import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { wrapDb, migrateDb } from "../src/db";
import { createApp } from "../src/app";
import type { AuthConfig, KVStore } from "../src/auth";
import { listTransactions } from "../src/queries";

/** Corrections to older transactions: recategorize works on locked rows,
 *  voiding (DELETE or POST .../void) refuses reconciled and settlement rows,
 *  and POST .../unvoid restores a voided row. Fixture names are invented. */

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
  const json = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  let cookie = "";
  expect((await json("POST", "/api/auth/signup", { username: "u1", salt: SALT, kdfKey: KDF_KEY })).status).toBe(200);
  const lr = await json("POST", "/api/auth/login", { username: "u1", kdfKey: KDF_KEY });
  cookie = (lr.headers.get("set-cookie") ?? "").split(";")[0];
  const userId = ((await db.get("SELECT id FROM users WHERE username = 'u1'")) as any).id as number;
  await db.run("INSERT INTO accounts (user_id, name, type) VALUES (?, 'Chequing', 'chequing')", userId);
  const accountId = ((await db.get("SELECT id FROM accounts WHERE user_id = ?", userId)) as any).id as number;
  const mk = async (name: string) => {
    const r = await json("POST", "/api/pots", { name, group: "Food", targetType: "fixed" });
    expect(r.status).toBe(200);
    return (await r.json()).id as number;
  };
  const groceries = await mk("Groceries");
  const dining = await mk("Dining");
  const txn = async (cleared = "uncleared") => {
    const r = await json("POST", "/api/transactions", { date: "2026-09-10", accountId, potId: groceries, amountCents: -5000, description: "shop", cleared });
    expect(r.status).toBe(200);
    return (await r.json()).id as number;
  };
  return { app, db, json, userId, accountId, groceries, dining, txn };
}

describe("recategorize on locked transactions", () => {
  test("moves a reconciled transaction to another pot; PUT with a new pot is refused", async () => {
    const { db, json, userId, dining, txn, accountId } = await setup();
    const id = await txn("cleared");
    await db.run("UPDATE transactions SET cleared = 'reconciled' WHERE id = ?", id);

    const put = await json("PUT", `/api/transactions/${id}`, { date: "2026-09-10", accountId, potId: dining, amountCents: -5000, description: "shop" });
    expect(put.status).toBe(400);
    expect((await put.json()).error).toMatch("already reconciled");

    const r = await json("POST", `/api/transactions/${id}/recategorize`, { potId: dining });
    expect(r.status).toBe(200);
    const row = (await listTransactions(db, userId, "2026-09")).find((t) => t.id === id)!;
    expect(row.potId).toBe(dining);
    expect(row.cleared).toBe("reconciled");
    expect(row.amountCents).toBe(-5000);
    expect(row.settled).toBe(0);

    // Description and date still change through PUT when the money matches.
    const edit = await json("PUT", `/api/transactions/${id}`, { date: "2026-09-11", accountId, potId: dining, amountCents: -5000, description: "big shop" });
    expect(edit.status).toBe(200);
  });

  test("changing the account of a cleared transaction is refused", async () => {
    const { db, json, userId, groceries, txn } = await setup();
    const id = await txn("cleared");
    await db.run("INSERT INTO accounts (user_id, name, type) VALUES (?, 'Card', 'credit_card')", userId);
    const card = ((await db.get("SELECT id FROM accounts WHERE name = 'Card'")) as any).id;
    const r = await json("PUT", `/api/transactions/${id}`, { date: "2026-09-10", accountId: card, potId: groceries, amountCents: -5000, description: "shop" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch("already cleared");
  });
});

describe("void and unvoid", () => {
  test("void is blocked on reconciled rows, on both routes", async () => {
    const { db, json, txn } = await setup();
    const id = await txn("cleared");
    await db.run("UPDATE transactions SET cleared = 'reconciled' WHERE id = ?", id);
    for (const [method, path] of [["DELETE", `/api/transactions/${id}`], ["POST", `/api/transactions/${id}/void`]]) {
      const r = await json(method, path);
      expect(r.status).toBe(409);
      expect((await r.json()).error).toMatch("reconciled");
    }
    expect(((await db.get("SELECT voided FROM transactions WHERE id = ?", id)) as any).voided).toBe(0);
  });

  test("void is blocked on settlement-linked rows", async () => {
    const { db, json, userId, txn } = await setup();
    const id = await txn();
    await db.run("INSERT INTO settlements (user_id, transaction_id, date, amount_cents) VALUES (?, ?, '2026-09-27', 5000)", userId, id);
    const row = (await listTransactions(db, userId, "2026-09")).find((t) => t.id === id)!;
    expect(row.settled).toBe(1);
    const r = await json("DELETE", `/api/transactions/${id}`);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch("settlement");
    expect(((await db.get("SELECT voided FROM transactions WHERE id = ?", id)) as any).voided).toBe(0);
  });

  test("cleared rows can still be voided, and unvoid restores them", async () => {
    const { db, json, userId, txn } = await setup();
    const id = await txn("cleared");
    expect((await json("DELETE", `/api/transactions/${id}`)).status).toBe(200);
    expect((await listTransactions(db, userId, "2026-09")).some((t) => t.id === id)).toBe(false);

    const r = await json("POST", `/api/transactions/${id}/unvoid`);
    expect(r.status).toBe(200);
    const row = (await listTransactions(db, userId, "2026-09")).find((t) => t.id === id)!;
    expect(row.amountCents).toBe(-5000);
    expect(((await db.get("SELECT voided FROM transactions WHERE id = ?", id)) as any).voided).toBe(0);
  });

  test("unvoid refuses a row reconciled while voided, and unknown ids 404", async () => {
    const { db, json, txn } = await setup();
    const id = await txn("cleared");
    expect((await json("DELETE", `/api/transactions/${id}`)).status).toBe(200);
    await db.run("UPDATE transactions SET cleared = 'reconciled' WHERE id = ?", id);
    const r = await json("POST", `/api/transactions/${id}/unvoid`);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toMatch("cannot be restored");
    expect((await json("POST", "/api/transactions/9999/unvoid")).status).toBe(404);
  });
});
