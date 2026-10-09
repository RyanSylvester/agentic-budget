import { useEffect, useRef, useState } from "react";
import { BudgetTable } from "./BudgetTable";
import { CoverSheet, CoverToast, OverspentLine, overspentLabel, overspentSummary, revealFirstOverspent, type CoverSource } from "./Overspent";
import { PotSheet } from "./PotSheet";
import { ScaffoldSheet } from "./ScaffoldSheet";
import { useApi, send } from "./api";
import { MONTHS, money, monthLabel, titleCase, todayLocal, trendLabel } from "./format";
import type { ClosePreview, Pot, PotsResponse, TrendPoint, TrendResponse } from "./types";
import { FetchError, Skeleton } from "./ui";

/* ---------- month timing ---------- */

/** Where a month sits relative to today. `today` is YYYY-MM-DD (local, like
 *  the rest of the app's month math); Storybook passes a fixed one. */
export function monthTiming(month: string, today = todayLocal()) {
  const current = today.slice(0, 7);
  const [y, m] = current.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const daysLeft = lastDay - Number(today.slice(8, 10));
  const isCurrent = month === current;
  return {
    current,
    isCurrent,
    isPast: month < current,
    isFuture: month > current,
    /** The last three days of the running month, when closing early is offered. */
    closingWindow: isCurrent && daysLeft <= 2,
    daysLeft,
  };
}

const monthName = (ym: string) => MONTHS[Number(ym.slice(5, 7)) - 1];

/* ---------- month status badge ---------- */

export function MonthStatusBadge({ closed }: { closed: boolean }) {
  return closed ? (
    <span className="rounded-[var(--r-pill)] bg-[var(--bg-sunken)] px-2.5 py-1 text-xs font-medium text-[var(--muted)]">
      Closed
    </span>
  ) : (
    <span className="rounded-[var(--r-pill)] bg-[var(--warning-soft)] px-2.5 py-1 text-xs font-medium text-[var(--ink-2)]">
      Open · not closed yet
    </span>
  );
}

/* ---------- close banner ---------- */

// The month close, as a compact banner that only appears when there is
// something to do: a past month left open, the last days of the running
// month (closing early), or a close that just happened. Income, spend and
// what went unspent sit on one line; the confirm step spells out what the
// close changes (savings, next month's fill amounts) before it runs.
export function CloseSummaryCard({ month, today, onClosed, onGoMonth }: {
  month: string;
  /** YYYY-MM-DD; defaults to the real date. */
  today?: string;
  onClosed: () => void;
  /** Jump to another month (the link to next month after closing). */
  onGoMonth?: (m: string) => void;
}) {
  const t = monthTiming(month, today);
  const relevant = t.isPast || t.closingWindow;
  const { data: preview, error, loading, retry } = useApi<ClosePreview>(
    relevant ? `/api/close-preview?month=${month}` : null
  );
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [justClosed, setJustClosed] = useState(false);

  if (!relevant) return null;

  if (loading) {
    return (
      <section className="card mb-5 px-4 py-3.5" aria-label="Month close">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="mt-2 h-4 w-72 max-w-full" />
      </section>
    );
  }

  if (error || !preview) {
    return (
      <div className="mb-5">
        <FetchError onRetry={retry} label="Couldn't load the month close." />
      </div>
    );
  }

  const next = preview.nextMonth;

  if (justClosed) {
    return (
      <section role="status" className="card mb-5 px-4 py-3.5" aria-label={`Month close for ${monthLabel(month)}`}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="text-md">
            <span className="font-medium">{monthLabel(month)} is closed.</span>{" "}
            <span className="text-[var(--ink-2)]">{monthName(next)}'s fill amounts are set.</span>
          </p>
          {onGoMonth && (
            <button
              onClick={() => onGoMonth(next)}
              className="min-h-11 text-md font-medium text-[var(--accent)] transition active:scale-[0.98]"
            >
              Go to {monthName(next)} <span aria-hidden>→</span>
            </button>
          )}
        </div>
      </section>
    );
  }

  // Already closed and nothing just happened here: the header badge says so.
  if (preview.closed) return null;

  const income = preview.inflowsCents;
  const spend = preview.spentCents;
  const rta = preview.rtaBeforeCents;
  const early = t.isCurrent;
  const fills = preview.pots.filter((p) => p.assignable && p.wireframeCents > 0);
  const fillTotal = fills.reduce((a, p) => a + p.wireframeCents, 0);

  const doClose = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const r = await send("/api/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setConfirming(false);
      setJustClosed(true);
      retry();
      onClosed();
    } catch (e) {
      setFailed((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <section className="card mb-5 px-4 py-3.5" aria-label={`Month close for ${monthLabel(month)}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="text-md font-medium">
            {early
              ? t.daysLeft === 0
                ? `${monthName(month)} ends today`
                : `${monthName(month)} ends in ${t.daysLeft} day${t.daysLeft === 1 ? "" : "s"}`
              : `${monthName(month)} isn't closed yet`}
          </div>
          <div className="t-nums mt-0.5 text-sm text-[var(--muted)]">
            <span className="whitespace-nowrap">Income {money(income)}</span> ·{" "}
            <span className="whitespace-nowrap">Spend {money(spend)}</span> ·{" "}
            <span className="whitespace-nowrap">Unspent {money(income - spend)}</span>
          </div>
        </div>
        {rta === 0 && !confirming && (
          <button onClick={() => setConfirming(true)} className="btn-ink min-h-11 shrink-0 px-4 text-md">
            {early ? "Close early" : `Close ${monthName(month)}`}
          </button>
        )}
      </div>
      {early && !confirming && rta === 0 && (
        <p className="mt-2 text-sm text-[var(--muted)]">
          Late transactions may still arrive for {monthName(month)} after you close it.
        </p>
      )}
      {rta !== 0 && (
        // The amount lives in Ready to assign below; here we only say what
        // unlocks the close, so the figure is not repeated.
        <p className="mt-2 text-sm text-[var(--muted)]">
          {rta > 0
            ? "Close opens once everything in Ready to assign has a job."
            : "More is assigned than came in. Bring Ready to assign back to $0 to close the month."}
        </p>
      )}
      {confirming && (
        <div className="mt-3 border-t border-[var(--hairline)] pt-3">
          <p className="text-md font-medium">Close {monthLabel(month)}?</p>
          <ul className="mt-1.5 space-y-1 text-sm text-[var(--ink-2)]">
            <li>
              {preview.movedToSavingsCents > 0 ? (
                <>
                  <span className="t-nums font-medium text-[var(--ink)]">{money(preview.movedToSavingsCents)}</span> moves to
                  savings.
                </>
              ) : (
                "Nothing moves to savings: every dollar already has a job."
              )}
            </li>
            {preview.sharedOwedBy.map((o) => (
              <li key={o.name}>
                {o.name} still owes <span className="t-nums">{money(o.cents)}</span>; that stays open.
              </li>
            ))}
            {early && <li>Late transactions may still arrive for {monthName(month)}.</li>}
          </ul>
          {fills.length > 0 ? (
            <div className="mt-3">
              <div className="mb-1 text-xs text-[var(--muted)]">{monthName(next)} starts with these fill amounts</div>
              <div className="rounded-[var(--r-md)] bg-[var(--bg-sunken)] px-3 py-2">
                <ul className="max-h-40 space-y-1 overflow-y-auto">
                  {fills.map((p) => (
                    <li key={p.potId} className="flex items-baseline justify-between gap-3 text-md">
                      <span className="truncate text-[var(--ink-2)]">
                        {p.name}
                        {p.wireframeSkipped && <span className="text-[var(--muted)]"> · schedule</span>}
                      </span>
                      <span className="t-nums shrink-0">{money(p.wireframeCents)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-[var(--hairline)] pt-1 text-md">
                  <span className="text-[var(--muted)]">Total</span>
                  <span className="t-nums shrink-0 font-medium">{money(fillTotal)}</span>
                </div>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-sm text-[var(--muted)]">No fill amounts for {monthName(next)} yet: there's no history to copy.</p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="flex-1 rounded-[var(--r-md)] border border-[var(--hairline-strong)] px-4 py-2.5 text-md font-medium text-[var(--ink-2)] transition active:scale-[0.99]"
            >
              Cancel
            </button>
            <button onClick={doClose} disabled={busy} className="btn-ink flex-1 px-4 py-2.5 text-md">
              {busy ? "Closing…" : `Close ${monthName(month)}`}
            </button>
          </div>
        </div>
      )}
      {failed && <p className="mt-2 text-sm text-[var(--danger)]">Couldn't close the month: {failed}</p>}
    </section>
  );
}

/* "Start assigning": bring the budget table into view and put focus on the
 * first Assigned amount, which is where money gets a job. */
function focusFirstAssignCell() {
  const cell = document.querySelector<HTMLButtonElement>('#budget-table button[title^="Assign to"]');
  const target = cell ?? document.getElementById("budget-table");
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
  cell?.focus({ preventScroll: true });
}

export function PotsTab({ month, today, onGoMonth }: {
  month: string;
  /** YYYY-MM-DD; defaults to the real date. Storybook pins it. */
  today?: string;
  /** Jump to another month (AppShell owns the month). */
  onGoMonth?: (m: string) => void;
}) {
  const t = monthTiming(month, today);
  const { data, error, loading, retry } = useApi<PotsResponse>(`/api/pots?month=${month}`);
  const { data: trendData } = useApi<TrendResponse>("/api/trend");
  // Same URL as the close banner, so the cache serves both from one fetch.
  const { data: closeData } = useApi<ClosePreview>(
    t.isPast || t.closingWindow ? `/api/close-preview?month=${month}` : null
  );
  const [sheetPot, setSheetPot] = useState<Pot | "new" | null>(null);
  const [scaffoldOpen, setScaffoldOpen] = useState(false);
  const [coverPot, setCoverPot] = useState<Pot | null>(null);
  const { optimistic, moved, move, undo, dismiss } = useCoverMove(month, data);
  const pots = optimistic.pots(data?.pots ?? []);
  const rta = optimistic.rta(data?.rtaCents ?? 0);
  const over = overspentSummary(pots);
  const groups = [...new Set(pots.map((p) => p.group))].sort();
  const nothingAssigned = pots.every((p) => !p.assignable || p.assignedCents === 0);
  // Fill from history is offered on future months, and on the current month
  // while nothing is assigned yet (there it is the empty state's action).
  const canFill = t.isFuture || (t.isCurrent && nothingAssigned);
  const fillInSummary = canFill && nothingAssigned;
  const showBadge = closeData && (t.isPast || closeData.closed);

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex items-center gap-2.5">
          <div className="font-serif-d text-xl font-medium">Pots</div>
          {showBadge && <MonthStatusBadge closed={closeData.closed} />}
        </div>
        <div className="flex gap-2">
          {canFill && !fillInSummary && !loading && !error && pots.length > 0 && (
            <button onClick={() => setScaffoldOpen(true)} className="btn-ghost px-4 py-2 text-md">
              Fill from history
            </button>
          )}
          <button onClick={() => setSheetPot("new")} className="btn-ink px-4 py-2 text-md">Add pot</button>
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
          <div className="font-serif-d text-xl font-medium">No pots yet</div>
          <p className="mx-auto mt-2 max-w-[340px] text-md text-[var(--ink-2)]">
            Pots are the buckets your money lives in. Create your first one to start budgeting.
          </p>
          <button onClick={() => setSheetPot("new")} className="btn-ink mt-5 px-5 py-2.5 text-md">
            Create your first pot
          </button>
        </div>
      ) : (
        <>
          <CloseSummaryCard month={month} today={today} onClosed={retry} onGoMonth={onGoMonth} />
          <PotsSummary
            month={month}
            pots={pots}
            rtaCents={rta}
            planning={t.isFuture ? "future" : t.isCurrent ? "current" : "past"}
            onAssign={focusFirstAssignCell}
            onFill={fillInSummary ? () => setScaffoldOpen(true) : undefined}
            overspent={over}
            onShowOverspent={revealFirstOverspent}
          />
          <div id="budget-table">
            <BudgetTable
              pots={pots}
              month={month}
              onAssigned={retry}
              onEditPot={(p) => setSheetPot(p)}
              onCover={(p) => setCoverPot(p)}
            />
          </div>
          <SpendInsights month={month} pots={pots} trend={trendData?.trend ?? []} />
        </>
      )}
      {coverPot && (
        <CoverSheet
          pot={coverPot}
          pots={pots}
          rtaCents={rta}
          onClose={() => setCoverPot(null)}
          onCover={(source, cents) => {
            setCoverPot(null);
            move(source, coverPot, cents);
          }}
        />
      )}
      {moved && <CoverToast text={moved.text} error={moved.error} onUndo={undo} onDismiss={dismiss} />}
      {scaffoldOpen && (
        <ScaffoldSheet month={month} pots={pots} onClose={() => setScaffoldOpen(false)} onScaffolded={retry} />
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

/* ---------- cover an overspent pot ---------- */

const UNDO_MS = 6000;

/** Moves assigned dollars to an overspent pot through POST /api/assign/move,
 *  shown at once (an override on top of the loaded pots until the refetch
 *  lands), with Undo for a few seconds. A failed move rolls back and says so. */
function useCoverMove(month: string, data: PotsResponse | null) {
  // Pot id -> assigned delta, and the Ready to assign delta, not yet in `data`.
  const [deltas, setDeltas] = useState<{ pots: Record<number, number>; rta: number } | null>(null);
  const [moved, setMoved] = useState<{ fromId: number | null; toId: number; cents: number; text: string; error?: string | null } | null>(null);
  const inflight = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fresh pots arrived from the server: they include the move.
  useEffect(() => {
    if (inflight.current === 0) setDeltas(null);
  }, [data]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const post = async (fromId: number | null, toId: number | null, cents: number) => {
    setDeltas((d) => {
      const pots = { ...(d?.pots ?? {}) };
      if (fromId !== null) pots[fromId] = (pots[fromId] ?? 0) - cents;
      if (toId !== null) pots[toId] = (pots[toId] ?? 0) + cents;
      return { pots, rta: (d?.rta ?? 0) + (fromId === null ? -cents : 0) + (toId === null ? cents : 0) };
    });
    inflight.current++;
    try {
      const r = await send("/api/assign/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, fromPotId: fromId, toPotId: toId, cents }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${r.status}`);
      }
      return null;
    } catch (e) {
      setDeltas(null);
      return (e as Error).message;
    } finally {
      inflight.current--;
    }
  };

  const arm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMoved(null), UNDO_MS);
  };

  return {
    optimistic: {
      pots: (ps: Pot[]) =>
        deltas ? ps.map((p) => (deltas.pots[p.id] ? { ...p, assignedCents: p.assignedCents + deltas.pots[p.id] } : p)) : ps,
      rta: (cents: number) => cents + (deltas?.rta ?? 0),
    },
    moved,
    move: async (source: CoverSource, target: Pot, cents: number) => {
      const text = `Moved ${money(cents)} from ${source.name} to ${target.name}`;
      setMoved({ fromId: source.potId, toId: target.id, cents, text });
      arm();
      const error = await post(source.potId, target.id, cents);
      if (error) setMoved({ fromId: source.potId, toId: target.id, cents, text, error: `Couldn't cover ${target.name}: ${error}` });
    },
    undo: async () => {
      if (!moved) return;
      if (timer.current) clearTimeout(timer.current);
      setMoved(null);
      const error = await post(moved.toId, moved.fromId, moved.cents);
      if (error) {
        setMoved({ ...moved, error: `Couldn't undo: ${error}` });
        arm();
      }
    },
    dismiss: () => {
      if (timer.current) clearTimeout(timer.current);
      setMoved(null);
    },
  };
}

/* ---------- pots summary ---------- */

// The first thing on the Pots page, straight above the budget table:
// ready-to-assign (its one home on this screen, with the action that leads
// to assigning), or, while the month's income is still planned rather than
// received, what is left to plan. Top groups and the sparkline live in
// SpendInsights below the table.
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
          <span key={t.month} className="t-nums flex-1 text-center text-2xs text-[var(--muted)]">
            {trendLabel(t.month)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Planned income and assignments for a month, as the budget table derives
 *  them: income pots carry planned income in their assigned amount, and only
 *  assignable pots count as assigned. */
export function monthPlan(pots: Pot[], rtaCents: number) {
  const assignedCents = pots.reduce((a, p) => a + (p.assignable ? p.assignedCents : 0), 0);
  const plannedCents = pots.reduce((a, p) => a + (p.assignable ? 0 : p.assignedCents), 0);
  // RTA = inflows - assigned, so inflows come back out of it.
  const inflowsCents = rtaCents + assignedCents;
  return { assignedCents, plannedCents, inflowsCents };
}

export function PotsSummary({
  month,
  pots,
  rtaCents,
  planning = "current",
  onAssign,
  onFill,
  overspent,
  onShowOverspent,
}: {
  month: string;
  pots: Pot[];
  rtaCents: number;
  /** Where the month sits; future months are always planned, not funded. */
  planning?: "past" | "current" | "future";
  /** Takes the user to the assign controls; omitted, no button is shown. */
  onAssign?: () => void;
  /** Opens Fill from history; shown as the action while nothing is assigned. */
  onFill?: () => void;
  /** Overspent pots this month; a danger line under the figure when any. */
  overspent?: { count: number; cents: number };
  /** Where the overspent line leads (the first overspent row). */
  onShowOverspent?: () => void;
}) {
  const { assignedCents, plannedCents, inflowsCents } = monthPlan(pots, rtaCents);
  // Before the money is in (a future month, or this month's pay still on its
  // way), inflows minus assigned only says "not here yet". Plan against
  // planned income instead, in neutral tones. Red over-assigned is kept for
  // real inflows that the assignments exceed.
  const plan =
    planning === "future" || (planning === "current" && (inflowsCents <= 0 || inflowsCents < plannedCents));
  const left = plannedCents - assignedCents;

  const action = onFill ? (
    <button onClick={onFill} className="btn-ink min-h-11 px-5 text-md">
      Fill from history
    </button>
  ) : onAssign && (plan ? left > 0 : rtaCents !== 0) ? (
    <button onClick={onAssign} className="btn-ink min-h-11 px-5 text-md">
      {plan || rtaCents > 0 ? "Start assigning" : "Review amounts"}
    </button>
  ) : null;

  return (
    <section className="card mb-6 p-5" aria-label={`Summary for ${monthLabel(month)}`}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        {plan ? (
          <div>
            <div className="text-xs text-[var(--muted)]">{left < 0 ? "Planned beyond income" : "Left to plan"}</div>
            <div className="t-nums font-serif-d mt-0.5 text-figure font-light leading-none text-[var(--ink)]">
              {money(Math.abs(left))}
            </div>
            <div className="t-nums mt-1.5 text-sm text-[var(--muted)]">
              {plannedCents === 0 && assignedCents === 0 ? (
                "Nothing planned yet. Set planned income under Income below, then fill the pots."
              ) : (
                <>
                  Planned income {money(plannedCents)} − assigned {money(assignedCents)} ={" "}
                  {left < 0 ? `${money(-left)} more than planned` : `${money(left)} left to plan`}
                </>
              )}
            </div>
            {planning === "current" && inflowsCents > 0 && (
              <div className="t-nums mt-1 text-sm text-[var(--muted)]">
                {money(inflowsCents)} received so far; ready to assign follows as income lands.
              </div>
            )}
          </div>
        ) : (
          <div>
            <div className="text-xs text-[var(--muted)]">Ready to assign</div>
            <div
              className={`t-nums font-serif-d mt-0.5 text-figure font-light leading-none ${
                rtaCents > 0 ? "text-[var(--accent)]" : rtaCents < 0 ? "text-[var(--danger)]" : "text-[var(--ink)]"
              }`}
            >
              {money(rtaCents)}
            </div>
            <div className="mt-1.5 text-sm text-[var(--muted)]">
              {rtaCents > 0
                ? "Give it a job: tap any Assigned amount below."
                : rtaCents < 0
                  ? "More is assigned than came in. Lower an Assigned amount below."
                  : "Every dollar has a job."}
            </div>
          </div>
        )}
        {action}
      </div>
      {overspent && overspent.count > 0 && (
        <div className="mt-4 border-t border-[var(--hairline)] pt-3">
          {onShowOverspent ? (
            <OverspentLine count={overspent.count} cents={overspent.cents} action="Show" onClick={onShowOverspent} className="-ml-1" />
          ) : (
            <p className="t-nums text-md font-medium text-[var(--danger)]">{overspentLabel(overspent.count, overspent.cents)}</p>
          )}
        </div>
      )}
    </section>
  );
}

/* ---------- spend insights ---------- */

// Below the budget table: the month's top spending groups and a six-month
// sparkline. Context, not controls, so it sits after the table.
export function SpendInsights({ month, pots, trend }: { month: string; pots: Pot[]; trend: TrendPoint[] }) {
  const byGroup = new Map<string, number>();
  for (const p of pots) {
    if (p.spentCents > 0) byGroup.set(p.group, (byGroup.get(p.group) ?? 0) + p.spentCents);
  }
  const top = [...byGroup.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (top.length === 0 && trend.length < 2) return null;

  return (
    <section className="card mt-8 p-5" aria-label={`Spending in ${monthLabel(month)}`}>
      {top.length > 0 && (
        <div>
          <div className="mb-1.5 text-xs text-[var(--muted)]">Top groups</div>
          <ul className="space-y-1.5">
            {top.map(([group, cents]) => (
              <li key={group} className="flex items-baseline justify-between gap-3 text-md">
                <span className="truncate text-[var(--ink-2)]">{titleCase(group)}</span>
                <span className="t-nums shrink-0 font-medium">{money(cents)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {trend.length > 1 && (
        <div className={top.length > 0 ? "mt-4 border-t border-[var(--hairline)] pt-3" : ""}>
          <div className="mb-2 text-xs text-[var(--muted)]">Six-month spend</div>
          <TrendSpark trend={trend} />
        </div>
      )}
    </section>
  );
}
