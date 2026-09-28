/** Remote mode: the CLI as a thin HTTP client against the hosted Worker.
 *
 *  Config lives in ~/.config/agentic-budget/config.json ({ apiUrl, token },
 *  written 0600). BUDGET_API_URL / BUDGET_API_TOKEN override the file.
 *  No apiUrl from either source means local mode: the CLI works against
 *  budget.db exactly as before.
 *
 *  Bun-only (node:fs, node:os, stty): the CLI stays local, this file never
 *  ships to the Worker. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface RemoteConfig {
  apiUrl: string;
  /** Null when no token is configured; requests then go without a header. */
  token: string | null;
}

const CONFIG_DIR = join(homedir(), ".config", "agentic-budget");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function configPath(): string {
  return CONFIG_PATH;
}

function readFileConfig(): { apiUrl?: unknown; token?: unknown } | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as { apiUrl?: unknown; token?: unknown };
  } catch {
    return null;
  }
}

/** Resolve remote config. Env wins over the file. Null = local mode. */
export function loadRemoteConfig(): RemoteConfig | null {
  const file = readFileConfig();
  const rawUrl = process.env.BUDGET_API_URL ?? (typeof file?.apiUrl === "string" ? file.apiUrl : undefined);
  if (!rawUrl) return null;
  const rawToken = process.env.BUDGET_API_TOKEN ?? (typeof file?.token === "string" ? file.token : undefined);
  return { apiUrl: rawUrl.replace(/\/+$/, ""), token: rawToken ?? null };
}

/** Persist the apiUrl + token with owner-only permissions. */
export function saveRemoteConfig(apiUrl: string, token: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ apiUrl, token }, null, 2) + "\n");
  chmodSync(CONFIG_PATH, 0o600);
}

/** Prompt for a secret without echoing it. Falls back to visible input with
 *  a warning when stdin is not a TTY. */
export async function promptHidden(question: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  const { spawnSync } = await import("node:child_process");
  const { readFileSync: readStdin } = await import("node:fs");
  process.stdout.write(question);
  if (!process.stdin.isTTY) {
    // Piped stdin: readline's line/close ordering is unreliable here, so read
    // to EOF and take the first line.
    process.stderr.write("(warning: input will be visible; stdin is not a TTY)\n");
    const line = readStdin(0, "utf8").split("\n")[0].trim();
    process.stdout.write("\n");
    return line;
  }
  spawnSync("stty", ["-echo"], { stdio: "inherit" });
  try {
    const rl = createInterface({ input: process.stdin, terminal: false });
    const line = await new Promise<string>((resolve) => {
      rl.once("line", (l) => {
        rl.close();
        resolve(l);
      });
      rl.once("close", () => resolve(""));
    });
    return line.trim();
  } finally {
    spawnSync("stty", ["echo"], { stdio: "inherit" });
    process.stdout.write("\n");
  }
}

export class RemoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteError";
  }
}

/** One JSON request against the Worker API. Sends Authorization: Bearer when
 *  a token is configured. Throws RemoteError carrying the server's message
 *  on non-2xx, or naming the apiUrl when the host is unreachable. */
export async function apiFetch(
  remote: RemoteConfig,
  path: string,
  opts: { method?: string; body?: unknown } = {}
): Promise<any> {
  const url = remote.apiUrl + path;
  const headers: Record<string, string> = {};
  if (remote.token) headers["Authorization"] = `Bearer ${remote.token}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? "GET", headers, body });
  } catch (e) {
    throw new RemoteError(`cannot reach ${remote.apiUrl}: ${(e as Error).message}`);
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body; the status check below still applies */
  }
  if (!res.ok) {
    throw new RemoteError(data?.error ?? `request failed (${res.status} ${res.statusText})`);
  }
  return data;
}
