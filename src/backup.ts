/* ==================================================================
 * Backing the whole install up into Google Drive, from the admin page.
 *
 * WHY THIS IS AN ADMIN FEATURE AND NOT A TEACHER ONE
 *
 * A D1 export is the whole database — every project in it. Handing
 * that to a teacher would hand them every other practice's students,
 * notes and phone numbers in one file, which is exactly the boundary
 * the other 125 queries in this app spend their time defending. So
 * this lives above projects, with the person who can already see
 * everything, and nowhere else.
 *
 * WHY NOTHING HERE TOUCHES THE BYTES
 *
 * A Worker on the free plan gets 10 ms of CPU per request. Waiting on
 * the network is free and there is no wall-clock limit, so a request
 * may sit for a minute waiting for Cloudflare to finish a dump — but
 * it may not *compute* for more than ten milliseconds. A database of
 * any size read into JavaScript and serialised there would be over
 * budget long before it finished.
 *
 * So the database never passes through this code. Cloudflare's own
 * export API does the dump and hands back a signed URL; that URL is
 * piped straight into a Drive upload as a stream. The bytes go from
 * Cloudflare to Google without ever being a JavaScript value. What is
 * left here is a few hundred bytes of JSON and some waiting.
 *
 * WHAT IT ASKS GOOGLE FOR
 *
 * `drive.file` and nothing else: the app can see and manage the files
 * it creates, and is blind to the rest of the Drive. It is classified
 * non-sensitive, so it needs no security assessment — and, more to the
 * point, a mistake in this file cannot read anybody's documents.
 *
 * WHAT IT STORES, AND THE ONE RISK
 *
 * A refresh token, so a backup can be taken later without signing in
 * to Google again. That is a long-lived credential to someone's Drive
 * sitting in this application's database, and it is the one genuinely
 * new thing to worry about here. It is encrypted with AES-GCM under a
 * key derived from SESSION_SECRET, which means two things worth
 * knowing: the database alone is not enough to use it, and rotating
 * SESSION_SECRET means reconnecting Drive.
 * ================================================================== */

import type { Env } from './types';
/* An explicit .ts, like tz.ts does for i18n: it is what lets Node's
   type-stripping loader resolve this module, which is what lets the
   encryption be tested without a bundler. */
import { newId, now } from './util.ts';

/** Only the files this app makes. It cannot see anything else. */
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
/** Already granted at sign-in, so it adds no friction; it only lets us
    record WHICH Google account the backups are going to. */
const EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Thrown for anything the admin could act on; the message reaches the page. */
export class BackupError extends Error {}

export interface DriveLink {
  id: string;
  account_email: string | null;
  refresh_token: string;
  folder_id: string | null;
  connected_at: string;
  connected_by: string | null;
}

export interface BackupRun {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: 'done' | 'failed';
  file_name: string | null;
  file_id: string | null;
  bytes: number | null;
  detail: string | null;
  started_by: string | null;
}

/* ------------------------------------------------------------------ *
 * Keeping the refresh token
 * ------------------------------------------------------------------ */

async function aesKey(secret: string): Promise<CryptoKey> {
  /* A hash rather than the raw secret, because AES-GCM wants exactly
     32 bytes and SESSION_SECRET is whatever length somebody typed. */
  const material = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${secret}/drive-refresh-token`),
  );
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export async function sealToken(secret: string, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await aesKey(secret),
      new TextEncoder().encode(token),
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64(out);
}

export async function openToken(secret: string, sealed: string): Promise<string> {
  const raw = unb64(sealed);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.slice(0, 12) },
    await aesKey(secret),
    raw.slice(12),
  );
  return new TextDecoder().decode(plain);
}

/* ------------------------------------------------------------------ *
 * The link to a Drive
 * ------------------------------------------------------------------ */

export async function getLink(env: Env): Promise<DriveLink | null> {
  /* One Drive for the whole installation. drive_link has no project_id
     because it is not any project's data — it is the admin's link to
     their own storage. */
  return env.DB.prepare("SELECT * FROM drive_link WHERE id = 'the'").first<DriveLink>();
}

export function driveConsentUrl(env: Env, redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: `${DRIVE_SCOPE} ${EMAIL_SCOPE}`,
    state,
    /* Offline and a forced consent screen, together, are what produce a
       refresh token. Google sends one only on a fresh grant, so an
       admin who has connected before and is reconnecting would
       otherwise get an access token good for an hour and nothing that
       survives it. */
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

interface TokenReply {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function googleToken(env: Env, body: Record<string, string>): Promise<TokenReply> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      ...body,
    }),
  });
  const json = (await res.json()) as TokenReply;
  if (!res.ok || json.error) {
    throw new BackupError(
      `Google refused: ${json.error_description || json.error || res.status}`,
    );
  }
  return json;
}

/** Finish the consent round trip and remember the Drive. */
export async function saveLink(
  env: Env,
  code: string,
  redirectUri: string,
  adminId: string,
): Promise<void> {
  const tok = await googleToken(env, {
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  if (!tok.refresh_token) {
    throw new BackupError(
      'Google did not send a refresh token. Disconnect this app at ' +
        'myaccount.google.com/permissions and connect again.',
    );
  }

  let email: string | null = null;
  try {
    const who = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
    email = ((await who.json()) as { email?: string }).email ?? null;
  } catch {
    /* The address is a courtesy on the page, not something to fail on. */
  }

  await env.DB.prepare(
    `INSERT INTO drive_link (id, account_email, refresh_token, folder_id, connected_at, connected_by)
     VALUES ('the', ?1, ?2, NULL, ?3, ?4)
     ON CONFLICT(id) DO UPDATE SET
       account_email = excluded.account_email,
       refresh_token = excluded.refresh_token,
       folder_id     = NULL,
       connected_at  = excluded.connected_at,
       connected_by  = excluded.connected_by`,
  )
    .bind(email, await sealToken(env.SESSION_SECRET, tok.refresh_token), now(), adminId)
    .run();
}

export async function forgetLink(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM drive_link WHERE id = 'the'").run();
}

/** An access token, minted fresh from the stored refresh token. */
async function accessToken(env: Env, link: DriveLink): Promise<string> {
  const tok = await googleToken(env, {
    refresh_token: await openToken(env.SESSION_SECRET, link.refresh_token),
    grant_type: 'refresh_token',
  });
  if (!tok.access_token) throw new BackupError('Google returned no access token.');
  return tok.access_token;
}

/* ------------------------------------------------------------------ *
 * The folder the backups go in
 * ------------------------------------------------------------------ */

async function folderFor(env: Env, link: DriveLink, token: string, name: string): Promise<string> {
  if (link.folder_id) {
    /* Still there? An admin who tidied their Drive should get a new
       folder rather than an error nobody can act on. */
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(link.folder_id)}?fields=id,trashed`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (res.ok) {
      const f = (await res.json()) as { trashed?: boolean };
      if (!f.trashed) return link.folder_id;
    }
  }

  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
  });
  if (!res.ok) throw new BackupError(`Could not make the Drive folder: ${await short(res)}`);
  const id = ((await res.json()) as { id?: string }).id;
  if (!id) throw new BackupError('Drive made a folder but did not say which.');

  await env.DB.prepare("UPDATE drive_link SET folder_id = ? WHERE id = 'the'").bind(id).run();
  return id;
}

async function short(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  return `${res.status} ${text.slice(0, 200)}`;
}

/* ------------------------------------------------------------------ *
 * Asking Cloudflare for the dump
 * ------------------------------------------------------------------ */

interface ExportReply {
  success?: boolean;
  errors?: { message?: string }[];
  result?: {
    at_bookmark?: string;
    status?: string;
    error?: string;
    result?: { filename?: string; signed_url?: string };
  };
}

function cfConfigured(env: Env): string | null {
  if (!env.CF_ACCOUNT_ID) return 'CF_ACCOUNT_ID is not set in wrangler.toml.';
  if (!env.D1_DATABASE_ID) return 'D1_DATABASE_ID is not set in wrangler.toml.';
  if (!env.CF_API_TOKEN) return 'The CF_API_TOKEN secret is not set.';
  return null;
}

async function callExport(env: Env, body: Record<string, unknown>): Promise<ExportReply> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${env.D1_DATABASE_ID}/export`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CF_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  if (res.status === 401 || res.status === 403)
    throw new BackupError(
      'Cloudflare rejected the API token. It needs D1:Edit on this account.',
    );
  const json = (await res.json()) as ExportReply;
  if (!res.ok || json.success === false) {
    const why = json.errors?.[0]?.message ?? `HTTP ${res.status}`;
    throw new BackupError(`Cloudflare refused the export: ${why}`);
  }
  return json;
}

/**
 * Start a dump and wait for it, politely.
 *
 * The first call starts the job and answers with a bookmark; the same
 * endpoint, given that bookmark, says whether it is finished. Each
 * poll is a subrequest and a free-plan request gets fifty, so the
 * ceiling here is a budget as much as it is patience.
 */
async function signedDumpUrl(env: Env): Promise<{ url: string; filename: string }> {
  let reply = await callExport(env, { output_format: 'polling' });
  const bookmark = reply.result?.at_bookmark;

  for (let tries = 0; tries < 18; tries++) {
    const r = reply.result;
    if (r?.status === 'error') throw new BackupError(`Cloudflare's export failed: ${r.error ?? ''}`);
    const url = r?.result?.signed_url;
    if (url) return { url, filename: r?.result?.filename ?? 'd1.sql' };

    await new Promise((done) => setTimeout(done, 2000));
    reply = await callExport(env, {
      output_format: 'polling',
      ...(bookmark ? { current_bookmark: bookmark } : {}),
    });
  }
  throw new BackupError(
    'The database export is taking unusually long. Nothing was harmed — try again in a minute.',
  );
}

/* ------------------------------------------------------------------ *
 * The backup itself
 * ------------------------------------------------------------------ */

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * Dump the database and put it in the Drive.
 *
 * One request start to finish. There is no wall-clock limit on an HTTP
 * request, the polling above is bounded, and the upload is a stream —
 * so the expensive-looking part of this function costs almost no CPU
 * and the whole thing fits inside the free plan.
 */
export async function runBackup(
  env: Env,
  adminId: string,
  siteName: string,
): Promise<BackupRun> {
  const startedAt = now();
  const id = newId('bk');

  const record = async (
    status: 'done' | 'failed',
    o: { fileName?: string; fileId?: string; bytes?: number; detail?: string },
  ) => {
    const run: BackupRun = {
      id,
      started_at: startedAt,
      finished_at: now(),
      status,
      file_name: o.fileName ?? null,
      file_id: o.fileId ?? null,
      bytes: o.bytes ?? null,
      detail: o.detail ?? null,
      started_by: adminId,
    };
    await env.DB.prepare(
      `INSERT INTO backup_runs
         (id, started_at, finished_at, status, file_name, file_id, bytes, detail, started_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(
        run.id, run.started_at, run.finished_at, run.status,
        run.file_name, run.file_id, run.bytes, run.detail, run.started_by,
      )
      .run();
    return run;
  };

  try {
    const missing = cfConfigured(env);
    if (missing) throw new BackupError(missing);

    const link = await getLink(env);
    if (!link) throw new BackupError('No Google Drive is connected yet.');

    const token = await accessToken(env, link);
    const folder = await folderFor(env, link, token, `${siteName} backups`);
    const { url } = await signedDumpUrl(env);

    const dump = await fetch(url);
    if (!dump.ok || !dump.body)
      throw new BackupError(`Could not fetch the dump: ${await short(dump)}`);

    /* Drive wants the length up front for a resumable upload, and the
       signed URL gives it. Without it there is nothing to stream into
       and the only alternative is holding the file in memory, which is
       the one thing this whole design exists to avoid. */
    const length = Number(dump.headers.get('content-length') ?? 0);
    if (!length)
      throw new BackupError('The dump arrived without a length, so it cannot be streamed.');

    const name = `${stamp()}-database.sql`;

    const begin = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': 'application/sql',
          'x-upload-content-length': String(length),
        },
        body: JSON.stringify({ name, parents: [folder] }),
      },
    );
    if (!begin.ok) throw new BackupError(`Drive would not start the upload: ${await short(begin)}`);
    const session = begin.headers.get('location');
    if (!session) throw new BackupError('Drive started an upload but gave no address for it.');

    /* The one line the whole file is arranged around: Cloudflare's
       bytes go straight into Google's, and this Worker never sees
       them. */
    const put = await fetch(session, {
      method: 'PUT',
      headers: { 'content-length': String(length), 'content-type': 'application/sql' },
      body: dump.body,
    });
    if (!put.ok) throw new BackupError(`Drive refused the upload: ${await short(put)}`);

    const fileId = ((await put.json().catch(() => ({}))) as { id?: string }).id;
    return await record('done', { fileName: name, fileId, bytes: length });
  } catch (e) {
    const known = e instanceof BackupError;
    if (!known) console.error('backup failed', e);
    return await record('failed', {
      detail: known ? (e as Error).message : 'Something unexpected went wrong. Check the logs.',
    });
  }
}

/* ------------------------------------------------------------------ *
 * "Can you reach everything?" — changes nothing
 * ------------------------------------------------------------------ */

export async function checkBackup(env: Env): Promise<string[]> {
  const notes: string[] = [];

  const missing = cfConfigured(env);
  if (missing) notes.push(`Cloudflare: ${missing}`);
  else {
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${env.D1_DATABASE_ID}`,
        { headers: { authorization: `Bearer ${env.CF_API_TOKEN}` } },
      );
      notes.push(
        res.ok
          ? 'Cloudflare: the API token can see the database.'
          : `Cloudflare: the API token was refused (${res.status}). It needs D1:Edit.`,
      );
    } catch (e) {
      notes.push(`Cloudflare: could not be reached — ${(e as Error).message}`);
    }
  }

  const link = await getLink(env);
  if (!link) {
    notes.push('Google Drive: not connected.');
    return notes;
  }
  try {
    const token = await accessToken(env, link);
    const res = await fetch(
      'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress),storageQuota(limit,usage)',
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      notes.push(`Google Drive: refused (${res.status}). Reconnect it.`);
      return notes;
    }
    const about = (await res.json()) as {
      user?: { emailAddress?: string };
      storageQuota?: { limit?: string; usage?: string };
    };
    const q = about.storageQuota;
    const gb = (v?: string) => (v ? (Number(v) / 1024 ** 3).toFixed(1) + ' GB' : '—');
    notes.push(
      `Google Drive: reachable as ${about.user?.emailAddress ?? 'that account'}` +
        (q?.limit ? ` · ${gb(q.usage)} used of ${gb(q.limit)}` : ''),
    );
  } catch (e) {
    notes.push(`Google Drive: ${(e as Error).message}`);
  }
  return notes;
}

/** The last few runs, newest first. */
export async function recentRuns(env: Env, limit = 5): Promise<BackupRun[]> {
  const r = await env.DB.prepare(
    'SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT ?1',
  )
    .bind(limit)
    .all<BackupRun>();
  return r.results ?? [];
}
