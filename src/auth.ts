/** In-app auth: client-side Argon2id KDF, server-side peppered HMAC verifier.
 *
 *  Protocol (client holds the password; the server never sees it):
 *    1. Client POSTs /api/auth/challenge {username} and gets {salt, kdf_params}.
 *    2. Client derives K = argon2id(password, salt) with hash-wasm
 *       (m=19456, t=2, p=1, 32-byte output) and POSTs /api/auth/login
 *       {username, kdfKey} where kdfKey is K as hex.
 *    3. The server recomputes verifier = HMAC_SHA256(pepper, K) and compares
 *       it against the stored verifier in constant time. On success it mints
 *       an opaque 256-bit session token, stores {userId, username} in KV
 *       with a 30-day TTL, and returns it as an HttpOnly Secure
 *       SameSite=Lax cookie.
 *    4. Signup: POST /api/auth/signup {username, salt, kdfKey, inviteCode}.
 *       The invite code is required once any user exists; while the users
 *       table is empty the first user may sign up without one (bootstrap).
 *       Codes are single-use: validated, then claimed with a conditional
 *       UPDATE so concurrent signups cannot share one. Signup also creates
 *       the user's Uncategorized pot and mints a session, so the new user
 *       lands in the app without a second login. The old one-time /api/auth/setup now
 *       permanently 404s.
 *    5. Agent access: per-user bearer tokens. An authenticated user mints one
 *       via POST /api/auth/agent-tokens (the raw token is shown once; only
 *       its SHA-256 is stored) and revokes via DELETE. Requests present it
 *       as Authorization: Bearer. The old global AGENT_TOKEN is retired.
 *
 *  Pass-the-hash property: K is a bearer credential while in flight, so
 *  logins are HTTPS-only and rate-limited per IP (5 attempts per 10 min);
 *  signups are rate-limited separately. Sessions live 30 days so K is
 *  transmitted rarely.
 *
 *  Worker-safe by construction: imports only `hono` and a type-only
 *  db-interface import. No bun:sqlite, no node:fs, no hono/bun.
 *  WebCrypto (crypto.subtle, crypto.getRandomValues) is available on
 *  Workers, in browsers, and in Bun. */

import { Hono } from "hono";
import type { Db, BatchStatement, BatchResult } from "./db-interface";

/** Minimal KV surface used by auth. Cloudflare's KVNamespace satisfies this
 *  structurally; tests use a Map-backed double. */
export interface KVStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AuthConfig {
  kv: KVStore;
  pepper: string;
}

/** Who is making the request, resolved per request by the middleware:
 *  "user" for a cookie session, "agent" for a per-user bearer token. */
export interface Identity {
  kind: "agent" | "user";
  userId: number;
}

/** 30-day sessions; 5 login attempts per IP per 10 minutes. */
export const SESSION_TTL_SECONDS = 2592000;
export const RATE_LIMIT_MAX = 5;
export const RATE_LIMIT_WINDOW_SECONDS = 600;

/** KDF params pinned server-side; the client just echoes what challenge says. */
export const DEFAULT_KDF_PARAMS = "m=19456,t=2,p=1";

/* ---------- byte helpers ---------- */

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function randomHex(nBytes: number): string {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

/** Constant-time equality over raw bytes. workerd has no timingSafeEqual,
 *  so this manual loop is the compare primitive for verifiers and tokens.
 *  Compares the full loop even on early mismatch; length mismatch is false. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** verifier = HMAC_SHA256(pepper, K). kdfKeyHex must be the 64-char hex of
 *  the 32-byte Argon2id output. */
export async function computeVerifier(pepper: string, kdfKeyHex: string): Promise<Uint8Array> {
  if (!/^[0-9a-fA-F]{64}$/.test(kdfKeyHex)) throw new Error("bad kdfKey");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, hexToBytes(kdfKeyHex));
  return new Uint8Array(sig);
}

/** SHA-256 of a token, hex-encoded. Agent tokens are stored hashed; the raw
 *  token is shown once at creation and never again. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

/* ---------- sessions & rate limits ---------- */

function sessionCookie(token: string, maxAge: number): string {
  return `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function getSessionToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === "session") {
      const v = part.slice(eq + 1).trim();
      return /^[0-9a-f]{64}$/.test(v) ? v : null;
    }
  }
  return null;
}

async function mintSession(kv: KVStore, userId: number, username: string): Promise<string> {
  const token = randomHex(32);
  await kv.put(`sess:${token}`, JSON.stringify({ userId, username }), { expirationTtl: SESSION_TTL_SECONDS });
  return token;
}

/** True when this IP has exhausted its budget for the scope. Counts every
 *  attempt (success or failure); the window is fixed at 10 minutes.
 *  Scopes ("login", "signup") get independent buckets under `rl:<scope>:`.
 *  (Review L2, accepted risk: the KV read-modify-write is not atomic, so
 *  under a concurrent burst the limit is approximate, not a hard cap. It
 *  bounds abuse well enough for a low-traffic app; a distributed counter
 *  would be over-engineering here.) */
export async function rateLimitHit(kv: KVStore, ip: string, scope = "login"): Promise<boolean> {
  const key = `rl:${scope}:${ip}`;
  const now = Date.now();
  let count = 0;
  let start = now;
  const raw = await kv.get(key);
  if (raw) {
    try {
      const s = JSON.parse(raw) as { count: number; start: number };
      if (typeof s.count === "number" && typeof s.start === "number" && now - s.start < RATE_LIMIT_WINDOW_SECONDS * 1000) {
        count = s.count;
        start = s.start;
      }
    } catch {
      // Corrupted entry: fall through and reset the window.
    }
  }
  count += 1;
  await kv.put(key, JSON.stringify({ count, start }), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
  return count > RATE_LIMIT_MAX;
}

function clientIp(c: any): string {
  // (Review L3, accepted risk: clients behind the same NAT / CGNAT share one
  // bucket, so one network's heavy traffic can burn the budget for everyone
  // behind it. Fail-closed per bucket is the safe direction, and the window
  // is only 10 minutes.)
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "127.0.0.1"
  );
}

/** Identify the request: a valid session cookie resolves to the user it was
 *  minted for; a bearer token is hashed and looked up in agent_tokens
 *  (per-user tokens, M2). Otherwise null. Pre-M2 sessions stored only
 *  {username} and no longer resolve: those clients re-login. */
export async function identifyRequest(c: any, config: AuthConfig, db: Db): Promise<Identity | null> {
  const token = getSessionToken(c.req.header("Cookie") ?? null);
  if (token) {
    const raw = await config.kv.get(`sess:${token}`);
    if (raw) {
      try {
        const s = JSON.parse(raw) as { userId?: unknown; username?: unknown };
        if (typeof s.userId === "number" && Number.isInteger(s.userId) && s.userId > 0) {
          return { kind: "user", userId: s.userId };
        }
      } catch {
        // Corrupt session value: fall through to unauthenticated.
      }
    }
  }
  const authz: string = c.req.header("Authorization") ?? "";
  if (authz.startsWith("Bearer ")) {
    const presented = authz.slice(7).trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(presented)) {
      const row = await db.get<{ user_id: number }>(
        "SELECT user_id FROM agent_tokens WHERE token_hash = ?",
        await sha256Hex(presented)
      );
      if (row) return { kind: "agent", userId: row.user_id };
    }
  }
  return null;
}

/** Hono middleware for /api/*: skips /api/auth/* (those routes identify the
 *  request themselves), requires a session or a per-user agent token, and
 *  records the identity for user_id scoping and entered_by derivation. */
export function authMiddleware(config: AuthConfig, getDb: () => Promise<Db>) {
  return async (c: any, next: () => Promise<void>) => {
    if (c.req.path.startsWith("/api/auth/")) return next();
    const identity = await identifyRequest(c, config, await getDb());
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    c.set("identity", identity);
    await next();
  };
}

/* ---------- the /api/auth/* routes ---------- */

async function userCount(db: Db): Promise<number> {
  const t = await db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'");
  if (!t) return 0;
  const row = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users");
  return row?.n ?? 0;
}

function validUsername(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.trim().length <= 80;
}

export function registerAuth(app: Hono, getDb: () => Promise<Db>, config: AuthConfig): void {
  /** Challenge: {salt, kdf_params} for the user. Unknown usernames get a
   *  random salt so the response shape never reveals whether a user exists. */
  app.post("/api/auth/challenge", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!validUsername(body?.username)) return c.json({ error: "username required" }, 400);
    const db = await getDb();
    const row = await db.get<{ salt: string; kdf_params: string }>(
      "SELECT salt, kdf_params FROM users WHERE username = ?",
      body.username.trim()
    );
    if (row) return c.json({ salt: row.salt, kdf_params: row.kdf_params });
    return c.json({ salt: randomHex(16), kdf_params: DEFAULT_KDF_PARAMS });
  });

  /** Retired in M2: one-time setup was replaced by invite-code signup.
   *  Kept as an explicit 404 so old clients fail closed and loud. */
  app.post("/api/auth/setup", async (c) => {
    return c.json({ error: "not found" }, 404);
  });

  /** Signup with an invite code. The code is required once any user exists;
   *  while the users table is empty the first user may sign up without one
   *  (bootstrap, like the old setup). The user insert, the code claim, and
   *  the Uncategorized-pot provision run as ONE atomic batch: any failure
   *  rolls all three back, so a failed signup can never leave an orphaned
   *  user row or a half-claimed code (review L4). The code claim is still a
   *  conditional UPDATE, so concurrent signups cannot share one code: the
   *  loser sees zero claimed rows and its orphaned user row is deleted.
   *  Signup also provisions the user's Uncategorized pot (deletePot's move
   *  target). */
  app.post("/api/auth/signup", async (c) => {
    if (!config.pepper) return c.json({ error: "auth not configured" }, 500);
    const body = await c.req.json().catch(() => null);
    const username = validUsername(body?.username) ? body.username.trim() : "";
    const salt = typeof body?.salt === "string" && /^[0-9a-fA-F]{32}$/.test(body.salt) ? body.salt.toLowerCase() : "";
    const kdfKey = typeof body?.kdfKey === "string" && /^[0-9a-fA-F]{64}$/.test(body.kdfKey) ? body.kdfKey : "";
    const rawCode = typeof body?.inviteCode === "string" ? body.inviteCode.trim().toLowerCase() : "";
    const inviteCode = /^[0-9a-f]{32}$/.test(rawCode) ? rawCode : "";
    if (!username || !salt || !kdfKey) return c.json({ error: "username, salt, and kdfKey required" }, 400);
    if (await rateLimitHit(config.kv, clientIp(c), "signup")) {
      return c.json({ error: "too many attempts; try again later" }, 429);
    }
    const db = await getDb();
    const existing = await userCount(db);
    if (existing > 0 && !inviteCode) return c.json({ error: "invite code required" }, 400);
    if (inviteCode) {
      const ok = await db.get("SELECT code FROM invite_codes WHERE code = ? AND used_by IS NULL", inviteCode);
      if (!ok) return c.json({ error: "invalid or already-used invite code" }, 400);
    }
    const verifier = bytesToHex(await computeVerifier(config.pepper, kdfKey));
    const now = new Date().toISOString();
    // Batch statements cannot reference each other's results, so the code
    // claim and pot provision locate the new user through the UNIQUE
    // username instead of a returned id.
    const stmts: BatchStatement[] = [
      {
        sql: "INSERT INTO users (username, salt, verifier, kdf_params, created_at) VALUES (?, ?, ?, ?, ?)",
        params: [username, salt, verifier, DEFAULT_KDF_PARAMS, now],
      },
    ];
    if (inviteCode) {
      stmts.push({
        sql: "UPDATE invite_codes SET used_by = (SELECT id FROM users WHERE username = ?), used_at = ? WHERE code = ? AND used_by IS NULL",
        params: [username, now, inviteCode],
      });
    }
    stmts.push({
      sql: "INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES ((SELECT id FROM users WHERE username = ?), 'Uncategorized', 'General', 'fixed', 0)",
      params: [username],
    });
    let results: BatchResult[];
    try {
      results = await db.batch(stmts);
    } catch (e) {
      // The batch is atomic: a UNIQUE violation on the username rolls the
      // whole batch back, so the invite code stays unused and the client can
      // retry with another name. Anything else is a server error.
      // (Review L1, accepted risk: learning that a username is taken
      // requires a valid unused invite code — or the bootstrap window —
      // and is per-IP rate-limited.)
      if (/UNIQUE constraint failed/i.test(e instanceof Error ? e.message : "")) {
        return c.json({ error: "that username is taken" }, 400);
      }
      throw e;
    }
    const userId = results[0].lastRowId;
    if (inviteCode && results[1].changes === 0) {
      // Lost the claim race: the batch committed a user row whose code claim
      // hit an already-used code. Delete the orphan; the code belongs to the
      // winner.
      await db.run("DELETE FROM users WHERE id = ?", userId);
      return c.json({ error: "invalid or already-used invite code" }, 400);
    }
    // Signup logs the user straight in: same session cookie as login, so the
    // client lands in the app instead of bouncing back to the login form.
    const token = await mintSession(config.kv, userId, username);
    c.header("Set-Cookie", sessionCookie(token, SESSION_TTL_SECONDS));
    return c.json({ ok: true });
  });

  /** Login: recompute the verifier and compare in constant time. Unknown
   *  users go through the same HMAC + compare against a random verifier so
   *  timing reveals nothing about user existence. */
  app.post("/api/auth/login", async (c) => {
    if (!config.pepper) return c.json({ error: "auth not configured" }, 500);
    const body = await c.req.json().catch(() => null);
    const username = validUsername(body?.username) ? body.username.trim() : "";
    const kdfKey = typeof body?.kdfKey === "string" && /^[0-9a-fA-F]{64}$/.test(body.kdfKey) ? body.kdfKey : "";
    if (!username || !kdfKey) return c.json({ error: "username and kdfKey required" }, 400);
    if (await rateLimitHit(config.kv, clientIp(c))) return c.json({ error: "too many attempts; try again later" }, 429);
    const db = await getDb();
    const row = await db.get<{ id: number; verifier: string }>("SELECT id, verifier FROM users WHERE username = ?", username);
    const expected = row ? hexToBytes(row.verifier) : crypto.getRandomValues(new Uint8Array(32));
    const actual = await computeVerifier(config.pepper, kdfKey);
    if (!row || !timingSafeEqual(actual, expected)) return c.json({ error: "wrong username or password" }, 401);
    const token = await mintSession(config.kv, row.id, username);
    c.header("Set-Cookie", sessionCookie(token, SESSION_TTL_SECONDS));
    return c.json({ ok: true });
  });

  /** Logout: delete the KV session and clear the cookie. Idempotent. */
  app.post("/api/auth/logout", async (c) => {
    const token = getSessionToken(c.req.header("Cookie") ?? null);
    if (token) await config.kv.delete(`sess:${token}`);
    c.header("Set-Cookie", sessionCookie("", 0));
    return c.json({ ok: true });
  });

  /** Frontend gate: { authenticated, setupRequired }. Identity-aware: a valid
   *  session or per-user agent token reports authenticated. */
  app.get("/api/auth/me", async (c) => {
    const db = await getDb();
    const identity = await identifyRequest(c, config, db);
    if (identity) {
      const row = await db.get<{ username: string }>("SELECT username FROM users WHERE id = ?", identity.userId);
      return c.json({ authenticated: true, setupRequired: false, username: row?.username ?? null });
    }
    return c.json({ authenticated: false, setupRequired: (await userCount(db)) === 0 });
  });

  /** List the user's agent tokens (id, name, created_at; never the secret). */
  app.get("/api/auth/agent-tokens", async (c) => {
    const db = await getDb();
    const identity = await identifyRequest(c, config, db);
    if (!identity || identity.kind !== "user") return c.json({ error: "unauthorized" }, 401);
    const rows = await db.all<{ id: number; name: string; created_at: string }>(
      "SELECT id, name, created_at FROM agent_tokens WHERE user_id = ? ORDER BY id",
      identity.userId
    );
    return c.json({ tokens: rows });
  });

  /** Mint a per-user agent token. Requires a user session: these are
   *  full-access bearer credentials, so another agent token cannot mint one.
   *  The raw token is returned once; only its SHA-256 is stored. */
  app.post("/api/auth/agent-tokens", async (c) => {
    const db = await getDb();
    const identity = await identifyRequest(c, config, db);
    if (!identity || identity.kind !== "user") return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => null);
    const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : "cli";
    const token = randomHex(32);
    const row = await db.get<{ id: number }>(
      "INSERT INTO agent_tokens (user_id, token_hash, name) VALUES (?, ?, ?) RETURNING id",
      identity.userId,
      await sha256Hex(token),
      name
    );
    return c.json({ ok: true, id: row!.id, token });
  });

  /** Revoke one of the user's agent tokens. The id is validated as pure
   *  digits before parsing: parseInt would silently accept "12abc" as 12
   *  (review L5). */
  app.delete("/api/auth/agent-tokens/:id", async (c) => {
    const db = await getDb();
    const identity = await identifyRequest(c, config, db);
    if (!identity || identity.kind !== "user") return c.json({ error: "unauthorized" }, 401);
    const idParam = c.req.param("id");
    if (!/^\d+$/.test(idParam)) return c.json({ error: "bad token id" }, 400);
    const tokenId = parseInt(idParam, 10);
    if (tokenId <= 0) return c.json({ error: "bad token id" }, 400);
    const r = await db.run("DELETE FROM agent_tokens WHERE id = ? AND user_id = ?", tokenId, identity.userId);
    if (r.changes === 0) return c.json({ error: "no such token" }, 404);
    return c.json({ ok: true });
  });

  /** Mint a single-use invite code. Any authenticated identity may do this:
   *  the operator's agent mints codes through the CLI, and invitees are
   *  bounded by code distribution. */
  app.post("/api/auth/invite-codes", async (c) => {
    const db = await getDb();
    const identity = await identifyRequest(c, config, db);
    if (!identity) return c.json({ error: "unauthorized" }, 401);
    const code = randomHex(16);
    await db.run("INSERT INTO invite_codes (code, created_by) VALUES (?, ?)", code, identity.userId);
    return c.json({ ok: true, code });
  });
}
