/** The portable Hono app: JSON API for the dashboard. Every route takes its
 *  database from the injected getter, so the same app serves the local
 *  bun:sqlite database (Bun entry in server.ts) and D1 (Cloudflare Worker
 *  entry in worker.ts).
 *
 *  Worker-safe by construction: this file imports only `hono`, a type-only
 *  import from `./db-interface`, and the domain modules. No `hono/bun`,
 *  no `node:fs`, no `bun:sqlite` as a value. Keep it that way. */
import { Hono } from "hono";
import type { Db } from "./db-interface";
import { registerAuth, authMiddleware, type AuthConfig, type Identity } from "./auth";
import { monthSpend, allPotSpend, allPotInflow, recentTransactions, listTransactions, spendTrend, assignedTotal, rtaCents, potHistory } from "./queries";
import { applySettlement, contactCredit, contactOwed } from "./settle";
import { contactBalances, createContact, renameContact, deleteContact } from "./contacts";
import { createPot, updatePot, deletePot, potExists, setGroupOrder } from "./pots";
import { reconcile, suggestClear } from "./reconcile";
import { closePreview, applyClose } from "./close";
import { assignToPot, allPotAssigned } from "./assign";
import { scaffoldMonth, type ScaffoldStrategy } from "./scaffold";
import { createTransaction, updateTransaction } from "./transactions";
import { createSchedule, getScheduleById, listSchedules, markPaid, removeSchedule, sinkingStatus } from "./sinking";
import { validMonth } from "./money";

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

async function txnExists(db: Db, userId: number, id: number): Promise<boolean> {
  return !!(await db.get("SELECT 1 FROM transactions WHERE id = ? AND user_id = ?", id, userId));
}

/** The acting identity's kind, for entered_by derivation: "agent" for the
 *  bearer-token write path, "user" for cookie sessions. Defaults to "user"
 *  when auth is not configured (local Bun dev, where the agent writes
 *  through the CLI). */
function requestKind(c: any): "agent" | "user" {
  return (c.get("identity") as Identity | undefined)?.kind ?? "user";
}

/** The acting user's id, for user_id scoping on writes. On the Worker it
 *  comes from the auth middleware (which 401s when absent); in
 *  unauthenticated Bun mode it is the first (only) local user. Throws when
 *  no local user exists yet; write handlers surface it as a 400. */
async function requestUserId(c: any, db: Db, authed: boolean): Promise<number> {
  if (authed) return (c.get("identity") as Identity).userId;
  const row = await db.get<{ id: number }>("SELECT id FROM users ORDER BY id LIMIT 1");
  if (!row) throw new Error("no user yet: run `budget user create <username>` first");
  return row.id;
}

/** The acting user's id for read-only handlers. Same as requestUserId, but
 *  returns 0 instead of throwing when no local user exists yet: every read
 *  is user_id-scoped, so 0 matches nothing and a fresh local database
 *  renders empty instead of 500ing. */
async function requestReaderId(c: any, db: Db, authed: boolean): Promise<number> {
  try {
    return await requestUserId(c, db, authed);
  } catch {
    return 0;
  }
}

/** Build the API app. getDb supplies the database per request; the Bun entry
 *  passes openDb, the Worker entry passes a D1-backed Db. opts.auth wires
 *  the session middleware and the /api/auth/* routes (Worker only); without
 *  it the API is unauthenticated and /api/auth/me reports an authenticated
 *  local session so the frontend gate passes. */
export function createApp(getDb: () => Promise<Db>, opts?: { auth?: AuthConfig }): Hono {
  const app = new Hono();
  const authed = !!opts?.auth;

  if (opts?.auth) {
    app.use("/api/*", authMiddleware(opts.auth, getDb));
    registerAuth(app, getDb, opts.auth);
  } else {
    app.get("/api/auth/me", (c) => c.json({ authenticated: true, setupRequired: false }));
  }

  app.get("/api/overview", async (c) => {
    const db = await getDb();
    const userId = await requestReaderId(c, db, authed);
    const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
    return c.json({
      month,
      confirmedSpendCents: await monthSpend(db, userId, month),
      recent: await recentTransactions(db, userId, 10, month),
      rtaCents: await rtaCents(db, userId, month),
      assignedCents: await assignedTotal(db, userId, month),
    });
  });

  /** Recategorize a transaction to another pot. */
  app.post("/api/transactions/:id/recategorize", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad transaction id" }, 400);
    if (!(await txnExists(db, userId, id))) return c.json({ error: `no transaction ${id}` }, 404);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    const potId = Number(body?.potId);
    if (!Number.isInteger(potId) || potId <= 0) return c.json({ error: "potId required" }, 400);
    if (!(await db.get("SELECT 1 FROM pots WHERE id = ? AND user_id = ?", potId, userId))) return c.json({ error: `no pot ${potId}` }, 404);
    await db.run("UPDATE splits SET pot_id = ? WHERE transaction_id = ? AND user_id = ?", potId, id, userId);
    return c.json({ ok: true });
  });

  /** Soft-void a transaction: excluded from spend, inflows, and RTA, kept for audit. */
  app.post("/api/transactions/:id/void", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad transaction id" }, 400);
    const row = await db.get<{ voided: number }>("SELECT voided FROM transactions WHERE id = ? AND user_id = ?", id, userId);
    if (!row) return c.json({ error: `no transaction ${id}` }, 404);
    await db.run("UPDATE transactions SET voided = 1 WHERE id = ? AND user_id = ?", id, userId);
    return c.json({ ok: true, alreadyVoided: row.voided === 1 });
  });

  /** Assign dollars to a pot for a month. Body: { month: "YYYY-MM", potId, cents }. */
  app.post("/api/assign", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    const { month, potId, cents } = body ?? {};
    try {
      const r = await assignToPot(db, userId, month, potId, cents);
      return c.json({ ok: true, ...r });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Bulk-fill a month's assignments from history. Body: { month: "YYYY-MM",
   *  strategy: "average_3mo" | "last_month" | "target", dryRun?: boolean }.
   *  With dryRun the computed lines are returned without writing anything. */
  app.post("/api/assign/scaffold", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    const { month, strategy, dryRun } = body ?? {};
    try {
      const lines = await scaffoldMonth(db, userId, month, strategy as ScaffoldStrategy, dryRun === true);
      return c.json({ ok: true, month, strategy, lines });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Sinking schedules (agent-managed; the UI only reads). Query param month
   *  selects the month the contributions are derived for. */
  app.get("/api/sinking", async (c) => {
    const db = await getDb();
    const userId = await requestReaderId(c, db, authed);
    const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
    if (!validMonth(month)) return c.json({ error: `bad month "${month}"; expected YYYY-MM` }, 400);
    const schedules = [];
    for (const s of await listSchedules(db, userId)) schedules.push((await sinkingStatus(db, userId, s.potId, month))!);
    return c.json({ month, schedules });
  });

  /** Create a schedule. Body: { potId | pot, expectedCents, dueMonth: "YYYY-MM", cadenceMonths? }. */
  app.post("/api/sinking", async (c) => {
    const db = await getDb();
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    const potRef = body?.potId ?? body?.pot;
    const expectedCents = Math.round(Number(body?.expectedCents));
    const dueMonth = body?.dueMonth;
    const cadenceMonths = body?.cadenceMonths === undefined ? 12 : Number(body.cadenceMonths);
    if (potRef === undefined || potRef === null) return c.json({ error: "potId (or pot name) required" }, 400);
    try {
      const s = await createSchedule(db, await requestUserId(c, db, authed), potRef, expectedCents, dueMonth, cadenceMonths);
      return c.json({ ok: true, id: s.id });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Mark the bill paid: roll the due month forward one cadence period. */
  app.post("/api/sinking/:id/paid", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad schedule id" }, 400);
    const s = await getScheduleById(db, userId, id);
    if (!s) return c.json({ error: `no sinking schedule ${id}` }, 404);
    try {
      const next = await markPaid(db, userId, s.potId);
      return c.json({ ok: true, dueMonth: next.dueMonth });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Delete a schedule. The pot and its history are untouched. */
  app.delete("/api/sinking/:id", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad schedule id" }, 400);
    const s = await getScheduleById(db, userId, id);
    if (!s) return c.json({ error: `no sinking schedule ${id}` }, 404);
    try {
      await removeSchedule(db, userId, s.potId);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Machine-readable ritual summary for the agent's weekly run. */
  app.get("/api/attention", async (c) => {
    const db = await getDb();
    const userId = await requestReaderId(c, db, authed);
    const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
    if (!validMonth(month)) return c.json({ error: `bad month "${month}"; expected YYYY-MM` }, 400);
    const accounts = await db.all<{ id: number; name: string }>("SELECT id, name FROM accounts WHERE user_id = ? ORDER BY id", userId);
    const unreconciledAccounts = [];
    for (const a of accounts) {
      const last = await db.get<{ actual_balance_cents: number }>(
        "SELECT actual_balance_cents FROM reconciliations WHERE account_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1",
        a.id,
        userId
      );
      const cleared = (await db.get<{ total: number }>(
        "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions WHERE account_id = ? AND cleared IN ('cleared','reconciled') AND voided = 0 AND user_id = ?",
        a.id,
        userId
      ))!;
      const diffCents = cleared.total - (last?.actual_balance_cents ?? 0);
      if (diffCents !== 0) unreconciledAccounts.push({ id: a.id, name: a.name, diffCents });
    }
    const owed = await contactOwed(db, userId);
    const byContact = new Map<number, { name: string; cents: number }>();
    for (const o of owed) {
      const e = byContact.get(o.contactId) ?? { name: o.contactName, cents: 0 };
      e.cents += o.owedCents;
      byContact.set(o.contactId, e);
    }
    const sharedOwedBy: { contactId: number; name: string; cents: number; netCents: number }[] = [];
    for (const [contactId, v] of [...byContact.entries()].sort((a, b) => b[1].cents - a[1].cents)) {
      // Per-contact net: gross owed minus this contact's unsettled credit, so
      // consumers never have to re-derive it (and never show gross as owed).
      const credit = await contactCredit(db, userId, contactId);
      sharedOwedBy.push({ contactId, ...v, netCents: Math.max(0, v.cents - credit) });
    }
    const sharedOwedCents = sharedOwedBy.reduce((a, o) => a + o.cents, 0);
    return c.json({
      month,
      unreconciledAccounts,
      rtaCents: await rtaCents(db, userId, month),
      unsettledSharedCents: Math.max(0, sharedOwedCents - (await contactCredit(db, userId))),
      sharedOwedBy,
    });
  });

  const balanceOf = async (db: Db, userId: number, accountId: number, clearedOnly: boolean): Promise<number> => {
    const row = (await db.get<{ total: number }>(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions WHERE account_id = ? AND voided = 0 AND user_id = ?${clearedOnly ? " AND cleared IN ('cleared','reconciled')" : ""}`,
      accountId,
      userId
    ))!;
    return row.total;
  };

  app.get("/api/accounts", async (c) => {
    const db = await getDb();
    const userId = await requestReaderId(c, db, authed);
    const accounts = await db.all<any>("SELECT id, name, type, last4 FROM accounts WHERE user_id = ? ORDER BY id", userId);
    const out = [];
    for (const a of accounts) {
      const last = await db.get<{ created_at: string }>(
        "SELECT created_at FROM reconciliations WHERE account_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1",
        a.id,
        userId
      );
      out.push({
        ...a,
        workingBalanceCents: await balanceOf(db, userId, a.id, false),
        clearedBalanceCents: await balanceOf(db, userId, a.id, true),
        lastReconciledAt: last?.created_at ?? null,
      });
    }
    return c.json({ accounts: out });
  });

  /** Reconcile an account against its real-world balance. Body: { actualBalanceCents }.
   *  Balanced → cleared transactions become reconciled and the event is recorded.
   *  Not balanced → returns the difference plus uncleared transactions to investigate. */
  app.post("/api/accounts/:id/reconcile", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const accountId = badId(c, "id");
    if (accountId === null) return c.json({ error: "bad account id" }, 400);
    if (!(await db.get("SELECT 1 FROM accounts WHERE id = ? AND user_id = ?", accountId, userId))) return c.json({ error: `no account ${accountId}` }, 404);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    const actualBalanceCents = Math.round(Number(body?.actualBalanceCents));
    if (!Number.isFinite(actualBalanceCents)) return c.json({ error: "actualBalanceCents required" }, 400);
    const cleared = await balanceOf(db, userId, accountId, true);
    const result = reconcile({ clearedBalanceCents: cleared, actualBalanceCents });

    if (result.balanced) {
      await db.run("UPDATE transactions SET cleared = 'reconciled' WHERE account_id = ? AND cleared = 'cleared' AND user_id = ?", accountId, userId);
      await db.run(
        `INSERT INTO reconciliations (user_id, account_id, actual_balance_cents, budget_balance_cents, difference_cents) VALUES (?, ?, ?, ?, 0)`,
        userId,
        accountId,
        actualBalanceCents,
        cleared
      );
      return c.json({ ...result, clearedBalanceCents: cleared, actualBalanceCents });
    }

    const uncleared = await db.all<{ id: number; amount_cents: number }>(
      "SELECT id, date, description, amount_cents FROM transactions WHERE account_id = ? AND cleared = 'uncleared' AND voided = 0 AND user_id = ? ORDER BY id",
      accountId,
      userId
    );
    return c.json({
      ...result,
      clearedBalanceCents: cleared,
      actualBalanceCents,
      uncleared,
      suggestedClearId: suggestClear(uncleared, result.differenceCents),
    });
  });

  app.post("/api/transactions/:id/clear", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad transaction id" }, 400);
    await db.run("UPDATE transactions SET cleared = 'cleared' WHERE id = ? AND cleared = 'uncleared' AND user_id = ?", id, userId);
    return c.json({ ok: true });
  });

  /** Every non-voided transaction in a month, newest first, with pot and
   *  contact-share detail. Powers the Transactions page. */
  app.get("/api/transactions", async (c) => {
    const db = await getDb();
    const userId = await requestReaderId(c, db, authed);
    const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
    if (!validMonth(month)) return c.json({ error: `bad month "${month}"; expected YYYY-MM` }, 400);
    return c.json({ month, transactions: await listTransactions(db, userId, month) });
  });

  /** Record a manually entered transaction. Body: { date, accountId, potId,
   *  amountCents (signed, nonzero), description, isTransfer?, contactId?, shareCents?,
   *  source?, cleared?, externalId? }. Uncertainty is resolved in conversation,
   *  never parked in the app: reviewReason is rejected. A repeat externalId
   *  returns the existing id with duplicate: true (idempotent record). */
  app.post("/api/transactions", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    try {
      const b = body ?? {};
      if (b.reviewReason !== undefined && b.reviewReason !== null)
        return c.json({ error: "reviewReason is not accepted; resolve uncertainty in conversation instead" }, 400);
      if (b.externalId) {
        const dup = await db.get<{ id: number }>("SELECT id FROM transactions WHERE external_id = ? AND user_id = ?", b.externalId, userId);
        if (dup) return c.json({ ok: true, id: dup.id, duplicate: true });
      }
      const id = await createTransaction(db, userId, { ...b, enteredBy: requestKind(c) });
      return c.json({ ok: true, id });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Replace a transaction's fields and splits. Same body shape as POST. */
  app.put("/api/transactions/:id", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad transaction id" }, 400);
    if (!(await txnExists(db, userId, id))) return c.json({ error: `no transaction ${id}` }, 404);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    try {
      await updateTransaction(db, userId, id, body ?? {});
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Delete a transaction. This is a soft void: excluded from spend, inflow,
   *  and RTA math, kept for audit. Same semantics as the existing void route. */
  app.delete("/api/transactions/:id", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad transaction id" }, 400);
    if (!(await txnExists(db, userId, id))) return c.json({ error: `no transaction ${id}` }, 404);
    await db.run("UPDATE transactions SET voided = 1 WHERE id = ? AND user_id = ?", id, userId);
    return c.json({ ok: true });
  });

  app.get("/api/pots", async (c) => {
    const db = await getDb();
    const userId = await requestReaderId(c, db, authed);
    const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
    // includeHidden=1 lets the CLI resolve retired pots by name (unhide).
    const includeHidden = c.req.query("includeHidden") === "1";
    const pots = await db.all<any>(
      `SELECT p.id, p.name, p.pot_group, p.target_type, p.target_cents, p.is_assignable, p.contact_id, p.share_pct,
              c.name AS contact_name
       FROM pots p LEFT JOIN contacts c ON c.id = p.contact_id AND c.user_id = p.user_id
       WHERE p.user_id = ? ${includeHidden ? "" : "AND p.hidden = 0 "}ORDER BY
         COALESCE((SELECT position FROM group_order g WHERE g.user_id = p.user_id AND g.group_name = p.pot_group),
                  9223372036854775807),
         p.id`,
      userId
    );
    const out = [];
    const potIds = pots.map((p: any) => p.id);
    // One GROUP BY query per metric for all pots, not one query per pot:
    // on D1 every round trip is an HTTPS request. sinkingStatus stays
    // per-pot (cheap config lookup; its table guard is memoized).
    const [spendByPot, inflowByPot, assignedByPot] = await Promise.all([
      allPotSpend(db, userId, potIds, month),
      allPotInflow(db, userId, potIds, month),
      allPotAssigned(db, userId, month, potIds),
    ]);
    for (const p of pots) {
      const sp = spendByPot.get(p.id) ?? { userCents: 0, sharedCents: 0 };
      const sched = await sinkingStatus(db, userId, p.id, month);
      out.push({
        id: p.id, name: p.name, group: p.pot_group, targetType: p.target_type, targetCents: p.target_cents,
        spentCents: sp.userCents, sharedCents: sp.sharedCents,
        contactId: p.contact_id, contactName: p.contact_name, sharePct: p.share_pct,
        assignable: p.is_assignable === 1, assignedCents: assignedByPot.get(p.id) ?? 0,
        receivedCents: inflowByPot.get(p.id) ?? 0,
        sinking: sched ? {
          expectedCents: sched.expectedCents, dueMonth: sched.dueMonth, cadenceMonths: sched.cadenceMonths,
          contributionCents: sched.contributionCents, balanceCents: sched.balanceCents, state: sched.state,
        } : null,
      });
    }
    return c.json({
      month,
      rtaCents: await rtaCents(db, userId, month),
      pots: out,
    });
  });

  /** Create a pot. Body: { name, group?, targetCents?, targetType?, contactId?, sharePct? }. */
  app.post("/api/pots", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    try {
      const id = await createPot(db, userId, body ?? {});
      return c.json({ ok: true, id });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Update a pot's name, group, target, or share config. */
  app.put("/api/pots/:id", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad pot id" }, 400);
    if (!(await potExists(db, userId, id))) return c.json({ error: `no pot ${id}` }, 404);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    try {
      await updatePot(db, userId, id, body ?? {});
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Delete a pot. Its transactions, splits, and assignments move to the
   *  Uncategorized pot; nothing is destroyed. */
  app.delete("/api/pots/:id", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad pot id" }, 400);
    if (!(await potExists(db, userId, id))) return c.json({ error: `no pot ${id}` }, 404);
    try {
      const summary = await deletePot(db, userId, id);
      return c.json({ ok: true, ...summary });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Replace the user's pot-group display order. Body: { groups: string[] }.
   *  The order lives entirely in the group_order table as user data; nothing
   *  about groups or their order is hardcoded. Groups the user has but did
   *  not list keep their relative order after the listed ones. */
  app.put("/api/groups/order", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    try {
      const order = await setGroupOrder(db, userId, (body as any)?.groups);
      return c.json({ ok: true, groups: order });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Every contact with what they owe, grouped by pot. Powers Sharing. */
  app.get("/api/contacts", async (c) => {
    const db = await getDb();
    const userId = await requestReaderId(c, db, authed);
    return c.json({ contacts: await contactBalances(db, userId) });
  });

  /** Add a contact. Body: { name }. */
  app.post("/api/contacts", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    try {
      const id = await createContact(db, userId, body?.name);
      return c.json({ ok: true, id });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Rename a contact. Body: { name }. */
  app.put("/api/contacts/:id", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad contact id" }, 400);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    try {
      await renameContact(db, userId, id, body?.name);
      return c.json({ ok: true });
    } catch (e) {
      const msg = (e as Error).message;
      return c.json({ error: msg }, msg.startsWith("no contact") ? 404 : 400);
    }
  });

  /** Delete a contact. Blocked while pots or splits reference them. */
  app.delete("/api/contacts/:id", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad contact id" }, 400);
    try {
      await deleteContact(db, userId, id);
      return c.json({ ok: true });
    } catch (e) {
      const msg = (e as Error).message;
      return c.json({ error: msg }, msg.startsWith("no contact") ? 404 : 400);
    }
  });

  app.get("/api/trend", async (c) => {
    const db = await getDb();
    const userId = await requestReaderId(c, db, authed);
    return c.json({ trend: await spendTrend(db, userId) });
  });

  /** One pot's spend per month, oldest first. Drives the per-pot history chart. */
  app.get("/api/pot-history", async (c) => {
    const db = await getDb();
    const userId = await requestReaderId(c, db, authed);
    const parsed = parseHistoryQuery({ potId: c.req.query("potId"), months: c.req.query("months") });
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const pot = await db.get("SELECT id FROM pots WHERE id = ? AND hidden = 0 AND user_id = ?", parsed.potId, userId);
    if (!pot) return c.json({ error: `no pot ${parsed.potId}` }, 404);
    return c.json({ potId: parsed.potId, history: await potHistory(db, userId, parsed.potId, parsed.months) });
  });

  /** Read-only month-end close preview. The agent applies the close after
   *  the user's review; this endpoint never writes. */
  app.get("/api/close-preview", async (c) => {
    const db = await getDb();
    const userId = await requestReaderId(c, db, authed);
    const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
    if (!validMonth(month)) return c.json({ error: `bad month "${month}"; expected YYYY-MM` }, 400);
    return c.json(await closePreview(db, userId, month));
  });

  /** Apply the month-end close. Body: { month: "YYYY-MM" }. The $0 rule binds
   *  here: ready-to-assign must be exactly $0, and the month must not already
   *  be closed. Human review happens before the agent runs this. */
  app.post("/api/close", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    const month = body?.month ?? new Date().toISOString().slice(0, 7);
    if (!validMonth(month)) return c.json({ error: `bad month "${month}"; expected YYYY-MM` }, 400);
    try {
      await applyClose(db, userId, await closePreview(db, userId, month));
      return c.json({ ok: true, month });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // Record a lump sum from a contact and allocate it against what they owe, oldest first.
  // Body: { contactId, accountId, amountCents, note? }.
  app.post("/api/settle", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    const amountCents = Math.round(Number(body?.amountCents));
    const accountId = Number(body?.accountId);
    const contactId = Number(body?.contactId);
    if (!accountId || !amountCents || amountCents <= 0) return c.json({ error: "accountId and positive amountCents required" }, 400);
    if (!contactId) return c.json({ error: "contactId required" }, 400);
    if (!(await db.get("SELECT 1 FROM accounts WHERE id = ? AND user_id = ?", accountId, userId))) return c.json({ error: `no account ${accountId}` }, 404);
    try {
      const summary = await applySettlement(db, userId, { contactId, accountId, amountCents, note: body?.note, enteredBy: requestKind(c) });
      return c.json(summary);
    } catch (e) {
      const msg = (e as Error).message;
      return c.json({ error: msg }, msg.startsWith("no contact") ? 404 : 400);
    }
  });

  return app;
}

/** Validate the pot-history query params. Pure so it can be unit-tested. */
export function parseHistoryQuery(query: Record<string, string | undefined>): { potId: number; months: number } | { error: string } {
  const potId = parseInt(query.potId ?? "", 10);
  if (!Number.isInteger(potId) || potId <= 0) return { error: "bad potId; expected a positive integer" };
  const months = parseInt(query.months ?? "6", 10);
  if (!Number.isInteger(months) || months < 1 || months > 12) return { error: "bad months; expected an integer from 1 to 12" };
  return { potId, months };
}
