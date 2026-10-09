import { useRef, useState } from "react";
import { MoneyInput } from "./MoneyInput";
import { useApi, send } from "./api";
import { fmtDate, money } from "./format";
import { expressionToCents } from "./money";
import type { Account, AccountsResponse, ContactBalance, ContactLedger, ContactsResponse, SettlementSummary } from "./types";
import { FetchError, Skeleton, TxnBadge } from "./ui";

/* ---------- contact ledger ---------- */

/* What makes up a contact's balance: each shared transaction with their
 *  share (and what is still unpaid of it), and each settlement either way.
 *  Fetched only once the card is expanded. */
export function ContactLedgerList({ contactId }: { contactId: number }) {
  const { data, error, loading, retry } = useApi<ContactLedger>(`/api/contacts/${contactId}/ledger`);
  if (loading) {
    return (
      <div className="mt-3 space-y-2">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="mt-3 text-sm text-[var(--danger)]">
        Couldn't load the details.{" "}
        <button onClick={retry} className="font-medium underline underline-offset-4">Try again</button>
      </div>
    );
  }
  if (data.entries.length === 0) {
    return <p className="mt-3 text-sm italic text-[var(--muted)]">Nothing shared yet.</p>;
  }
  return (
    <ul className="mt-2">
      {data.entries.map((e) => (
        <li
          key={e.kind === "share" ? `s${e.transactionId}` : `p${e.settlementId}`}
          className="flex items-start justify-between gap-3 border-b border-[var(--hairline)] py-2.5 last:border-0"
        >
          <div className="min-w-0">
            <div className="truncate text-md">{e.description}</div>
            <div className="mt-0.5 text-sm text-[var(--muted)]">
              {fmtDate(e.date)}
              {e.kind === "share"
                ? ` · ${e.potName ?? "(no pot)"}`
                : e.amountCents > 0
                  ? ` · they paid you, into ${e.accountName}`
                  : ` · you paid them, from ${e.accountName}`}
            </div>
          </div>
          <div className="shrink-0 text-right">
            {e.kind === "share" ? (
              <>
                <div className="t-nums text-md">{money(e.shareCents)}</div>
                <div className={`mt-0.5 text-xs ${e.outstandingCents > 0 ? "text-[var(--ink-2)]" : "text-[var(--muted)]"}`}>
                  {e.outstandingCents === 0
                    ? "paid"
                    : e.outstandingCents === e.shareCents
                      ? "unpaid"
                      : <span className="t-nums">{money(e.outstandingCents)} unpaid</span>}
                </div>
              </>
            ) : (
              <>
                <div className={`t-nums text-md ${e.amountCents > 0 ? "font-medium text-[var(--success)]" : ""}`}>
                  {money(e.amountCents)}
                </div>
                <div className="mt-0.5 text-xs text-[var(--muted)]">settle-up</div>
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ---------- contact balance ---------- */

/* One contact's shared balance: the net, what it is made of (by pot, and
 *  the full ledger behind an expander), and the settle-up flow in whichever
 *  direction the balance runs. Accounts are passed down so each card doesn't
 *  refetch them; the balance itself refreshes through the shared cache after
 *  every write. */
export function ContactCard({ contact, accounts, initialExpanded = false }: {
  contact: ContactBalance;
  accounts: Account[];
  /** Storybook only: render with the ledger already open. */
  initialExpanded?: boolean;
}) {
  // The headline is the NET balance: gross owed minus credit. A ledger
  // written off to zero (gross and credit equal) is settled, not owed.
  const netCents = contact.totalOwedCents - contact.creditCents;
  const settled = netCents === 0;
  // Money comes in when they owe you, goes out when you owe them.
  const direction = netCents < 0 ? "paid" : "received";

  // null = follow the balance: the field offers the full net amount.
  const [amountText, setAmountText] = useState<string | null>(null);
  const amount = amountText ?? (settled ? "" : (Math.abs(netCents) / 100).toFixed(2));
  const defaultAccount = accounts.find((a) => a.type === "chequing") ?? accounts[0] ?? null;
  const [accountId, setAccountId] = useState<string>("");
  const account = accounts.find((a) => String(a.id) === accountId) ?? defaultAccount;
  const [busy, setBusy] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);
  const [last, setLast] = useState<SettlementSummary | null>(null);
  const [undone, setUndone] = useState(false);
  const [expanded, setExpanded] = useState(initialExpanded);

  const cents = expressionToCents(amount);
  const valid = cents !== null && cents > 0;

  const settle = async () => {
    if (!valid || busy || !account) return;
    setBusy(true);
    setSettleError(null);
    setUndone(false);
    try {
      const r = await send("/api/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId: contact.id,
          accountId: account.id,
          amountCents: cents,
          direction,
          note: direction === "paid" ? `Paid ${contact.name}` : `${contact.name} settlement`,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setLast((await r.json()) as SettlementSummary);
      setAmountText(null);
    } catch {
      setSettleError("Couldn't record that. Try again.");
    }
    setBusy(false);
  };

  const undo = async () => {
    if (!last || busy) return;
    setBusy(true);
    setSettleError(null);
    try {
      const r = await send(`/api/settlements/${last.settlementId}/undo`, { method: "POST" });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        throw new Error(
          /undo that one first/.test(j?.error ?? "")
            ? "A later payment depends on this one. Undo that one first."
            : /reconciled/.test(j?.error ?? "")
              ? "This payment is reconciled now, so it can't be undone."
              : "Couldn't undo that. Try again."
        );
      }
      setLast(null);
      setUndone(true);
    } catch (e) {
      setSettleError(e instanceof Error ? e.message : "Couldn't undo that. Try again.");
    }
    setBusy(false);
  };

  return (
    <div className={`card p-5 ${contact.archived ? "opacity-80" : ""}`}>
      <div className="flex items-center gap-2">
        <div className="text-lg font-semibold">{contact.name}</div>
        {contact.archived && <TxnBadge>Archived</TxnBadge>}
      </div>
      <div className="text-sm text-[var(--muted)]">
        {settled ? "Settled up" : netCents > 0 ? "owes you" : "you owe"}
      </div>
      <div className="t-nums mt-1.5 text-figure font-light tracking-tight">
        {settled ? "$0.00" : money(Math.abs(netCents))}
      </div>
      {contact.totalOwedCents > 0 && (
        <>
          {contact.oldest && <div className="mt-1 text-sm text-[var(--muted)]">oldest since {fmtDate(contact.oldest)}</div>}
          <ul className="mt-3 space-y-1">
            {contact.byPot.map((b) => (
              <li key={b.pot} className="flex items-center justify-between text-md">
                <span className="text-[var(--ink-2)]">{b.pot}</span>
                <span className="t-nums">{money(b.cents)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {contact.creditCents > 0 && (
        <div className="mt-2 text-sm font-medium text-[var(--success)]">{money(contact.creditCents)} credit from overpayment</div>
      )}

      <button
        onClick={() => setExpanded((x) => !x)}
        aria-expanded={expanded}
        className="-mx-1 mt-3 inline-flex min-h-11 items-center gap-1.5 px-1 text-sm font-medium text-[var(--ink-2)] transition hover:text-[var(--ink)]"
      >
        <span aria-hidden className={`inline-block transition ${expanded ? "rotate-90" : ""}`}>›</span>
        {expanded ? "Hide details" : "How this adds up"}
      </button>
      {expanded && <ContactLedgerList contactId={contact.id} />}

      {!contact.archived && (
        <div className="mt-4 border-t border-[var(--hairline)] pt-4">
          <div className="mb-2 text-sm font-medium text-[var(--ink-2)]">
            {settled ? "Record a payment" : direction === "paid" ? `You paid ${contact.name}` : `${contact.name} paid you`}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <MoneyInput
              placeholder="Amount"
              ariaLabel={direction === "paid" ? `Amount you paid ${contact.name}` : `Amount ${contact.name} paid you`}
              value={amount}
              onChange={setAmountText}
              onKeyDown={(e) => {
                if (e.key === "Enter") settle();
              }}
              className="w-32 py-2 text-md"
            />
            <select
              value={account ? String(account.id) : ""}
              onChange={(e) => setAccountId(e.target.value)}
              aria-label={direction === "paid" ? "Paid from account" : "Paid into account"}
              disabled={accounts.length === 0}
              className="field min-w-0 max-w-[200px] px-3 py-2 text-md"
            >
              {accounts.length === 0 && <option value="">Loading accounts…</option>}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <button onClick={settle} disabled={busy || !account || !valid} className="btn-ink px-4 py-2 text-md">
              {busy && !last ? "Saving…" : valid ? `Mark ${money(cents)} paid` : "Mark paid"}
            </button>
          </div>
          <div className="mt-1.5 text-sm text-[var(--muted)]">
            {direction === "paid" ? "Recorded as money out of" : "Recorded as money into"} {account?.name ?? "an account"}
          </div>
          {settleError && <div role="alert" className="mt-1.5 text-sm text-[var(--danger)]">{settleError}</div>}
        </div>
      )}

      {last && (
        <div role="status" className="mt-3 rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-4 text-md">
          <div className="flex items-center justify-between gap-3">
            <span className="font-semibold">
              Marked <span className="t-nums">{money(last.amountCents)}</span> paid
            </span>
            <button
              onClick={undo}
              disabled={busy}
              className="shrink-0 font-medium underline decoration-[var(--hairline-strong)] underline-offset-4 transition hover:opacity-80 active:scale-95"
            >
              {busy ? "Undoing…" : "Undo"}
            </button>
          </div>
          {last.allocations.length > 0 && (
            <ul className="mt-1.5 space-y-1 text-sm">
              {last.allocations.map((a, i) => (
                <li key={i} className="flex items-center justify-between">
                  <span className="text-[var(--ink-2)]">{a.potName ?? "(no pot)"}</span>
                  <span className="t-nums">{money(a.amountCents)}</span>
                </li>
              ))}
            </ul>
          )}
          {last.direction === "paid" && last.creditConsumedCents > 0 && (
            <div className="mt-1.5 text-sm text-[var(--ink-2)]">{money(last.creditConsumedCents)} of their credit paid back</div>
          )}
          {last.leftoverCents > 0 && (
            <div className="mt-1.5 text-sm font-medium text-[var(--success)]">{money(last.leftoverCents)} kept as credit</div>
          )}
        </div>
      )}
      {undone && <div role="status" className="mt-3 text-sm text-[var(--muted)]">Payment undone.</div>}
    </div>
  );
}

/* Manage the people you share expenses with: add, rename inline, archive.
 *  Archiving hides a contact but keeps their history; it is refused while
 *  they still have an open balance. */
export function ContactsManager({ contacts, onChanged }: { contacts: ContactBalance[]; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const savingRef = useRef(false);

  const add = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await send("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      setName("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add that contact.");
    }
    setBusy(false);
  };

  const rename = async (id: number) => {
    const n = editName.trim();
    if (!n || busy || savingRef.current) return;
    savingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await send(`/api/contacts/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      setEditingId(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't rename that contact.");
    }
    setBusy(false);
    savingRef.current = false;
  };

  const setArchived = async (id: number, archived: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await send(`/api/contacts/${id}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : archived ? "Couldn't archive that contact." : "Couldn't restore that contact.");
    }
    setBusy(false);
  };

  return (
    <div className="card mb-5 p-5">
      <div className="text-lg font-semibold">Contacts</div>
      <div className="mt-1 text-sm text-[var(--muted)]">People you share expenses with. Pots can each be shared with one of them.</div>
      <ul className="mt-3 space-y-2">
        {contacts.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3">
            {editingId === c.id ? (
              <input
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") rename(c.id);
                  if (e.key === "Escape") setEditingId(null);
                }}
                onBlur={() => { if (editingId === c.id) rename(c.id); }}
                aria-label="Contact name"
                className="field t-nums flex-1 px-2 py-1.5 text-md"
              />
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <button
                  onClick={() => { setEditingId(c.id); setEditName(c.name); }}
                  className={`min-w-0 cursor-pointer truncate text-left text-md font-medium hover:underline ${c.archived ? "text-[var(--muted)]" : ""}`}
                  title="Rename"
                >
                  {c.name}
                </button>
                {c.archived && <TxnBadge>Archived</TxnBadge>}
              </span>
            )}
            <button
              onClick={() => setArchived(c.id, !c.archived)}
              disabled={busy}
              aria-label={`${c.archived ? "Restore" : "Archive"} ${c.name}`}
              className="-my-2 -mr-2 min-h-11 cursor-pointer px-2 text-sm text-[var(--muted)] hover:text-[var(--ink)]"
            >
              {c.archived ? "Restore" : "Archive"}
            </button>
          </li>
        ))}
      </ul>
      {contacts.length === 0 && (
        <div className="mt-3 text-sm italic text-[var(--muted)]">No contacts yet. Add one to start splitting expenses.</div>
      )}
      <div className="mt-3 flex gap-2">
        <input
          type="text"
          placeholder="New contact name"
          aria-label="New contact name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          className="field t-nums w-44 px-3 py-2 text-md"
        />
        <button onClick={add} disabled={busy || !name.trim()} className="btn-ink px-4 py-2 text-md">
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
      {error && <div role="alert" className="mt-2 text-sm text-[var(--danger)]">{error}</div>}
    </div>
  );
}

export function SharingTab() {
  // Archived contacts come along so the toggle needs no second fetch.
  const { data, error, loading, retry } = useApi<ContactsResponse>("/api/contacts?archived=1");
  const { data: accountsData } = useApi<AccountsResponse>("/api/accounts");
  const [showArchived, setShowArchived] = useState(false);
  const all = data?.contacts ?? [];
  const archivedCount = all.filter((c) => c.archived).length;
  const contacts = showArchived ? all : all.filter((c) => !c.archived);
  const accounts = accountsData?.accounts ?? [];

  return (
    <div className="mx-auto max-w-[720px]">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="font-serif-d text-xl font-medium">Sharing</div>
        {archivedCount > 0 && (
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-[var(--ink-2)]">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="h-4 w-4 shrink-0 accent-[var(--accent)]"
            />
            Show archived ({archivedCount})
          </label>
        )}
      </div>
      {loading ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="card space-y-3 p-5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-9 w-44" />
            </div>
          ))}
        </div>
      ) : error ? (
        <FetchError onRetry={retry} label="Couldn't load sharing." />
      ) : (
        <>
          <ContactsManager contacts={contacts} onChanged={retry} />
          {contacts.map((c) => (
            <div key={c.id} className="mb-5">
              <ContactCard contact={c} accounts={accounts} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
