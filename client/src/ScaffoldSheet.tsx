import { send } from "./api";
import { useEffect, useState } from "react";
import { money, monthLabel } from "./format";
import type { ErrorResponse, Pot, ScaffoldLine, ScaffoldResponse, ScaffoldStrategy } from "./types";
import { FetchError, Segmented, Sheet, Skeleton } from "./ui";

/* ---------- fill from history ---------- */

// Bulk-fill a month's assignments from history ("scaffolding" on the
// server). The user picks one of two strategies, previews the per-pot values
// against what is set now, then confirms. Income pots always copy last
// month's planned income; they are shown apart, as the plan the
// assignments are measured against.

export const SCAFFOLD_OPTIONS: { value: ScaffoldStrategy; label: string }[] = [
  { value: "average_3mo", label: "3-month average" },
  { value: "last_month", label: "Last month" },
];

function FillRow({ line, current }: { line: ScaffoldLine; current: number | undefined }) {
  const changes = current !== undefined && current !== line.cents;
  return (
    <li className="flex items-baseline justify-between gap-3 text-md">
      <span className="truncate text-[var(--ink-2)]">
        {line.name}
        {line.scheduled && <span className="text-[var(--muted)]"> · schedule</span>}
      </span>
      <span className="t-nums shrink-0">
        {changes && current !== undefined && (
          <span className="text-[var(--muted)]">
            {money(current)} <span aria-label="becomes">→</span>{" "}
          </span>
        )}
        <span className="font-medium">{money(line.cents)}</span>
      </span>
    </li>
  );
}

export function ScaffoldSheet({ month, pots, onClose, onScaffolded }: {
  month: string;
  /** The month's pots as loaded, for the current amount on each row. */
  pots?: Pot[];
  onClose: () => void;
  onScaffolded: () => void;
}) {
  const [strategy, setStrategy] = useState<ScaffoldStrategy>("average_3mo");
  const [lines, setLines] = useState<ScaffoldLine[] | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [applyFailed, setApplyFailed] = useState<string | null>(null);

  const loadPreview = async (s: ScaffoldStrategy) => {
    setLoadingPreview(true);
    setPreviewFailed(false);
    setApplyFailed(null);
    try {
      const r = await fetch("/api/assign/scaffold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, strategy: s, dryRun: true }),
      });
      const d = (await r.json().catch(() => ({}))) as Partial<ScaffoldResponse & ErrorResponse>;
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setLines(d.lines ?? []);
    } catch {
      setPreviewFailed(true);
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
    setApplyFailed(null);
    try {
      const r = await send("/api/assign/scaffold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, strategy }),
      });
      const d = (await r.json().catch(() => ({}))) as Partial<ScaffoldResponse & ErrorResponse>;
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      onScaffolded();
      onClose();
    } catch (e) {
      setApplyFailed((e as Error).message);
    }
    setBusy(false);
  };

  const all = lines ?? [];
  const assignable = all.filter((l) => !l.income);
  const income = all.filter((l) => l.income);
  const assignTotal = assignable.reduce((a, l) => a + l.cents, 0);
  const plannedTotal = income.reduce((a, l) => a + l.cents, 0);
  const currentOf = new Map((pots ?? []).map((p) => [p.id, p.assignedCents]));
  const n = assignable.length;

  return (
    <Sheet label={`Fill ${monthLabel(month)} from history`} onClose={onClose}>
      <div className="mb-1.5 text-lg font-semibold">Fill {monthLabel(month)} from history</div>
      <p className="mb-3 text-sm text-[var(--muted)]">
        Set every pot from what you assigned before. Planned income copies last month's.
      </p>
      <Segmented options={SCAFFOLD_OPTIONS} value={strategy} onChange={setStrategy} ariaLabel="Fill strategy" />
      <div className="mt-4">
        {loadingPreview ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-6" />
            ))}
          </div>
        ) : previewFailed ? (
          <FetchError onRetry={() => loadPreview(strategy)} label="Couldn't work out the amounts to fill." />
        ) : (
          <>
            <ul className="max-h-64 space-y-1.5 overflow-y-auto">
              {assignable.map((l) => (
                <FillRow key={l.potId} line={l} current={currentOf.get(l.potId)} />
              ))}
            </ul>
            {income.length > 0 && (
              <>
                <div className="mb-1 mt-3 text-xs text-[var(--muted)]">Planned income</div>
                <ul className="space-y-1.5">
                  {income.map((l) => (
                    <FillRow key={l.potId} line={l} current={currentOf.get(l.potId)} />
                  ))}
                </ul>
              </>
            )}
            <div className="t-nums mt-3 border-t border-[var(--hairline)] pt-2 text-md">
              Assigns <span className="font-semibold">{money(assignTotal)}</span>
              {plannedTotal > 0 ? (
                <>
                  {" "}of <span className="font-semibold">{money(plannedTotal)}</span> planned
                </>
              ) : (
                <span className="text-[var(--muted)]"> · no planned income yet</span>
              )}
            </div>
          </>
        )}
      </div>
      <div className="mt-4 border-t border-[var(--hairline)] pt-4">
        {confirming ? (
          <div>
            <p className="text-sm text-[var(--ink-2)]">
              Set these amounts for {monthLabel(month)}? This replaces any values already set.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => setConfirming(false)}
                disabled={busy}
                className="flex-1 rounded-[var(--r-md)] border border-[var(--hairline-strong)] px-4 py-2.5 text-md font-medium text-[var(--ink-2)] transition active:scale-[0.99]"
              >
                Cancel
              </button>
              <button onClick={apply} disabled={busy} className="btn-ink flex-1 px-4 py-2.5 text-md">
                {busy ? "Filling…" : "Fill now"}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            disabled={!lines || loadingPreview || previewFailed}
            className="btn-ink w-full py-2.5 text-md"
          >
            Fill {n} pot{n === 1 ? "" : "s"}
          </button>
        )}
        {applyFailed && (
          <p role="alert" className="mt-2 text-center text-sm text-[var(--danger)]">
            Couldn't save these amounts: {applyFailed}
          </p>
        )}
      </div>
    </Sheet>
  );
}
