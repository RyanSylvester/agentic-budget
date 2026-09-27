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
  // Backfill splits: pre-split transactions were 100% Ryan's.
  const unsplit = fresh.query(
    "SELECT id, pot_id, amount_cents FROM transactions WHERE id NOT IN (SELECT transaction_id FROM splits)"
  ).all() as { id: number; pot_id: number | null; amount_cents: number }[];
  const ins = fresh.query("INSERT INTO splits (transaction_id, pot_id, owner, amount_cents) VALUES (?, ?, 'ryan', ?)");
  for (const t of unsplit) ins.run(t.id, t.pot_id, t.amount_cents);
  db = fresh;
  return db;
}
