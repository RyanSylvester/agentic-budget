/** Settlements: Lilly's lump sums filling up the buckets she owes.
 *  Pure allocation math here; DB writes live in applySettlement. */
import type { Database } from "bun:sqlite";

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

/** Allocate a lump sum against what Lilly owes, oldest first. */
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

/** What Lilly still owes, oldest first. */
export function lillyOwed(db: Database): OwedSplit[] {
  const rows = db.query(
    `SELECT s.id AS splitId, p.name AS potName, t.date AS date,
            -s.amount_cents - COALESCE((SELECT SUM(a.amount_cents) FROM settlement_allocations a WHERE a.split_id = s.id), 0) AS owedCents
     FROM splits s
     JOIN transactions t ON t.id = s.transaction_id
     LEFT JOIN pots p ON p.id = s.pot_id
     WHERE s.owner = 'lilly' AND s.amount_cents < 0 AND t.status = 'confirmed'
     ORDER BY t.date, s.id`
  ).all() as OwedSplit[];
  return rows.filter((r) => r.owedCents > 0);
}

/** Record a lump sum from Lilly and allocate it. Returns the allocation summary. */
export function applySettlement(
  db: Database,
  opts: { accountId: number; amountCents: number; note?: string }
): { allocations: Allocation[]; leftoverCents: number } {
  const owed = lillyOwed(db);
  const { allocations, leftoverCents } = allocateSettlement(owed, opts.amountCents);

  const txn = db.query(
    `INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared)
     VALUES (date('now'), ?, ?, ?, 'manual', 'agent', 'confirmed', 'cleared') RETURNING id`
  ).get(opts.accountId, opts.amountCents, opts.note ?? "Lilly settlement") as { id: number };
  // 100% Lilly-owned: real money for reconciliation, invisible to Ryan's spend views.
  db.query("INSERT INTO splits (transaction_id, owner, amount_cents) VALUES (?, 'lilly', ?)").run(txn.id, opts.amountCents);

  const st = db.query(
    "INSERT INTO settlements (transaction_id, date, amount_cents, leftover_cents, note) VALUES (?, date('now'), ?, ?, ?) RETURNING id"
  ).get(txn.id, opts.amountCents, leftoverCents, opts.note ?? null) as { id: number };
  const ins = db.query("INSERT INTO settlement_allocations (settlement_id, split_id, amount_cents) VALUES (?, ?, ?)");
  for (const a of allocations) ins.run(st.id, a.splitId, a.amountCents);

  return { allocations, leftoverCents };
}

/** Total credit from overpaid settlements. */
export function lillyCredit(db: Database): number {
  const r = db.query("SELECT COALESCE(SUM(leftover_cents), 0) AS total FROM settlements").get() as { total: number };
  return r.total;
}
