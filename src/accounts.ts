/** Accounts: the user's real-world bank and card accounts. Pure DB functions
 *  that throw on bad input; routes translate that to 400s/404s. There is no
 *  opening balance: an account starts at zero and the first reconcile (or the
 *  first recorded transactions) brings it in line with the bank. */
import type { Db } from "./db-interface";
import type { Account, AccountType } from "./api-types";

export const ACCOUNT_TYPES: readonly AccountType[] = ["chequing", "savings", "credit_card"];

function needName(name: unknown): string {
  const n = (name ?? "").toString().trim();
  if (!n) throw new Error("name required");
  if (n.length > 60) throw new Error("name must be 60 characters or fewer");
  return n;
}

function needType(type: unknown): AccountType {
  if (!ACCOUNT_TYPES.includes(type as AccountType)) throw new Error(`type must be one of ${ACCOUNT_TYPES.join(", ")}`);
  return type as AccountType;
}

/** Optional last four digits: blank means none. */
function optLast4(last4: unknown): string | null {
  if (last4 === undefined || last4 === null) return null;
  const s = last4.toString().trim();
  if (!s) return null;
  if (!/^\d{4}$/.test(s)) throw new Error("last4 must be exactly 4 digits");
  return s;
}

/** Create an account; returns it in the GET /api/accounts item shape. */
export async function createAccount(db: Db, userId: number, input: { name?: unknown; type?: unknown; last4?: unknown }): Promise<Account> {
  const name = needName(input.name);
  const type = needType(input.type);
  const last4 = optLast4(input.last4);
  const row = await db.get<{ id: number }>(
    "INSERT INTO accounts (user_id, name, type, last4) VALUES (?, ?, ?, ?) RETURNING id",
    userId,
    name,
    type,
    last4
  );
  return { id: row!.id, name, type, last4, workingBalanceCents: 0, clearedBalanceCents: 0, lastReconciledAt: null };
}

/** Rename an account or change its last four digits. Type is fixed once
 *  created, since balances read differently for cards. */
export async function updateAccount(db: Db, userId: number, id: number, input: { name?: unknown; last4?: unknown }): Promise<void> {
  const existing = await db.get<{ name: string; last4: string | null }>("SELECT name, last4 FROM accounts WHERE id = ? AND user_id = ?", id, userId);
  if (!existing) throw new Error(`no account ${id}`);
  const name = input.name === undefined ? existing.name : needName(input.name);
  const last4 = input.last4 === undefined ? existing.last4 : optLast4(input.last4);
  await db.run("UPDATE accounts SET name = ?, last4 = ? WHERE id = ? AND user_id = ?", name, last4, id, userId);
}
