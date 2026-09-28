/** In-app auth: client-side Argon2id KDF, server-side peppered HMAC verifier.
 *
 *  Protocol (client holds the password; the server never sees it):
 *    1. Client POSTs /api/auth/challenge {username} and gets {salt, kdf_params}.
 *    2. Client derives K = argon2id(password, salt) with hash-wasm
 *       (m=19456, t=2, p=1, 32-byte output) and POSTs /api/auth/login
 *       {username, kdfKey} where kdfKey is K as hex.
 *    3. The server recomputes verifier = HMAC_SHA256(pepper, K) and compares
 *       it against the stored verifier in constant time. On success it mints
 *       an opaque 256-bit session token, stores it in KV with a 30-day TTL,
 *       and returns it as an HttpOnly Secure SameSite=Lax cookie.
 *    4. First run: /api/auth/setup {username, salt, kdfKey} stores the
 *       verifier. It works only while the users table is empty, then 404s
 *       permanently.
 *
 *  Pass-the-hash property: K is a bearer credential while in flight, so
 *  logins are HTTPS-only and rate-limited per IP (5 attempts per 10 min).
 *  Sessions live 30 days so K is transmitted rarely.
 *
 *  Worker-safe by construction: imports only `hono` and a type-only
 *  db-interface import. No bun:sqlite, no node:fs, no hono/bun.
 *  WebCrypto (crypto.subtle, crypto.getRandomValues) is available on
 *  Workers, in browsers, and in Bun. */

import { Hono } from "hono";
import type { Db } from "./db-interface";

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
  agentToken: string;
}

export type Identity = "agent" | "user";

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

async function mintSession(kv: KVStore, username: string): Promise<string> {
  const token = randomHex(32);
  await kv.put(`sess:${token}`, JSON.stringify({ username }), { expirationTtl: SESSION_TTL_SECONDS });
  return token;
}

/** True when this IP has exhausted its login budget. Counts every login
 *  attempt (success or failure); the window is fixed at 10 minutes. */
export async function rateLimitHit(kv: KVStore, ip: string): Promise<boolean> {
  const key = `rl:${ip}`;
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
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "127.0.0.1"
  );
}

/** Identify the request: valid session cookie -> "user"; matching bearer
 *  token -> "agent"; otherwise null. The bearer compare is constant-time. */
export async function identifyRequest(c: any, config: AuthConfig): Promise<Identity | null> {
  const token = getSessionToken(c.req.header("Cookie") ?? null);
  if (token && (await config.kv.get(`sess:${token}`))) return "user";
  const authz: string = c.req.header("Authorization") ?? "";
  if (config.agentToken && authz.startsWith("Bearer ")) {
    const presented = new TextEncoder().encode(authz.slice(7));
    const expected = new TextEncoder().encode(config.agentToken);
    if (timingSafeEqual(presented, expected)) return "agent";
  }
  return null;
}

/** Hono middleware for /api/*: skips /api/auth/*, requires a session or the
 *  agent bearer token, and records the identity for entered_by derivation. */
export function authMiddleware(config: AuthConfig) {
  return async (c: any, next: () => Promise<void>) => {
    if (c.req.path.startsWith("/api/auth/")) return next();
    const identity = await identifyRequest(c, config);
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

  /** One-time setup: stores verifier = HMAC_SHA256(pepper, kdfKey). Only
   *  while the users table is empty; afterwards this permanently 404s. */
  app.post("/api/auth/setup", async (c) => {
    if (!config.pepper) return c.json({ error: "auth not configured" }, 500);
    const db = await getDb();
    if ((await userCount(db)) > 0) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => null);
    const username = validUsername(body?.username) ? body.username.trim() : "";
    const salt = typeof body?.salt === "string" && /^[0-9a-fA-F]{32}$/.test(body.salt) ? body.salt.toLowerCase() : "";
    const kdfKey = typeof body?.kdfKey === "string" && /^[0-9a-fA-F]{64}$/.test(body.kdfKey) ? body.kdfKey : "";
    if (!username || !salt || !kdfKey) return c.json({ error: "username, salt, and kdfKey required" }, 400);
    const verifier = bytesToHex(await computeVerifier(config.pepper, kdfKey));
    try {
      await db.run(
        "INSERT INTO users (username, salt, verifier, kdf_params, created_at) VALUES (?, ?, ?, ?, ?)",
        username,
        salt,
        verifier,
        DEFAULT_KDF_PARAMS,
        new Date().toISOString()
      );
    } catch {
      // Lost a setup race (username is UNIQUE): behave as if setup is done.
      return c.json({ error: "not found" }, 404);
    }
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
    const row = await db.get<{ verifier: string }>("SELECT verifier FROM users WHERE username = ?", username);
    const expected = row ? hexToBytes(row.verifier) : crypto.getRandomValues(new Uint8Array(32));
    const actual = await computeVerifier(config.pepper, kdfKey);
    if (!timingSafeEqual(actual, expected)) return c.json({ error: "wrong username or password" }, 401);
    const token = await mintSession(config.kv, username);
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

  /** Frontend gate: { authenticated, setupRequired }. */
  app.get("/api/auth/me", async (c) => {
    const token = getSessionToken(c.req.header("Cookie") ?? null);
    if (token && (await config.kv.get(`sess:${token}`))) {
      return c.json({ authenticated: true, setupRequired: false });
    }
    const db = await getDb();
    return c.json({ authenticated: false, setupRequired: (await userCount(db)) === 0 });
  });
}
