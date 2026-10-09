import { useApi } from "./api";
import { currentMonthLocal, fmtDate, money, monthLabel } from "./format";
import { type Tab } from "./tabs";
import type { Account, AccountsResponse, Attention, Overview, RecentTransaction } from "./types";
import { Eyebrow, FetchError, Skeleton } from "./ui";

/* ---------- overview pieces ---------- */

/* Ready to assign has one home on Overview: this line under the hero figure.
 * With money waiting it is a button that jumps to Pots, where the assigning
 * happens; at zero it settles into a quiet confirmation. */
export function RtaLine({ cents, onAssign }: { cents: number; onAssign?: () => void }) {
  if (cents === 0) {
    return <div className="mt-3 text-[15px] text-[var(--muted)]">Every dollar is assigned</div>;
  }
  const over = cents < 0;
  const body = (
    <>
      <span className={`t-nums font-medium ${over ? "text-[var(--danger)]" : "text-[var(--accent)]"}`}>
        {money(Math.abs(cents))}
      </span>
      <span className="text-[var(--ink-2)]">{over ? " over-assigned" : " ready to assign"}</span>
    </>
  );
  if (!onAssign) return <div className="mt-3 text-[15px]">{body}</div>;
  return (
    <button
      onClick={onAssign}
      className={`mt-3 inline-flex min-h-11 items-center gap-1 rounded-[var(--r-pill)] pl-4 pr-3 text-[15px] transition active:scale-[0.98] ${
        over ? "bg-[var(--danger-soft)]" : "bg-[var(--accent-soft)]"
      }`}
    >
      {body}
      <span className={`ml-2 font-medium ${over ? "text-[var(--danger)]" : "text-[var(--accent)]"}`}>
        {over ? "Fix in Pots" : "Assign"} <span aria-hidden>→</span>
      </span>
    </button>
  );
}

export function Hero({ overview, isCurrent, loading, onAssign }: {
  overview: Overview | null;
  isCurrent: boolean;
  loading?: boolean;
  /** Where the ready-to-assign line leads; omitted, the line is plain text. */
  onAssign?: () => void;
}) {
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
      {isCurrent && <RtaLine cents={overview.rtaCents} onAssign={onAssign} />}
    </div>
  );
}

export function RecentActivity({ txns, loading }: { txns: RecentTransaction[]; loading?: boolean }) {
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

export function OverviewTab({ month, onGo }: { month: string; onGo: (t: Tab) => void }) {
  const { data: overview, error, loading, retry } = useApi<Overview>(`/api/overview?month=${month}`);
  const { data: attention } = useApi<Attention>("/api/attention");
  const { data: accountsData } = useApi<AccountsResponse>("/api/accounts");

  const current = currentMonthLocal();

  return (
    <div className="space-y-7">
      {loading || !overview ? (
        error ? (
          <FetchError onRetry={retry} label="Couldn't load this month." />
        ) : (
          <Hero overview={null} isCurrent={month === current} loading />
        )
      ) : (
        <Hero overview={overview} isCurrent={month === current} onAssign={() => onGo("pots")} />
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
    for (const a of attention.unreconciledAccounts) {
      items.push({ label: `${a.name} not reconciled yet`, tab: "accounts" });
    }
    if (attention.unsettledSharedCents > 0) {
      const names = attention.sharedOwedBy;
      items.push({
        label:
          names.length === 1 ? (
            // The per-contact line is the NET owed (gross minus credit), same
            // convention as the contact card headline.
            <>{names[0].name} owes <span className="t-nums font-medium">{money(names[0].netCents)}</span></>
          ) : (
            <><span className="t-nums font-medium">{money(attention.unsettledSharedCents)}</span> in shared balances owed</>
          ),
        tab: "sharing",
      });
    }
    // Ready to assign is deliberately not listed here: it lives on the hero
    // line above, with its own Assign action, so it is not said twice.
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
                <span aria-hidden className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--warning)]" />
                {/* One flex item for the whole label: otherwise each text and
                    amount fragment becomes its own item and picks up the gap. */}
                <span className="min-w-0">{it.label}</span>
              </span>
              <span aria-hidden className="ml-auto pl-3 text-[17px] text-[var(--muted)]">›</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
