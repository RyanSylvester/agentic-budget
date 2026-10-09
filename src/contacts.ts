/** Contacts: people the user shares expenses with. Names are user data,
 *  stored here and rendered as data, never hardcoded. Pure DB functions that
 *  throw on bad input; routes translate that to 400s/404s. */
import type { Db } from "./db-interface";
import type { Contact, ContactBalance } from "./api-types";
export type { Contact, ContactBalance };
import { contactCredit, contactOwed } from "./settle";

function needName(name: unknown): string {
  const n = (name ?? "").toString().trim();
  if (!n) throw new Error("name required");
  if (n.length > 60) throw new Error("name must be 60 characters or fewer");
  return n;
}

export async function listContacts(db: Db, userId: number): Promise<Contact[]> {
  return db.all<Contact>("SELECT id, name FROM contacts WHERE user_id = ? ORDER BY name", userId);
}

/** Every contact with what they owe, oldest first, grouped by pot. */
export async function contactBalances(db: Db, userId: number): Promise<ContactBalance[]> {
  const out: ContactBalance[] = [];
  for (const c of await listContacts(db, userId)) {
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
