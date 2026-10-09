/** The JSON API contract: the response shapes the server sends and the
 *  client reads. One definition for both sides.
 *
 *  Portable by construction: this file contains types only and imports
 *  nothing, so the Vite client can `import type` it across directories and
 *  the server build never needs client code. Keep it that way: no runtime
 *  values, no `bun:*`, no `hono`, no imports from sibling modules.
 *
 *  Server handlers check their bodies against these types (`satisfies`), and
 *  the domain modules that build a shape re-export its type from here, so a
 *  change on either side that breaks the contract fails typecheck. */

/* ---------- shared primitives ---------- */

/** Pot target behavior. */
export type TargetType = "fixed" | "average_3mo" | "savings";

/** Bulk-fill strategy for a month's assignments. */
export type ScaffoldStrategy = "average_3mo" | "last_month";

/** Sinking schedule state for a month. */
export type SinkingState = "funding" | "funded" | "overdue";

/** Every 4xx/5xx JSON body. */
export interface ErrorResponse {
  error: string;
}

/** Plain success for writes that return nothing else. */
export interface OkResponse {
  ok: true;
}

/** Success for writes that create a row. */
export interface CreatedResponse {
  ok: true;
  id: number;
}

/* ---------- overview ---------- */

/** One row of the Overview's recent activity (snake_case, straight from SQL).
 *  Matches GET /api/overview `recent`. */
export interface RecentTransaction {
  id: number;
  date: string;
  description: string;
  is_transfer: number;
  /** Sum of the user's splits: negative for spend, positive for inflow. */
  user_cents: number;
  split_with_contact: number;
  split_contact_name: string | null;
}

/** GET /api/overview?month= */
export interface Overview {
  month: string;
  confirmedSpendCents: number;
  recent: RecentTransaction[];
  rtaCents: number;
  assignedCents: number;
}

/* ---------- attention ---------- */

export interface UnreconciledAccount {
  id: number;
  name: string;
  /** Cleared balance minus the last reconciled balance. */
  diffCents: number;
}

export interface SharedOwedByContact {
  contactId: number;
  name: string;
  /** Gross owed. */
  cents: number;
  /** Gross owed minus this contact's unsettled credit, floored at 0. */
  netCents: number;
}

/** GET /api/attention?month= : the ritual summary. */
export interface Attention {
  month: string;
  unreconciledAccounts: UnreconciledAccount[];
  rtaCents: number;
  unsettledSharedCents: number;
  sharedOwedBy: SharedOwedByContact[];
}

/* ---------- accounts ---------- */

export interface Account {
  id: number;
  name: string;
  type: string;
  last4: string | null;
  workingBalanceCents: number;
  clearedBalanceCents: number;
  lastReconciledAt: string | null;
}

/** GET /api/accounts */
export interface AccountsResponse {
  accounts: Account[];
}

/** actual - cleared; zero means balanced. */
export interface ReconcileResult {
  differenceCents: number;
  balanced: boolean;
}

export interface UnclearedTransaction {
  id: number;
  date: string;
  description: string;
  amount_cents: number;
}

/** POST /api/accounts/:id/reconcile. The uncleared list and suggestion are
 *  present only when not balanced. */
export interface ReconcileResponse extends ReconcileResult {
  clearedBalanceCents: number;
  actualBalanceCents: number;
  uncleared?: UnclearedTransaction[];
  suggestedClearId?: number | null;
}

/* ---------- transactions ---------- */

/** One row of the Transactions page: the transaction plus its user-side pot
 *  and the contact's share. Newest first. Voided transactions never appear. */
export interface ListedTransaction {
  id: number;
  date: string;
  description: string;
  amountCents: number;
  isTransfer: number;
  cleared: string;
  source: string;
  accountId: number;
  accountName: string;
  potId: number | null;
  potName: string | null;
  potGroup: string | null;
  splitWithContact: number;
  sharedCents: number;
  splitContactId: number | null;
  splitContactName: string | null;
}

/** GET /api/transactions?month= */
export interface TransactionsResponse {
  month: string;
  transactions: ListedTransaction[];
}

/** POST /api/transactions. A repeated externalId returns the existing id. */
export interface TransactionCreatedResponse extends CreatedResponse {
  duplicate?: true;
}

/** POST /api/transactions/:id/void */
export interface VoidResponse extends OkResponse {
  alreadyVoided: boolean;
}

/* ---------- pots ---------- */

/** A pot's sinking schedule state for the viewed month. */
export interface PotSinking {
  expectedCents: number;
  dueMonth: string;
  cadenceMonths: number;
  contributionCents: number;
  balanceCents: number;
  remainingCents: number;
  monthsLeft: number;
  state: SinkingState;
}

/** One pot with its month figures. Matches GET /api/pots `pots`. */
export interface Pot {
  id: number;
  name: string;
  group: string;
  targetType: TargetType;
  targetCents: number;
  spentCents: number;
  sharedCents: number;
  assignable: boolean;
  assignedCents: number;
  receivedCents: number;
  contactId: number | null;
  contactName: string | null;
  sharePct: number | null;
  /** Null when the pot has no sinking schedule. */
  sinking: PotSinking | null;
}

/** GET /api/pots?month= */
export interface PotsResponse {
  month: string;
  rtaCents: number;
  pots: Pot[];
}

/** GET /api/pots/:id/delete-preview */
export interface PotDeletePreview {
  potId: number;
  name: string;
  transactionCount: number;
  assignmentCount: number;
}

/** What deletePot moved. */
export interface PotDeleteSummary {
  moveToPotId: number;
  moveToPotName: string;
  movedTransactions: number;
  movedAssignments: number;
}

/** DELETE /api/pots/:id */
export type PotDeleteResponse = OkResponse & PotDeleteSummary;

/** PUT /api/groups/order */
export interface GroupOrderResponse extends OkResponse {
  groups: string[];
}

export interface PotHistoryPoint {
  month: string;
  spentCents: number;
}

/** GET /api/pot-history?potId=&months= */
export interface PotHistoryResponse {
  potId: number;
  history: PotHistoryPoint[];
}

export interface TrendPoint {
  month: string;
  /** User spend for the month, in cents. */
  spent: number;
}

/** GET /api/trend */
export interface TrendResponse {
  trend: TrendPoint[];
}

/* ---------- assignments ---------- */

export interface Assignment {
  potId: number;
  month: string;
  cents: number;
}

/** POST /api/assign */
export type AssignResponse = OkResponse & Assignment;

/** GET /api/pots/:id/assign-history?month= */
export interface AssignHistory {
  potId: number;
  month: string;
  lastMonth: { month: string; cents: number };
  avg3moCents: number;
}

export interface ScaffoldLine {
  potId: number;
  name: string;
  cents: number;
  /** True for income pots, whose value is planned income, not an allocation. */
  income: boolean;
  /** True when the value came from the pot's sinking schedule, not the strategy. */
  scheduled?: boolean;
}

/** POST /api/assign/scaffold */
export interface ScaffoldResponse extends OkResponse {
  month: string;
  strategy: ScaffoldStrategy;
  lines: ScaffoldLine[];
}

/* ---------- sinking schedules ---------- */

export interface SinkingSchedule {
  id: number;
  potId: number;
  potName: string;
  expectedCents: number;
  dueMonth: string;
  cadenceMonths: number;
}

export interface SinkingStatus extends SinkingSchedule {
  /** Saved so far: cumulative assigned minus cumulative user spend. */
  balanceCents: number;
  /** max(0, expected - balance). */
  remainingCents: number;
  /** Contribution months from `month` up to (not including) the due month;
   *  1 when at or past the due month with the bill unpaid. */
  monthsLeft: number;
  /** ceil(remaining / monthsLeft); 0 when funded. */
  contributionCents: number;
  state: SinkingState;
}

/** GET /api/sinking?month= */
export interface SinkingResponse {
  month: string;
  schedules: SinkingStatus[];
}

/** POST /api/sinking/:id/paid */
export interface SinkingPaidResponse extends OkResponse {
  dueMonth: string;
}

/* ---------- month-end close ---------- */

export interface PotCloseLine {
  potId: number;
  name: string;
  targetType: TargetType;
  targetCents: number;
  spentCents: number;
  historyCents: number[];
  wireframeCents: number;
  assignable: boolean;
  /** True for pots with a sinking schedule: the schedule is the source of
   *  truth, so the wireframe leaves target_cents alone. wireframeCents then
   *  carries the schedule's contribution for next month, for information. */
  wireframeSkipped: boolean;
}

/** GET /api/close-preview?month= */
export interface ClosePreview {
  month: string;
  nextMonth: string;
  inflowsCents: number;
  spentCents: number;
  assignedCents: number;
  rtaBeforeCents: number;
  movedToSavingsCents: number;
  sharedOwedCents: number;
  sharedOwedBy: { name: string; cents: number }[];
  pots: PotCloseLine[];
  /** True once the month-end close has been applied for this month. */
  closed: boolean;
}

/** POST /api/close */
export interface CloseResponse extends OkResponse {
  month: string;
}

/* ---------- contacts + settlements ---------- */

export interface Contact {
  id: number;
  name: string;
}

/** A contact's outstanding shared balance. */
export interface ContactBalance extends Contact {
  totalOwedCents: number;
  creditCents: number;
  oldest: string | null;
  byPot: { pot: string; cents: number }[];
}

/** GET /api/contacts */
export interface ContactsResponse {
  contacts: ContactBalance[];
}

export interface Allocation {
  splitId: number;
  potName: string | null;
  amountCents: number; // positive
}

/** POST /api/settle */
export interface SettlementSummary {
  contactId: number;
  contactName: string;
  allocations: Allocation[];
  /** Splits paid down from prior credit (zero cash moved). */
  creditAllocations: Allocation[];
  creditConsumedCents: number;
  leftoverCents: number;
}

/** POST /api/settle/backfill */
export interface BackfillSummary {
  contactId: number;
  allocationsWritten: number;
  creditRemainingCents: number;
}

/* ---------- auth ---------- */

/** GET /api/auth/me. username is present only for an authenticated session
 *  on a server with auth configured. */
export interface AuthState {
  authenticated: boolean;
  setupRequired: boolean;
  username?: string | null;
}

/** POST /api/auth/challenge */
export interface AuthChallenge {
  salt: string;
  kdf_params: string;
}

export interface AgentToken {
  id: number;
  name: string;
  created_at: string;
}

/** GET /api/auth/agent-tokens */
export interface AgentTokensResponse {
  tokens: AgentToken[];
}

/** POST /api/auth/agent-tokens. The raw token is returned exactly once. */
export interface AgentTokenCreated extends CreatedResponse {
  token: string;
}

/** POST /api/auth/invites */
export interface InviteCreated extends OkResponse {
  code: string;
}
