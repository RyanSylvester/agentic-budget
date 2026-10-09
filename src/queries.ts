/** Spend queries. Every one of the user's views sums only owner='user' splits —
 *  a contact's share of a split transaction is recorded but never counted in
 *  the user's numbers. (Reconciliation is the exception: it uses full
 *  transaction amounts because the bank balance is the bank balance.)
 *
 *  Every query is scoped to one user: each user_id-bearing table in the
 *  query carries an `AND <alias>.user_id = ?` filter, so one user's rows
 *  can never leak into another user's views.
 */
import type { Db, DbValue } from "./db-interface";
import type { ListedTransaction, PotHistoryPoint, RecentTransaction, TrendPoint } from "./api-types";
export type { ListedTransaction, PotHistoryPoint, RecentTransaction, TrendPoint };

/** The user's confirmed outflow for a month, in positive cents.
 *  Transfers between the user's own accounts are never spending.
 *  Voided transactions are excluded everywhere. */
export async function monthSpend(db: Db, userId: number, month: string): Promise<number> {
  const r = await db.get<{ spent: number }>(
    `SELECT COALESCE(SUM(-s.amount_cents), 0) AS spent
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE substr(t.date, 1, 7) = ?
       AND t.is_transfer = 0 AND t.voided = 0
       AND s.owner = 'user' AND s.amount_cents < 0
       AND s.user_id = ? AND t.user_id = ?`,
    month,
    userId,
    userId
  );
  return r!.spent;
}

/** The user's confirmed outflow for one pot in a month: user share + contact share. */
export async function potSpend(db: Db, userId: number, potId: number, month: string): Promise<{ userCents: number; sharedCents: number }> {
  const r = await db.get<{ user: number; shared: number }>(
    `SELECT
       COALESCE(SUM(CASE WHEN s.owner = 'user' THEN -s.amount_cents ELSE 0 END), 0) AS user,
       COALESCE(SUM(CASE WHEN s.owner = 'contact' THEN -s.amount_cents ELSE 0 END), 0) AS shared
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE s.pot_id = ? AND substr(t.date, 1, 7) = ? AND t.is_transfer = 0 AND t.voided = 0 AND s.amount_cents < 0
       AND s.user_id = ? AND t.user_id = ?`,
    potId,
    month,
    userId,
    userId
  );
  return { userCents: r!.user, sharedCents: r!.shared };
}

/** Batched spend for many pots at once: one GROUP BY query for the whole pot
 *  list instead of one potSpend per pot. Filters match potSpend exactly;
 *  pots with no rows are absent from the map, so callers zero-fill in JS.
 *  On D1 every round trip is an HTTPS request, so this collapses the
 *  /api/pots N+1 (22 pots x 3 queries) into 3 queries total. */
export async function allPotSpend(
  db: Db,
  userId: number,
  potIds: number[],
  month: string
): Promise<Map<number, { userCents: number; sharedCents: number }>> {
  const out = new Map<number, { userCents: number; sharedCents: number }>();
  if (potIds.length === 0) return out;
  const placeholders = potIds.map(() => "?").join(",");
  const rows = await db.all<{ potId: number; user: number; shared: number }>(
    `SELECT s.pot_id AS potId,
       COALESCE(SUM(CASE WHEN s.owner = 'user' THEN -s.amount_cents ELSE 0 END), 0) AS user,
       COALESCE(SUM(CASE WHEN s.owner = 'contact' THEN -s.amount_cents ELSE 0 END), 0) AS shared
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE s.pot_id IN (${placeholders}) AND substr(t.date, 1, 7) = ?
       AND t.is_transfer = 0 AND t.voided = 0 AND s.amount_cents < 0
       AND s.user_id = ? AND t.user_id = ?
     GROUP BY s.pot_id`,
    ...potIds,
    month,
    userId,
    userId
  );
  for (const r of rows) out.set(r.potId, { userCents: r.user, sharedCents: r.shared });
  return out;
}

/** Batched multi-month user spend for many pots: one GROUP BY (pot_id,
 *  month) query instead of one potSpend per pot per month. Powers the
 *  close-preview history columns. Months with no rows are absent from the
 *  inner map, so callers zero-fill in JS; filters match potSpend exactly. */
export async function allPotSpendHistory(
  db: Db,
  userId: number,
  potIds: number[],
  months: string[]
): Promise<Map<number, Map<string, number>>> {
  const out = new Map<number, Map<string, number>>();
  if (potIds.length === 0 || months.length === 0) return out;
  const potPh = potIds.map(() => "?").join(",");
  const monthPh = months.map(() => "?").join(",");
  const rows = await db.all<{ potId: number; month: string; user: number }>(
    `SELECT s.pot_id AS potId, substr(t.date, 1, 7) AS month,
       COALESCE(SUM(CASE WHEN s.owner = 'user' THEN -s.amount_cents ELSE 0 END), 0) AS user
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE s.pot_id IN (${potPh}) AND substr(t.date, 1, 7) IN (${monthPh})
       AND t.is_transfer = 0 AND t.voided = 0 AND s.amount_cents < 0
       AND s.user_id = ? AND t.user_id = ?
     GROUP BY s.pot_id, month`,
    ...potIds,
    ...months,
    userId,
    userId
  );
  for (const r of rows) {
    let m = out.get(r.potId);
    if (!m) {
      m = new Map();
      out.set(r.potId, m);
    }
    m.set(r.month, r.user);
  }
  return out;
}

/** Shift a YYYY-MM month back by n months. */
function shiftBack(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** One pot's user spend for the last N months, oldest first. Powers the
 *  per-pot history chart. A single GROUP BY query, not one per month: on D1
 *  every round trip is an HTTPS request, so the N-1 saved here are real
 *  latency. Months with no rows report zero, matching the old loop. */
export async function potHistory(
  db: Db,
  userId: number,
  potId: number,
  months: number,
  endMonth?: string
): Promise<PotHistoryPoint[]> {
  const end = endMonth ?? new Date().toISOString().slice(0, 7);
  const start = shiftBack(end, months - 1);
  const rows = await db.all<{ month: string; user: number }>(
    `SELECT substr(t.date, 1, 7) AS month,
            COALESCE(SUM(CASE WHEN s.owner = 'user' THEN -s.amount_cents ELSE 0 END), 0) AS user
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE s.pot_id = ? AND t.is_transfer = 0 AND t.voided = 0 AND s.amount_cents < 0
       AND s.user_id = ? AND t.user_id = ?
       AND substr(t.date, 1, 7) >= ? AND substr(t.date, 1, 7) <= ?
     GROUP BY month`,
    potId,
    userId,
    userId,
    start,
    end
  );
  const byMonth = new Map(rows.map((r) => [r.month, r.user]));
  const out: PotHistoryPoint[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const m = shiftBack(end, i);
    out.push({ month: m, spentCents: byMonth.get(m) ?? 0 });
  }
  return out;
}

/** Last N months of the user's spend, oldest first. */
export async function spendTrend(db: Db, userId: number, limit = 6): Promise<TrendPoint[]> {
  const rows = await db.all<TrendPoint>(
    `SELECT substr(t.date, 1, 7) AS month,
            COALESCE(SUM(CASE WHEN s.owner = 'user' AND s.amount_cents < 0 THEN -s.amount_cents ELSE 0 END), 0) AS spent
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE t.is_transfer = 0 AND t.voided = 0
       AND s.user_id = ? AND t.user_id = ?
     GROUP BY month ORDER BY month DESC LIMIT ?`,
    userId,
    userId,
    limit
  );
  return rows.reverse();
}

/** Recent confirmed transactions with the user's share of each. Optional month filter (YYYY-MM).
 *  Voided transactions never appear. The contact name comes from a derived
 *  table (one row per transaction) instead of a correlated subquery, so the
 *  splits table is scanned once rather than once per transaction row. */
export async function recentTransactions(db: Db, userId: number, limit = 10, month?: string): Promise<RecentTransaction[]> {
  const params: DbValue[] = [];
  let where = `WHERE t.voided = 0 AND t.user_id = ?`;
  params.push(userId);
  if (month) {
    where += ` AND substr(t.date, 1, 7) = ?`;
    params.push(month);
  }
  params.push(limit);
  return db.all<RecentTransaction>(
    `SELECT t.id, t.date, t.description, t.is_transfer,
            COALESCE(SUM(CASE WHEN s.owner = 'user' THEN s.amount_cents ELSE 0 END), 0) AS user_cents,
            CASE WHEN SUM(CASE WHEN s.owner = 'contact' THEN 1 ELSE 0 END) > 0 THEN 1 ELSE 0 END AS split_with_contact,
            cc.cname AS split_contact_name
     FROM transactions t
     LEFT JOIN splits s ON s.transaction_id = t.id AND s.user_id = ?
     LEFT JOIN (
       SELECT s2.transaction_id AS tid, MIN(c.name) AS cname
       FROM splits s2 JOIN contacts c ON c.id = s2.contact_id
       WHERE s2.owner = 'contact' AND s2.user_id = ? AND c.user_id = ?
       GROUP BY s2.transaction_id
     ) cc ON cc.tid = t.id
     ${where}
     GROUP BY t.id ORDER BY t.date DESC, t.id DESC LIMIT ?`,
    userId,
    userId,
    userId,
    ...params
  );
}

/** The user's confirmed inflows for a month, in cents (positive).
 *  Transfers between the user's own accounts are never income. */
export async function monthInflows(db: Db, userId: number, month: string): Promise<number> {
  const r = await db.get<{ inflow: number }>(
    `SELECT COALESCE(SUM(s.amount_cents), 0) AS inflow
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE substr(t.date, 1, 7) = ?
       AND t.is_transfer = 0 AND t.voided = 0
       AND s.owner = 'user' AND s.amount_cents > 0
       AND s.user_id = ? AND t.user_id = ?`,
    month,
    userId,
    userId
  );
  return r!.inflow;
}

/** One pot's confirmed inflows for a month, in positive cents.
 *  This is what has actually landed in an income pot; compare against
 *  the pot's assignment (planned income) when filling out the month. */
export async function potInflow(db: Db, userId: number, potId: number, month: string): Promise<number> {
  const r = await db.get<{ inflow: number }>(
    `SELECT COALESCE(SUM(CASE WHEN s.owner = 'user' THEN s.amount_cents ELSE 0 END), 0) AS inflow
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE s.pot_id = ? AND substr(t.date, 1, 7) = ? AND t.voided = 0 AND s.amount_cents > 0
       AND s.user_id = ? AND t.user_id = ?`,
    potId,
    month,
    userId,
    userId
  );
  return r!.inflow;
}

/** Batched inflows for many pots at once. Filters match potInflow exactly;
 *  pots with no rows are absent from the map, so callers zero-fill in JS. */
export async function allPotInflow(
  db: Db,
  userId: number,
  potIds: number[],
  month: string
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (potIds.length === 0) return out;
  const placeholders = potIds.map(() => "?").join(",");
  const rows = await db.all<{ potId: number; inflow: number }>(
    `SELECT s.pot_id AS potId,
       COALESCE(SUM(CASE WHEN s.owner = 'user' THEN s.amount_cents ELSE 0 END), 0) AS inflow
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE s.pot_id IN (${placeholders}) AND substr(t.date, 1, 7) = ? AND t.voided = 0 AND s.amount_cents > 0
       AND s.user_id = ? AND t.user_id = ?
     GROUP BY s.pot_id`,
    ...potIds,
    month,
    userId,
    userId
  );
  for (const r of rows) out.set(r.potId, r.inflow);
  return out;
}

/** What the agent assigned to pots for a month, in cents.
 *  The assignments ledger is the source of truth; pot target_cents is only
 *  the wireframe template. Only spending pots count: assignments to income
 *  pots are planned income and never reduce ready-to-assign. */
export async function assignedTotal(db: Db, userId: number, month: string): Promise<number> {
  const r = await db.get<{ total: number }>(
    `SELECT COALESCE(SUM(a.cents), 0) AS total
     FROM assignments a JOIN pots p ON p.id = a.pot_id
     WHERE a.month = ? AND p.hidden = 0 AND p.is_assignable = 1
       AND a.user_id = ? AND p.user_id = ?`,
    month,
    userId,
    userId
  );
  return r!.total;
}

/** Ready-to-assign for a month: inflows minus assignments. The month ends
 *  when this is exactly 0. */
export async function rtaCents(db: Db, userId: number, month: string): Promise<number> {
  return (await monthInflows(db, userId, month)) - (await assignedTotal(db, userId, month));
}


export async function listTransactions(db: Db, userId: number, month: string): Promise<ListedTransaction[]> {
  // One pass over the month's transactions. The per-transaction pot pick
  // (largest user split) and contact summary used to be five correlated
  // subqueries, each a full scan of splits per row; they are now derived
  // tables joined once, seeking on the splits indexes.
  return db.all<ListedTransaction>(
    `WITH us AS (
       SELECT transaction_id, pot_id,
              ROW_NUMBER() OVER (PARTITION BY transaction_id
                                 ORDER BY ABS(amount_cents) DESC, id) AS rn
       FROM splits
       WHERE user_id = ? AND owner = 'user'
     ),
     cs AS (
       SELECT transaction_id, contact_id,
              ROW_NUMBER() OVER (PARTITION BY transaction_id ORDER BY id) AS rn,
              COUNT(*) OVER (PARTITION BY transaction_id) AS n,
              SUM(amount_cents) OVER (PARTITION BY transaction_id) AS total
       FROM splits
       WHERE user_id = ? AND owner = 'contact'
     )
     SELECT t.id, t.date, t.description,
            t.amount_cents AS amountCents, t.is_transfer AS isTransfer,
            t.cleared, t.source,
            t.account_id AS accountId, a.name AS accountName,
            up.pot_id AS potId, p.name AS potName, p.pot_group AS potGroup,
            CASE WHEN cs.n > 0 THEN 1 ELSE 0 END AS splitWithContact,
            COALESCE(-cs.total, 0) AS sharedCents,
            cs.contact_id AS splitContactId, c.name AS splitContactName,
            CASE WHEN EXISTS (SELECT 1 FROM settlement_allocations sa JOIN splits ss ON ss.id = sa.split_id
                              WHERE ss.transaction_id = t.id AND ss.user_id = t.user_id AND sa.user_id = t.user_id)
                   OR EXISTS (SELECT 1 FROM settlements st WHERE st.transaction_id = t.id AND st.user_id = t.user_id)
                 THEN 1 ELSE 0 END AS settled
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id AND a.user_id = ?
     LEFT JOIN us up ON up.transaction_id = t.id AND up.rn = 1
     LEFT JOIN pots p ON p.id = up.pot_id AND p.user_id = ?
     LEFT JOIN cs ON cs.transaction_id = t.id AND cs.rn = 1
     LEFT JOIN contacts c ON c.id = cs.contact_id AND c.user_id = ?
     WHERE t.voided = 0 AND substr(t.date, 1, 7) = ? AND t.user_id = ?
     ORDER BY t.date DESC, t.id DESC`,
    userId,
    userId,
    userId,
    userId,
    userId,
    month,
    userId
  );
}
