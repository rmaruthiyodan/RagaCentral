#!/usr/bin/env node
/* ==================================================================
 * Put a backup back.
 *
 *   node scripts/restore.mjs backup.sql --local
 *   node scripts/restore.mjs backup.sql --remote --wipe
 *
 * A dump from `wrangler d1 export` carries CREATE TABLE without
 * IF NOT EXISTS, so it only applies cleanly to an empty database.
 * --wipe drops the tables the dump contains first, which is what you
 * want when restoring over a database that is still there but wrong.
 *
 * Nothing happens without an explicit target and, for --wipe, typing
 * the database name. A restore is the one operation where a slip is
 * unrecoverable, so this asks rather than assumes.
 * ================================================================== */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const DB = 'sruti';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const remote = args.includes('--remote');
const local = args.includes('--local');
const wipe = args.includes('--wipe');
const yes = args.includes('--yes');
const dry = args.includes('--dry-run');

if (!file || (!remote && !local) || (remote && local)) {
  console.error(`
  usage: node scripts/restore.mjs <dump.sql> (--local | --remote) [--wipe] [--yes] [--dry-run]

    --local     the database wrangler dev uses on this machine
    --remote    the live database on Cloudflare
    --wipe      drop the dump's tables first (needed unless the DB is empty)
    --yes       skip the confirmation — for scripts, not for people
    --dry-run   print what would run, touch nothing
`);
  process.exit(2);
}

const target = remote ? '--remote' : '--local';
const sql = readFileSync(file, 'utf8');

/* What are we about to put back? */
const tables = [...new Set([...sql.matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?["`]?([A-Za-z0-9_]+)["`]?/gm)].map((m) => m[1]))];
const counts = {};
for (const m of sql.matchAll(/^INSERT INTO ["`]?([A-Za-z0-9_]+)["`]?/gm)) {
  counts[m[1]] = (counts[m[1]] ?? 0) + 1;
}
const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);

if (!tables.length || !totalRows) {
  console.error(`\n  ${file} contains ${tables.length} tables and ${totalRows} rows — refusing to restore from it.`);
  console.error('  Run: node scripts/backup-report.mjs ' + file + '\n');
  process.exit(1);
}

function wrangler(extra, quiet = false) {
  try {
    return execFileSync('npx', ['wrangler', ...extra], {
      encoding: 'utf8',
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
  } catch (err) {
    if (quiet) throw err; // the caller is probing and handles it
    console.error('\n  wrangler failed. Nothing further was attempted.');
    console.error('  Command: wrangler ' + extra.join(' ') + '\n');
    process.exit(1);
  }
}

/** Row counts from the live database, for the before/after comparison. */
function liveCounts() {
  const out = {};
  for (const t of tables) {
    try {
      const raw = wrangler(
        ['d1', 'execute', DB, target, '--json', '--command', `SELECT COUNT(*) AS n FROM ${t};`],
        true,
      );
      out[t] = JSON.parse(raw.slice(raw.indexOf('[')))[0].results[0].n;
    } catch {
      out[t] = null; // table isn't there yet — a fresh database
    }
  }
  return out;
}

console.log(`\n  Restoring ${file}`);
console.log(`  into the ${remote ? 'LIVE Cloudflare' : 'local'} database "${DB}"`);
console.log(`  ${tables.length} tables · ${totalRows} rows\n`);

const before = liveCounts();
const existing = Object.entries(before).filter(([, n]) => n !== null && n > 0);
if (existing.length) {
  console.log('  That database is not empty. It currently holds:');
  for (const [t, n] of existing) console.log(`    ${t.padEnd(18)} ${n}`);
  console.log(wipe
    ? '\n  --wipe will DROP these tables and replace them with the backup.\n'
    : '\n  Without --wipe the restore will fail on the first CREATE TABLE.\n');
}

if (dry) {
  console.log('  Dry run. Would execute:');
  if (wipe) console.log(`    wrangler d1 execute ${DB} ${target} --file=<drops.sql>`);
  console.log(`    wrangler d1 execute ${DB} ${target} --file=${file}\n`);
  process.exit(0);
}

if (!yes) {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(
    wipe
      ? `  Type the database name (${DB}) to wipe and restore: `
      : '  Type yes to restore: ',
  );
  rl.close();
  const ok = wipe ? answer.trim() === DB : answer.trim().toLowerCase() === 'yes';
  if (!ok) {
    console.log('\n  Nothing was changed.\n');
    process.exit(1);
  }
}

if (wipe) {
  /* Two things make a wipe work on SQLite. Tables come down in the
     reverse of the order the dump creates them, so a child is gone
     before its parent; and foreign keys are deferred, because dropping
     a parent that a not-yet-dropped child still references otherwise
     fails with "no such table". Found by running the drill. */
  const drops = '/tmp/sruti-drop-' + Date.now() + '.sql';
  writeFileSync(
    drops,
    'PRAGMA defer_foreign_keys=TRUE;\n' +
      [...tables].reverse().map((t) => `DROP TABLE IF EXISTS ${t};`).join('\n') +
      '\n',
  );
  console.log('\n  → dropping tables');
  wrangler(['d1', 'execute', DB, target, '-y', `--file=${drops}`]);
  unlinkSync(drops);
}

console.log('\n  → applying the backup');
wrangler(['d1', 'execute', DB, target, '-y', `--file=${file}`]);

/* Indexes are not in the dump — schema.sql keeps them separate — so
   put them back, or the app is correct but slow. */
console.log('\n  → re-creating indexes');
wrangler(['d1', 'execute', DB, target, '-y', '--file=./indexes.sql']);

console.log('\n  → verifying\n');
const after = liveCounts();
let bad = 0;
const w = Math.max(...tables.map((t) => t.length));
for (const t of tables) {
  const want = counts[t] ?? 0;
  const got = after[t] ?? 0;
  const ok = want === got;
  if (!ok) bad++;
  console.log(`    ${t.padEnd(w)}  backup ${String(want).padStart(6)}   now ${String(got).padStart(6)}   ${ok ? 'ok' : 'MISMATCH'}`);
}

console.log(
  bad
    ? `\n  ${bad} table(s) do not match the backup. Do not assume this restore worked.\n`
    : '\n  Every table matches the backup. Sign in and play one recording before you call it done.\n',
);
process.exit(bad ? 1 : 0);
