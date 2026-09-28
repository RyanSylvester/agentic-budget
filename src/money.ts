/** Shared money invariants and small helpers used by every write path. */
import type { Db } from "./db-interface";

/** Every transaction's splits must sum to its amount. Throws otherwise.
 *  Called at the end of every write path (record, settle). */
export async function assertSplitsSum(db: Db, userId: number, txnId: number): Promise<void> {
  const t = await db.get<{ amount_cents: number }>("SELECT amount_cents FROM transactions WHERE id = ? AND user_id = ?", txnId, userId);
  if (!t) throw new Error(`transaction ${txnId} does not exist`);
  const s = await db.get<{ total: number }>(
    "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM splits WHERE transaction_id = ? AND user_id = ?",
    txnId,
    userId
  );
  if (s!.total !== t.amount_cents) {
    throw new Error(`splits for transaction ${txnId} sum to ${s!.total}, expected ${t.amount_cents}`);
  }
}

/** Resolve a pot by id or name (case-insensitive) to its id. Throws when
 *  unknown or ambiguous. */
export async function resolvePotId(db: Db, userId: number, idOrName: string): Promise<number> {
  const n = parseInt(idOrName, 10);
  if (Number.isFinite(n) && String(n) === idOrName.trim()) {
    const row = await db.get<{ id: number }>("SELECT id FROM pots WHERE id = ? AND user_id = ?", n, userId);
    if (!row) throw new Error(`no pot with id ${n}`);
    return row.id;
  }
  const rows = await db.all<{ id: number; name: string }>(
    "SELECT id, name FROM pots WHERE LOWER(name) = LOWER(?) AND user_id = ?",
    idOrName.trim(),
    userId
  );
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
