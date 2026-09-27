import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateDb } from "../src/db";
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

function testDb(): Database {
  const db = new Database(":memory:");
  migrateDb(db);
  db.exec(`INSERT INTO accounts (name, type) VALUES ('Chequing','chequing')`);
  return db;
}

function spend(db: Database, potId: number, date: string, cents: number): void {
  // cents negative (outflow), like the CLI's record path
  const t = db.query(
    "INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared) VALUES (?, 1, ?, 'bill', 'manual', 'agent', 'confirmed', 'cleared') RETURNING id"
  ).get(date, cents) as { id: number };
  db.query("INSERT INTO splits (transaction_id, pot_id, owner, amount_cents) VALUES (?, ?, 'user', ?)").run(
    t.id,
    potId,
    cents
  );
}

function taxPot(db: Database): number {
  return createPot(db, { name: "Property tax", group: "Housing", targetType: "savings" });
}

describe("sinking schedules", () => {
  test("monthly contribution is ceil(remaining / months left)", () => {
    const db = testDb();
    const pot = taxPot(db);
    createSchedule(db, pot, 348359, "2027-07");
    // 2026-10 -> 2027-07 exclusive: 9 months; nothing saved yet
    const st = sinkingStatus(db, pot, "2026-10")!;
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

  test("contributions self-correct when a month is missed", () => {
    const db = testDb();
    const pot = taxPot(db);
    createSchedule(db, pot, 120000, "2027-09");
    // Fund only two of the first three months.
    assignToPot(db, "2026-10", pot, 10000);
    assignToPot(db, "2026-11", pot, 10000);
    const st = sinkingStatus(db, pot, "2026-12")!;
    expect(st.balanceCents).toBe(20000);
    // remaining 100000 over 9 months (2026-12..2027-08)
    expect(st.monthsLeft).toBe(9);
    expect(st.contributionCents).toBe(Math.ceil(100000 / 9));
    // skip December too: January must catch up on its own
    const jan = sinkingStatus(db, pot, "2027-01")!;
    expect(jan.balanceCents).toBe(20000);
    expect(jan.monthsLeft).toBe(8);
    expect(jan.contributionCents).toBe(Math.ceil(100000 / 8));
  });

  test("overpaying lowers the next contribution; funding pauses when covered", () => {
    const db = testDb();
    const pot = taxPot(db);
    createSchedule(db, pot, 120000, "2027-09");
    assignToPot(db, "2026-10", pot, 60000); // double the plan
    const st = sinkingStatus(db, pot, "2026-11")!;
    expect(st.balanceCents).toBe(60000);
    expect(st.monthsLeft).toBe(10);
    expect(st.contributionCents).toBe(Math.ceil(60000 / 10));
    assignToPot(db, "2026-11", pot, 60000);
    const done = sinkingStatus(db, pot, "2026-12")!;
    expect(done.state).toBe("funded");
    expect(done.contributionCents).toBe(0);
  });

  test("past-due and unpaid shows the full shortfall as overdue", () => {
    const db = testDb();
    const pot = taxPot(db);
    createSchedule(db, pot, 120000, "2026-09");
    assignToPot(db, "2026-09", pot, 70000);
    const st = sinkingStatus(db, pot, "2026-10")!;
    expect(st.state).toBe("overdue");
    expect(st.monthsLeft).toBe(1);
    expect(st.contributionCents).toBe(50000);
  });

  test("potBalance is cumulative assigned minus cumulative user spend", () => {
    const db = testDb();
    const pot = taxPot(db);
    createSchedule(db, pot, 120000, "2027-09");
    assignToPot(db, "2026-09", pot, 10000);
    assignToPot(db, "2026-10", pot, 10000);
    spend(db, pot, "2026-10-15", -3000);
    expect(potBalance(db, pot, "2026-10")).toBe(17000);
    // future months see the same cumulative balance (no future data)
    expect(potBalance(db, pot, "2026-12")).toBe(17000);
  });

  test("markPaid rolls the due date forward one cadence", () => {
    const db = testDb();
    const pot = taxPot(db);
    createSchedule(db, pot, 120000, "2027-07");
    const annual = markPaid(db, pot);
    expect(annual.dueMonth).toBe("2028-07");
    const semi = taxPot(db);
    createSchedule(db, semi, 60000, "2027-01", 6);
    expect(markPaid(db, semi).dueMonth).toBe("2027-07");
  });

  test("bill paid drains the balance so contributions rebuild", () => {
    const db = testDb();
    const pot = taxPot(db);
    createSchedule(db, pot, 120000, "2027-09");
    assignToPot(db, "2026-10", pot, 10000);
    spend(db, pot, "2027-09-05", -120000); // the bill lands
    markPaid(db, pot);
    const st = sinkingStatus(db, pot, "2027-10")!;
    expect(st.dueMonth).toBe("2028-09");
    expect(st.balanceCents).toBe(-110000);
    expect(st.remainingCents).toBe(230000);
    expect(st.state).toBe("funding");
  });

  test("validation rejects bad input", () => {
    const db = testDb();
    const pot = taxPot(db);
    expect(() => createSchedule(db, 999, 120000, "2027-07")).toThrow("no pot");
    expect(() => createSchedule(db, pot, 0, "2027-07")).toThrow("positive integer");
    expect(() => createSchedule(db, pot, -5, "2027-07")).toThrow("positive integer");
    expect(() => createSchedule(db, pot, 120000, "2027-13")).toThrow("YYYY-MM");
    expect(() => createSchedule(db, pot, 120000, "2027-07", 0)).toThrow("positive integer");
    createSchedule(db, pot, 120000, "2027-07");
    expect(() => createSchedule(db, pot, 120000, "2027-07")).toThrow("already has a sinking schedule");
    expect(() => removeSchedule(db, taxPot(db))).toThrow("no sinking schedule");
    expect(() => markPaid(db, taxPot(db))).toThrow("no sinking schedule");
    expect(sinkingStatus(db, taxPot(db), "2026-10")).toBeNull();
  });

  test("income and retired pots cannot be scheduled", () => {
    const db = testDb();
    const income = db.query(
      "INSERT INTO pots (name, pot_group, target_type, target_cents, is_assignable) VALUES ('Paycheck','Income','fixed',0,0) RETURNING id"
    ).get() as { id: number };
    expect(() => createSchedule(db, income.id, 120000, "2027-07")).toThrow("income pot");
    const retired = taxPot(db);
    db.query("UPDATE pots SET hidden = 1 WHERE id = ?").run(retired);
    expect(() => createSchedule(db, retired, 120000, "2027-07")).toThrow("retired");
  });

  test("listSchedules orders by due month", () => {
    const db = testDb();
    const a = taxPot(db);
    const b = createPot(db, { name: "Insurance", group: "Housing", targetType: "savings" });
    createSchedule(db, a, 120000, "2027-09");
    createSchedule(db, b, 60000, "2027-03");
    const names = listSchedules(db).map((s) => s.potName);
    expect(names).toEqual(["Insurance", "Property tax"]);
    expect(getSchedule(db, a)!.dueMonth).toBe("2027-09");
  });

  test("scaffold uses the schedule contribution for scheduled pots", () => {
    const db = testDb();
    const pot = taxPot(db);
    createSchedule(db, pot, 120000, "2027-09");
    // history would average to ~0 for the average strategy
    assignToPot(db, "2026-09", pot, 10000);
    const lines = scaffoldMonth(db, "2026-10", "average_3mo", true);
    const line = lines.find((l) => l.potId === pot)!;
    expect(line.scheduled).toBe(true);
    expect(line.cents).toBe(sinkingStatus(db, pot, "2026-10")!.contributionCents);
    // unscheduled pots are untouched by the change
    const other = createPot(db, { name: "Groceries", group: "Food", targetType: "average_3mo" });
    assignToPot(db, "2026-09", other, 60000);
    assignToPot(db, "2026-08", other, 60000);
    assignToPot(db, "2026-07", other, 60000);
    const lines2 = scaffoldMonth(db, "2026-10", "average_3mo", true);
    const oline = lines2.find((l) => l.potId === other)!;
    expect(oline.scheduled).not.toBe(true);
    expect(oline.cents).toBe(60000);
  });

  test("close apply leaves scheduled pots' targets alone", () => {
    const db = testDb();
    const pot = taxPot(db);
    createSchedule(db, pot, 120000, "2027-09");
    db.query("UPDATE pots SET target_cents = 55555 WHERE id = ?").run(pot);
    const preview = closePreview(db, "2026-09");
    const line = preview.pots.find((p) => p.potId === pot)!;
    expect(line.wireframeSkipped).toBe(true);
    expect(line.wireframeCents).toBe(sinkingStatus(db, pot, "2026-10")!.contributionCents);
    // RTA is 0 (nothing assigned, no inflows) so the close applies
    applyClose(db, preview);
    const after = db.query("SELECT target_cents FROM pots WHERE id = ?").get(pot) as { target_cents: number };
    expect(after.target_cents).toBe(55555);
  });

  test("deleting a pot removes its schedule", () => {
    const db = testDb();
    const pot = taxPot(db);
    createSchedule(db, pot, 120000, "2027-09");
    deletePot(db, pot);
    expect(getSchedule(db, pot)).toBeNull();
    expect(listSchedules(db)).toEqual([]);
  });
});
