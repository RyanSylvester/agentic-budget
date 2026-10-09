import { describe, expect, test } from "bun:test";
import { monthFromUrl, tabFromUrl } from "../client/src/tabs";

describe("tabFromUrl", () => {
  test("reads a known tab from the query param", () => {
    expect(tabFromUrl("?tab=pots")).toBe("pots");
    expect(tabFromUrl("?tab=transactions")).toBe("transactions");
    expect(tabFromUrl("?tab=sharing")).toBe("sharing");
    expect(tabFromUrl("?tab=accounts")).toBe("accounts");
    expect(tabFromUrl("?tab=settings")).toBe("settings");
    expect(tabFromUrl("?tab=overview")).toBe("overview");
  });
  test("missing param falls back to overview", () => {
    expect(tabFromUrl("")).toBe("overview");
    expect(tabFromUrl("?month=2026-09")).toBe("overview");
  });
  test("unknown tab values fall back to overview", () => {
    expect(tabFromUrl("?tab=banana")).toBe("overview");
    expect(tabFromUrl("?tab=")).toBe("overview");
    expect(tabFromUrl("?tab=Pots")).toBe("overview");
  });
  test("ignores other params around it", () => {
    expect(tabFromUrl("?foo=1&tab=accounts&bar=2")).toBe("accounts");
  });
});

describe("monthFromUrl", () => {
  test("reads a YYYY-MM month alongside the tab", () => {
    expect(monthFromUrl("?tab=pots&month=2026-10")).toBe("2026-10");
    expect(monthFromUrl("?month=2027-01")).toBe("2027-01");
  });
  test("missing or malformed months are ignored", () => {
    expect(monthFromUrl("?tab=pots")).toBeNull();
    expect(monthFromUrl("?month=2026-13")).toBeNull();
    expect(monthFromUrl("?month=2026-1")).toBeNull();
    expect(monthFromUrl("?month=banana")).toBeNull();
  });
});
