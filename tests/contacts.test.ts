import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { wrapDb } from "../src/db";
import type { Db } from "../src/db-interface";
import {
  contactBalances,
  createContact,
  deleteContact,
  listContacts,
  renameContact,
} from "../src/contacts";
import { applySettlement } from "../src/settle";

function seed(): Db {
  const raw = new Database(":memory:");
  raw.exec(readFileSync("src/schema.sql", "utf8"));
  raw.exec(`INSERT INTO accounts (name, type) VALUES ('Chequing','chequing')`);
  raw.exec(`INSERT INTO pots (name, pot_group, target_type, target_cents) VALUES ('Housing','essentials','fixed',300000)`);
  return wrapDb(raw);
}

describe("contacts", () => {
  test("create/rename/delete round trip", async () => {
    const db = seed();
    const id = await createContact(db, "Alex");
    expect(await listContacts(db)).toEqual([{ id, name: "Alex" }]);
    await renameContact(db, id, "Alex R.");
    expect(await listContacts(db)).toEqual([{ id, name: "Alex R." }]);
    await deleteContact(db, id);
    expect(await listContacts(db)).toEqual([]);
  });

  test("rejects blank names and unknown ids", async () => {
    const db = seed();
    await expect(createContact(db, "   ")).rejects.toThrow("name required");
    await expect(renameContact(db, 42, "x")).rejects.toThrow("no contact 42");
    await expect(deleteContact(db, 42)).rejects.toThrow("no contact 42");
  });

  test("delete is blocked while pots or splits reference the contact", async () => {
    const db = seed();
    const id = await createContact(db, "Alex");
    await db.run("UPDATE pots SET contact_id = ?, share_pct = 50 WHERE id = 1", id);
    await expect(deleteContact(db, id)).rejects.toThrow("1 pot");
    await db.run("UPDATE pots SET contact_id = NULL, share_pct = NULL WHERE id = 1");

    // now a split references the contact
    await db.run(
      "INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared) VALUES ('2026-09-01', 1, -10000, 't', 'manual', 'agent', 'confirmed', 'cleared')"
    );
    const t = (await db.get<{ id: number }>("SELECT id FROM transactions"))!;
    await db.run("INSERT INTO splits (transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (?, 1, 'user', NULL, -5000)", t.id);
    await db.run("INSERT INTO splits (transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (?, 1, 'contact', ?, -5000)", t.id, id);
    await expect(deleteContact(db, id)).rejects.toThrow("1 transaction split");
  });

  test("contactBalances reports per-contact owed, credit, and pot breakdown", async () => {
    const db = seed();
    const alex = await createContact(db, "Alex");
    const sam = await createContact(db, "Sam");
    await db.run(
      "INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared) VALUES ('2026-09-01', 1, -334000, 'rent', 'manual', 'agent', 'confirmed', 'cleared')"
    );
    const t = (await db.get<{ id: number }>("SELECT id FROM transactions"))!;
    await db.run("INSERT INTO splits (transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (?, 1, ?, ?, ?)", t.id, "user", null, -167000);
    await db.run("INSERT INTO splits (transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (?, 1, ?, ?, ?)", t.id, "contact", alex, -167000);
    await applySettlement(db, { contactId: alex, accountId: 1, amountCents: 200000 }); // 33000 credit

    const bals = await contactBalances(db);
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
