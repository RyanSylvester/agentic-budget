import { describe, expect, test } from "bun:test";
import type { Db } from "../src/db-interface";
import { testDb } from "./helpers";
import { assertSplitsSum } from "../src/money";
import { monthSpend, monthInflows, rtaCents } from "../src/queries";
import { applySettlement, contactCredit, contactOwed } from "../src/settle";
import { assignToPot } from "../src/assign";

async function seed(): Promise<Db> {
  const db = await testDb();
  await db.exec(`INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing','chequing')`);
  await db.exec(`INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES (1, 'Housing','essentials','fixed',300000), (1, 'Groceries','essentials','average_3mo',120000)`);
  await db.exec(`INSERT INTO contacts (user_id, name) VALUES (1, 'Alex'), (1, 'Sam')`);
  return db;
}

async function addTxn(db: Db, date: string, amountCents: number, userCents: number, contactCents: number, potId: number | null, voided = 0) {
  const t = (await db.get<{ id: number }>(
    "INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, status, cleared, voided) VALUES (1, ?, 1, ?, 't', 'manual', 'agent', 'confirmed', 'cleared', ?) RETURNING id",
    date, amountCents, voided
  ))!;
  await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (1, ?, ?, ?, ?, ?)", t.id, potId, "user", null, userCents);
  if (contactCents !== 0) await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (1, ?, ?, ?, ?, ?)", t.id, potId, "contact", 1, -contactCents);
  return t.id;
}

describe("assertSplitsSum", () => {
  test("balanced splits pass", async () => {
    const db = await seed();
    const id = await addTxn(db, "2026-09-01", -10000, -6000, 4000, 1);
    await expect(assertSplitsSum(db, id)).resolves.toBeUndefined();
  });

  test("unbalanced splits throw", async () => {
    const db = await seed();
    const t = (await db.get<{ id: number }>(
      "INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, status, cleared) VALUES (1, '2026-09-01', 1, -10000, 't', 'manual', 'agent', 'confirmed', 'cleared') RETURNING id"
    ))!;
    await db.run("INSERT INTO splits (user_id, transaction_id, owner, amount_cents) VALUES (1, ?, 'user', -6000)", t.id);
    await expect(assertSplitsSum(db, t.id)).rejects.toThrow("sum to -6000, expected -10000");
  });

  test("unknown transaction throws", async () => {
    const db = await seed();
    await expect(assertSplitsSum(db, 999)).rejects.toThrow("does not exist");
  });
});

describe("void", () => {
  test("voided transactions are excluded from spend, inflows, and RTA", async () => {
    const db = await seed();
    await addTxn(db, "2026-09-01", 500000, 500000, 0, null);   // paycheck
    await addTxn(db, "2026-09-02", -8000, -8000, 0, 2);        // groceries
    const dup = await addTxn(db, "2026-09-03", -8000, -8000, 0, 2, 1); // voided duplicate
    expect(await monthSpend(db, "2026-09")).toBe(8000);
    expect(await monthInflows(db, "2026-09")).toBe(500000);
    await assignToPot(db, 1, "2026-09", 2, 120000);
    expect(await rtaCents(db, "2026-09")).toBe(380000);
    // the voided row is still in the DB for audit
    expect(await db.get("SELECT voided FROM transactions WHERE id = ?", dup)).toEqual({ voided: 1 });
  });

  test("voided contact splits are not owed", async () => {
    const db = await seed();
    await addTxn(db, "2026-09-01", -334000, -167000, 167000, 1, 1); // voided rent split
    expect(await contactOwed(db, 1)).toEqual([]);
  });
});

describe("external_id idempotency", () => {
  test("duplicate external_id violates the unique index", async () => {
    const db = await seed();
    const sql = "INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, status, cleared, external_id) VALUES (1, '2026-09-01', 1, -1000, 't', 'gmail', 'agent', 'confirmed', 'cleared', 'stmt-1')";
    await db.run(sql);
    await expect(db.run(sql)).rejects.toThrow();
  });
});

describe("contact credit consumption", () => {
  test("overpay -> credit -> next settle consumes credit first", async () => {
    const db = await seed();
    await addTxn(db, "2026-09-01", -334000, -167000, 167000, 1); // Alex owes 167000
    const first = await applySettlement(db, 1, { contactId: 1, accountId: 1, amountCents: 200000 });
    expect(first.leftoverCents).toBe(33000);
    expect(await contactCredit(db, 1)).toBe(33000);
    expect(await contactOwed(db, 1)).toEqual([]);

    await addTxn(db, "2026-09-10", -100000, -50000, 50000, 2); // Alex owes 50000 more
    const second = await applySettlement(db, 1, { contactId: 1, accountId: 1, amountCents: 10000 });
    // 33000 of prior credit consumed first (zero cash), then the 10000 new money
    expect(second.creditConsumedCents).toBe(33000);
    expect(second.creditAllocations.map((a) => a.amountCents)).toEqual([33000]);
    expect(second.allocations.map((a) => a.amountCents)).toEqual([10000]);
    expect(second.leftoverCents).toBe(0);
    expect(await contactCredit(db, 1)).toBe(0);
    // 50000 - 33000 - 10000 = 7000 still owed
    expect((await contactOwed(db, 1)).reduce((a, o) => a + o.owedCents, 0)).toBe(7000);
  });

  test("credit older than the new settlement is consumed first", async () => {
    const db = await seed();
    await addTxn(db, "2026-09-01", -100000, -50000, 50000, 1);
    await applySettlement(db, 1, { contactId: 1, accountId: 1, amountCents: 80000 }); // 30000 credit
    await addTxn(db, "2026-09-05", -60000, -30000, 30000, 2);
    await applySettlement(db, 1, { contactId: 1, accountId: 1, amountCents: 40000 }); // credit covers the 30000 owed; 40000 leftover becomes credit
    expect(await contactCredit(db, 1)).toBe(40000);
    await addTxn(db, "2026-09-10", -80000, -40000, 40000, 1);
    const s = await applySettlement(db, 1, { contactId: 1, accountId: 1, amountCents: 5000 });
    expect(s.creditConsumedCents).toBe(40000);
    expect(s.leftoverCents).toBe(5000);
    // 40000 credit + 5000 cash covers the 40000 owed; the 5000 leftover is new credit
    expect(await contactCredit(db, 1)).toBe(5000);
    expect((await contactOwed(db, 1)).reduce((a, o) => a + o.owedCents, 0)).toBe(0);
  });

  test("credit is tracked per contact, not shared across contacts", async () => {
    const db = await seed();
    // Alex owes 50000; Sam has a separate contact split owing 20000
    await addTxn(db, "2026-09-01", -100000, -50000, 50000, 1);
    const t2 = await addTxn(db, "2026-09-02", -40000, -20000, 20000, 2);
    await db.run("UPDATE splits SET contact_id = 2 WHERE transaction_id = ? AND owner = 'contact'", t2);
    await applySettlement(db, 1, { contactId: 1, accountId: 1, amountCents: 80000 }); // 30000 credit for Alex
    expect(await contactCredit(db, 1)).toBe(30000);
    expect(await contactCredit(db, 2)).toBe(0);
    // Alex's credit only offsets Alex's owed, never Sam's
    expect(await contactOwed(db, 1)).toEqual([]);
    expect((await contactOwed(db, 2)).reduce((a, o) => a + o.owedCents, 0)).toBe(20000);
  });
});
