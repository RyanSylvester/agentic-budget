import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { wrapDb } from "../src/db";
import type { Db } from "../src/db-interface";
import { createContact } from "../src/contacts";
import { createPot, deletePot, uncategorizedPotId, updatePot } from "../src/pots";

function seed(): Db {
  const raw = new Database(":memory:");
  raw.exec(readFileSync("src/schema.sql", "utf8"));
  raw.exec(`INSERT INTO accounts (name, type) VALUES ('Chequing','chequing')`);
  return wrapDb(raw);
}

describe("pot management", () => {
  test("create with name, group, target, and share config", async () => {
    const db = seed();
    const cid = await createContact(db, "Alex");
    const id = await createPot(db, { name: "Rent share", group: "Home", targetCents: 334000, targetType: "fixed", contactId: cid, sharePct: 50 });
    const p = await db.get("SELECT name, pot_group, target_cents, target_type, contact_id, share_pct FROM pots WHERE id = ?", id) as any;
    expect(p).toEqual({ name: "Rent share", pot_group: "Home", target_cents: 334000, target_type: "fixed", contact_id: cid, share_pct: 50 });
  });

  test("sharePct defaults to 50 when a contact is set without one", async () => {
    const db = seed();
    const cid = await createContact(db, "Alex");
    const id = await createPot(db, { name: "Groceries", group: "Food", contactId: cid });
    const p = await db.get("SELECT contact_id, share_pct FROM pots WHERE id = ?", id) as any;
    expect(p.share_pct).toBe(50);
  });

  test("rejects bad input", async () => {
    const db = seed();
    const cid = await createContact(db, "Alex");
    await expect(createPot(db, { name: "  " })).rejects.toThrow("name required");
    await expect(createPot(db, { name: "x", group: " " })).rejects.toThrow("group required");
    await expect(createPot(db, { name: "x", targetType: "nope" })).rejects.toThrow("bad targetType");
    await expect(createPot(db, { name: "x", contactId: 999, sharePct: 50 })).rejects.toThrow("no contact 999");
    await expect(createPot(db, { name: "x", contactId: cid, sharePct: 101 })).rejects.toThrow("sharePct");
    await expect(createPot(db, { name: "x", sharePct: 50 })).rejects.toThrow("sharePct needs a contact");
  });

  test("update renames, regroups, retargets, and changes the share config", async () => {
    const db = seed();
    const cid = await createContact(db, "Alex");
    const id = await createPot(db, { name: "Rent", group: "Home", targetCents: 334000 });
    await updatePot(db, id, { name: "Rent share", group: "Shared", targetCents: 340000, targetType: "average_3mo", contactId: cid, sharePct: 60 });
    const p = await db.get("SELECT name, pot_group, target_cents, target_type, contact_id, share_pct FROM pots WHERE id = ?", id) as any;
    expect(p).toEqual({ name: "Rent share", pot_group: "Shared", target_cents: 340000, target_type: "average_3mo", contact_id: cid, share_pct: 60 });
    // unshare
    await updatePot(db, id, { contactId: null });
    const q = await db.get("SELECT contact_id, share_pct FROM pots WHERE id = ?", id) as any;
    expect(q.contact_id).toBeNull();
    expect(q.share_pct).toBeNull();
    await expect(updatePot(db, 4242, { name: "x" })).rejects.toThrow("no pot 4242");
  });

  test("delete moves transactions, splits, and assignments to Uncategorized", async () => {
    const db = seed();
    const id = await createPot(db, { name: "Dining out", group: "Food", targetCents: 60000 });
    await db.run("INSERT INTO transactions (date, account_id, pot_id, amount_cents, description, source, entered_by, status, cleared) VALUES ('2026-09-10', 1, ?, -5000, 'dinner', 'manual', 'agent', 'confirmed', 'cleared')", id);
    const t = (await db.get<{ id: number }>("SELECT id FROM transactions WHERE pot_id = ?", id))!;
    await db.run("INSERT INTO splits (transaction_id, pot_id, owner, amount_cents) VALUES (?, ?, 'user', -5000)", t.id, id);
    await db.run("INSERT INTO assignments (month, pot_id, cents) VALUES ('2026-09', ?, 60000)", id);

    const summary = await deletePot(db, id);
    const uncat = await uncategorizedPotId(db);
    expect(summary.uncategorizedPotId).toBe(uncat);
    expect(summary.movedTransactions).toBe(1);
    expect(summary.movedAssignments).toBe(1);
    expect(await db.get("SELECT pot_id FROM transactions WHERE id = ?", t.id) as any).toEqual({ pot_id: uncat });
    expect(await db.get("SELECT COUNT(*) AS n FROM splits WHERE pot_id = ?", uncat) as any).toEqual({ n: 1 });
    expect(await db.get("SELECT cents FROM assignments WHERE month = '2026-09' AND pot_id = ?", uncat) as any).toEqual({ cents: 60000 });
    expect(await db.get("SELECT COUNT(*) AS n FROM pots WHERE id = ?", id) as any).toEqual({ n: 0 });
    const uncatRow = await db.get("SELECT name, pot_group FROM pots WHERE id = ?", uncat) as any;
    expect(uncatRow).toEqual({ name: "Uncategorized", pot_group: "General" });
  });

  test("delete merges assignments when Uncategorized already has some", async () => {
    const db = seed();
    const uncat = await uncategorizedPotId(db);
    await db.run("INSERT INTO assignments (month, pot_id, cents) VALUES ('2026-09', ?, 10000)", uncat);
    const id = await createPot(db, { name: "Dining out", group: "Food" });
    await db.run("INSERT INTO assignments (month, pot_id, cents) VALUES ('2026-09', ?, 60000)", id);
    await deletePot(db, id);
    expect(await db.get("SELECT cents FROM assignments WHERE month = '2026-09' AND pot_id = ?", uncat) as any).toEqual({ cents: 70000 });
  });

  test("the Uncategorized pot itself cannot be deleted", async () => {
    const db = seed();
    await expect(deletePot(db, await uncategorizedPotId(db))).rejects.toThrow("cannot be deleted");
    await expect(deletePot(db, 4242)).rejects.toThrow("no pot 4242");
  });
});
