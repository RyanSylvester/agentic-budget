/** Spend queries. Every one of the user's views sums only owner='user' splits —
 *  the partner's share of a split transaction is recorded but never counted in
 *  the user's numbers. (Reconciliation is the exception: it uses full
 *  transaction amounts because the bank balance is the bank balance.)
 */
import type { Database } from "bun:sqlite";

/** The user's confirmed outflow for a month, in positive cents.
 *  Transfers between the user's own accounts are never spending. */
export function monthSpend(db: Database, month: string): number {
  const r = db.query(
    `SELECT COALESCE(SUM(-s.amount_cents), 0) AS spent
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE substr(t.date, 1, 7) = ? AND t.status = 'confirmed'
       AND t.is_transfer = 0
       AND s.owner = 'user' AND s.amount_cents < 0`
  ).get(month) as { spent: number };
  return r.spent;
}

/** The user's confirmed outflow for one pot in a month: user share + partner share. */
export function potSpend(db: Database, potId: number, month: string): { userCents: number; partnerCents: number } {
  const r = db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN s.owner = 'user' THEN -s.amount_cents ELSE 0 END), 0) AS user,
       COALESCE(SUM(CASE WHEN s.owner = 'partner' THEN -s.amount_cents ELSE 0 END), 0) AS partner
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE s.pot_id = ? AND substr(t.date, 1, 7) = ?
       AND t.status = 'confirmed' AND t.is_transfer = 0 AND s.amount_cents < 0`
  ).get(potId, month) as { user: number; partner: number };
  return { userCents: r.user, partnerCents: r.partner };
}

/** Last N months of the user's spend, oldest first. */
export function spendTrend(db: Database, limit = 6): { month: string; spent: number }[] {
  const rows = db.query(
    `SELECT substr(t.date, 1, 7) AS month,
            COALESCE(SUM(CASE WHEN s.owner = 'user' AND s.amount_cents < 0 THEN -s.amount_cents ELSE 0 END), 0) AS spent
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE t.status = 'confirmed' AND t.is_transfer = 0
     GROUP BY month ORDER BY month DESC LIMIT ?`
  ).all(limit) as { month: string; spent: number }[];
  return rows.reverse();
}

/** Recent confirmed transactions with the user's share of each. Optional month filter (YYYY-MM). */
export function recentTransactions(db: Database, limit = 10, month?: string) {
  const params: (string | number)[] = [];
  let where = `WHERE t.status = 'confirmed'`;
  if (month) {
    where += ` AND substr(t.date, 1, 7) = ?`;
    params.push(month);
  }
  params.push(limit);
  return db.query(
    `SELECT t.id, t.date, t.description, t.is_transfer,
            COALESCE(SUM(CASE WHEN s.owner = 'user' THEN s.amount_cents ELSE 0 END), 0) AS user_cents,
            CASE WHEN SUM(CASE WHEN s.owner = 'partner' THEN 1 ELSE 0 END) > 0 THEN 1 ELSE 0 END AS split_with_partner
     FROM transactions t LEFT JOIN splits s ON s.transaction_id = t.id
     ${where}
     GROUP BY t.id ORDER BY t.date DESC, t.id DESC LIMIT ?`
  ).all(...params);
}

/** The user's confirmed inflows for a month, in cents (positive).
 *  Transfers between the user's own accounts are never income. */
export function monthInflows(db: Database, month: string): number {
  const r = db.query(
    `SELECT COALESCE(SUM(s.amount_cents), 0) AS inflow
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE substr(t.date, 1, 7) = ? AND t.status = 'confirmed'
       AND t.is_transfer = 0
       AND s.owner = 'user' AND s.amount_cents > 0`
  ).get(month) as { inflow: number };
  return r.inflow;
}

/** Sum of current pot targets: what is assigned for the month, in cents. */
export function assignedTotal(db: Database): number {
  const r = db.query(`SELECT COALESCE(SUM(target_cents), 0) AS a FROM pots WHERE hidden = 0`).get() as { a: number };
  return r.a;
}
