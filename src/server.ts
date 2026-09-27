/** Dashboard server: JSON API + serves the built React client.
 *  Start with `bun src/cli.ts serve`. API under /api/*, client at /. */
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { existsSync } from "node:fs";
import { openDb } from "./db";
import { monthSpend, potSpend, recentTransactions, spendTrend } from "./queries";
import { applySettlement, lillyCredit, lillyOwed } from "./settle";
import { reconcile, suggestClear } from "./reconcile";
import { closePreview } from "./close";

const app = new Hono();

app.get("/api/overview", (c) => {
  const db = openDb();
  const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
  const pending = db.query("SELECT COUNT(*) AS n FROM transactions WHERE status = 'pending_review'").get() as { n: number };
  return c.json({ month, confirmedSpendCents: monthSpend(db, month), pendingCount: pending.n, recent: recentTransactions(db, 10, month) });
});

app.get("/api/review", (c) => {
  const db = openDb();
  const transactions = db.query(
    `SELECT t.id, t.date, t.description, t.amount_cents, t.source, t.status, t.review_reason,
            COALESCE((SELECT SUM(-s.amount_cents) FROM splits s
                      WHERE s.transaction_id = t.id AND s.owner = 'lilly' AND s.amount_cents < 0), 0) AS lilly_cents
     FROM transactions t WHERE t.status = 'pending_review' ORDER BY t.id`
  ).all();
  return c.json({ transactions });
});

app.post("/api/review/:id/confirm", (c) => {
  const db = openDb();
  const id = parseInt(c.req.param("id"), 10);
  db.query("UPDATE transactions SET status = 'confirmed' WHERE id = ?").run(id);
  return c.json({ ok: true });
});

const balanceOf = (db: ReturnType<typeof openDb>, accountId: number, clearedOnly: boolean) => {
  const row = db.query(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions WHERE account_id = ?${clearedOnly ? " AND cleared IN ('cleared','reconciled')" : ""}`
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
  const accountId = parseInt(c.req.param("id"), 10);
  const { actualBalanceCents } = await c.req.json();
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
    "SELECT id, date, description, amount_cents FROM transactions WHERE account_id = ? AND cleared = 'uncleared' ORDER BY id"
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
  const id = parseInt(c.req.param("id"), 10);
  db.query("UPDATE transactions SET cleared = 'cleared' WHERE id = ? AND cleared = 'uncleared'").run(id);
  return c.json({ ok: true });
});

app.get("/api/pots", (c) => {
  const db = openDb();
  const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
  const pots = db.query("SELECT id, name, pot_group, target_cents FROM pots ORDER BY id").all() as any[];
  return c.json({
    month,
    pots: pots.map((p) => {
      const { ryanCents, lillyCents } = potSpend(db, p.id, month);
      return { id: p.id, name: p.name, group: p.pot_group, targetCents: p.target_cents, spentCents: ryanCents, lillyCents };
    }),
  });
});

app.get("/api/trend", (c) => {
  const db = openDb();
  return c.json({ trend: spendTrend(db) });
});

/** Read-only month-end close preview. The agent applies the close after
 *  Ryan's review; this endpoint never writes. */
app.get("/api/close-preview", (c) => {
  const db = openDb();
  const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
  return c.json(closePreview(db, month));
});

// What Lilly owes Ryan: her outstanding shares, oldest first, grouped by pot.
app.get("/api/lilly", (c) => {
  const db = openDb();
  const owed = lillyOwed(db);
  const byPot = new Map<string, number>();
  for (const o of owed) {
    const name = o.potName ?? "Uncategorized";
    byPot.set(name, (byPot.get(name) ?? 0) + o.owedCents);
  }
  return c.json({
    totalOwedCents: owed.reduce((a, o) => a + o.owedCents, 0),
    creditCents: lillyCredit(db),
    byPot: [...byPot.entries()].map(([pot, cents]) => ({ pot, cents })).sort((a, b) => b.cents - a.cents),
    oldest: owed[0]?.date ?? null,
  });
});

// Record a lump sum from Lilly and allocate it against what she owes, oldest first.
app.post("/api/settle", async (c) => {
  const db = openDb();
  const body = await c.req.json();
  const amountCents = Math.round(Number(body.amountCents));
  const accountId = Number(body.accountId);
  if (!accountId || !amountCents || amountCents <= 0) return c.json({ error: "accountId and positive amountCents required" }, 400);
  const summary = applySettlement(db, { accountId, amountCents, note: body.note });
  return c.json(summary);
});

const dist = "./client/dist";
if (existsSync(dist)) {
  app.use("/*", serveStatic({ root: dist }));
  app.get("*", serveStatic({ path: `${dist}/index.html` }));
} else {
  app.get("/", (c) => c.text("client not built yet — run `bun run --cwd client build`", 503));
}

const port = parseInt(process.env.PORT ?? "3000", 10);
console.log(`agentic-budget at http://localhost:${port}`);
export default { port, fetch: app.fetch };
