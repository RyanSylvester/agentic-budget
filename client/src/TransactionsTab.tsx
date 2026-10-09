import { useState } from "react";
import { MoneyInput } from "./MoneyInput";
import { useApi } from "./api";
import { fmtDate, money, titleCase } from "./format";
import { expressionToCents } from "./money";
import { Account, ContactBalance, ListedTxn, Pot } from "./types";
import { FetchError, FormLabel, Segmented, Sheet, Skeleton, TxnBadge } from "./ui";

/* ---------- transaction add/edit sheet ---------- */

// Add/edit form for one transaction. txn === null means "add". Renders inside
// a Sheet; the parent refetches on onSaved. All inputs keep a fixed size so
// focusing never shifts the layout.
export function TransactionSheet({ txn, pots, accounts, onClose, onSaved }: {
  txn: ListedTxn | null;
  pots: Pot[];
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = txn !== null;
  const [description, setDescription] = useState(txn?.description ?? "");
  const [amount, setAmount] = useState(txn ? (Math.abs(txn.amountCents) / 100).toFixed(2) : "");
  const [direction, setDirection] = useState<"out" | "in">(txn && txn.amountCents > 0 ? "in" : "out");
  const [date, setDate] = useState(txn?.date ?? new Date().toISOString().slice(0, 10));
  const [accountId, setAccountId] = useState(txn ? String(txn.accountId) : accounts[0] ? String(accounts[0].id) : "");
  const [potId, setPotId] = useState(txn ? (txn.potId != null ? String(txn.potId) : "") : "");
  const [isTransfer, setIsTransfer] = useState(!!txn?.isTransfer);
  const [split, setSplit] = useState(!!txn?.splitWithContact);
  const [contactId, setContactId] = useState(
    txn?.splitContactId != null ? String(txn.splitContactId) : ""
  );
  const [shareAmount, setShareAmount] = useState(
    txn && txn.sharedCents > 0 ? (txn.sharedCents / 100).toFixed(2) : ""
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const { data: contactsData } = useApi<{ contacts: ContactBalance[] }>("/api/contacts");
  const contacts = contactsData?.contacts ?? [];

  const toggleSplit = (on: boolean) => {
    setSplit(on);
    if (on) {
      // Default the contact and share from the pot's share config.
      const pot = pots.find((p) => String(p.id) === potId);
      if (!contactId) {
        const cid = pot?.contactId ?? contacts[0]?.id ?? null;
        if (cid != null) setContactId(String(cid));
      }
      if (!shareAmount) {
        const cents = expressionToCents(amount);
        if (cents !== null && cents > 0) {
          const pct = pot?.sharePct ?? 50;
          setShareAmount(((cents * pct) / 100 / 100).toFixed(2));
        }
      }
    }
  };

  const save = async () => {
    const cents = expressionToCents(amount);
    if (!description.trim()) {
      setError("Add a description.");
      return;
    }
    if (cents === null || cents <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError("Pick a valid date.");
      return;
    }
    if (accountId === "") {
      setError("Pick an account.");
      return;
    }
    if (!isTransfer && potId === "") {
      setError("Pick a pot.");
      return;
    }
    let sCents = 0;
    let sContactId: number | null = null;
    if (split && !isTransfer) {
      const parsed = expressionToCents(shareAmount);
      if (parsed === null || parsed <= 0 || parsed >= cents) {
        setError("The contact's share must be less than the full amount.");
        return;
      }
      sCents = parsed;
      sContactId = contactId ? Number(contactId) : null;
      if (!sContactId) {
        setError("Pick a contact to split with.");
        return;
      }
    }
    setBusy(true);
    setError(null);
    const signed = direction === "out" ? -cents : cents;
    const body = {
      date,
      accountId: Number(accountId),
      potId: potId === "" ? null : Number(potId),
      amountCents: signed,
      description: description.trim(),
      isTransfer,
      contactId: sContactId,
      shareCents: split && !isTransfer ? (direction === "out" ? -sCents : sCents) : 0,
    };
    try {
      const r = await fetch(editing ? `/api/transactions/${txn.id}` : "/api/transactions", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        throw new Error(j?.error ?? `HTTP ${r.status}`);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    }
    setBusy(false);
  };

  const destroy = async () => {
    if (!editing || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/transactions/${txn.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      onSaved();
    } catch {
      setError("Couldn't delete it. Try again.");
    }
    setBusy(false);
  };

  const groups = [...new Set(pots.map((p) => p.group))];

  return (
    <Sheet label={editing ? "Edit transaction" : "Add transaction"} onClose={onClose}>
      <div className="mb-4 text-[17px] font-semibold">{editing ? "Edit transaction" : "Add transaction"}</div>
      <div className="space-y-4">
        <div>
          <FormLabel>Description</FormLabel>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What was it?"
            aria-label="Description"
            className="field w-full px-3 py-2.5 text-[15px]"
          />
        </div>
        <div>
          <FormLabel>Amount</FormLabel>
          <div className="flex gap-2">
            <Segmented
              ariaLabel="Direction"
              value={direction}
              onChange={setDirection}
              options={[
                { value: "out", label: "Out" },
                { value: "in", label: "In" },
              ]}
            />
            <MoneyInput
              value={amount}
              onChange={setAmount}
              placeholder="0.00"
              ariaLabel="Amount"
              className="min-w-0 flex-1 py-2.5 text-[15px]"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FormLabel>Date</FormLabel>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-label="Date"
              className="field w-full px-3 py-2.5 text-[15px]"
            />
          </div>
          <div>
            <FormLabel>Account</FormLabel>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              aria-label="Account"
              className="field w-full px-3 py-2.5 text-[15px]"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <FormLabel>Pot</FormLabel>
          <select
            value={potId}
            onChange={(e) => setPotId(e.target.value)}
            aria-label="Pot"
            className="field w-full px-3 py-2.5 text-[15px]"
          >
            {isTransfer ? (
              <option value="">No pot</option>
            ) : (
              <option value="" disabled>Pick a pot…</option>
            )}
            {groups.map((g) => (
              <optgroup key={g} label={titleCase(g)}>
                {pots
                  .filter((p) => p.group === g)
                  .map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>
        <label className="flex cursor-pointer items-center gap-2.5 text-[15px]">
          <input
            type="checkbox"
            checked={isTransfer}
            onChange={(e) => {
              setIsTransfer(e.target.checked);
              if (e.target.checked) {
                setSplit(false);
                setPotId("");
              }
            }}
            className="h-4 w-4 shrink-0 accent-[var(--accent)]"
          />
          Transfer between my accounts
        </label>
        {!isTransfer && (
          <div>
            <label className="flex cursor-pointer items-center gap-2.5 text-[15px]">
              <input
                type="checkbox"
                checked={split}
                onChange={(e) => toggleSplit(e.target.checked)}
                className="h-4 w-4 shrink-0 accent-[var(--accent)]"
              />
              Split with a contact
            </label>
            {split && (
              <div className="mt-2.5 space-y-2.5">
                <div>
                  <FormLabel>Contact</FormLabel>
                  {contacts.length > 0 ? (
                    <select
                      value={contactId}
                      onChange={(e) => setContactId(e.target.value)}
                      aria-label="Contact to split with"
                      className="field t-nums w-full px-3 py-2.5 text-[15px]"
                    >
                      <option value="">Pick a contact…</option>
                      {contacts.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  ) : (
                    <div className="text-[13px] text-[var(--muted)]">Add a contact in Sharing first.</div>
                  )}
                </div>
                <div>
                  <FormLabel>Their share</FormLabel>
                  <MoneyInput
                    value={shareAmount}
                    onChange={setShareAmount}
                    placeholder="0.00"
                    ariaLabel="Contact's share"
                    className="w-40 py-2.5 text-[15px]"
                  />
                </div>
              </div>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-[13px] font-medium text-[var(--danger)]">{error}</p>
        )}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-4 py-2.5 text-[15px] font-medium text-[var(--muted)] transition hover:text-[var(--ink)] active:scale-95"
          >
            Cancel
          </button>
          <button onClick={save} disabled={busy} className="btn-ink flex-1 px-4 py-2.5 text-[15px]">
            {busy ? "Saving…" : editing ? "Save changes" : "Add transaction"}
          </button>
        </div>
        {editing && !confirmingDelete && (
          <button
            onClick={() => setConfirmingDelete(true)}
            className="text-[15px] font-medium text-[var(--danger)] transition hover:opacity-80 active:scale-95"
          >
            Delete transaction
          </button>
        )}
        {confirmingDelete && (
          <div className="rounded-[var(--r-md)] bg-[var(--danger-soft)] p-4">
            <p className="text-[15px] font-medium">Delete this transaction?</p>
            <p className="mt-1 text-[13px] text-[var(--ink-2)]">It disappears from every view. This cannot be undone.</p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => setConfirmingDelete(false)}
                className="rounded-[var(--r-pill)] border border-[var(--hairline-strong)] px-4 py-2 text-[15px] font-medium transition active:scale-95"
              >
                Keep it
              </button>
              <button
                onClick={destroy}
                disabled={busy}
                className="rounded-[var(--r-pill)] bg-[var(--danger)] px-4 py-2 text-[15px] font-medium text-white transition hover:opacity-90 active:scale-95"
              >
                {busy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}

/* ---------- transactions page ---------- */

export function TransactionsTab({ month }: { month: string }) {
  const { data, error, loading, retry } = useApi<{ month: string; transactions: ListedTxn[] }>(
    `/api/transactions?month=${month}`
  );
  const { data: potsData } = useApi<{ pots: Pot[] }>(`/api/pots?month=${month}`);
  const { data: accountsData } = useApi<{ accounts: Account[] }>("/api/accounts");
  const [query, setQuery] = useState("");
  const [potFilter, setPotFilter] = useState("all");
  const [kind, setKind] = useState<"all" | "out" | "in" | "transfer">("all");
  const [sheet, setSheet] = useState<{ txn: ListedTxn | null } | null>(null);

  const pots = potsData?.pots ?? [];
  const accounts = accountsData?.accounts ?? [];
  const txns = data?.transactions ?? [];

  const q = query.trim().toLowerCase();
  const filtered = txns.filter((t) => {
    if (kind === "out" && !(t.amountCents < 0 && !t.isTransfer)) return false;
    if (kind === "in" && !(t.amountCents > 0 && !t.isTransfer)) return false;
    if (kind === "transfer" && !t.isTransfer) return false;
    if (potFilter !== "all" && t.potId !== Number(potFilter)) return false;
    if (q && !`${t.description} ${t.potName ?? ""}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const groups = [...new Set(pots.map((p) => p.group))];
  const openAdd = () => setSheet({ txn: null });
  const saved = () => {
    setSheet(null);
    retry();
  };

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div className="font-serif-d text-[24px] font-medium">Transactions</div>
        <button onClick={openAdd} className="btn-ink px-4 py-2 text-[15px]">Add</button>
      </div>

      <div className="mb-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search transactions…"
          aria-label="Search transactions"
          className="field w-full px-3 py-2.5 text-[15px]"
        />
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <select
          value={potFilter}
          onChange={(e) => setPotFilter(e.target.value)}
          aria-label="Filter by pot"
          className="field max-w-[200px] px-3 py-2 text-[15px]"
        >
          <option value="all">All pots</option>
          {groups.map((g) => (
            <optgroup key={g} label={titleCase(g)}>
              {pots
                .filter((p) => p.group === g)
                .map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
            </optgroup>
          ))}
        </select>
        <Segmented
          ariaLabel="Transaction type"
          value={kind}
          onChange={setKind}
          options={[
            { value: "all", label: "All" },
            { value: "out", label: "Out" },
            { value: "in", label: "In" },
            { value: "transfer", label: "Transfers" },
          ]}
        />
      </div>

      {loading ? (
        <div className="space-y-2.5">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-[58px]" />
          ))}
        </div>
      ) : error ? (
        <FetchError onRetry={retry} label="Couldn't load transactions." />
      ) : filtered.length === 0 ? (
        txns.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-[17px] italic text-[var(--muted)]">No transactions this month yet.</p>
            <button onClick={openAdd} className="btn-ink mt-4 px-5 py-2.5 text-[15px]">Add one</button>
          </div>
        ) : (
          <div className="py-10 text-center">
            <p className="text-[17px] italic text-[var(--muted)]">Nothing matches these filters.</p>
            <button
              onClick={() => {
                setQuery("");
                setPotFilter("all");
                setKind("all");
              }}
              className="mt-4 px-4 py-2 text-[15px] font-medium text-[var(--ink-2)] underline decoration-[var(--hairline-strong)] underline-offset-4"
            >
              Clear filters
            </button>
          </div>
        )
      ) : (
        <>
          <div className="mb-2 text-[13px] text-[var(--muted)]">
            {filtered.length} transaction{filtered.length === 1 ? "" : "s"}
          </div>
          <ul>
            {filtered.map((t) => (
              <li key={t.id} className="border-b border-[var(--hairline)] last:border-0">
                <button
                  onClick={() => setSheet({ txn: t })}
                  className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-[var(--r-md)] px-2 py-3 text-left transition hover:bg-[var(--bg-sunken)] active:bg-[var(--bg-sunken)]"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[15px] font-medium">{t.description}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-[var(--muted)]">
                      <span>{fmtDate(t.date)}</span>
                      <span aria-hidden>·</span>
                      <span className="truncate">{t.potName ?? "(no pot)"}</span>
                      {t.isTransfer ? <TxnBadge>Transfer</TxnBadge> : null}
                      {t.splitWithContact ? <TxnBadge>{t.splitContactName ? `split · ${t.splitContactName}` : "split"}</TxnBadge> : null}
                    </div>
                  </div>
                  <span
                    className={`t-nums shrink-0 text-[15px] ${
                      t.amountCents > 0 && !t.isTransfer
                        ? "font-medium text-[var(--success)]"
                        : t.isTransfer
                          ? "text-[var(--muted)]"
                          : ""
                    }`}
                  >
                    {money(t.amountCents)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {sheet && (
        <TransactionSheet
          txn={sheet.txn}
          pots={pots}
          accounts={accounts}
          onClose={() => setSheet(null)}
          onSaved={saved}
        />
      )}
    </div>
  );
}
