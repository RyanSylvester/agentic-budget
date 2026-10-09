import { describe, expect, test } from "bun:test";
import type { Db } from "../src/db-interface";
import { testDb } from "./helpers";
import { assignToPot, assignManyToPot } from "../src/assign";
import { assignedTotal, rtaCents } from "../src/queries";
import { closePreview } from "../src/close";
import { createTransaction } from "../src/transactions";

async function seed(): Promise<Db> {
  const db = await testDb();
  await db.exec(`INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing','chequing')`);
  await db.exec(`INSERT INTO pots (user_id, name, pot_group, target_type, target_cents, is_assignable) VALUES
    (1, 'Rent','Bills','fixed',300000,1),
    (1, 'Groceries','Food','average_3mo',60000,1),
    (1, 'Pay Bridge','Bridge','fixed',0,1),
    (1, 'Hydro Reimbursed','Reimbursements','fixed',0,1),
    (1, 'Paycheck','Income','fixed',0,0)`);
  return db;
}

describe("negative assignments on spending pots", () => {
  test("bridge and reimbursement offsets let RTA reach $0", async () => {
    const db = await seed();
    await createTransaction(db, 1, { date: "2026-10-01", accountId: 1, potId: 5, amountCents: 200000, description: "Pay" });
    // A mirrored budget assigns more than landed this month, balanced by offsets.
    await assignToPot(db, 1, "2026-10", "Rent", 300000);
    await assignToPot(db, 1, "2026-10", "Groceries", 60000);
    expect(await rtaCents(db, 1, "2026-10")).toBe(-160000);
    await assignToPot(db, 1, "2026-10", "Pay Bridge", -150000);
    await assignToPot(db, 1, "2026-10", "Hydro Reimbursed", -10000);
    expect(await assignedTotal(db, 1, "2026-10")).toBe(200000);
    expect(await rtaCents(db, 1, "2026-10")).toBe(0);
    expect((await closePreview(db, 1, "2026-10")).rtaBeforeCents).toBe(0);
  });

  test("income pots still refuse a negative assignment", async () => {
    const db = await seed();
    await expect(assignToPot(db, 1, "2026-10", "Paycheck", -100)).rejects.toThrow(/income pot/);
    await expect(assignManyToPot(db, 1, "2026-10", [{ potId: 5, cents: -100 }])).rejects.toThrow(/income pot/);
  });

  test("bulk upsert accepts negatives on spending pots", async () => {
    const db = await seed();
    await assignManyToPot(db, 1, "2026-10", [
      { potId: 1, cents: 300000 },
      { potId: 3, cents: -300000 },
    ]);
    expect(await assignedTotal(db, 1, "2026-10")).toBe(0);
  });

  test("non-integer amounts are still rejected", async () => {
    const db = await seed();
    await expect(assignToPot(db, 1, "2026-10", "Rent", 1.5)).rejects.toThrow(/integer/);
  });
});
