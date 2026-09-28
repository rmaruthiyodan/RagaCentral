import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env, User, Vars, AppEnv } from './types';
import { newId, now } from './util';
import { resolveProject } from './projects';

type Ctx = Context<AppEnv, any, any>;

const SESSION_COOKIE = 'sruti_session';
const STATE_COOKIE = 'sruti_oauth_state';
const SESSION_DAYS = 60;

/* ------------------------------------------------------------------ *
 * Signed session cookies
 * A session is just {uid, em, exp} signed with HMAC-SHA256. No session
 * table, no extra database read on every request.
 *
 * `uid` is the profile in use. `em` is the address Google vouched for at
 * sign-in, and it is what decides which OTHER profiles this browser may
 * switch to: one email is not one person — a parent signs in once for
 * themselves and each of their children — so "who is signed in" and
 * "whose lessons are these" are different questions with different
 * answers. A cookie from before profiles existed has no `em`; for those
 * the profile's own address stands in, which is the same thing in
 * practice, since nothing can change an address once it is on a profile.
 * ------------------------------------------------------------------ */

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): Uint8Array {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signSession(secret: string, uid: string, em?: string | null): Promise<string> {
  const payload = b64urlEncode(
    new TextEncoder().encode(
      JSON.stringify({ uid, em: em ?? undefined, exp: Date.now() + SESSION_DAYS * 86400000 }),
    ),
  );
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return `${payload}.${b64urlEncode(sig)}`;
}

export interface SessionData {
  uid: string;
  /** The verified sign-in address, lowercased. Undefined on a pre-profiles
   *  cookie; empty when Google did not vouch for the address at all. */
  em?: string;
}

export async function readSession(secret: string, token: string | undefined): Promise<SessionData | null> {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      b64urlDecode(sig),
      new TextEncoder().encode(payload),
    );
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (!data.exp || data.exp < Date.now()) return null;
    if (typeof data.uid !== 'string') return null;
    return { uid: data.uid, em: typeof data.em === 'string' ? data.em : undefined };
  } catch {
    return null;
  }
}

export async function startSession(c: Ctx, uid: string, em?: string | null) {
  const token = await signSession(c.env.SESSION_SECRET, uid, em);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
}

export function endSession(c: Ctx) {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export async function currentUser(c: Ctx): Promise<User | null> {
  const s = await readSession(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE));
  if (!s) return null;
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(s.uid).first<User>();
  return row ?? null;
}

/**
 * The address this browser signed in with — the key to every profile it
 * may use. Empty when there is none to trust, which leaves the profile
 * in use as the only one.
 */
export async function signInEmail(c: Ctx, user: User): Promise<string> {
  const s = await readSession(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE));
  if (s && s.em !== undefined) return s.em;
  return (user.email ?? '').toLowerCase().trim();
}

/**
 * Every profile behind one sign-in: the people who share its address.
 * Always includes the profile in use, even if its address has since
 * drifted from the one signed in with, so the chooser never loses the
 * person who is looking at it.
 */
export async function profilesFor(env: Env, email: string, currentId: string): Promise<User[]> {
  /* unscoped: identity, not membership — which people a sign-in may act as, before any project comes into it */
  const r = await env.DB.prepare(
    `SELECT * FROM users
      WHERE (?1 <> '' AND lower(email) = ?1) OR id = ?2
      ORDER BY created_at, name COLLATE NOCASE`,
  )
    .bind(email, currentId)
    .all<User>();
  return r.results ?? [];
}

/** At most this many people behind one address — a family, not a school. */
export const MAX_PROFILES_PER_EMAIL = 8;

/* ------------------------------------------------------------------ *
 * Google OAuth 2.0, authorization-code flow
 * ------------------------------------------------------------------ */

export function googleAuthUrl(c: Ctx, state: string): string {
  const redirect = new URL('/auth/callback', c.req.url).toString();
  const p = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export function setOAuthState(c: Ctx, state: string) {
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: 600,
  });
}

export function takeOAuthState(c: Ctx): string | undefined {
  const s = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: '/' });
  return s;
}

interface GoogleProfile {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

export async function exchangeCode(c: Ctx, code: string): Promise<GoogleProfile> {
  const redirect = new URL('/auth/callback', c.req.url).toString();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirect,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  const tokens = (await res.json()) as { id_token?: string; access_token?: string };
  if (!tokens.id_token) throw new Error('Google did not return an id_token');

  // The id_token comes straight from Google over TLS in response to our own
  // request with our own client secret, so decoding it is enough here — we are
  // not accepting a token handed to us by a browser.
  const [, payloadB64] = tokens.id_token.split('.');
  const profile = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))) as GoogleProfile & {
    aud?: string;
    iss?: string;
  };
  if (profile.aud !== c.env.GOOGLE_CLIENT_ID) throw new Error('id_token was issued for a different app');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(profile.iss ?? ''))
    throw new Error('id_token has an unexpected issuer');
  if (!profile.email) throw new Error('Google account has no email address');
  const exp = (profile as { exp?: number }).exp;
  if (typeof exp === 'number' && exp * 1000 < Date.now() - 5 * 60_000) throw new Error('id_token has expired');
  return profile;
}

/**
 * Find or create the profile a Google sign-in lands on.
 *
 * One address is not one person. A parent may sign in for themselves and
 * for each child, all on the same Gmail, and the teacher may have added
 * any of them by that address before anyone signed in. So:
 *
 *   - the profile already holding this Google account wins;
 *   - one profile on the address, not yet claimed: claim it (the old
 *     behaviour, and still the common case);
 *   - several profiles on the address: claim none of them and rename
 *     none of them. The sign-in belongs to the address; the chooser that
 *     follows asks who is actually at the keyboard.
 *
 * Google's own name and photo are copied onto the profile only when it
 * is the only one on its address. On a shared address they describe the
 * parent, and would otherwise turn every child into them.
 */
export async function upsertUser(c: Ctx, p: GoogleProfile): Promise<User> {
  const db = c.env.DB;
  const email = p.email.toLowerCase();
  /* An address Google has not verified proves nothing about who owns it,
     so it is never used to find somebody else's profile. */
  const verified = p.email_verified !== false;

  let user = await db.prepare('SELECT * FROM users WHERE google_sub = ?').bind(p.sub).first<User>();

  const onAddress = verified
    ? ((
        await db
          .prepare('SELECT * FROM users WHERE lower(email) = ? ORDER BY created_at')
          .bind(email)
          .all<User>()
      ).results ?? [])
    : [];
  const shared = onAddress.filter((u) => u.id !== user?.id).length > 0 && onAddress.length > 1;

  if (!user && onAddress.length === 1 && !onAddress[0].google_sub) {
    // A teacher added them by email before they ever signed in.
    const byEmail = onAddress[0];
    await db
      .prepare('UPDATE users SET google_sub = ?, name = ?, avatar_url = ? WHERE id = ?')
      .bind(p.sub, p.name ?? byEmail.name, p.picture ?? null, byEmail.id)
      .run();
    user = { ...byEmail, google_sub: p.sub, name: p.name ?? byEmail.name, avatar_url: p.picture ?? null };
  } else if (!user && onAddress.length > 1) {
    /* Several people on this address. Start on the first of them; the
       chooser comes next. Nothing is claimed, so nothing is renamed. */
    user = onAddress[0];
  }

  /* The nominated admin, on any visit — not only their first. Someone
     who signed in before the setting existed would otherwise be locked
     out of their own installation, and this is cheap to re-check. It
     only ever grants to the one address named in the config — and only
     to the profile that actually holds this Google account, never to a
     child who happens to share the address. */
  const bootstrapAdmin = (c.env.BOOTSTRAP_ADMIN_EMAIL ?? '').toLowerCase().trim();
  const isBootstrapAdmin = Boolean(bootstrapAdmin) && verified && email === bootstrapAdmin;

  if (!user) {
    const id = newId('u');
    await db
      .prepare(
        `INSERT INTO users (id, google_sub, email, name, avatar_url, role, status, created_at, is_admin)
         VALUES (?, ?, ?, ?, ?, 'student', 'pending', ?, ?)`,
      )
      .bind(
        id,
        p.sub,
        p.email,
        p.name ?? p.email,
        p.picture ?? null,
        now(),
        isBootstrapAdmin ? 1 : 0,
      )
      .run();

    /* A new account belongs to no project. Someone has to put them in
       one — a teacher inviting them by email, or an admin adding them.
       Until then they see the waiting page, which is the same thing
       that used to happen while a teacher approved them. */
    user = (await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>())!;
  } else if (!shared) {
    // Keep the display name and photo fresh — theirs alone to keep fresh.
    await db
      .prepare('UPDATE users SET name = ?, avatar_url = ? WHERE id = ?')
      .bind(p.name ?? user.name, p.picture ?? user.avatar_url, user.id)
      .run();
    user = { ...user, name: p.name ?? user.name, avatar_url: p.picture ?? user.avatar_url };
  }

  if (isBootstrapAdmin && !user.is_admin && user.google_sub === p.sub) {
    await db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(user.id).run();
    user = { ...user, is_admin: 1 };
  }

  return user;
}

/* ------------------------------------------------------------------ *
 * Route guards
 *
 * Since projects, "teacher" is not a fact about a person. It is a fact
 * about a person IN A PROJECT, so every guard below resolves which
 * project the request is acting in before it can answer.
 *
 * The order is always the same and matters:
 *
 *   1. Are you signed in at all?          → the sign-in page
 *   2. Which project are you acting in?   → the waiting page, or a chooser
 *   3. May you do this here?              → their own pages
 *
 * Skipping step 2 is how one teacher ends up looking at another's
 * students, so nothing below reads a scoped table without it.
 * ------------------------------------------------------------------ */

/** Signed in, and standing in some project. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await currentUser(c);
  if (!user) return c.redirect('/');
  c.set('user', user);

  const acting = await resolveProject(c, user);
  if (!acting) {
    /* Signed in but in no project: a brand-new account waiting to be
       added, or someone whose only membership was archived. An admin is
       the exception — they have somewhere to go without a membership. */
    if (user.is_admin) return c.redirect('/admin');
    return c.redirect('/waiting');
  }
  if (acting.membership && acting.membership.status !== 'active' && !acting.asAdmin)
    return c.redirect('/waiting');

  c.set('acting', acting);
  await next();
};

/** A teacher of the project being acted in — or an admin who switched into it. */
export const requireTeacher: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await currentUser(c);
  if (!user) return c.redirect('/');
  c.set('user', user);

  const acting = await resolveProject(c, user);
  if (!acting) return c.redirect(user.is_admin ? '/admin' : '/waiting');
  if (!acting.isTeacher) return c.redirect('/me');
  if (acting.membership && acting.membership.status !== 'active' && !acting.asAdmin)
    return c.redirect('/waiting');

  c.set('acting', acting);
  await next();
};

/** Above every project. Creating them, and switching between them. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await currentUser(c);
  if (!user) return c.redirect('/');
  if (!user.is_admin) return c.redirect('/');
  c.set('user', user);
  await next();
};

/**
 * The same rule as requireTeacher, but for the endpoints a script calls.
 *
 * A redirect is the right answer for a page and the wrong one for fetch:
 * the browser follows it, the script gets the sign-in page's HTML, and
 * `res.json()` throws something that reads like a network failure rather
 * than "you are signed out". These say so in the status line.
 */
export const requireTeacherJson: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'You are signed out. Reload the page and sign in again.' }, 401);
  c.set('user', user);

  const acting = await resolveProject(c, user);
  if (!acting || !acting.isTeacher)
    return c.json({ error: 'Only a teacher can do that.' }, 403);
  if (acting.membership && acting.membership.status !== 'active' && !acting.asAdmin)
    return c.json({ error: 'Your account is not active in this project.' }, 403);

  c.set('acting', acting);
  await next();
};

/** The same rule as requireUser, but for the endpoints a script calls — see requireTeacherJson above. */
export const requireUserJson: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'You are signed out. Reload the page and sign in again.' }, 401);
  c.set('user', user);

  const acting = await resolveProject(c, user);
  if (!acting) return c.json({ error: 'You are not part of a practice yet.' }, 403);
  if (acting.membership && acting.membership.status !== 'active' && !acting.asAdmin)
    return c.json({ error: 'Your account is not active in this project.' }, 403);

  c.set('acting', acting);
  await next();
};
