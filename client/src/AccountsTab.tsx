import { useState, type FormEvent } from "react";
import { AccountSheet } from "./AccountSheet";
import { MoneyInput } from "./MoneyInput";
import { useApi, send } from "./api";
import { fmtDate, money } from "./format";
import { evaluateExpression } from "./money";
import type { Account, AccountsResponse, ReconcileResponse } from "./types";
import { FetchError, Skeleton } from "./ui";

/* ---------- accounts + reconcile ---------- */

const isCard = (a: Account) => a.type === "credit_card";

/** Credit cards carry negative balances (money owed): "$653.65 owed" rather
 *  than a double negative like "−$653.65". */
export function owedOrMoney(a: Account, cents: number): string {
  if (isCard(a) && cents < 0) return `${money(-cents)} owed`;
  return money(cents);
}

export function clearedLabel(a: Account): string {
  return `Cleared ${owedOrMoney(a, a.clearedBalanceCents)}`;
}

const STALE_DAYS = 30;

/** "Reconciled Sep 20" (or "today"), flagged stale after 30 days. */
export function reconciledLabel(at: string | null, now = new Date()): { text: string; stale: boolean } {
  if (!at) return { text: "Never reconciled", stale: false };
  const when = fmtDate(at);
  const d = new Date(`${at.slice(0, 10)}T12:00:00`);
  const stale = !Number.isNaN(d.getTime()) && now.getTime() - d.getTime() > STALE_DAYS * 86400000;
  return { text: `Reconciled ${when === "Today" || when === "Yesterday" ? when.toLowerCase() : when}`, stale };
}

/** Plain-language direction of a reconcile difference (actual − cleared). */
export function differenceLabel(a: Account, differenceCents: number): string {
  const amt = money(Math.abs(differenceCents));
  if (isCard(a))
    return differenceCents < 0
      ? `Your statement shows ${amt} more owed than Daybook's cleared balance`
      : `Your statement shows ${amt} less owed than Daybook's cleared balance`;
  return differenceCents < 0
    ? `Your bank shows ${amt} less than Daybook's cleared balance`
    : `Your bank shows ${amt} more than Daybook's cleared balance`;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) return `${fallback} (${body.error})`;
  } catch {
    // not JSON; use the fallback
  }
  return fallback;
}

const OFFLINE = "Couldn't reach Daybook. Check your connection and try again.";

/** The Accounts tab: a header with the add action, then the account list. */
export function AccountsView() {
  const [adding, setAdding] = useState(false);
  return (
    <div>
      <div className="mb-5 flex items-baseline justify-between">
        {/* Phones show the tab name in the top bar: the heading stays for screen readers. */}
        <h1 tabIndex={-1} className="sr-only font-serif-d text-xl font-medium outline-none md:not-sr-only">Accounts</h1>
        <button onClick={() => setAdding(true)} className="btn-ink ml-auto px-4 py-2 text-md">Add account</button>
      </div>
      <AccountsList onAdd={() => setAdding(true)} />
      {adding && <AccountSheet onClose={() => setAdding(false)} />}
    </div>
  );
}

function AccountsList({ onAdd }: { onAdd: () => void }) {
  const { data, error, loading, retry } = useApi<AccountsResponse>("/api/accounts");
  const [actual, setActual] = useState<Record<number, string>>({});
  const [result, setResult] = useState<Record<number, ReconcileResponse | null>>({});
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [clearing, setClearing] = useState<Record<number, number | null>>({});
  const [problem, setProblem] = useState<Record<number, string | null>>({});

  const load = () => retry();
  const setFor = <T,>(set: (f: (p: Record<number, T>) => Record<number, T>) => void, id: number, v: T) =>
    set((p) => ({ ...p, [id]: v }));

  const reconcile = async (a: Account) => {
    const raw = (actual[a.id] ?? "").trim();
    if (!raw) {
      setFor(setProblem, a.id, isCard(a) ? "Enter the amount owed on your statement." : "Enter the balance your bank shows.");
      return;
    }
    // Balances can be negative, so evaluate directly instead of
    // expressionToCents, which rejects negatives.
    const dollars = evaluateExpression(raw);
    if (dollars === null) {
      setFor(setProblem, a.id, "That doesn't look like an amount. Try something like 1250.40.");
      return;
    }
    const typed = Math.round(dollars * 100);
    // Card statements show a positive amount owed; Daybook stores it as a
    // negative balance (and the iOS decimal keypad has no minus key).
    const cents = isCard(a) ? -typed : typed;
    setFor(setProblem, a.id, null);
    setFor(setBusy, a.id, true);
    try {
      const res = await send(`/api/accounts/${a.id}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actualBalanceCents: cents }),
      });
      // An error body ({ error }) is not a reconcile result; rendering it as
      // one would crash on the missing uncleared list.
      if (!res.ok) {
        setFor(setProblem, a.id, await errorMessage(res, "Couldn't reconcile right now."));
        return;
      }
      setFor(setResult, a.id, (await res.json()) as ReconcileResponse);
      load();
    } catch {
      setFor(setProblem, a.id, OFFLINE);
    } finally {
      setFor(setBusy, a.id, false);
    }
  };

  const clearTxn = async (a: Account, txnId: number) => {
    setFor(setClearing, a.id, txnId);
    setFor(setProblem, a.id, null);
    try {
      const res = await send(`/api/transactions/${txnId}/clear`, { method: "POST" });
      if (!res.ok) {
        setFor(setProblem, a.id, await errorMessage(res, "Couldn't mark that transaction cleared."));
        return;
      }
      // Keep the typed balance and re-check, so the remaining difference
      // updates in place until it balances.
      await reconcile(a);
    } catch {
      setFor(setProblem, a.id, OFFLINE);
    } finally {
      setFor(setClearing, a.id, null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        {[0, 1].map((i) => (
          <div key={i} className="card space-y-3 p-5">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-10 w-64" />
          </div>
        ))}
      </div>
    );
  }
  if (error) return <FetchError onRetry={retry} label="Couldn't load accounts." />;

  const accounts = data?.accounts ?? [];
  if (accounts.length === 0)
    return (
      <div className="rounded-[var(--r-lg)] border border-dashed border-[var(--line)] px-6 py-16 text-center">
        <div className="font-serif-d text-xl font-medium">No accounts yet</div>
        <p className="mx-auto mt-2 max-w-[340px] text-md text-[var(--ink-2)]">
          Add the chequing, savings or credit card accounts your money moves through. Every transaction belongs to one.
        </p>
        <button onClick={onAdd} className="btn-ink mt-5 px-5 py-2.5 text-md">
          Add your first account
        </button>
      </div>
    );

  return (
    <div className="space-y-4">
      {accounts.map((a) => {
        const r = result[a.id];
        const rec = reconciledLabel(a.lastReconciledAt);
        const working = a.workingBalanceCents;
        const card = isCard(a);
        const fieldLabel = card ? "Amount owed on statement" : "Balance your bank shows";
        const isBusy = !!busy[a.id] || clearing[a.id] != null;
        const onSubmit = (e: FormEvent) => {
          e.preventDefault();
          if (!isBusy) reconcile(a);
        };
        return (
          <div key={a.id} className="card p-5">
            <div className="flex items-baseline justify-between gap-3">
              <div className="text-md font-semibold">{a.name}</div>
              <div className="t-nums text-figure font-light tracking-tight">
                {card && working < 0 ? (
                  <>
                    {money(-working)}
                    <span className="ml-1.5 text-md font-normal text-[var(--muted)]">owed</span>
                  </>
                ) : (
                  money(working)
                )}
              </div>
            </div>
            <div className="mt-1 text-sm text-[var(--muted)]">
              {clearedLabel(a)}
              {" · "}
              <span className={rec.stale ? "font-medium text-[var(--warning)]" : undefined}>{rec.text}</span>
            </div>
            <form onSubmit={onSubmit} className="mt-4" noValidate>
              <div className="mb-1.5 text-sm font-medium text-[var(--muted)]">{fieldLabel}</div>
              <div className="flex gap-2">
                <MoneyInput
                  placeholder={card ? "Amount owed" : "Actual balance"}
                  ariaLabel={`${fieldLabel} for ${a.name}`}
                  value={actual[a.id] ?? ""}
                  onChange={(v) => {
                    setFor(setActual, a.id, v);
                    if (problem[a.id]) setFor(setProblem, a.id, null);
                  }}
                  className="w-36 py-2 text-md"
                />
                <button type="submit" disabled={isBusy} aria-busy={isBusy}
                  className="btn-ink px-4 py-2 text-md disabled:opacity-60">
                  {busy[a.id] ? "Checking…" : "Reconcile"}
                </button>
              </div>
            </form>
            {problem[a.id] && (
              <p role="alert" className="mt-2 text-sm text-[var(--danger)]">{problem[a.id]}</p>
            )}
            {r && (
              <div aria-live="polite" className="mt-3 rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-4 text-md">
                {r.balanced ? (
                  <>
                    <div className="flex items-center gap-2 text-lg font-medium text-[var(--success)]">
                      <span aria-hidden>✓</span> Balanced
                    </div>
                    <div className="mt-1 text-sm text-[var(--muted)]">Cleared transactions are now marked reconciled.</div>
                  </>
                ) : (
                  <>
                    <div>{differenceLabel(a, r.differenceCents)}.</div>
                    {(r.uncleared ?? []).length > 0 ? (
                      <div className="mt-1 text-sm text-[var(--muted)]">Clear the ones that have posted; the difference updates as you go.</div>
                    ) : (
                      <div className="mt-1 text-sm text-[var(--muted)]">No uncleared transactions to explain it. Check the balance you typed.</div>
                    )}
                    <ul className="mt-3 space-y-2">
                      {(r.uncleared ?? []).map((t) => {
                        const suggested = r.suggestedClearId === t.id;
                        const thisClearing = clearing[a.id] === t.id;
                        return (
                          <li key={t.id} className="flex items-center gap-3 text-sm">
                            {/* only the description truncates; date and amount always show */}
                            <div className="min-w-0 flex-1">
                              <div className="truncate">{t.description}</div>
                              <div className="whitespace-nowrap text-[var(--muted)]">
                                {fmtDate(t.date)} · <span className="t-nums text-[var(--ink)]">{money(t.amount_cents)}</span>
                              </div>
                            </div>
                            <button type="button" disabled={isBusy} onClick={() => clearTxn(a, t.id)}
                              className={`shrink-0 rounded-full px-3 py-1 font-medium transition active:scale-95 disabled:opacity-60 ${suggested ? "bg-[var(--accent)] text-[var(--on-accent)]" : "border border-[var(--hairline-strong)]"}`}>
                              {thisClearing ? "Clearing…" : suggested ? "This one posted" : "Clear"}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
