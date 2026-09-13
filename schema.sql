-- Sruti — schema
-- Everyone who signs in with Google lands in `users` as pending until a teacher approves them.

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  google_sub   TEXT UNIQUE,
  email        TEXT NOT NULL,
  name         TEXT NOT NULL,
  avatar_url   TEXT,
  role         TEXT NOT NULL DEFAULT 'student',   -- teacher | student
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | active | paused | graduated | ended | disabled
  created_at   TEXT NOT NULL,
  approved_at  TEXT,
  approved_by  TEXT REFERENCES users(id),
  time_zone    TEXT,                               -- IANA name, e.g. 'America/New_York'
  location     TEXT,                               -- free text, e.g. 'Dubai, UAE'
  phone        TEXT,                               -- WhatsApp number, as typed
  palette      TEXT,                               -- brass | indigo | palm | kumkum | night
  theme_mode   TEXT,                               -- auto | light | dark
  status_note  TEXT,                               -- why they paused/ended
  status_changed_at TEXT
);

-- Teacher-defined groupings for the song catalogue. Whatever he actually uses:
-- "Sarali varisai", "Geethams", "Kalyani", "Arangetram set" — his call, not ours.
CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  name_ml     TEXT,                                -- Malayalam script, optional
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

-- A song. Shared across all students; who learns it is decided in `assignments`.
CREATE TABLE IF NOT EXISTS sections (
  id          TEXT PRIMARY KEY,
  group_id    TEXT REFERENCES groups(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,                       -- transliteration, e.g. "Vatapi Ganapatim"
  title_ml    TEXT,                                -- Malayalam script, optional
  raga        TEXT,
  taala       TEXT,
  composer    TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

-- Which songs a given student is currently working on.
CREATE TABLE IF NOT EXISTS assignments (
  id           TEXT PRIMARY KEY,
  student_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section_id   TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  assigned_by  TEXT REFERENCES users(id),
  assigned_at  TEXT NOT NULL,
  archived_at  TEXT,
  completed_at TEXT,                                 -- finished learning it
  UNIQUE(student_id, section_id)
);

-- One take of one song for one student. The file itself lives in R2 under r2_key.
CREATE TABLE IF NOT EXISTS recordings (
  id            TEXT PRIMARY KEY,
  section_id    TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  student_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT,                              -- "Pallavi, slow"
  kind          TEXT NOT NULL DEFAULT 'audio',     -- audio | video
  r2_key        TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  duration_sec  REAL,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  source        TEXT NOT NULL DEFAULT 'upload',    -- upload | recorded
  uploaded_by   TEXT REFERENCES users(id),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  part          TEXT,                              -- pallavi, anupallavi, charanam…
  description   TEXT,                              -- a few lines on what this take shows
  visibility    TEXT NOT NULL DEFAULT 'shared',    -- shared with everyone learning the song | private to student_id
  created_at    TEXT NOT NULL
);

-- Typed notes or a pasted screenshot. Either loose under the song, or pinned to one recording.
CREATE TABLE IF NOT EXISTS notes (
  id            TEXT PRIMARY KEY,
  section_id    TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  student_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recording_id  TEXT REFERENCES recordings(id) ON DELETE CASCADE,
  title         TEXT,                              -- short heading, so notes can be scanned
  body          TEXT,
  image_key     TEXT,
  image_mime    TEXT,
  image_bytes   INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT REFERENCES users(id),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  visibility    TEXT NOT NULL DEFAULT 'shared',    -- same rule as recordings
  created_at    TEXT NOT NULL
);

-- The lesson log: one row per class, with the resume point for next time.

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  student_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  held_on       TEXT NOT NULL,                     -- YYYY-MM-DD, the day of the class
  status        TEXT NOT NULL DEFAULT 'completed', -- ongoing | completed
  covered       TEXT,                              -- what was worked on
  left_off      TEXT,                              -- the resume point: where exactly we stopped
  next_focus    TEXT,                              -- what the student should practise before next time
  duration_min  INTEGER,
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

-- Which songs a lesson touched. A lesson usually covers more than one.
CREATE TABLE IF NOT EXISTS session_sections (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  section_id  TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, section_id)
);

-- The class schedule: slots anchored to Indian wall time, plus per-date changes.
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

-- Who a recording is for, when it isn't for everyone learning the song.
-- A row here is one student being given one recording; a recording can have
-- as many as the teacher likes. Only consulted when visibility <> 'shared'.
CREATE TABLE IF NOT EXISTS recording_shares (
  recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  student_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (recording_id, student_id)
);

-- The same, for a note.
CREATE TABLE IF NOT EXISTS note_shares (
  note_id       TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  student_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (note_id, student_id)
);
