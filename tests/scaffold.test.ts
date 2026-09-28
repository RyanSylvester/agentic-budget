import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { wrapDb } from "../src/db";
import type { Db } from "../src/db-interface";
import { scaffoldMonth } from "../src/scaffold";
import { assignToPot, assignedToPot } from "../src/assign";

function seed(): Db {
  const raw = new Database(":memory:");
  raw.exec(readFileSync("src/schema.sql", "utf8"));
  raw.exec(`INSERT INTO pots (name, pot_group, target_type, target_cents, is_assignable) VALUES
    ('Rent','essentials','fixed',300000,1),
    ('Groceries','essentials','average_3mo',120000,1),
    ('TFSA','savings','savings',75000,1),
    ('Pay','income','fixed',0,0)`);
  return wrapDb(raw);
}

describe("scaffoldMonth", () => {
  test("last_month copies each pot's previous assignment", async () => {
    const db = seed();
    await assignToPot(db, "2026-09", "Rent", 300000);
    await assignToPot(db, "2026-09", "Groceries", 95000);
    await assignToPot(db, "2026-09", "TFSA", 75000);
    const lines = await scaffoldMonth(db, "2026-10", "last_month");
    expect(Object.fromEntries(lines.map((l) => [l.name, l.cents]))).toEqual({
      Rent: 300000,
      Groceries: 95000,
      TFSA: 75000,
      Pay: 0,
    });
    // written through
    expect(await assignedToPot(db, "2026-10", 1)).toBe(300000);
    expect(await assignedToPot(db, "2026-10", 2)).toBe(95000);
  });

  test("average_3mo averages the last three months of assignments", async () => {
    const db = seed();
    await assignToPot(db, "2026-07", "Groceries", 90000);
    await assignToPot(db, "2026-08", "Groceries", 120000);
    await assignToPot(db, "2026-09", "Groceries", 105000);
    const lines = await scaffoldMonth(db, "2026-10", "average_3mo");
    expect(lines.find((l) => l.name === "Groceries")!.cents).toBe(105000);
  });

  test("income pots copy last month's planned income under either strategy", async () => {
    for (const strategy of ["average_3mo", "last_month"] as const) {
      const db = seed();
      await assignToPot(db, "2026-09", "Pay", 512000);
      const lines = await scaffoldMonth(db, "2026-10", strategy);
      const pay = lines.find((l) => l.name === "Pay")!;
      expect(pay.cents).toBe(512000);
      expect(pay.income).toBe(true);
    }
  });

  test("dryRun returns lines without writing", async () => {
    const db = seed();
    await assignToPot(db, "2026-09", "Rent", 300000);
    const lines = await scaffoldMonth(db, "2026-10", "last_month", true);
    expect(lines.find((l) => l.name === "Rent")!.cents).toBe(300000);
    expect(await assignedToPot(db, "2026-10", 1)).toBe(0);
  });

  test("bad month and bad strategy throw", async () => {
    const db = seed();
    await expect(scaffoldMonth(db, "october", "last_month")).rejects.toThrow(/bad month/);
    await expect(scaffoldMonth(db, "2026-10", "vibes" as never)).rejects.toThrow(/bad strategy/);
  });

  test("scaffold skips hidden pots", async () => {
    const db = seed();
    await db.run(`UPDATE pots SET hidden = 1 WHERE name = 'TFSA'`);
    const lines = await scaffoldMonth(db, "2026-10", "last_month", true);
    expect(lines.some((l) => l.name === "TFSA")).toBe(false);
  });
});
