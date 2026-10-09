import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { wrapDb, migrateDb } from "../src/db";
import { createApp } from "../src/app";
import type { AuthConfig, KVStore } from "../src/auth";
import { createContact } from "../src/contacts";
import { applySettlement } from "../src/settle";

/** /api/attention must report per-contact NET owed (gross minus credit),
 *  not gross where the banner reads it as owed. Partial-credit scenario:
 *  contact settles 130000 against 100000 owed (30000 credit), then owes
 *  100000 more. The banner line must read the net 70000. */

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

function jsonCall(app: Hono, method: string, path: string, opts?: { body?: unknown; cookie?: string }) {
  return call(app, method, path, {
    ...opts,
    headers: { "Content-Type": "application/json" },
  });
}

async function setup() {
  const kv = new MapKV();
  const db = wrapDb(new Database(":memory:"));
  await migrateDb(db);
  const config: AuthConfig = { kv, pepper: "test-pepper" };
  const app = createApp(async () => db, { auth: config });

  const signup = await jsonCall(app, "POST", "/api/auth/signup", {
    body: { username: "riley", salt: SALT, kdfKey: KDF_KEY },
  });
  expect(signup.status).toBe(200);
  const login = await jsonCall(app, "POST", "/api/auth/login", {
    body: { username: "riley", kdfKey: KDF_KEY },
  });
  expect(login.status).toBe(200);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  await db.run("INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing', 'chequing')");
  await db.run("INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES (1, 'Groceries', 'essentials', 'fixed', 50000)");
  const contactId = await createContact(db, 1, "Riley");
  return { app, db, cookie, contactId };
}

async function spendSplit(db: Awaited<ReturnType<typeof setup>>["db"], contactId: number, date: string) {
  await db.run(
    "INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, cleared) VALUES (1, ?, 1, -200000, 'shared groceries', 'manual', 'agent', 'cleared')",
    date
  );
  const t = (await db.get<{ id: number }>("SELECT id FROM transactions ORDER BY id DESC LIMIT 1"))!;
  await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (1, ?, 1, 'user', NULL, -100000)", t.id);
  await db.run("INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (1, ?, 1, 'contact', ?, -100000)", t.id, contactId);
}

describe("attention", () => {
  test("sharedOwedBy carries per-contact net (gross minus credit)", async () => {
    const { app, db, cookie, contactId } = await setup();

    await spendSplit(db, contactId, "2026-09-01"); // Riley owes 100000
    const s = await applySettlement(db, 1, { contactId, accountId: 1, amountCents: 130000 });
    expect(s.leftoverCents).toBe(30000); // 30000 credit
    await spendSplit(db, contactId, "2026-09-10"); // Riley owes 100000 more

    const r = await call(app, "GET", "/api/attention?month=2026-09", { cookie });
    expect(r.status).toBe(200);
    const attention = (await r.json()) as any;

    expect(attention.unsettledSharedCents).toBe(70000);
    expect(attention.sharedOwedBy).toHaveLength(1);
    expect(attention.sharedOwedBy[0].name).toBe("Riley");
    expect(attention.sharedOwedBy[0].cents).toBe(100000); // gross kept for compatibility
    expect(attention.sharedOwedBy[0].netCents).toBe(70000); // net is what the banner reads
  });
});
