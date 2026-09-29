import { describe, expect, test } from "bun:test";
import type { Db } from "../src/db-interface";
import { testDb } from "./helpers";
import { sinkingStatus, sinkingStatuses, potBalance, potBalances, createSchedule } from "../src/sinking";
import { potSpend, allPotSpendHistory } from "../src/queries";
import { assignedToPot, assignToPot, allPotAssignedMonths, assignManyToPot } from "../src/assign";
import { contactCredit, allContactCredit } from "../src/settle";

/** Fixture data is invented. Pot 1 has a funding schedule (expected 240000,
 *  due 2026-12, 120000 assigned, 30000 spent -> balance 90000); pot 2 has an
 *  overdue schedule (expected 50000, due 2026-09, nothing saved); pot 3 has
 *  no schedule. */
async function seedSinking(): Promise<Db> {
  const db = await testDb();
  await db.exec(`INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing','chequing')`);
  await db.exec(`INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES
    (1, 'Taxes','essentials','fixed',0),
    (1, 'Insurance','essentials','fixed',0),
    (1, 'Plain','essentials','fixed',0)`);
  await assignToPot(db, 1, "2026-08", 1, 60000);
  await assignToPot(db, 1, "2026-09", 1, 60000);
  await assignToPot(db, 1, "2026-09", 2, 10000);
  const t = (await db.get<{ id: number }>(
    "INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, cleared) VALUES (1, '2026-09-10', 1, -30000, 't', 'manual', 'agent', 'cleared') RETURNING id"
  ))!;
  await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (1, ?, 1, 'user', NULL, -30000)", t.id);
  await createSchedule(db, 1, 1, 240000, "2026-12", 12);
  await createSchedule(db, 1, 2, 50000, "2026-09", 12);
  return db;
}

describe("sinkingStatuses", () => {
  test("matches sinkingStatus per pot, including derived fields", async () => {
    const db = await seedSinking();
    const batched = await sinkingStatuses(db, 1, [1, 2, 3], "2026-10");
    for (const id of [1, 2, 3]) {
      const single = await sinkingStatus(db, 1, id, "2026-10");
      if (single === null) expect(batched.has(id)).toBe(false);
      else expect(batched.get(id)).toEqual(single);
    }
    const funding = batched.get(1)!;
    expect(funding.balanceCents).toBe(90000);
    expect(funding.remainingCents).toBe(150000);
    expect(funding.monthsLeft).toBe(2);
    expect(funding.contributionCents).toBe(75000);
    expect(funding.state).toBe("funding");
    const overdue = batched.get(2)!;
    expect(overdue.state).toBe("overdue");
    expect(overdue.contributionCents).toBe(40000);
    expect(batched.has(3)).toBe(false); // no schedule: absent, not null row
  });

  test("single-pot wrapper still returns null without a schedule", async () => {
    const db = await seedSinking();
    expect(await sinkingStatus(db, 1, 3, "2026-10")).toBeNull();
  });

  test("empty pot list returns an empty map; bad month throws", async () => {
    const db = await seedSinking();
    expect((await sinkingStatuses(db, 1, [], "2026-10")).size).toBe(0);
    await expect(sinkingStatuses(db, 1, [1], "nope")).rejects.toThrow('bad month');
  });

  test("potBalances matches potBalance per pot", async () => {
    const db = await seedSinking();
    const batched = await potBalances(db, 1, [1, 2, 3], "2026-10");
    for (const id of [1, 2, 3]) {
      expect(batched.get(id) ?? 0).toBe(await potBalance(db, 1, id, "2026-10"));
    }
    expect(batched.get(1)).toBe(90000);
    expect(batched.get(2)).toBe(10000);
    expect(batched.has(3)).toBe(false);
  });
});

describe("allPotSpendHistory", () => {
  test("matches potSpend per pot per month", async () => {
    const db = await seedSinking();
    const months = ["2026-08", "2026-09"];
    const batched = await allPotSpendHistory(db, 1, [1, 2, 3], months);
    for (const id of [1, 2, 3]) {
      for (const m of months) {
        const single = (await potSpend(db, 1, id, m)).userCents;
        expect(batched.get(id)?.get(m) ?? 0).toBe(single);
      }
    }
    expect(batched.get(1)?.get("2026-09")).toBe(30000);
    expect(batched.get(2)?.get("2026-08") ?? 0).toBe(0);
  });

  test("empty inputs return an empty map", async () => {
    const db = await seedSinking();
    expect((await allPotSpendHistory(db, 1, [], ["2026-09"])).size).toBe(0);
    expect((await allPotSpendHistory(db, 1, [1], [])).size).toBe(0);
  });
});

describe("allPotAssignedMonths", () => {
  test("matches assignedToPot per pot per month", async () => {
    const db = await seedSinking();
    const months = ["2026-08", "2026-09"];
    const batched = await allPotAssignedMonths(db, 1, months, [1, 2, 3]);
    for (const id of [1, 2, 3]) {
      for (const m of months) {
        expect(batched.get(id)?.get(m) ?? 0).toBe(await assignedToPot(db, 1, m, id));
      }
    }
    expect(batched.get(1)?.get("2026-08")).toBe(60000);
    expect(batched.get(1)?.get("2026-09")).toBe(60000);
  });
});

describe("assignManyToPot", () => {
  test("writes a whole month in one call; upsert overwrites", async () => {
    const db = await seedSinking();
    await assignManyToPot(db, 1, "2026-10", [
      { potId: 1, cents: 111 },
      { potId: 2, cents: 222 },
      { potId: 3, cents: 333 },
    ]);
    expect(await assignedToPot(db, 1, "2026-10", 1)).toBe(111);
    expect(await assignedToPot(db, 1, "2026-10", 2)).toBe(222);
    expect(await assignedToPot(db, 1, "2026-10", 3)).toBe(333);
    await assignManyToPot(db, 1, "2026-10", [{ potId: 1, cents: 999 }]);
    expect(await assignedToPot(db, 1, "2026-10", 1)).toBe(999);
  });

  test("validates like assignToPot", async () => {
    const db = await seedSinking();
    await expect(assignManyToPot(db, 1, "nope", [{ potId: 1, cents: 1 }])).rejects.toThrow("bad month");
    await expect(assignManyToPot(db, 1, "2026-10", [{ potId: 1, cents: -5 }])).rejects.toThrow("bad amount");
    await expect(assignManyToPot(db, 1, "2026-10", [{ potId: 4242, cents: 1 }])).rejects.toThrow("no pot");
    await db.run("UPDATE pots SET hidden = 1 WHERE id = 2 AND user_id = 1");
    await expect(assignManyToPot(db, 1, "2026-10", [{ potId: 2, cents: 1 }])).rejects.toThrow("retired");
    await assignManyToPot(db, 1, "2026-10", []); // no-op, no throw
  });
});

/** Fixture data is invented. Contact 1 (Sam) has a settlement with 4000
 *  leftover credit on a transaction with TWO contact splits for Sam (the
 *  dedup case); contact 2 (Alex) has no settlements. */
async function seedCredit(): Promise<Db> {
  const db = await testDb();
  await db.exec(`INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing','chequing')`);
  await db.exec(`INSERT INTO contacts (user_id, name) VALUES (1, 'Sam'), (1, 'Alex')`);
  await db.exec(`INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES (1, 'Groceries','essentials','fixed',0)`);
  const t = (await db.get<{ id: number }>(
    "INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, cleared) VALUES (1, '2026-09-10', 1, -10000, 't', 'manual', 'agent', 'cleared') RETURNING id"
  ))!;
  await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (1, ?, 1, 'user', NULL, -5000)", t.id);
  await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (1, ?, 1, 'contact', 1, -3000)", t.id);
  await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (1, ?, 1, 'contact', 1, -2000)", t.id);
  await db.run("INSERT INTO settlements (user_id, transaction_id, date, amount_cents, leftover_cents) VALUES (1, ?, '2026-09-11', 5000, 4000)", t.id);
  return db;
}

describe("allContactCredit", () => {
  test("matches contactCredit per contact, counting a settlement once per contact", async () => {
    const db = await seedCredit();
    const batched = await allContactCredit(db, 1);
    for (const id of [1, 2]) {
      expect(batched.get(id) ?? 0).toBe(await contactCredit(db, 1, id));
    }
    // Two contact splits for Sam on the same transaction: the settlement's
    // 4000 leftover counts once, exactly like the EXISTS version.
    expect(batched.get(1)).toBe(4000);
    expect(batched.has(2)).toBe(false);
  });
});
