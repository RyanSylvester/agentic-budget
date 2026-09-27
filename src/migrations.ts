/** Versioned schema migrations. Timestamped SQL files live in src/migrations/
 *  (`YYYYMMDDHHMMSS_name.sql`, UTC), applied in lexicographic (= chronological)
 *  order and recorded in schema_migrations. The version stamp is minted by
 *  `createMigration()` from the clock, never typed by hand; `budget migration
 *  new <name>` is the only way to create one. No down migrations: single
 *  local database, forward only.
 *
 *  Databases created before the migration system get a '000' baseline marker
 *  (their history is NOT re-applied); fresh databases run every migration.
 *  Each migration runs in a transaction and its version is recorded only on
 *  success, so a failed migration retries cleanly on the next startup. */
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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
export function listMigrations(dir: string = DIR): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => /^\d{14}_.*\.sql$/.test(f))
    .sort();
  return files.map((f) => {
    const m = f.match(/^(\d{14})_(.+)\.sql$/)!;
    return { version: m[1], name: m[2].replace(/_/g, " "), sql: readFileSync(join(dir, f), "utf8") };
  });
}

/** Current UTC time as YYYYMMDDHHMMSS. */
function utcStamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/** Stamp out a new migration file and return its path. The version timestamp
 *  always comes from the clock; callers never supply it. */
export function createMigration(name: string, dir: string = DIR): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!slug) throw new Error(`bad migration name "${name}"; use letters, numbers, underscores`);
  const version = utcStamp();
  const filename = `${version}_${slug}.sql`;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  if (existsSync(path)) throw new Error(`migration ${filename} already exists; wait a second and retry`);
  writeFileSync(path, `-- ${version}: ${slug.replace(/_/g, " ")}\n\n`);
  return path;
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
