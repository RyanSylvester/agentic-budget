/** Settlements: a contact's lump sums filling up the buckets they owe.
 *  Credit from overpaid settlements is consumed first (oldest-first, zero
 *  cash) before any new money is allocated. Pure allocation math lives in
 *  allocateSettlement; DB writes live in applySettlement, run as sequential
 *  awaits (single writer: one user, one agent). */
import type { Db, DbValue } from "./db-interface";
import { assertSplitsSum } from "./money";

export interface OwedSplit {
  splitId: number;
  contactId: number;
  contactName: string;
  potName: string | null;
  date: string;
  owedCents: number; // positive
}

export interface Allocation {
  splitId: number;
  potName: string | null;
  amountCents: number; // positive
}

/** Allocate a lump sum against what a contact owes, oldest first. */
export function allocateSettlement(
  owed: OwedSplit[],
  settlementCents: number
): { allocations: Allocation[]; leftoverCents: number } {
  const allocations: Allocation[] = [];
  let remaining = settlementCents;
  for (const s of owed) {
    if (remaining <= 0) break;
    const take = Math.min(s.owedCents, remaining);
    if (take > 0) {
      allocations.push({ splitId: s.splitId, potName: s.potName, amountCents: take });
      remaining -= take;
    }
  }
  return { allocations, leftoverCents: remaining };
}

/** What a contact still owes, oldest first. Omit contactId for everyone. */
export async function contactOwed(db: Db, userId: number, contactId?: number): Promise<OwedSplit[]> {
  // All user_id filters bind the same value; params are listed in the order
  // their placeholders appear in the SQL text below.
  const params: DbValue[] = [userId, userId, userId, userId, userId];
  let where = `s.owner = 'contact' AND s.amount_cents < 0 AND t.voided = 0
               AND s.user_id = ? AND t.user_id = ? AND c.user_id = ?`;
  if (contactId !== undefined) {
    where += ` AND s.contact_id = ?`;
    params.push(contactId);
  }
  const rows = await db.all<OwedSplit>(
    // The settled allocation used to be a correlated subquery per split
    // (a full scan of settlement_allocations per row); it is now a LEFT
    // JOIN aggregated once, seeking on the new index.
    `SELECT s.id AS splitId, s.contact_id AS contactId, c.name AS contactName,
            p.name AS potName, t.date AS date,
            -s.amount_cents - COALESCE(SUM(a.amount_cents), 0) AS owedCents
     FROM splits s
     JOIN transactions t ON t.id = s.transaction_id
     JOIN contacts c ON c.id = s.contact_id
     LEFT JOIN pots p ON p.id = s.pot_id AND p.user_id = ?
     LEFT JOIN settlement_allocations a ON a.split_id = s.id AND a.user_id = ?
     WHERE ${where}
     GROUP BY s.id
     ORDER BY t.date, s.id`,
    ...params
  );
  return rows.filter((r) => r.owedCents > 0);
}

export interface SettlementSummary {
  contactId: number;
  contactName: string;
  allocations: Allocation[];
  /** Splits paid down from prior credit (zero cash moved). */
  creditAllocations: Allocation[];
  creditConsumedCents: number;
  leftoverCents: number;
}

/** Record a lump sum from a contact and allocate it against what they owe.
 *  Existing credit is consumed oldest-first (zero-cash allocations against
 *  the credit settlement), then the new money fills what is still owed.
 *  Sequential awaits, not a transaction: one writer per user (a single agent
 *  plus the human behind it), and every statement carries that user's
 *  user_id, so two users' sequences never touch the same rows. */
export async function applySettlement(
  db: Db,
  userId: number,
  opts: { contactId: number; accountId: number; amountCents: number; note?: string; enteredBy?: "agent" | "user" }
): Promise<SettlementSummary> {
  const enteredBy = opts.enteredBy ?? "agent";
  const contact = await db.get<{ id: number; name: string }>("SELECT id, name FROM contacts WHERE id = ? AND user_id = ?", opts.contactId, userId);
  if (!contact) throw new Error(`no contact ${opts.contactId}`);

  // 1. Consume existing credit oldest-first, zero cash.
  const creditAllocations: Allocation[] = [];
  let creditConsumedCents = 0;
  const credits = await db.all<{ id: number; leftover_cents: number }>(
    `SELECT st.id, st.leftover_cents FROM settlements st
     JOIN transactions t ON t.id = st.transaction_id
     JOIN splits s ON s.transaction_id = t.id AND s.owner = 'contact' AND s.contact_id = ?
     WHERE st.leftover_cents > 0 AND st.user_id = ? AND t.user_id = ? AND s.user_id = ? ORDER BY st.date, st.id`,
    opts.contactId,
    userId,
    userId,
    userId
  );
  if (credits.length > 0) {
    for (const o of await contactOwed(db, userId, opts.contactId)) {
      let need = o.owedCents;
      for (const cr of credits) {
        if (need <= 0) break;
        if (cr.leftover_cents <= 0) continue;
        const take = Math.min(need, cr.leftover_cents);
        await db.run(`INSERT INTO settlement_allocations (user_id, settlement_id, split_id, amount_cents) VALUES (?, ?, ?, ?)`, userId, cr.id, o.splitId, take);
        await db.run("UPDATE settlements SET leftover_cents = leftover_cents - ? WHERE id = ? AND user_id = ?", take, cr.id, userId);
        cr.leftover_cents -= take;
        need -= take;
        creditConsumedCents += take;
        creditAllocations.push({ splitId: o.splitId, potName: o.potName, amountCents: take });
      }
    }
  }

  // 2. Allocate the new money against what is still owed.
  const owed = await contactOwed(db, userId, opts.contactId);
  const { allocations, leftoverCents } = allocateSettlement(owed, opts.amountCents);

  const txn = await db.get<{ id: number }>(
    `INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, cleared)
     VALUES (?, date('now'), ?, ?, ?, 'manual', ?, 'cleared') RETURNING id`,
    userId,
    opts.accountId,
    opts.amountCents,
    opts.note ?? `${contact.name} settlement`,
    enteredBy
  );
  // 100% contact-owned: real money for reconciliation, invisible to the user's spend views.
  await db.run(
    `INSERT INTO splits (user_id, transaction_id, owner, contact_id, amount_cents) VALUES (?, ?, 'contact', ?, ?)`,
    userId,
    txn!.id,
    opts.contactId,
    opts.amountCents
  );

  const st = await db.get<{ id: number }>(
    `INSERT INTO settlements (user_id, transaction_id, date, amount_cents, leftover_cents, note) VALUES (?, ?, date('now'), ?, ?, ?) RETURNING id`,
    userId,
    txn!.id,
    opts.amountCents,
    leftoverCents,
    opts.note ?? null
  );
  for (const a of allocations) {
    await db.run(`INSERT INTO settlement_allocations (user_id, settlement_id, split_id, amount_cents) VALUES (?, ?, ?, ?)`, userId, st!.id, a.splitId, a.amountCents);
  }

  await assertSplitsSum(db, userId, txn!.id);
  return { contactId: contact.id, contactName: contact.name, allocations, creditAllocations, creditConsumedCents, leftoverCents };
}

/** Total credit from a contact's overpaid settlements not yet consumed.
 *  Omit contactId for everyone. */
export async function contactCredit(db: Db, userId: number, contactId?: number): Promise<number> {
  const params: DbValue[] = [userId];
  let where = `WHERE st.user_id = ?`;
  if (contactId !== undefined) {
    where += ` AND EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = st.transaction_id AND s.owner = 'contact' AND s.contact_id = ? AND s.user_id = ?)`;
    params.push(contactId, userId);
  }
  const r = await db.get<{ total: number }>(
    `SELECT COALESCE(SUM(st.leftover_cents), 0) AS total FROM settlements st ${where}`,
    ...params
  );
  return r!.total;
}
