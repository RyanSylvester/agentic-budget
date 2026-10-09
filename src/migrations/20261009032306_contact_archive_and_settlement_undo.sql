-- 20261009032306: contact archive and settlement undo
--
-- Contacts were hard-deleted, which is blocked once any split references
-- them, so a finished arrangement (an old roommate) stayed on the Sharing
-- page forever. archived = 1 hides a contact from the default lists while
-- keeping every split and settlement that references them.
--
-- Settlements can now be undone. Credit consumed when a later settlement
-- is applied is written as allocation rows that belong to the OLDER
-- (credit-holding) settlement, so undoing the later one needs to know which
-- rows it created. consumed_by_settlement_id records that: NULL for rows
-- funded by their own settlement's new money (and for every existing row),
-- otherwise the settlement whose application consumed the credit.
-- Non-destructive ALTERs only; existing rows get the defaults.
ALTER TABLE contacts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE settlement_allocations ADD COLUMN consumed_by_settlement_id INTEGER NULL;
