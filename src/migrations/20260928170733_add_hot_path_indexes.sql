-- 20260928170733: add hot path indexes
--
-- The splits table (and the settlement tables) had no indexes beyond the
-- primary key, so every per-transaction correlated subquery in
-- listTransactions, contactOwed, and contactCredit was a full table scan.
-- On 2026-09-28 the Transactions page alone burned ~6M D1 row reads in two
-- hours and exhausted the free-tier daily quota, taking the app down until
-- the quota reset. These indexes make the hot joins and filters seek
-- instead of scan. Non-destructive DDL only; IF NOT EXISTS so re-runs and
-- fresh databases (which run every migration) are safe.

-- Per-transaction split lookups filtered by owner: the rewritten
-- listTransactions and contactOwed/contactCredit join splits on
-- (user_id, owner, transaction_id).
CREATE INDEX IF NOT EXISTS idx_splits_user_owner_txn
  ON splits (user_id, owner, transaction_id);

-- Per-transaction split lookups without an owner filter.
CREATE INDEX IF NOT EXISTS idx_splits_user_txn
  ON splits (user_id, transaction_id);

-- Per-pot aggregations (allPotSpend / allPotInflow / allPotAssigned group
-- splits by pot_id per user).
CREATE INDEX IF NOT EXISTS idx_splits_user_pot
  ON splits (user_id, pot_id);

-- contactOwed joins settlement_allocations per split.
CREATE INDEX IF NOT EXISTS idx_settlement_allocations_split
  ON settlement_allocations (split_id);

-- contactCredit looks up a contact's unsettled settlements via splits.
CREATE INDEX IF NOT EXISTS idx_settlements_user_txn
  ON settlements (user_id, transaction_id);
