import { describe, expect, test } from "bun:test";
import type { Db } from "../src/db-interface";
import { testDb } from "./helpers";
import { closeMonth, wireframeTarget, closePreview, applyClose, shiftMonth, closeEquation } from "../src/close";
import { assignToPot } from "../src/assign";
import { rtaCents, assignedTotal } from "../src/queries";

describe("wireframeTarget", () => {
  test("fixed copies the most recent month", () => {
    expect(wireframeTarget({ potId: 1, targetType: "fixed", historyCents: [10000, 10200, 10100] })).toBe(10100);
  });

  test("average_3mo averages the last three months", () => {
    expect(wireframeTarget({ potId: 2, targetType: "average_3mo", historyCents: [30000, 36000, 33000] })).toBe(33000);
  });

  test("average_3mo works with fewer than three months", () => {
    expect(wireframeTarget({ potId: 2, targetType: "average_3mo", historyCents: [30000, 36000] })).toBe(33000);
  });

  test("savings pots get no assignment", () => {
    expect(wireframeTarget({ potId: 3, targetType: "savings", historyCents: [75000] })).toBe(0);
  });

  test("empty history assigns zero", () => {
    expect(wireframeTarget({ potId: 4, targetType: "fixed", historyCents: [] })).toBe(0);
  });
});

describe("closeMonth", () => {
  test("positive RTA moves to secondary savings and ends at zero", () => {
    expect(closeMonth({ rtaStartCents: 12500 })).toEqual({ rtaEndCents: 0, movedToSavingsCents: 12500 });
  });

  test("negative RTA stays put; nothing moves to savings", () => {
    expect(closeMonth({ rtaStartCents: -3000 })).toEqual({ rtaEndCents: 0, movedToSavingsCents: 0 });
  });
});

describe("closePreview / applyClose (live data)", () => {
  async function seedClose(): Promise<Db> {
    const db = await testDb();
    await db.exec(`INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing','chequing')`);
    await db.exec(`INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES
      (1, 'Housing','essentials','fixed',300000),
      (1, 'Groceries','essentials','average_3mo',120000),
      (1, 'TFSA','savings','savings',0)`);
    const txn = async (date: string, amount: number, pot: number | null) => {
      const t = (await db.get<{ id: number }>(
        "INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, cleared) VALUES (1, ?, 1, ?, 't', 'manual', 'agent', 'cleared') RETURNING id",
        date, amount
      ))!;
      await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, amount_cents) VALUES (1, ?, ?, 'user', ?)", t.id, pot, amount);
    };
    // paycheck + housing + groceries, Jun-Sep 2026
    for (const m of ["06", "07", "08"]) {
      await txn(`2026-${m}-01`, 500000, null);      // paycheck, no pot
      await txn(`2026-${m}-02`, -300000, 1);        // housing
      await txn(`2026-${m}-03`, -100000, 2);        // groceries
    }
    await txn("2026-09-01", 500000, null);
    await txn("2026-09-02", -300000, 1);
    await txn("2026-09-03", -140000, 2);
    return db;
  }

  test("preview reads inflows, spend, assigned, and wireframes", async () => {
    const db = await seedClose();
    await assignToPot(db, 1, "2026-09", 1, 300000); // Housing
    await assignToPot(db, 1, "2026-09", 2, 120000); // Groceries
    const p = await closePreview(db, 1, "2026-09");
    expect(p.inflowsCents).toBe(500000);
    expect(p.spentCents).toBe(440000);
    expect(p.assignedCents).toBe(420000);
    expect(await assignedTotal(db, 1, "2026-09")).toBe(420000);
    expect(p.rtaBeforeCents).toBe(80000);
    expect(await rtaCents(db, 1, "2026-09")).toBe(80000);
    expect(p.movedToSavingsCents).toBe(80000);
    const housing = p.pots.find((l) => l.name === "Housing")!;
    expect(housing.historyCents).toEqual([300000, 300000, 300000]);
    expect(housing.wireframeCents).toBe(300000); // fixed: last month
    const groceries = p.pots.find((l) => l.name === "Groceries")!;
    expect(groceries.historyCents).toEqual([100000, 100000, 100000]);
    expect(groceries.wireframeCents).toBe(100000); // 3-month average
    const tfsa = p.pots.find((l) => l.name === "TFSA")!;
    expect(tfsa.wireframeCents).toBe(0); // savings: no assignment
    expect(p.nextMonth).toBe("2026-10");
  });

  test("assign upserts idempotently and rejects bad input", async () => {
    const db = await seedClose();
    await assignToPot(db, 1, "2026-09", 1, 300000);
    expect(await assignedTotal(db, 1, "2026-09")).toBe(300000);
    await assignToPot(db, 1, "2026-09", "Housing", 250000); // by name, overwrite
    expect(await assignedTotal(db, 1, "2026-09")).toBe(250000);
    await expect(assignToPot(db, 1, "2026-9", 1, 100)).rejects.toThrow("bad month");
    await expect(assignToPot(db, 1, "2026-09", 1, -100)).rejects.toThrow("bad amount");
    await expect(assignToPot(db, 1, "2026-09", 999, 100)).rejects.toThrow("no pot");
  });

  test("apply refuses when RTA is not zero", async () => {
    const db = await seedClose();
    await assignToPot(db, 1, "2026-09", 1, 300000); // partial: RTA = 200000
    const p = await closePreview(db, 1, "2026-09");
    expect(p.rtaBeforeCents).toBe(200000);
    await expect(applyClose(db, 1, p)).rejects.toThrow("RTA is $2000.00; the close applies at month-end once every dollar is assigned");
    // nothing was written: the close is all-or-nothing
    expect(await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM month_closes")).toEqual({ n: 0 });
  });

  test("apply records the close, wireframes targets, and refuses doubles", async () => {
    const db = await seedClose();
    await assignToPot(db, 1, "2026-09", 1, 300000); // Housing
    await assignToPot(db, 1, "2026-09", 2, 120000); // Groceries
    await assignToPot(db, 1, "2026-09", 3, 80000);  // TFSA: every dollar assigned, RTA = 0
    const p = await closePreview(db, 1, "2026-09");
    expect(p.rtaBeforeCents).toBe(0);
    await applyClose(db, 1, p);
    const row = await db.get(`SELECT rta_start_cents, rta_end_cents, moved_to_savings_cents FROM month_closes WHERE month = '2026-09'`) as any;
    expect(row).toEqual({ rta_start_cents: 0, rta_end_cents: 0, moved_to_savings_cents: 0 });
    const targets = await db.all(`SELECT name, target_cents FROM pots ORDER BY id`) as { name: string; target_cents: number }[];
    expect(targets.find((t) => t.name === "Groceries")!.target_cents).toBe(100000);
    await expect(applyClose(db, 1, p)).rejects.toThrow("already applied");
  });

  test("shiftMonth handles year boundaries", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });

  test("income-group pots accept planned income but get no wireframe", async () => {
    const db = await seedClose();
    await db.exec(`INSERT INTO pots (user_id, name, pot_group, target_type, is_assignable) VALUES (1, 'Payroll','Income','fixed',0)`);
    const r = await assignToPot(db, 1, "2026-09", "Payroll", 500000);
    expect(r.cents).toBe(500000);
    const p = await closePreview(db, 1, "2026-09");
    const payroll = p.pots.find((l) => l.name === "Payroll")!;
    expect(payroll.assignable).toBe(false);
    expect(payroll.wireframeCents).toBe(0);
  });
});

describe("close card equation", () => {
  test("income minus spend minus savings nets to zero", () => {
    for (const preview of [
      { inflowsCents: 512000, spentCents: 272123 },
      { inflowsCents: 0, spentCents: 0 },
      { inflowsCents: 300000, spentCents: 300000 },
    ]) {
      const { incomeCents, spendCents, savingsCents } = closeEquation(preview);
      expect(incomeCents).toBe(preview.inflowsCents);
      expect(spendCents).toBe(preview.spentCents);
      expect(savingsCents).toBe(preview.inflowsCents - preview.spentCents);
      expect(incomeCents - spendCents - savingsCents).toBe(0);
    }
  });

  test("preview reports closed once the close is applied", async () => {
    const db = await testDb();
    await db.exec(`INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing','chequing')`);
    await db.exec(`INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES (1, 'Housing','essentials','fixed',300000)`);
    const t = (await db.get<{ id: number }>(
      "INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, cleared) VALUES (1, '2026-09-01', 1, 500000, 't', 'manual', 'agent', 'cleared') RETURNING id"
    ))!;
    await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, amount_cents) VALUES (1, ?, 1, 'user', 500000)", t.id);
    expect((await closePreview(db, 1, "2026-09")).closed).toBe(false);
    await assignToPot(db, 1, "2026-09", 1, 500000); // every dollar assigned: RTA = 0
    await applyClose(db, 1, await closePreview(db, 1, "2026-09"));
    expect((await closePreview(db, 1, "2026-09")).closed).toBe(true);
    // other months stay open
    expect((await closePreview(db, 1, "2026-08")).closed).toBe(false);
  });
});
