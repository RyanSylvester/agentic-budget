import { useRef, useState } from "react";
import { MoneyInput } from "./MoneyInput";
import { useApi } from "./api";
import { fmtDate, money } from "./format";
import { expressionToCents } from "./money";
import type { Account, AccountsResponse, ContactBalance, ContactsResponse, SettlementSummary } from "./types";
import { FetchError, Skeleton } from "./ui";

/* ---------- contact balance ---------- */

/* One contact's shared balance: what they owe, by pot, plus the settle-up
 *  flow. Accounts are passed down so each card doesn't refetch them. */
export function ContactCard({ contact, accounts }: { contact: ContactBalance; accounts: Account[] }) {
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [settleError, setSettleError] = useState(false);
  const [settledTick, setSettledTick] = useState(0);
  const [last, setLast] = useState<SettlementSummary | null>(null);

  // Re-read this contact's balance after a settlement lands.
  const { data: fresh } = useApi<ContactsResponse>(
    settledTick === 0 ? null : "/api/contacts"
  );
  const info = fresh?.contacts.find((c) => c.id === contact.id) ?? contact;

  // The headline is the NET balance: gross owed minus credit. A ledger
  // written off to zero (gross and credit equal) is settled, not owed.
  const netCents = info.totalOwedCents - info.creditCents;
  const settled = netCents === 0;
  const dest = accounts.find((a) => a.type === "chequing") ?? accounts[0] ?? null;

  const settle = async () => {
    const cents = expressionToCents(amount);
    if (cents === null || cents <= 0 || busy || !dest) return;
    setBusy(true);
    setSettleError(false);
    try {
      const res = await fetch("/api/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: contact.id, accountId: dest.id, amountCents: cents, note: `${contact.name} settlement` }),
      }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<SettlementSummary>;
      });
      setLast(res);
      setAmount("");
      setSettledTick((t) => t + 1);
    } catch {
      setSettleError(true);
    }
    setBusy(false);
  };

  return (
    <div className="card p-5">
      <div className="text-[17px] font-semibold">{contact.name}</div>
      <div className="text-[13px] text-[var(--muted)]">
        {settled ? "Settled up" : netCents > 0 ? "owes you" : "you owe"}
      </div>
      <div className="t-nums mt-1.5 text-[32px] font-light tracking-tight">
        {settled ? "$0.00" : money(Math.abs(netCents))}
      </div>
      {info.totalOwedCents > 0 && (
        <>
          {info.oldest && <div className="mt-1 text-[13px] text-[var(--muted)]">oldest since {fmtDate(info.oldest)}</div>}
          <ul className="mt-3 space-y-1">
            {info.byPot.map((b) => (
              <li key={b.pot} className="flex items-center justify-between text-[15px]">
                <span className="text-[var(--ink-2)]">{b.pot}</span>
                <span className="t-nums">{money(b.cents)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {info.creditCents > 0 && (
        <div className="mt-2 text-[13px] font-medium text-[var(--success)]">{money(info.creditCents)} credit from overpayment</div>
      )}
      <div className="mt-4">
        <div className="mb-2 text-[13px] font-medium text-[var(--ink-2)]">Record a payment</div>
        <div className="flex gap-2">
          <MoneyInput
            placeholder="Amount received"
            ariaLabel="Payment amount received"
            value={amount}
            onChange={setAmount}
            onKeyDown={(e) => {
              if (e.key === "Enter") settle();
            }}
            className="w-44 py-2 text-[15px]"
          />
          <button onClick={settle} disabled={busy || !dest} className="btn-ink px-4 py-2 text-[15px]">
            {busy ? "Settling…" : "Settle up"}
          </button>
        </div>
        <div className="mt-1.5 text-[13px] text-[var(--muted)]">
          {dest ? `Records into ${dest.name}` : "Loading accounts…"}
        </div>
        {settleError && <div className="mt-1.5 text-[13px] text-[var(--danger)]">Couldn't record that. Try again.</div>}
      </div>
      {last && (
        <div className="mt-3 rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-4 text-[15px]">
          <div className="font-semibold">Buckets filled</div>
          <ul className="mt-1.5 space-y-1 text-[13px]">
            {last.allocations.map((a, i) => (
              <li key={i} className="flex items-center justify-between">
                <span className="text-[var(--ink-2)]">{a.potName ?? "(no pot)"}</span>
                <span className="t-nums">{money(a.amountCents)}</span>
              </li>
            ))}
          </ul>
          {last.leftoverCents > 0 && (
            <div className="mt-1.5 text-[13px] font-medium text-[var(--success)]">{money(last.leftoverCents)} kept as credit</div>
          )}
        </div>
      )}
    </div>
  );
}

/* Manage the people you share expenses with: add, rename inline, delete.
 *  Deleting is blocked while a pot or split references the contact. */
export function ContactsManager({ contacts, onChanged }: { contacts: ContactBalance[]; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const savingRef = useRef(false);

  const add = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/contacts", {
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
      const r = await fetch(`/api/contacts/${id}`, {
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

  const remove = async (id: number) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/contacts/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      setConfirmDeleteId(null);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete that contact.");
    }
    setBusy(false);
  };

  return (
    <div className="card mb-5 p-5">
      <div className="text-[17px] font-semibold">Contacts</div>
      <div className="mt-1 text-[13px] text-[var(--muted)]">People you share expenses with. Pots can each be shared with one of them.</div>
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
                className="field t-nums flex-1 px-2 py-1.5 text-[15px]"
              />
            ) : (
              <button
                onClick={() => { setEditingId(c.id); setEditName(c.name); }}
                className="flex-1 cursor-pointer text-left text-[15px] font-medium hover:underline"
                title="Rename"
              >
                {c.name}
              </button>
            )}
            {confirmDeleteId === c.id ? (
              <span className="flex items-center gap-2 text-[13px]">
                <span className="text-[var(--muted)]">Delete?</span>
                <button onClick={() => remove(c.id)} disabled={busy} aria-label={`Yes, delete ${c.name}`} className="-my-2 min-h-11 cursor-pointer px-2 font-medium text-[var(--danger)]">Yes</button>
                <button onClick={() => setConfirmDeleteId(null)} aria-label={`Keep ${c.name}`} className="-my-2 -mr-2 min-h-11 cursor-pointer px-2 text-[var(--ink-2)]">Keep</button>
              </span>
            ) : (
              <button onClick={() => setConfirmDeleteId(c.id)} aria-label={`Delete ${c.name}`} className="-my-2 -mr-2 min-h-11 cursor-pointer px-2 text-[13px] text-[var(--muted)] hover:text-[var(--danger)]">
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
      {contacts.length === 0 && (
        <div className="mt-3 text-[13px] italic text-[var(--muted)]">No contacts yet. Add one to start splitting expenses.</div>
      )}
      <div className="mt-3 flex gap-2">
        <input
          type="text"
          placeholder="New contact name"
          aria-label="New contact name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          className="field t-nums w-44 px-3 py-2 text-[15px]"
        />
        <button onClick={add} disabled={busy || !name.trim()} className="btn-ink px-4 py-2 text-[15px]">
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
      {error && <div className="mt-2 text-[13px] text-[var(--danger)]">{error}</div>}
    </div>
  );
}

export function SharingTab() {
  const { data, error, loading, retry } = useApi<ContactsResponse>("/api/contacts");
  const { data: accountsData } = useApi<AccountsResponse>("/api/accounts");
  const contacts = data?.contacts ?? [];
  const accounts = accountsData?.accounts ?? [];

  return (
    <div>
      <div className="mb-5 font-serif-d text-[24px] font-medium">Sharing</div>
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
