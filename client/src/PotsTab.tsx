import { useState } from "react";
import { BudgetTable } from "./BudgetTable";
import { PotSheet } from "./PotSheet";
import { ScaffoldSheet } from "./ScaffoldSheet";
import { useApi } from "./api";
import { money, monthLabel, titleCase, trendLabel } from "./format";
import { ClosePreviewData, Pot, TrendPoint } from "./types";
import { FetchError, Skeleton } from "./ui";

/* ---------- close summary card ---------- */

// High-level month view at the top of the Pots tab: Income, Spend, Savings,
// which net to zero (Income minus Spend minus Savings). Reuses the
// close-preview data and the month-end close logic: on the current month the
// close action is offered once ready-to-assign is $0. Past months are
// read-only; the card is hidden on future months.
export function CloseSummaryCard({ month, onClosed }: { month: string; onClosed: () => void }) {
  const current = new Date().toISOString().slice(0, 7);
  const isFuture = month > current;
  const isCurrent = month === current;
  const { data: preview, error, loading, retry } = useApi<ClosePreviewData>(
    isFuture ? null : `/api/close-preview?month=${month}`
  );
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  if (isFuture) return null;

  if (loading) {
    return (
      <section className="card mb-6 p-5" aria-label="Month close summary">
        <Skeleton className="h-6 w-44" />
        <div className="mt-4 grid grid-cols-3 gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      </section>
    );
  }

  if (error || !preview) {
    return (
      <div className="mb-6">
        <FetchError onRetry={retry} label="Couldn't load the close summary." />
      </div>
    );
  }

  const income = preview.inflowsCents;
  const spend = preview.spentCents;
  const savings = income - spend;
  const rta = preview.rtaBeforeCents;
  const closed = preview.closed;

  const doClose = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const r = await fetch("/api/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setConfirming(false);
      onClosed();
    } catch (e) {
      setFailed((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <section className="card mb-6 p-5" aria-label={`Month close for ${monthLabel(month)}`}>
      <div className="mb-3 flex items-baseline justify-between">
        <div className="text-[17px] font-semibold">Month close</div>
        {closed ? (
          <span className="rounded-[var(--r-pill)] bg-[var(--bg-sunken)] px-2.5 py-1 text-[12px] font-medium text-[var(--muted)]">
            Closed
          </span>
        ) : (
          <span className="text-[12px] text-[var(--muted)]">{monthLabel(month)}</span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          { label: "Income", cents: income },
          { label: "Spend", cents: spend },
          { label: "Savings", cents: savings },
        ].map((s) => (
          <div key={s.label} className="rounded-[var(--r-md)] bg-[var(--bg-sunken)] px-2 py-3">
            <div className="text-[12px] text-[var(--muted)]">{s.label}</div>
            <div className="t-nums mt-0.5 text-[17px] font-medium leading-none">{money(s.cents)}</div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-center text-[13px] text-[var(--muted)]">
        Income − Spend − Savings = <span className="t-nums font-medium text-[var(--ink-2)]">{money(income - spend - savings)}</span>
      </p>
      {isCurrent && !closed && (
        <div className="mt-3 border-t border-[var(--hairline)] pt-3">
          {rta === 0 ? (
            confirming ? (
              <div>
                <p className="text-[14px] text-[var(--ink-2)]">
                  Close {monthLabel(month)}? This records the close and sets next month's fill amounts.
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => setConfirming(false)}
                    disabled={busy}
                    className="flex-1 rounded-[var(--r-md)] border border-[var(--hairline-strong)] px-4 py-2.5 text-[15px] font-medium text-[var(--ink-2)] transition active:scale-[0.99]"
                  >
                    Cancel
                  </button>
                  <button onClick={doClose} disabled={busy} className="btn-ink flex-1 px-4 py-2.5 text-[15px]">
                    {busy ? "Closing…" : "Close month"}
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => setConfirming(true)} className="btn-ink w-full py-2.5 text-[15px]">
                Close {monthLabel(month)}
              </button>
            )
          ) : (
            <p className="text-center text-[13px] text-[var(--muted)]">
              <span className="t-nums font-medium text-[var(--ink-2)]">{money(rta)}</span> still to assign before the
              month can close.
            </p>
          )}
          {failed && <p className="mt-2 text-center text-[13px] text-[var(--danger)]">{failed}</p>}
        </div>
      )}
    </section>
  );
}

export function PotsTab({ month }: { month: string }) {
  const current = new Date().toISOString().slice(0, 7);
  const isFuture = month > current;
  const { data, error, loading, retry } = useApi<{ pots: Pot[]; rtaCents: number }>(`/api/pots?month=${month}`);
  const { data: trendData } = useApi<{ trend: TrendPoint[] }>("/api/trend");
  const [sheetPot, setSheetPot] = useState<Pot | "new" | null>(null);
  const [scaffoldOpen, setScaffoldOpen] = useState(false);
  const pots = data?.pots ?? [];
  const groups = [...new Set(pots.map((p) => p.group))].sort();

  return (
    <div>
      <div className="mb-5 flex items-baseline justify-between">
        <div className="font-serif-d text-[24px] font-medium">Pots</div>
        <div className="flex gap-2">
          {isFuture && !loading && !error && (
            <button onClick={() => setScaffoldOpen(true)} className="btn-ink px-4 py-2 text-[14px]">
              Scaffold month
            </button>
          )}
          <button onClick={() => setSheetPot("new")} className="btn-ink px-4 py-2 text-[14px]">Add pot</button>
        </div>
      </div>
      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[64px]" />)}
        </div>
      ) : error ? (
        <FetchError onRetry={retry} label="Couldn't load pots." />
      ) : pots.length === 0 ? (
        <div className="rounded-[var(--r-lg)] border border-dashed border-[var(--line)] px-6 py-16 text-center">
          <div className="font-serif-d text-[22px] font-medium">No pots yet</div>
          <p className="mx-auto mt-2 max-w-[340px] text-[14px] text-[var(--ink-2)]">
            Pots are the buckets your money lives in. Create your first one to start budgeting.
          </p>
          <button onClick={() => setSheetPot("new")} className="btn-ink mt-5 px-5 py-2.5 text-[15px]">
            Create your first pot
          </button>
        </div>
      ) : (
        <>
          <CloseSummaryCard month={month} onClosed={retry} />
          <PotsSummary month={month} pots={pots} rtaCents={data?.rtaCents ?? 0} trend={trendData?.trend ?? []} />
          <BudgetTable pots={pots} month={month} onAssigned={retry} onEditPot={(p) => setSheetPot(p)} />
        </>
      )}
      {scaffoldOpen && (
        <ScaffoldSheet month={month} onClose={() => setScaffoldOpen(false)} onScaffolded={retry} />
      )}
      {sheetPot && (
        <PotSheet
          pot={sheetPot === "new" ? null : sheetPot}
          groups={groups}
          pots={pots}
          onClose={() => setSheetPot(null)}
          onSaved={retry}
        />
      )}
    </div>
  );
}

/* ---------- pots summary ---------- */

// Compact month summary shown on the Pots page: ready-to-assign, top
// spending groups, and a six-month sparkline. The close card above it already
// covers this month's spend, so this stays a summary, not a dashboard.
export function TrendSpark({ trend }: { trend: TrendPoint[] }) {
  if (trend.length === 0) return null;
  const W = 300;
  const H = 72;
  const PAD = 4; // keep the stroke and end dot off the top/bottom edges
  const max = Math.max(...trend.map((t) => (Number.isFinite(t.spent) ? t.spent : 0)), 0) * 1.1 || 1;
  const n = trend.length;
  // x as a fraction of width: points sit at the centre of each label column.
  const xFrac = (i: number) => (i + 0.5) / n;
  const yFrac = (v: number) => {
    const s = Number.isFinite(v) ? Math.max(0, v) : 0;
    return (PAD + (1 - s / max) * (H - 2 * PAD)) / H;
  };
  const pts = trend.map((t, i) => [xFrac(i) * W, yFrac(t.spent) * H] as const);
  const line = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = n > 1 ? `${line} L${pts[n - 1][0].toFixed(2)},${H} L${pts[0][0].toFixed(2)},${H} Z` : "";
  const last = trend[n - 1];
  // Static id: every instance defines an identical gradient, so a duplicate is harmless.
  const gradId = "trend-spark-fill";
  return (
    <div>
      <div className="relative h-[72px]" role="img" aria-label="Spending trend, last six months">
        <svg
          className="absolute inset-0 h-full w-full overflow-visible"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: "var(--bar)", stopOpacity: 0.22 }} />
              <stop offset="100%" style={{ stopColor: "var(--bar)", stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          {n > 1 && (
            <>
              <path d={area} fill={`url(#${gradId})`} stroke="none" />
              <path
                d={line}
                fill="none"
                style={{ stroke: "var(--bar)" }}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}
        </svg>
        {/* End dot as HTML so it stays round when the SVG stretches. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            left: `${xFrac(n - 1) * 100}%`,
            top: `${yFrac(last.spent) * 100}%`,
            background: "var(--bar)",
            boxShadow: "0 0 0 2px var(--surface)",
          }}
        />
        {/* Invisible per-month hover targets carry the exact figures. */}
        <div className="absolute inset-0 flex">
          {trend.map((t) => (
            <div key={t.month} className="h-full flex-1" title={`${monthLabel(t.month)}: ${money(t.spent)}`} />
          ))}
        </div>
      </div>
      <ul className="sr-only">
        {trend.map((t) => (
          <li key={t.month}>{`${monthLabel(t.month)}: ${money(t.spent)}`}</li>
        ))}
      </ul>
      <div className="mt-1 flex" aria-hidden="true">
        {trend.map((t) => (
          <span key={t.month} className="t-nums flex-1 text-center text-[10px] text-[var(--faint)]">
            {trendLabel(t.month)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function PotsSummary({
  month,
  pots,
  rtaCents,
  trend,
}: {
  month: string;
  pots: Pot[];
  rtaCents: number;
  trend: TrendPoint[];
}) {
  const spent = pots.reduce((a, p) => a + p.spentCents, 0);
  const byGroup = new Map<string, number>();
  for (const p of pots) {
    if (p.spentCents > 0) byGroup.set(p.group, (byGroup.get(p.group) ?? 0) + p.spentCents);
  }
  const top = [...byGroup.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  return (
    <section className="card mb-6 p-5" aria-label={`Summary for ${monthLabel(month)}`}>
      <div>
        <div className="text-[12px] text-[var(--muted)]">Ready to assign</div>
        <div className="t-nums font-serif-d mt-0.5 text-[32px] font-light leading-none text-[var(--accent)]">{money(rtaCents)}</div>
      </div>
      {top.length > 0 && (
        <div className="mt-4 border-t border-[var(--hairline)] pt-3">
          <div className="mb-1.5 text-[12px] text-[var(--muted)]">Top groups</div>
          <ul className="space-y-1.5">
            {top.map(([group, cents]) => (
              <li key={group} className="flex items-baseline justify-between gap-3 text-[14px]">
                <span className="truncate text-[var(--ink-2)]">{titleCase(group)}</span>
                <span className="t-nums shrink-0 font-medium">{money(cents)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {trend.length > 1 && (
        <div className="mt-4 border-t border-[var(--hairline)] pt-3">
          <div className="mb-2 text-[12px] text-[var(--muted)]">Six-month spend</div>
          <TrendSpark trend={trend} />
        </div>
      )}
      {spent === 0 && trend.length === 0 && (
        <p className="mt-3 text-[14px] italic text-[var(--muted)]">No spending recorded yet.</p>
      )}
    </section>
  );
}
