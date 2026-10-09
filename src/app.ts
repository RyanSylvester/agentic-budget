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
import { applySettlement, backfillSettlementAllocations, contactCredit, contactOwed, allContactCredit, undoSettlement } from "./settle";
import { createAccount, updateAccount } from "./accounts";
import { contactBalances, contactLedger, createContact, renameContact, deleteContact, setContactArchived } from "./contacts";
import { createPot, updatePot, deletePot, potExists, setGroupOrder } from "./pots";
import { reconcile, suggestClear } from "./reconcile";
import { closePreview, applyClose, shiftMonth, unclosedPreviousMonth } from "./close";
import { assignToPot, allPotAssigned, allPotAssignedMonths, moveAssignment } from "./assign";
import { scaffoldMonth, type ScaffoldStrategy } from "./scaffold";
import { createTransaction, updateTransaction, voidLockReason } from "./transactions";
import { createSchedule, getScheduleById, listSchedules, markPaid, removeSchedule, sinkingStatuses } from "./sinking";
import { validMonth } from "./money";
import type {
  Account,
  AccountCreatedResponse,
  AccountType,
  AccountsResponse,
  AssignHistory,
  AssignResponse,
  AssignMoveResponse,
  Attention,
  AuthState,
  ClosePreview,
  CloseResponse,
  ContactLedger,
  ContactsResponse,
  CreatedResponse,
  GroupOrderResponse,
  OkResponse,
  Overview,
  Pot,
  PotDeletePreview,
  PotDeleteResponse,
  PotHistoryResponse,
  PotsResponse,
  ReconcileResponse,
  ScaffoldResponse,
  SharedOwedByContact,
  SinkingPaidResponse,
  SinkingResponse,
  TargetType,
  TransactionCreatedResponse,
  TransactionsResponse,
  TrendResponse,
  UnreconciledAccount,
  VoidResponse,
} from "./api-types";

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
    app.get("/api/auth/me", (c) => c.json({ authenticated: true, setupRequired: false } satisfies AuthState));
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
    } satisfies Overview);
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
    return c.json({ ok: true } satisfies OkResponse);
  });

  /** Soft-void a transaction: excluded from spend, inflows, and RTA, kept for audit. */
  app.post("/api/transactions/:id/void", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad transaction id" }, 400);
    const row = await db.get<{ voided: number }>("SELECT voided FROM transactions WHERE id = ? AND user_id = ?", id, userId);
    if (!row) return c.json({ error: `no transaction ${id}` }, 404);
    const lock = await voidLockReason(db, userId, id);
    if (lock) return c.json({ error: lock }, 409);
    await db.run("UPDATE transactions SET voided = 1 WHERE id = ? AND user_id = ?", id, userId);
    return c.json({ ok: true, alreadyVoided: row.voided === 1 } satisfies VoidResponse);
  });

  /** Undo a void: the transaction counts again in spend, inflows, and RTA. */
  app.post("/api/transactions/:id/unvoid", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad transaction id" }, 400);
    if (!(await txnExists(db, userId, id))) return c.json({ error: `no transaction ${id}` }, 404);
    const lock = await voidLockReason(db, userId, id);
    if (lock) return c.json({ error: lock.replace("cannot be voided", "cannot be restored") }, 409);
    await db.run("UPDATE transactions SET voided = 0 WHERE id = ? AND user_id = ?", id, userId);
    return c.json({ ok: true } satisfies OkResponse);
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
      return c.json({ ok: true, ...r } satisfies AssignResponse);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Move assigned dollars between pots for a month (covering an overspent
   *  pot, or undoing that). Body: { month: "YYYY-MM", fromPotId, toPotId,
   *  cents } with cents > 0; a null or missing pot id is Ready to Assign. */
  app.post("/api/assign/move", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    const { month, fromPotId, toPotId, cents } = body ?? {};
    try {
      const r = await moveAssignment(db, userId, month, fromPotId ?? null, toPotId ?? null, cents);
      return c.json({ ok: true, month, cents, ...r } satisfies AssignMoveResponse);
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
      return c.json({ ok: true, month, strategy, lines } satisfies ScaffoldResponse);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Per-pot assignment history for the Assigned quick-fill: last month's
   *  assigned and the 3-month average before ?month. One GROUP BY query. */
  app.get("/api/pots/:id/assign-history", async (c) => {
    const db = await getDb();
    const userId = await requestReaderId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad pot id" }, 400);
    if (!(await potExists(db, userId, id))) return c.json({ error: `no pot ${id}` }, 404);
    const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
    if (!validMonth(month)) return c.json({ error: `bad month "${month}"` }, 400);
    const prev = [shiftMonth(month, -3), shiftMonth(month, -2), shiftMonth(month, -1)];
    const byPot = await allPotAssignedMonths(db, userId, prev, [id]);
    const byMonth = byPot.get(id) ?? new Map<string, number>();
    const lastCents = byMonth.get(prev[2]) ?? 0;
    const avg3moCents = Math.round(prev.reduce((s, m) => s + (byMonth.get(m) ?? 0), 0) / 3);
    return c.json({ potId: id, month, lastMonth: { month: prev[2], cents: lastCents }, avg3moCents } satisfies AssignHistory);
  });

  /** Sinking schedules (agent-managed; the UI only reads). Query param month
   *  selects the month the contributions are derived for. */
  app.get("/api/sinking", async (c) => {
    const db = await getDb();
    const userId = await requestReaderId(c, db, authed);
    const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
    if (!validMonth(month)) return c.json({ error: `bad month "${month}"; expected YYYY-MM` }, 400);
    const list = await listSchedules(db, userId);
    // One batched sinkingStatuses call, not one sinkingStatus per schedule.
    const byPot = await sinkingStatuses(db, userId, list.map((s) => s.potId), month);
    const schedules = list.map((s) => byPot.get(s.potId)!);
    return c.json({ month, schedules } satisfies SinkingResponse);
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
      return c.json({ ok: true, id: s.id } satisfies CreatedResponse);
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
      return c.json({ ok: true, dueMonth: next.dueMonth } satisfies SinkingPaidResponse);
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
      return c.json({ ok: true } satisfies OkResponse);
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
    // Batched per-account reconciliation state: one query for the latest
    // reconciliation row per account, one for the cleared sums. The old
    // per-account loop cost two round trips per account; on D1 each is an
    // HTTPS request.
    const accountIds = accounts.map((a) => a.id);
    const [lastRows, clearedRows] =
      accountIds.length === 0
        ? [[], []]
        : await Promise.all([
            db.all<{ accountId: number; bal: number }>(
              `SELECT r.account_id AS accountId, r.actual_balance_cents AS bal
               FROM reconciliations r
               JOIN (SELECT account_id, MAX(id) AS id FROM reconciliations WHERE user_id = ? GROUP BY account_id) m
                 ON m.id = r.id
               WHERE r.user_id = ?`,
              userId,
              userId
            ),
            db.all<{ accountId: number; total: number }>(
              `SELECT account_id AS accountId, COALESCE(SUM(amount_cents), 0) AS total
               FROM transactions
               WHERE account_id IN (${accountIds.map(() => "?").join(",")})
                 AND cleared IN ('cleared','reconciled') AND voided = 0 AND user_id = ?
               GROUP BY account_id`,
              ...accountIds,
              userId
            ),
          ]);
    const lastBal = new Map((lastRows as { accountId: number; bal: number }[]).map((r) => [r.accountId, r.bal]));
    const clearedByAcct = new Map((clearedRows as { accountId: number; total: number }[]).map((r) => [r.accountId, r.total]));
    const unreconciledAccounts: UnreconciledAccount[] = [];
    for (const a of accounts) {
      const diffCents = (clearedByAcct.get(a.id) ?? 0) - (lastBal.get(a.id) ?? 0);
      if (diffCents !== 0) unreconciledAccounts.push({ id: a.id, name: a.name, diffCents });
    }
    const owed = await contactOwed(db, userId);
    const byContact = new Map<number, { name: string; cents: number }>();
    for (const o of owed) {
      const e = byContact.get(o.contactId) ?? { name: o.contactName, cents: 0 };
      e.cents += o.owedCents;
      byContact.set(o.contactId, e);
    }
    const sharedOwedBy: SharedOwedByContact[] = [];
    // One batched credit query for all contacts instead of one per contact.
    const creditByContact = await allContactCredit(db, userId);
    for (const [contactId, v] of [...byContact.entries()].sort((a, b) => b[1].cents - a[1].cents)) {
      // Per-contact net: gross owed minus this contact's unsettled credit, so
      // consumers never have to re-derive it (and never show gross as owed).
      const credit = creditByContact.get(contactId) ?? 0;
      sharedOwedBy.push({ contactId, ...v, netCents: Math.max(0, v.cents - credit) });
    }
    const sharedOwedCents = sharedOwedBy.reduce((a, o) => a + o.cents, 0);
    return c.json({
      month,
      unreconciledAccounts,
      rtaCents: await rtaCents(db, userId, month),
      unsettledSharedCents: Math.max(0, sharedOwedCents - (await contactCredit(db, userId))),
      sharedOwedBy,
      unclosedMonth: await unclosedPreviousMonth(db, userId, month),
    } satisfies Attention);
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
    const accounts = await db.all<{ id: number; name: string; type: AccountType; last4: string | null }>(
      "SELECT id, name, type, last4 FROM accounts WHERE user_id = ? ORDER BY id",
      userId
    );
    // Batched per-account state: latest reconciliation row, working balance,
    // and cleared balance, each one GROUP BY query instead of three queries
    // per account.
    const accountIds = accounts.map((a) => a.id);
    const [lastRows, balRows] =
      accountIds.length === 0
        ? [[], []]
        : await Promise.all([
            db.all<{ accountId: number; at: string }>(
              `SELECT r.account_id AS accountId, r.created_at AS at
               FROM reconciliations r
               JOIN (SELECT account_id, MAX(id) AS id FROM reconciliations WHERE user_id = ? GROUP BY account_id) m
                 ON m.id = r.id
               WHERE r.user_id = ?`,
              userId,
              userId
            ),
            db.all<{ accountId: number; working: number; cleared: number }>(
              `SELECT account_id AS accountId,
                      COALESCE(SUM(amount_cents), 0) AS working,
                      COALESCE(SUM(CASE WHEN cleared IN ('cleared','reconciled') THEN amount_cents ELSE 0 END), 0) AS cleared
               FROM transactions
               WHERE account_id IN (${accountIds.map(() => "?").join(",")}) AND voided = 0 AND user_id = ?
               GROUP BY account_id`,
              ...accountIds,
              userId
            ),
          ]);
    const lastAt = new Map((lastRows as { accountId: number; at: string }[]).map((r) => [r.accountId, r.at]));
    const bals = new Map(
      (balRows as { accountId: number; working: number; cleared: number }[]).map((r) => [r.accountId, r])
    );
    const out: Account[] = [];
    for (const a of accounts) {
      const b = bals.get(a.id) ?? { working: 0, cleared: 0 };
      out.push({
        ...a,
        workingBalanceCents: b.working,
        clearedBalanceCents: b.cleared,
        lastReconciledAt: lastAt.get(a.id) ?? null,
      });
    }
    return c.json({ accounts: out } satisfies AccountsResponse);
  });

  /** Add an account. Body: { name, type: chequing|savings|credit_card, last4? }.
   *  Returns the new account in the GET /api/accounts item shape. */
  app.post("/api/accounts", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    try {
      const account = await createAccount(db, userId, body ?? {});
      return c.json({ ok: true, id: account.id, account } satisfies AccountCreatedResponse);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Rename an account or change its last four digits. Body: { name?, last4? }. */
  app.put("/api/accounts/:id", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad account id" }, 400);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    try {
      await updateAccount(db, userId, id, body ?? {});
      return c.json({ ok: true } satisfies OkResponse);
    } catch (e) {
      const msg = (e as Error).message;
      return c.json({ error: msg }, msg.startsWith("no account") ? 404 : 400);
    }
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
      return c.json({ ...result, clearedBalanceCents: cleared, actualBalanceCents } satisfies ReconcileResponse);
    }

    const uncleared = await db.all<{ id: number; date: string; description: string; amount_cents: number }>(
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
    } satisfies ReconcileResponse);
  });

  app.post("/api/transactions/:id/clear", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad transaction id" }, 400);
    await db.run("UPDATE transactions SET cleared = 'cleared' WHERE id = ? AND cleared = 'uncleared' AND user_id = ?", id, userId);
    return c.json({ ok: true } satisfies OkResponse);
  });

  /** Every non-voided transaction in a month, newest first, with pot and
   *  contact-share detail. Powers the Transactions page. */
  app.get("/api/transactions", async (c) => {
    const db = await getDb();
    const userId = await requestReaderId(c, db, authed);
    const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
    if (!validMonth(month)) return c.json({ error: `bad month "${month}"; expected YYYY-MM` }, 400);
    return c.json({ month, transactions: await listTransactions(db, userId, month) } satisfies TransactionsResponse);
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
        if (dup) return c.json({ ok: true, id: dup.id, duplicate: true } satisfies TransactionCreatedResponse);
      }
      const id = await createTransaction(db, userId, { ...b, enteredBy: requestKind(c) });
      return c.json({ ok: true, id } satisfies TransactionCreatedResponse);
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
      return c.json({ ok: true } satisfies OkResponse);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Delete a transaction. This is a soft void: excluded from spend, inflow,
   *  and RTA math, kept for audit, undone by POST .../unvoid. Same semantics
   *  as the void route; reconciled and settlement rows are refused (409). */
  app.delete("/api/transactions/:id", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad transaction id" }, 400);
    if (!(await txnExists(db, userId, id))) return c.json({ error: `no transaction ${id}` }, 404);
    const lock = await voidLockReason(db, userId, id);
    if (lock) return c.json({ error: lock }, 409);
    await db.run("UPDATE transactions SET voided = 1 WHERE id = ? AND user_id = ?", id, userId);
    return c.json({ ok: true } satisfies OkResponse);
  });

  app.get("/api/pots", async (c) => {
    const db = await getDb();
    const userId = await requestReaderId(c, db, authed);
    const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
    // includeHidden=1 lets the CLI resolve retired pots by name (unhide).
    const includeHidden = c.req.query("includeHidden") === "1";
    const pots = await db.all<{
      id: number; name: string; pot_group: string; target_type: TargetType; target_cents: number;
      is_assignable: number; contact_id: number | null; share_pct: number | null; contact_name: string | null;
    }>(
      `SELECT p.id, p.name, p.pot_group, p.target_type, p.target_cents, p.is_assignable, p.contact_id, p.share_pct,
              c.name AS contact_name
       FROM pots p LEFT JOIN contacts c ON c.id = p.contact_id AND c.user_id = p.user_id
       WHERE p.user_id = ? ${includeHidden ? "" : "AND p.hidden = 0 "}ORDER BY
         COALESCE((SELECT position FROM group_order g WHERE g.user_id = p.user_id AND g.group_name = p.pot_group),
                  9223372036854775807),
         p.id`,
      userId
    );
    const out: Pot[] = [];
    const potIds = pots.map((p) => p.id);
    // One GROUP BY query per metric for all pots, not one query per pot:
    // on D1 every round trip is an HTTPS request. The sinking schedule
    // states come from the same batched call.
    const [spendByPot, inflowByPot, assignedByPot, sinkingByPot] = await Promise.all([
      allPotSpend(db, userId, potIds, month),
      allPotInflow(db, userId, potIds, month),
      allPotAssigned(db, userId, month, potIds),
      sinkingStatuses(db, userId, potIds, month),
    ]);
    for (const p of pots) {
      const sp = spendByPot.get(p.id) ?? { userCents: 0, sharedCents: 0 };
      const sched = sinkingByPot.get(p.id) ?? null;
      out.push({
        id: p.id, name: p.name, group: p.pot_group, targetType: p.target_type, targetCents: p.target_cents,
        spentCents: sp.userCents, sharedCents: sp.sharedCents,
        contactId: p.contact_id, contactName: p.contact_name, sharePct: p.share_pct,
        assignable: p.is_assignable === 1, assignedCents: assignedByPot.get(p.id) ?? 0,
        receivedCents: inflowByPot.get(p.id) ?? 0,
        sinking: sched ? {
          expectedCents: sched.expectedCents, dueMonth: sched.dueMonth, cadenceMonths: sched.cadenceMonths,
          contributionCents: sched.contributionCents, balanceCents: sched.balanceCents,
          remainingCents: sched.remainingCents, monthsLeft: sched.monthsLeft, state: sched.state,
        } : null,
      });
    }
    return c.json({
      month,
      rtaCents: await rtaCents(db, userId, month),
      pots: out,
    } satisfies PotsResponse);
  });

  /** Create a pot. Body: { name, group?, targetCents?, targetType?, contactId?, sharePct? }. */
  app.post("/api/pots", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    try {
      const id = await createPot(db, userId, body ?? {});
      return c.json({ ok: true, id } satisfies CreatedResponse);
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
      return c.json({ ok: true } satisfies OkResponse);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Delete-preview for a pot: how many transactions and assignments would
   *  move, so the delete dialog can name the counts before confirming. */
  app.get("/api/pots/:id/delete-preview", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad pot id" }, 400);
    const pot = await db.get<{ id: number; name: string }>("SELECT id, name FROM pots WHERE id = ? AND user_id = ?", id, userId);
    if (!pot) return c.json({ error: `no pot ${id}` }, 404);
    // Splits are the source of truth for a transaction's pot
    // (transactions.pot_id is a legacy column, always NULL on new rows).
    const txns = await db.get<{ n: number }>(
      `SELECT COUNT(DISTINCT s.transaction_id) AS n FROM splits s
       JOIN transactions t ON t.id = s.transaction_id
       WHERE s.pot_id = ? AND s.user_id = ? AND t.user_id = ?`,
      id,
      userId,
      userId
    );
    const asg = await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM assignments WHERE pot_id = ? AND user_id = ?", id, userId);
    return c.json({ potId: id, name: pot.name, transactionCount: txns?.n ?? 0, assignmentCount: asg?.n ?? 0 } satisfies PotDeletePreview);
  });

  /** Delete a pot. Its transactions, splits, and assignments move to the
   *  destination pot named in the body ({ "moveToPotId": number });
   *  nothing is destroyed. */
  app.delete("/api/pots/:id", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad pot id" }, 400);
    if (!(await potExists(db, userId, id))) return c.json({ error: `no pot ${id}` }, 404);
    const { ok, body } = await readJson(c);
    // An empty body is not malformed here; it just means no destination was
    // chosen, and deletePot's validation reports that clearly.
    const moveToPotId = ok ? (body as any)?.moveToPotId : undefined;
    try {
      const summary = await deletePot(db, userId, id, moveToPotId);
      return c.json({ ok: true, ...summary } satisfies PotDeleteResponse);
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
      return c.json({ ok: true, groups: order } satisfies GroupOrderResponse);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  /** Every contact with what they owe, grouped by pot. Powers Sharing.
   *  Archived contacts are left out unless ?archived=1. */
  app.get("/api/contacts", async (c) => {
    const db = await getDb();
    const userId = await requestReaderId(c, db, authed);
    const includeArchived = c.req.query("archived") === "1";
    return c.json({ contacts: await contactBalances(db, userId, { includeArchived }) } satisfies ContactsResponse);
  });

  /** The shares and settlements behind one contact's balance, newest first. */
  app.get("/api/contacts/:id/ledger", async (c) => {
    const db = await getDb();
    const userId = await requestReaderId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad contact id" }, 400);
    try {
      return c.json((await contactLedger(db, userId, id)) satisfies ContactLedger);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404);
    }
  });

  /** Archive or restore a contact. Body: { archived: boolean }. Archiving is
   *  refused (400) while the contact has an open balance. */
  app.post("/api/contacts/:id/archive", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad contact id" }, 400);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    if (typeof body?.archived !== "boolean") return c.json({ error: "archived must be true or false" }, 400);
    try {
      await setContactArchived(db, userId, id, body.archived);
      return c.json({ ok: true } satisfies OkResponse);
    } catch (e) {
      const msg = (e as Error).message;
      return c.json({ error: msg }, msg.startsWith("no contact") ? 404 : 400);
    }
  });

  /** Add a contact. Body: { name }. */
  app.post("/api/contacts", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    try {
      const id = await createContact(db, userId, body?.name);
      return c.json({ ok: true, id } satisfies CreatedResponse);
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
      return c.json({ ok: true } satisfies OkResponse);
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
      return c.json({ ok: true } satisfies OkResponse);
    } catch (e) {
      const msg = (e as Error).message;
      return c.json({ error: msg }, msg.startsWith("no contact") ? 404 : 400);
    }
  });

  app.get("/api/trend", async (c) => {
    const db = await getDb();
    const userId = await requestReaderId(c, db, authed);
    return c.json({ trend: await spendTrend(db, userId) } satisfies TrendResponse);
  });

  /** One pot's spend per month, oldest first. Drives the per-pot history chart. */
  app.get("/api/pot-history", async (c) => {
    const db = await getDb();
    const userId = await requestReaderId(c, db, authed);
    const parsed = parseHistoryQuery({ potId: c.req.query("potId"), months: c.req.query("months") });
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const pot = await db.get("SELECT id FROM pots WHERE id = ? AND hidden = 0 AND user_id = ?", parsed.potId, userId);
    if (!pot) return c.json({ error: `no pot ${parsed.potId}` }, 404);
    return c.json({ potId: parsed.potId, history: await potHistory(db, userId, parsed.potId, parsed.months) } satisfies PotHistoryResponse);
  });

  /** Read-only month-end close preview. The agent applies the close after
   *  the user's review; this endpoint never writes. */
  app.get("/api/close-preview", async (c) => {
    const db = await getDb();
    const userId = await requestReaderId(c, db, authed);
    const month = c.req.query("month") ?? new Date().toISOString().slice(0, 7);
    if (!validMonth(month)) return c.json({ error: `bad month "${month}"; expected YYYY-MM` }, 400);
    return c.json((await closePreview(db, userId, month)) satisfies ClosePreview);
  });

  /** Apply the month-end close. Body: { month: "YYYY-MM" }. The $0 rule binds
   *  here: ready-to-assign must be exactly $0, and the month must not already
   *  be closed. Any month that has started can be closed: the current one
   *  (early) or a past one that was left open. A future month cannot. Human
   *  review happens before the agent runs this. */
  app.post("/api/close", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    const month = body?.month ?? new Date().toISOString().slice(0, 7);
    if (!validMonth(month)) return c.json({ error: `bad month "${month}"; expected YYYY-MM` }, 400);
    if (month > new Date().toISOString().slice(0, 7)) {
      return c.json({ error: `${month} hasn't started yet; only a current or past month can be closed` }, 400);
    }
    try {
      await applyClose(db, userId, await closePreview(db, userId, month));
      return c.json({ ok: true, month } satisfies CloseResponse);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // Record a settlement with a contact. direction "received" (default): a
  // lump sum from them, allocated against what they owe, oldest first.
  // direction "paid": money you sent them, drawn from their credit.
  // Body: { contactId, accountId, amountCents, direction?, note? }.
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
    const direction = body?.direction ?? "received";
    if (direction !== "received" && direction !== "paid") return c.json({ error: `bad direction "${direction}"; expected received or paid` }, 400);
    if (!(await db.get("SELECT 1 FROM accounts WHERE id = ? AND user_id = ?", accountId, userId))) return c.json({ error: `no account ${accountId}` }, 404);
    try {
      const summary = await applySettlement(db, userId, { contactId, accountId, amountCents, direction, note: body?.note, enteredBy: requestKind(c) });
      return c.json(summary);
    } catch (e) {
      const msg = (e as Error).message;
      return c.json({ error: msg }, msg.startsWith("no contact") ? 404 : 400);
    }
  });

  // Reverse a settlement as if it was never recorded. 409 when it is
  // reconciled or a later settlement depends on it.
  app.post("/api/settlements/:id/undo", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const id = badId(c, "id");
    if (id === null) return c.json({ error: "bad settlement id" }, 400);
    try {
      await undoSettlement(db, userId, id);
      return c.json({ ok: true } satisfies OkResponse);
    } catch (e) {
      const msg = (e as Error).message;
      return c.json({ error: msg }, msg.startsWith("no settlement") ? 404 : 409);
    }
  });

  // Repair settlements that were written without allocations: runs each
  // unallocated settlement's leftover through the allocation waterfall
  // against current outstanding, oldest first. Idempotent. Body: { contactId }.
  app.post("/api/settle/backfill", async (c) => {
    const db = await getDb();
    const userId = await requestUserId(c, db, authed);
    const { ok, body } = await readJson(c);
    if (!ok) return c.json({ error: "malformed JSON" }, 400);
    const contactId = Number(body?.contactId);
    if (!contactId) return c.json({ error: "contactId required" }, 400);
    try {
      return c.json(await backfillSettlementAllocations(db, userId, contactId));
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
