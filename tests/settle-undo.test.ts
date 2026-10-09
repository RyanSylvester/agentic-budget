import { describe, expect, test } from "bun:test";
import type { Db } from "../src/db-interface";
import { testDb } from "./helpers";
import { applySettlement, contactCredit, contactOwed, undoSettlement } from "../src/settle";
import { contactBalances, contactLedger, setContactArchived, listContacts } from "../src/contacts";

async function seed(): Promise<Db> {
  const db = await testDb();
  await db.exec(`INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing','chequing')`);
  await db.exec(`INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES (1, 'Housing','essentials','fixed',300000), (1, 'Groceries','essentials','average_3mo',120000)`);
  await db.exec(`INSERT INTO contacts (user_id, name) VALUES (1, 'Alex')`);
  return db;
}

async function addTxn(db: Db, date: string, amountCents: number, contactCents: number, potId: number, description = "t") {
  const t = (await db.get<{ id: number }>(
    "INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, cleared) VALUES (1, ?, 1, ?, ?, 'manual', 'agent', 'cleared') RETURNING id",
    date, amountCents, description
  ))!;
  await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (1, ?, ?, 'user', NULL, ?)", t.id, potId, amountCents + contactCents);
  await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (1, ?, ?, 'contact', 1, ?)", t.id, potId, -contactCents);
  return t.id;
}

const owedTotal = async (db: Db) => (await contactOwed(db, 1, 1)).reduce((a, o) => a + o.owedCents, 0);
const rowCount = async (db: Db, table: string) => (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;

describe("settlement undo", () => {
  test("undoing a received settlement makes the shares owed again and removes its money", async () => {
    const db = await seed();
    await addTxn(db, "2026-09-01", -10000, 5000, 1);
    await addTxn(db, "2026-09-03", -4000, 2000, 2);
    const before = { txns: await rowCount(db, "transactions"), splits: await rowCount(db, "splits") };

    const s = await applySettlement(db, 1, { contactId: 1, accountId: 1, amountCents: 8000 });
    expect(s.direction).toBe("received");
    expect(s.amountCents).toBe(8000);
    expect(await owedTotal(db)).toBe(0);
    expect(await contactCredit(db, 1, 1)).toBe(1000);

    await undoSettlement(db, 1, s.settlementId);
    expect(await owedTotal(db)).toBe(7000);
    expect(await contactCredit(db, 1, 1)).toBe(0);
    expect(await rowCount(db, "transactions")).toBe(before.txns);
    expect(await rowCount(db, "splits")).toBe(before.splits);
    expect(await rowCount(db, "settlements")).toBe(0);
    expect(await rowCount(db, "settlement_allocations")).toBe(0);
  });

  test("undo gives back credit that the settlement consumed", async () => {
    const db = await seed();
    await addTxn(db, "2026-09-01", -10000, 5000, 1);
    const first = await applySettlement(db, 1, { contactId: 1, accountId: 1, amountCents: 8000 }); // 3000 credit
    expect(await contactCredit(db, 1, 1)).toBe(3000);
    await addTxn(db, "2026-09-10", -8000, 4000, 2);

    const second = await applySettlement(db, 1, { contactId: 1, accountId: 1, amountCents: 500 });
    expect(second.creditConsumedCents).toBe(3000);
    expect(await owedTotal(db)).toBe(500);

    await undoSettlement(db, 1, second.settlementId);
    expect(await contactCredit(db, 1, 1)).toBe(3000);
    expect(await owedTotal(db)).toBe(4000);
    // The earlier settlement is intact and can itself be undone afterwards.
    await undoSettlement(db, 1, first.settlementId);
    expect(await owedTotal(db)).toBe(9000);
    expect(await contactCredit(db, 1, 1)).toBe(0);
  });

  test("undo is refused while a later settlement used this one's credit", async () => {
    const db = await seed();
    await addTxn(db, "2026-09-01", -10000, 5000, 1);
    const first = await applySettlement(db, 1, { contactId: 1, accountId: 1, amountCents: 8000 });
    await addTxn(db, "2026-09-10", -8000, 4000, 2);
    await applySettlement(db, 1, { contactId: 1, accountId: 1, amountCents: 500 });
    await expect(undoSettlement(db, 1, first.settlementId)).rejects.toThrow("undo that one first");
  });

  test("undo is refused once the settlement is reconciled, and for unknown ids", async () => {
    const db = await seed();
    await addTxn(db, "2026-09-01", -10000, 5000, 1);
    const s = await applySettlement(db, 1, { contactId: 1, accountId: 1, amountCents: 5000 });
    await db.run("UPDATE transactions SET cleared = 'reconciled' WHERE id = (SELECT transaction_id FROM settlements WHERE id = ?)", s.settlementId);
    await expect(undoSettlement(db, 1, s.settlementId)).rejects.toThrow("reconciled");
    await expect(undoSettlement(db, 1, 999)).rejects.toThrow("no settlement 999");
  });
});

describe("paying a contact", () => {
  test("a payout draws down their credit, leaves the user's spend alone, and undoes cleanly", async () => {
    const db = await seed();
    await addTxn(db, "2026-09-01", -10000, 5000, 1);
    await applySettlement(db, 1, { contactId: 1, accountId: 1, amountCents: 8000 }); // 3000 credit: you owe them
    const [before] = await contactBalances(db, 1);
    expect(before.totalOwedCents - before.creditCents).toBe(-3000);

    const p = await applySettlement(db, 1, { contactId: 1, accountId: 1, amountCents: 3000, direction: "paid" });
    expect(p.direction).toBe("paid");
    expect(p.creditConsumedCents).toBe(3000);
    const [after] = await contactBalances(db, 1);
    expect(after.totalOwedCents).toBe(0);
    expect(after.creditCents).toBe(0);
    const txn = (await db.get<{ amount_cents: number; description: string }>(
      "SELECT t.amount_cents, t.description FROM settlements st JOIN transactions t ON t.id = st.transaction_id WHERE st.id = ?", p.settlementId
    ))!;
    expect(txn).toEqual({ amount_cents: -3000, description: "Paid Alex" });
    // Contact-owned outflow: never the user's spending.
    const userSplits = (await db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM splits s JOIN settlements st ON st.transaction_id = s.transaction_id WHERE st.id = ? AND s.owner = 'user'", p.settlementId
    ))!;
    expect(userSplits.n).toBe(0);

    await undoSettlement(db, 1, p.settlementId);
    const [undone] = await contactBalances(db, 1);
    expect(undone.creditCents).toBe(3000);
    expect(undone.totalOwedCents).toBe(0);
  });

  test("paying more than their credit leaves the rest owed by them", async () => {
    const db = await seed();
    await addTxn(db, "2026-09-01", -10000, 5000, 1);
    await applySettlement(db, 1, { contactId: 1, accountId: 1, amountCents: 6000 }); // 1000 credit
    await applySettlement(db, 1, { contactId: 1, accountId: 1, amountCents: 1500, direction: "paid" });
    expect(await contactCredit(db, 1, 1)).toBe(0);
    expect(await owedTotal(db)).toBe(500);
  });
});

describe("contact archive and ledger", () => {
  test("archiving hides a settled contact; an open balance blocks it", async () => {
    const db = await seed();
    await addTxn(db, "2026-09-01", -10000, 5000, 1);
    await expect(setContactArchived(db, 1, 1, true)).rejects.toThrow("open balance");
    await applySettlement(db, 1, { contactId: 1, accountId: 1, amountCents: 5000 });
    await setContactArchived(db, 1, 1, true);
    expect(await listContacts(db, 1)).toEqual([]);
    expect(await contactBalances(db, 1)).toEqual([]);
    const all = await contactBalances(db, 1, { includeArchived: true });
    expect(all.map((c) => [c.name, c.archived])).toEqual([["Alex", true]]);
    await setContactArchived(db, 1, 1, false);
    expect((await contactBalances(db, 1)).map((c) => c.archived)).toEqual([false]);
    await expect(setContactArchived(db, 1, 42, true)).rejects.toThrow("no contact 42");
  });

  test("the ledger lists shares and settlements newest first", async () => {
    const db = await seed();
    await addTxn(db, "2026-09-01", -10000, 5000, 1, "Rent");
    await addTxn(db, "2026-09-03", -4000, 2000, 2, "Groceries");
    await db.run("UPDATE transactions SET voided = 1 WHERE description = 'Groceries'");
    await addTxn(db, "2026-09-05", -6000, 3000, 2, "Market");
    const s = await applySettlement(db, 1, { contactId: 1, accountId: 1, amountCents: 6000, note: "Alex e-transfer" });
    await db.run("UPDATE transactions SET date = '2026-09-20' WHERE id = (SELECT transaction_id FROM settlements WHERE id = ?)", s.settlementId);

    const { entries } = await contactLedger(db, 1, 1);
    expect(entries.map((e) => e.description)).toEqual(["Alex e-transfer", "Market", "Rent"]);
    expect(entries[0]).toMatchObject({ kind: "settlement", settlementId: s.settlementId, amountCents: 6000, accountName: "Chequing" });
    expect(entries[1]).toMatchObject({ kind: "share", shareCents: 3000, outstandingCents: 2000, potName: "Groceries" });
    expect(entries[2]).toMatchObject({ kind: "share", shareCents: 5000, outstandingCents: 0, potName: "Housing" });
    await expect(contactLedger(db, 1, 42)).rejects.toThrow("no contact 42");
  });
});
