import { describe, expect, test } from "bun:test";
import { potHistory } from "../src/queries";
import { assignedToPot } from "../src/assign";
import { parseHistoryQuery } from "../src/app";
import type { Db } from "../src/db-interface";
import { testDb } from "./helpers";

async function seed(): Promise<Db> {
  const db = await testDb();
  await db.exec(`INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing','chequing')`);
  await db.exec(`INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES
    (1, 'Housing','essentials','fixed',300000),
    (1, 'Groceries','essentials','average_3mo',120000)`);
  const txn = async (date: string, amount: number, pot: number | null) => {
    const t = (await db.get<{ id: number }>(
      "INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, status, cleared) VALUES (1, ?, 1, ?, 't', 'manual', 'agent', 'confirmed', 'cleared') RETURNING id",
      date, amount
    ))!;
    await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, amount_cents) VALUES (1, ?, ?, 'user', ?)", t.id, pot, amount);
  };
  // Jun-Sep 2026: housing 300k/mo, groceries 100k/mo (140k in Sep)
  for (const m of ["06", "07", "08"]) {
    await txn(`2026-${m}-02`, -300000, 1);
    await txn(`2026-${m}-03`, -100000, 2);
  }
  await txn("2026-09-02", -300000, 1);
  await txn("2026-09-03", -140000, 2);
  return db;
}

describe("potHistory", () => {
  test("returns N months oldest-first ending at the given month", async () => {
    const db = await seed();
    const h = await potHistory(db, 1, 2, 4, "2026-09");
    expect(h.map((x) => x.month)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09"]);
    expect(h.map((x) => x.spentCents)).toEqual([100000, 100000, 100000, 140000]);
  });

  test("months with no spend report zero", async () => {
    const db = await seed();
    const h = await potHistory(db, 1, 1, 2, "2026-05");
    expect(h).toEqual([
      { month: "2026-04", spentCents: 0 },
      { month: "2026-05", spentCents: 0 },
    ]);
  });
});

describe("assignedToPot", () => {
  test("defaults to 0 and reflects assignments", async () => {
    const db = await seed();
    expect(await assignedToPot(db, 1, "2026-09", 1)).toBe(0);
    await db.run("INSERT INTO assignments (user_id, month, pot_id, cents) VALUES (1, '2026-09', 1, 300000)");
    expect(await assignedToPot(db, 1, "2026-09", 1)).toBe(300000);
    expect(await assignedToPot(db, 1, "2026-08", 1)).toBe(0);
  });
});

describe("parseHistoryQuery", () => {
  test("defaults months to 6", () => {
    expect(parseHistoryQuery({ potId: "3", months: undefined })).toEqual({ potId: 3, months: 6 });
  });

  test("accepts months 1-12", () => {
    expect(parseHistoryQuery({ potId: "3", months: "12" })).toEqual({ potId: 3, months: 12 });
    expect(parseHistoryQuery({ potId: "3", months: "1" })).toEqual({ potId: 3, months: 1 });
  });

  test("rejects bad potId", () => {
    expect(parseHistoryQuery({ potId: "abc", months: undefined })).toEqual({ error: "bad potId; expected a positive integer" });
    expect(parseHistoryQuery({ potId: "0", months: undefined })).toEqual({ error: "bad potId; expected a positive integer" });
    expect(parseHistoryQuery({ potId: undefined, months: undefined })).toEqual({ error: "bad potId; expected a positive integer" });
  });

  test("rejects out-of-range months", () => {
    expect(parseHistoryQuery({ potId: "3", months: "0" })).toEqual({ error: "bad months; expected an integer from 1 to 12" });
    expect(parseHistoryQuery({ potId: "3", months: "13" })).toEqual({ error: "bad months; expected an integer from 1 to 12" });
    expect(parseHistoryQuery({ potId: "3", months: "x" })).toEqual({ error: "bad months; expected an integer from 1 to 12" });
  });
});
