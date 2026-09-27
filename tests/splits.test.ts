import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { monthSpend, potSpend } from "../src/queries";
import { allocateSettlement, applySettlement, contactCredit, contactOwed } from "../src/settle";

function seed(): Database {
  const db = new Database(":memory:");
  db.exec(readFileSync("src/schema.sql", "utf8"));
  db.exec(`INSERT INTO accounts (name, type) VALUES ('Chequing','chequing')`);
  db.exec(`INSERT INTO pots (name, pot_group, target_type, target_cents) VALUES ('Housing','essentials','fixed',300000), ('Groceries','essentials','average_3mo',120000)`);
  db.exec(`INSERT INTO contacts (name) VALUES ('Alex')`);
  return db;
}

function addTxn(db: Database, date: string, amountCents: number, userCents: number, contactCents: number, potId: number) {
  const t = db.query(
    "INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared) VALUES (?, 1, ?, 't', 'manual', 'agent', 'confirmed', 'cleared') RETURNING id"
  ).get(date, amountCents) as { id: number };
  const ins = db.query("INSERT INTO splits (transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (?, ?, ?, ?, ?)");
  ins.run(t.id, potId, "user", null, userCents);
  if (contactCents !== 0) ins.run(t.id, potId, "contact", 1, -contactCents);
}

describe("splits", () => {
  test("the user's views exclude the contact's share", () => {
    const db = seed();
    // $3,340 rent, split evenly, housing pot
    addTxn(db, "2026-09-01", -334000, -167000, 167000, 1);
    expect(monthSpend(db, "2026-09")).toBe(167000);
    expect(potSpend(db, 1, "2026-09")).toEqual({ userCents: 167000, sharedCents: 167000 });
    // unsplit grocery run still counts fully
    addTxn(db, "2026-09-02", -8000, -8000, 0, 2);
    expect(monthSpend(db, "2026-09")).toBe(175000);
  });

  test("pending_review transactions don't count", () => {
    const db = seed();
    db.exec(`INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared) VALUES ('2026-09-03', 1, -50000, 't', 'manual', 'agent', 'pending_review', 'uncleared')`);
    const t = db.query("SELECT id FROM transactions").get() as { id: number };
    db.query("INSERT INTO splits (transaction_id, pot_id, owner, amount_cents) VALUES (?, 1, 'user', -50000)").run(t.id);
    expect(monthSpend(db, "2026-09")).toBe(0);
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

  test("applySettlement end to end: lump sum fills buckets, user's spend untouched", () => {
    const db = seed();
    addTxn(db, "2026-09-01", -334000, -167000, 167000, 1); // rent split
    addTxn(db, "2026-09-05", -9000, -4500, 4500, 2);       // groceries split
    expect(contactOwed(db, 1).reduce((a, o) => a + o.owedCents, 0)).toBe(171500);

    const summary = applySettlement(db, { contactId: 1, accountId: 1, amountCents: 200000, note: "Alex e-transfer" });
    expect(summary.allocations.map((a) => a.amountCents)).toEqual([167000, 4500]);
    expect(summary.leftoverCents).toBe(28500);

    // Buckets filled, credit recorded
    expect(contactOwed(db, 1)).toEqual([]);
    expect(contactCredit(db, 1)).toBe(28500);

    // The user's spend unchanged: the settlement is real money (reconcile sees it)
    // but invisible to their views.
    expect(monthSpend(db, "2026-09")).toBe(171500);
    const acct = db.query("SELECT COALESCE(SUM(amount_cents),0) AS t FROM transactions WHERE account_id = 1").get() as { t: number };
    expect(acct.t).toBe(-334000 - 9000 + 200000);
  });
});

describe("uncertain review + transfers", () => {
  test("transfers are excluded from spend but count for reconciliation", () => {
    const db = seed();
    db.exec(`INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared, is_transfer) VALUES ('2026-09-01', 1, -190000, 'Payday holding loop', 'manual', 'agent', 'confirmed', 'cleared', 1)`);
    const t = db.query("SELECT id FROM transactions").get() as { id: number };
    db.query("INSERT INTO splits (transaction_id, owner, amount_cents) VALUES (?, 'user', -190000)").run(t.id);
    addTxn(db, "2026-09-02", -8000, -8000, 0, 2);
    expect(monthSpend(db, "2026-09")).toBe(8000);
    // ...but the money really moved, so the account balance includes it
    const acct = db.query("SELECT COALESCE(SUM(amount_cents),0) AS t FROM transactions WHERE account_id = 1").get() as { t: number };
    expect(acct.t).toBe(-198000);
  });

  test("uncertain entries queue with a reason; confident ones confirm directly", () => {
    const db = seed();
    db.exec(`INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared, review_reason) VALUES ('2026-09-03', 1, -2500, 'Mystery charge', 'gmail', 'agent', 'pending_review', 'uncleared', 'unsure which pot')`);
    const t = db.query("SELECT id FROM transactions").get() as { id: number };
    db.query("INSERT INTO splits (transaction_id, owner, amount_cents) VALUES (?, 'user', -2500)").run(t.id);
    // pending_review never counts toward spend
    expect(monthSpend(db, "2026-09")).toBe(0);
    const row = db.query("SELECT review_reason FROM transactions WHERE id = ?").get(t.id) as { review_reason: string };
    expect(row.review_reason).toBe("unsure which pot");
  });
});
