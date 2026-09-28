/** Sinking schedules: annual bills spread to a monthly contribution.
 *  One row per pot (expected amount, next due month, cadence). The monthly
 *  number is always derived, never stored: ceil((expected - saved so far) /
 *  months left). Miss a month or change the amount and the remaining months
 *  rescale automatically. Marking the bill paid rolls the due date forward
 *  one cadence period; no re-setup, ever. Agent-managed (CLI + API); the
 *  human UI only reads the derived line on the pot row. */
import type { Db } from "./db-interface";
import { resolvePotId, validMonth } from "./money";
import { shiftMonth } from "./close";
import { tableExists } from "./migrations";

export interface SinkingSchedule {
  id: number;
  potId: number;
  potName: string;
  expectedCents: number;
  dueMonth: string;
  cadenceMonths: number;
}

export type SinkingState = "funding" | "funded" | "overdue";

export interface SinkingStatus extends SinkingSchedule {
  /** Saved so far: cumulative assigned minus cumulative user spend. */
  balanceCents: number;
  /** max(0, expected - balance). */
  remainingCents: number;
  /** Contribution months from `month` up to (not including) the due month;
   *  1 when at or past the due month with the bill unpaid. */
  monthsLeft: number;
  /** ceil(remaining / monthsLeft); 0 when funded. */
  contributionCents: number;
  state: SinkingState;
}

const ROW = `SELECT s.id, s.pot_id AS potId, p.name AS potName,
                    s.expected_cents AS expectedCents, s.due_month AS dueMonth,
                    s.cadence_months AS cadenceMonths
             FROM sinking_schedules s JOIN pots p ON p.id = s.pot_id`;

/** The schedule for one pot, or null. Null when the table does not exist yet
 *  (hand-built test databases that never ran migrations behave as unscheduled). */
export async function getSchedule(db: Db, potId: number): Promise<SinkingSchedule | null> {
  if (!(await tableExists(db, "sinking_schedules"))) return null;
  return db.get<SinkingSchedule>(`${ROW} WHERE s.pot_id = ?`, potId);
}

/** The schedule by its own id, or null. */
export async function getScheduleById(db: Db, id: number): Promise<SinkingSchedule | null> {
  return db.get<SinkingSchedule>(`${ROW} WHERE s.id = ?`, id);
}

/** Every schedule, ordered by due month. */
export async function listSchedules(db: Db): Promise<SinkingSchedule[]> {
  if (!(await tableExists(db, "sinking_schedules"))) return [];
  return db.all<SinkingSchedule>(`${ROW} ORDER BY s.due_month, p.name`);
}

async function needScheduleTarget(db: Db, potRef: string | number): Promise<{ potId: number; name: string }> {
  const potId = await resolvePotId(db, String(potRef));
  const pot = (await db.get<{ name: string; hidden: number; is_assignable: number }>(
    "SELECT name, hidden, is_assignable FROM pots WHERE id = ?",
    potId
  ))!;
  if (pot.hidden) throw new Error(`pot "${pot.name}" is retired`);
  if (!pot.is_assignable) throw new Error(`"${pot.name}" is an income pot; sinking schedules are for spending pots`);
  return { potId, name: pot.name };
}

/** Create a schedule for a pot. Throws on bad input, unknown/retired pots,
 *  income pots, or a pot that already has one. */
export async function createSchedule(
  db: Db,
  potRef: string | number,
  expectedCents: number,
  dueMonth: string,
  cadenceMonths = 12
): Promise<SinkingSchedule> {
  const { potId, name } = await needScheduleTarget(db, potRef);
  if (!Number.isInteger(expectedCents) || expectedCents <= 0) {
    throw new Error(`bad expected amount "${expectedCents}"; expected a positive integer of cents`);
  }
  if (!validMonth(dueMonth)) throw new Error(`bad due month "${dueMonth}"; expected YYYY-MM`);
  if (!Number.isInteger(cadenceMonths) || cadenceMonths <= 0) {
    throw new Error(`bad cadence "${cadenceMonths}"; expected a positive integer of months`);
  }
  if (await getSchedule(db, potId)) throw new Error(`"${name}" already has a sinking schedule (remove it first to replace it)`);
  await db.get<{ id: number }>(
    "INSERT INTO sinking_schedules (pot_id, expected_cents, due_month, cadence_months) VALUES (?, ?, ?, ?) RETURNING id",
    potId,
    expectedCents,
    dueMonth,
    cadenceMonths
  );
  return (await getSchedule(db, potId))!;
}

/** Delete a pot's schedule. The pot and its history are untouched. */
export async function removeSchedule(db: Db, potRef: string | number): Promise<void> {
  const { potId, name } = await needScheduleTarget(db, potRef);
  const r = await db.run("DELETE FROM sinking_schedules WHERE pot_id = ?", potId);
  if (r.changes === 0) throw new Error(`"${name}" has no sinking schedule`);
}

/** Mark the bill paid: roll the due month forward one cadence period.
 *  The payment drained the balance, so contributions rebuild toward the
 *  next bill automatically. */
export async function markPaid(db: Db, potRef: string | number): Promise<SinkingSchedule> {
  const { potId, name } = await needScheduleTarget(db, potRef);
  const s = await getSchedule(db, potId);
  if (!s) throw new Error(`"${name}" has no sinking schedule`);
  const next = shiftMonth(s.dueMonth, s.cadenceMonths);
  await db.run("UPDATE sinking_schedules SET due_month = ? WHERE pot_id = ?", next, potId);
  return (await getSchedule(db, potId))!;
}

/** Saved so far for a pot as of a month: everything assigned up to and
 *  including `month`, minus the user's confirmed spend up to `month`. */
export async function potBalance(db: Db, potId: number, month: string): Promise<number> {
  const a = (await db.get<{ t: number }>(
    "SELECT COALESCE(SUM(cents), 0) AS t FROM assignments WHERE pot_id = ? AND month <= ?",
    potId,
    month
  ))!;
  const s = (await db.get<{ t: number }>(
    `SELECT COALESCE(SUM(-s.amount_cents), 0) AS t
     FROM splits s JOIN transactions t ON t.id = s.transaction_id
     WHERE s.pot_id = ? AND substr(t.date, 1, 7) <= ?
       AND t.status = 'confirmed' AND t.is_transfer = 0 AND t.voided = 0
       AND s.owner = 'user' AND s.amount_cents < 0`,
    potId,
    month
  ))!;
  return a.t - s.t;
}

/** Contribution months from `from` (inclusive) to `due` (exclusive);
 *  at least 1, so a past-due bill shows the full shortfall. */
export function monthsUntil(from: string, due: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [dy, dm] = due.split("-").map(Number);
  return Math.max(1, (dy - fy) * 12 + (dm - fm));
}

/** The derived schedule state for a pot in a month. Null when the pot has
 *  no schedule. */
export async function sinkingStatus(db: Db, potId: number, month: string): Promise<SinkingStatus | null> {
  const s = await getSchedule(db, potId);
  if (!s) return null;
  if (!validMonth(month)) throw new Error(`bad month "${month}"; expected YYYY-MM`);
  const balanceCents = await potBalance(db, potId, month);
  const remainingCents = Math.max(0, s.expectedCents - balanceCents);
  const monthsLeft = monthsUntil(month, s.dueMonth);
  const contributionCents = remainingCents === 0 ? 0 : Math.ceil(remainingCents / monthsLeft);
  const state: SinkingState =
    balanceCents >= s.expectedCents ? "funded" : month >= s.dueMonth ? "overdue" : "funding";
  return { ...s, balanceCents, remainingCents, monthsLeft, contributionCents, state };
}
