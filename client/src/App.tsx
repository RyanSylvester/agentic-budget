import { useEffect, useRef, useState } from "react";
import { LoginScreen, SignupScreen } from "./AuthScreens";
import { SettingsTab } from "./SettingsTab";
import { useApi, prime } from "./api";
import { MoneyInput } from "./MoneyInput";
import { expressionToCents, evaluateExpression, shareLabel, moneyGrouped } from "./money";

/* ---------- types ---------- */

export interface Txn {
  id: number;
  date: string;
  description: string;
  user_cents: number;
  is_transfer: number;
  split_with_contact: number;
  split_contact_name: string | null;
  source: string;
  shared_cents: number;
}

export interface Overview {
  month: string;
  confirmedSpendCents: number;
  recent: Txn[];
  rtaCents?: number;
  assignedCents?: number;
}

export interface ClosePreviewData {
  month: string;
  nextMonth: string;
  inflowsCents: number;
  spentCents: number;
  assignedCents?: number;
  rtaBeforeCents: number;
  movedToSavingsCents: number;
  sharedOwedCents: number;
  sharedOwedBy: { name: string; cents: number }[];
  closed: boolean;
}

export interface Account {
  id: number;
  name: string;
  type: string;
  last4: string | null;
  workingBalanceCents: number;
  clearedBalanceCents: number;
  lastReconciledAt: string | null;
}

export interface Pot {
  id: number;
  name: string;
  group: string;
  targetType: string;
  targetCents: number;
  spentCents: number;
  sharedCents: number;
  assignable: boolean;
  assignedCents?: number;
  receivedCents?: number;
  contactId: number | null;
  contactName: string | null;
  sharePct: number | null;
  /** Sinking schedule state for the viewed month, null when unscheduled. */
  sinking?: {
    expectedCents: number;
    dueMonth: string;
    cadenceMonths: number;
    contributionCents: number;
    balanceCents: number;
    remainingCents: number;
    monthsLeft: number;
    state: "funding" | "funded" | "overdue";
  } | null;
}

/** A contact's outstanding shared balance. Matches GET /api/contacts. */
export interface ContactBalance {
  id: number;
  name: string;
  totalOwedCents: number;
  creditCents: number;
  byPot: { pot: string; cents: number }[];
  oldest: string | null;
}

export interface TrendPoint {
  month: string;
  spent: number;
}

export interface Attention {
  month: string;
  unreconciledAccounts: Array<string | { name: string }>;
  rtaCents: number;
  unsettledSharedCents: number;
  sharedOwedBy: { contactId: number; name: string; cents: number; netCents?: number }[];
}

export interface PotHistoryPoint {
  month: string;
  spentCents: number;
}

/** One row of the Transactions page: the transaction plus its user-side pot
 *  and the contact's share. Matches GET /api/transactions. */
export interface ListedTxn {
  id: number;
  date: string;
  description: string;
  amountCents: number;
  isTransfer: number;
  cleared: string;
  source: string;
  accountId: number;
  accountName: string;
  potId: number | null;
  potName: string | null;
  potGroup: string | null;
  splitWithContact: number;
  sharedCents: number;
  splitContactId: number | null;
  splitContactName: string | null;
}

/* ---------- helpers ---------- */

// One money format everywhere: grouped thousands, true minus sign.
const money = moneyGrouped;

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const shortMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS_SHORT[m - 1]} ${y}`;
};

// "JOINT LIVING" -> "Joint Living" for serif section headers.
const titleCase = (s: string) =>
  s.split(" ").map((w) => (w === "&" ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(" ");

function shiftMonth(ym: string, delta: number) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// "2026-09-28" -> "Today" / "Yesterday" / "Sep 26". No raw ISO dates in the UI.
function fmtDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(new Date()) - startOf(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
}

// "2026-09" -> "Sep '26" for chart axes.
function trendLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return `${MONTHS[m - 1].slice(0, 3)} '${String(y).slice(2)}`;
}

/* ---------- data ---------- */

/* ---------- primitives ---------- */

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div className="eyebrow">{children}</div>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`skeleton ${className}`} />;
}

export function FetchError({ onRetry, label = "Couldn't load this." }: { onRetry: () => void; label?: string }) {
  return (
    <div className="card p-5 text-center">
      <p className="text-[15px] text-[var(--muted)]">{label}</p>
      <button onClick={onRetry} className="btn-ink mt-3 px-4 py-2 text-[15px]">
        Try again
      </button>
    </div>
  );
}

/* ---------- overview pieces ---------- */

export function Hero({ overview, isCurrent, loading }: { overview: Overview | null; isCurrent: boolean; loading?: boolean }) {
  const today = new Date();
  const day = today.getDate();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  if (loading || !overview) {
    return (
      <div className="pb-1 pt-2">
        <Skeleton className="h-[56px] w-56" />
        <Skeleton className="mt-2.5 h-5 w-44" />
      </div>
    );
  }
  const spent = overview.confirmedSpendCents;
  const daily = spent / Math.max(1, day);
  return (
    <div className="pb-1 pt-2">
      {!isCurrent && (
        <div className="text-[17px] text-[var(--muted)]">final for the month</div>
      )}
      <div className="t-nums font-serif-d mt-1 text-[56px] font-light leading-none tracking-[-0.02em]">
        {money(spent)}
      </div>
      <div className="mt-2.5 text-[15px]">
        {isCurrent ? (
          <>
            <span className="t-nums font-medium text-[var(--ink-2)]">{money(Math.round(daily))}/day</span>
            <span className="text-[var(--muted)]"> · day {day} of {daysInMonth}</span>
          </>
        ) : (
          <span className="text-[var(--muted)]">{monthLabel(overview.month)}</span>
        )}
      </div>
      {isCurrent && overview.rtaCents != null && (
        <div className="mt-1.5 text-[15px]">
          <span className="t-nums font-medium text-[var(--accent)]">{money(overview.rtaCents)}</span>
          <span className="text-[var(--muted)]"> ready to assign</span>
        </div>
      )}
    </div>
  );
}

/* ---------- budget table ---------- */

// Inline assign control: the Assigned cell is the button. Click to edit,
// Enter commits, Escape or click-away cancels. The control is never hidden.
// Idle and editing states share an identical box (w-24, same padding and
// border width) so toggling never shifts the surrounding layout.
// purpose="planned" relabels the control for income pots, where the value
// means planned income rather than a budget allocation.
export function AssignCell({ pot, month, onAssigned, purpose = "assign" }: { pot: Pot; month: string; onAssigned: () => void; purpose?: "assign" | "planned" }) {
  const [editing, setEditing] = useState(false);
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [hist, setHist] = useState<{ lastMonth: { month: string; cents: number }; avg3moCents: number } | null>(null);

  // Fetch last-month / 3-month-average assignments when the editor opens,
  // for the quick-fill buttons. One cheap GROUP BY query.
  useEffect(() => {
    if (!editing) return;
    setHist(null);
    fetch(`/api/pots/${pot.id}/assign-history?month=${month}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((h) => {
        if (h) setHist(h);
      })
      .catch(() => {});
  }, [editing, pot.id, month]);

  const commit = async () => {
    const cents = expressionToCents(amt);
    if (cents === null || busy) {
      if (!busy) setFailed("Enter a number, or math like 25+30.");
      return;
    }
    setBusy(true);
    setFailed(null);
    try {
      const r = await fetch("/api/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month, potId: pot.id, cents }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setEditing(false);
      setAmt("");
      onAssigned();
    } catch {
      setFailed("Couldn't save.");
    }
    setBusy(false);
  };

  if (!editing) {
    return (
      <button
        onClick={() => {
          setAmt(((pot.assignedCents ?? 0) / 100).toFixed(2));
          setEditing(true);
        }}
        title={purpose === "planned" ? `Set planned income for ${pot.name}` : `Assign to ${pot.name}`}
        className="t-nums w-24 rounded-[var(--r-sm)] border border-transparent px-2 py-1.5 text-left text-[15px] text-[var(--ink)] underline decoration-[var(--hairline-strong)] decoration-dotted underline-offset-4 transition hover:bg-[var(--surface)] active:scale-95"
      >
        {money(pot.assignedCents ?? 0)}
      </button>
    );
  }
  const showQuick = hist !== null && (hist.lastMonth.cents > 0 || hist.avg3moCents > 0);
  return (
    <span className="inline-flex flex-col items-start gap-1.5">
      <span className="inline-flex items-center gap-2">
        <MoneyInput
          autoFocus
          ariaLabel={purpose === "planned" ? `Planned income for ${pot.name}` : `Assign money to ${pot.name}`}
          value={amt}
          onChange={(v) => {
            setAmt(v);
            setFailed(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setEditing(false);
              setFailed(null);
            }
          }}
          onBlur={() => {
            if (!busy) {
              setEditing(false);
              setFailed(null);
            }
          }}
          className="w-24 py-1.5 text-[15px]"
        />
        {failed && <span className="text-[13px] text-[var(--danger)]">{failed}</span>}
      </span>
      {showQuick && (
        <span className="flex gap-1.5">
          <button
            type="button"
            onClick={() => setAmt((hist.lastMonth.cents / 100).toFixed(2))}
            className="t-nums rounded-full border border-[var(--hairline-strong)] px-2 py-0.5 text-[12px] text-[var(--ink-2)] transition hover:bg-[var(--bg-sunken)] active:scale-95"
          >
            Last month · {money(hist.lastMonth.cents)}
          </button>
          <button
            type="button"
            onClick={() => setAmt((hist.avg3moCents / 100).toFixed(2))}
            className="t-nums rounded-full border border-[var(--hairline-strong)] px-2 py-0.5 text-[12px] text-[var(--ink-2)] transition hover:bg-[var(--bg-sunken)] active:scale-95"
          >
            3-mo avg · {money(hist.avg3moCents)}
          </button>
        </span>
      )}
    </span>
  );
}

// Split tag: a small pill after the spent amount. Reads "split 50/50" for
// even splits, "{name} {pct}%" for other configured shares, or "Shared" when
// no share config exists. Same component, same size.
export function SplitTag({ p }: { p: Pot }) {
  if (p.sharedCents <= 0) return null;
  const label =
    p.sharePct == null ? "Shared"
    : p.sharePct === 50 ? "split 50/50"
    : `${p.contactName ?? "Shared"} ${p.sharePct}%`;
  return (
    <span className="t-nums ml-2 inline-flex items-center rounded-[var(--r-pill)] border border-transparent bg-[var(--accent-soft)] px-2 py-0.5 align-middle text-[11px] font-medium text-[var(--accent)]">
      {label}
    </span>
  );
}

// Available = assigned minus spent. Green when positive, warm red only
// when overspent, muted at exactly zero.
export function Available({ assignedCents, spentCents, className = "" }: { assignedCents: number; spentCents: number; className?: string }) {
  const avail = assignedCents - spentCents;
  const color = avail > 0 ? "var(--success)" : avail < 0 ? "var(--danger)" : "var(--muted)";
  return (
    <span className={`t-nums font-medium ${className}`} style={{ color }}>
      {money(avail)}
    </span>
  );
}

export function PotNameCell({ p, onEdit }: { p: Pot; onEdit?: () => void }) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-2">
        <div className="truncate text-[15px] font-semibold">{p.name}</div>
        {onEdit && (
          <button onClick={onEdit} className="-m-2 shrink-0 cursor-pointer p-2 text-[12px] text-[var(--faint)] hover:text-[var(--ink)] hover:underline">
            Edit
          </button>
        )}
      </div>
      {p.sinking && <SinkingLine sinking={p.sinking} />}
    </div>
  );
}

/** The sinking-schedule readout on a pot row: a slim progress bar plus one
 *  line that tells the full story. Funding shows saved-of-expected, the
 *  monthly pace, months left, and the due month; funded is green with the
 *  bill covered; overdue is red with what is still needed. */
export function SinkingLine({ sinking }: { sinking: NonNullable<Pot["sinking"]> }) {
  const pct = sinking.expectedCents > 0 ? Math.min(100, (sinking.balanceCents / sinking.expectedCents) * 100) : 0;
  const fillColor =
    sinking.state === "funded" ? "var(--success)" : sinking.state === "overdue" ? "var(--danger)" : "var(--ink)";
  const monthsLabel = sinking.monthsLeft === 1 ? "1 mo left" : `${sinking.monthsLeft} mo left`;
  const line =
    sinking.state === "funded"
      ? `Funded · ${money(sinking.expectedCents)} ready for ${shortMonth(sinking.dueMonth)}`
      : sinking.state === "overdue"
        ? `Overdue · ${money(sinking.remainingCents)} still needed · due ${shortMonth(sinking.dueMonth)}`
        : `${money(sinking.balanceCents)} of ${money(sinking.expectedCents)} · ${money(sinking.contributionCents)}/mo · ${monthsLabel} · due ${shortMonth(sinking.dueMonth)}`;
  const lineColor =
    sinking.state === "funded" ? "var(--success)" : sinking.state === "overdue" ? "var(--danger)" : "var(--muted)";
  return (
    <div className="mt-1">
      <div
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Sinking fund progress: ${line}`}
        className="h-[5px] w-full overflow-hidden rounded-full bg-[var(--bg-sunken)]"
      >
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: fillColor }} />
      </div>
      <div className="mt-0.5 text-[12px] font-medium" style={{ color: lineColor }}>
        {line}
      </div>
    </div>
  );
}

export function BudgetTable({ pots, month, onAssigned, onEditPot }: { pots: Pot[]; month: string; onAssigned: () => void; onEditPot?: (pot: Pot) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (pots.length === 0)
    return <p className="text-[17px] italic text-[var(--muted)]">No pots yet. They'll appear here once the budget is set up.</p>;

  const earners = pots.filter((p) => p.assignable);
  const income = pots.filter((p) => !p.assignable);

  const groups: { name: string; pots: Pot[] }[] = [];
  for (const p of earners) {
    const g = groups.find((x) => x.name === p.group);
    if (g) g.pots.push(p);
    else groups.push({ name: p.group, pots: [p] });
  }

  const sum = (ps: Pot[], f: (p: Pot) => number) => ps.reduce((a, p) => a + f(p), 0);
  // Share-of-assigned percentages in group headers use earners only, matching
  // the grouping above; income pots never count toward the total.
  const totalAssigned = sum(earners, (p) => p.assignedCents ?? 0);

  return (
    <div>
      <div className="hidden grid-cols-[minmax(0,1fr)_130px_170px_120px] gap-3 border-b border-[var(--hairline-strong)] px-4 pb-2 sm:grid sm:px-5">
        <span className="eyebrow">Pot</span>
        <span className="eyebrow">Assigned <span className="whitespace-nowrap text-[var(--faint)]" style={{ textTransform: "none", letterSpacing: "normal", fontWeight: 400 }}>(tap to edit)</span></span>
        <span className="eyebrow">Spent</span>
        <span className="eyebrow text-right">Available</span>
      </div>
      <div className="mt-3 space-y-4">
      {groups.map((g) => {
        const assigned = sum(g.pots, (p) => p.assignedCents ?? 0);
        const share = shareLabel(assigned, totalAssigned);
        const isOpen = open[g.name] ?? true;
        return (
          <section key={g.name} className="card overflow-hidden">
            {/* Group header. The word "assigned" is intentionally absent from the
              visible UI. The percentage pill is the semantic rescue: no other
              figure on this screen is ever a percentage, so "$X, N%" can only
              read as share-of-assigned. The desktop eyebrow's "Assigned" label
              stays as the visible anchor. Note the stat cluster right-aligns
              over the Available column track, not the Assigned one; accepted
              because the header is a full-width sunken section, visually
              distinct from a table cell, and the pill carries the semantics. */}
            <button
              onClick={() => setOpen((o) => ({ ...o, [g.name]: !isOpen }))}
              aria-expanded={isOpen}
              aria-label={`${titleCase(g.name)}: ${moneyGrouped(assigned)} assigned, ${
                share ? `${share} of total assigned` : "no assigned total yet"
              }. ${isOpen ? "Expanded" : "Collapsed"}.`}
              className="flex w-full items-baseline justify-between gap-3 px-4 py-3 text-left sm:px-5"
            >
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span aria-hidden="true" className="shrink-0 text-[13px] text-[var(--faint)]">{isOpen ? "▾" : "▸"}</span>
                <span className="truncate text-[17px] font-semibold text-[var(--ink)]">{titleCase(g.name)}</span>
              </span>
              <span className="t-nums flex shrink-0 items-baseline gap-2 whitespace-nowrap">
                <span className={`text-[22px] font-semibold ${assigned === 0 ? "text-[var(--muted)]" : "text-[var(--ink)]"}`}>
                  {moneyGrouped(assigned)}
                </span>
                {share !== "" && (
                  <span className="rounded-[var(--r-pill)] border border-[var(--hairline-strong)] px-2 py-0.5 text-[12px] font-semibold text-[var(--ink-2)]">
                    {share}
                  </span>
                )}
              </span>
            </button>
            {isOpen && (
              <div className="px-4 pb-1 sm:px-5">
              {g.pots.map((p) => (
                <div key={p.id} className="border-t border-[var(--hairline)] py-3">
                  {/* narrow screens: name + available up top, assigned/spent below */}
                  <div className="sm:hidden">
                    <div className="flex items-start justify-between gap-3">
                      <PotNameCell p={p} onEdit={onEditPot ? () => onEditPot(p) : undefined} />
                      <Available assignedCents={p.assignedCents ?? 0} spentCents={p.spentCents} className="shrink-0 pt-0.5" />
                    </div>
                    <div className="mt-2 flex items-center gap-4">
                      <AssignCell pot={p} month={month} onAssigned={onAssigned} />
                      <span className="t-nums text-[13px] text-[var(--ink-2)]">
                        {money(p.spentCents)}
                        <SplitTag p={p} />
                      </span>
                    </div>
                  </div>
                  {/* wide screens: one table row */}
                  <div className="hidden grid-cols-[minmax(0,1fr)_130px_170px_120px] items-center gap-3 sm:grid">
                    <PotNameCell p={p} onEdit={onEditPot ? () => onEditPot(p) : undefined} />
                    <AssignCell pot={p} month={month} onAssigned={onAssigned} />
                    <span className="t-nums whitespace-nowrap text-[15px]">
                      {money(p.spentCents)}
                      <SplitTag p={p} />
                    </span>
                    <span className="text-right">
                      <Available assignedCents={p.assignedCents ?? 0} spentCents={p.spentCents} />
                    </span>
                  </div>
                  {/* spent / assigned progress, once per row; sinking pots have their own bar */}
                  {!p.sinking && (() => {
                    const a = p.assignedCents ?? 0;
                    const over = p.spentCents > a;
                    const pct = over ? 100 : a > 0 ? Math.max(0, Math.min(100, (p.spentCents / a) * 100)) : 0;
                    return (
                      <div
                        className="track mt-2.5"
                        role="progressbar"
                        aria-valuenow={Math.round(pct)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`${p.name}: ${money(p.spentCents)} of ${money(a)} spent`}
                      >
                        <span className={over ? "over" : undefined} style={{ width: `${pct}%` }} />
                      </div>
                    );
                  })()}
                </div>
              ))}
              </div>
            )}
          </section>
        );
      })}
      </div>
      {income.length > 0 && (
        <div className="mt-8">
          <div className="mb-1 text-[15px] font-semibold">Income</div>
          <p className="mb-2 text-[13px] text-[var(--muted)]">Money in. Set planned income when you fill out the month; received shows what has actually landed. Planned income is just your expectation; only actual inflows become ready to assign.</p>
          {income.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 border-b border-[var(--hairline)] py-3">
              <PotNameCell p={p} onEdit={onEditPot ? () => onEditPot(p) : undefined} />
              <div className="flex shrink-0 items-center gap-4">
                <span className="flex items-baseline gap-1.5">
                  <span className="text-[12px] text-[var(--faint)]">planned</span>
                  <AssignCell pot={p} month={month} onAssigned={onAssigned} purpose="planned" />
                </span>
                <span className="t-nums whitespace-nowrap text-[13px] text-[var(--muted)]">
                  <span className="text-[12px] text-[var(--faint)]">received </span>
                  {money(p.receivedCents ?? 0)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RecentActivity({ txns, loading }: { txns: Txn[]; loading?: boolean }) {
  // Transfer pairs (e.g. +$891.82 / -$891.82 between own accounts) are net-zero
  // noise, not spending: keep them out of the activity feed.
  const visible = txns.filter((t) => !t.is_transfer);
  if (loading) {
    return (
      <div>
        <div className="mb-2"><Eyebrow>Recent activity</Eyebrow></div>
        <div className="space-y-2.5">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[54px]" />)}
        </div>
      </div>
    );
  }
  if (visible.length === 0) {
    return (
      <div>
        <div className="mb-2"><Eyebrow>Recent activity</Eyebrow></div>
        <p className="text-[17px] italic text-[var(--muted)]">Nothing here yet.</p>
      </div>
    );
  }
  return (
    <div>
      <div className="mb-2"><Eyebrow>Recent activity</Eyebrow></div>
      <ul>
        {visible.slice(0, 8).map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-3 border-b border-[var(--hairline)] py-2.5 last:border-0">
            <div className="min-w-0">
              <div className="truncate text-[15px]">{t.description}</div>
              <div className="mt-0.5 text-[13px] text-[var(--muted)]">
                {fmtDate(t.date)}
                {t.split_with_contact ? ` · split${t.split_contact_name ? ` with ${t.split_contact_name}` : ""}` : ""}
              </div>
            </div>
            <span className={`t-nums shrink-0 text-[15px] ${t.user_cents < 0 ? "" : "font-medium text-[var(--success)]"}`}>
              {money(t.user_cents)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

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

export function MonthNav({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  const btn =
    "flex h-11 w-11 items-center justify-center text-[20px] text-[var(--ink-2)] transition active:scale-95";
  return (
    <div className="mb-5 flex items-center justify-between">
      <button aria-label="Previous month" onClick={() => onChange(shiftMonth(month, -1))} className={btn}>
        ‹
      </button>
      <span className="text-[17px] font-medium">{monthLabel(month)}</span>
      <button aria-label="Next month" onClick={() => onChange(shiftMonth(month, 1))} className={btn}>
        ›
      </button>
    </div>
  );
}

export function OverviewTab({ month, onGo }: { month: string; onGo: (t: Tab) => void }) {
  const { data: overview, error, loading, retry } = useApi<Overview>(`/api/overview?month=${month}`);
  const { data: attention } = useApi<Attention>("/api/attention");
  const { data: accountsData } = useApi<{ accounts: Account[] }>("/api/accounts");

  const current = new Date().toISOString().slice(0, 7);

  return (
    <div className="space-y-7">
      {loading || !overview ? (
        error ? (
          <FetchError onRetry={retry} label="Couldn't load this month." />
        ) : (
          <Hero overview={null} isCurrent={month === current} loading />
        )
      ) : (
        <Hero overview={overview} isCurrent={month === current} />
      )}
      <AttentionCard
        attention={attention}
        overview={overview}
        accounts={accountsData?.accounts ?? []}
        onGo={onGo}
      />
      <RecentActivity txns={overview?.recent ?? []} loading={loading} />
    </div>
  );
}

export function AttentionCard({ attention, overview, accounts, onGo }: {
  attention: Attention | null;
  overview: Overview | null;
  accounts: Account[];
  onGo: (t: Tab) => void;
}) {
  const items: { label: React.ReactNode; tab: Tab }[] = [];
  if (attention) {
    for (const a of attention.unreconciledAccounts ?? []) {
      const name = typeof a === "string" ? a : a.name;
      items.push({ label: `${name} not reconciled yet`, tab: "accounts" });
    }
    if (attention.unsettledSharedCents > 0) {
      const names = attention.sharedOwedBy ?? [];
      items.push({
        label:
          names.length === 1 ? (
            // The per-contact line is the NET owed (gross minus credit), same
            // convention as the contact card headline. Falls back to gross for
            // older servers that do not send netCents.
            <>{names[0].name} owes <span className="t-nums font-medium">{money(names[0].netCents ?? names[0].cents)}</span></>
          ) : (
            <><span className="t-nums font-medium">{money(attention.unsettledSharedCents)}</span> in shared balances owed</>
          ),
        tab: "sharing",
      });
    }
    if (attention.rtaCents > 0)
      items.push({
        label: <><span className="t-nums font-medium">{money(attention.rtaCents)}</span> ready to assign</>,
        tab: "pots",
      });
  } else {
    // Legacy fallback while /api/attention is unavailable.
    for (const a of accounts)
      if (!a.lastReconciledAt)
        items.push({ label: `${a.name} not reconciled yet`, tab: "accounts" });
  }
  if (items.length === 0) return null;
  return (
    <div className="card px-5 py-4">
      <div className="mb-1"><Eyebrow>Needs attention</Eyebrow></div>
      <ul>
        {items.map((it, i) => (
          <li key={i} className="border-b border-[var(--hairline)] last:border-0">
            <button onClick={() => onGo(it.tab)} className="-mx-2 flex w-[calc(100%+1rem)] items-center rounded-[var(--r-md)] px-2 py-2.5 text-left text-[15px] transition hover:bg-[var(--bg-sunken)] active:scale-[0.99] active:bg-[var(--bg-sunken)]">
              <span className="flex items-center gap-2.5">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--warning)]" />
                {it.label}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- contact balance ---------- */

/* One contact's shared balance: what they owe, by pot, plus the settle-up
 *  flow. Accounts are passed down so each card doesn't refetch them. */
export function ContactCard({ contact, accounts }: { contact: ContactBalance; accounts: Account[] }) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [settleError, setSettleError] = useState(false);
  const [settledTick, setSettledTick] = useState(0);
  const [last, setLast] = useState<{ allocations: { potName: string | null; amountCents: number }[]; leftoverCents: number } | null>(null);

  // Re-read this contact's balance after a settlement lands.
  const { data: fresh } = useApi<{ contacts: ContactBalance[] }>(
    settledTick === 0 ? null : "/api/contacts"
  );
  const info = fresh?.contacts.find((c) => c.id === contact.id) ?? contact;

  // The headline is the NET balance: gross owed minus credit. A ledger
  // written off to zero (gross and credit equal) is settled, not owed.
  const netCents = info.totalOwedCents - info.creditCents;
  const settled = netCents === 0;
  const dest = accounts.find((a) => a.type === "chequing") ?? accounts[0] ?? null;

  const settle = async () => {
    const cents = expressionToCents(amount);
    if (cents === null || cents <= 0 || busy || !dest) return;
    setBusy(true);
    setSettleError(false);
    try {
      const res = await fetch("/api/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: contact.id, accountId: dest.id, amountCents: cents, note: `${contact.name} settlement` }),
      }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
      setLast(res);
      setAmount("");
      setSettledTick((t) => t + 1);
    } catch {
      setSettleError(true);
    }
    setBusy(false);
  };

  return (
    <div className="card p-5">
      <div className="text-[17px] font-semibold">{contact.name}</div>
      <div className="text-[13px] text-[var(--muted)]">
        {settled ? "Settled up" : netCents > 0 ? "owes you" : "you owe"}
      </div>
      <div className="t-nums mt-1.5 text-[32px] font-light tracking-tight">
        {settled ? "$0.00" : money(Math.abs(netCents))}
      </div>
      {info.totalOwedCents > 0 && (
        <>
          {info.oldest && <div className="mt-1 text-[13px] text-[var(--muted)]">oldest since {fmtDate(info.oldest)}</div>}
          <ul className="mt-3 space-y-1">
            {info.byPot.map((b) => (
              <li key={b.pot} className="flex items-center justify-between text-[15px]">
                <span className="text-[var(--ink-2)]">{b.pot}</span>
                <span className="t-nums">{money(b.cents)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {info.creditCents > 0 && (
        <div className="mt-2 text-[13px] font-medium text-[var(--success)]">{money(info.creditCents)} credit from overpayment</div>
      )}
      <div className="mt-4">
        <div className="mb-2 text-[13px] font-medium text-[var(--ink-2)]">Record a payment</div>
        <div className="flex gap-2">
          <MoneyInput
            placeholder="Amount received"
            ariaLabel="Payment amount received"
            value={amount}
            onChange={setAmount}
            onKeyDown={(e) => {
              if (e.key === "Enter") settle();
            }}
            className="w-44 py-2 text-[15px]"
          />
          <button onClick={settle} disabled={busy || !dest} className="btn-ink px-4 py-2 text-[15px]">
            {busy ? "Settling…" : "Settle up"}
          </button>
        </div>
        <div className="mt-1.5 text-[13px] text-[var(--muted)]">
          {dest ? `Records into ${dest.name}` : "Loading accounts…"}
        </div>
        {settleError && <div className="mt-1.5 text-[13px] text-[var(--danger)]">Couldn't record that. Try again.</div>}
      </div>
      {last && (
        <div className="mt-3 rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-4 text-[15px]">
          <div className="font-semibold">Buckets filled</div>
          <ul className="mt-1.5 space-y-1 text-[13px]">
            {last.allocations.map((a, i) => (
              <li key={i} className="flex items-center justify-between">
                <span className="text-[var(--ink-2)]">{a.potName ?? "(no pot)"}</span>
                <span className="t-nums">{money(a.amountCents)}</span>
              </li>
            ))}
          </ul>
          {last.leftoverCents > 0 && (
            <div className="mt-1.5 text-[13px] font-medium text-[var(--success)]">{money(last.leftoverCents)} kept as credit</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- tabs: pots / close / sharing ---------- */

/* Add or edit a pot: name, group, next-month fill rule, and who it's shared
 *  with (which contact and their percentage). Deleting moves the pot's
 *  history to a destination pot the user picks instead of destroying it. */
export function PotSheet({ pot, groups, pots, onClose, onSaved }: {
  pot: Pot | null;
  groups: string[];
  pots: Pot[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data: contactsData } = useApi<{ contacts: ContactBalance[] }>("/api/contacts");
  const contacts = contactsData?.contacts ?? [];
  const [name, setName] = useState(pot?.name ?? "");
  // New pots start in the last-used group (remembered across sessions), so
  // strays never land in a "General" bucket the user didn't ask for.
  const [group, setGroup] = useState(
    pot?.group ?? (typeof localStorage !== "undefined" ? localStorage.getItem("daybook:lastGroup") : null) ?? ""
  );
  const [targetType, setTargetType] = useState<"fixed" | "average_3mo" | "savings">(
    pot && ["fixed", "average_3mo", "savings"].includes(pot.targetType)
      ? (pot.targetType as "fixed" | "average_3mo" | "savings")
      : "average_3mo"
  );
  const [shared, setShared] = useState(pot?.contactId != null);
  const [contactId, setContactId] = useState<string>(pot?.contactId != null ? String(pot.contactId) : "");
  const [sharePct, setSharePct] = useState<string>(pot?.sharePct != null ? String(pot.sharePct) : "50");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    const n = name.trim();
    if (!n || busy) return;
    const pct = parseInt(sharePct, 10);
    if (shared && (!Number.isInteger(pct) || pct < 0 || pct > 100)) {
      setError("Share must be a whole percent from 0 to 100.");
      return;
    }
    if (shared && !contactId) {
      setError("Pick a contact to share with.");
      return;
    }
    setBusy(true);
    setError(null);
    const finalGroup =
      group.trim() || (typeof localStorage !== "undefined" ? localStorage.getItem("daybook:lastGroup") : null) || "General";
    if (typeof localStorage !== "undefined") localStorage.setItem("daybook:lastGroup", finalGroup);
    const body = {
      name: n,
      group: finalGroup,
      targetType,
      targetCents: pot ? pot.targetCents : 0,
      contactId: shared ? Number(contactId) : null,
      sharePct: shared ? pct : null,
    };
    try {
      const r = await fetch(pot ? `/api/pots/${pot.id}` : "/api/pots", {
        method: pot ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that pot.");
    }
    setBusy(false);
  };

  const [moveToPotId, setMoveToPotId] = useState<string>("");
  const [preview, setPreview] = useState<{ transactionCount: number; assignmentCount: number } | null>(null);
  const openDelete = async () => {
    setConfirmDelete(true);
    setMoveToPotId("");
    setPreview(null);
    setError(null);
    try {
      const r = await fetch(`/api/pots/${pot!.id}/delete-preview`);
      if (r.ok) setPreview(await r.json());
    } catch {
      /* counts are a nicety; the delete still works without them */
    }
  };

  const remove = async () => {
    if (!pot || busy || !moveToPotId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/pots/${pot.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moveToPotId: Number(moveToPotId) }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete that pot.");
    }
    setBusy(false);
  };

  return (
    <Sheet label={pot ? `Edit ${pot.name}` : "Add pot"} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-[var(--ink-2)]" htmlFor="pot-name">Name</label>
          <input id="pot-name" type="text" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Groceries" className="field t-nums w-full px-3 py-2 text-[15px]" />
        </div>
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-[var(--ink-2)]" htmlFor="pot-group">Group</label>
          <input id="pot-group" type="text" value={group} onChange={(e) => setGroup(e.target.value)}
            list="pot-groups" placeholder="Life" className="field t-nums w-full px-3 py-2 text-[15px]" />
          <datalist id="pot-groups">
            {groups.map((g) => <option key={g} value={g} />)}
          </datalist>
        </div>
        <div>
          <span className="mb-1.5 block text-[13px] font-medium text-[var(--ink-2)]">Next month fills with</span>
          <Segmented
            ariaLabel="Next month fill rule"
            value={targetType}
            onChange={setTargetType}
            options={[
              { value: "fixed", label: "Last month" },
              { value: "average_3mo", label: "3-mo average" },
              { value: "savings", label: "Leftovers" },
            ]}
          />
          <p className="mt-1.5 text-[12px] text-[var(--muted)]">
            {targetType === "fixed" && "The bulk fill copies what you assigned last month."}
            {targetType === "average_3mo" && "The bulk fill uses your 3-month average assignment."}
            {targetType === "savings" && "Skipped by the bulk fill; only month-end leftovers land here."}
          </p>
        </div>
        <div className="rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-4">
          <label className="flex cursor-pointer items-center gap-2.5 text-[15px] font-medium">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} className="h-4 w-4 accent-[var(--ink)]" />
            Share with a contact
          </label>
          {shared && (
            <div className="mt-3 flex items-center gap-2">
              <select
                value={contactId}
                onChange={(e) => setContactId(e.target.value)}
                aria-label="Contact"
                className="field t-nums flex-1 px-2 py-2 text-[15px]"
              >
                <option value="">Pick a contact…</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <input type="text" inputMode="numeric" value={sharePct} onChange={(e) => setSharePct(e.target.value)}
                aria-label="Share percent" className="field t-nums w-20 px-2 py-2 text-center text-[15px]" />
              <span className="text-[13px] text-[var(--muted)]">%</span>
            </div>
          )}
          {shared && contacts.length === 0 && (
            <div className="mt-2 text-[13px] text-[var(--muted)]">Add a contact in Sharing first.</div>
          )}
          <div className="mt-2 text-[13px] text-[var(--muted)]">New split transactions in this pot default to this share.</div>
        </div>
        {error && <div className="text-[13px] text-[var(--danger)]">{error}</div>}
        <div className="flex items-center gap-2">
          <button onClick={save} disabled={busy || !name.trim()} className="btn-ink flex-1 px-4 py-2.5 text-[15px]">
            {busy ? "Saving…" : pot ? "Save changes" : "Add pot"}
          </button>
          <button onClick={onClose} className="btn-ghost px-4 py-2.5 text-[15px]">Cancel</button>
        </div>
        {pot && !confirmDelete && (
          <button onClick={openDelete} className="cursor-pointer text-[13px] text-[var(--muted)] hover:text-[var(--danger)]">
            Delete this pot…
          </button>
        )}
        {pot && confirmDelete && (
          <div className="rounded-[var(--r-md)] border border-[var(--danger)] p-4 text-[13px]">
            <div className="font-medium">Delete {pot.name}?</div>
            <div className="mt-1 text-[var(--ink-2)]">
              {preview
                ? `${preview.transactionCount} transaction${preview.transactionCount === 1 ? "" : "s"} and ${preview.assignmentCount} assignment${preview.assignmentCount === 1 ? "" : "s"} will move to the pot you pick. `
                : "Its history will move to the pot you pick. "}
              Nothing is destroyed, but this can't be undone.
            </div>
            <label className="mt-3 mb-1.5 block font-medium text-[var(--ink-2)]" htmlFor="delete-move-to">
              Move history to
            </label>
            <select
              id="delete-move-to"
              value={moveToPotId}
              onChange={(e) => setMoveToPotId(e.target.value)}
              className="field w-full px-3 py-2"
            >
              <option value="">Choose a pot…</option>
              {pots
                .filter((p) => p.id !== pot.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            <div className="mt-3 flex gap-2">
              <button
                onClick={remove}
                disabled={busy || !moveToPotId}
                className="cursor-pointer rounded-[var(--r-pill)] bg-[var(--danger)] px-4 py-2 font-medium text-white disabled:opacity-40"
              >
                {busy ? "Deleting…" : "Move & delete"}
              </button>
              <button onClick={() => setConfirmDelete(false)} className="btn-ghost px-4 py-2">Keep it</button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
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

/* ---------- scaffold sheet ---------- */

// Bulk-fill a future month's assignments from history. The user picks one of
// two strategies, previews the per-pot values, then confirms. Income pots
// always copy last month's planned income.
type ScaffoldStrategy = "average_3mo" | "last_month";

const SCAFFOLD_OPTIONS: { value: ScaffoldStrategy; label: string }[] = [
  { value: "average_3mo", label: "3-month average" },
  { value: "last_month", label: "Last month" },
];

interface ScaffoldLine {
  potId: number;
  name: string;
  cents: number;
  income: boolean;
  scheduled?: boolean;
}

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
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setLines(d.lines);
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
      const d = await r.json().catch(() => ({}));
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

/* Manage the people you share expenses with: add, rename inline, delete.
 *  Deleting is blocked while a pot or split references the contact. */
export function ContactsManager({ contacts, onChanged }: { contacts: ContactBalance[]; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const savingRef = useRef(false);

  const add = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      setName("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add that contact.");
    }
    setBusy(false);
  };

  const rename = async (id: number) => {
    const n = editName.trim();
    if (!n || busy || savingRef.current) return;
    savingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/contacts/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      setEditingId(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't rename that contact.");
    }
    setBusy(false);
    savingRef.current = false;
  };

  const remove = async (id: number) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/contacts/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      setConfirmDeleteId(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete that contact.");
    }
    setBusy(false);
  };

  return (
    <div className="card mb-5 p-5">
      <div className="text-[17px] font-semibold">Contacts</div>
      <div className="mt-1 text-[13px] text-[var(--muted)]">People you share expenses with. Pots can each be shared with one of them.</div>
      <ul className="mt-3 space-y-2">
        {contacts.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3">
            {editingId === c.id ? (
              <input
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") rename(c.id);
                  if (e.key === "Escape") setEditingId(null);
                }}
                onBlur={() => { if (editingId === c.id) rename(c.id); }}
                aria-label="Contact name"
                className="field t-nums flex-1 px-2 py-1.5 text-[15px]"
              />
            ) : (
              <button
                onClick={() => { setEditingId(c.id); setEditName(c.name); }}
                className="flex-1 cursor-pointer text-left text-[15px] font-medium hover:underline"
                title="Rename"
              >
                {c.name}
              </button>
            )}
            {confirmDeleteId === c.id ? (
              <span className="flex items-center gap-2 text-[13px]">
                <span className="text-[var(--muted)]">Delete?</span>
                <button onClick={() => remove(c.id)} disabled={busy} className="cursor-pointer font-medium text-[var(--danger)]">Yes</button>
                <button onClick={() => setConfirmDeleteId(null)} className="cursor-pointer text-[var(--ink-2)]">Keep</button>
              </span>
            ) : (
              <button onClick={() => setConfirmDeleteId(c.id)} className="cursor-pointer text-[13px] text-[var(--muted)] hover:text-[var(--danger)]">
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
      {contacts.length === 0 && (
        <div className="mt-3 text-[13px] italic text-[var(--muted)]">No contacts yet. Add one to start splitting expenses.</div>
      )}
      <div className="mt-3 flex gap-2">
        <input
          type="text"
          placeholder="New contact name"
          aria-label="New contact name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          className="field t-nums w-44 px-3 py-2 text-[15px]"
        />
        <button onClick={add} disabled={busy || !name.trim()} className="btn-ink px-4 py-2 text-[15px]">
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
      {error && <div className="mt-2 text-[13px] text-[var(--danger)]">{error}</div>}
    </div>
  );
}

export function SharingTab() {
  const { data, error, loading, retry } = useApi<{ contacts: ContactBalance[] }>("/api/contacts");
  const { data: accountsData } = useApi<{ accounts: Account[] }>("/api/accounts");
  const contacts = data?.contacts ?? [];
  const accounts = accountsData?.accounts ?? [];

  return (
    <div>
      <div className="mb-5 font-serif-d text-[24px] font-medium">Sharing</div>
      {loading ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="card space-y-3 p-5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-9 w-44" />
            </div>
          ))}
        </div>
      ) : error ? (
        <FetchError onRetry={retry} label="Couldn't load sharing." />
      ) : (
        <>
          <ContactsManager contacts={contacts} onChanged={retry} />
          {contacts.map((c) => (
            <div key={c.id} className="mb-5">
              <ContactCard contact={c} accounts={accounts} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/* ---------- accounts + reconcile ---------- */

interface ReconcileResponse {
  differenceCents: number;
  balanced: boolean;
  clearedBalanceCents: number;
  actualBalanceCents: number;
  uncleared?: { id: number; date: string; description: string; amount_cents: number }[];
  suggestedClearId?: number | null;
}

function clearedLabel(a: Account): string {
  // Credit-card cleared balances are negative (money owed): say so plainly
  // instead of rendering a double negative like "Cleared −$653.65".
  if (a.clearedBalanceCents < 0 && a.type === "credit_card")
    return `Owed ${money(-a.clearedBalanceCents)}`;
  return `Cleared ${money(a.clearedBalanceCents)}`;
}

export function AccountsView() {
  const { data, error, loading, retry } = useApi<{ accounts: Account[] }>("/api/accounts");
  const [actual, setActual] = useState<Record<number, string>>({});
  const [result, setResult] = useState<Record<number, ReconcileResponse | null>>({});

  const load = () => retry();

  const reconcile = async (id: number) => {
    // Balances can be negative (credit cards), so evaluate directly instead
    // of expressionToCents, which rejects negatives.
    const dollars = evaluateExpression(actual[id] ?? "");
    if (dollars === null) return;
    const cents = Math.round(dollars * 100);
    const r = await fetch(`/api/accounts/${id}/reconcile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actualBalanceCents: cents }),
    }).then((x) => x.json());
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
                    {result[a.id]!.uncleared!.map((t) => (
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

/* ---------- sheet (modal) ---------- */

// Bottom sheet on mobile, centered dialog on desktop. Backdrop click or
// Escape dismisses. Follows the "More" sheet's visual pattern.
export function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-30" role="dialog" aria-modal="true" aria-label={label}>
      <div className="absolute inset-0 cursor-pointer bg-black/30" onClick={onClose} />
      <div
        className="absolute inset-x-0 bottom-0 max-h-[92dvh] overflow-y-auto rounded-t-[var(--r-lg)] border border-[var(--hairline)] bg-[var(--surface)] p-5 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[var(--r-lg)]"
        style={{ boxShadow: "var(--shadow-elev)" }}
      >
        {children}
      </div>
    </div>
  );
}

// Pill segmented control. Used for Out/In and for the type filter.
export function Segmented<T extends string>({ options, value, onChange, ariaLabel }: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex shrink-0 rounded-[var(--r-pill)] border border-[var(--hairline-strong)] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`rounded-full px-3 py-1.5 text-[13px] transition active:scale-95 ${
            value === o.value
              ? "bg-[var(--ink)] font-medium text-[var(--bg)]"
              : "text-[var(--muted)] hover:text-[var(--ink-2)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function FormLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[13px] font-medium text-[var(--ink-2)]">{children}</div>;
}

export function TxnBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-[var(--r-pill)] border border-[var(--hairline)] bg-[var(--bg-sunken)] px-2 py-0.5 text-[11px] font-medium text-[var(--ink-2)]">
      {children}
    </span>
  );
}

/* ---------- transaction add/edit sheet ---------- */

// Add/edit form for one transaction. txn === null means "add". Renders inside
// a Sheet; the parent refetches on onSaved. All inputs keep a fixed size so
// focusing never shifts the layout.
export function TransactionSheet({ txn, pots, accounts, onClose, onSaved }: {
  txn: ListedTxn | null;
  pots: Pot[];
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = txn !== null;
  const [description, setDescription] = useState(txn?.description ?? "");
  const [amount, setAmount] = useState(txn ? (Math.abs(txn.amountCents) / 100).toFixed(2) : "");
  const [direction, setDirection] = useState<"out" | "in">(txn && txn.amountCents > 0 ? "in" : "out");
  const [date, setDate] = useState(txn?.date ?? new Date().toISOString().slice(0, 10));
  const [accountId, setAccountId] = useState(txn ? String(txn.accountId) : accounts[0] ? String(accounts[0].id) : "");
  const [potId, setPotId] = useState(txn ? (txn.potId != null ? String(txn.potId) : "") : "");
  const [isTransfer, setIsTransfer] = useState(!!txn?.isTransfer);
  const [split, setSplit] = useState(!!txn?.splitWithContact);
  const [contactId, setContactId] = useState(
    txn?.splitContactId != null ? String(txn.splitContactId) : ""
  );
  const [shareAmount, setShareAmount] = useState(
    txn && txn.sharedCents > 0 ? (txn.sharedCents / 100).toFixed(2) : ""
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const { data: contactsData } = useApi<{ contacts: ContactBalance[] }>("/api/contacts");
  const contacts = contactsData?.contacts ?? [];

  const toggleSplit = (on: boolean) => {
    setSplit(on);
    if (on) {
      // Default the contact and share from the pot's share config.
      const pot = pots.find((p) => String(p.id) === potId);
      if (!contactId) {
        const cid = pot?.contactId ?? contacts[0]?.id ?? null;
        if (cid != null) setContactId(String(cid));
      }
      if (!shareAmount) {
        const cents = expressionToCents(amount);
        if (cents !== null && cents > 0) {
          const pct = pot?.sharePct ?? 50;
          setShareAmount(((cents * pct) / 100 / 100).toFixed(2));
        }
      }
    }
  };

  const save = async () => {
    const cents = expressionToCents(amount);
    if (!description.trim()) {
      setError("Add a description.");
      return;
    }
    if (cents === null || cents <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError("Pick a valid date.");
      return;
    }
    if (accountId === "") {
      setError("Pick an account.");
      return;
    }
    if (!isTransfer && potId === "") {
      setError("Pick a pot.");
      return;
    }
    let sCents = 0;
    let sContactId: number | null = null;
    if (split && !isTransfer) {
      const parsed = expressionToCents(shareAmount);
      if (parsed === null || parsed <= 0 || parsed >= cents) {
        setError("The contact's share must be less than the full amount.");
        return;
      }
      sCents = parsed;
      sContactId = contactId ? Number(contactId) : null;
      if (!sContactId) {
        setError("Pick a contact to split with.");
        return;
      }
    }
    setBusy(true);
    setError(null);
    const signed = direction === "out" ? -cents : cents;
    const body = {
      date,
      accountId: Number(accountId),
      potId: potId === "" ? null : Number(potId),
      amountCents: signed,
      description: description.trim(),
      isTransfer,
      contactId: sContactId,
      shareCents: split && !isTransfer ? (direction === "out" ? -sCents : sCents) : 0,
    };
    try {
      const r = await fetch(editing ? `/api/transactions/${txn.id}` : "/api/transactions", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        throw new Error(j?.error ?? `HTTP ${r.status}`);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    }
    setBusy(false);
  };

  const destroy = async () => {
    if (!editing || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/transactions/${txn.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      onSaved();
    } catch {
      setError("Couldn't delete it. Try again.");
    }
    setBusy(false);
  };

  const groups = [...new Set(pots.map((p) => p.group))];

  return (
    <Sheet label={editing ? "Edit transaction" : "Add transaction"} onClose={onClose}>
      <div className="mb-4 text-[17px] font-semibold">{editing ? "Edit transaction" : "Add transaction"}</div>
      <div className="space-y-4">
        <div>
          <FormLabel>Description</FormLabel>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What was it?"
            aria-label="Description"
            className="field w-full px-3 py-2.5 text-[15px]"
          />
        </div>
        <div>
          <FormLabel>Amount</FormLabel>
          <div className="flex gap-2">
            <Segmented
              ariaLabel="Direction"
              value={direction}
              onChange={setDirection}
              options={[
                { value: "out", label: "Out" },
                { value: "in", label: "In" },
              ]}
            />
            <MoneyInput
              value={amount}
              onChange={setAmount}
              placeholder="0.00"
              ariaLabel="Amount"
              className="min-w-0 flex-1 py-2.5 text-[15px]"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FormLabel>Date</FormLabel>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-label="Date"
              className="field w-full px-3 py-2.5 text-[15px]"
            />
          </div>
          <div>
            <FormLabel>Account</FormLabel>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              aria-label="Account"
              className="field w-full px-3 py-2.5 text-[15px]"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <FormLabel>Pot</FormLabel>
          <select
            value={potId}
            onChange={(e) => setPotId(e.target.value)}
            aria-label="Pot"
            className="field w-full px-3 py-2.5 text-[15px]"
          >
            {isTransfer ? (
              <option value="">No pot</option>
            ) : (
              <option value="" disabled>Pick a pot…</option>
            )}
            {groups.map((g) => (
              <optgroup key={g} label={titleCase(g)}>
                {pots
                  .filter((p) => p.group === g)
                  .map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>
        <label className="flex cursor-pointer items-center gap-2.5 text-[15px]">
          <input
            type="checkbox"
            checked={isTransfer}
            onChange={(e) => {
              setIsTransfer(e.target.checked);
              if (e.target.checked) {
                setSplit(false);
                setPotId("");
              }
            }}
            className="h-4 w-4 shrink-0 accent-[var(--accent)]"
          />
          Transfer between my accounts
        </label>
        {!isTransfer && (
          <div>
            <label className="flex cursor-pointer items-center gap-2.5 text-[15px]">
              <input
                type="checkbox"
                checked={split}
                onChange={(e) => toggleSplit(e.target.checked)}
                className="h-4 w-4 shrink-0 accent-[var(--accent)]"
              />
              Split with a contact
            </label>
            {split && (
              <div className="mt-2.5 space-y-2.5">
                <div>
                  <FormLabel>Contact</FormLabel>
                  {contacts.length > 0 ? (
                    <select
                      value={contactId}
                      onChange={(e) => setContactId(e.target.value)}
                      aria-label="Contact to split with"
                      className="field t-nums w-full px-3 py-2.5 text-[15px]"
                    >
                      <option value="">Pick a contact…</option>
                      {contacts.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  ) : (
                    <div className="text-[13px] text-[var(--muted)]">Add a contact in Sharing first.</div>
                  )}
                </div>
                <div>
                  <FormLabel>Their share</FormLabel>
                  <MoneyInput
                    value={shareAmount}
                    onChange={setShareAmount}
                    placeholder="0.00"
                    ariaLabel="Contact's share"
                    className="w-40 py-2.5 text-[15px]"
                  />
                </div>
              </div>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-[13px] font-medium text-[var(--danger)]">{error}</p>
        )}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-4 py-2.5 text-[15px] font-medium text-[var(--muted)] transition hover:text-[var(--ink)] active:scale-95"
          >
            Cancel
          </button>
          <button onClick={save} disabled={busy} className="btn-ink flex-1 px-4 py-2.5 text-[15px]">
            {busy ? "Saving…" : editing ? "Save changes" : "Add transaction"}
          </button>
        </div>
        {editing && !confirmingDelete && (
          <button
            onClick={() => setConfirmingDelete(true)}
            className="text-[15px] font-medium text-[var(--danger)] transition hover:opacity-80 active:scale-95"
          >
            Delete transaction
          </button>
        )}
        {confirmingDelete && (
          <div className="rounded-[var(--r-md)] bg-[var(--danger-soft)] p-4">
            <p className="text-[15px] font-medium">Delete this transaction?</p>
            <p className="mt-1 text-[13px] text-[var(--ink-2)]">It disappears from every view. This cannot be undone.</p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => setConfirmingDelete(false)}
                className="rounded-[var(--r-pill)] border border-[var(--hairline-strong)] px-4 py-2 text-[15px] font-medium transition active:scale-95"
              >
                Keep it
              </button>
              <button
                onClick={destroy}
                disabled={busy}
                className="rounded-[var(--r-pill)] bg-[var(--danger)] px-4 py-2 text-[15px] font-medium text-white transition hover:opacity-90 active:scale-95"
              >
                {busy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}

/* ---------- transactions page ---------- */

export function TransactionsTab({ month }: { month: string }) {
  const { data, error, loading, retry } = useApi<{ month: string; transactions: ListedTxn[] }>(
    `/api/transactions?month=${month}`
  );
  const { data: potsData } = useApi<{ pots: Pot[] }>(`/api/pots?month=${month}`);
  const { data: accountsData } = useApi<{ accounts: Account[] }>("/api/accounts");
  const [query, setQuery] = useState("");
  const [potFilter, setPotFilter] = useState("all");
  const [kind, setKind] = useState<"all" | "out" | "in" | "transfer">("all");
  const [sheet, setSheet] = useState<{ txn: ListedTxn | null } | null>(null);

  const pots = potsData?.pots ?? [];
  const accounts = accountsData?.accounts ?? [];
  const txns = data?.transactions ?? [];

  const q = query.trim().toLowerCase();
  const filtered = txns.filter((t) => {
    if (kind === "out" && !(t.amountCents < 0 && !t.isTransfer)) return false;
    if (kind === "in" && !(t.amountCents > 0 && !t.isTransfer)) return false;
    if (kind === "transfer" && !t.isTransfer) return false;
    if (potFilter !== "all" && t.potId !== Number(potFilter)) return false;
    if (q && !`${t.description} ${t.potName ?? ""}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const groups = [...new Set(pots.map((p) => p.group))];
  const openAdd = () => setSheet({ txn: null });
  const saved = () => {
    setSheet(null);
    retry();
  };

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div className="font-serif-d text-[24px] font-medium">Transactions</div>
        <button onClick={openAdd} className="btn-ink px-4 py-2 text-[15px]">Add</button>
      </div>

      <div className="mb-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search transactions…"
          aria-label="Search transactions"
          className="field w-full px-3 py-2.5 text-[15px]"
        />
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <select
          value={potFilter}
          onChange={(e) => setPotFilter(e.target.value)}
          aria-label="Filter by pot"
          className="field max-w-[200px] px-3 py-2 text-[15px]"
        >
          <option value="all">All pots</option>
          {groups.map((g) => (
            <optgroup key={g} label={titleCase(g)}>
              {pots
                .filter((p) => p.group === g)
                .map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
            </optgroup>
          ))}
        </select>
        <Segmented
          ariaLabel="Transaction type"
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: "All" },
            { value: "out", label: "Out" },
            { value: "in", label: "In" },
            { value: "transfer", label: "Transfers" },
          ]}
        />
      </div>

      {loading ? (
        <div className="space-y-2.5">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-[58px]" />
          ))}
        </div>
      ) : error ? (
        <FetchError onRetry={retry} label="Couldn't load transactions." />
      ) : filtered.length === 0 ? (
        txns.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-[17px] italic text-[var(--muted)]">No transactions this month yet.</p>
            <button onClick={openAdd} className="btn-ink mt-4 px-5 py-2.5 text-[15px]">Add one</button>
          </div>
        ) : (
          <div className="py-10 text-center">
            <p className="text-[17px] italic text-[var(--muted)]">Nothing matches these filters.</p>
            <button
              onClick={() => {
                setQuery("");
                setPotFilter("all");
                setKind("all");
              }}
              className="mt-4 px-4 py-2 text-[15px] font-medium text-[var(--ink-2)] underline decoration-[var(--hairline-strong)] underline-offset-4"
            >
              Clear filters
            </button>
          </div>
        )
      ) : (
        <>
          <div className="mb-2 text-[13px] text-[var(--muted)]">
            {filtered.length} transaction{filtered.length === 1 ? "" : "s"}
          </div>
          <ul>
            {filtered.map((t) => (
              <li key={t.id} className="border-b border-[var(--hairline)] last:border-0">
                <button
                  onClick={() => setSheet({ txn: t })}
                  className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-[var(--r-md)] px-2 py-3 text-left transition hover:bg-[var(--bg-sunken)] active:bg-[var(--bg-sunken)]"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[15px] font-medium">{t.description}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-[var(--muted)]">
                      <span>{fmtDate(t.date)}</span>
                      <span aria-hidden>·</span>
                      <span className="truncate">{t.potName ?? "(no pot)"}</span>
                      {t.isTransfer ? <TxnBadge>Transfer</TxnBadge> : null}
                      {t.splitWithContact ? <TxnBadge>{t.splitContactName ? `split · ${t.splitContactName}` : "split"}</TxnBadge> : null}
                    </div>
                  </div>
                  <span
                    className={`t-nums shrink-0 text-[15px] ${
                      t.amountCents > 0 && !t.isTransfer
                        ? "font-medium text-[var(--success)]"
                        : t.isTransfer
                          ? "text-[var(--muted)]"
                          : ""
                    }`}
                  >
                    {money(t.amountCents)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {sheet && (
        <TransactionSheet
          txn={sheet.txn}
          pots={pots}
          accounts={accounts}
          onClose={() => setSheet(null)}
          onSaved={saved}
        />
      )}
    </div>
  );
}

/* ---------- app ---------- */

export type Tab = "overview" | "pots" | "transactions" | "sharing" | "accounts" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "pots", label: "Pots" },
  { id: "transactions", label: "Transactions" },
  { id: "sharing", label: "Sharing" },
  { id: "accounts", label: "Accounts" },
  { id: "settings", label: "Settings" },
];

const tabLabel = (id: Tab) => TABS.find((t) => t.id === id)?.label ?? id;

const TAB_IDS: Tab[] = TABS.map((t) => t.id);

/* Read the initial tab from the URL (?tab=pots). Missing or unknown values
 * fall back to overview, so a bare URL always opens on the home tab. */
export function tabFromUrl(search: string = window.location.search): Tab {
  const raw = new URLSearchParams(search).get("tab");
  return TAB_IDS.includes(raw as Tab) ? (raw as Tab) : "overview";
}

const MONTH_TABS: Tab[] = ["overview", "pots", "transactions"];

/* Icon-only mobile tab bar: one clean inline SVG per tab, no icon library.
 * Selected renders in dark ink, inactive in muted grey. */
function TabIcon({ id }: { id: Tab }) {
  const common = {
    width: 24,
    height: 24,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  } as const;
  switch (id) {
    case "overview":
      return (
        <svg {...common}><path d="M4 11.5 12 4l8 7.5" /><path d="M6 10.5V20h12v-9.5" /></svg>
      );
    case "pots":
      return (
        <svg {...common}><path d="M12 3.5 3.5 8 12 12.5 20.5 8 12 3.5Z" /><path d="M4.5 12.5 12 16.7l7.5-4.2" /><path d="M4.5 16.5 12 20.7l7.5-4.2" /></svg>
      );
    case "transactions":
      return (
        <svg {...common}><path d="M6 3.5h12V21l-2.2-1.6-1.8 1.6-2-1.6-2 1.6-1.8-1.6L6 21V3.5Z" /><path d="M9.5 8.5h5M9.5 12h5" /></svg>
      );
    case "sharing":
      return (
        <svg {...common}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19.5c.7-3.4 2.9-5.2 5.5-5.2s4.8 1.8 5.5 5.2" /><circle cx="16.8" cy="9" r="2.6" /><path d="M16 14.4c2.4.4 4.1 1.9 4.6 4.6" /></svg>
      );
    case "accounts":
      return (
        <svg {...common}><rect x="3.5" y="6" width="17" height="12" rx="2.5" /><path d="M3.5 10h17" /><path d="M7 14.5h4" /></svg>
      );
    case "settings":
      return (
        <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.09a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z" /></svg>
      );
  }
}

export function CountBadge({ n, className = "" }: { n: number; className?: string }) {
  return (
    <span className={`t-nums flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--ink)] px-1.5 text-[11px] font-bold text-[var(--bg)] ${className}`}>
      {n}
    </span>
  );
}

/** The full app shell: tabs, sidebar, and content. Rendered only once the
 *  auth gate below has confirmed a session. Also the Storybook entry point. */
/* Mobile bottom tab bar: icon-only, all six tabs in the same order, no
 * "More" sheet. The active dot is absolutely positioned (out of flow) so the
 * 24px icon stays optically centered in the 64px button. Dark ink when
 * active, muted grey when inactive. */
export function MobileTabBar({ tab, onGo, closeAlert }: { tab: Tab; onGo: (t: Tab) => void; closeAlert: boolean }) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--hairline)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="Primary">
      <div className="grid grid-cols-6">
        {TABS.map(({ id }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              onClick={() => onGo(id)}
              aria-label={tabLabel(id)}
              aria-current={active ? "page" : undefined}
              className={`relative flex min-h-[64px] items-center justify-center transition active:scale-95 ${
                active ? "text-[var(--ink)]" : "text-[var(--muted)]"
              }`}
            >
              <span className={`absolute left-1/2 top-2 h-1.5 w-1.5 -translate-x-1/2 rounded-full ${active ? "bg-[var(--ink)]" : "bg-transparent"}`} />
              <TabIcon id={id} />
              {id === "pots" && closeAlert && (
                <span className="absolute right-4 top-3 h-2 w-2 rounded-full bg-[var(--warning)]" />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export function AppShell() {
  const [tab, setTab] = useState<Tab>(tabFromUrl);
  const [refreshKey, setRefreshKey] = useState(0);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const { data: attention } = useApi<Attention>("/api/attention");

  // Keep the tab in the URL (?tab=pots) so a refresh lands back on the
  // current tab, and browser back/forward moves between tabs.
  useEffect(() => {
    const onPopState = () => setTab(tabFromUrl());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Near month-end with money still unassigned, the Pots tab earns a dot:
  // the close card now lives there.
  const now = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const closeAlert = now.getDate() >= lastDay - 2 && (attention?.rtaCents ?? 0) > 0;

  const go = (t: Tab) => {
    setTab(t);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", t);
    window.history.pushState(null, "", url);
    window.scrollTo(0, 0);
  };

  const navBadge = (id: Tab) => {
    if (id === "pots" && closeAlert) return <span className="ml-auto h-2 w-2 rounded-full bg-[var(--warning)]" />;
    return null;
  };

  return (
    <div className="min-h-screen md:flex">
      {/* desktop sidebar rail */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-[var(--hairline)] px-4 py-6 md:flex">
        <div className="px-3 font-serif-d text-[20px] font-medium tracking-tight">Daybook</div>
        <div className="mx-3 my-5 border-t border-[var(--hairline)]" />
        <nav className="flex flex-col gap-0.5" aria-label="Primary">
          {TABS.map(({ id }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                onClick={() => go(id)}
                aria-current={active ? "page" : undefined}
                className={`flex items-center rounded-[var(--r-sm)] px-3 py-2.5 text-left text-[15px] transition active:scale-[0.99] ${
                  active
                    ? "bg-[var(--surface)] font-semibold text-[var(--ink)] shadow-[var(--shadow-card)]"
                    : "font-medium text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--ink-2)]"
                }`}
              >
                {tabLabel(id)}
                {navBadge(id)}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* content column */}
      <div className="min-w-0 flex-1">
        <header className="flex items-center justify-between px-5 pb-1 pt-5 md:hidden">
          <span className="font-serif-d text-[19px] font-medium tracking-tight">Daybook</span>
        </header>
        <div className="mx-auto max-w-5xl px-5 pb-32 pt-2 md:px-8 md:py-8 md:pb-16">
          {MONTH_TABS.includes(tab) && <MonthNav month={month} onChange={setMonth} />}

          {tab === "overview" && <OverviewTab key={`o-${refreshKey}-${month}`} month={month} onGo={go} />}

          {tab === "pots" && <PotsTab key={`p-${refreshKey}-${month}`} month={month} />}

          {tab === "transactions" && <TransactionsTab key={`t-${refreshKey}-${month}`} month={month} />}

          {tab === "sharing" && <SharingTab key={`s-${refreshKey}`} />}

          {tab === "accounts" && (
            <div>
              <div className="mb-5 font-serif-d text-[24px] font-medium">Accounts</div>
              <AccountsView />
            </div>
          )}

          {tab === "settings" && (
            <div>
              <div className="mb-5 font-serif-d text-[24px] font-medium">Settings</div>
              <SettingsTab />
            </div>
          )}
        </div>
      </div>

      {/* mobile bottom tab bar */}
      <MobileTabBar tab={tab} onGo={go} closeAlert={closeAlert} />
    </div>
  );
}

/* ---------- auth gate ---------- */

interface AuthState {
  authenticated: boolean;
  setupRequired: boolean;
}

/** Root component: gates the app on GET /api/auth/me. No users yet shows the
 *  signup screen, logged-out shows login (with a link to signup for later
 *  users), and an authenticated session (or a local dev server with auth
 *  disabled) renders the shell. */
export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [failed, setFailed] = useState(false);
  const [authView, setAuthView] = useState<"login" | "signup">("login");

  const load = () => {
    setFailed(false);
    // Warm the data cache in parallel with the auth check: the five hot
    // endpoints start fetching before the shell even renders, so the first
    // paint already has real data instead of skeletons popping in one by
    // one. A failed prime is harmless; the tab's own fetch surfaces it.
    const month = new Date().toISOString().slice(0, 7);
    const primes = Promise.allSettled([
      prime("/api/attention"),
      prime(`/api/pots?month=${month}`),
      prime("/api/accounts"),
      prime(`/api/overview?month=${month}`),
      prime("/api/trend"),
    ]);
    fetch("/api/auth/me")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as AuthState;
      })
      .then(async (a) => {
        await primes;
        setAuth(a);
      })
      .catch(() => setFailed(true));
  };

  useEffect(load, []);

  if (failed) {
    return (
      <div className="flex min-h-screen items-center justify-center px-5">
        <div className="card w-full max-w-sm p-6 text-center">
          <p className="text-[15px] text-[var(--muted)]">Couldn't reach the server.</p>
          <button onClick={load} className="btn-ink mt-3 px-4 py-2 text-[15px]">
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!auth) {
    return (
      <div className="flex min-h-screen items-center justify-center px-5">
        <div className="w-full max-w-sm">
          <Skeleton className="mx-auto h-9 w-40" />
          <div className="card mt-6 p-6">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="mt-4 h-11" />
            <Skeleton className="mt-3 h-11" />
            <Skeleton className="mt-4 h-11" />
          </div>
        </div>
      </div>
    );
  }

  if (auth.setupRequired) return <SignupScreen onSignup={load} />;
  if (!auth.authenticated) {
    return authView === "signup" ? (
      <SignupScreen onSignup={load} onBackToLogin={() => setAuthView("login")} />
    ) : (
      <LoginScreen onAuthenticated={load} onSignup={() => setAuthView("signup")} />
    );
  }
  return <AppShell />;
}
