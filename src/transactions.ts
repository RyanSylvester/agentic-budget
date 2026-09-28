/** Manual transaction write paths for the Transactions page.
 *  Pure DB functions that throw on bad input; the routes translate that to
 *  400s. Every write ends with assertSplitsSum, like the other write paths. */
import type { Db } from "./db-interface";
import { assertSplitsSum, validDate } from "./money";

export interface TransactionInput {
  date?: string;
  accountId?: number;
  potId?: number | null;
  amountCents?: number;
  description?: string;
  isTransfer?: boolean;
  /** Contact the transaction is split with. Required when shareCents is set. */
  contactId?: number | null;
  /** The contact's share, same sign as amountCents. 0/undefined = no split. */
  shareCents?: number;
  /** Where the entry came from: "gmail" | "mention" | "manual" (default). */
  source?: string;
  /** "cleared" | "uncleared" (default). */
  cleared?: string;
  /** When set, the transaction is created pending_review with this reason. */
  reviewReason?: string | null;
  /** Idempotency key: the record route no-ops on a repeat external id. */
  externalId?: string | null;
  /** Who made the entry: "agent" or "user". The API route derives this from
   *  the auth identity; defaults to "user" (direct local calls). */
  enteredBy?: "agent" | "user";
}

async function needAccount(db: Db, userId: number, accountId: unknown): Promise<number> {
  const n = Number(accountId);
  if (!Number.isInteger(n) || n <= 0) throw new Error("accountId required");
  if (!(await db.get("SELECT 1 FROM accounts WHERE id = ? AND user_id = ?", n, userId))) throw new Error(`no account ${n}`);
  return n;
}

async function needPot(db: Db, userId: number, potId: unknown): Promise<number> {
  const n = Number(potId);
  if (!Number.isInteger(n) || n <= 0) throw new Error("potId required");
  if (!(await db.get("SELECT 1 FROM pots WHERE id = ? AND hidden = 0 AND user_id = ?", n, userId))) throw new Error(`no pot ${n}`);
  return n;
}

function needAmount(amountCents: unknown): number {
  const n = Math.round(Number(amountCents));
  if (!Number.isFinite(n) || n === 0) throw new Error("amountCents must be a nonzero integer");
  return n;
}

function checkShareCents(amountCents: number, shareCents: number): void {
  if (!Number.isInteger(shareCents)) throw new Error("shareCents must be an integer");
  if (shareCents === 0) return;
  if (Math.sign(shareCents) !== Math.sign(amountCents))
    throw new Error("shareCents must have the same sign as amountCents");
  if (Math.abs(shareCents) >= Math.abs(amountCents))
    throw new Error("shareCents must be smaller than the transaction amount");
}

async function needContact(db: Db, userId: number, contactId: unknown): Promise<number> {
  const n = Number(contactId);
  if (!Number.isInteger(n) || n <= 0) throw new Error("contactId required");
  if (!(await db.get("SELECT 1 FROM contacts WHERE id = ? AND user_id = ?", n, userId))) throw new Error(`no contact ${n}`);
  return n;
}

/** Validate the shared shape of a create/replace payload. Returns the
 *  normalized fields (throws on the first problem found). */
async function normalizeInput(db: Db, userId: number, input: TransactionInput): Promise<{
  date: string;
  accountId: number;
  potId: number | null;
  amountCents: number;
  description: string;
  isTransfer: boolean;
  contactId: number | null;
  shareCents: number;
  source: string;
  cleared: string;
  reviewReason: string | null;
  externalId: string | null;
}> {
  if (!input || typeof input !== "object") throw new Error("transaction body required");
  if (!validDate(input.date ?? "")) throw new Error(`bad date "${input.date}"; expected YYYY-MM-DD`);
  const accountId = await needAccount(db, userId, input.accountId);
  const amountCents = needAmount(input.amountCents);
  const description = (input.description ?? "").trim();
  if (!description) throw new Error("description required");
  const isTransfer = input.isTransfer === true;
  let potId: number | null = null;
  if (!isTransfer) {
    potId = await needPot(db, userId, input.potId);
  } else if (input.potId != null) {
    potId = await needPot(db, userId, input.potId);
  }
  const shareCents = Math.round(Number(input.shareCents ?? 0));
  let contactId: number | null = null;
  if (shareCents !== 0) {
    if (isTransfer) throw new Error("transfers cannot be split with a contact");
    contactId = await needContact(db, userId, input.contactId);
  } else if (input.contactId != null) {
    contactId = await needContact(db, userId, input.contactId);
  }
  checkShareCents(amountCents, shareCents);
  const source = input.source ?? "manual";
  if (!["gmail", "mention", "manual"].includes(source)) {
    throw new Error(`bad source "${input.source}"; expected gmail, mention, or manual`);
  }
  const cleared = input.cleared ?? "uncleared";
  if (!["cleared", "uncleared"].includes(cleared)) {
    throw new Error(`bad cleared "${input.cleared}"; expected cleared or uncleared`);
  }
  return { date: input.date as string, accountId, potId, amountCents, description, isTransfer, contactId, shareCents, source, cleared, reviewReason: input.reviewReason ?? null, externalId: input.externalId ?? null };
}

/** Insert the user (+ optional contact) splits for a transaction. */
async function insertSplits(
  db: Db,
  userId: number,
  txnId: number,
  potId: number | null,
  amountCents: number,
  contactId: number | null,
  shareCents: number
): Promise<void> {
  if (shareCents !== 0 && contactId !== null) {
    await db.run(`INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (?, ?, ?, ?, ?, ?)`, userId, txnId, potId, "user", null, amountCents - shareCents);
    await db.run(`INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (?, ?, ?, ?, ?, ?)`, userId, txnId, potId, "contact", contactId, shareCents);
  } else {
    await db.run(`INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (?, ?, ?, ?, ?, ?)`, userId, txnId, potId, "user", null, amountCents);
  }
}

/** Record a manually entered transaction for a user. Returns the new id.
 *  Sequential awaits, not a transaction: one writer per user (a single agent
 *  plus the human behind it), and every statement carries that user's
 *  user_id, so two users' sequences never touch the same rows. */
export async function createTransaction(db: Db, userId: number, input: TransactionInput): Promise<number> {
  const f = await normalizeInput(db, userId, input);
  const status = f.reviewReason ? "pending_review" : "confirmed";
  const enteredBy = input.enteredBy ?? "user";
  if (enteredBy !== "agent" && enteredBy !== "user") throw new Error("bad enteredBy");
  const t = await db.get<{ id: number }>(
    `INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, status, cleared, review_reason, is_transfer, external_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    userId,
    f.date,
    f.accountId,
    f.amountCents,
    f.description,
    f.source,
    enteredBy,
    status,
    f.cleared,
    f.reviewReason,
    f.isTransfer ? 1 : 0,
    f.externalId
  );
  await insertSplits(db, userId, t!.id, f.potId, f.amountCents, f.contactId, f.shareCents);
  await assertSplitsSum(db, userId, t!.id);
  return t!.id;
}

/** Why a transaction's money fields are frozen, or null when they can change.
 *  Editing amounts on cleared/reconciled rows would silently corrupt
 *  reconciliation; settled rows are append-only by design. */
export async function moneyLockReason(db: Db, userId: number, id: number): Promise<string | null> {
  const t = await db.get<{ cleared: string }>("SELECT cleared FROM transactions WHERE id = ? AND user_id = ?", id, userId);
  if (!t) return null;
  if (t.cleared !== "uncleared") return `already ${t.cleared}; amounts cannot change`;
  const alloc = await db.get(
    `SELECT 1 FROM settlement_allocations a JOIN splits s ON s.id = a.split_id
     WHERE s.transaction_id = ? AND a.user_id = ? AND s.user_id = ? LIMIT 1`,
    id,
    userId,
    userId
  );
  if (alloc) return "linked to a contact settlement; amounts cannot change";
  const st = await db.get("SELECT 1 FROM settlements WHERE transaction_id = ? AND user_id = ? LIMIT 1", id, userId);
  if (st) return "this is a settlement record; amounts cannot change";
  return null;
}

interface SplitRow {
  potId: number | null;
  owner: string;
  contactId: number | null;
  amountCents: number;
}

async function currentSplits(db: Db, userId: number, id: number): Promise<SplitRow[]> {
  return db.all<SplitRow>(
    "SELECT pot_id AS potId, owner, contact_id AS contactId, amount_cents AS amountCents FROM splits WHERE transaction_id = ? AND user_id = ? ORDER BY id",
    id,
    userId
  );
}

/** Replace a transaction's fields and rebuild its splits from the payload.
 *  Throws when the id is unknown, the payload is invalid, or the money
 *  fields changed on a locked transaction. Sequential awaits, not a
 *  transaction: one writer per user (a single agent plus the human behind
 *  it), and every statement carries that user's user_id. */
export async function updateTransaction(db: Db, userId: number, id: number, input: TransactionInput): Promise<void> {
  const cur = (await db.get("SELECT * FROM transactions WHERE id = ? AND user_id = ?", id, userId)) as any;
  if (!cur) throw new Error(`no transaction ${id}`);
  const f = await normalizeInput(db, userId, input);

  const want: SplitRow[] =
    f.shareCents !== 0 && f.contactId !== null
      ? [
          { potId: f.potId, owner: "user", contactId: null, amountCents: f.amountCents - f.shareCents },
          { potId: f.potId, owner: "contact", contactId: f.contactId, amountCents: f.shareCents },
        ]
      : [{ potId: f.potId, owner: "user", contactId: null, amountCents: f.amountCents }];
  const have = await currentSplits(db, userId, id);
  const splitsChanged =
    have.length !== want.length ||
    have.some((s, i) => s.potId !== want[i].potId || s.owner !== want[i].owner || s.contactId !== want[i].contactId || s.amountCents !== want[i].amountCents);
  const moneyChanged =
    f.amountCents !== cur.amount_cents || (f.isTransfer ? 1 : 0) !== cur.is_transfer || splitsChanged;
  if (moneyChanged) {
    const lock = await moneyLockReason(db, userId, id);
    if (lock) throw new Error(lock);
  }

  await db.run("UPDATE transactions SET date = ?, account_id = ?, amount_cents = ?, description = ?, is_transfer = ? WHERE id = ? AND user_id = ?", f.date, f.accountId, f.amountCents, f.description, f.isTransfer ? 1 : 0, id, userId);
  await db.run("DELETE FROM splits WHERE transaction_id = ? AND user_id = ?", id, userId);
  await insertSplits(db, cur.user_id, id, f.potId, f.amountCents, f.contactId, f.shareCents);
  await assertSplitsSum(db, userId, id);
}
