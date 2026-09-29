import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { wrapDb, migrateDb } from "../src/db";
import type { Db } from "../src/db-interface";
import { clearTableExistsCache } from "../src/db-interface";
import { runMigrations, listMigrations } from "../src/migrations";
import { createPot, updatePot, deletePot, setGroupOrder } from "../src/pots";
import { createApp } from "../src/app";
import type { AuthConfig, KVStore } from "../src/auth";

/** Group ordering lives in the group_order table as user data: nothing
 *  about groups or their order is hardcoded. Groups emerge from pot_group
 *  labels; the table only positions whatever exists. Fixture group names
 *  below are invented. */

const here = dirname(fileURLToPath(import.meta.url));
const GROUP_ORDER_VERSION = "20260928044111";

async function seedUser(db: Db, id = 1): Promise<void> {
  await db.run("INSERT INTO users (username, salt, verifier, kdf_params) VALUES ('test', 'x', 'x', 'm=19456,t=2,p=1')");
}

/** A database at the pre-group-order schema: every migration applied
 *  except the group_order one, so the backfill path can be tested. */
async function preGroupOrderDb(): Promise<Db> {
  clearTableExistsCache(); // this database has no group_order table yet
  const db = wrapDb(new Database(":memory:"));
  await db.exec(readFileSync(join(here, "..", "src", "schema.sql"), "utf8"));
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  for (const m of listMigrations()) {
    if (m.version === GROUP_ORDER_VERSION) continue;
    await db.exec(m.sql);
    await db.run("INSERT INTO schema_migrations (version) VALUES (?)", m.version);
  }
  await seedUser(db);
  return db;
}

async function orderRows(db: Db, userId = 1): Promise<[string, number][]> {
  const rows = await db.all<{ group_name: string; position: number }>(
    "SELECT group_name, position FROM group_order WHERE user_id = ? ORDER BY position",
    userId
  );
  return rows.map((r) => [r.group_name, r.position]);
}

describe("group_order migration backfill", () => {
  test("positions follow each group's first pot appearance", async () => {
    const db = await preGroupOrderDb();
    // Creation order: Zebra, Quilt, Zebra again, Juniper.
    await createPot(db, 1, { name: "P1", group: "Zebra" });
    await createPot(db, 1, { name: "P2", group: "Quilt" });
    await createPot(db, 1, { name: "P3", group: "Zebra" });
    await createPot(db, 1, { name: "P4", group: "Juniper" });
    await runMigrations(db); // applies only the group_order migration
    expect(await orderRows(db)).toEqual([
      ["Zebra", 1],
      ["Quilt", 2],
      ["Juniper", 4],
    ]);
  });

  test("backfill is per-user", async () => {
    const db = await preGroupOrderDb();
    await db.run("INSERT INTO users (username, salt, verifier, kdf_params) VALUES ('test2', 'x', 'x', 'm=19456,t=2,p=1')");
    await createPot(db, 1, { name: "P1", group: "Zebra" });
    await createPot(db, 2, { name: "P2", group: "Quilt" });
    await runMigrations(db);
    expect(await orderRows(db, 1)).toEqual([["Zebra", 1]]);
    expect(await orderRows(db, 2)).toEqual([["Quilt", 2]]);
  });
});

describe("setGroupOrder", () => {
  async function dbWithGroups(): Promise<Db> {
    const db = wrapDb(new Database(":memory:"));
    await migrateDb(db);
    await seedUser(db);
    await createPot(db, 1, { name: "P1", group: "Zebra" });
    await createPot(db, 1, { name: "P2", group: "Quilt" });
    await createPot(db, 1, { name: "P3", group: "Juniper" });
    return db;
  }

  test("reorders and normalizes positions", async () => {
    const db = await dbWithGroups();
    const order = await setGroupOrder(db, 1, ["Juniper", "Zebra", "Quilt"]);
    expect(order).toEqual(["Juniper", "Zebra", "Quilt"]);
    expect(await orderRows(db)).toEqual([
      ["Juniper", 0],
      ["Zebra", 1],
      ["Quilt", 2],
    ]);
  });

  test("unlisted groups keep relative order after the listed ones", async () => {
    const db = await dbWithGroups();
    const order = await setGroupOrder(db, 1, ["Quilt"]);
    expect(order).toEqual(["Quilt", "Zebra", "Juniper"]);
  });

  test("dedupes repeated names", async () => {
    const db = await dbWithGroups();
    expect(await setGroupOrder(db, 1, ["Quilt", "Quilt", "Zebra"])).toEqual(["Quilt", "Zebra", "Juniper"]);
  });

  test("rejects unknown, blank, and empty input", async () => {
    const db = await dbWithGroups();
    await expect(setGroupOrder(db, 1, ["Nope"])).rejects.toThrow('unknown group "Nope"');
    await expect(setGroupOrder(db, 1, ["  "])).rejects.toThrow("must not be blank");
    await expect(setGroupOrder(db, 1, [])).rejects.toThrow("at least one group name");
    await expect(setGroupOrder(db, 1, "Quilt" as any)).rejects.toThrow("must be an array");
  });

  test("a new group from createPot goes last", async () => {
    const db = await dbWithGroups();
    await setGroupOrder(db, 1, ["Juniper", "Zebra", "Quilt"]);
    await createPot(db, 1, { name: "P4", group: "Wobble" });
    expect(await orderRows(db)).toEqual([
      ["Juniper", 0],
      ["Zebra", 1],
      ["Quilt", 2],
      ["Wobble", 3],
    ]);
  });

  test("moving the last pot out of a group prunes it and appends the new one", async () => {
    const db = await dbWithGroups();
    const p1 = (await db.get<{ id: number }>("SELECT id FROM pots WHERE name = 'P1'"))!.id;
    await updatePot(db, 1, p1, { group: "Wobble" });
    expect(await orderRows(db)).toEqual([
      ["Quilt", 1],
      ["Juniper", 2],
      ["Wobble", 3],
    ]);
  });

  test("deleting the last pot of a group prunes it without conjuring a General group", async () => {
    const db = await dbWithGroups();
    const p2 = (await db.get<{ id: number }>("SELECT id FROM pots WHERE name = 'P2'"))!.id;
    await deletePot(db, 1, p2);
    // Quilt is gone, and the on-demand Uncategorized pot landed in an
    // existing group instead of inventing a "General" one.
    expect((await orderRows(db)).map(([g]) => g).sort()).toEqual(["Juniper", "Zebra"]);
  });
});

describe("PUT /api/groups/order", () => {
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
    for (const [name, group] of [["P1", "Zebra"], ["P2", "Quilt"], ["P3", "Juniper"]] as const) {
      const r = await json("POST", "/api/pots", { name, group, targetType: "fixed" }, cookie);
      expect(r.status).toBe(200);
    }
    return { app, json, cookie };
  }

  async function potGroups(app: Hono, json: any, cookie: string): Promise<string[]> {
    const r = await json("GET", "/api/pots", undefined, cookie);
    expect(r.status).toBe(200);
    const seen: string[] = [];
    for (const p of (await r.json()).pots as { group: string }[]) {
      if (!seen.includes(p.group)) seen.push(p.group);
    }
    return seen;
  }

  test("reorders the groups returned by GET /api/pots", async () => {
    const { app, json, cookie } = await setup();
    expect(await potGroups(app, json, cookie)).toEqual(["General", "Zebra", "Quilt", "Juniper"]);
    const r = await json("PUT", "/api/groups/order", { groups: ["Juniper", "Zebra", "Quilt", "General"] }, cookie);
    expect(r.status).toBe(200);
    expect((await r.json()).groups).toEqual(["Juniper", "Zebra", "Quilt", "General"]);
    expect(await potGroups(app, json, cookie)).toEqual(["Juniper", "Zebra", "Quilt", "General"]);
  });

  test("rejects malformed bodies", async () => {
    const { json, cookie } = await setup();
    for (const body of [{}, { groups: [] }, { groups: ["Nope"] }, { groups: "Zebra" }]) {
      const r = await json("PUT", "/api/groups/order", body, cookie);
      expect(r.status).toBe(400);
    }
  });

  test("requires auth", async () => {
    const { json } = await setup();
    const r = await json("PUT", "/api/groups/order", { groups: ["Zebra"] });
    expect(r.status).toBe(401);
  });
});
