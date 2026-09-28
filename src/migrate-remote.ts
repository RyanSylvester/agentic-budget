/** `budget migrate-remote` — push the local budget.db into the hosted D1.
 *
 *  Re-runnable by design: it ensures the remote schema (schema.sql +
 *  pending src/migrations/ files, tracked in D1's schema_migrations),
 *  then wipes remote DATA tables and re-imports every row from the local
 *  database. Phase 7 re-runs this after a hard freeze on local writes for
 *  the final cutover sync.
 *
 *  Safety rules:
 *  - The local budget.db is opened READ ONLY. It is never written.
 *  - schema_migrations is managed, never wiped or imported: the remote
 *    tracks its own applied migrations.
 *  - Wipe is DELETE FROM in foreign-key-safe order (children first), not
 *    DROP TABLE: the schema stays intact, so a wipe can never leave the
 *    remote half-rebuilt, and migration tracking is undisturbed.
 *  - Every /query call is its own atomic transaction (proven in spike 001),
 *    so each table's import is all-or-nothing.
 *  - Counts are verified per table afterwards; any mismatch throws.
 *
 *  Transport: shells out to the cloudflare skill's cf-api CLI (which holds
 *  the stored credential via surrogate). No secrets in this file: the
 *  account id and database id are not secret.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DB_PATH } from "./db";
import { listMigrations } from "./migrations";

const here = dirname(fileURLToPath(import.meta.url));
const CF_API = join(process.env.HOME ?? "/home/hatch", "workspace/skills/cloudflare/bin/cf-api");

// Not a secret. From ~/workspace/skills/cloudflare/SKILL.md.
const ACCOUNT_ID = "1af804e6c3520a49f4ec595bea0041f2";

/** Identity tables: never wiped or imported. A push replaces the budget
 *  data, not who may sign in: wiping users (or their invite codes / agent
 *  tokens) would strand or delete remote identities the local database
 *  knows nothing about. */
const PRESERVED = ["users", "invite_codes", "agent_tokens"];

/** Data tables in wipe order: children before parents (FK-safe for DELETE).
 *  schema_migrations is intentionally absent: it is managed, not data. */
const WIPE_ORDER = [
  "settlement_allocations", // -> settlements, splits
  "settlements",            // -> transactions
  "splits",                 // -> transactions, pots, contacts
  "transactions",           // -> accounts, pots
  "assignments",            // -> pots
  "reconciliations",        // -> accounts
  "sinking_schedules",      // -> pots
  "month_closes",
  "pots",                   // -> contacts
  "contacts",
  "accounts",
  "settings",
];

/** Import order is the reverse: parents before children. */
const IMPORT_ORDER = [...WIPE_ORDER].reverse();

function readDatabaseId(): string {
  const toml = readFileSync(join(here, "..", "wrangler.toml"), "utf8");
  const m = toml.match(/^database_id\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error("database_id not found in wrangler.toml");
  return m[1];
}

interface D1Result {
  results: Record<string, unknown>[];
  success: boolean;
  meta: Record<string, unknown>;
}

async function d1query(dbId: string, sql: string): Promise<D1Result[]> {
  const path = `/accounts/${ACCOUNT_ID}/d1/database/${dbId}/query`;
  const body = JSON.stringify({ sql });
  const proc = Bun.spawn(["python3", CF_API, "POST", path, body], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const errText = await new Response(proc.stderr).text();
  const code = await proc.exited;
  let payload: any;
  try {
    payload = JSON.parse(out);
  } catch {
    throw new Error(`cf-api returned non-JSON (exit ${code}): ${out.slice(0, 300)}${errText}`);
  }
  if (!payload.success) {
    const detail = JSON.stringify(payload.errors ?? payload).slice(0, 500);
    throw new Error(`D1 query failed: ${detail}\nSQL: ${sql.slice(0, 200)}`);
  }
  return payload.result as D1Result[];
}

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") {
    if (!Number.isFinite(Number(v))) throw new Error(`non-finite number in export: ${v}`);
    return String(v);
  }
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString("hex")}'`;
  throw new Error(`unexportable value of type ${typeof v}: ${String(v).slice(0, 80)}`);
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Bring the remote schema up to date: schema.sql (idempotent) then every
 *  pending src/migrations/ file in version order, recording each version
 *  only after its SQL succeeds. */
async function ensureRemoteSchema(d1: (sql: string) => Promise<D1Result[]>): Promise<void> {
  const schema = readFileSync(join(here, "schema.sql"), "utf8");
  await d1(schema);
  await d1(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  const appliedRows = (await d1(`SELECT version FROM schema_migrations`))[0].results;
  const applied = new Set(appliedRows.map((r) => r.version as string));
  // Fresh D1 has no pre-migration history, so no '000' baseline is recorded:
  // every migration is applied explicitly and tracked by its own version.
  for (const m of listMigrations()) {
    if (applied.has(m.version)) continue;
    console.log(`  applying migration ${m.version} (${m.name})`);
    await d1(m.sql);
    await d1(`INSERT INTO schema_migrations (version) VALUES (${sqlLiteral(m.version)})`);
  }
}

/** Schema-only entry point: bring the remote D1 up to date (schema.sql +
 *  pending migrations) without touching any data. Used for deploys where the
 *  remote must stay empty (multi-user cutover) or already holds live data
 *  that a wipe would destroy. */
export async function ensureRemoteSchemaOnly(): Promise<void> {
  const dbId = readDatabaseId();
  const d1 = (sql: string) => d1query(dbId, sql);
  console.log(`target D1: ${dbId}`);
  console.log("ensuring remote schema (no data changes)...");
  await ensureRemoteSchema(d1);
  console.log("remote schema is up to date.");
}

export async function migrateRemote(): Promise<void> {
  const dbId = readDatabaseId();
  const d1 = (sql: string) => d1query(dbId, sql);
  console.log(`target D1: ${dbId}`);

  console.log("ensuring remote schema...");
  await ensureRemoteSchema(d1);

  const local = new Database(DB_PATH, { readonly: true });
  try {
    const localTables = (local
      .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_cf_KV' ORDER BY name`)
      .all() as { name: string }[]).map((r) => r.name);
    const known = new Set([...WIPE_ORDER, ...PRESERVED, "schema_migrations"]);
    const drift = localTables.filter((t) => !known.has(t));
    if (drift.length > 0) {
      throw new Error(`local has tables outside the known wipe order: ${drift.join(", ")} — update WIPE_ORDER first`);
    }

    console.log("wiping remote data tables (one atomic call)...");
    await d1(WIPE_ORDER.map((t) => `DELETE FROM ${q(t)}`).join("; ") + ";");

    console.log("importing tables (one atomic call each)...");
    for (const t of IMPORT_ORDER) {
      const cols = (local.query(`PRAGMA table_info(${q(t)})`).all() as { name: string }[]).map((c) => c.name);
      const rows = local.query(`SELECT * FROM ${q(t)}`).all() as Record<string, unknown>[];
      if (rows.length === 0) {
        console.log(`  ${t}: 0 rows (skipped)`);
        continue;
      }
      const colList = cols.map(q).join(", ");
      const values = rows
        .map((r) => `(${cols.map((c) => sqlLiteral(r[c])).join(", ")})`)
        .join(", ");
      await d1(`INSERT INTO ${q(t)} (${colList}) VALUES ${values};`);
      console.log(`  ${t}: ${rows.length} rows`);
    }

    console.log("verifying per-table counts (local vs D1)...");
    let ok = true;
    for (const t of IMPORT_ORDER) {
      const localN = (local.query(`SELECT COUNT(*) AS n FROM ${q(t)}`).get() as { n: number }).n;
      const remoteN = ((await d1(`SELECT COUNT(*) AS n FROM ${q(t)}`))[0].results[0] as { n: number }).n;
      const mark = localN === remoteN ? "ok" : "MISMATCH";
      if (localN !== remoteN) ok = false;
      console.log(`  ${t}: local ${localN}, D1 ${remoteN} [${mark}]`);
    }
    const fk = (await d1(`PRAGMA foreign_key_check`))[0].results;
    console.log(`  foreign_key_check: ${fk.length === 0 ? "clean" : `VIOLATIONS: ${JSON.stringify(fk)}`}`);
    if (fk.length > 0) ok = false;
    if (!ok) throw new Error("verification failed: counts or foreign keys do not match");
    console.log("migrate-remote complete: D1 matches local.");
  } finally {
    local.close();
  }
}
