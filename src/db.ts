import { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { Db, DbValue, RunResult, BatchStatement, BatchResult } from "./db-interface";
import { tableExists, clearTableExistsCache } from "./db-interface";
import { runMigrations } from "./migrations";

const here = dirname(fileURLToPath(import.meta.url));
// Private local data lives outside the repo worktree so repo-wide file
// operations (commits, uploads, sweeps) can never touch it. Falls back to
// the legacy repo-local path for existing checkouts.
const configDb = join(homedir(), ".config", "agentic-budget", "budget.db");
const legacyDb = join(here, "..", "budget.db");
export const DB_PATH =
  process.env.BUDGET_DB ?? (existsSync(configDb) ? configDb : legacyDb);

/** The Bun adapter: the Db interface on top of bun:sqlite. Serves the
 *  `budget` CLI, local `bun src/server.ts`, and the test suite (in-memory). */
export class BunDb implements Db {
  constructor(private raw: Database) {}

  async get<T = any>(sql: string, ...params: DbValue[]): Promise<T | null> {
    const row = this.raw.query(sql).get(...params) as T | null | undefined;
    return row ?? null;
  }

  async all<T = any>(sql: string, ...params: DbValue[]): Promise<T[]> {
    return this.raw.query(sql).all(...params) as T[];
  }

  async run(sql: string, ...params: DbValue[]): Promise<RunResult> {
    const r = this.raw.query(sql).run(...params);
    return { changes: Number(r.changes), lastRowId: Number(r.lastInsertRowid) };
  }

  async exec(sql: string): Promise<void> {
    // Multi-statement schema/migration replay must be atomic on the Bun path
    // too (D1 is atomic per the Phase 1 spike). No caller passes its own
    // BEGIN/COMMIT, so wrapping unconditionally is safe.
    this.raw.exec(`BEGIN; ${sql}; COMMIT;`);
  }

  async batch(stmts: BatchStatement[]): Promise<BatchResult[]> {
    // D1 executes batch() natively; here we emulate it with an explicit
    // transaction so a mid-batch failure rolls every statement back.
    const results: BatchResult[] = [];
    this.raw.exec("BEGIN");
    try {
      for (const s of stmts) {
        const r = this.raw.query(s.sql).run(...s.params);
        results.push({ changes: Number(r.changes), lastRowId: Number(r.lastInsertRowid) });
      }
      this.raw.exec("COMMIT");
    } catch (e) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        // Already rolled back (e.g. a trigger ABORT): nothing to undo.
      }
      throw e;
    }
    return results;
  }
}

/** Wrap a raw bun:sqlite Database in the Db interface. Tests use this for
 *  in-memory databases. */
export function wrapDb(raw: Database): Db {
  return new BunDb(raw);
}

/** Bring a database up to the current schema. Idempotent: schema.sql is a
 *  set of CREATE TABLE IF NOT EXISTS, and runMigrations records every
 *  applied version, so running it twice is a no-op. Exported so tests can
 *  run it against a scratch database.
 *
 *  Freshness is judged BEFORE schema.sql runs: a database that already has
 *  app tables was built by the pre-migration code and is marked at the
 *  '000' baseline (its history is not re-applied); a fresh database gets
 *  schema.sql and then every migration in order. */
export async function migrateDb(db: Db): Promise<void> {
  // Schema may change here, so memoized table-existence answers are dropped
  // before judging freshness. (Test databases are rebuilt per test; the
  // production database migrates once at startup.)
  clearTableExistsCache();
  const preMigrationDb = await tableExists(db, "pots");
  const schema = readFileSync(join(here, "schema.sql"), "utf8");
  await db.exec(schema);
  await runMigrations(db, { baseline: preMigrationDb });
}

let singleton: Db | null = null;
let singletonPath: string | null = null;

/** Open (and migrate) the budget database. Single-writer: one user, one agent.
 *  The WAL pragma is applied to the raw handle before wrapping: it is a
 *  Bun-local concern (D1 does not accept it), so it stays outside the Db
 *  interface. A second call for a different path throws instead of silently
 *  returning the wrong database. */
export async function openDb(path: string = DB_PATH): Promise<Db> {
  if (singleton) {
    if (path !== singletonPath) {
      throw new Error(`openDb: already open at ${singletonPath}; refusing a second database at ${path}`);
    }
    return singleton;
  }
  const raw = new Database(path, { create: true });
  raw.exec("PRAGMA journal_mode = WAL;");
  const db = new BunDb(raw);
  await migrateDb(db);
  singletonPath = path;
  singleton = db;
  return db;
}

/** Read a user's app setting. Returns null when unset. */
export async function getSetting(db: Db, userId: number, key: string): Promise<string | null> {
  const r = await db.get<{ value: string }>("SELECT value FROM settings WHERE user_id = ? AND key = ?", userId, key);
  return r?.value ?? null;
}
