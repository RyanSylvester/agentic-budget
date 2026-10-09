import { useApi } from "./api";
import { type Tab } from "./tabs";
import type { AccountsResponse, Overview, PotsResponse } from "./types";
import { Eyebrow } from "./ui";

/* ---------- first-run checklist ---------- */

/* A new user lands on an empty Overview with nothing to record against.
 * Until they have at least one account and one pot, this card sits at the
 * top of Overview and walks them through the three steps that make the rest
 * of Daybook work. Each step ticks off from data the app already loads
 * (accounts, this month's pots, this month's overview), so no extra request
 * is made just for the card. */

export interface SetupStep {
  title: string;
  detail: string;
  done: boolean;
  /** Where the step's action leads. */
  tab: Tab;
  action: string;
}

/** The three steps, ticked off from what is already loaded. Pure, so the
 *  rules can be read (and storied) without the fetches. */
export function setupSteps({ accounts, pots, overview }: {
  accounts: AccountsResponse["accounts"];
  pots: PotsResponse["pots"];
  overview: Overview | null;
}): SetupStep[] {
  const recorded =
    (overview?.recent.length ?? 0) > 0 ||
    accounts.some((a) => a.workingBalanceCents !== 0 || a.lastReconciledAt !== null);
  return [
    {
      title: "Add your first account",
      detail: "The chequing, savings or credit card your money moves through.",
      done: accounts.length > 0,
      tab: "accounts",
      action: "Add account",
    },
    {
      title: "Create pots or fill the month",
      detail: "The buckets you give every dollar to.",
      done: pots.length > 0 || (overview?.assignedCents ?? 0) > 0,
      tab: "pots",
      action: "Open Pots",
    },
    {
      title: "Record a transaction or connect an agent",
      detail: "Add one by hand, or create an agent token in Settings and let your assistant record for you.",
      done: recorded,
      tab: accounts.length > 0 ? "transactions" : "settings",
      action: accounts.length === 0 ? "Connect an agent" : "Record one",
    },
  ];
}

export function SetupChecklistCard({ steps, onGo }: { steps: SetupStep[]; onGo: (t: Tab) => void }) {
  const doneCount = steps.filter((s) => s.done).length;
  // The first unfinished step is the one to do next; it carries the emphasis.
  const next = steps.findIndex((s) => !s.done);
  return (
    <section aria-labelledby="setup-title" className="card px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <div id="setup-title"><Eyebrow>Get set up</Eyebrow></div>
        <div className="t-nums text-xs text-[var(--muted)]">{doneCount} of {steps.length} done</div>
      </div>
      <ol className="mt-2">
        {steps.map((s, i) => (
          <li key={s.title} className="border-b border-[var(--hairline)] last:border-0">
            <button
              onClick={() => onGo(s.tab)}
              className="-mx-2 flex w-[calc(100%+1rem)] items-start gap-3 rounded-[var(--r-md)] px-2 py-3 text-left transition hover:bg-[var(--bg-sunken)] active:scale-[0.99] active:bg-[var(--bg-sunken)]"
            >
              <span
                aria-hidden
                className={`t-nums mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  s.done
                    ? "bg-[var(--success)] text-[var(--on-accent)]"
                    : i === next
                      ? "bg-[var(--ink)] text-[var(--bg)]"
                      : "border border-[var(--hairline-strong)] text-[var(--muted)]"
                }`}
              >
                {s.done ? "✓" : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-md font-medium ${s.done ? "text-[var(--muted)] line-through" : ""}`}>
                  {s.title}
                  <span className="sr-only">{s.done ? " (done)" : ""}</span>
                </span>
                {!s.done && <span className="mt-0.5 block text-sm text-[var(--muted)]">{s.detail}</span>}
                {i === next && (
                  <span className="mt-1.5 block text-sm font-medium text-[var(--accent)]">{s.action} <span aria-hidden>→</span></span>
                )}
              </span>
              <span aria-hidden className="ml-auto self-center pl-1 text-lg text-[var(--muted)]">›</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Overview's first-run card: shown while the user has no accounts or no
 *  pots, hidden for good once both exist. */
export function SetupChecklist({ month, onGo }: { month: string; onGo: (t: Tab) => void }) {
  const { data: accountsData } = useApi<AccountsResponse>("/api/accounts");
  const { data: potsData } = useApi<PotsResponse>(`/api/pots?month=${month}`);
  const { data: overview } = useApi<Overview>(`/api/overview?month=${month}`);
  // Wait for both lists: an established user should never see it flash.
  if (!accountsData || !potsData) return null;
  const accounts = accountsData.accounts;
  const pots = potsData.pots;
  if (accounts.length > 0 && pots.length > 0) return null;
  return <SetupChecklistCard steps={setupSteps({ accounts, pots, overview })} onGo={onGo} />;
}
