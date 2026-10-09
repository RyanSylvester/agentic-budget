import { useEffect, useState } from "react";
import { MoneyInput } from "./MoneyInput";
import { money, shortMonth, titleCase } from "./format";
import { expressionToCents, moneyGrouped, shareLabel } from "./money";
import type { AssignHistory, Pot } from "./types";

/* ---------- budget table ---------- */

// Inline assign control: the Assigned cell is the button. Click to edit,
// Enter commits, Escape or click-away cancels. The control is never hidden.
// Idle and editing states share an identical box (w-24, same padding and
// border width) so toggling never shifts the surrounding layout.
// purpose="planned" relabels the control for income pots, where the value
// means planned income rather than a budget allocation.
export function AssignCell({ pot, month, onAssigned, purpose = "assign" }: { pot: Pot; month: string; onAssigned: () => void; purpose?: "assign" | "planned" }) {
  const [editing, setEditing] = useState(false);
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [hist, setHist] = useState<AssignHistory | null>(null);

  // Fetch last-month / 3-month-average assignments when the editor opens,
  // for the quick-fill buttons. One cheap GROUP BY query.
  useEffect(() => {
    if (!editing) return;
    setHist(null);
    fetch(`/api/pots/${pot.id}/assign-history?month=${month}`)
      .then((r) => (r.ok ? (r.json() as Promise<AssignHistory>) : null))
      .then((h) => {
        if (h) setHist(h);
      })
      .catch(() => {});
  }, [editing, pot.id, month]);

  const commit = async () => {
    const cents = expressionToCents(amt);
    if (cents === null || busy) {
      if (!busy) setFailed("Enter a number, or math like 25+30.");
      return;
    }
    setBusy(true);
    setFailed(null);
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
      setFailed("Couldn't save.");
    }
    setBusy(false);
  };

  if (!editing) {
    return (
      <button
        onClick={() => {
          setAmt(((pot.assignedCents) / 100).toFixed(2));
          setEditing(true);
        }}
        title={purpose === "planned" ? `Set planned income for ${pot.name}` : `Assign to ${pot.name}`}
        className="t-nums w-24 rounded-[var(--r-sm)] border border-transparent px-2 py-1.5 text-left text-[15px] text-[var(--ink)] underline decoration-[var(--hairline-strong)] decoration-dotted underline-offset-4 transition hover:bg-[var(--surface)] active:scale-95"
      >
        {money(pot.assignedCents)}
      </button>
    );
  }
  const showQuick = hist !== null && (hist.lastMonth.cents > 0 || hist.avg3moCents > 0);
  return (
    <span className="inline-flex flex-col items-start gap-1.5">
      <span className="inline-flex items-center gap-2">
        <MoneyInput
          autoFocus
          ariaLabel={purpose === "planned" ? `Planned income for ${pot.name}` : `Assign money to ${pot.name}`}
          value={amt}
          onChange={(v) => {
            setAmt(v);
            setFailed(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setEditing(false);
              setFailed(null);
            }
          }}
          onBlur={() => {
            if (!busy) {
              setEditing(false);
              setFailed(null);
            }
          }}
          className="w-24 py-1.5 text-[15px]"
        />
        {failed && <span className="text-[13px] text-[var(--danger)]">{failed}</span>}
      </span>
      {showQuick && (
        <span className="flex gap-1.5">
          <button
            type="button"
            onClick={() => setAmt((hist.lastMonth.cents / 100).toFixed(2))}
            className="t-nums rounded-full border border-[var(--hairline-strong)] px-2 py-0.5 text-[12px] text-[var(--ink-2)] transition hover:bg-[var(--bg-sunken)] active:scale-95"
          >
            Last month · {money(hist.lastMonth.cents)}
          </button>
          <button
            type="button"
            onClick={() => setAmt((hist.avg3moCents / 100).toFixed(2))}
            className="t-nums rounded-full border border-[var(--hairline-strong)] px-2 py-0.5 text-[12px] text-[var(--ink-2)] transition hover:bg-[var(--bg-sunken)] active:scale-95"
          >
            3-mo avg · {money(hist.avg3moCents)}
          </button>
        </span>
      )}
    </span>
  );
}

// Split tag: a small pill after the spent amount. Reads "split 50/50" for
// even splits, "{name} {pct}%" for other configured shares, or "Shared" when
// no share config exists. Same component, same size.
export function SplitTag({ p }: { p: Pot }) {
  if (p.sharedCents <= 0) return null;
  const label =
    p.sharePct == null ? "Shared"
    : p.sharePct === 50 ? "split 50/50"
    : `${p.contactName ?? "Shared"} ${p.sharePct}%`;
  return (
    <span className="t-nums ml-2 inline-flex items-center rounded-[var(--r-pill)] border border-transparent bg-[var(--accent-soft)] px-2 py-0.5 align-middle text-[11px] font-medium text-[var(--accent)]">
      {label}
    </span>
  );
}

// Available = assigned minus spent. Green when positive, warm red only
// when overspent, muted at exactly zero.
export function Available({ assignedCents, spentCents, className = "" }: { assignedCents: number; spentCents: number; className?: string }) {
  const avail = assignedCents - spentCents;
  const color = avail > 0 ? "var(--success)" : avail < 0 ? "var(--danger)" : "var(--muted)";
  return (
    <span className={`t-nums font-medium ${className}`} style={{ color }}>
      {money(avail)}
    </span>
  );
}

export function PotNameCell({ p, onEdit }: { p: Pot; onEdit?: () => void }) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-2">
        <div className="truncate text-[15px] font-semibold">{p.name}</div>
        {onEdit && (
          <button onClick={onEdit} className="-m-2 shrink-0 cursor-pointer p-2 text-[12px] text-[var(--faint)] hover:text-[var(--ink)] hover:underline">
            Edit
          </button>
        )}
      </div>
      {p.sinking && <SinkingLine sinking={p.sinking} />}
    </div>
  );
}

/** The sinking-schedule readout on a pot row: a slim progress bar plus one
 *  line that tells the full story. Funding shows saved-of-expected, the
 *  monthly pace, months left, and the due month; funded is green with the
 *  bill covered; overdue is red with what is still needed. */
export function SinkingLine({ sinking }: { sinking: NonNullable<Pot["sinking"]> }) {
  const pct = sinking.expectedCents > 0 ? Math.min(100, (sinking.balanceCents / sinking.expectedCents) * 100) : 0;
  const fillColor =
    sinking.state === "funded" ? "var(--success)" : sinking.state === "overdue" ? "var(--danger)" : "var(--ink)";
  const monthsLabel = sinking.monthsLeft === 1 ? "1 mo left" : `${sinking.monthsLeft} mo left`;
  const line =
    sinking.state === "funded"
      ? `Funded · ${money(sinking.expectedCents)} ready for ${shortMonth(sinking.dueMonth)}`
      : sinking.state === "overdue"
        ? `Overdue · ${money(sinking.remainingCents)} still needed · due ${shortMonth(sinking.dueMonth)}`
        : `${money(sinking.balanceCents)} of ${money(sinking.expectedCents)} · ${money(sinking.contributionCents)}/mo · ${monthsLabel} · due ${shortMonth(sinking.dueMonth)}`;
  const lineColor =
    sinking.state === "funded" ? "var(--success)" : sinking.state === "overdue" ? "var(--danger)" : "var(--muted)";
  return (
    <div className="mt-1">
      <div
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Sinking fund progress: ${line}`}
        className="h-[5px] w-full overflow-hidden rounded-full bg-[var(--bg-sunken)]"
      >
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: fillColor }} />
      </div>
      <div className="mt-0.5 text-[12px] font-medium" style={{ color: lineColor }}>
        {line}
      </div>
    </div>
  );
}

export function BudgetTable({ pots, month, onAssigned, onEditPot }: { pots: Pot[]; month: string; onAssigned: () => void; onEditPot?: (pot: Pot) => void }) {
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
  // Share-of-assigned percentages in group headers use earners only, matching
  // the grouping above; income pots never count toward the total.
  const totalAssigned = sum(earners, (p) => p.assignedCents);

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
        const assigned = sum(g.pots, (p) => p.assignedCents);
        const share = shareLabel(assigned, totalAssigned);
        const isOpen = open[g.name] ?? true;
        return (
          <section key={g.name} className="card overflow-hidden">
            {/* Group header. The word "assigned" is intentionally absent from the
              visible UI. The percentage pill is the semantic rescue: no other
              figure on this screen is ever a percentage, so "$X, N%" can only
              read as share-of-assigned. The desktop eyebrow's "Assigned" label
              stays as the visible anchor. Note the stat cluster right-aligns
              over the Available column track, not the Assigned one; accepted
              because the header is a full-width sunken section, visually
              distinct from a table cell, and the pill carries the semantics. */}
            <button
              onClick={() => setOpen((o) => ({ ...o, [g.name]: !isOpen }))}
              aria-expanded={isOpen}
              aria-label={`${titleCase(g.name)}: ${moneyGrouped(assigned)} assigned, ${
                share ? `${share} of total assigned` : "no assigned total yet"
              }. ${isOpen ? "Expanded" : "Collapsed"}.`}
              className="flex w-full items-baseline justify-between gap-3 px-4 py-3 text-left sm:px-5"
            >
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span aria-hidden="true" className="shrink-0 text-[13px] text-[var(--faint)]">{isOpen ? "▾" : "▸"}</span>
                <span className="truncate text-[17px] font-semibold text-[var(--ink)]">{titleCase(g.name)}</span>
              </span>
              <span className="t-nums flex shrink-0 items-baseline gap-2 whitespace-nowrap">
                <span className={`text-[22px] font-semibold ${assigned === 0 ? "text-[var(--muted)]" : "text-[var(--ink)]"}`}>
                  {moneyGrouped(assigned)}
                </span>
                {share !== "" && (
                  <span className="rounded-[var(--r-pill)] border border-[var(--hairline-strong)] px-2 py-0.5 text-[12px] font-semibold text-[var(--ink-2)]">
                    {share}
                  </span>
                )}
              </span>
            </button>
            {isOpen && (
              <div className="px-4 pb-1 sm:px-5">
              {g.pots.map((p) => (
                <div key={p.id} className="border-t border-[var(--hairline)] py-3">
                  {/* narrow screens: name + available up top, assigned/spent below */}
                  <div className="sm:hidden">
                    <div className="flex items-start justify-between gap-3">
                      <PotNameCell p={p} onEdit={onEditPot ? () => onEditPot(p) : undefined} />
                      <Available assignedCents={p.assignedCents} spentCents={p.spentCents} className="shrink-0 pt-0.5" />
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
                    <PotNameCell p={p} onEdit={onEditPot ? () => onEditPot(p) : undefined} />
                    <AssignCell pot={p} month={month} onAssigned={onAssigned} />
                    <span className="t-nums whitespace-nowrap text-[15px]">
                      {money(p.spentCents)}
                      <SplitTag p={p} />
                    </span>
                    <span className="text-right">
                      <Available assignedCents={p.assignedCents} spentCents={p.spentCents} />
                    </span>
                  </div>
                  {/* spent / assigned progress, once per row; sinking pots have their own bar */}
                  {!p.sinking && (() => {
                    const a = p.assignedCents;
                    const over = p.spentCents > a;
                    const pct = over ? 100 : a > 0 ? Math.max(0, Math.min(100, (p.spentCents / a) * 100)) : 0;
                    return (
                      <div
                        className="track mt-2.5"
                        role="progressbar"
                        aria-valuenow={Math.round(pct)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={`${p.name}: ${money(p.spentCents)} of ${money(a)} spent`}
                      >
                        <span className={over ? "over" : undefined} style={{ width: `${pct}%` }} />
                      </div>
                    );
                  })()}
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
          <p className="mb-2 text-[13px] text-[var(--muted)]">Money in. Set planned income when you fill out the month; received shows what has actually landed. Planned income is just your expectation; only actual inflows become ready to assign.</p>
          {income.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 border-b border-[var(--hairline)] py-3">
              <PotNameCell p={p} onEdit={onEditPot ? () => onEditPot(p) : undefined} />
              <div className="flex shrink-0 items-center gap-4">
                <span className="flex items-baseline gap-1.5">
                  <span className="text-[12px] text-[var(--faint)]">planned</span>
                  <AssignCell pot={p} month={month} onAssigned={onAssigned} purpose="planned" />
                </span>
                <span className="t-nums whitespace-nowrap text-[13px] text-[var(--muted)]">
                  <span className="text-[12px] text-[var(--faint)]">received </span>
                  {money(p.receivedCents)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
