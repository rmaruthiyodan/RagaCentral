#!/usr/bin/env node
/* ==================================================================
 * What is actually inside a backup?
 *
 * Reads a .sql dump produced by `wrangler d1 export` and reports the
 * tables it contains, how many rows each holds, and a checksum of the
 * file. Run it on every fresh backup — a dump that is present but
 * empty is the failure this catches, and it is the one that looks
 * like success until the day you need it.
 *
 *   node scripts/backup-report.mjs backup.sql            # human
 *   node scripts/backup-report.mjs backup.sql --json     # machine
 * ================================================================== */

import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const file = process.argv[2];
const asJson = process.argv.includes('--json');

if (!file) {
  console.error('usage: node scripts/backup-report.mjs <dump.sql> [--json]');
  process.exit(2);
}

const sql = readFileSync(file, 'utf8');
const bytes = statSync(file).size;
const sha = createHash('sha256').update(sql).digest('hex');

/* The dump is one statement per line for inserts, which is what makes
   counting rows a matter of counting lines rather than parsing SQL. */
const tables = new Map();
for (const m of sql.matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?["`]?([A-Za-z0-9_]+)["`]?/gm)) {
  tables.set(m[1], 0);
}
for (const m of sql.matchAll(/^INSERT INTO ["`]?([A-Za-z0-9_]+)["`]?/gm)) {
  tables.set(m[1], (tables.get(m[1]) ?? 0) + 1);
}

const rows = [...tables.entries()].sort((a, b) => a[0].localeCompare(b[0]));
const total = rows.reduce((n, [, c]) => n + c, 0);

/* A backup with no users in it cannot be a good backup of this app. */
const problems = [];
if (!tables.has('users')) problems.push('no users table — is this a schema-only export?');
if ((tables.get('users') ?? 0) === 0) problems.push('users table is empty');
if (!total) problems.push('no rows at all');

if (asJson) {
  console.log(JSON.stringify({
    file, bytes, sha256: sha, total_rows: total,
    tables: Object.fromEntries(rows), problems,
  }, null, 2));
} else {
  console.log(`\n  ${file}`);
  console.log(`  ${(bytes / 1024).toFixed(1)} KB · sha256 ${sha.slice(0, 16)}…\n`);
  const w = Math.max(...rows.map(([t]) => t.length), 5);
  for (const [t, c] of rows) {
    console.log(`  ${t.padEnd(w)}  ${String(c).padStart(6)}${c === 0 ? '   (empty)' : ''}`);
  }
  console.log(`  ${'—'.repeat(w + 9)}`);
  console.log(`  ${'total'.padEnd(w)}  ${String(total).padStart(6)} rows\n`);
  if (problems.length) {
    console.log('  ⚠ ' + problems.join('\n  ⚠ ') + '\n');
  } else {
    console.log('  Looks like a real backup.\n');
  }
}

process.exit(problems.length ? 1 : 0);
