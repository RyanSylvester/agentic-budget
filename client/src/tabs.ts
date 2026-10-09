/* Tab ids, labels and URL routing (?tab=pots). Kept free of React so
 * tests can import it without pulling in the app. */

export type Tab = "overview" | "pots" | "transactions" | "sharing" | "accounts" | "settings";

export const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "pots", label: "Pots" },
  { id: "transactions", label: "Transactions" },
  { id: "sharing", label: "Sharing" },
  { id: "accounts", label: "Accounts" },
  { id: "settings", label: "Settings" },
];

export const tabLabel = (id: Tab) => TABS.find((t) => t.id === id)?.label ?? id;

export const TAB_IDS: Tab[] = TABS.map((t) => t.id);

/* Read the initial tab from the URL (?tab=pots). Missing or unknown values
 * fall back to overview, so a bare URL always opens on the home tab. */
export function tabFromUrl(search: string = window.location.search): Tab {
  const raw = new URLSearchParams(search).get("tab");
  return TAB_IDS.includes(raw as Tab) ? (raw as Tab) : "overview";
}
