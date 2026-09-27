import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { createContact } from "../src/contacts";
import { createPot, deletePot, uncategorizedPotId, updatePot } from "../src/pots";

function seed(): Database {
  const db = new Database(":memory:");
  db.exec(readFileSync("src/schema.sql", "utf8"));
  db.exec(`INSERT INTO accounts (name, type) VALUES ('Chequing','chequing')`);
  return db;
}

describe("pot management", () => {
  test("create with name, group, target, and share config", () => {
    const db = seed();
    const cid = createContact(db, "Alex");
    const id = createPot(db, { name: "Rent share", group: "Home", targetCents: 334000, targetType: "fixed", contactId: cid, sharePct: 50 });
    const p = db.query("SELECT name, pot_group, target_cents, target_type, contact_id, share_pct FROM pots WHERE id = ?").get(id) as any;
    expect(p).toEqual({ name: "Rent share", pot_group: "Home", target_cents: 334000, target_type: "fixed", contact_id: cid, share_pct: 50 });
  });

  test("sharePct defaults to 50 when a contact is set without one", () => {
    const db = seed();
    const cid = createContact(db, "Alex");
    const id = createPot(db, { name: "Groceries", group: "Food", contactId: cid });
    const p = db.query("SELECT contact_id, share_pct FROM pots WHERE id = ?").get(id) as any;
    expect(p.share_pct).toBe(50);
  });

  test("rejects bad input", () => {
    const db = seed();
    const cid = createContact(db, "Alex");
    expect(() => createPot(db, { name: "  " })).toThrow("name required");
    expect(() => createPot(db, { name: "x", group: " " })).toThrow("group required");
    expect(() => createPot(db, { name: "x", targetType: "nope" })).toThrow("bad targetType");
    expect(() => createPot(db, { name: "x", contactId: 999, sharePct: 50 })).toThrow("no contact 999");
    expect(() => createPot(db, { name: "x", contactId: cid, sharePct: 101 })).toThrow("sharePct");
    expect(() => createPot(db, { name: "x", sharePct: 50 })).toThrow("sharePct needs a contact");
  });

  test("update renames, regroups, retargets, and changes the share config", () => {
    const db = seed();
    const cid = createContact(db, "Alex");
    const id = createPot(db, { name: "Rent", group: "Home", targetCents: 334000 });
    updatePot(db, id, { name: "Rent share", group: "Shared", targetCents: 340000, targetType: "average_3mo", contactId: cid, sharePct: 60 });
    const p = db.query("SELECT name, pot_group, target_cents, target_type, contact_id, share_pct FROM pots WHERE id = ?").get(id) as any;
    expect(p).toEqual({ name: "Rent share", pot_group: "Shared", target_cents: 340000, target_type: "average_3mo", contact_id: cid, share_pct: 60 });
    // unshare
    updatePot(db, id, { contactId: null });
    const q = db.query("SELECT contact_id, share_pct FROM pots WHERE id = ?").get(id) as any;
    expect(q.contact_id).toBeNull();
    expect(q.share_pct).toBeNull();
    expect(() => updatePot(db, 4242, { name: "x" })).toThrow("no pot 4242");
  });

  test("delete moves transactions, splits, and assignments to Uncategorized", () => {
    const db = seed();
    const id = createPot(db, { name: "Dining out", group: "Food", targetCents: 60000 });
    db.query("INSERT INTO transactions (date, account_id, pot_id, amount_cents, description, source, entered_by, status, cleared) VALUES ('2026-09-10', 1, ?, -5000, 'dinner', 'manual', 'agent', 'confirmed', 'cleared')").run(id);
    const t = db.query("SELECT id FROM transactions WHERE pot_id = ?").get(id) as { id: number };
    db.query("INSERT INTO splits (transaction_id, pot_id, owner, amount_cents) VALUES (?, ?, 'user', -5000)").run(t.id, id);
    db.query("INSERT INTO assignments (month, pot_id, cents) VALUES ('2026-09', ?, 60000)").run(id);

    const summary = deletePot(db, id);
    const uncat = uncategorizedPotId(db);
    expect(summary.uncategorizedPotId).toBe(uncat);
    expect(summary.movedTransactions).toBe(1);
    expect(summary.movedAssignments).toBe(1);
    expect(db.query("SELECT pot_id FROM transactions WHERE id = ?").get(t.id) as any).toEqual({ pot_id: uncat });
    expect(db.query("SELECT COUNT(*) AS n FROM splits WHERE pot_id = ?").get(uncat) as any).toEqual({ n: 1 });
    expect(db.query("SELECT cents FROM assignments WHERE month = '2026-09' AND pot_id = ?").get(uncat) as any).toEqual({ cents: 60000 });
    expect(db.query("SELECT COUNT(*) AS n FROM pots WHERE id = ?").get(id) as any).toEqual({ n: 0 });
    const uncatRow = db.query("SELECT name, pot_group FROM pots WHERE id = ?").get(uncat) as any;
    expect(uncatRow).toEqual({ name: "Uncategorized", pot_group: "General" });
  });

  test("delete merges assignments when Uncategorized already has some", () => {
    const db = seed();
    const uncat = uncategorizedPotId(db);
    db.query("INSERT INTO assignments (month, pot_id, cents) VALUES ('2026-09', ?, 10000)").run(uncat);
    const id = createPot(db, { name: "Dining out", group: "Food" });
    db.query("INSERT INTO assignments (month, pot_id, cents) VALUES ('2026-09', ?, 60000)").run(id);
    deletePot(db, id);
    expect(db.query("SELECT cents FROM assignments WHERE month = '2026-09' AND pot_id = ?").get(uncat) as any).toEqual({ cents: 70000 });
  });

  test("the Uncategorized pot itself cannot be deleted", () => {
    const db = seed();
    expect(() => deletePot(db, uncategorizedPotId(db))).toThrow("cannot be deleted");
    expect(() => deletePot(db, 4242)).toThrow("no pot 4242");
  });
});
