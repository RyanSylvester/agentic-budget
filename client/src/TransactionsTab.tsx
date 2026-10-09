import { useEffect, useState } from "react";
import { MoneyInput } from "./MoneyInput";
import { useApi, send } from "./api";
import { defaultDateInMonth, money, titleCase, todayLocal } from "./format";
import { expressionToCents } from "./money";
import type { Account, AccountsResponse, ContactsResponse, ListedTransaction, Pot, PotsResponse, TransactionsResponse } from "./types";
import { FetchError, FormLabel, Segmented, Sheet, Skeleton, TxnBadge } from "./ui";
import { dayLabel, groupByDay, matchesQuery, takePendingTransaction, userShareCents } from "./txnList";

/* ---------- transaction add/edit sheet ---------- */

// Turn the server's terse lock/validation errors into sentences.
function readableError(message: string | undefined, status: number): string {
  if (!message) return status >= 500 ? "Something went wrong on our end. Try again." : "Couldn't save. Try again.";
  const money = /^already (cleared|reconciled); amounts cannot change/.exec(message);
  if (money) return `This transaction is ${money[1]}, so its amount, account and split can't change. You can still change the pot, date and description.`;
  if (/settlement.*amounts cannot change/.test(message))
    return "This transaction is part of a contact settlement, so its amount, account and split can't change. You can still change the pot, date and description.";
  if (/^already reconciled; cannot be voided/.test(message)) return "Reconciled transactions can't be voided. Record a correcting transaction instead.";
  if (/^already reconciled; cannot be restored/.test(message)) return "This transaction was reconciled while voided, so it can't be restored.";
  if (/settlement.*cannot be (voided|restored)/.test(message)) return "This transaction is part of a contact settlement, so it can't be voided or restored.";
  if (/^no pot/.test(message)) return "That pot no longer exists. Pick another one.";
  if (/^no account/.test(message)) return "That account no longer exists. Pick another one.";
  if (/^no transaction/.test(message)) return "This transaction no longer exists. Refresh and try again.";
  return message;
}

// fetch that throws a readable Error on a non-2xx response.
async function request(url: string, init: RequestInit): Promise<void> {
  const r = await send(url, init);
  if (!r.ok) {
    const j = await r.json().catch(() => null);
    throw new Error(readableError(j?.error, r.status));
  }
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// Add/edit form for one transaction. txn === null means "add". Renders inside
// a Sheet; the parent refetches on onSaved. All inputs keep a fixed size so
// focusing never shifts the layout.
export function TransactionSheet({ txn, month, pots, accounts, onClose, onSaved, onVoided }: {
  txn: ListedTransaction | null;
  month?: string;
  pots: Pot[];
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
  /** Called after a void; defaults to onSaved. */
  onVoided?: (txn: ListedTransaction) => void;
}) {
  const editing = txn !== null;
  // Mirrors the server: cleared, reconciled and settlement rows keep their
  // money fields; reconciled and settlement rows cannot be voided.
  const lockedAs = !txn ? null : txn.settled ? "settled" : txn.cleared !== "uncleared" ? txn.cleared : null;
  const locked = lockedAs !== null;
  const voidLocked = !!txn && (!!txn.settled || txn.cleared === "reconciled");
  const [description, setDescription] = useState(txn?.description ?? "");
  const [amount, setAmount] = useState(txn ? (Math.abs(txn.amountCents) / 100).toFixed(2) : "");
  const [direction, setDirection] = useState<"out" | "in">(txn && txn.amountCents > 0 ? "in" : "out");
  const [date, setDate] = useState(txn?.date ?? (month ? defaultDateInMonth(month) : todayLocal()));
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

  const { data: contactsData } = useApi<ContactsResponse>("/api/contacts");
  const contacts = contactsData?.contacts ?? [];

  // The split editor takes their share as an amount or a percent of the
  // total; the percent field shows the share's percent unless being typed in.
  const [pctText, setPctText] = useState("");
  const [pctEditing, setPctEditing] = useState(false);
  const totalCents = (() => {
    const c = expressionToCents(amount);
    return c !== null && c > 0 ? c : null;
  })();
  const shareCents = expressionToCents(shareAmount);
  const sharePct = totalCents !== null && shareCents !== null && shareCents > 0
    ? Math.round((shareCents / totalCents) * 1000) / 10
    : null;
  const yourShareCents = totalCents !== null && shareCents !== null && shareCents > 0 && shareCents < totalCents
    ? totalCents - shareCents
    : null;
  const setPct = (text: string) => {
    setPctText(text);
    const pct = Number(text);
    if (totalCents === null || text.trim() === "" || !Number.isFinite(pct) || pct < 0 || pct > 100) return;
    setShareAmount((Math.round((totalCents * pct) / 100) / 100).toFixed(2));
  };

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

  const saveLocked = async (t: ListedTransaction) => {
    if (!description.trim()) {
      setError("Add a description.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError("Pick a valid date.");
      return;
    }
    if (!t.isTransfer && potId === "") {
      setError("Pick a pot.");
      return;
    }
    const newPotId = potId === "" ? null : Number(potId);
    const potChanged = newPotId !== t.potId;
    const textChanged = description.trim() !== t.description || date !== t.date;
    setBusy(true);
    setError(null);
    try {
      // The pot moves through recategorize, which locked rows allow; date and
      // description go through PUT with the money fields exactly as they were.
      if (potChanged && newPotId !== null) await request(`/api/transactions/${t.id}/recategorize`, jsonInit("POST", { potId: newPotId }));
      if (textChanged) {
        await request(`/api/transactions/${t.id}`, jsonInit("PUT", {
          date,
          accountId: t.accountId,
          potId: potChanged ? newPotId : t.potId,
          amountCents: t.amountCents,
          description: description.trim(),
          isTransfer: !!t.isTransfer,
          contactId: t.splitWithContact ? t.splitContactId : null,
          shareCents: t.splitWithContact ? -t.sharedCents : 0,
        }));
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    }
    setBusy(false);
  };

  const save = async () => {
    if (txn && locked) return saveLocked(txn);
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
      setError(accounts.length === 0 ? "Add an account first" : "Pick an account.");
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
      await request(editing ? `/api/transactions/${txn.id}` : "/api/transactions", jsonInit(editing ? "PUT" : "POST", body));
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    }
    setBusy(false);
  };

  const voidTxn = async () => {
    if (!editing || busy) return;
    setBusy(true);
    setError(null);
    try {
      await request(`/api/transactions/${txn.id}`, { method: "DELETE" });
      if (onVoided) onVoided(txn);
      else onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't void it. Try again.");
    }
    setBusy(false);
  };

  const groups = [...new Set(pots.map((p) => p.group))];

  return (
    <Sheet label={editing ? "Edit transaction" : "Add transaction"} onClose={onClose}>
      <div className="mb-4 text-lg font-semibold">{editing ? "Edit transaction" : "Add transaction"}</div>
      {lockedAs && (
        <p className="mb-4 rounded-[var(--r-md)] bg-[var(--bg-sunken)] px-3 py-2.5 text-sm text-[var(--ink-2)]">
          {lockedAs === "settled" ? "Part of a contact settlement" : titleCase(lockedAs)}. Amount, account and split are locked; you can still change the pot, date and description.
        </p>
      )}
      <div className="space-y-4">
        <div>
          <FormLabel>Description</FormLabel>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What was it?"
            aria-label="Description"
            className="field w-full px-3 py-2.5 text-md"
          />
        </div>
        <div>
          <FormLabel>Amount</FormLabel>
          <div className="flex gap-2">
            <Segmented
              ariaLabel="Direction"
              value={direction}
              onChange={setDirection}
              disabled={locked}
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
              disabled={locked}
              className="min-w-0 flex-1 py-2.5 text-md"
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
              className="field w-full px-3 py-2.5 text-md"
            />
          </div>
          <div>
            <FormLabel>Account</FormLabel>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              disabled={locked}
              aria-label="Account"
              className="field w-full px-3 py-2.5 text-md"
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
            disabled={locked && isTransfer}
            aria-label="Pot"
            className="field w-full px-3 py-2.5 text-md"
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
        <label className="flex cursor-pointer items-center gap-2.5 text-md">
          <input
            type="checkbox"
            checked={isTransfer}
            disabled={locked}
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
            <label className="flex cursor-pointer items-center gap-2.5 text-md">
              <input
                type="checkbox"
                checked={split}
                disabled={locked}
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
                      disabled={locked}
                      aria-label="Contact to split with"
                      className="field t-nums w-full px-3 py-2.5 text-md"
                    >
                      <option value="">Pick a contact…</option>
                      {contacts.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  ) : (
                    <div className="text-sm text-[var(--muted)]">Add a contact in Sharing first.</div>
                  )}
                </div>
                <div>
                  <FormLabel>Their share</FormLabel>
                  <div className="flex flex-wrap items-center gap-2">
                    <MoneyInput
                      value={shareAmount}
                      onChange={setShareAmount}
                      placeholder="0.00"
                      ariaLabel="Contact's share"
                      disabled={locked}
                      className="w-32 py-2.5 text-md"
                    />
                    <span className="text-sm text-[var(--muted)]">or</span>
                    <span className="flex items-center gap-1">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={pctEditing ? pctText : sharePct === null ? "" : String(sharePct)}
                        onChange={(e) => setPct(e.target.value)}
                        onFocus={() => {
                          setPctEditing(true);
                          setPctText(sharePct === null ? "" : String(sharePct));
                        }}
                        onBlur={() => setPctEditing(false)}
                        placeholder="50"
                        aria-label="Contact's share as a percent"
                        disabled={locked || totalCents === null}
                        className="field t-nums w-16 px-2 py-2.5 text-right text-md"
                      />
                      <span className="text-md text-[var(--muted)]">%</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setPct("50")}
                      disabled={locked || totalCents === null}
                      className="rounded-[var(--r-pill)] border border-[var(--hairline-strong)] px-3 py-2 text-sm font-medium text-[var(--ink-2)] transition active:scale-95 disabled:opacity-50"
                    >
                      Half
                    </button>
                  </div>
                  {yourShareCents !== null && (
                    <div className="t-nums mt-1.5 text-sm text-[var(--muted)]">Your share {money(yourShareCents)}</div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm font-medium text-[var(--danger)]">{error === "Add an account first" ? <a href="?tab=accounts" className="underline">{error}</a> : error}</p>
        )}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-4 py-2.5 text-md font-medium text-[var(--muted)] transition hover:text-[var(--ink)] active:scale-95"
          >
            Cancel
          </button>
          <button onClick={save} disabled={busy} className="btn-ink flex-1 px-4 py-2.5 text-md">
            {busy ? "Saving…" : editing ? "Save changes" : "Add transaction"}
          </button>
        </div>
        {editing && !confirmingDelete && (
          <div>
            <button
              onClick={() => setConfirmingDelete(true)}
              disabled={voidLocked}
              className="text-md font-medium text-[var(--danger)] transition hover:opacity-80 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Void transaction
            </button>
            {voidLocked && (
              <p className="mt-1 text-sm text-[var(--muted)]">
                {txn.settled
                  ? "Part of a contact settlement, so it can't be voided."
                  : "Reconciled, so it can't be voided. Record a correcting transaction instead."}
              </p>
            )}
          </div>
        )}
        {confirmingDelete && (
          <div className="rounded-[var(--r-md)] bg-[var(--danger-soft)] p-4">
            <p className="text-md font-medium">Void this transaction?</p>
            <p className="mt-1 text-sm text-[var(--ink-2)]">Removed from spending and budgets; kept in history. You can undo right after.</p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => setConfirmingDelete(false)}
                className="rounded-[var(--r-pill)] border border-[var(--hairline-strong)] px-4 py-2 text-md font-medium transition active:scale-95"
              >
                Keep it
              </button>
              <button
                onClick={voidTxn}
                disabled={busy}
                className="rounded-[var(--r-pill)] bg-[var(--danger)] px-4 py-2 text-md font-medium text-[var(--on-danger)] transition hover:opacity-90 active:scale-95"
              >
                {busy ? "Voiding…" : "Void"}
              </button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}

/* ---------- transactions page ---------- */

/* Cleared and reconciled marks: a small check for cleared, a lock for
 * reconciled; uncleared rows show nothing. */
function ClearedMark({ state }: { state: string }) {
  const common = {
    width: 12,
    height: 12,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  } as const;
  if (state === "cleared") {
    return (
      <span title="Cleared" className="inline-flex items-center text-[var(--muted)]">
        <svg {...common}><path d="M3 8.5 6.5 12 13 4.5" /></svg>
        <span className="sr-only">Cleared</span>
      </span>
    );
  }
  if (state === "reconciled") {
    return (
      <span title="Reconciled" className="inline-flex items-center text-[var(--success)]">
        <svg {...common}><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
        <span className="sr-only">Reconciled</span>
      </span>
    );
  }
  return null;
}

function TransactionRow({ t, onOpen }: { t: ListedTransaction; onOpen: () => void }) {
  const mine = userShareCents(t);
  // A settlement is wholly the contact's money: no share of yours to show.
  const settlement = !!t.splitWithContact && mine === 0;
  const showShare = !!t.splitWithContact && !settlement && mine !== t.amountCents;
  return (
    <button
      onClick={onOpen}
      className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-[var(--r-md)] px-2 py-3 text-left transition hover:bg-[var(--bg-sunken)] active:bg-[var(--bg-sunken)]"
    >
      <div className="min-w-0">
        <div className="truncate text-md font-medium">{t.description}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-[var(--muted)]">
          <span className="truncate">{settlement ? "Settle-up" : t.potName ?? "(no pot)"}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{t.accountName}</span>
          <ClearedMark state={t.cleared} />
          {t.isTransfer ? <TxnBadge>Transfer</TxnBadge> : null}
          {t.splitWithContact ? (
            <TxnBadge>{t.splitContactName ? `${settlement ? "with" : "split ·"} ${t.splitContactName}` : "split"}</TxnBadge>
          ) : null}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div
          className={`t-nums text-md ${
            t.amountCents > 0 && !t.isTransfer
              ? "font-medium text-[var(--success)]"
              : t.isTransfer || settlement
                ? "text-[var(--muted)]"
                : ""
          }`}
        >
          {money(t.amountCents)}
        </div>
        {showShare && (
          <div className="t-nums mt-0.5 text-xs text-[var(--muted)]">your share {money(Math.abs(mine))}</div>
        )}
      </div>
    </button>
  );
}

export function TransactionsTab({ month }: { month: string }) {
  const { data, error, loading, retry } = useApi<TransactionsResponse>(
    `/api/transactions?month=${month}`
  );
  const { data: potsData } = useApi<PotsResponse>(`/api/pots?month=${month}`);
  const { data: accountsData } = useApi<AccountsResponse>("/api/accounts");
  const [query, setQuery] = useState("");
  const [potFilter, setPotFilter] = useState("all");
  const [kind, setKind] = useState<"all" | "out" | "in" | "transfer">("all");
  const [sheet, setSheet] = useState<{ txn: ListedTransaction | null } | null>(null);
  // The last voided transaction, offered for undo for a few seconds.
  const [voided, setVoided] = useState<{ txn: ListedTransaction; error: string | null } | null>(null);
  // A transaction another tab asked to open (Overview's recent activity).
  const [openId, setOpenId] = useState<number | null>(takePendingTransaction);

  useEffect(() => {
    if (!voided || voided.error) return;
    const t = setTimeout(() => setVoided(null), 10000);
    return () => clearTimeout(t);
  }, [voided]);

  useEffect(() => {
    if (openId === null || !data) return;
    const t = data.transactions.find((x) => x.id === openId);
    if (t) setSheet({ txn: t });
    setOpenId(null);
  }, [data, openId]);

  const pots = potsData?.pots ?? [];
  const accounts = accountsData?.accounts ?? [];
  const txns = data?.transactions ?? [];

  const filtered = txns.filter((t) => {
    if (kind === "out" && !(t.amountCents < 0 && !t.isTransfer)) return false;
    if (kind === "in" && !(t.amountCents > 0 && !t.isTransfer)) return false;
    if (kind === "transfer" && !t.isTransfer) return false;
    if (potFilter !== "all" && t.potId !== Number(potFilter)) return false;
    return matchesQuery(t, query);
  });
  const filtering = query.trim() !== "" || potFilter !== "all" || kind !== "all";
  const filteredTotal = filtered.reduce((a, t) => a + t.amountCents, 0);

  const groups = [...new Set(pots.map((p) => p.group))];
  const openAdd = () => setSheet({ txn: null });
  const saved = () => {
    setSheet(null);
    retry();
  };
  const onVoided = (txn: ListedTransaction) => {
    setSheet(null);
    setVoided({ txn, error: null });
    retry();
  };
  const undoVoid = async () => {
    if (!voided) return;
    try {
      await request(`/api/transactions/${voided.txn.id}/unvoid`, { method: "POST" });
      setVoided(null);
      retry();
    } catch (e) {
      setVoided({ ...voided, error: e instanceof Error ? e.message : "Couldn't undo. Try again." });
    }
  };

  return (
    <div className="mx-auto max-w-[720px]">
      <div className="mb-5 flex items-center justify-between">
        <div className="font-serif-d text-xl font-medium">Transactions</div>
        <button onClick={openAdd} className="btn-ink px-4 py-2 text-md">Add</button>
      </div>

      <div className="mb-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, pot or amount…"
          aria-label="Search transactions"
          className="field w-full px-3 py-2.5 text-md"
        />
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <select
          value={potFilter}
          onChange={(e) => setPotFilter(e.target.value)}
          aria-label="Filter by pot"
          className="field max-w-[200px] px-3 py-2 text-md"
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

      {voided && (
        <div role="status" className="mb-4 rounded-[var(--r-md)] bg-[var(--bg-sunken)] px-3 py-2.5 text-md">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate">Voided · {voided.txn.description}</span>
            {voided.error ? (
              <button onClick={() => setVoided(null)} className="shrink-0 font-medium text-[var(--muted)] transition hover:text-[var(--ink)]">
                Dismiss
              </button>
            ) : (
              <button onClick={undoVoid} className="shrink-0 font-medium underline decoration-[var(--hairline-strong)] underline-offset-4 transition hover:opacity-80 active:scale-95">
                Undo
              </button>
            )}
          </div>
          {voided.error && <p className="mt-1 text-sm text-[var(--danger)]">{voided.error}</p>}
        </div>
      )}

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
            <p className="text-lg italic text-[var(--muted)]">No transactions this month yet.</p>
            <button onClick={openAdd} className="btn-ink mt-4 px-5 py-2.5 text-md">Add one</button>
          </div>
        ) : (
          <div className="py-10 text-center">
            <p className="text-lg italic text-[var(--muted)]">Nothing matches these filters.</p>
            <button
              onClick={() => {
                setQuery("");
                setPotFilter("all");
                setKind("all");
              }}
              className="mt-4 px-4 py-2 text-md font-medium text-[var(--ink-2)] underline decoration-[var(--hairline-strong)] underline-offset-4"
            >
              Clear filters
            </button>
          </div>
        )
      ) : (
        <>
          <div role="status" className="mb-1 text-sm text-[var(--muted)]">
            {filtered.length} transaction{filtered.length === 1 ? "" : "s"}
            {filtering && (
              <>
                <span aria-hidden> · </span>
                <span className="t-nums font-medium text-[var(--ink-2)]">{money(filteredTotal)}</span>
              </>
            )}
          </div>
          {groupByDay(filtered).map((day) => (
            <section key={day.date} aria-label={dayLabel(day.date)}>
              <h3 className="eyebrow sticky top-0 z-[1] -mx-2 bg-[var(--bg)] px-2 pb-1 pt-4">
                {dayLabel(day.date)}
              </h3>
              <ul>
                {day.rows.map((t) => (
                  <li key={t.id} className="border-b border-[var(--hairline)] last:border-0">
                    <TransactionRow t={t} onOpen={() => setSheet({ txn: t })} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}

      {sheet && (
        <TransactionSheet
          txn={sheet.txn}
          month={month}
          pots={pots}
          accounts={accounts}
          onClose={() => setSheet(null)}
          onSaved={saved}
          onVoided={onVoided}
        />
      )}
    </div>
  );
}
