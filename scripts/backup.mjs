#!/usr/bin/env node
/* ==================================================================
 * The whole backup: the database and the recordings, into Google Drive.
 *
 *   node scripts/backup.mjs              the weekly job
 *   node scripts/backup.mjs --check      can I reach everything? (changes nothing)
 *   node scripts/backup.mjs --db-only    skip the media
 *   node scripts/backup.mjs --verify     re-check what's already there, download nothing
 *   node scripts/backup.mjs --dry-run    say what it would do
 *
 * Settings come from the environment, or from ~/.sruti-backup.env,
 * which is a plain `KEY=value` file. Run it by hand once; then let
 * launchd run it weekly — see BACKUP.md.
 *
 * ---------------------------------------------------------------
 * Three ideas hold this together.
 *
 * 1. **The database dump is the manifest.** Which recordings matter is
 *    decided by what the database references, not by what happens to be
 *    sitting in the bucket. So an orphaned upload is never mistaken for
 *    data, and a file that has gone missing from R2 is noticed here
 *    rather than by a student pressing play.
 *
 * 2. **Media copies forward, never back.** A recording deleted from R2
 *    stays in the backup. This is a copy, not a mirror; there is no
 *    code path in this program that deletes a media file.
 *
 * 3. **A bad run must not replace a good backup.** Every check that can
 *    fail, fails *before* anything in Drive is touched.
 * ================================================================== */

import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mediaKeysFromDump } from './lib/media-keys.mjs';
import { R2 } from './lib/r2.mjs';

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = new Set(process.argv.slice(2));
const MODE = {
  check: argv.has('--check'),
  dbOnly: argv.has('--db-only'),
  verify: argv.has('--verify'),
  dryRun: argv.has('--dry-run'),
};

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

await loadEnvFile(join(homedir(), '.sruti-backup.env'));

const CFG = {
  db: env('DB', 'sruti'),
  target: env('TARGET', '--remote'), // --local for a rehearsal
  keep: Number(env('KEEP', '12')), // weeks of database dumps
  dest: env('DEST', defaultDriveFolder()),
  quotaGb: Number(env('QUOTA_GB', '15')), // free Google Drive, shared with Gmail
  parallel: Math.max(1, Number(env('PARALLEL', '4'))),
  r2: {
    accountId: env('R2_ACCOUNT_ID', ''),
    accessKeyId: env('R2_ACCESS_KEY_ID', ''),
    secretAccessKey: env('R2_SECRET_ACCESS_KEY', ''),
    bucket: env('R2_BUCKET', 'sruti-media'),
    endpoint: env('R2_ENDPOINT', ''),
  },
};

const STAMP = new Date().toISOString().slice(0, 10);
const DB_DIR = join(CFG.dest, 'database');
const MEDIA_DIR = join(CFG.dest, 'media');
const MANIFEST = join(MEDIA_DIR, 'manifest.json');

const problems = [];
let mediaStats = null;

/* ------------------------------------------------------------------ */

try {
  await main();
} catch (e) {
  die(e.message || String(e));
}

async function main() {
  log(`backup ${STAMP} → ${CFG.dest}`);

  if (MODE.check) return check();

  /* 1. Is Google Drive actually there?
     Writing into a folder Drive isn't syncing produces a backup that
     exists only on this Mac — the exact failure this exists to avoid.
     So check, and refuse rather than pretend. */
  await ensureDest();

  const tmp = await mkdtemp(join(tmpdir(), 'sruti-backup-'));

  /* 2. The database. */
  const dumpPath = MODE.verify ? await newestDump(tmp) : await exportDatabase(tmp);

  if (!MODE.verify) {
    await verifyDump(dumpPath); // exits if this isn't a real backup
    await storeDump(dumpPath);
    await pruneDumps();
  }

  /* 3. The recordings, driven by what that dump references. */
  if (!MODE.dbOnly) {
    const sql = await readFile(dumpPath, 'utf8');
    mediaStats = await syncMedia(mediaKeysFromDump(sql));
  }

  /* 4. Leave something a person can read, and something a program can. */
  if (!MODE.dryRun && !MODE.verify) await writeStatus();

  await rm(tmp, { recursive: true, force: true });

  report();
}

/* ------------------------------------------------------------------ *
 * The database
 * ------------------------------------------------------------------ */

async function exportDatabase(tmp) {
  const out = join(tmp, `${CFG.db}-${STAMP}.sql`);
  log('exporting the database');
  const r = await run('npx', ['--yes', 'wrangler@4', 'd1', 'export', CFG.db, CFG.target, '--output', out]);
  if (r.code !== 0 || !existsSync(out))
    die(`wrangler could not export the database\n${indent(r.err || r.out)}`);
  const { size } = await stat(out);
  log(`  ${human(size)} of SQL`);
  return out;
}

/* An empty dump is the failure that looks like success. backup-report
   exits non-zero when the users table is empty, which stops us here
   rather than overwriting last week's good copy with this week's bad
   one. */
async function verifyDump(dump) {
  log('checking what was captured');
  const r = await run('node', [join(PROJECT, 'scripts/backup-report.mjs'), dump]);
  process.stdout.write(indent(r.out));
  if (r.code !== 0) die('that dump does not look like a real backup — keeping the old ones');
}

async function storeDump(dump) {
  if (MODE.dryRun) return log(`would store ${base(dump)}.gz`);

  // The report has to be taken from the SQL, before it is compressed —
  // reading a .gz as text reports a perfectly healthy zero rows.
  const r = await run('node', [join(PROJECT, 'scripts/backup-report.mjs'), dump, '--json']);

  await mkdir(DB_DIR, { recursive: true });
  const gz = join(DB_DIR, `${base(dump)}.gz`);
  await pipeline(createReadStream(dump), createGzip({ level: 9 }), createWriteStream(`${gz}.part`));
  await rename(`${gz}.part`, gz);
  await writeFile(join(DB_DIR, `${CFG.db}-${STAMP}.report.json`), r.out);
  log(`  wrote ${base(gz)} (${human((await stat(gz)).size)})`);
}

/* Deleting the oldest by name works because the name is a date. */
async function pruneDumps() {
  // On a dry run, or the very first one, there is no folder yet to prune.
  const dumps = (await readdir(DB_DIR).catch(() => [])).filter((f) => f.endsWith('.sql.gz')).sort();
  if (dumps.length <= CFG.keep) return;
  for (const old of dumps.slice(0, dumps.length - CFG.keep)) {
    log(`  pruning ${old}`);
    if (MODE.dryRun) continue;
    await rm(join(DB_DIR, old), { force: true });
    await rm(join(DB_DIR, old.replace(/\.sql\.gz$/, '.report.json')), { force: true });
  }
}

async function newestDump(tmp) {
  const dumps = (await readdir(DB_DIR).catch(() => [])).filter((f) => f.endsWith('.sql.gz')).sort();
  if (!dumps.length) die(`Nothing to verify: no dumps in ${DB_DIR}`);
  const gz = join(DB_DIR, dumps.at(-1));
  const out = join(tmp, dumps.at(-1).replace(/\.gz$/, ''));
  log(`verifying against ${dumps.at(-1)}`);
  const { createGunzip } = await import('node:zlib');
  await pipeline(createReadStream(gz), createGunzip(), createWriteStream(out));
  return out;
}

/* ------------------------------------------------------------------ *
 * The recordings
 * ------------------------------------------------------------------ */

async function syncMedia(wanted) {
  if (!wanted.size) {
    log('no recordings referenced by the database yet — nothing to copy');
    return { wanted: 0, already: 0, copied: 0, bytes: 0, missing: [] };
  }

  /* No R2 credentials is a reason not to copy recordings, not a reason
     to throw away a database dump that is already safely in Drive. It
     is reported like any other problem, and the run still ends tidily
     with a status file that says what happened. */
  const r2 = makeR2();
  if (!r2) {
    problems.push(
      'No R2 credentials, so the recordings were not backed up — only the database was.\n' +
        '      Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in ~/.sruti-backup.env\n' +
        '      (BACKUP.md has the steps), or pass --db-only to stop being told about it.',
    );
    return { wanted: wanted.size, already: 0, copied: 0, bytes: 0, missing: [] };
  }
  await mkdir(MEDIA_DIR, { recursive: true });
  const manifest = await readManifest();

  /* What is already here? Trust the file on disk over the manifest —
     the manifest is a cache, the file is the backup. A file whose size
     disagrees with what we recorded is treated as not there. */
  const need = [];
  let already = 0;
  for (const key of wanted.keys()) {
    const noted = manifest.files[key];
    const local = await stat(join(MEDIA_DIR, key)).catch(() => null);
    if (local && local.isFile() && (!noted || noted.size === local.size)) {
      already++;
      if (!noted) manifest.files[key] = { size: local.size, at: STAMP };
    } else {
      need.push(key);
    }
  }

  log(`recordings: ${wanted.size} referenced, ${already} already backed up, ${need.length} to fetch`);
  if (!need.length) {
    if (!MODE.dryRun && !MODE.verify) await writeManifest(manifest);
    return { wanted: wanted.size, already, copied: 0, bytes: 0, missing: [] };
  }
  if (MODE.verify) {
    problems.push(`${need.length} referenced file(s) are not in the backup — run without --verify`);
    return { wanted: wanted.size, already, copied: 0, bytes: 0, missing: need };
  }

  /* How big is this going to be? Asked before anything is downloaded,
     because the answer can be "don't". A key R2 has never heard of is
     data the app has already lost — reported, not fatal to the rest. */
  log('  asking R2 how big that is');
  const sizes = new Map();
  const gone = [];
  await inParallel(need, CFG.parallel, async (key) => {
    const h = await r2.head(key);
    if (h) sizes.set(key, h.size);
    else gone.push(key);
  });

  const incoming = [...sizes.values()].reduce((a, b) => a + b, 0);
  if (gone.length) {
    problems.push(
      `${gone.length} file(s) the database references are not in R2 — the app cannot play them:\n` +
        gone.slice(0, 10).map((k) => `      ${wanted.get(k)}  ${k}`).join('\n') +
        (gone.length > 10 ? `\n      …and ${gone.length - 10} more` : ''),
    );
  }
  if (!sizes.size) return { wanted: wanted.size, already, copied: 0, bytes: 0, missing: gone };

  /* Google Drive's free tier is 15 GB and it is shared with Gmail.
     Filling it doesn't just stop the media copying — Drive stops
     syncing everything, database dumps included. So this refuses to
     start a copy that would cross the line, and says by how much. */
  const used = await dirSize(CFG.dest);
  const quota = CFG.quotaGb * 1024 ** 3;
  if (CFG.quotaGb > 0 && used + incoming > quota) {
    problems.push(
      `Not copying media: ${human(used)} already in the backup folder + ${human(incoming)} to add ` +
        `would pass the ${CFG.quotaGb} GB you told me this Drive holds.\n` +
        `      The database dump is safely stored. Free space in Drive, raise QUOTA_GB, or\n` +
        `      keep media somewhere with more room — see BACKUP.md.`,
    );
    return { wanted: wanted.size, already, copied: 0, bytes: 0, missing: gone, skipped: sizes.size };
  }

  if (MODE.dryRun) {
    log(`  would fetch ${sizes.size} file(s), ${human(incoming)}`);
    return { wanted: wanted.size, already, copied: 0, bytes: incoming, missing: gone };
  }
  log(`  fetching ${sizes.size} file(s), ${human(incoming)}`);

  let copied = 0;
  let bytes = 0;
  const failed = [];
  await inParallel([...sizes.keys()], CFG.parallel, async (key) => {
    try {
      const got = await r2.download(key, join(MEDIA_DIR, key));
      if (!got) return failed.push(key);
      manifest.files[key] = { size: got.size, etag: got.etag, at: STAMP };
      copied++;
      bytes += got.size;
      if (copied % 25 === 0) log(`    ${copied}/${sizes.size}`);
    } catch (e) {
      failed.push(`${key} (${e.message})`);
    }
  });

  manifest.updated = new Date().toISOString();
  manifest.bucket = CFG.r2.bucket;
  await writeManifest(manifest);

  if (failed.length)
    problems.push(
      `${failed.length} file(s) would not copy:\n` +
        failed.slice(0, 10).map((k) => `      ${k}`).join('\n'),
    );

  log(`  copied ${copied} file(s), ${human(bytes)}`);
  return { wanted: wanted.size, already, copied, bytes, missing: gone, failed: failed.length };
}

async function readManifest() {
  try {
    const m = JSON.parse(await readFile(MANIFEST, 'utf8'));
    if (m && typeof m.files === 'object') return m;
  } catch {
    /* no manifest yet, or an unreadable one — the files on disk are the
       truth either way, so rebuild rather than refuse */
  }
  return { updated: null, bucket: CFG.r2.bucket, files: {} };
}

async function writeManifest(m) {
  m.updated ??= new Date().toISOString();
  await writeFile(`${MANIFEST}.part`, JSON.stringify(m, null, 1));
  await rename(`${MANIFEST}.part`, MANIFEST);
}

/* ------------------------------------------------------------------ *
 * --check: everything this needs, before it needs it
 * ------------------------------------------------------------------ */

async function check() {
  let ok = true;
  const say = (good, label, detail = '') => {
    console.log(`  ${good ? '  ok' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
    if (!good) ok = false;
  };

  const dest = existsSync(CFG.dest);
  say(dest, `Drive folder  ${CFG.dest}`, dest ? '' : "not there — is Google Drive for desktop signed in?");

  /* A real query, not `d1 list`: it proves the database can be read
     with whatever credentials are in play, and it works the same for
     --local as for --remote. */
  const w = await run('npx', [
    '--yes', 'wrangler@4', 'd1', 'execute', CFG.db, CFG.target,
    '--command', 'SELECT count(*) AS n FROM users',
  ]);
  say(
    w.code === 0,
    `database      ${CFG.db} ${CFG.target}`,
    w.code === 0 ? '' : `cannot read it — ${firstLine(w.err || w.out) || 'try `npx wrangler login`'}`,
  );

  if (!CFG.r2.accountId || !CFG.r2.accessKeyId || !CFG.r2.secretAccessKey) {
    say(false, `R2 bucket     ${CFG.r2.bucket}`, 'R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY not set — see BACKUP.md');
  } else {
    const res = await makeR2().check();
    say(res.ok, `R2 bucket     ${CFG.r2.bucket}`, res.ok ? '' : `${res.status}: ${res.hint}`);
  }

  if (existsSync(CFG.dest)) {
    const used = await dirSize(CFG.dest);
    const room = CFG.quotaGb > 0 ? ` of ${CFG.quotaGb} GB` : '';
    say(true, `space used    ${human(used)}${room}`);
  }

  console.log('');
  if (!ok) process.exit(1);
  console.log('  Everything this needs is reachable.\n');
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

async function writeStatus() {
  const kept = (await readdir(DB_DIR).catch(() => [])).filter((f) => f.endsWith('.sql.gz')).length;
  const lines = [
    `Last backup: ${new Date().toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })}`,
    `Database:    ${CFG.db}-${STAMP}.sql.gz`,
    `Kept:        ${kept} weekly dump${kept === 1 ? '' : 's'}`,
  ];
  if (mediaStats)
    lines.push(
      `Recordings:  ${mediaStats.already + mediaStats.copied} of ${mediaStats.wanted} backed up` +
        (mediaStats.copied ? ` (${mediaStats.copied} new this week)` : ''),
    );
  lines.push(`Folder size: ${human(await dirSize(CFG.dest))}`);
  lines.push('');
  if (problems.length) {
    lines.push('NEEDS ATTENTION');
    for (const p of problems) lines.push(`  - ${p.replace(/\n\s+/g, '\n    ')}`);
    lines.push('');
  }
  lines.push('To restore the database:  node scripts/restore.mjs <dump.sql> --remote --wipe');
  lines.push('To restore recordings:    node scripts/restore-media.mjs');
  lines.push('The full procedure is in BACKUP.md.');

  await writeFile(join(CFG.dest, 'LAST BACKUP.txt'), lines.join('\n') + '\n');
  await writeFile(
    join(CFG.dest, 'status.json'),
    JSON.stringify(
      { at: new Date().toISOString(), db: CFG.db, stamp: STAMP, media: mediaStats, problems, ok: !problems.length },
      null,
      1,
    ),
  );
}

function report() {
  if (!problems.length) {
    log('done — nothing needs attention');
    return;
  }
  console.log('');
  for (const p of problems) console.error(`  !! ${p}`);
  console.error('');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

/** An R2 client, or null when it hasn't been given credentials yet. */
function makeR2() {
  try {
    return new R2(CFG.r2);
  } catch {
    return null;
  }
}

async function ensureDest() {
  if (existsSync(CFG.dest)) return;
  const parent = dirname(CFG.dest);
  if (!existsSync(parent))
    die(`No such folder: ${parent}
   Is Google Drive for desktop installed and signed in?
   Look under ~/Library/CloudStorage/ for the exact name, then set DEST.`);
  await mkdir(CFG.dest, { recursive: true });
  log(`created ${CFG.dest}`);
}

/** Run `work` over `items`, `n` at a time. */
async function inParallel(items, n, work) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      for (let item; (item = queue.shift()) !== undefined; ) await work(item);
    }),
  );
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: PROJECT, env: process.env });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ code: 127, out, err: e.message }));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

async function dirSize(dir) {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else total += (await stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

async function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const v = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    process.env[m[1]] ??= v;
  }
}

function env(k, d) {
  const v = process.env[k];
  return v === undefined || v === '' ? d : v;
}

/* Drive for desktop mounts under ~/Library/CloudStorage/GoogleDrive-<email>,
   and the email is the part we can't guess — so look for it rather than
   make the person spell out a path they never type. */
function defaultDriveFolder() {
  const cloud = join(homedir(), 'Library', 'CloudStorage');
  try {
    const drive = readdirSync(cloud).find((d) => d.startsWith('GoogleDrive-'));
    if (drive) return join(cloud, drive, 'My Drive', 'RP Sajeev Music backups');
  } catch {
    /* not a Mac, or Drive isn't installed — fall through to the plain path */
  }
  return join(homedir(), 'Google Drive', 'RP Sajeev Music backups');
}

/* Declarations, not consts: main() runs before the bottom of this file
   is evaluated, and a const down here is still in its dead zone when
   the first log line wants it. */
function base(p) {
  return p.split('/').pop();
}
function indent(s) {
  return (s || '').split('\n').map((l) => (l ? `    ${l}` : l)).join('\n');
}
function firstLine(s) {
  return (s || '').split('\n').map((l) => l.trim()).find((l) => l && !/^[✘✔🌀]?\s*$/.test(l)) || '';
}
function human(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

function log(...a) {
  console.log(`${new Date().toTimeString().slice(0, 8)}  ${a.join(' ')}`);
}
function die(msg) {
  console.error(`\n!! ${msg}\n`);
  process.exit(1);
}
