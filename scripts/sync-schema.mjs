#!/usr/bin/env node
/**
 * Bring a live database's columns up to date with schema.sql.
 *
 * Why this exists: `CREATE TABLE IF NOT EXISTS` does nothing to a table that
 * already exists. So when a new version of schema.sql adds a column, an
 * upgraded database never gets it — and anything referring to that column
 * (an index, a query) then fails with "no such column".
 *
 * This reads the column list out of schema.sql, asks the database what it
 * actually has, and issues an ALTER TABLE ADD COLUMN for the difference.
 * It is driven entirely by schema.sql, so it stays correct as the schema
 * grows without anyone having to remember to write a migration.
 *
 *   node scripts/sync-schema.mjs            # local database (Docker, dev)
 *   node scripts/sync-schema.mjs --remote   # the real Cloudflare database
 *
 * Existing columns are never altered or dropped. This only ever adds.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REMOTE = process.argv.includes('--remote');
const DB = process.env.D1_NAME || 'sruti';
const SCHEMA = process.env.SCHEMA_FILE || './schema.sql';

/** Strip comments, then find each CREATE TABLE and its column definitions. */
function parseSchema(sql) {
  const clean = sql.replace(/--[^\n]*/g, '');
  const tables = new Map();

  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)\s*\(/gi;
  let m;
  while ((m = re.exec(clean))) {
    const name = m[1];
    // Walk forward to the matching close paren so nested parens
    // — REFERENCES users(id), UNIQUE(a, b) — don't end the block early.
    let depth = 1;
    let i = re.lastIndex;
    for (; i < clean.length && depth > 0; i++) {
      if (clean[i] === '(') depth++;
      else if (clean[i] === ')') depth--;
    }
    const body = clean.slice(re.lastIndex, i - 1);

    // Split on top-level commas only.
    const parts = [];
    let buf = '';
    let d = 0;
    for (const ch of body) {
      if (ch === '(') d++;
      if (ch === ')') d--;
      if (ch === ',' && d === 0) {
        parts.push(buf);
        buf = '';
      } else buf += ch;
    }
    parts.push(buf);

    const cols = [];
    for (const raw of parts) {
      const def = raw.trim().replace(/\s+/g, ' ');
      if (!def) continue;
      // Table-level constraints are not columns.
      if (/^(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|CONSTRAINT)\b/i.test(def)) continue;
      const colName = def.split(/\s/)[0].replace(/["`\[\]]/g, '');
      if (!colName) continue;
      cols.push({ name: colName, def });
    }
    tables.set(name, cols);
  }
  return tables;
}

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function liveColumns(table) {
  const out = wrangler([
    'd1', 'execute', DB, REMOTE ? '--remote' : '--local',
    '--command', `PRAGMA table_info(${table})`, '--json',
  ]);
  // Wrangler prints banners around the JSON, so take the first array in it.
  const start = out.indexOf('[');
  const parsed = JSON.parse(out.slice(start));
  const rows = parsed?.[0]?.results ?? [];
  return new Set(rows.map((r) => r.name));
}

const schema = parseSchema(readFileSync(SCHEMA, 'utf8'));
const statements = [];
let checked = 0;

for (const [table, cols] of schema) {
  let live;
  try {
    live = liveColumns(table);
  } catch {
    // The table doesn't exist yet — schema.sql will have just created it, so
    // nothing to reconcile. (Also covers a database that isn't there at all.)
    continue;
  }
  if (!live.size) continue;
  checked++;

  for (const col of cols) {
    if (live.has(col.name)) continue;

    // SQLite refuses to ADD COLUMN with PRIMARY KEY or UNIQUE, and refuses a
    // non-constant default. Anything like that needs a hand-written migration.
    if (/\b(PRIMARY\s+KEY|UNIQUE)\b/i.test(col.def)) {
      console.error(`  ! ${table}.${col.name} needs a manual migration (${col.def})`);
      continue;
    }
    // A NOT NULL column can only be added when it carries a default.
    if (/\bNOT\s+NULL\b/i.test(col.def) && !/\bDEFAULT\b/i.test(col.def)) {
      console.error(`  ! ${table}.${col.name} is NOT NULL with no default — needs a manual migration`);
      continue;
    }
    statements.push(`ALTER TABLE ${table} ADD COLUMN ${col.def};`);
  }
}

if (!statements.length) {
  console.log(`→ columns up to date (${checked} tables checked)`);
  process.exit(0);
}

console.log(`→ adding ${statements.length} missing column(s):`);
for (const s of statements) console.log(`    ${s}`);

for (const stmt of statements) {
  try {
    wrangler(['d1', 'execute', DB, REMOTE ? '--remote' : '--local', '--command', stmt]);
  } catch (err) {
    const text = String(err.stdout ?? '') + String(err.stderr ?? '');
    // Two processes racing, or a column added by hand in between. Not a failure.
    if (/duplicate column name/i.test(text)) continue;
    console.error(`  ! failed: ${stmt}`);
    console.error(text.trim().split('\n').slice(0, 4).join('\n'));
    process.exit(1);
  }
}
console.log('→ columns synced');
