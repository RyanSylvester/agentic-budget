-- 20260928041320: remove review queue
--
-- Uncertainty is resolved in conversation now, never parked in the app:
-- there is no pending_review status and no review_reason. Any rows still
-- parked become confirmed, then the review columns are dropped in place.
-- (DROP COLUMN rather than a table rebuild: D1 enforces foreign keys, so
-- dropping the parent table fails while splits reference transactions.
-- Dropping the columns leaves the table - and its child references -
-- untouched.)
UPDATE transactions SET status = 'confirmed' WHERE status = 'pending_review';
ALTER TABLE transactions DROP COLUMN review_reason;
ALTER TABLE transactions DROP COLUMN status;
