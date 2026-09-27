import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { closeMonth, wireframeTarget, closePreview, applyClose, shiftMonth } from "../src/close";

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
  function seedClose(): Database {
    const db = new Database(":memory:");
    db.exec(readFileSync("src/schema.sql", "utf8"));
    db.exec(`INSERT INTO accounts (name, type) VALUES ('Chequing','chequing')`);
    db.exec(`INSERT INTO pots (name, pot_group, target_type, target_cents) VALUES
      ('Housing','essentials','fixed',300000),
      ('Groceries','essentials','average_3mo',120000),
      ('TFSA','savings','savings',0)`);
    const txn = (date: string, amount: number, pot: number | null) => {
      const t = db.query(
        "INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared) VALUES (?, 1, ?, 't', 'manual', 'agent', 'confirmed', 'cleared') RETURNING id"
      ).get(date, amount) as { id: number };
      db.query("INSERT INTO splits (transaction_id, pot_id, owner, amount_cents) VALUES (?, ?, 'ryan', ?)").run(t.id, pot, amount);
    };
    // paycheck + housing + groceries, Jun-Sep 2026
    for (const m of ["06", "07", "08"]) {
      txn(`2026-${m}-01`, 500000, null);      // paycheck, no pot
      txn(`2026-${m}-02`, -300000, 1);        // housing
      txn(`2026-${m}-03`, -100000, 2);        // groceries
    }
    txn("2026-09-01", 500000, null);
    txn("2026-09-02", -300000, 1);
    txn("2026-09-03", -140000, 2);
    return db;
  }

  test("preview reads inflows, spend, assigned, and wireframes", () => {
    const db = seedClose();
    const p = closePreview(db, "2026-09");
    expect(p.inflowsCents).toBe(500000);
    expect(p.spentCents).toBe(440000);
    expect(p.assignedCents).toBe(420000); // 300000 + 120000 + 0
    expect(p.rtaBeforeCents).toBe(80000);
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

  test("apply records the close, wireframes targets, and refuses doubles", () => {
    const db = seedClose();
    const p = closePreview(db, "2026-09");
    applyClose(db, p);
    const row = db.query(`SELECT rta_start_cents, rta_end_cents, moved_to_savings_cents FROM month_closes WHERE month = '2026-09'`).get() as any;
    expect(row).toEqual({ rta_start_cents: 80000, rta_end_cents: 0, moved_to_savings_cents: 80000 });
    const targets = db.query(`SELECT name, target_cents FROM pots ORDER BY id`).all() as { name: string; target_cents: number }[];
    expect(targets.find((t) => t.name === "Groceries")!.target_cents).toBe(100000);
    expect(() => applyClose(db, p)).toThrow("already applied");
  });

  test("shiftMonth handles year boundaries", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });
});
