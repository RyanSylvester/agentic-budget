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
  sha256Hex,
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
  const config: AuthConfig = { kv, pepper: "test-pepper", ...auth };
  const app = createApp(async () => db, { auth: config });
  return { app, kv, db, config };
}

async function seedShop(db: Db): Promise<void> {
  await db.run("INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing', 'chequing')");
  await db.run("INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES (1, 'Groceries', 'Food', 'fixed', 0)");
}

async function call(
  app: Hono,
  method: string,
  path: string,
  opts?: { body?: unknown; cookie?: string; headers?: Record<string, string> }
): Promise<Response> {
  const headers: Record<string, string> = { ...(opts?.headers ?? {}) };
  if (opts?.cookie) headers["Cookie"] = opts.cookie;
  return await app.request(path, {
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

/** First user signs up with no invite code. Signup mints a session cookie,
 *  so the response authenticates the new user immediately. */
async function signupFirst(app: Hono, username = "owner"): Promise<void> {
  const r = await jsonCall(app, "POST", "/api/auth/signup", {
    body: { username, salt: SALT, kdfKey: KDF_KEY },
  });
  expect(r.status).toBe(200);
  expect(((await r.json()) as any).ok).toBe(true);
}

async function loginAs(app: Hono, username = "owner"): Promise<string> {
  const r = await jsonCall(app, "POST", "/api/auth/login", {
    body: { username, kdfKey: KDF_KEY },
  });
  expect(r.status).toBe(200);
  return sessionCookie(r);
}

async function mintInvite(app: Hono, cookie: string): Promise<string> {
  const r = await jsonCall(app, "POST", "/api/auth/invite-codes", { cookie });
  expect(r.status).toBe(200);
  return ((await r.json()) as any).code as string;
}

async function mintAgentToken(app: Hono, cookie: string, name = "t"): Promise<{ id: number; token: string }> {
  const r = await jsonCall(app, "POST", "/api/auth/agent-tokens", { body: { name }, cookie });
  expect(r.status).toBe(200);
  const body = (await r.json()) as any;
  expect(body.token).toMatch(/^[0-9a-f]{64}$/);
  return { id: body.id, token: body.token };
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
  test("login and signup scopes are independent", async () => {
    const kv = new MapKV();
    for (let i = 0; i < 6; i++) await rateLimitHit(kv, "1.2.3.4", "login");
    expect(await rateLimitHit(kv, "1.2.3.4", "login")).toBe(true);
    expect(await rateLimitHit(kv, "1.2.3.4", "signup")).toBe(false);
  });
});

describe("auth endpoints", () => {
  test("me reports setupRequired before any user exists", async () => {
    const { app } = await setupApp();
    const me = await (await call(app, "GET", "/api/auth/me")).json();
    expect(me).toEqual({ authenticated: false, setupRequired: true });
  });

  test("setup endpoint is gone", async () => {
    const { app } = await setupApp();
    const r = await jsonCall(app, "POST", "/api/auth/setup", {
      body: { username: "owner", salt: SALT, kdfKey: KDF_KEY },
    });
    expect(r.status).toBe(404);
  });

  test("signup validates its inputs", async () => {
    const { app } = await setupApp();
    expect((await jsonCall(app, "POST", "/api/auth/signup", { body: { username: "u" } })).status).toBe(400);
    expect(
      (await jsonCall(app, "POST", "/api/auth/signup", { body: { username: "  ", salt: SALT, kdfKey: KDF_KEY } })).status
    ).toBe(400);
    expect(
      (await jsonCall(app, "POST", "/api/auth/signup", { body: { username: "u", salt: SALT, kdfKey: "short" } })).status
    ).toBe(400);
  });

  test("first signup needs no invite code and stores the peppered verifier", async () => {
    const { app, db } = await setupApp();
    const r = await jsonCall(app, "POST", "/api/auth/signup", {
      body: { username: "owner", salt: SALT, kdfKey: KDF_KEY },
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).ok).toBe(true);
    // Signup mints a session: the new user lands in the app without logging in.
    const signupCookie = sessionCookie(r);
    expect(signupCookie).toMatch(/^session=/);
    const meAfterSignup = await (await call(app, "GET", "/api/auth/me", { cookie: signupCookie })).json();
    expect(meAfterSignup.authenticated).toBe(true);
    expect(meAfterSignup.username).toBe("owner");

    const row = (await db.get("SELECT salt, verifier, kdf_params FROM users WHERE username = 'owner'")) as any;
    expect(row.salt).toBe(SALT);
    expect(row.verifier).toBe(bytesToHex(await computeVerifier("test-pepper", KDF_KEY)));
    expect(row.kdf_params).toBe("m=19456,t=2,p=1");

    // Signup seeds zero pots: the user creates their first pot in the app.
    const potCount = (await db.get(
      "SELECT COUNT(*) AS n FROM pots WHERE user_id = (SELECT id FROM users WHERE username = 'owner')"
    )) as any;
    expect(potCount.n).toBe(0);

    const cookie = await loginAs(app);
    const me = await (await call(app, "GET", "/api/auth/me", { cookie })).json();
    expect(me.authenticated).toBe(true);
    expect(me.setupRequired).toBe(false);
    expect(me.username).toBe("owner");
  });

  test("signup 500s when no pepper is configured", async () => {
    const { app } = await setupApp({ pepper: "" });
    const r = await jsonCall(app, "POST", "/api/auth/signup", {
      body: { username: "owner", salt: SALT, kdfKey: KDF_KEY },
    });
    expect(r.status).toBe(500);
  });

  test("second signup without a code is rejected", async () => {
    const { app } = await setupApp();
    await signupFirst(app);
    const r = await jsonCall(app, "POST", "/api/auth/signup", {
      body: { username: "second", salt: SALT, kdfKey: KDF_KEY },
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("invite code required");
  });

  test("signup with an unknown invite code is rejected", async () => {
    const { app } = await setupApp();
    await signupFirst(app);
    // Malformed codes are treated as absent...
    const malformed = await jsonCall(app, "POST", "/api/auth/signup", {
      body: { username: "second", salt: SALT, kdfKey: KDF_KEY, inviteCode: "nope" },
    });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as any).error).toBe("invite code required");
    // ...while a well-formed but unknown code is explicitly invalid.
    const r = await jsonCall(app, "POST", "/api/auth/signup", {
      body: { username: "second", salt: SALT, kdfKey: KDF_KEY, inviteCode: "ab".repeat(16) },
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("invalid or already-used invite code");
  });

  test("signup with a valid code works once and consumes the code", async () => {
    const { app, db } = await setupApp();
    await signupFirst(app);
    const cookie = await loginAs(app);
    const code = await mintInvite(app, cookie);

    const r = await jsonCall(app, "POST", "/api/auth/signup", {
      body: { username: "second", salt: SALT, kdfKey: KDF_KEY, inviteCode: code },
    });
    expect(r.status).toBe(200);
    const second = (await db.get("SELECT id FROM users WHERE username = 'second'")) as any;
    const used = (await db.get("SELECT used_by FROM invite_codes WHERE code = ?", code)) as any;
    expect(used.used_by).toBe(second.id);

    const reuse = await jsonCall(app, "POST", "/api/auth/signup", {
      body: { username: "third", salt: SALT, kdfKey: KDF_KEY, inviteCode: code },
    });
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as any).error).toBe("invalid or already-used invite code");
  });

  test("taken usernames are rejected without consuming the code", async () => {
    const { app, db } = await setupApp();
    await signupFirst(app);
    const cookie = await loginAs(app);
    const used = await mintInvite(app, cookie);
    const fresh = await mintInvite(app, cookie);

    const r = await jsonCall(app, "POST", "/api/auth/signup", {
      body: { username: "owner", salt: SALT, kdfKey: KDF_KEY, inviteCode: used },
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("that username is taken");
    // The code survives for a real signup.
    const ok = await jsonCall(app, "POST", "/api/auth/signup", {
      body: { username: "second", salt: SALT, kdfKey: KDF_KEY, inviteCode: used },
    });
    expect(ok.status).toBe(200);
    expect(((await db.get("SELECT used_by FROM invite_codes WHERE code = ?", fresh)) as any).used_by).toBeNull();
  });

  test("a mid-signup code-claim failure rolls back the user row and leaves the code unused", async () => {
    const { app, db } = await setupApp();
    await signupFirst(app);
    const cookie = await loginAs(app);
    const code = await mintInvite(app, cookie);
    const usersBefore = ((await db.get("SELECT COUNT(*) AS n FROM users")) as any).n;
    // Simulate the L4 failure: the invite-code claim aborts mid-batch.
    await db.exec(
      "CREATE TRIGGER abort_claim BEFORE UPDATE ON invite_codes BEGIN SELECT RAISE(ABORT, 'boom'); END;"
    );
    const r = await jsonCall(app, "POST", "/api/auth/signup", {
      body: { username: "second", salt: SALT, kdfKey: KDF_KEY, inviteCode: code },
    });
    expect(r.status).toBe(500);
    // Atomic batch: no orphaned user row, and the code is still unused.
    expect(((await db.get("SELECT COUNT(*) AS n FROM users")) as any).n).toBe(usersBefore);
    expect(((await db.get("SELECT used_by FROM invite_codes WHERE code = ?", code)) as any).used_by).toBeNull();
    // Without the trigger the same signup succeeds and consumes the code.
    await db.exec("DROP TRIGGER abort_claim");
    const ok = await jsonCall(app, "POST", "/api/auth/signup", {
      body: { username: "second", salt: SALT, kdfKey: KDF_KEY, inviteCode: code },
    });
    expect(ok.status).toBe(200);
    expect(((await db.get("SELECT used_by FROM invite_codes WHERE code = ?", code)) as any).used_by).not.toBeNull();
  });

  test("sixth rapid signup attempt is rate-limited", async () => {
    const { app } = await setupApp();
    await signupFirst(app);
    const headers = { "CF-Connecting-IP": "9.9.9.9" };
    // The first signup above used no IP header (a different bucket). Each
    // attempt below fails on the missing invite code but still spends the
    // signup budget for 9.9.9.9.
    for (let i = 0; i < 5; i++) {
      const r = await jsonCall(app, "POST", "/api/auth/signup", {
        body: { username: `u${i}`, salt: SALT, kdfKey: KDF_KEY },
        headers,
      });
      expect(r.status).toBe(400);
    }
    const limited = await jsonCall(app, "POST", "/api/auth/signup", {
      body: { username: "u5", salt: SALT, kdfKey: KDF_KEY },
      headers,
    });
    expect(limited.status).toBe(429);
  });

  test("challenge returns stored params for known users, random salt for unknown", async () => {
    const { app } = await setupApp();
    await signupFirst(app);
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
    await signupFirst(app);

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

    const me = await (await call(app, "GET", "/api/auth/me", { cookie: sessionCookie(good) })).json();
    expect(me.authenticated).toBe(true);
    expect(me.setupRequired).toBe(false);
    expect(me.username).toBe("owner");
  });

  test("middleware: 401 without credentials, 200 with session or minted bearer", async () => {
    const { app } = await setupApp();
    await signupFirst(app);
    const cookie = await loginAs(app);
    const { token } = await mintAgentToken(app, cookie);

    expect((await call(app, "GET", "/api/overview")).status).toBe(401);
    expect((await call(app, "GET", "/api/overview", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    // The old global AGENT_TOKEN no longer exists: a stale shared secret authenticates nobody.
    expect((await call(app, "GET", "/api/overview", { headers: { Authorization: "Bearer test-agent-token" } })).status).toBe(401);
    expect((await call(app, "GET", "/api/overview", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await call(app, "GET", "/api/overview", { cookie })).status).toBe(200);
  });

  test("me is identity-aware: bearer reports the token's user", async () => {
    const { app } = await setupApp();
    await signupFirst(app);
    const cookie = await loginAs(app);
    const { token } = await mintAgentToken(app, cookie);
    const me = await (
      await call(app, "GET", "/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })
    ).json();
    expect(me).toEqual({ authenticated: true, setupRequired: false, username: "owner" });
  });

  test("agent tokens: mint needs a user session, revoke kills the token", async () => {
    const { app, db } = await setupApp();
    await signupFirst(app);
    const cookie = await loginAs(app);
    const { id, token } = await mintAgentToken(app, cookie, "cli");

    const row = (await db.get("SELECT name, token_hash FROM agent_tokens WHERE id = ?", id)) as any;
    expect(row.name).toBe("cli");
    // Only the SHA-256 hash is stored, never the token itself.
    expect(row.token_hash).not.toContain(token);
    expect(row.token_hash).toBe(await sha256Hex(token));

    // An agent identity cannot mint more tokens.
    const agentMint = await jsonCall(app, "POST", "/api/auth/agent-tokens", {
      body: { name: "nope" },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(agentMint.status).toBe(401);

    // Revoke via the session; the bearer stops working immediately and the
    // row is gone.
    const del = await call(app, "DELETE", `/api/auth/agent-tokens/${id}`, { cookie });
    expect(del.status).toBe(200);
    expect(await db.get("SELECT 1 FROM agent_tokens WHERE id = ?", id)).toBeNull();
    expect((await call(app, "GET", "/api/overview", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(
      401
    );
  });

  test("agent token list shows only the caller's tokens, never the secret", async () => {
    const { app } = await setupApp();
    await signupFirst(app);
    const cookieA = await loginAs(app);
    const first = await mintAgentToken(app, cookieA, "cli");
    await mintAgentToken(app, cookieA, "home");
    expect(first.id).toBeGreaterThan(0);

    // A second user with their own token must not see user A's tokens.
    const invite = await mintInvite(app, cookieA);
    const signupB = await jsonCall(app, "POST", "/api/auth/signup", {
      body: { username: "second", salt: SALT, kdfKey: KDF_KEY, inviteCode: invite },
    });
    expect(signupB.status).toBe(200);
    const cookieB = await loginAs(app, "second");

    const listA = (await (await call(app, "GET", "/api/auth/agent-tokens", { cookie: cookieA })).json()) as any;
    expect(listA.tokens.map((t: any) => t.name).sort()).toEqual(["cli", "home"]);
    for (const t of listA.tokens) {
      expect(Object.keys(t).sort()).toEqual(["created_at", "id", "name"]);
    }
    const listB = (await (await call(app, "GET", "/api/auth/agent-tokens", { cookie: cookieB })).json()) as any;
    expect(listB.tokens).toEqual([]);

    // Agent identities and anonymous callers get 401, not the list.
    const agent = await mintAgentToken(app, cookieA, "agent-cant-list");
    expect(
      (await call(app, "GET", "/api/auth/agent-tokens", { headers: { Authorization: `Bearer ${agent.token}` } }))
        .status
    ).toBe(401);
    expect((await call(app, "GET", "/api/auth/agent-tokens")).status).toBe(401);
  });

  test("invite codes can be minted by a session or an agent token, never anonymously", async () => {
    const { app } = await setupApp();
    await signupFirst(app);
    const cookie = await loginAs(app);
    expect((await jsonCall(app, "POST", "/api/auth/invite-codes")).status).toBe(401);

    const viaSession = await jsonCall(app, "POST", "/api/auth/invite-codes", { cookie });
    expect(viaSession.status).toBe(200);
    expect(((await viaSession.json()) as any).code).toMatch(/^[0-9a-f]{32}$/);

    const { token } = await mintAgentToken(app, cookie);
    const viaAgent = await jsonCall(app, "POST", "/api/auth/invite-codes", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(viaAgent.status).toBe(200);
    expect(((await viaAgent.json()) as any).code).toMatch(/^[0-9a-f]{32}$/);
  });

  test("logout clears the session", async () => {
    const { app } = await setupApp();
    await signupFirst(app);
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
    await signupFirst(app);
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

  test("entered_by and user_id follow the auth identity", async () => {
    const { app, db } = await setupApp();
    await signupFirst(app);
    const cookie = await loginAs(app);
    const { token } = await mintAgentToken(app, cookie);
    await seedShop(db);
    const body = { date: "2026-09-27", accountId: 1, potId: 1, amountCents: -100, description: "user buy" };

    const asUser = await jsonCall(app, "POST", "/api/transactions", { body, cookie });
    expect(asUser.status).toBe(200);
    const userId = ((await asUser.json()) as any).id;
    const userRow = (await db.get("SELECT entered_by AS e, user_id AS u FROM transactions WHERE id = ?", userId)) as any;
    expect(userRow.e).toBe("user");
    expect(userRow.u).toBe(1);

    const asAgent = await jsonCall(app, "POST", "/api/transactions", {
      body: { ...body, description: "agent buy" },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(asAgent.status).toBe(200);
    const agentId = ((await asAgent.json()) as any).id;
    const agentRow = (await db.get("SELECT entered_by AS e, user_id AS u FROM transactions WHERE id = ?", agentId)) as any;
    expect(agentRow.e).toBe("agent");
    expect(agentRow.u).toBe(1);
  });

  test("no-auth app keeps the local dev behavior", async () => {
    const db = wrapDb(new Database(":memory:"));
    await migrateDb(db);
    const app = createApp(async () => db);
    const me = await (await call(app, "GET", "/api/auth/me")).json();
    expect(me).toEqual({ authenticated: true, setupRequired: false });
    expect((await call(app, "GET", "/api/overview")).status).toBe(200);
  });

  test("no-auth app writes attribute to the first local user", async () => {
    const db = wrapDb(new Database(":memory:"));
    await migrateDb(db);
    await db.run("INSERT INTO users (username, salt, verifier, kdf_params) VALUES ('local', 's', 'v', 'kdf')");
    await db.run("INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing', 'chequing')");
    await db.run("INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES (1, 'Groceries', 'Food', 'fixed', 0)");
    const app = createApp(async () => db);
    const r = await jsonCall(app, "POST", "/api/transactions", {
      body: { date: "2026-09-27", accountId: 1, potId: 1, amountCents: -100, description: "local buy" },
    });
    expect(r.status).toBe(200);
    const id = ((await r.json()) as any).id;
    expect(((await db.get("SELECT user_id AS u FROM transactions WHERE id = ?", id)) as any).u).toBe(1);
  });
});
