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
const RED = '\u001b[31m';
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

/* Ordinary app code. auth.ts and projects.ts are deliberately absent:
   the first is sign-in, which is identity and happens before any
   project exists, and the second is the machinery that defines the
   boundary rather than code that sits inside it. Anything else that
   queries the database belongs on this list — a new file with SQL in
   it that nobody scans is exactly how the boundary stops being
   checked. */
const FILES = [
  'src/index.ts',
  'src/backup.ts',
  ...readdirSync('src/views').map((f) => `src/views/${f}`),
];

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

/* ------------------------------------------------------------------ *
 * Finding the strings — properly this time
 *
 * This used to be one regex alternation over quoted spans, and it was
 * quietly wrong in a way that matters more than being wrong loudly.
 * The views are template literals containing `${...}` containing more
 * template literals, several deep; the moment a nested backtick closed
 * what the regex thought was the outer string, everything after it was
 * read as code rather than string, and the scan never recovered.
 *
 * It examined 22 statements. There are 114 in src/index.ts alone. It
 * then printed "every query stays inside its project", which is the
 * worst thing a checker can do: a boundary nobody is watching, with a
 * green tick over it.
 *
 * So: a real lexer. It tracks comments, both quote styles and template
 * literals with their `${}` expressions, which is the only way to know
 * where a string actually ends.
 * ------------------------------------------------------------------ */

function literals(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  let line = 1;

  /* One entry per template literal we are inside of.
     `depth` is how deep we are in its `${...}` — 0 means we are in the
     template's own text, and anything above means we are in code that
     happens to sit inside it. One flat pass with this stack, rather
     than recursion over slices: the views are a thousand lines of
     nested templates, and re-slicing at every one of them turned a
     linear scan into a quadratic one that never finished. */
  const stack = [];

  while (i < n) {
    const top = stack.length ? stack[stack.length - 1] : null;
    const c = src[i];

    /* Inside a template's text. */
    if (top && top.depth === 0) {
      if (c === '\\') { top.buf += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') {
        top.buf += '`';
        out.push({ text: top.buf, line: top.startLine });
        stack.pop();
        i++;
        continue;
      }
      if (c === '$' && src[i + 1] === '{') {
        /* The expression is code. Replace it with a space so `${x}`
           between two words cannot glue them into a table name that
           was never written. */
        top.buf += ' ';
        top.depth = 1;
        i += 2;
        continue;
      }
      if (c === '\n') line++;
      top.buf += c;
      i++;
      continue;
    }

    /* Code: the top level, or inside a `${ }`. */
    if (c === '\n') { line++; i++; continue; }

    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }

    if (c === "'" || c === '"') {
      const q = c;
      const start = i;
      const startLine = line;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') i++;
        else if (src[i] === '\n') line++;
        i++;
      }
      i++;
      out.push({ text: src.slice(start, i), line: startLine });
      continue;
    }

    if (c === '`') {
      stack.push({ buf: '`', startLine: line, depth: 0 });
      i++;
      continue;
    }

    if (top) {
      if (c === '{') { top.depth++; i++; continue; }
      if (c === '}') { top.depth--; i++; continue; }
    }

    i++;
  }

  return out;
}

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

  for (const { text: sql, line: lineNo } of literals(src)) {
    const isScoped = touches.test(sql);
    const isUsers = touchesUsers.test(sql);
    if (!isScoped && !isUsers) continue;

    /* Six lines, not three. A waiver worth writing is usually a
       sentence or two of why, and a three-line window silently missed
       the first line of every one of them — which reads, from the
       outside, exactly like a developer who did not bother. */
    const before = lines.slice(Math.max(0, lineNo - 7), lineNo).join('\n');
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
      const firstU = sql.replace(/\s+/g, ' ').slice(1, 130);
      console.log(`\n  ${RED}${file}:${lineNo}${OFF}  ${YEL}[users]${OFF}`);
      console.log(`    ${firstU}…`);
      continue;
    }

    if (/\bproject_id\b/.test(sql)) {
      ok++;
      continue;
    }

    bad++;
    const first = sql.replace(/\s+/g, ' ').slice(1, 130);
    console.log(`\n  ${RED}${file}:${lineNo}${OFF}`);
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
