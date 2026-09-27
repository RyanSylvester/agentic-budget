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
  const d = new Date(`${iso}T12:00:00`);
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

function Hero({ overview, isCurrent }: { overview: Overview | null; isCurrent: boolean }) {
  const today = new Date();
  const day = today.getDate();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const spent = overview?.confirmedSpendCents ?? 0;
  const daily = spent / Math.max(1, day);
  return (
    <div className="pb-1 pt-2">
      {!isCurrent && (
        <div className="font-serif-d text-[17px] italic text-[var(--muted)]">final for the month</div>
      )}
      <div className="t-nums mt-1 text-[56px] font-light leading-none tracking-[-0.02em]">
        {overview ? money(spent) : "…"}
      </div>
      <div className="mt-2.5 text-[15px]">
        {isCurrent ? (
          <>
            <span className="t-nums font-medium text-[var(--ink-2)]">{money(Math.round(daily))}/day</span>
            <span className="text-[var(--muted)]"> · day {day} of {daysInMonth}</span>
          </>
        ) : (
          <span className="text-[var(--muted)]">{overview ? monthLabel(overview.month) : ""}</span>
        )}
      </div>
    </div>
  );
}

function PotCard({ p, partnerName }: { p: Pot; partnerName: string }) {
  const hasTarget = p.targetCents > 0;
  const pct = hasTarget ? (p.spentCents / p.targetCents) * 100 : 0;
  const over = hasTarget && p.spentCents > p.targetCents;
  const left = p.targetCents - p.spentCents;
  return (
    <div className="card p-4">
      <div className="truncate text-[15px] font-semibold">{p.name}</div>
      <div className="t-nums mt-1 text-[13px] text-[var(--muted)]">
        {hasTarget ? (
          <>
            <span className="text-[var(--ink)]">{money(p.spentCents)}</span> of {money(p.targetCents)}
          </>
        ) : (
          <span className="text-[var(--ink)]">{money(p.spentCents)}</span>
        )}
        {p.partnerCents > 0 && (
          <span> · {p.partnerCents === p.spentCents ? `${partnerName}'s half` : `${money(p.partnerCents)} ${partnerName}'s`}</span>
        )}
      </div>
      {hasTarget && (
        <>
          <div className="mt-2.5 h-[6px] overflow-hidden rounded-full bg-[var(--bg-sunken)]">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, pct)}%`,
                background: over ? "var(--danger)" : "var(--accent)",
              }}
            />
          </div>
          <div
            className="t-nums mt-1.5 text-[13px] font-semibold"
            style={{ color: over ? "var(--danger)" : "var(--muted)" }}
          >
            {over ? `${money(left)} over` : `${money(left)} left`}
          </div>
        </>
      )}
    </div>
  );
}

function PotsGrid({ pots, partnerName }: { pots: Pot[]; partnerName: string }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (pots.length === 0)
    return <p className="font-serif-d text-[17px] italic text-[var(--muted)]">No pots yet. They'll appear here once the budget is set up.</p>;

  const groups: { name: string; pots: Pot[] }[] = [];
  for (const p of pots) {
    const g = groups.find((x) => x.name === p.group);
    if (g) g.pots.push(p);
    else groups.push({ name: p.group, pots: [p] });
  }

  return (
    <div className="space-y-5">
      {groups.map((g) => {
        const spent = g.pots.reduce((a, p) => a + p.spentCents, 0);
        const target = g.pots.reduce((a, p) => a + p.targetCents, 0);
        const isOpen = open[g.name] ?? spent > 0;
        return (
          <div key={g.name}>
            <button
              onClick={() => setOpen((o) => ({ ...o, [g.name]: !isOpen }))}
              className="mb-2.5 flex w-full items-baseline justify-between text-left"
            >
              <span className="font-serif-d text-[20px] font-medium">{titleCase(g.name)}</span>
              <span className="t-nums text-[13px] text-[var(--muted)]">
                {money(spent)}{target > 0 ? ` of ${money(target)}` : ""}
                <span className="ml-2 inline-block w-3 text-[var(--faint)]">{isOpen ? "▾" : "▸"}</span>
              </span>
            </button>
            {isOpen && (
              <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2">
                {g.pots.map((p) => <PotCard key={p.id} p={p} partnerName={partnerName} />)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RecentActivity({ txns, partnerName, loading }: { txns: Txn[]; partnerName: string; loading?: boolean }) {
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
        <p className="font-serif-d text-[17px] italic text-[var(--muted)]">Nothing here yet.</p>
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
                {t.split_with_partner ? ` · split with ${partnerName}` : ""}
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

function CloseCard({ preview }: { preview: ClosePreviewData | null }) {
  if (!preview) return null;
  return (
    <div className="card p-5">
      <div className="mb-3"><Eyebrow>Month-end preview</Eyebrow></div>
      <div className="space-y-1.5 text-[15px]">
        <div className="flex justify-between"><span className="text-[var(--muted)]">Inflows</span><span className="t-nums">{money(preview.inflowsCents)}</span></div>
        <div className="flex justify-between"><span className="text-[var(--muted)]">Spent</span><span className="t-nums">{money(preview.spentCents)}</span></div>
        <div className="flex justify-between border-t border-[var(--hairline)] pt-1.5 font-semibold">
          <span>Ready to assign</span><span className="t-nums">{money(preview.rtaBeforeCents)}</span>
        </div>
        <div className="flex justify-between text-[13px] text-[var(--muted)]">
          <span>Moves to secondary savings at close</span><span className="t-nums">{money(preview.movedToSavingsCents)}</span>
        </div>
      </div>
      <p className="mt-3 text-[13px] text-[var(--muted)]">The agent applies the close at month-end after your review.</p>
    </div>
  );
}

function Trend({ data }: { data: TrendPoint[] }) {
  if (data.length === 0) return null;
  const max = Math.max(...data.map((d) => d.spent), 1);
  return (
    <div>
      <div className="mb-2"><Eyebrow>Spending trend</Eyebrow></div>
      <div className="flex h-28 items-end gap-2.5">
        {data.map((d, i) => (
          <div key={d.month} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
            <div
              title={`${monthLabel(d.month)}: ${money(d.spent)}`}
              className="w-full rounded-t-[4px]"
              style={{
                height: `${Math.max(4, (d.spent / max) * 100)}%`,
                background: i === data.length - 1 ? "var(--accent)" : "var(--hairline-strong)",
              }}
            />
            <span className="t-nums text-[11px] text-[var(--faint)]">{trendLabel(d.month)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MonthNav({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  const current = new Date().toISOString().slice(0, 7);
  const atCurrent = month >= current;
  const btn =
    "flex h-11 w-11 items-center justify-center rounded-full border border-[var(--hairline-strong)] text-[17px] text-[var(--ink-2)] transition active:scale-95 disabled:opacity-40";
  return (
    <div className="mb-5 flex items-center justify-between">
      <button aria-label="Previous month" onClick={() => onChange(shiftMonth(month, -1))} className={btn}>
        ‹
      </button>
      <span className="font-serif-d text-[17px] italic">{monthLabel(month)}</span>
      <button aria-label="Next month" onClick={() => onChange(shiftMonth(month, 1))} disabled={atCurrent} className={btn}>
        ›
      </button>
    </div>
  );
}

function OverviewTab({ month, onGo }: { month: string; onGo: (t: "review" | "accounts") => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [pots, setPots] = useState<Pot[]>([]);
  const [partnerName, setPartnerName] = useState("Partner");
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [close, setClose] = useState<ClosePreviewData | null>(null);

  const current = new Date().toISOString().slice(0, 7);

  useEffect(() => {
    setOverview(null);
    fetch(`/api/overview?month=${month}`).then((r) => r.json()).then((d) => { setOverview(d); setPartnerName(d.partnerName ?? "Partner"); });
    fetch(`/api/pots?month=${month}`).then((r) => r.json()).then((d) => setPots(d.pots));
    fetch(`/api/close-preview?month=${month}`).then((r) => r.json()).then(setClose);
  }, [month]);

  useEffect(() => {
    fetch("/api/trend").then((r) => r.json()).then((d) => setTrend(d.trend));
    fetch("/api/accounts").then((r) => r.json()).then((d) => setAccounts(d.accounts));
  }, []);

  return (
    <div className="space-y-7">
      <Hero overview={overview} isCurrent={month === current} />
      <ClickableAttention overview={overview} accounts={accounts} onGo={onGo} />
      <PartnerCard />
      <div>
        <div className="mb-3"><Eyebrow>Pots</Eyebrow></div>
        <PotsGrid pots={pots} partnerName={partnerName} />
      </div>
      <RecentActivity txns={overview?.recent ?? []} partnerName={partnerName} />
      <CloseCard preview={close} />
      <Trend data={trend} />
    </div>
  );
}

function ClickableAttention({ overview, accounts, onGo }: { overview: Overview | null; accounts: Account[]; onGo: (t: "review" | "accounts") => void }) {
  const items: { label: string; tab: "review" | "accounts" }[] = [];
  if (overview && overview.pendingCount > 0)
    items.push({ label: `${overview.pendingCount} transaction${overview.pendingCount === 1 ? "" : "s"} to review`, tab: "review" });
  for (const a of accounts)
    if (!a.lastReconciledAt)
      items.push({ label: `${a.name} not reconciled yet`, tab: "accounts" });
  if (items.length === 0) return null;
  return (
    <div className="card px-5 py-4">
      <div className="mb-1"><Eyebrow>Needs attention</Eyebrow></div>
      <ul>
        {items.map((it, i) => (
          <li key={i} className="border-b border-[var(--hairline)] last:border-0">
            <button onClick={() => onGo(it.tab)} className="flex w-full items-center justify-between py-2.5 text-left text-[15px] transition active:scale-[0.99]">
              <span className="flex items-center gap-2.5">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--warning)]" />
                {it.label}
              </span>
              <span className="text-[var(--faint)]">→</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- partner balance ---------- */

function PartnerCard() {
  const [info, setInfo] = useState<PartnerInfo | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ allocations: { potName: string | null; amountCents: number }[]; leftoverCents: number } | null>(null);

  const load = () => fetch("/api/partner").then((r) => r.json()).then(setInfo);
  useEffect(() => { load(); }, []);

  if (!info || (info.totalOwedCents === 0 && info.creditCents === 0)) return null;

  const settle = async () => {
    const cents = Math.round(parseFloat(amount) * 100);
    if (!cents || cents <= 0 || busy) return;
    setBusy(true);
    const d = await fetch("/api/accounts").then((r) => r.json());
    const accounts = d.accounts as Account[];
    const acct = accounts.find((a) => a.type === "chequing") ?? accounts[0];
    if (acct) {
      const res = await fetch("/api/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: acct.id, amountCents: cents, note: "Partner settlement" }),
      }).then((r) => r.json());
      setLast(res);
      setAmount("");
      await load();
    }
    setBusy(false);
  };

  return (
    <div className="card p-5">
      <Eyebrow>{info.partnerName} owes you</Eyebrow>
      <div className="t-nums mt-1.5 text-[32px] font-light tracking-tight">{money(info.totalOwedCents)}</div>
      {info.oldest && <div className="mt-1 text-[13px] text-[var(--muted)]">oldest since {info.oldest}</div>}
      <ul className="mt-3 space-y-1">
        {info.byPot.map((b) => (
          <li key={b.pot} className="flex items-center justify-between text-[15px]">
            <span className="text-[var(--ink-2)]">{b.pot}</span>
            <span className="t-nums">{money(b.cents)}</span>
          </li>
        ))}
      </ul>
      {info.creditCents > 0 && (
        <div className="mt-2 text-[13px] font-medium text-[var(--success)]">{money(info.creditCents)} credit from overpayment</div>
      )}
      <div className="mt-4 flex gap-2">
        <input
          type="text"
          inputMode="decimal"
          placeholder="Lump sum received"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="field t-nums w-44 px-3 py-2 text-[15px]"
        />
        <button onClick={settle} disabled={busy} className="btn-ink px-4 py-2 text-[15px]">
          {busy ? "Settling…" : "Settle up"}
        </button>
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
    return <p className="font-serif-d py-6 text-center text-[19px] italic text-[var(--muted)]">All clear.</p>;

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
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [actual, setActual] = useState<Record<number, string>>({});
  const [result, setResult] = useState<Record<number, ReconcileResponse | null>>({});

  const load = () => fetch("/api/accounts").then((r) => r.json()).then((d) => setAccounts(d.accounts));
  useEffect(() => { load(); }, []);

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

  if (accounts.length === 0)
    return <p className="font-serif-d text-[17px] italic text-[var(--muted)]">No accounts yet.</p>;

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
                <span className="font-serif-d text-[17px] italic">Balanced. Nice.</span>
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

type Tab = "overview" | "review" | "accounts";

export default function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [refreshKey, setRefreshKey] = useState(0);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    fetch("/api/review").then((r) => r.json()).then((d) => setPendingCount(d.transactions.length));
  }, [refreshKey, tab]);

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-2xl px-5 py-8">
        <header className="mb-7 flex items-center justify-between gap-3">
          <h1 className="font-serif-d shrink-0 whitespace-nowrap text-[19px] font-medium tracking-tight">Daybook</h1>
          <nav
            className="no-scrollbar flex min-w-0 gap-0.5 overflow-x-auto rounded-full border border-[var(--hairline)] bg-[var(--surface)] p-1 text-[13px]"
            style={{ boxShadow: "var(--shadow-card)" }}
          >
            {(["overview", "review", "accounts"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`relative shrink-0 rounded-full px-2.5 py-1.5 capitalize transition active:scale-95 ${tab === t ? "pill-active font-medium" : "text-[var(--muted)]"}`}
              >
                {t}
                {t === "review" && pendingCount > 0 && (
                  <span className="t-nums absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-[#161513] px-1 text-[11px] font-bold text-[#faf9f5]">
                    {pendingCount}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </header>

        {tab === "overview" && (
          <>
            <MonthNav month={month} onChange={setMonth} />
            <OverviewTab key={`${refreshKey}-${month}`} month={month} onGo={setTab} />
          </>
        )}

        {tab === "review" && (
          <div>
            <div className="mb-1 font-serif-d text-[24px] font-medium">Review</div>
            <p className="mb-5 text-[15px] text-[var(--muted)]">
              Only the entries the agent wasn't sure about. One tap to confirm.
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
  );
}
