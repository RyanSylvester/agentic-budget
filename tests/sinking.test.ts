import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateDb, wrapDb } from "../src/db";
import type { Db } from "../src/db-interface";
import { createPot, deletePot } from "../src/pots";
import { assignToPot } from "../src/assign";
import { applyClose, closePreview } from "../src/close";
import { scaffoldMonth } from "../src/scaffold";
import {
  createSchedule,
  getSchedule,
  listSchedules,
  markPaid,
  monthsUntil,
  potBalance,
  removeSchedule,
  sinkingStatus,
} from "../src/sinking";

async function testDb(): Promise<Db> {
  const db = wrapDb(new Database(":memory:"));
  await migrateDb(db);
  await db.run("INSERT INTO users (username, salt, verifier, kdf_params) VALUES ('test', 'x', 'x', 'm=19456,t=2,p=1')");
  await db.exec(`INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing','chequing')`);
  return db;
}

async function spend(db: Db, potId: number, date: string, cents: number): Promise<void> {
  // cents negative (outflow), like the CLI's record path
  const t = (await db.get<{ id: number }>(
    "INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, status, cleared) VALUES (1, ?, 1, ?, 'bill', 'manual', 'agent', 'confirmed', 'cleared') RETURNING id",
    date, cents
  ))!;
  await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, amount_cents) VALUES (1, ?, ?, 'user', ?)", t.id, potId, cents);
}

async function taxPot(db: Db): Promise<number> {
  return createPot(db, 1, { name: "Property tax", group: "Housing", targetType: "savings" });
}

describe("sinking schedules", () => {
  test("monthly contribution is ceil(remaining / months left)", async () => {
    const db = await testDb();
    const pot = await taxPot(db);
    await createSchedule(db, 1, pot, 348359, "2027-07");
    // 2026-10 -> 2027-07 exclusive: 9 months; nothing saved yet
    const st = (await sinkingStatus(db, 1, pot, "2026-10"))!;
    expect(st.monthsLeft).toBe(9);
    expect(st.remainingCents).toBe(348359);
    expect(st.contributionCents).toBe(Math.ceil(348359 / 9));
    expect(st.state).toBe("funding");
  });

  test("monthsUntil counts contribution months, minimum 1", () => {
    expect(monthsUntil("2026-10", "2027-07")).toBe(9);
    expect(monthsUntil("2027-07", "2027-07")).toBe(1);
    expect(monthsUntil("2027-09", "2027-07")).toBe(1); // past due
    expect(monthsUntil("2026-09", "2026-10")).toBe(1);
  });

  test("contributions self-correct when a month is missed", async () => {
    const db = await testDb();
    const pot = await taxPot(db);
    await createSchedule(db, 1, pot, 120000, "2027-09");
    // Fund only two of the first three months.
    await assignToPot(db, 1, "2026-10", pot, 10000);
    await assignToPot(db, 1, "2026-11", pot, 10000);
    const st = (await sinkingStatus(db, 1, pot, "2026-12"))!;
    expect(st.balanceCents).toBe(20000);
    // remaining 100000 over 9 months (2026-12..2027-08)
    expect(st.monthsLeft).toBe(9);
    expect(st.contributionCents).toBe(Math.ceil(100000 / 9));
    // skip December too: January must catch up on its own
    const jan = (await sinkingStatus(db, 1, pot, "2027-01"))!;
    expect(jan.balanceCents).toBe(20000);
    expect(jan.monthsLeft).toBe(8);
    expect(jan.contributionCents).toBe(Math.ceil(100000 / 8));
  });

  test("overpaying lowers the next contribution; funding pauses when covered", async () => {
    const db = await testDb();
    const pot = await taxPot(db);
    await createSchedule(db, 1, pot, 120000, "2027-09");
    await assignToPot(db, 1, "2026-10", pot, 60000); // double the plan
    const st = (await sinkingStatus(db, 1, pot, "2026-11"))!;
    expect(st.balanceCents).toBe(60000);
    expect(st.monthsLeft).toBe(10);
    expect(st.contributionCents).toBe(Math.ceil(60000 / 10));
    await assignToPot(db, 1, "2026-11", pot, 60000);
    const done = (await sinkingStatus(db, 1, pot, "2026-12"))!;
    expect(done.state).toBe("funded");
    expect(done.contributionCents).toBe(0);
  });

  test("past-due and unpaid shows the full shortfall as overdue", async () => {
    const db = await testDb();
    const pot = await taxPot(db);
    await createSchedule(db, 1, pot, 120000, "2026-09");
    await assignToPot(db, 1, "2026-09", pot, 70000);
    const st = (await sinkingStatus(db, 1, pot, "2026-10"))!;
    expect(st.state).toBe("overdue");
    expect(st.monthsLeft).toBe(1);
    expect(st.contributionCents).toBe(50000);
  });

  test("potBalance is cumulative assigned minus cumulative user spend", async () => {
    const db = await testDb();
    const pot = await taxPot(db);
    await createSchedule(db, 1, pot, 120000, "2027-09");
    await assignToPot(db, 1, "2026-09", pot, 10000);
    await assignToPot(db, 1, "2026-10", pot, 10000);
    await spend(db, pot, "2026-10-15", -3000);
    expect(await potBalance(db, 1, pot, "2026-10")).toBe(17000);
    // future months see the same cumulative balance (no future data)
    expect(await potBalance(db, 1, pot, "2026-12")).toBe(17000);
  });

  test("markPaid rolls the due date forward one cadence", async () => {
    const db = await testDb();
    const pot = await taxPot(db);
    await createSchedule(db, 1, pot, 120000, "2027-07");
    const annual = await markPaid(db, 1, pot);
    expect(annual.dueMonth).toBe("2028-07");
    const semi = await taxPot(db);
    await createSchedule(db, 1, semi, 60000, "2027-01", 6);
    expect((await markPaid(db, 1, semi)).dueMonth).toBe("2027-07");
  });

  test("bill paid drains the balance so contributions rebuild", async () => {
    const db = await testDb();
    const pot = await taxPot(db);
    await createSchedule(db, 1, pot, 120000, "2027-09");
    await assignToPot(db, 1, "2026-10", pot, 10000);
    await spend(db, pot, "2027-09-05", -120000); // the bill lands
    await markPaid(db, 1, pot);
    const st = (await sinkingStatus(db, 1, pot, "2027-10"))!;
    expect(st.dueMonth).toBe("2028-09");
    expect(st.balanceCents).toBe(-110000);
    expect(st.remainingCents).toBe(230000);
    expect(st.state).toBe("funding");
  });

  test("validation rejects bad input", async () => {
    const db = await testDb();
    const pot = await taxPot(db);
    await expect(createSchedule(db, 1, 999, 120000, "2027-07")).rejects.toThrow("no pot");
    await expect(createSchedule(db, 1, pot, 0, "2027-07")).rejects.toThrow("positive integer");
    await expect(createSchedule(db, 1, pot, -5, "2027-07")).rejects.toThrow("positive integer");
    await expect(createSchedule(db, 1, pot, 120000, "2027-13")).rejects.toThrow("YYYY-MM");
    await expect(createSchedule(db, 1, pot, 120000, "2027-07", 0)).rejects.toThrow("positive integer");
    await createSchedule(db, 1, pot, 120000, "2027-07");
    await expect(createSchedule(db, 1, pot, 120000, "2027-07")).rejects.toThrow("already has a sinking schedule");
    await expect(removeSchedule(db, 1, await taxPot(db))).rejects.toThrow("no sinking schedule");
    await expect(markPaid(db, 1, await taxPot(db))).rejects.toThrow("no sinking schedule");
    expect(await sinkingStatus(db, 1, await taxPot(db), "2026-10")).toBeNull();
  });

  test("income and retired pots cannot be scheduled", async () => {
    const db = await testDb();
    const income = (await db.get<{ id: number }>(
      "INSERT INTO pots (user_id, name, pot_group, target_type, target_cents, is_assignable) VALUES (1, 'Paycheck','Income','fixed',0,0) RETURNING id"
    ))!;
    await expect(createSchedule(db, 1, income.id, 120000, "2027-07")).rejects.toThrow("income pot");
    const retired = await taxPot(db);
    await db.run("UPDATE pots SET hidden = 1 WHERE id = ?", retired);
    await expect(createSchedule(db, 1, retired, 120000, "2027-07")).rejects.toThrow("retired");
  });

  test("listSchedules orders by due month", async () => {
    const db = await testDb();
    const a = await taxPot(db);
    const b = await createPot(db, 1, { name: "Insurance", group: "Housing", targetType: "savings" });
    await createSchedule(db, 1, a, 120000, "2027-09");
    await createSchedule(db, 1, b, 60000, "2027-03");
    const names = (await listSchedules(db, 1)).map((s) => s.potName);
    expect(names).toEqual(["Insurance", "Property tax"]);
    expect((await getSchedule(db, 1, a))!.dueMonth).toBe("2027-09");
  });

  test("scaffold uses the schedule contribution for scheduled pots", async () => {
    const db = await testDb();
    const pot = await taxPot(db);
    await createSchedule(db, 1, pot, 120000, "2027-09");
    // history would average to ~0 for the average strategy
    await assignToPot(db, 1, "2026-09", pot, 10000);
    const lines = await scaffoldMonth(db, 1, "2026-10", "average_3mo", true);
    const line = lines.find((l) => l.potId === pot)!;
    expect(line.scheduled).toBe(true);
    expect(line.cents).toBe((await sinkingStatus(db, 1, pot, "2026-10"))!.contributionCents);
    // unscheduled pots are untouched by the change
    const other = await createPot(db, 1, { name: "Groceries", group: "Food", targetType: "average_3mo" });
    await assignToPot(db, 1, "2026-09", other, 60000);
    await assignToPot(db, 1, "2026-08", other, 60000);
    await assignToPot(db, 1, "2026-07", other, 60000);
    const lines2 = await scaffoldMonth(db, 1, "2026-10", "average_3mo", true);
    const oline = lines2.find((l) => l.potId === other)!;
    expect(oline.scheduled).not.toBe(true);
    expect(oline.cents).toBe(60000);
  });

  test("close apply leaves scheduled pots' targets alone", async () => {
    const db = await testDb();
    const pot = await taxPot(db);
    await createSchedule(db, 1, pot, 120000, "2027-09");
    await db.run("UPDATE pots SET target_cents = 55555 WHERE id = ?", pot);
    const preview = await closePreview(db, 1, "2026-09");
    const line = preview.pots.find((p) => p.potId === pot)!;
    expect(line.wireframeSkipped).toBe(true);
    expect(line.wireframeCents).toBe((await sinkingStatus(db, 1, pot, "2026-10"))!.contributionCents);
    // RTA is 0 (nothing assigned, no inflows) so the close applies
    await applyClose(db, 1, preview);
    const after = (await db.get<{ target_cents: number }>("SELECT target_cents FROM pots WHERE id = ?", pot))!;
    expect(after.target_cents).toBe(55555);
  });

  test("deleting a pot removes its schedule", async () => {
    const db = await testDb();
    const pot = await taxPot(db);
    await createSchedule(db, 1, pot, 120000, "2027-09");
    await deletePot(db, 1, pot);
    expect(await getSchedule(db, 1, pot)).toBeNull();
    expect(await listSchedules(db, 1)).toEqual([]);
  });
});
