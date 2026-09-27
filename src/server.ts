/** Dashboard server: JSON API + serves the built React client.
 *  Start with `bun src/cli.ts serve` (or `bun src/server.ts`). API under /api/*, client at /. */
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { openDb } from "./db";
import { monthSpend, potSpend, potInflow, recentTransactions, listTransactions, spendTrend, assignedTotal, rtaCents, potHistory } from "./queries";
import { applySettlement, contactCredit, contactOwed } from "./settle";
import { contactBalances, createContact, renameContact, deleteContact } from "./contacts";
import { createPot, updatePot, deletePot, potExists } from "./pots";
import { reconcile, suggestClear } from "./reconcile";
import { closePreview, applyClose } from "./close";
import { assignToPot, assignedToPot } from "./assign";
import { scaffoldMonth, type ScaffoldStrategy } from "./scaffold";
import { createTransaction, updateTransaction } from "./transactions";
import { validMonth } from "./money";

const app = new Hono();

/* Input validation helpers: 400 for bad input, 404 when the row is missing. */

function badId(c: any, param: string): number | null {
  const n = parseInt(c.req.param(param), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function readJson(c: any): Promise<{ ok: boolean; body: any }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: false, body: null };
  }
}

function txnExists(db: ReturnType<typeof openDb>, id: number): boolean {
  return !!db.query("SELECT 1 FROM transactions WHERE id = ?").get(id);
}

app.get("/api/overview", (c) => {
  const db = openDb();
  const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
  const pending = db.query("SELECT COUNT(*) AS n FROM transactions WHERE status = 'pending_review' AND voided = 0").get() as { n: number };
  return c.json({
    month,
    confirmedSpendCents: monthSpend(db, month),
    pendingCount: pending.n,
    recent: recentTransactions(db, 10, month),
    rtaCents: rtaCents(db, month),
    assignedCents: assignedTotal(db, month),
  });
});

app.get("/api/review", (c) => {
  const db = openDb();
  const transactions = db.query(
    `SELECT t.id, t.date, t.description, t.amount_cents, t.source, t.status, t.review_reason,
            COALESCE((SELECT SUM(-s.amount_cents) FROM splits s
                      WHERE s.transaction_id = t.id AND s.owner = 'contact' AND s.amount_cents < 0), 0) AS shared_cents,
            (SELECT c.name FROM splits s JOIN contacts c ON c.id = s.contact_id
             WHERE s.transaction_id = t.id AND s.owner = 'contact' LIMIT 1) AS split_contact_name
     FROM transactions t WHERE t.status = 'pending_review' AND t.voided = 0 ORDER BY t.id`
  ).all();
  return c.json({ transactions });
});

/** Confirm a review item. Body may carry { potId } to recategorize at the same time. */
app.post("/api/review/:id/confirm", async (c) => {
  const db = openDb();
  const id = badId(c, "id");
  if (id === null) return c.json({ error: "bad transaction id" }, 400);
  if (!txnExists(db, id)) return c.json({ error: `no transaction ${id}` }, 404);
  const { ok, body } = await readJson(c);
  if (!ok) return c.json({ error: "malformed JSON" }, 400);
  db.transaction(() => {
    if (body?.potId !== undefined && body?.potId !== null) {
      const potId = Number(body.potId);
      if (!Number.isInteger(potId) || potId <= 0) throw new Error("bad potId");
      if (!db.query("SELECT 1 FROM pots WHERE id = ?").get(potId)) throw new Error(`no pot ${potId}`);
      db.query("UPDATE splits SET pot_id = ? WHERE transaction_id = ?").run(potId, id);
    }
    db.query("UPDATE transactions SET status = 'confirmed' WHERE id = ?").run(id);
  })();
  return c.json({ ok: true });
});

/** Recategorize a transaction to another pot. */
app.post("/api/transactions/:id/recategorize", async (c) => {
  const db = openDb();
  const id = badId(c, "id");
  if (id === null) return c.json({ error: "bad transaction id" }, 400);
  if (!txnExists(db, id)) return c.json({ error: `no transaction ${id}` }, 404);
  const { ok, body } = await readJson(c);
  if (!ok) return c.json({ error: "malformed JSON" }, 400);
  const potId = Number(body?.potId);
  if (!Number.isInteger(potId) || potId <= 0) return c.json({ error: "potId required" }, 400);
  if (!db.query("SELECT 1 FROM pots WHERE id = ?").get(potId)) return c.json({ error: `no pot ${potId}` }, 404);
  db.query("UPDATE splits SET pot_id = ? WHERE transaction_id = ?").run(potId, id);
  return c.json({ ok: true });
});

/** Soft-void a transaction: excluded from spend, inflows, and RTA, kept for audit. */
app.post("/api/transactions/:id/void", (c) => {
  const db = openDb();
  const id = badId(c, "id");
  if (id === null) return c.json({ error: "bad transaction id" }, 400);
  if (!txnExists(db, id)) return c.json({ error: `no transaction ${id}` }, 404);
  db.query("UPDATE transactions SET voided = 1 WHERE id = ?").run(id);
  return c.json({ ok: true });
});

/** Assign dollars to a pot for a month. Body: { month: "YYYY-MM", potId, cents }. */
app.post("/api/assign", async (c) => {
  const db = openDb();
  const { ok, body } = await readJson(c);
  if (!ok) return c.json({ error: "malformed JSON" }, 400);
  const { month, potId, cents } = body ?? {};
  try {
    const r = assignToPot(db, month, potId, cents);
    return c.json({ ok: true, ...r });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

/** Bulk-fill a month's assignments from history. Body: { month: "YYYY-MM",
 *  strategy: "average_3mo" | "last_month" | "target", dryRun?: boolean }.
 *  With dryRun the computed lines are returned without writing anything. */
app.post("/api/assign/scaffold", async (c) => {
  const db = openDb();
  const { ok, body } = await readJson(c);
  if (!ok) return c.json({ error: "malformed JSON" }, 400);
  const { month, strategy, dryRun } = body ?? {};
  try {
    const lines = scaffoldMonth(db, month, strategy as ScaffoldStrategy, dryRun === true);
    return c.json({ ok: true, month, strategy, lines });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

/** Machine-readable ritual summary for the agent's weekly run. */
app.get("/api/attention", (c) => {
  const db = openDb();
  const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
  if (!validMonth(month)) return c.json({ error: `bad month "${month}"; expected YYYY-MM` }, 400);
  const pending = db.query("SELECT COUNT(*) AS n FROM transactions WHERE status = 'pending_review' AND voided = 0").get() as { n: number };
  const accounts = db.query("SELECT id, name FROM accounts ORDER BY id").all() as { id: number; name: string }[];
  const unreconciledAccounts = accounts
    .map((a) => {
      const last = db.query("SELECT actual_balance_cents FROM reconciliations WHERE account_id = ? ORDER BY id DESC LIMIT 1").get(a.id) as { actual_balance_cents: number } | null;
      const cleared = db.query(
        "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions WHERE account_id = ? AND cleared IN ('cleared','reconciled') AND voided = 0"
      ).get(a.id) as { total: number };
      return { id: a.id, name: a.name, diffCents: cleared.total - (last?.actual_balance_cents ?? 0) };
    })
    .filter((a) => a.diffCents !== 0);
  const owed = contactOwed(db);
  const byContact = new Map<number, { name: string; cents: number }>();
  for (const o of owed) {
    const e = byContact.get(o.contactId) ?? { name: o.contactName, cents: 0 };
    e.cents += o.owedCents;
    byContact.set(o.contactId, e);
  }
  const sharedOwedBy = [...byContact.entries()]
    .map(([contactId, v]) => ({ contactId, ...v }))
    .sort((a, b) => b.cents - a.cents);
  const sharedOwedCents = sharedOwedBy.reduce((a, o) => a + o.cents, 0);
  return c.json({
    month,
    pendingReviewCount: pending.n,
    unreconciledAccounts,
    rtaCents: rtaCents(db, month),
    unsettledSharedCents: Math.max(0, sharedOwedCents - contactCredit(db)),
    sharedOwedBy,
  });
});

const balanceOf = (db: ReturnType<typeof openDb>, accountId: number, clearedOnly: boolean) => {
  const row = db.query(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions WHERE account_id = ? AND voided = 0${clearedOnly ? " AND cleared IN ('cleared','reconciled')" : ""}`
  ).get(accountId) as { total: number };
  return row.total;
};

app.get("/api/accounts", (c) => {
  const db = openDb();
  const accounts = db.query("SELECT id, name, type, last4 FROM accounts ORDER BY id").all() as any[];
  return c.json({
    accounts: accounts.map((a) => {
      const last = db.query(
        "SELECT created_at FROM reconciliations WHERE account_id = ? ORDER BY id DESC LIMIT 1"
      ).get(a.id) as { created_at: string } | null;
      return {
        ...a,
        workingBalanceCents: balanceOf(db, a.id, false),
        clearedBalanceCents: balanceOf(db, a.id, true),
        lastReconciledAt: last?.created_at ?? null,
      };
    }),
  });
});

/** Reconcile an account against its real-world balance. Body: { actualBalanceCents }.
 *  Balanced → cleared transactions become reconciled and the event is recorded.
 *  Not balanced → returns the difference plus uncleared transactions to investigate. */
app.post("/api/accounts/:id/reconcile", async (c) => {
  const db = openDb();
  const accountId = badId(c, "id");
  if (accountId === null) return c.json({ error: "bad account id" }, 400);
  if (!db.query("SELECT 1 FROM accounts WHERE id = ?").get(accountId)) return c.json({ error: `no account ${accountId}` }, 404);
  const { ok, body } = await readJson(c);
  if (!ok) return c.json({ error: "malformed JSON" }, 400);
  const actualBalanceCents = Math.round(Number(body?.actualBalanceCents));
  if (!Number.isFinite(actualBalanceCents)) return c.json({ error: "actualBalanceCents required" }, 400);
  const cleared = balanceOf(db, accountId, true);
  const result = reconcile({ clearedBalanceCents: cleared, actualBalanceCents });

  if (result.balanced) {
    db.query("UPDATE transactions SET cleared = 'reconciled' WHERE account_id = ? AND cleared = 'cleared'").run(accountId);
    db.query(
      "INSERT INTO reconciliations (account_id, actual_balance_cents, budget_balance_cents, difference_cents) VALUES (?, ?, ?, 0)"
    ).run(accountId, actualBalanceCents, cleared);
    return c.json({ ...result, clearedBalanceCents: cleared, actualBalanceCents });
  }

  const uncleared = db.query(
    "SELECT id, date, description, amount_cents FROM transactions WHERE account_id = ? AND cleared = 'uncleared' AND voided = 0 ORDER BY id"
  ).all(accountId) as { id: number; amount_cents: number }[];
  return c.json({
    ...result,
    clearedBalanceCents: cleared,
    actualBalanceCents,
    uncleared,
    suggestedClearId: suggestClear(uncleared, result.differenceCents),
  });
});

app.post("/api/transactions/:id/clear", (c) => {
  const db = openDb();
  const id = badId(c, "id");
  if (id === null) return c.json({ error: "bad transaction id" }, 400);
  db.query("UPDATE transactions SET cleared = 'cleared' WHERE id = ? AND cleared = 'uncleared'").run(id);
  return c.json({ ok: true });
});

/** Every non-voided transaction in a month, newest first, with pot and
 *  contact-share detail. Powers the Transactions page. */
app.get("/api/transactions", (c) => {
  const db = openDb();
  const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
  if (!validMonth(month)) return c.json({ error: `bad month "${month}"; expected YYYY-MM` }, 400);
  return c.json({ month, transactions: listTransactions(db, month) });
});

/** Record a manually entered transaction. Body: { date, accountId, potId,
 *  amountCents (signed, nonzero), description, isTransfer?, contactId?, shareCents? }. */
app.post("/api/transactions", async (c) => {
  const db = openDb();
  const { ok, body } = await readJson(c);
  if (!ok) return c.json({ error: "malformed JSON" }, 400);
  try {
    const id = createTransaction(db, body ?? {});
    return c.json({ ok: true, id });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

/** Replace a transaction's fields and splits. Same body shape as POST. */
app.put("/api/transactions/:id", async (c) => {
  const db = openDb();
  const id = badId(c, "id");
  if (id === null) return c.json({ error: "bad transaction id" }, 400);
  if (!txnExists(db, id)) return c.json({ error: `no transaction ${id}` }, 404);
  const { ok, body } = await readJson(c);
  if (!ok) return c.json({ error: "malformed JSON" }, 400);
  try {
    updateTransaction(db, id, body ?? {});
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

/** Delete a transaction. This is a soft void: excluded from spend, inflow,
 *  and RTA math, kept for audit. Same semantics as the existing void route. */
app.delete("/api/transactions/:id", (c) => {
  const db = openDb();
  const id = badId(c, "id");
  if (id === null) return c.json({ error: "bad transaction id" }, 400);
  if (!txnExists(db, id)) return c.json({ error: `no transaction ${id}` }, 404);
  db.query("UPDATE transactions SET voided = 1 WHERE id = ?").run(id);
  return c.json({ ok: true });
});

app.get("/api/pots", (c) => {
  const db = openDb();
  const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
  const pots = db.query(
    `SELECT p.id, p.name, p.pot_group, p.target_type, p.target_cents, p.is_assignable, p.contact_id, p.share_pct,
            c.name AS contact_name
     FROM pots p LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE p.hidden = 0 ORDER BY p.id`
  ).all() as any[];
  return c.json({
    month,
    rtaCents: rtaCents(db, month),
    pots: pots.map((p) => {
      const { userCents, sharedCents } = potSpend(db, p.id, month);
      return {
        id: p.id, name: p.name, group: p.pot_group, targetType: p.target_type, targetCents: p.target_cents,
        spentCents: userCents, sharedCents,
        contactId: p.contact_id, contactName: p.contact_name, sharePct: p.share_pct,
        assignable: p.is_assignable === 1, assignedCents: assignedToPot(db, month, p.id),
        receivedCents: potInflow(db, p.id, month),
      };
    }),
  });
});

/** Create a pot. Body: { name, group?, targetCents?, targetType?, contactId?, sharePct? }. */
app.post("/api/pots", async (c) => {
  const db = openDb();
  const { ok, body } = await readJson(c);
  if (!ok) return c.json({ error: "malformed JSON" }, 400);
  try {
    const id = createPot(db, body ?? {});
    return c.json({ ok: true, id });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

/** Update a pot's name, group, target, or share config. */
app.put("/api/pots/:id", async (c) => {
  const db = openDb();
  const id = badId(c, "id");
  if (id === null) return c.json({ error: "bad pot id" }, 400);
  if (!potExists(db, id)) return c.json({ error: `no pot ${id}` }, 404);
  const { ok, body } = await readJson(c);
  if (!ok) return c.json({ error: "malformed JSON" }, 400);
  try {
    updatePot(db, id, body ?? {});
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

/** Delete a pot. Its transactions, splits, and assignments move to the
 *  Uncategorized pot; nothing is destroyed. */
app.delete("/api/pots/:id", (c) => {
  const db = openDb();
  const id = badId(c, "id");
  if (id === null) return c.json({ error: "bad pot id" }, 400);
  if (!potExists(db, id)) return c.json({ error: `no pot ${id}` }, 404);
  try {
    const summary = deletePot(db, id);
    return c.json({ ok: true, ...summary });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

/** Every contact with what they owe, grouped by pot. Powers Sharing. */
app.get("/api/contacts", (c) => {
  const db = openDb();
  return c.json({ contacts: contactBalances(db) });
});

/** Add a contact. Body: { name }. */
app.post("/api/contacts", async (c) => {
  const db = openDb();
  const { ok, body } = await readJson(c);
  if (!ok) return c.json({ error: "malformed JSON" }, 400);
  try {
    const id = createContact(db, body?.name);
    return c.json({ ok: true, id });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

/** Rename a contact. Body: { name }. */
app.put("/api/contacts/:id", async (c) => {
  const db = openDb();
  const id = badId(c, "id");
  if (id === null) return c.json({ error: "bad contact id" }, 400);
  const { ok, body } = await readJson(c);
  if (!ok) return c.json({ error: "malformed JSON" }, 400);
  try {
    renameContact(db, id, body?.name);
    return c.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    return c.json({ error: msg }, msg.startsWith("no contact") ? 404 : 400);
  }
});

/** Delete a contact. Blocked while pots or splits reference them. */
app.delete("/api/contacts/:id", (c) => {
  const db = openDb();
  const id = badId(c, "id");
  if (id === null) return c.json({ error: "bad contact id" }, 400);
  try {
    deleteContact(db, id);
    return c.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    return c.json({ error: msg }, msg.startsWith("no contact") ? 404 : 400);
  }
});

app.get("/api/trend", (c) => {
  const db = openDb();
  return c.json({ trend: spendTrend(db) });
});

/** Validate the pot-history query params. Pure so it can be unit-tested. */
export function parseHistoryQuery(query: Record<string, string | undefined>): { potId: number; months: number } | { error: string } {
  const potId = parseInt(query.potId ?? "", 10);
  if (!Number.isInteger(potId) || potId <= 0) return { error: "bad potId; expected a positive integer" };
  const months = parseInt(query.months ?? "6", 10);
  if (!Number.isInteger(months) || months < 1 || months > 12) return { error: "bad months; expected an integer from 1 to 12" };
  return { potId, months };
}

/** One pot's spend per month, oldest first. Drives the per-pot history chart. */
app.get("/api/pot-history", (c) => {
  const db = openDb();
  const parsed = parseHistoryQuery({ potId: c.req.query("potId"), months: c.req.query("months") });
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const pot = db.query("SELECT id FROM pots WHERE id = ? AND hidden = 0").get(parsed.potId);
  if (!pot) return c.json({ error: `no pot ${parsed.potId}` }, 404);
  return c.json({ potId: parsed.potId, history: potHistory(db, parsed.potId, parsed.months) });
});

/** Read-only month-end close preview. The agent applies the close after
 *  the user's review; this endpoint never writes. */
app.get("/api/close-preview", (c) => {
  const db = openDb();
  const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
  if (!validMonth(month)) return c.json({ error: `bad month "${month}"; expected YYYY-MM` }, 400);
  return c.json(closePreview(db, month));
});

/** Apply the month-end close. Body: { month: "YYYY-MM" }. The $0 rule binds
 *  here: ready-to-assign must be exactly $0, and the month must not already
 *  be closed. Human review happens before the agent runs this. */
app.post("/api/close", async (c) => {
  const db = openDb();
  const { ok, body } = await readJson(c);
  if (!ok) return c.json({ error: "malformed JSON" }, 400);
  const month = body?.month ?? new Date().toISOString().slice(0, 7);
  if (!validMonth(month)) return c.json({ error: `bad month "${month}"; expected YYYY-MM` }, 400);
  try {
    applyClose(db, closePreview(db, month));
    return c.json({ ok: true, month });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

// Record a lump sum from a contact and allocate it against what they owe, oldest first.
// Body: { contactId, accountId, amountCents, note? }.
app.post("/api/settle", async (c) => {
  const db = openDb();
  const { ok, body } = await readJson(c);
  if (!ok) return c.json({ error: "malformed JSON" }, 400);
  const amountCents = Math.round(Number(body?.amountCents));
  const accountId = Number(body?.accountId);
  const contactId = Number(body?.contactId);
  if (!accountId || !amountCents || amountCents <= 0) return c.json({ error: "accountId and positive amountCents required" }, 400);
  if (!contactId) return c.json({ error: "contactId required" }, 400);
  if (!db.query("SELECT 1 FROM accounts WHERE id = ?").get(accountId)) return c.json({ error: `no account ${accountId}` }, 404);
  try {
    const summary = applySettlement(db, { contactId, accountId, amountCents, note: body?.note, enteredBy: "user" });
    return c.json(summary);
  } catch (e) {
    const msg = (e as Error).message;
    return c.json({ error: msg }, msg.startsWith("no contact") ? 404 : 400);
  }
});

const dist = "./client/dist";
if (existsSync(dist)) {
  app.use("/*", serveStatic({ root: dist }));
  app.get("*", serveStatic({ path: `${dist}/index.html` }));
} else {
  app.get("/", (c) => c.text("client not built yet — run `bun run --cwd client build`", 503));
}

/** Start the dashboard. Default port 3111; PORT env overrides.
 *  `bun src/cli.ts serve` calls this (dynamic import doesn't trigger the
 *  default-export auto-serve, which only fires when this file is the entrypoint). */
export function startServer() {
  const port = parseInt(process.env.PORT ?? "3111", 10);
  const server = Bun.serve({ port, fetch: app.fetch });
  console.log(`agentic-budget at http://localhost:${server.port}`);
  return server;
}

// `bun src/server.ts` still works via Bun's default-export auto-serve.
const defaultPort = parseInt(process.env.PORT ?? "3111", 10);
export default { port: defaultPort, fetch: app.fetch };
