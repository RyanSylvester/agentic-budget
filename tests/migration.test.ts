import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateDb, wrapDb } from "../src/db";
import type { Db } from "../src/db-interface";
import { createMigration, listMigrations, runMigrations } from "../src/migrations";
import { oldMigrateDb } from "./old-migrate";

const schemaSql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "schema.sql"), "utf8");

async function versions(db: Db): Promise<string[]> {
  return (await db.all<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version")).map(
    (r) => r.version
  );
}

/** A scratch database built through the OLD code path (schema.sql + the
 *  ad-hoc ALTER chain), with real data: the closest stand-in for the live
 *  budget.db at the moment the migration system ships. Built on the raw
 *  handle (oldMigrateDb is preserved verbatim), then wrapped in the Db
 *  interface for the new migrateDb. */
function oldPathDb(): Db {
  const db = new Database(":memory:");
  oldMigrateDb(db, schemaSql);
  db.exec(`INSERT INTO accounts (name, type) VALUES ('Chequing','chequing')`);
  db.exec(`INSERT INTO contacts (name) VALUES ('Alex')`);
  db.exec(`INSERT INTO pots (name, pot_group, target_type, target_cents) VALUES ('Housing','essentials','fixed',172000)`);
  db.exec(`INSERT INTO pots (name, pot_group, target_type, target_cents) VALUES ('Property tax','Housing','savings',0)`);
  db.query("INSERT INTO assignments (month, pot_id, cents) VALUES ('2026-09', 2, 29901)").run();
  db.query(
    "INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared) VALUES ('2026-09-01', 1, -172000, 'rent', 'manual', 'agent', 'confirmed', 'cleared')"
  ).run();
  const t = (db.query("SELECT id FROM transactions").get() as { id: number }).id;
  db.query("INSERT INTO splits (transaction_id, pot_id, owner, amount_cents) VALUES (?, 1, 'user', -172000)").run(t);
  return wrapDb(db);
}

describe("versioned migrations", () => {
  test("listMigrations returns versions sorted and unique", () => {
    const ms = listMigrations();
    expect(ms.length).toBeGreaterThan(0);
    const vs = ms.map((m) => m.version);
    expect([...vs].sort()).toEqual(vs);
    expect(new Set(vs).size).toBe(vs.length);
    expect(vs[0]).toMatch(/^\d{14}$/);
  });

  test("fresh databases get schema.sql plus every migration, no baseline marker", async () => {
    const db = wrapDb(new Database(":memory:"));
    await migrateDb(db);
    expect(await versions(db)).toEqual(listMigrations().map((m) => m.version));
    expect(await versions(db)).not.toContain("000");
    const t = await db.get("SELECT name FROM sqlite_master WHERE name = 'sinking_schedules'");
    expect(t).not.toBeNull();
    const cols = (await db.all<{ name: string }>("PRAGMA table_info(pots)")).map((c) => c.name);
    expect(cols).toContain("is_assignable");
  });

  test("pre-migration databases are baselined without re-applying history", async () => {
    const db = oldPathDb();
    await migrateOldDb(db);

    // baseline marker recorded, then the real migrations applied on top
    const vs = await versions(db);
    expect(vs[0]).toBe("000");
    expect(vs.slice(1)).toEqual(listMigrations().map((m) => m.version));

    // the new tables arrived via migration, not the old chain
    const t = await db.get("SELECT name FROM sqlite_master WHERE name = 'sinking_schedules'");
    expect(t).not.toBeNull();
    expect(await db.get("SELECT name FROM sqlite_master WHERE name = 'invite_codes'")).not.toBeNull();
    expect(await db.get("SELECT name FROM sqlite_master WHERE name = 'agent_tokens'")).not.toBeNull();

    // not a byte of user data lost
    expect(await db.get("SELECT COUNT(*) AS n FROM pots")).toEqual({ n: 2 });
    expect(await db.get("SELECT COUNT(*) AS n FROM contacts")).toEqual({ n: 1 });
    expect(await db.get("SELECT cents FROM assignments WHERE month = '2026-09' AND pot_id = 2")).toEqual({
      cents: 29901,
    });
    const total = (await db.get<{ s: number }>("SELECT SUM(amount_cents) AS s FROM splits"))!;
    expect(total.s).toBe(-172000);

    // every row backfilled to the first user; the new tables exist
    for (const tbl of [
      "accounts", "pots", "contacts", "transactions", "splits",
      "assignments", "month_closes", "reconciliations", "settlements",
      "settlement_allocations", "sinking_schedules", "settings",
    ]) {
      const bad = await db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${tbl} WHERE user_id IS NULL OR user_id != 1`
      );
      expect(bad).toEqual({ n: 0 });
    }
    expect(await db.get<{ role: string }>("SELECT role FROM users WHERE id = 1")).toEqual({ role: "user" });
  });

  test("migrateDb is idempotent on fresh and baselined databases", async () => {
    const freshDb = wrapDb(new Database(":memory:"));
    await migrateDb(freshDb);
    await migrateDb(freshDb);
    expect(await versions(freshDb)).toEqual(listMigrations().map((m) => m.version));

    const oldDb = oldPathDb();
    await migrateOldDb(oldDb);
    const once = await versions(oldDb);
    const countsBefore = await dbCounts(oldDb);
    await migrateDb(oldDb);
    expect(await versions(oldDb)).toEqual(once);
    expect(await dbCounts(oldDb)).toEqual(countsBefore);
  });

  test("runMigrations applies pending migrations in order to a partially migrated db", async () => {
    const db = wrapDb(new Database(":memory:"));
    await db.exec(schemaSql);
    // simulate a db that recorded the known versions by hand long ago (versions table exists, nothing else new)
    await runMigrations(db);
    expect(await versions(db)).toEqual(listMigrations().map((m) => m.version));
    // a later run picks up nothing new and changes nothing
    await runMigrations(db);
    expect(await versions(db)).toEqual(listMigrations().map((m) => m.version));
  });

  test("createMigration stamps the version from the clock; it is never hand-typed", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    const p = createMigration("Add Water Bill", dir);
    expect(p).toMatch(/\d{14}_add_water_bill\.sql$/);
    expect(readFileSync(p, "utf8")).toMatch(/^-- \d{14}: add water bill\n/);
    expect(() => createMigration("!!!", dir)).toThrow();
  });

  test("listMigrations reads timestamped files in chronological order", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    writeFileSync(join(dir, "20260927120000_b.sql"), "SELECT 1;");
    writeFileSync(join(dir, "20260927090000_a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "not-a-migration.sql"), "SELECT 1;");
    expect(listMigrations(dir).map((m) => m.version)).toEqual(["20260927090000", "20260927120000"]);
  });

  test("remove_review_queue converts parked rows and drops the review columns", async () => {
    const target = listMigrations().find((m) => m.name === "remove review queue")!;
    // Stage a database at the migration just before the new one.
    const db = wrapDb(new Database(":memory:"));
    await db.exec(schemaSql);
    await db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`
    );
    for (const m of listMigrations()) {
      if (m.version >= target.version) break;
      await db.exec(m.sql);
      await db.run("INSERT INTO schema_migrations (version) VALUES (?)", m.version);
    }
    await db.run("INSERT INTO users (username, salt, verifier, kdf_params) VALUES ('test', 'x', 'x', 'm=19456,t=2,p=1')");
    await db.run("INSERT INTO accounts (user_id, name, type) VALUES (1, 'Chequing', 'chequing')");
    await db.run(
      `INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, status, cleared, review_reason)
       VALUES (1, '2026-09-01', 1, -5000, 'mystery charge', 'manual', 'agent', 'pending_review', 'uncleared', 'unsure which pot')`
    );
    const before = (await db.all<{ name: string }>("PRAGMA table_info(transactions)")).map((c) => c.name);
    expect(before).toContain("status");
    expect(before).toContain("review_reason");

    // The real runner picks up only the new migration.
    await runMigrations(db);
    expect(await versions(db)).toContain(target.version);

    const after = (await db.all<{ name: string }>("PRAGMA table_info(transactions)")).map((c) => c.name);
    expect(after).not.toContain("status");
    expect(after).not.toContain("review_reason");
    // The parked row survived the rebuild, converted to confirmed.
    const t = (await db.get<any>("SELECT * FROM transactions"))!;
    expect(t.description).toBe("mystery charge");
    expect(t.amount_cents).toBe(-5000);
    expect(t.entered_by).toBe("agent");
    // The per-user external-id uniqueness survived the rebuild.
    const idx = (await db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'"))!;
    expect(idx.sql).toContain("UNIQUE (user_id, external_id)");
  });
});

/** The M1 version (multi-user backfill), found by name so the test does not
 *  depend on it being the latest migration. */
function m1Version(): string {
  return listMigrations().find((m) => m.name === "multi user")!.version;
}

/** A pre-migration database can only finish migrating once a user exists:
 *  the first attempt fails the M1 backfill guard with a clear error, the
 *  operator creates the user, the retry backfills every row to them. */
async function migrateOldDb(db: Db): Promise<void> {
  await expect(migrateDb(db)).rejects.toThrow("budget user create");
  expect(await versions(db)).toContain("20260928023841"); // add_users ran before the guard
  expect(await versions(db)).not.toContain(m1Version()); // M1 did not
  await db.run(
    "INSERT INTO users (username, salt, verifier, kdf_params) VALUES ('test', 'x', 'x', 'm=19456,t=2,p=1')"
  );
  await migrateDb(db);
}

/** Row counts of the user-data tables, for the idempotency comparison. */
async function dbCounts(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of ["pots", "contacts", "assignments", "transactions", "splits", "sinking_schedules"]) {
    out[t] = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`))!.n;
  }
  return out;
}
