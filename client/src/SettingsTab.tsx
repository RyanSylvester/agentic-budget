import { useEffect, useRef, useState } from "react";
import { useApi, send } from "./api";
import { type ThemeChoice, savedTheme, setTheme } from "./theme";
import type { AgentToken, AgentTokenCreated, AgentTokensResponse, AuthState, InviteCreated } from "./types";
import { Skeleton, FetchError, Segmented } from "./ui";

/* Settings tab: account info, appearance, invites, and per-user agent token
 * management.
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

/** "Last used 2h ago" from a timestamp the server refreshes at most hourly,
 *  so anything under an hour reads as the past hour. */
export function lastUsedLabel(iso: string | null, now: number = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "Never used";
  const hours = Math.floor((now - t) / 3_600_000);
  if (hours < 1) return "Last used in the past hour";
  if (hours < 24) return `Last used ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `Last used ${days}d ago`;
  return `Last used ${formatDate(iso!)}`;
}

/** Copy text to the clipboard and report whether it really happened. The
 *  async Clipboard API needs a secure context and permission; the
 *  execCommand fallback covers older browsers. Either can fail, and the
 *  caller must not claim "Copied" when it did. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall back below */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** A value to copy (token, invite code, link) with its Copy button. When
 *  copying fails the value is selected so the reader can copy it by hand. */
function CopyField({ value, buttonLabel = "Copy" }: { value: string; buttonLabel?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const box = useRef<HTMLElement>(null);

  const copy = async () => {
    if (await copyText(value)) {
      setState("copied");
      return;
    }
    const sel = window.getSelection();
    if (box.current && sel) sel.selectAllChildren(box.current);
    setState("manual");
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <code
          ref={box}
          className="t-nums min-w-0 flex-1 truncate rounded-[var(--r-sm)] bg-[var(--bg-sunken)] px-3 py-2 text-sm"
        >
          {value}
        </code>
        <button onClick={copy} className="btn-ink shrink-0 px-4 py-2 text-md">
          {state === "copied" ? "Copied" : buttonLabel}
        </button>
      </div>
      <div aria-live="polite" className="text-sm text-[var(--ink-2)]">
        {state === "manual" && <p className="mt-1.5">Couldn't copy automatically. Press ⌘C / Ctrl+C.</p>}
      </div>
    </div>
  );
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
      <h2 className="text-lg font-semibold">Account</h2>
      {loading && <Skeleton className="mt-3 h-6 w-40" />}
      {error && (
        <div className="mt-3">
          <FetchError onRetry={retry} label="Couldn't load account info." />
        </div>
      )}
      {data && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-md font-medium">{data.username ?? "Signed in"}</div>
            <div className="text-sm text-[var(--muted)]">Signed in on this device</div>
          </div>
          <button onClick={logout} disabled={loggingOut} className="btn-ghost px-4 py-2 text-md">
            {loggingOut ? "Logging out…" : "Log out"}
          </button>
        </div>
      )}
    </section>
  );
}

function AppearanceCard() {
  const [choice, setChoice] = useState<ThemeChoice>(savedTheme);
  return (
    <section className="card p-5" aria-labelledby="appearance-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="appearance-title" className="text-lg font-semibold">Appearance</h2>
          <p className="text-sm text-[var(--muted)]">System follows your device setting.</p>
        </div>
        <Segmented<ThemeChoice>
          ariaLabel="Theme"
          value={choice}
          onChange={(v) => {
            setChoice(v);
            setTheme(v);
          }}
          options={[
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
            { value: "system", label: "System" },
          ]}
        />
      </div>
    </section>
  );
}

function InviteCard() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await send("/api/auth/invite-codes", { method: "POST" });
      const body = (await r.json().catch(() => null)) as Partial<InviteCreated> | null;
      if (!r.ok || !body?.code) throw new Error("invite failed");
      setCode(body.code);
    } catch {
      setError("Couldn't create an invite. Try again.");
    }
    setBusy(false);
  };

  return (
    <section className="card p-5" aria-labelledby="invite-title">
      <h2 id="invite-title" className="text-lg font-semibold">Invite someone</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Each invite code works once and gives the person their own separate budget.
      </p>
      {code ? (
        <div className="mt-4 space-y-3">
          <CopyField value={code} buttonLabel="Copy code" />
          <CopyField value={`${window.location.origin}/?invite=${code}`} buttonLabel="Copy link" />
          <button
            onClick={create}
            disabled={busy}
            className="w-full text-center text-sm text-[var(--ink-2)] underline underline-offset-2"
          >
            {busy ? "Creating…" : "Create another invite"}
          </button>
        </div>
      ) : (
        <button onClick={create} disabled={busy} className="btn-ghost mt-4 px-4 py-2 text-md">
          {busy ? "Creating…" : "Create invite"}
        </button>
      )}
      {error && (
        <div role="alert" className="mt-2 text-sm text-[var(--danger)]">
          {error}
        </div>
      )}
    </section>
  );
}

function TokenRow({
  token,
  onRevoke,
  revoking,
  failed,
}: {
  token: AgentToken;
  onRevoke: () => void;
  revoking: boolean;
  failed: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);

  // The swap replaces the focused button, so move focus with it: to the safe
  // choice (Keep) when confirming, back to Revoke… on cancel.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    (confirming ? keepRef : triggerRef).current?.focus();
  }, [confirming]);

  return (
    <li className="border-b border-[var(--hairline)] py-3 last:border-0 last:pb-0 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-md font-medium">{token.name}</div>
          <div className="text-sm text-[var(--muted)]">
            Created {formatDate(token.created_at)} · {lastUsedLabel(token.last_used_at)}
          </div>
        </div>
        {!confirming ? (
          <button
            ref={triggerRef}
            onClick={() => setConfirming(true)}
            className="-m-2 shrink-0 cursor-pointer p-2 text-sm text-[var(--muted)] hover:text-[var(--danger)]"
          >
            Revoke…
          </button>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={onRevoke}
              disabled={revoking}
              className="cursor-pointer rounded-[var(--r-pill)] bg-[var(--danger)] px-3 py-1.5 text-sm font-medium text-[var(--on-danger)]"
            >
              {revoking ? "Revoking…" : "Revoke"}
            </button>
            <button ref={keepRef} onClick={() => setConfirming(false)} className="btn-ghost px-3 py-1.5 text-sm">
              Keep
            </button>
          </div>
        )}
      </div>
      {failed && (
        <div role="alert" className="mt-2 text-sm text-[var(--danger)]">
          Couldn't revoke. Try again.
        </div>
      )}
    </li>
  );
}

function AgentTokensCard() {
  const { data, error, loading, retry } = useApi<AgentTokensResponse>("/api/auth/agent-tokens");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<{ name: string; token: string } | null>(null);
  const [revokingId, setRevokingId] = useState<number | null>(null);
  const [revokeFailedId, setRevokeFailedId] = useState<number | null>(null);

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
      retry();
    } catch {
      setCreateError("Couldn't create the token. Try again.");
    }
    setCreating(false);
  };

  const revoke = async (id: number) => {
    if (revokingId !== null) return;
    setRevokingId(id);
    setRevokeFailedId(null);
    try {
      const r = await send(`/api/auth/agent-tokens/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("revoke failed");
      retry();
    } catch {
      // The row stays, still confirming, so Revoke is one tap from a retry.
      setRevokeFailedId(id);
    }
    setRevokingId(null);
  };

  const tokens = data?.tokens ?? [];

  return (
    <section className="card p-5" aria-labelledby="agent-tokens-title">
      <h2 id="agent-tokens-title" className="text-lg font-semibold">Agent tokens</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
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
          <div className="text-md font-semibold">Token created: {newToken.name}</div>
          <p className="mb-3 mt-1 text-sm text-[var(--ink-2)]">
            Copy it now. This is the only time it will be shown.
          </p>
          <CopyField value={newToken.token} />
          <button
            onClick={() => setNewToken(null)}
            className="mt-3 w-full text-center text-sm text-[var(--ink-2)] underline underline-offset-2"
          >
            I've saved it
          </button>
        </div>
      )}

      {!loading && !error && (
        <>
          {tokens.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--muted)]">
              No agent tokens yet. Create one to connect an agent or the command-line tool.
            </p>
          ) : (
            <ul className={newToken ? "mt-4" : "mt-2"}>
              {tokens.map((t) => (
                <TokenRow
                  key={t.id}
                  token={t}
                  onRevoke={() => revoke(t.id)}
                  revoking={revokingId === t.id}
                  failed={revokeFailedId === t.id}
                />
              ))}
            </ul>
          )}

          {!newToken && (
            <div className="mt-4 border-t border-[var(--hairline)] pt-4">
              <label htmlFor="new-token-name" className="mb-1.5 block text-sm font-medium text-[var(--ink-2)]">
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
                  className="field min-w-0 flex-1 px-3 py-2 text-md"
                />
                <button
                  onClick={create}
                  disabled={creating}
                  className="btn-ink shrink-0 px-4 py-2 text-md"
                >
                  {creating ? "Creating…" : "Create token"}
                </button>
              </div>
              {createError && (
                <div role="alert" className="mt-2 text-sm text-[var(--danger)]">
                  {createError}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function SettingsTab() {
  return (
    <div className="space-y-4">
      <AccountCard />
      <AppearanceCard />
      <InviteCard />
      <AgentTokensCard />
    </div>
  );
}
