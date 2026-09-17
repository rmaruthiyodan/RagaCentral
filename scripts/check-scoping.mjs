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

const YEL = '\u001b[33m';
const OFF = '\u001b[0m';

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

/* `users` is the trap. It has no project_id — identity is global, and a
   person can be in two projects — so the rule above cannot see it, and
   a query that reads or writes a user by id will happily cross into
   another practice. That is worse than anything the scoped tables can
   leak, because it is a person's name, email and phone rather than a
   row of song metadata.
   A users query inside the app therefore has to reach the project some
   other way: by joining project_members. Sign-in is the exception and
   lives in auth.ts, which is not checked. */
const touchesUsers =
  /\b(?:FROM|JOIN|UPDATE|INTO|DELETE\s+FROM)\s+(?:main\.)?"?users"?\b/i;
const reachesProject = /\bproject_members\b|\bproject_id\b/i;

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

  /* Comments have to go first. An apostrophe in prose — song's,
     teacher's — otherwise opens a "string" that swallows the real code
     after it, and the statements inside that span are never examined.
     The checker then reports zero problems for a reason that has
     nothing to do with the code being right. Blank them out rather than
     deleting, so line numbers still point at the truth. */
  const blanked = src
    .replace(/\/\*[\s\S]*?\*\//g, (m2) => m2.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m2, p1) => p1 + ' '.repeat(m2.length - p1.length));

  const re = /(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  let m;
  while ((m = re.exec(blanked))) {
    const sql = m[1];
    const isScoped = touches.test(sql);
    const isUsers = touchesUsers.test(sql);
    if (!isScoped && !isUsers) continue;

    const lineNo = blanked.slice(0, m.index).split('\n').length;
    const before = lines.slice(Math.max(0, lineNo - 3), lineNo).join('\n');
    const waiver = /unscoped:\s*(.+)/.exec(sql) || /unscoped:\s*(.+)/.exec(before);

    if (waiver) {
      waived.push(`${file}:${lineNo}  ${waiver[1].replace(/\*\/.*$/, '').trim()}`);
      continue;
    }
    if (isUsers && !isScoped) {
      if (reachesProject.test(sql)) {
        ok++;
        continue;
      }
      bad++;
      const firstU = sql.replace(/\s+/g, ' ').slice(1, 110);
      console.log(`\n  ${file}:${lineNo}  ${YEL}[users]${OFF}`);
      console.log(`    ${firstU}…`);
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
