/** Month assignments: the agent assigns every dollar of income to a pot.
 *  `assign` upserts the pot's assigned total for the month — idempotent.
 *  Assigning to an Income pot records planned/expected income for the month;
 *  it is stored in the same ledger but excluded from assignedTotal and RTA. */
import type { Db } from "./db-interface";
import { resolvePotId, validMonth } from "./money";

/** Set a user's pot's assigned total for a month. Throws on bad input,
 *  unknown pots, or hidden pots. Income pots accept assignments too:
 *  the value means planned income, not a budget allocation. */
export async function assignToPot(
  db: Db,
  userId: number,
  month: string,
  potIdOrName: string | number,
  cents: number
): Promise<{ potId: number; month: string; cents: number }> {
  if (!validMonth(month)) throw new Error(`bad month "${month}"; expected YYYY-MM`);
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`bad amount "${cents}"; expected a non-negative integer of cents`);
  const potId = await resolvePotId(db, userId, String(potIdOrName));
  const pot = await db.get<{ hidden: number; name: string }>("SELECT hidden, name FROM pots WHERE id = ? AND user_id = ?", potId, userId);
  if (pot!.hidden) throw new Error(`pot "${pot!.name}" is retired`);
  await db.run(
    `INSERT INTO assignments (user_id, month, pot_id, cents) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, month, pot_id) DO UPDATE SET cents = excluded.cents`,
    userId,
    month,
    potId,
    cents
  );
  return { potId, month, cents };
}

/** What was assigned to one pot for a month (0 when nothing). */
export async function assignedToPot(db: Db, userId: number, month: string, potId: number): Promise<number> {
  const r = await db.get<{ cents: number }>("SELECT cents FROM assignments WHERE month = ? AND pot_id = ? AND user_id = ?", month, potId, userId);
  return r?.cents ?? 0;
}

/** Batched assignments for many pots at once: one GROUP BY query instead of
 *  one assignedToPot per pot. Pots with no row are absent from the map, so
 *  callers zero-fill in JS. */
export async function allPotAssigned(
  db: Db,
  userId: number,
  month: string,
  potIds: number[]
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (potIds.length === 0) return out;
  const placeholders = potIds.map(() => "?").join(",");
  const rows = await db.all<{ potId: number; cents: number }>(
    `SELECT pot_id AS potId, SUM(cents) AS cents FROM assignments
     WHERE month = ? AND user_id = ? AND pot_id IN (${placeholders})
     GROUP BY pot_id`,
    month,
    userId,
    ...potIds
  );
  for (const r of rows) out.set(r.potId, r.cents);
  return out;
}
