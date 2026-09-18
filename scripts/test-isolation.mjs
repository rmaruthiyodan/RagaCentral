#!/usr/bin/env node
/* ===================================================================
 * Does the multi-tenant boundary actually hold?
 *
 * Not by reading the code — by running it. This starts the real app on
 * a real local D1, builds two complete practices through the real HTTP
 * routes, and then has teacher A try, one request at a time, to touch
 * every single thing that belongs to teacher B.
 *
 * Every attempt is asserted on the status line AND on the database: a
 * redirect that quietly wrote the row anyway is a leak, not a refusal.
 * Project B's whole state is snapshotted before the attacks and diffed
 * after them, so a write nobody thought to assert on still fails the
 * run.
 *
 * The other half matters just as much: a test that passes by refusing
 * everything has proved nothing. So the same operations are done inside
 * A and have to succeed, students have to see their own material, and
 * the admin has to be able to cross the boundary on purpose and be
 * recorded doing it.
 *
 *   npm run test:isolation
 *
 * Exits non-zero on the first failure it finds, after running them all.
 * =================================================================== */

import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOML = path.join(ROOT, 'wrangler.toml');
const TOML_BACKUP = path.join(ROOT, 'wrangler.toml.isolation-backup');
const PORT = Number(process.env.ISO_PORT || 8788);
const BASE = `http://127.0.0.1:${PORT}`;
const RUN = (Date.now().toString(36) + Math.random().toString(36).slice(2, 5)).replace(/[^a-z0-9]/g, '');

/* ------------------------------------------------------------------ *
 * Scoreboard
 * ------------------------------------------------------------------ */

let passed = 0;
const failures = [];
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

function pass(name, detail) {
  passed++;
  console.log(`${GREEN}PASS${OFF} ${name}${detail ? ` ${DIM}${detail}${OFF}` : ''}`);
}

function fail(name, detail) {
  failures.push({ name, detail });
  console.log(`${RED}FAIL${OFF} ${name}\n       ${detail}`);
}

/** `detail` describes the failure, and is printed only when it is one. */
function check(name, ok, detail) {
  if (ok) pass(name);
  else fail(name, detail);
  return ok;
}

/** The status line is the assertion. 500 is always a failure, never a "refusal". */
function checkStatus(name, res, expected) {
  const want = Array.isArray(expected) ? expected : [expected];
  const got = res.status;
  if (got >= 500) {
    fail(name, `${res.line} -> ${got} (server error, not a refusal). Body: ${snippet(res.text)}`);
    return false;
  }
  if (!want.includes(got)) {
    fail(name, `${res.line} -> ${got}, wanted ${want.join(' or ')}${res.location ? ` (Location: ${res.location})` : ''}. Body: ${snippet(res.text)}`);
    return false;
  }
  pass(name, `${res.line} -> ${got}${res.location ? ` -> ${res.location}` : ''}`);
  return true;
}

function snippet(t) {
  if (!t) return '(empty)';
  return JSON.stringify(t.replace(/\s+/g, ' ').trim().slice(0, 220));
}

/* ------------------------------------------------------------------ *
 * HTTP, with a cookie jar per person
 * ------------------------------------------------------------------ */

class Jar {
  constructor(who) {
    this.who = who;
    this.cookies = new Map();
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  set(name, value) {
    this.cookies.set(name, value);
  }
  absorb(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      if (i < 0) continue;
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (v === '' || /Max-Age=0/i.test(line)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }
}

const seen5xx = [];

/**
 * One request. Redirects are never followed: where the app sends you is
 * half of what is being asserted on.
 */
async function req(jar, method, url, opts = {}) {
  const headers = { ...(opts.headers ?? {}) };
  if (jar) headers.cookie = jar.header();

  let body;
  if (opts.form) {
    body = new URLSearchParams(opts.form).toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  } else if (opts.multipart) {
    body = opts.multipart;
  }

  /* `wrangler dev` reloads the worker when anything under .wrangler
     changes, and every d1 read this script makes touches that directory.
     A connection refused during a reload is the harness's problem, not
     the app's, so it is retried — a refusal by the app always arrives as
     a status code, and those are never retried. */
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(BASE + url, { method, headers, body, redirect: 'manual' });
      break;
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(750);
    }
  }
  if (jar) jar.absorb(res);

  const line = `${method} ${url}${jar ? ` [as ${jar.who}]` : ''}`;
  const out = {
    status: res.status,
    location: res.headers.get('location'),
    type: res.headers.get('content-type') ?? '',
    line,
    headers: res.headers,
  };
  if (opts.binary) out.bytes = new Uint8Array(await res.arrayBuffer());
  else out.text = await res.text();

  if (res.status >= 500) seen5xx.push(`${line} -> ${res.status}: ${snippet(out.text ?? '')}`);
  return out;
}

const GET = (jar, url, opts) => req(jar, 'GET', url, opts);
const POST = (jar, url, form, opts) => req(jar, 'POST', url, { form, ...opts });

/* ------------------------------------------------------------------ *
 * The local database, for the assertions HTTP cannot make
 * ------------------------------------------------------------------ */

function d1(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'sruti', '--local', '--json', '-y', '--command', sql],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const start = out.indexOf('[');
  if (start < 0) throw new Error(`d1: no JSON in output:\n${out}`);
  const parsed = JSON.parse(out.slice(start));
  return parsed.map((r) => r.results ?? []);
}

/** One statement, one result set. */
const d1one = (sql) => d1(sql)[0];

/* ------------------------------------------------------------------ *
 * wrangler.toml — the [ai] block has to go, and has to come back
 * ------------------------------------------------------------------ */

let tomlStripped = false;

function stripAiBlock() {
  const original = fs.readFileSync(TOML, 'utf8');
  if (!/^\[ai\]$/m.test(original)) return;
  fs.writeFileSync(TOML_BACKUP, original);
  tomlStripped = true;
  /* Same rule the Docker entrypoint uses: drop [ai] and everything under
     it up to the first blank line. The comment lives inside the block on
     purpose, so it goes with it. */
  const out = [];
  let skip = false;
  for (const line of original.split('\n')) {
    if (line === '[ai]') {
      skip = true;
      continue;
    }
    if (skip && line.trim() === '') {
      skip = false;
      continue;
    }
    if (skip) continue;
    out.push(line);
  }
  fs.writeFileSync(TOML, out.join('\n'));
}

function restoreToml() {
  if (!tomlStripped) return;
  try {
    fs.copyFileSync(TOML_BACKUP, TOML);
    fs.unlinkSync(TOML_BACKUP);
  } catch (e) {
    console.error(`\n${RED}wrangler.toml could not be restored automatically${OFF}: ${e.message}`);
    console.error(`Restore it by hand from ${TOML_BACKUP}`);
    return;
  }
  tomlStripped = false;
}

/* ------------------------------------------------------------------ *
 * The server
 * ------------------------------------------------------------------ */

let server = null;
let serverLog = '';

async function portIsFree() {
  try {
    await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1500) });
    return false;
  } catch {
    return true;
  }
}

async function startServer() {
  server = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], {
    cwd: ROOT,
    env: { ...process.env, CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null)
      throw new Error(`wrangler dev exited with ${server.exitCode}:\n${serverLog.slice(-3000)}`);
    try {
      const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const h = await r.json();
        console.log(`${DIM}server up: db=${h.db} media=${h.media}${OFF}\n`);
        return;
      }
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error(`server never became healthy:\n${serverLog.slice(-3000)}`);
}

function stopServer() {
  if (!server || server.exitCode !== null) return;
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    try {
      server.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  try {
    execFileSync('bash', ['-c', `sleep 2; kill -9 -${server.pid} 2>/dev/null || true`], { timeout: 8000 });
  } catch {
    /* best effort */
  }
}

/* ------------------------------------------------------------------ *
 * Small parsing helpers
 * ------------------------------------------------------------------ */

const ID = '[0-9a-hjkmnp-tv-z]{10}';

function firstMatch(text, re, what) {
  const m = text.match(re);
  if (!m) throw new Error(`Could not find ${what} in the page.\n${text.slice(0, 600)}`);
  return m[1];
}

function pngBytes() {
  /* A real 1x1 PNG, so R2 gets something with a shape. */
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
}

function audioBytes(tag) {
  /* Not a real codec — R2 and the streaming route only care about bytes. */
  return Buffer.from(`RIFF....WAVEfmt ${tag}`.padEnd(2048, '.'));
}

/* ==================================================================
 * The run
 * ================================================================== */

async function main() {
  console.log(`${DIM}run id ${RUN}${OFF}\n`);

  /* ---- the fixtures' names, each unique to this run ---- */
  const N = {
    adminEmail: `iso-admin-${RUN}@iso.test`,
    teacherA: `iso-ta-${RUN}@iso.test`,
    teacherB: `iso-tb-${RUN}@iso.test`,
    studentA: `iso-sa-${RUN}@iso.test`,
    studentB: `iso-sb-${RUN}@iso.test`,
    dual: `iso-dual-${RUN}@iso.test`,
    projectA: `Iso Alpha ${RUN}`,
    projectB: `Iso Bravo ${RUN}`,
    studentAName: `AnitaAlpha${RUN}`,
    studentBName: `BirenBravo${RUN}`,
    songA: `SongAlpha${RUN}`,
    songB: `SongBravo${RUN}`,
    groupA: `GroupAlpha${RUN}`,
    groupB: `GroupBravo${RUN}`,
    recA: `TakeAlpha${RUN}`,
    recB: `TakeBravo${RUN}`,
    noteA: `NoteAlpha${RUN}`,
    noteB: `NoteBravo${RUN}`,
    leftA: `LeftoffAlpha${RUN}`,
    leftB: `LeftoffBravo${RUN}`,
  };

  const admin = new Jar('admin');
  const ta = new Jar('teacherA');
  const tb = new Jar('teacherB');
  const sa = new Jar('studentA');
  const dual = new Jar('dualStudent');

  /* ================================================================
   * 1. Sign the admin in and give them the admin bit
   * ================================================================ */

  console.log('--- setting up ---');

  let r = await GET(admin, `/dev/login?email=${encodeURIComponent(N.adminEmail)}&role=teacher`);
  if (r.status !== 302) throw new Error(`/dev/login did not sign anyone in: ${r.status} ${snippet(r.text)}`);
  if (!admin.cookies.has('sruti_session')) throw new Error('/dev/login set no session cookie');

  /* /dev/login can only make an ordinary identity: is_admin is set by
     BOOTSTRAP_ADMIN_EMAIL during a real Google sign-in, which local dev
     never reaches. So the one bit it cannot grant is granted here. */
  d1(`UPDATE users SET is_admin = 1 WHERE lower(email) = '${N.adminEmail}'`);
  const adminId = d1one(`SELECT id FROM users WHERE lower(email) = '${N.adminEmail}'`)[0].id;

  /* ================================================================
   * 2. Two projects, each with its own teacher — through /admin
   * ================================================================ */

  r = await POST(admin, '/admin/projects', { name: N.projectA, name_ml: '', note: 'isolation test' });
  checkStatus('admin creates project A via /admin/projects', r, 302);
  const A = { id: firstMatch(r.location ?? '', new RegExp(`/admin/p/(p_${ID})`), 'project A id') };

  r = await POST(admin, '/admin/projects', { name: N.projectB, name_ml: '', note: 'isolation test' });
  checkStatus('admin creates project B via /admin/projects', r, 302);
  const B = { id: firstMatch(r.location ?? '', new RegExp(`/admin/p/(p_${ID})`), 'project B id') };

  check('the two projects are distinct', A.id !== B.id, `A=${A.id} B=${B.id}`);

  for (const [proj, email, who] of [
    [A, N.teacherA, 'teacher A'],
    [B, N.teacherB, 'teacher B'],
  ]) {
    r = await POST(admin, `/admin/p/${proj.id}/members`, { email, role: 'teacher' });
    checkStatus(`admin adds ${who} via /admin/p/:id/members`, r, 302);
  }
  for (const proj of [A, B]) {
    r = await POST(admin, `/admin/p/${proj.id}/members`, { email: N.dual, role: 'student' });
    checkStatus(`admin adds the dual student to ${proj === A ? 'A' : 'B'}`, r, 302);
  }

  /* The admin leaves, so nothing below inherits an acting project by accident. */
  await POST(admin, '/admin/leave', {});

  /* ================================================================
   * 3. Each teacher fills their own practice, over HTTP
   * ================================================================ */

  async function signIn(jar, email) {
    const res = await GET(jar, `/dev/login?email=${encodeURIComponent(email)}`);
    if (res.status !== 302) throw new Error(`could not sign in ${email}: ${res.status}`);
    return GET(jar, '/');
  }

  async function furnish(jar, proj, names, studentEmail) {
    /* a student */
    let res = await POST(jar, '/t/students', {
      name: names.studentName,
      email: studentEmail,
      location: `Town${RUN}`,
      phone: `+1000${RUN.slice(0, 4)}`,
    });
    checkStatus(`${jar.who} adds a student`, res, 302);

    /* a group and a song */
    res = await POST(jar, '/t/groups', { name: names.group });
    checkStatus(`${jar.who} adds a group`, res, 302);
    res = await POST(jar, '/t/sections', {
      title: names.song,
      raga: `Raga${RUN}`,
      taala: 'Adi',
      composer: `Composer${RUN}`,
    });
    checkStatus(`${jar.who} adds a song`, res, 302);

    /* read their ids back: from the app's own student list, and from the
       rows the two catalogue posts must have written */
    const list = await GET(jar, `/t?q=${encodeURIComponent(names.studentName)}`);
    const studentId = firstMatch(list.text, new RegExp(`/t/s/(u_${ID})`), 'the new student');
    const [[group], [section]] = d1(
      `SELECT id FROM groups WHERE project_id='${proj.id}' AND name='${names.group}';
       SELECT id FROM sections WHERE project_id='${proj.id}' AND title='${names.song}'`,
    );
    if (!group?.id || !section?.id) throw new Error(`the group or song for ${jar.who} was not created`);
    const groupId = group.id;
    const sectionId = section.id;

    /* assign it */
    res = await POST(jar, `/t/song/${sectionId}/assign`, { student_id: studentId });
    checkStatus(`${jar.who} assigns the song to their student`, res, 302);

    /* a recording */
    const fd = new FormData();
    fd.set('file', new File([audioBytes(names.rec)], `${names.rec}.wav`, { type: 'audio/wav' }));
    fd.set('section_id', sectionId);
    fd.set('student_id', studentId);
    fd.set('title', names.rec);
    fd.set('part', 'pallavi');
    res = await req(jar, 'POST', '/api/recordings', { multipart: fd });
    checkStatus(`${jar.who} uploads a recording`, res, 200);
    const recordingId = JSON.parse(res.text).id;

    /* a note, with an image */
    const nf = new FormData();
    nf.set('section_id', sectionId);
    nf.set('student_id', studentId);
    nf.set('title', names.note);
    nf.set('body', `${names.note} body text`);
    nf.set('image', new File([pngBytes()], 'notation.png', { type: 'image/png' }));
    nf.set('back', `/t/song/${sectionId}`);
    res = await req(jar, 'POST', '/t/notes', { multipart: nf });
    checkStatus(`${jar.who} writes a note with an image`, res, 302);

    /* a lesson */
    res = await POST(jar, `/t/s/${studentId}/sessions`, {
      held_on: '2026-09-10',
      status: 'completed',
      covered: `${names.song} first half`,
      left_off: names.left,
      duration_min: '45',
      section_ids: sectionId,
    });
    checkStatus(`${jar.who} logs a lesson`, res, 302);

    /* a class slot */
    res = await POST(jar, `/t/students/${studentId}/slots`, {
      kind: 'weekly',
      weekday: '3',
      time_ist: '18:30',
      duration_min: '45',
      label: `Slot${RUN}`,
    });
    checkStatus(`${jar.who} adds a class slot`, res, 302);

    const [[note], [session], [slot]] = d1(
      `SELECT id FROM notes WHERE project_id='${proj.id}' AND title='${names.note}';
       SELECT id FROM sessions WHERE project_id='${proj.id}' AND student_id='${studentId}' AND held_on='2026-09-10';
       SELECT id FROM class_slots WHERE project_id='${proj.id}' AND student_id='${studentId}'`,
    );
    if (!note?.id || !session?.id || !slot?.id)
      throw new Error(`${jar.who}: note/lesson/slot missing — ${JSON.stringify({ note, session, slot })}`);

    Object.assign(proj, {
      studentId,
      sectionId,
      groupId,
      recordingId,
      noteId: note.id,
      sessionId: session.id,
      slotId: slot.id,
    });
  }

  const landedA = await signIn(ta, N.teacherA);
  checkStatus('teacher A signs in and lands in their own practice', landedA, 302);
  check(
    'teacher A lands on the teacher side, not /waiting',
    landedA.location === '/t/schedule/week',
    `Location was ${landedA.location}, wanted /t/schedule/week`,
  );
  await furnish(ta, A, { studentName: N.studentAName, group: N.groupA, song: N.songA, rec: N.recA, note: N.noteA, left: N.leftA }, N.studentA);

  await signIn(tb, N.teacherB);
  await furnish(tb, B, { studentName: N.studentBName, group: N.groupB, song: N.songB, rec: N.recB, note: N.noteB, left: N.leftB }, N.studentB);

  /* the dual student gets material in both practices */
  const dualId = firstMatch(
    (await GET(ta, `/t?q=${encodeURIComponent(N.dual)}`)).text,
    new RegExp(`/t/s/(u_${ID})`),
    'the dual student in A',
  );
  await POST(ta, `/t/s/${dualId}/assign`, { section_id: A.sectionId });
  await POST(ta, `/t/s/${dualId}/sessions`, { held_on: '2026-09-11', status: 'completed', covered: `${N.songA} with dual`, left_off: N.leftA });
  await POST(tb, `/t/s/${dualId}/assign`, { section_id: B.sectionId });
  await POST(tb, `/t/s/${dualId}/sessions`, { held_on: '2026-09-12', status: 'completed', covered: `${N.songB} with dual`, left_off: N.leftB });

  /* A second, untouched song in B, kept aside as a target nothing has
     ever been assigned to — so a row appearing on it has exactly one
     possible author. */
  await POST(tb, '/t/sections', { title: `ProbeSong${RUN}` });
  B.probeSectionId = d1one(`SELECT id FROM sections WHERE project_id='${B.id}' AND title='ProbeSong${RUN}'`)[0]?.id;
  if (!B.probeSectionId) throw new Error('the probe song in B was not created');

  console.log(`${DIM}A = ${JSON.stringify(A)}${OFF}`);
  console.log(`${DIM}B = ${JSON.stringify(B)}${OFF}\n`);

  /* ================================================================
   * 4. Snapshot B, so any write that lands can be caught
   * ================================================================ */

  const snapshotSql = (p) =>
    [
      `SELECT user_id, role, status, status_note FROM project_members WHERE project_id='${p}' ORDER BY user_id`,
      `SELECT id, name, email, phone, location, time_zone FROM users WHERE id IN (SELECT user_id FROM project_members WHERE project_id='${p}') ORDER BY id`,
      `SELECT id, name, sort_order FROM groups WHERE project_id='${p}' ORDER BY id`,
      `SELECT id, title, raga, taala, composer, group_id, sort_order FROM sections WHERE project_id='${p}' ORDER BY id`,
      `SELECT id, title, part, description, visibility, sort_order, r2_key FROM recordings WHERE project_id='${p}' ORDER BY id`,
      `SELECT id, title, body, visibility, sort_order, image_key FROM notes WHERE project_id='${p}' ORDER BY id`,
      `SELECT id, student_id, section_id, archived_at, completed_at FROM assignments WHERE project_id='${p}' ORDER BY id`,
      `SELECT id, student_id, held_on, status, covered, left_off FROM sessions WHERE project_id='${p}' ORDER BY id`,
      `SELECT id, student_id, weekday, on_date, time_ist, duration_min, label FROM class_slots WHERE project_id='${p}' ORDER BY id`,
      `SELECT x.id, x.slot_id, x.on_date, x.action, x.new_date FROM slot_exceptions x JOIN class_slots cs ON cs.id = x.slot_id WHERE cs.project_id='${p}' ORDER BY x.id`,
      `SELECT rs.recording_id, rs.student_id FROM recording_shares rs JOIN recordings r ON r.id = rs.recording_id WHERE r.project_id='${p}' ORDER BY 1,2`,
      `SELECT ns.note_id, ns.student_id FROM note_shares ns JOIN notes n ON n.id = ns.note_id WHERE n.project_id='${p}' ORDER BY 1,2`,
      `SELECT ss.session_id, ss.section_id FROM session_sections ss JOIN sessions s ON s.id = ss.session_id WHERE s.project_id='${p}' ORDER BY 1,2`,
    ].join('; ');

  const LABELS = ['members', 'people', 'groups', 'songs', 'recordings', 'notes', 'assignments', 'lessons', 'slots', 'slot_exceptions', 'recording_shares', 'note_shares', 'lesson_songs'];
  const snapB = d1(snapshotSql(B.id));

  /* ================================================================
   * 5. Teacher A, acting in A, goes after everything in B
   * ================================================================ */

  console.log('--- teacher A reaching into project B (every one of these must fail) ---');

  /* --- reading B's pages --- */
  for (const [label, url] of [
    ["B's student page (overview tab)", `/t/s/${B.studentId}`],
    ["B's student, songs tab", `/t/s/${B.studentId}/songs`],
    ["B's student, lessons tab", `/t/s/${B.studentId}/lessons`],
    ["B's student, schedule tab", `/t/s/${B.studentId}/schedule`],
    ["B's student, settings tab", `/t/s/${B.studentId}/settings`],
    ["B's song page", `/t/song/${B.sectionId}`],
    ["B's song in B's student's workspace", `/t/s/${B.studentId}/${B.sectionId}`],
  ]) {
    const res = await GET(ta, url);
    if (checkStatus(`teacher A cannot open ${label}`, res, 404))
      check(`  …and none of B's material is in the body`, !res.text.includes(N.studentBName) && !res.text.includes(N.songB), `body leaked: ${snippet(res.text)}`);
  }

  /* --- B's media --- */
  for (const [label, url] of [
    ["B's recording", `/media/${B.recordingId}`],
    ["B's note image", `/img/${B.noteId}`],
    ["B's note as a text file", `/note/${B.noteId}/download`],
  ]) {
    const res = await GET(ta, url);
    if (checkStatus(`teacher A cannot fetch ${label}`, res, [403, 404]))
      check(`  …and the response carries none of B's content`, !(res.text ?? '').includes(N.noteB) && !(res.text ?? '').includes(N.recB), `body leaked: ${snippet(res.text)}`);
  }

  /* --- writing to B's student --- */
  const writes = [
    ["change B's student's status", 'POST', `/t/students/${B.studentId}/status`, { status: 'ended', status_note: 'hijacked' }],
    ["edit B's student's details", 'POST', `/t/students/${B.studentId}/details`, { name: `HIJACKED${RUN}`, phone: '+999', location: 'nowhere' }],
    ["change B's student's time zone", 'POST', `/t/students/${B.studentId}/zone`, { time_zone: 'America/New_York', location: 'nowhere' }],
    ["assign B's song to A's own student", 'POST', `/t/song/${B.sectionId}/assign`, { student_id: A.studentId }],
    ["assign A's song to B's student", 'POST', `/t/s/${B.studentId}/assign`, { section_id: A.sectionId }],
    ["assign B's song to B's student", 'POST', `/t/s/${B.studentId}/assign`, { section_id: B.sectionId }],
    ["mark B's song finished for B's student", 'POST', `/t/s/${B.studentId}/complete-song`, { section_id: B.sectionId }],
    ["unassign B's song from B's student", 'POST', `/t/s/${B.studentId}/unassign`, { section_id: B.sectionId }],
    ["edit B's recording", 'POST', `/t/recordings/${B.recordingId}`, { title: `HIJACKED${RUN}`, part: 'charanam', description: 'hijacked' }],
    ["move B's recording", 'POST', `/t/recordings/${B.recordingId}/move`, { dir: 'up' }],
    ["delete B's recording", 'POST', `/t/recordings/${B.recordingId}/delete`, {}],
    ["hand B's recording to A's student", 'POST', `/t/recordings/${B.recordingId}/share`, { student_id: A.studentId }],
    ["edit B's note", 'POST', `/t/notes/${B.noteId}`, { title: `HIJACKED${RUN}`, body: 'hijacked' }],
    ["move B's note", 'POST', `/t/notes/${B.noteId}/move`, { dir: 'up' }],
    ["delete B's note", 'POST', `/notes/${B.noteId}/delete`, {}],
    ["edit B's song", 'POST', `/t/sections/${B.sectionId}`, { title: `HIJACKED${RUN}`, raga: 'hijacked' }],
    ["move B's song", 'POST', `/t/sections/${B.sectionId}/move`, { dir: 'up' }],
    ["delete B's song", 'POST', `/t/sections/${B.sectionId}/delete`, {}],
    ["move B's group", 'POST', `/t/groups/${B.groupId}/move`, { dir: 'up' }],
    ["delete B's group", 'POST', `/t/groups/${B.groupId}/delete`, {}],
    ["edit B's lesson", 'POST', `/t/sessions/${B.sessionId}`, { held_on: '2020-01-01', status: 'completed', covered: `HIJACKED${RUN}` }],
    ["mark B's lesson finished", 'POST', `/t/sessions/${B.sessionId}/complete`, {}],
    ["delete B's lesson", 'POST', `/t/sessions/${B.sessionId}/delete`, {}],
    ["log a lesson against B's student", 'POST', `/t/s/${B.studentId}/sessions`, { held_on: '2026-09-13', status: 'completed', covered: `HIJACKED${RUN}` }],
    ["delete B's class slot", 'POST', `/t/slots/${B.slotId}/delete`, {}],
    ["skip an occurrence of B's class slot", 'POST', `/t/slots/${B.slotId}/skip`, { on_date: '2026-09-16', reason: 'hijacked' }],
    ["mark an occurrence of B's slot missed", 'POST', `/t/slots/${B.slotId}/missed`, { on_date: '2026-09-17', reason: 'hijacked' }],
    ["move an occurrence of B's class slot", 'POST', `/t/slots/${B.slotId}/move`, { on_date: '2026-09-23', new_date: '2026-09-24', new_time_ist: '09:00' }],
    ["give B's student a new class slot", 'POST', `/t/students/${B.studentId}/slots`, { kind: 'weekly', weekday: '1', time_ist: '07:00', duration_min: '30' }],
  ];

  for (const [label, method, url, form] of writes) {
    const res = await req(ta, method, url, { form });
    /* A refusal is a 403, a 404, or a redirect that writes nothing. What
       it may never be is a 200 page of B's data, or a 500. */
    checkStatus(`teacher A cannot ${label}`, res, [302, 303, 403, 404]);
  }

  /* The assign above answered with a redirect, which is a refusal only if
     nothing was written. So ask the database. */
  /* The other assign route, the one on the student's own page, reached
     with B's song id. Aimed at a different student so it cannot be
     confused with the attempt above, which used the same pair. */
  const viaStudentPage = await POST(ta, `/t/s/${dualId}/assign`, { section_id: B.probeSectionId });
  checkStatus("teacher A's post of B's song to /t/s/:id/assign is answered without an error", viaStudentPage, [302, 403, 404]);
  check(
    "teacher A cannot assign B's song from their own student's page — no assignment row was written",
    d1one(`SELECT COUNT(*) AS n FROM assignments WHERE section_id='${B.probeSectionId}'`)[0].n === 0,
    `an assignments row now links a student of A to B's second song ${B.probeSectionId}`,
  );

  check(
    "teacher A cannot assign B's song to A's own student — no assignment row was written",
    d1one(`SELECT COUNT(*) AS n FROM assignments WHERE section_id='${B.sectionId}' AND project_id='${A.id}'`)[0].n === 0,
    `an assignments row in ${A.id} now points at B's song ${B.sectionId}`,
  );
  check(
    "teacher A's attempts against B's student wrote nothing for them in A",
    d1one(`SELECT COUNT(*) AS n FROM assignments WHERE student_id='${B.studentId}' AND project_id='${A.id}'`)[0].n === 0 &&
      d1one(`SELECT COUNT(*) AS n FROM sessions WHERE student_id='${B.studentId}' AND project_id='${A.id}'`)[0].n === 0 &&
      d1one(`SELECT COUNT(*) AS n FROM class_slots WHERE student_id='${B.studentId}' AND project_id='${A.id}'`)[0].n === 0,
    "rows for B's student were written into project A",
  );

  /* --- and the two creates that name one of B's rows as a parent --- */
  const fdX = new FormData();
  fdX.set('file', new File([audioBytes('X')], 'sneak.wav', { type: 'audio/wav' }));
  fdX.set('section_id', B.sectionId);
  fdX.set('title', `SneakRec${RUN}`);
  const sneakRec = await req(ta, 'POST', '/api/recordings', { multipart: fdX });
  const nfX = new FormData();
  nfX.set('section_id', B.sectionId);
  nfX.set('title', `SneakNote${RUN}`);
  nfX.set('body', 'sneak');
  const sneakNote = await req(ta, 'POST', '/t/notes', { multipart: nfX });
  check(
    "teacher A cannot attach a new recording to B's song",
    sneakRec.status >= 400 || d1one(`SELECT COUNT(*) AS n FROM recordings WHERE section_id='${B.sectionId}' AND id NOT IN ('${B.recordingId}')`)[0].n === 0,
    `${sneakRec.line} -> ${sneakRec.status} ${snippet(sneakRec.text)} — and a recordings row now points at B's song`,
  );
  check(
    "teacher A cannot attach a new note to B's song",
    sneakNote.status >= 400 || d1one(`SELECT COUNT(*) AS n FROM notes WHERE section_id='${B.sectionId}' AND id NOT IN ('${B.noteId}')`)[0].n === 0,
    `${sneakNote.line} -> ${sneakNote.status} — and a notes row now points at B's song`,
  );

  /* --- searching for something only B has ---
     The term is echoed back into the search box, so its bare presence
     proves nothing: what is asserted is the empty state, the absence of
     B's id, and that the title appears exactly once — in the input. */
  const count = (hay, needle) => hay.split(needle).length - 1;
  let res = await GET(ta, `/t/catalogue?q=${encodeURIComponent(N.songB)}`);
  checkStatus("teacher A's catalogue search for B's song answers normally", res, 200);
  check(
    "teacher A's catalogue search finds nothing of B's",
    /* Two echoes are expected and harmless: the search box, and the
       "No songs match …" line. A third would be a rendered result. */
    res.text.includes('No songs match') && !res.text.includes(B.sectionId) && count(res.text, N.songB) <= 2,
    `the result page is not empty: id present=${res.text.includes(B.sectionId)}, empty state=${res.text.includes('No songs match')}, title occurrences=${count(res.text, N.songB)}`,
  );
  res = await GET(ta, `/t/catalogue?q=${encodeURIComponent(`Raga${RUN}`)}`);
  check(
    "teacher A's catalogue search by raga returns only A's song",
    res.status === 200 && !res.text.includes(N.songB) && res.text.includes(N.songA),
    `${res.line} -> ${res.status}; B's song present=${res.text.includes(N.songB)}`,
  );
  res = await GET(ta, `/t?q=${encodeURIComponent(N.studentBName)}`);
  checkStatus("teacher A's student search for B's student answers normally", res, 200);
  check(
    "teacher A's student search finds nothing of B's",
    !res.text.includes(B.studentId) && !res.text.includes(`/t/s/${B.studentId}`) && count(res.text, N.studentBName) <= 2,
    `the result page contains B's student ${B.studentId} (name occurrences: ${count(res.text, N.studentBName)}, id present: ${res.text.includes(B.studentId)})`,
  );
  res = await GET(ta, `/t?q=${encodeURIComponent(N.studentB)}`);
  check(
    "teacher A cannot find B's student by email either",
    res.status === 200 && !res.text.includes(B.studentId),
    `${res.line} -> ${res.status}; B's student id is on the page`,
  );
  res = await GET(ta, '/t?all=1');
  checkStatus("teacher A's full student list loads", res, 200);
  check("teacher A's full student list holds nobody from B", !res.text.includes(B.studentId), "B's student is listed in A");
  res = await GET(ta, '/t/schedule/slots');
  check("teacher A's schedule holds no slot of B's", !res.text.includes(B.slotId), "B's slot appears on A's schedule page");

  /* --- did any of that actually land? --- */
  const snapB2 = d1(snapshotSql(B.id));
  let drifted = 0;
  for (let i = 0; i < snapB.length; i++) {
    const before = JSON.stringify(snapB[i]);
    const after = JSON.stringify(snapB2[i]);
    if (before !== after) {
      drifted++;
      fail(`project B's ${LABELS[i]} were changed by teacher A`, `before: ${before}\n       after:  ${after}`);
    }
  }
  if (!drifted) pass("not one row of project B changed under teacher A's attack", `${LABELS.length} tables compared`);

  /* B's own files are still there and still playable by B */
  const bMedia = await GET(tb, `/media/${B.recordingId}`, { binary: true });
  check(
    "B's recording still streams for teacher B after A tried to delete it",
    bMedia.status === 200 && bMedia.bytes.length === audioBytes(N.recB).length,
    `${bMedia.line} -> ${bMedia.status}, ${bMedia.bytes?.length ?? 0} bytes`,
  );
  const bImg = await GET(tb, `/img/${B.noteId}`, { binary: true });
  check(
    "B's note image still loads for teacher B",
    bImg.status === 200 && bImg.bytes.length === pngBytes().length,
    `${bImg.line} -> ${bImg.status}, ${bImg.bytes?.length ?? 0} bytes`,
  );
  const bSong = await GET(tb, `/t/song/${B.sectionId}`);
  if (checkStatus("B's song page still opens for teacher B", bSong, 200))
    check(
      "  …with B's own title, not the one A tried to write",
      bSong.text.includes(N.songB) && !bSong.text.includes(`HIJACKED${RUN}`),
      'B\'s song page shows A\'s edit',
    );

  /* rows in A that point at something in B */
  const MINE = `('${A.id}','${B.id}')`;
  const cross = d1(
    `SELECT a.id, a.project_id AS in_project, s.project_id AS song_project FROM assignments a JOIN sections s ON s.id = a.section_id WHERE a.project_id <> s.project_id AND a.project_id IN ${MINE};
     SELECT r.id, r.project_id AS in_project, s.project_id AS song_project FROM recordings r JOIN sections s ON s.id = r.section_id WHERE r.project_id <> s.project_id AND r.project_id IN ${MINE};
     SELECT n.id, n.project_id AS in_project, s.project_id AS song_project FROM notes n JOIN sections s ON s.id = n.section_id WHERE n.project_id <> s.project_id AND n.project_id IN ${MINE};
     SELECT ss.session_id, ss.section_id FROM session_sections ss JOIN sessions s ON s.id = ss.session_id JOIN sections sec ON sec.id = ss.section_id WHERE s.project_id <> sec.project_id AND s.project_id IN ${MINE}`,
  );
  const crossLabels = ['assignments', 'recordings', 'notes', 'lesson-song links'];
  cross.forEach((rows, i) => {
    check(
      `no ${crossLabels[i]} row lives in one project and points at another project's song`,
      rows.length === 0,
      `${rows.length} row(s): ${JSON.stringify(rows).slice(0, 400)}`,
    );
  });

  /* rows filed in a project against somebody who is not in it */
  const strangers = d1(
    `SELECT id, project_id, student_id FROM sessions s WHERE s.project_id IN ${MINE} AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = s.student_id AND m.project_id = s.project_id);
     SELECT id, project_id, student_id FROM class_slots cs WHERE cs.project_id IN ${MINE} AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = cs.student_id AND m.project_id = cs.project_id);
     SELECT id, project_id, student_id FROM assignments a WHERE a.project_id IN ${MINE} AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.user_id = a.student_id AND m.project_id = a.project_id)`,
  );
  ['lessons', 'class slots', 'assignments'].forEach((label, i) => {
    check(
      `no ${label} were filed against somebody who is not in that project`,
      strangers[i].length === 0,
      `${strangers[i].length} row(s): ${JSON.stringify(strangers[i]).slice(0, 400)}`,
    );
  });

  /* The assign routes end in ON CONFLICT ... DO UPDATE, and the pair they
     conflict on carries no project. So: can teacher A undo teacher B's
     decision to take a song off a student they happen to share? */
  const assignRow = () =>
    d1one(`SELECT project_id, archived_at FROM assignments WHERE student_id='${dualId}' AND section_id='${B.sectionId}'`)[0];
  await POST(tb, `/t/s/${dualId}/unassign`, { section_id: B.sectionId });
  if (check('teacher B takes their own song off the shared student', Boolean(assignRow()?.archived_at), 'the assignment was not archived')) {
    const revive = await POST(ta, `/t/s/${dualId}/assign`, { section_id: B.sectionId });
    checkStatus("teacher A's post to re-assign it is answered without an error", revive, [302, 403, 404]);
    check(
      "teacher A cannot un-archive an assignment inside project B",
      Boolean(assignRow()?.archived_at),
      `the row in project ${assignRow()?.project_id} was put back in B's student's list by teacher A`,
    );
  }
  await POST(tb, `/t/s/${dualId}/assign`, { section_id: B.sectionId }); // B puts it back, for the tests below

  /* ================================================================
   * 6. The same operations, inside A, must work
   * ================================================================ */

  console.log('\n--- the same work inside project A (all of this must succeed) ---');

  for (const [label, url, mustContain] of [
    ["A's student page (overview tab)", `/t/s/${A.studentId}`, N.studentAName],
    ["A's student, songs tab", `/t/s/${A.studentId}/songs`, N.songA],
    ["A's student, lessons tab", `/t/s/${A.studentId}/lessons`, N.leftA],
    ["A's student, schedule tab", `/t/s/${A.studentId}/schedule`, 'Slot' + RUN],
    ["A's student, settings tab", `/t/s/${A.studentId}/settings`, N.studentAName],
    ["A's song page", `/t/song/${A.sectionId}`, N.songA],
    ["A's song in A's student's workspace", `/t/s/${A.studentId}/${A.sectionId}`, N.songA],
  ]) {
    const got = await GET(ta, url);
    if (checkStatus(`teacher A opens ${label}`, got, 200))
      check(`  …and it shows their own material`, got.text.includes(mustContain), `"${mustContain}" was not on the page`);
  }

  const mediaA = await GET(ta, `/media/${A.recordingId}`, { binary: true });
  check(
    "teacher A streams their own recording",
    mediaA.status === 200 && mediaA.bytes.length === audioBytes(N.recA).length,
    `${mediaA.line} -> ${mediaA.status}, ${mediaA.bytes?.length ?? 0} bytes (wanted 200 and ${audioBytes(N.recA).length})`,
  );
  const imgA = await GET(ta, `/img/${A.noteId}`, { binary: true });
  check(
    "teacher A opens their own note's image",
    imgA.status === 200 && imgA.bytes.length === pngBytes().length,
    `${imgA.line} -> ${imgA.status}, ${imgA.bytes?.length ?? 0} bytes`,
  );
  const dlA = await GET(ta, `/note/${A.noteId}/download`);
  if (checkStatus("teacher A downloads their own note", dlA, 200))
    check('  …and the file holds the note', dlA.text.includes(N.noteA), `download body: ${snippet(dlA.text)}`);

  const good = [
    ["pause their own student", `/t/students/${A.studentId}/status`, { status: 'paused', status_note: 'holiday' },
      () => d1one(`SELECT status FROM project_members WHERE user_id='${A.studentId}' AND project_id='${A.id}'`)[0]?.status === 'paused'],
    ["put their own student back to active", `/t/students/${A.studentId}/status`, { status: 'active' },
      () => d1one(`SELECT status FROM project_members WHERE user_id='${A.studentId}' AND project_id='${A.id}'`)[0]?.status === 'active'],
    ["edit their own student's details", `/t/students/${A.studentId}/details`, { name: N.studentAName, location: `Edited${RUN}`, phone: '+123456' },
      () => d1one(`SELECT location FROM users WHERE id='${A.studentId}'`)[0]?.location === `Edited${RUN}`],
    ["change their own student's time zone", `/t/students/${A.studentId}/zone`, { time_zone: 'Asia/Dubai', location: `Edited${RUN}` },
      () => d1one(`SELECT time_zone FROM users WHERE id='${A.studentId}'`)[0]?.time_zone === 'Asia/Dubai'],
    ["rename their own recording", `/t/recordings/${A.recordingId}`, { title: `${N.recA}-edited`, part: 'pallavi' },
      () => d1one(`SELECT title FROM recordings WHERE id='${A.recordingId}'`)[0]?.title === `${N.recA}-edited`],
    ["edit their own note", `/t/notes/${A.noteId}`, { title: N.noteA, body: `${N.noteA} edited` },
      () => d1one(`SELECT body FROM notes WHERE id='${A.noteId}'`)[0]?.body === `${N.noteA} edited`],
    ["edit their own song", `/t/sections/${A.sectionId}`, { title: N.songA, raga: `Raga${RUN}-edited`, group_id: A.groupId },
      () => d1one(`SELECT raga FROM sections WHERE id='${A.sectionId}'`)[0]?.raga === `Raga${RUN}-edited`],
    ["edit their own lesson", `/t/sessions/${A.sessionId}`, { held_on: '2026-09-10', status: 'completed', covered: `${N.songA} edited`, left_off: N.leftA },
      () => d1one(`SELECT covered FROM sessions WHERE id='${A.sessionId}'`)[0]?.covered === `${N.songA} edited`],
    ["skip an occurrence of their own class slot", `/t/slots/${A.slotId}/skip`, { on_date: '2026-09-23', reason: 'holiday' },
      () => d1one(`SELECT COUNT(*) AS n FROM slot_exceptions WHERE slot_id='${A.slotId}' AND action='skip'`)[0].n === 1],
    ["move an occurrence of their own class slot", `/t/slots/${A.slotId}/move`, { on_date: '2026-09-30', new_date: '2026-10-01', new_time_ist: '19:00' },
      () => d1one(`SELECT COUNT(*) AS n FROM slot_exceptions WHERE slot_id='${A.slotId}' AND action='move'`)[0].n === 1],
  ];
  for (const [label, url, form, verify] of good) {
    const got = await POST(ta, url, form);
    if (checkStatus(`teacher A can ${label}`, got, [302, 303]))
      check(`  …and the change is in the database`, verify(), 'the row did not change');
  }

  /* assigning, unassigning and deleting inside A */
  let got = await POST(ta, `/t/song/${A.sectionId}/assign`, { student_id: dualId });
  if (checkStatus('teacher A can assign their own song to their own student', got, 302))
    check('  …and the assignment exists', d1one(`SELECT COUNT(*) AS n FROM assignments WHERE project_id='${A.id}' AND section_id='${A.sectionId}' AND student_id='${dualId}' AND archived_at IS NULL`)[0].n === 1, 'no assignment row');

  got = await GET(ta, `/t/catalogue?q=${encodeURIComponent(N.songA)}`);
  if (checkStatus("teacher A's catalogue search for their own song answers", got, 200))
    check(
      '  …and finds it',
      got.text.includes('1 match for') && (got.text.split(N.songA).length - 1) > 1,
      `no match block: ${snippet(got.text.slice(got.text.indexOf('<main')))}`,
    );
  got = await GET(ta, `/t?q=${encodeURIComponent(N.studentAName)}`);
  if (checkStatus("teacher A's student search for their own student answers", got, 200))
    check('  …and finds them', got.text.includes(A.studentId), "A's own student was not in its own search results");

  /* a throwaway group and song, created and then deleted inside A */
  await POST(ta, '/t/groups', { name: `Doomed${RUN}` });
  const doomedGroup = d1one(`SELECT id FROM groups WHERE project_id='${A.id}' AND name='Doomed${RUN}'`)[0]?.id;
  check('teacher A can create a group of their own', Boolean(doomedGroup), 'no group row was written');
  got = await POST(ta, `/t/groups/${doomedGroup}/delete`, {});
  if (checkStatus('teacher A can delete a group of their own', got, 302))
    check('  …and it is gone', d1one(`SELECT COUNT(*) AS n FROM groups WHERE id='${doomedGroup}'`)[0].n === 0, 'the group is still there');

  await POST(ta, '/t/sections', { title: `DoomedSong${RUN}` });
  const doomedSong = d1one(`SELECT id FROM sections WHERE project_id='${A.id}' AND title='DoomedSong${RUN}'`)[0]?.id;
  check('teacher A can add a song of their own', Boolean(doomedSong), 'no section row was written');
  got = await POST(ta, `/t/sections/${doomedSong}/delete`, {});
  if (checkStatus('teacher A can delete a song of their own', got, 302))
    check('  …and it is gone', d1one(`SELECT COUNT(*) AS n FROM sections WHERE id='${doomedSong}'`)[0].n === 0, 'the song is still there');

  /* ================================================================
   * 7. A's student sees A's material and nothing else
   * ================================================================ */

  console.log("\n--- a student of A, looking around ---");

  await signIn(sa, N.studentA);
  got = await GET(sa, '/me');
  if (checkStatus("A's student opens their own page", got, 200)) {
    check('  …and their own song is on it', got.text.includes(N.songA), `"${N.songA}" missing from /me`);
    check("  …and nothing of B's is", !got.text.includes(N.songB) && !got.text.includes(B.sectionId) && !got.text.includes(N.leftB), "B's material is on A's student's page");
  }
  for (const [label, url, want] of [
    ["B's song", `/me/${B.sectionId}`, 404],
    ["B's recording", `/media/${B.recordingId}`, [403, 404]],
    ["B's note image", `/img/${B.noteId}`, [403, 404]],
    ["B's note download", `/note/${B.noteId}/download`, [403, 404]],
  ]) {
    const r2 = await GET(sa, url);
    checkStatus(`A's student cannot open ${label}`, r2, want);
  }
  const ownSong = await GET(sa, `/me/${A.sectionId}`);
  checkStatus("A's student opens their own assigned song", ownSong, 200);
  const ownMedia = await GET(sa, `/media/${A.recordingId}`, { binary: true });
  check("A's student hears their own recording", ownMedia.status === 200, `${ownMedia.line} -> ${ownMedia.status}`);
  const teacherPage = await GET(sa, `/t/s/${A.studentId}`);
  check("A's student is bounced off the teacher pages", teacherPage.status === 302 && teacherPage.location === '/me', `${teacherPage.line} -> ${teacherPage.status} ${teacherPage.location ?? ''}`);

  /* ================================================================
   * 8. The admin crosses the boundary on purpose, and is recorded
   * ================================================================ */

  console.log('\n--- the admin switching into B ---');

  /* An admin now joins every practice they create as a teacher, which
     means the visiting path \u2014 banner, audit log, no membership \u2014 no
     longer applies to their own. It still has to work for a practice
     they are genuinely outside of, and that is what is being tested
     here, so take the membership away first.
     Removing it rather than never creating it is deliberate: it also
     proves that leaving a practice really does put the admin back
     outside it. */
  r = await POST(admin, `/admin/p/${B.id}/members/${adminId}/remove`, {});
  checkStatus('the admin steps out of B, so they are a visitor to it', r, 302);
  check(
    '  …and holds no membership there',
    d1one(`SELECT COUNT(*) AS n FROM project_members WHERE project_id='${B.id}' AND user_id='${adminId}'`)[0].n === 0,
    'the membership row survived the removal',
  );

  const logBefore = d1one(`SELECT COUNT(*) AS n FROM admin_log WHERE project_id='${B.id}'`)[0].n;

  got = await POST(admin, `/admin/switch/${B.id}`, {});
  checkStatus('the admin switches into project B', got, 302);
  check('  …and is sent to the teacher side', got.location === '/t/schedule/week', `Location was ${got.location}`);

  got = await GET(admin, '/t');
  if (checkStatus("the admin sees B's student list", got, 200)) {
    check("  …with B's student on it", got.text.includes(B.studentId) && got.text.includes(N.studentBName), "B's student is missing from the admin's view of B");
    check("  …and nobody from A", !got.text.includes(A.studentId) && !got.text.includes(N.studentAName), "A's student showed up inside B");
    check('  …and the visiting banner is up', got.text.includes('class="visiting"') && got.text.includes(N.projectB), 'no visiting banner on the page');
  }
  got = await GET(admin, `/t/song/${B.sectionId}`);
  if (checkStatus("the admin opens B's song page", got, 200))
    check('  …and the visiting banner is up there too', got.text.includes('class="visiting"'), 'no visiting banner');
  got = await GET(admin, `/t/song/${A.sectionId}`);
  checkStatus("the admin inside B cannot open A's song", got, 404);

  got = await POST(admin, `/t/students/${B.studentId}/status`, { status: 'paused', status_note: 'admin was here' });
  if (checkStatus("the admin changes B's student's status", got, 302))
    check('  …and it landed', d1one(`SELECT status FROM project_members WHERE user_id='${B.studentId}' AND project_id='${B.id}'`)[0]?.status === 'paused', 'the status did not change');

  const logAfter = d1one(`SELECT action, detail, path FROM admin_log WHERE project_id='${B.id}' ORDER BY at DESC LIMIT 3`);
  check(
    "the admin's change is in admin_log",
    logAfter.some((l) => l.path === `/t/students/${B.studentId}/status`),
    `admin_log for B holds: ${JSON.stringify(logAfter)}`,
  );

  /* the same change, by the teacher of that project, is not audited */
  const logCount = d1one(`SELECT COUNT(*) AS n FROM admin_log WHERE project_id='${B.id}'`)[0].n;
  got = await POST(tb, `/t/students/${B.studentId}/status`, { status: 'active', status_note: 'teacher was here' });
  if (checkStatus("teacher B makes the same change in their own project", got, 302))
    check('  …and it landed', d1one(`SELECT status FROM project_members WHERE user_id='${B.studentId}' AND project_id='${B.id}'`)[0]?.status === 'active', 'the status did not change');
  check(
    "teacher B's own change is NOT written to admin_log",
    d1one(`SELECT COUNT(*) AS n FROM admin_log WHERE project_id='${B.id}'`)[0].n === logCount,
    `admin_log grew from ${logCount} to ${d1one(`SELECT COUNT(*) AS n FROM admin_log WHERE project_id='${B.id}'`)[0].n} for a teacher acting at home`,
  );
  check(
    'admin_log had nothing for B before the admin went in',
    logBefore === 0,
    `admin_log already held ${logBefore} rows for a project created seconds ago`,
  );

  got = await POST(admin, '/admin/leave', {});
  checkStatus('the admin leaves project B', got, 302);
  got = await GET(admin, '/t');
  check(
    'once out, the admin is no longer inside anyone’s practice',
    got.status === 302 && got.location === '/admin',
    `${got.line} -> ${got.status} ${got.location ?? ''}`,
  );

  /* ================================================================
   * 9. One person, a student in both practices
   * ================================================================ */

  console.log('\n--- a student who belongs to both practices ---');

  await GET(dual, `/dev/login?email=${encodeURIComponent(N.dual)}`);
  const noPick = await GET(dual, '/');
  check(
    'a student in two practices with no project chosen is asked which one',
    noPick.status === 302 && noPick.location === '/hats',
    `${noPick.line} -> ${noPick.status} ${noPick.location ?? ''} — expected the chooser at /hats`,
  );

  for (const [proj, mine, theirs, myLeft, theirLeft] of [
    [A, N.songA, N.songB, N.leftA, N.leftB],
    [B, N.songB, N.songA, N.leftB, N.leftA],
  ]) {
    const which = proj === A ? 'A' : 'B';
    dual.set('sruti_project', proj.id);
    const page = await GET(dual, '/me');
    if (checkStatus(`the dual student, acting in ${which}, opens their page`, page, 200)) {
      check(`  …and sees ${which}'s song`, page.text.includes(mine), `"${mine}" missing`);
      check(`  …and not the other practice's song`, !page.text.includes(theirs), `"${theirs}" leaked across`);
      check(`  …and sees ${which}'s lesson`, page.text.includes(myLeft), `"${myLeft}" missing`);
      check(`  …and not the other practice's lesson`, !page.text.includes(theirLeft), `"${theirLeft}" leaked across`);
    }
    const other = proj === A ? B : A;
    const otherSong = await GET(dual, `/me/${other.sectionId}`);
    checkStatus(`  …and cannot open the other practice's song page`, otherSong, 404);
    const otherMedia = await GET(dual, `/media/${other.recordingId}`);
    checkStatus(`  …and cannot play the other practice's recording`, otherMedia, [403, 404]);
  }

  /* Does the assignment row teacher A managed to write actually cost B
     anything? assignments is UNIQUE(student_id, section_id) and the
     assign routes are ON CONFLICT DO UPDATE, so a row A wrote first
     could be squatting on the pair B needs. */
  await POST(tb, '/t/sections', { title: `SquatSong${RUN}` });
  const squat = d1one(`SELECT id FROM sections WHERE project_id='${B.id}' AND title='SquatSong${RUN}'`)[0]?.id;
  if (squat) {
    await POST(ta, `/t/song/${squat}/assign`, { student_id: dualId }); // A, reaching into B's catalogue
    const bAssign = await POST(tb, `/t/s/${dualId}/assign`, { section_id: squat }); // B, doing the normal thing
    checkStatus("teacher B assigns their own new song to a student of theirs", bAssign, 302);
    const owner = d1one(`SELECT project_id FROM assignments WHERE student_id='${dualId}' AND section_id='${squat}'`)[0];
    check(
      "teacher A cannot squat on an assignment slot in B — the row belongs to B",
      owner?.project_id === B.id,
      `the assignment row for B's song sits in project ${owner?.project_id} (B is ${B.id}, A is ${A.id})`,
    );
    dual.set('sruti_project', B.id);
    const dualB = await GET(dual, '/me');
    check(
      "teacher A cannot squat on an assignment slot in B — B's student sees what B assigned",
      dualB.status === 200 && dualB.text.includes(`SquatSong${RUN}`),
      `${dualB.line} -> ${dualB.status}; the song B assigned is not on their page — teacher A's row took the slot`,
    );
  }

  /* a cookie naming a project they are not in gets them nowhere */
  const outsider = new Jar('outsider');
  await GET(outsider, `/dev/login?email=${encodeURIComponent(N.studentA)}`);
  outsider.set('sruti_project', B.id);
  const forged = await GET(outsider, '/me');
  if (checkStatus('a forged project cookie does not let A’s student into B', forged, [200, 302])) {
    check(
      '  …and they see nothing of B',
      !(forged.text ?? '').includes(N.songB) && !(forged.text ?? '').includes(B.sectionId),
      "B's material rendered for someone holding only a cookie",
    );
  }

  /* ================================================================
   * 10. Which hat?
   *
   * One identity, several standings. The chooser is the only thing
   * standing between "I am the admin, and I also teach" and a landing
   * page that silently picks one for you — so what matters here is not
   * that it renders, but that it cannot be talked into handing over a
   * hat the person does not hold.
   * ================================================================ */

  console.log('\n--- which hat? ---');

  /* The dual student: two memberships, so a real choice. */
  dual.cookies.delete('sruti_project');
  const chooser = await GET(dual, '/hats');
  if (checkStatus('a student in two practices is offered the chooser', chooser, 200)) {
    check('  …and both practices are on it', chooser.text.includes(N.projectA) && chooser.text.includes(N.projectB),
      `A present: ${chooser.text.includes(N.projectA)}, B present: ${chooser.text.includes(N.projectB)}`);
    check('  …and the admin console is not, for someone who is not an admin',
      !chooser.text.includes('/hats/choose" class="hat-form"><input type="hidden" name="to" value="admin"'),
      'the admin hat was offered to a student');
  }

  const picked = await POST(dual, '/hats/choose', { to: A.id });
  if (checkStatus('choosing a practice lands them in it', picked, 302)) {
    check('  …on their own pages, not a teacher\u2019s', picked.location === '/me', `went to ${picked.location}`);
    check('  …and the cookie now names that project', dual.cookies.get('sruti_project') === A.id,
      `cookie is ${dual.cookies.get('sruti_project')}`);
    const after = await GET(dual, '/me');
    check('  …and they see that practice\u2019s song', after.status === 200 && after.text.includes(N.songA),
      `${after.line} -> ${after.status}`);
  }

  /* A student of A only, asking for B. The chooser is a preference; the
     membership is the permission. */
  const onlyA = new Jar('studentAOnly');
  await GET(onlyA, `/dev/login?email=${encodeURIComponent(N.studentA)}`);
  const grab = await POST(onlyA, '/hats/choose', { to: B.id });
  check('a student of A cannot choose their way into B', grab.status === 302 && grab.location === '/hats',
    `${grab.line} -> ${grab.status} ${grab.location ?? ''}`);
  check('  …and no cookie for B was written', onlyA.cookies.get('sruti_project') !== B.id,
    `cookie is ${onlyA.cookies.get('sruti_project')}`);

  /* Nor can they claim to be the admin. */
  const claimAdmin = await POST(onlyA, '/hats/choose', { to: 'admin' });
  check('a student cannot choose the admin hat', claimAdmin.status === 302 && claimAdmin.location === '/hats',
    `${claimAdmin.line} -> ${claimAdmin.status} ${claimAdmin.location ?? ''}`);
  const stillStudent = await GET(onlyA, '/admin');
  check('  …and /admin still refuses them', stillStudent.status === 302 && stillStudent.location === '/',
    `${stillStudent.line} -> ${stillStudent.status} ${stillStudent.location ?? ''}`);

  /* One hat means no question. Teacher A belongs to exactly one
     practice and is not an admin, so the chooser must get out of the
     way rather than make them click through it. */
  const taHats = await GET(ta, '/hats');
  check('a teacher with one practice is not asked to choose',
    taHats.status === 302 && taHats.location === '/t/schedule/week',
    `${taHats.line} -> ${taHats.status} ${taHats.location ?? ''}`);

  /* The admin, who from here also teaches A: two hats, and the one
     they pick has to stick. */
  check(
    'the admin is a teacher of the practice they created, without being added by hand',
    d1one(`SELECT role FROM project_members WHERE project_id='${A.id}' AND user_id='${adminId}'`)[0]?.role === 'teacher',
    'no teacher membership was created for the admin when they made the project',
  );
  admin.cookies.delete('sruti_project');

  const adminHats = await GET(admin, '/hats');
  if (checkStatus('an admin who also teaches is offered both', adminHats, 200)) {
    check('  …the practice they teach', adminHats.text.includes(N.projectA), 'their practice is missing');
    check('  …and the admin console', adminHats.text.includes('value="admin"'), 'the admin hat is missing');
  }

  const beAdmin = await POST(admin, '/hats/choose', { to: 'admin' });
  check('the admin can choose the console', beAdmin.status === 302 && beAdmin.location === '/admin',
    `${beAdmin.line} -> ${beAdmin.status} ${beAdmin.location ?? ''}`);
  const adminLanding = await GET(admin, '/');
  check('  …and is not dropped back into their own practice next time',
    adminLanding.status === 302 && adminLanding.location === '/admin',
    `${adminLanding.line} -> ${adminLanding.status} ${adminLanding.location ?? ''} — the membership overrode the choice`);

  const beTeacher = await POST(admin, '/hats/choose', { to: A.id });
  check('the same admin can put the teacher hat on', beTeacher.status === 302 && beTeacher.location === '/t/schedule/week',
    `${beTeacher.line} -> ${beTeacher.status} ${beTeacher.location ?? ''}`);
  const teaching = await GET(admin, '/t');
  check('  …and teaches their own practice, not as a visiting admin',
    teaching.status === 200 && !teaching.text.includes('class="visiting"'),
    `${teaching.line} -> ${teaching.status}; the visiting banner appeared in their own practice`);

  /* Leaving a practice they are only visiting must put the admin hat
     back on, not leave them hatless for the fallback to pick up. */
  await POST(admin, `/admin/switch/${B.id}`, {});
  const visitingB = await GET(admin, '/t');
  check('the admin visiting B is told so', visitingB.status === 200 && visitingB.text.includes('class="visiting"'),
    `${visitingB.line} -> ${visitingB.status}; no visiting banner`);
  await POST(admin, '/admin/leave', {});
  const left = await GET(admin, '/');
  check('leaving a visited practice returns to the console, not to their own students',
    left.status === 302 && left.location === '/admin',
    `${left.line} -> ${left.status} ${left.location ?? ''}`);

  /* ----------------------------------------------------------------
     The admin who enrolled themselves as a student.

     Reported as "once I register myself as a student, I can no longer
     get in as teacher". A role is a fact about a membership, so the
     moment theirs said 'student' the membership decided, and it
     decided against them \u2014 in the one practice they run. Going in
     from the console has to mean going in as the admin, not as
     whatever this account happens to be there.
     ---------------------------------------------------------------- */

  r = await POST(admin, `/admin/p/${A.id}/members`, { email: N.adminEmail, role: 'student' });
  checkStatus('the admin enrols themselves as a student of their own practice', r, 302);
  check(
    '  …and the membership really did change',
    d1one(`SELECT role FROM project_members WHERE project_id='${A.id}' AND user_id='${adminId}'`)[0]?.role === 'student',
    'the role did not change to student',
  );

  admin.cookies.delete('sruti_project');
  const studentHat = await POST(admin, '/hats/choose', { to: A.id });
  check('  …so their hat there is the student one', studentHat.status === 302 && studentHat.location === '/me',
    `${studentHat.line} -> ${studentHat.status} ${studentHat.location ?? ''}`);
  const asStudent = await GET(admin, '/t');
  check('  …and the teacher pages turn them away, correctly',
    asStudent.status === 302 && asStudent.location === '/me',
    `${asStudent.line} -> ${asStudent.status} ${asStudent.location ?? ''}`);

  const backIn = await POST(admin, `/admin/switch/${A.id}`, {});
  check('the console can still put them on the teacher side of that same practice',
    backIn.status === 302 && backIn.location === '/t/schedule/week',
    `${backIn.line} -> ${backIn.status} ${backIn.location ?? ''}`);
  const teachingOwn = await GET(admin, '/t');
  if (checkStatus('  …and the teacher pages open', teachingOwn, 200)) {
    check('  …showing that practice\u2019s students', teachingOwn.text.includes(N.studentAName),
      `${N.studentAName} is not on the page`);
    check('  …with the banner up, because this is borrowed authority',
      teachingOwn.text.includes('class="visiting"'), 'no banner while in as the admin');
  }
  check(
    '  …and their student membership is untouched by any of it',
    d1one(`SELECT role FROM project_members WHERE project_id='${A.id}' AND user_id='${adminId}'`)[0]?.role === 'student',
    'going in as the admin rewrote the membership row',
  );

  /* A teacher of A is not an admin, and must not be able to do the same
     by typing the cookie. */
  const forgedAdminIn = new Jar('forgedAdminIn');
  await GET(forgedAdminIn, `/dev/login?email=${encodeURIComponent(N.studentA)}`);
  forgedAdminIn.set('sruti_project', `admin:${A.id}`);
  const forgedIn = await GET(forgedAdminIn, '/t');
  check('a student cannot forge their way in as the admin',
    forgedIn.status === 302 && forgedIn.location !== '/t/schedule/week',
    `${forgedIn.line} -> ${forgedIn.status} ${forgedIn.location ?? ''} — the cookie granted teacher powers`);
}

/* ================================================================== */

let exitCode = 0;
process.on('exit', restoreToml);
process.on('SIGINT', () => {
  stopServer();
  restoreToml();
  process.exit(130);
});

try {
  if (!(await portIsFree()))
    throw new Error(`Something is already answering on ${BASE}. Stop it, or set ISO_PORT.`);

  console.log(`${DIM}applying the schema to the local database…${OFF}`);
  execFileSync('npm', ['run', 'db:local'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });

  stripAiBlock();
  console.log(`${DIM}starting wrangler dev on ${BASE}…${OFF}`);
  await startServer();

  await main();
} catch (err) {
  exitCode = 1;
  console.log(`\n${RED}The run stopped early${OFF}: ${err.message}`);
  if (err.stack) console.log(err.stack.split('\n').slice(1, 6).join('\n'));
  console.log(`\n${DIM}--- the last of wrangler's own output ---${OFF}\n${serverLog.slice(-4000)}`);
  failures.push({ name: 'the run itself', detail: err.message });
} finally {
  stopServer();
  restoreToml();
}

for (const line of seen5xx) fail('a request came back 5xx', line);

console.log('\n' + '='.repeat(70));
console.log(`${passed} passed, ${failures.length} failed, ${passed + failures.length} assertions`);
if (failures.length) {
  console.log(`\n${RED}Failures${OFF}`);
  for (const f of failures) console.log(`  · ${f.name}\n      ${f.detail}`);
  exitCode = 1;
} else if (!exitCode) {
  console.log(`${GREEN}Every assertion held.${OFF}`);
}
console.log('='.repeat(70));

process.exit(exitCode);
