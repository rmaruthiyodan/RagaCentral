-- ===================================================================
-- Data fixups. Run on every start, after the tables, columns and
-- indexes are in place.
--
-- Every statement here MUST be safe to run again on a database that
-- has already had it applied — these run on every container start.
-- The trick used throughout is to make the statement's own effect
-- remove the rows it selects, so the second run matches nothing.
-- ===================================================================

-- 2026-09-09 · one recording, several students.
--
-- 'private' used to mean "for the one student in recordings.student_id".
-- It now means "for the students listed in recording_shares", so the old
-- single student is copied across and the row is renamed to 'chosen'.
-- The rename is what makes this idempotent: a second run finds no
-- 'private' rows left. Anything not yet renamed is still treated as
-- restricted by the app, so an interrupted run fails closed, not open.

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
