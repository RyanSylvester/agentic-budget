import { describe, expect, test } from "bun:test";
import type { Db } from "../src/db-interface";
import { testDb } from "./helpers";
import { monthSpend, potSpend } from "../src/queries";
import { allocateSettlement, applySettlement, contactCredit, contactOwed } from "../src/settle";

async function seed(): Promise<Db> {
  const db = await testDb();
  await db.exec(`INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing','chequing')`);
  await db.exec(`INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES (1, 'Housing','essentials','fixed',300000), (1, 'Groceries','essentials','average_3mo',120000)`);
  await db.exec(`INSERT INTO contacts (user_id, name) VALUES (1, 'Alex')`);
  return db;
}

async function addTxn(db: Db, date: string, amountCents: number, userCents: number, contactCents: number, potId: number) {
  const t = (await db.get<{ id: number }>(
    "INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, status, cleared) VALUES (1, ?, 1, ?, 't', 'manual', 'agent', 'confirmed', 'cleared') RETURNING id",
    date, amountCents
  ))!;
  await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (1, ?, ?, ?, ?, ?)", t.id, potId, "user", null, userCents);
  if (contactCents !== 0) await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (1, ?, ?, ?, ?, ?)", t.id, potId, "contact", 1, -contactCents);
}

describe("splits", () => {
  test("the user's views exclude the contact's share", async () => {
    const db = await seed();
    // $3,340 rent, split evenly, housing pot
    await addTxn(db, "2026-09-01", -334000, -167000, 167000, 1);
    expect(await monthSpend(db, "2026-09")).toBe(167000);
    expect(await potSpend(db, 1, "2026-09")).toEqual({ userCents: 167000, sharedCents: 167000 });
    // unsplit grocery run still counts fully
    await addTxn(db, "2026-09-02", -8000, -8000, 0, 2);
    expect(await monthSpend(db, "2026-09")).toBe(175000);
  });

  test("pending_review transactions don't count", async () => {
    const db = await seed();
    await db.exec(`INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, status, cleared) VALUES (1, '2026-09-03', 1, -50000, 't', 'manual', 'agent', 'pending_review', 'uncleared')`);
    const t = (await db.get<{ id: number }>("SELECT id FROM transactions"))!;
    await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, amount_cents) VALUES (1, ?, 1, 'user', -50000)", t.id);
    expect(await monthSpend(db, "2026-09")).toBe(0);
  });
});

describe("settlements", () => {
  test("allocateSettlement fills oldest first", () => {
    const owed = [
      { splitId: 1, contactId: 1, contactName: "Alex", potName: "Housing", date: "2026-09-01", owedCents: 167000 },
      { splitId: 2, contactId: 1, contactName: "Alex", potName: "Groceries", date: "2026-09-05", owedCents: 4000 },
    ];
    const r = allocateSettlement(owed, 200000);
    expect(r.allocations).toEqual([
      { splitId: 1, potName: "Housing", amountCents: 167000 },
      { splitId: 2, potName: "Groceries", amountCents: 4000 },
    ]);
    expect(r.leftoverCents).toBe(29000);
  });

  test("overpayment becomes leftover credit", () => {
    const owed = [{ splitId: 1, contactId: 1, contactName: "Alex", potName: "Housing", date: "2026-09-01", owedCents: 167000 }];
    const r = allocateSettlement(owed, 200000);
    expect(r.allocations).toEqual([{ splitId: 1, potName: "Housing", amountCents: 167000 }]);
    expect(r.leftoverCents).toBe(33000);
  });

  test("applySettlement end to end: lump sum fills buckets, user's spend untouched", async () => {
    const db = await seed();
    await addTxn(db, "2026-09-01", -334000, -167000, 167000, 1); // rent split
    await addTxn(db, "2026-09-05", -9000, -4500, 4500, 2);       // groceries split
    expect((await contactOwed(db, 1)).reduce((a, o) => a + o.owedCents, 0)).toBe(171500);

    const summary = await applySettlement(db, 1, { contactId: 1, accountId: 1, amountCents: 200000, note: "Alex e-transfer" });
    expect(summary.allocations.map((a) => a.amountCents)).toEqual([167000, 4500]);
    expect(summary.leftoverCents).toBe(28500);

    // Buckets filled, credit recorded
    expect(await contactOwed(db, 1)).toEqual([]);
    expect(await contactCredit(db, 1)).toBe(28500);

    // The user's spend unchanged: the settlement is real money (reconcile sees it)
    // but invisible to their views.
    expect(await monthSpend(db, "2026-09")).toBe(171500);
    const acct = (await db.get<{ t: number }>("SELECT COALESCE(SUM(amount_cents),0) AS t FROM transactions WHERE account_id = 1"))!;
    expect(acct.t).toBe(-334000 - 9000 + 200000);
  });
});

describe("uncertain review + transfers", () => {
  test("transfers are excluded from spend but count for reconciliation", async () => {
    const db = await seed();
    await db.exec(`INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, status, cleared, is_transfer) VALUES (1, '2026-09-01', 1, -190000, 'Payday holding loop', 'manual', 'agent', 'confirmed', 'cleared', 1)`);
    const t = (await db.get<{ id: number }>("SELECT id FROM transactions"))!;
    await db.run("INSERT INTO splits (user_id, transaction_id, owner, amount_cents) VALUES (1, ?, 'user', -190000)", t.id);
    await addTxn(db, "2026-09-02", -8000, -8000, 0, 2);
    expect(await monthSpend(db, "2026-09")).toBe(8000);
    // ...but the money really moved, so the account balance includes it
    const acct = (await db.get<{ t: number }>("SELECT COALESCE(SUM(amount_cents),0) AS t FROM transactions WHERE account_id = 1"))!;
    expect(acct.t).toBe(-198000);
  });

  test("uncertain entries queue with a reason; confident ones confirm directly", async () => {
    const db = await seed();
    await db.exec(`INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, status, cleared, review_reason) VALUES (1, '2026-09-03', 1, -2500, 'Mystery charge', 'gmail', 'agent', 'pending_review', 'uncleared', 'unsure which pot')`);
    const t = (await db.get<{ id: number }>("SELECT id FROM transactions"))!;
    await db.run("INSERT INTO splits (user_id, transaction_id, owner, amount_cents) VALUES (1, ?, 'user', -2500)", t.id);
    // pending_review never counts toward spend
    expect(await monthSpend(db, "2026-09")).toBe(0);
    const row = (await db.get<{ review_reason: string }>("SELECT review_reason FROM transactions WHERE id = ?", t.id))!;
    expect(row.review_reason).toBe("unsure which pot");
  });
});
