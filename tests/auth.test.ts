import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { wrapDb, migrateDb } from "../src/db";
import type { Db } from "../src/db-interface";
import { createApp } from "../src/app";
import {
  timingSafeEqual,
  hexToBytes,
  bytesToHex,
  randomHex,
  computeVerifier,
  rateLimitHit,
  type AuthConfig,
  type KVStore,
} from "../src/auth";

/** Map-backed KV double. expirationTtl is ignored: tests drive the window. */
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

const KDF_KEY = "ab".repeat(32); // 64 hex chars; the server never derives it
const SALT = "cd".repeat(16); // 32 hex chars

async function setupApp(auth?: Partial<AuthConfig>): Promise<{ app: Hono; kv: MapKV; db: Db; config: AuthConfig }> {
  const kv = new MapKV();
  const db = wrapDb(new Database(":memory:"));
  await migrateDb(db);
  const config: AuthConfig = { kv, pepper: "test-pepper", agentToken: "test-agent-token", ...auth };
  const app = createApp(async () => db, { auth: config });
  return { app, kv, db, config };
}

async function seedShop(db: Db): Promise<void> {
  await db.run("INSERT INTO accounts (name, type) VALUES ('Chequing', 'chequing')");
  await db.run("INSERT INTO pots (name, pot_group, target_type, target_cents) VALUES ('Groceries', 'Food', 'fixed', 0)");
}

function call(
  app: Hono,
  method: string,
  path: string,
  opts?: { body?: unknown; cookie?: string; headers?: Record<string, string> }
): Promise<Response> {
  const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
  if (opts?.cookie) headers["Cookie"] = opts.cookie;
  return app.request(path, {
    method,
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

function jsonCall(app: Hono, method: string, path: string, opts?: { body?: unknown; cookie?: string; headers?: Record<string, string> }) {
  return call(app, method, path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
  });
}

function sessionCookie(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  return set.split(";")[0];
}

describe("timingSafeEqual", () => {
  test("equal arrays are true", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });
  test("one differing byte is false", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });
  test("different lengths are false", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
  test("empty arrays are true", () => {
    expect(timingSafeEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true);
  });
});

describe("hex helpers", () => {
  test("bytesToHex/hexToBytes round-trip", () => {
    const b = new Uint8Array([0, 1, 254, 255]);
    expect(hexToBytes(bytesToHex(b))).toEqual(b);
  });
  test("hexToBytes rejects odd and non-hex input", () => {
    expect(() => hexToBytes("abc")).toThrow();
    expect(() => hexToBytes("zz")).toThrow();
  });
  test("randomHex has the right shape", () => {
    expect(randomHex(32)).toMatch(/^[0-9a-f]{64}$/);
    expect(randomHex(32)).not.toBe(randomHex(32));
  });
});

describe("computeVerifier", () => {
  test("deterministic for the same pepper and key", async () => {
    const a = await computeVerifier("pepper", KDF_KEY);
    const b = await computeVerifier("pepper", KDF_KEY);
    expect(timingSafeEqual(a, b)).toBe(true);
    expect(a.length).toBe(32);
  });
  test("changes with pepper and with key", async () => {
    const a = await computeVerifier("pepper", KDF_KEY);
    expect(timingSafeEqual(a, await computeVerifier("other", KDF_KEY))).toBe(false);
    expect(timingSafeEqual(a, await computeVerifier("pepper", "ff".repeat(32)))).toBe(false);
  });
  test("rejects malformed kdfKey", async () => {
    await expect(computeVerifier("pepper", "short")).rejects.toThrow();
  });
});

describe("rateLimitHit", () => {
  test("allows 5 attempts per window, then trips", async () => {
    const kv = new MapKV();
    for (let i = 0; i < 5; i++) expect(await rateLimitHit(kv, "1.2.3.4")).toBe(false);
    expect(await rateLimitHit(kv, "1.2.3.4")).toBe(true);
  });
  test("separate IPs have separate budgets", async () => {
    const kv = new MapKV();
    for (let i = 0; i < 6; i++) await rateLimitHit(kv, "1.2.3.4");
    expect(await rateLimitHit(kv, "5.6.7.8")).toBe(false);
  });
});

describe("auth endpoints", () => {
  test("me reports setupRequired before any user exists", async () => {
    const { app } = await setupApp();
    const me = await (await call(app, "GET", "/api/auth/me")).json();
    expect(me).toEqual({ authenticated: false, setupRequired: true });
  });

  test("setup validates its inputs", async () => {
    const { app } = await setupApp();
    const r = await jsonCall(app, "POST", "/api/auth/setup", { body: { username: "u" } });
    expect(r.status).toBe(400);
  });

  test("setup stores the peppered verifier and then permanently 404s", async () => {
    const { app, db } = await setupApp();
    const r = await jsonCall(app, "POST", "/api/auth/setup", {
      body: { username: "owner", salt: SALT, kdfKey: KDF_KEY },
    });
    expect(r.status).toBe(200);
    const row = (await db.get("SELECT salt, verifier, kdf_params FROM users WHERE username = 'owner'")) as any;
    expect(row.salt).toBe(SALT);
    expect(row.verifier).toBe(bytesToHex(await computeVerifier("test-pepper", KDF_KEY)));
    expect(row.kdf_params).toBe("m=19456,t=2,p=1");
    const again = await jsonCall(app, "POST", "/api/auth/setup", {
      body: { username: "intruder", salt: SALT, kdfKey: KDF_KEY },
    });
    expect(again.status).toBe(404);
  });

  test("setup 500s when no pepper is configured", async () => {
    const { app } = await setupApp({ pepper: "" });
    const r = await jsonCall(app, "POST", "/api/auth/setup", {
      body: { username: "owner", salt: SALT, kdfKey: KDF_KEY },
    });
    expect(r.status).toBe(500);
  });

  test("challenge returns stored params for known users, random salt for unknown", async () => {
    const { app } = await setupApp();
    await jsonCall(app, "POST", "/api/auth/setup", { body: { username: "owner", salt: SALT, kdfKey: KDF_KEY } });
    const known = await (
      await jsonCall(app, "POST", "/api/auth/challenge", { body: { username: "owner" } })
    ).json();
    expect(known).toEqual({ salt: SALT, kdf_params: "m=19456,t=2,p=1" });
    const unknown = await (
      await jsonCall(app, "POST", "/api/auth/challenge", { body: { username: "nobody" } })
    ).json();
    expect(unknown.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(unknown.salt).not.toBe(SALT);
    expect(unknown.kdf_params).toBe("m=19456,t=2,p=1");
  });

  test("login round-trip: wrong key 401s, right key sets a session cookie", async () => {
    const { app } = await setupApp();
    await jsonCall(app, "POST", "/api/auth/setup", { body: { username: "owner", salt: SALT, kdfKey: KDF_KEY } });

    const bad = await jsonCall(app, "POST", "/api/auth/login", {
      body: { username: "owner", kdfKey: "ff".repeat(32) },
    });
    expect(bad.status).toBe(401);

    const ghost = await jsonCall(app, "POST", "/api/auth/login", {
      body: { username: "nobody", kdfKey: KDF_KEY },
    });
    expect(ghost.status).toBe(401);

    const good = await jsonCall(app, "POST", "/api/auth/login", {
      body: { username: "owner", kdfKey: KDF_KEY },
    });
    expect(good.status).toBe(200);
    const set = good.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^session=[0-9a-f]{64};/);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("Secure");
    expect(set).toContain("SameSite=Lax");

    const me = await (await call(app, "GET", "/api/auth/me", { cookie: sessionCookie(good) })).json();
    expect(me).toEqual({ authenticated: true, setupRequired: false });
  });

  test("middleware: 401 without credentials, 200 with session or bearer", async () => {
    const { app } = await setupApp();
    await jsonCall(app, "POST", "/api/auth/setup", { body: { username: "owner", salt: SALT, kdfKey: KDF_KEY } });
    const login = await jsonCall(app, "POST", "/api/auth/login", {
      body: { username: "owner", kdfKey: KDF_KEY },
    });
    const cookie = sessionCookie(login);

    expect((await call(app, "GET", "/api/overview")).status).toBe(401);
    expect((await call(app, "GET", "/api/overview", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await call(app, "GET", "/api/overview", { headers: { Authorization: "Bearer test-agent-token" } })).status).toBe(200);
    expect((await call(app, "GET", "/api/overview", { cookie })).status).toBe(200);
  });

  test("logout clears the session", async () => {
    const { app } = await setupApp();
    await jsonCall(app, "POST", "/api/auth/setup", { body: { username: "owner", salt: SALT, kdfKey: KDF_KEY } });
    const login = await jsonCall(app, "POST", "/api/auth/login", {
      body: { username: "owner", kdfKey: KDF_KEY },
    });
    const cookie = sessionCookie(login);
    const out = await call(app, "POST", "/api/auth/logout", { cookie });
    expect(out.status).toBe(200);
    expect((await call(app, "GET", "/api/overview", { cookie })).status).toBe(401);
    const me = await (await call(app, "GET", "/api/auth/me", { cookie })).json();
    expect(me.authenticated).toBe(false);
  });

  test("sixth rapid login attempt is rate-limited", async () => {
    const { app } = await setupApp();
    await jsonCall(app, "POST", "/api/auth/setup", { body: { username: "owner", salt: SALT, kdfKey: KDF_KEY } });
    const headers = { "CF-Connecting-IP": "9.9.9.9" };
    for (let i = 0; i < 5; i++) {
      const r = await jsonCall(app, "POST", "/api/auth/login", {
        body: { username: "owner", kdfKey: "ff".repeat(32) },
        headers,
      });
      expect(r.status).toBe(401);
    }
    const limited = await jsonCall(app, "POST", "/api/auth/login", {
      body: { username: "owner", kdfKey: "ff".repeat(32) },
      headers,
    });
    expect(limited.status).toBe(429);
    // The budget is spent even for the right key.
    const alsoLimited = await jsonCall(app, "POST", "/api/auth/login", {
      body: { username: "owner", kdfKey: KDF_KEY },
      headers,
    });
    expect(alsoLimited.status).toBe(429);
  });

  test("entered_by follows the auth identity", async () => {
    const { app, db } = await setupApp();
    await seedShop(db);
    await jsonCall(app, "POST", "/api/auth/setup", { body: { username: "owner", salt: SALT, kdfKey: KDF_KEY } });
    const login = await jsonCall(app, "POST", "/api/auth/login", {
      body: { username: "owner", kdfKey: KDF_KEY },
    });
    const cookie = sessionCookie(login);
    const body = { date: "2026-09-27", accountId: 1, potId: 1, amountCents: -100, description: "user buy" };

    const asUser = await jsonCall(app, "POST", "/api/transactions", { body, cookie });
    expect(asUser.status).toBe(200);
    const userId = ((await asUser.json()) as any).id;
    expect(((await db.get("SELECT entered_by AS e FROM transactions WHERE id = ?", userId)) as any).e).toBe("user");

    const asAgent = await jsonCall(app, "POST", "/api/transactions", {
      body: { ...body, description: "agent buy" },
      headers: { Authorization: "Bearer test-agent-token" },
    });
    expect(asAgent.status).toBe(200);
    const agentId = ((await asAgent.json()) as any).id;
    expect(((await db.get("SELECT entered_by AS e FROM transactions WHERE id = ?", agentId)) as any).e).toBe("agent");
  });

  test("no-auth app keeps the local dev behavior", async () => {
    const db = wrapDb(new Database(":memory:"));
    await migrateDb(db);
    const app = createApp(async () => db);
    const me = await (await call(app, "GET", "/api/auth/me")).json();
    expect(me).toEqual({ authenticated: true, setupRequired: false });
    expect((await call(app, "GET", "/api/overview")).status).toBe(200);
  });
});
