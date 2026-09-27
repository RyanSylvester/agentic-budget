/** The pre-migration migrateDb, preserved verbatim for the baseline test:
 *  this is the ad-hoc ALTER-chain code path a scratch DB is built through
 *  before the new versioned runner is run against it. */
import type { Database } from "bun:sqlite";

function getSetting(db: Database, key: string): string | null {
  const r = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  return r?.value ?? null;
}

export function oldMigrateDb(fresh: Database, schemaSql: string): void {

  const schema = schemaSql;
  fresh.exec(schema);
  // Lightweight migrations for databases created before a column existed.
  const cols = fresh.query("PRAGMA table_info(transactions)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "cleared")) {
    fresh.exec("ALTER TABLE transactions ADD COLUMN cleared TEXT NOT NULL DEFAULT 'uncleared'");
  }
  if (!cols.some((c) => c.name === "review_reason")) {
    fresh.exec("ALTER TABLE transactions ADD COLUMN review_reason TEXT");
  }
  if (!cols.some((c) => c.name === "is_transfer")) {
    fresh.exec("ALTER TABLE transactions ADD COLUMN is_transfer INTEGER NOT NULL DEFAULT 0");
  }
  // Soft-delete flag for retired pots (history kept, hidden from views).
  const potCols = fresh.query("PRAGMA table_info(pots)").all() as { name: string }[];
  if (!potCols.some((c) => c.name === "hidden")) {
    fresh.exec("ALTER TABLE pots ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
  }
  // Income-group pots receive money; assignments to them mean planned
  // income and are excluded from assignedTotal and RTA.
  if (!potCols.some((c) => c.name === "is_assignable")) {
    fresh.exec("ALTER TABLE pots ADD COLUMN is_assignable INTEGER NOT NULL DEFAULT 1");
  }
  fresh.exec("UPDATE pots SET is_assignable = 0 WHERE pot_group = 'Income'");
  // Month assignments ledger.
  fresh.exec(`CREATE TABLE IF NOT EXISTS assignments (
    month    TEXT NOT NULL,
    pot_id   INTEGER NOT NULL REFERENCES pots(id),
    cents    INTEGER NOT NULL,
    PRIMARY KEY (month, pot_id)
  )`);
  // Statement-import idempotency key. (ALTER TABLE cannot add a UNIQUE
  // constraint, so existing DBs get a unique index instead.)
  if (!cols.some((c) => c.name === "external_id")) {
    fresh.exec("ALTER TABLE transactions ADD COLUMN external_id TEXT");
  }
  fresh.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_external_id ON transactions(external_id)");
  // Soft-void flag.
  if (!cols.some((c) => c.name === "voided")) {
    fresh.exec("ALTER TABLE transactions ADD COLUMN voided INTEGER NOT NULL DEFAULT 0");
  }
  // Contacts: people the user shares expenses with (replaces the single
  // hardcoded partner concept).
  fresh.exec(`CREATE TABLE IF NOT EXISTS contacts (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  // Per-pot share config: which contact a pot is shared with and their
  // percentage. NULL contact_id = not shared.
  if (!potCols.some((c) => c.name === "contact_id")) {
    fresh.exec("ALTER TABLE pots ADD COLUMN contact_id INTEGER NULL REFERENCES contacts(id)");
  }
  if (!potCols.some((c) => c.name === "share_pct")) {
    fresh.exec("ALTER TABLE pots ADD COLUMN share_pct INTEGER NULL");
  }
  // Migrate the old single-partner model to contacts. The old splits table
  // constrained owner to ('user','partner'); the new one uses
  // ('user','contact') plus a contact_id, which needs a table rebuild.
  const splitsSql = (
    fresh.query("SELECT sql FROM sqlite_master WHERE name = 'splits'").get() as { sql: string } | null
  )?.sql;
  if (splitsSql && splitsSql.includes("'partner'")) {
    let contact = fresh.query("SELECT id FROM contacts ORDER BY id LIMIT 1").get() as { id: number } | null;
    if (!contact) {
      const name = getSetting(fresh, "partner_name") ?? "Contact";
      contact = fresh.query("INSERT INTO contacts (name) VALUES (?) RETURNING id").get(name) as { id: number };
    }
    fresh.exec(`CREATE TABLE splits_new (
      id             INTEGER PRIMARY KEY,
      transaction_id INTEGER NOT NULL REFERENCES transactions(id),
      pot_id         INTEGER REFERENCES pots(id),
      owner          TEXT NOT NULL CHECK (owner IN ('user','contact')),
      contact_id     INTEGER NULL REFERENCES contacts(id),
      amount_cents   INTEGER NOT NULL
    )`);
    fresh.query(
      `INSERT INTO splits_new (id, transaction_id, pot_id, owner, contact_id, amount_cents)
       SELECT id, transaction_id, pot_id,
              CASE WHEN owner = 'partner' THEN 'contact' ELSE 'user' END,
              CASE WHEN owner = 'partner' THEN ? ELSE NULL END,
              amount_cents
       FROM splits`
    ).run(contact.id);
    fresh.exec("DROP TABLE splits");
    fresh.exec("ALTER TABLE splits_new RENAME TO splits");
    // Pots that historically split with the contact keep a 50% share config
    // (the old default when splitting a transaction). Editable in the UI.
    fresh.query(
      `UPDATE pots SET contact_id = ?, share_pct = 50
       WHERE contact_id IS NULL AND id IN (
         SELECT DISTINCT s.pot_id FROM splits s
         WHERE s.owner = 'contact' AND s.contact_id = ? AND s.pot_id IS NOT NULL
       )`
    ).run(contact.id, contact.id);
    // The old partner_name setting is superseded by the contacts table.
    fresh.exec("DELETE FROM settings WHERE key = 'partner_name'");
  }
  // Backfill splits: pre-split transactions were 100% the user's.
  const unsplit = fresh.query(
    "SELECT id, pot_id, amount_cents FROM transactions WHERE id NOT IN (SELECT transaction_id FROM splits)"
  ).all() as { id: number; pot_id: number | null; amount_cents: number }[];
  const ins = fresh.query("INSERT INTO splits (transaction_id, pot_id, owner, amount_cents) VALUES (?, ?, 'user', ?)");
  for (const t of unsplit) ins.run(t.id, t.pot_id, t.amount_cents);
}
