import { describe, expect, test } from "bun:test";
import type { Db } from "../src/db-interface";
import { testDb } from "./helpers";
import { assignToPot, assignedToPot } from "../src/assign";
import { assignedTotal, potInflow, rtaCents } from "../src/queries";
import { createTransaction } from "../src/transactions";

async function seed(): Promise<Db> {
  const db = await testDb();
  await db.exec(`INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing','chequing')`);
  await db.exec(`INSERT INTO pots (user_id, name, pot_group, target_type, target_cents, is_assignable) VALUES
    (1, 'Groceries','Food','average_3mo',60000,1),
    (1, 'Paycheck','Income','fixed',0,0),
    (1, 'Interest','Income','fixed',0,0)`);
  return db;
}

describe("planned income on income pots", () => {
  test("assignToPot accepts an income pot and stores planned income", async () => {
    const db = await seed();
    const r = await assignToPot(db, 1, "2026-09", "Paycheck", 500000);
    expect(r.cents).toBe(500000);
    expect(await assignedToPot(db, 1, "2026-09", r.potId)).toBe(500000);
  });

  test("planned income is excluded from assignedTotal", async () => {
    const db = await seed();
    await assignToPot(db, 1, "2026-09", "Groceries", 60000);
    await assignToPot(db, 1, "2026-09", "Paycheck", 500000);
    await assignToPot(db, 1, "2026-09", "Interest", 1200);
    expect(await assignedTotal(db, 1, "2026-09")).toBe(60000);
  });

  test("planned income does not change RTA; only actual inflows and spending assignments do", async () => {
    const db = await seed();
    await assignToPot(db, 1, "2026-09", "Paycheck", 520000);
    await assignToPot(db, 1, "2026-09", "Groceries", 60000);
    await createTransaction(db, 1, { date: "2026-09-15", accountId: 1, potId: 2, amountCents: 500000, description: "Pay" });
    // RTA = actual inflows - spending-pot assignments; the 520000 planned is ignored.
    expect(await rtaCents(db, 1, "2026-09")).toBe(500000 - 60000);
  });

  test("potInflow reports what actually landed per income pot", async () => {
    const db = await seed();
    await createTransaction(db, 1, { date: "2026-09-15", accountId: 1, potId: 2, amountCents: 500000, description: "Pay" });
    await createTransaction(db, 1, { date: "2026-09-20", accountId: 1, potId: 3, amountCents: 1200, description: "Interest" });
    expect(await potInflow(db, 1, 2, "2026-09")).toBe(500000);
    expect(await potInflow(db, 1, 3, "2026-09")).toBe(1200);
    expect(await potInflow(db, 1, 1, "2026-09")).toBe(0);
    expect(await potInflow(db, 1, 2, "2026-08")).toBe(0);
  });

  test("hidden pots are still rejected", async () => {
    const db = await seed();
    await db.run("UPDATE pots SET hidden = 1 WHERE name = 'Paycheck'");
    await expect(assignToPot(db, 1, "2026-09", "Paycheck", 1)).rejects.toThrow("retired");
  });
});
