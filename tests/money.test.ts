import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { assertSplitsSum } from "../src/money";
import { monthSpend, monthInflows, rtaCents } from "../src/queries";
import { applySettlement, contactCredit, contactOwed } from "../src/settle";
import { assignToPot } from "../src/assign";

function seed(): Database {
  const db = new Database(":memory:");
  db.exec(readFileSync("src/schema.sql", "utf8"));
  db.exec(`INSERT INTO accounts (name, type) VALUES ('Chequing','chequing')`);
  db.exec(`INSERT INTO pots (name, pot_group, target_type, target_cents) VALUES ('Housing','essentials','fixed',300000), ('Groceries','essentials','average_3mo',120000)`);
  db.exec(`INSERT INTO contacts (name) VALUES ('Alex'), ('Sam')`);
  return db;
}

function addTxn(db: Database, date: string, amountCents: number, userCents: number, contactCents: number, potId: number | null, voided = 0) {
  const t = db.query(
    "INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared, voided) VALUES (?, 1, ?, 't', 'manual', 'agent', 'confirmed', 'cleared', ?) RETURNING id"
  ).get(date, amountCents, voided) as { id: number };
  const ins = db.query("INSERT INTO splits (transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (?, ?, ?, ?, ?)");
  ins.run(t.id, potId, "user", null, userCents);
  if (contactCents !== 0) ins.run(t.id, potId, "contact", 1, -contactCents);
  return t.id;
}

describe("assertSplitsSum", () => {
  test("balanced splits pass", () => {
    const db = seed();
    const id = addTxn(db, "2026-09-01", -10000, -6000, 4000, 1);
    expect(() => assertSplitsSum(db, id)).not.toThrow();
  });

  test("unbalanced splits throw", () => {
    const db = seed();
    const t = db.query(
      "INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared) VALUES ('2026-09-01', 1, -10000, 't', 'manual', 'agent', 'confirmed', 'cleared') RETURNING id"
    ).get() as { id: number };
    db.query("INSERT INTO splits (transaction_id, owner, amount_cents) VALUES (?, 'user', -6000)").run(t.id);
    expect(() => assertSplitsSum(db, t.id)).toThrow("sum to -6000, expected -10000");
  });

  test("unknown transaction throws", () => {
    const db = seed();
    expect(() => assertSplitsSum(db, 999)).toThrow("does not exist");
  });
});

describe("void", () => {
  test("voided transactions are excluded from spend, inflows, and RTA", () => {
    const db = seed();
    addTxn(db, "2026-09-01", 500000, 500000, 0, null);   // paycheck
    addTxn(db, "2026-09-02", -8000, -8000, 0, 2);        // groceries
    const dup = addTxn(db, "2026-09-03", -8000, -8000, 0, 2, 1); // voided duplicate
    expect(monthSpend(db, "2026-09")).toBe(8000);
    expect(monthInflows(db, "2026-09")).toBe(500000);
    assignToPot(db, "2026-09", 2, 120000);
    expect(rtaCents(db, "2026-09")).toBe(380000);
    // the voided row is still in the DB for audit
    expect(db.query("SELECT voided FROM transactions WHERE id = ?").get(dup) as { voided: number }).toEqual({ voided: 1 });
  });

  test("voided contact splits are not owed", () => {
    const db = seed();
    addTxn(db, "2026-09-01", -334000, -167000, 167000, 1, 1); // voided rent split
    expect(contactOwed(db, 1)).toEqual([]);
  });
});

describe("external_id idempotency", () => {
  test("duplicate external_id violates the unique index", () => {
    const db = seed();
    db.query("INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared, external_id) VALUES ('2026-09-01', 1, -1000, 't', 'gmail', 'agent', 'confirmed', 'cleared', 'stmt-1')").run();
    expect(() =>
      db.query("INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared, external_id) VALUES ('2026-09-01', 1, -1000, 't', 'gmail', 'agent', 'confirmed', 'cleared', 'stmt-1')").run()
    ).toThrow();
  });
});

describe("contact credit consumption", () => {
  test("overpay -> credit -> next settle consumes credit first", () => {
    const db = seed();
    addTxn(db, "2026-09-01", -334000, -167000, 167000, 1); // Alex owes 167000
    const first = applySettlement(db, { contactId: 1, accountId: 1, amountCents: 200000 });
    expect(first.leftoverCents).toBe(33000);
    expect(contactCredit(db, 1)).toBe(33000);
    expect(contactOwed(db, 1)).toEqual([]);

    addTxn(db, "2026-09-10", -100000, -50000, 50000, 2); // Alex owes 50000 more
    const second = applySettlement(db, { contactId: 1, accountId: 1, amountCents: 10000 });
    // 33000 of prior credit consumed first (zero cash), then the 10000 new money
    expect(second.creditConsumedCents).toBe(33000);
    expect(second.creditAllocations.map((a) => a.amountCents)).toEqual([33000]);
    expect(second.allocations.map((a) => a.amountCents)).toEqual([10000]);
    expect(second.leftoverCents).toBe(0);
    expect(contactCredit(db, 1)).toBe(0);
    // 50000 - 33000 - 10000 = 7000 still owed
    expect(contactOwed(db, 1).reduce((a, o) => a + o.owedCents, 0)).toBe(7000);
  });

  test("credit older than the new settlement is consumed first", () => {
    const db = seed();
    addTxn(db, "2026-09-01", -100000, -50000, 50000, 1);
    applySettlement(db, { contactId: 1, accountId: 1, amountCents: 80000 }); // 30000 credit
    addTxn(db, "2026-09-05", -60000, -30000, 30000, 2);
    applySettlement(db, { contactId: 1, accountId: 1, amountCents: 40000 }); // credit covers the 30000 owed; 40000 leftover becomes credit
    expect(contactCredit(db, 1)).toBe(40000);
    addTxn(db, "2026-09-10", -80000, -40000, 40000, 1);
    const s = applySettlement(db, { contactId: 1, accountId: 1, amountCents: 5000 });
    expect(s.creditConsumedCents).toBe(40000);
    expect(s.leftoverCents).toBe(5000);
    // 40000 credit + 5000 cash covers the 40000 owed; the 5000 leftover is new credit
    expect(contactCredit(db, 1)).toBe(5000);
    expect(contactOwed(db, 1).reduce((a, o) => a + o.owedCents, 0)).toBe(0);
  });

  test("credit is tracked per contact, not shared across contacts", () => {
    const db = seed();
    // Alex owes 50000; Sam has a separate contact split owing 20000
    addTxn(db, "2026-09-01", -100000, -50000, 50000, 1);
    const t2 = addTxn(db, "2026-09-02", -40000, -20000, 20000, 2);
    db.query("UPDATE splits SET contact_id = 2 WHERE transaction_id = ? AND owner = 'contact'").run(t2);
    applySettlement(db, { contactId: 1, accountId: 1, amountCents: 80000 }); // 30000 credit for Alex
    expect(contactCredit(db, 1)).toBe(30000);
    expect(contactCredit(db, 2)).toBe(0);
    // Alex's credit only offsets Alex's owed, never Sam's
    expect(contactOwed(db, 1)).toEqual([]);
    expect(contactOwed(db, 2).reduce((a, o) => a + o.owedCents, 0)).toBe(20000);
  });
});
