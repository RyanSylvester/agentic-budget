import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateDb } from "../src/db";
import { listMigrations, runMigrations } from "../src/migrations";
import { oldMigrateDb } from "./old-migrate";

const schemaSql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "schema.sql"), "utf8");

function versions(db: Database): string[] {
  return (db.query("SELECT version FROM schema_migrations ORDER BY version").all() as { version: string }[]).map(
    (r) => r.version
  );
}

/** A scratch database built through the OLD code path (schema.sql + the
 *  ad-hoc ALTER chain), with real data: the closest stand-in for the live
 *  budget.db at the moment the migration system ships. */
function oldPathDb(): Database {
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
  return db;
}

describe("versioned migrations", () => {
  test("listMigrations returns versions sorted and unique", () => {
    const ms = listMigrations();
    expect(ms.length).toBeGreaterThan(0);
    const vs = ms.map((m) => m.version);
    expect([...vs].sort()).toEqual(vs);
    expect(new Set(vs).size).toBe(vs.length);
    expect(vs[0]).toBe("001");
  });

  test("fresh databases get schema.sql plus every migration, no baseline marker", () => {
    const db = new Database(":memory:");
    migrateDb(db);
    expect(versions(db)).toEqual(listMigrations().map((m) => m.version));
    expect(versions(db)).not.toContain("000");
    const t = db.query("SELECT name FROM sqlite_master WHERE name = 'sinking_schedules'").get();
    expect(t).not.toBeNull();
    const cols = (db.query("PRAGMA table_info(pots)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("is_assignable");
  });

  test("pre-migration databases are baselined without re-applying history", () => {
    const db = oldPathDb();
    migrateDb(db);

    // baseline marker recorded, then the real migrations applied on top
    const vs = versions(db);
    expect(vs[0]).toBe("000");
    expect(vs.slice(1)).toEqual(listMigrations().map((m) => m.version));

    // the new tables arrived via migration, not the old chain
    const t = db.query("SELECT name FROM sqlite_master WHERE name = 'sinking_schedules'").get();
    expect(t).not.toBeNull();

    // not a byte of user data lost
    expect(db.query("SELECT COUNT(*) AS n FROM pots").get()).toEqual({ n: 2 });
    expect(db.query("SELECT COUNT(*) AS n FROM contacts").get()).toEqual({ n: 1 });
    expect(db.query("SELECT cents FROM assignments WHERE month = '2026-09' AND pot_id = 2").get()).toEqual({
      cents: 29901,
    });
    const total = db.query("SELECT SUM(amount_cents) AS s FROM splits").get() as { s: number };
    expect(total.s).toBe(-172000);
  });

  test("migrateDb is idempotent on fresh and baselined databases", () => {
    const freshDb = new Database(":memory:");
    migrateDb(freshDb);
    migrateDb(freshDb);
    expect(versions(freshDb)).toEqual(listMigrations().map((m) => m.version));

    const oldDb = oldPathDb();
    migrateDb(oldDb);
    const once = versions(oldDb);
    const countsBefore = dbCounts(oldDb);
    migrateDb(oldDb);
    expect(versions(oldDb)).toEqual(once);
    expect(dbCounts(oldDb)).toEqual(countsBefore);
  });

  test("runMigrations applies pending migrations in order to a partially migrated db", () => {
    const db = new Database(":memory:");
    db.exec(schemaSql);
    // simulate a db that recorded 001 by hand long ago (versions table exists, nothing else new)
    runMigrations(db);
    expect(versions(db)).toEqual(["001"]);
    // a later run picks up nothing new and changes nothing
    runMigrations(db);
    expect(versions(db)).toEqual(["001"]);
  });
});

/** Row counts of the user-data tables, for the idempotency comparison. */
function dbCounts(db: Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of ["pots", "contacts", "assignments", "transactions", "splits", "sinking_schedules"]) {
    out[t] = (db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  }
  return out;
}
