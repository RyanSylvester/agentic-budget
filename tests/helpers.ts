/** Shared test setup: a fresh in-memory database at the current schema
 *  (via migrateDb, so all migrations including the M2 multi-user rebuild
 *  have run) with a single user row (id 1). M2 domain functions take the
 *  acting user id as an explicit argument; tests pass `1` and insert
 *  `user_id = 1` on their direct SQL writes. */
import { Database } from "bun:sqlite";
import { migrateDb, wrapDb } from "../src/db";
import type { Db } from "../src/db-interface";

export async function testDb(): Promise<Db> {
  const db = wrapDb(new Database(":memory:"));
  await migrateDb(db);
  await db.run(
    "INSERT INTO users (username, salt, verifier, kdf_params) VALUES ('test', 'x', 'x', 'm=19456,t=2,p=1')"
  );
  return db;
}
