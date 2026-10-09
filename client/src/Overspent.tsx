import { money } from "./format";
import type { Pot } from "./types";
import { Sheet } from "./ui";

/* ---------- overspending ---------- */

// A pot is overspent when its available balance (assigned minus spent) is
// below zero. Only spending pots count: income pots are never assigned to.

/** Available balance for a pot this month. */
export const availableCents = (p: Pot) => p.assignedCents - p.spentCents;

/** True for a spending pot whose available balance is negative. */
export const isOverspent = (p: Pot) => p.assignable && availableCents(p) < 0;

/** The month's overspent pots, how many, and the total overspend (positive). */
export function overspentSummary(pots: Pot[]) {
  const over = pots.filter(isOverspent);
  return { pots: over, count: over.length, cents: over.reduce((a, p) => a - availableCents(p), 0) };
}

/** "2 pots overspent · $84.10", in the danger colour. */
export function overspentLabel(count: number, cents: number) {
  return `${count} ${count === 1 ? "pot" : "pots"} overspent · ${money(cents)}`;
}

/** The overspent summary line: a button with a trailing action word. */
export function OverspentLine({ count, cents, action, onClick, className = "" }: {
  count: number;
  cents: number;
  /** Trailing action word, e.g. "Show" or "Cover". */
  action: string;
  onClick: () => void;
  className?: string;
}) {
  if (count === 0) return null;
  return (
    <button
      onClick={onClick}
      className={`inline-flex min-h-11 items-center gap-1 rounded-[var(--r-pill)] bg-[var(--danger-soft)] pl-4 pr-3 text-left text-md transition active:scale-[0.98] ${className}`}
    >
      <span className="t-nums font-medium text-[var(--danger)]">{overspentLabel(count, cents)}</span>
      <span className="ml-2 shrink-0 font-medium text-[var(--danger)]">
        {action} <span aria-hidden>→</span>
      </span>
    </button>
  );
}

/** Bring the first overspent row in the budget table into view, flash it,
 *  and put focus on its Cover button. */
export function revealFirstOverspent() {
  const row = document.querySelector<HTMLElement>("#budget-table [data-overspent]");
  if (!row) {
    document.getElementById("budget-table")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.querySelector<HTMLButtonElement>("button[data-cover]")?.focus({ preventScroll: true });
  const soft = getComputedStyle(row).getPropertyValue("--danger-soft").trim();
  if (soft && typeof row.animate === "function") {
    row.animate([{ backgroundColor: soft }, { backgroundColor: soft, offset: 0.6 }, { backgroundColor: "transparent" }], {
      duration: 1800,
      easing: "ease-out",
    });
  }
}

/** A place money can come from to cover an overspent pot: another pot with
 *  money left this month, or Ready to Assign (potId null). */
export interface CoverSource {
  potId: number | null;
  name: string;
  availableCents: number;
}

/** Sources with a positive balance this month: Ready to Assign first when
 *  it has money, then pots with the most left first. */
export function coverSources(target: Pot, pots: Pot[], rtaCents: number): CoverSource[] {
  const out: CoverSource[] = [];
  if (rtaCents > 0) out.push({ potId: null, name: "Ready to assign", availableCents: rtaCents });
  const ps = pots
    .filter((p) => p.assignable && p.id !== target.id && availableCents(p) > 0)
    .sort((a, b) => availableCents(b) - availableCents(a));
  for (const p of ps) out.push({ potId: p.id, name: p.name, availableCents: availableCents(p) });
  return out;
}

/** "Cover $X from…": pick where the money comes from. Each choice moves
 *  min(overspend, source available), so a source is never pushed below zero. */
export function CoverSheet({ pot, pots, rtaCents, onClose, onCover }: {
  pot: Pot;
  pots: Pot[];
  rtaCents: number;
  onClose: () => void;
  onCover: (source: CoverSource, cents: number) => void;
}) {
  const over = -availableCents(pot);
  const sources = coverSources(pot, pots, rtaCents);
  return (
    <Sheet label={`Cover ${pot.name}`} onClose={onClose}>
      <div className="text-lg font-semibold">Cover {pot.name}</div>
      <p className="t-nums mt-1 text-md text-[var(--ink-2)]">
        {pot.name} is <span className="font-medium text-[var(--danger)]">{money(over)}</span> over. Pick where the money
        comes from.
      </p>
      {sources.length === 0 ? (
        <p className="mt-4 rounded-[var(--r-md)] bg-[var(--bg-sunken)] px-3 py-3 text-md text-[var(--ink-2)]">
          No pot has money left this month. Lower an Assigned amount, or assign more income first.
        </p>
      ) : (
        <ul className="-mx-2 mt-3">
          {sources.map((s) => {
            const move = Math.min(over, s.availableCents);
            return (
              <li key={s.potId ?? "rta"} className="border-b border-[var(--hairline)] last:border-0">
                <button
                  onClick={() => onCover(s, move)}
                  className="flex min-h-11 w-full items-center justify-between gap-3 rounded-[var(--r-md)] px-2 py-2.5 text-left transition hover:bg-[var(--bg-sunken)] active:scale-[0.99]"
                >
                  <span className="min-w-0">
                    <span className={`block truncate text-md ${s.potId === null ? "font-medium" : ""}`}>{s.name}</span>
                    <span className="t-nums block text-sm text-[var(--muted)]">
                      <span className="text-[var(--success)]">{money(s.availableCents)}</span> available
                    </span>
                  </span>
                  <span className="t-nums shrink-0 text-right text-md font-medium text-[var(--ink)]">
                    Move {money(move)}
                    {move < over && <span className="block text-xs font-normal text-[var(--muted)]">covers part</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <button onClick={onClose} className="btn-ghost mt-4 w-full px-4 py-2.5 text-md">
        Cancel
      </button>
    </Sheet>
  );
}

/** After a cover: what moved, with Undo for a few seconds. */
export function CoverToast({ text, error, onUndo, onDismiss }: {
  text: string;
  error?: string | null;
  onUndo?: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+5rem)] z-20 mx-auto max-w-md rounded-[var(--r-md)] bg-[var(--ink)] px-4 py-3 text-md text-[var(--bg)] md:bottom-6"
      style={{ boxShadow: "var(--shadow-elev)" }}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="t-nums min-w-0">{error ?? text}</span>
        {onUndo && !error ? (
          <button onClick={onUndo} className="min-h-9 shrink-0 font-medium underline underline-offset-4 transition hover:opacity-80 active:scale-95">
            Undo
          </button>
        ) : (
          <button onClick={onDismiss} className="min-h-9 shrink-0 font-medium opacity-80 transition hover:opacity-100">
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
