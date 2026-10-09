/* Pure helpers behind the Transactions list: day headers, amount search and
 * the user's share of a split. Kept free of React so tests can import them. */

import type { ListedTransaction } from "./types";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Header for one day of the list: "Today", "Yesterday", "Mon, Sep 22".
 *  Dates are local calendar days, like fmtDate. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  const label = `${DAYS[d.getDay()]}, ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? label : `${label}, ${d.getFullYear()}`;
}

/** The user's own part of a transaction: the amount minus the contact's
 *  share. Equal to the amount when nothing is split, 0 for a settlement
 *  (wholly the contact's money). */
export function userShareCents(t: Pick<ListedTransaction, "amountCents" | "sharedCents">): number {
  return t.amountCents + t.sharedCents;
}

/** Read a search query as an amount: "12.5", "$12.50", "-12.50", "1,200".
 *  Returns null for anything that is not a plain number. `whole` is true
 *  when no decimal point was typed, so "12" can match $12.00 to $12.99. */
export function parseAmountQuery(q: string): { cents: number; whole: boolean } | null {
  const s = q.trim().replace(/^[-−+]/, "").replace(/^\$/, "").replace(/,/g, "");
  if (!/^(\d+\.?\d{0,2}|\.\d{1,2})$/.test(s)) return null;
  return { cents: Math.round(parseFloat(s) * 100), whole: !s.includes(".") };
}

/** Does a transaction match the search box? Text matches description, pot
 *  and account; a numeric query also matches the amount or the user's share. */
export function matchesQuery(t: ListedTransaction, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (`${t.description} ${t.potName ?? ""} ${t.accountName}`.toLowerCase().includes(q)) return true;
  const amt = parseAmountQuery(q);
  if (!amt) return false;
  return [Math.abs(t.amountCents), Math.abs(userShareCents(t))].some((c) =>
    amt.whole ? Math.floor(c / 100) === amt.cents / 100 : c === amt.cents
  );
}

/** Consecutive rows grouped by date, keeping the list's order. */
export function groupByDay<T extends { date: string }>(rows: T[]): { date: string; rows: T[] }[] {
  const out: { date: string; rows: T[] }[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.date === r.date) last.rows.push(r);
    else out.push({ date: r.date, rows: [r] });
  }
  return out;
}

/* Opening a transaction from another tab: the caller records the id and
 * switches to Transactions, which opens that row's sheet once its list has
 * loaded. Plain module state; nothing lands in the URL or history. */
let pendingOpen: number | null = null;

export function requestOpenTransaction(id: number): void {
  pendingOpen = id;
}

export function takePendingTransaction(): number | null {
  const id = pendingOpen;
  pendingOpen = null;
  return id;
}
