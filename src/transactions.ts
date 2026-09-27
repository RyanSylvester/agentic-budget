/** Manual transaction write paths for the Transactions page.
 *  Pure DB functions that throw on bad input; the routes translate that to
 *  400s. Every write ends with assertSplitsSum, like the other write paths. */
import type { Database } from "bun:sqlite";
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
}

function needAccount(db: Database, accountId: unknown): number {
  const n = Number(accountId);
  if (!Number.isInteger(n) || n <= 0) throw new Error("accountId required");
  if (!db.query("SELECT 1 FROM accounts WHERE id = ?").get(n)) throw new Error(`no account ${n}`);
  return n;
}

function needPot(db: Database, potId: unknown): number {
  const n = Number(potId);
  if (!Number.isInteger(n) || n <= 0) throw new Error("potId required");
  if (!db.query("SELECT 1 FROM pots WHERE id = ? AND hidden = 0").get(n)) throw new Error(`no pot ${n}`);
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

function needContact(db: Database, contactId: unknown): number {
  const n = Number(contactId);
  if (!Number.isInteger(n) || n <= 0) throw new Error("contactId required");
  if (!db.query("SELECT 1 FROM contacts WHERE id = ?").get(n)) throw new Error(`no contact ${n}`);
  return n;
}

/** Validate the shared shape of a create/replace payload. Returns the
 *  normalized fields (throws on the first problem found). */
function normalizeInput(db: Database, input: TransactionInput): {
  date: string;
  accountId: number;
  potId: number | null;
  amountCents: number;
  description: string;
  isTransfer: boolean;
  contactId: number | null;
  shareCents: number;
} {
  if (!input || typeof input !== "object") throw new Error("transaction body required");
  if (!validDate(input.date ?? "")) throw new Error(`bad date "${input.date}"; expected YYYY-MM-DD`);
  const accountId = needAccount(db, input.accountId);
  const amountCents = needAmount(input.amountCents);
  const description = (input.description ?? "").trim();
  if (!description) throw new Error("description required");
  const isTransfer = input.isTransfer === true;
  let potId: number | null = null;
  if (!isTransfer) {
    potId = needPot(db, input.potId);
  } else if (input.potId != null) {
    potId = needPot(db, input.potId);
  }
  const shareCents = Math.round(Number(input.shareCents ?? 0));
  let contactId: number | null = null;
  if (shareCents !== 0) {
    if (isTransfer) throw new Error("transfers cannot be split with a contact");
    contactId = needContact(db, input.contactId);
  } else if (input.contactId != null) {
    contactId = needContact(db, input.contactId);
  }
  checkShareCents(amountCents, shareCents);
  return { date: input.date as string, accountId, potId, amountCents, description, isTransfer, contactId, shareCents };
}

/** Insert the user (+ optional contact) splits for a transaction. */
function insertSplits(db: Database, txnId: number, potId: number | null, amountCents: number, contactId: number | null, shareCents: number): void {
  const ins = db.query("INSERT INTO splits (transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (?, ?, ?, ?, ?)");
  if (shareCents !== 0 && contactId !== null) {
    ins.run(txnId, potId, "user", null, amountCents - shareCents);
    ins.run(txnId, potId, "contact", contactId, shareCents);
  } else {
    ins.run(txnId, potId, "user", null, amountCents);
  }
}

/** Record a manually entered transaction. Returns the new id. */
export function createTransaction(db: Database, input: TransactionInput): number {
  const f = normalizeInput(db, input);
  return db.transaction(() => {
    const t = db.query(
      `INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared, is_transfer)
       VALUES (?, ?, ?, ?, 'manual', 'user', 'confirmed', 'uncleared', ?) RETURNING id`
    ).get(f.date, f.accountId, f.amountCents, f.description, f.isTransfer ? 1 : 0) as { id: number };
    insertSplits(db, t.id, f.potId, f.amountCents, f.contactId, f.shareCents);
    assertSplitsSum(db, t.id);
    return t.id;
  })();
}

/** Why a transaction's money fields are frozen, or null when they can change.
 *  Editing amounts on cleared/reconciled rows would silently corrupt
 *  reconciliation; settled rows are append-only by design. */
export function moneyLockReason(db: Database, id: number): string | null {
  const t = db.query("SELECT cleared FROM transactions WHERE id = ?").get(id) as { cleared: string } | null;
  if (!t) return null;
  if (t.cleared !== "uncleared") return `already ${t.cleared}; amounts cannot change`;
  const alloc = db.query(
    `SELECT 1 FROM settlement_allocations a JOIN splits s ON s.id = a.split_id
     WHERE s.transaction_id = ? LIMIT 1`
  ).get(id);
  if (alloc) return "linked to a contact settlement; amounts cannot change";
  const st = db.query("SELECT 1 FROM settlements WHERE transaction_id = ? LIMIT 1").get(id);
  if (st) return "this is a settlement record; amounts cannot change";
  return null;
}

interface SplitRow {
  potId: number | null;
  owner: string;
  contactId: number | null;
  amountCents: number;
}

function currentSplits(db: Database, id: number): SplitRow[] {
  return db.query(
    "SELECT pot_id AS potId, owner, contact_id AS contactId, amount_cents AS amountCents FROM splits WHERE transaction_id = ? ORDER BY id"
  ).all(id) as SplitRow[];
}

/** Replace a transaction's fields and rebuild its splits from the payload.
 *  Throws when the id is unknown, the payload is invalid, or the money
 *  fields changed on a locked transaction. */
export function updateTransaction(db: Database, id: number, input: TransactionInput): void {
  const cur = db.query("SELECT * FROM transactions WHERE id = ?").get(id) as any;
  if (!cur) throw new Error(`no transaction ${id}`);
  const f = normalizeInput(db, input);

  const want: SplitRow[] =
    f.shareCents !== 0 && f.contactId !== null
      ? [
          { potId: f.potId, owner: "user", contactId: null, amountCents: f.amountCents - f.shareCents },
          { potId: f.potId, owner: "contact", contactId: f.contactId, amountCents: f.shareCents },
        ]
      : [{ potId: f.potId, owner: "user", contactId: null, amountCents: f.amountCents }];
  const have = currentSplits(db, id);
  const splitsChanged =
    have.length !== want.length ||
    have.some((s, i) => s.potId !== want[i].potId || s.owner !== want[i].owner || s.contactId !== want[i].contactId || s.amountCents !== want[i].amountCents);
  const moneyChanged =
    f.amountCents !== cur.amount_cents || (f.isTransfer ? 1 : 0) !== cur.is_transfer || splitsChanged;
  if (moneyChanged) {
    const lock = moneyLockReason(db, id);
    if (lock) throw new Error(lock);
  }

  db.transaction(() => {
    db.query("UPDATE transactions SET date = ?, account_id = ?, amount_cents = ?, description = ?, is_transfer = ? WHERE id = ?").run(
      f.date,
      f.accountId,
      f.amountCents,
      f.description,
      f.isTransfer ? 1 : 0,
      id
    );
    db.query("DELETE FROM splits WHERE transaction_id = ?").run(id);
    insertSplits(db, id, f.potId, f.amountCents, f.contactId, f.shareCents);
    assertSplitsSum(db, id);
  })();
}
