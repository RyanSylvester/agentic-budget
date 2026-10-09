

/* ---------- types ---------- */

export interface Txn {
  id: number;
  date: string;
  description: string;
  user_cents: number;
  is_transfer: number;
  split_with_contact: number;
  split_contact_name: string | null;
  source: string;
  shared_cents: number;
}

export interface Overview {
  month: string;
  confirmedSpendCents: number;
  recent: Txn[];
  rtaCents?: number;
  assignedCents?: number;
}

export interface ClosePreviewData {
  month: string;
  nextMonth: string;
  inflowsCents: number;
  spentCents: number;
  assignedCents?: number;
  rtaBeforeCents: number;
  movedToSavingsCents: number;
  sharedOwedCents: number;
  sharedOwedBy: { name: string; cents: number }[];
  closed: boolean;
}

export interface Account {
  id: number;
  name: string;
  type: string;
  last4: string | null;
  workingBalanceCents: number;
  clearedBalanceCents: number;
  lastReconciledAt: string | null;
}

export interface Pot {
  id: number;
  name: string;
  group: string;
  targetType: string;
  targetCents: number;
  spentCents: number;
  sharedCents: number;
  assignable: boolean;
  assignedCents?: number;
  receivedCents?: number;
  contactId: number | null;
  contactName: string | null;
  sharePct: number | null;
  /** Sinking schedule state for the viewed month, null when unscheduled. */
  sinking?: {
    expectedCents: number;
    dueMonth: string;
    cadenceMonths: number;
    contributionCents: number;
    balanceCents: number;
    remainingCents: number;
    monthsLeft: number;
    state: "funding" | "funded" | "overdue";
  } | null;
}

/** A contact's outstanding shared balance. Matches GET /api/contacts. */
export interface ContactBalance {
  id: number;
  name: string;
  totalOwedCents: number;
  creditCents: number;
  byPot: { pot: string; cents: number }[];
  oldest: string | null;
}

export interface TrendPoint {
  month: string;
  spent: number;
}

export interface Attention {
  month: string;
  unreconciledAccounts: Array<string | { name: string }>;
  rtaCents: number;
  unsettledSharedCents: number;
  sharedOwedBy: { contactId: number; name: string; cents: number; netCents?: number }[];
}

export interface PotHistoryPoint {
  month: string;
  spentCents: number;
}

/** One row of the Transactions page: the transaction plus its user-side pot
 *  and the contact's share. Matches GET /api/transactions. */
export interface ListedTxn {
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
