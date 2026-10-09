import { useState } from "react";
import { useApi, send } from "./api";
import type { ContactsResponse, Pot, PotDeletePreview, TargetType } from "./types";
import { Segmented, Sheet } from "./ui";

/* ---------- tabs: pots / close / sharing ---------- */

/* Add or edit a pot: name, group, next-month fill rule, and who it's shared
 *  with (which contact and their percentage). Deleting moves the pot's
 *  history to a destination pot the user picks instead of destroying it. */
export function PotSheet({ pot, groups, pots, onClose, onSaved }: {
  pot: Pot | null;
  groups: string[];
  pots: Pot[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data: contactsData } = useApi<ContactsResponse>("/api/contacts");
  const contacts = contactsData?.contacts ?? [];
  const [name, setName] = useState(pot?.name ?? "");
  // New pots start in the last-used group (remembered across sessions), so
  // strays never land in a "General" bucket the user didn't ask for.
  const [group, setGroup] = useState(
    pot?.group ?? (typeof localStorage !== "undefined" ? localStorage.getItem("daybook:lastGroup") : null) ?? ""
  );
  const [targetType, setTargetType] = useState<TargetType>(pot?.targetType ?? "average_3mo");
  const [shared, setShared] = useState(pot?.contactId != null);
  const [contactId, setContactId] = useState<string>(pot?.contactId != null ? String(pot.contactId) : "");
  const [sharePct, setSharePct] = useState<string>(pot?.sharePct != null ? String(pot.sharePct) : "50");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    const n = name.trim();
    if (!n || busy) return;
    const pct = parseInt(sharePct, 10);
    if (shared && (!Number.isInteger(pct) || pct < 0 || pct > 100)) {
      setError("Share must be a whole percent from 0 to 100.");
      return;
    }
    if (shared && !contactId) {
      setError("Pick a contact to share with.");
      return;
    }
    setBusy(true);
    setError(null);
    const finalGroup =
      group.trim() || (typeof localStorage !== "undefined" ? localStorage.getItem("daybook:lastGroup") : null) || "General";
    if (typeof localStorage !== "undefined") localStorage.setItem("daybook:lastGroup", finalGroup);
    const body = {
      name: n,
      group: finalGroup,
      targetType,
      targetCents: pot ? pot.targetCents : 0,
      contactId: shared ? Number(contactId) : null,
      sharePct: shared ? pct : null,
    };
    try {
      const r = await send(pot ? `/api/pots/${pot.id}` : "/api/pots", {
        method: pot ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save that pot.");
    }
    setBusy(false);
  };

  const [moveToPotId, setMoveToPotId] = useState<string>("");
  const [preview, setPreview] = useState<PotDeletePreview | null>(null);
  const openDelete = async () => {
    setConfirmDelete(true);
    setMoveToPotId("");
    setPreview(null);
    setError(null);
    try {
      const r = await fetch(`/api/pots/${pot!.id}/delete-preview`);
      if (r.ok) setPreview((await r.json()) as PotDeletePreview);
    } catch {
      /* counts are a nicety; the delete still works without them */
    }
  };

  const remove = async () => {
    if (!pot || busy || !moveToPotId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await send(`/api/pots/${pot.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moveToPotId: Number(moveToPotId) }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete that pot.");
    }
    setBusy(false);
  };

  return (
    <Sheet label={pot ? `Edit ${pot.name}` : "Add pot"} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-[var(--ink-2)]" htmlFor="pot-name">Name</label>
          <input id="pot-name" type="text" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Groceries" className="field t-nums w-full px-3 py-2 text-md" />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-medium text-[var(--ink-2)]" htmlFor="pot-group">Group</label>
          <input id="pot-group" type="text" value={group} onChange={(e) => setGroup(e.target.value)}
            list="pot-groups" placeholder="Life" className="field t-nums w-full px-3 py-2 text-md" />
          <datalist id="pot-groups">
            {groups.map((g) => <option key={g} value={g} />)}
          </datalist>
        </div>
        <div>
          <span className="mb-1.5 block text-sm font-medium text-[var(--ink-2)]">Next month fills with</span>
          <Segmented
            ariaLabel="Next month fill rule"
            value={targetType}
            onChange={setTargetType}
            options={[
              { value: "fixed", label: "Last month" },
              { value: "average_3mo", label: "3-mo average" },
              { value: "savings", label: "Leftovers" },
            ]}
          />
          <p className="mt-1.5 text-xs text-[var(--muted)]">
            {targetType === "fixed" && "The bulk fill copies what you assigned last month."}
            {targetType === "average_3mo" && "The bulk fill uses your 3-month average assignment."}
            {targetType === "savings" && "Skipped by the bulk fill; only month-end leftovers land here."}
          </p>
        </div>
        <div className="rounded-[var(--r-md)] bg-[var(--bg-sunken)] p-4">
          <label className="flex cursor-pointer items-center gap-2.5 text-md font-medium">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} className="h-4 w-4 accent-[var(--ink)]" />
            Share with a contact
          </label>
          {shared && (
            <div className="mt-3 flex items-center gap-2">
              <select
                value={contactId}
                onChange={(e) => setContactId(e.target.value)}
                aria-label="Contact"
                className="field t-nums flex-1 px-2 py-2 text-md"
              >
                <option value="">Pick a contact…</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <input type="text" inputMode="numeric" value={sharePct} onChange={(e) => setSharePct(e.target.value)}
                aria-label="Share percent" className="field t-nums w-20 px-2 py-2 text-center text-md" />
              <span className="text-sm text-[var(--muted)]">%</span>
            </div>
          )}
          {shared && contacts.length === 0 && (
            <div className="mt-2 text-sm text-[var(--muted)]">Add a contact in Sharing first.</div>
          )}
          <div className="mt-2 text-sm text-[var(--muted)]">New split transactions in this pot default to this share.</div>
        </div>
        {error && <div className="text-sm text-[var(--danger)]">{error}</div>}
        <div className="flex items-center gap-2">
          <button onClick={save} disabled={busy || !name.trim()} className="btn-ink flex-1 px-4 py-2.5 text-md">
            {busy ? "Saving…" : pot ? "Save changes" : "Add pot"}
          </button>
          <button onClick={onClose} className="btn-ghost px-4 py-2.5 text-md">Cancel</button>
        </div>
        {pot && !confirmDelete && (
          <button onClick={openDelete} className="cursor-pointer text-sm text-[var(--muted)] hover:text-[var(--danger)]">
            Delete this pot…
          </button>
        )}
        {pot && confirmDelete && (
          <div className="rounded-[var(--r-md)] border border-[var(--danger)] p-4 text-sm">
            <div className="font-medium">Delete {pot.name}?</div>
            <div className="mt-1 text-[var(--ink-2)]">
              {preview
                ? `${preview.transactionCount} transaction${preview.transactionCount === 1 ? "" : "s"} and ${preview.assignmentCount} assignment${preview.assignmentCount === 1 ? "" : "s"} will move to the pot you pick. `
                : "Its history will move to the pot you pick. "}
              Nothing is destroyed, but this can't be undone.
            </div>
            <label className="mt-3 mb-1.5 block font-medium text-[var(--ink-2)]" htmlFor="delete-move-to">
              Move history to
            </label>
            <select
              id="delete-move-to"
              value={moveToPotId}
              onChange={(e) => setMoveToPotId(e.target.value)}
              className="field w-full px-3 py-2"
            >
              <option value="">Choose a pot…</option>
              {pots
                .filter((p) => p.id !== pot.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            <div className="mt-3 flex gap-2">
              <button
                onClick={remove}
                disabled={busy || !moveToPotId}
                className="cursor-pointer rounded-[var(--r-pill)] bg-[var(--danger)] px-4 py-2 font-medium text-[var(--on-danger)] disabled:opacity-40"
              >
                {busy ? "Deleting…" : "Move & delete"}
              </button>
              <button onClick={() => setConfirmDelete(false)} className="btn-ghost px-4 py-2">Keep it</button>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}
