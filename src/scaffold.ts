/** Bulk-fill a month's assignments from history ("scaffolding").
 *  Spending pots follow the chosen strategy; income pots always copy last
 *  month's planned income. Pots with a sinking schedule ignore the strategy
 *  and use the schedule's derived contribution instead (the average strategy
 *  is actively wrong for annual bills: ~$0 for 11 months, then a spike).
 *  Reuses assignToPot per pot, so all the usual validation applies. */
import type { Db } from "./db-interface";
import { assignManyToPot, allPotAssignedMonths } from "./assign";
import { shiftMonth } from "./close";
import { validMonth } from "./money";
import { sinkingStatuses } from "./sinking";

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

/** Compute (and, unless dryRun, write) one month's scaffolded assignments for
 *  a user. Throws on a bad month or an unknown strategy. Sequential awaits,
 *  not a transaction: one writer per user (a single agent plus the human
 *  behind it), and every statement carries that user's user_id. */
export async function scaffoldMonth(
  db: Db,
  userId: number,
  month: string,
  strategy: ScaffoldStrategy,
  dryRun = false
): Promise<ScaffoldLine[]> {
  if (!validMonth(month)) throw new Error(`bad month "${month}"; expected YYYY-MM`);
  if (!SCAFFOLD_STRATEGIES.includes(strategy)) {
    throw new Error(`bad strategy "${strategy}"; expected one of ${SCAFFOLD_STRATEGIES.join(", ")}`);
  }
  const pots = await db.all<{ id: number; name: string; is_assignable: number }>(
    `SELECT id, name, is_assignable FROM pots WHERE hidden = 0 AND user_id = ? ORDER BY id`,
    userId
  );

  // Batched per-pot reads: assigned totals for the three prior months in one
  // GROUP BY query, and all sinking schedule states in one call. The old
  // loop cost up to 4 assignedToPot queries + 3 sinking queries per pot;
  // on D1 every round trip is an HTTPS request.
  const potIds = pots.map((p) => p.id);
  const prevMonths = [shiftMonth(month, -1), shiftMonth(month, -2), shiftMonth(month, -3)];
  const [assignedHist, sinkingByPot] = await Promise.all([
    allPotAssignedMonths(db, userId, prevMonths, potIds),
    sinkingStatuses(db, userId, potIds, month),
  ]);

  const lines: ScaffoldLine[] = [];
  for (const p of pots) {
    const income = p.is_assignable === 0;
    const hist = assignedHist.get(p.id);
    let cents: number;
    let scheduled = false;
    if (income) {
      // Income pots hold planned income: carry last month's plan forward.
      cents = hist?.get(prevMonths[0]) ?? 0;
    } else {
      // A sinking schedule takes precedence over the history strategies.
      const sched = sinkingByPot.get(p.id);
      if (sched) {
        cents = sched.contributionCents;
        scheduled = true;
      } else if (strategy === "last_month") {
        cents = hist?.get(prevMonths[0]) ?? 0;
      } else {
        const vals = prevMonths.map((m) => hist?.get(m) ?? 0);
        cents = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
      }
    }
    lines.push({ potId: p.id, name: p.name, cents, income, scheduled });
  }

  if (!dryRun) {
    // One multi-row upsert for the whole month instead of one assignToPot
    // (3 queries) per line.
    await assignManyToPot(
      db,
      userId,
      month,
      lines.map((l) => ({ potId: l.potId, cents: l.cents }))
    );
  }
  return lines;
}
