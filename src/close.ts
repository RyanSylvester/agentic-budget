/** Month-end close math. Pure functions: same input, same output, fully tested.
 *  The close rules: the month starts and ends at $0; leftover RTA goes to
 *  secondary savings; next month is wireframed from history.
 */

export interface PotTarget {
  potId: number;
  /** 'fixed' = copy last month's bill, 'average_3mo' = 3-month average, 'savings' = sink */
  targetType: TargetType;
  /** Assigned amounts per month, oldest first, in cents. */
  historyCents: number[];
}

/** What next month's wireframe assigns to a pot, in cents. */
export function wireframeTarget(pot: PotTarget): number {
  const h = pot.historyCents;
  if (pot.targetType === "savings") return 0; // savings get leftovers, not assignments
  if (h.length === 0) return 0;
  if (pot.targetType === "fixed") return h[h.length - 1];
  const last3 = h.slice(-3);
  return Math.round(last3.reduce((a, b) => a + b, 0) / last3.length);
}

export interface CloseInput {
  /** Ready-to-assign at start of close, in cents. May be negative mid-month. */
  rtaStartCents: number;
}

/** End-of-month close: RTA must end at exactly 0; the remainder (or the
 *  negative, which stays put) determines what moves to secondary savings. */
export function closeMonth(input: CloseInput): { rtaEndCents: number; movedToSavingsCents: number } {
  const movedToSavingsCents = Math.max(0, input.rtaStartCents);
  return { rtaEndCents: 0, movedToSavingsCents };
}

/* Live-data wiring: build the close preview from the database. */

import type { ClosePreview, PotCloseLine, TargetType } from "./api-types";
export type { ClosePreview, PotCloseLine };
import type { Db } from "./db-interface";
import { monthSpend, monthInflows, assignedTotal, rtaCents, allPotSpendHistory } from "./queries";
import { contactOwed } from "./settle";
import { fmtCents } from "./money";
import { sinkingStatuses } from "./sinking";

/** Shift a YYYY-MM month by delta months. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}



/** The close card's three numbers: income in, spend out, savings as the
 *  residual. Income minus spend minus savings is always zero. */
export function closeEquation(preview: Pick<ClosePreview, "inflowsCents" | "spentCents">): {
  incomeCents: number;
  spendCents: number;
  savingsCents: number;
} {
  const incomeCents = preview.inflowsCents;
  const spendCents = preview.spentCents;
  return { incomeCents, spendCents, savingsCents: incomeCents - spendCents };
}

/** Everything the month-end close needs, read from live data. */
export async function closePreview(db: Db, userId: number, month: string): Promise<ClosePreview> {
  const pots = await db.all<{ id: number; name: string; target_type: TargetType; target_cents: number; is_assignable: number }>(
    `SELECT id, name, target_type, target_cents, is_assignable FROM pots WHERE hidden = 0 AND user_id = ? ORDER BY id`,
    userId
  );

  const nextMonth = shiftMonth(month, 1);
  // Batched per-pot data: the 3-month spend history plus current-month spend
  // in one GROUP BY (pot_id, month) query, and all sinking schedule states
  // in one call. The old loop cost 4 potSpend queries + up to 3 sinking
  // queries per pot; on D1 every round trip is an HTTPS request.
  const potIds = pots.map((p) => p.id);
  const histMonths = [shiftMonth(month, -3), shiftMonth(month, -2), shiftMonth(month, -1)];
  const [spendHist, sinkingByPot] = await Promise.all([
    allPotSpendHistory(db, userId, potIds, [...histMonths, month]),
    sinkingStatuses(
      db,
      userId,
      pots.filter((p) => p.is_assignable).map((p) => p.id),
      nextMonth
    ),
  ]);
  const lines: PotCloseLine[] = [];
  for (const p of pots) {
    const hist = spendHist.get(p.id);
    const historyCents = histMonths.map((m) => hist?.get(m) ?? 0);
    const spentCents = hist?.get(month) ?? 0;
    // Income-group pots receive money; they get no wireframe target.
    // Scheduled pots keep the schedule as source of truth: no target write,
    // and the preview shows the schedule's next-month contribution instead.
    const sched = p.is_assignable ? sinkingByPot.get(p.id) ?? null : null;
    const wireframeCents = sched
      ? sched.contributionCents
      : p.is_assignable
        ? wireframeTarget({ potId: p.id, targetType: p.target_type, historyCents })
        : 0;
    lines.push({ potId: p.id, name: p.name, targetType: p.target_type, targetCents: p.target_cents, spentCents, historyCents, wireframeCents, assignable: p.is_assignable === 1, wireframeSkipped: sched !== null });
  }

  const inflowsCents = await monthInflows(db, userId, month);
  const spentCents = await monthSpend(db, userId, month);
  const assignedCents = await assignedTotal(db, userId, month);
  const rtaBeforeCents = await rtaCents(db, userId, month);
  const { movedToSavingsCents } = closeMonth({ rtaStartCents: rtaBeforeCents });
  const owed = await contactOwed(db, userId);
  const sharedOwedCents = owed.reduce((a, o) => a + o.owedCents, 0);
  const byName = new Map<string, number>();
  for (const o of owed) byName.set(o.contactName, (byName.get(o.contactName) ?? 0) + o.owedCents);
  const sharedOwedBy = [...byName.entries()]
    .map(([name, cents]) => ({ name, cents }))
    .sort((a, b) => b.cents - a.cents);

  const closed = !!(await db.get(`SELECT 1 FROM month_closes WHERE month = ? AND user_id = ?`, month, userId));

  return { month, nextMonth, inflowsCents, spentCents, assignedCents, rtaBeforeCents, movedToSavingsCents, sharedOwedCents, sharedOwedBy, pots: lines, closed };
}

/** Apply the month-end close: record it and wireframe next month's pot targets.
 *  The $0 rule binds only here, at apply time: Ready-to-Assign must be exactly
 *  $0 when the month is closed. Mid-month it is free to be anything; the
 *  dashboard shows it as a neutral number until the last day. Throws if this
 *  month was already closed. Sequential awaits, not a transaction: one writer
 *  per user (a single agent plus the human behind it), and every statement
 *  carries that user's user_id, so two users' sequences never touch the same
 *  rows. Human review happens before the agent runs this. */
export async function applyClose(db: Db, userId: number, preview: ClosePreview): Promise<void> {
  if (preview.rtaBeforeCents !== 0) {
    throw new Error(`RTA is $${fmtCents(preview.rtaBeforeCents)}; the close applies at month-end once every dollar is assigned`);
  }
  const exists = await db.get(`SELECT 1 FROM month_closes WHERE month = ? AND user_id = ?`, preview.month, userId);
  if (exists) throw new Error(`close for ${preview.month} already applied`);
  await db.run(
    `INSERT INTO month_closes (user_id, month, rta_start_cents, rta_end_cents, moved_to_savings_cents)
     VALUES (?, ?, ?, 0, ?)`,
    userId,
    preview.month,
    preview.rtaBeforeCents,
    preview.movedToSavingsCents
  );
  const targets = preview.pots.filter((p) => p.assignable && !p.wireframeSkipped);
  // One UPDATE with CASE instead of one per pot: on D1 every round trip is
  // an HTTPS request. Income pots get no wireframe target; scheduled pots
  // keep the schedule.
  if (targets.length > 0) {
    const cases = targets.map(() => "WHEN ? THEN ?").join(" ");
    const ids = targets.map(() => "?").join(",");
    await db.run(
      `UPDATE pots SET target_cents = CASE id ${cases} END WHERE id IN (${ids}) AND user_id = ?`,
      ...targets.flatMap((p) => [p.potId, p.wireframeCents]),
      ...targets.map((p) => p.potId),
      userId
    );
  }
}
