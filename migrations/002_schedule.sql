-- Class schedule. Run against an existing database:
--   npx wrangler d1 execute sruti --remote --file=./migrations/002_schedule.sql
-- A fresh install gets these from schema.sql already.

-- Where each person's clock is. An IANA zone name, never a numeric offset:
-- an offset is wrong for half the year in any country with daylight saving.
ALTER TABLE users ADD COLUMN time_zone TEXT;

-- Where they actually are, in words: "Dubai, UAE". Free text on purpose —
-- the zone drives every calculation, this is for the teacher to read.
ALTER TABLE users ADD COLUMN location TEXT;

-- A recurring weekly class, or a one-off. The time is always a wall time in
-- India, because that is where the teacher is and India has no daylight saving.
CREATE TABLE IF NOT EXISTS class_slots (
  id            TEXT PRIMARY KEY,
  student_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'weekly',   -- weekly | once
  weekday       INTEGER,                          -- 0=Sunday .. 6=Saturday, for weekly
  on_date       TEXT,                             -- YYYY-MM-DD, for one-offs
  time_ist      TEXT NOT NULL,                    -- 'HH:MM' in Asia/Kolkata
  duration_min  INTEGER NOT NULL DEFAULT 60,
  active_from   TEXT,
  active_until  TEXT,
  label         TEXT,
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slots_student ON class_slots(student_id);
CREATE INDEX IF NOT EXISTS idx_slots_weekday ON class_slots(kind, weekday);

-- One changed occurrence: skipped for a holiday, or moved to another time.
-- Keyed by the date the class was *originally* due, so the rule stays intact.
CREATE TABLE IF NOT EXISTS slot_exceptions (
  id            TEXT PRIMARY KEY,
  slot_id       TEXT NOT NULL REFERENCES class_slots(id) ON DELETE CASCADE,
  on_date       TEXT NOT NULL,
  action        TEXT NOT NULL,                    -- skip | move
  new_date      TEXT,
  new_time_ist  TEXT,
  reason        TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE(slot_id, on_date)
);
CREATE INDEX IF NOT EXISTS idx_slotex_slot ON slot_exceptions(slot_id, on_date);

-- A song a student has finished. Distinct from removing it from their list:
-- completed songs stay visible, with their recordings, as a record of progress.
ALTER TABLE assignments ADD COLUMN completed_at TEXT;
