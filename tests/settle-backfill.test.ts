import { describe, expect, test } from "bun:test";
import type { Db } from "../src/db-interface";
import { testDb } from "./helpers";
import { backfillSettlementAllocations, contactCredit, contactOwed } from "../src/settle";

/** All fixtures are invented. Nothing here comes from real data. */
async function seed(): Promise<Db> {
  const db = await testDb();
  await db.exec(`INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing','chequing')`);
  await db.exec(`INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES (1, 'Housing','essentials','fixed',300000), (1, 'Groceries','essentials','average_3mo',120000)`);
  await db.exec(`INSERT INTO contacts (user_id, name) VALUES (1, 'Alex'), (1, 'Blake')`);
  return db;
}

/** A shared expense the contact owes half of (contact split: negative). */
async function addOwed(db: Db, date: string, contactCents: number, potId: number, contactId = 1) {
  const t = (await db.get<{ id: number }>(
    "INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, cleared) VALUES (1, ?, 1, ?, 't', 'manual', 'agent', 'cleared') RETURNING id",
    date,
    -contactCents * 2
  ))!;
  await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (1, ?, ?, 'user', NULL, ?)", t.id, potId, -contactCents);
  await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (1, ?, ?, 'contact', ?, ?)", t.id, potId, contactId, -contactCents);
}

/** A settlement written the way the historical hand-written ones were: the
 *  settlement row carries the full leftover but NO settlement_allocations. */
async function addUnallocatedSettlement(db: Db, date: string, amountCents: number): Promise<number> {
  const t = (await db.get<{ id: number }>(
    "INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, cleared) VALUES (1, ?, 1, ?, 'settlement', 'manual', 'agent', 'cleared') RETURNING id",
    date,
    amountCents
  ))!;
  await db.run("INSERT INTO splits (user_id, transaction_id, owner, contact_id, amount_cents) VALUES (1, ?, 'contact', 1, ?)", t.id, amountCents);
  const st = (await db.get<{ id: number }>(
    "INSERT INTO settlements (user_id, transaction_id, date, amount_cents, leftover_cents, note) VALUES (1, ?, ?, ?, ?, NULL) RETURNING id",
    t.id,
    date,
    amountCents,
    amountCents
  ))!;
  return st.id;
}

const totalOwed = (owed: { owedCents: number }[]) => owed.reduce((a, o) => a + o.owedCents, 0);

describe("settle backfill", () => {
  test("allocates oldest first across multiple pots", async () => {
    const db = await seed();
    await addOwed(db, "2026-09-01", 10000, 1); // Housing, oldest
    await addOwed(db, "2026-09-05", 4000, 2);  // Groceries
    await addUnallocatedSettlement(db, "2026-09-10", 10000);

    const r = await backfillSettlementAllocations(db, 1, 1);
    expect(r.contactId).toBe(1);
    expect(r.allocationsWritten).toBe(1);
    expect(r.creditRemainingCents).toBe(0);

    // Housing filled, Groceries still outstanding
    const owed = await contactOwed(db, 1, 1);
    expect(totalOwed(owed)).toBe(4000);
    expect(owed[0].potName).toBe("Groceries");
    expect(await contactCredit(db, 1, 1)).toBe(0);
  });

  test("partial payment leaves the correct remainder", async () => {
    const db = await seed();
    await addOwed(db, "2026-09-01", 10000, 1);
    await addOwed(db, "2026-09-05", 4000, 2);
    await addUnallocatedSettlement(db, "2026-09-10", 6000);

    const r = await backfillSettlementAllocations(db, 1, 1);
    expect(r.allocationsWritten).toBe(1);
    expect(r.creditRemainingCents).toBe(0);

    const owed = await contactOwed(db, 1, 1);
    expect(totalOwed(owed)).toBe(8000); // $40 Housing + $40 Groceries
    expect(owed.map((o) => o.potName)).toEqual(["Housing", "Groceries"]);
  });

  test("overpayment keeps the rest as credit", async () => {
    const db = await seed();
    await addOwed(db, "2026-09-01", 10000, 1);
    await addUnallocatedSettlement(db, "2026-09-10", 15000);

    const r = await backfillSettlementAllocations(db, 1, 1);
    expect(r.allocationsWritten).toBe(1);
    expect(r.creditRemainingCents).toBe(5000);

    expect(await contactOwed(db, 1, 1)).toEqual([]);
    expect(await contactCredit(db, 1, 1)).toBe(5000);
  });

  test("multiple unallocated settlements processed oldest first", async () => {
    const db = await seed();
    await addOwed(db, "2026-09-01", 10000, 1);
    const older = await addUnallocatedSettlement(db, "2026-09-10", 6000);
    const newer = await addUnallocatedSettlement(db, "2026-09-15", 6000);

    const r = await backfillSettlementAllocations(db, 1, 1);
    expect(r.allocationsWritten).toBe(2);
    expect(r.creditRemainingCents).toBe(2000);

    // Older settlement fully consumed, newer keeps the $20 remainder
    const leftovers = await db.all<{ id: number; leftover_cents: number }>(
      "SELECT id, leftover_cents FROM settlements ORDER BY id"
    );
    expect(leftovers).toEqual([
      { id: older, leftover_cents: 0 },
      { id: newer, leftover_cents: 2000 },
    ]);
    expect(await contactOwed(db, 1, 1)).toEqual([]);
  });

  test("re-running is a no-op", async () => {
    const db = await seed();
    await addOwed(db, "2026-09-01", 10000, 1);
    await addUnallocatedSettlement(db, "2026-09-10", 15000);

    await backfillSettlementAllocations(db, 1, 1);
    const allocsBefore = (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM settlement_allocations"))!.n;

    const r = await backfillSettlementAllocations(db, 1, 1);
    expect(r.allocationsWritten).toBe(0);
    expect(r.creditRemainingCents).toBe(5000);
    const allocsAfter = (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM settlement_allocations"))!.n;
    expect(allocsAfter).toBe(allocsBefore);
  });

  test("contact with no settlements is a no-op", async () => {
    const db = await seed();
    await addOwed(db, "2026-09-01", 5000, 1, 2); // Blake owes $50

    const r = await backfillSettlementAllocations(db, 1, 2); // Blake
    expect(r.contactId).toBe(2);
    expect(r.allocationsWritten).toBe(0);
    expect(r.creditRemainingCents).toBe(0);
    expect(totalOwed(await contactOwed(db, 1, 2))).toBe(5000);
  });

  test("unknown contact throws", async () => {
    const db = await seed();
    await expect(backfillSettlementAllocations(db, 1, 99)).rejects.toThrow("no contact 99");
  });
});
