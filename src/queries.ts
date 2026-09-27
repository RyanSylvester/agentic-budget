/** Spend queries. Every one of the user's views sums only owner='user' splits —
 *  a contact's share of a split transaction is recorded but never counted in
 *  the user's numbers. (Reconciliation is the exception: it uses full
 *  transaction amounts because the bank balance is the bank balance.)
 */
import type { Database } from "bun:sqlite";

/** The user's confirmed outflow for a month, in positive cents.
 *  Transfers between the user's own accounts are never spending.
 *  Voided transactions are excluded everywhere. */
export function monthSpend(db: Database, month: string): number {
  const r = db.query(
    `SELECT COALESCE(SUM(-s.amount_cents), 0) AS spent
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE substr(t.date, 1, 7) = ? AND t.status = 'confirmed'
       AND t.is_transfer = 0 AND t.voided = 0
       AND s.owner = 'user' AND s.amount_cents < 0`
  ).get(month) as { spent: number };
  return r.spent;
}

/** The user's confirmed outflow for one pot in a month: user share + contact share. */
export function potSpend(db: Database, potId: number, month: string): { userCents: number; sharedCents: number } {
  const r = db.query(
    `SELECT
       COALESCE(SUM(CASE WHEN s.owner = 'user' THEN -s.amount_cents ELSE 0 END), 0) AS user,
       COALESCE(SUM(CASE WHEN s.owner = 'contact' THEN -s.amount_cents ELSE 0 END), 0) AS shared
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE s.pot_id = ? AND substr(t.date, 1, 7) = ?
       AND t.status = 'confirmed' AND t.is_transfer = 0 AND t.voided = 0 AND s.amount_cents < 0`
  ).get(potId, month) as { user: number; shared: number };
  return { userCents: r.user, sharedCents: r.shared };
}

/** Shift a YYYY-MM month back by n months. */
function shiftBack(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** One pot's user spend for the last N months, oldest first. Powers the
 *  per-pot history chart. */
export function potHistory(db: Database, potId: number, months: number, endMonth?: string): { month: string; spentCents: number }[] {
  const end = endMonth ?? new Date().toISOString().slice(0, 7);
  const out: { month: string; spentCents: number }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const m = shiftBack(end, i);
    out.push({ month: m, spentCents: potSpend(db, potId, m).userCents });
  }
  return out;
}

/** Last N months of the user's spend, oldest first. */
export function spendTrend(db: Database, limit = 6): { month: string; spent: number }[] {
  const rows = db.query(
    `SELECT substr(t.date, 1, 7) AS month,
            COALESCE(SUM(CASE WHEN s.owner = 'user' AND s.amount_cents < 0 THEN -s.amount_cents ELSE 0 END), 0) AS spent
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE t.status = 'confirmed' AND t.is_transfer = 0 AND t.voided = 0
     GROUP BY month ORDER BY month DESC LIMIT ?`
  ).all(limit) as { month: string; spent: number }[];
  return rows.reverse();
}

/** Recent confirmed transactions with the user's share of each. Optional month filter (YYYY-MM).
 *  Voided transactions never appear. */
export function recentTransactions(db: Database, limit = 10, month?: string) {
  const params: (string | number)[] = [];
  let where = `WHERE t.status = 'confirmed' AND t.voided = 0`;
  if (month) {
    where += ` AND substr(t.date, 1, 7) = ?`;
    params.push(month);
  }
  params.push(limit);
  return db.query(
    `SELECT t.id, t.date, t.description, t.is_transfer,
            COALESCE(SUM(CASE WHEN s.owner = 'user' THEN s.amount_cents ELSE 0 END), 0) AS user_cents,
            CASE WHEN SUM(CASE WHEN s.owner = 'contact' THEN 1 ELSE 0 END) > 0 THEN 1 ELSE 0 END AS split_with_contact,
            (SELECT c.name FROM splits s2 JOIN contacts c ON c.id = s2.contact_id
             WHERE s2.transaction_id = t.id AND s2.owner = 'contact' LIMIT 1) AS split_contact_name
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
       AND t.is_transfer = 0 AND t.voided = 0
       AND s.owner = 'user' AND s.amount_cents > 0`
  ).get(month) as { inflow: number };
  return r.inflow;
}

/** One pot's confirmed inflows for a month, in positive cents.
 *  This is what has actually landed in an income pot; compare against
 *  the pot's assignment (planned income) when filling out the month. */
export function potInflow(db: Database, potId: number, month: string): number {
  const r = db.query(
    `SELECT COALESCE(SUM(CASE WHEN s.owner = 'user' THEN s.amount_cents ELSE 0 END), 0) AS inflow
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE s.pot_id = ? AND substr(t.date, 1, 7) = ?
       AND t.status = 'confirmed' AND t.is_transfer = 0 AND t.voided = 0 AND s.amount_cents > 0`
  ).get(potId, month) as { inflow: number };
  return r.inflow;
}

/** What the agent assigned to pots for a month, in cents.
 *  The assignments ledger is the source of truth; pot target_cents is only
 *  the wireframe template. Only spending pots count: assignments to income
 *  pots are planned income and never reduce ready-to-assign. */
export function assignedTotal(db: Database, month: string): number {
  const r = db.query(
    `SELECT COALESCE(SUM(a.cents), 0) AS total
     FROM assignments a JOIN pots p ON p.id = a.pot_id
     WHERE a.month = ? AND p.hidden = 0 AND p.is_assignable = 1`
  ).get(month) as { total: number };
  return r.total;
}

/** Ready-to-assign for a month: inflows minus assignments. The month ends
 *  when this is exactly 0. */
export function rtaCents(db: Database, month: string): number {
  return monthInflows(db, month) - assignedTotal(db, month);
}

/** One row of the Transactions page: the transaction plus its user-side pot
 *  and the contact's share. Newest first. Voided transactions never appear. */
export interface ListedTransaction {
  id: number;
  date: string;
  description: string;
  amountCents: number;
  isTransfer: number;
  status: string;
  cleared: string;
  source: string;
  accountId: number;
  accountName: string;
  potId: number | null;
  potName: string | null;
  potGroup: string | null;
  splitWithContact: number;
  sharedCents: number;
  splitContactId: number | null;
  splitContactName: string | null;
}

export function listTransactions(db: Database, month: string): ListedTransaction[] {
  return db.query(
    `SELECT t.id, t.date, t.description,
            t.amount_cents AS amountCents, t.is_transfer AS isTransfer,
            t.status, t.cleared, t.source,
            t.account_id AS accountId, a.name AS accountName,
            (SELECT s2.pot_id FROM splits s2
             WHERE s2.transaction_id = t.id AND s2.owner = 'user'
             ORDER BY ABS(s2.amount_cents) DESC LIMIT 1) AS potId,
            (SELECT p.name FROM splits s2 JOIN pots p ON p.id = s2.pot_id
             WHERE s2.transaction_id = t.id AND s2.owner = 'user'
             ORDER BY ABS(s2.amount_cents) DESC LIMIT 1) AS potName,
            (SELECT p.pot_group FROM splits s2 JOIN pots p ON p.id = s2.pot_id
             WHERE s2.transaction_id = t.id AND s2.owner = 'user'
             ORDER BY ABS(s2.amount_cents) DESC LIMIT 1) AS potGroup,
            CASE WHEN SUM(CASE WHEN s.owner = 'contact' THEN 1 ELSE 0 END) > 0 THEN 1 ELSE 0 END AS splitWithContact,
            COALESCE(-SUM(CASE WHEN s.owner = 'contact' THEN s.amount_cents ELSE 0 END), 0) AS sharedCents,
            (SELECT s2.contact_id FROM splits s2
             WHERE s2.transaction_id = t.id AND s2.owner = 'contact' LIMIT 1) AS splitContactId,
            (SELECT c.name FROM splits s2 JOIN contacts c ON c.id = s2.contact_id
             WHERE s2.transaction_id = t.id AND s2.owner = 'contact' LIMIT 1) AS splitContactName
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN splits s ON s.transaction_id = t.id
     WHERE t.voided = 0 AND substr(t.date, 1, 7) = ?
     GROUP BY t.id
     ORDER BY t.date DESC, t.id DESC`
  ).all(month) as ListedTransaction[];
}
