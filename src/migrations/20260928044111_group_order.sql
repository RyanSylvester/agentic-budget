-- 20260928044111: custom pot-group ordering
--
-- Pot groups were just a TEXT label on pots, rendered in order of each
-- group's first pot (ORDER BY id). This adds a per-user group_order table
-- so the group section order is explicit and user-controlled.
--
-- Backfill: each user's groups get positions from the current display
-- order. Using MIN(pots.id) as the position captures "order of first
-- appearance" exactly, with no window functions (keeps this portable to
-- D1). The PUT /api/groups/order endpoint normalizes positions to
-- 0,1,2... whenever the user reorders.
CREATE TABLE group_order (
  user_id    INTEGER NOT NULL,
  group_name TEXT    NOT NULL,
  position   INTEGER NOT NULL,
  PRIMARY KEY (user_id, group_name)
);
INSERT INTO group_order (user_id, group_name, position)
SELECT user_id, pot_group, MIN(id) FROM pots GROUP BY user_id, pot_group;
