-- 001: sinking schedules. One row per annual-bill pot: the expected bill
-- amount, the next due month, and the cadence. The monthly contribution is
-- always derived (never stored): ceil((expected - saved so far) / months left).
CREATE TABLE sinking_schedules (
  id             INTEGER PRIMARY KEY,
  pot_id         INTEGER NOT NULL UNIQUE REFERENCES pots(id),
  expected_cents INTEGER NOT NULL CHECK (expected_cents > 0),
  due_month      TEXT NOT NULL, -- YYYY-MM of the next bill
  cadence_months INTEGER NOT NULL DEFAULT 12 CHECK (cadence_months > 0)
);
