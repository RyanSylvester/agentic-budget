/* Tiny safe arithmetic parser for money inputs. Supports + - * / and
   parentheses, e.g. "25+30*2" -> 85. No eval(), no Function constructor:
   a hand-rolled recursive-descent parser, so only digits, decimal points,
   the four operators, and parens are ever accepted. A leading "$" and
   thousands separators (",") are stripped for paste-friendliness.
   Returns the value in dollars, or null when the input is not a valid
   expression. Plain numbers ("25", "25.50") are valid expressions. */

export function evaluateExpression(input: string): number | null {
  const src = input.replace(/[$,]/g, "").trim();
  if (src === "") return null;
  let i = 0;

  const peek = () => src[i];
  const eatWs = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };

  function parseNumber(): number | null {
    eatWs();
    const start = i;
    while (i < src.length && /[0-9]/.test(src[i])) i++;
    if (src[i] === ".") {
      i++;
      while (i < src.length && /[0-9]/.test(src[i])) i++;
    }
    if (i === start || (i === start + 1 && src[start] === ".")) return null;
    return parseFloat(src.slice(start, i));
  }

  function parseFactor(): number | null {
    eatWs();
    if (peek() === "-") {
      i++;
      const v = parseFactor();
      return v === null ? null : -v;
    }
    if (peek() === "+") {
      i++;
      return parseFactor();
    }
    if (peek() === "(") {
      i++;
      const v = parseExpr();
      if (v === null) return null;
      eatWs();
      if (peek() !== ")") return null;
      i++;
      return v;
    }
    return parseNumber();
  }

  function parseTerm(): number | null {
    let v = parseFactor();
    if (v === null) return null;
    for (;;) {
      eatWs();
      const op = peek();
      if (op !== "*" && op !== "/") return v;
      i++;
      const rhs = parseFactor();
      if (rhs === null) return null;
      if (op === "*") v *= rhs;
      else {
        if (rhs === 0) return null;
        v /= rhs;
      }
    }
  }

  function parseExpr(): number | null {
    let v = parseTerm();
    if (v === null) return null;
    for (;;) {
      eatWs();
      const op = peek();
      if (op !== "+" && op !== "-") return v;
      i++;
      const rhs = parseTerm();
      if (rhs === null) return null;
      v = op === "+" ? v + rhs : v - rhs;
    }
  }

  const v = parseExpr();
  if (v === null) return null;
  eatWs();
  if (i !== src.length) return null; // trailing garbage
  if (!Number.isFinite(v)) return null;
  // Knock out float dust (0.1+0.2) at the cent boundary callers use.
  return Math.round(v * 1e10) / 1e10;
}

/** Dollars -> integer cents, or null when the input is not a valid amount. */
export function expressionToCents(input: string): number | null {
  const v = evaluateExpression(input);
  if (v === null || v < 0) return null;
  return Math.round(v * 100);
}
