/** Pot management: create, rename, retarget, regroup, share config, delete.
 *  Deleting a pot never destroys history: its transactions, splits, and
 *  month assignments move to an "Uncategorized" pot (created on demand).
 *  Pure DB functions that throw on bad input; routes translate to 400s/404s. */
import type { Database } from "bun:sqlite";

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

function needShare(db: Database, contactId: unknown, sharePct: unknown): { contactId: number | null; sharePct: number | null } {
  if (contactId == null) {
    if (sharePct != null) throw new Error("sharePct needs a contact");
    return { contactId: null, sharePct: null };
  }
  const cid = Number(contactId);
  if (!Number.isInteger(cid) || cid <= 0) throw new Error("bad contactId");
  if (!db.query("SELECT 1 FROM contacts WHERE id = ?").get(cid)) throw new Error(`no contact ${cid}`);
  if (sharePct == null) return { contactId: cid, sharePct: 50 };
  const pct = Number(sharePct);
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new Error("sharePct must be an integer from 0 to 100");
  return { contactId: cid, sharePct: pct };
}

export function potExists(db: Database, id: number): boolean {
  return !!db.query("SELECT 1 FROM pots WHERE id = ?").get(id);
}

/** Create a pot. Returns the new id. */
export function createPot(db: Database, input: PotInput): number {
  const name = needName(input.name);
  const group = needGroup(input.group ?? "Life");
  const targetType = needTargetType(input.targetType);
  const targetCents = needTargetCents(input.targetCents);
  const share = needShare(db, input.contactId, input.sharePct);
  const row = db.query(
    "INSERT INTO pots (name, pot_group, target_type, target_cents, contact_id, share_pct) VALUES (?, ?, ?, ?, ?, ?) RETURNING id"
  ).get(name, group, targetType, targetCents, share.contactId, share.sharePct) as { id: number };
  return row.id;
}

/** Update a pot's name, group, target, or share config. */
export function updatePot(db: Database, id: number, input: PotInput): void {
  if (!potExists(db, id)) throw new Error(`no pot ${id}`);
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (input.name !== undefined) {
    sets.push("name = ?");
    params.push(needName(input.name));
  }
  if (input.group !== undefined) {
    sets.push("pot_group = ?");
    params.push(needGroup(input.group));
  }
  if (input.targetType !== undefined) {
    sets.push("target_type = ?");
    params.push(needTargetType(input.targetType));
  }
  if (input.targetCents !== undefined) {
    sets.push("target_cents = ?");
    params.push(needTargetCents(input.targetCents));
  }
  if (input.contactId !== undefined || input.sharePct !== undefined) {
    const cur = db.query("SELECT contact_id, share_pct FROM pots WHERE id = ?").get(id) as {
      contact_id: number | null;
      share_pct: number | null;
    };
    // Explicitly unsharing (contactId: null) clears the old percent too;
    // otherwise the carried-over share_pct would fail validation.
    const pct = input.sharePct !== undefined ? input.sharePct : input.contactId === null ? null : cur.share_pct;
    const share = needShare(
      db,
      input.contactId !== undefined ? input.contactId : cur.contact_id,
      pct
    );
    sets.push("contact_id = ?", "share_pct = ?");
    params.push(share.contactId, share.sharePct);
  }
  if (sets.length === 0) return;
  db.query(`UPDATE pots SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
}

export interface PotDeleteSummary {
  uncategorizedPotId: number;
  movedTransactions: number;
  movedAssignments: number;
}

/** The catch-all pot for deleted pots' history. Created on demand. */
export function uncategorizedPotId(db: Database): number {
  const found = db.query("SELECT id FROM pots WHERE name = 'Uncategorized' AND hidden = 0").get() as {
    id: number;
  } | null;
  if (found) return found.id;
  const row = db.query(
    "INSERT INTO pots (name, pot_group, target_type, target_cents) VALUES ('Uncategorized', 'General', 'fixed', 0) RETURNING id"
  ).get() as { id: number };
  return row.id;
}

/** Delete a pot, moving its history to Uncategorized. Never destroys data. */
export function deletePot(db: Database, id: number): PotDeleteSummary {
  const pot = db.query("SELECT id, name FROM pots WHERE id = ?").get(id) as { id: number; name: string } | null;
  if (!pot) throw new Error(`no pot ${id}`);
  const uncat = uncategorizedPotId(db);
  if (uncat === id) throw new Error("the Uncategorized pot cannot be deleted");
  return db.transaction(() => {
    const txns = db.query("UPDATE transactions SET pot_id = ? WHERE pot_id = ?").run(uncat, id);
    db.query("UPDATE splits SET pot_id = ? WHERE pot_id = ?").run(uncat, id);
    const rows = db.query("SELECT month, cents FROM assignments WHERE pot_id = ?").all(id) as {
      month: string;
      cents: number;
    }[];
    const upsert = db.query(
      `INSERT INTO assignments (month, pot_id, cents) VALUES (?, ?, ?)
       ON CONFLICT (month, pot_id) DO UPDATE SET cents = cents + excluded.cents`
    );
    for (const r of rows) upsert.run(r.month, uncat, r.cents);
    db.query("DELETE FROM assignments WHERE pot_id = ?").run(id);
    db.query("DELETE FROM pots WHERE id = ?").run(id);
    return { uncategorizedPotId: uncat, movedTransactions: Number(txns.changes), movedAssignments: rows.length };
  })();
}
