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
 * A session is just {uid, exp} signed with HMAC-SHA256. No session
 * table, no extra database read on every request.
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

export async function signSession(secret: string, uid: string): Promise<string> {
  const payload = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ uid, exp: Date.now() + SESSION_DAYS * 86400000 })),
  );
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return `${payload}.${b64urlEncode(sig)}`;
}

export async function readSession(secret: string, token: string | undefined): Promise<string | null> {
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
    return data.uid as string;
  } catch {
    return null;
  }
}

export async function startSession(c: Ctx, uid: string) {
  const token = await signSession(c.env.SESSION_SECRET, uid);
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
  const uid = await readSession(c.env.SESSION_SECRET, getCookie(c, SESSION_COOKIE));
  if (!uid) return null;
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(uid).first<User>();
  return row ?? null;
}

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
  return profile;
}

/** Find or create the user behind a Google profile. */
export async function upsertUser(c: Ctx, p: GoogleProfile): Promise<User> {
  const db = c.env.DB;
  const email = p.email.toLowerCase();

  let user = await db.prepare('SELECT * FROM users WHERE google_sub = ?').bind(p.sub).first<User>();

  if (!user) {
    // A teacher may have added the student by email before they ever signed in.
    const byEmail = await db
      .prepare('SELECT * FROM users WHERE lower(email) = ? AND google_sub IS NULL')
      .bind(email)
      .first<User>();
    if (byEmail) {
      await db
        .prepare('UPDATE users SET google_sub = ?, name = ?, avatar_url = ? WHERE id = ?')
        .bind(p.sub, p.name ?? byEmail.name, p.picture ?? null, byEmail.id)
        .run();
      user = { ...byEmail, google_sub: p.sub, name: p.name ?? byEmail.name, avatar_url: p.picture ?? null };
    }
  }

  /* The nominated admin, on any visit — not only their first. Someone
     who signed in before the setting existed would otherwise be locked
     out of their own installation, and this is cheap to re-check. It
     only ever grants to the one address named in the config. */
  const bootstrapAdmin = (c.env.BOOTSTRAP_ADMIN_EMAIL ?? '').toLowerCase().trim();
  const isBootstrapAdmin = Boolean(bootstrapAdmin) && email === bootstrapAdmin;

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
  } else {
    // Keep the display name and photo fresh.
    await db
      .prepare('UPDATE users SET name = ?, avatar_url = ? WHERE id = ?')
      .bind(p.name ?? user.name, p.picture ?? user.avatar_url, user.id)
      .run();
    user = { ...user, name: p.name ?? user.name, avatar_url: p.picture ?? user.avatar_url };
  }

  if (isBootstrapAdmin && !user.is_admin) {
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
