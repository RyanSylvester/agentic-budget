import { describe, expect, test } from "bun:test";
import { dayLabel, groupByDay, matchesQuery, parseAmountQuery, userShareCents } from "../client/src/txnList";
import type { ListedTransaction } from "../src/api-types";

const txn = (over: Partial<ListedTransaction> = {}): ListedTransaction => ({
  id: 1,
  date: "2026-09-22",
  description: "Corner bakery",
  amountCents: -1250,
  isTransfer: 0,
  cleared: "uncleared",
  source: "manual",
  accountId: 1,
  accountName: "Chequing",
  potId: 1,
  potName: "Coffee",
  potGroup: "Food",
  splitWithContact: 0,
  sharedCents: 0,
  splitContactId: null,
  splitContactName: null,
  settled: 0,
  ...over,
});

describe("dayLabel", () => {
  const now = new Date(2026, 8, 24, 9, 0); // Thu Sep 24 2026, local
  test("today and yesterday by local calendar day", () => {
    expect(dayLabel("2026-09-24", now)).toBe("Today");
    expect(dayLabel("2026-09-23", now)).toBe("Yesterday");
  });
  test("older days read weekday, month and day", () => {
    expect(dayLabel("2026-09-21", now)).toBe("Mon, Sep 21");
    expect(dayLabel("2025-12-31", now)).toBe("Wed, Dec 31, 2025");
  });
});

describe("amount search", () => {
  test("parses dollar amounts with or without $ and separators", () => {
    expect(parseAmountQuery("12.5")).toEqual({ cents: 1250, whole: false });
    expect(parseAmountQuery("$12.50")).toEqual({ cents: 1250, whole: false });
    expect(parseAmountQuery("-1,200")).toEqual({ cents: 120000, whole: true });
    expect(parseAmountQuery("bakery")).toBeNull();
    expect(parseAmountQuery("12.505")).toBeNull();
  });

  test("matches the amount, the user's share, or a whole-dollar prefix", () => {
    const t = txn();
    expect(matchesQuery(t, "12.5")).toBe(true);
    expect(matchesQuery(t, "$12.50")).toBe(true);
    expect(matchesQuery(t, "12")).toBe(true);
    expect(matchesQuery(t, "12.49")).toBe(false);
    const split = txn({ amountCents: -8421, splitWithContact: 1, sharedCents: 4210 });
    expect(userShareCents(split)).toBe(-4211);
    expect(matchesQuery(split, "42.11")).toBe(true);
    expect(matchesQuery(split, "84.21")).toBe(true);
  });

  test("text still matches description, pot and account", () => {
    expect(matchesQuery(txn(), "bakery")).toBe(true);
    expect(matchesQuery(txn(), "coffee")).toBe(true);
    expect(matchesQuery(txn(), "chequing")).toBe(true);
    expect(matchesQuery(txn(), "rent")).toBe(false);
  });
});

test("groupByDay keeps order and groups consecutive dates", () => {
  const rows = [{ date: "2026-09-24" }, { date: "2026-09-24" }, { date: "2026-09-22" }];
  expect(groupByDay(rows).map((g) => [g.date, g.rows.length])).toEqual([["2026-09-24", 2], ["2026-09-22", 1]]);
});
