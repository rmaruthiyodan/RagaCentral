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

-- ===================================================================
-- 2026-09-14 · one project becomes many.
--
-- Everything that existed before this change belongs to one teacher, so
-- it becomes project 'p_first'. Idempotence comes from the project's
-- fixed id and from every UPDATE being restricted to rows that have no
-- project yet — a second run matches nothing, because the first run
-- gave them all one.
--
-- Ordering matters in one place only: the project row must exist before
-- anything can point at it.
-- ===================================================================

INSERT OR IGNORE INTO projects (id, name, status, note, created_at)
VALUES (
  'p_first',
  'RP Sajeev Music',
  'active',
  'Everything that existed before projects were introduced.',
  datetime('now')
);

-- Everyone who already had an account joins it, keeping the role and the
-- standing they had. users.role and users.status stop being read after
-- this; this statement is the one place their old values still matter.
INSERT OR IGNORE INTO project_members
  (id, project_id, user_id, role, status, status_note, status_changed_at,
   approved_at, approved_by, joined_at)
SELECT 'pm_' || u.id, 'p_first', u.id,
       CASE WHEN u.role = 'teacher' THEN 'teacher' ELSE 'student' END,
       u.status, u.status_note, u.status_changed_at,
       u.approved_at, u.approved_by, u.created_at
  FROM users u;

-- Every piece of content that has no project yet is that project's.
UPDATE groups      SET project_id = 'p_first' WHERE project_id IS NULL;
UPDATE sections    SET project_id = 'p_first' WHERE project_id IS NULL;
UPDATE assignments SET project_id = 'p_first' WHERE project_id IS NULL;
UPDATE recordings  SET project_id = 'p_first' WHERE project_id IS NULL;
UPDATE notes       SET project_id = 'p_first' WHERE project_id IS NULL;
UPDATE sessions    SET project_id = 'p_first' WHERE project_id IS NULL;
UPDATE class_slots SET project_id = 'p_first' WHERE project_id IS NULL;

-- ===================================================================
-- Every admin teaches every practice.
--
-- Asked for as "make myself a teacher in all the projects by default".
-- An admin could already step into any practice, but that is the
-- visiting path: no membership, a banner across the top, and every
-- change written to the audit log. Right for somebody else's practice,
-- wrong for one you run yourself.
--
-- A standing rule rather than a one-off migration, so a practice
-- created before this — or by someone else — is covered too. INSERT OR
-- IGNORE means it never touches a membership that already exists, so a
-- role deliberately set to 'student' is left exactly as it is.
--
-- The one consequence worth knowing: an admin removed from a practice
-- is added back the next time this runs, because "every admin teaches
-- every practice" is what this says. Remove the statement, not the row,
-- if that is ever not what you want.
-- ===================================================================

INSERT OR IGNORE INTO project_members
  (id, project_id, user_id, role, status, approved_at, approved_by, joined_at)
SELECT 'pm_' || u.id || '_' || p.id, p.id, u.id, 'teacher', 'active',
       datetime('now'), u.id, datetime('now')
  FROM users u
  CROSS JOIN projects p
 WHERE u.is_admin = 1
   AND p.status = 'active';
