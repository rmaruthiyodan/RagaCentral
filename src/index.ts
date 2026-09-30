import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import type { Env, Vars, AppEnv, User, ProjectPerson, Group, Section, Recording, Note, SessionRow, ClassSlot, AssignedRow } from './types';
import { SEP } from './views/sessions';
import * as Sched from './views/schedule';
import { songPage, type SongStudent, type SongPageData } from './views/song';
import * as Stu from './views/student';
import * as Me from './views/me';
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
  requireUserJson, requireAdmin, signInEmail, profilesFor, MAX_PROFILES_PER_EMAIL,
} from './auth';
import {
  pid, acting, addMember, removeMember, createProject, getProject,
  setActiveProject, clearActiveProject, recentAdminLog, resolveProject, logAdmin,
  hatsFor, chosenHat, ADMIN_HAT, ADMIN_IN,
} from './projects';
import { newId, now, extFor, slugify, safeBack, withMsg, uploadType, serveType, lockDownUpload } from './util';
import { isLang } from './i18n';
import { transcribe, DictateError, CARNATIC_TERMS } from './transcribe';
import * as V from './views/pages';
import * as Adm from './views/admin';
import {
  getLink, driveConsentUrl, saveLink, forgetLink, runBackup, checkBackup,
  recentRuns, BackupError,
} from './backup';
import type { StudentRow } from './views/pages';

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

/* ==================================================================
 * Security headers, on every response
 *
 * - nosniff: a browser never second-guesses a Content-Type into HTML.
 * - frame-ancestors / X-Frame-Options: no other site can frame these
 *   pages and trick a click on a Delete button.
 * - Permissions-Policy: the microphone and camera the recorder needs,
 *   for this site only, and nothing else.
 * - A Content-Security-Policy for pages. It still allows inline script,
 *   because every Delete button confirms with an inline onsubmit and the
 *   time-zone reporter is an inline block; what it does is pin every
 *   script, style, font, image, media and fetch to this site (plus Google
 *   Fonts and Google profile photos), and forbid plugins and <base>.
 * An upload already carries its own, stricter policy (lockDownUpload),
 * which is left alone.
 * ================================================================== */
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.googleusercontent.com",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use('*', async (c, next) => {
  await next();
  const set = (h: Headers) => {
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    h.set('X-Frame-Options', 'DENY');
    h.set('Permissions-Policy', 'microphone=(self), camera=(self), geolocation=(), payment=(), usb=()');
    if (new URL(c.req.url).protocol === 'https:')
      h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (!h.has('Content-Security-Policy') && (h.get('Content-Type') ?? '').startsWith('text/html'))
      h.set('Content-Security-Policy', PAGE_CSP);
  };
  try {
    set(c.res.headers);
  } catch {
    // A response whose headers are frozen: copy it once, then set them.
    c.res = new Response(c.res.body, c.res);
    set(c.res.headers);
  }
});

/* ==================================================================
 * No changes from other sites
 *
 * The session cookie is SameSite=Lax, which already keeps it off a POST
 * that another site's page makes — so such a POST arrives signed out.
 * Not every route needs a session to do something, though (signing out
 * is one), and Lax is a browser's promise rather than ours. So a
 * state-changing request that says it came from another origin is
 * refused outright. Browsers send Origin on every cross-site POST; a
 * request with no Origin at all (curl, an old client) is left to the
 * route's own sign-in check, as before.
 * ================================================================== */
app.use('*', async (c, next) => {
  const m = c.req.method;
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
    const origin = c.req.header('origin');
    const fetchSite = c.req.header('sec-fetch-site');
    const here = new URL(c.req.url).origin;
    /* A modern browser says where a request came from outright; only this
       site itself (or the person typing an address) may change anything.
       Otherwise fall back to Origin — and "null", which a sandboxed frame
       on any site can produce, is not this site either. */
    const foreign = fetchSite
      ? fetchSite !== 'same-origin' && fetchSite !== 'none'
      : Boolean(origin) && origin !== here;
    if (foreign) return c.text('That request came from another site, so it was not carried out.', 403);
  }
  await next();
});

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

/* The R2 half of the check is a List call, which is billed. The page
   needs no sign-in, so without this anyone hammering it spends money;
   with it, the store is asked at most every 30 seconds per worker. */
let mediaCheckedAt = 0;
let mediaOk = false;

app.get('/healthz', async (c) => {
  const started = Date.now();
  let db = false;

  try {
    const r = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    db = r?.ok === 1;
  } catch {
    db = false;
  }

  if (Date.now() - mediaCheckedAt > 30_000) {
    try {
      await c.env.MEDIA.list({ limit: 1 });
      mediaOk = true;
    } catch {
      mediaOk = false;
    }
    mediaCheckedAt = Date.now();
  }
  const media = mediaOk;

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
/**
 * Where this person belongs right now.
 *
 * One standing means there is nothing to ask about, so nobody with a
 * single role ever sees the chooser. More than one, and nothing chosen
 * yet, and we ask instead of guessing — which is also what fixes the
 * dead end this used to have: anyone belonging to two practices
 * resolved to no project at all and was sent to the waiting page for
 * an approval that had already happened.
 */
async function landingFor(c: Context<AppEnv, any, any>, user: User): Promise<string> {
  if (!chosenHat(c)) {
    const hats = await hatsFor(c.env, user);
    if (hats.length > 1) return '/hats';
  }
  const acting = await resolveProject(c, user);
  /* A standing that is not active — paused, graduated, ended — is still a
     project to act in (the teacher's pages keep showing that person), but
     the guards on /me and /t turn it away. Sending them there anyway made
     /me bounce to /waiting and /waiting bounce back to /me until Safari
     gave up with "too many redirects". They belong on /waiting, which
     says what their standing is. */
  if (acting && acting.membership && acting.membership.status !== 'active' && !acting.asAdmin)
    return '/waiting';
  if (acting) return acting.isTeacher ? '/t/schedule/week' : '/me';
  if (user.is_admin) return '/admin';
  return '/waiting';
}

/** Where a chosen hat lands you. */
function hatLanding(kind: 'admin' | 'member', role: 'teacher' | 'student' | null): string {
  if (kind === 'admin') return '/admin';
  return role === 'teacher' ? '/t/schedule/week' : '/me';
}

/* ------------------------------------------------------------------ *
 * Choosing a hat
 *
 * Deliberately outside requireUser: that guard's whole job is to settle
 * which project you are acting in, which is the question being asked
 * here. Signed in is the only thing these two need to know.
 * ------------------------------------------------------------------ */

app.get('/hats', async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect('/');

  const hats = await hatsFor(c.env, user);
  if (hats.length === 0) return c.redirect('/waiting');
  if (hats.length === 1) {
    /* Nothing to choose. Record it anyway so the next page does not
       come straight back here, and go. */
    setActiveProject(c, hats[0].id);
    return c.redirect(hatLanding(hats[0].kind, hats[0].role));
  }
  return c.html(V.chooseHat(user, hats, site(c), chosenHat(c)));
});

app.post('/hats/choose', async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect('/');

  const to = String((await c.req.formData()).get('to') ?? '');
  /* The cookie is a preference; this is the permission. A hat that is
     not in the list — a forged id, or one that was real until a
     membership ended a moment ago — buys nothing. */
  const hat = (await hatsFor(c.env, user)).find((h) => h.id === to);
  if (!hat) return c.redirect('/hats');

  setActiveProject(c, hat.id);
  /* The redirect is computed from the hat rather than read back from
     the cookie, because the cookie we just set is on the *response* —
     this request still sees the old one. */
  return c.redirect(hatLanding(hat.kind, hat.role));
});

/* ------------------------------------------------------------------ *
 * Whose turn is it?
 *
 * One sign-in, several people: a parent who learns, and their children
 * who learn too, all on the parent's Gmail. Each is a profile — their own
 * songs, recordings, lessons and teacher's notes — and this is where the
 * person at the keyboard says which of them they are.
 *
 * Like the hat chooser, outside requireUser: being signed in is all
 * these need to know. The list is always rebuilt from the database and
 * the address the sign-in was made with, so a profile id typed into the
 * form buys nothing unless it really is on that address.
 * ------------------------------------------------------------------ */

async function profileCards(env: Env, profiles: User[]): Promise<V.ProfileCard[]> {
  if (!profiles.length) return [];
  /* unscoped: which practices each of this sign-in's own profiles is in, to label them on the chooser — every row read belongs to one of them */
  const r = await env.DB.prepare(
    `SELECT m.user_id, m.role, m.status, p.name AS project_name
       FROM project_members m JOIN projects p ON p.id = m.project_id
      WHERE m.user_id IN (${profiles.map((_, i) => `?${i + 1}`).join(',')})
        AND p.status = 'active' AND m.status <> 'disabled'
      ORDER BY p.name COLLATE NOCASE`,
  )
    .bind(...profiles.map((u) => u.id))
    .all<{ user_id: string; role: string; status: string; project_name: string }>();
  const rows = r.results ?? [];
  return profiles.map((u) => ({
    user: u,
    places: rows.filter((x) => x.user_id === u.id),
  }));
}

app.get('/profiles', async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect('/');
  const em = await signInEmail(c, user);
  const profiles = await profilesFor(c.env, em, user.id);
  return c.html(
    V.chooseProfile(user, em, await profileCards(c.env, profiles), site(c), c.req.query('msg'),
      profiles.length < MAX_PROFILES_PER_EMAIL && em !== ''),
  );
});

app.post('/profiles/switch', async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect('/');
  const to = String((await c.req.formData()).get('to') ?? '');
  const em = await signInEmail(c, user);
  /* The permission: the profile must be on the address this browser signed
     in with. Anything else — someone else's profile id, a stale one — is
     refused without saying why. */
  const target = (await profilesFor(c.env, em, user.id)).find((u) => u.id === to);
  if (!target) return c.redirect('/profiles');

  await startSession(c, target.id, em);
  /* Which practice to open is a question for the new profile, not an
     answer carried over from the last one. */
  clearActiveProject(c);
  return c.redirect('/');
});

app.post('/profiles/add', async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect('/');
  const f = await c.req.formData();
  const name = String(f.get('name') ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const em = await signInEmail(c, user);
  if (!name) return c.redirect('/profiles?msg=' + encodeURIComponent('A name is needed.'));
  if (!em) return c.redirect('/profiles?msg=' + encodeURIComponent('This sign-in cannot hold more than one person.'));

  const profiles = await profilesFor(c.env, em, user.id);
  if (profiles.length >= MAX_PROFILES_PER_EMAIL)
    return c.redirect('/profiles?msg=' + encodeURIComponent(`One sign-in can hold up to ${MAX_PROFILES_PER_EMAIL} people.`));
  if (profiles.some((u) => u.name.trim().toLowerCase() === name.toLowerCase()))
    return c.redirect('/profiles?msg=' + encodeURIComponent(`There is already a ${name} on this sign-in.`));
  /* Each new profile also asks a teacher to let them in, so this is capped
     per day as well as in total — the Approvals page is not a place to spam. */
  if (!(await spend(c.env, user.id, 'profile_add', PROFILE_ADDS_PER_DAY)))
    return c.redirect('/profiles?msg=' + encodeURIComponent('That is enough new profiles for one day. Try again tomorrow.'));

  const id = newId('u');
  /* A household shares a clock, a place and usually a phone, so those
     start as the profile they were added from; each can change them. No
     google_sub: the sign-in belongs to the address, not to any one of the
     people on it. */
  await c.env.DB.prepare(
    /* unscoped: creating a person — identity is global and has no project_id; the memberships below are what put them anywhere */
    `INSERT INTO users (id, google_sub, email, name, created_at, time_zone, location, phone, lang)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, em, name, now(), user.time_zone ?? null, user.location ?? null, user.phone ?? null, user.lang ?? null)
    .run();

  /* They ask to join wherever the person adding them is — as a student,
     and waiting, because it is still the teacher's practice to let people
     into. Nobody gets into a class by being somebody's sibling. */
  const places = await c.env.DB.prepare(
    /* unscoped: the practices of the signed-in profile itself, to ask to join the same ones */
    `SELECT m.project_id FROM project_members m JOIN projects p ON p.id = m.project_id
      WHERE m.user_id = ? AND m.status IN ('active','paused','pending') AND p.status = 'active'`,
  )
    .bind(user.id)
    .all<{ project_id: string }>();
  for (const pl of places.results ?? [])
    await addMember(c.env, { projectId: pl.project_id, userId: id, role: 'student', status: 'pending' });

  return c.redirect(
    '/profiles?msg=' +
      encodeURIComponent(
        (places.results ?? []).length
          ? `${name} is added. Your teacher needs to let ${name} in before their lessons appear.`
          : `${name} is added. A teacher needs to add ${name} to their practice before anything appears.`,
      ),
  );
});

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
  /* Waiting for what? A first approval, or a teacher who has paused or
     closed their lessons — the page says which, and never redirects. */
  const acting = await resolveProject(c, user);
  const m = acting?.membership;
  return c.html(
    V.waiting(user, site(c), {
      status: m && m.status !== 'active' ? m.status : null,
      practice: m ? acting!.project.name : null,
      canSwitch: (await hatsFor(c.env, user)).length > 1,
    }),
  );
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
    const em = profile.email_verified === false ? '' : profile.email.toLowerCase();
    await startSession(c, user.id, em);
    /* Several people on this address — a parent and their children — and
       the sign-in cannot tell which of them is at the keyboard. Ask. */
    if ((await profilesFor(c.env, em, user.id)).length > 1) {
      clearActiveProject(c);
      return c.redirect('/profiles');
    }
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

  /* Admin if asked for, or if this is the address wrangler.toml names.
     Without this there is no way to reach /admin on a local database:
     is_admin is otherwise set only during a real Google sign-in, and the
     admin screens are the first thing anyone wants to try locally. */
  const wantsAdmin =
    c.req.query('admin') === '1' ||
    email === (c.env.BOOTSTRAP_ADMIN_EMAIL ?? '').toLowerCase().trim();

  /* unscoped: local-only sign-in, which is identity and happens before any project is resolved — the same job auth.ts does in production.
     With several profiles on one address, start on the one that holds the sign-in, as a real Google sign-in would. */
  let u = await c.env.DB.prepare(
    'SELECT * FROM users WHERE lower(email) = ? ORDER BY google_sub IS NULL, created_at LIMIT 1',
  ).bind(email).first<User>();
  if (!u) {
    const id = newId('u');
    await c.env.DB.prepare(
      /* unscoped: creating the local-only dev account — identity is global, and it joins a project the same way anyone else does */
      `INSERT INTO users (id, google_sub, email, name, created_at, is_admin)
       VALUES (?,?,?,?,?,?)`,
    )
      .bind(id, `dev-${id}`, email, c.req.query('name') ?? email.split('@')[0], now(), wantsAdmin ? 1 : 0)
      .run();
    /* unscoped: reading back the local-only dev account just created, to start its session */
    u = (await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>())!;
  } else if (wantsAdmin && !u.is_admin) {
    /* unscoped: promoting the local-only dev account that already existed */
    await c.env.DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(u.id).run();
    u = { ...u, is_admin: 1 };
  }

  /* ?project=<id> joins them to a practice and switches into it, so one
     URL produces a usable teacher or student. Without it a fresh account
     belongs to nothing and lands on /waiting — correct, and useless for
     testing. */
  const projectId = c.req.query('project');
  if (projectId) {
    const p = await getProject(c.env, projectId);
    if (p) {
      await addMember(c.env, { projectId: p.id, userId: u.id, role, status: 'active' });
      setActiveProject(c, p.id);
    }
  }

  await startSession(c, u.id, email);
  if (!projectId && (await profilesFor(c.env, email, u.id)).length > 1) return c.redirect('/profiles');
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
        m.status_changed_at AS status_changed_at, m.approved_at AS approved_at,
        m.can_curate AS can_curate`;

/**
 * Is this song in the project we are acting in?
 *
 * Every route that takes a section_id off a form has to ask. The id is
 * a guess away, and without this a teacher could file a recording, a
 * note or an assignment in their own project against another practice's
 * song — invisible to both sides, counted against the wrong storage
 * total, and leaving R2 objects that the owning project's delete would
 * never collect.
 */
async function sectionInProject(env: Env, projectId: string, sectionId: string): Promise<boolean> {
  const r = await env.DB.prepare('SELECT 1 AS ok FROM sections WHERE id = ?1 AND project_id = ?2')
    .bind(sectionId, projectId)
    .first<{ ok: number }>();
  return r?.ok === 1;
}

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
/* Every change an admin makes inside somebody else's practice — including
   the few teacher actions that live outside /t/: deleting a note, and
   uploading a recording through the JSON endpoint. */
async function auditAdmin(c: Context<AppEnv, any, any>, next: () => Promise<void>) {
  await next();
  if (c.req.method !== 'POST') return;
  const a = c.get('acting');
  if (!a?.asAdmin) return;
  const status = c.res.status;
  if (status >= 400) return;
  await logAdmin(c, a, `${c.req.method} ${new URL(c.req.url).pathname}`, describeChange(c));
}
app.use('/t/*', auditAdmin);
app.use('/notes/*', auditAdmin);
app.use('/api/recordings', auditAdmin);
app.use('/api/recordings/*', auditAdmin);
app.use('/recordings/*', auditAdmin);

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
    [/^\/t\/notes\/[^/]+\/delete$|^\/notes\/[^/]+\/delete$/, 'Deleted a note'],
    [/^\/api\/recordings$/, 'Added a recording'],
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
  const aside = c.req.query('aside') === '1';
  return c.html(
    Adm.adminHome(
      c.get('user'),
      r.results ?? [],
      await strandedUsers(c.env, aside),
      await awaitingTeacher(c.env),
      site(c),
      c.req.query('msg'),
      aside,
    ),
  );
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

  /* The admin joins as a teacher, always.
     An admin can already reach any practice by switching into it, but
     that is the visiting path: no membership, every change written to
     the audit log, and a red banner across the top saying so. That is
     right for looking at somebody else's practice and wrong for one
     you set up yourself. Being a member makes it yours \u2014 it appears in
     the hat chooser, it opens without a banner, and nothing about it is
     recorded as an intrusion.
     Matched by the rule in backfill.sql, which does the same for every
     practice that already exists. */
  await addMember(c.env, {
    projectId: id,
    userId: c.get('user').id,
    role: 'teacher',
    approvedBy: c.get('user').id,
  });

  return c.redirect(`/admin/p/${id}?msg=` + encodeURIComponent('Created. You are its teacher; add anyone else who teaches it.'));
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

  /* The address may already be on the site — for this person, or, since a
     family can share one Gmail, for several people. With one of them it is
     them; with several, ask which. */
  const who = await personForAdd(c.env, email, '', String(f.get('profile') ?? ''));
  if (who.kind === 'ask')
    return c.html(
      V.whoDoYouMean(c.get('user'), {
        action: `/admin/p/${id}/members`,
        fields: formFields(f, ['email', 'role']),
        name: '', email, existing: who.existing, back: `/admin/p/${id}`,
      }, site(c), null),
    );
  let u: { id: string; name: string } | null = who.kind === 'use' ? { id: who.id, name: who.name } : null;

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
 * People who signed in and landed nowhere
 *
 * Someone who signs in with Google and was never invited gets a `users`
 * row and no membership at all. The teacher's approvals page joins
 * project_members, so an account with no membership cannot appear on
 * it — for any teacher, ever. They sat on the waiting page and nobody
 * was told.
 *
 * Until each practice has its own address and a sign-in can say which
 * one it meant, the admin is the only person who can answer "whose
 * student is this?", so the decision lives here.
 * ------------------------------------------------------------------ */

async function strandedUsers(env: Env, includeTurnedAway = false): Promise<Adm.Stranded[]> {
  /* unscoped: the whole point of this query is people who belong to NO
     project — a membership join would return exactly nobody. Admin only,
     and the only query in the app that deliberately looks outside every
     practice at once. */
  const r = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.avatar_url, u.created_at, u.turned_away_at
       FROM users u
      WHERE u.is_admin = 0
        AND u.google_sub IS NOT NULL
        AND (?1 = 1 OR u.turned_away_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = u.id)
      ORDER BY u.created_at`,
  )
    .bind(includeTurnedAway ? 1 : 0)
    .all<Adm.Stranded>();
  return r.results ?? [];
}

/** Sent to a practice, still waiting for its teacher to answer. */
async function awaitingTeacher(env: Env): Promise<Adm.AwaitingRow[]> {
  const r = await env.DB.prepare(
    `SELECT u.id AS user_id, u.name, u.email, u.avatar_url,
            p.id AS project_id, p.name AS project_name,
            m.joined_at, m.role
       FROM project_members m
       JOIN users u ON u.id = m.user_id
       JOIN projects p ON p.id = m.project_id
      WHERE m.status = 'pending'
      ORDER BY m.joined_at`,
  ).all<Adm.AwaitingRow>();
  return r.results ?? [];
}

app.post('/admin/place', requireAdmin, async (c) => {
  const f = await c.req.formData();
  const userId = String(f.get('user_id') ?? '');
  const projectId = String(f.get('project_id') ?? '');
  const role = String(f.get('role')) === 'teacher' ? 'teacher' : 'student';

  const project = await getProject(c.env, projectId);
  if (!project || project.status !== 'active')
    return c.redirect('/admin?msg=' + encodeURIComponent('That practice is not open.'));

  /* Only somebody who is actually stranded. An id typed into the form
     for a person who already belongs somewhere would otherwise move
     them, from a page that is not about moving anyone. */
  const waiting = await strandedUsers(c.env, true);
  const person = waiting.find((w) => w.id === userId);
  if (!person)
    return c.redirect('/admin?msg=' + encodeURIComponent('That person is already in a practice.'));

  /* Pending, not active — the admin routes, the teacher decides.
     The admin can say which practice a stranger probably belongs to;
     only the teacher knows whether they are actually their student. So
     this puts them in the practice's approvals queue, which is a screen
     that already exists and that the teacher already watches.

     A teacher is the exception and has to go straight in: pending means
     "somebody here will approve you", and in a practice with no teacher
     yet there is nobody to do it. */
  const status = role === 'teacher' ? 'active' : 'pending';
  await addMember(c.env, {
    projectId,
    userId,
    role,
    status,
    /* Deliberately not approvedBy: the admin did not approve them, they
       decided where the question should be asked. */
  });
  /* Placed, so no longer turned away — the two states contradict.
     unscoped: clearing a flag on the person just placed, by their own
     id; the membership that scopes them was written a line above. */
  await c.env.DB.prepare('UPDATE users SET turned_away_at = NULL WHERE id = ?')
    .bind(userId)
    .run();

  return c.redirect(
    '/admin?msg=' +
      encodeURIComponent(
        status === 'pending'
          ? `${person.name} has been sent to ${project.name}. Its teacher will see them under Approvals and can let them in or turn them down.`
          : `${person.name} is now a teacher of ${project.name}.`,
      ),
  );
});

/**
 * Sent to the wrong practice: take the question to a different teacher.
 *
 * Only for somebody still waiting to be answered. Once a teacher has
 * said yes they are that practice's student, and moving them is not an
 * admin's decision to make from a list.
 */
app.post('/admin/move', requireAdmin, async (c) => {
  const f = await c.req.formData();
  const userId = String(f.get('user_id') ?? '');
  const projectId = String(f.get('project_id') ?? '');

  const project = await getProject(c.env, projectId);
  if (!project || project.status !== 'active')
    return c.redirect('/admin?msg=' + encodeURIComponent('That practice is not open.'));

  const pending = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM project_members
      WHERE user_id = ?1 AND status = 'pending'`,
  )
    .bind(userId)
    .first<{ n: number }>();
  if (!pending?.n)
    return c.redirect('/admin?msg=' + encodeURIComponent('They are not waiting to be answered.'));

  /* The old question goes away with the move — two practices both being
     asked about the same person is how somebody gets approved twice. */
  await c.env.DB.prepare(
    "DELETE FROM project_members WHERE user_id = ?1 AND status = 'pending'",
  )
    .bind(userId)
    .run();
  await addMember(c.env, { projectId, userId, role: 'student', status: 'pending' });

  return c.redirect(
    '/admin?msg=' + encodeURIComponent(`Moved. ${project.name}'s teacher will see them now.`),
  );
});

app.post('/admin/turn-away', requireAdmin, async (c) => {
  const f = await c.req.formData();
  await c.env.DB.prepare(
    /* unscoped: a person who belongs to no project — see strandedUsers */
    'UPDATE users SET turned_away_at = ? WHERE id = ? AND is_admin = 0',
  )
    .bind(now(), String(f.get('user_id') ?? ''))
    .run();
  return c.redirect(
    '/admin?msg=' +
      encodeURIComponent('Set aside. Their account still exists and you can let them in later.'),
  );
});

app.post('/admin/allow-again', requireAdmin, async (c) => {
  const f = await c.req.formData();
  await c.env.DB.prepare(
    /* unscoped: a person who belongs to no project — see strandedUsers */
    'UPDATE users SET turned_away_at = NULL WHERE id = ?',
  )
    .bind(String(f.get('user_id') ?? ''))
    .run();
  return c.redirect('/admin?msg=' + encodeURIComponent('Back on the list.'));
});

/* ------------------------------------------------------------------ *
 * Backing up into Google Drive
 *
 * Admin only, and that is not a convenience: a D1 export is the whole
 * database, every practice in it. See src/backup.ts.
 * ------------------------------------------------------------------ */

const driveRedirect = (c: Context<AppEnv, any, any>) =>
  new URL('/admin/drive/callback', c.req.url).toString();

/** The last things that went wrong, newest first — see app.onError. */
app.get('/admin/errors', requireAdmin, async (c) => {
  let rows: Adm.ErrorRow[] = [];
  try {
    const r = await c.env.DB.prepare(
      /* unscoped: the app's own error record, for the admin */
      `SELECT e.id, e.at, e.method, e.path, e.message, e.stack, u.name AS user_name, u.email AS user_email
         FROM error_log e LEFT JOIN users u ON u.id = e.user_id
        ORDER BY e.at DESC LIMIT 50`,
    ).all<Adm.ErrorRow>();
    rows = r.results ?? [];
  } catch {
    /* No table yet: nothing has gone wrong since this version went live. */
  }
  return c.html(Adm.adminErrors(c.get('user'), rows, site(c)));
});

app.get('/admin/backup', requireAdmin, async (c) => {
  return c.html(
    Adm.adminBackup(
      c.get('user'),
      await getLink(c.env),
      await recentRuns(c.env),
      {
        accountId: Boolean(c.env.CF_ACCOUNT_ID),
        databaseId: Boolean(c.env.D1_DATABASE_ID),
        apiToken: Boolean(c.env.CF_API_TOKEN),
      },
      site(c),
      c.req.query('msg'),
      c.req.query('err'),
    ),
  );
});

app.post('/admin/drive/connect', requireAdmin, (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET)
    return c.redirect(
      '/admin/backup?err=' + encodeURIComponent('Google sign-in is not configured on this deployment.'),
    );
  const state = newId();
  setOAuthState(c, state);
  return c.redirect(driveConsentUrl(c.env, driveRedirect(c), state));
});

app.get('/admin/drive/callback', requireAdmin, async (c) => {
  const { code, state, error } = c.req.query();
  const expected = takeOAuthState(c);
  if (error)
    return c.redirect('/admin/backup?err=' + encodeURIComponent('Google access was declined.'));
  if (!code || !state || state !== expected)
    return c.redirect('/admin/backup?err=' + encodeURIComponent('That link expired. Try again.'));

  try {
    await saveLink(c.env, code, driveRedirect(c), c.get('user').id);
  } catch (e) {
    const known = e instanceof BackupError;
    if (!known) console.error('drive connect', e);
    return c.redirect(
      '/admin/backup?err=' +
        encodeURIComponent(known ? (e as Error).message : 'Could not connect that Drive.'),
    );
  }
  return c.redirect('/admin/backup?msg=' + encodeURIComponent('Google Drive is connected.'));
});

app.post('/admin/drive/disconnect', requireAdmin, async (c) => {
  await forgetLink(c.env);
  /* The token is gone from here, but Google still lists this app until
     the person revokes it, and the backups already in the Drive are
     theirs and are left alone. Say so rather than implying otherwise. */
  return c.redirect(
    '/admin/backup?msg=' +
      encodeURIComponent(
        'Disconnected. Backups already in the Drive are untouched; remove this app at ' +
          'myaccount.google.com/permissions to revoke it there too.',
      ),
  );
});

app.post('/admin/backup/run', requireAdmin, async (c) => {
  const run = await runBackup(c.env, c.get('user').id, site(c));
  return c.redirect(
    run.status === 'done'
      ? '/admin/backup?msg=' + encodeURIComponent(`Saved to Drive as ${run.file_name}.`)
      : '/admin/backup?err=' + encodeURIComponent(run.detail ?? 'The backup failed.'),
  );
});

app.post('/admin/backup/check', requireAdmin, async (c) => {
  const notes = await checkBackup(c.env);
  return c.redirect('/admin/backup?msg=' + encodeURIComponent(notes.join('  ·  ')));
});

/* ------------------------------------------------------------------ *
 * In, and out again
 * ------------------------------------------------------------------ */

app.post('/admin/switch/:id', requireAdmin, async (c) => {
  const p = await getProject(c.env, c.req.param('id'));
  if (!p || p.status !== 'active')
    return c.redirect('/admin?msg=' + encodeURIComponent('That practice is not open.'));
  /* In AS THE ADMIN, not as whatever this account happens to be here.
     The button sits on the admin console and says "go in and teach";
     an admin who had enrolled themselves as a student somewhere would
     otherwise press it and land on their own student page, with no way
     back to the teacher side of that practice. */
  setActiveProject(c, ADMIN_IN + p.id);
  /* Where the button that sent us here said it was going. Only ever a
     path inside this site: a full URL from a form field would be an
     open redirect, and this one is reachable by anyone who can reach
     the admin pages. */
  const to = String((await c.req.formData().catch(() => new FormData())).get('to') ?? '');
  return c.redirect(safeBack(to, '/t/schedule/week'));
});

app.post('/admin/leave', requireAdmin, (c) => {
  /* The admin hat, not no hat. Clearing the cookie outright would leave
     an admin who also teaches to be picked up by the single-membership
     fallback and dropped straight back into their own practice — which
     looks, from the outside, like the Leave button not working. */
  setActiveProject(c, ADMIN_HAT);
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

/* ---------------- one email, possibly several people ---------------- */

/**
 * Who a "name + email" typed into an add form refers to.
 *
 * An address used to be taken as a person: add someone whose address was
 * already on the site and you got whoever held it. But a parent learns
 * alongside their children on one Gmail, so the address alone cannot say
 * which of them is meant. The rule now:
 *
 *   - nobody on the address                → a new person;
 *   - the form already answered ('new' or one of the ids) → that;
 *   - exactly one person on it with the same name → them, obviously;
 *   - one person on it and no name to compare (the admin's form) → them;
 *   - anything else                        → ask, don't guess.
 *
 * The ids a form can answer with are re-checked against the address, so
 * posting some other person's id picks nobody.
 */
type PersonPick =
  | { kind: 'new' }
  | { kind: 'use'; id: string; name: string }
  | { kind: 'ask'; existing: { id: string; name: string; avatar_url: string | null }[] };

async function personForAdd(env: Env, email: string, name: string, answer: string): Promise<PersonPick> {
  /* unscoped: finding the people behind an email address, before any membership exists — addMember is what puts one of them in this project */
  const r = await env.DB.prepare(
    'SELECT id, name, avatar_url FROM users WHERE lower(email) = ? ORDER BY created_at',
  )
    .bind(email)
    .all<{ id: string; name: string; avatar_url: string | null }>();
  const existing = r.results ?? [];
  if (!existing.length) return { kind: 'new' };
  if (answer === 'new' && name) return { kind: 'new' };
  const picked = existing.find((u) => u.id === answer);
  if (picked) return { kind: 'use', id: picked.id, name: picked.name };
  const same = name
    ? existing.filter((u) => u.name.trim().toLowerCase() === name.trim().toLowerCase())
    : [];
  if (same.length === 1) return { kind: 'use', id: same[0].id, name: same[0].name };
  if (!name && existing.length === 1) return { kind: 'use', id: existing[0].id, name: existing[0].name };
  return { kind: 'ask', existing };
}

/** The fields of an add form, carried through the "who do you mean?" page unchanged. */
function formFields(f: FormData, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) out[k] = String(f.get(k) ?? '');
  return out;
}

/**
 * Who a teacher may edit the global details of — name, phone, place, clock.
 * Those follow a person into every practice, so a teacher may only change
 * them for someone who is a STUDENT here and belongs to no other practice
 * (and is not an admin). Anyone else — a co-teacher, the admin, a student
 * who also learns elsewhere — changes their own, from their own Settings.
 * The rule is spelled out in each UPDATE (see /t/students/:id/details and
 * /t/students/:id/zone) so the scoping check can read it.
 */
const NOT_ONLY_YOURS =
  'Not changed — they also belong to another practice (or teach), so only they can change their own details, from their Settings.';

const STUDENT_STATUSES = ['active', 'paused', 'graduated', 'ended'] as const;

app.post('/t/students', requireTeacher, async (c) => {
  const f = await c.req.formData();
  const name = String(f.get('name') ?? '').trim();
  const email = String(f.get('email') ?? '').trim().toLowerCase();
  if (!name || !email) return c.redirect('/t?msg=' + encodeURIComponent('A name and email are both needed.'));

  /* An address may already be on the site — for this person, learning with
     another teacher, or for somebody else in their family. See personForAdd. */
  const who = await personForAdd(c.env, email, name, String(f.get('profile') ?? ''));
  if (who.kind === 'ask')
    return c.html(
      V.whoDoYouMean(c.get('user'), {
        action: '/t/students',
        fields: formFields(f, ['name', 'email', 'location', 'phone', 'time_zone']),
        name, email, existing: who.existing, back: '/t',
      }, site(c), visiting(c)),
    );
  if (who.kind === 'use') {
    await addMember(c.env, {
      projectId: pid(c),
      userId: who.id,
      role: 'student',
      status: 'active',
      approvedBy: c.get('user').id,
    });
    return c.redirect('/t?msg=' + encodeURIComponent(`${who.name} is on the site already — now active here.`));
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

/** Make a student a catalogue helper here, or stop. */
app.post('/t/students/:id/curator', requireTeacher, async (c) => {
  const on = String((await c.req.formData()).get('on') ?? '') === '1' ? 1 : 0;
  const r = await c.env.DB.prepare(
    `UPDATE project_members SET can_curate = ?1
      WHERE user_id = ?2 AND project_id = ?3 AND role = 'student'`,
  )
    .bind(on, c.req.param('id'), pid(c))
    .run();
  return c.redirect(
    withMsg(`/t/s/${c.req.param('id')}/settings`,
      !r.meta?.changes ? 'Not changed.'
        : on ? 'Now a Song Catalog helper: they can see every song, and add and edit songs and groups. Deletions come to you on Approvals.'
          : 'No longer a Song Catalog helper.'),
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
  const back = safeBack(f.get('back'), `/t/s/${c.req.param('id')}`);
  const label =
    status === 'active' ? 'active again' : status === 'paused' ? 'paused' : status;
  return c.redirect(withMsg(back, `Marked ${label}.`));
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
  const r = await c.env.DB.prepare(
    `UPDATE users SET name = ?1, location = ?2, phone = ?3, time_zone = ?4
      WHERE id = ?5 AND users.is_admin = 0
        AND EXISTS (SELECT 1 FROM project_members m
                     WHERE m.user_id = users.id AND m.project_id = ?6 AND m.role = 'student')
        AND NOT EXISTS (SELECT 1 FROM project_members o
                         WHERE o.user_id = users.id AND o.project_id <> ?6 AND o.status <> 'disabled')`,
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
  if (!r.meta?.changes)
    return c.redirect(`/t/s/${c.req.param('id')}?msg=` + encodeURIComponent(NOT_ONLY_YOURS));
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
    V.teacherApprovals(c.get('user'), pending.results ?? [], site(c), c.req.query('msg'), visiting(c),
      await pendingDeletions(c.env, pid(c))),
  );
});

/**
 * Deletions a catalogue helper has asked for and nobody has decided yet —
 * only for songs and groups that still exist. With how much would go.
 */
async function pendingDeletions(env: Env, projectId: string): Promise<V.DeletionRequestRow[]> {
  const r = await env.DB.prepare(
    `SELECT d.id, d.kind, d.target_id, d.target_title, d.reason, d.requested_at, u.name AS requested_by_name,
            CASE d.kind
              WHEN 'section' THEN (SELECT COUNT(*) FROM recordings r WHERE r.section_id = d.target_id AND r.project_id = ?1)
              ELSE (SELECT COUNT(*) FROM sections s WHERE s.group_id = d.target_id AND s.project_id = ?1) END AS weight,
            CASE d.kind
              WHEN 'section' THEN (SELECT COUNT(*) FROM assignments a WHERE a.section_id = d.target_id AND a.project_id = ?1 AND a.archived_at IS NULL)
              ELSE 0 END AS learners
       FROM deletion_requests d JOIN users u ON u.id = d.requested_by
      WHERE d.project_id = ?1 AND d.status = 'pending'
        AND ((d.kind = 'section' AND EXISTS (SELECT 1 FROM sections s WHERE s.id = d.target_id AND s.project_id = ?1))
          OR (d.kind = 'group' AND EXISTS (SELECT 1 FROM groups g WHERE g.id = d.target_id AND g.project_id = ?1)))
      ORDER BY d.requested_at`,
  )
    .bind(projectId)
    .all<V.DeletionRequestRow>();
  return r.results ?? [];
}

/** The teacher's answer to a deletion request. */
app.post('/t/deletions/:id', requireTeacher, async (c) => {
  const approve = String((await c.req.formData()).get('action')) === 'approve';
  const req = await c.env.DB.prepare(
    `SELECT * FROM deletion_requests WHERE id = ? AND project_id = ? AND status = 'pending'`,
  )
    .bind(c.req.param('id'), pid(c))
    .first<{ id: string; kind: string; target_id: string; target_title: string }>();
  if (!req) return c.redirect(withMsg('/t/approvals', 'That request has already been answered.'));

  if (approve) {
    if (req.kind === 'section') await deleteSection(c.env, pid(c), req.target_id);
    else {
      await c.env.DB.prepare('DELETE FROM groups WHERE id = ? AND project_id = ?').bind(req.target_id, pid(c)).run();
      await settleRequestsFor(c.env, pid(c), 'group', req.target_id);
    }
  }
  await c.env.DB.prepare(
    `UPDATE deletion_requests SET status = ?1, decided_by = ?2, decided_at = ?3 WHERE id = ?4 AND project_id = ?5`,
  )
    .bind(approve ? 'approved' : 'declined', c.get('user').id, now(), req.id, pid(c))
    .run();
  return c.redirect(
    withMsg('/t/approvals',
      approve
        ? req.kind === 'section' ? `"${req.target_title}" deleted, with its recordings and notes.` : `Group "${req.target_title}" deleted. Its songs are now ungrouped.`
        : `Kept "${req.target_title}".`),
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

  /* Same as adding a student on /t: the address may already be on the
     site, for this person or for someone else in their family. */
  const who = await personForAdd(c.env, email, name, String(form.get('profile') ?? ''));
  if (who.kind === 'ask')
    return c.html(
      V.whoDoYouMean(c.get('user'), {
        action: '/t/invite',
        fields: formFields(form, ['name', 'email']),
        name, email, existing: who.existing, back: '/t/approvals',
      }, site(c), visiting(c)),
    );
  if (who.kind === 'use') {
    await addMember(c.env, {
      projectId: pid(c),
      userId: who.id,
      role: 'student',
      status: 'active',
      approvedBy: c.get('user').id,
    });
    return c.redirect('/t/approvals?msg=' + encodeURIComponent(`${who.name} is on the site already — now approved here.`));
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
  const base = `SELECT s.*, (SELECT COUNT(*) FROM assignments a WHERE a.section_id = s.id AND a.archived_at IS NULL AND a.project_id = ?1) AS assigned_count,
       (SELECT u.name FROM users u JOIN project_members pm ON pm.user_id = u.id AND pm.project_id = ?1 AND pm.role = 'student'
         WHERE u.id = s.created_by) AS added_by_student,
       EXISTS (SELECT 1 FROM deletion_requests d WHERE d.project_id = ?1 AND d.kind = 'section'
                 AND d.target_id = s.id AND d.status = 'pending') AS delete_asked
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
      visiting(c), (await pendingDeletions(c.env, pid(c))).length,
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
    .bind(await groupHere(c.env, pid(c), f.get('group_id')), title, str('title_ml'), str('raga'), str('taala'), str('composer'), c.req.param('id'), pid(c))
    .run();
  const back = safeBack(f.get('back'), '/t/catalogue');
  return c.redirect(withMsg(back, `"${title}" updated.`));
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
  const back = safeBack(f.get('back'), `/t/song/${rec.section_id}`);
  return c.redirect(withMsg(back, msg));
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
  const back = safeBack(f.get('back'), `/t/song/${note.section_id}`);
  return c.redirect(withMsg(back, msg));
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
  const back = safeBack(f.get('back'), `/t/song/${note.section_id}`);
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
    'INSERT INTO groups (project_id, id, name, name_ml, sort_order, created_at, created_by) VALUES (?,?,?,?,?,?,?)',
  )
    .bind(pid(c), newId('g'), name, String(f.get('name_ml') ?? '').trim() || null, (max?.m ?? 0) + 10, now(), c.get('user').id)
    .run();
  return c.redirect('/t/catalogue?msg=' + encodeURIComponent(`Group "${name}" added.`));
});

app.post('/t/groups/:id/delete', requireTeacher, async (c) => {
  await c.env.DB.prepare('DELETE FROM groups WHERE id = ? AND project_id = ?')
    .bind(c.req.param('id'), pid(c))
    .run();
  await settleRequestsFor(c.env, pid(c), 'group', c.req.param('id'));
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
    `INSERT INTO sections (project_id, id, group_id, title, title_ml, raga, taala, composer, sort_order, created_at, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(pid(c), newId('s'), await groupHere(c.env, pid(c), f.get('group_id')), title, str('title_ml'), str('raga'), str('taala'), str('composer'), (max?.m ?? 0) + 10, now(), c.get('user').id)
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
      `SELECT u.id, u.name, u.avatar_url, m.status AS status, a.completed_at, a.assigned_at AS started_at,
        /* A catalogue helper's name when they put it on the list, so the
           teacher can tell their own assignments from a helper's. */
        (SELECT hu.name FROM users hu JOIN project_members hm ON hm.user_id = hu.id AND hm.project_id = ?2
          WHERE hu.id = a.assigned_by AND hm.role = 'student') AS added_by,
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
      `SELECT u.id, u.name, u.avatar_url, m.status AS status, NULL AS completed_at,
              NULL AS started_at, NULL AS added_by, 0 AS rec_count
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
        AND EXISTS (SELECT 1 FROM sections sec WHERE sec.id = ?4 AND sec.project_id = ?1)
     ON CONFLICT(student_id, section_id) DO UPDATE SET archived_at = NULL, completed_at = NULL, assigned_by = excluded.assigned_by`,
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

/** Delete a song, its recordings' and notes' files, and (by cascade) their rows. */
async function deleteSection(env: Env, projectId: string, id: string): Promise<void> {
  const db = env.DB;
  // Remove the media from R2 first — an orphaned object costs storage forever.
  const recs = await db
    .prepare('SELECT r2_key, original_r2_key FROM recordings WHERE section_id = ? AND project_id = ?')
    .bind(id, projectId)
    .all<{ r2_key: string; original_r2_key: string | null }>();
  const imgs = await db
    .prepare('SELECT image_key FROM notes WHERE section_id = ? AND project_id = ? AND image_key IS NOT NULL')
    .bind(id, projectId)
    .all<{ image_key: string }>();
  const keys = [
    ...(recs.results ?? []).flatMap((r) => (r.original_r2_key ? [r.r2_key, r.original_r2_key] : [r.r2_key])),
    ...(imgs.results ?? []).map((i) => i.image_key),
  ];
  if (keys.length) await env.MEDIA.delete(keys);
  await db.prepare('DELETE FROM sections WHERE id = ? AND project_id = ?').bind(id, projectId).run();
  await settleRequestsFor(env, projectId, 'section', id);
}

/** A song or group that is gone has nothing left to ask about. */
async function settleRequestsFor(env: Env, projectId: string, kind: string, targetId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE deletion_requests SET status = 'approved', decided_at = ?1
      WHERE project_id = ?2 AND kind = ?3 AND target_id = ?4 AND status = 'pending'`,
  )
    .bind(now(), projectId, kind, targetId)
    .run();
}

app.post('/t/sections/:id/delete', requireTeacher, async (c) => {
  await deleteSection(c.env, pid(c), c.req.param('id'));
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
/* ------------------------------------------------------------------ *
 * Lessons, a page at a time
 *
 * A student two years in has a hundred classes, each carrying what was
 * covered, where they stopped and what to practise, in two languages.
 * Sending all of it on every visit to the tab is a bigger query, a
 * bigger response and a slower page, and nobody reads past the first
 * few. So the list is paginated in SQL, not hidden in CSS: what is not
 * on the page is not fetched, not rendered and not sent.
 *
 * The count is asked for separately because the tally has to say how
 * many lessons there are in total, not how many are on this page.
 * ------------------------------------------------------------------ */

/**
 * How many lessons on one page.
 *
 * Four, because a lesson is not a row: it carries what was covered,
 * where the class stopped and what to practise, in two scripts, and
 * four of them is already a screenful. The number is small on purpose —
 * paging is cheap and scrolling past things you are not reading is not.
 *
 * Not exported, and that is not tidiness. This module is the Worker's
 * entry point, and the runtime reads its exports as handlers: a `const`
 * among them refuses to start the whole Worker with
 *
 *   Incorrect type for map entry 'LESSONS_PER_PAGE': the provided value
 *   is not of type 'function or ExportedHandler'
 *
 * which is a dead site, not a warning. Exported functions are fine;
 * exported values are not.
 */
const LESSONS_PER_PAGE = 4;

export interface LessonPage {
  rows: SessionRow[];
  /** Every lesson, not just this page. */
  total: number;
  completed: number;
  ongoing: number;
  page: number;
  pages: number;
}

async function sessionsFor(
  env: Env,
  projectId: string,
  studentId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<SessionRow[]> {
  /* A limit of 0 would be a page with nothing on it, so it means "all"
     — which is what every caller outside the lessons tab wants. */
  const limit = opts.limit && opts.limit > 0 ? opts.limit : -1;
  const r = await env.DB.prepare(
    `SELECT s.*,
       (SELECT group_concat(sec.title, ?2) FROM session_sections ss
          JOIN sections sec ON sec.id = ss.section_id AND sec.project_id = ?3
         WHERE ss.session_id = s.id) AS section_titles,
       (SELECT group_concat(ss.section_id, ?2) FROM session_sections ss
         WHERE ss.session_id = s.id) AS section_ids
     FROM sessions s
     WHERE s.student_id = ?1 AND s.project_id = ?3
     ORDER BY s.held_on DESC, s.created_at DESC
     LIMIT ?4 OFFSET ?5`,
  )
    .bind(studentId, SEP, projectId, limit, Math.max(0, opts.offset ?? 0))
    .all<SessionRow>();
  return r.results ?? [];
}

/**
 * One page of the lesson history, plus the totals the tally needs.
 *
 * `onDate` is how the calendar reaches a class that is not on page one:
 * rather than guessing a page number, it names the day and this works
 * out which page that day falls on. A link that lands on the wrong page
 * is worse than no link.
 */
async function lessonPage(
  env: Env,
  projectId: string,
  studentId: string,
  o: { page?: number; onDate?: string | null } = {},
): Promise<LessonPage> {
  const counts =
    (await env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
         FROM sessions WHERE student_id = ?1 AND project_id = ?2`,
    )
      .bind(studentId, projectId)
      .first<{ total: number; completed: number | null }>()) ?? { total: 0, completed: 0 };

  const total = counts.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / LESSONS_PER_PAGE));

  let page = o.page && o.page > 0 ? o.page : 1;

  if (o.onDate) {
    /* How many lessons sort before this day? That is its position in the
       list, and its position divided by the page size is its page. */
    const before = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sessions
        WHERE student_id = ?1 AND project_id = ?2 AND held_on > ?3`,
    )
      .bind(studentId, projectId, o.onDate)
      .first<{ n: number }>();
    page = Math.floor((before?.n ?? 0) / LESSONS_PER_PAGE) + 1;
  }

  page = Math.min(page, pages);

  const rows = await sessionsFor(env, projectId, studentId, {
    limit: LESSONS_PER_PAGE,
    offset: (page - 1) * LESSONS_PER_PAGE,
  });

  const completed = counts.completed ?? 0;
  return { rows, total, completed, ongoing: total - completed, page, pages };
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
       a.assigned_at AS started_at,
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
        /* Three are shown and one is read for the resume card.
           Fetching a hundred to render three was the same waste as the
           lessons tab, one page over. */
        sessions: await sessionsFor(c.env, pid(c), student.id, { limit: 6 }),
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
  /* One page of lessons, chosen by ?lp — or by ?on=<date>, which is how
     the calendar reaches a class buried forty lessons back. */
  const lp = await lessonPage(c.env, pid(c), student.id, {
    page: Number(c.req.query('lp')) || 1,
    onDate: c.req.query('on') ?? null,
  });

  /* Which days in THIS month have a class in the log, and which lesson
     each one is. The calendar can then link a day whose lesson is forty
     back in the history; without it that cell would point at an anchor
     that is not on the page and do nothing. Bounded to the month on
     screen, so it stays one small query however long the history. */
  const monthEnd = addDays(month, 41);
  const loggedDays = new Map(
    (
      (
        await c.env.DB.prepare(
          `SELECT id, held_on FROM sessions
            WHERE student_id = ?1 AND project_id = ?2 AND held_on BETWEEN ?3 AND ?4`,
        )
          .bind(student.id, pid(c), month, monthEnd)
          .all<{ id: string; held_on: string }>()
      ).results ?? []
    ).map((r) => [r.held_on, r.id] as const),
  );

  const keep = (n: number) => {
    const u = new URL(c.req.url);
    u.searchParams.delete('on');
    u.searchParams.delete('msg');
    if (n <= 1) u.searchParams.delete('lp');
    else u.searchParams.set('lp', String(n));
    return u.pathname + (u.search || '');
  };

  return c.html(
    Stu.lessonsTab(
      c.get('user'),
      student,
      await tabCounts(c.env, pid(c), student.id),
      {
        sessions: lp.rows,
        totals: { total: lp.total, completed: lp.completed, ongoing: lp.ongoing },
        pager: { page: lp.page, pages: lp.pages, href: keep },
        assigned: await assignedFor(c.env, pid(c), student.id),
        month,
        monthOccs,
        prevMonth: shift(-1),
        nextMonth: shift(1),
        dictate: dictateEnabled(c.env),
        visiting: visiting(c),
        lessonOn: (date) => loggedDays.get(date) ?? null,
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

  const back = safeBack(f.get('back'), `/t/s/${studentId}/lessons`);
  return c.redirect(
    withMsg(back,
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
        AND EXISTS (SELECT 1 FROM sections sec WHERE sec.id = ?4 AND sec.project_id = ?1)
     ON CONFLICT(student_id, section_id) DO UPDATE SET archived_at = NULL,
       assigned_by = CASE WHEN assignments.archived_at IS NULL THEN assignments.assigned_by ELSE excluded.assigned_by END`,
  )
    .bind(pid(c), newId('a'), studentId, sectionId, c.get('user').id, now())
    .run();
  const back = safeBack(f.get('back'), `/t/s/${studentId}/songs`);
  return c.redirect(withMsg(back, 'Song assigned.'));
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
  const back = safeBack(f.get('back'), `/t/s/${studentId}`);
  return c.redirect(withMsg(back, done ? 'Marked as finished.' : 'Back in progress.'));
});

/**
 * Correcting when a song was started, and when it was finished.
 *
 * assigned_at is written the moment a song is put on someone's list,
 * which is the right default and often the wrong date: a teacher
 * setting up an account in September for a student who began this
 * krithi in March needs to say March. Both dates are plain dates
 * rather than instants, because "when did she start this" is a day,
 * not a moment.
 */
app.post('/t/s/:id/song-dates', requireTeacher, async (c) => {
  const studentId = c.req.param('id');
  const f = await c.req.formData();
  const sectionId = String(f.get('section_id') ?? '');
  const day = (v: unknown) => {
    const d = String(v ?? '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  };
  const started = day(f.get('started_at'));
  const finished = day(f.get('completed_at'));

  /* A start with no date is a row that has lost something true, so an
     empty box leaves the existing value alone. An empty finish box is
     different: clearing it is how you say "not finished after all". */
  await c.env.DB.prepare(
    `UPDATE assignments
        SET assigned_at = COALESCE(?1, assigned_at),
            completed_at = ?2
      WHERE student_id = ?3 AND section_id = ?4 AND project_id = ?5`,
  )
    .bind(started, finished, studentId, sectionId, pid(c))
    .run();

  const back = safeBack(f.get('back'), `/t/s/${studentId}/${sectionId}`);
  return c.redirect(withMsg(back, 'Dates saved.'));
});

app.post('/t/s/:id/unassign', requireTeacher, async (c) => {
  const studentId = c.req.param('id');
  const f = await c.req.formData();
  await c.env.DB.prepare(
    'UPDATE assignments SET archived_at = ? WHERE student_id = ? AND section_id = ? AND project_id = ?',
  )
    .bind(now(), studentId, String(f.get('section_id') ?? ''), pid(c))
    .run();
  const back = safeBack(f.get('back'), `/t/s/${studentId}/songs`);
  return c.redirect(withMsg(back, 'Removed from their list. Recordings kept.'));
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

  // Every recording on the song this student may know about, each marked
  // with whether they may actually hear it. A 'chosen' one they haven't been
  // given yet is still listed — locked — so they can see what the song holds
  // and ask for it, and so the teacher can hand one over from the same
  // screen instead of hunting for it in the catalogue. A 'self' recording —
  // another student's own practice take — isn't theirs to ask for, so it's
  // left out of the list entirely rather than shown locked.
  const recordings = await env.DB.prepare(
    `SELECT r.*,
       CASE WHEN r.visibility = 'shared'
              OR r.student_id = ?2
              OR EXISTS (SELECT 1 FROM recording_shares rs
                          WHERE rs.recording_id = r.id AND rs.student_id = ?2)
            THEN 0 ELSE 1 END AS locked
     FROM recordings r
     WHERE r.section_id = ?1 AND r.project_id = ?3
       AND (r.visibility != 'self' OR r.student_id = ?2)
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

  /* When they started it, and whether they have finished.
     assigned_at was always written and never shown, which is why the
     finish date looked like the only date this song had. */
  const progress = await env.DB.prepare(
    `SELECT a.assigned_at AS started_at, a.completed_at
       FROM assignments a
      WHERE a.student_id = ?1 AND a.section_id = ?2 AND a.project_id = ?3
        AND a.archived_at IS NULL`,
  )
    .bind(studentId, sectionId, projectId)
    .first<{ started_at: string | null; completed_at: string | null }>();

  return {
    section,
    recordings: recordings.results ?? [],
    notes: notes.results ?? [],
    progress: progress ?? null,
  };
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

/* ------------------------------------------------------------------ *
 * The student's own side
 *
 * Five tabs rather than one long page, the same shape the teacher gets
 * when looking at a student — see src/views/me.ts for why.
 *
 * Order matters below: /me/songs and its siblings are registered before
 * /me/:secid, or the song route swallows them. It cannot happen the
 * other way round by accident, because section ids are minted 's_…' and
 * no song can be called "songs" — but the order is load-bearing, so it
 * is written down rather than left to luck.
 * ------------------------------------------------------------------ */

/** Everything the tabs share: who they are, and when they are next on. */
async function meContext(c: Context<AppEnv, any, any>, days = 28) {
  const user = c.get('user');
  const from = istToday();
  const slots = await loadSlots(c.env, pid(c), user.id);
  const upcoming = slots.length
    ? expand(slots, await loadExceptions(c.env, pid(c), from, addDays(from, days - 1)), from, days)
    : [];
  return { user, upcoming };
}

/** The two numbers on the tabs. One query, not two. */
async function meCounts(env: Env, projectId: string, userId: string): Promise<Me.MeCounts> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM assignments
         WHERE project_id = ?1 AND student_id = ?2) AS songs,
       (SELECT COUNT(*) FROM sessions
         WHERE project_id = ?1 AND student_id = ?2) AS lessons,
       (SELECT can_curate FROM project_members
         WHERE project_id = ?1 AND user_id = ?2 AND role = 'student' AND status = 'active') AS curator`,
  )
    .bind(projectId, userId)
    .first<Me.MeCounts>();
  return row ?? { songs: 0, lessons: 0, curator: 0 };
}

app.get('/me', requireUser, async (c) => {
  /* Whether they teach is a fact about them IN THIS PROJECT. Reading the dead
     users.role instead sent anyone who teaches anywhere to /t, where
     requireTeacher sent them straight back here — a loop, for exactly the
     person projects exist for: a teacher over there, a student here. */
  if (acting(c).isTeacher) return c.redirect('/t');
  const { user, upcoming } = await meContext(c);
  return c.html(
    Me.homeTab(
      user,
      await meCounts(c.env, pid(c), user.id),
      {
        sessions: await sessionsFor(c.env, pid(c), user.id, { limit: 6 }),
        upcoming,
        assigned: await assignedFor(c.env, pid(c), user.id),
      },
      site(c),
      c.req.query('msg'),
    ),
  );
});

app.get('/me/songs', requireUser, async (c) => {
  if (acting(c).isTeacher) return c.redirect('/t');
  const { user, upcoming } = await meContext(c);
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const all = await assignedFor(c.env, pid(c), user.id);
  const assigned = q
    ? all.filter((a) =>
        [a.title, a.title_ml, a.raga, a.taala, a.composer, a.group_name]
          .some((v) => (v ?? '').toLowerCase().includes(q)),
      )
    : all;
  return c.html(
    Me.songsTab(
      user,
      await meCounts(c.env, pid(c), user.id),
      assigned,
      site(c),
      upcoming[0],
      c.req.query('q') ?? '',
    ),
  );
});

app.get('/me/lessons', requireUser, async (c) => {
  if (acting(c).isTeacher) return c.redirect('/t');
  const { user, upcoming } = await meContext(c);
  const lp = await lessonPage(c.env, pid(c), user.id, {
    page: Number(c.req.query('lp')) || 1,
  });
  const keep = (n: number) => (n <= 1 ? '/me/lessons' : `/me/lessons?lp=${n}`);
  return c.html(
    Me.lessonsTab(
      user,
      await meCounts(c.env, pid(c), user.id),
      lp.rows,
      await assignedFor(c.env, pid(c), user.id),
      site(c),
      upcoming[0],
      { total: lp.total, completed: lp.completed, ongoing: lp.ongoing },
      { page: lp.page, pages: lp.pages, href: keep },
    ),
  );
});

app.get('/me/schedule', requireUser, async (c) => {
  if (acting(c).isTeacher) return c.redirect('/t');
  /* Further ahead than the other tabs: this is the one place someone
     looks to answer "am I on over the holidays?". */
  const { user, upcoming } = await meContext(c, 70);
  return c.html(
    Me.scheduleTab(
      user,
      await meCounts(c.env, pid(c), user.id),
      upcoming,
      istToday().slice(0, 7) + '-01',
      site(c),
    ),
  );
});

app.get('/me/settings', requireUser, async (c) => {
  if (acting(c).isTeacher) return c.redirect('/t');
  const { user, upcoming } = await meContext(c);
  return c.html(
    Me.settingsTab(
      user,
      await meCounts(c.env, pid(c), user.id),
      site(c),
      upcoming[0],
      c.req.query('msg'),
    ),
  );
});

/* ------------------------------------------------------------------ *
 * Catalogue helpers
 *
 * A student the teacher has trusted with the song list (project_members
 * .can_curate). They see every song and group, add new ones and correct
 * their details — never recordings or notes of songs that are not theirs,
 * which stay exactly as private as before. Deleting is the one thing
 * they cannot do: they ask, and the teacher decides on the Approvals page,
 * because a song's deletion takes every recording and note filed under it.
 *
 * These routes sit before /me/:secid, which would otherwise take
 * "catalogue" for a song id.
 * ------------------------------------------------------------------ */

const requireCurator: MiddlewareHandler<AppEnv> = async (c, next) => {
  const a = acting(c);
  if (a.isTeacher) return c.redirect('/t/catalogue');
  const m = a.membership;
  if (!m || m.role !== 'student' || m.status !== 'active' || !m.can_curate) return c.redirect('/me');
  await next();
};

/** The whole catalogue, with what a helper needs beside each song. */
app.get('/me/catalogue', requireUser, requireCurator, async (c) => {
  const db = c.env.DB;
  const me = c.get('user');
  const q = (c.req.query('q') ?? '').trim();
  const groups = await db
    .prepare('SELECT * FROM groups WHERE project_id = ?1 ORDER BY sort_order, name COLLATE NOCASE')
    .bind(pid(c))
    .all<Group>();
  const base = `SELECT s.*,
       EXISTS (SELECT 1 FROM assignments a WHERE a.project_id = ?1 AND a.section_id = s.id
                 AND a.student_id = ?2 AND a.archived_at IS NULL) AS mine,
       (SELECT COUNT(*) FROM assignments a
          JOIN project_members m ON m.user_id = a.student_id AND m.project_id = ?1
                                AND m.role = 'student' AND m.status = 'active'
         WHERE a.project_id = ?1 AND a.section_id = s.id
           AND a.archived_at IS NULL AND a.completed_at IS NULL) AS learners
     FROM sections s WHERE s.project_id = ?1`;
  const order = ' ORDER BY s.sort_order, s.title COLLATE NOCASE';
  const sections = q
    ? await db
        .prepare(`${base} AND (s.title LIKE ?3 OR s.title_ml LIKE ?3 OR s.raga LIKE ?3
             OR s.taala LIKE ?3 OR s.composer LIKE ?3)${order}`)
        .bind(pid(c), me.id, `%${q}%`)
        .all<Me.CatalogueSong>()
    : await db.prepare(base + order).bind(pid(c), me.id).all<Me.CatalogueSong>();
  const pending = await db
    .prepare(
      `SELECT id, kind, target_id, requested_by FROM deletion_requests
        WHERE project_id = ?1 AND status = 'pending'`,
    )
    .bind(pid(c))
    .all<Me.PendingDeletion>();
  const { upcoming } = await meContext(c);
  return c.html(
    Me.catalogueTab(
      me, await meCounts(c.env, pid(c), me.id), site(c), upcoming[0],
      groups.results ?? [], sections.results ?? [], pending.results ?? [], q, c.req.query('msg'),
    ),
  );
});

app.post('/me/catalogue/groups', requireUser, requireCurator, async (c) => {
  const f = await c.req.formData();
  const name = String(f.get('name') ?? '').trim().slice(0, 120);
  if (!name) return c.redirect('/me/catalogue');
  const max = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM groups WHERE project_id = ?')
    .bind(pid(c))
    .first<{ m: number }>();
  await c.env.DB.prepare(
    'INSERT INTO groups (project_id, id, name, name_ml, sort_order, created_at, created_by) VALUES (?,?,?,?,?,?,?)',
  )
    .bind(pid(c), newId('g'), name, String(f.get('name_ml') ?? '').trim().slice(0, 120) || null,
      (max?.m ?? 0) + 10, now(), c.get('user').id)
    .run();
  return c.redirect(withMsg('/me/catalogue', `Group "${name}" added.`));
});

/** A group id from a form, if it really is one of this practice's groups. */
async function groupHere(env: Env, projectId: string, raw: unknown): Promise<string | null> {
  const id = String(raw ?? '').trim();
  if (!id) return null;
  const g = await env.DB.prepare('SELECT id FROM groups WHERE id = ? AND project_id = ?').bind(id, projectId).first();
  return g ? id : null;
}

app.post('/me/catalogue/sections', requireUser, requireCurator, async (c) => {
  const f = await c.req.formData();
  const title = String(f.get('title') ?? '').trim().slice(0, 200);
  if (!title) return c.redirect('/me/catalogue');
  const str = (k: string) => String(f.get(k) ?? '').trim().slice(0, 200) || null;
  const max = await c.env.DB.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM sections WHERE project_id = ?')
    .bind(pid(c))
    .first<{ m: number }>();
  await c.env.DB.prepare(
    `INSERT INTO sections (project_id, id, group_id, title, title_ml, raga, taala, composer, sort_order, created_at, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(pid(c), newId('s'), await groupHere(c.env, pid(c), f.get('group_id')), title, str('title_ml'),
      str('raga'), str('taala'), str('composer'), (max?.m ?? 0) + 10, now(), c.get('user').id)
    .run();
  return c.redirect(withMsg('/me/catalogue', `"${title}" added to the catalogue.`));
});

/** Correct a song's details. Same fields as the teacher's form; no deleting. */
app.post('/me/catalogue/sections/:id', requireUser, requireCurator, async (c) => {
  const f = await c.req.formData();
  const title = String(f.get('title') ?? '').trim().slice(0, 200);
  if (!title) return c.redirect('/me/catalogue');
  const str = (k: string) => String(f.get(k) ?? '').trim().slice(0, 200) || null;
  const r = await c.env.DB.prepare(
    `UPDATE sections SET group_id=?, title=?, title_ml=?, raga=?, taala=?, composer=? WHERE id=? AND project_id=?`,
  )
    .bind(await groupHere(c.env, pid(c), f.get('group_id')), title, str('title_ml'), str('raga'), str('taala'),
      str('composer'), c.req.param('id'), pid(c))
    .run();
  return c.redirect(withMsg('/me/catalogue', r.meta?.changes ? `"${title}" updated.` : 'That song is not in this catalogue.'));
});

/** Ask the teacher to delete a song or a group. Nothing is deleted here. */
app.post('/me/catalogue/delete-request', requireUser, requireCurator, async (c) => {
  const f = await c.req.formData();
  const kind = String(f.get('kind')) === 'group' ? 'group' : 'section';
  const targetId = String(f.get('target_id') ?? '');
  const target = await c.env.DB.prepare(
    kind === 'group'
      ? 'SELECT name AS title FROM groups WHERE id = ? AND project_id = ?'
      : 'SELECT title FROM sections WHERE id = ? AND project_id = ?',
  )
    .bind(targetId, pid(c))
    .first<{ title: string }>();
  if (!target) return c.redirect(withMsg('/me/catalogue', 'That is not in this catalogue.'));
  const already = await c.env.DB.prepare(
    `SELECT 1 FROM deletion_requests WHERE project_id = ? AND kind = ? AND target_id = ? AND status = 'pending'`,
  )
    .bind(pid(c), kind, targetId)
    .first();
  if (already) return c.redirect(withMsg('/me/catalogue', `Deleting "${target.title}" is already waiting for your teacher.`));
  await c.env.DB.prepare(
    `INSERT INTO deletion_requests (id, project_id, kind, target_id, target_title, reason, requested_by, requested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(newId('dr'), pid(c), kind, targetId, target.title,
      String(f.get('reason') ?? '').trim().slice(0, 300) || null, c.get('user').id, now())
    .run();
  return c.redirect(withMsg('/me/catalogue', `Asked your teacher to delete "${target.title}". It stays until they approve.`));
});

/* Who is learning a song — the only place a helper sees other students.
 *
 * A helper can put a song on their own list or another student's, and
 * take it off again while it is still being learned. What they see of
 * the others is a name and nothing more: no recordings, no notes, no
 * progress beyond "learning" or "finished". Finished songs stay put —
 * that is the teacher's record of someone's progress, not the helper's
 * to tidy away. Only active students of this practice are named, and
 * only they can be given a song. */

type HelperStudent = Me.HelperStudent;

async function helperSong(env: Env, projectId: string, id: string) {
  return env.DB.prepare(
    `SELECT s.*, g.name AS group_name FROM sections s LEFT JOIN groups g ON g.id = s.group_id AND g.project_id = s.project_id
      WHERE s.id = ? AND s.project_id = ?`,
  )
    .bind(id, projectId)
    .first<Section & { group_name: string | null }>();
}

/** An id off a form, if it is an active student of this practice. */
async function activeStudentHere(env: Env, projectId: string, raw: unknown): Promise<{ id: string; name: string } | null> {
  const id = String(raw ?? '');
  if (!id) return null;
  return env.DB.prepare(
    `SELECT u.id, u.name FROM users u
       JOIN project_members m ON m.user_id = u.id AND m.project_id = ?2 AND m.role = 'student' AND m.status = 'active'
      WHERE u.id = ?1`,
  )
    .bind(id, projectId)
    .first<{ id: string; name: string }>();
}

app.get('/me/catalogue/song/:id', requireUser, requireCurator, async (c) => {
  const db = c.env.DB;
  const me = c.get('user');
  const song = await helperSong(c.env, pid(c), c.req.param('id'));
  if (!song) return c.redirect(withMsg('/me/catalogue', 'That song is not in this catalogue.'));
  const rows = await db
    .prepare(
      `SELECT u.id, u.name, a.completed_at, a.assigned_at AS started_at,
              CASE WHEN a.assigned_by IS NULL OR a.assigned_by = u.id THEN NULL ELSE ab.name END AS added_by
         FROM users u
         JOIN project_members m ON m.user_id = u.id AND m.project_id = ?2
                               AND m.role = 'student' AND m.status = 'active'
         LEFT JOIN assignments a ON a.student_id = u.id AND a.section_id = ?1
                                AND a.project_id = ?2 AND a.archived_at IS NULL
         LEFT JOIN users ab ON ab.id = a.assigned_by
        ORDER BY (u.id = ?3) DESC, u.name COLLATE NOCASE`,
    )
    .bind(song.id, pid(c), me.id)
    .all<HelperStudent & { started_at: string | null }>();
  const all = rows.results ?? [];
  const { upcoming } = await meContext(c);
  return c.html(
    Me.catalogueSong(me, await meCounts(c.env, pid(c), me.id), site(c), upcoming[0], song, {
      learning: all.filter((r) => r.started_at && !r.completed_at),
      finished: all.filter((r) => r.started_at && r.completed_at),
      others: all.filter((r) => !r.started_at),
    }, c.req.query('msg')),
  );
});

app.post('/me/catalogue/song/:id/assign', requireUser, requireCurator, async (c) => {
  const song = await helperSong(c.env, pid(c), c.req.param('id'));
  if (!song) return c.redirect(withMsg('/me/catalogue', 'That song is not in this catalogue.'));
  const back = `/me/catalogue/song/${song.id}`;
  const f = await c.req.formData();
  const me = c.get('user');
  const student = await activeStudentHere(c.env, pid(c), f.get('student_id'));
  if (!student) return c.redirect(withMsg(back, 'Pick a student from the list.'));
  /* A song they once had comes back as it was — learning, or finished —
     the same as the teacher's assign from a student's page. */
  await c.env.DB.prepare(
    `INSERT INTO assignments (project_id, id, student_id, section_id, assigned_by, assigned_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(student_id, section_id) DO UPDATE SET archived_at = NULL, assigned_by = excluded.assigned_by
      WHERE assignments.project_id = ?1 AND assignments.archived_at IS NOT NULL`,
  )
    .bind(pid(c), newId('a'), student.id, song.id, me.id, now())
    .run();
  return c.redirect(withMsg(back, student.id === me.id ? 'Added to your list.' : `Added to ${student.name}'s list.`));
});

app.post('/me/catalogue/song/:id/unassign', requireUser, requireCurator, async (c) => {
  const song = await helperSong(c.env, pid(c), c.req.param('id'));
  if (!song) return c.redirect(withMsg('/me/catalogue', 'That song is not in this catalogue.'));
  const back = `/me/catalogue/song/${song.id}`;
  const f = await c.req.formData();
  const me = c.get('user');
  const student = await activeStudentHere(c.env, pid(c), f.get('student_id'));
  if (!student) return c.redirect(back);
  const r = await c.env.DB.prepare(
    `UPDATE assignments SET archived_at = ?1
      WHERE student_id = ?2 AND section_id = ?3 AND project_id = ?4
        AND archived_at IS NULL AND completed_at IS NULL`,
  )
    .bind(now(), student.id, song.id, pid(c))
    .run();
  if (!r.meta?.changes) return c.redirect(withMsg(back, 'Only your teacher can change a finished song.'));
  return c.redirect(withMsg(back,
    student.id === me.id ? 'Taken off your list. Recordings kept.' : `Taken off ${student.name}'s list. Recordings kept.`));
});

/** Take back a request you made, while it is still waiting. */
app.post('/me/catalogue/delete-request/:id/withdraw', requireUser, requireCurator, async (c) => {
  await c.env.DB.prepare(
    `UPDATE deletion_requests SET status = 'declined', decided_by = ?1, decided_at = ?2
      WHERE id = ?3 AND project_id = ?4 AND requested_by = ?1 AND status = 'pending'`,
  )
    .bind(c.get('user').id, now(), c.req.param('id'), pid(c))
    .run();
  return c.redirect(withMsg('/me/catalogue', 'Request withdrawn.'));
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
 * One ceiling on how long a single take may run — recorded in the browser or
 * uploaded as a file, by a teacher or a student. recorder.js enforces the
 * same number while recording (stopping the capture on its own) and while
 * probing an uploaded file's length before it ever reaches the network, but
 * neither of those is trustworthy on its own: a client can be old, patched,
 * or simply lying. This is the check that actually decides.
 */
const MAX_RECORDING_SEC = 6 * 60;
/** How much longer an edited recording may be than its original: room for a reverb's tail. */
const REVERB_TAIL_SEC = 3;

/**
 * A teacher chooses to add a recording; a student's own practice takes are
 * the one kind nobody but the student decided to create, one at a time,
 * with nothing stopping them from recording forever. Two ceilings, so
 * "record often" can't turn into "fill the shared R2 bucket without
 * meaning to": one per song, because that's where they actually pile up,
 * and one across the whole practice, because a student assigned to twenty
 * songs could otherwise still get to two hundred takes ten at a time.
 * Neither limit touches recordings a teacher adds — those stay unlimited,
 * as before.
 */
const MAX_PRACTICE_TAKES_PER_SONG = 10;
const MAX_PRACTICE_TAKES_TOTAL = 100;

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
  item: { id: string; section_id: string; visibility: string; student_id?: string },
  kind: 'recording' | 'note',
): Promise<boolean> {
  // Whatever it's marked, a student may always hear their own take —
  // that's the whole point of visibility 'self'. Still gated by the
  // assignment check below, same as everything else.
  const isOwn = kind === 'recording' && item.student_id === studentId;
  if (item.visibility !== 'shared' && !isOwn) {
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

/* How much may arrive in one request.
 *
 * The browser sends base64 of a 16 kHz mono MP3 at 32 kbps: two
 * minutes of that is about 640 KB encoded, so 1.5 MB is generous.
 *
 * It is also a hard ceiling rather than a courtesy, because of what
 * lies on the other side of it. On the free plan a Worker gets 10 ms of
 * CPU per request, and merely *reading* a body costs time in proportion
 * to its size — about 11 ms for a 2 MB string, which is over budget
 * before this route has done anything at all. So the size is checked
 * from the header, before a byte is read, and an oversized body is
 * refused rather than parsed. A request that dies of CPU exhaustion
 * gives the browser a dead connection and the teacher a shrug; a 413
 * gives him a sentence he can act on.
 *
 * The one thing that lands here oversized in practice is a page that
 * has been open since before this fix, still sending a whole WAV. Hence
 * the mention of reloading. */
const MAX_DICTATE = 1_500_000;
const DICTATE_PER_DAY = 150;
const PROFILE_ADDS_PER_DAY = 10;

/**
 * Take one from a person's daily allowance of something — true if there
 * was one to take. The check and the count are one statement, so two
 * requests at the same moment cannot both squeeze under the limit.
 */
async function spend(env: Env, userId: string, kind: string, limit: number): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const take = () =>
    env.DB.prepare(
      /* unscoped: a per-person allowance (spoken notes, profiles added) — a fact about the person, not about any one practice */
      `INSERT INTO usage_counters (user_id, day, kind, n) VALUES (?1, ?2, ?3, 1)
       ON CONFLICT(user_id, day, kind) DO UPDATE SET n = n + 1 WHERE n < ?4
       RETURNING n`,
    )
      .bind(userId, day, kind, limit)
      .first<{ n: number }>();
  try {
    return Boolean(await take());
  } catch (e) {
    /* An allowance is a brake on abuse, not a reason for an ordinary
       request to fail. A database that has not had schema.sql applied yet
       gets the table here; anything else is logged and let through. */
    if (/no such table/i.test(String(e))) {
      try {
        await env.DB.prepare(USAGE_COUNTERS_DDL).run();
        return Boolean(await take());
      } catch (e2) {
        console.error('usage_counters unavailable', e2);
        return true;
      }
    }
    console.error('usage counter failed', e);
    return true;
  }
}

/* The same statement as in schema.sql, for the rare database that is
   running this code before the schema step reached it. */
const USAGE_COUNTERS_DDL = `CREATE TABLE IF NOT EXISTS usage_counters (
  user_id TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day, kind))`;

app.post('/t/api/dictate', requireTeacherJson, async (c) => {
  if (!dictateEnabled(c.env))
    return c.json({ error: 'Dictation is switched off for this site.' }, 503);

  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_DICTATE)
    return c.json(
      {
        error:
          'That clip is too big to read back. Keep it to a sentence or two — ' +
          'and if this page has been open a while, reload it first.',
      },
      413,
    );

  const type = (c.req.header('content-type') || '').toLowerCase();
  let b64 = '';
  let mime = c.req.header('x-audio-type') || 'audio/mpeg';

  if (type.startsWith('text/') || type.includes('base64')) {
    /* The fast path, and the only one the current page uses: the body
       IS the base64, so this is one native read and no parsing. */
    b64 = (await c.req.text()).trim();
  } else {
    /* A multipart upload from an older cached copy of dictate.js.
       Parsing it costs CPU in proportion to its size, which is why the
       ceiling above is small enough that the cost is survivable. */
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'That clip could not be read. Reload the page and try again.' }, 400);
    }
    const file = form.get('audio');
    if (!(file instanceof File) || file.size === 0)
      return c.json({ error: 'Nothing was recorded.' }, 400);
    mime = file.type || mime;
    /* Encoding here is exactly the CPU cost this route exists to avoid,
       so it is not done at all. Say so plainly: one reload fixes it. */
    return c.json(
      {
        error:
          'This page is out of date and sent the recording the old way. ' +
          'Reload the page (⌘⇧R, or Ctrl-Shift-R) and speak it again.',
      },
      409,
    );
  }

  if (!b64) return c.json({ error: 'Nothing was recorded.' }, 400);
  /* The declared length above can be absent (a chunked body); this is the
     length actually read, which cannot. */
  if (b64.length > MAX_DICTATE)
    return c.json({ error: 'That clip is too big to read back. Keep it to a sentence or two.' }, 413);
  /* Every call here is billed by the transcription service, so each person
     gets a daily allowance — far more than a day of lessons uses, far less
     than a script in a loop would. */
  if (!(await spend(c.env, c.get('user').id, 'dictate', DICTATE_PER_DAY)))
    return c.json({ error: `That's the day's ${DICTATE_PER_DAY} spoken notes used up. Type it instead — it resets tomorrow.` }, 429);

  /* The vocabulary the model has no reason to know: the Carnatic terms,
     plus the titles and ragas of the songs this teacher actually
     teaches. Sarvam takes them as keyterms and gets them right; Whisper
     takes them as a prompt and does a little better than nothing. */
  const keyterms = [...CARNATIC_TERMS, ...(await catalogueTerms(c.env, pid(c)))];

  try {
    const t = await transcribe(c.env, b64, mime, keyterms);
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

app.post('/api/recordings', requireUserJson, async (c) => {
  const isTeacher = acting(c).isTeacher;
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'That file was too large to upload in one go.' }, 413);
  }

  const file = form.get('file');
  const sectionId = String(form.get('section_id') ?? '');
  if (!(file instanceof File) || !sectionId)
    return c.json({ error: 'Missing file or song.' }, 400);
  if (!(await sectionInProject(c.env, pid(c), sectionId)))
    return c.json({ error: 'That song is not in this practice.' }, 404);

  let studentId: string;
  let shareIds: string[] = [];
  let visibility: 'shared' | 'chosen' | 'self';
  if (isTeacher) {
    // A recording added from the song page belongs to no particular student.
    // It is filed against the teacher and shared, which is what the access
    // check actually reads; student_id here is attribution, not a gate.
    studentId = String(form.get('student_id') ?? '') || c.get('user').id;
    /* Attribution only, but it still has to be somebody in this practice —
       otherwise a stranger's name turns up on this practice's song page. */
    if (studentId !== c.get('user').id && !(await memberHere(c.env, pid(c), studentId)))
      return c.json({ error: 'That student is not in this practice.' }, 404);
    shareIds = form.getAll('share_ids').map((v) => String(v)).filter(Boolean);
    visibility = String(form.get('visibility')) === 'chosen' && shareIds.length ? 'chosen' : 'shared';
  } else {
    // A student may only record themselves, only for a song they're
    // actually assigned, and it's never shared beyond them and a teacher —
    // there's no form field that can change any of that from the client.
    studentId = c.get('user').id;
    visibility = 'self';
    const assigned = await c.env.DB.prepare(
      'SELECT 1 AS x FROM assignments WHERE student_id = ? AND section_id = ? AND archived_at IS NULL AND project_id = ?',
    )
      .bind(studentId, sectionId, pid(c))
      .first();
    if (!assigned) return c.json({ error: 'That song is not on your list.' }, 403);

    // Two quotas, checked before anything is written or uploaded, so a
    // student who has hit one gets turned away without the file ever
    // touching R2. Both count only their own practice takes — a teacher's
    // recordings on this song, or on any other, are never in this tally.
    const perSong = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM recordings
        WHERE section_id = ? AND student_id = ? AND project_id = ? AND visibility = 'self'`,
    )
      .bind(sectionId, studentId, pid(c))
      .first<{ n: number }>();
    if ((perSong?.n ?? 0) >= MAX_PRACTICE_TAKES_PER_SONG)
      return c.json(
        {
          error: `You've reached the limit of ${MAX_PRACTICE_TAKES_PER_SONG} practice takes for this song. Delete an older one before adding a new one.`,
        },
        409,
      );

    const total = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM recordings WHERE student_id = ? AND project_id = ? AND visibility = 'self'`,
    )
      .bind(studentId, pid(c))
      .first<{ n: number }>();
    if ((total?.n ?? 0) >= MAX_PRACTICE_TAKES_TOTAL)
      return c.json(
        {
          error: `You've reached your overall limit of ${MAX_PRACTICE_TAKES_TOTAL} practice takes for this practice. Delete some older recordings before adding new ones.`,
        },
        409,
      );
  }

  if (file.size === 0) return c.json({ error: 'That file is empty.' }, 400);
  if (file.size > MAX_UPLOAD)
    return c.json({ error: `That file is ${(file.size / 1048576).toFixed(0)} MB. The limit is 90 MB.` }, 413);

  /* Only audio and video, whatever the browser claims — see uploadType.
     A take declared as text/html would otherwise be served back as a page. */
  const mime = uploadType(file.type, file.name, 'media');
  if (!mime)
    return c.json(
      { error: 'That kind of file can’t be added here. Use an audio or video file — MP3, M4A, WAV, WebM or MP4.' },
      415,
    );
  const kind = mime.startsWith('video/') || String(form.get('kind')) === 'video' ? 'video' : 'audio';
  // Every recording carries a name. An upload falls back to its filename; a
  // take recorded in the browser is named in the form before it can be saved.
  const title = String(form.get('title') ?? '').trim() || file.name.replace(/\.[^.]+$/, '').trim();
  if (!title) return c.json({ error: 'Give this recording a name first.' }, 400);
  const durationRaw = Number(form.get('duration_sec'));
  const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null;
  // Known and over the cap is a hard stop, for a recording or an upload,
  // teacher's or student's. Unknown (an upload whose length couldn't be read
  // client-side) is let through rather than guessed at — see recorder.js.
  if (duration !== null && duration > MAX_RECORDING_SEC)
    return c.json(
      {
        error: `Recordings are capped at ${Math.round(MAX_RECORDING_SEC / 60)} minutes. This one runs ${Math.ceil(duration / 60)}. Trim it and try again.`,
      },
      413,
    );
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
 * Replace a recording's audio with an edited version — parts cut out in the
 * browser (public/audio-edit.js). A teacher may edit any audio recording in
 * their practice; a student only their own practice takes, the same ones
 * nobody else can hear. It can only get shorter: this is for cutting, not
 * for swapping in a different take under an old name and date.
 *
 * The new file goes in under a new key and the row is pointed at it before
 * the old file is deleted, so a failure part-way leaves the recording
 * playable either way. The player's URL carries a fingerprint of the key
 * (views/recorder.ts mediaSrc), so nobody keeps hearing the cached original.
 */
/** A teacher may edit any recording in their practice; a student only their own practice takes. */
function mayEditRecording(c: Context<AppEnv, any, any>, rec: Recording): boolean {
  return acting(c).isTeacher || (rec.visibility === 'self' && rec.student_id === c.get('user').id);
}

app.post('/api/recordings/:id/audio', requireUserJson, async (c) => {
  const rec = await c.env.DB.prepare('SELECT * FROM recordings WHERE id = ?1 AND project_id = ?2')
    .bind(c.req.param('id'), pid(c))
    .first<Recording>();
  if (!rec) return c.json({ error: 'That recording is not in this practice.' }, 404);
  if (!mayEditRecording(c, rec)) return c.json({ error: 'Only your own practice takes can be edited.' }, 403);
  if (rec.kind !== 'audio') return c.json({ error: 'Only audio recordings can be edited.' }, 400);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'That file was too large to upload in one go.' }, 413);
  }
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return c.json({ error: 'The edited recording is missing.' }, 400);
  if (file.size > MAX_UPLOAD) return c.json({ error: 'That file is too large.' }, 413);
  const mime = uploadType(file.type, file.name, 'media');
  if (!mime || !mime.startsWith('audio/'))
    return c.json({ error: 'An edited recording has to be audio.' }, 415);
  const durationRaw = Number(form.get('duration_sec'));
  const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : null;
  if (duration === null) return c.json({ error: 'The edited recording has no length.' }, 400);
  /* Never longer than the recording it came from — measured against the
     untouched original when there is one, so a string of edits can't creep
     past it — except for a few seconds of reverb tail at the end. */
  const base = rec.original_duration ?? rec.duration_sec;
  if (duration > MAX_RECORDING_SEC + REVERB_TAIL_SEC || (base && duration > base + REVERB_TAIL_SEC))
    return c.json({ error: 'An edit can only make a recording shorter.' }, 400);

  const key = `rec/${rec.student_id}/${rec.section_id}/${rec.id}-${slugify(rec.title ?? 'recording')}-e${Date.now().toString(36)}.${extFor(mime)}`;
  await c.env.MEDIA.put(key, file.stream(), {
    httpMetadata: { contentType: mime, cacheControl: 'private, max-age=31536000' },
  });
  /* The first edit keeps what it replaces as the original; a later edit
     replaces only the previous edit, so there are never more than two. */
  const first = !rec.original_r2_key;
  const r = await c.env.DB.prepare(
    `UPDATE recordings SET r2_key = ?1, mime_type = ?2, size_bytes = ?3, duration_sec = ?4,
            original_mime = CASE WHEN original_r2_key IS NULL THEN ?8 ELSE original_mime END,
            original_size = CASE WHEN original_r2_key IS NULL THEN ?9 ELSE original_size END,
            original_duration = CASE WHEN original_r2_key IS NULL THEN ?10 ELSE original_duration END,
            original_r2_key = COALESCE(original_r2_key, ?7)
      WHERE id = ?5 AND project_id = ?6 AND r2_key = ?7`,
  )
    .bind(key, mime, file.size, duration, rec.id, pid(c), rec.r2_key, rec.mime_type, rec.size_bytes, rec.duration_sec)
    .run();
  if (!r.meta?.changes) {
    // Deleted, or edited by someone else, while this one was uploading.
    await c.env.MEDIA.delete(key);
    return c.json({ error: 'This recording changed while you were editing it. Reload and try again.' }, 409);
  }
  if (!first) await c.env.MEDIA.delete(rec.r2_key);
  return c.json({ ok: true, kept_original: true });
});

/**
 * An edited recording carries two files until someone chooses: keep the
 * edit (the original is deleted) or go back to the original (the edit is
 * deleted). Either way one copy remains.
 */
app.post('/recordings/:id/original', requireUser, async (c) => {
  const f = await c.req.formData();
  const rec = await c.env.DB.prepare('SELECT * FROM recordings WHERE id = ?1 AND project_id = ?2')
    .bind(c.req.param('id'), pid(c))
    .first<Recording>();
  const back = safeBack(f.get('back'), acting(c).isTeacher ? '/t' : '/me');
  if (!rec || !mayEditRecording(c, rec)) return c.redirect(withMsg(back, 'That recording is not yours to change.'));
  if (!rec.original_r2_key) return c.redirect(withMsg(back, 'There is only one copy of that recording.'));
  if (String(f.get('action')) === 'restore') {
    const r = await c.env.DB.prepare(
      `UPDATE recordings SET r2_key = original_r2_key, mime_type = original_mime, size_bytes = original_size,
              duration_sec = original_duration,
              original_r2_key = NULL, original_mime = NULL, original_size = NULL, original_duration = NULL
        WHERE id = ?1 AND project_id = ?2 AND r2_key = ?3`,
    )
      .bind(rec.id, pid(c), rec.r2_key)
      .run();
    if (r.meta?.changes) await c.env.MEDIA.delete(rec.r2_key);
    return c.redirect(withMsg(back, 'Back to the original. The edited copy is deleted.'));
  }
  const r = await c.env.DB.prepare(
    `UPDATE recordings SET original_r2_key = NULL, original_mime = NULL, original_size = NULL, original_duration = NULL
      WHERE id = ?1 AND project_id = ?2 AND original_r2_key = ?3`,
  )
    .bind(rec.id, pid(c), rec.original_r2_key)
    .run();
  if (r.meta?.changes) await c.env.MEDIA.delete(rec.original_r2_key);
  return c.redirect(withMsg(back, 'Edited version kept. The original copy is deleted.'));
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
  return c.redirect(safeBack(f.get('back'), `/t/song/${rec.section_id}`));
});

app.post('/t/recordings/:id/delete', requireTeacher, async (c) => {
  const rec = await c.env.DB.prepare('SELECT * FROM recordings WHERE id = ?1 AND project_id = ?2')
    .bind(c.req.param('id'), pid(c))
    .first<Recording>();
  if (!rec) return c.redirect('/t');
  await c.env.MEDIA.delete(rec.original_r2_key ? [rec.r2_key, rec.original_r2_key] : rec.r2_key);
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

  /* ?original=1 plays the pre-edit copy, while there is one. The size and
     type used below are then that copy's, not the edit's. */
  if (c.req.query('original')) {
    if (!rec.original_r2_key) return c.notFound();
    rec.r2_key = rec.original_r2_key;
    rec.mime_type = rec.original_mime ?? rec.mime_type;
    rec.size_bytes = rec.original_size ?? rec.size_bytes;
  }
  const rangeHeader = c.req.header('range');
  const obj = await c.env.MEDIA.get(rec.r2_key, rangeHeader ? { range: c.req.raw.headers } : undefined);
  if (!obj) return c.notFound();

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, max-age=3600');
  /* Served as an audio or video type or not at all inline — never as
     whatever was stored, which an uploader chose. */
  const served = serveType(rec.mime_type, 'media');
  headers.set('content-type', served.type);
  lockDownUpload(headers);

  if (c.req.query('download') || !served.inline) {
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
  const back = safeBack(f.get('back'), `/t/s/${studentId}/${rec.section_id}`);
  return c.redirect(withMsg(back, 'Unlocked for this student.'));
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
  const back = safeBack(f.get('back'), `/t/s/${studentId}/${rec.section_id}`);
  return c.redirect(withMsg(back, 'Locked for this student.'));
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
  const back = safeBack(f.get('back'), `/t/s/${studentId}/${sectionId}`);

  if (!sectionId) return c.redirect('/t');
  if (!(await sectionInProject(c.env, pid(c), sectionId)))
    return c.html(V.notFound(c.get('user'), site(c)), 404);
  if (studentId !== c.get('user').id && !(await memberHere(c.env, pid(c), studentId)))
    return c.html(V.notFound(c.get('user'), site(c)), 404);

  let imageKey: string | null = null;
  let imageMime: string | null = null;
  let imageBytes = 0;

  const id = newId('n');
  if (image instanceof File && image.size > 0) {
    if (image.size > 12 * 1024 * 1024)
      return c.redirect(withMsg(back, 'That image is over 12 MB — try a smaller one.'));
    const im = uploadType(image.type, image.name, 'image');
    if (!im) return c.redirect(withMsg(back, 'That kind of image can’t be added — use PNG, JPEG, WebP or GIF.'));
    imageMime = im;
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

  return c.redirect(withMsg(back, 'Note saved.'));
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
  /* A raster image or an opaque download — never SVG, never HTML. */
  const served = serveType(note.image_mime, 'image');
  headers.set('content-type', served.type);
  lockDownUpload(headers);
  // ?download=1 turns the same URL into a save-to-disk, named after the note.
  if (c.req.query('download') || !served.inline) {
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

/** Is this person in this practice at all (any role, any standing)? */
async function memberHere(env: Env, projectId: string, userId: string): Promise<boolean> {
  const r = await env.DB.prepare('SELECT 1 AS x FROM project_members WHERE project_id = ? AND user_id = ?')
    .bind(projectId, userId)
    .first();
  return Boolean(r);
}

/** Every active student in the project, for a "pick a student" control. */
async function activeStudentRoster(env: Env, projectId: string): Promise<Sched.WithZone[]> {
  const rows = await env.DB.prepare(
    `SELECT u.id, u.name, u.avatar_url, u.time_zone, u.location
       FROM users u
       JOIN project_members m ON m.user_id = u.id AND m.project_id = ?1
      WHERE m.status = 'active' AND m.role = 'student'
      ORDER BY u.name COLLATE NOCASE`,
  )
    .bind(projectId)
    .all<Sched.WithZone>();
  return rows.results ?? [];
}

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

  const roster = await activeStudentRoster(c.env, pid(c));

  return c.html(
    Sched.weekCalendar(c.get('user'), start, cells, site(c), roster, c.req.query('msg'), visiting(c)),
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

  const roster = await activeStudentRoster(c.env, pid(c));

  return c.html(
    Sched.dayView(c.get('user'), date, items, site(c), roster, c.req.query('msg'), visiting(c)),
  );
});

/** Add a one-off class for a student, straight from the calendar. */
app.post('/t/schedule/day/:date/add', requireTeacher, async (c) => {
  const date = c.req.param('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.redirect('/t/schedule/week');

  const f = await c.req.formData();
  const studentId = String(f.get('student_id') ?? '').trim();
  const time = String(f.get('time_ist') ?? '').trim();
  const back = safeBack(f.get('back'), `/t/schedule/day/${date}`);
  if (!studentId) return c.redirect(withMsg(back, 'Pick a student.'));
  if (!/^\d{2}:\d{2}$/.test(time))
    return c.redirect(withMsg(back, 'That time did not look right.'));

  const dur = Number(f.get('duration_min'));
  await c.env.DB.prepare(
    /* student_id comes from a <select> built from this project's own
       active roster, but the WHERE EXISTS re-checks it server-side anyway
       — exactly like /t/students/:id/slots, just with the student named
       in the form instead of the URL. */
    `INSERT INTO class_slots
       (project_id, id, student_id, kind, weekday, on_date, time_ist, duration_min, label, created_by, created_at)
     SELECT ?1,?2,?3,'once',NULL,?4,?5,?6,?7,?8,?9
      WHERE EXISTS (
        SELECT 1 FROM project_members m
         WHERE m.user_id = ?3 AND m.project_id = ?1 AND m.status = 'active' AND m.role = 'student'
      )`,
  )
    .bind(
      pid(c), newId('cs'), studentId, date, time,
      Number.isFinite(dur) && dur > 0 ? Math.round(dur) : 60,
      String(f.get('label') ?? '').trim() || null,
      c.get('user').id, now(),
    )
    .run();
  return c.redirect(withMsg(back, 'Class added.'));
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
  const back = safeBack(f.get('back'), '/t/schedule');
  return c.redirect(withMsg(back, 'Marked as missed. Reschedule it below if you want to.'));
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

/**
 * Change an existing slot's own rule — its day/date, time, length or label —
 * rather than deleting it and adding a replacement. A recurring slot keeps
 * its id and its history of exceptions (skips, moves) either way; only the
 * rule itself changes, from here on.
 */
app.post('/t/slots/:id', requireTeacher, async (c) => {
  const id = c.req.param('id');
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
    /* :id is a slot id from the URL, so this only ever touches a slot that
       already belongs to the acting project — nothing to check beforehand. */
    `UPDATE class_slots
        SET kind = ?1, weekday = ?2, on_date = ?3, time_ist = ?4, duration_min = ?5, label = ?6
      WHERE id = ?7 AND project_id = ?8`,
  )
    .bind(
      kind,
      kind === 'weekly' ? Number(f.get('weekday')) || 0 : null,
      kind === 'once' ? onDate : null,
      time,
      Number.isFinite(dur) && dur > 0 ? Math.round(dur) : 60,
      String(f.get('label') ?? '').trim() || null,
      id,
      pid(c),
    )
    .run();
  return c.redirect('/t/schedule/slots?msg=' + encodeURIComponent('Class slot updated.'));
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
  const back = safeBack(f.get('back'), '/t/schedule');
  return c.redirect(withMsg(back, 'Marked as no class.'));
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
  const back = safeBack(f.get('back'), '/t/schedule');
  return c.redirect(withMsg(back, 'Class moved. The student sees the new time on their own clock.'));
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
  const back = safeBack(f.get('back'), '/t/schedule');
  return c.redirect(withMsg(back, 'Back to normal.'));
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
  const r = await c.env.DB.prepare(
    `UPDATE users SET time_zone = ?1, location = ?2
      WHERE id = ?3 AND users.is_admin = 0
        AND EXISTS (SELECT 1 FROM project_members m
                     WHERE m.user_id = users.id AND m.project_id = ?4 AND m.role = 'student')
        AND NOT EXISTS (SELECT 1 FROM project_members o
                         WHERE o.user_id = users.id AND o.project_id <> ?4 AND o.status <> 'disabled')`,
  )
    .bind(tz || null, String(f.get('location') ?? '').trim() || null, c.req.param('id'), pid(c))
    .run();
  if (!r.meta?.changes) return c.redirect('/t/schedule/slots?msg=' + encodeURIComponent(NOT_ONLY_YOURS));
  return c.redirect('/t/schedule/slots?msg=' + encodeURIComponent('Saved.'));
});

app.post('/me/zone', requireUser, async (c) => {
  const f = await c.req.formData();
  const tz = String(f.get('time_zone') ?? '').trim();
  if (tz && !isValidZone(tz))
    return c.redirect('/me/settings?msg=' + encodeURIComponent('That time zone was not recognised.'));
  /* unscoped: the signed-in user setting their own location and time zone — one person keeps one clock, whichever teachers they learn from */
  await c.env.DB.prepare('UPDATE users SET time_zone = ?, location = ? WHERE id = ?')
    .bind(tz || null, String(f.get('location') ?? '').trim() || null, c.get('user').id)
    .run();
  return c.redirect('/me/settings?msg=' + encodeURIComponent('Saved.'));
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

/* ==================================================================
 * When something breaks
 *
 * "Something went wrong" on its own tells nobody anything: the person who
 * saw it cannot say which thing, and without a live log stream nobody can
 * find out afterwards. So every failure gets a short reference, shown on
 * the page and written — with the path and the error itself — to
 * error_log, which the admin can read at /admin/errors.
 * ================================================================== */
const ERROR_LOG_DDL = `CREATE TABLE IF NOT EXISTS error_log (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, method TEXT, path TEXT,
  user_id TEXT, message TEXT, stack TEXT)`;

app.onError(async (err, c) => {
  const ref = Math.random().toString(36).slice(2, 8).toUpperCase();
  const path = new URL(c.req.url).pathname;
  const e = err as Error;
  console.error(`[error ${ref}] ${c.req.method} ${path}`, e);
  try {
    const who = (c.get('user') as User | undefined)?.id ?? (await currentUser(c).catch(() => null))?.id ?? null;
    const write = () =>
      c.env.DB.prepare(
        /* unscoped: the app's own error record, read only by an admin */
        'INSERT INTO error_log (id, at, method, path, user_id, message, stack) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(ref, now(), c.req.method, path, who,
          String(e?.message ?? e).slice(0, 600), String(e?.stack ?? '').slice(0, 3000))
        .run();
    try {
      await write();
    } catch (w) {
      if (!/no such table/i.test(String(w))) throw w;
      await c.env.DB.prepare(ERROR_LOG_DDL).run();
      await write();
    }
  } catch (w) {
    console.error('could not record the error', w);
  }
  return c.text(
    `Something went wrong. Please try again.\n\nIf it keeps happening, tell the site admin this reference: ${ref}`,
    500,
  );
});

export default app;
