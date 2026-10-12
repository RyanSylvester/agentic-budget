import { describe, expect, test } from "bun:test";
import { allPotSpend, monthInflows, monthSpend, potHistory, rtaCents } from "../src/queries";
import { potBalance } from "../src/sinking";
import { createTransaction } from "../src/transactions";
import { testDb } from "./helpers";

/** Inflows on a spending pot are refunds: they net against that pot's spend
 *  and never reach Ready to Assign. Inflows on income pots stay income.
 *  Fixture names are invented. */
async function seed() {
  const db = await testDb();
  await db.exec(`INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing','chequing')`);
  await db.exec(`INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES (1, 'Clothing','Life','fixed',0)`);
  await db.exec(`INSERT INTO pots (user_id, name, pot_group, target_type, is_assignable) VALUES (1, 'Payroll','Income','fixed',0)`);
  const rec = (potId: number, amountCents: number, description: string) =>
    createTransaction(db, 1, { date: "2026-09-26", accountId: 1, potId, amountCents, description });
  await rec(2, 500000, "pay");
  await rec(2, -20000, "income pot outflow");
  await rec(1, -106672, "suit");
  await rec(1, 106672, "money in for the suit");
  return db;
}

describe("refunds on spending pots", () => {
  test("an inflow on a spending pot offsets its spend", async () => {
    const db = await seed();
    expect((await allPotSpend(db, 1, [1, 2], "2026-09")).get(1)!.userCents).toBe(0);
    expect((await potHistory(db, 1, 1, 1, "2026-09"))[0].spentCents).toBe(0);
    expect(await potBalance(db, 1, 1, "2026-09")).toBe(0);
  });

  test("income pots keep counting inflows as income and outflows as spend", async () => {
    const db = await seed();
    expect((await allPotSpend(db, 1, [2], "2026-09")).get(2)!.userCents).toBe(20000);
    expect(await monthInflows(db, 1, "2026-09")).toBe(500000);
    expect(await rtaCents(db, 1, "2026-09")).toBe(500000);
    expect(await monthSpend(db, 1, "2026-09")).toBe(20000);
  });

  test("a refund larger than the month's purchases leaves spend negative", async () => {
    const db = await seed();
    await createTransaction(db, 1, { date: "2026-09-28", accountId: 1, potId: 1, amountCents: 5000, description: "return" });
    expect((await allPotSpend(db, 1, [1], "2026-09")).get(1)!.userCents).toBe(-5000);
    expect(await rtaCents(db, 1, "2026-09")).toBe(500000);
  });
});
