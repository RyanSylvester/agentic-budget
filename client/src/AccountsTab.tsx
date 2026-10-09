import { useState } from "react";
import { MoneyInput } from "./MoneyInput";
import { useApi } from "./api";
import { money } from "./format";
import { evaluateExpression } from "./money";
import type { Account, AccountsResponse, ReconcileResponse } from "./types";
import { FetchError, Skeleton } from "./ui";

/* ---------- accounts + reconcile ---------- */

export function clearedLabel(a: Account): string {
  // Credit-card cleared balances are negative (money owed): say so plainly
  // instead of rendering a double negative like "Cleared −$653.65".
  if (a.clearedBalanceCents < 0 && a.type === "credit_card")
    return `Owed ${money(-a.clearedBalanceCents)}`;
  return `Cleared ${money(a.clearedBalanceCents)}`;
}

export function AccountsView() {
  const { data, error, loading, retry } = useApi<AccountsResponse>("/api/accounts");
  const [actual, setActual] = useState<Record<number, string>>({});
  const [result, setResult] = useState<Record<number, ReconcileResponse | null>>({});

  const load = () => retry();

  const reconcile = async (id: number) => {
    // Balances can be negative (credit cards), so evaluate directly instead
    // of expressionToCents, which rejects negatives.
    const dollars = evaluateExpression(actual[id] ?? "");
    if (dollars === null) return;
    const cents = Math.round(dollars * 100);
    const res = await fetch(`/api/accounts/${id}/reconcile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actualBalanceCents: cents }),
    });
    // An error body ({ error }) is not a reconcile result; rendering it as
    // one would crash on the missing uncleared list.
    const r = res.ok ? ((await res.json()) as ReconcileResponse) : null;
    setResult((prev) => ({ ...prev, [id]: r }));
    load();
  };

  const clearTxn = async (accountId: number, txnId: number) => {
    await fetch(`/api/transactions/${txnId}/clear`, { method: "POST" });
    setResult((prev) => ({ ...prev, [accountId]: null }));
    load();
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
    return <p className="text-[17px] italic text-[var(--muted)]">No accounts yet.</p>;

  return (
    <div className="space-y-4">
      {accounts.map((a) => (
        <div key={a.id} className="card p-5">
          <div className="flex items-baseline justify-between gap-3">
            <div className="text-[15px] font-semibold">{a.name}</div>
            <div className="t-nums text-[32px] font-light tracking-tight">{money(a.workingBalanceCents)}</div>
          </div>
          <div className="mt-1 text-[13px] text-[var(--muted)]">
            {clearedLabel(a)}
            {a.lastReconciledAt ? ` · reconciled ${a.lastReconciledAt.slice(0, 10)}` : " · never reconciled"}
          </div>
          <div className="mt-4 flex gap-2">
            <MoneyInput
              placeholder="Actual balance"
              ariaLabel={`Actual balance for ${a.name}`}
              value={actual[a.id] ?? ""}
              onChange={(v) => setActual((p) => ({ ...p, [a.id]: v }))}
              className="w-36 py-2 text-[15px]"
            />
            <button onClick={() => reconcile(a.id)} className="btn-ink px-4 py-2 text-[15px]">
              Reconcile
            </button>
          </div>
          {result[a.id] && (
            <div className="mt-3 rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-4 text-[15px]">
              {result[a.id]!.balanced ? (
                <span className="text-[17px]">Balanced. Nice.</span>
              ) : (
                <>
                  <div>Difference: <strong className="t-nums">{money(result[a.id]!.differenceCents)}</strong></div>
                  <ul className="mt-2 space-y-1.5">
                    {(result[a.id]!.uncleared ?? []).map((t) => (
                      <li key={t.id} className="flex items-center justify-between gap-2 text-[13px]">
                        <span className="truncate">{t.description} <span className="t-nums text-[var(--muted)]">{money(t.amount_cents)}</span></span>
                        <button onClick={() => clearTxn(a.id, t.id)}
                          className={`shrink-0 rounded-full px-3 py-1 font-medium transition active:scale-95 ${result[a.id]!.suggestedClearId === t.id ? "bg-[var(--accent)] text-[var(--on-accent)]" : "border border-[var(--hairline-strong)]"}`}>
                          {result[a.id]!.suggestedClearId === t.id ? "This one posted" : "Clear"}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
