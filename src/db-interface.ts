/** The async database port. Both runtimes implement this interface: bun:sqlite
 *  (Bun: local CLI, local serve, tests) today, D1 (Cloudflare Worker) later.
 *  Async by construction and D1-shaped on purpose: `get`/`all`/`run` mirror
 *  D1's `first`/`all`/`run`, and there are deliberately no interactive
 *  transactions. With a single writer (one user, one agent), every write path
 *  runs as sequential awaits and the read-then-write logic is unchanged.
 *
 *  This file is portable: it imports nothing, so the Worker entry can import
 *  the contract without pulling in bun:sqlite. */
export type DbValue = string | number | bigint | null | Uint8Array;

export interface RunResult {
  changes: number;
  lastRowId: number;
}

export interface Db {
  /** First row of the query, or null when it returns no rows. */
  get<T = any>(sql: string, ...params: DbValue[]): Promise<T | null>;
  /** All rows of the query, in query order. */
  all<T = any>(sql: string, ...params: DbValue[]): Promise<T[]>;
  /** INSERT/UPDATE/DELETE. Reports rows changed and the last inserted row id. */
  run(sql: string, ...params: DbValue[]): Promise<RunResult>;
  /** One or more statements with no parameters (schema, PRAGMA). */
  exec(sql: string): Promise<void>;
}
