import { useEffect, useState } from "react";

/* ---------- types ---------- */

interface Txn {
  id: number;
  date: string;
  description: string;
  user_cents: number;
  amount_cents?: number; // present on /api/review items only
  is_transfer: number;
  split_with_partner: number;
  source: string;
  status: string;
  partner_cents: number;
  review_reason: string | null;
}

interface Overview {
  month: string;
  confirmedSpendCents: number;
  pendingCount: number;
  recent: Txn[];
  partnerName: string;
  rtaCents?: number;
  assignedCents?: number;
}

interface ClosePreviewData {
  month: string;
  nextMonth: string;
  inflowsCents: number;
  spentCents: number;
  assignedCents?: number;
  rtaBeforeCents: number;
  movedToSavingsCents: number;
  partnerOwedCents: number;
}

interface Account {
  id: number;
  name: string;
  type: string;
  last4: string | null;
  workingBalanceCents: number;
  clearedBalanceCents: number;
  lastReconciledAt: string | null;
}

interface Pot {
  id: number;
  name: string;
  group: string;
  targetCents: number;
  spentCents: number;
  partnerCents: number;
  assignable: boolean;
  assignedCents?: number;
}

interface PartnerInfo {
  partnerName: string;
  totalOwedCents: number;
  creditCents: number;
  byPot: { pot: string; cents: number }[];
  oldest: string | null;
}

interface TrendPoint {
  month: string;
  spent: number;
}

interface Attention {
  month: string;
  pendingReviewCount: number;
  unreconciledAccounts: Array<string | { name: string }>;
  rtaCents: number;
  unsettledPartnerCents: number;
}

interface PotHistoryPoint {
  month: string;
  spentCents: number;
}

/* ---------- helpers ---------- */

const money = (cents: number) =>
  `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
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

// Small fetch hook with loading + error states. A failed fetch surfaces a
// retryable error instead of hanging on a skeleton forever.
function useApi<T>(url: string | null): { data: T | null; error: boolean; loading: boolean; retry: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!url) return;
    let live = true;
    setError(false);
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const ct = r.headers.get("content-type") ?? "";
        if (!ct.includes("json")) throw new Error("not JSON");
        return (await r.json()) as T;
      })
      .then((d) => {
        if (live) setData(d);
      })
      .catch(() => {
        if (live) setError(true);
      });
    return () => {
      live = false;
    };
  }, [url, nonce]);

  return { data, error, loading: data === null && !error, retry: () => setNonce((n) => n + 1) };
}

/* ---------- primitives ---------- */

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div className="eyebrow">{children}</div>;
}

function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`skeleton ${className}`} />;
}

function FetchError({ onRetry, label = "Couldn't load this." }: { onRetry: () => void; label?: string }) {
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

function Hero({ overview, isCurrent, loading }: { overview: Overview | null; isCurrent: boolean; loading?: boolean }) {
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
          <span className="t-nums font-medium text-[var(--ink-2)]">{money(overview.rtaCents)}</span>
          <span className="text-[var(--muted)]"> ready to assign</span>
        </div>
      )}
    </div>
  );
}

/* ---------- budget table ---------- */

// Inline assign control: the Assigned cell is the button. Click to edit,
// Enter commits, Escape or click-away cancels. The control is never hidden.
function AssignCell({ pot, month, onAssigned }: { pot: Pot; month: string; onAssigned: () => void }) {
  const [editing, setEditing] = useState(false);
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const commit = async () => {
    const cents = Math.round(parseFloat(amt) * 100);
    if (!Number.isFinite(cents) || cents < 0 || busy) return;
    setBusy(true);
    setFailed(false);
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
      setFailed(true);
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
        title={`Assign to ${pot.name}`}
        className="t-nums rounded-[var(--r-sm)] px-2 py-2 text-left text-[15px] text-[var(--ink)] underline decoration-[var(--hairline-strong)] decoration-dotted underline-offset-4 transition hover:bg-[var(--surface)] active:scale-95 sm:py-1"
      >
        {money(pot.assignedCents ?? 0)}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <input
        autoFocus
        type="text"
        inputMode="decimal"
        aria-label={`Assign money to ${pot.name}`}
        value={amt}
        onChange={(e) => setAmt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setEditing(false);
            setFailed(false);
          }
        }}
        onBlur={() => {
          if (!busy) {
            setEditing(false);
            setFailed(false);
          }
        }}
        className="field t-nums w-24 px-2 py-1.5 text-[15px]"
      />
      {failed && <span className="text-[13px] text-[var(--danger)]">Couldn't save.</span>}
    </span>
  );
}

// Split tag: a small pill after the spent amount. Even splits read "50%";
// partial splits read "partner $X.XX". Same component, same size.
function SplitTag({ p }: { p: Pot }) {
  if (p.partnerCents <= 0) return null;
  return (
    <span className="t-nums ml-2 inline-flex items-center rounded-[var(--r-pill)] border border-[var(--hairline)] bg-[var(--bg-sunken)] px-2 py-0.5 align-middle text-[11px] font-medium text-[var(--ink)]">
      {p.partnerCents === p.spentCents ? "50%" : `partner ${money(p.partnerCents)}`}
    </span>
  );
}

// Available = assigned minus spent. Green when positive, warm red only
// when overspent, muted at exactly zero.
function Available({ assignedCents, spentCents, className = "" }: { assignedCents: number; spentCents: number; className?: string }) {
  const avail = assignedCents - spentCents;
  const color = avail > 0 ? "var(--success)" : avail < 0 ? "var(--danger)" : "var(--muted)";
  return (
    <span className={`t-nums font-medium ${className}`} style={{ color }}>
      {money(avail)}
    </span>
  );
}

function PotNameCell({ p }: { p: Pot }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[15px] font-semibold">{p.name}</div>
      {p.targetCents > 0 && (
        <div className="mt-0.5 text-[12px] text-[var(--muted)]">target {money(p.targetCents)}</div>
      )}
    </div>
  );
}

function BudgetTable({ pots, month, onAssigned }: { pots: Pot[]; month: string; onAssigned: () => void }) {
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
        const spent = sum(g.pots, (p) => p.spentCents);
        const isOpen = open[g.name] ?? true;
        return (
          <section key={g.name} className="overflow-hidden rounded-[12px] bg-[var(--bg-sunken)]">
            <button
              onClick={() => setOpen((o) => ({ ...o, [g.name]: !isOpen }))}
              className="flex w-full flex-col items-start gap-1 px-4 py-3.5 text-left sm:flex-row sm:items-baseline sm:justify-between sm:gap-3 sm:px-5"
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate font-serif-d text-[20px] font-medium">{titleCase(g.name)}</span>
                <span className="shrink-0 text-[13px] text-[var(--faint)]">{isOpen ? "▾" : "▸"}</span>
              </span>
              <span className="flex shrink-0 items-baseline gap-5 whitespace-nowrap">
                <span className="t-nums text-[14px] text-[var(--ink-2)]">
                  <span className="mr-1.5 text-[12px] text-[var(--muted)]">assigned</span>
                  {money(assigned)}
                </span>
                <span className="t-nums text-[14px] text-[var(--ink-2)]">
                  <span className="mr-1.5 text-[12px] text-[var(--muted)]">spent</span>
                  {money(spent)}
                </span>
                <Available assignedCents={assigned} spentCents={spent} className="text-[14px]" />
              </span>
            </button>
            {isOpen && (
              <div className="px-4 pb-1 sm:px-5">
              {g.pots.map((p) => (
                <div key={p.id} className="border-t border-[var(--hairline)] py-3">
                  {/* narrow screens: name + available up top, assigned/spent below */}
                  <div className="sm:hidden">
                    <div className="flex items-start justify-between gap-3">
                      <PotNameCell p={p} />
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
                    <PotNameCell p={p} />
                    <AssignCell pot={p} month={month} onAssigned={onAssigned} />
                    <span className="t-nums whitespace-nowrap text-[15px]">
                      {money(p.spentCents)}
                      <SplitTag p={p} />
                    </span>
                    <span className="text-right">
                      <Available assignedCents={p.assignedCents ?? 0} spentCents={p.spentCents} />
                    </span>
                  </div>
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
          <p className="mb-2 text-[13px] text-[var(--muted)]">Money in. These pots receive; they are never assigned to.</p>
          {income.map((p) => (
            <div key={p.id} className="flex items-baseline justify-between gap-3 border-b border-[var(--hairline)] py-3">
              <PotNameCell p={p} />
              <span className="t-nums shrink-0 text-[13px] text-[var(--faint)]">income</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecentActivity({ txns, loading }: { txns: Txn[]; loading?: boolean }) {
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
                {t.split_with_partner ? " · split" : ""}
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

function CloseCard({ preview, onGo }: { preview: ClosePreviewData; onGo: (t: Tab) => void }) {
  return (
    <div className="card p-5">
      <div className="mb-3 text-[17px] font-semibold">How the month closes</div>
      <div className="space-y-1.5 text-[15px]">
        <div className="flex justify-between"><span className="text-[var(--muted)]">Inflows</span><span className="t-nums">{money(preview.inflowsCents)}</span></div>
        <div className="flex justify-between"><span className="text-[var(--muted)]">Spent</span><span className="t-nums">{money(preview.spentCents)}</span></div>
        {preview.assignedCents != null && (
          <div className="flex justify-between"><span className="text-[var(--muted)]">Assigned</span><span className="t-nums">{money(preview.assignedCents)}</span></div>
        )}
      </div>
      <div className="mt-2.5 border-t border-[var(--hairline)] pt-2.5 text-[15px]">
        <span className="t-nums font-semibold">{money(preview.movedToSavingsCents)}</span>
        <span className="text-[var(--muted)]"> moves to secondary savings; ready-to-assign → $0</span>
      </div>
      {preview.partnerOwedCents > 0 && (
        <button
          onClick={() => onGo("partner")}
          className="mt-3 flex w-full items-center justify-between rounded-[var(--r-md)] bg-[var(--bg-sunken)] px-4 py-3 text-left text-[15px] transition active:scale-[0.99]"
        >
          <span>Partner owes <span className="t-nums font-medium">{money(preview.partnerOwedCents)}</span></span>
          <span className="text-[var(--faint)]">→</span>
        </button>
      )}
      <p className="mt-3 text-[13px] text-[var(--muted)]">Applied at month-end once ready-to-assign is $0.</p>
    </div>
  );
}

function MonthNav({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  const current = new Date().toISOString().slice(0, 7);
  const atCurrent = month >= current;
  const btn =
    "flex h-11 w-11 items-center justify-center text-[20px] text-[var(--ink-2)] transition active:scale-95 disabled:opacity-40";
  return (
    <div className="mb-5 flex items-center justify-between">
      <button aria-label="Previous month" onClick={() => onChange(shiftMonth(month, -1))} className={btn}>
        ‹
      </button>
      <span className="text-[17px] font-medium">{monthLabel(month)}</span>
      <button aria-label="Next month" onClick={() => onChange(shiftMonth(month, 1))} disabled={atCurrent} className={btn}>
        ›
      </button>
    </div>
  );
}

function OverviewTab({ month, onGo }: { month: string; onGo: (t: Tab) => void }) {
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

function AttentionCard({ attention, overview, accounts, onGo }: {
  attention: Attention | null;
  overview: Overview | null;
  accounts: Account[];
  onGo: (t: Tab) => void;
}) {
  const items: { label: React.ReactNode; tab: Tab }[] = [];
  if (attention) {
    if (attention.pendingReviewCount > 0)
      items.push({
        label: `${attention.pendingReviewCount} transaction${attention.pendingReviewCount === 1 ? "" : "s"} to review`,
        tab: "review",
      });
    for (const a of attention.unreconciledAccounts ?? []) {
      const name = typeof a === "string" ? a : a.name;
      items.push({ label: `${name} not reconciled yet`, tab: "accounts" });
    }
    if (attention.unsettledPartnerCents > 0)
      items.push({
        label: <>Partner owes <span className="t-nums font-medium">{money(attention.unsettledPartnerCents)}</span></>,
        tab: "partner",
      });
    if (attention.rtaCents > 0)
      items.push({
        label: <><span className="t-nums font-medium">{money(attention.rtaCents)}</span> ready to assign</>,
        tab: "pots",
      });
  } else {
    // Legacy fallback while /api/attention is unavailable.
    if (overview && overview.pendingCount > 0)
      items.push({
        label: `${overview.pendingCount} transaction${overview.pendingCount === 1 ? "" : "s"} to review`,
        tab: "review",
      });
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

/* ---------- partner balance ---------- */

function PartnerCard() {
  const { data: info, error, loading, retry } = useApi<PartnerInfo>("/api/partner");
  const { data: accountsData } = useApi<{ accounts: Account[] }>("/api/accounts");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [settleError, setSettleError] = useState(false);
  const [last, setLast] = useState<{ allocations: { potName: string | null; amountCents: number }[]; leftoverCents: number } | null>(null);

  if (loading) {
    return (
      <div className="card space-y-3 p-5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-44" />
        <Skeleton className="h-5 w-full" />
      </div>
    );
  }
  if (error || !info) return <FetchError onRetry={retry} label="Couldn't load the partner balance." />;

  const settled = info.totalOwedCents === 0 && info.creditCents === 0;
  const accounts = accountsData?.accounts ?? [];
  const dest = accounts.find((a) => a.type === "chequing") ?? accounts[0] ?? null;

  const settle = async () => {
    const cents = Math.round(parseFloat(amount) * 100);
    if (!cents || cents <= 0 || busy || !dest) return;
    setBusy(true);
    setSettleError(false);
    try {
      const res = await fetch("/api/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: dest.id, amountCents: cents, note: "Partner settlement" }),
      }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });
      setLast(res);
      setAmount("");
      retry();
    } catch {
      setSettleError(true);
    }
    setBusy(false);
  };

  return (
    <div className="card p-5">
      <div className="text-[17px] font-semibold">{settled ? "Settled up" : "Partner owes you"}</div>
      {settled ? (
        <div className="mt-1.5 text-[24px] italic">All settled.</div>
      ) : (
        <>
          <div className="t-nums mt-1.5 text-[32px] font-light tracking-tight">{money(info.totalOwedCents)}</div>
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
          <input
            type="text"
            inputMode="decimal"
            placeholder="Amount received"
            aria-label="Payment amount received"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") settle();
            }}
            className="field t-nums w-44 px-3 py-2 text-[15px]"
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
                <span className="text-[var(--ink-2)]">{a.potName ?? "Uncategorized"}</span>
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

/* ---------- tabs: pots / close / partner ---------- */

function PotsTab({ month }: { month: string }) {
  const { data, error, loading, retry } = useApi<{ pots: Pot[] }>(`/api/pots?month=${month}`);

  return (
    <div>
      <div className="mb-5 font-serif-d text-[24px] font-medium">Pots</div>
      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[64px]" />)}
        </div>
      ) : error ? (
        <FetchError onRetry={retry} label="Couldn't load pots." />
      ) : (
        <BudgetTable pots={data?.pots ?? []} month={month} onAssigned={retry} />
      )}
    </div>
  );
}

/* ---------- insights ---------- */

const CHART_VARS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6", "--chart-7", "--chart-8"];
const chartColor = (i: number) => `var(${CHART_VARS[i % CHART_VARS.length]})`;

// Donut of this month's user spend by pot group. Hand-rolled SVG; segment
// colors come from CSS variables so dark mode keeps working.
function Donut({ segments }: { segments: { label: string; cents: number }[] }) {
  const total = segments.reduce((a, s) => a + s.cents, 0);
  if (total <= 0)
    return <p className="py-6 text-center text-[19px] italic text-[var(--muted)]">No spending this month yet.</p>;
  const R = 80;
  const C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div className="flex flex-col items-center gap-6 sm:flex-row sm:gap-10">
      <div className="relative shrink-0">
        <svg viewBox="0 0 200 200" className="h-52 w-52" role="img" aria-label="Spending by pot group">
          {segments.map((s, i) => {
            const frac = s.cents / total;
            const len = Math.max(0, frac * C - 3);
            const rot = (acc / total) * 360 - 90;
            acc += s.cents;
            return (
              <circle
                key={s.label}
                cx="100"
                cy="100"
                r={R}
                fill="none"
                strokeWidth="30"
                style={{
                  stroke: chartColor(i),
                  strokeDasharray: `${len} ${C}`,
                  transform: `rotate(${rot}deg)`,
                  transformOrigin: "100px 100px",
                  opacity: 0.92,
                }}
              />
            );
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <div className="t-nums font-serif-d text-[24px] font-medium">{money(total)}</div>
          <div className="text-[12px] text-[var(--muted)]">spent</div>
        </div>
      </div>
      <ul className="w-full max-w-xs flex-1 space-y-2">
        {segments.map((s, i) => (
          <li key={s.label} className="flex items-center gap-2.5 text-[14px]">
            <span className="h-3 w-3 shrink-0 rounded-[4px]" style={{ background: chartColor(i), opacity: 0.92 }} />
            <span className="min-w-0 flex-1 truncate">{titleCase(s.label)}</span>
            <span className="t-nums text-[var(--muted)]">{Math.round((s.cents / total) * 100)}%</span>
            <span className="t-nums w-20 shrink-0 text-right font-medium">{money(s.cents)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Six months of one pot's spend, with the 3-month average as a solid
// reference line in ink: the same number next month's target is wireframed from.
function PotBars({ history }: { history: PotHistoryPoint[] }) {
  if (history.length === 0) return null;
  const max = Math.max(...history.map((h) => h.spentCents), 1);
  const last3 = history.slice(-3);
  const avg = last3.length > 0 ? Math.round(last3.reduce((a, h) => a + h.spentCents, 0) / last3.length) : 0;
  const avgPct = Math.min(100, (avg / max) * 100);
  return (
    <div>
      <div className="relative h-44">
        <div className="absolute inset-0 flex items-end gap-2.5 sm:gap-3">
          {history.map((h) => (
            <div key={h.month} className="flex h-full flex-1 items-end" title={`${monthLabel(h.month)}: ${money(h.spentCents)}`}>
              <div
                className="w-full rounded-t-[6px]"
                style={{
                  height: `${Math.max(3, (h.spentCents / max) * 100)}%`,
                  background: "var(--bar)",
                }}
              />
            </div>
          ))}
        </div>
        {avg > 0 && (
          <div
            className="pointer-events-none absolute left-0 right-0"
            style={{ bottom: `${avgPct}%`, height: 2, background: "var(--ink)", opacity: 0.4 }}
          />
        )}
      </div>
      <div className="mt-1.5 flex gap-2.5 sm:gap-3">
        {history.map((h) => (
          <span key={h.month} className="t-nums flex-1 text-center text-[11px] text-[var(--faint)]">
            {trendLabel(h.month)}
          </span>
        ))}
      </div>
      {avg > 0 && (
        <div className="mt-2.5 flex items-center gap-2 text-[12px] text-[var(--muted)]">
          <span className="inline-block h-[2px] w-6" style={{ background: "var(--ink)", opacity: 0.4 }} />
          <span className="t-nums">3-month avg {money(avg)}</span>
        </div>
      )}
    </div>
  );
}

function InsightsTab({ month }: { month: string }) {
  const { data, error, loading, retry } = useApi<{ pots: Pot[] }>(`/api/pots?month=${month}`);
  const [potId, setPotId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  const pots = data?.pots ?? [];

  // Default to the highest-spend pot once pots load.
  useEffect(() => {
    if (potId === null && pots.length > 0) {
      const top = [...pots].sort((a, b) => b.spentCents - a.spentCents)[0];
      setPotId(top.id);
    }
  }, [pots, potId]);

  const { data: histData, error: histError, loading: histLoading, retry: histRetry } = useApi<{ history: PotHistoryPoint[] }>(
    potId !== null ? `/api/pot-history?potId=${potId}&months=6` : null
  );

  const byGroup = new Map<string, number>();
  for (const p of pots) {
    if (p.spentCents > 0) byGroup.set(p.group, (byGroup.get(p.group) ?? 0) + p.spentCents);
  }
  const segments = [...byGroup.entries()]
    .map(([label, cents]) => ({ label, cents }))
    .sort((a, b) => b.cents - a.cents);

  const selected = pots.find((p) => p.id === potId) ?? null;
  const q = query.trim().toLowerCase();
  const matches = pots.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8);

  return (
    <div className="space-y-10">
      <div>
        <div className="mb-5 font-serif-d text-[24px] font-medium">Insights</div>
        <div className="card p-5">
          <div className="mb-1 text-[17px] font-semibold">Where the money went</div>
          <div className="mb-4 text-[13px] text-[var(--muted)]">{monthLabel(month)}</div>
          {loading ? (
            <div className="flex justify-center py-6"><Skeleton className="h-52 w-52 rounded-full" /></div>
          ) : error ? (
            <FetchError onRetry={retry} label="Couldn't load spending." />
          ) : (
            <Donut segments={segments} />
          )}
        </div>
      </div>
      <div>
        <div className="card p-5">
          <div className="mb-4 text-[17px] font-semibold">Spending over time</div>
          <div className="relative mb-5">
            <input
              type="text"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPickerOpen(true); }}
              onFocus={() => setPickerOpen(true)}
              onBlur={() => window.setTimeout(() => setPickerOpen(false), 120)}
              onKeyDown={(e) => { if (e.key === "Escape") setPickerOpen(false); }}
              placeholder={selected ? selected.name : "Search pots…"}
              aria-label="Search pots"
              className="field w-full px-3 py-2.5 text-[15px]"
            />
            {pickerOpen && matches.length > 0 && (
              <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-[var(--r-md)] border border-[var(--hairline)] bg-[var(--surface)] py-1" style={{ boxShadow: "var(--shadow-elev)" }}>
                {matches.map((p) => (
                  <li key={p.id}>
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => { setPotId(p.id); setQuery(""); setPickerOpen(false); }}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-[15px] transition hover:bg-[var(--bg-sunken)] active:bg-[var(--bg-sunken)]"
                    >
                      <span className="truncate">{p.name}</span>
                      <span className="t-nums shrink-0 text-[13px] text-[var(--muted)]">{money(p.spentCents)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {histLoading ? (
            <div className="flex h-44 items-end gap-3">
              {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-24 flex-1" />)}
            </div>
          ) : histError || !histData ? (
            <FetchError onRetry={histRetry} label="Couldn't load pot history." />
          ) : (
            <PotBars history={histData.history} />
          )}
        </div>
      </div>
    </div>
  );
}

function CloseTab({ month, onGo }: { month: string; onGo: (t: Tab) => void }) {
  const { data: preview, error, loading, retry } = useApi<ClosePreviewData>(`/api/close-preview?month=${month}`);

  return (
    <div>
      <div className="mb-5 font-serif-d text-[24px] font-medium">Close</div>
      {loading ? (
        <div className="card space-y-2.5 p-5">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-5 w-3/5" />
        </div>
      ) : error || !preview ? (
        <FetchError onRetry={retry} label="Couldn't load the close preview." />
      ) : (
        <CloseCard preview={preview} onGo={onGo} />
      )}
    </div>
  );
}

function PartnerTab() {
  return (
    <div>
      <div className="mb-5 font-serif-d text-[24px] font-medium">Partner</div>
      <PartnerCard />
    </div>
  );
}

/* ---------- review ---------- */

function ReviewQueue({ onChange }: { onChange: () => void }) {
  const { data, error, loading, retry } = useApi<{ transactions: Txn[] }>("/api/review");
  const [doneIds, setDoneIds] = useState<Set<number>>(new Set());

  const confirm = async (id: number) => {
    await fetch(`/api/review/${id}/confirm`, { method: "POST" });
    setDoneIds((s) => new Set(s).add(id));
    onChange();
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[76px]" />)}
      </div>
    );
  }
  if (error) return <FetchError onRetry={retry} label="Couldn't load the review queue." />;

  const txns = (data?.transactions ?? []).filter((t) => !doneIds.has(t.id));
  if (txns.length === 0)
    return <p className="py-6 text-center text-[19px] italic text-[var(--muted)]">All clear.</p>;

  return (
    <ul className="space-y-3">
      {txns.map((t) => (
        <li key={t.id} className="card flex items-center justify-between gap-3 overflow-hidden">
          <div className="w-1 self-stretch bg-[var(--warning)]" />
          <div className="min-w-0 flex-1 py-3.5">
            <div className="truncate text-[15px] font-semibold">{t.description}</div>
            <div className="mt-0.5 text-[13px] text-[var(--muted)]">{fmtDate(t.date)} · via {t.source}</div>
            {t.review_reason && (
              <div className="mt-1 text-[13px] font-medium text-[var(--warning)]">Agent wasn't sure: {t.review_reason}</div>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2 py-3.5 pr-4">
            <span className="t-nums text-[15px]">{money(t.amount_cents ?? 0)}</span>
            <button onClick={() => confirm(t.id)} className="btn-ink px-4 py-1.5 text-[13px]">
              Confirm
            </button>
          </div>
        </li>
      ))}
    </ul>
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

function AccountsView() {
  const { data, error, loading, retry } = useApi<{ accounts: Account[] }>("/api/accounts");
  const [actual, setActual] = useState<Record<number, string>>({});
  const [result, setResult] = useState<Record<number, ReconcileResponse | null>>({});

  const load = () => retry();

  const reconcile = async (id: number) => {
    const cents = Math.round(parseFloat(actual[id] ?? "NaN") * 100);
    if (!Number.isFinite(cents)) return;
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
            <input
              type="text"
              inputMode="decimal"
              placeholder="Actual balance"
              value={actual[a.id] ?? ""}
              onChange={(e) => setActual((p) => ({ ...p, [a.id]: e.target.value }))}
              className="field t-nums w-36 px-3 py-2 text-[15px]"
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

/* ---------- app ---------- */

type Tab = "overview" | "pots" | "insights" | "close" | "partner" | "review" | "accounts";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "pots", label: "Pots" },
  { id: "insights", label: "Insights" },
  { id: "close", label: "Close" },
  { id: "partner", label: "Partner" },
  { id: "review", label: "Review" },
  { id: "accounts", label: "Accounts" },
];

const tabLabel = (id: Tab) => TABS.find((t) => t.id === id)?.label ?? id;

const MONTH_TABS: Tab[] = ["overview", "pots", "insights", "close"];

// Mobile bottom bar: four tabs plus a "More" sheet for the rest.
const MOBILE_TABS: Tab[] = ["overview", "pots", "insights", "close"];
const SHEET_TABS: Tab[] = ["partner", "review", "accounts"];

function CountBadge({ n, className = "" }: { n: number; className?: string }) {
  return (
    <span className={`t-nums flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--ink)] px-1.5 text-[11px] font-bold text-[var(--bg)] ${className}`}>
      {n}
    </span>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [pendingCount, setPendingCount] = useState(0);
  const { data: attention } = useApi<Attention>("/api/attention");

  useEffect(() => {
    fetch("/api/review")
      .then((r) => r.json())
      .then((d) => setPendingCount(d.transactions.length))
      .catch(() => {});
  }, [refreshKey, tab]);

  // Near month-end with money still unassigned, the Close tab earns a dot.
  const now = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const closeAlert = now.getDate() >= lastDay - 2 && (attention?.rtaCents ?? 0) > 0;

  const go = (t: Tab) => {
    setTab(t);
    setSheetOpen(false);
    window.scrollTo(0, 0);
  };

  const navBadge = (id: Tab) => {
    if (id === "review" && pendingCount > 0) return <CountBadge n={pendingCount} className="ml-auto" />;
    if (id === "close" && closeAlert) return <span className="ml-auto h-2 w-2 rounded-full bg-[var(--warning)]" />;
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
                    ? "bg-[var(--bg-sunken)] font-semibold text-[var(--ink)]"
                    : "font-medium text-[var(--muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--ink-2)]"
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

          {tab === "insights" && <InsightsTab key={`i-${refreshKey}-${month}`} month={month} />}

          {tab === "close" && <CloseTab key={`c-${refreshKey}-${month}`} month={month} onGo={go} />}

          {tab === "partner" && <PartnerTab key={`pt-${refreshKey}`} />}

          {tab === "review" && (
            <div>
              <div className="mb-1 font-serif-d text-[24px] font-medium">Review</div>
              <p className="mb-5 text-[15px] text-[var(--muted)]">
                Only the entries that weren't clear. One tap to confirm.
              </p>
              <ReviewQueue onChange={() => setRefreshKey((k) => k + 1)} />
            </div>
          )}

          {tab === "accounts" && (
            <div>
              <div className="mb-5 font-serif-d text-[24px] font-medium">Accounts</div>
              <AccountsView />
            </div>
          )}
        </div>
      </div>

      {/* mobile bottom tab bar */}
      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--hairline)] bg-[var(--surface)] pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="Primary">
        <div className="grid grid-cols-5">
          {MOBILE_TABS.map((id) => {
            const active = tab === id;
            return (
              <button
                key={id}
                onClick={() => go(id)}
                className={`relative flex min-h-[64px] flex-col items-center justify-center gap-1 text-[11px] transition active:scale-95 ${
                  active ? "font-semibold text-[var(--ink)]" : "text-[var(--muted)]"
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-[var(--ink)]" : "bg-transparent"}`} />
                {tabLabel(id)}
                {id === "close" && closeAlert && (
                  <span className="absolute right-4 top-3 h-2 w-2 rounded-full bg-[var(--warning)]" />
                )}
              </button>
            );
          })}
          <button
            onClick={() => setSheetOpen(true)}
            className={`relative flex min-h-[64px] flex-col items-center justify-center gap-1 text-[11px] transition active:scale-95 ${
              SHEET_TABS.includes(tab) ? "font-semibold text-[var(--ink)]" : "text-[var(--muted)]"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${SHEET_TABS.includes(tab) ? "bg-[var(--ink)]" : "bg-transparent"}`} />
            More
            {pendingCount > 0 && (
              <span className="t-nums absolute right-3 top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--ink)] px-1 text-[10px] font-bold text-[var(--bg)]">
                {pendingCount}
              </span>
            )}
          </button>
        </div>
      </nav>

      {/* mobile "More" bottom sheet */}
      {sheetOpen && (
        <div className="fixed inset-0 z-30 md:hidden" role="dialog" aria-label="More">
          <div className="absolute inset-0 bg-black/30" onClick={() => setSheetOpen(false)} />
          <div className="absolute inset-x-0 bottom-0 rounded-t-[var(--r-lg)] border-t border-[var(--hairline)] bg-[var(--surface)] p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
            {SHEET_TABS.map((id) => (
              <button
                key={id}
                onClick={() => go(id)}
                className="flex min-h-[52px] w-full items-center justify-between rounded-[var(--r-md)] px-3 text-left text-[16px] transition active:bg-[var(--bg-sunken)]"
              >
                <span className={tab === id ? "font-medium" : undefined}>{tabLabel(id)}</span>
                {id === "review" && pendingCount > 0 && <CountBadge n={pendingCount} />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
