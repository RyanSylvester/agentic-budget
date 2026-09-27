/** Dashboard server: JSON API + serves the built React client.
 *  Start with `bun src/cli.ts serve` (or `bun src/server.ts`). API under /api/*, client at /. */
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { openDb, getSetting } from "./db";
import { monthSpend, potSpend, recentTransactions, spendTrend, assignedTotal, rtaCents } from "./queries";
import { applySettlement, partnerCredit, partnerOwed } from "./settle";
import { reconcile, suggestClear } from "./reconcile";
import { closePreview } from "./close";
import { assignToPot } from "./assign";
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
    partnerName: getSetting(db, "partner_name") ?? "Partner",
    rtaCents: rtaCents(db, month),
    assignedCents: assignedTotal(db, month),
  });
});

app.get("/api/review", (c) => {
  const db = openDb();
  const transactions = db.query(
    `SELECT t.id, t.date, t.description, t.amount_cents, t.source, t.status, t.review_reason,
            COALESCE((SELECT SUM(-s.amount_cents) FROM splits s
                      WHERE s.transaction_id = t.id AND s.owner = 'partner' AND s.amount_cents < 0), 0) AS partner_cents
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
  const owed = partnerOwed(db).reduce((a, o) => a + o.owedCents, 0);
  return c.json({
    month,
    pendingReviewCount: pending.n,
    unreconciledAccounts,
    rtaCents: rtaCents(db, month),
    unsettledPartnerCents: Math.max(0, owed - partnerCredit(db)),
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

app.get("/api/pots", (c) => {
  const db = openDb();
  const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
  const pots = db.query("SELECT id, name, pot_group, target_cents, is_assignable FROM pots WHERE hidden = 0 ORDER BY id").all() as any[];
  return c.json({
    month,
    partnerName: getSetting(db, "partner_name") ?? "Partner",
    pots: pots.map((p) => {
      const { userCents, partnerCents } = potSpend(db, p.id, month);
      return { id: p.id, name: p.name, group: p.pot_group, targetCents: p.target_cents, spentCents: userCents, partnerCents, assignable: p.is_assignable === 1 };
    }),
  });
});

app.get("/api/trend", (c) => {
  const db = openDb();
  return c.json({ trend: spendTrend(db) });
});

/** Read-only month-end close preview. The agent applies the close after
 *  the user's review; this endpoint never writes. */
app.get("/api/close-preview", (c) => {
  const db = openDb();
  const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
  if (!validMonth(month)) return c.json({ error: `bad month "${month}"; expected YYYY-MM` }, 400);
  return c.json(closePreview(db, month));
});

// What the partner owes the user: their outstanding shares, oldest first, grouped by pot.
app.get("/api/partner", (c) => {
  const db = openDb();
  const owed = partnerOwed(db);
  const byPot = new Map<string, number>();
  for (const o of owed) {
    const name = o.potName ?? "Uncategorized";
    byPot.set(name, (byPot.get(name) ?? 0) + o.owedCents);
  }
  return c.json({
    partnerName: getSetting(db, "partner_name") ?? "Partner",
    totalOwedCents: owed.reduce((a, o) => a + o.owedCents, 0),
    creditCents: partnerCredit(db),
    byPot: [...byPot.entries()].map(([pot, cents]) => ({ pot, cents })).sort((a, b) => b.cents - a.cents),
    oldest: owed[0]?.date ?? null,
  });
});

// Record a lump sum from the partner and allocate it against what they owe, oldest first.
app.post("/api/settle", async (c) => {
  const db = openDb();
  const { ok, body } = await readJson(c);
  if (!ok) return c.json({ error: "malformed JSON" }, 400);
  const amountCents = Math.round(Number(body?.amountCents));
  const accountId = Number(body?.accountId);
  if (!accountId || !amountCents || amountCents <= 0) return c.json({ error: "accountId and positive amountCents required" }, 400);
  if (!db.query("SELECT 1 FROM accounts WHERE id = ?").get(accountId)) return c.json({ error: `no account ${accountId}` }, 404);
  const summary = applySettlement(db, { accountId, amountCents, note: body?.note, enteredBy: "user" });
  return c.json(summary);
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
