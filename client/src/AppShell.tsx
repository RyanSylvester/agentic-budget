import { useEffect, useState } from "react";
import { AccountsView } from "./AccountsTab";
import { OverviewTab } from "./OverviewTab";
import { PotsTab } from "./PotsTab";
import { SettingsTab } from "./SettingsTab";
import { SharingTab } from "./SharingTab";
import { TransactionsTab } from "./TransactionsTab";
import { useApi } from "./api";
import { TABS, type Tab, tabFromUrl, tabLabel } from "./tabs";
import { Attention } from "./types";
import { MonthNav } from "./ui";

/* ---------- app ---------- */

export const MONTH_TABS: Tab[] = ["overview", "pots", "transactions"];

/* Icon-only mobile tab bar: one clean inline SVG per tab, no icon library.
 * Selected renders in dark ink, inactive in muted grey. */
export function TabIcon({ id }: { id: Tab }) {
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
