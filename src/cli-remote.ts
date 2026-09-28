/** Remote-mode command implementations: each CLI command as a thin HTTP
 *  client against the Worker's REST API. Output shapes match local mode so
 *  the agent's scripts cannot tell which mode is active.
 *
 *  Shared formatters (printClosePreview, printScaffold) live here so local
 *  mode uses the same rendering. Bun-only: never imported by the Worker. */
import type { RemoteConfig } from "./remote";
import { apiFetch } from "./remote";
import { fmtCents, validDate, validMonth } from "./money";
import type { ClosePreview } from "./close";
import type { ScaffoldLine } from "./scaffold";

function flag(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

function usage(): never {
  console.error("usage: budget <record|assign|recategorize|void|pot|contact|settle|reconcile|close|sinking|invite|migration|migrate-remote|serve|login> [options]");
  process.exit(2);
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** apiFetch that prints the server's error and exits non-zero, like the
 *  local fail() on a domain throw. */
async function api(remote: RemoteConfig, path: string, opts: { method?: string; body?: unknown } = {}): Promise<any> {
  try {
    return await apiFetch(remote, path, opts);
  } catch (e) {
    fail((e as Error).message);
  }
}

/** Resolve a pot ref (id or case-insensitive name) to its id using the
 *  visible pot list. Numeric refs pass through; the server validates them.
 *  Hidden (retired) pots resolve by name too, matching local mode. */
async function resolvePotRemote(remote: RemoteConfig, ref: string): Promise<number> {
  const n = parseInt(ref, 10);
  if (Number.isFinite(n) && String(n) === ref.trim()) return n;
  const data = await api(remote, "/api/pots?includeHidden=1");
  const pots = data.pots as { id: number; name: string }[];
  const matches = pots.filter((p) => p.name.toLowerCase() === ref.trim().toLowerCase());
  if (matches.length === 0) fail(`no pot named "${ref}"`);
  if (matches.length > 1) fail(`ambiguous pot name "${ref}"`);
  return matches[0].id;
}

/** The Uncategorized pot id, creating it on demand exactly like the
 *  server-side ensureUncategorizedPotId does for local mode. */
async function uncategorizedPotRemote(remote: RemoteConfig): Promise<number> {
  const data = await api(remote, "/api/pots");
  const pots = data.pots as { id: number; name: string }[];
  const found = pots.find((p) => p.name === "Uncategorized");
  if (found) return found.id;
  const created = await api(remote, "/api/pots", {
    method: "POST",
    body: { name: "Uncategorized", group: "General", targetType: "fixed", targetCents: 0 },
  });
  return created.id;
}

/** Resolve a pot ref to its sinking schedule id. */
async function resolveScheduleRemote(remote: RemoteConfig, ref: string): Promise<{ id: number; potName: string }> {
  const data = await api(remote, "/api/sinking");
  const schedules = data.schedules as { id: number; potId: number; potName: string }[];
  const n = parseInt(ref, 10);
  const s =
    Number.isFinite(n) && String(n) === ref.trim()
      ? schedules.find((x) => x.potId === n)
      : schedules.find((x) => x.potName.toLowerCase() === ref.trim().toLowerCase());
  if (!s) fail(`"${ref}" has no sinking schedule`);
  return { id: s!.id, potName: s!.potName };
}

/** Shared close-preview rendering (local and remote). */
export function printClosePreview(p: ClosePreview): void {
  const $ = (c: number) => `$${fmtCents(c)}`;
  console.log(`close preview: ${p.month}  (applies wireframe for ${p.nextMonth})`);
  console.log(`  inflows (user)     ${$(p.inflowsCents)}`);
  console.log(`  assigned to pots   ${$(p.assignedCents)}`);
  console.log(`  spent (user)       ${$(p.spentCents)}`);
  console.log(`  RTA before close   ${$(p.rtaBeforeCents)}`);
  console.log(`  -> moves to savings ${$(p.movedToSavingsCents)}, RTA ends $0.00`);
  console.log(`  shared owed total  ${$(p.sharedOwedCents)}`);
  console.log(`  per-pot wireframe:`);
  for (const l of p.pots) {
    const next = l.wireframeSkipped
      ? `schedule $${fmtCents(l.wireframeCents)} (target not written)`
      : `next $${fmtCents(l.wireframeCents)}`;
    console.log(
      `    ${l.name} (${l.targetType}${l.assignable ? "" : ", income, no wireframe"}): spent $${fmtCents(l.spentCents)} / target $${fmtCents(l.targetCents)} -> ${next}`
    );
  }
}

/** Shared scaffold rendering (local and remote). */
export function printScaffold(month: string, strategy: string, dryRun: boolean, lines: ScaffoldLine[]): void {
  console.log(
    dryRun ? `scaffold preview for ${month} (${strategy}) - dry run, nothing written:` : `scaffolded ${month} (${strategy}):`
  );
  for (const l of lines) {
    const tags = [l.income ? "planned income" : null, l.scheduled ? "schedule" : null].filter(Boolean);
    console.log(`  ${l.name}: $${fmtCents(l.cents)}${tags.length ? ` (${tags.join(", ")})` : ""}`);
  }
}

async function remoteRecord(remote: RemoteConfig, rest: string[]): Promise<void> {
  const amount = Math.round(parseFloat(flag(rest, "amount") ?? "NaN") * 100);
  const description = flag(rest, "description") ?? "";
  const accountId = parseInt(flag(rest, "account") ?? "NaN", 10);
  const source = flag(rest, "source") ?? "manual";
  const cleared = rest.includes("--cleared") ? "cleared" : "uncleared";
  const potRef = flag(rest, "pot");
  const isTransfer = rest.includes("--transfer");
  const date = flag(rest, "date") ?? new Date().toISOString().slice(0, 10);
  const externalId = flag(rest, "external-id") ?? null;
  if (!Number.isFinite(amount) || !description || !Number.isFinite(accountId)) usage();
  if (!validDate(date)) fail(`bad --date "${date}"; expected YYYY-MM-DD`);
  if (!["gmail", "mention", "manual"].includes(source)) fail(`bad --source "${source}"; expected gmail, mention, or manual`);

  const potId = potRef ? await resolvePotRemote(remote, potRef) : await uncategorizedPotRemote(remote);
  // Splits: same defaults as local mode, read from the pot's share config.
  let contactId = flag(rest, "contact-id") ? parseInt(flag(rest, "contact-id")!, 10) : null;
  let share = flag(rest, "share-cents") ? Math.round(parseFloat(flag(rest, "share-cents")!) * 100) : 0;
  if (potId && !isTransfer && (contactId === null || share === 0)) {
    const data = await api(remote, "/api/pots");
    const pot = (data.pots as { id: number; contactId: number | null; sharePct: number | null }[]).find(
      (p) => p.id === potId
    );
    if (contactId === null && pot?.contactId) contactId = pot.contactId;
    if (share === 0 && pot?.sharePct != null && contactId !== null) {
      share = Math.round((Math.abs(amount) * pot.sharePct) / 100);
    }
  }
  if (share !== 0) {
    if (contactId === null) fail("splitting needs --contact-id (or a pot with a share config)");
    if (isTransfer) fail("transfers cannot be split with a contact");
  }
  // The API's shareCents carries the contact split's sign; the CLI flag is
  // the contact's positive share, and the contact split is always -share.
  const data = await api(remote, "/api/transactions", {
    method: "POST",
    body: {
      date, accountId, amountCents: amount, description, source, cleared,
      isTransfer, potId, contactId, shareCents: -share,
      externalId,
    },
  });
  if (data.duplicate) {
    console.log(`already recorded (id ${data.id})`);
    return;
  }
  const tag = `confirmed${isTransfer ? ", transfer" : ""}, ${cleared}`;
  if (share !== 0) {
    console.log(`recorded transaction ${data.id} (${tag}) - split: user ${fmtCents(amount + share)}, contact owes ${fmtCents(share)}`);
  } else {
    console.log(`recorded transaction ${data.id} (${tag})`);
  }
}

async function remoteAssign(remote: RemoteConfig, rest: string[]): Promise<void> {
  if (rest[0] === "scaffold") {
    const srest = rest.slice(1);
    const month = flag(srest, "month") ?? new Date().toISOString().slice(0, 7);
    const strategy = flag(srest, "strategy") ?? "average_3mo";
    const dryRun = srest.includes("--dry-run");
    const data = await api(remote, "/api/assign/scaffold", { method: "POST", body: { month, strategy, dryRun } });
    printScaffold(data.month, data.strategy, dryRun, data.lines);
    return;
  }
  const month = flag(rest, "month") ?? new Date().toISOString().slice(0, 7);
  const pot = flag(rest, "pot");
  const cents = Math.round(parseFloat(flag(rest, "cents") ?? "NaN"));
  if (!pot || !Number.isFinite(cents)) usage();
  const potId = await resolvePotRemote(remote, pot);
  const data = await api(remote, "/api/assign", { method: "POST", body: { month, potId, cents } });
  console.log(`assigned $${fmtCents(data.cents)} to pot ${data.potId} for ${data.month}`);
}

async function remotePot(remote: RemoteConfig, rest: string[]): Promise<void> {
  const [sub] = rest;
  if (sub === "create") {
    const name = flag(rest, "name");
    const group = flag(rest, "group") ?? "Life";
    const targetType = flag(rest, "target-type") ?? "average_3mo";
    const targetCents = Math.round(parseFloat(flag(rest, "target-cents") ?? "0"));
    if (!name) usage();
    const body: Record<string, unknown> = { name, group, targetType, targetCents };
    if (flag(rest, "contact-id")) body.contactId = parseInt(flag(rest, "contact-id")!, 10);
    if (flag(rest, "share-pct")) body.sharePct = parseInt(flag(rest, "share-pct")!, 10);
    const data = await api(remote, "/api/pots", { method: "POST", body });
    console.log(`created pot ${data.id} "${name}" (${group}, ${targetType})`);
  } else if (sub === "share" || sub === "unshare") {
    const potRef = flag(rest, "pot");
    if (!potRef) usage();
    const potId = await resolvePotRemote(remote, potRef);
    if (sub === "share") {
      const contactId = parseInt(flag(rest, "contact-id") ?? "NaN", 10);
      if (!Number.isFinite(contactId)) usage();
      const body: Record<string, unknown> = { contactId };
      if (flag(rest, "share-pct")) body.sharePct = parseInt(flag(rest, "share-pct")!, 10);
      await api(remote, `/api/pots/${potId}`, { method: "PUT", body });
      console.log(`pot ${potId} now shared`);
    } else {
      await api(remote, `/api/pots/${potId}`, { method: "PUT", body: { contactId: null } });
      console.log(`pot ${potId} no longer shared`);
    }
  } else if (sub === "delete") {
    const potRef = flag(rest, "pot");
    if (!potRef) usage();
    const potId = await resolvePotRemote(remote, potRef);
    const data = await api(remote, `/api/pots/${potId}`, { method: "DELETE" });
    console.log(
      `deleted pot ${potId}; ${data.movedTransactions} transactions and ${data.movedAssignments} assignments moved to Uncategorized (pot ${data.uncategorizedPotId})`
    );
  } else if (sub === "rename" || sub === "retire" || sub === "unhide") {
    const potRef = flag(rest, "pot");
    if (!potRef) usage();
    const potId = await resolvePotRemote(remote, potRef);
    if (sub === "rename") {
      const name = flag(rest, "name");
      if (!name) usage();
      await api(remote, `/api/pots/${potId}`, { method: "PUT", body: { name } });
      console.log(`renamed pot ${potId} to "${name}"`);
    } else {
      await api(remote, `/api/pots/${potId}`, { method: "PUT", body: { hidden: sub === "retire" ? 1 : 0 } });
      console.log(`${sub === "retire" ? "retired" : "unhid"} pot ${potId}`);
    }
  } else if (sub === "group-order") {
    const groups = rest.slice(1);
    if (groups.length === 0) usage();
    const data = await api(remote, "/api/groups/order", { method: "PUT", body: { groups } });
    console.log(`group order: ${(data.groups as string[]).join(", ")}`);
  } else {
    usage();
  }
}

async function remoteContact(remote: RemoteConfig, rest: string[]): Promise<void> {
  const [sub] = rest;
  if (sub === "list") {
    const data = await api(remote, "/api/contacts");
    const contacts = data.contacts as { id: number; name: string; totalOwedCents: number; creditCents: number }[];
    if (contacts.length === 0) console.log("no contacts");
    for (const b of contacts) {
      console.log(`${b.id} "${b.name}" - owes $${fmtCents(b.totalOwedCents)}, credit $${fmtCents(b.creditCents)}`);
    }
  } else if (sub === "add") {
    const name = flag(rest, "name");
    if (!name) usage();
    const data = await api(remote, "/api/contacts", { method: "POST", body: { name } });
    console.log(`created contact ${data.id} "${name}"`);
  } else if (sub === "rename" || sub === "delete") {
    const contactId = parseInt(flag(rest, "contact") ?? "NaN", 10);
    if (!Number.isFinite(contactId)) usage();
    if (sub === "rename") {
      const name = flag(rest, "name");
      if (!name) usage();
      await api(remote, `/api/contacts/${contactId}`, { method: "PUT", body: { name } });
      console.log(`renamed contact ${contactId} to "${name}"`);
    } else {
      await api(remote, `/api/contacts/${contactId}`, { method: "DELETE" });
      console.log(`deleted contact ${contactId}`);
    }
  } else {
    usage();
  }
}

async function remoteSettle(remote: RemoteConfig, rest: string[]): Promise<void> {
  const accountId = parseInt(flag(rest, "account") ?? "NaN", 10);
  const amountCents = Math.round(parseFloat(flag(rest, "amount") ?? "NaN") * 100);
  const note = flag(rest, "note") ?? undefined;
  if (!Number.isFinite(accountId) || !Number.isFinite(amountCents) || amountCents <= 0) usage();
  const contactId = parseInt(flag(rest, "contact") ?? "NaN", 10);
  if (!Number.isFinite(contactId)) usage();
  const contacts = await api(remote, "/api/contacts");
  const contact = (contacts.contacts as { id: number; name: string; totalOwedCents: number }[]).find(
    (c) => c.id === contactId
  );
  if (!contact) fail(`no contact ${contactId}`);
  const before = contact!.totalOwedCents;
  const s = await api(remote, "/api/settle", { method: "POST", body: { contactId, accountId, amountCents, note } });
  console.log(`settlement of $${fmtCents(amountCents)} recorded (cleared, confirmed).`);
  for (const a of s.creditAllocations) console.log(`  credit ${(a.amountCents / 100).toFixed(2)} -> ${a.potName ?? "Uncategorized"}`);
  for (const a of s.allocations) console.log(`  filled ${(a.amountCents / 100).toFixed(2)} -> ${a.potName ?? "Uncategorized"}`);
  if (s.leftoverCents > 0) console.log(`  $${fmtCents(s.leftoverCents)} left over - credit for next time`);
  if (s.creditConsumedCents > 0) console.log(`  $${fmtCents(s.creditConsumedCents)} of prior credit consumed`);
  console.log(`${s.contactName} owed before: $${fmtCents(before)}`);
}

async function remoteReconcile(remote: RemoteConfig, rest: string[]): Promise<void> {
  const accountId = parseInt(flag(rest, "account") ?? "NaN", 10);
  const actual = Math.round(parseFloat(flag(rest, "balance") ?? "NaN") * 100);
  if (!Number.isFinite(accountId) || !Number.isFinite(actual)) usage();
  const r = await api(remote, `/api/accounts/${accountId}/reconcile`, {
    method: "POST",
    body: { actualBalanceCents: actual },
  });
  console.log(`cleared balance: $${fmtCents(r.clearedBalanceCents)}  actual: $${fmtCents(r.actualBalanceCents)}  difference: $${fmtCents(r.differenceCents)}`);
  if (r.balanced) {
    console.log("balanced - transactions reconciled.");
  } else {
    if (r.suggestedClearId) console.log(`transaction ${r.suggestedClearId} exactly explains the difference - did it post?`);
    for (const t of r.uncleared) console.log(`  uncleared: ${t.id} $${fmtCents(t.amount_cents)} ${t.description}`);
  }
}

async function remoteClose(remote: RemoteConfig, rest: string[]): Promise<void> {
  const month = flag(rest, "month") ?? new Date().toISOString().slice(0, 7);
  if (!validMonth(month)) fail(`bad --month "${month}"; expected YYYY-MM`);
  const p = (await api(remote, `/api/close-preview?month=${month}`)) as ClosePreview;
  printClosePreview(p);
  if (rest.includes("--apply")) {
    try {
      await api(remote, "/api/close", { method: "POST", body: { month } });
      console.log(`applied: close recorded for ${p.month}, ${p.nextMonth} targets wireframed.`);
    } catch (e) {
      console.error(`cannot apply: ${(e as Error).message}`);
      process.exit(1);
    }
  } else {
    console.log(`preview only; add --apply to record the close and wireframe ${p.nextMonth}.`);
  }
}

async function remoteSinking(remote: RemoteConfig, rest: string[]): Promise<void> {
  const [sub] = rest;
  if (sub === "add") {
    const pot = flag(rest, "pot");
    const expectedCents = Math.round(parseFloat(flag(rest, "expected") ?? "NaN") * 100);
    const due = flag(rest, "due");
    const cadence = flag(rest, "cadence") ? parseInt(flag(rest, "cadence")!, 10) : 12;
    if (!pot || !Number.isFinite(expectedCents) || !due) usage();
    const data = await api(remote, "/api/sinking", {
      method: "POST",
      body: { pot, expectedCents, dueMonth: due, cadenceMonths: cadence },
    });
    const list = await api(remote, `/api/sinking?month=${new Date().toISOString().slice(0, 7)}`);
    const s = (list.schedules as { id: number; potName: string; expectedCents: number; dueMonth: string; cadenceMonths: number; contributionCents: number }[]).find(
      (x) => x.id === data.id
    )!;
    console.log(`schedule ${s.id}: "${s.potName}" expects $${fmtCents(s.expectedCents)}, due ${s.dueMonth} (every ${s.cadenceMonths}mo), $${fmtCents(s.contributionCents)}/mo from here`);
  } else if (sub === "list") {
    const month = flag(rest, "month") ?? new Date().toISOString().slice(0, 7);
    if (!validMonth(month)) fail(`bad --month "${month}"; expected YYYY-MM`);
    const data = await api(remote, `/api/sinking?month=${month}`);
    const schedules = data.schedules as {
      id: number; potName: string; expectedCents: number; dueMonth: string;
      contributionCents: number; balanceCents: number; monthsLeft: number; state: string;
    }[];
    if (schedules.length === 0) console.log("no sinking schedules");
    for (const s of schedules) {
      const state = s.state === "funded" ? "funded" : s.state === "overdue" ? "OVERDUE" : "funding";
      console.log(`${s.id} "${s.potName}": $${fmtCents(s.expectedCents)} due ${s.dueMonth}, $${fmtCents(s.contributionCents)}/mo for ${month} (saved $${fmtCents(s.balanceCents)}, ${s.monthsLeft}mo left) [${state}]`);
    }
  } else if (sub === "paid" || sub === "remove") {
    const pot = flag(rest, "pot");
    if (!pot) usage();
    const sched = await resolveScheduleRemote(remote, pot);
    if (sub === "paid") {
      const data = await api(remote, `/api/sinking/${sched.id}/paid`, { method: "POST" });
      console.log(`"${sched.potName}" marked paid, next due ${data.dueMonth}`);
    } else {
      await api(remote, `/api/sinking/${sched.id}`, { method: "DELETE" });
      console.log(`schedule removed for "${pot}"`);
    }
  } else {
    usage();
  }
}

/** Dispatch one CLI command against the Worker API. Never touches the local db. */
export async function runRemote(remote: RemoteConfig, cmd: string, rest: string[]): Promise<void> {
  if (cmd === "record") await remoteRecord(remote, rest);
  else if (cmd === "assign") await remoteAssign(remote, rest);
  else if (cmd === "recategorize") {
    const id = parseInt(flag(rest, "id") ?? "NaN", 10);
    const pot = flag(rest, "pot");
    if (!Number.isFinite(id) || !pot) usage();
    const potId = await resolvePotRemote(remote, pot);
    await api(remote, `/api/transactions/${id}/recategorize`, { method: "POST", body: { potId } });
    console.log(`transaction ${id} recategorized to pot ${potId}`);
  } else if (cmd === "void") {
    const id = parseInt(flag(rest, "id") ?? "NaN", 10);
    if (!Number.isFinite(id)) usage();
    const data = await api(remote, `/api/transactions/${id}/void`, { method: "POST" });
    console.log(data.alreadyVoided ? `transaction ${id} was already void` : `transaction ${id} voided`);
  } else if (cmd === "pot") await remotePot(remote, rest);
  else if (cmd === "contact") await remoteContact(remote, rest);
  else if (cmd === "settle") await remoteSettle(remote, rest);
  else if (cmd === "reconcile") await remoteReconcile(remote, rest);
  else if (cmd === "close") await remoteClose(remote, rest);
  else if (cmd === "sinking") await remoteSinking(remote, rest);
  else if (cmd === "migrate-remote") {
    // Mode-independent: pushes local budget.db to D1 directly, never through
    // the Worker API.
    const { migrateRemote, ensureRemoteSchemaOnly } = await import("./migrate-remote");
    if (rest.includes("--schema-only")) await ensureRemoteSchemaOnly();
    else await migrateRemote();
  }
  else usage();
}
