import { useEffect, useState } from "react";
import { money, monthLabel } from "./format";
import type { ErrorResponse, ScaffoldLine, ScaffoldResponse, ScaffoldStrategy } from "./types";
import { FetchError, Segmented, Sheet, Skeleton } from "./ui";

/* ---------- scaffold sheet ---------- */

// Bulk-fill a future month's assignments from history. The user picks one of
// two strategies, previews the per-pot values, then confirms. Income pots
// always copy last month's planned income.

export const SCAFFOLD_OPTIONS: { value: ScaffoldStrategy; label: string }[] = [
  { value: "average_3mo", label: "3-month average" },
  { value: "last_month", label: "Last month" },
];

export function ScaffoldSheet({ month, onClose, onScaffolded }: {
  month: string;
  onClose: () => void;
  onScaffolded: () => void;
}) {
  const [strategy, setStrategy] = useState<ScaffoldStrategy>("average_3mo");
  const [lines, setLines] = useState<ScaffoldLine[] | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const loadPreview = async (s: ScaffoldStrategy) => {
    setLoadingPreview(true);
    setFailed(null);
    try {
      const r = await fetch("/api/assign/scaffold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, strategy: s, dryRun: true }),
      });
      const d = (await r.json().catch(() => ({}))) as Partial<ScaffoldResponse & ErrorResponse>;
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setLines(d.lines ?? []);
    } catch (e) {
      setFailed((e as Error).message);
    }
    setLoadingPreview(false);
  };

  useEffect(() => {
    setConfirming(false);
    loadPreview(strategy);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy]);

  const apply = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const r = await fetch("/api/assign/scaffold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, strategy }),
      });
      const d = (await r.json().catch(() => ({}))) as Partial<ScaffoldResponse & ErrorResponse>;
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      onScaffolded();
      onClose();
    } catch (e) {
      setFailed((e as Error).message);
    }
    setBusy(false);
  };

  const total = (lines ?? []).reduce((a, l) => a + l.cents, 0);

  return (
    <Sheet label={`Scaffold ${monthLabel(month)}`} onClose={onClose}>
      <div className="mb-1.5 text-[17px] font-semibold">Scaffold {monthLabel(month)}</div>
      <p className="mb-3 text-[14px] text-[var(--muted)]">
        Fill every pot from its assigned history. Income pots copy last month's planned income.
      </p>
      <Segmented options={SCAFFOLD_OPTIONS} value={strategy} onChange={setStrategy} ariaLabel="Scaffold strategy" />
      <div className="mt-4">
        {loadingPreview ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-6" />
            ))}
          </div>
        ) : failed ? (
          <FetchError onRetry={() => loadPreview(strategy)} label="Couldn't preview the scaffold." />
        ) : (
          <>
            <ul className="max-h-64 space-y-1.5 overflow-y-auto">
              {(lines ?? []).map((l) => (
                <li key={l.potId} className="flex items-baseline justify-between gap-3 text-[14px]">
                  <span className="truncate text-[var(--ink-2)]">
                    {l.name}
                    {l.income && <span className="text-[var(--faint)]"> · planned</span>}
                    {l.scheduled && <span className="text-[var(--faint)]"> · schedule</span>}
                  </span>
                  <span className="t-nums shrink-0 font-medium">{money(l.cents)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex justify-between border-t border-[var(--hairline)] pt-2 text-[14px]">
              <span className="text-[var(--muted)]">Total</span>
              <span className="t-nums font-semibold">{money(total)}</span>
            </div>
          </>
        )}
      </div>
      <div className="mt-4 border-t border-[var(--hairline)] pt-4">
        {confirming ? (
          <div>
            <p className="text-[14px] text-[var(--ink-2)]">
              Set these assignments for {monthLabel(month)}? This overwrites any values already set.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="flex-1 rounded-[var(--r-md)] border border-[var(--hairline-strong)] px-4 py-2.5 text-[15px] font-medium text-[var(--ink-2)] transition active:scale-[0.99]"
              >
                Cancel
              </button>
              <button onClick={apply} disabled={busy} className="btn-ink flex-1 px-4 py-2.5 text-[15px]">
                {busy ? "Scaffolding…" : "Confirm scaffold"}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            disabled={!lines || loadingPreview}
            className="btn-ink w-full py-2.5 text-[15px]"
          >
            Scaffold {(lines ?? []).length} pots
          </button>
        )}
        {failed && !loadingPreview && <p className="mt-2 text-center text-[13px] text-[var(--danger)]">{failed}</p>}
      </div>
    </Sheet>
  );
}
