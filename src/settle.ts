/** Settlements: the partner's lump sums filling up the buckets they owe.
 *  Credit from overpaid settlements is consumed first (oldest-first, zero
 *  cash) before any new money is allocated. Pure allocation math lives in
 *  allocateSettlement; DB writes live in applySettlement (all-or-nothing). */
import type { Database } from "bun:sqlite";
import { assertSplitsSum } from "./money";

export interface OwedSplit {
  splitId: number;
  potName: string | null;
  date: string;
  owedCents: number; // positive
}

export interface Allocation {
  splitId: number;
  potName: string | null;
  amountCents: number; // positive
}

/** Allocate a lump sum against what the partner owes, oldest first. */
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

/** What the partner still owes, oldest first. */
export function partnerOwed(db: Database): OwedSplit[] {
  const rows = db.query(
    `SELECT s.id AS splitId, p.name AS potName, t.date AS date,
            -s.amount_cents - COALESCE((SELECT SUM(a.amount_cents) FROM settlement_allocations a WHERE a.split_id = s.id), 0) AS owedCents
     FROM splits s
     JOIN transactions t ON t.id = s.transaction_id
     LEFT JOIN pots p ON p.id = s.pot_id
     WHERE s.owner = 'partner' AND s.amount_cents < 0 AND t.status = 'confirmed' AND t.voided = 0
     ORDER BY t.date, s.id`
  ).all() as OwedSplit[];
  return rows.filter((r) => r.owedCents > 0);
}

export interface SettlementSummary {
  allocations: Allocation[];
  /** Splits paid down from prior credit (zero cash moved). */
  creditAllocations: Allocation[];
  creditConsumedCents: number;
  leftoverCents: number;
}

/** Record a lump sum from the partner and allocate it. Existing credit is
 *  consumed oldest-first (zero-cash allocations against the credit
 *  settlement), then the new money fills what is still owed. All-or-nothing. */
export function applySettlement(
  db: Database,
  opts: { accountId: number; amountCents: number; note?: string; enteredBy?: "agent" | "user" }
): SettlementSummary {
  return db.transaction(() => {
    const enteredBy = opts.enteredBy ?? "agent";

    // 1. Consume existing credit oldest-first, zero cash.
    const creditAllocations: Allocation[] = [];
    let creditConsumedCents = 0;
    const credits = db.query(
      `SELECT id, leftover_cents FROM settlements WHERE leftover_cents > 0 ORDER BY date, id`
    ).all() as { id: number; leftover_cents: number }[];
    if (credits.length > 0) {
      const ins = db.query("INSERT INTO settlement_allocations (settlement_id, split_id, amount_cents) VALUES (?, ?, ?)");
      const useCredit = db.query("UPDATE settlements SET leftover_cents = leftover_cents - ? WHERE id = ?");
      for (const o of partnerOwed(db)) {
        let need = o.owedCents;
        for (const cr of credits) {
          if (need <= 0) break;
          if (cr.leftover_cents <= 0) continue;
          const take = Math.min(need, cr.leftover_cents);
          ins.run(cr.id, o.splitId, take);
          useCredit.run(take, cr.id);
          cr.leftover_cents -= take;
          need -= take;
          creditConsumedCents += take;
          creditAllocations.push({ splitId: o.splitId, potName: o.potName, amountCents: take });
        }
      }
    }

    // 2. Allocate the new money against what is still owed.
    const owed = partnerOwed(db);
    const { allocations, leftoverCents } = allocateSettlement(owed, opts.amountCents);

    const txn = db.query(
      `INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared)
       VALUES (date('now'), ?, ?, ?, 'manual', ?, 'confirmed', 'cleared') RETURNING id`
    ).get(opts.accountId, opts.amountCents, opts.note ?? "Partner settlement", enteredBy) as { id: number };
    // 100% partner-owned: real money for reconciliation, invisible to the user's spend views.
    db.query("INSERT INTO splits (transaction_id, owner, amount_cents) VALUES (?, 'partner', ?)").run(txn.id, opts.amountCents);

    const st = db.query(
      "INSERT INTO settlements (transaction_id, date, amount_cents, leftover_cents, note) VALUES (?, date('now'), ?, ?, ?) RETURNING id"
    ).get(txn.id, opts.amountCents, leftoverCents, opts.note ?? null) as { id: number };
    const ins = db.query("INSERT INTO settlement_allocations (settlement_id, split_id, amount_cents) VALUES (?, ?, ?)");
    for (const a of allocations) ins.run(st.id, a.splitId, a.amountCents);

    assertSplitsSum(db, txn.id);
    return { allocations, creditAllocations, creditConsumedCents, leftoverCents };
  })();
}

/** Total credit from overpaid settlements not yet consumed. */
export function partnerCredit(db: Database): number {
  const r = db.query("SELECT COALESCE(SUM(leftover_cents), 0) AS total FROM settlements").get() as { total: number };
  return r.total;
}
