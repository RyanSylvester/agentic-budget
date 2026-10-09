import { useState } from "react";
import { useApi, send } from "./api";
import type { AgentToken, AgentTokenCreated, AgentTokensResponse, AuthState } from "./types";
import { Skeleton, FetchError } from "./ui";

/* Settings tab: account info and per-user agent token management.
 *
 * Agent tokens are full-access bearer credentials for the API: they let a
 * personal AI agent manage this user's budget. The raw token is shown exactly
 * once at creation; the server stores only its SHA-256. Minting and revoking
 * require the cookie session, so a stolen agent token cannot mint more. */

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function AccountCard() {
  const { data, error, loading, retry } = useApi<AuthState>(
    "/api/auth/me"
  );
  const [loggingOut, setLoggingOut] = useState(false);

  const logout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* fall through: reload clears state either way */
    }
    window.location.reload();
  };

  return (
    <section className="card p-5" aria-label="Account">
      <h2 className="text-[16px] font-semibold">Account</h2>
      {loading && <Skeleton className="mt-3 h-6 w-40" />}
      {error && (
        <div className="mt-3">
          <FetchError onRetry={retry} label="Couldn't load account info." />
        </div>
      )}
      {data && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-[15px] font-medium">{data.username ?? "Signed in"}</div>
            <div className="text-[13px] text-[var(--muted)]">Signed in on this device</div>
          </div>
          <button onClick={logout} disabled={loggingOut} className="btn-ghost px-4 py-2 text-[14px]">
            {loggingOut ? "Logging out…" : "Log out"}
          </button>
        </div>
      )}
    </section>
  );
}

function TokenRow({
  token,
  onRevoke,
  revoking,
}: {
  token: AgentToken;
  onRevoke: () => void;
  revoking: boolean;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="border-b border-[var(--hairline)] py-3 last:border-0 last:pb-0 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-medium">{token.name}</div>
          <div className="text-[13px] text-[var(--muted)]">Created {formatDate(token.created_at)}</div>
        </div>
        {!confirming ? (
          <button
            onClick={() => setConfirming(true)}
            className="-m-2 shrink-0 cursor-pointer p-2 text-[13px] text-[var(--muted)] hover:text-[var(--danger)]"
          >
            Revoke…
          </button>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={onRevoke}
              disabled={revoking}
              className="cursor-pointer rounded-[var(--r-pill)] bg-[var(--danger)] px-3 py-1.5 text-[13px] font-medium text-white"
            >
              {revoking ? "Revoking…" : "Revoke"}
            </button>
            <button onClick={() => setConfirming(false)} className="btn-ghost px-3 py-1.5 text-[13px]">
              Keep
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function AgentTokensCard() {
  const { data, error, loading, retry } = useApi<AgentTokensResponse>("/api/auth/agent-tokens");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokingId, setRevokingId] = useState<number | null>(null);

  const create = async () => {
    if (creating || newToken) return;
    setCreating(true);
    setCreateError(null);
    try {
      const r = await send("/api/auth/agent-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || "cli" }),
      });
      const body = (await r.json().catch(() => null)) as Partial<AgentTokenCreated> | null;
      if (!r.ok || !body?.token) throw new Error("create failed");
      setNewToken({ name: name.trim() || "cli", token: body.token });
      setName("");
      setCopied(false);
      retry();
    } catch {
      setCreateError("Couldn't create the token. Try again.");
    }
    setCreating(false);
  };

  const revoke = async (id: number) => {
    if (revokingId !== null) return;
    setRevokingId(id);
    try {
      const r = await send(`/api/auth/agent-tokens/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("revoke failed");
      retry();
    } catch {
      /* the row stays; the next render still shows it */
    }
    setRevokingId(null);
  };

  const copyToken = async () => {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken.token);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = newToken.token;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
  };

  const tokens = data?.tokens ?? [];

  return (
    <section className="card p-5" aria-label="Agent tokens">
      <h2 className="text-[16px] font-semibold">Agent tokens</h2>
      <p className="mt-1 text-[13px] text-[var(--muted)]">
        Tokens let a personal AI agent manage your budget through the API. Each token has full access
        to your data, so treat it like a password and revoke any you don't recognize.
      </p>

      {loading && (
        <div className="mt-4 space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}
      {error && (
        <div className="mt-4">
          <FetchError onRetry={retry} label="Couldn't load agent tokens." />
        </div>
      )}

      {!loading && !error && newToken && (
        <div className="mt-4 rounded-[var(--r-md)] border border-[var(--warning)] bg-[var(--warning-soft)] p-4">
          <div className="text-[14px] font-semibold">Token created: {newToken.name}</div>
          <p className="mt-1 text-[13px] text-[var(--ink-2)]">
            Copy it now. This is the only time it will be shown.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="t-nums min-w-0 flex-1 truncate rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-3 py-2 text-[13px]">
              {newToken.token}
            </code>
            <button onClick={copyToken} className="btn-ink shrink-0 px-4 py-2 text-[14px]">
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button
            onClick={() => setNewToken(null)}
            className="mt-3 w-full text-center text-[13px] text-[var(--ink-2)] underline underline-offset-2"
          >
            I've saved it
          </button>
        </div>
      )}

      {!loading && !error && !newToken && (
        <>
          {tokens.length === 0 ? (
            <p className="mt-4 text-[14px] text-[var(--muted)]">
              No agent tokens yet. Create one to connect an agent or the command-line tool.
            </p>
          ) : (
            <ul className="mt-2">
              {tokens.map((t) => (
                <TokenRow key={t.id} token={t} onRevoke={() => revoke(t.id)} revoking={revokingId === t.id} />
              ))}
            </ul>
          )}

          <div className="mt-4 border-t border-[var(--hairline)] pt-4">
            <label htmlFor="new-token-name" className="mb-1.5 block text-[13px] font-medium text-[var(--ink-2)]">
              New token name
            </label>
            <div className="flex gap-2">
              <input
                id="new-token-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Home server"
                maxLength={80}
                className="field min-w-0 flex-1 px-3 py-2 text-[15px]"
              />
              <button
                onClick={create}
                disabled={creating}
                className="btn-ink shrink-0 px-4 py-2 text-[14px]"
              >
                {creating ? "Creating…" : "Create token"}
              </button>
            </div>
            {createError && (
              <div role="alert" className="mt-2 text-[13px] text-[var(--danger)]">
                {createError}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function SettingsTab() {
  return (
    <div className="space-y-4">
      <AccountCard />
      <AgentTokensCard />
    </div>
  );
}
