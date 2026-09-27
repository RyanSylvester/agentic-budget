import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  contactBalances,
  createContact,
  deleteContact,
  listContacts,
  renameContact,
} from "../src/contacts";
import { applySettlement } from "../src/settle";

function seed(): Database {
  const db = new Database(":memory:");
  db.exec(readFileSync("src/schema.sql", "utf8"));
  db.exec(`INSERT INTO accounts (name, type) VALUES ('Chequing','chequing')`);
  db.exec(`INSERT INTO pots (name, pot_group, target_type, target_cents) VALUES ('Housing','essentials','fixed',300000)`);
  return db;
}

describe("contacts", () => {
  test("create/rename/delete round trip", () => {
    const db = seed();
    const id = createContact(db, "Alex");
    expect(listContacts(db)).toEqual([{ id, name: "Alex" }]);
    renameContact(db, id, "Alex R.");
    expect(listContacts(db)).toEqual([{ id, name: "Alex R." }]);
    deleteContact(db, id);
    expect(listContacts(db)).toEqual([]);
  });

  test("rejects blank names and unknown ids", () => {
    const db = seed();
    expect(() => createContact(db, "   ")).toThrow("name required");
    expect(() => renameContact(db, 42, "x")).toThrow("no contact 42");
    expect(() => deleteContact(db, 42)).toThrow("no contact 42");
  });

  test("delete is blocked while pots or splits reference the contact", () => {
    const db = seed();
    const id = createContact(db, "Alex");
    db.query("UPDATE pots SET contact_id = ?, share_pct = 50 WHERE id = 1").run(id);
    expect(() => deleteContact(db, id)).toThrow("1 pot");
    db.query("UPDATE pots SET contact_id = NULL, share_pct = NULL WHERE id = 1").run();

    // now a split references the contact
    db.query(
      "INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared) VALUES ('2026-09-01', 1, -10000, 't', 'manual', 'agent', 'confirmed', 'cleared')"
    ).run();
    const t = db.query("SELECT id FROM transactions").get() as { id: number };
    db.query("INSERT INTO splits (transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (?, 1, 'user', NULL, -5000)").run(t.id);
    db.query("INSERT INTO splits (transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (?, 1, 'contact', ?, -5000)").run(t.id, id);
    expect(() => deleteContact(db, id)).toThrow("1 transaction split");
  });

  test("contactBalances reports per-contact owed, credit, and pot breakdown", () => {
    const db = seed();
    const alex = createContact(db, "Alex");
    const sam = createContact(db, "Sam");
    db.query(
      "INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared) VALUES ('2026-09-01', 1, -334000, 'rent', 'manual', 'agent', 'confirmed', 'cleared')"
    ).run();
    const t = db.query("SELECT id FROM transactions").get() as { id: number };
    const ins = db.query("INSERT INTO splits (transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (?, 1, ?, ?, ?)");
    ins.run(t.id, "user", null, -167000);
    ins.run(t.id, "contact", alex, -167000);
    applySettlement(db, { contactId: alex, accountId: 1, amountCents: 200000 }); // 33000 credit

    const bals = contactBalances(db);
    const a = bals.find((b) => b.id === alex)!;
    const s = bals.find((b) => b.id === sam)!;
    expect(a.totalOwedCents).toBe(0);
    expect(a.creditCents).toBe(33000);
    expect(a.byPot).toEqual([]);
    expect(a.oldest).toBeNull();
    expect(s.totalOwedCents).toBe(0);
    expect(s.creditCents).toBe(0);
  });
});
