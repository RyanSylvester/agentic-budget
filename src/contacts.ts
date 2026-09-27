/** Contacts: people the user shares expenses with. Names are user data,
 *  stored here and rendered as data, never hardcoded. Pure DB functions that
 *  throw on bad input; routes translate that to 400s/404s. */
import type { Database } from "bun:sqlite";
import { contactCredit, contactOwed } from "./settle";

export interface Contact {
  id: number;
  name: string;
}

export interface ContactBalance extends Contact {
  totalOwedCents: number;
  creditCents: number;
  oldest: string | null;
  byPot: { pot: string; cents: number }[];
}

function needName(name: unknown): string {
  const n = (name ?? "").toString().trim();
  if (!n) throw new Error("name required");
  if (n.length > 60) throw new Error("name must be 60 characters or fewer");
  return n;
}

export function listContacts(db: Database): Contact[] {
  return db.query("SELECT id, name FROM contacts ORDER BY name").all() as Contact[];
}

/** Every contact with what they owe, oldest first, grouped by pot. */
export function contactBalances(db: Database): ContactBalance[] {
  return listContacts(db).map((c) => {
    const owed = contactOwed(db, c.id);
    const byPot = new Map<string, number>();
    for (const o of owed) {
      const name = o.potName ?? "Uncategorized";
      byPot.set(name, (byPot.get(name) ?? 0) + o.owedCents);
    }
    return {
      ...c,
      totalOwedCents: owed.reduce((a, o) => a + o.owedCents, 0),
      creditCents: contactCredit(db, c.id),
      oldest: owed[0]?.date ?? null,
      byPot: [...byPot.entries()]
        .map(([pot, cents]) => ({ pot, cents }))
        .sort((a, b) => b.cents - a.cents),
    };
  });
}

export function createContact(db: Database, name: unknown): number {
  const n = needName(name);
  const row = db.query("INSERT INTO contacts (name) VALUES (?) RETURNING id").get(n) as { id: number };
  return row.id;
}

export function renameContact(db: Database, id: number, name: unknown): void {
  const n = needName(name);
  const r = db.query("UPDATE contacts SET name = ? WHERE id = ?").run(n, id);
  if (r.changes === 0) throw new Error(`no contact ${id}`);
}

/** Delete a contact. Blocked while any pot share config or split references
 *  them, so history can never dangle: remove those references first. */
export function deleteContact(db: Database, id: number): void {
  const contact = db.query("SELECT id, name FROM contacts WHERE id = ?").get(id) as Contact | null;
  if (!contact) throw new Error(`no contact ${id}`);
  const pots = db.query("SELECT COUNT(*) AS n FROM pots WHERE contact_id = ?").get(id) as { n: number };
  const splits = db.query("SELECT COUNT(*) AS n FROM splits WHERE contact_id = ?").get(id) as { n: number };
  if (pots.n > 0 || splits.n > 0) {
    const bits: string[] = [];
    if (pots.n > 0) bits.push(`${pots.n} pot${pots.n === 1 ? "" : "s"}`);
    if (splits.n > 0) bits.push(`${splits.n} transaction split${splits.n === 1 ? "" : "s"}`);
    throw new Error(
      `${contact.name} is still used by ${bits.join(" and ")}. Remove those references first.`
    );
  }
  db.query("DELETE FROM contacts WHERE id = ?").run(id);
}
