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

/** Group ordering lives entirely in the group_order table as user data:
 *  no group names or orders are hardcoded anywhere. Groups emerge from
 *  pot_group labels on pots; these helpers only position whatever exists.
 *  (Guarded for hand-built databases that never ran migrations.) */
async function groupOrderTable(db: Db): Promise<boolean> {
  return tableExists(db, "group_order");
}

/** Ensure the user's group_order has a row for `group`; new groups go last. */
export async function ensureGroupOrderRow(db: Db, userId: number, group: string): Promise<void> {
  if (!(await groupOrderTable(db))) return;
  const row = await db.get("SELECT 1 FROM group_order WHERE user_id = ? AND group_name = ?", userId, group);
  if (row) return;
  const mx = await db.get<{ m: number | null }>("SELECT MAX(position) AS m FROM group_order WHERE user_id = ?", userId);
  await db.run("INSERT INTO group_order (user_id, group_name, position) VALUES (?, ?, ?)", userId, group, (mx?.m ?? -1) + 1);
}

/** Drop the group_order row for `group` when the user has no pots left in it. */
export async function pruneEmptyGroup(db: Db, userId: number, group: string): Promise<void> {
  if (!(await groupOrderTable(db))) return;
  const left = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pots WHERE user_id = ? AND pot_group = ?", userId, group);
  if ((left?.n ?? 0) === 0) {
    await db.run("DELETE FROM group_order WHERE user_id = ? AND group_name = ?", userId, group);
  }
}

/** The groups a user actually has, from their pots and their order rows. */
export async function knownGroups(db: Db, userId: number): Promise<string[]> {
  const rows = await db.all<{ group_name: string }>(
    `SELECT group_name FROM group_order WHERE user_id = ?
     UNION
     SELECT pot_group AS group_name FROM pots WHERE user_id = ?`,
    userId,
    userId
  );
  return rows.map((r) => r.group_name);
}

/** Replace the user's group display order with `groups`, normalized to
 *  0,1,2... Existing groups the user has but did not list keep their
 *  relative order after the listed ones. Unknown names are rejected: the
 *  caller can read the real groups first, so a miss is a typo, not intent. */
export async function setGroupOrder(db: Db, userId: number, groups: unknown): Promise<string[]> {
  if (!(await groupOrderTable(db))) throw new Error("group ordering is not set up; run migrations first");
  if (!Array.isArray(groups)) throw new Error("groups must be an array of group names");
  const clean: string[] = [];
  for (const g of groups) {
    const name = (g ?? "").toString().trim();
    if (!name) throw new Error("group names must not be blank");
    if (name.length > 80) throw new Error("group names must be 80 characters or fewer");
    if (!clean.includes(name)) clean.push(name);
  }
  if (clean.length === 0) throw new Error("at least one group name is required");
  const known = await knownGroups(db, userId);
  for (const name of clean) {
    if (!known.includes(name)) throw new Error(`unknown group "${name}"; known groups: ${known.join(", ") || "(none)"}`);
  }
  const existing = await db.all<{ group_name: string }>(
    "SELECT group_name FROM group_order WHERE user_id = ? ORDER BY position",
    userId
  );
  const ordered = [...clean];
  for (const e of existing) if (!ordered.includes(e.group_name)) ordered.push(e.group_name);
  await db.run("DELETE FROM group_order WHERE user_id = ?", userId);
  // One multi-row INSERT instead of one per group.
  const values = ordered.map(() => "(?, ?, ?)").join(",");
  const params: DbValue[] = [];
  ordered.forEach((g, i) => params.push(userId, g, i));
  await db.run(`INSERT INTO group_order (user_id, group_name, position) VALUES ${values}`, ...params);
  return ordered;
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
  // A brand-new group label goes last in the user's group order.
  await ensureGroupOrderRow(db, userId, group);
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
  // A pot moving groups keeps the order table in sync: the new group goes
  // last if unseen, and the old group drops out when emptied.
  let oldGroup: string | null = null;
  let newGroup: string | null = null;
  if (input.group !== undefined) {
    newGroup = needGroup(input.group);
    oldGroup = (await db.get<{ pot_group: string }>("SELECT pot_group FROM pots WHERE id = ? AND user_id = ?", id, userId))!.pot_group;
    sets.push("pot_group = ?");
    params.push(newGroup);
    // The assignable flag follows the group: Income pots hold planned income.
    sets.push("is_assignable = ?");
    params.push(assignableForGroup(newGroup));
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
  if (newGroup !== null) {
    await ensureGroupOrderRow(db, userId, newGroup);
    if (oldGroup !== null && oldGroup !== newGroup) await pruneEmptyGroup(db, userId, oldGroup);
  }
}

export interface PotDeleteSummary {
  uncategorizedPotId: number;
  movedTransactions: number;
  movedAssignments: number;
}

/** The catch-all pot for a user's deleted pots' history. Created on demand.
 *  It lands in the user's most-used group (never a hardcoded "General"),
 *  so no stray group section appears from a pot the user never placed. */
export async function uncategorizedPotId(db: Db, userId: number): Promise<number> {
  const found = await db.get<{ id: number }>("SELECT id FROM pots WHERE user_id = ? AND name = 'Uncategorized' AND hidden = 0", userId);
  if (found) return found.id;
  const common = await db.get<{ pot_group: string }>(
    `SELECT pot_group FROM pots WHERE user_id = ? AND hidden = 0
     GROUP BY pot_group ORDER BY COUNT(*) DESC LIMIT 1`,
    userId
  );
  const group = common?.pot_group ?? "General";
  const row = await db.get<{ id: number }>(
    `INSERT INTO pots (user_id, name, pot_group, target_type, target_cents) VALUES (?, 'Uncategorized', ?, 'average_3mo', 0) RETURNING id`,
    userId, group
  );
  await ensureGroupOrderRow(db, userId, group);
  return row!.id;
}

/** Delete a pot, moving its history to the user's Uncategorized pot. Never destroys data.
 *  Sequential awaits, not a transaction: one writer per user (a single agent
 *  plus the human behind it), and every statement is scoped to that user's
 *  user_id, so two users' sequences never touch the same rows. D1 serializes
 *  concurrent writes on its primary; a second tab of the same user could
 *  already interleave before multi-user, and that has not changed. */
export async function deletePot(db: Db, userId: number, id: number): Promise<PotDeleteSummary> {
  const pot = await db.get<{ id: number; name: string; pot_group: string }>("SELECT id, name, pot_group FROM pots WHERE id = ? AND user_id = ?", id, userId);
  if (!pot) throw new Error(`no pot ${id}`);
  const uncat = await uncategorizedPotId(db, userId);
  if (uncat === id) throw new Error("the Uncategorized pot cannot be deleted");
  const txns = await db.run("UPDATE transactions SET pot_id = ? WHERE pot_id = ? AND user_id = ?", uncat, id, userId);
  await db.run("UPDATE splits SET pot_id = ? WHERE pot_id = ? AND user_id = ?", uncat, id, userId);
  // Move the pot's assignments to Uncategorized in one statement: the
  // ON CONFLICT clause adds to any existing month row, exactly like the
  // old per-month loop.
  const moved = await db.run(
    `INSERT INTO assignments (user_id, month, pot_id, cents)
     SELECT user_id, month, ? AS pot_id, cents FROM assignments WHERE pot_id = ? AND user_id = ?
     ON CONFLICT (user_id, month, pot_id) DO UPDATE SET cents = cents + excluded.cents`,
    uncat,
    id,
    userId
  );
  await db.run("DELETE FROM assignments WHERE pot_id = ? AND user_id = ?", id, userId);
  // A sinking schedule is configuration, not history: it goes with the pot.
  // (Guarded for hand-built databases that never ran migrations.)
  if (await tableExists(db, "sinking_schedules")) {
    await db.run("DELETE FROM sinking_schedules WHERE pot_id = ? AND user_id = ?", id, userId);
  }
  await db.run("DELETE FROM pots WHERE id = ? AND user_id = ?", id, userId);
  await pruneEmptyGroup(db, userId, pot.pot_group);
  return { uncategorizedPotId: uncat, movedTransactions: txns.changes, movedAssignments: moved.changes };
}
