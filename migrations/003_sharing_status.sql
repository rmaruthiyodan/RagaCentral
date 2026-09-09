-- Song-level sharing, song parts, and student statuses.
--   npx wrangler d1 execute sruti --remote --file=./migrations/003_sharing_status.sql
-- A fresh install gets all of this from schema.sql.

-- Recordings and notes now belong to the SONG, and are shared with everyone
-- learning it. `student_id` stays as "who this was made for", and is what a
-- private item is restricted to.
--   shared  — everyone assigned this song sees it (the default)
--   private — only the student in student_id sees it
ALTER TABLE recordings ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared';
ALTER TABLE notes      ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared';

-- Which part of the song a recording covers: pallavi, anupallavi, charanam,
-- chittaswaram, muktayi swaram, ettugada swaram… Free text, because the parts
-- differ by form and the teacher's names for them are the ones that matter.
ALTER TABLE recordings ADD COLUMN part TEXT;

-- Notes get an order too, so they can be arranged like recordings.
ALTER TABLE notes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_rec_section_vis ON recordings(section_id, visibility, sort_order);
CREATE INDEX IF NOT EXISTS idx_notes_section_vis ON notes(section_id, visibility, sort_order);

-- When a student stops, or finishes. `status` already held pending/active/
-- disabled; these extend it. Nothing is ever deleted — the recordings and the
-- lesson history stay, and a status can always be set back to active.
--   paused    — taking a break, expected back
--   graduated — finished their course of study
--   ended     — stopped for good
-- Stored as text, so no schema change is needed; this is the note that says so.
ALTER TABLE users ADD COLUMN status_note TEXT;
ALTER TABLE users ADD COLUMN status_changed_at TEXT;

-- Exceptions gain a third kind. 'skip' is a planned cancellation; 'missed' is a
-- class that should have happened and didn't, which is a different fact and is
-- always shown rather than hidden.
--   action: skip | move | missed
-- Stored as text, so no schema change is required; this note records the change.
