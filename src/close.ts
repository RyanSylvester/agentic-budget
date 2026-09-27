/** Month-end close math. Pure functions: same input, same output, fully tested.
 *  The close rules: the month starts and ends at $0; leftover RTA goes to
 *  secondary savings; next month is wireframed from history.
 */

export interface PotTarget {
  potId: number;
  /** 'fixed' = copy last month's bill, 'average_3mo' = 3-month average, 'savings' = sink */
  targetType: "fixed" | "average_3mo" | "savings";
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

import type { Database } from "bun:sqlite";
import { monthSpend, monthInflows, potSpend, assignedTotal, rtaCents } from "./queries";
import { partnerOwed } from "./settle";
import { fmtCents } from "./money";

/** Shift a YYYY-MM month by delta months. */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface PotCloseLine {
  potId: number;
  name: string;
  targetType: "fixed" | "average_3mo" | "savings";
  targetCents: number;
  spentCents: number;
  historyCents: number[];
  wireframeCents: number;
  assignable: boolean;
}

export interface ClosePreview {
  month: string;
  nextMonth: string;
  inflowsCents: number;
  spentCents: number;
  assignedCents: number;
  rtaBeforeCents: number;
  movedToSavingsCents: number;
  partnerOwedCents: number;
  pots: PotCloseLine[];
}

/** Everything the month-end close needs, read from live data. */
export function closePreview(db: Database, month: string): ClosePreview {
  const pots = db.query(
    `SELECT id, name, target_type, target_cents, is_assignable FROM pots WHERE hidden = 0 ORDER BY id`
  ).all() as { id: number; name: string; target_type: "fixed" | "average_3mo" | "savings"; target_cents: number; is_assignable: number }[];

  const lines: PotCloseLine[] = pots.map((p) => {
    const historyCents = [3, 2, 1].map((i) => potSpend(db, p.id, shiftMonth(month, -i)).userCents);
    const spentCents = potSpend(db, p.id, month).userCents;
    // Income-group pots receive money; they get no wireframe target.
    const wireframeCents = p.is_assignable
      ? wireframeTarget({ potId: p.id, targetType: p.target_type, historyCents })
      : 0;
    return { potId: p.id, name: p.name, targetType: p.target_type, targetCents: p.target_cents, spentCents, historyCents, wireframeCents, assignable: p.is_assignable === 1 };
  });

  const inflowsCents = monthInflows(db, month);
  const spentCents = monthSpend(db, month);
  const assignedCents = assignedTotal(db, month);
  const rtaBeforeCents = rtaCents(db, month);
  const { movedToSavingsCents } = closeMonth({ rtaStartCents: rtaBeforeCents });
  const partnerOwedCents = partnerOwed(db).reduce((a, o) => a + o.owedCents, 0);

  return { month, nextMonth: shiftMonth(month, 1), inflowsCents, spentCents, assignedCents, rtaBeforeCents, movedToSavingsCents, partnerOwedCents, pots: lines };
}

/** Apply the month-end close: record it and wireframe next month's pot targets.
 *  The $0 rule binds only here, at apply time: Ready-to-Assign must be exactly
 *  $0 when the month is closed. Mid-month it is free to be anything; the
 *  dashboard shows it as a neutral number until the last day. Throws if this
 *  month was already closed. All-or-nothing. Human review happens before the
 *  agent runs this. */
export function applyClose(db: Database, preview: ClosePreview): void {
  if (preview.rtaBeforeCents !== 0) {
    throw new Error(`RTA is $${fmtCents(preview.rtaBeforeCents)}; the close applies at month-end once every dollar is assigned`);
  }
  db.transaction(() => {
    const exists = db.query(`SELECT 1 FROM month_closes WHERE month = ?`).get(preview.month);
    if (exists) throw new Error(`close for ${preview.month} already applied`);
    db.query(
      `INSERT INTO month_closes (month, rta_start_cents, rta_end_cents, moved_to_savings_cents)
       VALUES (?, ?, 0, ?)`
    ).run(preview.month, preview.rtaBeforeCents, preview.movedToSavingsCents);
    const upd = db.query(`UPDATE pots SET target_cents = ? WHERE id = ?`);
    for (const p of preview.pots) {
      if (!p.assignable) continue; // income pots get no wireframe target
      upd.run(p.wireframeCents, p.potId);
    }
  })();
}
