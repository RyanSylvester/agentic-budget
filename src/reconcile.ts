/** Reconciliation: compare the budget's account balance against the real-world
 *  balance (read by the agent from a statement), YNAB-style.
 *  Pure functions; the server handles the database writes.
 */

export interface ReconcileInput {
  /** Sum of cleared + reconciled transactions only, in cents.
   *  (Uncleared = still pending at the bank, so excluded, YNAB-style.) */
  clearedBalanceCents: number;
  /** Real balance from the bank/statement, in cents. */
  actualBalanceCents: number;
}

export interface ReconcileResult {
  /** actual - cleared. Zero means balanced. */
  differenceCents: number;
  balanced: boolean;
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const differenceCents = input.actualBalanceCents - input.clearedBalanceCents;
  return { differenceCents, balanced: differenceCents === 0 };
}

/** If a single uncleared transaction exactly explains the difference, return
 *  its id so the UI can suggest clearing it. */
export function suggestClear(
  uncleared: { id: number; amount_cents: number }[],
  differenceCents: number
): number | null {
  // difference = actual - budget. An uncleared outflow (-x) missing from the
  // real balance means actual is higher by x... in practice: if clearing a
  // transaction (including it in the budget balance) would zero the
  // difference, suggest it.
  for (const t of uncleared) {
    if (t.amount_cents === differenceCents) return t.id;
  }
  return null;
}
