/** Pot management: create, rename, retarget, regroup, share config, delete.
 *  Deleting a pot never destroys history: its transactions, splits, and
 *  month assignments move to an "Uncategorized" pot (created on demand).
 *  Pure DB functions that throw on bad input; routes translate to 400s/404s. */
import type { Db, DbValue } from "./db-interface";
import { tableExists } from "./db-interface";

export type TargetType = "fixed" | "average_3mo" | "savings";

export interface PotInput {
  name?: unknown;
  group?: unknown;
  targetCents?: unknown;
  targetType?: unknown;
  /** Contact id this pot is shared with, or null to unshare. */
  contactId?: number | null;
  /** The contact's percentage share (0-100), or null. Requires contactId. */
  sharePct?: number | null;
  /** 1 to retire the pot, 0 to unhide it. */
  hidden?: number | null;
}

const TARGET_TYPES: TargetType[] = ["fixed", "average_3mo", "savings"];

function needName(name: unknown): string {
  const n = (name ?? "").toString().trim();
  if (!n) throw new Error("name required");
  if (n.length > 80) throw new Error("name must be 80 characters or fewer");
  return n;
}

function needGroup(group: unknown): string {
  const g = (group ?? "").toString().trim();
  if (!g) throw new Error("group required");
  if (g.length > 80) throw new Error("group must be 80 characters or fewer");
  return g;
}

function needTargetType(t: unknown): TargetType {
  const tt = (t ?? "fixed").toString();
  if (!TARGET_TYPES.includes(tt as TargetType)) throw new Error(`bad targetType "${tt}"`);
  return tt as TargetType;
}

function needTargetCents(c: unknown): number {
  const n = Math.round(Number(c ?? 0));
  if (!Number.isFinite(n) || n < 0) throw new Error("targetCents must be a non-negative integer");
  return n;
}

async function needShare(
  db: Db,
  userId: number,
  contactId: unknown,
  sharePct: unknown
): Promise<{ contactId: number | null; sharePct: number | null }> {
  if (contactId == null) {
    if (sharePct != null) throw new Error("sharePct needs a contact");
    return { contactId: null, sharePct: null };
  }
  const cid = Number(contactId);
  if (!Number.isInteger(cid) || cid <= 0) throw new Error("bad contactId");
  if (!(await db.get("SELECT 1 FROM contacts WHERE id = ? AND user_id = ?", cid, userId))) throw new Error(`no contact ${cid}`);
  if (sharePct == null) return { contactId: cid, sharePct: 50 };
  const pct = Number(sharePct);
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new Error("sharePct must be an integer from 0 to 100");
  return { contactId: cid, sharePct: pct };
}

export async function potExists(db: Db, userId: number, id: number): Promise<boolean> {
  return !!(await db.get("SELECT 1 FROM pots WHERE id = ? AND user_id = ?", id, userId));
}

/** Income-group pots receive money; assignments to them mean planned income
 *  and are excluded from assignedTotal and RTA. Only spending pots draw. */
function assignableForGroup(group: string): number {
  return group === "Income" ? 0 : 1;
}

/** Create a pot for a user. Returns the new id. */
export async function createPot(db: Db, userId: number, input: PotInput): Promise<number> {
  const name = needName(input.name);
  const group = needGroup(input.group ?? "Life");
  const targetType = needTargetType(input.targetType);
  const targetCents = needTargetCents(input.targetCents);
  const share = await needShare(db, userId, input.contactId, input.sharePct);
  const row = await db.get<{ id: number }>(
    `INSERT INTO pots (user_id, name, pot_group, target_type, target_cents, is_assignable, contact_id, share_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    userId,
    name,
    group,
    targetType,
    targetCents,
    assignableForGroup(group),
    share.contactId,
    share.sharePct
  );
  return row!.id;
}

/** Update a pot's name, group, target, or share config. */
export async function updatePot(db: Db, userId: number, id: number, input: PotInput): Promise<void> {
  if (!(await potExists(db, userId, id))) throw new Error(`no pot ${id}`);
  const sets: string[] = [];
  const params: DbValue[] = [];
  if (input.name !== undefined) {
    sets.push("name = ?");
    params.push(needName(input.name));
  }
  if (input.group !== undefined) {
    const g = needGroup(input.group);
    sets.push("pot_group = ?");
    params.push(g);
    // The assignable flag follows the group: Income pots hold planned income.
    sets.push("is_assignable = ?");
    params.push(assignableForGroup(g));
  }
  if (input.targetType !== undefined) {
    sets.push("target_type = ?");
    params.push(needTargetType(input.targetType));
  }
  if (input.targetCents !== undefined) {
    sets.push("target_cents = ?");
    params.push(needTargetCents(input.targetCents));
  }
  if (input.hidden !== undefined && input.hidden !== null) {
    const h = Number(input.hidden);
    if (h !== 0 && h !== 1) throw new Error(`bad hidden "${input.hidden}"; expected 0 or 1`);
    sets.push("hidden = ?");
    params.push(h);
  }
  if (input.contactId !== undefined || input.sharePct !== undefined) {
    const cur = (await db.get<{ contact_id: number | null; share_pct: number | null }>(
      "SELECT contact_id, share_pct FROM pots WHERE id = ? AND user_id = ?",
      id,
      userId
    ))!;
    // Explicitly unsharing (contactId: null) clears the old percent too;
    // otherwise the carried-over share_pct would fail validation.
    const pct = input.sharePct !== undefined ? input.sharePct : input.contactId === null ? null : cur.share_pct;
    const share = await needShare(
      db,
      userId,
      input.contactId !== undefined ? input.contactId : cur.contact_id,
      pct
    );
    sets.push("contact_id = ?", "share_pct = ?");
    params.push(share.contactId, share.sharePct);
  }
  if (sets.length === 0) return;
  await db.run(`UPDATE pots SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, ...params, id, userId);
}

export interface PotDeleteSummary {
  uncategorizedPotId: number;
  movedTransactions: number;
  movedAssignments: number;
}

/** The catch-all pot for a user's deleted pots' history. Created on demand. */
export async function uncategorizedPotId(db: Db, userId: number): Promise<number> {
  const found = await db.get<{ id: number }>("SELECT id FROM pots WHERE user_id = ? AND name = 'Uncategorized' AND hidden = 0", userId);
  if (found) return found.id;
  const row = await db.get<{ id: number }>(
    `INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES (?, 'Uncategorized', 'General', 'fixed', 0) RETURNING id`,
    userId
  );
  return row!.id;
}

/** Delete a pot, moving its history to the user's Uncategorized pot. Never destroys data.
 *  Sequential awaits, not a transaction: one writer per user (a single agent
 *  plus the human behind it), and every statement is scoped to that user's
 *  user_id, so two users' sequences never touch the same rows. D1 serializes
 *  concurrent writes on its primary; a second tab of the same user could
 *  already interleave before multi-user, and that has not changed. */
export async function deletePot(db: Db, userId: number, id: number): Promise<PotDeleteSummary> {
  const pot = await db.get<{ id: number; name: string }>("SELECT id, name FROM pots WHERE id = ? AND user_id = ?", id, userId);
  if (!pot) throw new Error(`no pot ${id}`);
  const uncat = await uncategorizedPotId(db, userId);
  if (uncat === id) throw new Error("the Uncategorized pot cannot be deleted");
  const txns = await db.run("UPDATE transactions SET pot_id = ? WHERE pot_id = ? AND user_id = ?", uncat, id, userId);
  await db.run("UPDATE splits SET pot_id = ? WHERE pot_id = ? AND user_id = ?", uncat, id, userId);
  const rows = await db.all<{ month: string; cents: number }>("SELECT month, cents FROM assignments WHERE pot_id = ? AND user_id = ?", id, userId);
  for (const r of rows) {
    await db.run(
      `INSERT INTO assignments (user_id, month, pot_id, cents) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, month, pot_id) DO UPDATE SET cents = cents + excluded.cents`,
      userId,
      r.month,
      uncat,
      r.cents
    );
  }
  await db.run("DELETE FROM assignments WHERE pot_id = ? AND user_id = ?", id, userId);
  // A sinking schedule is configuration, not history: it goes with the pot.
  // (Guarded for hand-built databases that never ran migrations.)
  if (await tableExists(db, "sinking_schedules")) {
    await db.run("DELETE FROM sinking_schedules WHERE pot_id = ? AND user_id = ?", id, userId);
  }
  await db.run("DELETE FROM pots WHERE id = ? AND user_id = ?", id, userId);
  return { uncategorizedPotId: uncat, movedTransactions: txns.changes, movedAssignments: rows.length };
}
