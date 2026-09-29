import type { KeyboardEvent } from "react";
import { evaluateExpression } from "./money";

/* Money input with a fixed, non-editable "$" prefix and inline math.
   The dollar sign is a positioned span outside the input, so it never
   disappears while editing; the input's left padding is set inline so no
   padding utility can fight it. Typing an expression like "25+30*2" shows
   a live "= 85.00" hint under the field; parents commit with
   evaluateExpression() / expressionToCents() from ./money. */

const HAS_OPERATOR = /[+\-*/()]/;

export function MoneyInput({
  value,
  onChange,
  onKeyDown,
  onBlur,
  autoFocus,
  ariaLabel,
  placeholder = "0.00",
  className = "",
  hint = true,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
  autoFocus?: boolean;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  /** Show the "= 85.00" live hint while an expression is typed. */
  hint?: boolean;
}) {
  const trimmed = value.trim();
  // Show the hint only when the input is a real expression, not a plain
  // number that merely contains a minus sign ("-25" needs no "= -25.00").
  const computed =
    hint && HAS_OPERATOR.test(trimmed) && parseFloat(trimmed) !== evaluateExpression(trimmed)
      ? evaluateExpression(trimmed)
      : null;
  return (
    <span className="relative inline-flex items-center">
      <span
        aria-hidden
        className="pointer-events-none absolute left-2.5 select-none text-[15px] text-[var(--muted)]"
      >
        $
      </span>
      <input
        type="text"
        inputMode="decimal"
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={`field t-nums pr-3 ${className}`}
        style={{ paddingLeft: "1.6rem" }}
      />
      {computed !== null && (
        <span
          aria-hidden
          className="t-nums pointer-events-none absolute left-0 top-full z-10 mt-1 whitespace-nowrap rounded-[var(--r-sm)] border border-[var(--hairline)] bg-[var(--surface)] px-2 py-0.5 text-[12px] text-[var(--ink-2)] shadow-sm"
        >
          = {computed.toFixed(2)}
        </span>
      )}
    </span>
  );
}
