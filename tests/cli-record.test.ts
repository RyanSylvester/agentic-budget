import { describe, expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/** Local `record` without --pot must land splits on the Uncategorized pot,
 *  exactly like remote mode, never with a NULL pot_id. Drives the real CLI
 *  as a subprocess against a scratch database (BUDGET_DB + an empty
 *  BUDGET_API_URL force local mode regardless of the machine's config). */

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function cli(dbPath: string, args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: REPO,
    env: { ...process.env, BUDGET_DB: dbPath, BUDGET_API_URL: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out + err };
}

function query<T>(dbPath: string, sql: string): T[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query(sql).all() as T[];
  } finally {
    db.close();
  }
}

async function setupDb(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "cli-record-"));
  tmpDirs.push(dir);
  const dbPath = join(dir, "test.db");
  const u = await cli(dbPath, ["user", "create", "testuser"]);
  expect(u.code).toBe(0);
  // user create does not run migrations; do it here and add the account.
  const setup = Bun.spawn([process.execPath, "-e", `
    import { Database } from "bun:sqlite";
    import { migrateDb, wrapDb } from "./src/db.ts";
    const db = wrapDb(new Database(process.env.BUDGET_DB));
    await migrateDb(db);
    await db.run("INSERT INTO accounts (user_id, name, type) VALUES (1, 'Test Chequing', 'chequing')");
  `], {
    cwd: REPO,
    env: { ...process.env, BUDGET_DB: dbPath, BUDGET_API_URL: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [sout, serr, scode] = await Promise.all([
    new Response(setup.stdout).text(), new Response(setup.stderr).text(), setup.exited,
  ]);
  expect(scode).toBe(0);
  if (scode !== 0) console.log(sout + serr);
  return dbPath;
}

describe("local record without --pot", () => {
  test("splits land on the Uncategorized pot, never NULL", async () => {
    const dbPath = await setupDb();
    const r = await cli(dbPath, [
      "record", "--account", "1", "--amount", "-12.50",
      "--description", "Test spend", "--source", "manual",
    ]);
    expect(r.code).toBe(0);
    const uncat = query<{ id: number }>(dbPath, "SELECT id FROM pots WHERE name = 'Uncategorized'")[0];
    expect(uncat).toBeDefined();
    const rows = query<{ pot_id: number | null }>(dbPath, "SELECT pot_id FROM splits");
    expect(rows.length).toBe(1);
    expect(rows[0].pot_id).toBe(uncat.id);
  });

  test("record with --pot still uses that pot", async () => {
    const dbPath = await setupDb();
    const c = await cli(dbPath, ["pot", "create", "--name", "Groceries", "--group", "Food"]);
    expect(c.code).toBe(0);
    const r = await cli(dbPath, [
      "record", "--account", "1", "--amount", "-9.99",
      "--description", "Test groceries", "--source", "manual", "--pot", "Groceries",
    ]);
    expect(r.code).toBe(0);
    const pot = query<{ id: number }>(dbPath, "SELECT id FROM pots WHERE name = 'Groceries'")[0];
    const rows = query<{ pot_id: number | null }>(dbPath, "SELECT pot_id FROM splits");
    expect(rows.length).toBe(1);
    expect(rows[0].pot_id).toBe(pot.id);
  });
});
