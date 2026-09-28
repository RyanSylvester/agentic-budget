-- precheck: m1-user-backfill
-- 20260928031833: multi user
--
-- Phase M1 of the multi-user redesign: per-user data isolation.
--
-- Every data table gains `user_id INTEGER NOT NULL REFERENCES users(id)`.
-- The five tables whose uniqueness constraints were global are rebuilt so the
-- constraints become user-scoped (SQLite cannot ALTER a constraint):
--   transactions.external_id        -> UNIQUE (user_id, external_id)
--   assignments PRIMARY KEY        -> PRIMARY KEY (user_id, month, pot_id)
--   month_closes.month              -> UNIQUE (user_id, month)
--   sinking_schedules.pot_id        -> UNIQUE (user_id, pot_id)
--   settings.key                   -> PRIMARY KEY (user_id, key)
-- The other seven tables are rebuilt too: SQLite cannot add a NOT NULL column
-- to a table that already has rows, so the create-copy-drop-rename dance is
-- the only way to get a true NOT NULL user_id everywhere.
--
-- Backfill: every existing row is attributed to the first (lowest-id) user.
-- The `m1-user-backfill` precheck (src/migrations.ts) refuses to run this
-- migration when data rows exist but the users table is empty: the operator
-- must run `budget user create <username>` first, then retry. On a fresh
-- database (no rows anywhere) the backfill copies zero rows and the
-- subquery below never produces a NULL.
--
-- Also new: invite_codes (single-use signup codes), agent_tokens (per-user
-- agent API tokens; only the SHA-256 hash is stored), and users.role.

-- accounts
CREATE TABLE accounts_new (
  id        INTEGER PRIMARY KEY,
  user_id   INTEGER NOT NULL REFERENCES users(id),
  name      TEXT NOT NULL,
  type      TEXT NOT NULL CHECK (type IN ('chequing','credit_card','savings')),
  last4     TEXT
);
INSERT INTO accounts_new (id, user_id, name, type, last4)
  SELECT id, (SELECT id FROM users ORDER BY id LIMIT 1), name, type, last4 FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

-- pots
CREATE TABLE pots_new (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,
  pot_group    TEXT NOT NULL,
  target_type  TEXT NOT NULL CHECK (target_type IN ('fixed','average_3mo','savings')),
  target_cents INTEGER NOT NULL DEFAULT 0,
  hidden        INTEGER NOT NULL DEFAULT 0,
  is_assignable INTEGER NOT NULL DEFAULT 1,
  contact_id   INTEGER NULL REFERENCES contacts(id),
  share_pct    INTEGER NULL
);
INSERT INTO pots_new (id, user_id, name, pot_group, target_type, target_cents, hidden, is_assignable, contact_id, share_pct)
  SELECT id, (SELECT id FROM users ORDER BY id LIMIT 1), name, pot_group, target_type, target_cents, hidden, is_assignable, contact_id, share_pct FROM pots;
DROP TABLE pots;
ALTER TABLE pots_new RENAME TO pots;

-- contacts
CREATE TABLE contacts_new (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO contacts_new (id, user_id, name, created_at)
  SELECT id, (SELECT id FROM users ORDER BY id LIMIT 1), name, created_at FROM contacts;
DROP TABLE contacts;
ALTER TABLE contacts_new RENAME TO contacts;

-- transactions (external_id now UNIQUE per user)
CREATE TABLE transactions_new (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  date         TEXT NOT NULL,
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  pot_id       INTEGER REFERENCES pots(id),
  amount_cents INTEGER NOT NULL,
  description  TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('gmail','mention','manual')),
  entered_by   TEXT NOT NULL CHECK (entered_by IN ('agent','user')),
  status       TEXT NOT NULL DEFAULT 'pending_review'
               CHECK (status IN ('pending_review','confirmed')),
  cleared      TEXT NOT NULL DEFAULT 'uncleared'
               CHECK (cleared IN ('uncleared','cleared','reconciled')),
  review_reason TEXT,
  is_transfer  INTEGER NOT NULL DEFAULT 0,
  external_id  TEXT,
  voided       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, external_id)
);
INSERT INTO transactions_new (id, user_id, date, account_id, pot_id, amount_cents, description, source, entered_by, status, cleared, review_reason, is_transfer, external_id, voided, created_at)
  SELECT id, (SELECT id FROM users ORDER BY id LIMIT 1), date, account_id, pot_id, amount_cents, description, source, entered_by, status, cleared, review_reason, is_transfer, external_id, voided, created_at FROM transactions;
DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;

-- splits
CREATE TABLE splits_new (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  pot_id         INTEGER REFERENCES pots(id),
  owner          TEXT NOT NULL CHECK (owner IN ('user','contact')),
  contact_id     INTEGER NULL REFERENCES contacts(id),
  amount_cents   INTEGER NOT NULL
);
INSERT INTO splits_new (id, user_id, transaction_id, pot_id, owner, contact_id, amount_cents)
  SELECT id, (SELECT id FROM users ORDER BY id LIMIT 1), transaction_id, pot_id, owner, contact_id, amount_cents FROM splits;
DROP TABLE splits;
ALTER TABLE splits_new RENAME TO splits;

-- assignments (PRIMARY KEY now per user)
CREATE TABLE assignments_new (
  user_id INTEGER NOT NULL REFERENCES users(id),
  month   TEXT NOT NULL,
  pot_id  INTEGER NOT NULL REFERENCES pots(id),
  cents   INTEGER NOT NULL,
  PRIMARY KEY (user_id, month, pot_id)
);
INSERT INTO assignments_new (user_id, month, pot_id, cents)
  SELECT (SELECT id FROM users ORDER BY id LIMIT 1), month, pot_id, cents FROM assignments;
DROP TABLE assignments;
ALTER TABLE assignments_new RENAME TO assignments;

-- month_closes (month now UNIQUE per user)
CREATE TABLE month_closes_new (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  month            TEXT NOT NULL,
  rta_start_cents  INTEGER NOT NULL,
  rta_end_cents    INTEGER NOT NULL,
  moved_to_savings_cents INTEGER NOT NULL,
  applied_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, month)
);
INSERT INTO month_closes_new (id, user_id, month, rta_start_cents, rta_end_cents, moved_to_savings_cents, applied_at)
  SELECT id, (SELECT id FROM users ORDER BY id LIMIT 1), month, rta_start_cents, rta_end_cents, moved_to_savings_cents, applied_at FROM month_closes;
DROP TABLE month_closes;
ALTER TABLE month_closes_new RENAME TO month_closes;

-- reconciliations
CREATE TABLE reconciliations_new (
  id                   INTEGER PRIMARY KEY,
  user_id              INTEGER NOT NULL REFERENCES users(id),
  account_id           INTEGER NOT NULL REFERENCES accounts(id),
  actual_balance_cents INTEGER NOT NULL,
  budget_balance_cents INTEGER NOT NULL,
  difference_cents     INTEGER NOT NULL,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO reconciliations_new (id, user_id, account_id, actual_balance_cents, budget_balance_cents, difference_cents, created_at)
  SELECT id, (SELECT id FROM users ORDER BY id LIMIT 1), account_id, actual_balance_cents, budget_balance_cents, difference_cents, created_at FROM reconciliations;
DROP TABLE reconciliations;
ALTER TABLE reconciliations_new RENAME TO reconciliations;

-- settlements
CREATE TABLE settlements_new (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  transaction_id  INTEGER NOT NULL REFERENCES transactions(id),
  date            TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL,
  leftover_cents  INTEGER NOT NULL DEFAULT 0,
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO settlements_new (id, user_id, transaction_id, date, amount_cents, leftover_cents, note, created_at)
  SELECT id, (SELECT id FROM users ORDER BY id LIMIT 1), transaction_id, date, amount_cents, leftover_cents, note, created_at FROM settlements;
DROP TABLE settlements;
ALTER TABLE settlements_new RENAME TO settlements;

-- settlement_allocations
CREATE TABLE settlement_allocations_new (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  settlement_id INTEGER NOT NULL REFERENCES settlements(id),
  split_id      INTEGER NOT NULL REFERENCES splits(id),
  amount_cents  INTEGER NOT NULL
);
INSERT INTO settlement_allocations_new (id, user_id, settlement_id, split_id, amount_cents)
  SELECT id, (SELECT id FROM users ORDER BY id LIMIT 1), settlement_id, split_id, amount_cents FROM settlement_allocations;
DROP TABLE settlement_allocations;
ALTER TABLE settlement_allocations_new RENAME TO settlement_allocations;

-- sinking_schedules (pot_id now UNIQUE per user)
CREATE TABLE sinking_schedules_new (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  pot_id         INTEGER NOT NULL REFERENCES pots(id),
  expected_cents INTEGER NOT NULL CHECK (expected_cents > 0),
  due_month      TEXT NOT NULL,
  cadence_months INTEGER NOT NULL DEFAULT 12 CHECK (cadence_months > 0),
  UNIQUE (user_id, pot_id)
);
INSERT INTO sinking_schedules_new (id, user_id, pot_id, expected_cents, due_month, cadence_months)
  SELECT id, (SELECT id FROM users ORDER BY id LIMIT 1), pot_id, expected_cents, due_month, cadence_months FROM sinking_schedules;
DROP TABLE sinking_schedules;
ALTER TABLE sinking_schedules_new RENAME TO sinking_schedules;

-- settings (key now PRIMARY KEY per user)
CREATE TABLE settings_new (
  user_id INTEGER NOT NULL REFERENCES users(id),
  key     TEXT NOT NULL,
  value   TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
INSERT INTO settings_new (user_id, key, value)
  SELECT (SELECT id FROM users ORDER BY id LIMIT 1), key, value FROM settings;
DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;

-- invite_codes: single-use signup codes. created_by/used_by are NULL when
-- the code was minted outside a user context (operator tooling).
CREATE TABLE invite_codes (
  code       TEXT PRIMARY KEY,
  created_by INTEGER NULL REFERENCES users(id),
  used_by    INTEGER NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  used_at    TEXT NULL
);

-- agent_tokens: per-user agent API tokens. Only the SHA-256 hex of the token
-- is stored; the token itself is shown once at creation and never again.
CREATE TABLE agent_tokens (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- users.role: 'user' today; reserved for a future admin role.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
