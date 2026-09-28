/** The async database port. Both runtimes implement this interface: bun:sqlite
 *  (Bun: local CLI, local serve, tests) today, D1 (Cloudflare Worker) later.
 *  Async by construction and D1-shaped on purpose: `get`/`all`/`run` mirror
 *  D1's `first`/`all`/`run`, and there are deliberately no interactive
 *  transactions. With a single writer per user (one agent plus the human
 *  behind it), every write path runs as sequential awaits and the
 *  read-then-write logic is unchanged.
 *
 *  This file is portable: it imports nothing, so the Worker entry can import
 *  the contract without pulling in bun:sqlite. */
export type DbValue = string | number | bigint | null | Uint8Array;

export interface RunResult {
  changes: number;
  lastRowId: number;
}

/** One statement inside a batch: SQL plus its bound parameters. */
export interface BatchStatement {
  sql: string;
  params: DbValue[];
}

/** Per-statement outcome of a batch, in statement order. */
export interface BatchResult {
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
  /** Atomic multi-statement write: every statement commits or none does.
   *  D1 executes this natively; the Bun adapter wraps it in a transaction.
   *  Statements cannot reference each other's results: use subqueries
   *  (e.g. on a UNIQUE column) when a later statement needs an id produced
   *  by an earlier one. */
  batch(stmts: BatchStatement[]): Promise<BatchResult[]>;
}

/** Portable schema-introspection helper: pure SQL over the Db interface, so
 *  domain modules can use it without pulling in the node:fs-based migration
 *  runner (which the Worker cannot import). */
export async function tableExists(db: Db, name: string): Promise<boolean> {
  return !!(await db.get("SELECT 1 FROM sqlite_master WHERE name = ?", name));
}
