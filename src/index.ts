import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Vars, AppEnv, User, ProjectPerson, Group, Section, Recording, Note, SessionRow, ClassSlot, AssignedRow } from './types';
import { SEP } from './views/sessions';
import * as Sched from './views/schedule';
import { songPage, type SongStudent, type SongPageData } from './views/song';
import * as Stu from './views/student';
import { classPage, type ClassPageData } from './views/klass';
import type { Visiting } from './views/layout';
import { STARTER_CATALOGUE, STARTER_COUNT } from './catalogue-seed';
import {
  expand, istToday, addDays, isValidZone, TEACHER_ZONE,
  type Slot, type SlotException, type Occurrence,
} from './tz';
import {
  currentUser, startSession, endSession, googleAuthUrl, setOAuthState,
  takeOAuthState, exchangeCode, upsertUser, requireUser, requireTeacher, requireTeacherJson,
  requireAdmin,
} from './auth';
import {
  pid, acting, addMember, removeMember, createProject, getProject,
  setActiveProject, clearActiveProject, recentAdminLog, resolveProject, logAdmin,
} from './projects';
import { newId, now, extFor, slugify } from './util';
import { isLang } from './i18n';
import { transcribe, DictateError, CARNATIC_TERMS } from './transcribe';
import * as V from './views/pages';
import * as Adm from './views/admin';
import type { StudentRow } from './views/pages';

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const site = (c: { env: Env }) => c.env.SITE_NAME || 'RP Sajeev Music';

/** The banner, when an admin is inside a practice they do not teach. */
function visiting(c: Context<AppEnv, any, any>): Visiting | null {
  const a = c.get('acting');
  return a?.asAdmin ? { name: a.project.name, asAdmin: true } : null;
}

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
      /* Same idea as `dictate`: answer "I set it up and sign-in is broken"
         without anyone reading logs. Names only, never values. */
      signin: signinWhy(c.env),
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
  const language = String(f.get('lang') ?? '');

  if (palette && V.isPalette(palette)) {
    /* unscoped: the signed-in user choosing their own colours, which follow them into every project */
    await c.env.DB.prepare('UPDATE users SET palette = ? WHERE id = ?').bind(palette, user.id).run();
  } else if (mode && V.isMode(mode)) {
    /* unscoped: the signed-in user choosing their own light/dark mode, which follows them into every project */
    await c.env.DB.prepare('UPDATE users SET theme_mode = ? WHERE id = ?').bind(mode, user.id).run();
  } else if (language && isLang(language)) {
    /* unscoped: the signed-in user choosing their own interface language, which follows them into every project */
    await c.env.DB.prepare('UPDATE users SET lang = ? WHERE id = ?').bind(language, user.id).run();
  }

  /* '/' works out where this person belongs; user.role is the dead
     global column and would send a teacher to the student pages. */
  let back = '/';
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

/**
 * Where someone belongs the moment they arrive.
 *
 * This used to read users.status and users.role. Nothing writes those
 * any more — standing is per-project — so asking them would send a
 * student a teacher had just added and activated straight to /waiting,
 * where the only link is /waiting. A dead end for exactly the person
 * who had just been let in.
 *
 * So ask the same question the guards ask, one hop earlier: is there a
 * project this person can act in, and are they a teacher of it?
 */
async function landingFor(c: Context<AppEnv, any, any>, user: User): Promise<string> {
  const acting = await resolveProject(c, user);
  if (acting) return acting.isTeacher ? '/t/schedule/week' : '/me';
  if (user.is_admin) return '/admin';
  return '/waiting';
}

app.get('/', async (c) => {
  const user = await currentUser(c);
  if (user) {
    const to = await landingFor(c, user);
    return c.redirect(to);
  }
  return c.html(V.landing(site(c), c.req.query('error')));
});

app.get('/waiting', async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect('/');
  const to = await landingFor(c, user);
  if (to !== '/waiting') return c.redirect(to);
  return c.html(V.waiting(user, site(c)));
});

app.get('/auth/google', (c) => {
  /* An unset secret is `undefined`, and URLSearchParams turns that into the
     five letters "undefined" — so the browser lands on Google's
     "Error 401: invalid_client" page, which says nothing about what is
     actually wrong. Say it here instead, where we know. */
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET)
    return c.redirect(
      '/?error=' +
        encodeURIComponent(
          'Google sign-in is not configured yet: the GOOGLE_CLIENT_ID and ' +
            'GOOGLE_CLIENT_SECRET secrets are not set on this deployment. ' +
            'See /healthz.',
        ),
    );
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
    return c.redirect(await landingFor(c, user));
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
  /* unscoped: local-only sign-in, which is identity and happens before any project is resolved — the same job auth.ts does in production */
  let u = await c.env.DB.prepare('SELECT * FROM users WHERE lower(email) = ?').bind(email).first<User>();
  if (!u) {
    const id = newId('u');
    await c.env.DB.prepare(
      /* unscoped: creating the local-only dev account — identity is global, and it joins a project the same way anyone else does */
      `INSERT INTO users (id, google_sub, email, name, role, status, created_at, approved_at)
       VALUES (?,?,?,?,?, 'active', ?, ?)`,
    )
      .bind(id, `dev-${id}`, email, c.req.query('name') ?? email.split('@')[0], role, now(), now())
      .run();
    /* unscoped: reading back the local-only dev account just created, to start its session */
    u = (await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>())!;
  }
  await startSession(c, u.id);
  return c.redirect('/');
});

/* ================================================================== *
 * Teacher — students
 * ================================================================== */

/**
 * The columns a person is made of, read through their membership of the
 * acting project.
 *
 * `users` still has `role` and `status` columns and they are dead — a
 * person is a student here and a teacher there, paused here and active
 * there — so they are deliberately not listed. Every query that wants a
 * role or a standing takes it from `project_members` (aliased `m`), and
 * every query that uses this has to join `m` to the acting project,
 * which is also what keeps another practice's people out of the result.
 */
const MEMBER_COLS = `u.id, u.google_sub, u.email, u.name, u.avatar_url, u.created_at,
        u.time_zone, u.location, u.phone, u.palette, u.theme_mode, u.lang, u.is_admin,
        m.role AS role, m.status AS status, m.status_note AS status_note,
        m.status_changed_at AS status_changed_at, m.approved_at AS approved_at`;

/* ------------------------------------------------------------------ *
 * The audit trail
 *
 * One middleware rather than a call in each of the thirty-seven teacher
 * mutations, for the same reason the scoping has a checker: the failure
 * mode is not getting it wrong, it is forgetting — on the one route
 * nobody thought about, or the one written next month. A middleware
 * cannot forget.
 *
 * It records the method, the path and the project. Not the form body:
 * that is where a phone number or a lesson note would be, and an audit
 * log is not a place to copy a student's data to.
 *
 * Only writes, only when an admin is inside a practice they do not
 * teach, and only when the request actually succeeded — a rejected
 * change is not a change.
 * ------------------------------------------------------------------ */
app.use('/t/*', async (c, next) => {
  await next();
  if (c.req.method !== 'POST') return;
  const a = c.get('acting');
  if (!a?.asAdmin) return;
  const status = c.res.status;
  if (status >= 400) return;
  await logAdmin(c, a, `${c.req.method} ${new URL(c.req.url).pathname}`, describeChange(c));
});

/** A short readable line for the log, from the path alone. */
function describeChange(c: Context<AppEnv, any, any>): string {
  const p = new URL(c.req.url).pathname;
  const rules: [RegExp, string][] = [
    [/^\/t\/students\/[^/]+\/status$/, "Changed a student's status"],
    [/^\/t\/students\/[^/]+\/details$/, "Edited a student's details"],
    [/^\/t\/students\/[^/]+\/zone$/, "Changed a student's time zone"],
    [/^\/t\/students$/, 'Added a student'],
    [/^\/t\/invite$/, 'Invited someone by email'],
    [/^\/t\/approvals\//, 'Answered an approval'],
    [/^\/t\/sessions\/[^/]+\/delete$/, 'Deleted a lesson'],
    [/^\/t\/sessions\//, 'Edited a lesson'],
    [/^\/t\/s\/[^/]+\/sessions$/, 'Logged a lesson'],
    [/^\/t\/recordings\/[^/]+\/delete$/, 'Deleted a recording'],
    [/^\/t\/recordings\//, 'Changed a recording'],
    [/^\/t\/notes\/[^/]+\/delete$/, 'Deleted a note'],
    [/^\/t\/notes/, 'Changed a note'],
    [/^\/t\/sections\/[^/]+\/delete$/, 'Deleted a song'],
    [/^\/t\/sections/, 'Changed a song'],
    [/^\/t\/groups/, 'Changed a group'],
    [/^\/t\/slots|^\/t\/students\/[^/]+\/slots$/, 'Changed the schedule'],
    [/^\/t\/catalogue\/seed$/, 'Loaded the starter catalogue'],
  ];
  for (const [re, label] of rules) if (re.test(p)) return label;
  return `Changed something at ${p}`;
}

/* ==================================================================
 * Admin — above every project
 *
 * Two pages, and a way in and out of a practice. Everything else an
 * admin might want is the teacher's own screens, reached by switching
 * in: there is no second copy of the teaching interface here, and a
 * good part of the reason this feature is small is that there isn't.
 *
 * Switching in sets a cookie and nothing else. The cookie is only ever
 * a request — resolveProject proves it against the database on every
 * single hit — so nothing here is trusted later on.
 * ================================================================== */

/** The numbers worth seeing without opening a practice. */
const PROJECT_SUMMARY = `
  SELECT p.*,
    (SELECT group_concat(u.name, ', ') FROM project_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.project_id = p.id AND m.role = 'teacher' AND m.status = 'active') AS teacher_names,
    (SELECT COUNT(*) FROM project_members m
      WHERE m.project_id = p.id AND m.role = 'student'
        AND m.status NOT IN ('disabled','pending'))                      AS student_count,
    (SELECT COUNT(*) FROM sections  WHERE project_id = p.id)             AS song_count,
    (SELECT COUNT(*) FROM recordings WHERE project_id = p.id)            AS recording_count,
    (SELECT COALESCE(SUM(size_bytes),0) FROM recordings WHERE project_id = p.id)
      + (SELECT COALESCE(SUM(image_bytes),0) FROM notes WHERE project_id = p.id) AS bytes,
    (SELECT MAX(created_at) FROM recordings WHERE project_id = p.id)     AS last_activity
  FROM projects p`;

app.get('/admin', requireAdmin, async (c) => {
  const r = await c.env.DB.prepare(
    `${PROJECT_SUMMARY} ORDER BY p.status, p.name COLLATE NOCASE`,
  ).all<Adm.ProjectSummary>();
  return c.html(Adm.adminHome(c.get('user'), r.results ?? [], site(c), c.req.query('msg')));
});

app.post('/admin/projects', requireAdmin, async (c) => {
  const f = await c.req.formData();
  const name = String(f.get('name') ?? '').trim();
  if (!name) return c.redirect('/admin?msg=' + encodeURIComponent('A practice needs a name.'));
  const id = await createProject(c.env, {
    name,
    nameMl: String(f.get('name_ml') ?? ''),
    note: String(f.get('note') ?? ''),
    createdBy: c.get('user').id,
  });
  return c.redirect(`/admin/p/${id}?msg=` + encodeURIComponent('Created. Now add the teacher who runs it.'));
});

async function projectSummaryOr404(env: Env, id: string): Promise<Adm.ProjectSummary | null> {
  return (
    (await env.DB.prepare(`${PROJECT_SUMMARY} WHERE p.id = ?`)
      .bind(id)
      .first<Adm.ProjectSummary>()) ?? null
  );
}

app.get('/admin/p/:id', requireAdmin, async (c) => {
  const p = await projectSummaryOr404(c.env, c.req.param('id'));
  if (!p) return c.html(V.notFound(c.get('user'), site(c)), 404);
  const members = await c.env.DB.prepare(
    `SELECT m.user_id, m.role, m.status, m.joined_at, u.name, u.email, u.avatar_url
       FROM project_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.project_id = ?
      ORDER BY m.role DESC, u.name COLLATE NOCASE`,
  )
    .bind(p.id)
    .all<Adm.MemberRow>();
  const log = await recentAdminLog(c.env, p.id, 40);
  return c.html(
    Adm.adminProject(c.get('user'), p, members.results ?? [], log, site(c), c.req.query('msg')),
  );
});

app.post('/admin/p/:id', requireAdmin, async (c) => {
  const f = await c.req.formData();
  const id = c.req.param('id');
  const name = String(f.get('name') ?? '').trim();
  if (!name) return c.redirect(`/admin/p/${id}?msg=` + encodeURIComponent('A practice needs a name.'));
  await c.env.DB.prepare('UPDATE projects SET name = ?, name_ml = ?, note = ? WHERE id = ?')
    .bind(name, String(f.get('name_ml') ?? '').trim() || null, String(f.get('note') ?? '').trim() || null, id)
    .run();
  return c.redirect(`/admin/p/${id}?msg=` + encodeURIComponent('Saved.'));
});

app.post('/admin/p/:id/archive', requireAdmin, async (c) => {
  const id = c.req.param('id');
  const p = await getProject(c.env, id);
  if (!p) return c.html(V.notFound(c.get('user'), site(c)), 404);
  const archiving = p.status === 'active';
  await c.env.DB.prepare(
    `UPDATE projects SET status = ?, archived_at = ? WHERE id = ?`,
  )
    .bind(archiving ? 'archived' : 'active', archiving ? now() : null, id)
    .run();
  /* Anyone currently inside it is holding a cookie that resolveProject
     will now refuse, which is the behaviour we want: they land back on
     whatever else they can reach rather than in a practice that is
     supposed to be closed. */
  return c.redirect(
    `/admin/p/${id}?msg=` +
      encodeURIComponent(archiving ? 'Archived. Nothing was deleted.' : 'Back in use.'),
  );
});

app.post('/admin/p/:id/members', requireAdmin, async (c) => {
  const f = await c.req.formData();
  const id = c.req.param('id');
  const email = String(f.get('email') ?? '').trim().toLowerCase();
  const role = String(f.get('role') ?? 'student') === 'teacher' ? 'teacher' : 'student';
  if (!email.includes('@'))
    return c.redirect(`/admin/p/${id}?msg=` + encodeURIComponent('That does not look like an email address.'));

  /* unscoped: finding the person behind an email address — identity is
     global, and they may already be learning with another teacher.
     addMember below is what puts them in this practice. */
  let u = await c.env.DB.prepare('SELECT id, name FROM users WHERE lower(email) = ?')
    .bind(email)
    .first<{ id: string; name: string }>();

  if (!u) {
    const uid = newId('u');
    /* unscoped: creating the person. Identity has no project_id; the
       membership on the next line is what joins them to this one. */
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)`,
    )
      .bind(uid, email, email.split('@')[0], now())
      .run();
    u = { id: uid, name: email.split('@')[0] };
  }

  await addMember(c.env, {
    projectId: id,
    userId: u.id,
    role,
    status: 'active',
    approvedBy: c.get('user').id,
  });

  return c.redirect(
    `/admin/p/${id}?msg=` +
      encodeURIComponent(
        `${u.name} is in as ${role === 'teacher' ? 'a teacher' : 'a student'}. They are active the moment they sign in with that address.`,
      ),
  );
});

app.post('/admin/p/:id/members/:uid/remove', requireAdmin, async (c) => {
  const id = c.req.param('id');
  await removeMember(c.env, id, c.req.param('uid'));
  /* The membership goes; the person, and everything they recorded or
     were taught, stays. Removing somebody is not a way to delete them. */
  return c.redirect(`/admin/p/${id}?msg=` + encodeURIComponent('Taken out of this practice.'));
});

/* ------------------------------------------------------------------ *
 * In, and out again
 * ------------------------------------------------------------------ */

app.post('/admin/switch/:id', requireAdmin, async (c) => {
  const p = await getProject(c.env, c.req.param('id'));
  if (!p || p.status !== 'active')
    return c.redirect('/admin?msg=' + encodeURIComponent('That practice is not open.'));
  setActiveProject(c, p.id);
  return c.redirect('/t/schedule/week');
});

app.post('/admin/leave', requireAdmin, (c) => {
  clearActiveProject(c);
  return c.redirect('/admin');
});

app.get('/t', requireTeacher, async (c) => {
  const db = c.env.DB;
  const q = (c.req.query('q') ?? '').trim();
  // Only current students by default. Paused, graduated and ended are still
  // there — they are never deleted — but they clutter the list he uses weekly.
  const showAll = c.req.query('all') === '1';
  const statusFilter = showAll
    ? "m.status IN ('active','paused','graduated','ended')"
    : "m.status = 'active'";

  const counts = `SELECT ${MEMBER_COLS},
        (SELECT COUNT(*) FROM assignments a WHERE a.student_id = u.id AND a.archived_at IS NULL AND a.project_id = ?1) AS song_count,
        (SELECT COUNT(*) FROM recordings r WHERE r.student_id = u.id AND r.project_id = ?1) AS rec_count,
        (SELECT MAX(r.created_at) FROM recordings r WHERE r.student_id = u.id AND r.project_id = ?1) AS last_activity
       FROM users u
       JOIN project_members m ON m.user_id = u.id AND m.project_id = ?1
       WHERE ${statusFilter} AND m.role = 'student'`;
  const order = " ORDER BY CASE m.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, u.name COLLATE NOCASE";
  const students = q
    ? await db
        .prepare(`${counts} AND (u.name LIKE ?2 OR u.email LIKE ?2 OR u.location LIKE ?2 OR u.phone LIKE ?2)${order}`)
        .bind(pid(c), `%${q}%`)
        .all<StudentRow>()
    : await db.prepare(counts + order).bind(pid(c)).all<StudentRow>();

  const hidden = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM project_members
        WHERE project_id = ?1 AND role = 'student' AND status IN ('paused','graduated','ended')`,
    )
    .bind(pid(c))
    .first<{ n: number }>();

  const pending = await db
    .prepare("SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?1 AND status = 'pending'")
    .bind(pid(c))
    .first<{ n: number }>();

  const used = await db
    .prepare(
      `SELECT (SELECT COALESCE(SUM(size_bytes),0) FROM recordings WHERE project_id = ?1)
            + (SELECT COALESCE(SUM(image_bytes),0) FROM notes WHERE project_id = ?1) AS b`,
    )
    .bind(pid(c))
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
      visiting(c),
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

  /* An email address names a person, not a member: the same Google account may
     already be learning with another teacher, and there is no project to look
     them up in until they are in one. Only the id and name are taken from the
     row; addMember below is what admits them here. */
  /* unscoped: finding the person behind an email address, before any membership exists — addMember below is what puts them in this project */
  const existing = await c.env.DB.prepare('SELECT id, name FROM users WHERE lower(email) = ?')
    .bind(email)
    .first<{ id: string; name: string }>();
  if (existing) {
    await addMember(c.env, {
      projectId: pid(c),
      userId: existing.id,
      role: 'student',
      status: 'active',
      approvedBy: c.get('user').id,
    });
    return c.redirect('/t?msg=' + encodeURIComponent(`${existing.name} is on the site already — now active here.`));
  }

  const tz = String(f.get('time_zone') ?? '').trim();
  const newUserId = newId('u');
  /* Name, email, phone, location and time zone are who someone is rather than
     what they are here, so they go on `users`, which has no project_id. role
     and status are left off on purpose: those columns are dead. */
  await c.env.DB.prepare(
    /* unscoped: creating the person — identity is global and has no project_id; the addMember call below is what puts them in this project */
    `INSERT INTO users (id, google_sub, email, name, created_at, location, phone, time_zone)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(newUserId, email, name, now(),
      String(f.get('location') ?? '').trim() || null,
      String(f.get('phone') ?? '').trim() || null,
      isValidZone(tz) ? tz : null)
    .run();
  await addMember(c.env, {
    projectId: pid(c),
    userId: newUserId,
    role: 'student',
    status: 'active',
    approvedBy: c.get('user').id,
  });
  return c.redirect(
    '/t?msg=' + encodeURIComponent(`${name} added. They're in as soon as they sign in with ${email}.`),
  );
});

app.post('/t/students/:id/status', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const status = String(f.get('status') ?? '');
  if (!STUDENT_STATUSES.includes(status as (typeof STUDENT_STATUSES)[number]))
    return c.redirect('/t');
  /* Standing is per-project now: a student one teacher has paused stays
     active with the other, so this writes the membership and never the user. */
  await c.env.DB.prepare(
    `UPDATE project_members SET status = ?1, status_note = ?2, status_changed_at = ?3
      WHERE user_id = ?4 AND project_id = ?5 AND role = 'student'`,
  )
    .bind(status, String(f.get('status_note') ?? '').trim() || null, now(), c.req.param('id'), pid(c))
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
  /* These four are global: editing a phone number changes it everywhere the
     person appears, which is right for a phone number. That is exactly why
     the EXISTS matters — only a teacher of a project this person is actually
     in may edit them at all. */
  await c.env.DB.prepare(
    `UPDATE users SET name = ?1, location = ?2, phone = ?3, time_zone = ?4
      WHERE id = ?5
        AND EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = users.id AND m.project_id = ?6)`,
  )
    .bind(
      name,
      String(f.get('location') ?? '').trim() || null,
      String(f.get('phone') ?? '').trim() || null,
      tz || null,
      c.req.param('id'),
      pid(c),
    )
    .run();
  return c.redirect(`/t/s/${c.req.param('id')}?msg=` + encodeURIComponent('Saved.'));
});

app.get('/t/approvals', requireTeacher, async (c) => {
  /* People with a pending membership of THIS project — not "users whose
     global status says pending", which was everybody waiting anywhere. */
  const pending = await c.env.DB.prepare(
    `SELECT ${MEMBER_COLS} FROM users u
       JOIN project_members m ON m.user_id = u.id AND m.project_id = ?1
      WHERE m.status = 'pending'
      ORDER BY m.joined_at`,
  )
    .bind(pid(c))
    .all<User>();
  return c.html(
    V.teacherApprovals(c.get('user'), pending.results ?? [], site(c), c.req.query('msg'), visiting(c)),
  );
});

app.post('/t/approvals/:id', requireTeacher, async (c) => {
  const id = c.req.param('id');
  const form = await c.req.formData();
  const action = String(form.get('action') ?? '');
  const me = c.get('user');

  if (action === 'reject') {
    /* Declining someone here closes this door only; a project they are
       welcome in is none of this teacher's business. */
    await c.env.DB.prepare(
      "UPDATE project_members SET status = 'disabled', status_changed_at = ?1 WHERE user_id = ?2 AND project_id = ?3",
    )
      .bind(now(), id, pid(c))
      .run();
    return c.redirect('/t/approvals?msg=' + encodeURIComponent('Request declined.'));
  }
  if (action !== 'student' && action !== 'teacher') return c.redirect('/t/approvals');

  await c.env.DB.prepare(
    `UPDATE project_members SET status = 'active', role = ?1, approved_at = ?2, approved_by = ?3,
       status_changed_at = ?2
      WHERE user_id = ?4 AND project_id = ?5`,
  )
    .bind(action, now(), me.id, id, pid(c))
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

  /* Same as adding a student by email on /t: an address names a person, and
     there is no project to look them up in until they belong to one. */
  /* unscoped: finding the person behind an email address, before any membership exists — addMember below is what puts them in this project */
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE lower(email) = ?')
    .bind(email)
    .first<{ id: string }>();
  if (existing) {
    await addMember(c.env, {
      projectId: pid(c),
      userId: existing.id,
      role: 'student',
      status: 'active',
      approvedBy: c.get('user').id,
    });
    return c.redirect('/t/approvals?msg=' + encodeURIComponent(`${name} is on the site already — now approved here.`));
  }

  const invitedId = newId('u');
  /* role and status are left off: those columns are dead, and the membership
     addMember writes next is where a role and a standing belong. */
  await c.env.DB.prepare(
    /* unscoped: creating the person — identity is global and has no project_id; the addMember call below is what puts them in this project */
    `INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?, NULL, ?, ?, ?)`,
  )
    .bind(invitedId, email, name, now())
    .run();
  await addMember(c.env, {
    projectId: pid(c),
    userId: invitedId,
    role: 'student',
    status: 'active',
    approvedBy: c.get('user').id,
  });
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
  const groups = await db
    .prepare('SELECT * FROM groups WHERE project_id = ?1 ORDER BY sort_order, name COLLATE NOCASE')
    .bind(pid(c))
    .all<Group>();

  // One LIKE across every field a teacher might remember a song by. SQLite's
  // LIKE is case-insensitive for ASCII, and Malayalam has no case, so the
  // same clause serves both scripts.
  const base = `SELECT s.*, (SELECT COUNT(*) FROM assignments a WHERE a.section_id = s.id AND a.archived_at IS NULL AND a.project_id = ?1) AS assigned_count
     FROM sections s WHERE s.project_id = ?1`;
  const order = ' ORDER BY s.sort_order, s.title COLLATE NOCASE';
  const sections = q
    ? await db
        .prepare(
          `${base} AND (s.title LIKE ?2 OR s.title_ml LIKE ?2 OR s.raga LIKE ?2
             OR s.taala LIKE ?2 OR s.composer LIKE ?2)${order}`,
        )
        .bind(pid(c), `%${q}%`)
        .all<Section & { assigned_count: number }>()
    : await db.prepare(base + order).bind(pid(c)).all<Section & { assigned_count: number }>();

  return c.html(
    V.teacherCatalogue(
      c.get('user'), groups.results ?? [], sections.results ?? [], site(c), c.req.query('msg'), q,
      visiting(c),
    ),
  );
});

/** Change a song's details. Previously the only route was delete and re-add. */
app.post('/t/sections/:id', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const title = String(f.get('title') ?? '').trim();
  if (!title) return c.redirect('/t/catalogue');
  const str = (k: string) => String(f.get(k) ?? '').trim() || null;
  await c.env.DB.prepare(
    `UPDATE sections SET group_id=?, title=?, title_ml=?, raga=?, taala=?, composer=? WHERE id=? AND project_id=?`,
  )
    .bind(str('group_id'), title, str('title_ml'), str('raga'), str('taala'), str('composer'), c.req.param('id'), pid(c))
    .run();
  const back = String(f.get('back') ?? '') || '/t/catalogue';
  return c.redirect(`${back}?msg=` + encodeURIComponent(`"${title}" updated.`));
});

/** Change a recording's name, which part it covers, and who can hear it. */
app.post('/t/recordings/:id', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const rec = await c.env.DB.prepare('SELECT * FROM recordings WHERE id = ?1 AND project_id = ?2')
    .bind(c.req.param('id'), pid(c))
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
    const visibility = await setShares(c.env, pid(c), 'recording', rec.id, String(f.get('visibility')), ids);
    sets.push('visibility = ?');
    vals.push(visibility);
    msg =
      visibility === 'shared'
        ? 'Shared with everyone learning this song.'
        : `Shared with ${ids.length} ${ids.length === 1 ? 'student' : 'students'}.`;
  }

  if (sets.length) {
    // Scoped on project_id as well as id: a recording in another project matches nothing.
    await c.env.DB.prepare(`UPDATE recordings SET ${sets.join(', ')} WHERE id = ? AND project_id = ?`)
      .bind(...vals, rec.id, pid(c))
      .run();
  }
  const back = String(f.get('back') ?? '') || `/t/song/${rec.section_id}`;
  return c.redirect(`${back}?msg=` + encodeURIComponent(msg));
});

/** Edit a note's text and who can see it. */
app.post('/t/notes/:id', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const note = await c.env.DB.prepare('SELECT * FROM notes WHERE id = ?1 AND project_id = ?2')
    .bind(c.req.param('id'), pid(c))
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
    const visibility = await setShares(c.env, pid(c), 'note', note.id, String(f.get('visibility')), ids);
    sets.push('visibility = ?');
    vals.push(visibility);
    msg =
      visibility === 'shared'
        ? 'Note shared with everyone learning this song.'
        : `Note shared with ${ids.length} ${ids.length === 1 ? 'student' : 'students'}.`;
  }

  if (sets.length) {
    await c.env.DB.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ? AND project_id = ?`)
      .bind(...vals, note.id, pid(c))
      .run();
  }
  const back = String(f.get('back') ?? '') || `/t/song/${note.section_id}`;
  return c.redirect(`${back}?msg=` + encodeURIComponent(msg));
});

/** Reorder a note within its song, same swap as recordings. */
app.post('/t/notes/:id/move', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const dir = String(f.get('dir')) === 'up' ? 'up' : 'down';
  const note = await c.env.DB.prepare('SELECT * FROM notes WHERE id = ?1 AND project_id = ?2')
    .bind(c.req.param('id'), pid(c))
    .first<Note>();
  if (!note) return c.redirect('/t');

  // A note moves within its own list: the notes on the same recording, or the
  // song-wide ones. Before, everything was compared against the song-wide list,
  // so a note attached to a recording had no neighbour and never moved.
  const scope = note.recording_id ? 'recording_id = ?5' : 'recording_id IS NULL';
  const neighbour = await c.env.DB.prepare(
    dir === 'up'
      ? `SELECT * FROM notes WHERE section_id=?1 AND project_id=?4 AND ${scope}
           AND (sort_order < ?2 OR (sort_order = ?2 AND created_at < ?3))
         ORDER BY sort_order DESC, created_at DESC LIMIT 1`
      : `SELECT * FROM notes WHERE section_id=?1 AND project_id=?4 AND ${scope}
           AND (sort_order > ?2 OR (sort_order = ?2 AND created_at > ?3))
         ORDER BY sort_order ASC, created_at ASC LIMIT 1`,
  )
    .bind(
      ...(note.recording_id
        ? [note.section_id, note.sort_order, note.created_at, pid(c), note.recording_id]
        : [note.section_id, note.sort_order, note.created_at, pid(c)]),
    )
    .first<Note>();

  if (neighbour) {
    const a = note.sort_order;
    const b = neighbour.sort_order;
    const [newA, newB] = a === b ? (dir === 'up' ? [b - 1, b] : [b + 1, b]) : [b, a];
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE notes SET sort_order = ? WHERE id = ? AND project_id = ?').bind(newA, note.id, pid(c)),
      c.env.DB.prepare('UPDATE notes SET sort_order = ? WHERE id = ? AND project_id = ?').bind(newB, neighbour.id, pid(c)),
    ]);
  }
  const back = String(f.get('back') ?? '') || `/t/song/${note.section_id}`;
  return c.redirect(back);
});

app.post('/t/groups', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const name = String(f.get('name') ?? '').trim();
  if (!name) return c.redirect('/t/catalogue');
  const max = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM groups WHERE project_id = ?')
    .bind(pid(c))
    .first<{ m: number }>();
  await c.env.DB.prepare(
    'INSERT INTO groups (project_id, id, name, name_ml, sort_order, created_at) VALUES (?,?,?,?,?,?)',
  )
    .bind(pid(c), newId('g'), name, String(f.get('name_ml') ?? '').trim() || null, (max?.m ?? 0) + 10, now())
    .run();
  return c.redirect('/t/catalogue?msg=' + encodeURIComponent(`Group "${name}" added.`));
});

app.post('/t/groups/:id/delete', requireTeacher, async (c) => {
  await c.env.DB.prepare('DELETE FROM groups WHERE id = ? AND project_id = ?')
    .bind(c.req.param('id'), pid(c))
    .run();
  return c.redirect('/t/catalogue?msg=' + encodeURIComponent('Group deleted. Its songs are now ungrouped.'));
});

app.post('/t/sections', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const title = String(f.get('title') ?? '').trim();
  if (!title) return c.redirect('/t/catalogue');
  const max = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM sections WHERE project_id = ?')
    .bind(pid(c))
    .first<{ m: number }>();
  const str = (k: string) => String(f.get(k) ?? '').trim() || null;
  await c.env.DB.prepare(
    `INSERT INTO sections (project_id, id, group_id, title, title_ml, raga, taala, composer, sort_order, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(pid(c), newId('s'), str('group_id'), title, str('title_ml'), str('raga'), str('taala'), str('composer'), (max?.m ?? 0) + 10, now())
    .run();
  return c.redirect('/t/catalogue?msg=' + encodeURIComponent(`"${title}" added to the catalogue.`));
});

/** The song page: everything about one song in one place. */
app.get('/t/song/:id', requireTeacher, async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  const section = await db
    .prepare(`SELECT s.*, g.name AS group_name FROM sections s
              LEFT JOIN groups g ON g.id = s.group_id AND g.project_id = ?2
              WHERE s.id = ?1 AND s.project_id = ?2`)
    .bind(id, pid(c))
    .first<Section & { group_name: string | null }>();
  if (!section) return c.html(V.notFound(c.get('user'), site(c)), 404);

  const groups = await db
    .prepare('SELECT * FROM groups WHERE project_id = ? ORDER BY sort_order, name COLLATE NOCASE')
    .bind(pid(c))
    .all<Group>();

  const recordings = await db
    .prepare(`SELECT r.*, u.name AS student_name FROM recordings r
              LEFT JOIN users u ON u.id = r.student_id
              WHERE r.section_id = ?1 AND r.project_id = ?2
              ORDER BY r.sort_order, r.created_at`)
    .bind(id, pid(c))
    .all<Recording & { student_name: string | null }>();

  // Every note on the song — the ones pinned to a recording and the song-wide
  // ones — split apart in the view rather than fetched twice.
  const notes = await db
    .prepare(`SELECT n.*, u.name AS student_name FROM notes n
              LEFT JOIN users u ON u.id = n.student_id
              WHERE n.section_id = ?1 AND n.project_id = ?2
              ORDER BY n.sort_order, n.created_at`)
    .bind(id, pid(c))
    .all<Note & { student_name: string | null }>();

  const roster = await db
    .prepare(
      `SELECT u.id, u.name, u.avatar_url, m.status AS status, a.completed_at,
        (SELECT COUNT(*) FROM recording_shares rs
           JOIN recordings r ON r.id = rs.recording_id AND r.project_id = ?2
          WHERE r.section_id = ?1 AND rs.student_id = u.id) AS rec_count
       FROM assignments a
       JOIN users u ON u.id = a.student_id
       JOIN project_members m ON m.user_id = u.id AND m.project_id = ?2
       WHERE a.section_id = ?1 AND a.project_id = ?2 AND a.archived_at IS NULL
       ORDER BY u.name COLLATE NOCASE`,
    )
    .bind(id, pid(c))
    .all<SongStudent>();
  const rows = roster.results ?? [];

  const assignable = await db
    .prepare(
      `SELECT u.id, u.name, u.avatar_url, m.status AS status, NULL AS completed_at, 0 AS rec_count
       FROM users u
       JOIN project_members m ON m.user_id = u.id AND m.project_id = ?2
       WHERE m.role = 'student' AND m.status = 'active'
         AND u.id NOT IN (SELECT student_id FROM assignments
                           WHERE section_id = ?1 AND project_id = ?2 AND archived_at IS NULL)
       ORDER BY u.name COLLATE NOCASE`,
    )
    .bind(id, pid(c))
    .all<SongStudent>();

  const [recShares, noteShares] = await Promise.all([
    sharesFor(c.env, pid(c), 'recording', id),
    sharesFor(c.env, pid(c), 'note', id),
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
    visiting: visiting(c),
  };
  return c.html(songPage(c.get('user'), data, site(c), c.req.query('msg')));
});

app.post('/t/song/:id/assign', requireTeacher, async (c) => {
  const sectionId = c.req.param('id');
  const f = await c.req.formData();
  const studentId = String(f.get('student_id') ?? '');
  if (!studentId) return c.redirect(`/t/song/${sectionId}`);
  await c.env.DB.prepare(
    /* The student id comes off the form, so it is gated on membership of the
       acting project — otherwise a hand-made POST assigns this teacher's song
       to somebody else's student. */
    `INSERT INTO assignments (project_id, id, student_id, section_id, assigned_by, assigned_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6
      WHERE EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = ?3 AND m.project_id = ?1)
     ON CONFLICT(student_id, section_id) DO UPDATE SET archived_at = NULL, completed_at = NULL`,
  )
    .bind(pid(c), newId('a'), studentId, sectionId, c.get('user').id, now())
    .run();
  return c.redirect(`/t/song/${sectionId}?msg=` + encodeURIComponent('Assigned.'));
});

/** Load the starter repertoire. Adds only what is missing. */
app.post('/t/catalogue/seed', requireTeacher, async (c) => {
  const db = c.env.DB;
  let added = 0;

  const existingGroups = await db
    .prepare('SELECT id, name FROM groups WHERE project_id = ?')
    .bind(pid(c))
    .all<{ id: string; name: string }>();
  const groupByName = new Map((existingGroups.results ?? []).map((g) => [g.name.toLowerCase(), g.id]));
  const existingSongs = await db
    .prepare('SELECT title, raga FROM sections WHERE project_id = ?')
    .bind(pid(c))
    .all<{ title: string; raga: string | null }>();
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
        .prepare('INSERT INTO groups (project_id, id, name, sort_order, created_at) VALUES (?,?,?,?,?)')
        .bind(pid(c), gid, g.name, groupOrder, now())
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
            `INSERT INTO sections (project_id, id, group_id, title, raga, taala, composer, sort_order, created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .bind(pid(c), newId('s'), gid, song.title, song.raga, song.taala, song.composer, songOrder, now()),
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
  projectId: string,
  table: 'groups' | 'sections',
  id: string,
  dir: 'up' | 'down',
  nameCol: 'name' | 'title',
  scope?: { col: string; val: string | null },
): Promise<void> {
  const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id = ? AND project_id = ?`)
    .bind(id, projectId)
    .first<{ id: string; sort_order: number } & Record<string, unknown>>();
  if (!row) return;

  const where = scope ? ` AND COALESCE(${scope.col},'') = ?5` : '';
  const binds: unknown[] = [row.sort_order, String(row[nameCol] ?? ''), id, projectId];
  if (scope) binds.push(scope.val ?? '');

  const neighbour = await env.DB.prepare(
    dir === 'up'
      ? `SELECT id, sort_order FROM ${table}
           WHERE (sort_order < ?1 OR (sort_order = ?1 AND ${nameCol} COLLATE NOCASE < ?2))
             AND id <> ?3 AND project_id = ?4${where}
         ORDER BY sort_order DESC, ${nameCol} COLLATE NOCASE DESC LIMIT 1`
      : `SELECT id, sort_order FROM ${table}
           WHERE (sort_order > ?1 OR (sort_order = ?1 AND ${nameCol} COLLATE NOCASE > ?2))
             AND id <> ?3 AND project_id = ?4${where}
         ORDER BY sort_order ASC, ${nameCol} COLLATE NOCASE ASC LIMIT 1`,
  )
    .bind(...(binds as [number, string, string, ...unknown[]]))
    .first<{ id: string; sort_order: number }>();
  if (!neighbour) return;

  const a = row.sort_order;
  const b = neighbour.sort_order;
  const [newA, newB] = a === b ? (dir === 'up' ? [b - 1, b] : [b + 1, b]) : [b, a];
  await env.DB.batch([
    env.DB.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ? AND project_id = ?`).bind(newA, id, projectId),
    env.DB.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ? AND project_id = ?`).bind(newB, neighbour.id, projectId),
  ]);
}

app.post('/t/groups/:id/move', requireTeacher, async (c) => {
  const dir = String((await c.req.formData()).get('dir')) === 'up' ? 'up' : 'down';
  await moveInList(c.env, pid(c), 'groups', c.req.param('id'), dir, 'name');
  return c.redirect('/t/catalogue');
});

app.post('/t/sections/:id/move', requireTeacher, async (c) => {
  const dir = String((await c.req.formData()).get('dir')) === 'up' ? 'up' : 'down';
  const s = await c.env.DB.prepare('SELECT group_id FROM sections WHERE id = ? AND project_id = ?')
    .bind(c.req.param('id'), pid(c))
    .first<{ group_id: string | null }>();
  if (s)
    await moveInList(c.env, pid(c), 'sections', c.req.param('id'), dir, 'title', {
      col: 'group_id',
      val: s.group_id,
    });
  return c.redirect('/t/catalogue');
});

app.post('/t/sections/:id/delete', requireTeacher, async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  // Remove the media from R2 first — an orphaned object costs storage forever.
  const recs = await db
    .prepare('SELECT r2_key FROM recordings WHERE section_id = ? AND project_id = ?')
    .bind(id, pid(c))
    .all<{ r2_key: string }>();
  const imgs = await db
    .prepare('SELECT image_key FROM notes WHERE section_id = ? AND project_id = ? AND image_key IS NOT NULL')
    .bind(id, pid(c))
    .all<{ image_key: string }>();
  const keys = [...(recs.results ?? []).map((r) => r.r2_key), ...(imgs.results ?? []).map((i) => i.image_key)];
  if (keys.length) await c.env.MEDIA.delete(keys);
  await db.prepare('DELETE FROM sections WHERE id = ? AND project_id = ?').bind(id, pid(c)).run();
  return c.redirect('/t/catalogue?msg=' + encodeURIComponent('Song deleted, along with its recordings.'));
});

/* ================================================================== *
 * Teacher — one student
 * ================================================================== */

/* ---------------- schedule ---------------- */

/** Slots for one student, or for everyone when studentId is omitted. */
async function loadSlots(env: Env, projectId: string, studentId?: string): Promise<Slot[]> {
  const q = studentId
    ? env.DB.prepare(
        'SELECT * FROM class_slots WHERE project_id = ?1 AND student_id = ?2 ORDER BY weekday, time_ist',
      ).bind(projectId, studentId)
    : env.DB.prepare('SELECT * FROM class_slots WHERE project_id = ?1 ORDER BY weekday, time_ist').bind(projectId);
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

async function loadExceptions(env: Env, projectId: string, from: string, to: string): Promise<SlotException[]> {
  // A moved class can land outside the window it came from, and one moved
  // *into* the window came from a date outside it, so the range is widened
  // generously either side rather than matched exactly. It has to cover the
  // padding expand() scans with, or a class moved across a week boundary is
  // read without its exception and appears on both dates.
  // slot_exceptions carries no project_id of its own: it reaches a project
  // only through the slot it changes, so the scope goes on that join.
  const r = await env.DB.prepare(
    `SELECT x.slot_id, x.on_date, x.action, x.new_date, x.new_time_ist, x.reason
     FROM slot_exceptions x
     JOIN class_slots cs ON cs.id = x.slot_id AND cs.project_id = ?3
     WHERE x.on_date BETWEEN ?1 AND ?2`,
  )
    .bind(addDays(from, -21), addDays(to, 21), projectId)
    .all<SlotException>();
  return r.results ?? [];
}

/**
 * The lesson log for one student, newest first, with the songs each class
 * touched folded in. SEP is an unlikely-in-a-song-title separator so the
 * concatenated lists can be split apart again for display.
 */
async function sessionsFor(env: Env, projectId: string, studentId: string): Promise<SessionRow[]> {
  const r = await env.DB.prepare(
    `SELECT s.*,
       (SELECT group_concat(sec.title, ?2) FROM session_sections ss
          JOIN sections sec ON sec.id = ss.section_id AND sec.project_id = ?3
         WHERE ss.session_id = s.id) AS section_titles,
       (SELECT group_concat(ss.section_id, ?2) FROM session_sections ss
         WHERE ss.session_id = s.id) AS section_ids
     FROM sessions s
     WHERE s.student_id = ?1 AND s.project_id = ?3
     ORDER BY s.held_on DESC, s.created_at DESC`,
  )
    .bind(studentId, SEP, projectId)
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
async function setSessionSections(env: Env, projectId: string, sessionId: string, sectionIds: string[]) {
  // session_sections has no project_id: both ends are checked against their
  // parents instead, so neither a foreign lesson nor a foreign song can be
  // touched from here.
  await env.DB.prepare(
    `DELETE FROM session_sections WHERE session_id = ?1
       AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = ?1 AND s.project_id = ?2)`,
  )
    .bind(sessionId, projectId)
    .run();
  if (!sectionIds.length) return;
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO session_sections (session_id, section_id)
     SELECT ?1, ?2
      WHERE EXISTS (SELECT 1 FROM sessions s WHERE s.id = ?1 AND s.project_id = ?3)
        AND EXISTS (SELECT 1 FROM sections sec WHERE sec.id = ?2 AND sec.project_id = ?3)`,
  );
  await env.DB.batch(sectionIds.map((id) => stmt.bind(sessionId, id, projectId)));
}

async function assignedFor(env: Env, projectId: string, studentId: string): Promise<AssignedRow[]> {
  const r = await env.DB.prepare(
    `SELECT s.*, g.name AS group_name, a.completed_at AS completed_at,
       (SELECT COUNT(*) FROM recordings x WHERE x.section_id = s.id AND x.student_id = ?1 AND x.project_id = ?2) AS rec_count,
       (SELECT COUNT(*) FROM notes n  WHERE n.section_id = s.id AND n.student_id = ?1 AND n.project_id = ?2) AS note_count,
       (SELECT MAX(x.created_at) FROM recordings x WHERE x.section_id = s.id AND x.student_id = ?1 AND x.project_id = ?2) AS last_added
     FROM assignments a
     JOIN sections s ON s.id = a.section_id AND s.project_id = ?2
     LEFT JOIN groups g ON g.id = s.group_id AND g.project_id = ?2
     WHERE a.student_id = ?1 AND a.project_id = ?2 AND a.archived_at IS NULL
     ORDER BY COALESCE(g.sort_order, 9999), s.sort_order, s.title COLLATE NOCASE`,
  )
    .bind(studentId, projectId)
    .all<AssignedRow>();
  return r.results ?? [];
}

/* ---------------- one student, across five tabs ---------------- */

/**
 * A student of the acting project, or null.
 *
 * The membership join is the whole point: without it this was `SELECT *
 * FROM users WHERE id = ?`, and every tab below would happily render
 * another teacher's student's name, email, phone and time zone. The role
 * and standing shown come from that membership too, so a student paused
 * here still reads as active in the project that has not paused them.
 */
async function studentOr404(env: Env, projectId: string, id: string): Promise<ProjectPerson | null> {
  return (
    (await env.DB.prepare(
      `SELECT ${MEMBER_COLS} FROM users u
         JOIN project_members m ON m.user_id = u.id AND m.project_id = ?2
        WHERE u.id = ?1 AND m.role = 'student'`,
    )
      .bind(id, projectId)
      .first<ProjectPerson>()) ?? null
  );
}

async function tabCounts(env: Env, projectId: string, studentId: string): Promise<Stu.TabCounts> {
  const r = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM assignments WHERE student_id = ?1 AND project_id = ?2 AND archived_at IS NULL) AS songs,
            (SELECT COUNT(*) FROM sessions WHERE student_id = ?1 AND project_id = ?2) AS lessons`,
  )
    .bind(studentId, projectId)
    .first<Stu.TabCounts>();
  return r ?? { songs: 0, lessons: 0 };
}

/**
 * Their next classes, computed from the slots. A student who isn't active
 * has none: their weekly pattern is kept, but nothing is scheduled from it
 * until they come back.
 */
async function upcomingFor(env: Env, projectId: string, studentId: string, days = 28): Promise<Occurrence[]> {
  /* "Active" is a standing in this project, so it is read from the
     membership: a student this teacher paused keeps their classes with the
     teacher who has not. */
  const student = await env.DB.prepare(
    'SELECT status FROM project_members WHERE user_id = ?1 AND project_id = ?2',
  )
    .bind(studentId, projectId)
    .first<{ status: string }>();
  if (student && student.status !== 'active') return [];

  const slots = await loadSlots(env, projectId, studentId);
  if (!slots.length) return [];
  const from = istToday();
  return expand(slots, await loadExceptions(env, projectId, from, addDays(from, days - 1)), from, days);
}

app.get('/t/s/:id', requireTeacher, async (c) => {
  const student = await studentOr404(c.env, pid(c), c.req.param('id'));
  if (!student) return c.html(V.notFound(c.get('user'), site(c)), 404);
  const assigned = await assignedFor(c.env, pid(c), student.id);
  return c.html(
    Stu.overviewTab(
      c.get('user'),
      student,
      await tabCounts(c.env, pid(c), student.id),
      {
        sessions: await sessionsFor(c.env, pid(c), student.id),
        upcoming: await upcomingFor(c.env, pid(c), student.id),
        learning: assigned.filter((a) => !a.completed_at),
        visiting: visiting(c),
      },
      site(c),
      c.req.query('msg'),
    ),
  );
});

app.get('/t/s/:id/songs', requireTeacher, async (c) => {
  const student = await studentOr404(c.env, pid(c), c.req.param('id'));
  if (!student) return c.html(V.notFound(c.get('user'), site(c)), 404);
  const catalogue = await c.env.DB.prepare(
    `SELECT s.*, g.name AS group_name FROM sections s
     LEFT JOIN groups g ON g.id = s.group_id AND g.project_id = ?1
     WHERE s.project_id = ?1
     ORDER BY COALESCE(g.sort_order, 9999), s.sort_order, s.title COLLATE NOCASE`,
  )
    .bind(pid(c))
    .all<Section & { group_name: string | null }>();
  return c.html(
    Stu.songsTab(
      c.get('user'),
      student,
      await tabCounts(c.env, pid(c), student.id),
      await assignedFor(c.env, pid(c), student.id),
      catalogue.results ?? [],
      site(c),
      c.req.query('msg'),
      visiting(c),
    ),
  );
});

app.get('/t/s/:id/lessons', requireTeacher, async (c) => {
  const student = await studentOr404(c.env, pid(c), c.req.param('id'));
  if (!student) return c.html(V.notFound(c.get('user'), site(c)), 404);

  const today = istToday();
  const mp = c.req.query('month');
  const month = mp && /^\d{4}-\d{2}$/.test(mp) ? `${mp}-01` : `${today.slice(0, 7)}-01`;
  const slots = await loadSlots(c.env, pid(c), student.id);
  let monthOccs = slots.length
    ? expand(slots, await loadExceptions(c.env, pid(c), month, addDays(month, 41)), month, 42, {
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
  return c.html(
    Stu.lessonsTab(
      c.get('user'),
      student,
      await tabCounts(c.env, pid(c), student.id),
      {
        sessions: await sessionsFor(c.env, pid(c), student.id),
        assigned: await assignedFor(c.env, pid(c), student.id),
        month,
        monthOccs,
        prevMonth: shift(-1),
        nextMonth: shift(1),
        dictate: dictateEnabled(c.env),
        visiting: visiting(c),
      },
      site(c),
      c.req.query('msg'),
    ),
  );
});

app.get('/t/s/:id/schedule', requireTeacher, async (c) => {
  const student = await studentOr404(c.env, pid(c), c.req.param('id'));
  if (!student) return c.html(V.notFound(c.get('user'), site(c)), 404);
  return c.html(
    Stu.scheduleTab(
      c.get('user'),
      student,
      await tabCounts(c.env, pid(c), student.id),
      {
        slots: (await loadSlots(c.env, pid(c), student.id)) as unknown as ClassSlot[],
        upcoming: await upcomingFor(c.env, pid(c), student.id, 42),
        visiting: visiting(c),
      },
      site(c),
      c.req.query('msg'),
    ),
  );
});

app.get('/t/s/:id/settings', requireTeacher, async (c) => {
  const student = await studentOr404(c.env, pid(c), c.req.param('id'));
  if (!student) return c.html(V.notFound(c.get('user'), site(c)), 404);
  return c.html(
    Stu.settingsTab(
      c.get('user'), student, await tabCounts(c.env, pid(c), student.id), site(c), c.req.query('msg'),
      visiting(c),
    ),
  );
});

/* ---------------- one class, opened to teach it ---------------- */

app.get('/t/class/:slotId/:date', requireTeacher, async (c) => {
  const slotId = c.req.param('slotId');
  const date = c.req.param('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.redirect('/t/schedule/week');

  const slot = await c.env.DB.prepare('SELECT * FROM class_slots WHERE id = ?1 AND project_id = ?2')
    .bind(slotId, pid(c))
    .first<Slot>();
  if (!slot) return c.html(V.notFound(c.get('user'), site(c)), 404);

  const student = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.avatar_url, u.time_zone, u.location, u.phone, m.status AS status
       FROM users u
       JOIN project_members m ON m.user_id = u.id AND m.project_id = ?2
      WHERE u.id = ?1`,
  )
    .bind(slot.student_id, pid(c))
    .first<ClassPageData['student']>();
  if (!student) return c.html(V.notFound(c.get('user'), site(c)), 404);

  // `date` is the date the class was originally due, which is how an exception
  // is keyed — so a rescheduled class keeps working from its original link.
  // That is what `by: 'originalDate'` asks for: expand trims by the date a
  // class *lands* on by default, which would throw away the very occurrence
  // this page exists to show.
  const occ = expand([slot], await loadExceptions(c.env, pid(c), date, date), date, 1, {
    includeSkipped: true,
    by: 'originalDate',
  }).find((o) => o.originalDate === date);
  if (!occ) return c.html(V.notFound(c.get('user'), site(c)), 404);

  const lastLesson =
    (await c.env.DB.prepare(
      `SELECT s.*, NULL AS section_titles, NULL AS section_ids FROM sessions s
       WHERE s.student_id = ?1 AND s.held_on < ?2 AND s.project_id = ?3
       ORDER BY s.held_on DESC, s.created_at DESC LIMIT 1`,
    )
      .bind(student.id, occ.date, pid(c))
      .first<SessionRow>()) ?? null;

  const alreadyLogged =
    (await c.env.DB.prepare(
      `SELECT s.*, NULL AS section_titles, NULL AS section_ids FROM sessions s
       WHERE s.student_id = ?1 AND s.held_on = ?2 AND s.project_id = ?3 LIMIT 1`,
    )
      .bind(student.id, occ.date, pid(c))
      .first<SessionRow>()) ?? null;

  const songs = (await assignedFor(c.env, pid(c), student.id)).filter((a) => !a.completed_at);

  return c.html(
    classPage(
      c.get('user'),
      { student, occ, lastLesson, songs, alreadyLogged, dictate: dictateEnabled(c.env), visiting: visiting(c) },
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
    /* :id is a student id from the URL, so the lesson is only written if they
       are a member of the acting project. */
    `INSERT INTO sessions
       (project_id, id, student_id, held_on, status, covered, left_off, next_focus,
        covered_ml, left_off_ml, next_focus_ml, duration_min, created_by, created_at)
     SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14
      WHERE EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = ?3 AND m.project_id = ?1)`,
  )
    .bind(pid(c), id, studentId, d.held_on, d.status, d.covered, d.left_off, d.next_focus,
          d.covered_ml, d.left_off_ml, d.next_focus_ml, d.duration_min, c.get('user').id, now())
    .run();
  await setSessionSections(c.env, pid(c), id, d.sectionIds);

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
  const existing = await c.env.DB.prepare('SELECT student_id FROM sessions WHERE id = ?1 AND project_id = ?2')
    .bind(id, pid(c))
    .first<{ student_id: string }>();
  if (!existing) return c.redirect('/t');

  const d = readSessionForm(await c.req.formData());
  await c.env.DB.prepare(
    `UPDATE sessions SET held_on=?, status=?, covered=?, left_off=?, next_focus=?,
       covered_ml=?, left_off_ml=?, next_focus_ml=?, duration_min=?, updated_at=?
     WHERE id=? AND project_id=?`,
  )
    .bind(d.held_on, d.status, d.covered, d.left_off, d.next_focus,
          d.covered_ml, d.left_off_ml, d.next_focus_ml, d.duration_min, now(), id, pid(c))
    .run();
  await setSessionSections(c.env, pid(c), id, d.sectionIds);

  return c.redirect(`/t/s/${existing.student_id}/lessons?msg=` + encodeURIComponent('Lesson updated.'));
});

app.post('/t/sessions/:id/complete', requireTeacher, async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT student_id FROM sessions WHERE id = ?1 AND project_id = ?2')
    .bind(id, pid(c))
    .first<{ student_id: string }>();
  if (!row) return c.redirect('/t');
  await c.env.DB.prepare("UPDATE sessions SET status='completed', updated_at=? WHERE id=? AND project_id=?")
    .bind(now(), id, pid(c))
    .run();
  return c.redirect(`/t/s/${row.student_id}/lessons?msg=` + encodeURIComponent('Lesson marked finished.'));
});

app.post('/t/sessions/:id/delete', requireTeacher, async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT student_id FROM sessions WHERE id = ?1 AND project_id = ?2')
    .bind(id, pid(c))
    .first<{ student_id: string }>();
  if (!row) return c.redirect('/t');
  await c.env.DB.prepare('DELETE FROM sessions WHERE id = ? AND project_id = ?').bind(id, pid(c)).run();
  return c.redirect(`/t/s/${row.student_id}/lessons?msg=` + encodeURIComponent('Lesson deleted from the log.'));
});

app.post('/t/s/:id/assign', requireTeacher, async (c) => {
  const studentId = c.req.param('id');
  const f = await c.req.formData();
  const sectionId = String(f.get('section_id') ?? '');
  if (!sectionId) return c.redirect(`/t/s/${studentId}`);
  await c.env.DB.prepare(
    /* :id is a student id straight out of the URL — gated on membership of the
       acting project, the same as the song page's assign. */
    `INSERT INTO assignments (project_id, id, student_id, section_id, assigned_by, assigned_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6
      WHERE EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = ?3 AND m.project_id = ?1)
     ON CONFLICT(student_id, section_id) DO UPDATE SET archived_at = NULL`,
  )
    .bind(pid(c), newId('a'), studentId, sectionId, c.get('user').id, now())
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
    'UPDATE assignments SET completed_at = ? WHERE student_id = ? AND section_id = ? AND project_id = ?',
  )
    .bind(done ? now() : null, studentId, String(f.get('section_id') ?? ''), pid(c))
    .run();
  const back = String(f.get('back') ?? '') || `/t/s/${studentId}`;
  return c.redirect(`${back}?msg=` + encodeURIComponent(done ? 'Marked as finished.' : 'Back in progress.'));
});

app.post('/t/s/:id/unassign', requireTeacher, async (c) => {
  const studentId = c.req.param('id');
  const f = await c.req.formData();
  await c.env.DB.prepare(
    'UPDATE assignments SET archived_at = ? WHERE student_id = ? AND section_id = ? AND project_id = ?',
  )
    .bind(now(), studentId, String(f.get('section_id') ?? ''), pid(c))
    .run();
  const back = String(f.get('back') ?? '') || `/t/s/${studentId}/songs`;
  return c.redirect(`${back}?msg=` + encodeURIComponent('Removed from their list. Recordings kept.'));
});

/* ================================================================== *
 * The song workspace
 * ================================================================== */

async function loadSong(env: Env, projectId: string, studentId: string, sectionId: string) {
  const section = await env.DB.prepare(
    `SELECT s.*, g.name AS group_name FROM sections s
     LEFT JOIN groups g ON g.id = s.group_id AND g.project_id = ?2
     WHERE s.id = ?1 AND s.project_id = ?2`,
  )
    .bind(sectionId, projectId)
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
     FROM recordings r WHERE r.section_id = ?1 AND r.project_id = ?3
     ORDER BY r.sort_order, r.created_at`,
  )
    .bind(sectionId, studentId, projectId)
    .all<Recording & { locked: number }>();
  const notes = await env.DB.prepare(
    `SELECT * FROM notes WHERE section_id = ?1 AND project_id = ?3
       AND (visibility = 'shared'
            OR id IN (SELECT note_id FROM note_shares WHERE student_id = ?2))
     ORDER BY sort_order, created_at`,
  )
    .bind(sectionId, studentId, projectId)
    .all<Note>();

  return { section, recordings: recordings.results ?? [], notes: notes.results ?? [] };
}

app.get('/t/s/:sid/:secid', requireTeacher, async (c) => {
  const student = await studentOr404(c.env, pid(c), c.req.param('sid'));
  if (!student) return c.html(V.notFound(c.get('user'), site(c)), 404);
  const data = await loadSong(c.env, pid(c), student.id, c.req.param('secid'));
  if (!data) return c.html(V.notFound(c.get('user'), site(c)), 404);

  return c.html(
    V.songPage({
      viewer: c.get('user'),
      isTeacher: acting(c).isTeacher,
      student,
      ...data,
      siteName: site(c),
      msg: c.req.query('msg'),
      dictate: dictateEnabled(c.env),
      visiting: visiting(c),
    }),
  );
});

app.get('/me', requireUser, async (c) => {
  const user = c.get('user');
  /* Whether they teach is a fact about them IN THIS PROJECT. Reading the dead
     users.role instead sent anyone who teaches anywhere to /t, where
     requireTeacher sent them straight back here — a loop, for exactly the
     person projects exist for: a teacher over there, a student here. */
  if (acting(c).isTeacher) return c.redirect('/t');
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const all = await assignedFor(c.env, pid(c), user.id);
  const assigned = q
    ? all.filter((a) =>
        [a.title, a.title_ml, a.raga, a.taala, a.composer, a.group_name]
          .some((v) => (v ?? '').toLowerCase().includes(q)),
      )
    : all;

  // The next few classes, on the student's own clock.
  const from = istToday();
  const slots = await loadSlots(c.env, pid(c), user.id);
  const occs = slots.length
    ? expand(slots, await loadExceptions(c.env, pid(c), from, addDays(from, 27)), from, 28)
    : [];

  return c.html(V.studentHome(user, assigned, await sessionsFor(c.env, pid(c), user.id), site(c), q, occs));
});

app.get('/me/:secid', requireUser, async (c) => {
  const user = c.get('user');
  if (acting(c).isTeacher) return c.redirect('/t');

  // A student may only open a song that is actually assigned to them.
  const ok = await c.env.DB.prepare(
    'SELECT 1 AS x FROM assignments WHERE student_id = ? AND section_id = ? AND archived_at IS NULL AND project_id = ?',
  )
    .bind(user.id, c.req.param('secid'), pid(c))
    .first();
  if (!ok) return c.html(V.notFound(user, site(c)), 404);

  const data = await loadSong(c.env, pid(c), user.id, c.req.param('secid'));
  if (!data) return c.html(V.notFound(user, site(c)), 404);
  return c.html(
    V.songPage({ viewer: user, student: user, ...data, siteName: site(c), isTeacher: acting(c).isTeacher }),
  );
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
  projectId: string,
  studentId: string,
  item: { id: string; section_id: string; visibility: string },
  kind: 'recording' | 'note',
): Promise<boolean> {
  if (item.visibility !== 'shared') {
    // The share tables carry no project_id, so each is joined to its parent
    // and scoped there.
    const given = await env.DB.prepare(
      kind === 'recording'
        ? `SELECT 1 AS x FROM recording_shares rs
             JOIN recordings r ON r.id = rs.recording_id AND r.project_id = ?3
            WHERE rs.recording_id = ?1 AND rs.student_id = ?2`
        : `SELECT 1 AS x FROM note_shares ns
             JOIN notes n ON n.id = ns.note_id AND n.project_id = ?3
            WHERE ns.note_id = ?1 AND ns.student_id = ?2`,
    )
      .bind(item.id, studentId, projectId)
      .first();
    if (!given) return false;
  }
  const assigned = await env.DB.prepare(
    'SELECT 1 AS x FROM assignments WHERE student_id = ? AND section_id = ? AND archived_at IS NULL AND project_id = ?',
  )
    .bind(studentId, item.section_id, projectId)
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
  projectId: string,
  kind: 'recording' | 'note',
  itemId: string,
  visibility: string,
  studentIds: string[],
): Promise<'shared' | 'chosen'> {
  const table = kind === 'recording' ? 'recording_shares' : 'note_shares';
  const col = kind === 'recording' ? 'recording_id' : 'note_id';
  // The share table reaches a project only through the item it shares, so
  // every write here is gated on that item being in the acting project.
  const parent = kind === 'recording' ? 'recordings' : 'notes';
  const chosen = visibility === 'chosen' && studentIds.length > 0;

  const stmts = [
    env.DB.prepare(
      `DELETE FROM ${table} WHERE ${col} = ?1
         AND EXISTS (SELECT 1 FROM ${parent} p WHERE p.id = ?1 AND p.project_id = ?2)`,
    ).bind(itemId, projectId),
  ];
  if (chosen) {
    const ts = now();
    for (const sid of studentIds) {
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO ${table} (${col}, student_id, created_at)
           SELECT ?1, ?2, ?3
            WHERE EXISTS (SELECT 1 FROM ${parent} p WHERE p.id = ?1 AND p.project_id = ?4)`,
        ).bind(itemId, sid, ts, projectId),
      );
    }
  }
  await env.DB.batch(stmts);
  return chosen ? 'chosen' : 'shared';
}

/** The students an item was given to, as ids. */
async function sharesFor(
  env: Env,
  projectId: string,
  kind: 'recording' | 'note',
  sectionId: string,
): Promise<Map<string, string[]>> {
  const rows =
    kind === 'recording'
      ? await env.DB.prepare(
          `SELECT s.recording_id AS item_id, s.student_id FROM recording_shares s
             JOIN recordings r ON r.id = s.recording_id AND r.project_id = ?2
            WHERE r.section_id = ?1`,
        )
          .bind(sectionId, projectId)
          .all<{ item_id: string; student_id: string }>()
      : await env.DB.prepare(
          `SELECT s.note_id AS item_id, s.student_id FROM note_shares s
             JOIN notes n ON n.id = s.note_id AND n.project_id = ?2
            WHERE n.section_id = ?1`,
        )
          .bind(sectionId, projectId)
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
  const keyterms = [...CARNATIC_TERMS, ...(await catalogueTerms(c.env, pid(c)))];

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
const termCache = new Map<string, { at: number; terms: string[] }>();
async function catalogueTerms(env: Env, projectId: string): Promise<string[]> {
  // Keyed by project: one practice's song titles must never be handed to
  // another's transcriber as vocabulary.
  const hit = termCache.get(projectId);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.terms;
  const { results } = await env.DB.prepare(
    'SELECT title, raga FROM sections WHERE project_id = ? ORDER BY id LIMIT 300',
  )
    .bind(projectId)
    .all<{ title: string; raga: string | null }>();
  const set = new Set<string>();
  for (const r of results ?? []) {
    if (r.title) set.add(r.title);
    if (r.raga) set.add(r.raga);
  }
  const terms = [...set];
  termCache.set(projectId, { at: Date.now(), terms });
  return terms;
}

/**
 * The same decision as dictateEnabled, but it says why — which is the
 * question people actually have when the button isn't there.
 */
/**
 * Whether Google sign-in can work, and if not, which half is missing.
 * Never prints a value — only whether a name has one.
 */
export function signinWhy(env: Env): string {
  const id = (env.GOOGLE_CLIENT_ID || '').trim();
  const secret = (env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!id && !secret) return 'off (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set)';
  if (!id) return 'off (GOOGLE_CLIENT_SECRET is set but GOOGLE_CLIENT_ID is not)';
  if (!secret) return 'off (GOOGLE_CLIENT_ID is set but GOOGLE_CLIENT_SECRET is not)';
  /* A Google client id always ends this way. Getting the secret and the id
     the wrong way round is a common slip and produces the same
     "invalid_client" page as setting neither. */
  if (!id.endsWith('.apps.googleusercontent.com'))
    return 'suspect (GOOGLE_CLIENT_ID does not end in .apps.googleusercontent.com — is it the secret by mistake?)';
  return 'ok';
}

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
    'SELECT COALESCE(MAX(sort_order),0) AS m FROM recordings WHERE section_id = ? AND project_id = ?',
  )
    .bind(sectionId, pid(c))
    .first<{ m: number }>();

  await c.env.DB.prepare(
    `INSERT INTO recordings
       (project_id, id, section_id, student_id, title, kind, r2_key, mime_type, duration_sec, size_bytes,
        source, uploaded_by, sort_order, part, description, visibility, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(pid(c), id, sectionId, studentId, title, kind, key, mime, duration, file.size, source,
      c.get('user').id, (max?.m ?? 0) + 10, String(form.get('part') ?? '').trim() || null,
      String(form.get('description') ?? '').trim() || null, visibility, now())
    .run();

  if (visibility === 'chosen') await setShares(c.env, pid(c), 'recording', id, 'chosen', shareIds);

  return c.json({ ok: true, id });
});

/**
 * Move a recording up or down within its song by swapping sort_order with the
 * neighbour. Plain form posts, so it works without JavaScript.
 */
app.post('/t/recordings/:id/move', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const dir = String(f.get('dir')) === 'up' ? 'up' : 'down';
  const rec = await c.env.DB.prepare('SELECT * FROM recordings WHERE id = ?1 AND project_id = ?2')
    .bind(c.req.param('id'), pid(c))
    .first<Recording>();
  if (!rec) return c.redirect('/t');

  /* The song page groups recordings by the part they cover, so "up" has
     to mean "up within Pallavi" — swapping with a neighbour in another
     part looks, to the teacher, like the button did nothing at all. */
  const neighbour = await c.env.DB.prepare(
    dir === 'up'
      ? `SELECT * FROM recordings WHERE section_id=?1 AND project_id=?5 AND COALESCE(part,'') = ?4
           AND (sort_order < ?2 OR (sort_order = ?2 AND created_at < ?3))
         ORDER BY sort_order DESC, created_at DESC LIMIT 1`
      : `SELECT * FROM recordings WHERE section_id=?1 AND project_id=?5 AND COALESCE(part,'') = ?4
           AND (sort_order > ?2 OR (sort_order = ?2 AND created_at > ?3))
         ORDER BY sort_order ASC, created_at ASC LIMIT 1`,
  )
    .bind(rec.section_id, rec.sort_order, rec.created_at, rec.part ?? '', pid(c))
    .first<Recording>();

  if (neighbour) {
    // Equal sort_order values would swap to no effect, so separate them first.
    const a = rec.sort_order;
    const b = neighbour.sort_order;
    const [newA, newB] = a === b ? (dir === 'up' ? [b - 1, b] : [b + 1, b]) : [b, a];
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE recordings SET sort_order = ? WHERE id = ? AND project_id = ?').bind(newA, rec.id, pid(c)),
      c.env.DB.prepare('UPDATE recordings SET sort_order = ? WHERE id = ? AND project_id = ?').bind(newB, neighbour.id, pid(c)),
    ]);
  }
  const back = String(f.get('back') ?? '');
  return c.redirect(back || `/t/song/${rec.section_id}`);
});

app.post('/t/recordings/:id/delete', requireTeacher, async (c) => {
  const rec = await c.env.DB.prepare('SELECT * FROM recordings WHERE id = ?1 AND project_id = ?2')
    .bind(c.req.param('id'), pid(c))
    .first<Recording>();
  if (!rec) return c.redirect('/t');
  await c.env.MEDIA.delete(rec.r2_key);
  await c.env.DB.prepare('DELETE FROM recordings WHERE id = ? AND project_id = ?').bind(rec.id, pid(c)).run();
  return c.redirect(`/t/song/${rec.section_id}?msg=` + encodeURIComponent('Recording deleted.'));
});

/** Stream media from R2 with Range support so seeking works in the player. */
app.get('/media/:id', requireUser, async (c) => {
  const user = c.get('user');
  const rec = await c.env.DB.prepare('SELECT * FROM recordings WHERE id = ?1 AND project_id = ?2')
    .bind(c.req.param('id'), pid(c))
    .first<Recording>();
  if (!rec) return c.notFound();
  if (!acting(c).isTeacher && !(await studentMaySee(c.env, pid(c), user.id, rec, 'recording')))
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
  const rec = await c.env.DB.prepare('SELECT * FROM recordings WHERE id = ?1 AND project_id = ?2')
    .bind(c.req.param('id'), pid(c))
    .first<Recording>();
  if (!rec || !studentId) return c.redirect('/t');

  if (rec.visibility !== 'shared') {
    /* student_id arrives on a form, so it is checked the same way the
       recording is: the SELECT ... WHERE EXISTS hands the take to nobody
       unless they are a member of the acting project. */
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO recording_shares (recording_id, student_id, created_at)
       SELECT ?1, ?2, ?3
        WHERE EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = ?2 AND m.project_id = ?4)`,
    )
      .bind(rec.id, studentId, now(), pid(c))
      .run();
  }
  const back = String(f.get('back') ?? '') || `/t/s/${studentId}/${rec.section_id}`;
  return c.redirect(`${back}?msg=` + encodeURIComponent('Unlocked for this student.'));
});

app.post('/t/recordings/:id/unshare', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const studentId = String(f.get('student_id') ?? '');
  const rec = await c.env.DB.prepare('SELECT * FROM recordings WHERE id = ?1 AND project_id = ?2')
    .bind(c.req.param('id'), pid(c))
    .first<Recording>();
  if (!rec || !studentId) return c.redirect('/t');

  if (rec.visibility === 'shared') {
    const others = await c.env.DB.prepare(
      `SELECT student_id FROM assignments
        WHERE section_id = ? AND project_id = ? AND archived_at IS NULL AND student_id <> ?`,
    )
      .bind(rec.section_id, pid(c), studentId)
      .all<{ student_id: string }>();
    const ts = now();
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM recording_shares WHERE recording_id = ?').bind(rec.id),
      ...(others.results ?? []).map((r) =>
        c.env.DB.prepare(
          'INSERT OR IGNORE INTO recording_shares (recording_id, student_id, created_at) VALUES (?,?,?)',
        ).bind(rec.id, r.student_id, ts),
      ),
      // project_id is in this WHERE too: a recording outside the acting project matches nothing.
      c.env.DB.prepare("UPDATE recordings SET visibility = 'chosen' WHERE id = ? AND project_id = ?").bind(rec.id, pid(c)),
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
      ? 'SELECT COALESCE(MAX(sort_order),0) AS m FROM notes WHERE section_id = ?1 AND project_id = ?2 AND recording_id = ?3'
      : 'SELECT COALESCE(MAX(sort_order),0) AS m FROM notes WHERE section_id = ?1 AND project_id = ?2 AND recording_id IS NULL',
  )
    .bind(...(recordingId ? [sectionId, pid(c), recordingId] : [sectionId, pid(c)]))
    .first<{ m: number }>();

  await c.env.DB.prepare(
    `INSERT INTO notes (project_id, id, section_id, student_id, recording_id, title, body, body_ml,
       image_key, image_mime, image_bytes, created_by, sort_order, visibility, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(pid(c), id, sectionId, studentId, recordingId, String(f.get('title') ?? '').trim() || null,
      body, bodyMl, imageKey, imageMime, imageBytes,
      c.get('user').id, (nmax?.m ?? 0) + 10, visibility, now())
    .run();

  if (wantChosen) await setShares(c.env, pid(c), 'note', id, 'chosen', shareIds);

  return c.redirect(`${back}?msg=` + encodeURIComponent('Note saved.'));
});

app.post('/notes/:id/delete', requireTeacher, async (c) => {
  const note = await c.env.DB.prepare('SELECT * FROM notes WHERE id = ?1 AND project_id = ?2')
    .bind(c.req.param('id'), pid(c))
    .first<Note>();
  if (!note) return c.redirect('/t');
  if (note.image_key) await c.env.MEDIA.delete(note.image_key);
  await c.env.DB.prepare('DELETE FROM notes WHERE id = ? AND project_id = ?').bind(note.id, pid(c)).run();
  return c.redirect(`/t/song/${note.section_id}?msg=` + encodeURIComponent('Note deleted.'));
});

app.get('/img/:id', requireUser, async (c) => {
  const user = c.get('user');
  const note = await c.env.DB.prepare('SELECT * FROM notes WHERE id = ?1 AND project_id = ?2')
    .bind(c.req.param('id'), pid(c))
    .first<Note>();
  if (!note?.image_key) return c.notFound();
  if (!acting(c).isTeacher && !(await studentMaySee(c.env, pid(c), user.id, note, 'note')))
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
       JOIN sections s ON s.id = n.section_id AND s.project_id = ?2
       LEFT JOIN recordings r ON r.id = n.recording_id AND r.project_id = ?2
      WHERE n.id = ?1 AND n.project_id = ?2`,
  )
    .bind(c.req.param('id'), pid(c))
    .first<Note & { song_title: string; rec_title: string | null }>();
  if (!note) return c.notFound();
  if (!acting(c).isTeacher && !(await studentMaySee(c.env, pid(c), user.id, note, 'note')))
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

  const slots = await loadSlots(c.env, pid(c));
  const exceptions = await loadExceptions(c.env, pid(c), from, to);
  const occs = expand(slots, exceptions, from, days, { includeSkipped: true });

  const studentIds = [...new Set(occs.map((o) => o.slot.student_id))];
  const students = new Map<string, Sched.WithZone>();
  if (studentIds.length) {
    const rows = await c.env.DB.prepare(
      `SELECT u.id, u.name, u.avatar_url, u.time_zone, u.location, m.status AS status
         FROM users u
         JOIN project_members m ON m.user_id = u.id AND m.project_id = ?1
        WHERE u.id IN (${studentIds.map((_, i) => `?${i + 2}`).join(',')})`,
    )
      .bind(pid(c), ...studentIds)
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
    Sched.schedulePageWrapped(
      c.get('user'), [...byDate.values()], days, site(c), c.req.query('msg'), visiting(c),
    ),
  );
});

/** Load the students behind a set of occurrences, keyed by id. */
async function studentsFor(
  env: Env,
  projectId: string,
  ids: string[],
): Promise<Map<string, Sched.WithZone>> {
  const out = new Map<string, Sched.WithZone>();
  if (!ids.length) return out;
  const rows = await env.DB.prepare(
    `SELECT u.id, u.name, u.avatar_url, u.time_zone, u.location, m.status AS status
       FROM users u
       JOIN project_members m ON m.user_id = u.id AND m.project_id = ?1
      WHERE u.id IN (${ids.map((_, i) => `?${i + 2}`).join(',')})`,
  )
    .bind(projectId, ...ids)
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

  const slots = await loadSlots(c.env, pid(c));
  const exceptions = await loadExceptions(c.env, pid(c), start, addDays(start, 6));
  const occs = expand(slots, exceptions, start, 7, { includeSkipped: true });
  const students = await studentsFor(c.env, pid(c), [...new Set(occs.map((o) => o.slot.student_id))]);

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

  return c.html(
    Sched.weekCalendar(c.get('user'), start, cells, site(c), c.req.query('msg'), visiting(c)),
  );
});

/** One day, opened from the calendar. */
app.get('/t/schedule/day/:date', requireTeacher, async (c) => {
  const date = c.req.param('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.redirect('/t/schedule/week');

  const slots = await loadSlots(c.env, pid(c));
  const exceptions = await loadExceptions(c.env, pid(c), date, date);
  const occs = expand(slots, exceptions, date, 1, { includeSkipped: true }).filter((o) => o.date === date);
  const students = await studentsFor(c.env, pid(c), [...new Set(occs.map((o) => o.slot.student_id))]);

  const items = occs
    .map((occ) => ({ occ, student: students.get(occ.slot.student_id)! }))
    .filter((x) => x.student && stillScheduled(x.student.status, x.occ.date, istToday()));

  return c.html(Sched.dayView(c.get('user'), date, items, site(c), c.req.query('msg'), visiting(c)));
});

/** A class that should have happened and didn't. Distinct from a cancellation. */
app.post('/t/slots/:id/missed', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const onDate = String(f.get('on_date') ?? '');
  if (!onDate) return c.redirect('/t/schedule');
  await c.env.DB.prepare(
    /* slot_exceptions has no project_id — the SELECT ... WHERE EXISTS is how
       the change is kept to a slot in the acting project. */
    `INSERT INTO slot_exceptions (id, slot_id, on_date, action, reason, created_at)
     SELECT ?1, ?2, ?3, 'missed', ?4, ?5
      WHERE EXISTS (SELECT 1 FROM class_slots cs WHERE cs.id = ?2 AND cs.project_id = ?6)
     ON CONFLICT(slot_id, on_date) DO UPDATE SET
       action='missed', new_date=NULL, new_time_ist=NULL, reason=excluded.reason`,
  )
    .bind(newId('ex'), c.req.param('id'), onDate, String(f.get('reason') ?? '').trim() || null, now(), pid(c))
    .run();
  const back = String(f.get('back') ?? '') || '/t/schedule';
  return c.redirect(`${back}?msg=` + encodeURIComponent('Marked as missed. Reschedule it below if you want to.'));
});

app.get('/t/schedule/slots', requireTeacher, async (c) => {
  const students = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.avatar_url, u.time_zone, u.location
       FROM users u
       JOIN project_members m ON m.user_id = u.id AND m.project_id = ?1
      WHERE m.status = 'active' AND m.role = 'student'
      ORDER BY u.name COLLATE NOCASE`,
  )
    .bind(pid(c))
    .all<Sched.WithZone & { email: string }>();

  const allSlots = await loadSlots(c.env, pid(c));
  const rows: Sched.StudentSlots[] = (students.results ?? []).map((student) => ({
    student,
    slots: allSlots.filter((s) => s.student_id === student.id) as unknown as ClassSlot[],
  }));

  return c.html(Sched.slotsPage(c.get('user'), rows, site(c), c.req.query('msg'), visiting(c)));
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
    /* :id is a student id from the URL, so the slot is only created if they
       are a member of the acting project. */
    `INSERT INTO class_slots
       (project_id, id, student_id, kind, weekday, on_date, time_ist, duration_min, label, created_by, created_at)
     SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11
      WHERE EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = ?3 AND m.project_id = ?1)`,
  )
    .bind(
      pid(c), newId('cs'), studentId, kind,
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
  await c.env.DB.prepare('DELETE FROM class_slots WHERE id = ? AND project_id = ?')
    .bind(c.req.param('id'), pid(c))
    .run();
  return c.redirect('/t/schedule/slots?msg=' + encodeURIComponent('Slot removed.'));
});

/** Cancel one occurrence without touching the weekly rule. */
app.post('/t/slots/:id/skip', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const onDate = String(f.get('on_date') ?? '');
  if (!onDate) return c.redirect('/t/schedule');
  await c.env.DB.prepare(
    /* Scoped through the slot: slot_exceptions carries no project_id. */
    `INSERT INTO slot_exceptions (id, slot_id, on_date, action, reason, created_at)
     SELECT ?1, ?2, ?3, 'skip', ?4, ?5
      WHERE EXISTS (SELECT 1 FROM class_slots cs WHERE cs.id = ?2 AND cs.project_id = ?6)
     ON CONFLICT(slot_id, on_date) DO UPDATE SET
       action='skip', new_date=NULL, new_time_ist=NULL, reason=excluded.reason`,
  )
    .bind(newId('ex'), c.req.param('id'), onDate, String(f.get('reason') ?? '').trim() || null, now(), pid(c))
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
    /* Scoped through the slot: slot_exceptions carries no project_id. */
    `INSERT INTO slot_exceptions (id, slot_id, on_date, action, new_date, new_time_ist, reason, created_at)
     SELECT ?1, ?2, ?3, 'move', ?4, ?5, ?6, ?7
      WHERE EXISTS (SELECT 1 FROM class_slots cs WHERE cs.id = ?2 AND cs.project_id = ?8)
     ON CONFLICT(slot_id, on_date) DO UPDATE SET
       action='move', new_date=excluded.new_date, new_time_ist=excluded.new_time_ist,
       reason=excluded.reason`,
  )
    .bind(newId('ex'), c.req.param('id'), onDate, newDate, newTime,
      String(f.get('reason') ?? '').trim() || null, now(), pid(c))
    .run();
  const back = String(f.get('back') ?? '') || '/t/schedule';
  return c.redirect(`${back}?msg=` + encodeURIComponent('Class moved. The student sees the new time on their own clock.'));
});

app.post('/t/slots/:id/restore', requireTeacher, async (c) => {
  const f = await c.req.formData();
  await c.env.DB.prepare(
    /* Scoped through the slot: slot_exceptions carries no project_id. */
    `DELETE FROM slot_exceptions WHERE slot_id = ?1 AND on_date = ?2
       AND EXISTS (SELECT 1 FROM class_slots cs WHERE cs.id = ?1 AND cs.project_id = ?3)`,
  )
    .bind(c.req.param('id'), String(f.get('on_date') ?? ''), pid(c))
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
  /* Where someone is and what clock they keep are global — they do not change
     per teacher — so the EXISTS is what keeps a teacher to the people who are
     actually in their project. */
  await c.env.DB.prepare(
    `UPDATE users SET time_zone = ?1, location = ?2
      WHERE id = ?3
        AND EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = users.id AND m.project_id = ?4)`,
  )
    .bind(tz || null, String(f.get('location') ?? '').trim() || null, c.req.param('id'), pid(c))
    .run();
  return c.redirect('/t/schedule/slots?msg=' + encodeURIComponent('Saved.'));
});

app.post('/me/zone', requireUser, async (c) => {
  const f = await c.req.formData();
  const tz = String(f.get('time_zone') ?? '').trim();
  if (tz && !isValidZone(tz)) return c.redirect('/me');
  /* unscoped: the signed-in user setting their own location and time zone — one person keeps one clock, whichever teachers they learn from */
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
    /* unscoped: the signed-in user setting their own time zone */
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
