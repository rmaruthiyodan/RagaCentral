#!/usr/bin/env node
/* ==================================================================
 * Put the recordings back into R2 from the Google Drive backup.
 *
 *   node scripts/restore-media.mjs            what it would do
 *   node scripts/restore-media.mjs --yes      actually do it
 *   node scripts/restore-media.mjs --force    re-upload even what's there
 *
 * `restore.mjs` brings the database back; this brings back the files
 * the database points at. Run the database one first, so this knows
 * which files are still referenced.
 *
 * Two deliberate refusals:
 *   - **Nothing happens without --yes.** The default run reads, counts
 *     and prints. A restore is usually run by someone having a bad day;
 *     it should not be possible to start one by pressing up-arrow.
 *   - **An object already in R2 is left alone** unless you pass
 *     --force. Restoring into a half-good bucket is the common case,
 *     and overwriting the good half with an older copy would turn a
 *     partial loss into a total one.
 *
 * This needs an R2 token with **Object Read & Write** — the backup's
 * read-only token cannot do it, which is the point of it being
 * read-only.
 * ================================================================== */

import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { R2 } from './lib/r2.mjs';
import { mediaKeysFromDump } from './lib/media-keys.mjs';

const argv = new Set(process.argv.slice(2));
const GO = argv.has('--yes');
const FORCE = argv.has('--force');

await loadEnvFile(join(homedir(), '.sruti-backup.env'));

const DEST = env('DEST', join(homedir(), 'Google Drive', 'RP Sajeev Music backups'));
const MEDIA_DIR = env('MEDIA_DIR', join(DEST, 'media'));
const PARALLEL = Math.max(1, Number(env('PARALLEL', '4')));

if (!existsSync(MEDIA_DIR)) die(`No media backup at ${MEDIA_DIR}\n   Set DEST or MEDIA_DIR to the backup folder.`);

const r2 = new R2({
  accountId: env('R2_ACCOUNT_ID', ''),
  accessKeyId: env('R2_ACCESS_KEY_ID', ''),
  secretAccessKey: env('R2_SECRET_ACCESS_KEY', ''),
  bucket: env('R2_BUCKET', 'sruti-media'),
  endpoint: env('R2_ENDPOINT', ''),
});

/* Every file in the backup, as the key it will go back under. */
const files = [];
for await (const p of walk(MEDIA_DIR)) {
  const key = relative(MEDIA_DIR, p).split(/[\\/]/).join('/');
  if (key === 'manifest.json' || key.endsWith('.part')) continue;
  files.push({ key, path: p, size: (await stat(p)).size });
}

if (!files.length) die(`${MEDIA_DIR} has no files in it.`);

/* If a dump was named, restore only what it still references — a bucket
   should not be refilled with recordings the teacher deleted years ago. */
const dumpArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
let wanted = null;
if (dumpArg) {
  if (!existsSync(dumpArg)) die(`No such dump: ${dumpArg}`);
  wanted = mediaKeysFromDump(await readFile(dumpArg, 'utf8'));
  if (!wanted.size) die(`${dumpArg} references no media at all — is it a real dump?`);
}

console.log(`\n  backup folder   ${MEDIA_DIR}`);
console.log(`  bucket          ${r2.bucket}`);
console.log(`  files in backup ${files.length} (${human(files.reduce((a, f) => a + f.size, 0))})`);
if (wanted) console.log(`  referenced by   ${dumpArg} — ${wanted.size} of them`);

const candidates = wanted ? files.filter((f) => wanted.has(f.key)) : files;

console.log('\n  checking what is already in R2…');
const todo = [];
let present = 0;
await inParallel(candidates, PARALLEL, async (f) => {
  if (FORCE) return void todo.push(f);
  const h = await r2.head(f.key).catch(() => null);
  if (h && h.size === f.size) present++;
  else todo.push(f);
});

console.log(`  already there   ${present}`);
console.log(`  to upload       ${todo.length} (${human(todo.reduce((a, f) => a + f.size, 0))})\n`);

if (!todo.length) {
  console.log('  Nothing to do — R2 already has everything in this backup.\n');
  process.exit(0);
}
if (!GO) {
  console.log('  Nothing was uploaded. Run again with --yes to do it.\n');
  process.exit(0);
}

let done = 0;
const failed = [];
await inParallel(todo, PARALLEL, async (f) => {
  try {
    await r2.upload(f.key, await readFile(f.path), contentTypeFor(f.key));
    if (++done % 25 === 0) console.log(`    ${done}/${todo.length}`);
  } catch (e) {
    failed.push(`${f.key} (${e.message})`);
  }
});

console.log(`\n  uploaded ${done} file(s)`);
if (failed.length) {
  console.error(`  ${failed.length} failed:`);
  for (const f of failed.slice(0, 20)) console.error(`    ${f}`);
  console.error('');
  process.exit(1);
}
console.log('  Done. Open a song and press play before you call it fixed.\n');

/* ------------------------------------------------------------------ */

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

async function inParallel(items, n, work) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      for (let item; (item = queue.shift()) !== undefined; ) await work(item);
    }),
  );
}

/* The app stores the real type on the row, but the row may be what we
   are restoring *from* — so guess from the name and let the database be
   the authority once it is back. */
function contentTypeFor(key) {
  const ext = key.split('.').pop().toLowerCase();
  return (
    {
      mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
      ogg: 'audio/ogg', opus: 'audio/ogg', webm: 'video/webm', mp4: 'video/mp4',
      mov: 'video/quicktime', png: 'image/png', jpg: 'image/jpeg',
      jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    }[ext] || 'application/octet-stream'
  );
}

async function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    process.env[m[1]] ??= m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
}

function env(k, d) {
  const v = process.env[k];
  return v === undefined || v === '' ? d : v;
}

/* A declaration, not a const: the body of this file runs top to bottom
   and reaches the first `human(…)` long before a const down here is
   initialised. */
function human(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

function die(msg) {
  console.error(`\n!! ${msg}\n`);
  process.exit(1);
}
