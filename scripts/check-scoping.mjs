#!/usr/bin/env node
/* ==================================================================
 * Does every query stay inside its project?
 *
 *   node scripts/check-scoping.mjs
 *
 * A project is a privacy boundary: one teacher's students, recordings
 * and lesson notes must not be reachable from another's. That boundary
 * is only as good as the weakest query, and there are ninety of them.
 * Reading them all once proves nothing about the ninety-first.
 *
 * So: find every SQL statement that touches a project-scoped table, and
 * insist it mentions project_id. Not proof of correctness — a query can
 * name the column and still compare it to the wrong thing — but it
 * catches the failure that actually happens, which is forgetting.
 *
 * A statement that genuinely does not need scoping says so for itself:
 *
 *     /* unscoped: <why> *\/
 *
 * on the line before, or `-- unscoped: <why>` inside the SQL. Each one
 * is listed in the output, so the exceptions stay visible rather than
 * accumulating quietly.
 * ================================================================== */

import { readFileSync, readdirSync } from 'node:fs';

/* Tables that carry project_id. The child tables (session_sections,
   slot_exceptions, recording_shares, note_shares) reach a project only
   through their parent, so a query touching one of those must join to
   the parent — which puts a scoped table in the statement anyway. */
const SCOPED = [
  'groups',
  'sections',
  'assignments',
  'recordings',
  'notes',
  'sessions',
  'class_slots',
];

const FILES = ['src/index.ts', ...readdirSync('src/views').map((f) => `src/views/${f}`)];

const touches = new RegExp(
  String.raw`\b(?:FROM|JOIN|UPDATE|INTO|DELETE\s+FROM)\s+(?:main\.)?"?(${SCOPED.join('|')})"?\b`,
  'i',
);

let bad = 0;
let ok = 0;
const waived = [];

for (const file of FILES) {
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lines = src.split('\n');

  /* Template literals and ordinary strings that look like SQL. Good
     enough: every query in this codebase is written as one literal
     passed to .prepare(). */
  const re = /(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*')/g;
  let m;
  while ((m = re.exec(src))) {
    const sql = m[1];
    if (!touches.test(sql)) continue;

    const lineNo = src.slice(0, m.index).split('\n').length;
    const before = lines.slice(Math.max(0, lineNo - 3), lineNo).join('\n');
    const waiver = /unscoped:\s*(.+)/.exec(sql) || /unscoped:\s*(.+)/.exec(before);

    if (waiver) {
      waived.push(`${file}:${lineNo}  ${waiver[1].replace(/\*\/.*$/, '').trim()}`);
      continue;
    }
    if (/\bproject_id\b/.test(sql)) {
      ok++;
      continue;
    }

    bad++;
    const first = sql.replace(/\s+/g, ' ').slice(1, 110);
    console.log(`\n  ${file}:${lineNo}`);
    console.log(`    ${first}…`);
  }
}

console.log(`\n${ok} scoped · ${waived.length} waived · ${bad} unscoped`);

if (waived.length) {
  console.log('\nDeliberately unscoped:');
  for (const w of waived) console.log('  ' + w);
}

if (bad) {
  console.log(
    `\n${bad} statement(s) touch a project's data without naming project_id.\n` +
      `Add the filter, or mark it /* unscoped: why */ if it genuinely does not need one.\n`,
  );
  process.exit(1);
}
console.log('\nevery query stays inside its project\n');
