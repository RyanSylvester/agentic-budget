/** Spend queries. Every one of Ryan's views sums only owner='ryan' splits —
 *  Lilly's share of a split transaction is recorded but never counted in his
 *  numbers. (Reconciliation is the exception: it uses full transaction
 *  amounts because the bank balance is the bank balance.)
 */
import type { Database } from "bun:sqlite";

/** Ryan's confirmed outflow for a month, in positive cents.
 *  Transfers between his own accounts are never spending. */
export function monthSpend(db: Database, month: string): number {
  const r = db.query(
    `SELECT COALESCE(SUM(-s.amount_cents), 0) AS spent
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE substr(t.date, 1, 7) = ? AND t.status = 'confirmed'
       AND t.is_transfer = 0
       AND s.owner = 'ryan' AND s.amount_cents < 0`
  ).get(month) as { spent: number };
  return r.spent;
}

/** Ryan's confirmed outflow for one pot in a month: his share + Lilly's share. */
export function potSpend(db: Database, potId: number, month: string): { ryanCents: number; lillyCents: number } {
  const r = db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN s.owner = 'ryan' THEN -s.amount_cents ELSE 0 END), 0) AS ryan,
       COALESCE(SUM(CASE WHEN s.owner = 'lilly' THEN -s.amount_cents ELSE 0 END), 0) AS lilly
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE s.pot_id = ? AND substr(t.date, 1, 7) = ?
       AND t.status = 'confirmed' AND t.is_transfer = 0 AND s.amount_cents < 0`
  ).get(potId, month) as { ryan: number; lilly: number };
  return { ryanCents: r.ryan, lillyCents: r.lilly };
}

/** Last N months of Ryan's spend, oldest first. */
export function spendTrend(db: Database, limit = 6): { month: string; spent: number }[] {
  const rows = db.query(
    `SELECT substr(t.date, 1, 7) AS month,
            COALESCE(SUM(CASE WHEN s.owner = 'ryan' AND s.amount_cents < 0 THEN -s.amount_cents ELSE 0 END), 0) AS spent
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE t.status = 'confirmed' AND t.is_transfer = 0
     GROUP BY month ORDER BY month DESC LIMIT ?`
  ).all(limit) as { month: string; spent: number }[];
  return rows.reverse();
}

/** Recent transactions with Ryan's share of each. */
export function recentTransactions(db: Database, limit = 10) {
  return db.query(
    `SELECT t.id, t.date, t.description,
            COALESCE(SUM(CASE WHEN s.owner = 'ryan' THEN s.amount_cents ELSE 0 END), 0) AS ryan_cents,
            CASE WHEN SUM(CASE WHEN s.owner = 'lilly' THEN 1 ELSE 0 END) > 0 THEN 1 ELSE 0 END AS split_with_lilly
     FROM transactions t LEFT JOIN splits s ON s.transaction_id = t.id
     GROUP BY t.id ORDER BY t.id DESC LIMIT ?`
  ).all(limit);
}
