-- Indexes, applied AFTER the tables exist and after any missing columns have
-- been added. They live apart from schema.sql for one specific reason:
--
--   CREATE TABLE IF NOT EXISTS is a no-op on a table that already exists, so a
--   column added in a later version never appears on an upgraded database. An
--   index over that column, sitting in the same file, then fails with
--   "no such column" and takes the whole startup down with it.
--
-- Order is: tables → add missing columns (scripts/sync-schema.mjs) → indexes.

CREATE INDEX IF NOT EXISTS idx_users_status ON users(status, role);
CREATE INDEX IF NOT EXISTS idx_users_email  ON users(email);
CREATE INDEX IF NOT EXISTS idx_sections_group ON sections(group_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_assign_student ON assignments(student_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_rec_section_vis ON recordings(section_id, visibility, sort_order);
CREATE INDEX IF NOT EXISTS idx_rec_student_section ON recordings(student_id, section_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_notes_section_vis ON notes(section_id, visibility, sort_order);
CREATE INDEX IF NOT EXISTS idx_notes_student_section ON notes(student_id, section_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_student ON sessions(student_id, held_on DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status  ON sessions(status, student_id);
CREATE INDEX IF NOT EXISTS idx_sessec_section ON session_sections(section_id);
CREATE INDEX IF NOT EXISTS idx_slots_student ON class_slots(student_id);
CREATE INDEX IF NOT EXISTS idx_slots_weekday ON class_slots(kind, weekday);
CREATE INDEX IF NOT EXISTS idx_slotex_slot ON slot_exceptions(slot_id, on_date);
CREATE INDEX IF NOT EXISTS idx_recshares_student ON recording_shares(student_id);
CREATE INDEX IF NOT EXISTS idx_noteshares_student ON note_shares(student_id);
