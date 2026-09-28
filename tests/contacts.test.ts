import { describe, expect, test } from "bun:test";
import type { Db } from "../src/db-interface";
import { testDb } from "./helpers";
import {
  contactBalances,
  createContact,
  deleteContact,
  listContacts,
  renameContact,
} from "../src/contacts";
import { applySettlement } from "../src/settle";

async function seed(): Promise<Db> {
  const db = await testDb();
  await db.exec(`INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing','chequing')`);
  await db.exec(`INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES (1, 'Housing','essentials','fixed',300000)`);
  return db;
}

describe("contacts", () => {
  test("create/rename/delete round trip", async () => {
    const db = await seed();
    const id = await createContact(db, 1, "Alex");
    expect(await listContacts(db, 1)).toEqual([{ id, name: "Alex" }]);
    await renameContact(db, 1, id, "Alex R.");
    expect(await listContacts(db, 1)).toEqual([{ id, name: "Alex R." }]);
    await deleteContact(db, 1, id);
    expect(await listContacts(db, 1)).toEqual([]);
  });

  test("rejects blank names and unknown ids", async () => {
    const db = await seed();
    await expect(createContact(db, 1, "   ")).rejects.toThrow("name required");
    await expect(renameContact(db, 1, 42, "x")).rejects.toThrow("no contact 42");
    await expect(deleteContact(db, 1, 42)).rejects.toThrow("no contact 42");
  });

  test("delete is blocked while pots or splits reference the contact", async () => {
    const db = await seed();
    const id = await createContact(db, 1, "Alex");
    await db.run("UPDATE pots SET contact_id = ?, share_pct = 50 WHERE id = 1", id);
    await expect(deleteContact(db, 1, id)).rejects.toThrow("1 pot");
    await db.run("UPDATE pots SET contact_id = NULL, share_pct = NULL WHERE id = 1");

    // now a split references the contact
    await db.run(
      "INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, cleared) VALUES (1, '2026-09-01', 1, -10000, 't', 'manual', 'agent', 'cleared')"
    );
    const t = (await db.get<{ id: number }>("SELECT id FROM transactions"))!;
    await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (1, ?, 1, 'user', NULL, -5000)", t.id);
    await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (1, ?, 1, 'contact', ?, -5000)", t.id, id);
    await expect(deleteContact(db, 1, id)).rejects.toThrow("1 transaction split");
  });

  test("contactBalances reports per-contact owed, credit, and pot breakdown", async () => {
    const db = await seed();
    const alex = await createContact(db, 1, "Alex");
    const sam = await createContact(db, 1, "Sam");
    await db.run(
      "INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, cleared) VALUES (1, '2026-09-01', 1, -334000, 'rent', 'manual', 'agent', 'cleared')"
    );
    const t = (await db.get<{ id: number }>("SELECT id FROM transactions"))!;
    await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (1, ?, 1, ?, ?, ?)", t.id, "user", null, -167000);
    await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (1, ?, 1, ?, ?, ?)", t.id, "contact", alex, -167000);
    await applySettlement(db, 1, { contactId: alex, accountId: 1, amountCents: 200000 }); // 33000 credit

    const bals = await contactBalances(db, 1);
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
