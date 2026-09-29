import { describe, expect, test } from "bun:test";
import { moneyGrouped } from "../client/src/money";

describe("moneyGrouped", () => {
  test("formats dollars and cents", () => {
    expect(moneyGrouped(171950)).toBe("$1,719.50");
    expect(moneyGrouped(0)).toBe("$0.00");
    expect(moneyGrouped(99)).toBe("$0.99");
  });
  test("adds thousand separators", () => {
    expect(moneyGrouped(1234567)).toBe("$12,345.67");
    expect(moneyGrouped(123456789012)).toBe("$1,234,567,890.12");
  });
  test("negative amounts keep the minus sign", () => {
    expect(moneyGrouped(-500)).toBe("−$5.00");
  });
});
