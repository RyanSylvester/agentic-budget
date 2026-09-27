-- agentic-budget schema (DRAFT — pending scoping session)
-- Every money-moving row carries its provenance: who entered it and where it came from.

CREATE TABLE IF NOT EXISTS accounts (
  id        INTEGER PRIMARY KEY,
  name      TEXT NOT NULL,
  type      TEXT NOT NULL CHECK (type IN ('chequing','credit_card','savings')),
  last4     TEXT
);

-- Pots are managed directly in this app. hidden=1 keeps a retired pot's
-- history while hiding it from views.
CREATE TABLE IF NOT EXISTS pots (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  pot_group    TEXT NOT NULL,
  target_type  TEXT NOT NULL CHECK (target_type IN ('fixed','average_3mo','savings')),
  target_cents INTEGER NOT NULL DEFAULT 0,
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
  entered_by   TEXT NOT NULL CHECK (entered_by IN ('agent','user')),
  status       TEXT NOT NULL DEFAULT 'pending_review'
               CHECK (status IN ('pending_review','confirmed')),
  -- Cleared states. Reconciliation compares the budget balance
  -- against the real account balance; 'reconciled' locks the match.
  cleared      TEXT NOT NULL DEFAULT 'uncleared'
               CHECK (cleared IN ('uncleared','cleared','reconciled')),
  -- Only uncertain agent entries wait for review;
  -- the reason is shown in the review queue.
  review_reason TEXT,
  -- Movements between the user's own accounts (holding-account loop, savings
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
  rta_end_cents    INTEGER NOT NULL,       -- must be 0 at close
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

-- Splits: who pays what on a transaction. The user splits parts of the budget
-- with a partner (e.g. housing), so every transaction is divided into owner
-- shares. All of the user's views sum only owner='user' — "$1,670 in housing"
-- never includes the partner's half. Splits always sum to the transaction amount.
CREATE TABLE IF NOT EXISTS splits (
  id             INTEGER PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  pot_id         INTEGER REFERENCES pots(id),
  owner          TEXT NOT NULL CHECK (owner IN ('user','partner')),
  amount_cents   INTEGER NOT NULL
);

-- Settlements: when the partner sends a lump sum, it lands as a (100%
-- partner-owned, so the user's spend views ignore it) transaction, then gets
-- allocated against their outstanding shares oldest-first.
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
  split_id      INTEGER NOT NULL REFERENCES splits(id),  -- partner's split being paid down
  amount_cents  INTEGER NOT NULL   -- positive
);

-- App settings as data (never hardcoded in code): partner display name,
-- defaults, and other user-facing configuration.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
