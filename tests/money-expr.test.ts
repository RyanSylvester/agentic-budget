import { describe, expect, test } from "bun:test";
import { evaluateExpression, expressionToCents } from "../client/src/money";

describe("evaluateExpression", () => {
  test("plain numbers", () => {
    expect(evaluateExpression("25")).toBe(25);
    expect(evaluateExpression("25.50")).toBe(25.5);
    expect(evaluateExpression("  30  ")).toBe(30);
    expect(evaluateExpression(".5")).toBe(0.5);
  });
  test("operator precedence", () => {
    expect(evaluateExpression("25+30*2")).toBe(85);
    expect(evaluateExpression("100-20/4")).toBe(95);
    expect(evaluateExpression("10-3-2")).toBe(5);
    expect(evaluateExpression("100/10/2")).toBe(5);
  });
  test("parentheses", () => {
    expect(evaluateExpression("(25+30)*2")).toBe(110);
    expect(evaluateExpression("2*(3+(4*5))")).toBe(46);
  });
  test("unary minus", () => {
    expect(evaluateExpression("-5+10")).toBe(5);
    expect(evaluateExpression("10+-3")).toBe(7);
  });
  test("paste-friendly junk is stripped", () => {
    expect(evaluateExpression("$25")).toBe(25);
    expect(evaluateExpression("1,000+200")).toBe(1200);
  });
  test("float dust is knocked out", () => {
    expect(evaluateExpression("0.1+0.2")).toBe(0.3);
  });
  test("invalid inputs return null", () => {
    for (const bad of ["", "   ", "abc", "5+", "(5", "5)", "5 5", "10/0", "0/0", "2**3", "1e3", "--5x"]) {
      expect(evaluateExpression(bad)).toBeNull();
    }
    expect(evaluateExpression("+-5")).toBe(-5); // harmless unary chains
  });
});

describe("expressionToCents", () => {
  test("converts dollars to cents", () => {
    expect(expressionToCents("25")).toBe(2500);
    expect(expressionToCents("25+30*2")).toBe(8500);
    expect(expressionToCents("10.99")).toBe(1099);
  });
  test("rejects negative and invalid", () => {
    expect(expressionToCents("-5")).toBeNull();
    expect(expressionToCents("abc")).toBeNull();
    expect(expressionToCents("")).toBeNull();
  });
});
