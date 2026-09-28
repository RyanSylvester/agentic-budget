import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { wrapDb } from "../src/db";
import type { Db } from "../src/db-interface";
import { assignToPot, assignedToPot } from "../src/assign";
import { assignedTotal, potInflow, rtaCents } from "../src/queries";
import { createTransaction } from "../src/transactions";

function seed(): Db {
  const raw = new Database(":memory:");
  raw.exec(readFileSync("src/schema.sql", "utf8"));
  raw.exec(`INSERT INTO accounts (name, type) VALUES ('Chequing','chequing')`);
  raw.exec(`INSERT INTO pots (name, pot_group, target_type, target_cents, is_assignable) VALUES
    ('Groceries','Food','average_3mo',60000,1),
    ('Paycheck','Income','fixed',0,0),
    ('Interest','Income','fixed',0,0)`);
  return wrapDb(raw);
}

describe("planned income on income pots", () => {
  test("assignToPot accepts an income pot and stores planned income", async () => {
    const db = seed();
    const r = await assignToPot(db, "2026-09", "Paycheck", 500000);
    expect(r.cents).toBe(500000);
    expect(await assignedToPot(db, "2026-09", r.potId)).toBe(500000);
  });

  test("planned income is excluded from assignedTotal", async () => {
    const db = seed();
    await assignToPot(db, "2026-09", "Groceries", 60000);
    await assignToPot(db, "2026-09", "Paycheck", 500000);
    await assignToPot(db, "2026-09", "Interest", 1200);
    expect(await assignedTotal(db, "2026-09")).toBe(60000);
  });

  test("planned income does not change RTA; only actual inflows and spending assignments do", async () => {
    const db = seed();
    await assignToPot(db, "2026-09", "Paycheck", 520000);
    await assignToPot(db, "2026-09", "Groceries", 60000);
    await createTransaction(db, { date: "2026-09-15", accountId: 1, potId: 2, amountCents: 500000, description: "Pay" });
    // RTA = actual inflows - spending-pot assignments; the 520000 planned is ignored.
    expect(await rtaCents(db, "2026-09")).toBe(500000 - 60000);
  });

  test("potInflow reports what actually landed per income pot", async () => {
    const db = seed();
    await createTransaction(db, { date: "2026-09-15", accountId: 1, potId: 2, amountCents: 500000, description: "Pay" });
    await createTransaction(db, { date: "2026-09-20", accountId: 1, potId: 3, amountCents: 1200, description: "Interest" });
    expect(await potInflow(db, 2, "2026-09")).toBe(500000);
    expect(await potInflow(db, 3, "2026-09")).toBe(1200);
    expect(await potInflow(db, 1, "2026-09")).toBe(0);
    expect(await potInflow(db, 2, "2026-08")).toBe(0);
  });

  test("hidden pots are still rejected", async () => {
    const db = seed();
    await db.run("UPDATE pots SET hidden = 1 WHERE name = 'Paycheck'");
    await expect(assignToPot(db, "2026-09", "Paycheck", 1)).rejects.toThrow("retired");
  });
});
