/** Versioned schema migrations. Numbered SQL files live in src/migrations/
 *  (`001_name.sql`, ...), applied in order and recorded in schema_migrations.
 *  No down migrations: single local database, forward only.
 *
 *  Databases created before the migration system get a '000' baseline marker
 *  (their history is NOT re-applied); fresh databases run every migration.
 *  Each migration runs in a transaction and its version is recorded only on
 *  success, so a failed migration retries cleanly on the next startup. */
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, "migrations");

export interface Migration {
  version: string;
  name: string;
  sql: string;
}

/** Every known migration, sorted by version. */
export function listMigrations(): Migration[] {
  const files = readdirSync(DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  return files.map((f) => {
    const m = f.match(/^(\d+)_(.+)\.sql$/)!;
    return { version: m[1], name: m[2].replace(/_/g, " "), sql: readFileSync(join(DIR, f), "utf8") };
  });
}

export function tableExists(db: Database, name: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);
}

function appliedVersions(db: Database): Set<string> {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  const rows = db.query("SELECT version FROM schema_migrations").all() as { version: string }[];
  return new Set(rows.map((r) => r.version));
}

/** Apply every pending migration in version order. When `baseline` is set
 *  (a database built by the pre-migration code), record version '000' first
 *  so the old history is marked applied without being re-applied. */
export function runMigrations(db: Database, opts: { baseline?: boolean } = {}): void {
  const applied = appliedVersions(db);
  if (opts.baseline && applied.size === 0) {
    db.query("INSERT INTO schema_migrations (version) VALUES ('000')").run();
    applied.add("000");
  }
  const record = db.query("INSERT INTO schema_migrations (version) VALUES (?)");
  for (const m of listMigrations()) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version);
    })();
  }
}
