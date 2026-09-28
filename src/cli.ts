/** `budget` — the agent's write path. Every command here is something the agent
 *  runs instead of clicking through a UI.
 *
 *  Usage:
 *    bun src/cli.ts record --account 1 --amount -12.50 --description "Voila groceries" --source mention [--date 2026-09-26] [--cleared] [--pot 5] [--contact-id 1] [--share-cents 625] [--uncertain "unsure which pot"] [--transfer] [--external-id stmt-abc123]
 *    bun src/cli.ts assign --month 2026-09 --pot Groceries --cents 60000
 *    bun src/cli.ts assign scaffold --month 2026-10 [--strategy average_3mo|last_month] [--dry-run]
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
 *    bun src/cli.ts migration new add_water_bill   # stamp a new timestamped migration file (version comes from the clock)
 *    bun src/cli.ts migrate-remote    # ensure D1 schema, wipe remote data, re-import local budget.db (re-runnable; read-only on local)
 *    bun src/cli.ts serve             # start the dashboard
 *    bun src/cli.ts login --api-url https://daybook.example.workers.dev   # store the agent token for remote mode
 *
 *  Remote mode: with BUDGET_API_URL set (or ~/.config/agentic-budget/config.json
 *  written by `login`), every command above except `migration new` and `serve`
 *  runs against the hosted Worker instead of the local budget.db.
 */
import { openDb } from "./db";
import type { Db } from "./db-interface";
import { reconcile, suggestClear } from "./reconcile";
import { applySettlement, contactOwed } from "./settle";
import { closePreview, applyClose } from "./close";
import { assignToPot } from "./assign";
import { contactBalances, createContact, deleteContact, listContacts, renameContact } from "./contacts";
import { createPot, deletePot, updatePot } from "./pots";
import { createSchedule, listSchedules, markPaid, removeSchedule, sinkingStatus } from "./sinking";
import { createMigration } from "./migrations";
import { assertSplitsSum, resolvePotId, validDate, validMonth, fmtCents, FIRST_USER } from "./money";
import { scaffoldMonth, type ScaffoldStrategy } from "./scaffold";
import { loadRemoteConfig, saveRemoteConfig, promptHidden, configPath } from "./remote";
import { runRemote, printScaffold, printClosePreview } from "./cli-remote";

function usage(): never {
  console.error("usage: budget <record|assign|recategorize|void|pot|contact|settle|review|reconcile|close|sinking|user|migration|migrate-remote|serve|login> [options]");
  process.exit(2);
}

const [cmd, ...rest] = Bun.argv.slice(2);
if (!cmd) usage();

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

function fail(msg: string): never {
  // M1: every write attributes its row to the first user. On a database with
  // no user yet this surfaces as a raw NOT NULL failure; point at the fix.
  if (msg.includes("NOT NULL constraint failed") && msg.includes(".user_id")) {
    msg += "\nNo user exists yet: run `budget user create <username>` first.";
  }
  console.error(msg);
  process.exit(1);
}

async function mustResolvePot(db: Db, ref: string): Promise<number> {
  try {
    return await resolvePotId(db, ref);
  } catch (e) {
    fail((e as Error).message);
  }
}

async function main() {
  if (cmd === "login") {
    const apiUrl = flag("api-url") ?? loadRemoteConfig()?.apiUrl;
    if (!apiUrl) fail(`usage: budget login --api-url <worker-url>`);
    const token = await promptHidden("agent token: ");
    if (!token) fail("no token entered; nothing saved");
    saveRemoteConfig(apiUrl, token);
    console.log(`saved remote config for ${apiUrl} (${configPath()})`);
    return;
  }
  const remote = loadRemoteConfig();
  if (remote) {
    // migrate-remote is mode-independent (it pushes local budget.db to D1
    // directly, never through the Worker API), so it stays available.
    if (cmd === "migration" || cmd === "serve" || cmd === "user") {
      fail(`"${cmd}" is local-only: it works on files on this machine, not the hosted Worker. Unset BUDGET_API_URL to run it locally.`);
    }
    await runRemote(remote, cmd, rest);
    return;
  }
  if (cmd === "record") {
    const db = await openDb();
    const amount = Math.round(parseFloat(flag("amount") ?? "NaN") * 100);
    const description = flag("description") ?? "";
    const accountId = parseInt(flag("account") ?? "NaN", 10);
    const source = (flag("source") ?? "manual") as "gmail" | "mention" | "manual";
    const cleared = rest.includes("--cleared") ? "cleared" : "uncleared";
    const potId = flag("pot") ? await mustResolvePot(db, flag("pot")!) : null;
    const uncertain = flag("uncertain") ?? null; // reason the agent wasn't sure
    const isTransfer = rest.includes("--transfer") ? 1 : 0;
    const date = flag("date") ?? new Date().toISOString().slice(0, 10);
    const externalId = flag("external-id") ?? null;
    if (!Number.isFinite(amount) || !description || !Number.isFinite(accountId)) usage();
    if (!validDate(date)) fail(`bad --date "${date}"; expected YYYY-MM-DD`);
    if (externalId) {
      const dup = await db.get<{ id: number }>("SELECT id FROM transactions WHERE external_id = ?", externalId);
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
      const cfg = await db.get<{ contact_id: number | null; share_pct: number | null }>(
        "SELECT contact_id, share_pct FROM pots WHERE id = ?",
        potId
      );
      if (contactId === null && cfg?.contact_id) contactId = cfg.contact_id;
      if (share === 0 && cfg?.share_pct != null && contactId !== null) {
        share = Math.round((Math.abs(amount) * cfg.share_pct) / 100);
      }
    }
    if (share !== 0) {
      if (contactId === null) fail("splitting needs --contact-id (or a pot with a share config)");
      if (!(await db.get("SELECT 1 FROM contacts WHERE id = ?", contactId))) fail(`no contact ${contactId}`);
      if (isTransfer) fail("transfers cannot be split with a contact");
    }
    // Sequential awaits, not a transaction: the single writer is the only
    // writer, so the read-then-write sequence cannot interleave.
    const row = (await db.get<{ id: number }>(
      `INSERT INTO transactions (user_id, date, account_id, amount_cents, description, source, entered_by, status, cleared, review_reason, is_transfer, external_id) VALUES (${FIRST_USER}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      date, accountId, amount, description, source, enteredBy, status, cleared, uncertain, isTransfer, externalId
    ))!;
    if (share !== 0 && contactId !== null) {
      const userCents = amount + share; // amount negative outflow; contact's share positive dollars
      await db.run(`INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (${FIRST_USER}, ?, ?, ?, ?, ?)`, row.id, potId, "user", null, userCents);
      await db.run(`INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (${FIRST_USER}, ?, ?, ?, ?, ?)`, row.id, potId, "contact", contactId, -share);
    } else {
      await db.run(`INSERT INTO splits (user_id, transaction_id, pot_id, owner, contact_id, amount_cents) VALUES (${FIRST_USER}, ?, ?, ?, ?, ?)`, row.id, potId, "user", null, amount);
    }
    await assertSplitsSum(db, row.id);
    const txnId = row.id;
    const tag = `${status}${isTransfer ? ", transfer" : ""}, ${cleared}`;
    if (share !== 0) {
      console.log(`recorded transaction ${txnId} (${tag}) — split: user ${fmtCents(amount + share)}, contact owes ${fmtCents(share)}`);
    } else {
      console.log(`recorded transaction ${txnId} (${tag})${uncertain ? ` — needs review: ${uncertain}` : ""}`);
    }
  } else if (cmd === "assign") {
    const db = await openDb();
    if (rest[0] === "scaffold") {
      const srest = rest.slice(1);
      const sflag = (name: string): string | undefined => {
        const i = srest.indexOf(`--${name}`);
        return i >= 0 ? srest[i + 1] : undefined;
      };
      const month = sflag("month") ?? new Date().toISOString().slice(0, 7);
      const strategy = (sflag("strategy") ?? "average_3mo") as ScaffoldStrategy;
      const dryRun = srest.includes("--dry-run");
      try {
        const lines = await scaffoldMonth(db, month, strategy, dryRun);
        printScaffold(month, strategy, dryRun, lines);
      } catch (e) {
        fail((e as Error).message);
      }
      return;
    }
    const month = flag("month") ?? new Date().toISOString().slice(0, 7);
    const pot = flag("pot");
    const cents = Math.round(parseFloat(flag("cents") ?? "NaN"));
    if (!pot || !Number.isFinite(cents)) usage();
    try {
      const r = await assignToPot(db, month, pot, cents);
      console.log(`assigned $${fmtCents(r.cents)} to pot ${r.potId} for ${r.month}`);
    } catch (e) {
      fail((e as Error).message);
    }
  } else if (cmd === "recategorize") {
    const db = await openDb();
    const id = parseInt(flag("id") ?? "NaN", 10);
    const pot = flag("pot");
    if (!Number.isFinite(id) || !pot) usage();
    const txn = await db.get<{ id: number }>("SELECT id FROM transactions WHERE id = ?", id);
    if (!txn) fail(`no transaction ${id}`);
    const potId = await mustResolvePot(db, pot!);
    await db.run("UPDATE splits SET pot_id = ? WHERE transaction_id = ?", potId, id);
    console.log(`transaction ${id} recategorized to pot ${potId}`);
  } else if (cmd === "void") {
    const db = await openDb();
    const id = parseInt(flag("id") ?? "NaN", 10);
    if (!Number.isFinite(id)) usage();
    const txn = await db.get<{ id: number; voided: number }>("SELECT id, voided FROM transactions WHERE id = ?", id);
    if (!txn) fail(`no transaction ${id}`);
    await db.run("UPDATE transactions SET voided = 1 WHERE id = ?", id);
    console.log(txn!.voided ? `transaction ${id} was already void` : `transaction ${id} voided`);
  } else if (cmd === "pot") {
    const db = await openDb();
    const [sub, ..._subRest] = rest;
    if (sub === "create") {
      const name = flag("name");
      const group = flag("group") ?? "Life";
      const targetType = (flag("target-type") ?? "average_3mo") as "fixed" | "average_3mo" | "savings";
      const targetCents = Math.round(parseFloat(flag("target-cents") ?? "0"));
      if (!name) usage();
      try {
        const id = await createPot(db, {
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
      const potId = await mustResolvePot(db, potRef);
      try {
        if (sub === "share") {
          const contactId = parseInt(flag("contact-id") ?? "NaN", 10);
          if (!Number.isFinite(contactId)) usage();
          await updatePot(db, potId, {
            contactId,
            sharePct: flag("share-pct") ? parseInt(flag("share-pct")!, 10) : undefined,
          });
          console.log(`pot ${potId} now shared`);
        } else {
          await updatePot(db, potId, { contactId: null });
          console.log(`pot ${potId} no longer shared`);
        }
      } catch (e) {
        fail((e as Error).message);
      }
    } else if (sub === "delete") {
      const potRef = flag("pot");
      if (!potRef) usage();
      const potId = await mustResolvePot(db, potRef);
      try {
        const s = await deletePot(db, potId);
        console.log(`deleted pot ${potId}; ${s.movedTransactions} transactions and ${s.movedAssignments} assignments moved to Uncategorized (pot ${s.uncategorizedPotId})`);
      } catch (e) {
        fail((e as Error).message);
      }
    } else if (sub === "rename" || sub === "retire" || sub === "unhide") {
      const potRef = flag("pot");
      if (!potRef) usage();
      const potId = await mustResolvePot(db, potRef);
      if (sub === "rename") {
        const name = flag("name");
        if (!name) usage();
        await db.run("UPDATE pots SET name = ? WHERE id = ?", name, potId);
        console.log(`renamed pot ${potId} to "${name}"`);
      } else {
        await db.run("UPDATE pots SET hidden = ? WHERE id = ?", sub === "retire" ? 1 : 0, potId);
        console.log(`${sub === "retire" ? "retired" : "unhid"} pot ${potId}`);
      }
    } else {
      usage();
    }
  } else if (cmd === "contact") {
    const db = await openDb();
    const [sub, ..._cRest] = rest;
    if (sub === "list") {
      const bals = await contactBalances(db);
      if (bals.length === 0) console.log("no contacts");
      for (const b of bals) {
        console.log(`${b.id} "${b.name}" — owes $${fmtCents(b.totalOwedCents)}, credit $${fmtCents(b.creditCents)}`);
      }
    } else if (sub === "add") {
      const name = flag("name");
      if (!name) usage();
      try {
        const id = await createContact(db, name);
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
          await renameContact(db, contactId, name);
          console.log(`renamed contact ${contactId} to "${name}"`);
        } else {
          await deleteContact(db, contactId);
          console.log(`deleted contact ${contactId}`);
        }
      } catch (e) {
        fail((e as Error).message);
      }
    } else {
      usage();
    }
  } else if (cmd === "settle") {
    const db = await openDb();
    const accountId = parseInt(flag("account") ?? "NaN", 10);
    const amountCents = Math.round(parseFloat(flag("amount") ?? "NaN") * 100);
    const note = flag("note") ?? undefined;
    if (!Number.isFinite(accountId) || !Number.isFinite(amountCents) || amountCents <= 0) usage();
    const contactId = parseInt(flag("contact") ?? "NaN", 10);
    if (!Number.isFinite(contactId)) usage();
    const contact = await db.get<{ name: string }>("SELECT name FROM contacts WHERE id = ?", contactId);
    if (!contact) fail(`no contact ${contactId}`);
    const before = (await contactOwed(db, contactId)).reduce((a, o) => a + o.owedCents, 0);
    const { allocations, creditAllocations, creditConsumedCents, leftoverCents } = await applySettlement(db, { contactId, accountId, amountCents, note });
    console.log(`settlement of $${fmtCents(amountCents)} recorded (cleared, confirmed).`);
    for (const a of creditAllocations) console.log(`  credit ${(a.amountCents / 100).toFixed(2)} -> ${a.potName ?? "Uncategorized"}`);
    for (const a of allocations) console.log(`  filled ${(a.amountCents / 100).toFixed(2)} -> ${a.potName ?? "Uncategorized"}`);
    if (leftoverCents > 0) console.log(`  $${fmtCents(leftoverCents)} left over — credit for next time`);
    if (creditConsumedCents > 0) console.log(`  $${fmtCents(creditConsumedCents)} of prior credit consumed`);
    console.log(`${contact.name} owed before: $${fmtCents(before)}`);
  } else if (cmd === "reconcile") {
    const db = await openDb();
    const accountId = parseInt(flag("account") ?? "NaN", 10);
    const actual = Math.round(parseFloat(flag("balance") ?? "NaN") * 100);
    if (!Number.isFinite(accountId) || !Number.isFinite(actual)) usage();
    const clearedRow = (await db.get<{ total: number }>("SELECT COALESCE(SUM(amount_cents),0) AS total FROM transactions WHERE account_id = ? AND cleared IN ('cleared','reconciled') AND voided = 0", accountId))!;
    const result = reconcile({ clearedBalanceCents: clearedRow.total, actualBalanceCents: actual });
    console.log(`cleared balance: $${fmtCents(clearedRow.total)}  actual: $${fmtCents(actual)}  difference: $${fmtCents(result.differenceCents)}`);
    if (result.balanced) {
      await db.run("UPDATE transactions SET cleared = 'reconciled' WHERE account_id = ? AND cleared = 'cleared'", accountId);
      await db.run(`INSERT INTO reconciliations (user_id, account_id, actual_balance_cents, budget_balance_cents, difference_cents) VALUES (${FIRST_USER}, ?, ?, ?, 0)`, accountId, actual, clearedRow.total);
      console.log("balanced — transactions reconciled.");
    } else {
      const uncleared = await db.all<any>("SELECT id, date, description, amount_cents FROM transactions WHERE account_id = ? AND cleared = 'uncleared' AND voided = 0 ORDER BY id", accountId);
      const suggestion = suggestClear(uncleared, result.differenceCents);
      if (suggestion) console.log(`transaction ${suggestion} exactly explains the difference — did it post?`);
      for (const t of uncleared) console.log(`  uncleared: ${t.id} $${fmtCents(t.amount_cents)} ${t.description}`);
    }
  } else if (cmd === "review") {
    const db = await openDb();
    const rows = await db.all<any>("SELECT id, date, amount_cents, description, source FROM transactions WHERE status = 'pending_review' AND voided = 0 ORDER BY id");
    if (rows.length === 0) console.log("nothing pending review");
    else for (const r of rows) console.log(`${r.id}  ${r.date}  $${fmtCents(r.amount_cents)}  ${r.description}  [${r.source}]`);
  } else if (cmd === "close") {
    const db = await openDb();
    const month = flag("month") ?? new Date().toISOString().slice(0, 7);
    if (!validMonth(month)) fail(`bad --month "${month}"; expected YYYY-MM`);
    const p = await closePreview(db, month);
    printClosePreview(p);
    if (rest.includes("--apply")) {
      try {
        await applyClose(db, p);
        console.log(`applied: close recorded for ${p.month}, ${p.nextMonth} targets wireframed.`);
      } catch (e) {
        console.error(`cannot apply: ${(e as Error).message}`);
        process.exit(1);
      }
    } else {
      console.log(`preview only; add --apply to record the close and wireframe ${p.nextMonth}.`);
    }
  } else if (cmd === "sinking") {
    const db = await openDb();
    const [sub, ..._sRest] = rest;
    if (sub === "add") {
      const pot = flag("pot");
      const expectedCents = Math.round(parseFloat(flag("expected") ?? "NaN") * 100);
      const due = flag("due");
      const cadence = flag("cadence") ? parseInt(flag("cadence")!, 10) : 12;
      if (!pot || !Number.isFinite(expectedCents) || !due) usage();
      try {
        const s = await createSchedule(db, pot!, expectedCents, due!, cadence);
        const st = (await sinkingStatus(db, s.potId, new Date().toISOString().slice(0, 7)))!;
        console.log(`schedule ${s.id}: "${s.potName}" expects $${fmtCents(s.expectedCents)}, due ${s.dueMonth} (every ${s.cadenceMonths}mo), $${fmtCents(st.contributionCents)}/mo from here`);
      } catch (e) {
        fail((e as Error).message);
      }
    } else if (sub === "list") {
      const month = flag("month") ?? new Date().toISOString().slice(0, 7);
      if (!validMonth(month)) fail(`bad --month "${month}"; expected YYYY-MM`);
      const rows = await listSchedules(db);
      if (rows.length === 0) console.log("no sinking schedules");
      for (const s of rows) {
        const st = (await sinkingStatus(db, s.potId, month))!;
        const state = st.state === "funded" ? "funded" : st.state === "overdue" ? "OVERDUE" : "funding";
        console.log(`${s.id} "${s.potName}": $${fmtCents(s.expectedCents)} due ${s.dueMonth}, $${fmtCents(st.contributionCents)}/mo for ${month} (saved $${fmtCents(st.balanceCents)}, ${st.monthsLeft}mo left) [${state}]`);
      }
    } else if (sub === "paid") {
      const pot = flag("pot");
      if (!pot) usage();
      try {
        const s = await markPaid(db, pot!);
        console.log(`"${s.potName}" marked paid, next due ${s.dueMonth}`);
      } catch (e) {
        fail((e as Error).message);
      }
    } else if (sub === "remove") {
      const pot = flag("pot");
      if (!pot) usage();
      try {
        await removeSchedule(db, pot!);
        console.log(`schedule removed for "${pot}"`);
      } catch (e) {
        fail((e as Error).message);
      }
    } else {
      usage();
    }
  } else if (cmd === "user") {
    const [sub, username] = rest;
    if (sub === "create") {
      if (!username) fail(`usage: budget user create <username>`);
      try {
        const { createLocalUser } = await import("./users");
        const id = await createLocalUser(username);
        console.log(`created user "${username}" (id ${id})`);
      } catch (e) {
        fail((e as Error).message);
      }
    } else {
      usage();
    }
  } else if (cmd === "migration") {
    const [sub, name] = rest;
    if (sub === "new") {
      if (!name) fail(`usage: budget migration new <name>`);
      try {
        const path = createMigration(name);
        console.log(`created ${path}`);
      } catch (e) {
        fail((e as Error).message);
      }
    } else {
      usage();
    }
  } else if (cmd === "migrate-remote") {
    const { migrateRemote } = await import("./migrate-remote");
    await migrateRemote();
  } else if (cmd === "serve") {
    const { startServer } = await import("./server");
    startServer();
  } else {
    usage();
  }
}

await main().catch((e) => fail((e as Error).message));
