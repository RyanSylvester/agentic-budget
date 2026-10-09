import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { wrapDb, migrateDb } from "../src/db";
import { createApp } from "../src/app";
import { shiftMonth, unclosedPreviousMonth } from "../src/close";

/** Closing is not limited to the running month: a past month that was left
 *  open can be closed later under the same $0 rule, a future month cannot,
 *  and /api/attention flags the previous month while it stays open. */

async function setup() {
  const db = wrapDb(new Database(":memory:"));
  await migrateDb(db);
  const app = createApp(async () => db);
  await db.run("INSERT INTO users (username, salt, verifier, kdf_params) VALUES ('local', 's', 'v', 'kdf')");
  await db.run("INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing', 'chequing')");
  await db.run("INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES (1, 'Rent', 'essentials', 'fixed', 0)");
  return { app, db };
}

async function paycheck(db: Awaited<ReturnType<typeof setup>>["db"], date: string, cents: number) {
  const t = (await db.get<{ id: number }>(
    "INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, cleared) VALUES (1, ?, 1, ?, 'pay', 'manual', 'agent', 'cleared') RETURNING id",
    date,
    cents
  ))!;
  await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, amount_cents) VALUES (1, ?, NULL, 'user', ?)", t.id, cents);
}

const post = (app: Awaited<ReturnType<typeof setup>>["app"], path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const current = () => new Date().toISOString().slice(0, 7);

describe("closing a past month", () => {
  test("a past, unclosed month closes once its RTA is $0", async () => {
    const { app, db } = await setup();
    const past = shiftMonth(current(), -2);
    await paycheck(db, `${past}-01`, 300000);

    // RTA is $3,000: refused, nothing recorded.
    const refused = await post(app, "/api/close", { month: past });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("RTA is $3000.00");

    expect((await post(app, "/api/assign", { month: past, potId: 1, cents: 300000 })).status).toBe(200);
    const preview = (await (await app.request(`/api/close-preview?month=${past}`)).json()) as any;
    expect(preview.rtaBeforeCents).toBe(0);
    expect(preview.closed).toBe(false);

    expect((await post(app, "/api/close", { month: past })).status).toBe(200);
    const after = (await (await app.request(`/api/close-preview?month=${past}`)).json()) as any;
    expect(after.closed).toBe(true);
  });

  test("a future month cannot be closed", async () => {
    const { app, db } = await setup();
    const r = await post(app, "/api/close", { month: shiftMonth(current(), 1) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain("hasn't started");
    expect(await db.get("SELECT 1 AS x FROM month_closes")).toBeNull();
  });

  test("the current month can still be closed early", async () => {
    const { app } = await setup();
    expect((await post(app, "/api/close", { month: current() })).status).toBe(200);
  });
});

describe("attention: unclosed previous month", () => {
  test("flags last month while it is open, clears once closed", async () => {
    const { app, db } = await setup();
    await paycheck(db, "2026-09-01", 100000);
    await db.run("INSERT INTO assignments (user_id, pot_id, month, cents) VALUES (1, 1, '2026-09', 100000)");

    const before = (await (await app.request("/api/attention?month=2026-10")).json()) as any;
    expect(before.unclosedMonth).toBe("2026-09");

    await db.run("INSERT INTO month_closes (user_id, month, rta_start_cents, rta_end_cents, moved_to_savings_cents) VALUES (1, '2026-09', 0, 0, 0)");
    const after = (await (await app.request("/api/attention?month=2026-10")).json()) as any;
    expect(after.unclosedMonth).toBeNull();
  });

  test("an empty previous month has nothing to close", async () => {
    const { db } = await setup();
    expect(await unclosedPreviousMonth(db, 1, "2026-10")).toBeNull();
    // Assignments alone count as activity.
    await db.run("INSERT INTO assignments (user_id, pot_id, month, cents) VALUES (1, 1, '2026-09', 5000)");
    expect(await unclosedPreviousMonth(db, 1, "2026-10")).toBe("2026-09");
    // Another user's close does not count.
    await db.run("INSERT INTO month_closes (user_id, month, rta_start_cents, rta_end_cents, moved_to_savings_cents) VALUES (2, '2026-09', 0, 0, 0)");
    expect(await unclosedPreviousMonth(db, 1, "2026-10")).toBe("2026-09");
  });
});
