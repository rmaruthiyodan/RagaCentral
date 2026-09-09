-- One recording (or note) shared with several named students.
--
-- You don't need this file if you run the four steps — schema.sql,
-- sync-schema.mjs, indexes.sql, backfill.sql — which do the same thing.
-- It's here to apply the change deliberately, once.

CREATE TABLE IF NOT EXISTS recording_shares (
  recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  student_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (recording_id, student_id)
);

CREATE TABLE IF NOT EXISTS note_shares (
  note_id       TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  student_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (note_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_recshares_student ON recording_shares(student_id);
CREATE INDEX IF NOT EXISTS idx_noteshares_student ON note_shares(student_id);

-- Carry the old single-student 'private' rows across to the new table.
INSERT OR IGNORE INTO recording_shares (recording_id, student_id, created_at)
SELECT r.id, r.student_id, r.created_at
  FROM recordings r
  JOIN users u ON u.id = r.student_id AND u.role = 'student'
 WHERE r.visibility = 'private';
UPDATE recordings SET visibility = 'chosen' WHERE visibility = 'private';

INSERT OR IGNORE INTO note_shares (note_id, student_id, created_at)
SELECT n.id, n.student_id, n.created_at
  FROM notes n
  JOIN users u ON u.id = n.student_id AND u.role = 'student'
 WHERE n.visibility = 'private';
UPDATE notes SET visibility = 'chosen' WHERE visibility = 'private';
