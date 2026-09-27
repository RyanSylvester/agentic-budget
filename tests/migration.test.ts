import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateDb } from "../src/db";

/** Rebuilds a database on the OLD schema: the single hardcoded-partner model
 *  (splits owner IN ('user','partner'), partner_name in settings, no contacts
 *  table, no per-pot share config). migrateDb must bring it up to the new
 *  model without losing a cent. */
function oldDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, last4 TEXT);
    CREATE TABLE pots (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, pot_group TEXT NOT NULL,
      target_type TEXT NOT NULL, target_cents INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0, is_assignable INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY, date TEXT NOT NULL, account_id INTEGER NOT NULL,
      pot_id INTEGER REFERENCES pots(id), amount_cents INTEGER NOT NULL,
      description TEXT NOT NULL, source TEXT NOT NULL, entered_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_review',
      cleared TEXT NOT NULL DEFAULT 'uncleared', review_reason TEXT,
      is_transfer INTEGER NOT NULL DEFAULT 0, external_id TEXT UNIQUE,
      voided INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE assignments (month TEXT NOT NULL, pot_id INTEGER NOT NULL, cents INTEGER NOT NULL, PRIMARY KEY (month, pot_id));
    CREATE TABLE month_closes (id INTEGER PRIMARY KEY, month TEXT NOT NULL UNIQUE, rta_start_cents INTEGER NOT NULL, rta_end_cents INTEGER NOT NULL, moved_to_savings_cents INTEGER NOT NULL, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE reconciliations (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, actual_balance_cents INTEGER NOT NULL, budget_balance_cents INTEGER NOT NULL, difference_cents INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE splits (
      id INTEGER PRIMARY KEY, transaction_id INTEGER NOT NULL REFERENCES transactions(id),
      pot_id INTEGER REFERENCES pots(id),
      owner TEXT NOT NULL CHECK (owner IN ('user','partner')),
      amount_cents INTEGER NOT NULL
    );
    CREATE TABLE settlements (id INTEGER PRIMARY KEY, transaction_id INTEGER NOT NULL REFERENCES transactions(id), date TEXT NOT NULL, amount_cents INTEGER NOT NULL, leftover_cents INTEGER NOT NULL DEFAULT 0, note TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE settlement_allocations (id INTEGER PRIMARY KEY, settlement_id INTEGER NOT NULL REFERENCES settlements(id), split_id INTEGER NOT NULL REFERENCES splits(id), amount_cents INTEGER NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  db.exec(`INSERT INTO accounts (name, type) VALUES ('Chequing','chequing')`);
  db.exec(`INSERT INTO pots (name, pot_group, target_type, target_cents) VALUES ('Housing','essentials','fixed',334000), ('Groceries','essentials','average_3mo',60000)`);
  db.exec(`INSERT INTO settings (key, value) VALUES ('partner_name', 'Alex')`);
  // rent split 50/50 with the partner; groceries unsplit
  db.query("INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared) VALUES ('2026-09-01', 1, -334000, 'rent', 'manual', 'agent', 'confirmed', 'cleared')").run();
  db.query("INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared) VALUES ('2026-09-02', 1, -8000, 'groceries', 'manual', 'agent', 'confirmed', 'cleared')").run();
  const t1 = (db.query("SELECT id FROM transactions WHERE description = 'rent'").get() as { id: number }).id;
  const t2 = (db.query("SELECT id FROM transactions WHERE description = 'groceries'").get() as { id: number }).id;
  const ins = db.query("INSERT INTO splits (transaction_id, pot_id, owner, amount_cents) VALUES (?, ?, ?, ?)");
  ins.run(t1, 1, "user", -167000);
  ins.run(t1, 1, "partner", -167000);
  ins.run(t2, 2, "user", -8000);
  return db;
}

describe("partner -> contacts migration", () => {
  test("old databases come up to the contact model", () => {
    const db = oldDb();
    migrateDb(db);

    // a contact seeded from the old partner_name setting
    const contacts = db.query("SELECT id, name FROM contacts ORDER BY id").all() as { id: number; name: string }[];
    expect(contacts).toEqual([{ id: 1, name: "Alex" }]);

    // splits migrated: partner -> contact with the seeded contact id
    const owners = db.query("SELECT DISTINCT owner FROM splits ORDER BY owner").all() as { owner: string }[];
    expect(owners).toEqual([{ owner: "contact" }, { owner: "user" }]);
    const cs = db.query("SELECT contact_id, amount_cents FROM splits WHERE owner = 'contact'").all() as any[];
    expect(cs).toEqual([{ contact_id: 1, amount_cents: -167000 }]);
    const us = db.query("SELECT contact_id FROM splits WHERE owner = 'user'").all() as any[];
    expect(us.every((u) => u.contact_id === null)).toBe(true);

    // pots with historical splits got a 50% share config; others untouched
    const p1 = db.query("SELECT contact_id, share_pct FROM pots WHERE id = 1").get() as any;
    const p2 = db.query("SELECT contact_id, share_pct FROM pots WHERE id = 2").get() as any;
    expect(p1).toEqual({ contact_id: 1, share_pct: 50 });
    expect(p2).toEqual({ contact_id: null, share_pct: null });

    // the old setting is gone
    expect(db.query("SELECT COUNT(*) AS n FROM settings WHERE key = 'partner_name'").get() as any).toEqual({ n: 0 });

    // balances still add up
    const total = db.query("SELECT SUM(amount_cents) AS s FROM splits").get() as { s: number };
    expect(total.s).toBe(-342000);
  });

  test("migration is idempotent", () => {
    const db = oldDb();
    migrateDb(db);
    migrateDb(db);
    const n = db.query("SELECT COUNT(*) AS n FROM contacts").get() as { n: number };
    expect(n.n).toBe(1);
    const splits = db.query("SELECT COUNT(*) AS n FROM splits").get() as { n: number };
    expect(splits.n).toBe(3);
  });

  test("a database with no partner_name setting still migrates", () => {
    const db = oldDb();
    db.exec("DELETE FROM settings WHERE key = 'partner_name'");
    migrateDb(db);
    const contacts = db.query("SELECT name FROM contacts").all() as { name: string }[];
    expect(contacts).toEqual([{ name: "Contact" }]);
  });
});
