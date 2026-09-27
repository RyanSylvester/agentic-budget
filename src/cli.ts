/** `budget` — the agent's write path. Every command here is something the agent
 *  runs instead of clicking through a UI.
 *
 *  Usage:
 *    bun src/cli.ts record --account 1 --amount -12.50 --description "Voila groceries" --source mention [--date 2026-09-26] [--cleared] [--pot 5] [--contact-id 1] [--share-cents 625] [--uncertain "unsure which pot"] [--transfer] [--external-id stmt-abc123]
 *    bun src/cli.ts assign --month 2026-09 --pot Groceries --cents 60000
 *    bun src/cli.ts recategorize --id 42 --pot Groceries
 *    bun src/cli.ts void --id 42
 *    bun src/cli.ts pot create --name "Nova" --group Life [--target-type savings] [--contact-id 1 --share-pct 50]
 *    bun src/cli.ts pot rename --pot 12 --name "Nova Fund"
 *    bun src/cli.ts pot share --pot 12 --contact-id 1 [--share-pct 50]   # default 50%
 *    bun src/cli.ts pot unshare --pot 12
 *    bun src/cli.ts pot retire --pot 12
 *    bun src/cli.ts pot unhide --pot 12
 *    bun src/cli.ts contact list
 *    bun src/cli.ts contact add --name "Alex"
 *    bun src/cli.ts contact rename --contact 1 --name "Alex R."
 *    bun src/cli.ts contact delete --contact 1   # blocked while pots or splits reference them
 *    bun src/cli.ts settle --contact 1 --account 1 --amount 2000 --note "E-transfer"   # their lump sum fills the buckets they owe, oldest first
 *    bun src/cli.ts review            # list pending_review transactions
 *    bun src/cli.ts reconcile --account 1 --balance 1234.56
 *    bun src/cli.ts close --month 2026-09 [--apply]   # preview (or apply) the month-end close
 *    bun src/cli.ts sinking add --pot "Property tax" --expected 3483.59 --due 2027-07 [--cadence 12]
 *    bun src/cli.ts sinking list [--month 2026-10]    # schedules with the derived monthly contribution
 *    bun src/cli.ts sinking paid --pot "Property tax" # roll the due date forward one cadence
 *    bun src/cli.ts sinking remove --pot "Property tax"
 *    bun src/cli.ts serve             # start the dashboard
 */
import { openDb } from "./db";
import { reconcile, suggestClear } from "./reconcile";
import { applySettlement, contactOwed } from "./settle";
import { closePreview, applyClose } from "./close";
import { assignToPot } from "./assign";
import { contactBalances, createContact, deleteContact, listContacts, renameContact } from "./contacts";
import { createPot, deletePot, updatePot } from "./pots";
import { createSchedule, listSchedules, markPaid, removeSchedule, sinkingStatus } from "./sinking";
import { assertSplitsSum, resolvePotId, validDate, validMonth, fmtCents } from "./money";

function usage(): never {
  console.error("usage: budget <record|assign|recategorize|void|pot|contact|settle|review|reconcile|close|sinking|serve> [options]");
  process.exit(2);
}

const [cmd, ...rest] = Bun.argv.slice(2);
if (!cmd) usage();

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function mustResolvePot(db: ReturnType<typeof openDb>, ref: string): number {
  try {
    return resolvePotId(db, ref);
  } catch (e) {
    fail((e as Error).message);
  }
}

if (cmd === "record") {
  const db = openDb();
  const amount = Math.round(parseFloat(flag("amount") ?? "NaN") * 100);
  const description = flag("description") ?? "";
  const accountId = parseInt(flag("account") ?? "NaN", 10);
  const source = (flag("source") ?? "manual") as "gmail" | "mention" | "manual";
  const cleared = rest.includes("--cleared") ? "cleared" : "uncleared";
  const potId = flag("pot") ? mustResolvePot(db, flag("pot")!) : null;
  const uncertain = flag("uncertain") ?? null; // reason the agent wasn't sure
  const isTransfer = rest.includes("--transfer") ? 1 : 0;
  const date = flag("date") ?? new Date().toISOString().slice(0, 10);
  const externalId = flag("external-id") ?? null;
  if (!Number.isFinite(amount) || !description || !Number.isFinite(accountId)) usage();
  if (!validDate(date)) fail(`bad --date "${date}"; expected YYYY-MM-DD`);
  if (externalId) {
    const dup = db.query("SELECT id FROM transactions WHERE external_id = ?").get(externalId) as { id: number } | null;
    if (dup) {
      console.log(`already recorded (id ${dup.id})`);
      process.exit(0);
    }
  }
  const status = uncertain ? "pending_review" : "confirmed";
  const enteredBy = "agent"; // CLI is the agent's write path
  // Splits: the user's share counts in their views; the contact's share is
  // expected (owed). Defaults come from the pot's share config; flags override.
  let contactId = flag("contact-id") ? parseInt(flag("contact-id")!, 10) : null;
  let share = flag("share-cents") ? Math.round(parseFloat(flag("share-cents")!) * 100) : 0;
  if (potId && !isTransfer && (contactId === null || share === 0)) {
    const cfg = db.query("SELECT contact_id, share_pct FROM pots WHERE id = ?").get(potId) as {
      contact_id: number | null;
      share_pct: number | null;
    };
    if (contactId === null && cfg?.contact_id) contactId = cfg.contact_id;
    if (share === 0 && cfg?.share_pct != null && contactId !== null) {
      share = Math.round((Math.abs(amount) * cfg.share_pct) / 100);
    }
  }
  if (share !== 0) {
    if (contactId === null) fail("splitting needs --contact-id (or a pot with a share config)");
    if (!db.query("SELECT 1 FROM contacts WHERE id = ?").get(contactId)) fail(`no contact ${contactId}`);
    if (isTransfer) fail("transfers cannot be split with a contact");
  }
  const txnId = db.transaction(() => {
    const row = db.query(
      "INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, status, cleared, review_reason, is_transfer, external_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
    ).get(date, accountId, amount, description, source, enteredBy, status, cleared, uncertain, isTransfer, externalId) as { id: number };
    const ins = db.query("INSERT INTO splits (transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (?, ?, ?, ?, ?)");
    if (share !== 0 && contactId !== null) {
      const userCents = amount + share; // amount negative outflow; contact's share positive dollars
      ins.run(row.id, potId, "user", null, userCents);
      ins.run(row.id, potId, "contact", contactId, -share);
    } else {
      ins.run(row.id, potId, "user", null, amount);
    }
    assertSplitsSum(db, row.id);
    return row.id;
  })();
  const tag = `${status}${isTransfer ? ", transfer" : ""}, ${cleared}`;
  if (share !== 0) {
    console.log(`recorded transaction ${txnId} (${tag}) — split: user ${fmtCents(amount + share)}, contact owes ${fmtCents(share)}`);
  } else {
    console.log(`recorded transaction ${txnId} (${tag})${uncertain ? ` — needs review: ${uncertain}` : ""}`);
  }
} else if (cmd === "assign") {
  const db = openDb();
  const month = flag("month") ?? new Date().toISOString().slice(0, 7);
  const pot = flag("pot");
  const cents = Math.round(parseFloat(flag("cents") ?? "NaN"));
  if (!pot || !Number.isFinite(cents)) usage();
  try {
    const r = assignToPot(db, month, pot, cents);
    console.log(`assigned $${fmtCents(r.cents)} to pot ${r.potId} for ${r.month}`);
  } catch (e) {
    fail((e as Error).message);
  }
} else if (cmd === "recategorize") {
  const db = openDb();
  const id = parseInt(flag("id") ?? "NaN", 10);
  const pot = flag("pot");
  if (!Number.isFinite(id) || !pot) usage();
  const txn = db.query("SELECT id FROM transactions WHERE id = ?").get(id) as { id: number } | null;
  if (!txn) fail(`no transaction ${id}`);
  const potId = mustResolvePot(db, pot!);
  db.query("UPDATE splits SET pot_id = ? WHERE transaction_id = ?").run(potId, id);
  console.log(`transaction ${id} recategorized to pot ${potId}`);
} else if (cmd === "void") {
  const db = openDb();
  const id = parseInt(flag("id") ?? "NaN", 10);
  if (!Number.isFinite(id)) usage();
  const txn = db.query("SELECT id, voided FROM transactions WHERE id = ?").get(id) as { id: number; voided: number } | null;
  if (!txn) fail(`no transaction ${id}`);
  db.query("UPDATE transactions SET voided = 1 WHERE id = ?").run(id);
  console.log(txn!.voided ? `transaction ${id} was already void` : `transaction ${id} voided`);
} else if (cmd === "pot") {
  const db = openDb();
  const [sub, ..._subRest] = rest;
  if (sub === "create") {
    const name = flag("name");
    const group = flag("group") ?? "Life";
    const targetType = (flag("target-type") ?? "average_3mo") as "fixed" | "average_3mo" | "savings";
    const targetCents = Math.round(parseFloat(flag("target-cents") ?? "0"));
    if (!name) usage();
    try {
      const id = createPot(db, {
        name, group, targetType, targetCents,
        contactId: flag("contact-id") ? parseInt(flag("contact-id")!, 10) : undefined,
        sharePct: flag("share-pct") ? parseInt(flag("share-pct")!, 10) : undefined,
      });
      console.log(`created pot ${id} "${name}" (${group}, ${targetType})`);
    } catch (e) {
      fail((e as Error).message);
    }
  } else if (sub === "share" || sub === "unshare") {
    const potRef = flag("pot");
    if (!potRef) usage();
    const potId = mustResolvePot(db, potRef);
    try {
      if (sub === "share") {
        const contactId = parseInt(flag("contact-id") ?? "NaN", 10);
        if (!Number.isFinite(contactId)) usage();
        updatePot(db, potId, {
          contactId,
          sharePct: flag("share-pct") ? parseInt(flag("share-pct")!, 10) : undefined,
        });
        console.log(`pot ${potId} now shared`);
      } else {
        updatePot(db, potId, { contactId: null });
        console.log(`pot ${potId} no longer shared`);
      }
    } catch (e) {
      fail((e as Error).message);
    }
  } else if (sub === "delete") {
    const potRef = flag("pot");
    if (!potRef) usage();
    const potId = mustResolvePot(db, potRef);
    try {
      const s = deletePot(db, potId);
      console.log(`deleted pot ${potId}; ${s.movedTransactions} transactions and ${s.movedAssignments} assignments moved to Uncategorized (pot ${s.uncategorizedPotId})`);
    } catch (e) {
      fail((e as Error).message);
    }
  } else if (sub === "rename" || sub === "retire" || sub === "unhide") {
    const potRef = flag("pot");
    if (!potRef) usage();
    const potId = mustResolvePot(db, potRef);
    if (sub === "rename") {
      const name = flag("name");
      if (!name) usage();
      db.query("UPDATE pots SET name = ? WHERE id = ?").run(name, potId);
      console.log(`renamed pot ${potId} to "${name}"`);
    } else {
      db.query("UPDATE pots SET hidden = ? WHERE id = ?").run(sub === "retire" ? 1 : 0, potId);
      console.log(`${sub === "retire" ? "retired" : "unhid"} pot ${potId}`);
    }
  } else {
    usage();
  }
} else if (cmd === "contact") {
  const db = openDb();
  const [sub, ..._cRest] = rest;
  if (sub === "list") {
    const bals = contactBalances(db);
    if (bals.length === 0) console.log("no contacts");
    for (const b of bals) {
      console.log(`${b.id} "${b.name}" — owes $${fmtCents(b.totalOwedCents)}, credit $${fmtCents(b.creditCents)}`);
    }
  } else if (sub === "add") {
    const name = flag("name");
    if (!name) usage();
    try {
      const id = createContact(db, name);
      console.log(`created contact ${id} "${name}"`);
    } catch (e) {
      fail((e as Error).message);
    }
  } else if (sub === "rename" || sub === "delete") {
    const contactId = parseInt(flag("contact") ?? "NaN", 10);
    if (!Number.isFinite(contactId)) usage();
    try {
      if (sub === "rename") {
        const name = flag("name");
        if (!name) usage();
        renameContact(db, contactId, name);
        console.log(`renamed contact ${contactId} to "${name}"`);
      } else {
        deleteContact(db, contactId);
        console.log(`deleted contact ${contactId}`);
      }
    } catch (e) {
      fail((e as Error).message);
    }
  } else {
    usage();
  }
} else if (cmd === "settle") {
  const db = openDb();
  const accountId = parseInt(flag("account") ?? "NaN", 10);
  const amountCents = Math.round(parseFloat(flag("amount") ?? "NaN") * 100);
  const note = flag("note") ?? undefined;
  if (!Number.isFinite(accountId) || !Number.isFinite(amountCents) || amountCents <= 0) usage();
  const contactId = parseInt(flag("contact") ?? "NaN", 10);
  if (!Number.isFinite(contactId)) usage();
  const contact = db.query("SELECT name FROM contacts WHERE id = ?").get(contactId) as { name: string } | null;
  if (!contact) fail(`no contact ${contactId}`);
  const before = contactOwed(db, contactId).reduce((a, o) => a + o.owedCents, 0);
  const { allocations, creditAllocations, creditConsumedCents, leftoverCents } = applySettlement(db, { contactId, accountId, amountCents, note });
  console.log(`settlement of $${fmtCents(amountCents)} recorded (cleared, confirmed).`);
  for (const a of creditAllocations) console.log(`  credit ${(a.amountCents / 100).toFixed(2)} -> ${a.potName ?? "Uncategorized"}`);
  for (const a of allocations) console.log(`  filled ${(a.amountCents / 100).toFixed(2)} -> ${a.potName ?? "Uncategorized"}`);
  if (leftoverCents > 0) console.log(`  $${fmtCents(leftoverCents)} left over — credit for next time`);
  if (creditConsumedCents > 0) console.log(`  $${fmtCents(creditConsumedCents)} of prior credit consumed`);
  console.log(`${contact.name} owed before: $${fmtCents(before)}`);
} else if (cmd === "reconcile") {
  const db = openDb();
  const accountId = parseInt(flag("account") ?? "NaN", 10);
  const actual = Math.round(parseFloat(flag("balance") ?? "NaN") * 100);
  if (!Number.isFinite(accountId) || !Number.isFinite(actual)) usage();
  const clearedRow = db.query("SELECT COALESCE(SUM(amount_cents),0) AS total FROM transactions WHERE account_id = ? AND cleared IN ('cleared','reconciled') AND voided = 0").get(accountId) as { total: number };
  const result = reconcile({ clearedBalanceCents: clearedRow.total, actualBalanceCents: actual });
  console.log(`cleared balance: $${fmtCents(clearedRow.total)}  actual: $${fmtCents(actual)}  difference: $${fmtCents(result.differenceCents)}`);
  if (result.balanced) {
    db.query("UPDATE transactions SET cleared = 'reconciled' WHERE account_id = ? AND cleared = 'cleared'").run(accountId);
    db.query("INSERT INTO reconciliations (account_id, actual_balance_cents, budget_balance_cents, difference_cents) VALUES (?, ?, ?, 0)").run(accountId, actual, clearedRow.total);
    console.log("balanced — transactions reconciled.");
  } else {
    const uncleared = db.query("SELECT id, date, description, amount_cents FROM transactions WHERE account_id = ? AND cleared = 'uncleared' AND voided = 0 ORDER BY id").all(accountId) as any[];
    const suggestion = suggestClear(uncleared, result.differenceCents);
    if (suggestion) console.log(`transaction ${suggestion} exactly explains the difference — did it post?`);
    for (const t of uncleared) console.log(`  uncleared: ${t.id} $${fmtCents(t.amount_cents)} ${t.description}`);
  }
} else if (cmd === "review") {
  const db = openDb();
  const rows = db.query("SELECT id, date, amount_cents, description, source FROM transactions WHERE status = 'pending_review' AND voided = 0 ORDER BY id").all();
  if (rows.length === 0) console.log("nothing pending review");
  else for (const r of rows as any[]) console.log(`${r.id}  ${r.date}  $${fmtCents(r.amount_cents)}  ${r.description}  [${r.source}]`);
} else if (cmd === "close") {
  const db = openDb();
  const month = flag("month") ?? new Date().toISOString().slice(0, 7);
  if (!validMonth(month)) fail(`bad --month "${month}"; expected YYYY-MM`);
  const p = closePreview(db, month);
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
    const next = l.wireframeSkipped ? `schedule $${fmtCents(l.wireframeCents)} (target not written)` : `next $${fmtCents(l.wireframeCents)}`;
    console.log(`    ${l.name} (${l.targetType}${l.assignable ? "" : ", income, no wireframe"}): spent $${fmtCents(l.spentCents)} / target $${fmtCents(l.targetCents)} -> ${next}`);
  }
  if (rest.includes("--apply")) {
    try {
      applyClose(db, p);
      console.log(`applied: close recorded for ${p.month}, ${p.nextMonth} targets wireframed.`);
    } catch (e) {
      console.error(`cannot apply: ${(e as Error).message}`);
      process.exit(1);
    }
  } else {
    console.log(`preview only; add --apply to record the close and wireframe ${p.nextMonth}.`);
  }
} else if (cmd === "sinking") {
  const db = openDb();
  const [sub, ..._sRest] = rest;
  if (sub === "add") {
    const pot = flag("pot");
    const expectedCents = Math.round(parseFloat(flag("expected") ?? "NaN") * 100);
    const due = flag("due");
    const cadence = flag("cadence") ? parseInt(flag("cadence")!, 10) : 12;
    if (!pot || !Number.isFinite(expectedCents) || !due) usage();
    try {
      const s = createSchedule(db, pot!, expectedCents, due!, cadence);
      const st = sinkingStatus(db, s.potId, new Date().toISOString().slice(0, 7))!;
      console.log(`schedule ${s.id}: "${s.potName}" expects $${fmtCents(s.expectedCents)}, due ${s.dueMonth} (every ${s.cadenceMonths}mo) — $${fmtCents(st.contributionCents)}/mo from here`);
    } catch (e) {
      fail((e as Error).message);
    }
  } else if (sub === "list") {
    const month = flag("month") ?? new Date().toISOString().slice(0, 7);
    if (!validMonth(month)) fail(`bad --month "${month}"; expected YYYY-MM`);
    const rows = listSchedules(db);
    if (rows.length === 0) console.log("no sinking schedules");
    for (const s of rows) {
      const st = sinkingStatus(db, s.potId, month)!;
      const state = st.state === "funded" ? "funded" : st.state === "overdue" ? "OVERDUE" : "funding";
      console.log(`${s.id} "${s.potName}": $${fmtCents(s.expectedCents)} due ${s.dueMonth} — $${fmtCents(st.contributionCents)}/mo for ${month} (saved $${fmtCents(st.balanceCents)}, ${st.monthsLeft}mo left) [${state}]`);
    }
  } else if (sub === "paid") {
    const pot = flag("pot");
    if (!pot) usage();
    try {
      const s = markPaid(db, pot!);
      console.log(`"${s.potName}" marked paid — next due ${s.dueMonth}`);
    } catch (e) {
      fail((e as Error).message);
    }
  } else if (sub === "remove") {
    const pot = flag("pot");
    if (!pot) usage();
    try {
      removeSchedule(db, pot!);
      console.log(`schedule removed for "${pot}"`);
    } catch (e) {
      fail((e as Error).message);
    }
  } else {
    usage();
  }
} else if (cmd === "serve") {
  const { startServer } = await import("./server");
  startServer();
} else {
  usage();
}
