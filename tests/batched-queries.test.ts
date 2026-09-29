import { describe, expect, test } from "bun:test";
import { potSpend, potInflow, allPotSpend, allPotInflow, recentTransactions, allPotSpendHistory } from "../src/queries";
import { assignedToPot, allPotAssigned, assignToPot, allPotAssignedMonths, assignManyToPot } from "../src/assign";
import { sinkingStatus, sinkingStatuses, potBalance, potBalances, createSchedule } from "../src/sinking";
import { contactCredit, allContactCredit } from "../src/settle";
import { tableExists, clearTableExistsCache } from "../src/db-interface";
import type { Db } from "../src/db-interface";
import { testDb } from "./helpers";

/** Fixture data is invented. Seeds two pots with September spend, one pot
 *  with nothing, an income inflow, assignments, and a contact-split
 *  transaction carrying a contact name. */
async function seed(): Promise<Db> {
  const db = await testDb();
  await db.exec(`INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing','chequing')`);
  await db.exec(`INSERT INTO contacts (user_id, name) VALUES (1, 'Sam')`);
  await db.exec(`INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES
    (1, 'Housing','essentials','fixed',300000),
    (1, 'Groceries','essentials','average_3mo',120000),
    (1, 'Empty','essentials','fixed',0),
    (1, 'Paycheck','income','fixed',0)`);
  const txn = async (date: string, amount: number, pot: number, owner = "user", contactId: number | null = null) => {
    const t = (await db.get<{ id: number }>(
      "INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, cleared) VALUES (1, ?, 1, ?, 't', 'manual', 'agent', 'cleared') RETURNING id",
      date,
      amount
    ))!;
    await db.run(
      "INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (1, ?, ?, ?, ?, ?)",
      t.id,
      pot,
      owner,
      contactId,
      amount
    );
    return t.id;
  };
  await txn("2026-09-02", -300000, 1);
  await txn("2026-09-03", -100000, 2);
  // contact share of a grocery run: user half + contact half
  const t = await txn("2026-09-04", -50000, 2);
  await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (1, ?, 2, 'contact', 1, -50000)", t);
  await txn("2026-09-05", 500000, 4); // income inflow
  await assignToPot(db, 1, "2026-09", 1, 300000);
  await assignToPot(db, 1, "2026-09", 2, 120000);
  return db;
}

describe("batched pot queries", () => {
  test("allPotSpend matches potSpend per pot, zero-filling empty pots", async () => {
    const db = await seed();
    const batched = await allPotSpend(db, 1, [1, 2, 3], "2026-09");
    for (const id of [1, 2, 3]) {
      expect(batched.get(id) ?? { userCents: 0, sharedCents: 0 }).toEqual(await potSpend(db, 1, id, "2026-09"));
    }
    expect(batched.get(1)).toEqual({ userCents: 300000, sharedCents: 0 });
    expect(batched.get(2)).toEqual({ userCents: 150000, sharedCents: 50000 });
    expect(batched.get(3) ?? { userCents: 0, sharedCents: 0 }).toEqual({ userCents: 0, sharedCents: 0 });
  });

  test("allPotInflow matches potInflow per pot", async () => {
    const db = await seed();
    const batched = await allPotInflow(db, 1, [1, 2, 3, 4], "2026-09");
    for (const id of [1, 2, 3, 4]) {
      expect(batched.get(id) ?? 0).toBe(await potInflow(db, 1, id, "2026-09"));
    }
    expect(batched.get(4)).toBe(500000);
    expect(batched.has(3)).toBe(false); // absent, not zero row
  });

  test("allPotAssigned matches assignedToPot per pot", async () => {
    const db = await seed();
    const batched = await allPotAssigned(db, 1, "2026-09", [1, 2, 3]);
    for (const id of [1, 2, 3]) {
      expect(batched.get(id) ?? 0).toBe(await assignedToPot(db, 1, "2026-09", id));
    }
    expect(batched.get(1)).toBe(300000);
    expect(batched.get(2)).toBe(120000);
    expect(batched.has(3)).toBe(false);
  });

  test("empty pot list returns empty maps without querying", async () => {
    const db = await seed();
    expect((await allPotSpend(db, 1, [], "2026-09")).size).toBe(0);
    expect((await allPotInflow(db, 1, [], "2026-09")).size).toBe(0);
    expect((await allPotAssigned(db, 1, "2026-09", [])).size).toBe(0);
  });
});

describe("recentTransactions contact name", () => {
  test("still resolves the contact name after the JOIN rewrite", async () => {
    const db = await seed();
    const rows = (await recentTransactions(db, 1, 10, "2026-09")) as any[];
    const split = rows.find((r) => r.split_with_contact === 1);
    expect(split).toBeDefined();
    expect(split.split_contact_name).toBe("Sam");
    const plain = rows.find((r) => r.split_with_contact === 0);
    expect(plain.split_contact_name).toBeNull();
  });
});

describe("tableExists memoization", () => {
  test("caches per table; clearTableExistsCache drops memoized answers", async () => {
    const db = await testDb();
    expect(await tableExists(db, "pots")).toBe(true);
    expect(await tableExists(db, "no_such_table")).toBe(false);
    // Drop a table: the memoized answer is stale until cleared.
    await db.exec("DROP TABLE pots");
    expect(await tableExists(db, "pots")).toBe(true);
    clearTableExistsCache();
    expect(await tableExists(db, "pots")).toBe(false);
  });
});
