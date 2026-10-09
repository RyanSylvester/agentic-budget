import { useEffect, useRef, useState } from "react";
import { monthLabel, shiftMonth } from "./format";

/* ---------- primitives ---------- */

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div className="eyebrow">{children}</div>;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`skeleton ${className}`} />;
}

export function FetchError({ onRetry, label = "Couldn't load this." }: { onRetry: () => void; label?: string }) {
  return (
    <div className="card p-5 text-center">
      <p className="text-[15px] text-[var(--muted)]">{label}</p>
      <button onClick={onRetry} className="btn-ink mt-3 px-4 py-2 text-[15px]">
        Try again
      </button>
    </div>
  );
}

export function MonthNav({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  const btn =
    "flex h-11 w-11 items-center justify-center text-[20px] text-[var(--ink-2)] transition active:scale-95";
  return (
    <div className="mb-5 flex items-center justify-between">
      <button aria-label="Previous month" onClick={() => onChange(shiftMonth(month, -1))} className={btn}>
        ‹
      </button>
      <span className="text-[17px] font-medium">{monthLabel(month)}</span>
      <button aria-label="Next month" onClick={() => onChange(shiftMonth(month, 1))} className={btn}>
        ›
      </button>
    </div>
  );
}

/* ---------- sheet (modal) ---------- */

// Bottom sheet on mobile, centered dialog on desktop. Backdrop click or
// Escape dismisses. Keyboard and screen-reader behaviour of a real modal:
// focus moves into the sheet on open (to an autoFocus field if there is one,
// otherwise the panel itself, so phones do not pop the keyboard), Tab and
// Shift+Tab stay inside, the page behind does not scroll, and focus returns
// to whatever opened the sheet when it closes.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  // Read during the first render, before any autoFocus child takes focus.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  // Callers usually pass an inline onClose; keep the latest in a ref so the
  // mount effect below runs once and does not steal focus on re-render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const el = panel.current;
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  return (
    <div className="fixed inset-0 z-30" role="dialog" aria-modal="true" aria-label={label}>
      <div className="absolute inset-0 cursor-pointer bg-black/30" onClick={onClose} />
      <div
        ref={panel}
        tabIndex={-1}
        className="absolute inset-x-0 bottom-0 max-h-[92dvh] overflow-y-auto rounded-t-[var(--r-lg)] border border-[var(--hairline)] bg-[var(--surface)] p-5 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] outline-none sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[var(--r-lg)]"
        style={{ boxShadow: "var(--shadow-elev)" }}
      >
        {children}
      </div>
    </div>
  );
}

// Pill segmented control. Used for Out/In and for the type filter.
export function Segmented<T extends string>({ options, value, onChange, ariaLabel }: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="inline-flex shrink-0 rounded-[var(--r-pill)] border border-[var(--hairline-strong)] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`rounded-full px-3 py-1.5 text-[13px] transition active:scale-95 ${
            value === o.value
              ? "bg-[var(--ink)] font-medium text-[var(--bg)]"
              : "text-[var(--muted)] hover:text-[var(--ink-2)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function FormLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 text-[13px] font-medium text-[var(--ink-2)]">{children}</div>;
}

export function TxnBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-[var(--r-pill)] border border-[var(--hairline)] bg-[var(--bg-sunken)] px-2 py-0.5 text-[11px] font-medium text-[var(--ink-2)]">
      {children}
    </span>
  );
}
