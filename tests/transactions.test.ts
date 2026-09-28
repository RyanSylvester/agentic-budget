import { describe, expect, test } from "bun:test";
import type { Db } from "../src/db-interface";
import { testDb } from "./helpers";
import { createTransaction, updateTransaction, moneyLockReason } from "../src/transactions";
import { listTransactions } from "../src/queries";

async function seed(): Promise<Db> {
  const db = await testDb();
  await db.exec(`INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing','chequing'), (1, 'Card','credit_card')`);
  await db.exec(`INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES
    (1, 'Groceries','Food','average_3mo',60000),
    (1, 'Paycheck','Income','fixed',0),
    (1, 'Old Pot','Food','fixed',0)`);
  await db.exec(`INSERT INTO contacts (user_id, name) VALUES (1, 'Alex')`);
  await db.run("UPDATE pots SET hidden = 1 WHERE name = 'Old Pot'");
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
  test("records an outflow with a user split", async () => {
    const db = await seed();
    const id = await createTransaction(db, 1, base);
    const t = await db.get("SELECT * FROM transactions WHERE id = ?", id) as any;
    expect(t.description).toBe("Test purchase");
    expect(t.amount_cents).toBe(-2599);
    expect(t.source).toBe("manual");
    expect(t.entered_by).toBe("user");
    const splits = await db.all("SELECT owner, amount_cents, pot_id FROM splits WHERE transaction_id = ?", id) as any[];
    expect(splits).toEqual([{ owner: "user", amount_cents: -2599, pot_id: 1 }]);
  });

  test("records an inflow", async () => {
    const db = await seed();
    const id = await createTransaction(db, 1, { ...base, amountCents: 250000, potId: 2, description: "Pay" });
    const splits = await db.all("SELECT owner, amount_cents FROM splits WHERE transaction_id = ?", id) as any[];
    expect(splits).toEqual([{ owner: "user", amount_cents: 250000 }]);
  });

  test("splits with a contact sum to the amount", async () => {
    const db = await seed();
    const id = await createTransaction(db, 1, { ...base, amountCents: -10000, contactId: 1, shareCents: -5000 });
    const splits = await db.all("SELECT owner, contact_id, amount_cents FROM splits WHERE transaction_id = ? ORDER BY owner", id) as any[];
    expect(splits).toEqual([
      { owner: "contact", contact_id: 1, amount_cents: -5000 },
      { owner: "user", contact_id: null, amount_cents: -5000 },
    ]);
  });

  test("records a transfer without a pot", async () => {
    const db = await seed();
    const id = await createTransaction(db, 1, {
      date: "2026-09-26", accountId: 1, amountCents: -37500,
      description: "Move to savings", isTransfer: true,
    });
    const t = await db.get("SELECT is_transfer FROM transactions WHERE id = ?", id) as any;
    expect(t.is_transfer).toBe(1);
  });

  test("rejects bad input", async () => {
    const db = await seed();
    await expect(createTransaction(db, 1, { ...base, date: "2026-13-40" })).rejects.toThrow("bad date");
    await expect(createTransaction(db, 1, { ...base, amountCents: 0 })).rejects.toThrow("nonzero");
    await expect(createTransaction(db, 1, { ...base, description: "  " })).rejects.toThrow("description required");
    await expect(createTransaction(db, 1, { ...base, accountId: 99 })).rejects.toThrow("no account 99");
    await expect(createTransaction(db, 1, { ...base, potId: 99 })).rejects.toThrow("no pot 99");
    await expect(createTransaction(db, 1, { ...base, potId: 3 })).rejects.toThrow("no pot 3"); // hidden
    await expect(createTransaction(db, 1, { ...base, contactId: 1, shareCents: -2599 })).rejects.toThrow("smaller than");
    await expect(createTransaction(db, 1, { ...base, contactId: 1, shareCents: 5000 })).rejects.toThrow("same sign");
    await expect(createTransaction(db, 1, { ...base, contactId: 99, shareCents: -100 })).rejects.toThrow("no contact 99");
    await expect(createTransaction(db, 1, { ...base, shareCents: -100 })).rejects.toThrow("contactId required");
    await expect(createTransaction(db, 1, { ...base, isTransfer: true, contactId: 1, shareCents: -100 })).rejects.toThrow("cannot be split");
  });
});

describe("updateTransaction", () => {
  test("edits description and date, keeps splits", async () => {
    const db = await seed();
    const id = await createTransaction(db, 1, base);
    await updateTransaction(db, 1, id, { ...base, description: "Renamed", date: "2026-09-25" });
    const t = await db.get("SELECT description, date FROM transactions WHERE id = ?", id) as any;
    expect(t.description).toBe("Renamed");
    expect(t.date).toBe("2026-09-25");
  });

  test("changes amount and rebuilds splits", async () => {
    const db = await seed();
    const id = await createTransaction(db, 1, base);
    await updateTransaction(db, 1, id, { ...base, amountCents: -3000 });
    const splits = await db.all("SELECT owner, amount_cents FROM splits WHERE transaction_id = ?", id) as any[];
    expect(splits).toEqual([{ owner: "user", amount_cents: -3000 }]);
  });

  test("recategorizes to another pot", async () => {
    const db = await seed();
    const id = await createTransaction(db, 1, base);
    await updateTransaction(db, 1, id, { ...base, potId: 2 });
    const splits = await db.all("SELECT pot_id FROM splits WHERE transaction_id = ?", id) as any[];
    expect(splits).toEqual([{ pot_id: 2 }]);
  });

  test("adds a contact split on edit", async () => {
    const db = await seed();
    const id = await createTransaction(db, 1, base);
    await updateTransaction(db, 1, id, { ...base, amountCents: -10000, contactId: 1, shareCents: -5000 });
    const total = await db.get("SELECT SUM(amount_cents) AS s FROM splits WHERE transaction_id = ?", id) as any;
    expect(total.s).toBe(-10000);
  });

  test("rejects amount changes on cleared transactions", async () => {
    const db = await seed();
    const id = await createTransaction(db, 1, base);
    await db.run("UPDATE transactions SET cleared = 'cleared' WHERE id = ?", id);
    await expect(updateTransaction(db, 1, id, { ...base, amountCents: -1 })).rejects.toThrow("already cleared");
    // description-only edits still work
    await updateTransaction(db, 1, id, { ...base, description: "Still editable" });
    expect((await db.get("SELECT description FROM transactions WHERE id = ?", id) as any).description).toBe("Still editable");
  });

  test("rejects amount changes on settlement-linked transactions", async () => {
    const db = await seed();
    const id = await createTransaction(db, 1, { ...base, amountCents: -10000, contactId: 1, shareCents: -5000 });
    const splitId = (await db.get("SELECT id FROM splits WHERE transaction_id = ? AND owner = 'contact'", id) as any).id;
    await db.run("INSERT INTO settlements (user_id, transaction_id, date, amount_cents) VALUES (1, ?, '2026-09-27', 5000)", id);
    const stId = (await db.get("SELECT id FROM settlements WHERE transaction_id = ?", id) as any).id;
    await db.run("INSERT INTO settlement_allocations (user_id, settlement_id, split_id, amount_cents) VALUES (1, ?, ?, 100)", stId, splitId);
    expect(await moneyLockReason(db, 1, id)).toMatch("settlement");
    await expect(updateTransaction(db, 1, id, { ...base, amountCents: -9000, contactId: 1, shareCents: -4500 })).rejects.toThrow("settlement");
  });

  test("throws on unknown id", async () => {
    const db = await seed();
    await expect(updateTransaction(db, 1, 4242, base)).rejects.toThrow("no transaction 4242");
  });
});

describe("listTransactions", () => {
  test("lists a month newest-first with pot and contact detail, skips voided", async () => {
    const db = await seed();
    const a = await createTransaction(db, 1, { ...base, date: "2026-09-20" });
    await createTransaction(db, 1, { ...base, date: "2026-09-26", amountCents: -10000, contactId: 1, shareCents: -5000, description: "Split shop" });
    await createTransaction(db, 1, { ...base, date: "2026-08-15", description: "Old month" });
    await db.run("UPDATE transactions SET voided = 1 WHERE id = ?", a);

    const rows = await listTransactions(db, 1, "2026-09");
    expect(rows.map((r) => r.description)).toEqual(["Split shop"]);
    const r = rows[0];
    expect(r.potName).toBe("Groceries");
    expect(r.potGroup).toBe("Food");
    expect(r.splitWithContact).toBe(1);
    expect(r.sharedCents).toBe(5000);
    expect(r.splitContactName).toBe("Alex");
    expect(r.accountName).toBe("Chequing");
  });
});
