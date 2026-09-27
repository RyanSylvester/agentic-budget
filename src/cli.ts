/** `budget` — the agent's write path. Every command here is something the agent
 *  runs instead of clicking through a UI.
 *
 *  Usage:
 *    bun src/cli.ts record --account 1 --amount -12.50 --description "Voila groceries" --source mention [--cleared] [--pot 5] [--lilly-cents 625]
 *    bun src/cli.ts settle --account 1 --amount 2000 --note "Lilly e-transfer"   # her lump sum fills her buckets, oldest first
 *    bun src/cli.ts review            # list pending_review transactions
 *    bun src/cli.ts reconcile --account 1 --balance 1234.56
 *    bun src/cli.ts close --month 2026-09   # preview the month-end close
 *    bun src/cli.ts serve             # start the dashboard
 */
import { openDb } from "./db";
import { reconcile, suggestClear } from "./reconcile";
import { applySettlement, lillyOwed } from "./settle";

function usage(): never {
  console.error("usage: budget <record|settle|review|reconcile|close|serve> [options]");
  process.exit(2);
}

const [cmd, ...rest] = Bun.argv.slice(2);
if (!cmd) usage();

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

if (cmd === "record") {
  const db = openDb();
  const amount = Math.round(parseFloat(flag("amount") ?? "NaN") * 100);
  const description = flag("description") ?? "";
  const accountId = parseInt(flag("account") ?? "NaN", 10);
  const source = (flag("source") ?? "manual") as "gmail" | "mention" | "manual";
  const cleared = rest.includes("--cleared") ? "cleared" : "uncleared";
  const potId = flag("pot") ? parseInt(flag("pot")!, 10) : null;
  if (!Number.isFinite(amount) || !description || !Number.isFinite(accountId)) usage();
  const row = db.query("INSERT INTO transactions (date, account_id, amount_cents, description, source, entered_by, cleared) VALUES (date('now'), ?, ?, ?, ?, 'agent', ?) RETURNING id").get(accountId, amount, description, source, cleared) as { id: number };
  // Splits: Ryan's share counts in his views; Lilly's share is expected (owed).
  const lilly = flag("lilly-cents") ? Math.round(parseFloat(flag("lilly-cents")!) * 100) : 0;
  const ins = db.query("INSERT INTO splits (transaction_id, pot_id, owner, amount_cents) VALUES (?, ?, ?, ?)");
  if (lilly !== 0) {
    const ryanCents = amount + lilly; // amount negative outflow; Lilly's share positive dollars
    ins.run(row.id, potId, "ryan", ryanCents);
    ins.run(row.id, potId, "lilly", -lilly);
    console.log(`recorded transaction ${row.id} (pending_review, ${cleared}) — split: Ryan ${(ryanCents / 100).toFixed(2)}, Lilly owes ${(lilly / 100).toFixed(2)}`);
  } else {
    ins.run(row.id, potId, "ryan", amount);
    console.log(`recorded transaction ${row.id} (pending_review, ${cleared})`);
  }
} else if (cmd === "settle") {
  const db = openDb();
  const accountId = parseInt(flag("account") ?? "NaN", 10);
  const amountCents = Math.round(parseFloat(flag("amount") ?? "NaN") * 100);
  const note = flag("note") ?? "Lilly settlement";
  if (!Number.isFinite(accountId) || !Number.isFinite(amountCents) || amountCents <= 0) usage();
  const before = lillyOwed(db).reduce((a, o) => a + o.owedCents, 0);
  const { allocations, leftoverCents } = applySettlement(db, { accountId, amountCents, note });
  console.log(`settlement of ${(amountCents / 100).toFixed(2)} recorded (cleared, confirmed).`);
  for (const a of allocations) console.log(`  filled ${(a.amountCents / 100).toFixed(2)} -> ${a.potName ?? "Uncategorized"}`);
  if (leftoverCents > 0) console.log(`  ${(leftoverCents / 100).toFixed(2)} left over — credit for next time`);
  console.log(`Lilly owed before: ${(before / 100).toFixed(2)}`);
} else if (cmd === "reconcile") {
  const db = openDb();
  const accountId = parseInt(flag("account") ?? "NaN", 10);
  const actual = Math.round(parseFloat(flag("balance") ?? "NaN") * 100);
  if (!Number.isFinite(accountId) || !Number.isFinite(actual)) usage();
  const clearedRow = db.query("SELECT COALESCE(SUM(amount_cents),0) AS total FROM transactions WHERE account_id = ? AND cleared IN ('cleared','reconciled')").get(accountId) as { total: number };
  const result = reconcile({ clearedBalanceCents: clearedRow.total, actualBalanceCents: actual });
  console.log(`cleared balance: ${(clearedRow.total / 100).toFixed(2)}  actual: ${(actual / 100).toFixed(2)}  difference: ${(result.differenceCents / 100).toFixed(2)}`);
  if (result.balanced) {
    db.query("UPDATE transactions SET cleared = 'reconciled' WHERE account_id = ? AND cleared = 'cleared'").run(accountId);
    db.query("INSERT INTO reconciliations (account_id, actual_balance_cents, budget_balance_cents, difference_cents) VALUES (?, ?, ?, 0)").run(accountId, actual, clearedRow.total);
    console.log("balanced — transactions reconciled.");
  } else {
    const uncleared = db.query("SELECT id, date, description, amount_cents FROM transactions WHERE account_id = ? AND cleared = 'uncleared' ORDER BY id").all(accountId) as any[];
    const suggestion = suggestClear(uncleared, result.differenceCents);
    if (suggestion) console.log(`transaction ${suggestion} exactly explains the difference — did it post?`);
    for (const t of uncleared) console.log(`  uncleared: ${t.id} ${(t.amount_cents / 100).toFixed(2)} ${t.description}`);
  }
} else if (cmd === "review") {
  const db = openDb();
  const rows = db.query("SELECT id, date, amount_cents, description, source FROM transactions WHERE status = 'pending_review' ORDER BY id").all();
  if (rows.length === 0) console.log("nothing pending review");
  else for (const r of rows as any[]) console.log(`${r.id}  ${r.date}  ${(r.amount_cents / 100).toFixed(2)}  ${r.description}  [${r.source}]`);
} else if (cmd === "close") {
  const month = flag("month") ?? new Date().toISOString().slice(0, 7);
  console.log(`month-end close preview for ${month}: not yet wired to live data (see src/close.ts)`);
} else if (cmd === "serve") {
  await import("./server");
} else {
  usage();
}
