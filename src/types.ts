export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  BOOTSTRAP_TEACHER_EMAIL: string;
  SITE_NAME: string;
}

export interface User {
  id: string;
  google_sub: string | null;
  email: string;
  name: string;
  avatar_url: string | null;
  role: 'teacher' | 'student';
  status: 'pending' | 'active' | 'paused' | 'graduated' | 'ended' | 'disabled';
  created_at: string;
  approved_at: string | null;
  time_zone: string | null;
  location: string | null;
  /** WhatsApp number, as the teacher typed it. */
  phone: string | null;
  /** Their own choice of colours — see PALETTES in views/layout.ts. */
  palette: string | null;
  /** auto follows the device; light and dark override it. */
  theme_mode: string | null;
  status_note: string | null;
  status_changed_at: string | null;
}

export interface Group {
  id: string;
  name: string;
  name_ml: string | null;
  sort_order: number;
}

export interface Section {
  id: string;
  group_id: string | null;
  title: string;
  title_ml: string | null;
  raga: string | null;
  taala: string | null;
  composer: string | null;
  sort_order: number;
}

/**
 * 'shared'  — everyone learning the song.
 * 'chosen'  — only the students listed in recording_shares / note_shares.
 * 'private' — what 'chosen' used to be called, before one item could go to
 *             several students. Treated as 'chosen' everywhere, so a database
 *             the backfill hasn't reached yet stays closed rather than open.
 */
export type Visibility = 'shared' | 'chosen' | 'private';

export interface Recording {
  id: string;
  section_id: string;
  student_id: string;
  title: string | null;
  kind: 'audio' | 'video';
  r2_key: string;
  mime_type: string;
  duration_sec: number | null;
  size_bytes: number;
  source: 'upload' | 'recorded';
  uploaded_by: string | null;
  sort_order: number;
  part: string | null;
  description: string | null;
  visibility: Visibility;
  created_at: string;
}

export interface Note {
  id: string;
  section_id: string;
  student_id: string;
  recording_id: string | null;
  title: string | null;
  body: string | null;
  image_key: string | null;
  image_mime: string | null;
  sort_order: number;
  visibility: Visibility;
  created_at: string;
}

export type Vars = { user: User };

// Shared context shape so helpers and route handlers agree.
export type AppEnv = { Bindings: Env; Variables: Vars };

export interface Session {
  id: string;
  student_id: string;
  held_on: string;
  status: 'ongoing' | 'completed';
  covered: string | null;
  left_off: string | null;
  next_focus: string | null;
  duration_min: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string | null;
}

/** A session with the songs it touched, joined for display. */
export interface SessionRow extends Session {
  section_titles: string | null; // group_concat of song titles, SEP-joined
  section_ids: string | null;    // group_concat of song ids, SEP-joined
}

export interface ClassSlot {
  id: string;
  student_id: string;
  kind: 'weekly' | 'once';
  weekday: number | null;
  on_date: string | null;
  time_ist: string;
  duration_min: number;
  active_from: string | null;
  active_until: string | null;
  label: string | null;
  created_at: string;
}

export interface SlotExceptionRow {
  id: string;
  slot_id: string;
  on_date: string;
  action: 'skip' | 'move' | 'missed';
  new_date: string | null;
  new_time_ist: string | null;
  reason: string | null;
}

/** A song as it appears on a student's list: the section plus their counts. */
export interface AssignedRow extends Section {
  group_name: string | null;
  rec_count: number;
  note_count: number;
  last_added: string | null;
  completed_at: string | null;
}
