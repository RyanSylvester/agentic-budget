/* Representative mock data for stories. Everything here is fictional:
   no real transaction descriptions, no personal names. */

import type {
  Account,
  Attention,
  ClosePreviewData,
  ListedTxn,
  Overview,
  PartnerInfo,
  Pot,
  PotHistoryPoint,
  Txn,
} from "../App";

export const MONTH = "2026-09";

let id = 1;
const nid = () => id++;

export function makePot(over: Partial<Pot> = {}): Pot {
  return {
    id: nid(),
    name: "Sample pot",
    group: "Joint Living",
    targetCents: 0,
    spentCents: 0,
    partnerCents: 0,
    assignable: true,
    assignedCents: 0,
    ...over,
  };
}

export const fixturePots: Pot[] = [
  makePot({ name: "Rent share", group: "Joint Living", targetCents: 172000, spentCents: 171953, partnerCents: 171953, assignedCents: 172000 }),
  makePot({ name: "Utilities", group: "Joint Living", targetCents: 14000, spentCents: 13820, assignedCents: 14000 }),
  makePot({ name: "Internet", group: "Joint Living", spentCents: 8995, assignedCents: 9000 }),
  makePot({ name: "Groceries", group: "Food", targetCents: 60000, spentCents: 55263, partnerCents: 27631, assignedCents: 60000 }),
  makePot({ name: "Dining out", group: "Food", targetCents: 20000, spentCents: 23450, assignedCents: 20000 }),
  makePot({ name: "Coffee", group: "Food", spentCents: 4850, assignedCents: 5000 }),
  makePot({ name: "Transit", group: "Transport", targetCents: 15000, spentCents: 15000, assignedCents: 15000 }),
  makePot({ name: "Rideshare", group: "Transport", spentCents: 3210, assignedCents: 0 }),
  makePot({ name: "Emergency buffer", group: "Savings", targetCents: 50000, spentCents: 0, assignedCents: 50000 }),
  makePot({ name: "Paycheck", group: "Income", assignable: false, spentCents: 0 }),
  makePot({ name: "Interest", group: "Income", assignable: false, spentCents: 0 }),
];

export function makeTxn(over: Partial<Txn> = {}): Txn {
  return {
    id: nid(),
    date: "2026-09-26",
    description: "Mock purchase",
    user_cents: -2599,
    is_transfer: 0,
    split_with_partner: 0,
    source: "mock-import",
    status: "confirmed",
    partner_cents: 0,
    review_reason: null,
    ...over,
  };
}

export const fixtureTxns: Txn[] = [
  makeTxn({ date: "2026-09-27", description: "Mock grocery run", user_cents: -8421, split_with_partner: 1, partner_cents: 4210 }),
  makeTxn({ date: "2026-09-26", description: "Mock transit top-up", user_cents: -15000 }),
  makeTxn({ date: "2026-09-25", description: "Mock paycheck deposit", user_cents: 250000, is_transfer: 0 }),
  makeTxn({ date: "2026-09-24", description: "Mock transfer between accounts", user_cents: 89182, is_transfer: 1 }),
  makeTxn({ date: "2026-09-23", description: "Mock dinner out", user_cents: -9650, split_with_partner: 1, partner_cents: 4825 }),
  makeTxn({ date: "2026-09-22", description: "Mock coffee stop", user_cents: -485 }),
];

export function makeOverview(over: Partial<Overview> = {}): Overview {
  return {
    month: MONTH,
    confirmedSpendCents: 272123,
    pendingCount: 0,
    recent: fixtureTxns,
    partnerName: "Partner",
    rtaCents: 503394,
    assignedCents: 0,
    ...over,
  };
}

export function makeAttention(over: Partial<Attention> = {}): Attention {
  return {
    month: MONTH,
    pendingReviewCount: 3,
    unreconciledAccounts: [{ name: "Mock Chequing" }, { name: "Mock Credit Card" }],
    rtaCents: 503394,
    unsettledPartnerCents: 0,
    ...over,
  };
}

export function makeClosePreview(over: Partial<ClosePreviewData> = {}): ClosePreviewData {
  return {
    month: MONTH,
    nextMonth: "2026-10",
    inflowsCents: 512000,
    spentCents: 272123,
    assignedCents: 8633,
    rtaBeforeCents: 503394,
    movedToSavingsCents: 503394,
    partnerOwedCents: 0,
    ...over,
  };
}

export function makePartnerInfo(over: Partial<PartnerInfo> = {}): PartnerInfo {
  return {
    partnerName: "Partner",
    totalOwedCents: 42180,
    creditCents: 0,
    byPot: [
      { pot: "Rent share", cents: 35210 },
      { pot: "Groceries", cents: 6970 },
    ],
    oldest: "2026-09-01",
    ...over,
  };
}

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

export const fixtureReviewTxns: Txn[] = [
  makeTxn({ id: 101, description: "Mock ambiguous charge", user_cents: -1299, amount_cents: -1299, review_reason: "Unusual merchant for this pot", status: "pending_review" }),
  makeTxn({ id: 102, description: "Mock subscription renewal", user_cents: -1499, amount_cents: -1499, review_reason: null, status: "pending_review" }),
  makeTxn({ id: 103, description: "Mock refund posted twice", user_cents: 4500, amount_cents: 4500, review_reason: "Possible duplicate of a cleared entry", status: "pending_review" }),
];

export const fixtureHistory: PotHistoryPoint[] = [
  { month: "2026-04", spentCents: 48210 },
  { month: "2026-05", spentCents: 55263 },
  { month: "2026-06", spentCents: 51040 },
  { month: "2026-07", spentCents: 60312 },
  { month: "2026-08", spentCents: 54877 },
  { month: "2026-09", spentCents: 55263 },
];

export const fixtureDonutSegments = [
  { label: "Joint Living", cents: 194768 },
  { label: "Food", cents: 83563 },
  { label: "Transport", cents: 18210 },
  { label: "Savings", cents: 0 },
].filter((s) => s.cents > 0);

/* Transactions-page rows: outflows, an inflow, a transfer, splits, a
   pending-review item, and an uncategorized one. */

const fixtureChequing = fixtureAccounts[0];
const groceriesPot = fixturePots.find((p) => p.name === "Groceries")!;
const transitPot = fixturePots.find((p) => p.name === "Transit")!;
const paycheckPot = fixturePots.find((p) => p.name === "Paycheck")!;
const diningPot = fixturePots.find((p) => p.name === "Dining out")!;
const coffeePot = fixturePots.find((p) => p.name === "Coffee")!;

export function makeListedTxn(over: Partial<ListedTxn> = {}): ListedTxn {
  return {
    id: nid(),
    date: "2026-09-26",
    description: "Mock purchase",
    amountCents: -2599,
    isTransfer: 0,
    status: "confirmed",
    cleared: "uncleared",
    source: "manual",
    accountId: fixtureChequing.id,
    accountName: fixtureChequing.name,
    potId: groceriesPot.id,
    potName: groceriesPot.name,
    potGroup: groceriesPot.group,
    splitWithPartner: 0,
    partnerCents: 0,
    ...over,
  };
}

export const fixtureListedTxns: ListedTxn[] = [
  makeListedTxn({ date: "2026-09-27", description: "Mock grocery run", amountCents: -8421, splitWithPartner: 1, partnerCents: 4210 }),
  makeListedTxn({ date: "2026-09-26", description: "Mock transit top-up", amountCents: -15000, potId: transitPot.id, potName: transitPot.name, potGroup: transitPot.group }),
  makeListedTxn({ date: "2026-09-25", description: "Mock paycheck deposit", amountCents: 250000, potId: paycheckPot.id, potName: paycheckPot.name, potGroup: paycheckPot.group }),
  makeListedTxn({ date: "2026-09-24", description: "Mock transfer between accounts", amountCents: -89182, isTransfer: 1, potId: null, potName: null, potGroup: null }),
  makeListedTxn({ date: "2026-09-23", description: "Mock dinner out", amountCents: -9650, splitWithPartner: 1, partnerCents: 4825, potId: diningPot.id, potName: diningPot.name, potGroup: diningPot.group }),
  makeListedTxn({ date: "2026-09-22", description: "Mock coffee stop", amountCents: -485, potId: coffeePot.id, potName: coffeePot.name, potGroup: coffeePot.group }),
  makeListedTxn({ date: "2026-09-21", description: "Mock ambiguous charge", amountCents: -1299, status: "pending_review" }),
  makeListedTxn({ date: "2026-09-20", description: "Mock uncategorized import", amountCents: -3200, potId: null, potName: null, potGroup: null }),
];
