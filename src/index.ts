import { Hono } from 'hono';
import type { Env, Vars, User, Group, Section, Recording, Note, SessionRow, ClassSlot, AssignedRow } from './types';
import { SEP } from './views/sessions';
import * as Sched from './views/schedule';
import { songPage, type SongStudent, type SongPageData } from './views/song';
import * as Stu from './views/student';
import { classPage, type ClassPageData } from './views/klass';
import { STARTER_CATALOGUE, STARTER_COUNT } from './catalogue-seed';
import {
  expand, istToday, addDays, isValidZone, TEACHER_ZONE,
  type Slot, type SlotException, type Occurrence,
} from './tz';
import {
  currentUser, startSession, endSession, googleAuthUrl, setOAuthState,
  takeOAuthState, exchangeCode, upsertUser, requireUser, requireTeacher, requireTeacherJson,
} from './auth';
import { newId, now, extFor, slugify } from './util';
import { transcribe, DictateError, CARNATIC_TERMS } from './transcribe';
import * as V from './views/pages';
import type { StudentRow } from './views/pages';

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const site = (c: { env: Env }) => c.env.SITE_NAME || 'RP Sajeev Music';

/* ==================================================================
 * Is it up, and can it reach its two stores?
 *
 * Signed out on purpose, so an external monitor can watch it without
 * credentials. It answers with booleans and nothing else — no counts,
 * no names — because anyone can call it.
 *
 * Both checks are the cheapest possible: one row from D1, one listing
 * of a single object from R2. A 503 here means the app is up but blind,
 * which is the failure worth being woken for.
 * ================================================================== */

app.get('/healthz', async (c) => {
  const started = Date.now();
  let db = false;
  let media = false;

  try {
    const r = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    db = r?.ok === 1;
  } catch {
    db = false;
  }

  try {
    await c.env.MEDIA.list({ limit: 1 });
    media = true;
  } catch {
    media = false;
  }

  const ok = db && media;
  return c.json(
    {
      ok,
      db,
      media,
      /* Why the microphone is or isn't on the lesson form. No key, no
         account id — just enough to answer "I set the variables and
         nothing happened" without reading container logs, and it works
         the same deployed as it does in Docker. */
      dictate: dictateWhy(c.env),
      ms: Date.now() - started,
      at: new Date().toISOString(),
    },
    ok ? 200 : 503,
    { 'cache-control': 'no-store' },
  );
});

/**
 * Each person's own colours. Stored on the user, so the choice follows
 * them from the practice room laptop to the phone.
 *
 * One form posts either a palette or a mode — whichever button was
 * pressed — and we return to the page they were on. `back` comes from
 * the Referer header and only its path is used: a full URL from
 * anywhere else would be an open redirect.
 */
app.post('/settings/theme', requireUser, async (c) => {
  const f = await c.req.formData();
  const user = c.get('user');

  const palette = String(f.get('palette') ?? '');
  const mode = String(f.get('theme_mode') ?? '');

  if (palette && V.isPalette(palette)) {
    await c.env.DB.prepare('UPDATE users SET palette = ? WHERE id = ?').bind(palette, user.id).run();
  } else if (mode && V.isMode(mode)) {
    await c.env.DB.prepare('UPDATE users SET theme_mode = ? WHERE id = ?').bind(mode, user.id).run();
  }

  let back = user.role === 'teacher' ? '/t' : '/me';
  const ref = c.req.header('referer');
  if (ref) {
    try {
      const u = new URL(ref);
      if (u.origin === new URL(c.req.url).origin) back = u.pathname + u.search;
    } catch {
      /* a malformed Referer is not worth an error page */
    }
  }
  return c.redirect(back);
});

/* ================================================================== *
 * Sign in
 * ================================================================== */

app.get('/', async (c) => {
  const user = await currentUser(c);
  if (user?.status === 'active') return c.redirect(user.role === 'teacher' ? '/t/schedule/week' : '/me');
  if (user) return c.redirect('/waiting');
  return c.html(V.landing(site(c), c.req.query('error')));
});

app.get('/waiting', async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect('/');
  if (user.status === 'active') return c.redirect(user.role === 'teacher' ? '/t' : '/me');
  return c.html(V.waiting(user, site(c)));
});

app.get('/auth/google', (c) => {
  const state = newId();
  setOAuthState(c, state);
  return c.redirect(googleAuthUrl(c, state));
});

app.get('/auth/callback', async (c) => {
  const { code, state, error } = c.req.query();
  if (error) return c.redirect(`/?error=${encodeURIComponent('Google sign-in was cancelled.')}`);
  const expected = takeOAuthState(c);
  if (!code || !state || state !== expected)
    return c.redirect(`/?error=${encodeURIComponent('That sign-in link expired. Please try again.')}`);

  try {
    const profile = await exchangeCode(c, code);
    const user = await upsertUser(c, profile);
    await startSession(c, user.id);
    if (user.status !== 'active') return c.redirect('/waiting');
    return c.redirect(user.role === 'teacher' ? '/t/schedule/week' : '/me');
  } catch (e) {
    console.error('oauth', e);
    return c.redirect(`/?error=${encodeURIComponent('Could not complete sign-in. Please try again.')}`);
  }
});

app.post('/auth/logout', (c) => {
  endSession(c);
  return c.redirect('/');
});

/**
 * Local development only. Doubly gated: the DEV_LOGIN variable must be "true"
 * AND the request must come from localhost. It is never set in wrangler.toml —
 * put it in .dev.vars, which is gitignored and never deployed.
 */
app.get('/dev/login', async (c) => {
  const host = new URL(c.req.url).hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if ((c.env as unknown as { DEV_LOGIN?: string }).DEV_LOGIN !== 'true' || !local)
    return c.notFound();

  const email = (c.req.query('email') ?? 'teacher@example.com').toLowerCase();
  const role = c.req.query('role') === 'student' ? 'student' : 'teacher';
  let u = await c.env.DB.prepare('SELECT * FROM users WHERE lower(email) = ?').bind(email).first<User>();
  if (!u) {
    const id = newId('u');
    await c.env.DB.prepare(
      `INSERT INTO users (id, google_sub, email, name, role, status, created_at, approved_at)
       VALUES (?,?,?,?,?, 'active', ?, ?)`,
    )
      .bind(id, `dev-${id}`, email, c.req.query('name') ?? email.split('@')[0], role, now(), now())
      .run();
    u = (await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>())!;
  }
  await startSession(c, u.id);
  return c.redirect(u.role === 'teacher' ? '/t' : '/me');
});

/* ================================================================== *
 * Teacher — students
 * ================================================================== */

app.get('/t', requireTeacher, async (c) => {
  const db = c.env.DB;
  const q = (c.req.query('q') ?? '').trim();
  // Only current students by default. Paused, graduated and ended are still
  // there — they are never deleted — but they clutter the list he uses weekly.
  const showAll = c.req.query('all') === '1';
  const statusFilter = showAll
    ? "u.status IN ('active','paused','graduated','ended')"
    : "u.status = 'active'";

  const counts = `SELECT u.*,
        (SELECT COUNT(*) FROM assignments a WHERE a.student_id = u.id AND a.archived_at IS NULL) AS song_count,
        (SELECT COUNT(*) FROM recordings r WHERE r.student_id = u.id) AS rec_count,
        (SELECT MAX(r.created_at) FROM recordings r WHERE r.student_id = u.id) AS last_activity
       FROM users u
       WHERE ${statusFilter} AND u.role = 'student'`;
  const order = " ORDER BY CASE u.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, u.name COLLATE NOCASE";
  const students = q
    ? await db
        .prepare(`${counts} AND (u.name LIKE ?1 OR u.email LIKE ?1 OR u.location LIKE ?1 OR u.phone LIKE ?1)${order}`)
        .bind(`%${q}%`)
        .all<StudentRow>()
    : await db.prepare(counts + order).all<StudentRow>();

  const hidden = await db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role='student' AND status IN ('paused','graduated','ended')")
    .first<{ n: number }>();

  const pending = await db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'")
    .first<{ n: number }>();

  const used = await db
    .prepare(
      `SELECT (SELECT COALESCE(SUM(size_bytes),0) FROM recordings)
            + (SELECT COALESCE(SUM(image_bytes),0) FROM notes) AS b`,
    )
    .first<{ b: number }>();

  return c.html(
    V.teacherStudents(
      c.get('user'),
      students.results ?? [],
      pending?.n ?? 0,
      { bytes: used?.b ?? 0 },
      site(c),
      c.req.query('msg'),
      q,
      { showAll, hiddenCount: hidden?.n ?? 0 },
    ),
  );
});

/* ---------------- student status and adding ---------------- */

const STUDENT_STATUSES = ['active', 'paused', 'graduated', 'ended'] as const;

app.post('/t/students', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const name = String(f.get('name') ?? '').trim();
  const email = String(f.get('email') ?? '').trim().toLowerCase();
  if (!name || !email) return c.redirect('/t?msg=' + encodeURIComponent('A name and email are both needed.'));

  const existing = await c.env.DB.prepare('SELECT id, name FROM users WHERE lower(email) = ?')
    .bind(email)
    .first<{ id: string; name: string }>();
  if (existing) {
    await c.env.DB.prepare(
      "UPDATE users SET status='active', role='student', approved_at=?, status_changed_at=? WHERE id=?",
    )
      .bind(now(), now(), existing.id)
      .run();
    return c.redirect('/t?msg=' + encodeURIComponent(`${existing.name} was already here — now active.`));
  }

  const tz = String(f.get('time_zone') ?? '').trim();
  await c.env.DB.prepare(
    `INSERT INTO users (id, google_sub, email, name, role, status, created_at, approved_at, approved_by,
       location, phone, time_zone, status_changed_at)
     VALUES (?, NULL, ?, ?, 'student', 'active', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(newId('u'), email, name, now(), now(), c.get('user').id,
      String(f.get('location') ?? '').trim() || null,
      String(f.get('phone') ?? '').trim() || null,
      isValidZone(tz) ? tz : null, now())
    .run();
  return c.redirect(
    '/t?msg=' + encodeURIComponent(`${name} added. They're in as soon as they sign in with ${email}.`),
  );
});

app.post('/t/students/:id/status', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const status = String(f.get('status') ?? '');
  if (!STUDENT_STATUSES.includes(status as (typeof STUDENT_STATUSES)[number]))
    return c.redirect('/t');
  await c.env.DB.prepare(
    'UPDATE users SET status = ?, status_note = ?, status_changed_at = ? WHERE id = ? AND role = ?',
  )
    .bind(status, String(f.get('status_note') ?? '').trim() || null, now(), c.req.param('id'), 'student')
    .run();
  const back = String(f.get('back') ?? '') || `/t/s/${c.req.param('id')}`;
  const label =
    status === 'active' ? 'active again' : status === 'paused' ? 'paused' : status;
  return c.redirect(`${back}?msg=` + encodeURIComponent(`Marked ${label}.`));
});

/** Name, email and where they are — editable without going through the schedule screen. */
app.post('/t/students/:id/details', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const name = String(f.get('name') ?? '').trim();
  if (!name) return c.redirect(`/t/s/${c.req.param('id')}`);
  const tz = String(f.get('time_zone') ?? '').trim();
  if (tz && !isValidZone(tz))
    return c.redirect(`/t/s/${c.req.param('id')}?msg=` + encodeURIComponent('Unknown time zone.'));
  await c.env.DB.prepare(
    'UPDATE users SET name = ?, location = ?, phone = ?, time_zone = ? WHERE id = ?',
  )
    .bind(
      name,
      String(f.get('location') ?? '').trim() || null,
      String(f.get('phone') ?? '').trim() || null,
      tz || null,
      c.req.param('id'),
    )
    .run();
  return c.redirect(`/t/s/${c.req.param('id')}?msg=` + encodeURIComponent('Saved.'));
});

app.get('/t/approvals', requireTeacher, async (c) => {
  const pending = await c.env.DB.prepare(
    "SELECT * FROM users WHERE status = 'pending' ORDER BY created_at",
  ).all<User>();
  return c.html(V.teacherApprovals(c.get('user'), pending.results ?? [], site(c), c.req.query('msg')));
});

app.post('/t/approvals/:id', requireTeacher, async (c) => {
  const id = c.req.param('id');
  const form = await c.req.formData();
  const action = String(form.get('action') ?? '');
  const me = c.get('user');

  if (action === 'reject') {
    await c.env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(id).run();
    return c.redirect('/t/approvals?msg=' + encodeURIComponent('Request declined.'));
  }
  if (action !== 'student' && action !== 'teacher') return c.redirect('/t/approvals');

  await c.env.DB.prepare(
    "UPDATE users SET status = 'active', role = ?, approved_at = ?, approved_by = ? WHERE id = ?",
  )
    .bind(action, now(), me.id, id)
    .run();
  return c.redirect(
    '/t/approvals?msg=' + encodeURIComponent(action === 'teacher' ? 'Added as a teacher.' : 'Student approved.'),
  );
});

app.post('/t/invite', requireTeacher, async (c) => {
  const form = await c.req.formData();
  const name = String(form.get('name') ?? '').trim();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  if (!name || !email) return c.redirect('/t/approvals');

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE lower(email) = ?')
    .bind(email)
    .first<{ id: string }>();
  if (existing) {
    await c.env.DB.prepare("UPDATE users SET status='active', role='student', approved_at=? WHERE id=?")
      .bind(now(), existing.id)
      .run();
    return c.redirect('/t/approvals?msg=' + encodeURIComponent(`${name} is already here — now approved.`));
  }

  await c.env.DB.prepare(
    `INSERT INTO users (id, google_sub, email, name, role, status, created_at, approved_at, approved_by)
     VALUES (?, NULL, ?, ?, 'student', 'active', ?, ?, ?)`,
  )
    .bind(newId('u'), email, name, now(), now(), c.get('user').id)
    .run();
  return c.redirect(
    '/t/approvals?msg=' + encodeURIComponent(`${name} added. They're in as soon as they sign in with ${email}.`),
  );
});

/* ================================================================== *
 * Teacher — catalogue
 * ================================================================== */

app.get('/t/catalogue', requireTeacher, async (c) => {
  const db = c.env.DB;
  const q = (c.req.query('q') ?? '').trim();
  const groups = await db.prepare('SELECT * FROM groups ORDER BY sort_order, name COLLATE NOCASE').all<Group>();

  // One LIKE across every field a teacher might remember a song by. SQLite's
  // LIKE is case-insensitive for ASCII, and Malayalam has no case, so the
  // same clause serves both scripts.
  const base = `SELECT s.*, (SELECT COUNT(*) FROM assignments a WHERE a.section_id = s.id AND a.archived_at IS NULL) AS assigned_count
     FROM sections s`;
  const order = ' ORDER BY s.sort_order, s.title COLLATE NOCASE';
  const sections = q
    ? await db
        .prepare(
          `${base} WHERE s.title LIKE ?1 OR s.title_ml LIKE ?1 OR s.raga LIKE ?1
             OR s.taala LIKE ?1 OR s.composer LIKE ?1${order}`,
        )
        .bind(`%${q}%`)
        .all<Section & { assigned_count: number }>()
    : await db.prepare(base + order).all<Section & { assigned_count: number }>();

  return c.html(
    V.teacherCatalogue(c.get('user'), groups.results ?? [], sections.results ?? [], site(c), c.req.query('msg'), q),
  );
});

/** Change a song's details. Previously the only route was delete and re-add. */
app.post('/t/sections/:id', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const title = String(f.get('title') ?? '').trim();
  if (!title) return c.redirect('/t/catalogue');
  const str = (k: string) => String(f.get(k) ?? '').trim() || null;
  await c.env.DB.prepare(
    `UPDATE sections SET group_id=?, title=?, title_ml=?, raga=?, taala=?, composer=? WHERE id=?`,
  )
    .bind(str('group_id'), title, str('title_ml'), str('raga'), str('taala'), str('composer'), c.req.param('id'))
    .run();
  const back = String(f.get('back') ?? '') || '/t/catalogue';
  return c.redirect(`${back}?msg=` + encodeURIComponent(`"${title}" updated.`));
});

/** Change a recording's name, which part it covers, and who can hear it. */
app.post('/t/recordings/:id', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const rec = await c.env.DB.prepare('SELECT * FROM recordings WHERE id = ?')
    .bind(c.req.param('id'))
    .first<Recording>();
  if (!rec) return c.redirect('/t');

  // Two separate forms post here — the details, and the audience — so only
  // the fields a form actually sent are written. Sending everything from both
  // would mean one form silently blanking the other's fields.
  const sets: string[] = [];
  const vals: unknown[] = [];
  let msg = 'Recording updated.';

  if (f.has('title')) {
    // A recording has to stay identifiable, so an empty box keeps the old name.
    sets.push('title = ?');
    vals.push(String(f.get('title') ?? '').trim() || rec.title);
  }
  if (f.has('part')) {
    sets.push('part = ?');
    vals.push(String(f.get('part') ?? '').trim() || null);
  }
  if (f.has('description')) {
    sets.push('description = ?');
    vals.push(String(f.get('description') ?? '').trim() || null);
  }
  if (f.has('visibility')) {
    const ids = postedShareIds(f);
    const visibility = await setShares(c.env, 'recording', rec.id, String(f.get('visibility')), ids);
    sets.push('visibility = ?');
    vals.push(visibility);
    msg =
      visibility === 'shared'
        ? 'Shared with everyone learning this song.'
        : `Shared with ${ids.length} ${ids.length === 1 ? 'student' : 'students'}.`;
  }

  if (sets.length) {
    await c.env.DB.prepare(`UPDATE recordings SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...vals, rec.id)
      .run();
  }
  const back = String(f.get('back') ?? '') || `/t/song/${rec.section_id}`;
  return c.redirect(`${back}?msg=` + encodeURIComponent(msg));
});

/** Edit a note's text and who can see it. */
app.post('/t/notes/:id', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const note = await c.env.DB.prepare('SELECT * FROM notes WHERE id = ?')
    .bind(c.req.param('id'))
    .first<Note>();
  if (!note) return c.redirect('/t');

  // Same split as recordings: the text form and the audience form each write
  // only what they sent.
  const sets: string[] = [];
  const vals: unknown[] = [];
  let msg = 'Note updated.';

  if (f.has('title')) {
    sets.push('title = ?');
    vals.push(String(f.get('title') ?? '').trim() || null);
  }
  if (f.has('body')) {
    sets.push('body = ?');
    vals.push(String(f.get('body') ?? '').trim() || null);
  }
  if (f.has('body_ml')) {
    sets.push('body_ml = ?');
    vals.push(String(f.get('body_ml') ?? '').trim() || null);
  }
  if (f.has('visibility')) {
    const ids = postedShareIds(f);
    const visibility = await setShares(c.env, 'note', note.id, String(f.get('visibility')), ids);
    sets.push('visibility = ?');
    vals.push(visibility);
    msg =
      visibility === 'shared'
        ? 'Note shared with everyone learning this song.'
        : `Note shared with ${ids.length} ${ids.length === 1 ? 'student' : 'students'}.`;
  }

  if (sets.length) {
    await c.env.DB.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...vals, note.id)
      .run();
  }
  const back = String(f.get('back') ?? '') || `/t/song/${note.section_id}`;
  return c.redirect(`${back}?msg=` + encodeURIComponent(msg));
});

/** Reorder a note within its song, same swap as recordings. */
app.post('/t/notes/:id/move', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const dir = String(f.get('dir')) === 'up' ? 'up' : 'down';
  const note = await c.env.DB.prepare('SELECT * FROM notes WHERE id = ?')
    .bind(c.req.param('id'))
    .first<Note>();
  if (!note) return c.redirect('/t');

  // A note moves within its own list: the notes on the same recording, or the
  // song-wide ones. Before, everything was compared against the song-wide list,
  // so a note attached to a recording had no neighbour and never moved.
  const scope = note.recording_id ? 'recording_id = ?4' : 'recording_id IS NULL';
  const neighbour = await c.env.DB.prepare(
    dir === 'up'
      ? `SELECT * FROM notes WHERE section_id=?1 AND ${scope}
           AND (sort_order < ?2 OR (sort_order = ?2 AND created_at < ?3))
         ORDER BY sort_order DESC, created_at DESC LIMIT 1`
      : `SELECT * FROM notes WHERE section_id=?1 AND ${scope}
           AND (sort_order > ?2 OR (sort_order = ?2 AND created_at > ?3))
         ORDER BY sort_order ASC, created_at ASC LIMIT 1`,
  )
    .bind(
      ...(note.recording_id
        ? [note.section_id, note.sort_order, note.created_at, note.recording_id]
        : [note.section_id, note.sort_order, note.created_at]),
    )
    .first<Note>();

  if (neighbour) {
    const a = note.sort_order;
    const b = neighbour.sort_order;
    const [newA, newB] = a === b ? (dir === 'up' ? [b - 1, b] : [b + 1, b]) : [b, a];
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE notes SET sort_order = ? WHERE id = ?').bind(newA, note.id),
      c.env.DB.prepare('UPDATE notes SET sort_order = ? WHERE id = ?').bind(newB, neighbour.id),
    ]);
  }
  const back = String(f.get('back') ?? '') || `/t/song/${note.section_id}`;
  return c.redirect(back);
});

app.post('/t/groups', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const name = String(f.get('name') ?? '').trim();
  if (!name) return c.redirect('/t/catalogue');
  const max = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM groups').first<{ m: number }>();
  await c.env.DB.prepare('INSERT INTO groups (id, name, name_ml, sort_order, created_at) VALUES (?,?,?,?,?)')
    .bind(newId('g'), name, String(f.get('name_ml') ?? '').trim() || null, (max?.m ?? 0) + 10, now())
    .run();
  return c.redirect('/t/catalogue?msg=' + encodeURIComponent(`Group "${name}" added.`));
});

app.post('/t/groups/:id/delete', requireTeacher, async (c) => {
  await c.env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(c.req.param('id')).run();
  return c.redirect('/t/catalogue?msg=' + encodeURIComponent('Group deleted. Its songs are now ungrouped.'));
});

app.post('/t/sections', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const title = String(f.get('title') ?? '').trim();
  if (!title) return c.redirect('/t/catalogue');
  const max = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM sections').first<{ m: number }>();
  const str = (k: string) => String(f.get(k) ?? '').trim() || null;
  await c.env.DB.prepare(
    `INSERT INTO sections (id, group_id, title, title_ml, raga, taala, composer, sort_order, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  )
    .bind(newId('s'), str('group_id'), title, str('title_ml'), str('raga'), str('taala'), str('composer'), (max?.m ?? 0) + 10, now())
    .run();
  return c.redirect('/t/catalogue?msg=' + encodeURIComponent(`"${title}" added to the catalogue.`));
});

/** The song page: everything about one song in one place. */
app.get('/t/song/:id', requireTeacher, async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  const section = await db
    .prepare(`SELECT s.*, g.name AS group_name FROM sections s
              LEFT JOIN groups g ON g.id = s.group_id WHERE s.id = ?`)
    .bind(id)
    .first<Section & { group_name: string | null }>();
  if (!section) return c.html(V.notFound(c.get('user'), site(c)), 404);

  const groups = await db.prepare('SELECT * FROM groups ORDER BY sort_order, name COLLATE NOCASE').all<Group>();

  const recordings = await db
    .prepare(`SELECT r.*, u.name AS student_name FROM recordings r
              LEFT JOIN users u ON u.id = r.student_id
              WHERE r.section_id = ? ORDER BY r.sort_order, r.created_at`)
    .bind(id)
    .all<Recording & { student_name: string | null }>();

  // Every note on the song — the ones pinned to a recording and the song-wide
  // ones — split apart in the view rather than fetched twice.
  const notes = await db
    .prepare(`SELECT n.*, u.name AS student_name FROM notes n
              LEFT JOIN users u ON u.id = n.student_id
              WHERE n.section_id = ?
              ORDER BY n.sort_order, n.created_at`)
    .bind(id)
    .all<Note & { student_name: string | null }>();

  const roster = await db
    .prepare(
      `SELECT u.id, u.name, u.avatar_url, u.status, a.completed_at,
        (SELECT COUNT(*) FROM recording_shares rs JOIN recordings r ON r.id = rs.recording_id
          WHERE r.section_id = ?1 AND rs.student_id = u.id) AS rec_count
       FROM assignments a JOIN users u ON u.id = a.student_id
       WHERE a.section_id = ?1 AND a.archived_at IS NULL
       ORDER BY u.name COLLATE NOCASE`,
    )
    .bind(id)
    .all<SongStudent>();
  const rows = roster.results ?? [];

  const assignable = await db
    .prepare(
      `SELECT id, name, avatar_url, status, NULL AS completed_at, 0 AS rec_count FROM users
       WHERE role = 'student' AND status = 'active'
         AND id NOT IN (SELECT student_id FROM assignments WHERE section_id = ?1 AND archived_at IS NULL)
       ORDER BY name COLLATE NOCASE`,
    )
    .bind(id)
    .all<SongStudent>();

  const [recShares, noteShares] = await Promise.all([
    sharesFor(c.env, 'recording', id),
    sharesFor(c.env, 'note', id),
  ]);

  const data: SongPageData = {
    section,
    groups: groups.results ?? [],
    recordings: recordings.results ?? [],
    notes: notes.results ?? [],
    recShares,
    noteShares,
    learning: rows.filter((r) => !r.completed_at),
    finished: rows.filter((r) => r.completed_at),
    assignable: assignable.results ?? [],
    dictate: dictateEnabled(c.env),
  };
  return c.html(songPage(c.get('user'), data, site(c), c.req.query('msg')));
});

app.post('/t/song/:id/assign', requireTeacher, async (c) => {
  const sectionId = c.req.param('id');
  const f = await c.req.formData();
  const studentId = String(f.get('student_id') ?? '');
  if (!studentId) return c.redirect(`/t/song/${sectionId}`);
  await c.env.DB.prepare(
    `INSERT INTO assignments (id, student_id, section_id, assigned_by, assigned_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(student_id, section_id) DO UPDATE SET archived_at = NULL, completed_at = NULL`,
  )
    .bind(newId('a'), studentId, sectionId, c.get('user').id, now())
    .run();
  return c.redirect(`/t/song/${sectionId}?msg=` + encodeURIComponent('Assigned.'));
});

/** Load the starter repertoire. Adds only what is missing. */
app.post('/t/catalogue/seed', requireTeacher, async (c) => {
  const db = c.env.DB;
  let added = 0;

  const existingGroups = await db.prepare('SELECT id, name FROM groups').all<{ id: string; name: string }>();
  const groupByName = new Map((existingGroups.results ?? []).map((g) => [g.name.toLowerCase(), g.id]));
  const existingSongs = await db.prepare('SELECT title, raga FROM sections').all<{ title: string; raga: string | null }>();
  const haveSong = new Set(
    (existingSongs.results ?? []).map((s) => `${s.title.toLowerCase()}|${(s.raga ?? '').toLowerCase()}`),
  );

  let groupOrder = 0;
  let songOrder = 0;
  for (const g of STARTER_CATALOGUE) {
    groupOrder += 10;
    let gid = groupByName.get(g.name.toLowerCase());
    if (!gid) {
      gid = newId('g');
      await db
        .prepare('INSERT INTO groups (id, name, sort_order, created_at) VALUES (?,?,?,?)')
        .bind(gid, g.name, groupOrder, now())
        .run();
      groupByName.set(g.name.toLowerCase(), gid);
    }

    const inserts = [];
    for (const song of g.songs) {
      songOrder += 10;
      const key = `${song.title.toLowerCase()}|${(song.raga ?? '').toLowerCase()}`;
      if (haveSong.has(key)) continue;
      haveSong.add(key);
      inserts.push(
        db
          .prepare(
            `INSERT INTO sections (id, group_id, title, raga, taala, composer, sort_order, created_at)
             VALUES (?,?,?,?,?,?,?,?)`,
          )
          .bind(newId('s'), gid, song.title, song.raga, song.taala, song.composer, songOrder, now()),
      );
      added++;
    }
    // D1 caps how much one batch can carry, so a group at a time.
    if (inserts.length) await db.batch(inserts);
  }

  return c.redirect(
    '/t/catalogue?msg=' +
      encodeURIComponent(
        added ? `Added ${added} songs.` : 'Everything in the starter catalogue is already here.',
      ),
  );
});

/* ------------------------------------------------------------------ *
 * Moving one row up or down a hand-ordered list.
 *
 * Swaps sort_order with the nearest neighbour, where "nearest" means the
 * same ordering the list is displayed in — sort_order first, then a name
 * column, because a fresh catalogue has every sort_order at 0 and
 * without the tiebreak nothing has a neighbour at all. Rows that share a
 * sort_order are separated rather than swapped, which would be a no-op.
 *
 * `scope` keeps a song inside its own group: without it, moving the first
 * song of a group swaps it with the last song of the one above, which on
 * screen looks like the button did nothing.
 * ------------------------------------------------------------------ */
async function moveInList(
  env: Env,
  table: 'groups' | 'sections',
  id: string,
  dir: 'up' | 'down',
  nameCol: 'name' | 'title',
  scope?: { col: string; val: string | null },
): Promise<void> {
  const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`)
    .bind(id)
    .first<{ id: string; sort_order: number } & Record<string, unknown>>();
  if (!row) return;

  const where = scope ? ` AND COALESCE(${scope.col},'') = ?4` : '';
  const binds: unknown[] = [row.sort_order, String(row[nameCol] ?? ''), id];
  if (scope) binds.push(scope.val ?? '');

  const neighbour = await env.DB.prepare(
    dir === 'up'
      ? `SELECT id, sort_order FROM ${table}
           WHERE (sort_order < ?1 OR (sort_order = ?1 AND ${nameCol} COLLATE NOCASE < ?2))
             AND id <> ?3${where}
         ORDER BY sort_order DESC, ${nameCol} COLLATE NOCASE DESC LIMIT 1`
      : `SELECT id, sort_order FROM ${table}
           WHERE (sort_order > ?1 OR (sort_order = ?1 AND ${nameCol} COLLATE NOCASE > ?2))
             AND id <> ?3${where}
         ORDER BY sort_order ASC, ${nameCol} COLLATE NOCASE ASC LIMIT 1`,
  )
    .bind(...(binds as [number, string, string, ...unknown[]]))
    .first<{ id: string; sort_order: number }>();
  if (!neighbour) return;

  const a = row.sort_order;
  const b = neighbour.sort_order;
  const [newA, newB] = a === b ? (dir === 'up' ? [b - 1, b] : [b + 1, b]) : [b, a];
  await env.DB.batch([
    env.DB.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`).bind(newA, id),
    env.DB.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`).bind(newB, neighbour.id),
  ]);
}

app.post('/t/groups/:id/move', requireTeacher, async (c) => {
  const dir = String((await c.req.formData()).get('dir')) === 'up' ? 'up' : 'down';
  await moveInList(c.env, 'groups', c.req.param('id'), dir, 'name');
  return c.redirect('/t/catalogue');
});

app.post('/t/sections/:id/move', requireTeacher, async (c) => {
  const dir = String((await c.req.formData()).get('dir')) === 'up' ? 'up' : 'down';
  const s = await c.env.DB.prepare('SELECT group_id FROM sections WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ group_id: string | null }>();
  if (s)
    await moveInList(c.env, 'sections', c.req.param('id'), dir, 'title', {
      col: 'group_id',
      val: s.group_id,
    });
  return c.redirect('/t/catalogue');
});

app.post('/t/sections/:id/delete', requireTeacher, async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  // Remove the media from R2 first — an orphaned object costs storage forever.
  const recs = await db.prepare('SELECT r2_key FROM recordings WHERE section_id = ?').bind(id).all<{ r2_key: string }>();
  const imgs = await db
    .prepare('SELECT image_key FROM notes WHERE section_id = ? AND image_key IS NOT NULL')
    .bind(id)
    .all<{ image_key: string }>();
  const keys = [...(recs.results ?? []).map((r) => r.r2_key), ...(imgs.results ?? []).map((i) => i.image_key)];
  if (keys.length) await c.env.MEDIA.delete(keys);
  await db.prepare('DELETE FROM sections WHERE id = ?').bind(id).run();
  return c.redirect('/t/catalogue?msg=' + encodeURIComponent('Song deleted, along with its recordings.'));
});

/* ================================================================== *
 * Teacher — one student
 * ================================================================== */

/* ---------------- schedule ---------------- */

/** Slots for one student, or for everyone when studentId is omitted. */
async function loadSlots(env: Env, studentId?: string): Promise<Slot[]> {
  const q = studentId
    ? env.DB.prepare('SELECT * FROM class_slots WHERE student_id = ? ORDER BY weekday, time_ist').bind(studentId)
    : env.DB.prepare('SELECT * FROM class_slots ORDER BY weekday, time_ist');
  return ((await q.all<Slot>()).results ?? []);
}

/**
 * A student who isn't active has no classes ahead of them — but the ones
 * behind them still happened, and the teacher needs to be able to look back
 * at them. So the rule is about the date, not the student: keep everything up
 * to yesterday, drop today onwards.
 *
 * Applied where occurrences are turned into a view rather than inside
 * loadSlots, because the same slots feed the week you are looking back at and
 * the week you are planning.
 */
function stillScheduled(status: string | undefined, date: string, today: string): boolean {
  return status === 'active' || date < today;
}

async function loadExceptions(env: Env, from: string, to: string): Promise<SlotException[]> {
  // A moved class can land outside the window it came from, and one moved
  // *into* the window came from a date outside it, so the range is widened
  // generously either side rather than matched exactly. It has to cover the
  // padding expand() scans with, or a class moved across a week boundary is
  // read without its exception and appears on both dates.
  const r = await env.DB.prepare(
    `SELECT slot_id, on_date, action, new_date, new_time_ist, reason
     FROM slot_exceptions WHERE on_date BETWEEN ? AND ?`,
  )
    .bind(addDays(from, -21), addDays(to, 21))
    .all<SlotException>();
  return r.results ?? [];
}

/**
 * The lesson log for one student, newest first, with the songs each class
 * touched folded in. SEP is an unlikely-in-a-song-title separator so the
 * concatenated lists can be split apart again for display.
 */
async function sessionsFor(env: Env, studentId: string): Promise<SessionRow[]> {
  const r = await env.DB.prepare(
    `SELECT s.*,
       (SELECT group_concat(sec.title, ?2) FROM session_sections ss
          JOIN sections sec ON sec.id = ss.section_id
         WHERE ss.session_id = s.id) AS section_titles,
       (SELECT group_concat(ss.section_id, ?2) FROM session_sections ss
         WHERE ss.session_id = s.id) AS section_ids
     FROM sessions s
     WHERE s.student_id = ?1
     ORDER BY s.held_on DESC, s.created_at DESC`,
  )
    .bind(studentId, SEP)
    .all<SessionRow>();
  return r.results ?? [];
}

/** Shared by the create and update routes. */
function readSessionForm(f: FormData) {
  const str = (k: string) => String(f.get(k) ?? '').trim() || null;
  const dur = Number(f.get('duration_min'));
  return {
    held_on: String(f.get('held_on') ?? '').trim() || new Date().toISOString().slice(0, 10),
    status: String(f.get('status')) === 'ongoing' ? 'ongoing' : 'completed',
    covered: str('covered'),
    left_off: str('left_off'),
    next_focus: str('next_focus'),
    covered_ml: str('covered_ml'),
    left_off_ml: str('left_off_ml'),
    next_focus_ml: str('next_focus_ml'),
    duration_min: Number.isFinite(dur) && dur > 0 ? Math.round(dur) : null,
    sectionIds: f.getAll('section_ids').map(String).filter(Boolean),
  };
}

/** Replace the songs attached to a session. */
async function setSessionSections(env: Env, sessionId: string, sectionIds: string[]) {
  await env.DB.prepare('DELETE FROM session_sections WHERE session_id = ?').bind(sessionId).run();
  if (!sectionIds.length) return;
  const stmt = env.DB.prepare(
    'INSERT OR IGNORE INTO session_sections (session_id, section_id) VALUES (?, ?)',
  );
  await env.DB.batch(sectionIds.map((id) => stmt.bind(sessionId, id)));
}

async function assignedFor(env: Env, studentId: string): Promise<AssignedRow[]> {
  const r = await env.DB.prepare(
    `SELECT s.*, g.name AS group_name, a.completed_at AS completed_at,
       (SELECT COUNT(*) FROM recordings x WHERE x.section_id = s.id AND x.student_id = ?1) AS rec_count,
       (SELECT COUNT(*) FROM notes n  WHERE n.section_id = s.id AND n.student_id = ?1) AS note_count,
       (SELECT MAX(x.created_at) FROM recordings x WHERE x.section_id = s.id AND x.student_id = ?1) AS last_added
     FROM assignments a
     JOIN sections s ON s.id = a.section_id
     LEFT JOIN groups g ON g.id = s.group_id
     WHERE a.student_id = ?1 AND a.archived_at IS NULL
     ORDER BY COALESCE(g.sort_order, 9999), s.sort_order, s.title COLLATE NOCASE`,
  )
    .bind(studentId)
    .all<AssignedRow>();
  return r.results ?? [];
}

/* ---------------- one student, across five tabs ---------------- */

async function studentOr404(env: Env, id: string): Promise<User | null> {
  return (await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>()) ?? null;
}

async function tabCounts(env: Env, studentId: string): Promise<Stu.TabCounts> {
  const r = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM assignments WHERE student_id = ?1 AND archived_at IS NULL) AS songs,
            (SELECT COUNT(*) FROM sessions WHERE student_id = ?1) AS lessons`,
  )
    .bind(studentId)
    .first<Stu.TabCounts>();
  return r ?? { songs: 0, lessons: 0 };
}

/**
 * Their next classes, computed from the slots. A student who isn't active
 * has none: their weekly pattern is kept, but nothing is scheduled from it
 * until they come back.
 */
async function upcomingFor(env: Env, studentId: string, days = 28): Promise<Occurrence[]> {
  const student = await env.DB.prepare('SELECT status FROM users WHERE id = ?')
    .bind(studentId)
    .first<{ status: string }>();
  if (student && student.status !== 'active') return [];

  const slots = await loadSlots(env, studentId);
  if (!slots.length) return [];
  const from = istToday();
  return expand(slots, await loadExceptions(env, from, addDays(from, days - 1)), from, days);
}

app.get('/t/s/:id', requireTeacher, async (c) => {
  const student = await studentOr404(c.env, c.req.param('id'));
  if (!student) return c.html(V.notFound(c.get('user'), site(c)), 404);
  const assigned = await assignedFor(c.env, student.id);
  return c.html(
    Stu.overviewTab(
      c.get('user'),
      student,
      await tabCounts(c.env, student.id),
      {
        sessions: await sessionsFor(c.env, student.id),
        upcoming: await upcomingFor(c.env, student.id),
        learning: assigned.filter((a) => !a.completed_at),
      },
      site(c),
      c.req.query('msg'),
    ),
  );
});

app.get('/t/s/:id/songs', requireTeacher, async (c) => {
  const student = await studentOr404(c.env, c.req.param('id'));
  if (!student) return c.html(V.notFound(c.get('user'), site(c)), 404);
  const catalogue = await c.env.DB.prepare(
    `SELECT s.*, g.name AS group_name FROM sections s
     LEFT JOIN groups g ON g.id = s.group_id
     ORDER BY COALESCE(g.sort_order, 9999), s.sort_order, s.title COLLATE NOCASE`,
  ).all<Section & { group_name: string | null }>();
  return c.html(
    Stu.songsTab(
      c.get('user'),
      student,
      await tabCounts(c.env, student.id),
      await assignedFor(c.env, student.id),
      catalogue.results ?? [],
      site(c),
      c.req.query('msg'),
    ),
  );
});

app.get('/t/s/:id/lessons', requireTeacher, async (c) => {
  const student = await studentOr404(c.env, c.req.param('id'));
  if (!student) return c.html(V.notFound(c.get('user'), site(c)), 404);

  const today = istToday();
  const mp = c.req.query('month');
  const month = mp && /^\d{4}-\d{2}$/.test(mp) ? `${mp}-01` : `${today.slice(0, 7)}-01`;
  const slots = await loadSlots(c.env, student.id);
  let monthOccs = slots.length
    ? expand(slots, await loadExceptions(c.env, month, addDays(month, 41)), month, 42, {
        includeSkipped: true,
      })
    : [];
  // Classes that already happened stay on the calendar whatever the student's
  // status; classes that haven't only belong there if they are still coming.
  if (student.status !== 'active') monthOccs = monthOccs.filter((o) => o.date < today);

  const shift = (by: number) => {
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
  };
  const label = (ym: string) => {
    const [y, m] = ym.split('-').map(Number);
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'short', year: 'numeric' })
      .format(new Date(Date.UTC(y, m - 1, 1)));
  };

  return c.html(
    Stu.lessonsTab(
      c.get('user'),
      student,
      await tabCounts(c.env, student.id),
      {
        sessions: await sessionsFor(c.env, student.id),
        assigned: await assignedFor(c.env, student.id),
        month,
        monthOccs,
        prevMonth: shift(-1),
        nextMonth: shift(1),
        monthLabelPrev: label(shift(-1)),
        monthLabelNext: label(shift(1)),
        dictate: dictateEnabled(c.env),
      },
      site(c),
      c.req.query('msg'),
    ),
  );
});

app.get('/t/s/:id/schedule', requireTeacher, async (c) => {
  const student = await studentOr404(c.env, c.req.param('id'));
  if (!student) return c.html(V.notFound(c.get('user'), site(c)), 404);
  return c.html(
    Stu.scheduleTab(
      c.get('user'),
      student,
      await tabCounts(c.env, student.id),
      {
        slots: (await loadSlots(c.env, student.id)) as unknown as ClassSlot[],
        upcoming: await upcomingFor(c.env, student.id, 42),
      },
      site(c),
      c.req.query('msg'),
    ),
  );
});

app.get('/t/s/:id/settings', requireTeacher, async (c) => {
  const student = await studentOr404(c.env, c.req.param('id'));
  if (!student) return c.html(V.notFound(c.get('user'), site(c)), 404);
  return c.html(
    Stu.settingsTab(c.get('user'), student, await tabCounts(c.env, student.id), site(c), c.req.query('msg')),
  );
});

/* ---------------- one class, opened to teach it ---------------- */

app.get('/t/class/:slotId/:date', requireTeacher, async (c) => {
  const slotId = c.req.param('slotId');
  const date = c.req.param('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.redirect('/t/schedule/week');

  const slot = await c.env.DB.prepare('SELECT * FROM class_slots WHERE id = ?')
    .bind(slotId)
    .first<Slot>();
  if (!slot) return c.html(V.notFound(c.get('user'), site(c)), 404);

  const student = await c.env.DB.prepare(
    'SELECT id, name, email, avatar_url, time_zone, location, phone, status FROM users WHERE id = ?',
  )
    .bind(slot.student_id)
    .first<ClassPageData['student']>();
  if (!student) return c.html(V.notFound(c.get('user'), site(c)), 404);

  // `date` is the date the class was originally due, which is how an exception
  // is keyed — so a rescheduled class keeps working from its original link.
  // That is what `by: 'originalDate'` asks for: expand trims by the date a
  // class *lands* on by default, which would throw away the very occurrence
  // this page exists to show.
  const occ = expand([slot], await loadExceptions(c.env, date, date), date, 1, {
    includeSkipped: true,
    by: 'originalDate',
  }).find((o) => o.originalDate === date);
  if (!occ) return c.html(V.notFound(c.get('user'), site(c)), 404);

  const lastLesson =
    (await c.env.DB.prepare(
      `SELECT s.*, NULL AS section_titles, NULL AS section_ids FROM sessions s
       WHERE s.student_id = ?1 AND s.held_on < ?2
       ORDER BY s.held_on DESC, s.created_at DESC LIMIT 1`,
    )
      .bind(student.id, occ.date)
      .first<SessionRow>()) ?? null;

  const alreadyLogged =
    (await c.env.DB.prepare(
      `SELECT s.*, NULL AS section_titles, NULL AS section_ids FROM sessions s
       WHERE s.student_id = ?1 AND s.held_on = ?2 LIMIT 1`,
    )
      .bind(student.id, occ.date)
      .first<SessionRow>()) ?? null;

  const songs = (await assignedFor(c.env, student.id)).filter((a) => !a.completed_at);

  return c.html(
    classPage(
      c.get('user'),
      { student, occ, lastLesson, songs, alreadyLogged, dictate: dictateEnabled(c.env) },
      site(c),
      c.req.query('msg'),
    ),
  );
});

/* ---------------- the lesson log ---------------- */

app.post('/t/s/:id/sessions', requireTeacher, async (c) => {
  const studentId = c.req.param('id');
  const f = await c.req.formData();
  const d = readSessionForm(f);

  const id = newId('ls');
  await c.env.DB.prepare(
    `INSERT INTO sessions
       (id, student_id, held_on, status, covered, left_off, next_focus,
        covered_ml, left_off_ml, next_focus_ml, duration_min, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(id, studentId, d.held_on, d.status, d.covered, d.left_off, d.next_focus,
          d.covered_ml, d.left_off_ml, d.next_focus_ml, d.duration_min, c.get('user').id, now())
    .run();
  await setSessionSections(c.env, id, d.sectionIds);

  const back = String(f.get('back') ?? '') || `/t/s/${studentId}/lessons`;
  return c.redirect(
    `${back}?msg=` +
      encodeURIComponent(
        d.status === 'ongoing'
          ? 'Lesson logged. It stays pinned at the top until you mark it finished.'
          : 'Lesson logged.',
      ),
  );
});

app.post('/t/sessions/:id', requireTeacher, async (c) => {
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT student_id FROM sessions WHERE id = ?')
    .bind(id)
    .first<{ student_id: string }>();
  if (!existing) return c.redirect('/t');

  const d = readSessionForm(await c.req.formData());
  await c.env.DB.prepare(
    `UPDATE sessions SET held_on=?, status=?, covered=?, left_off=?, next_focus=?,
       covered_ml=?, left_off_ml=?, next_focus_ml=?, duration_min=?, updated_at=? WHERE id=?`,
  )
    .bind(d.held_on, d.status, d.covered, d.left_off, d.next_focus,
          d.covered_ml, d.left_off_ml, d.next_focus_ml, d.duration_min, now(), id)
    .run();
  await setSessionSections(c.env, id, d.sectionIds);

  return c.redirect(`/t/s/${existing.student_id}/lessons?msg=` + encodeURIComponent('Lesson updated.'));
});

app.post('/t/sessions/:id/complete', requireTeacher, async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT student_id FROM sessions WHERE id = ?')
    .bind(id)
    .first<{ student_id: string }>();
  if (!row) return c.redirect('/t');
  await c.env.DB.prepare("UPDATE sessions SET status='completed', updated_at=? WHERE id=?")
    .bind(now(), id)
    .run();
  return c.redirect(`/t/s/${row.student_id}/lessons?msg=` + encodeURIComponent('Lesson marked finished.'));
});

app.post('/t/sessions/:id/delete', requireTeacher, async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT student_id FROM sessions WHERE id = ?')
    .bind(id)
    .first<{ student_id: string }>();
  if (!row) return c.redirect('/t');
  await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
  return c.redirect(`/t/s/${row.student_id}/lessons?msg=` + encodeURIComponent('Lesson deleted from the log.'));
});

app.post('/t/s/:id/assign', requireTeacher, async (c) => {
  const studentId = c.req.param('id');
  const f = await c.req.formData();
  const sectionId = String(f.get('section_id') ?? '');
  if (!sectionId) return c.redirect(`/t/s/${studentId}`);
  await c.env.DB.prepare(
    `INSERT INTO assignments (id, student_id, section_id, assigned_by, assigned_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(student_id, section_id) DO UPDATE SET archived_at = NULL`,
  )
    .bind(newId('a'), studentId, sectionId, c.get('user').id, now())
    .run();
  const back = String(f.get('back') ?? '') || `/t/s/${studentId}/songs`;
  return c.redirect(`${back}?msg=` + encodeURIComponent('Song assigned.'));
});

/** Mark a song finished for this student — kept on their page, not removed. */
app.post('/t/s/:id/complete-song', requireTeacher, async (c) => {
  const studentId = c.req.param('id');
  const f = await c.req.formData();
  const done = String(f.get('undo')) !== '1';
  await c.env.DB.prepare(
    'UPDATE assignments SET completed_at = ? WHERE student_id = ? AND section_id = ?',
  )
    .bind(done ? now() : null, studentId, String(f.get('section_id') ?? ''))
    .run();
  const back = String(f.get('back') ?? '') || `/t/s/${studentId}`;
  return c.redirect(`${back}?msg=` + encodeURIComponent(done ? 'Marked as finished.' : 'Back in progress.'));
});

app.post('/t/s/:id/unassign', requireTeacher, async (c) => {
  const studentId = c.req.param('id');
  const f = await c.req.formData();
  await c.env.DB.prepare('UPDATE assignments SET archived_at = ? WHERE student_id = ? AND section_id = ?')
    .bind(now(), studentId, String(f.get('section_id') ?? ''))
    .run();
  const back = String(f.get('back') ?? '') || `/t/s/${studentId}/songs`;
  return c.redirect(`${back}?msg=` + encodeURIComponent('Removed from their list. Recordings kept.'));
});

/* ================================================================== *
 * The song workspace
 * ================================================================== */

async function loadSong(env: Env, studentId: string, sectionId: string) {
  const section = await env.DB.prepare(
    `SELECT s.*, g.name AS group_name FROM sections s
     LEFT JOIN groups g ON g.id = s.group_id WHERE s.id = ?`,
  )
    .bind(sectionId)
    .first<Section & { group_name: string | null }>();
  if (!section) return null;

  // Every recording on the song, each marked with whether this student may
  // hear it. The ones they may not are still listed — locked — so they can see
  // what the song holds and ask for it, and so the teacher can hand one over
  // from the same screen instead of hunting for it in the catalogue.
  const recordings = await env.DB.prepare(
    `SELECT r.*,
       CASE WHEN r.visibility = 'shared'
              OR EXISTS (SELECT 1 FROM recording_shares rs
                          WHERE rs.recording_id = r.id AND rs.student_id = ?2)
            THEN 0 ELSE 1 END AS locked
     FROM recordings r WHERE r.section_id = ?1
     ORDER BY r.sort_order, r.created_at`,
  )
    .bind(sectionId, studentId)
    .all<Recording & { locked: number }>();
  const notes = await env.DB.prepare(
    `SELECT * FROM notes WHERE section_id = ?1
       AND (visibility = 'shared'
            OR id IN (SELECT note_id FROM note_shares WHERE student_id = ?2))
     ORDER BY sort_order, created_at`,
  )
    .bind(sectionId, studentId)
    .all<Note>();

  return { section, recordings: recordings.results ?? [], notes: notes.results ?? [] };
}

app.get('/t/s/:sid/:secid', requireTeacher, async (c) => {
  const student = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(c.req.param('sid'))
    .first<User>();
  if (!student) return c.html(V.notFound(c.get('user'), site(c)), 404);
  const data = await loadSong(c.env, student.id, c.req.param('secid'));
  if (!data) return c.html(V.notFound(c.get('user'), site(c)), 404);

  return c.html(
    V.songPage({
      viewer: c.get('user'),
      student,
      ...data,
      siteName: site(c),
      msg: c.req.query('msg'),
      dictate: dictateEnabled(c.env),
    }),
  );
});

app.get('/me', requireUser, async (c) => {
  const user = c.get('user');
  if (user.role === 'teacher') return c.redirect('/t');
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const all = await assignedFor(c.env, user.id);
  const assigned = q
    ? all.filter((a) =>
        [a.title, a.title_ml, a.raga, a.taala, a.composer, a.group_name]
          .some((v) => (v ?? '').toLowerCase().includes(q)),
      )
    : all;

  // The next few classes, on the student's own clock.
  const from = istToday();
  const slots = await loadSlots(c.env, user.id);
  const occs = slots.length
    ? expand(slots, await loadExceptions(c.env, from, addDays(from, 27)), from, 28)
    : [];

  return c.html(V.studentHome(user, assigned, await sessionsFor(c.env, user.id), site(c), q, occs));
});

app.get('/me/:secid', requireUser, async (c) => {
  const user = c.get('user');
  if (user.role === 'teacher') return c.redirect('/t');

  // A student may only open a song that is actually assigned to them.
  const ok = await c.env.DB.prepare(
    'SELECT 1 AS x FROM assignments WHERE student_id = ? AND section_id = ? AND archived_at IS NULL',
  )
    .bind(user.id, c.req.param('secid'))
    .first();
  if (!ok) return c.html(V.notFound(user, site(c)), 404);

  const data = await loadSong(c.env, user.id, c.req.param('secid'));
  if (!data) return c.html(V.notFound(user, site(c)), 404);
  return c.html(V.songPage({ viewer: user, student: user, ...data, siteName: site(c) }));
});

/* ================================================================== *
 * Recordings — create, delete, stream
 * ================================================================== */

const MAX_UPLOAD = 90 * 1024 * 1024; // Workers caps request bodies at 100 MB.

/**
 * Can this student see this recording or note?
 *  - shared → yes, if the song is assigned to them
 *  - chosen → yes, only if they are one of the students it was given to
 *
 * Anything that isn't exactly 'shared' is treated as chosen, so a row the
 * backfill hasn't renamed yet is checked against the share table and comes
 * back false rather than true. Teachers are let through before this is called.
 */
async function studentMaySee(
  env: Env,
  studentId: string,
  item: { id: string; section_id: string; visibility: string },
  kind: 'recording' | 'note',
): Promise<boolean> {
  if (item.visibility !== 'shared') {
    const given = await env.DB.prepare(
      kind === 'recording'
        ? 'SELECT 1 AS x FROM recording_shares WHERE recording_id = ? AND student_id = ?'
        : 'SELECT 1 AS x FROM note_shares WHERE note_id = ? AND student_id = ?',
    )
      .bind(item.id, studentId)
      .first();
    if (!given) return false;
  }
  const assigned = await env.DB.prepare(
    'SELECT 1 AS x FROM assignments WHERE student_id = ? AND section_id = ? AND archived_at IS NULL',
  )
    .bind(studentId, item.section_id)
    .first();
  return !!assigned;
}

/**
 * Replace the list of students an item is shared with.
 *
 * Written as delete-then-insert rather than a diff: the form always posts the
 * complete list, so the whole set is what's being saved. `visibility` is set
 * in the same breath, and an empty list is forced back to 'shared' — a
 * recording nobody can hear is never what was meant.
 */
async function setShares(
  env: Env,
  kind: 'recording' | 'note',
  itemId: string,
  visibility: string,
  studentIds: string[],
): Promise<'shared' | 'chosen'> {
  const table = kind === 'recording' ? 'recording_shares' : 'note_shares';
  const col = kind === 'recording' ? 'recording_id' : 'note_id';
  const chosen = visibility === 'chosen' && studentIds.length > 0;

  const stmts = [env.DB.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).bind(itemId)];
  if (chosen) {
    const ts = now();
    for (const sid of studentIds) {
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO ${table} (${col}, student_id, created_at) VALUES (?,?,?)`,
        ).bind(itemId, sid, ts),
      );
    }
  }
  await env.DB.batch(stmts);
  return chosen ? 'chosen' : 'shared';
}

/** The students an item was given to, as ids. */
async function sharesFor(
  env: Env,
  kind: 'recording' | 'note',
  sectionId: string,
): Promise<Map<string, string[]>> {
  const rows =
    kind === 'recording'
      ? await env.DB.prepare(
          `SELECT s.recording_id AS item_id, s.student_id FROM recording_shares s
             JOIN recordings r ON r.id = s.recording_id WHERE r.section_id = ?`,
        )
          .bind(sectionId)
          .all<{ item_id: string; student_id: string }>()
      : await env.DB.prepare(
          `SELECT s.note_id AS item_id, s.student_id FROM note_shares s
             JOIN notes n ON n.id = s.note_id WHERE n.section_id = ?`,
        )
          .bind(sectionId)
          .all<{ item_id: string; student_id: string }>();

  const map = new Map<string, string[]>();
  for (const r of rows.results ?? []) {
    if (!map.has(r.item_id)) map.set(r.item_id, []);
    map.get(r.item_id)!.push(r.student_id);
  }
  return map;
}

/** The student ids ticked in a form that posts one checkbox per student. */
function postedShareIds(f: FormData): string[] {
  return f
    .getAll('share_ids')
    .map((v) => String(v))
    .filter(Boolean);
}

/* ================================================================== *
 * Speaking a lesson note
 *
 * Takes a short clip and hands back the Malayalam and an English
 * rendering. It writes nothing: the teacher gets both in the form and
 * decides what to keep. A dictation that goes wrong should cost him a
 * retry, never a lesson.
 * ================================================================== */

const MAX_DICTATE = 8 * 1024 * 1024; // ~2 minutes of anything a browser records

app.post('/t/api/dictate', requireTeacherJson, async (c) => {
  if (!dictateEnabled(c.env))
    return c.json({ error: 'Dictation is switched off for this site.' }, 503);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'That clip was too long to send in one go. Try a shorter one.' }, 413);
  }

  const file = form.get('audio');
  if (!(file instanceof File) || file.size === 0)
    return c.json({ error: 'Nothing was recorded.' }, 400);
  if (file.size > MAX_DICTATE)
    return c.json({ error: 'That clip is too long — keep it to a sentence or two.' }, 413);

  /* The vocabulary the model has no reason to know: the Carnatic terms,
     plus the titles and ragas of the songs this teacher actually
     teaches. Sarvam takes them as keyterms and gets them right; Whisper
     takes them as a prompt and does a little better than nothing. */
  const keyterms = [...CARNATIC_TERMS, ...(await catalogueTerms(c.env))];

  try {
    const t = await transcribe(c.env, await file.arrayBuffer(), file.type, keyterms);
    if (!t.ml && !t.en)
      return c.json({ error: "Nothing came back — the clip may be silent." }, 422);
    return c.json(t);
  } catch (e) {
    const known = e instanceof DictateError;
    if (!known) console.error('dictate failed', e);
    return c.json(
      { error: known ? (e as Error).message : 'The transcriber did not answer. Type it instead.' },
      known ? 400 : 502,
    );
  }
});

/** Song titles and ragas, deduped, as vocabulary hints. Cheap and cached. */
let termCache: { at: number; terms: string[] } | null = null;
async function catalogueTerms(env: Env): Promise<string[]> {
  if (termCache && Date.now() - termCache.at < 10 * 60_000) return termCache.terms;
  const { results } = await env.DB.prepare(
    'SELECT title, raga FROM sections ORDER BY id LIMIT 300',
  ).all<{ title: string; raga: string | null }>();
  const set = new Set<string>();
  for (const r of results ?? []) {
    if (r.title) set.add(r.title);
    if (r.raga) set.add(r.raga);
  }
  termCache = { at: Date.now(), terms: [...set] };
  return termCache.terms;
}

/**
 * The same decision as dictateEnabled, but it says why — which is the
 * question people actually have when the button isn't there.
 */
export function dictateWhy(env: Env): string {
  if ((env.DICTATE || '').toLowerCase() === 'off') return 'off (DICTATE=off)';
  const p = (env.DICTATE_PROVIDER || 'workers-ai').trim();
  if (p === 'sarvam')
    return env.SARVAM_API_KEY ? 'sarvam' : 'off (DICTATE_PROVIDER=sarvam but SARVAM_API_KEY is empty)';
  if (p === 'workers-ai')
    return env.AI ? 'workers-ai' : 'off (no AI binding — normal in Docker; use sarvam there)';
  return `off (DICTATE_PROVIDER="${p}" is not a known engine)`;
}

/** Is there anything behind the microphone button? */
export function dictateEnabled(env: Env): boolean {
  if ((env.DICTATE || '').toLowerCase() === 'off') return false;
  const p = (env.DICTATE_PROVIDER || 'workers-ai').trim();
  if (p === 'sarvam') return Boolean(env.SARVAM_API_KEY);
  return Boolean(env.AI);
}

app.post('/api/recordings', requireTeacherJson, async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'That file was too large to upload in one go.' }, 413);
  }

  const file = form.get('file');
  const sectionId = String(form.get('section_id') ?? '');
  // A recording added from the song page belongs to no particular student. It
  // is filed against the teacher and shared, which is what the access check
  // actually reads; student_id only gates a recording marked private.
  const studentId = String(form.get('student_id') ?? '') || c.get('user').id;
  const shareIds = form.getAll('share_ids').map((v) => String(v)).filter(Boolean);
  const visibility = String(form.get('visibility')) === 'chosen' && shareIds.length ? 'chosen' : 'shared';
  if (!(file instanceof File) || !sectionId)
    return c.json({ error: 'Missing file or song.' }, 400);
  if (file.size === 0) return c.json({ error: 'That file is empty.' }, 400);
  if (file.size > MAX_UPLOAD)
    return c.json({ error: `That file is ${(file.size / 1048576).toFixed(0)} MB. The limit is 90 MB.` }, 413);

  const mime = file.type || 'application/octet-stream';
  const kind = mime.startsWith('video/') || String(form.get('kind')) === 'video' ? 'video' : 'audio';
  // Every recording carries a name. An upload falls back to its filename; a
  // take recorded in the browser is named in the form before it can be saved.
  const title = String(form.get('title') ?? '').trim() || file.name.replace(/\.[^.]+$/, '').trim();
  if (!title) return c.json({ error: 'Give this recording a name first.' }, 400);
  const durationRaw = Number(form.get('duration_sec'));
  const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null;
  const source = String(form.get('source') ?? 'upload') === 'recorded' ? 'recorded' : 'upload';

  const id = newId('r');
  const key = `rec/${studentId}/${sectionId}/${id}-${slugify(title ?? kind)}.${extFor(mime)}`;

  await c.env.MEDIA.put(key, file.stream(), {
    httpMetadata: { contentType: mime, cacheControl: 'private, max-age=31536000' },
  });

  const max = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(sort_order),0) AS m FROM recordings WHERE section_id = ?',
  )
    .bind(sectionId)
    .first<{ m: number }>();

  await c.env.DB.prepare(
    `INSERT INTO recordings
       (id, section_id, student_id, title, kind, r2_key, mime_type, duration_sec, size_bytes,
        source, uploaded_by, sort_order, part, description, visibility, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(id, sectionId, studentId, title, kind, key, mime, duration, file.size, source,
      c.get('user').id, (max?.m ?? 0) + 10, String(form.get('part') ?? '').trim() || null,
      String(form.get('description') ?? '').trim() || null, visibility, now())
    .run();

  if (visibility === 'chosen') await setShares(c.env, 'recording', id, 'chosen', shareIds);

  return c.json({ ok: true, id });
});

/**
 * Move a recording up or down within its song by swapping sort_order with the
 * neighbour. Plain form posts, so it works without JavaScript.
 */
app.post('/t/recordings/:id/move', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const dir = String(f.get('dir')) === 'up' ? 'up' : 'down';
  const rec = await c.env.DB.prepare('SELECT * FROM recordings WHERE id = ?')
    .bind(c.req.param('id'))
    .first<Recording>();
  if (!rec) return c.redirect('/t');

  /* The song page groups recordings by the part they cover, so "up" has
     to mean "up within Pallavi" — swapping with a neighbour in another
     part looks, to the teacher, like the button did nothing at all. */
  const neighbour = await c.env.DB.prepare(
    dir === 'up'
      ? `SELECT * FROM recordings WHERE section_id=?1 AND COALESCE(part,'') = ?4
           AND (sort_order < ?2 OR (sort_order = ?2 AND created_at < ?3))
         ORDER BY sort_order DESC, created_at DESC LIMIT 1`
      : `SELECT * FROM recordings WHERE section_id=?1 AND COALESCE(part,'') = ?4
           AND (sort_order > ?2 OR (sort_order = ?2 AND created_at > ?3))
         ORDER BY sort_order ASC, created_at ASC LIMIT 1`,
  )
    .bind(rec.section_id, rec.sort_order, rec.created_at, rec.part ?? '')
    .first<Recording>();

  if (neighbour) {
    // Equal sort_order values would swap to no effect, so separate them first.
    const a = rec.sort_order;
    const b = neighbour.sort_order;
    const [newA, newB] = a === b ? (dir === 'up' ? [b - 1, b] : [b + 1, b]) : [b, a];
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE recordings SET sort_order = ? WHERE id = ?').bind(newA, rec.id),
      c.env.DB.prepare('UPDATE recordings SET sort_order = ? WHERE id = ?').bind(newB, neighbour.id),
    ]);
  }
  const back = String(f.get('back') ?? '');
  return c.redirect(back || `/t/song/${rec.section_id}`);
});

app.post('/t/recordings/:id/delete', requireTeacher, async (c) => {
  const rec = await c.env.DB.prepare('SELECT * FROM recordings WHERE id = ?')
    .bind(c.req.param('id'))
    .first<Recording>();
  if (!rec) return c.redirect('/t');
  await c.env.MEDIA.delete(rec.r2_key);
  await c.env.DB.prepare('DELETE FROM recordings WHERE id = ?').bind(rec.id).run();
  return c.redirect(`/t/song/${rec.section_id}?msg=` + encodeURIComponent('Recording deleted.'));
});

/** Stream media from R2 with Range support so seeking works in the player. */
app.get('/media/:id', requireUser, async (c) => {
  const user = c.get('user');
  const rec = await c.env.DB.prepare('SELECT * FROM recordings WHERE id = ?')
    .bind(c.req.param('id'))
    .first<Recording>();
  if (!rec) return c.notFound();
  if (user.role !== 'teacher' && !(await studentMaySee(c.env, user.id, rec, 'recording')))
    return c.text('Not yours to play.', 403);

  const rangeHeader = c.req.header('range');
  const obj = await c.env.MEDIA.get(rec.r2_key, rangeHeader ? { range: c.req.raw.headers } : undefined);
  if (!obj) return c.notFound();

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, max-age=3600');
  if (!headers.get('content-type')) headers.set('content-type', rec.mime_type);

  if (c.req.query('download')) {
    const name = `${slugify(rec.title ?? 'recording')}.${extFor(rec.mime_type)}`;
    headers.set('content-disposition', `attachment; filename="${name}"`);
  }

  const range = obj.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (rangeHeader && range) {
    const offset = range.suffix !== undefined ? rec.size_bytes - range.suffix : range.offset ?? 0;
    const length = range.suffix !== undefined ? range.suffix : range.length ?? obj.size - offset;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set('content-length', String(length));
    return new Response(obj.body, { status: 206, headers });
  }

  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { headers });
});

/**
 * Hand one recording to one student, or take it back, from the student's own
 * song page.
 *
 * Sharing an item that is already for everyone is a no-op. Locking one that is
 * for everyone is not: it becomes 'chosen' and every *other* student assigned
 * the song is written into the share table, so nobody else loses it. That is
 * why this doesn't go through setShares — an empty list there means "everyone",
 * which is the opposite of what locking the only student means.
 */
app.post('/t/recordings/:id/share', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const studentId = String(f.get('student_id') ?? '');
  const rec = await c.env.DB.prepare('SELECT * FROM recordings WHERE id = ?')
    .bind(c.req.param('id'))
    .first<Recording>();
  if (!rec || !studentId) return c.redirect('/t');

  if (rec.visibility !== 'shared') {
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO recording_shares (recording_id, student_id, created_at) VALUES (?,?,?)',
    )
      .bind(rec.id, studentId, now())
      .run();
  }
  const back = String(f.get('back') ?? '') || `/t/s/${studentId}/${rec.section_id}`;
  return c.redirect(`${back}?msg=` + encodeURIComponent('Unlocked for this student.'));
});

app.post('/t/recordings/:id/unshare', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const studentId = String(f.get('student_id') ?? '');
  const rec = await c.env.DB.prepare('SELECT * FROM recordings WHERE id = ?')
    .bind(c.req.param('id'))
    .first<Recording>();
  if (!rec || !studentId) return c.redirect('/t');

  if (rec.visibility === 'shared') {
    const others = await c.env.DB.prepare(
      `SELECT student_id FROM assignments
        WHERE section_id = ? AND archived_at IS NULL AND student_id <> ?`,
    )
      .bind(rec.section_id, studentId)
      .all<{ student_id: string }>();
    const ts = now();
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM recording_shares WHERE recording_id = ?').bind(rec.id),
      ...(others.results ?? []).map((r) =>
        c.env.DB.prepare(
          'INSERT OR IGNORE INTO recording_shares (recording_id, student_id, created_at) VALUES (?,?,?)',
        ).bind(rec.id, r.student_id, ts),
      ),
      c.env.DB.prepare("UPDATE recordings SET visibility = 'chosen' WHERE id = ?").bind(rec.id),
    ]);
  } else {
    await c.env.DB.prepare(
      'DELETE FROM recording_shares WHERE recording_id = ? AND student_id = ?',
    )
      .bind(rec.id, studentId)
      .run();
  }
  const back = String(f.get('back') ?? '') || `/t/s/${studentId}/${rec.section_id}`;
  return c.redirect(`${back}?msg=` + encodeURIComponent('Locked for this student.'));
});

/* ================================================================== *
 * Notes
 * ================================================================== */

app.post('/t/notes', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const sectionId = String(f.get('section_id') ?? '');
  const shareIds = postedShareIds(f);
  // Notes are for everyone learning the song unless the teacher picks people.
  const wantChosen = String(f.get('visibility')) === 'chosen' && shareIds.length > 0;
  const visibility = wantChosen ? 'chosen' : 'shared';
  const studentId = String(f.get('student_id') ?? '') || c.get('user').id;
  const recordingId = String(f.get('recording_id') ?? '') || null;
  const body = String(f.get('body') ?? '').trim() || null;
  const bodyMl = String(f.get('body_ml') ?? '').trim() || null;
  const image = f.get('image');
  const back = String(f.get('back') ?? '') || `/t/s/${studentId}/${sectionId}`;

  if (!sectionId) return c.redirect('/t');

  let imageKey: string | null = null;
  let imageMime: string | null = null;
  let imageBytes = 0;

  const id = newId('n');
  if (image instanceof File && image.size > 0) {
    if (image.size > 12 * 1024 * 1024)
      return c.redirect(`${back}?msg=` + encodeURIComponent('That image is over 12 MB — try a smaller one.'));
    imageMime = image.type || 'image/png';
    imageBytes = image.size;
    imageKey = `note/${studentId}/${sectionId}/${id}.${extFor(imageMime)}`;
    await c.env.MEDIA.put(imageKey, image.stream(), { httpMetadata: { contentType: imageMime } });
  }

  if (!body && !bodyMl && !imageKey) return c.redirect(back);

  // Ordered within its own list — the notes on this recording, or the song's.
  const nmax = await c.env.DB.prepare(
    recordingId
      ? 'SELECT COALESCE(MAX(sort_order),0) AS m FROM notes WHERE section_id = ? AND recording_id = ?'
      : 'SELECT COALESCE(MAX(sort_order),0) AS m FROM notes WHERE section_id = ? AND recording_id IS NULL',
  )
    .bind(...(recordingId ? [sectionId, recordingId] : [sectionId]))
    .first<{ m: number }>();

  await c.env.DB.prepare(
    `INSERT INTO notes (id, section_id, student_id, recording_id, title, body, body_ml,
       image_key, image_mime, image_bytes, created_by, sort_order, visibility, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(id, sectionId, studentId, recordingId, String(f.get('title') ?? '').trim() || null,
      body, bodyMl, imageKey, imageMime, imageBytes,
      c.get('user').id, (nmax?.m ?? 0) + 10, visibility, now())
    .run();

  if (wantChosen) await setShares(c.env, 'note', id, 'chosen', shareIds);

  return c.redirect(`${back}?msg=` + encodeURIComponent('Note saved.'));
});

app.post('/notes/:id/delete', requireTeacher, async (c) => {
  const note = await c.env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(c.req.param('id')).first<Note>();
  if (!note) return c.redirect('/t');
  if (note.image_key) await c.env.MEDIA.delete(note.image_key);
  await c.env.DB.prepare('DELETE FROM notes WHERE id = ?').bind(note.id).run();
  return c.redirect(`/t/song/${note.section_id}?msg=` + encodeURIComponent('Note deleted.'));
});

app.get('/img/:id', requireUser, async (c) => {
  const user = c.get('user');
  const note = await c.env.DB.prepare('SELECT * FROM notes WHERE id = ?').bind(c.req.param('id')).first<Note>();
  if (!note?.image_key) return c.notFound();
  if (user.role !== 'teacher' && !(await studentMaySee(c.env, user.id, note, 'note')))
    return c.text('Not yours.', 403);

  const obj = await c.env.MEDIA.get(note.image_key);
  if (!obj) return c.notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('cache-control', 'private, max-age=86400');
  headers.set('etag', obj.httpEtag);
  if (!headers.get('content-type')) headers.set('content-type', note.image_mime ?? 'image/png');
  // ?download=1 turns the same URL into a save-to-disk, named after the note.
  if (c.req.query('download')) {
    const ext = extFor(note.image_mime ?? 'image/png');
    headers.set(
      'content-disposition',
      `attachment; filename="${slugify(note.title || 'note')}.${ext}"`,
    );
  }
  return new Response(obj.body, { headers });
});

/**
 * The note itself as a text file — heading, body, and where it came from.
 * Notation screenshots download from /img/:id?download=1; this is for the
 * words, which are often the part worth keeping beside a practice file.
 */
app.get('/note/:id/download', requireUser, async (c) => {
  const user = c.get('user');
  const note = await c.env.DB.prepare(
    `SELECT n.*, s.title AS song_title, r.title AS rec_title FROM notes n
       JOIN sections s ON s.id = n.section_id
       LEFT JOIN recordings r ON r.id = n.recording_id
      WHERE n.id = ?`,
  )
    .bind(c.req.param('id'))
    .first<Note & { song_title: string; rec_title: string | null }>();
  if (!note) return c.notFound();
  if (user.role !== 'teacher' && !(await studentMaySee(c.env, user.id, note, 'note')))
    return c.text('Not yours.', 403);

  const lines = [
    note.title || 'Note',
    '='.repeat((note.title || 'Note').length),
    '',
    `Song: ${note.song_title}`,
    ...(note.rec_title ? [`Recording: ${note.rec_title}`] : []),
    `Written: ${note.created_at.slice(0, 10)}`,
    '',
    // Malayalam first, the way it reads on screen; the file is UTF-8.
    ...(note.body_ml ? [note.body_ml, ''] : []),
    ...(note.body ? [note.body] : []),
    ...(note.image_key ? ['', '(This note also has an image — download it separately.)'] : []),
    '',
  ];

  return new Response(lines.join('\n'), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="${slugify(
        `${note.song_title}-${note.title || 'note'}`,
      )}.txt"`,
    },
  });
});

/* ================================================================== */

/* ================================================================== *
 * Schedule
 * ================================================================== */

app.get('/t/schedule', requireTeacher, async (c) => {
  const days = Math.min(60, Math.max(1, Number(c.req.query('days')) || 14));
  const from = istToday();
  const to = addDays(from, days - 1);

  const slots = await loadSlots(c.env);
  const exceptions = await loadExceptions(c.env, from, to);
  const occs = expand(slots, exceptions, from, days, { includeSkipped: true });

  const studentIds = [...new Set(occs.map((o) => o.slot.student_id))];
  const students = new Map<string, Sched.WithZone>();
  if (studentIds.length) {
    const rows = await c.env.DB.prepare(
      `SELECT id, name, avatar_url, time_zone, location, status FROM users
       WHERE id IN (${studentIds.map(() => '?').join(',')})`,
    )
      .bind(...studentIds)
      .all<Sched.WithZone>();
    for (const r of rows.results ?? []) students.set(r.id, r);
  }

  // Group by the Indian date, since that is the teacher's own day. This view
  // only ever looks forward, so a student who isn't active has nothing in it.
  const byDate = new Map<string, Sched.DayGroup>();
  for (let i = 0; i < days; i++) byDate.set(addDays(from, i), { date: addDays(from, i), items: [] });
  for (const occ of occs) {
    const st = students.get(occ.slot.student_id);
    if (!st || !stillScheduled(st.status, occ.date, from)) continue;
    const g = byDate.get(occ.date);
    if (g) g.items.push({ occ, student: st });
  }

  return c.html(
    Sched.schedulePageWrapped(c.get('user'), [...byDate.values()], days, site(c), c.req.query('msg')),
  );
});

/** Load the students behind a set of occurrences, keyed by id. */
async function studentsFor(env: Env, ids: string[]): Promise<Map<string, Sched.WithZone>> {
  const out = new Map<string, Sched.WithZone>();
  if (!ids.length) return out;
  const rows = await env.DB.prepare(
    `SELECT id, name, avatar_url, time_zone, location, status FROM users
     WHERE id IN (${ids.map(() => '?').join(',')})`,
  )
    .bind(...ids)
    .all<Sched.WithZone>();
  for (const r of rows.results ?? []) out.set(r.id, r);
  return out;
}

/** The week as a grid. Weeks start on Sunday, matching the weekday numbering. */
app.get('/t/schedule/week', requireTeacher, async (c) => {
  const today = istToday();
  const asked = c.req.query('start');
  const anchor = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : today;
  const [ay, am, ad] = anchor.split('-').map(Number);
  const dow = new Date(Date.UTC(ay, am - 1, ad)).getUTCDay();
  const start = addDays(anchor, -dow);

  const slots = await loadSlots(c.env);
  const exceptions = await loadExceptions(c.env, start, addDays(start, 6));
  const occs = expand(slots, exceptions, start, 7, { includeSkipped: true });
  const students = await studentsFor(c.env, [...new Set(occs.map((o) => o.slot.student_id))]);

  const cells: Sched.DayGroup[] = [];
  for (let i = 0; i < 7; i++) cells.push({ date: addDays(start, i), items: [] });
  for (const occ of occs) {
    const st = students.get(occ.slot.student_id);
    // Look back at any week and a paused student's classes are all still
    // there; from today onwards they are not.
    if (st && !stillScheduled(st.status, occ.date, today)) continue;
    const cell = cells.find((x) => x.date === occ.date);
    if (st && cell) cell.items.push({ occ, student: st });
  }

  return c.html(Sched.weekCalendar(c.get('user'), start, cells, site(c), c.req.query('msg')));
});

/** One day, opened from the calendar. */
app.get('/t/schedule/day/:date', requireTeacher, async (c) => {
  const date = c.req.param('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.redirect('/t/schedule/week');

  const slots = await loadSlots(c.env);
  const exceptions = await loadExceptions(c.env, date, date);
  const occs = expand(slots, exceptions, date, 1, { includeSkipped: true }).filter((o) => o.date === date);
  const students = await studentsFor(c.env, [...new Set(occs.map((o) => o.slot.student_id))]);

  const items = occs
    .map((occ) => ({ occ, student: students.get(occ.slot.student_id)! }))
    .filter((x) => x.student && stillScheduled(x.student.status, x.occ.date, istToday()));

  return c.html(Sched.dayView(c.get('user'), date, items, site(c), c.req.query('msg')));
});

/** A class that should have happened and didn't. Distinct from a cancellation. */
app.post('/t/slots/:id/missed', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const onDate = String(f.get('on_date') ?? '');
  if (!onDate) return c.redirect('/t/schedule');
  await c.env.DB.prepare(
    `INSERT INTO slot_exceptions (id, slot_id, on_date, action, reason, created_at)
     VALUES (?,?,?,'missed',?,?)
     ON CONFLICT(slot_id, on_date) DO UPDATE SET
       action='missed', new_date=NULL, new_time_ist=NULL, reason=excluded.reason`,
  )
    .bind(newId('ex'), c.req.param('id'), onDate, String(f.get('reason') ?? '').trim() || null, now())
    .run();
  const back = String(f.get('back') ?? '') || '/t/schedule';
  return c.redirect(`${back}?msg=` + encodeURIComponent('Marked as missed. Reschedule it below if you want to.'));
});

app.get('/t/schedule/slots', requireTeacher, async (c) => {
  const students = await c.env.DB.prepare(
    `SELECT id, name, email, avatar_url, time_zone, location FROM users
     WHERE status = 'active' AND role = 'student' ORDER BY name COLLATE NOCASE`,
  ).all<Sched.WithZone & { email: string }>();

  const allSlots = await loadSlots(c.env);
  const rows: Sched.StudentSlots[] = (students.results ?? []).map((student) => ({
    student,
    slots: allSlots.filter((s) => s.student_id === student.id) as unknown as ClassSlot[],
  }));

  return c.html(Sched.slotsPage(c.get('user'), rows, site(c), c.req.query('msg')));
});

app.post('/t/students/:id/slots', requireTeacher, async (c) => {
  const studentId = c.req.param('id');
  const f = await c.req.formData();
  const onDate = String(f.get('on_date') ?? '').trim();
  const kind = String(f.get('kind')) === 'once' || onDate ? 'once' : 'weekly';
  const time = String(f.get('time_ist') ?? '').trim();
  if (!/^\d{2}:\d{2}$/.test(time))
    return c.redirect('/t/schedule/slots?msg=' + encodeURIComponent('That time did not look right.'));
  if (kind === 'once' && !onDate)
    return c.redirect('/t/schedule/slots?msg=' + encodeURIComponent('A one-off class needs a date.'));

  const dur = Number(f.get('duration_min'));
  await c.env.DB.prepare(
    `INSERT INTO class_slots
       (id, student_id, kind, weekday, on_date, time_ist, duration_min, label, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      newId('cs'), studentId, kind,
      kind === 'weekly' ? Number(f.get('weekday')) || 0 : null,
      kind === 'once' ? onDate : null,
      time,
      Number.isFinite(dur) && dur > 0 ? Math.round(dur) : 60,
      String(f.get('label') ?? '').trim() || null,
      c.get('user').id, now(),
    )
    .run();
  return c.redirect('/t/schedule/slots?msg=' + encodeURIComponent('Class slot added.'));
});

app.post('/t/slots/:id/delete', requireTeacher, async (c) => {
  await c.env.DB.prepare('DELETE FROM class_slots WHERE id = ?').bind(c.req.param('id')).run();
  return c.redirect('/t/schedule/slots?msg=' + encodeURIComponent('Slot removed.'));
});

/** Cancel one occurrence without touching the weekly rule. */
app.post('/t/slots/:id/skip', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const onDate = String(f.get('on_date') ?? '');
  if (!onDate) return c.redirect('/t/schedule');
  await c.env.DB.prepare(
    `INSERT INTO slot_exceptions (id, slot_id, on_date, action, reason, created_at)
     VALUES (?,?,?,'skip',?,?)
     ON CONFLICT(slot_id, on_date) DO UPDATE SET
       action='skip', new_date=NULL, new_time_ist=NULL, reason=excluded.reason`,
  )
    .bind(newId('ex'), c.req.param('id'), onDate, String(f.get('reason') ?? '').trim() || null, now())
    .run();
  const back = String(f.get('back') ?? '') || '/t/schedule';
  return c.redirect(`${back}?msg=` + encodeURIComponent('Marked as no class.'));
});

/** Move one occurrence to another date or time, in Indian time. */
app.post('/t/slots/:id/move', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const onDate = String(f.get('on_date') ?? '');
  const newDate = String(f.get('new_date') ?? '');
  const newTime = String(f.get('new_time_ist') ?? '');
  if (!onDate || !newDate || !/^\d{2}:\d{2}$/.test(newTime))
    return c.redirect('/t/schedule?msg=' + encodeURIComponent('That reschedule did not look right.'));

  await c.env.DB.prepare(
    `INSERT INTO slot_exceptions (id, slot_id, on_date, action, new_date, new_time_ist, reason, created_at)
     VALUES (?,?,?,'move',?,?,?,?)
     ON CONFLICT(slot_id, on_date) DO UPDATE SET
       action='move', new_date=excluded.new_date, new_time_ist=excluded.new_time_ist,
       reason=excluded.reason`,
  )
    .bind(newId('ex'), c.req.param('id'), onDate, newDate, newTime,
      String(f.get('reason') ?? '').trim() || null, now())
    .run();
  const back = String(f.get('back') ?? '') || '/t/schedule';
  return c.redirect(`${back}?msg=` + encodeURIComponent('Class moved. The student sees the new time on their own clock.'));
});

app.post('/t/slots/:id/restore', requireTeacher, async (c) => {
  const f = await c.req.formData();
  await c.env.DB.prepare('DELETE FROM slot_exceptions WHERE slot_id = ? AND on_date = ?')
    .bind(c.req.param('id'), String(f.get('on_date') ?? ''))
    .run();
  const back = String(f.get('back') ?? '') || '/t/schedule';
  return c.redirect(`${back}?msg=` + encodeURIComponent('Back to normal.'));
});

/* ---------------- where people are ---------------- */

app.post('/t/students/:id/zone', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const tz = String(f.get('time_zone') ?? '').trim();
  if (tz && !isValidZone(tz))
    return c.redirect('/t/schedule/slots?msg=' + encodeURIComponent('That is not a time zone this server recognises.'));
  await c.env.DB.prepare('UPDATE users SET time_zone = ?, location = ? WHERE id = ?')
    .bind(tz || null, String(f.get('location') ?? '').trim() || null, c.req.param('id'))
    .run();
  return c.redirect('/t/schedule/slots?msg=' + encodeURIComponent('Saved.'));
});

app.post('/me/zone', requireUser, async (c) => {
  const f = await c.req.formData();
  const tz = String(f.get('time_zone') ?? '').trim();
  if (tz && !isValidZone(tz)) return c.redirect('/me');
  await c.env.DB.prepare('UPDATE users SET time_zone = ?, location = ? WHERE id = ?')
    .bind(tz || null, String(f.get('location') ?? '').trim() || null, c.get('user').id)
    .run();
  return c.redirect('/me');
});

/**
 * The browser reporting its own zone, so class times need no setup.
 *
 * It only fills a zone that is empty — it never overwrites one. A teacher often
 * sets a student's zone by hand before that student has ever signed in, and it
 * would be wrong for the first page load from a laptop in a hotel to quietly
 * discard that. When someone genuinely moves, they change it themselves on
 * their own page, or the teacher does under Settings.
 */
app.post('/api/tz', requireUser, async (c) => {
  let tz = '';
  try {
    tz = String(((await c.req.json()) as { tz?: string }).tz ?? '');
  } catch {
    return c.json({ ok: false }, 400);
  }
  if (!isValidZone(tz)) return c.json({ ok: false }, 400);

  const res = await c.env.DB.prepare(
    "UPDATE users SET time_zone = ? WHERE id = ? AND (time_zone IS NULL OR time_zone = '')",
  )
    .bind(tz, c.get('user').id)
    .run();
  return c.json({ ok: true, stored: (res.meta?.changes ?? 0) > 0 });
});

app.notFound(async (c) => c.html(V.notFound(await currentUser(c), site(c)), 404));

app.onError((err, c) => {
  console.error(err);
  return c.text('Something went wrong. Please try again.', 500);
});

export default app;
