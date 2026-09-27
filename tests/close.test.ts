import { describe, expect, test } from "bun:test";
import { closeMonth, wireframeTarget } from "../src/close";

describe("wireframeTarget", () => {
  test("fixed copies the most recent month", () => {
    expect(wireframeTarget({ potId: 1, targetType: "fixed", historyCents: [10000, 10200, 10100] })).toBe(10100);
  });

  test("average_3mo averages the last three months", () => {
    expect(wireframeTarget({ potId: 2, targetType: "average_3mo", historyCents: [30000, 36000, 33000] })).toBe(33000);
  });

  test("average_3mo works with fewer than three months", () => {
    expect(wireframeTarget({ potId: 2, targetType: "average_3mo", historyCents: [30000, 36000] })).toBe(33000);
  });

  test("savings pots get no assignment", () => {
    expect(wireframeTarget({ potId: 3, targetType: "savings", historyCents: [75000] })).toBe(0);
  });

  test("empty history assigns zero", () => {
    expect(wireframeTarget({ potId: 4, targetType: "fixed", historyCents: [] })).toBe(0);
  });
});

describe("closeMonth", () => {
  test("positive RTA moves to secondary savings and ends at zero", () => {
    expect(closeMonth({ rtaStartCents: 12500 })).toEqual({ rtaEndCents: 0, movedToSavingsCents: 12500 });
  });

  test("negative RTA stays put; nothing moves to savings", () => {
    expect(closeMonth({ rtaStartCents: -3000 })).toEqual({ rtaEndCents: 0, movedToSavingsCents: 0 });
  });
});
