import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createTransaction, updateTransaction, moneyLockReason } from "../src/transactions";
import { listTransactions } from "../src/queries";

function seed(): Database {
  const db = new Database(":memory:");
  db.exec(readFileSync("src/schema.sql", "utf8"));
  db.exec(`INSERT INTO accounts (name, type) VALUES ('Chequing','chequing'), ('Card','credit_card')`);
  db.exec(`INSERT INTO pots (name, pot_group, target_type, target_cents) VALUES
    ('Groceries','Food','average_3mo',60000),
    ('Paycheck','Income','fixed',0),
    ('Old Pot','Food','fixed',0)`);
  db.query("UPDATE pots SET hidden = 1 WHERE name = 'Old Pot'").run();
  return db;
}

const base = {
  date: "2026-09-26",
  accountId: 1,
  potId: 1,
  amountCents: -2599,
  description: "Test purchase",
};

describe("createTransaction", () => {
  test("records an outflow with a user split", () => {
    const db = seed();
    const id = createTransaction(db, base);
    const t = db.query("SELECT * FROM transactions WHERE id = ?").get(id) as any;
    expect(t.description).toBe("Test purchase");
    expect(t.amount_cents).toBe(-2599);
    expect(t.source).toBe("manual");
    expect(t.entered_by).toBe("user");
    expect(t.status).toBe("confirmed");
    const splits = db.query("SELECT owner, amount_cents, pot_id FROM splits WHERE transaction_id = ?").all(id) as any[];
    expect(splits).toEqual([{ owner: "user", amount_cents: -2599, pot_id: 1 }]);
  });

  test("records an inflow", () => {
    const db = seed();
    const id = createTransaction(db, { ...base, amountCents: 250000, potId: 2, description: "Pay" });
    const splits = db.query("SELECT owner, amount_cents FROM splits WHERE transaction_id = ?").all(id) as any[];
    expect(splits).toEqual([{ owner: "user", amount_cents: 250000 }]);
  });

  test("splits with the partner sum to the amount", () => {
    const db = seed();
    const id = createTransaction(db, { ...base, amountCents: -10000, partnerCents: -5000 });
    const splits = db.query("SELECT owner, amount_cents FROM splits WHERE transaction_id = ? ORDER BY owner").all(id) as any[];
    expect(splits).toEqual([
      { owner: "partner", amount_cents: -5000 },
      { owner: "user", amount_cents: -5000 },
    ]);
  });

  test("records a transfer without a pot", () => {
    const db = seed();
    const id = createTransaction(db, {
      date: "2026-09-26", accountId: 1, amountCents: -37500,
      description: "Move to savings", isTransfer: true,
    });
    const t = db.query("SELECT is_transfer FROM transactions WHERE id = ?").get(id) as any;
    expect(t.is_transfer).toBe(1);
  });

  test("rejects bad input", () => {
    const db = seed();
    expect(() => createTransaction(db, { ...base, date: "2026-13-40" })).toThrow("bad date");
    expect(() => createTransaction(db, { ...base, amountCents: 0 })).toThrow("nonzero");
    expect(() => createTransaction(db, { ...base, description: "  " })).toThrow("description required");
    expect(() => createTransaction(db, { ...base, accountId: 99 })).toThrow("no account 99");
    expect(() => createTransaction(db, { ...base, potId: 99 })).toThrow("no pot 99");
    expect(() => createTransaction(db, { ...base, potId: 3 })).toThrow("no pot 3"); // hidden
    expect(() => createTransaction(db, { ...base, partnerCents: -2599 })).toThrow("smaller than");
    expect(() => createTransaction(db, { ...base, partnerCents: 5000 })).toThrow("same sign");
    expect(() => createTransaction(db, { ...base, isTransfer: true, partnerCents: -100 })).toThrow("cannot be split");
  });
});

describe("updateTransaction", () => {
  test("edits description and date, keeps splits", () => {
    const db = seed();
    const id = createTransaction(db, base);
    updateTransaction(db, id, { ...base, description: "Renamed", date: "2026-09-25" });
    const t = db.query("SELECT description, date FROM transactions WHERE id = ?").get(id) as any;
    expect(t.description).toBe("Renamed");
    expect(t.date).toBe("2026-09-25");
  });

  test("changes amount and rebuilds splits", () => {
    const db = seed();
    const id = createTransaction(db, base);
    updateTransaction(db, id, { ...base, amountCents: -3000 });
    const splits = db.query("SELECT owner, amount_cents FROM splits WHERE transaction_id = ?").all(id) as any[];
    expect(splits).toEqual([{ owner: "user", amount_cents: -3000 }]);
  });

  test("recategorizes to another pot", () => {
    const db = seed();
    const id = createTransaction(db, base);
    updateTransaction(db, id, { ...base, potId: 2 });
    const splits = db.query("SELECT pot_id FROM splits WHERE transaction_id = ?").all(id) as any[];
    expect(splits).toEqual([{ pot_id: 2 }]);
  });

  test("adds a partner split on edit", () => {
    const db = seed();
    const id = createTransaction(db, base);
    updateTransaction(db, id, { ...base, amountCents: -10000, partnerCents: -5000 });
    const total = db.query("SELECT SUM(amount_cents) AS s FROM splits WHERE transaction_id = ?").get(id) as any;
    expect(total.s).toBe(-10000);
  });

  test("rejects amount changes on cleared transactions", () => {
    const db = seed();
    const id = createTransaction(db, base);
    db.query("UPDATE transactions SET cleared = 'cleared' WHERE id = ?").run(id);
    expect(() => updateTransaction(db, id, { ...base, amountCents: -1 })).toThrow("already cleared");
    // description-only edits still work
    updateTransaction(db, id, { ...base, description: "Still editable" });
    expect((db.query("SELECT description FROM transactions WHERE id = ?").get(id) as any).description).toBe("Still editable");
  });

  test("rejects amount changes on settlement-linked transactions", () => {
    const db = seed();
    const id = createTransaction(db, { ...base, amountCents: -10000, partnerCents: -5000 });
    const splitId = (db.query("SELECT id FROM splits WHERE transaction_id = ? AND owner = 'partner'").get(id) as any).id;
    db.query("INSERT INTO settlements (transaction_id, date, amount_cents) VALUES (?, '2026-09-27', 5000)").run(id);
    const stId = (db.query("SELECT id FROM settlements WHERE transaction_id = ?").get(id) as any).id;
    db.query("INSERT INTO settlement_allocations (settlement_id, split_id, amount_cents) VALUES (?, ?, 100)").run(stId, splitId);
    expect(moneyLockReason(db, id)).toMatch("settlement");
    expect(() => updateTransaction(db, id, { ...base, amountCents: -9000, partnerCents: -4500 })).toThrow("settlement");
  });

  test("throws on unknown id", () => {
    const db = seed();
    expect(() => updateTransaction(db, 4242, base)).toThrow("no transaction 4242");
  });
});

describe("listTransactions", () => {
  test("lists a month newest-first with pot and partner detail, skips voided", () => {
    const db = seed();
    const a = createTransaction(db, { ...base, date: "2026-09-20" });
    createTransaction(db, { ...base, date: "2026-09-26", amountCents: -10000, partnerCents: -5000, description: "Split shop" });
    createTransaction(db, { ...base, date: "2026-08-15", description: "Old month" });
    db.query("UPDATE transactions SET voided = 1 WHERE id = ?").run(a);

    const rows = listTransactions(db, "2026-09");
    expect(rows.map((r) => r.description)).toEqual(["Split shop"]);
    const r = rows[0];
    expect(r.potName).toBe("Groceries");
    expect(r.potGroup).toBe("Food");
    expect(r.splitWithPartner).toBe(1);
    expect(r.partnerCents).toBe(5000);
    expect(r.accountName).toBe("Chequing");
  });
});
