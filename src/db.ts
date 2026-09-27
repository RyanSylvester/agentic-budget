import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.BUDGET_DB ?? join(here, "..", "budget.db");

let db: Database | null = null;

/** Open (and migrate) the budget database. Single-writer: one user, one agent. */
export function openDb(path: string = DB_PATH): Database {
  if (db) return db;
  const fresh = new Database(path, { create: true });
  fresh.exec("PRAGMA journal_mode = WAL;");
  const schema = readFileSync(join(here, "schema.sql"), "utf8");
  fresh.exec(schema);
  // Lightweight migrations for databases created before a column existed.
  const cols = fresh.query("PRAGMA table_info(transactions)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "cleared")) {
    fresh.exec("ALTER TABLE transactions ADD COLUMN cleared TEXT NOT NULL DEFAULT 'uncleared'");
  }
  if (!cols.some((c) => c.name === "review_reason")) {
    fresh.exec("ALTER TABLE transactions ADD COLUMN review_reason TEXT");
  }
  if (!cols.some((c) => c.name === "is_transfer")) {
    fresh.exec("ALTER TABLE transactions ADD COLUMN is_transfer INTEGER NOT NULL DEFAULT 0");
  }
  // Soft-delete flag for retired pots (history kept, hidden from views).
  const potCols = fresh.query("PRAGMA table_info(pots)").all() as { name: string }[];
  if (!potCols.some((c) => c.name === "hidden")) {
    fresh.exec("ALTER TABLE pots ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
  }
  // Income-group pots receive money; dollars are never assigned to them.
  if (!potCols.some((c) => c.name === "is_assignable")) {
    fresh.exec("ALTER TABLE pots ADD COLUMN is_assignable INTEGER NOT NULL DEFAULT 1");
  }
  fresh.exec("UPDATE pots SET is_assignable = 0 WHERE pot_group = 'Income'");
  // Month assignments ledger.
  fresh.exec(`CREATE TABLE IF NOT EXISTS assignments (
    month    TEXT NOT NULL,
    pot_id   INTEGER NOT NULL REFERENCES pots(id),
    cents    INTEGER NOT NULL,
    PRIMARY KEY (month, pot_id)
  )`);
  // Statement-import idempotency key. (ALTER TABLE cannot add a UNIQUE
  // constraint, so existing DBs get a unique index instead.)
  if (!cols.some((c) => c.name === "external_id")) {
    fresh.exec("ALTER TABLE transactions ADD COLUMN external_id TEXT");
  }
  fresh.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_external_id ON transactions(external_id)");
  // Soft-void flag.
  if (!cols.some((c) => c.name === "voided")) {
    fresh.exec("ALTER TABLE transactions ADD COLUMN voided INTEGER NOT NULL DEFAULT 0");
  }
  // Backfill splits: pre-split transactions were 100% the user's.
  const unsplit = fresh.query(
    "SELECT id, pot_id, amount_cents FROM transactions WHERE id NOT IN (SELECT transaction_id FROM splits)"
  ).all() as { id: number; pot_id: number | null; amount_cents: number }[];
  const ins = fresh.query("INSERT INTO splits (transaction_id, pot_id, owner, amount_cents) VALUES (?, ?, 'user', ?)");
  for (const t of unsplit) ins.run(t.id, t.pot_id, t.amount_cents);
  // Seed default settings (INSERT OR IGNORE: never overwrite user data).
  fresh.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('partner_name', 'Partner')");
  db = fresh;
  return db;
}

/** Read an app setting. Returns null when unset. */
export function getSetting(db: Database, key: string): string | null {
  const r = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  return r?.value ?? null;
}
