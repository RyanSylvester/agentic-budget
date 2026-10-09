import { describe, expect, test } from "bun:test";
import { currentMonthLocal, defaultDateInMonth, todayLocal } from "../client/src/format";

describe("local date helpers", () => {
  test("use the local calendar, zero-padded", () => {
    const d = new Date(2026, 0, 5, 9, 30);
    expect(todayLocal(d)).toBe("2026-01-05");
    expect(currentMonthLocal(d)).toBe("2026-01");
  });

  test("stay on the last local day of the month late in the evening", () => {
    const prev = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      // 9pm Eastern on Sep 30 is already Oct 1 in UTC.
      const d = new Date("2026-10-01T01:00:00Z");
      expect(d.toISOString().slice(0, 10)).toBe("2026-10-01");
      expect(todayLocal(d)).toBe("2026-09-30");
      expect(currentMonthLocal(d)).toBe("2026-09");
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  test("defaultDateInMonth keeps today in the current month", () => {
    expect(defaultDateInMonth("2026-03", new Date(2026, 2, 17))).toBe("2026-03-17");
  });

  test("defaultDateInMonth lands inside another viewed month", () => {
    const now = new Date(2026, 2, 31);
    expect(defaultDateInMonth("2026-02", now)).toBe("2026-02-28");
    expect(defaultDateInMonth("2024-02", now)).toBe("2024-02-29");
    expect(defaultDateInMonth("2026-01", now)).toBe("2026-01-31");
    expect(defaultDateInMonth("2026-05", new Date(2026, 2, 4))).toBe("2026-05-04");
  });
});
