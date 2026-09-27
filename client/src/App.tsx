import { useEffect, useState } from "react";

/* ---------- types ---------- */

interface Txn {
  id: number;
  date: string;
  description: string;
  amount_cents: number;
  source: string;
  status: string;
  lilly_cents: number;
}

interface Overview {
  month: string;
  confirmedSpendCents: number;
  pendingCount: number;
  recent: Txn[];
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
  lillyCents: number;
}

interface LillyInfo {
  totalOwedCents: number;
  creditCents: number;
  byPot: { pot: string; cents: number }[];
  oldest: string | null;
}

interface TrendPoint {
  month: string;
  spent: number;
}

/* ---------- helpers ---------- */

const money = (cents: number) =>
  `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};

/* ---------- primitives ---------- */

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:border-zinc-800 dark:bg-zinc-900 ${className}`}>
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400 dark:text-zinc-500">{children}</div>;
}

function ProgressBar({ pct }: { pct: number }) {
  const color = pct > 100 ? "bg-rose-500" : pct >= 80 ? "bg-amber-400" : "bg-emerald-500";
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

/* ---------- overview pieces ---------- */

function Hero({ overview }: { overview: Overview | null }) {
  const today = new Date();
  const day = today.getDate();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const spent = overview?.confirmedSpendCents ?? 0;
  const daily = spent / Math.max(1, day);
  return (
    <Card className="overflow-hidden">
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400 dark:text-zinc-500">
        {overview ? monthLabel(overview.month) : "…"}
      </div>
      <div className="mt-2 text-[44px] font-semibold leading-none tracking-tight tabular-nums">
        {overview ? money(spent) : "…"}
      </div>
      <div className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        spent so far · <span className="tabular-nums">{money(Math.round(daily))}/day</span> · day {day} of {daysInMonth}
      </div>
    </Card>
  );
}

function PotsGrid({ pots }: { pots: Pot[] }) {
  if (pots.length === 0)
    return <p className="text-sm text-zinc-500">No pots yet. They'll appear here once the budget is set up.</p>;
  return (
    <div className="grid grid-cols-2 gap-3">
      {pots.map((p) => {
        const pct = p.targetCents > 0 ? (p.spentCents / p.targetCents) * 100 : 0;
        const left = p.targetCents - p.spentCents;
        return (
          <Card key={p.id} className="p-4">
            <div className="truncate text-sm font-medium">{p.name}</div>
            <div className="mt-1 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
              <span className="text-zinc-900 dark:text-zinc-100">{money(p.spentCents)}</span> of {money(p.targetCents)}
              {p.lillyCents > 0 && <span className="text-zinc-400"> · {money(p.lillyCents)} Lilly's share</span>}
            </div>
            <div className="mt-2"><ProgressBar pct={pct} /></div>
            <div className={`mt-1.5 text-xs tabular-nums ${left < 0 ? "text-rose-500" : "text-zinc-400"}`}>
              {left < 0 ? `${money(left)} over` : `${money(left)} left`}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function Trend({ data }: { data: TrendPoint[] }) {
  if (data.length === 0) return null;
  const max = Math.max(...data.map((d) => d.spent), 1);
  return (
    <Card>
      <SectionLabel>Spending trend</SectionLabel>
      <div className="flex h-28 items-end gap-2.5">
        {data.map((d, i) => (
          <div key={d.month} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
            <div
              title={`${monthLabel(d.month)}: ${money(d.spent)}`}
              className={`w-full rounded-t-md ${i === data.length - 1 ? "bg-zinc-900 dark:bg-zinc-100" : "bg-zinc-200 dark:bg-zinc-700"}`}
              style={{ height: `${Math.max(4, (d.spent / max) * 100)}%` }}
            />
            <span className="text-[10px] tabular-nums text-zinc-400">{d.month.slice(5)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function OverviewTab({ onGo }: { onGo: (t: "review" | "accounts") => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [pots, setPots] = useState<Pot[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);

  useEffect(() => {
    fetch("/api/overview").then((r) => r.json()).then(setOverview);
    fetch("/api/pots").then((r) => r.json()).then((d) => setPots(d.pots));
    fetch("/api/trend").then((r) => r.json()).then((d) => setTrend(d.trend));
    fetch("/api/accounts").then((r) => r.json()).then((d) => setAccounts(d.accounts));
  }, []);

  return (
    <div className="space-y-4">
      <Hero overview={overview} />
      <ClickableAttention overview={overview} accounts={accounts} onGo={onGo} />
      <LillyCard />
      <div>
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400 dark:text-zinc-500">Pots</div>
        <PotsGrid pots={pots} />
      </div>
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
    <Card>
      <SectionLabel>Needs attention</SectionLabel>
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {items.map((it, i) => (
          <li key={i}>
            <button onClick={() => onGo(it.tab)} className="flex w-full items-center justify-between py-2 text-left text-sm hover:opacity-70">
              <span className="flex items-center gap-2.5">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
                {it.label}
              </span>
              <span className="text-zinc-400">→</span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ---------- lilly owes ---------- */

function LillyCard() {
  const [info, setInfo] = useState<LillyInfo | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ allocations: { potName: string | null; amountCents: number }[]; leftoverCents: number } | null>(null);

  const load = () => fetch("/api/lilly").then((r) => r.json()).then(setInfo);
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
        body: JSON.stringify({ accountId: acct.id, amountCents: cents, note: "Lilly settlement" }),
      }).then((r) => r.json());
      setLast(res);
      setAmount("");
      await load();
    }
    setBusy(false);
  };

  return (
    <Card>
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-400 dark:text-zinc-500">Lilly owes you</div>
      <div className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">{money(info.totalOwedCents)}</div>
      {info.oldest && <div className="mt-1 text-xs text-zinc-500">oldest since {info.oldest}</div>}
      <ul className="mt-3 space-y-1">
        {info.byPot.map((b) => (
          <li key={b.pot} className="flex items-center justify-between text-sm">
            <span className="text-zinc-600 dark:text-zinc-400">{b.pot}</span>
            <span className="tabular-nums">{money(b.cents)}</span>
          </li>
        ))}
      </ul>
      {info.creditCents > 0 && (
        <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">{money(info.creditCents)} credit from overpayment</div>
      )}
      <div className="mt-3 flex gap-2">
        <input
          type="number"
          step="0.01"
          placeholder="Lump sum received"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="w-44 rounded-lg border border-zinc-200 bg-transparent px-2.5 py-1.5 text-sm tabular-nums dark:border-zinc-700"
        />
        <button
          onClick={settle}
          disabled={busy}
          className="rounded-lg bg-zinc-900 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {busy ? "Settling…" : "Settle up"}
        </button>
      </div>
      {last && (
        <div className="mt-3 rounded-xl bg-zinc-50 p-3.5 text-sm dark:bg-zinc-800/60">
          <div className="font-medium">Buckets filled</div>
          <ul className="mt-1.5 space-y-1 text-xs">
            {last.allocations.map((a, i) => (
              <li key={i} className="flex items-center justify-between">
                <span className="text-zinc-600 dark:text-zinc-400">{a.potName ?? "Uncategorized"}</span>
                <span className="tabular-nums">{money(a.amountCents)}</span>
              </li>
            ))}
          </ul>
          {last.leftoverCents > 0 && (
            <div className="mt-1.5 text-xs text-emerald-600 dark:text-emerald-400">{money(last.leftoverCents)} kept as credit</div>
          )}
        </div>
      )}
    </Card>
  );
}

/* ---------- review ---------- */

function ReviewQueue({ onChange }: { onChange: () => void }) {
  const [txns, setTxns] = useState<Txn[]>([]);
  useEffect(() => {
    fetch("/api/review").then((r) => r.json()).then((d) => setTxns(d.transactions));
  }, []);

  const confirm = async (id: number) => {
    await fetch(`/api/review/${id}/confirm`, { method: "POST" });
    setTxns((t) => t.filter((x) => x.id !== id));
    onChange();
  };

  if (txns.length === 0)
    return <p className="text-sm text-zinc-500">All clear. Nothing needs your eyes.</p>;

  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {txns.map((t) => (
        <li key={t.id} className="flex items-center justify-between gap-3 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{t.description}</div>
            <div className="text-xs text-zinc-500">{t.date} · via {t.source}</div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="text-sm tabular-nums">{money(t.amount_cents)}</span>
            {t.lilly_cents > 0 && (
              <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
                split · {money(t.lilly_cents)} Lilly
              </span>
            )}
            <button
              onClick={() => confirm(t.id)}
              className="rounded-full bg-zinc-900 px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
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
    return <p className="text-sm text-zinc-500">No accounts yet.</p>;

  return (
    <div className="space-y-4">
      {accounts.map((a) => (
        <Card key={a.id}>
          <div className="flex items-baseline justify-between">
            <div className="font-medium">{a.name}</div>
            <div className="text-lg tabular-nums">{money(a.workingBalanceCents)}</div>
          </div>
          <div className="mt-1 text-xs text-zinc-500">
            Cleared {money(a.clearedBalanceCents)}
            {a.lastReconciledAt ? ` · reconciled ${a.lastReconciledAt.slice(0, 10)}` : " · never reconciled"}
          </div>
          <div className="mt-3 flex gap-2">
            <input
              type="number"
              step="0.01"
              placeholder="Actual balance"
              value={actual[a.id] ?? ""}
              onChange={(e) => setActual((p) => ({ ...p, [a.id]: e.target.value }))}
              className="w-36 rounded-lg border border-zinc-200 bg-transparent px-2.5 py-1.5 text-sm tabular-nums dark:border-zinc-700"
            />
            <button
              onClick={() => reconcile(a.id)}
              className="rounded-lg bg-zinc-900 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Reconcile
            </button>
          </div>
          {result[a.id] && (
            <div className="mt-3 rounded-xl bg-zinc-50 p-3.5 text-sm dark:bg-zinc-800/60">
              {result[a.id]!.balanced ? (
                <span className="font-medium text-emerald-600 dark:text-emerald-400">Balanced. Nice.</span>
              ) : (
                <>
                  <div>Difference: <strong className="tabular-nums">{money(result[a.id]!.differenceCents)}</strong></div>
                  <ul className="mt-2 space-y-1.5">
                    {result[a.id]!.uncleared!.map((t) => (
                      <li key={t.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate">{t.description} <span className="text-zinc-500 tabular-nums">{money(t.amount_cents)}</span></span>
                        <button onClick={() => clearTxn(a.id, t.id)}
                          className={`shrink-0 rounded-full px-2.5 py-1 font-medium ${result[a.id]!.suggestedClearId === t.id ? "bg-blue-600 text-white" : "bg-zinc-200 dark:bg-zinc-700"}`}>
                          {result[a.id]!.suggestedClearId === t.id ? "This one posted — clear it" : "Clear"}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

/* ---------- app ---------- */

type Tab = "overview" | "review" | "accounts";

export default function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 antialiased dark:bg-zinc-950 dark:text-zinc-100">
      <div className="mx-auto max-w-2xl px-4 py-8">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight">agentic-budget</h1>
          <nav className="flex gap-0.5 rounded-full border border-zinc-200/80 bg-white p-1 text-sm shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            {(["overview", "review", "accounts"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-full px-3.5 py-1.5 capitalize transition ${tab === t ? "bg-zinc-900 font-medium text-white dark:bg-white dark:text-zinc-900" : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"}`}
              >
                {t}
              </button>
            ))}
          </nav>
        </header>

        {tab === "overview" && <OverviewTab key={refreshKey} onGo={setTab} />}

        {tab === "review" && (
          <Card>
            <SectionLabel>Pending review</SectionLabel>
            <p className="mb-4 text-sm text-zinc-500">
              The agent entered these. One tap to confirm.
            </p>
            <ReviewQueue onChange={() => setRefreshKey((k) => k + 1)} />
          </Card>
        )}

        {tab === "accounts" && <AccountsView />}
      </div>
    </div>
  );
}
