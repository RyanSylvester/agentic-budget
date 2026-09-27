/** Month-end close math. Pure functions: same input, same output, fully tested.
 *  Ryan's rules: the month starts and ends at $0; leftover RTA goes to
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
