-- Lesson log. Run this against an existing database:
--   npx wrangler d1 execute sruti --remote --file=./migrations/001_sessions.sql
-- A fresh install gets these tables from schema.sql already.

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
CREATE INDEX IF NOT EXISTS idx_sessions_student ON sessions(student_id, held_on DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status  ON sessions(status, student_id);

-- Which songs a lesson touched. A lesson usually covers more than one.
CREATE TABLE IF NOT EXISTS session_sections (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  section_id  TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, section_id)
);
CREATE INDEX IF NOT EXISTS idx_sessec_section ON session_sections(section_id);
