import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env, User, Vars, AppEnv } from './types';
import { newId, now } from './util';

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

  if (!user) {
    // Nobody at all yet, or this is the nominated teacher's first visit.
    const anyTeacher = await db
      .prepare("SELECT id FROM users WHERE role = 'teacher' AND status = 'active' LIMIT 1")
      .first<{ id: string }>();
    const isBootstrap =
      !anyTeacher && email === (c.env.BOOTSTRAP_TEACHER_EMAIL ?? '').toLowerCase().trim();

    const id = newId('u');
    const role = isBootstrap ? 'teacher' : 'student';
    const status = isBootstrap ? 'active' : 'pending';
    await db
      .prepare(
        `INSERT INTO users (id, google_sub, email, name, avatar_url, role, status, created_at, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, p.sub, p.email, p.name ?? p.email, p.picture ?? null, role, status, now(), isBootstrap ? now() : null)
      .run();
    user = (await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>())!;
  } else {
    // Keep the display name and photo fresh.
    await db
      .prepare('UPDATE users SET name = ?, avatar_url = ? WHERE id = ?')
      .bind(p.name ?? user.name, p.picture ?? user.avatar_url, user.id)
      .run();
  }

  return user;
}

/* ------------------------------------------------------------------ *
 * Route guards
 * ------------------------------------------------------------------ */

export const requireUser: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const user = await currentUser(c);
  if (!user) return c.redirect('/');
  if (user.status !== 'active') return c.redirect('/waiting');
  c.set('user', user);
  await next();
};

export const requireTeacher: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const user = await currentUser(c);
  if (!user) return c.redirect('/');
  if (user.status !== 'active') return c.redirect('/waiting');
  if (user.role !== 'teacher') return c.redirect('/me');
  c.set('user', user);
  await next();
};
