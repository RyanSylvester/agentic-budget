import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { wrapDb, migrateDb } from "../src/db";
import type { Db } from "../src/db-interface";
import { createApp } from "../src/app";
import type { AuthConfig, KVStore } from "../src/auth";

/** Cross-user isolation at the HTTP layer: two authenticated users share one
 *  database; every route must behave as if the other user does not exist.
 *  Reads must not surface the other user's rows; writes against the other
 *  user's ids must fail and leave their rows untouched. */

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

function jsonCall(
  app: Hono,
  method: string,
  path: string,
  opts?: { body?: unknown; cookie?: string; headers?: Record<string, string> }
) {
  return call(app, method, path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
  });
}

function sessionCookie(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function signup(app: Hono, username: string, inviteCode?: string): Promise<void> {
  const r = await jsonCall(app, "POST", "/api/auth/signup", {
    body: { username, salt: SALT, kdfKey: KDF_KEY, ...(inviteCode ? { inviteCode } : {}) },
  });
  expect(r.status).toBe(200);
}

async function login(app: Hono, username: string): Promise<string> {
  const r = await jsonCall(app, "POST", "/api/auth/login", {
    body: { username, kdfKey: KDF_KEY },
  });
  expect(r.status).toBe(200);
  return sessionCookie(r);
}

/** POST and return the created id, asserting success. */
async function postId(app: Hono, cookie: string, path: string, body: unknown): Promise<number> {
  const r = await jsonCall(app, "POST", path, { cookie, body });
  expect(r.status).toBe(200);
  const j = (await r.json()) as any;
  expect(j.ok).toBe(true);
  return j.id as number;
}

async function setupTwoUsers() {
  const kv = new MapKV();
  const db = wrapDb(new Database(":memory:"));
  await migrateDb(db);
  const config: AuthConfig = { kv, pepper: "test-pepper" };
  const app = createApp(async () => db, { auth: config });

  await signup(app, "alice"); // first user: no invite code needed (id 1)
  const cookieA = await login(app, "alice");

  const invite = (await (await jsonCall(app, "POST", "/api/auth/invite-codes", { cookie: cookieA })).json()) as any;
  await signup(app, "bob", invite.code as string); // id 2
  const cookieB = await login(app, "bob");

  // No account-creation route exists; accounts are test setup, not app code.
  await db.run("INSERT INTO accounts (user_id, name, type) VALUES (1, 'A Chequing', 'chequing')");
  await db.run("INSERT INTO accounts (user_id, name, type) VALUES (2, 'B Chequing', 'chequing')");

  const potA = await postId(app, cookieA, "/api/pots", { name: "Alice Pot", pot_group: "Test", target_type: "fixed" });
  const contactA = await postId(app, cookieA, "/api/contacts", { name: "Alice Contact" });
  const txnA = await postId(app, cookieA, "/api/transactions", {
    date: "2026-09-05", accountId: 1, potId: potA, amountCents: -5000, description: "alice spend",
  });
  const schedARes = await jsonCall(app, "POST", "/api/sinking", {
    cookie: cookieA, body: { potId: potA, expectedCents: 120000, dueMonth: "2026-12" },
  });
  expect(schedARes.status).toBe(200);
  const schedA = ((await schedARes.json()) as any).id as number;

  const potB = await postId(app, cookieB, "/api/pots", { name: "Bob Pot", pot_group: "Test", target_type: "fixed" });
  const contactB = await postId(app, cookieB, "/api/contacts", { name: "Bob Contact" });
  const txnB = await postId(app, cookieB, "/api/transactions", {
    date: "2026-09-06", accountId: 2, potId: potB, amountCents: -7000, description: "bob spend",
  });
  const schedB = await postId(app, cookieB, "/api/sinking", { potId: potB, expectedCents: 60000, dueMonth: "2026-11" });

  // Assignments via the app so they carry the right user_id.
  for (const [cookie, potId, cents] of [[cookieA, potA, 10000], [cookieB, potB, 20000]] as const) {
    const r = await jsonCall(app, "POST", "/api/assign", { cookie, body: { month: "2026-09", potId, cents } });
    expect(r.status).toBe(200);
  }

  return { app, db, cookieA, cookieB, potA, potB, contactA, contactB, txnA, txnB, schedA, schedB };
}

describe("cross-user isolation", () => {
  test("reads never surface the other user's data", async () => {
    const { app, cookieA, potA, potB } = await setupTwoUsers();

    const overview = (await (await call(app, "GET", "/api/overview?month=2026-09", { cookie: cookieA })).json()) as any;
    expect(overview.confirmedSpendCents).toBe(5000);
    expect(overview.recent.map((t: any) => t.description)).toEqual(["alice spend"]);

    const txns = (await (await call(app, "GET", "/api/transactions?month=2026-09", { cookie: cookieA })).json()) as any;
    expect(txns.transactions.map((t: any) => t.description)).toEqual(["alice spend"]);

    const pots = (await (await call(app, "GET", "/api/pots", { cookie: cookieA })).json()) as any;
    const potNames = pots.pots.map((p: any) => p.name);
    expect(potNames).toContain("Alice Pot");
    expect(potNames).not.toContain("Bob Pot");

    const contacts = (await (await call(app, "GET", "/api/contacts", { cookie: cookieA })).json()) as any;
    expect(contacts.contacts.map((c: any) => c.name)).toEqual(["Alice Contact"]);

    const accounts = (await (await call(app, "GET", "/api/accounts", { cookie: cookieA })).json()) as any;
    expect(accounts.accounts.map((a: any) => a.name)).toEqual(["A Chequing"]);

    const trend = (await (await call(app, "GET", "/api/trend", { cookie: cookieA })).json()) as any;
    expect(trend.trend.find((e: any) => e.month === "2026-09")?.spent).toBe(5000);

    const preview = (await (await call(app, "GET", "/api/close-preview?month=2026-09", { cookie: cookieA })).json()) as any;
    expect(preview.assignedCents).toBe(10000);
    expect(preview.spentCents).toBe(5000);

    const attention = (await (await call(app, "GET", "/api/attention?month=2026-09", { cookie: cookieA })).json()) as any;
    expect(attention.sharedOwedBy).toEqual([]);

    const sinking = (await (await call(app, "GET", "/api/sinking?month=2026-09", { cookie: cookieA })).json()) as any;
    expect(sinking.schedules.map((s: any) => s.potName)).toEqual(["Alice Pot"]);

    // Alice's own pot history works; Bob's pot is invisible to her.
    expect((await call(app, "GET", `/api/pot-history?potId=${potA}&months=3`, { cookie: cookieA })).status).toBe(200);
    expect((await call(app, "GET", `/api/pot-history?potId=${potB}&months=3`, { cookie: cookieA })).status).toBe(404);
  });

  test("writes against the other user's ids fail and change nothing", async () => {
    const { app, db, cookieA, potB, contactB, txnB, schedB } = await setupTwoUsers();

    const attempt = (method: string, path: string, body?: unknown) => jsonCall(app, method, path, { cookie: cookieA, body });

    expect((await attempt("POST", `/api/transactions/${txnB}/recategorize`, { potId: 1 })).status).toBe(404);
    expect((await attempt("POST", `/api/transactions/${txnB}/void`)).status).toBe(404);
    expect((await attempt("PUT", `/api/transactions/${txnB}`, { description: "hacked" })).status).toBe(404);
    expect((await attempt("DELETE", `/api/transactions/${txnB}`)).status).toBe(404);
    expect((await attempt("POST", `/api/transactions/${txnB}/unvoid`)).status).toBe(404);
    expect((await attempt("PUT", `/api/pots/${potB}`, { name: "Hacked" })).status).toBe(404);
    expect((await attempt("DELETE", `/api/pots/${potB}`)).status).toBe(404);
    expect((await attempt("PUT", `/api/contacts/${contactB}`, { name: "Hacked" })).status).toBe(404);
    expect((await attempt("DELETE", `/api/contacts/${contactB}`)).status).toBe(404);
    expect((await attempt("POST", "/api/assign", { month: "2026-09", potId: potB, cents: 1 })).status).toBe(400);
    expect((await attempt("POST", "/api/sinking", { potId: potB, expectedCents: 1, dueMonth: "2026-12" })).status).toBe(400);
    expect((await attempt("POST", `/api/sinking/${schedB}/paid`)).status).toBe(404);
    expect((await attempt("DELETE", `/api/sinking/${schedB}`)).status).toBe(404);
    expect((await attempt("POST", "/api/accounts/2/reconcile", { actualBalanceCents: 0 })).status).toBe(404);
    expect((await attempt("POST", "/api/settle", { contactId: contactB, accountId: 1, amountCents: 1000 })).status).toBe(404);
    expect((await attempt("POST", "/api/settle", { contactId: 1, accountId: 2, amountCents: 1000 })).status).toBe(404);

    // Clear returns ok (no existence check) but must not touch Bob's row.
    expect((await attempt("POST", `/api/transactions/${txnB}/clear`)).status).toBe(200);

    // Scaffold dry-run must only propose Alice's pots.
    const scaf = (await (await attempt("POST", "/api/assign/scaffold", {
      month: "2026-10", strategy: "last_month", dryRun: true,
    })).json()) as any;
    expect(scaf.ok).toBe(true);
    expect(scaf.lines.length).toBeGreaterThan(0);
    expect(scaf.lines.every((l: any) => l.potId !== potB)).toBe(true);

    // Alice closes an empty month: only her user gets a month_closes row.
    expect((await attempt("POST", "/api/close", { month: "2026-08" })).status).toBe(200);

    // Nothing of Bob's changed.
    expect(((await db.get("SELECT name AS n FROM pots WHERE id = ?", potB)) as any).n).toBe("Bob Pot");
    expect(((await db.get("SELECT name AS n FROM contacts WHERE id = ?", contactB)) as any).n).toBe("Bob Contact");
    expect(((await db.get("SELECT description AS d, voided AS v, cleared AS c FROM transactions WHERE id = ?", txnB)) as any)).toEqual({
      d: "bob spend", v: 0, c: "uncleared",
    });
    expect(await db.get("SELECT 1 AS x FROM sinking_schedules WHERE id = ?", schedB)).toBeTruthy();
    expect(await db.get("SELECT 1 AS x FROM assignments WHERE pot_id = ? AND month = '2026-09' AND cents = 1", potB)).toBeNull();
    expect(await db.get("SELECT 1 AS x FROM reconciliations WHERE account_id = 2")).toBeNull();
    expect(await db.get("SELECT 1 AS x FROM month_closes WHERE user_id = 2")).toBeNull();
    expect((await db.get("SELECT COUNT(*) AS n FROM month_closes WHERE user_id = 1") as any).n).toBe(1);
  });
});
