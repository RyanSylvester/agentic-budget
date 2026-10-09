import { describe, expect, test } from "bun:test";
import type { Db } from "../src/db-interface";
import { testDb } from "./helpers";
import { assignToPot, assignedToPot, moveAssignment } from "../src/assign";
import { rtaCents } from "../src/queries";
import { createApp } from "../src/app";
import { createTransaction } from "../src/transactions";

async function seed(): Promise<Db> {
  const db = await testDb();
  await db.exec(`INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing','chequing')`);
  await db.exec(`INSERT INTO pots (user_id, name, pot_group, target_type, target_cents, is_assignable, hidden) VALUES
    (1, 'Dining out','Food','average_3mo',0,1,0),
    (1, 'Coffee','Food','average_3mo',0,1,0),
    (1, 'Paycheck','Income','fixed',0,0,0),
    (1, 'Old pot','Food','fixed',0,1,1)`);
  await createTransaction(db, 1, { date: "2026-09-01", accountId: 1, potId: 3, amountCents: 100000, description: "Pay" });
  await assignToPot(db, 1, "2026-09", 1, 20000);
  await assignToPot(db, 1, "2026-09", 2, 5000);
  return db;
}

describe("moveAssignment", () => {
  test("moves dollars between pots and leaves RTA alone", async () => {
    const db = await seed();
    const before = await rtaCents(db, 1, "2026-09");
    const r = await moveAssignment(db, 1, "2026-09", 2, 1, 3000);
    expect(r).toEqual({ from: { potId: 2, month: "2026-09", cents: 2000 }, to: { potId: 1, month: "2026-09", cents: 23000 } });
    expect(await assignedToPot(db, 1, "2026-09", 2)).toBe(2000);
    expect(await assignedToPot(db, 1, "2026-09", 1)).toBe(23000);
    expect(await rtaCents(db, 1, "2026-09")).toBe(before);
  });

  test("moving back undoes the move", async () => {
    const db = await seed();
    await moveAssignment(db, 1, "2026-09", 2, 1, 3000);
    await moveAssignment(db, 1, "2026-09", 1, 2, 3000);
    expect(await assignedToPot(db, 1, "2026-09", 1)).toBe(20000);
    expect(await assignedToPot(db, 1, "2026-09", 2)).toBe(5000);
  });

  test("Ready to Assign is the null side", async () => {
    const db = await seed();
    const before = await rtaCents(db, 1, "2026-09");
    const r = await moveAssignment(db, 1, "2026-09", null, 1, 1500);
    expect(r.from).toBeNull();
    expect(r.to?.cents).toBe(21500);
    expect(await rtaCents(db, 1, "2026-09")).toBe(before - 1500);
    await moveAssignment(db, 1, "2026-09", 1, null, 1500);
    expect(await rtaCents(db, 1, "2026-09")).toBe(before);
  });

  test("creates the destination row when the pot had no assignment", async () => {
    const db = await seed();
    await moveAssignment(db, 1, "2026-10", 1, 2, 700);
    expect(await assignedToPot(db, 1, "2026-10", 1)).toBe(-700);
    expect(await assignedToPot(db, 1, "2026-10", 2)).toBe(700);
  });

  test("refuses bad input and changes nothing", async () => {
    const db = await seed();
    await expect(moveAssignment(db, 1, "2026-9", 2, 1, 100)).rejects.toThrow(/bad month/);
    await expect(moveAssignment(db, 1, "2026-09", 2, 1, 0)).rejects.toThrow(/positive/);
    await expect(moveAssignment(db, 1, "2026-09", 2, 1, -100)).rejects.toThrow(/positive/);
    await expect(moveAssignment(db, 1, "2026-09", 2, 1, 1.5)).rejects.toThrow(/positive/);
    await expect(moveAssignment(db, 1, "2026-09", 1, 1, 100)).rejects.toThrow(/different/);
    await expect(moveAssignment(db, 1, "2026-09", null, null, 100)).rejects.toThrow(/pick a pot/);
    await expect(moveAssignment(db, 1, "2026-09", 3, 1, 100)).rejects.toThrow(/income pot/);
    await expect(moveAssignment(db, 1, "2026-09", 2, 4, 100)).rejects.toThrow(/retired/);
    await expect(moveAssignment(db, 1, "2026-09", 2, 99, 100)).rejects.toThrow(/no pot/);
    expect(await assignedToPot(db, 1, "2026-09", 1)).toBe(20000);
    expect(await assignedToPot(db, 1, "2026-09", 2)).toBe(5000);
  });
});

describe("POST /api/assign/move", () => {
  const post = (app: ReturnType<typeof createApp>, body: unknown) =>
    app.request("/api/assign/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  test("returns both new totals", async () => {
    const db = await seed();
    const app = createApp(async () => db);
    const r = await post(app, { month: "2026-09", fromPotId: 2, toPotId: 1, cents: 2500 });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      ok: true,
      month: "2026-09",
      cents: 2500,
      from: { potId: 2, month: "2026-09", cents: 2500 },
      to: { potId: 1, month: "2026-09", cents: 22500 },
    });
  });

  test("a missing fromPotId means Ready to Assign", async () => {
    const db = await seed();
    const app = createApp(async () => db);
    const r = await post(app, { month: "2026-09", toPotId: 1, cents: 100 });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).from).toBeNull();
  });

  test("validation errors are 400 with a message", async () => {
    const db = await seed();
    const app = createApp(async () => db);
    const r = await post(app, { month: "2026-09", fromPotId: "2", toPotId: 1, cents: 100 });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toMatch(/bad pot id/);
    const bad = await app.request("/api/assign/move", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    expect(bad.status).toBe(400);
  });
});
