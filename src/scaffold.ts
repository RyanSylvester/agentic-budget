/** Bulk-fill a month's assignments from history ("scaffolding").
 *  Spending pots follow the chosen strategy; income pots always copy last
 *  month's planned income. Pots with a sinking schedule ignore the strategy
 *  and use the schedule's derived contribution instead (the average strategy
 *  is actively wrong for annual bills: ~$0 for 11 months, then a spike).
 *  Reuses assignToPot per pot, so all the usual validation applies. */
import type { Database } from "bun:sqlite";
import { assignToPot, assignedToPot } from "./assign";
import { shiftMonth } from "./close";
import { validMonth } from "./money";
import { sinkingStatus } from "./sinking";

export type ScaffoldStrategy = "average_3mo" | "last_month";

export const SCAFFOLD_STRATEGIES: ScaffoldStrategy[] = ["average_3mo", "last_month"];

export interface ScaffoldLine {
  potId: number;
  name: string;
  cents: number;
  /** True for income pots, whose value is planned income, not an allocation. */
  income: boolean;
  /** True when the value came from the pot's sinking schedule, not the strategy. */
  scheduled?: boolean;
}

/** Compute (and, unless dryRun, write) one month's scaffolded assignments.
 *  Throws on a bad month or an unknown strategy. */
export function scaffoldMonth(
  db: Database,
  month: string,
  strategy: ScaffoldStrategy,
  dryRun = false
): ScaffoldLine[] {
  if (!validMonth(month)) throw new Error(`bad month "${month}"; expected YYYY-MM`);
  if (!SCAFFOLD_STRATEGIES.includes(strategy)) {
    throw new Error(`bad strategy "${strategy}"; expected one of ${SCAFFOLD_STRATEGIES.join(", ")}`);
  }
  const pots = db.query(
    `SELECT id, name, is_assignable FROM pots WHERE hidden = 0 ORDER BY id`
  ).all() as { id: number; name: string; is_assignable: number }[];

  const lines: ScaffoldLine[] = pots.map((p) => {
    const income = p.is_assignable === 0;
    let cents: number;
    let scheduled = false;
    if (income) {
      // Income pots hold planned income: carry last month's plan forward.
      cents = assignedToPot(db, shiftMonth(month, -1), p.id);
    } else {
      // A sinking schedule takes precedence over the history strategies.
      const sched = sinkingStatus(db, p.id, month);
      if (sched) {
        cents = sched.contributionCents;
        scheduled = true;
      } else if (strategy === "last_month") {
        cents = assignedToPot(db, shiftMonth(month, -1), p.id);
      } else {
        const hist = [1, 2, 3].map((i) => assignedToPot(db, shiftMonth(month, -i), p.id));
        cents = Math.round(hist.reduce((a, b) => a + b, 0) / hist.length);
      }
    }
    return { potId: p.id, name: p.name, cents, income, scheduled };
  });

  if (!dryRun) {
    db.transaction(() => {
      for (const l of lines) assignToPot(db, month, l.potId, l.cents);
    })();
  }
  return lines;
}
