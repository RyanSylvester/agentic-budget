import { useState, type FormEvent } from "react";
import { send } from "./api";
import type { AccountCreatedResponse, AccountType } from "./types";
import { Segmented, Sheet } from "./ui";

/* Add a bank or card account: a name, what kind it is, and optionally the
 *  last four digits so it is easy to tell apart. Accounts start at zero;
 *  reconciling against the bank's balance brings them in line. */
export function AccountSheet({ onClose, onSaved }: {
  onClose: () => void;
  onSaved?: (created: AccountCreatedResponse) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("chequing");
  const [last4, setLast4] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    const digits = last4.trim();
    if (digits && !/^\d{4}$/.test(digits)) {
      setError("Last four digits should be exactly 4 numbers.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await send("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n, type, last4: digits || null }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      onSaved?.((await r.json()) as AccountCreatedResponse);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that account.");
    }
    setBusy(false);
  };

  return (
    <Sheet label="Add account" onClose={onClose}>
      <form onSubmit={save} className="space-y-4" noValidate>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-[var(--ink-2)]" htmlFor="account-name">Name</label>
          <input id="account-name" type="text" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Everyday chequing" maxLength={60} className="field w-full px-3 py-2 text-md" />
        </div>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-[var(--ink-2)]">Type</span>
          <Segmented
            ariaLabel="Account type"
            value={type}
            onChange={setType}
            options={[
              { value: "chequing", label: "Chequing" },
              { value: "savings", label: "Savings" },
              { value: "credit_card", label: "Credit card" },
            ]}
          />
          <p className="mt-1.5 text-xs text-[var(--muted)]">
            {type === "credit_card"
              ? "Card balances show what you owe; reconcile against your statement."
              : "Reconcile against the balance your bank shows."}
          </p>
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-[var(--ink-2)]" htmlFor="account-last4">
            Last four digits <span className="font-normal text-[var(--muted)]">(optional)</span>
          </label>
          <input id="account-last4" type="text" inputMode="numeric" autoComplete="off" value={last4}
            onChange={(e) => setLast4(e.target.value)} placeholder="1234" maxLength={4}
            className="field t-nums w-28 px-3 py-2 text-md" />
        </div>
        {error && <div role="alert" className="text-sm text-[var(--danger)]">{error}</div>}
        <div className="flex items-center gap-2">
          <button type="submit" disabled={busy || !name.trim()} className="btn-ink flex-1 px-4 py-2.5 text-md">
            {busy ? "Adding…" : "Add account"}
          </button>
          <button type="button" onClick={onClose} className="btn-ghost px-4 py-2.5 text-md">Cancel</button>
        </div>
      </form>
    </Sheet>
  );
}
