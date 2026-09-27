import { describe, expect, test } from "bun:test";
import { reconcile, suggestClear } from "../src/reconcile";

describe("reconcile", () => {
  test("matching balances are balanced with zero difference", () => {
    expect(reconcile({ clearedBalanceCents: 12345, actualBalanceCents: 12345 }))
      .toEqual({ differenceCents: 0, balanced: true });
  });

  test("difference is actual minus cleared", () => {
    expect(reconcile({ clearedBalanceCents: 10000, actualBalanceCents: 9500 }))
      .toEqual({ differenceCents: -500, balanced: false });
  });
});

describe("suggestClear", () => {
  test("finds the uncleared transaction that explains the difference", () => {
    const uncleared = [
      { id: 1, amount_cents: -8400 },
      { id: 2, amount_cents: -1250 },
    ];
    expect(suggestClear(uncleared, -1250)).toBe(2);
  });

  test("returns null when nothing explains it", () => {
    expect(suggestClear([{ id: 1, amount_cents: -8400 }], -100)).toBeNull();
  });
});
