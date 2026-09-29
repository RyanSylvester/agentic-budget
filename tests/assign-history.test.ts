import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { wrapDb, migrateDb } from "../src/db";
import { createApp } from "../src/app";
import type { AuthConfig, KVStore } from "../src/auth";

class MapKV implements KVStore {
  private m = new Map<string, string>();
  async get(k: string): Promise<string | null> {
    return this.m.get(k) ?? null;
  }
  async put(k: string, v: string): Promise<void> {
    this.m.set(k, v);
  }
  async delete(k: string): Promise<void> {
    this.m.delete(k);
  }
}

const KDF_KEY = "ab".repeat(32);
const SALT = "cd".repeat(16);

async function setup() {
  const kv = new MapKV();
  const db = wrapDb(new Database(":memory:"));
  await migrateDb(db);
  const config: AuthConfig = { kv, pepper: "test-pepper" };
  const app = createApp(async () => db, { auth: config });

  const signup = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "riley", salt: SALT, kdfKey: KDF_KEY }),
  });
  expect(signup.status).toBe(200);
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "riley", kdfKey: KDF_KEY }),
  });
  expect(login.status).toBe(200);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  await db.run("INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES (1, 'Groceries', 'essentials', 'fixed', 0)");
  return { app, db, cookie };
}

describe("GET /api/pots/:id/assign-history", () => {
  test("returns last month and 3-month average", async () => {
    const { app, db, cookie } = await setup();
    await db.run("INSERT INTO assignments (user_id, pot_id, month, cents) VALUES (1, 1, '2026-06', 60000), (1, 1, '2026-07', 90000), (1, 1, '2026-08', 75000)");
    const r = await app.request("/api/pots/1/assign-history?month=2026-09", {
      headers: { Cookie: cookie },
    });
    expect(r.status).toBe(200);
    const h = (await r.json()) as any;
    expect(h.potId).toBe(1);
    expect(h.lastMonth).toEqual({ month: "2026-08", cents: 75000 });
    expect(h.avg3moCents).toBe(75000); // (60000+90000+75000)/3
  });

  test("zero-fills months with no assignments", async () => {
    const { app, cookie } = await setup();
    const r = await app.request("/api/pots/1/assign-history?month=2026-09", {
      headers: { Cookie: cookie },
    });
    expect(r.status).toBe(200);
    const h = (await r.json()) as any;
    expect(h.lastMonth).toEqual({ month: "2026-08", cents: 0 });
    expect(h.avg3moCents).toBe(0);
  });

  test("404 for unknown pot, 400 for bad month", async () => {
    const { app, cookie } = await setup();
    const r404 = await app.request("/api/pots/4242/assign-history?month=2026-09", {
      headers: { Cookie: cookie },
    });
    expect(r404.status).toBe(404);
    const r400 = await app.request("/api/pots/1/assign-history?month=sept", {
      headers: { Cookie: cookie },
    });
    expect(r400.status).toBe(400);
  });
});
