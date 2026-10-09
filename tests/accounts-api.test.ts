import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { wrapDb, migrateDb } from "../src/db";
import { createApp } from "../src/app";
import type { AuthConfig, KVStore } from "../src/auth";

/** POST /api/accounts lets a new user add their first account from the app;
 *  PUT /api/accounts/:id renames it. Fixture names below are invented. */

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
  return { app, db, json, cookie };
}

describe("POST /api/accounts", () => {
  test("creates an account and returns it in the list shape", async () => {
    const { json, cookie } = await setup();
    const r = await json("POST", "/api/accounts", { name: "  Everyday  ", type: "chequing", last4: "4321" }, cookie);
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.ok).toBe(true);
    expect(j.account).toEqual({
      id: j.id,
      name: "Everyday",
      type: "chequing",
      last4: "4321",
      workingBalanceCents: 0,
      clearedBalanceCents: 0,
      lastReconciledAt: null,
    });
    const list = (await (await json("GET", "/api/accounts", undefined, cookie)).json()) as any;
    expect(list.accounts).toEqual([j.account]);
  });

  test("last4 is optional and blank means none", async () => {
    const { json, cookie } = await setup();
    const a = (await (await json("POST", "/api/accounts", { name: "Card", type: "credit_card" }, cookie)).json()) as any;
    expect(a.account.last4).toBeNull();
    const b = (await (await json("POST", "/api/accounts", { name: "Rainy day", type: "savings", last4: " " }, cookie)).json()) as any;
    expect(b.account.last4).toBeNull();
  });

  test("the new account can take a transaction", async () => {
    const { json, cookie } = await setup();
    const acct = (await (await json("POST", "/api/accounts", { name: "Everyday", type: "chequing" }, cookie)).json()) as any;
    const pot = (await (await json("POST", "/api/pots", { name: "Groceries", group: "Food", targetType: "fixed" }, cookie)).json()) as any;
    const t = await json("POST", "/api/transactions", {
      date: "2026-09-05", accountId: acct.id, potId: pot.id, amountCents: -1250, description: "market",
    }, cookie);
    expect(t.status).toBe(200);
    const list = (await (await json("GET", "/api/accounts", undefined, cookie)).json()) as any;
    expect(list.accounts[0].workingBalanceCents).toBe(-1250);
  });

  test("rejects bad input", async () => {
    const { app, json, cookie, db } = await setup();
    const bad = async (body: unknown) => {
      const r = await json("POST", "/api/accounts", body, cookie);
      expect(r.status).toBe(400);
      return ((await r.json()) as any).error as string;
    };
    expect(await bad({ type: "chequing" })).toBe("name required");
    expect(await bad({ name: "   ", type: "chequing" })).toBe("name required");
    expect(await bad({ name: "x".repeat(61), type: "chequing" })).toContain("60 characters");
    expect(await bad({ name: "Brokerage" })).toContain("type must be one of");
    expect(await bad({ name: "Brokerage", type: "investment" })).toContain("type must be one of");
    expect(await bad({ name: "Card", type: "credit_card", last4: "12" })).toContain("4 digits");
    expect(await bad({ name: "Card", type: "credit_card", last4: "12a4" })).toContain("4 digits");
    const malformed = await app.request("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(((await db.get("SELECT COUNT(*) AS n FROM accounts")) as any).n).toBe(0);
  });

  test("requires a session", async () => {
    const { json } = await setup();
    const r = await json("POST", "/api/accounts", { name: "Everyday", type: "chequing" });
    expect(r.status).toBe(401);
  });
});

describe("PUT /api/accounts/:id", () => {
  test("renames and changes last4, keeping the type", async () => {
    const { json, cookie } = await setup();
    const a = (await (await json("POST", "/api/accounts", { name: "Everyday", type: "chequing", last4: "1111" }, cookie)).json()) as any;
    expect((await json("PUT", `/api/accounts/${a.id}`, { name: "Joint" }, cookie)).status).toBe(200);
    let list = (await (await json("GET", "/api/accounts", undefined, cookie)).json()) as any;
    expect(list.accounts[0]).toMatchObject({ name: "Joint", type: "chequing", last4: "1111" });
    expect((await json("PUT", `/api/accounts/${a.id}`, { last4: "" }, cookie)).status).toBe(200);
    list = (await (await json("GET", "/api/accounts", undefined, cookie)).json()) as any;
    expect(list.accounts[0]).toMatchObject({ name: "Joint", last4: null });
  });

  test("400 on bad input, 404 on a missing account", async () => {
    const { json, cookie } = await setup();
    const a = (await (await json("POST", "/api/accounts", { name: "Everyday", type: "chequing" }, cookie)).json()) as any;
    expect((await json("PUT", `/api/accounts/${a.id}`, { name: "" }, cookie)).status).toBe(400);
    expect((await json("PUT", "/api/accounts/abc", { name: "X" }, cookie)).status).toBe(400);
    expect((await json("PUT", "/api/accounts/999", { name: "X" }, cookie)).status).toBe(404);
  });
});
