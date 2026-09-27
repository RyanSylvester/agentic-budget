/** Shared money invariants and small helpers used by every write path. */
import type { Database } from "bun:sqlite";

/** Every transaction's splits must sum to its amount. Throws otherwise.
 *  Called at the end of every write path (record, settle). */
export function assertSplitsSum(db: Database, txnId: number): void {
  const t = db.query("SELECT amount_cents FROM transactions WHERE id = ?").get(txnId) as { amount_cents: number } | null;
  if (!t) throw new Error(`transaction ${txnId} does not exist`);
  const s = db.query("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM splits WHERE transaction_id = ?").get(txnId) as { total: number };
  if (s.total !== t.amount_cents) {
    throw new Error(`splits for transaction ${txnId} sum to ${s.total}, expected ${t.amount_cents}`);
  }
}

/** Resolve a pot by id or name (case-insensitive) to its id. Throws when
 *  unknown or ambiguous. */
export function resolvePotId(db: Database, idOrName: string): number {
  const n = parseInt(idOrName, 10);
  if (Number.isFinite(n) && String(n) === idOrName.trim()) {
    const row = db.query("SELECT id FROM pots WHERE id = ?").get(n) as { id: number } | null;
    if (!row) throw new Error(`no pot with id ${n}`);
    return row.id;
  }
  const rows = db.query("SELECT id, name FROM pots WHERE LOWER(name) = LOWER(?)").all(idOrName.trim()) as { id: number; name: string }[];
  if (rows.length === 0) throw new Error(`no pot named "${idOrName}"`);
  if (rows.length > 1) throw new Error(`ambiguous pot name "${idOrName}"`);
  return rows[0].id;
}

/** YYYY-MM, strict. */
export function validMonth(month: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

/** YYYY-MM-DD, strict and a real calendar date. */
export function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 12345 -> "123.45", -50 -> "-0.50". */
export function fmtCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const a = Math.abs(cents);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}
