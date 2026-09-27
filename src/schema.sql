-- agentic-budget schema (DRAFT — pending scoping session)
-- Every money-moving row carries its provenance: who entered it and where it came from.

CREATE TABLE IF NOT EXISTS accounts (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  type      TEXT NOT NULL CHECK (type IN ('chequing','credit_card','savings')),
  last4     TEXT
);

-- Pots mirror the YNAB category taxonomy 1:1. YNAB is the source of truth:
-- categories are synced by stable id (see src/ynab.ts), never hardcoded.
-- ynab_id / ynab_group_id are the YNAB UUIDs; name and pot_group are labels
-- that follow YNAB renames. hidden mirrors YNAB's hidden/deleted flags.
CREATE TABLE IF NOT EXISTS pots (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  pot_group    TEXT NOT NULL,
  target_type  TEXT NOT NULL CHECK (target_type IN ('fixed','average_3mo','savings')),
  target_cents INTEGER NOT NULL DEFAULT 0,
  ynab_id       TEXT UNIQUE,
  ynab_group_id TEXT,
  hidden        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY,
  date         TEXT NOT NULL,              -- YYYY-MM-DD
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  pot_id       INTEGER REFERENCES pots(id), -- NULL until categorized
  amount_cents INTEGER NOT NULL,            -- negative = outflow
  description  TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('gmail','mention','manual')),
  entered_by   TEXT NOT NULL CHECK (entered_by IN ('agent','ryan')),
  status       TEXT NOT NULL DEFAULT 'pending_review'
               CHECK (status IN ('pending_review','confirmed')),
  -- YNAB-style cleared states. Reconciliation compares the budget balance
  -- against the real account balance; 'reconciled' locks the match.
  cleared      TEXT NOT NULL DEFAULT 'uncleared'
               CHECK (cleared IN ('uncleared','cleared','reconciled')),
  -- Only uncertain agent entries wait for review (Ryan 2026-09-26);
  -- the reason is shown in the review queue.
  review_reason TEXT,
  -- Movements between Ryan's own accounts (holding-account loop, TFSA
  -- contributions). Real money for reconciliation, never spending.
  is_transfer  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One row per applied month-end close. The close itself is a pure function
-- (see src/close.ts); applying it writes this record.
CREATE TABLE IF NOT EXISTS month_closes (
  id               INTEGER PRIMARY KEY,
  month            TEXT NOT NULL UNIQUE,   -- YYYY-MM
  rta_start_cents  INTEGER NOT NULL,
  rta_end_cents    INTEGER NOT NULL,       -- must be 0 per Ryan's rule
  moved_to_savings_cents INTEGER NOT NULL,
  applied_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Reconciliation history: each time an account's budget balance was checked
-- against the real-world balance (from a statement the agent read).
CREATE TABLE IF NOT EXISTS reconciliations (
  id                   INTEGER PRIMARY KEY,
  account_id           INTEGER NOT NULL REFERENCES accounts(id),
  actual_balance_cents INTEGER NOT NULL,
  budget_balance_cents INTEGER NOT NULL,
  difference_cents     INTEGER NOT NULL,   -- actual - budget at the time
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Splits: who pays what on a transaction. Ryan splits parts of the budget
-- with Lilly (e.g. housing), so every transaction is divided into owner
-- shares. All of Ryan's views sum only owner='ryan' — "$1,670 in housing"
-- never includes Lilly's half. Splits always sum to the transaction amount.
CREATE TABLE IF NOT EXISTS splits (
  id             INTEGER PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  pot_id         INTEGER REFERENCES pots(id),
  owner          TEXT NOT NULL CHECK (owner IN ('ryan','lilly')),
  amount_cents   INTEGER NOT NULL
);

-- Settlements: when Lilly sends a lump sum, it lands as a (100% Lilly-owned,
-- so Ryan's spend views ignore it) transaction, then gets allocated against
-- her outstanding shares oldest-first — "filling up those buckets".
CREATE TABLE IF NOT EXISTS settlements (
  id              INTEGER PRIMARY KEY,
  transaction_id  INTEGER NOT NULL REFERENCES transactions(id),
  date            TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL,   -- positive inflow
  leftover_cents  INTEGER NOT NULL DEFAULT 0,  -- overpayment becomes credit
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS settlement_allocations (
  id            INTEGER PRIMARY KEY,
  settlement_id INTEGER NOT NULL REFERENCES settlements(id),
  split_id      INTEGER NOT NULL REFERENCES splits(id),  -- Lilly's split being paid down
  amount_cents  INTEGER NOT NULL   -- positive
);
