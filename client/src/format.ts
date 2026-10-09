import { moneyGrouped } from "./money";

/* ---------- helpers ---------- */

// One money format everywhere: grouped thousands, true minus sign.
export const money = moneyGrouped;

export const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
export const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};
export const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
export const shortMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS_SHORT[m - 1]} ${y}`;
};

// "JOINT LIVING" -> "Joint Living" for serif section headers.
export const titleCase = (s: string) =>
  s.split(" ").map((w) => (w === "&" ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(" ");

export function shiftMonth(ym: string, delta: number) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// "2026-09-28" -> "Today" / "Yesterday" / "Sep 26". No raw ISO dates in the UI.
export function fmtDate(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(new Date()) - startOf(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
}

// "2026-09" -> "Sep '26" for chart axes.
export function trendLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return `${MONTHS[m - 1].slice(0, 3)} '${String(y).slice(2)}`;
}

