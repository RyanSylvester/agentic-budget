import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { wrapDb } from "../src/db";
import { potHistory } from "../src/queries";
import { assignedToPot } from "../src/assign";
import { parseHistoryQuery } from "../src/app";
import type { Db } from "../src/db-interface";

function seed(): Db {
  const raw = new Database(":memory:");
  raw.exec(readFileSync("src/schema.sql", "utf8"));
  raw.exec(`INSERT INTO accounts (name, type) VALUES ('Chequing','chequing')`);
  raw.exec(`INSERT INTO pots (name, pot_group, target_type, target_cents) VALUES
    ('Housing','essentials','fixed',300000),
    ('Groceries','essentials','average_3mo',120000)`);
  const txn = (date: string, amount: number, pot: number | null) => {
    const t = raw.query(
      "INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared) VALUES (?, 1, ?, 't', 'manual', 'agent', 'confirmed', 'cleared') RETURNING id"
    ).get(date, amount) as { id: number };
    raw.query("INSERT INTO splits (transaction_id, pot_id, owner, amount_cents) VALUES (?, ?, 'user', ?)").run(t.id, pot, amount);
  };
  // Jun-Sep 2026: housing 300k/mo, groceries 100k/mo (140k in Sep)
  for (const m of ["06", "07", "08"]) {
    txn(`2026-${m}-02`, -300000, 1);
    txn(`2026-${m}-03`, -100000, 2);
  }
  txn("2026-09-02", -300000, 1);
  txn("2026-09-03", -140000, 2);
  return wrapDb(raw);
}

describe("potHistory", () => {
  test("returns N months oldest-first ending at the given month", async () => {
    const db = seed();
    const h = await potHistory(db, 2, 4, "2026-09");
    expect(h.map((x) => x.month)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09"]);
    expect(h.map((x) => x.spentCents)).toEqual([100000, 100000, 100000, 140000]);
  });

  test("months with no spend report zero", async () => {
    const db = seed();
    const h = await potHistory(db, 1, 2, "2026-05");
    expect(h).toEqual([
      { month: "2026-04", spentCents: 0 },
      { month: "2026-05", spentCents: 0 },
    ]);
  });
});

describe("assignedToPot", () => {
  test("defaults to 0 and reflects assignments", async () => {
    const db = seed();
    expect(await assignedToPot(db, "2026-09", 1)).toBe(0);
    await db.run("INSERT INTO assignments (month, pot_id, cents) VALUES ('2026-09', 1, 300000)");
    expect(await assignedToPot(db, "2026-09", 1)).toBe(300000);
    expect(await assignedToPot(db, "2026-08", 1)).toBe(0);
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
