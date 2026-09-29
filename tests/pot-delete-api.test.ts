import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { wrapDb, migrateDb } from "../src/db";
import { createApp } from "../src/app";
import type { AuthConfig, KVStore } from "../src/auth";

/** DELETE /api/pots/:id moves history to a user-picked destination pot
 *  (YNAB-style); without one it 400s. The delete-preview route names the
 *  counts before the user confirms. Fixture names below are invented. */

class MapKV implements KVStore {
  private m = new Map<string, string>();
  async get(k: string): Promise<string | null> { return this.m.get(k) ?? null; }
  async put(k: string, v: string): Promise<void> { this.m.set(k, v); }
  async delete(k: string): Promise<void> { this.m.delete(k); }
}

const KDF_KEY = "ab".repeat(32);
const SALT = "cd".repeat(16);

async function setup() {
  const kv = new MapKV();
  const db = wrapDb(new Database(":memory:"));
  await migrateDb(db);
  const app = createApp(async () => db, { auth: { kv, pepper: "test-pepper" } as AuthConfig });
  const json = (method: string, path: string, body?: unknown, cookie?: string) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const sr = await json("POST", "/api/auth/signup", { username: "u1", salt: SALT, kdfKey: KDF_KEY });
  expect(sr.status).toBe(200);
  const lr = await json("POST", "/api/auth/login", { username: "u1", kdfKey: KDF_KEY });
  const cookie = (lr.headers.get("set-cookie") ?? "").split(";")[0];
  const mk = async (name: string, group = "Food") => {
    const r = await json("POST", "/api/pots", { name, group, targetType: "fixed" }, cookie);
    expect(r.status).toBe(200);
    return (await r.json()).id as number;
  };
  return { app, db, json, cookie, mk };
}

/** One transaction (via splits) and one assignment row on the pot. */
async function giveHistory(db: any, userId: number, potId: number, accountId: number, month = "2026-09") {
  const t = (await db.get(
    `INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, cleared)
     VALUES (?, '2026-09-10', ?, -5000, 'dinner', 'manual', 'agent', 'cleared') RETURNING id`,
    userId,
    accountId
  )) as { id: number };
  await db.run(
    "INSERT INTO splits (user_id, transaction_id, pot_id, owner, amount_cents) VALUES (?, ?, ?, 'user', -5000)",
    userId,
    t.id,
    potId
  );
  await db.run("INSERT INTO assignments (user_id, month, pot_id, cents) VALUES (?, ?, ?, 60000)", userId, month, potId);
}

describe("DELETE /api/pots/:id", () => {
  test("200 moves history to the named destination", async () => {
    const { db, json, cookie, mk } = await setup();
    const dest = await mk("Groceries");
    const doomed = await mk("Dining out");
    await db.run("INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing', 'chequing')");
    await giveHistory(db, 1, doomed, 1);

    const r = await json("DELETE", `/api/pots/${doomed}`, { moveToPotId: dest }, cookie);
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.moveToPotId).toBe(dest);
    expect(body.moveToPotName).toBe("Groceries");
    expect(body.movedTransactions).toBe(1);
    expect(body.movedAssignments).toBe(1);

    expect(((await db.get("SELECT COUNT(*) AS n FROM splits WHERE pot_id = ? AND user_id = ?", dest, 1)) as any).n).toBe(1);
    expect(((await db.get("SELECT cents FROM assignments WHERE month = '2026-09' AND pot_id = ? AND user_id = ?", dest, 1)) as any).cents).toBe(60000);
    expect(((await db.get("SELECT COUNT(*) AS n FROM pots WHERE id = ?", doomed)) as any).n).toBe(0);
  });

  test("400 when the destination is missing, itself, or unknown", async () => {
    const { json, cookie, mk } = await setup();
    const a = await mk("Groceries");
    const b = await mk("Dining out");

    const noDest = await json("DELETE", `/api/pots/${b}`, undefined, cookie);
    expect(noDest.status).toBe(400);
    expect(((await noDest.json()) as any).error).toMatch(/moveToPotId required/);

    const self = await json("DELETE", `/api/pots/${b}`, { moveToPotId: b }, cookie);
    expect(self.status).toBe(400);
    expect(((await self.json()) as any).error).toMatch(/different pot/);

    const unknown = await json("DELETE", `/api/pots/${b}`, { moveToPotId: 4242 }, cookie);
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as any).error).toMatch(/no pot 4242/);

    // Failed deletes leave both pots standing.
    const list = await json("GET", "/api/pots", undefined, cookie);
    expect(((await list.json()).pots as any[]).map((p) => p.id).sort()).toEqual([a, b].sort());
  });

  test("404 for an unknown pot", async () => {
    const { json, cookie, mk } = await setup();
    const a = await mk("Groceries");
    const r = await json("DELETE", "/api/pots/4242", { moveToPotId: a }, cookie);
    expect(r.status).toBe(404);
  });

  test("the only pot cannot be deleted: no destination validates", async () => {
    const { json, cookie, mk } = await setup();
    const only = await mk("Groceries");
    const self = await json("DELETE", `/api/pots/${only}`, { moveToPotId: only }, cookie);
    expect(self.status).toBe(400);
    const unknown = await json("DELETE", `/api/pots/${only}`, { moveToPotId: 4242 }, cookie);
    expect(unknown.status).toBe(400);
    const list = await json("GET", "/api/pots", undefined, cookie);
    expect(((await list.json()).pots as any[]).length).toBe(1);
  });
});

describe("GET /api/pots/:id/delete-preview", () => {
  test("names the counts that a delete would move", async () => {
    const { db, json, cookie, mk } = await setup();
    const a = await mk("Groceries");
    const b = await mk("Dining out");
    await db.run("INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing', 'chequing')");
    await giveHistory(db, 1, b, 1);
    await giveHistory(db, 1, b, 1, "2026-08");

    const r = await json("GET", `/api/pots/${b}/delete-preview`, undefined, cookie);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ potId: b, name: "Dining out", transactionCount: 2, assignmentCount: 2 });

    const empty = await json("GET", `/api/pots/${a}/delete-preview`, undefined, cookie);
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as any).transactionCount).toBe(0);

    const missing = await json("GET", "/api/pots/4242/delete-preview", undefined, cookie);
    expect(missing.status).toBe(404);
  });
});
