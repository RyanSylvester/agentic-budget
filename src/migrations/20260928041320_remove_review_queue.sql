-- 20260928041320: remove review queue
--
-- Uncertainty is resolved in conversation now, never parked in the app:
-- there is no pending_review status and no review_reason. Any rows still
-- parked become confirmed, then the review columns are dropped via a table
-- rebuild (same pattern as the multi-user rebuild).
UPDATE transactions SET status = 'confirmed' WHERE status = 'pending_review';

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
  cleared      TEXT NOT NULL DEFAULT 'uncleared'
               CHECK (cleared IN ('uncleared','cleared','reconciled')),
  is_transfer  INTEGER NOT NULL DEFAULT 0,
  external_id  TEXT,
  voided       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, external_id)
);
INSERT INTO transactions_new (id, user_id, date, account_id, pot_id, amount_cents, description, source, entered_by, cleared, is_transfer, external_id, voided, created_at)
  SELECT id, user_id, date, account_id, pot_id, amount_cents, description, source, entered_by, cleared, is_transfer, external_id, voided, created_at FROM transactions;
DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;
