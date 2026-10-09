/* Representative mock data for stories. Everything here is fictional:
   no real transaction descriptions, no personal names. Contact names used
   ("Alex", "Sam") are fictional stand-ins, never real people. */

import type { Account, Attention, ClosePreview, PotCloseLine, ContactBalance, ListedTransaction, Overview, Pot, RecentTransaction, TrendPoint } from "../types";

export const MONTH = "2026-09";

let id = 1;
const nid = () => id++;

export function makePot(over: Partial<Pot> = {}): Pot {
  return {
    id: nid(),
    name: "Sample pot",
    group: "Joint Living",
    targetType: "fixed",
    targetCents: 0,
    spentCents: 0,
    sharedCents: 0,
    assignable: true,
    assignedCents: 0,
    receivedCents: 0,
    contactId: null,
    contactName: null,
    sharePct: null,
    sinking: null,
    ...over,
  };
}

export const fixturePots: Pot[] = [
  makePot({ name: "Rent share", group: "Joint Living", targetCents: 172000, spentCents: 171953, sharedCents: 171953, assignedCents: 172000, contactId: 1, contactName: "Alex", sharePct: 50 }),
  makePot({ name: "Utilities", group: "Joint Living", targetCents: 14000, spentCents: 13820, assignedCents: 14000 }),
  makePot({ name: "Internet", group: "Joint Living", spentCents: 8995, assignedCents: 9000 }),
  makePot({ name: "Groceries", group: "Food", targetCents: 60000, spentCents: 55263, sharedCents: 27631, assignedCents: 60000, contactId: 1, contactName: "Alex", sharePct: 50 }),
  makePot({ name: "Dining out", group: "Food", targetCents: 20000, spentCents: 23450, assignedCents: 20000 }),
  makePot({ name: "Coffee", group: "Food", spentCents: 4850, assignedCents: 5000 }),
  makePot({ name: "Transit", group: "Transport", targetCents: 15000, spentCents: 15000, assignedCents: 15000 }),
  makePot({ name: "Rideshare", group: "Transport", spentCents: 3210, assignedCents: 0 }),
  makePot({ name: "Emergency buffer", group: "Savings", targetCents: 50000, spentCents: 0, assignedCents: 50000 }),
  makePot({ name: "Paycheck", group: "Income", assignable: false, spentCents: 0 }),
  makePot({ name: "Interest", group: "Income", assignable: false, spentCents: 0 }),
];

export function makeTxn(over: Partial<RecentTransaction> = {}): RecentTransaction {
  return {
    id: nid(),
    date: "2026-09-26",
    description: "Mock purchase",
    user_cents: -2599,
    is_transfer: 0,
    split_with_contact: 0,
    split_contact_name: null,
    ...over,
  };
}

export const fixtureTxns: RecentTransaction[] = [
  makeTxn({ date: "2026-09-27", description: "Mock grocery run", user_cents: -8421, split_with_contact: 1, split_contact_name: "Alex" }),
  makeTxn({ date: "2026-09-26", description: "Mock transit top-up", user_cents: -15000 }),
  makeTxn({ date: "2026-09-25", description: "Mock paycheck deposit", user_cents: 250000, is_transfer: 0 }),
  makeTxn({ date: "2026-09-24", description: "Mock transfer between accounts", user_cents: 89182, is_transfer: 1 }),
  makeTxn({ date: "2026-09-23", description: "Mock dinner out", user_cents: -9650, split_with_contact: 1, split_contact_name: "Alex" }),
  makeTxn({ date: "2026-09-22", description: "Mock coffee stop", user_cents: -485 }),
];

export function makeOverview(over: Partial<Overview> = {}): Overview {
  return {
    month: MONTH,
    confirmedSpendCents: 272123,
    recent: fixtureTxns,
    rtaCents: 487250,
    assignedCents: 0,
    ...over,
  };
}

export function makeAttention(over: Partial<Attention> = {}): Attention {
  return {
    month: MONTH,
    unreconciledAccounts: [
      { id: 1, name: "Mock Chequing", diffCents: -4210 },
      { id: 2, name: "Mock Credit Card", diffCents: 12999 },
    ],
    rtaCents: 487250,
    unsettledSharedCents: 0,
    sharedOwedBy: [],
    unclosedMonth: null,
    ...over,
  };
}

export function makeClosePreview(over: Partial<ClosePreview> = {}): ClosePreview {
  return {
    month: MONTH,
    nextMonth: "2026-10",
    inflowsCents: 512000,
    spentCents: 272123,
    assignedCents: 8633,
    rtaBeforeCents: 487250,
    movedToSavingsCents: 487250,
    sharedOwedCents: 0,
    sharedOwedBy: [],
    pots: [],
    closed: false,
    ...over,
  };
}

/** A pinned "today" for stories whose look depends on the date: mid-month,
 *  and the last days of the month, when closing early is offered. */
export const TODAY_MID = "2026-09-14";
export const TODAY_MONTH_END = "2026-09-29";
export const PAST_MONTH = "2026-08";
export const FUTURE_MONTH = "2026-10";

/** The month's pots with $5,120 of planned income and $4,800 assigned, as a
 *  freshly filled future month looks: nothing received or spent yet. */
export const fixturePlannedPots: Pot[] = fixturePots.map((p) =>
  p.name === "Paycheck"
    ? { ...p, assignedCents: 512000 }
    : p.name === "Emergency buffer"
      ? { ...p, assignedCents: 185000, spentCents: 0 }
      : { ...p, spentCents: 0, sharedCents: 0 }
);

/** A month with three overspent pots ($84.10 over in all): two in Food
 *  (Dining out $34.50, Coffee $8.50) and one in Transport (Rideshare $41.10). */
export const fixtureOverspentPots: Pot[] = fixturePots.map((p) =>
  p.name === "Coffee" ? { ...p, spentCents: 5850 } : p.name === "Rideshare" ? { ...p, spentCents: 4110 } : p
);

/** Close-preview pot lines: next month's fill amounts. */
export const fixtureCloseLines: PotCloseLine[] = [
  { name: "Rent share", wireframeCents: 172000 },
  { name: "Utilities", wireframeCents: 14000 },
  { name: "Internet", wireframeCents: 9000 },
  { name: "Groceries", wireframeCents: 58500 },
  { name: "Dining out", wireframeCents: 21000 },
  { name: "Transit", wireframeCents: 15000 },
  { name: "Car insurance", wireframeCents: 12500, wireframeSkipped: true },
  { name: "Emergency buffer", wireframeCents: 0, targetType: "savings" as const },
  { name: "Paycheck", wireframeCents: 0, assignable: false },
].map((l, i) => ({
  potId: i + 1,
  targetType: "fixed",
  targetCents: 0,
  spentCents: 0,
  historyCents: [],
  assignable: true,
  wireframeSkipped: false,
  ...l,
}));

export function makeContactBalance(over: Partial<ContactBalance> = {}): ContactBalance {
  return {
    id: nid(),
    name: "Alex",
    totalOwedCents: 42180,
    creditCents: 0,
    byPot: [
      { pot: "Rent share", cents: 35210 },
      { pot: "Groceries", cents: 6970 },
    ],
    oldest: "2026-09-01",
    archived: false,
    ...over,
  };
}

export const fixtureContacts: ContactBalance[] = [
  makeContactBalance(),
  makeContactBalance({ id: 2, name: "Sam", totalOwedCents: 0, creditCents: 0, byPot: [], oldest: null }),
];

export function makeAccount(over: Partial<Account> = {}): Account {
  return {
    id: nid(),
    name: "Mock Chequing",
    type: "chequing",
    last4: "1234",
    workingBalanceCents: 412050,
    clearedBalanceCents: 408812,
    lastReconciledAt: "2026-09-20T10:00:00",
    ...over,
  };
}

export const fixtureAccounts: Account[] = [
  makeAccount(),
  makeAccount({
    name: "Mock Credit Card",
    type: "credit_card",
    last4: "5678",
    workingBalanceCents: -65365,
    clearedBalanceCents: -65365,
    lastReconciledAt: null,
  }),
];

/* Six months of total spend, oldest first: backs the /api/trend mock and
   the Pots-page summary sparkline. Amounts are cents, like the API. */
export const fixtureTrend: TrendPoint[] = [
  { month: "2026-04", spent: 251200 },
  { month: "2026-05", spent: 289400 },
  { month: "2026-06", spent: 264800 },
  { month: "2026-07", spent: 301500 },
  { month: "2026-08", spent: 276300 },
  { month: "2026-09", spent: 272123 },
];

/* Transactions-page rows: outflows, an inflow, a transfer, splits,
   and a just-imported expense. Every row lands in a real pot. */

const fixtureChequing = fixtureAccounts[0];
const groceriesPot = fixturePots.find((p) => p.name === "Groceries")!;
const transitPot = fixturePots.find((p) => p.name === "Transit")!;
const paycheckPot = fixturePots.find((p) => p.name === "Paycheck")!;
const diningPot = fixturePots.find((p) => p.name === "Dining out")!;
const coffeePot = fixturePots.find((p) => p.name === "Coffee")!;

export function makeListedTxn(over: Partial<ListedTransaction> = {}): ListedTransaction {
  return {
    id: nid(),
    date: "2026-09-26",
    description: "Mock purchase",
    amountCents: -2599,
    isTransfer: 0,
    cleared: "uncleared",
    source: "manual",
    accountId: fixtureChequing.id,
    accountName: fixtureChequing.name,
    potId: groceriesPot.id,
    potName: groceriesPot.name,
    potGroup: groceriesPot.group,
    splitWithContact: 0,
    sharedCents: 0,
    splitContactId: null,
    splitContactName: null,
    settled: 0,
    ...over,
  };
}

const fixtureCard = fixtureAccounts[1];
const card = { accountId: fixtureCard.id, accountName: fixtureCard.name };

export const fixtureListedTxns: ListedTransaction[] = [
  makeListedTxn({ date: "2026-09-27", description: "Mock grocery run", amountCents: -8421, splitWithContact: 1, sharedCents: 4210, splitContactId: 1, splitContactName: "Alex", ...card }),
  makeListedTxn({ date: "2026-09-27", description: "Mock bakery", amountCents: -1250, potId: coffeePot.id, potName: coffeePot.name, potGroup: coffeePot.group, ...card }),
  makeListedTxn({ date: "2026-09-26", description: "Mock transit top-up", amountCents: -15000, cleared: "cleared", potId: transitPot.id, potName: transitPot.name, potGroup: transitPot.group }),
  makeListedTxn({ date: "2026-09-25", description: "Mock paycheck deposit", amountCents: 250000, cleared: "reconciled", potId: paycheckPot.id, potName: paycheckPot.name, potGroup: paycheckPot.group }),
  makeListedTxn({ date: "2026-09-24", description: "Mock transfer between accounts", amountCents: -89182, isTransfer: 1, cleared: "reconciled", potId: null, potName: null, potGroup: null }),
  makeListedTxn({ date: "2026-09-23", description: "Mock dinner out", amountCents: -9650, splitWithContact: 1, sharedCents: 4825, splitContactId: 1, splitContactName: "Alex", cleared: "cleared", potId: diningPot.id, potName: diningPot.name, potGroup: diningPot.group, ...card }),
  makeListedTxn({ date: "2026-09-22", description: "Alex settlement", amountCents: 20000, splitWithContact: 1, sharedCents: -20000, splitContactId: 1, splitContactName: "Alex", cleared: "cleared", settled: 1, potId: null, potName: null, potGroup: null }),
  makeListedTxn({ date: "2026-09-22", description: "Mock coffee stop", amountCents: -485, potId: coffeePot.id, potName: coffeePot.name, potGroup: coffeePot.group }),
  makeListedTxn({ date: "2026-09-20", description: "Mock imported expense", amountCents: -3200, potId: diningPot.id, potName: diningPot.name, potGroup: diningPot.group, ...card }),
];
