/** Month assignments: the agent assigns every dollar of income to a pot.
 *  `assign` upserts the pot's assigned total for the month — idempotent. */
import type { Database } from "bun:sqlite";
import { resolvePotId, validMonth } from "./money";

/** Set a pot's assigned total for a month. Throws on bad input,
 *  unknown pots, hidden pots, or non-assignable (Income-group) pots. */
export function assignToPot(db: Database, month: string, potIdOrName: string | number, cents: number): { potId: number; month: string; cents: number } {
  if (!validMonth(month)) throw new Error(`bad month "${month}"; expected YYYY-MM`);
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`bad amount "${cents}"; expected a non-negative integer of cents`);
  const potId = resolvePotId(db, String(potIdOrName));
  const pot = db.query("SELECT is_assignable, hidden, name FROM pots WHERE id = ?").get(potId) as {
    is_assignable: number; hidden: number; name: string;
  };
  if (pot.hidden) throw new Error(`pot "${pot.name}" is retired`);
  if (!pot.is_assignable) throw new Error(`pot "${pot.name}" is not assignable (income pots receive money; they are never assigned to)`);
  db.query("INSERT INTO assignments (month, pot_id, cents) VALUES (?, ?, ?) ON CONFLICT(month, pot_id) DO UPDATE SET cents = excluded.cents").run(month, potId, cents);
  return { potId, month, cents };
}

/** What was assigned to one pot for a month (0 when nothing). */
export function assignedToPot(db: Database, month: string, potId: number): number {
  const r = db.query("SELECT cents FROM assignments WHERE month = ? AND pot_id = ?").get(month, potId) as { cents: number } | null;
  return r?.cents ?? 0;
}
