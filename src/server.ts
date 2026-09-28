/** Dashboard server (Bun entry): JSON API + serves the built React client.
 *  Start with `bun src/cli.ts serve` (or `bun src/server.ts`). API under /api/*, client at /.
 *
 *  The portable Hono app is built by createApp in ./app; this file only
 *  wires it to the local bun:sqlite database and serves the client with
 *  hono/bun. The Worker entry (worker.ts) does the same with a D1-backed Db. */
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { openDb } from "./db";
import { createApp } from "./app";

/* Bun-local wiring. The Worker entry serves static assets via Workers Static
 * Assets; the hono/bun static serving here stays Bun-only. */
const app = createApp(openDb);

const dist = "./client/dist";
if (existsSync(dist)) {
  app.use("/*", serveStatic({ root: dist }));
  app.get("*", serveStatic({ path: `${dist}/index.html` }));
} else {
  app.get("/", (c) => c.text("client not built yet — run `bun run --cwd client build`", 503));
}

/** Start the dashboard. Default port 3111; PORT env overrides.
 *  `bun src/cli.ts serve` calls this (dynamic import doesn't trigger the
 *  default-export auto-serve, which only fires when this file is the entrypoint). */
export function startServer() {
  const port = parseInt(process.env.PORT ?? "3111", 10);
  const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch });
  console.log(`agentic-budget at http://localhost:${server.port}`);
  return server;
}

// `bun src/server.ts` still works via Bun's default-export auto-serve.
const defaultPort = parseInt(process.env.PORT ?? "3111", 10);
export default { port: defaultPort, hostname: "127.0.0.1", fetch: app.fetch };
