import { describe, expect, test } from "bun:test";
import { spendShareLabel } from "../client/src/money";

describe("spendShareLabel", () => {
  test("whole percents round normally", () => {
    expect(spendShareLabel(3400, 10000)).toBe("34%");
    expect(spendShareLabel(10000, 10000)).toBe("100%");
    expect(spendShareLabel(0, 10000)).toBe("0%");
  });
  test("nonzero sliver reads <1%", () => {
    expect(spendShareLabel(1, 10000)).toBe("<1%");
    expect(spendShareLabel(49, 10000)).toBe("<1%");
    // exactly half a percent rounds up to 1%
    expect(spendShareLabel(50, 10000)).toBe("1%");
  });
  test("empty when there is no spend to divide by", () => {
    expect(spendShareLabel(0, 0)).toBe("");
    expect(spendShareLabel(100, 0)).toBe("");
    expect(spendShareLabel(100, -5)).toBe("");
  });
});
