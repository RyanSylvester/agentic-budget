import { describe, expect, test } from "bun:test";
import type { Db } from "../src/db-interface";
import { testDb } from "./helpers";
import { createContact } from "../src/contacts";
import { createPot, deletePot, updatePot } from "../src/pots";

async function seed(): Promise<Db> {
  const db = await testDb();
  await db.exec(`INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing','chequing')`);
  return db;
}

describe("pot management", () => {
  test("create with name, group, target, and share config", async () => {
    const db = await seed();
    const cid = await createContact(db, 1, "Alex");
    const id = await createPot(db, 1, { name: "Rent share", group: "Home", targetCents: 334000, targetType: "fixed", contactId: cid, sharePct: 50 });
    const p = await db.get("SELECT name, pot_group, target_cents, target_type, contact_id, share_pct FROM pots WHERE id = ?", id) as any;
    expect(p).toEqual({ name: "Rent share", pot_group: "Home", target_cents: 334000, target_type: "fixed", contact_id: cid, share_pct: 50 });
  });

  test("sharePct defaults to 50 when a contact is set without one", async () => {
    const db = await seed();
    const cid = await createContact(db, 1, "Alex");
    const id = await createPot(db, 1, { name: "Groceries", group: "Food", contactId: cid });
    const p = await db.get("SELECT contact_id, share_pct FROM pots WHERE id = ?", id) as any;
    expect(p.share_pct).toBe(50);
  });

  test("rejects bad input", async () => {
    const db = await seed();
    const cid = await createContact(db, 1, "Alex");
    await expect(createPot(db, 1, { name: "  " })).rejects.toThrow("name required");
    await expect(createPot(db, 1, { name: "x", group: " " })).rejects.toThrow("group required");
    await expect(createPot(db, 1, { name: "x", targetType: "nope" })).rejects.toThrow("bad targetType");
    await expect(createPot(db, 1, { name: "x", contactId: 999, sharePct: 50 })).rejects.toThrow("no contact 999");
    await expect(createPot(db, 1, { name: "x", contactId: cid, sharePct: 101 })).rejects.toThrow("sharePct");
    await expect(createPot(db, 1, { name: "x", sharePct: 50 })).rejects.toThrow("sharePct needs a contact");
  });

  test("update renames, regroups, retargets, and changes the share config", async () => {
    const db = await seed();
    const cid = await createContact(db, 1, "Alex");
    const id = await createPot(db, 1, { name: "Rent", group: "Home", targetCents: 334000 });
    await updatePot(db, 1, id, { name: "Rent share", group: "Shared", targetCents: 340000, targetType: "average_3mo", contactId: cid, sharePct: 60 });
    const p = await db.get("SELECT name, pot_group, target_cents, target_type, contact_id, share_pct FROM pots WHERE id = ?", id) as any;
    expect(p).toEqual({ name: "Rent share", pot_group: "Shared", target_cents: 340000, target_type: "average_3mo", contact_id: cid, share_pct: 60 });
    // unshare
    await updatePot(db, 1, id, { contactId: null });
    const q = await db.get("SELECT contact_id, share_pct FROM pots WHERE id = ?", id) as any;
    expect(q.contact_id).toBeNull();
    expect(q.share_pct).toBeNull();
    await expect(updatePot(db, 1, 4242, { name: "x" })).rejects.toThrow("no pot 4242");
  });

  test("delete moves transactions, splits, and assignments to the chosen destination pot", async () => {
    const db = await seed();
    const dest = await createPot(db, 1, { name: "Groceries", group: "Food" });
    const id = await createPot(db, 1, { name: "Dining out", group: "Food", targetCents: 60000 });
    await db.run("INSERT INTO transactions (user_id, date, account_id, pot_id, amount_cents, description, source, entered_by, cleared) VALUES (1, '2026-09-10', 1, ?, -5000, 'dinner', 'manual', 'agent', 'cleared')", id);
    const t = (await db.get<{ id: number }>("SELECT id FROM transactions WHERE pot_id = ? AND user_id = ?", id, 1))!;
    await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, amount_cents) VALUES (1, ?, ?, 'user', -5000)", t.id, id);
    await db.run("INSERT INTO assignments (user_id, month, pot_id, cents) VALUES (1, '2026-09', ?, 60000)", id);

    const summary = await deletePot(db, 1, id, dest);
    expect(summary.moveToPotId).toBe(dest);
    expect(summary.moveToPotName).toBe("Groceries");
    expect(summary.movedTransactions).toBe(1);
    expect(summary.movedAssignments).toBe(1);
    expect(await db.get("SELECT pot_id FROM transactions WHERE id = ?", t.id) as any).toEqual({ pot_id: dest });
    expect(await db.get("SELECT COUNT(*) AS n FROM splits WHERE pot_id = ? AND user_id = ?", dest, 1) as any).toEqual({ n: 1 });
    expect(await db.get("SELECT cents FROM assignments WHERE month = '2026-09' AND pot_id = ? AND user_id = ?", dest, 1) as any).toEqual({ cents: 60000 });
    expect(await db.get("SELECT COUNT(*) AS n FROM pots WHERE id = ?", id) as any).toEqual({ n: 0 });
  });

  test("delete merges assignments when the destination already has some", async () => {
    const db = await seed();
    const dest = await createPot(db, 1, { name: "Groceries", group: "Food" });
    await db.run("INSERT INTO assignments (user_id, month, pot_id, cents) VALUES (1, '2026-09', ?, 10000)", dest);
    const id = await createPot(db, 1, { name: "Dining out", group: "Food" });
    await db.run("INSERT INTO assignments (user_id, month, pot_id, cents) VALUES (1, '2026-09', ?, 60000)", id);
    await deletePot(db, 1, id, dest);
    expect(await db.get("SELECT cents FROM assignments WHERE month = '2026-09' AND pot_id = ? AND user_id = ?", dest, 1) as any).toEqual({ cents: 70000 });
  });

  test("delete requires a destination pot", async () => {
    const db = await seed();
    const a = await createPot(db, 1, { name: "Groceries", group: "Food" });
    const b = await createPot(db, 1, { name: "Dining out", group: "Food" });
    await expect(deletePot(db, 1, b, undefined)).rejects.toThrow("moveToPotId required");
    await expect(deletePot(db, 1, b, null)).rejects.toThrow("moveToPotId required");
    await expect(deletePot(db, 1, b, "Groceries")).rejects.toThrow("moveToPotId required");
    await expect(deletePot(db, 1, b, b)).rejects.toThrow("must be a different pot");
    await expect(deletePot(db, 1, b, 4242)).rejects.toThrow("no pot 4242");
    await expect(deletePot(db, 1, 4242, a)).rejects.toThrow("no pot 4242");
    // Both pots survive the failed deletes.
    expect(await db.get("SELECT COUNT(*) AS n FROM pots WHERE user_id = ?", 1) as any).toEqual({ n: 2 });
  });

  test("the last pot cannot be deleted: with one pot there is no valid destination", async () => {
    const db = await seed();
    const only = await createPot(db, 1, { name: "Groceries", group: "Food" });
    // Itself is rejected, an unknown id is rejected, and another user's pot is
    // rejected: no destination validates, so the only pot is undeletable.
    await expect(deletePot(db, 1, only, only)).rejects.toThrow("must be a different pot");
    await expect(deletePot(db, 1, only, 4242)).rejects.toThrow("no pot 4242");
    await db.run("INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES (2, 'Other', 'Food', 'average_3mo', 0)");
    const other = (await db.get<{ id: number }>("SELECT id FROM pots WHERE user_id = 2"))!;
    await expect(deletePot(db, 1, only, other.id)).rejects.toThrow("no pot");
    expect(await db.get("SELECT COUNT(*) AS n FROM pots WHERE user_id = ?", 1) as any).toEqual({ n: 1 });
  });
});
