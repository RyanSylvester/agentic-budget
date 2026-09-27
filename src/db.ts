import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations, tableExists } from "./migrations";

const here = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.BUDGET_DB ?? join(here, "..", "budget.db");

let db: Database | null = null;

/** Bring a database up to the current schema. Idempotent: schema.sql is a
 *  set of CREATE TABLE IF NOT EXISTS, and runMigrations records every
 *  applied version, so running it twice is a no-op. Exported so tests can
 *  run it against a scratch database.
 *
 *  Freshness is judged BEFORE schema.sql runs: a database that already has
 *  app tables was built by the pre-migration code and is marked at the
 *  '000' baseline (its history is not re-applied); a fresh database gets
 *  schema.sql and then every migration in order. */
export function migrateDb(fresh: Database): void {
  const preMigrationDb = tableExists(fresh, "pots");
  const schema = readFileSync(join(here, "schema.sql"), "utf8");
  fresh.exec(schema);
  runMigrations(fresh, { baseline: preMigrationDb });
}

/** Open (and migrate) the budget database. Single-writer: one user, one agent. */
export function openDb(path: string = DB_PATH): Database {
  if (db) return db;
  const fresh = new Database(path, { create: true });
  fresh.exec("PRAGMA journal_mode = WAL;");
  migrateDb(fresh);
  db = fresh;
  return db;
}

/** Read an app setting. Returns null when unset. */
export function getSetting(db: Database, key: string): string | null {
  const r = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  return r?.value ?? null;
}
