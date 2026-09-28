/** Cloudflare Worker entry: the same Hono app as the Bun server, backed by
 *  D1. Routing is explicit in wrangler.toml: /api/* always runs this Worker;
 *  everything else is served as static assets by the platform (with SPA
 *  fallback to /index.html), so the Worker only ever sees API requests.
 *
 *  Worker-safe: imports only ./app (hono + type-only db-interface + domain
 *  modules) and ./db-interface. Never imports ./server or ./db. */
import type { Db, DbValue, RunResult } from "./db-interface";
import { createApp } from "./app";

/* Minimal Cloudflare binding shapes, declared locally so this file needs no
 * @cloudflare/workers-types dependency. */
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number; last_row_id?: number | string } }>;
}
interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  exec(sql: string): Promise<unknown>;
}

interface Env {
  DB: D1Database;
  /* SESSIONS (KVNamespace): Phase 5 auth. Not wired yet; creating the
   * namespace needs Workers KV Storage:Edit on the deploy token. */
}

/** D1 rejects bigint bindings; the app passes money as numbers, but coerce
 *  defensively so a stray bigint can never 500 a request. */
function bindable(v: DbValue): unknown {
  return typeof v === "bigint" ? Number(v) : v;
}

/** The Db interface on top of a D1 database binding. */
class D1Db implements Db {
  constructor(private db: D1Database) {}

  async get<T = any>(sql: string, ...params: DbValue[]): Promise<T | null> {
    return (await this.db.prepare(sql).bind(...params.map(bindable)).first<T>()) ?? null;
  }

  async all<T = any>(sql: string, ...params: DbValue[]): Promise<T[]> {
    const r = await this.db.prepare(sql).bind(...params.map(bindable)).all<T>();
    return r.results;
  }

  async run(sql: string, ...params: DbValue[]): Promise<RunResult> {
    const r = await this.db.prepare(sql).bind(...params.map(bindable)).run();
    return { changes: r.meta.changes ?? 0, lastRowId: Number(r.meta.last_row_id ?? 0) };
  }

  async exec(sql: string): Promise<void> {
    // Multi-statement exec on D1 is atomic (proven in the Phase 1 spike).
    await this.db.exec(sql);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const app = createApp(async () => new D1Db(env.DB));
      return app.fetch(request);
    }
    // Non-API requests are served as static assets by the platform (see
    // run_worker_first in wrangler.toml); reaching here means no asset
    // matched outside the SPA fallback, so 404.
    return new Response(null, { status: 404 });
  },
};
