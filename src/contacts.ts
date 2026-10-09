/** Contacts: people the user shares expenses with. Names are user data,
 *  stored here and rendered as data, never hardcoded. Pure DB functions that
 *  throw on bad input; routes translate that to 400s/404s. */
import type { Db } from "./db-interface";
import type { Contact, ContactBalance, ContactLedger, ContactLedgerEntry } from "./api-types";
export type { Contact, ContactBalance, ContactLedger, ContactLedgerEntry };
import { contactCredit, contactOwed } from "./settle";

function needName(name: unknown): string {
  const n = (name ?? "").toString().trim();
  if (!n) throw new Error("name required");
  if (n.length > 60) throw new Error("name must be 60 characters or fewer");
  return n;
}

/** The user's contacts by name. Archived contacts are left out unless
 *  asked for. */
export async function listContacts(db: Db, userId: number, opts: { includeArchived?: boolean } = {}): Promise<Contact[]> {
  return db.all<Contact>(
    `SELECT id, name FROM contacts WHERE user_id = ? ${opts.includeArchived ? "" : "AND archived = 0"} ORDER BY name`,
    userId
  );
}

/** Every contact with what they owe, oldest first, grouped by pot.
 *  Archived contacts are included only with includeArchived. */
export async function contactBalances(db: Db, userId: number, opts: { includeArchived?: boolean } = {}): Promise<ContactBalance[]> {
  const out: ContactBalance[] = [];
  const contacts = await db.all<Contact & { archived: number }>(
    `SELECT id, name, archived FROM contacts WHERE user_id = ? ${opts.includeArchived ? "" : "AND archived = 0"} ORDER BY name`,
    userId
  );
  for (const { archived, ...c } of contacts) {
    const owed = await contactOwed(db, userId, c.id);
    const byPot = new Map<string, number>();
    for (const o of owed) {
      // Splits always reference a real pot; the fallback is a safety net that
      // should never be user-visible in practice.
      const name = o.potName ?? "(no pot)";
      byPot.set(name, (byPot.get(name) ?? 0) + o.owedCents);
    }
    out.push({
      ...c,
      totalOwedCents: owed.reduce((a, o) => a + o.owedCents, 0),
      creditCents: await contactCredit(db, userId, c.id),
      oldest: owed[0]?.date ?? null,
      byPot: [...byPot.entries()]
        .map(([pot, cents]) => ({ pot, cents }))
        .sort((a, b) => b.cents - a.cents),
      archived: archived === 1,
    });
  }
  return out;
}

export async function createContact(db: Db, userId: number, name: unknown): Promise<number> {
  const n = needName(name);
  const row = await db.get<{ id: number }>(`INSERT INTO contacts (user_id, name) VALUES (?, ?) RETURNING id`, userId, n);
  return row!.id;
}

export async function renameContact(db: Db, userId: number, id: number, name: unknown): Promise<void> {
  const n = needName(name);
  const r = await db.run("UPDATE contacts SET name = ? WHERE id = ? AND user_id = ?", n, id, userId);
  if (r.changes === 0) throw new Error(`no contact ${id}`);
}

/** Delete a contact. Blocked while any pot share config or split references
 *  them, so history can never dangle: remove those references first. */
export async function deleteContact(db: Db, userId: number, id: number): Promise<void> {
  const contact = await db.get<Contact>("SELECT id, name FROM contacts WHERE id = ? AND user_id = ?", id, userId);
  if (!contact) throw new Error(`no contact ${id}`);
  const pots = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pots WHERE contact_id = ? AND user_id = ?", id, userId);
  const splits = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM splits WHERE contact_id = ? AND user_id = ?", id, userId);
  if (pots!.n > 0 || splits!.n > 0) {
    const bits: string[] = [];
    if (pots!.n > 0) bits.push(`${pots!.n} pot${pots!.n === 1 ? "" : "s"}`);
    if (splits!.n > 0) bits.push(`${splits!.n} transaction split${splits!.n === 1 ? "" : "s"}`);
    throw new Error(
      `${contact.name} is still used by ${bits.join(" and ")}. Remove those references first.`
    );
  }
  await db.run("DELETE FROM contacts WHERE id = ? AND user_id = ?", id, userId);
}

/** Archive or restore a contact. Archiving hides them from the Sharing page
 *  and the split picker while keeping every split and settlement. Refused
 *  while they still have an open balance either way: settle up first, so
 *  money owed never disappears from view. */
export async function setContactArchived(db: Db, userId: number, id: number, archived: boolean): Promise<void> {
  const contact = await db.get<Contact>("SELECT id, name FROM contacts WHERE id = ? AND user_id = ?", id, userId);
  if (!contact) throw new Error(`no contact ${id}`);
  if (archived) {
    const owed = (await contactOwed(db, userId, id)).reduce((a, o) => a + o.owedCents, 0);
    const net = owed - (await contactCredit(db, userId, id));
    if (net !== 0) throw new Error(`${contact.name} still has an open balance. Settle up before archiving.`);
  }
  await db.run("UPDATE contacts SET archived = ? WHERE id = ? AND user_id = ?", archived ? 1 : 0, id, userId);
}

/** What makes up a contact's balance, newest first: each shared transaction
 *  (their share and what is still unpaid of it) and each settlement either
 *  way. Settlement transactions are listed once, as settlements, never as
 *  shares. Voided transactions are left out, as they are from the balance. */
export async function contactLedger(db: Db, userId: number, id: number): Promise<ContactLedger> {
  const contact = await db.get<{ id: number }>("SELECT id FROM contacts WHERE id = ? AND user_id = ?", id, userId);
  if (!contact) throw new Error(`no contact ${id}`);
  const shares = await db.all<{ transactionId: number; date: string; description: string; potName: string | null; shareCents: number; paidCents: number }>(
    `SELECT t.id AS transactionId, t.date, t.description, p.name AS potName,
            -s.amount_cents AS shareCents, COALESCE(SUM(a.amount_cents), 0) AS paidCents
     FROM splits s
     JOIN transactions t ON t.id = s.transaction_id AND t.user_id = ?
     LEFT JOIN pots p ON p.id = s.pot_id AND p.user_id = ?
     LEFT JOIN settlement_allocations a ON a.split_id = s.id AND a.user_id = ?
     WHERE s.user_id = ? AND s.owner = 'contact' AND s.contact_id = ? AND s.amount_cents < 0 AND t.voided = 0
       AND NOT EXISTS (SELECT 1 FROM settlements st WHERE st.transaction_id = t.id AND st.user_id = ?)
     GROUP BY s.id`,
    userId, userId, userId, userId, id, userId
  );
  const settlements = await db.all<{ settlementId: number; transactionId: number; date: string; description: string; accountName: string; amountCents: number }>(
    `SELECT st.id AS settlementId, t.id AS transactionId, t.date, t.description, a.name AS accountName, st.amount_cents AS amountCents
     FROM settlements st
     JOIN transactions t ON t.id = st.transaction_id AND t.user_id = ?
     JOIN accounts a ON a.id = t.account_id AND a.user_id = ?
     WHERE st.user_id = ? AND t.voided = 0
       AND EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id AND s.owner = 'contact' AND s.contact_id = ? AND s.user_id = ?)`,
    userId, userId, userId, id, userId
  );
  const entries: (ContactLedgerEntry & { order: number })[] = [
    ...shares.map((r) => ({
      kind: "share" as const,
      transactionId: r.transactionId,
      date: r.date,
      description: r.description,
      potName: r.potName,
      shareCents: r.shareCents,
      outstandingCents: Math.max(0, r.shareCents - r.paidCents),
      order: r.transactionId,
    })),
    ...settlements.map((r) => ({ kind: "settlement" as const, ...r, order: r.transactionId })),
  ];
  entries.sort((a, b) => (a.date === b.date ? b.order - a.order : a.date < b.date ? 1 : -1));
  return { contactId: id, entries: entries.map(({ order, ...e }) => e as ContactLedgerEntry) };
}
