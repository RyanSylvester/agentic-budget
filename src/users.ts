/** Local user creation: `budget user create <username>`.
 *
 *  This exists for the M1 multi-user backfill flow. A pre-migration database
 *  has data rows but no users; the M1 migration refuses to attribute those
 *  rows to nobody, so the operator creates the first user first, then runs
 *  any command (which applies the pending migration and backfills every row
 *  to that user).
 *
 *  Deliberately does NOT use openDb(): openDb applies pending migrations,
 *  which would trip the M1 backfill guard before the user exists. Instead it
 *  opens the database raw, ensures the users table exists (same DDL as the
 *  add_users migration), records that migration's version so openDb will not
 *  re-apply it, and inserts the row.
 *
 *  Local mode has no login, so the verifier is 32 random bytes: no password
 *  can ever reproduce it, which makes the row unusable for authentication by
 *  construction. (Real verifiers come from the remote signup flow in M5.) */
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { DB_PATH } from "./db";

const ADD_USERS_VERSION = "20260928023841";

const USERS_DDL = `CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE,
  salt       TEXT NOT NULL,
  verifier   TEXT NOT NULL,
  kdf_params TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`;

/** Create a local user row. Returns the new user's id. */
export async function createLocalUser(
  username: string,
  dbPath: string = DB_PATH,
): Promise<number> {
  const name = username.trim();
  if (!name) throw new Error("usage: budget user create <username>");
  const raw = new Database(dbPath, { create: true });
  try {
    raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);
    raw.exec(USERS_DDL);
    // The users table now exists outside the migration system; record the
    // version so openDb does not re-apply the add_users migration.
    raw.exec(`INSERT OR IGNORE INTO schema_migrations (version) VALUES ('${ADD_USERS_VERSION}')`);
    const taken = raw.query("SELECT id FROM users WHERE username = ?").get(name) as { id: number } | null;
    if (taken) throw new Error(`user "${name}" already exists (id ${taken.id})`);
    const salt = randomBytes(16).toString("hex");
    const verifier = randomBytes(32).toString("hex"); // random: unusable for login
    const row = raw.query(
      "INSERT INTO users (username, salt, verifier, kdf_params) VALUES (?, ?, ?, ?) RETURNING id",
    ).get(name, salt, verifier, "m=19456,t=2,p=1") as { id: number };
    return row.id;
  } finally {
    raw.close();
  }
}
