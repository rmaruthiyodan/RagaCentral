import {
  page, avatar, inlineTitle, titleWithScript, flash, disclosure, discloseAll,
} from './layout';
import { resumeCard, lessonLog, spoken } from './sessions';
import { studentSchedule, zoneOptions } from './schedule';
import { prettyIst, prettyIstDate, WEEKDAYS, inZone, type Occurrence } from '../tz';
import { esc, fmtBytes, fmtDuration, fmtDate, relativeDate } from '../util';
import type { User, Group, Section, Recording, Note, SessionRow, ClassSlot, AssignedRow } from '../types';

export type { AssignedRow };
export { isPalette, isMode, PALETTES } from './layout';

const STATUS_LABEL: Record<string, string> = {
  active: 'Active', paused: 'Paused', graduated: 'Graduated', ended: 'Ended',
  pending: 'Waiting for approval', disabled: 'Declined',
};
const STATUS_CLASS: Record<string, string> = {
  active: 'p-good', paused: 'p-warn', graduated: 'p-info', ended: 'p-bad',
  pending: 'p-warn', disabled: 'p-bad',
};

/** One search box, used on three different pages. */
function searchBox(action: string, q: string, placeholder: string): string {
  return `<form class="searchbox" method="get" action="${esc(action)}" role="search">
  <input type="search" name="q" value="${esc(q)}" placeholder="${esc(placeholder)}" aria-label="Search">
  <button class="btn btn-sm" type="submit">Search</button>
  ${q ? `<a class="btn btn-sm btn-quiet" href="${esc(action)}">Clear</a>` : ''}
</form>`;
}

const GOOGLE_G = `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
<path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z"/>
<path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.35 0-4.34-1.58-5.05-3.71H.96v2.33A9 9 0 0 0 9 18Z"/>
<path fill="#FBBC05" d="M3.95 10.71a5.4 5.4 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l2.99-2.33Z"/>
<path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l2.99 2.33C4.66 5.16 6.65 3.58 9 3.58Z"/></svg>`;

/* ================================================================== *
 * Signed out
 * ================================================================== */

export function landing(siteName: string, error?: string): string {
  return page(
    `${flash(error, 'err')}
<div style="max-width:520px;margin:8vh auto 0;text-align:center">
  <h1 style="font-size:2.6rem">${esc(siteName)}</h1>
  <p class="lede" style="margin:14px auto 30px;max-width:42ch">
    Recordings and notes from your Carnatic vocal lessons, kept in one place.
    Sign in with the Google account your teacher has for you.
  </p>
  <a class="google-btn" href="/auth/google">${GOOGLE_G} Sign in with Google</a>
  <p class="hint" style="margin-top:26px">
    Your recordings are private. Only you and your teacher can play them.
  </p>
</div>`,
    { title: 'Sign in', siteName, bodyClass: 'narrow' },
  );
}

export function waiting(user: User, siteName: string): string {
  return page(
    `<div style="max-width:520px;margin:8vh auto 0;text-align:center">
  <h1>Almost there</h1>
  <p class="lede" style="margin:14px auto 26px;max-width:44ch">
    You're signed in as <strong>${esc(user.email)}</strong>. Your teacher needs to approve
    this account before your lessons appear. You'll see them here as soon as that happens.
  </p>
  <div class="btn-row" style="justify-content:center">
    <a class="btn" href="/waiting">Check again</a>
    <form method="post" action="/auth/logout"><button class="btn btn-quiet" type="submit">Sign out</button></form>
  </div>
</div>`,
    { title: 'Waiting for approval', siteName, user: null },
  );
}

/* ================================================================== *
 * Teacher — students
 * ================================================================== */

export interface StudentRow extends User {
  song_count: number;
  rec_count: number;
  last_activity: string | null;
}

export function teacherStudents(
  user: User,
  students: StudentRow[],
  pendingCount: number,
  storage: { bytes: number },
  siteName: string,
  msg?: string,
  q = '',
  filter: { showAll: boolean; hiddenCount: number } = { showAll: false, hiddenCount: 0 },
): string {
  const pct = Math.min(100, (storage.bytes / (10 * 1024 ** 3)) * 100);

  const rows = students.length
    ? `<div class="rows">${students
        .map(
          (s) => `<a class="row" href="/t/s/${esc(s.id)}">
      ${avatar(s)}
      <div class="row-main">
        <div class="row-title">${esc(s.name)}${
          s.status !== 'active'
            ? ` <span class="pill ${STATUS_CLASS[s.status] ?? 'p-warn'}">${esc(STATUS_LABEL[s.status] ?? s.status)}</span>`
            : ''
        }</div>
        <div class="row-meta">
          <span>${esc(s.email)}</span>
          ${s.location ? `<span class="loc">${esc(s.location)}</span>` : ''}
          ${s.phone ? `<span class="loc">${esc(s.phone)}</span>` : ''}
          <span class="num">${s.song_count} ${s.song_count === 1 ? 'song' : 'songs'}</span>
          <span class="num">${s.rec_count} ${s.rec_count === 1 ? 'recording' : 'recordings'}</span>
          <span>last added ${esc(relativeDate(s.last_activity))}</span>
        </div>
      </div>
      <div class="row-actions"><span class="btn btn-sm">Open</span></div>
    </a>`,
        )
        .join('')}</div>`
    : q
      ? `<div class="empty"><strong>Nobody matches "${esc(q)}"</strong>
         Try part of a name, an email address, or where they live.</div>`
      : `<div class="empty"><strong>No students yet</strong>
       Ask them to open this site and sign in with Google. They'll appear under Approvals,
       and you decide who gets in.</div>`;

  return page(
    `${flash(msg)}
<div class="page-head">
  <h1>Students</h1>
  <p class="lede">Everyone you teach. Open a student to assign songs and add recordings.</p>
</div>

<div class="listbar">
  ${searchBox('/t', q, 'Name, email, place or number…')}
  ${
    filter.hiddenCount || filter.showAll
      ? `<form method="get" action="/t" class="showall">
      ${q ? `<input type="hidden" name="q" value="${esc(q)}">` : ''}
      <label>
        <input type="checkbox" name="all" value="1"${filter.showAll ? ' checked' : ''}
               onchange="this.form.submit()">
        Include paused, graduated and ended
        ${!filter.showAll ? `<span class="num">(${filter.hiddenCount})</span>` : ''}
      </label>
    </form>`
      : ''
  }
</div>

${
  pendingCount
    ? `<div class="flash" style="border-left-color:var(--brass);background:var(--brass-soft);color:var(--brass-ink)">
     ${pendingCount} ${pendingCount === 1 ? 'person is' : 'people are'} waiting to be let in ·
     <a href="/t/approvals" style="color:inherit;font-weight:600">Review</a>
   </div>`
    : ''
}

${rows}

<div class="section-head"><h2>Add a student</h2></div>
<div class="card">
  <p class="hint" style="margin-top:0;margin-bottom:14px">
    Add the Google address you have for them. They're approved the moment they first sign in,
    so there's no second step for you.
  </p>
  <form method="post" action="/t/students">
    <div class="field-row">
      <div class="field"><label for="ns-name">Name</label>
        <input id="ns-name" name="name" type="text" required placeholder="Anjali Menon"></div>
      <div class="field"><label for="ns-email">Google email</label>
        <input id="ns-email" name="email" type="email" required placeholder="anjali@gmail.com"></div>
    </div>
    <div class="field-row">
      <div class="field"><label for="ns-loc">Where they are <span class="opt">— optional</span></label>
        <input id="ns-loc" name="location" type="text" placeholder="Dubai, UAE"></div>
      <div class="field"><label for="ns-phone">WhatsApp number <span class="opt">— optional</span></label>
        <input id="ns-phone" name="phone" type="tel" inputmode="tel" placeholder="+91 98470 12345"></div>
      <div class="field"><label for="ns-tz">Time zone <span class="opt">— optional</span></label>
        <select id="ns-tz" name="time_zone">
          <option value="">Set on their first sign-in</option>
          ${zoneOptions(null)}
        </select></div>
    </div>
    <div class="form-actions">
      <button class="btn btn-primary" type="submit">Add student</button>
      <span class="hint">Only the name and email are needed — the rest can wait.</span>
    </div>
  </form>
</div>

<div class="section-head"><h2>Storage</h2></div>
<div class="card">
  <div class="meter-wrap">
    <div class="meter"><i style="width:${pct.toFixed(1)}%"></i></div>
    <span><strong class="num">${esc(fmtBytes(storage.bytes))}</strong> of 10 GB free tier used</span>
  </div>
  <p class="hint" style="margin-top:10px">
    Beyond 10 GB it costs about 1.5 cents per gigabyte per month. Playback is always free.
  </p>
</div>`,
    { title: 'Students', user, siteName, nav: 'students' },
  );
}

export function teacherApprovals(user: User, pending: User[], siteName: string, msg?: string): string {
  const rows = pending.length
    ? `<div class="rows">${pending
        .map(
          (p) => `<div class="row">
      ${avatar(p)}
      <div class="row-main">
        <div class="row-title">${esc(p.name)}</div>
        <div class="row-meta"><span>${esc(p.email)}</span><span>signed in ${esc(relativeDate(p.created_at))}</span></div>
      </div>
      <div class="row-actions">
        <form method="post" action="/t/approvals/${esc(p.id)}" style="display:flex;gap:6px">
          <button class="btn btn-sm btn-primary" name="action" value="student">Approve as student</button>
          <button class="btn btn-sm" name="action" value="teacher">Make teacher</button>
          <button class="btn btn-sm btn-danger" name="action" value="reject">Reject</button>
        </form>
      </div>
    </div>`,
        )
        .join('')}</div>`
    : `<div class="empty"><strong>Nobody waiting</strong>
       When someone signs in with Google for the first time, they'll appear here.</div>`;

  return page(
    `${flash(msg)}
<div class="page-head">
  <h1>Approvals</h1>
  <p class="lede">Nobody sees a single recording until you approve them here.</p>
</div>
${rows}

<div class="section-head"><h2>Invite someone by email</h2></div>
<div class="card">
  <p class="hint" style="margin-top:0;margin-bottom:14px">
    Add the Google address you have for a student and they'll be approved automatically the
    first time they sign in — no second step for you.
  </p>
  <form method="post" action="/t/invite">
    <div class="field-row">
      <div class="field"><label for="inv-name">Name</label><input id="inv-name" name="name" type="text" required placeholder="Anjali Menon"></div>
      <div class="field"><label for="inv-email">Google email</label><input id="inv-email" name="email" type="email" required placeholder="anjali@gmail.com"></div>
    </div>
    <button class="btn btn-primary" type="submit">Add student</button>
  </form>
</div>`,
    { title: 'Approvals', user, siteName, nav: 'approvals' },
  );
}

/* ================================================================== *
 * Teacher — song catalogue
 * ================================================================== */

export function teacherCatalogue(
  user: User,
  groups: Group[],
  sections: (Section & { assigned_count: number })[],
  siteName: string,
  msg?: string,
  q = '',
): string {
  const byGroup = new Map<string, (Section & { assigned_count: number })[]>();
  for (const s of sections) {
    const k = s.group_id ?? '__none';
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k)!.push(s);
  }

  const groupOptions = groups
    .map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`)
    .join('');

  // With a full catalogue — ten groups, ninety songs — everything open at once is a
  // wall. Collapsed, the group names are an index. What you open is remembered.
  const openByDefault = groups.length <= 3;

  /* Sorting a catalogue is done in bursts, so the controls have to work
     without opening each group first — hence the form outside the details
     and the buttons reaching it by id, the same shape the recordings use.
     The ungrouped bucket isn't a real group and can't be moved. */
  const groupBlock = (id: string, name: string, nameMl: string | null, gi = -1) => {
    const items = byGroup.get(id) ?? [];
    const movable = id !== '__none' && groups.length > 1;
    const before = movable
      ? `<form id="gmv-${esc(id)}" method="post" action="/t/groups/${esc(id)}/move" class="mv-form"></form>`
      : '';
    const actions = movable
      ? `<button class="btn btn-sm" type="submit" form="gmv-${esc(id)}" name="dir" value="up"
           data-keep-open title="Move this group up"${gi === 0 ? ' disabled' : ''}>&uarr;</button>
         <button class="btn btn-sm" type="submit" form="gmv-${esc(id)}" name="dir" value="down"
           data-keep-open title="Move this group down"${
             gi === groups.length - 1 ? ' disabled' : ''
           }>&darr;</button>`
      : '';
    const body = `${
    items.length
      ? `<div class="rows">${items
          .map(
            (s, i) => `<div class="row">
        <div class="row-main">
          <div class="row-title">${inlineTitle(s.title, s.title_ml)}</div>
          <div class="row-meta">
            ${s.raga ? `<span>Raga ${esc(s.raga)}</span>` : ''}
            ${s.taala ? `<span>Taala ${esc(s.taala)}</span>` : ''}
            ${s.composer ? `<span>${esc(s.composer)}</span>` : ''}
            <span class="num">${s.assigned_count} ${s.assigned_count === 1 ? 'student' : 'students'}</span>
          </div>
        </div>
        <div class="row-actions">
          <span class="rec-order">
            <form method="post" action="/t/sections/${esc(s.id)}/move">
              <button class="btn btn-sm" name="dir" value="up" type="submit"
                title="Move up within this group"${i === 0 ? ' disabled' : ''}>&uarr;</button></form>
            <form method="post" action="/t/sections/${esc(s.id)}/move">
              <button class="btn btn-sm" name="dir" value="down" type="submit"
                title="Move down within this group"${
                  i === items.length - 1 ? ' disabled' : ''
                }>&darr;</button></form>
          </span>
          <a class="btn btn-sm btn-primary" href="/t/song/${esc(s.id)}">Open</a>
          <form method="post" action="/t/sections/${esc(s.id)}/delete" onsubmit="return confirm('Delete &quot;${esc(
            s.title,
          )}&quot;? Every recording and note filed under it will be deleted too.')">
            <button class="btn btn-sm btn-danger" type="submit">Delete</button></form>
        </div>
      </div>`,
          )
          .join('')}</div>`
      : `<div class="empty">Nothing in this group yet.</div>`
  }${
    id !== '__none'
      ? `<form method="post" action="/t/groups/${esc(id)}/delete" style="margin-top:14px"
           onsubmit="return confirm('Delete this group? The songs in it stay, but lose their group.')">
           <button class="btn btn-sm btn-danger" type="submit">Delete group</button></form>`
      : ''
  }`;

    return disclosure({
      key: `group:${id}`,
      cls: 'disc-group',
      open: openByDefault,
      title: `${esc(name)}${
        nameMl ? ` <span class="ml" style="font-weight:400;color:var(--ink-3)">${esc(nameMl)}</span>` : ''
      }`,
      meta: `${items.length} ${items.length === 1 ? 'song' : 'songs'}`,
      body,
      before,
      actions,
    });
  };

  return page(
    `${flash(msg)}
<div class="page-head">
  <h1>Songs</h1>
  <p class="lede">
    One shared list. Assigning a song to a student is a separate step, so the same song can sit at
    a different stage for each of them.
  </p>
</div>

${searchBox('/t/catalogue', q, 'Title, Malayalam, raga, taala or composer…')}

${
  !sections.length && !q
    ? `<div class="card" style="margin-bottom:20px">
    <h3>Start from the standard repertoire</h3>
    <p class="hint" style="margin:6px 0 12px">
      Loads the usual beginner-to-varnam course — sarali, janta, dhatu and sthayi varisai,
      alankarams, geethams, swarajatis and the Adi and Ata tala varnams, with raga, taala and
      composer filled in. Nothing is overwritten, and you can edit or delete any of it.
    </p>
    <form method="post" action="/t/catalogue/seed">
      <button class="btn btn-primary" type="submit">Load starter catalogue</button>
    </form>
  </div>`
    : ''
}

<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr));margin-bottom:10px">
  <details class="panel">
    <summary>Add a song</summary>
    <div class="panel-body">
      <form method="post" action="/t/sections">
        <div class="field">
          <label for="s-title">Title <span class="opt">— transliterated</span></label>
          <input id="s-title" name="title" type="text" required placeholder="Vatapi Ganapatim">
        </div>
        <div class="field">
          <label for="s-title-ml">Title in Malayalam <span class="opt">— optional</span></label>
          <input id="s-title-ml" name="title_ml" type="text" class="ml" lang="ml" placeholder="വാതാപി ഗണപതിം">
          <p class="hint">Type or paste Malayalam here. Leave it blank if you'd rather not.</p>
        </div>
        <div class="field-row">
          <div class="field"><label for="s-raga">Raga</label><input id="s-raga" name="raga" type="text" placeholder="Hamsadhwani"></div>
          <div class="field"><label for="s-taala">Taala</label><input id="s-taala" name="taala" type="text" placeholder="Adi"></div>
        </div>
        <div class="field-row">
          <div class="field"><label for="s-composer">Composer</label><input id="s-composer" name="composer" type="text" placeholder="Muthuswami Dikshitar"></div>
          <div class="field"><label for="s-group">Group</label>
            <select id="s-group" name="group_id"><option value="">— none —</option>${groupOptions}</select>
          </div>
        </div>
        <button class="btn btn-primary" type="submit">Add song</button>
      </form>
    </div>
  </details>

  <details class="panel">
    <summary>Add a group</summary>
    <div class="panel-body">
      <p class="hint" style="margin-top:0">
        Group songs however you actually teach — by stage, by raga, by whatever you call it.
      </p>
      <form method="post" action="/t/groups">
        <div class="field"><label for="g-name">Group name</label>
          <input id="g-name" name="name" type="text" required placeholder="Sarali varisai"></div>
        <div class="field"><label for="g-name-ml">In Malayalam <span class="opt">— optional</span></label>
          <input id="g-name-ml" name="name_ml" type="text" class="ml" lang="ml"></div>
        <button class="btn btn-primary" type="submit">Add group</button>
      </form>
    </div>
  </details>
</div>

${
  q
    ? sections.length
      ? `<div class="section-head"><div><h2>${sections.length} ${
          sections.length === 1 ? 'match' : 'matches'
        } for "${esc(q)}"</h2></div></div>
       <div class="rows">${sections
         .map(
           (s) => `<div class="row">
         <div class="row-main">
           <div class="row-title">${inlineTitle(s.title, s.title_ml)}</div>
           <div class="row-meta">
             ${s.raga ? `<span>Raga ${esc(s.raga)}</span>` : ''}
             ${s.taala ? `<span>Taala ${esc(s.taala)}</span>` : ''}
             ${s.composer ? `<span>${esc(s.composer)}</span>` : ''}
             <span class="num">${s.assigned_count} ${s.assigned_count === 1 ? 'student' : 'students'}</span>
           </div>
         </div>
       </div>`,
         )
         .join('')}</div>`
      : `<div class="empty"><strong>No songs match "${esc(q)}"</strong>
         Search covers the title in either script, plus raga, taala and composer.</div>`
    : `${groups.length + (byGroup.has('__none') ? 1 : 0) > 1 ? discloseAll('Open a group to see its songs.') : ''}
${groups.map((g, gi) => groupBlock(g.id, g.name, g.name_ml, gi)).join('')}
${byGroup.has('__none') ? groupBlock('__none', 'Ungrouped', null) : ''}`
}
${
  !groups.length && !sections.length
    ? `<div class="empty"><strong>Nothing here yet</strong>
       Start by adding a group like "Sarali varisai", then put songs in it.</div>`
    : ''
}`,
    { title: 'Songs', user, siteName, nav: 'catalogue' },
  );
}

/* ================================================================== *
 * The song workspace — shared by teacher and student
 * ================================================================== */

export function songPage(opts: {
  viewer: User;
  student: User;
  section: Section & { group_name: string | null };
  /** `locked` is 1 when this student may not hear it — see loadSong. */
  recordings: (Recording & { locked?: number })[];
  notes: Note[];
  siteName: string;
  msg?: string;
  /** Show the speak-it button on the note box. */
  dictate?: boolean;
}): string {
  const { viewer, student, section, recordings, notes, siteName, msg } = opts;
  const dictate = Boolean(opts.dictate);
  const isTeacher = viewer.role === 'teacher';
  const backHref = isTeacher ? `/t/s/${student.id}` : '/me';
  const backLabel = isTeacher ? `← ${student.name}` : '← My songs';

  const notesFor = (recId: string | null) =>
    notes.filter((n) => (recId === null ? !n.recording_id : n.recording_id === recId));

  const renderNote = (n: Note) => `<div class="note">
  <div class="note-meta">
    <span>${esc(fmtDate(n.created_at))}</span>
    ${
      isTeacher
        ? `<form method="post" action="/notes/${esc(n.id)}/delete">
             <button class="btn btn-sm btn-danger" type="submit" style="padding:2px 6px;font-size:11px">Delete</button>
           </form>`
        : ''
    }
  </div>
  ${n.title ? `<p class="note-title">${esc(n.title)}</p>` : ''}
  ${n.body_ml ? `<p class="note-body ml">${esc(n.body_ml)}</p>` : ''}
  ${n.body ? `<p class="note-body${n.body_ml ? ' said-en' : ''}">${esc(n.body)}</p>` : ''}
  ${n.image_key ? `<img class="note-img" src="/img/${esc(n.id)}" alt="Note attachment" loading="lazy">` : ''}
  <div class="note-tools">
    <a class="note-dl" href="/note/${esc(n.id)}/download">Download note</a>
    ${n.image_key ? `<a class="note-dl" href="/img/${esc(n.id)}?download=1">Download image</a>` : ''}
  </div>
</div>`;

  /**
   * A recording this student hasn't been given: named, so they know it exists
   * and can ask for it, but with nothing to play. The teacher gets the button
   * that hands it over, right here rather than back in the catalogue.
   */
  const renderLocked = (r: Recording) => `<div class="rec is-locked">
  <div class="rec-sum-top">
    <span class="rec-title">
      <span class="lock" aria-hidden="true">🔒</span>
      ${esc(r.title || (r.kind === 'video' ? 'Video clip' : 'Recording'))}
      ${r.part ? `<span class="part-tag">${esc(r.part)}</span>` : ''}
    </span>
    <span class="rec-meta">
      <span>${esc(fmtDuration(r.duration_sec))}</span>
      ${isTeacher ? `<span>${esc(fmtDate(r.created_at))}</span>` : ''}
    </span>
  </div>
  ${r.description ? `<p class="rec-desc">${esc(r.description)}</p>` : ''}
  <div class="locked-foot">
    ${
      isTeacher
        ? `<span class="locked-note">${esc(student.name.split(' ')[0])} can't hear this one.</span>
      <form method="post" action="/t/recordings/${esc(r.id)}/share">
        <input type="hidden" name="student_id" value="${esc(student.id)}">
        <input type="hidden" name="back" value="${esc(backHref === '/me' ? '/me' : `/t/s/${student.id}/${section.id}`)}">
        <button class="btn btn-sm btn-primary" type="submit">Unlock for ${esc(student.name.split(' ')[0])}</button>
      </form>`
        : `<span class="locked-note">Your teacher hasn't shared this one with you yet.</span>`
    }
  </div>
</div>`;

  const renderRec = (r: Recording, seq: number) => {
    const { idx, total } = partIndex.get(r.id) ?? { idx: 0, total: 1 };
    const media =
      r.kind === 'video'
        ? `<video controls preload="metadata" playsinline src="/media/${esc(r.id)}"></video>`
        : `<audio controls preload="metadata" src="/media/${esc(r.id)}"></audio>`;
    const attached = notesFor(r.id);
    // The top recording opens, so there's always something to press play on.
    const open = seq === 0 || recCount <= 2;
    /* The reorder form sits outside the <details> and the buttons reach it
       by id: a <form> isn't valid inside a <summary>, and anything inside
       the details is hidden while it's closed — which is exactly when you
       want to reorder, without opening every take first. */
    return `${
      isTeacher
        ? `<form id="mv-${esc(r.id)}" method="post" action="/t/recordings/${esc(
            r.id,
          )}/move" class="mv-form">
      <input type="hidden" name="back" value="${esc(`/t/s/${student.id}/${section.id}`)}">
    </form>`
        : ''
    }
<details class="rec" data-rec="${esc(r.id)}" data-disc="rec:${esc(r.id)}"${
      open ? ' open' : ''
    }>
  <summary>
    <span class="disc-mark" aria-hidden="true"></span>
    <span class="rec-sum">
      <span class="rec-sum-top">
        <span class="rec-title">
          ${esc(r.title || (r.kind === 'video' ? 'Video clip' : 'Recording'))}
          ${r.part ? `<span class="part-tag">${esc(r.part)}</span>` : ''}
        </span>
        <span class="rec-meta">
          <span>${esc(fmtDate(r.created_at))}</span>
          <span>${esc(fmtDuration(r.duration_sec))}</span>
          <span>${esc(fmtBytes(r.size_bytes))}</span>
          ${r.source === 'recorded' ? '<span>recorded in browser</span>' : ''}
        </span>
      </span>
      ${r.description ? `<span class="rec-sum-desc">${esc(r.description)}</span>` : ''}
    </span>
    ${
      isTeacher
        ? `<span class="rec-order">
      <button class="btn btn-sm" type="submit" form="mv-${esc(r.id)}" name="dir" value="up"
        data-keep-open title="Move up"${idx === 0 ? ' disabled' : ''}>&uarr;</button>
      <button class="btn btn-sm" type="submit" form="mv-${esc(r.id)}" name="dir" value="down"
        data-keep-open title="Move down"${idx === total - 1 ? ' disabled' : ''}>&darr;</button>
    </span>`
        : ''
    }
  </summary>
  <div class="rec-body">
  ${r.description ? `<p class="rec-desc">${esc(r.description)}</p>` : ''}
  ${media}
  <div class="controls">
    <div class="ctrl-group">
      <span class="ctrl-label">Speed</span>
      <div class="speeds" data-speeds>
        <button type="button" data-rate="0.5">0.5&times;</button>
        <button type="button" data-rate="0.75">0.75&times;</button>
        <button type="button" data-rate="1" aria-pressed="true">1&times;</button>
        <button type="button" data-rate="1.25">1.25&times;</button>
      </div>
    </div>
    <div class="ctrl-group">
      <span class="ctrl-label">Loop</span>
      <button type="button" class="btn btn-sm" data-loop>Set A</button>
      <span class="loop-state" data-loop-state></span>
    </div>
    <div class="ctrl-group" style="margin-left:auto">
      <a class="btn btn-sm" href="/media/${esc(r.id)}?download=1">Download</a>
      ${
        isTeacher
          ? `<form method="post" action="/t/recordings/${esc(r.id)}/unshare">
               <input type="hidden" name="student_id" value="${esc(student.id)}">
               <input type="hidden" name="back" value="/t/s/${esc(student.id)}/${esc(section.id)}">
               <button class="btn btn-sm" type="submit"
                 title="Take this one back from ${esc(student.name.split(' ')[0])}">Lock</button></form>
             <form method="post" action="/t/recordings/${esc(
               r.id,
             )}/delete" onsubmit="return confirm('Delete this recording permanently?')">
               <button class="btn btn-sm btn-danger" type="submit">Delete</button></form>`
          : ''
      }
    </div>
  </div>
  ${attached.length ? `<div style="margin-top:13px">${attached.map(renderNote).join('')}</div>` : ''}
  ${
    isTeacher
      ? `<details class="panel" style="margin-top:12px;border:none;background:transparent">
      <summary style="padding:6px 0;font-size:13px;color:var(--ink-3)">Add a note on this recording</summary>
      <div class="panel-body" style="padding:10px 0 0;border-top:1px solid var(--line)">
        <form method="post" action="/t/notes" enctype="multipart/form-data">
          <input type="hidden" name="section_id" value="${esc(section.id)}">
          <input type="hidden" name="student_id" value="${esc(student.id)}">
          <input type="hidden" name="recording_id" value="${esc(r.id)}">
          <div class="field"><textarea name="body" rows="2" placeholder="Watch the gamaka at 0:42 — it should be slower."></textarea></div>
          <div class="field"><label>Screenshot <span class="opt">— optional</span></label>
            <input type="file" name="image" accept="image/*"></div>
          <button class="btn btn-sm btn-primary" type="submit">Save note</button>
        </form>
      </div>
    </details>`
      : ''
  }
  </div>
</details>`;
  };

  const generalNotes = notesFor(null);
  const open = recordings.filter((r) => !r.locked);
  const locked = recordings.filter((r) => r.locked);
  const recCount = open.length;

  /* The server moves a recording within its own part, so the arrows have to
     be disabled by position within the part — not within the whole list, or
     the first take of a second part offers an "up" that does nothing. */
  const partIndex = new Map<string, { idx: number; total: number }>();
  {
    const byPart = new Map<string, Recording[]>();
    for (const r of open) {
      const k = r.part || '';
      let list = byPart.get(k);
      if (!list) byPart.set(k, (list = []));
      list.push(r);
    }
    for (const list of byPart.values())
      list.forEach((r, i) => partIndex.set(r.id, { idx: i, total: list.length }));
  }

  /* Shut by default, like the one on the song page: recording is something
     you go and do, and until you do, the button and the whole apparatus are
     just a wall between the teacher and the takes they came to hear. No
     data-disc — always closed on load rather than remembered. */
  const recorderBlock = isTeacher
    ? `<details class="panel addrec">
  <summary>
    <span class="addrec-t">Add a recording</span>
    <span class="addrec-s">record in the browser, or drop in files</span>
  </summary>
  <div class="panel-body">
  <div class="tabs" role="tablist">
    <button role="tab" aria-selected="true" data-tab="record">Record now</button>
    <button role="tab" aria-selected="false" data-tab="upload">Upload files</button>
  </div>

  <div data-panel="record">
    <div class="recorder"
         data-student="${esc(student.id)}" data-section="${esc(section.id)}">
      <div class="rec-stage">
        <span class="rec-dot" data-dot></span>
        <span class="rec-time" data-timer>0:00</span>
        <div class="level" data-level-wrap hidden><div class="level-fill" data-level></div></div>
      </div>
      <div class="btn-row" style="margin-top:16px">
        <button class="btn btn-primary" type="button" data-start>Start recording</button>
        <button class="btn" type="button" data-stop disabled>Stop</button>
        <label style="display:flex;align-items:center;gap:7px;margin:0 0 0 6px;font-size:13.5px;font-weight:500;color:var(--ink-2)">
          <input type="checkbox" data-video style="width:auto"> Record video instead
        </label>
      </div>
      <p class="rec-status" data-status>Audio is saved as MP3 so it plays on every phone, including older iPhones.</p>
      <div data-preview hidden style="margin-top:14px;padding-top:16px;border-top:1px solid var(--line)">
        <div data-player></div>
        <div class="field" style="margin-top:12px">
          <label for="rec-title">Name this take</label>
          <input id="rec-title" type="text" data-title placeholder="Pallavi, slow">
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" type="button" data-save>Save recording</button>
          <button class="btn btn-quiet" type="button" data-discard>Discard</button>
        </div>
        <div class="progress" data-progress><div class="progress-fill" data-progress-fill></div></div>
      </div>
    </div>
  </div>

  <div data-panel="upload" hidden>
    <div class="dropzone" data-drop
         data-student="${esc(student.id)}" data-section="${esc(section.id)}">
      <strong>Drop audio or video here</strong>
      or click to choose files — MP3, M4A, WAV, MP4 and MOV all work
      <input type="file" data-file multiple accept="audio/*,video/*" hidden>
    </div>
    <div class="queue" data-queue></div>
  </div>
  </div>
</details>`
    : '';

  return page(
    `${flash(msg)}
<a class="crumb" href="${esc(backHref)}">${esc(backLabel)}</a>
<div class="page-head">
  <h1>${titleWithScript(section.title, section.title_ml)}</h1>
  <p class="lede">
    ${[
      section.group_name ? esc(section.group_name) : '',
      section.raga ? `Raga ${esc(section.raga)}` : '',
      section.taala ? `Taala ${esc(section.taala)}` : '',
      section.composer ? esc(section.composer) : '',
      isTeacher ? `for ${esc(student.name)}` : '',
    ]
      .filter(Boolean)
      .join(' · ')}
  </p>
</div>

${
  generalNotes.length
    ? `<div class="section-head"><h2>Notes</h2></div>${generalNotes.map(renderNote).join('')}`
    : ''
}

<div class="section-head">
  <div><h2>Recordings</h2>
    ${
      locked.length
        ? `<p class="lede">${open.length} to practise${
            isTeacher
              ? `, and ${locked.length} not yet given to ${esc(student.name.split(' ')[0])}.`
              : `, and ${locked.length} your teacher hasn't shared yet.`
          }</p>`
        : ''
    }</div>
</div>
${open.length > 2 ? discloseAll('Your browser remembers what you leave open.') : ''}
${
  open.length
    ? open.map((r, i) => renderRec(r, i)).join('')
    : `<div class="empty"><strong>Nothing to play yet</strong>${
        isTeacher
          ? 'Record a take below, or unlock one of the others.'
          : locked.length
            ? 'Your teacher hasn\'t shared any of these with you yet.'
            : 'Your teacher hasn\'t added a recording for this song yet.'
      }</div>`
}

${
  locked.length
    ? `<div class="section-head" style="margin-top:26px">
    <div><h3>${
      isTeacher ? 'Not shared with them' : 'Not yet shared with you'
    }</h3>
      <p class="lede">${
        isTeacher
          ? 'These exist on the song but are not for this student — yet.'
          : 'These takes exist for this song. Ask your teacher if you need one.'
      }</p></div>
  </div>
  ${locked.map(renderLocked).join('')}`
    : ''
}

${recorderBlock}

${
  isTeacher
    ? `<details class="panel" style="margin-top:14px">
  <summary>Add a note for this song</summary>
  <div class="panel-body">
    <form method="post" action="/t/notes" enctype="multipart/form-data">
      <input type="hidden" name="section_id" value="${esc(section.id)}">
      <input type="hidden" name="student_id" value="${esc(student.id)}">
      ${spoken({
        id: 'note-body',
        name: 'body',
        label: 'Note',
        placeholder: 'Sing the second sangati only after the first is steady.',
        en: '',
        ml: '',
        dictate,
      })}
      <div class="field">
        <label for="note-img">Screenshot or photo of notation <span class="opt">— optional</span></label>
        <input id="note-img" name="image" type="file" accept="image/*">
        <p class="hint">You can also paste an image straight into the note box.</p>
      </div>
      <button class="btn btn-primary" type="submit">Save note</button>
    </form>
  </div>
</details>`
    : ''
}`,
    {
      title: section.title,
      user: viewer,
      siteName,
      nav: isTeacher ? 'students' : 'mine',
      scripts: isTeacher
        ? dictate
          ? ['/player.js', '/recorder.js', '/dictate.js']
          : ['/player.js', '/recorder.js']
        : ['/player.js'],
    },
  );
}

/* ================================================================== *
 * Student home
 * ================================================================== */

export function studentHome(
  user: User,
  assigned: AssignedRow[],
  sessions: SessionRow[],
  siteName: string,
  q = '',
  upcoming: Occurrence[] = [],
): string {
  const live = assigned.filter((a) => !a.completed_at);
  const withRecs = live.filter((a) => a.rec_count > 0);
  const waiting = live.filter((a) => a.rec_count === 0);
  const finished = assigned.filter((a) => a.completed_at);

  const rowFor = (a: AssignedRow) => `<a class="row${a.completed_at ? ' is-done' : ''}" href="/me/${esc(a.id)}">
  <div class="row-main">
    <div class="row-title">${inlineTitle(a.title, a.title_ml)}${
      a.completed_at ? ' <span class="pill p-good">finished</span>' : ''
    }</div>
    <div class="row-meta">
      ${a.group_name ? `<span>${esc(a.group_name)}</span>` : ''}
      ${a.raga ? `<span>Raga ${esc(a.raga)}</span>` : ''}
      ${a.rec_count ? `<span class="num">${a.rec_count} ${a.rec_count === 1 ? 'recording' : 'recordings'}</span>` : ''}
      ${a.note_count ? `<span class="num">${a.note_count} ${a.note_count === 1 ? 'note' : 'notes'}</span>` : ''}
      ${a.last_added ? `<span>updated ${esc(relativeDate(a.last_added))}</span>` : ''}
    </div>
  </div>
  <div class="row-actions"><span class="btn btn-sm">${a.rec_count ? 'Listen' : 'Open'}</span></div>
</a>`;

  return page(
    `<div class="page-head">
  <h1>My songs</h1>
  <p class="lede">Everything your teacher has recorded for you. Slow any of them down without
    changing the pitch, and loop the phrase you're working on.</p>
</div>

${resumeCard(sessions[0] ?? null, { isTeacher: false, firstName: user.name.split(' ')[0] })}

${studentSchedule(user, upcoming)}

${searchBox('/me', q, 'Search your songs by name or raga…')}

${
  withRecs.length
    ? `<div class="rows">${withRecs.map(rowFor).join('')}</div>`
    : q
      ? `<div class="empty"><strong>Nothing matches "${esc(q)}"</strong>
         Search covers the song name in either script, plus raga and composer.</div>`
      : `<div class="empty"><strong>Nothing to practise yet</strong>
       As soon as your teacher adds a recording, it appears here.</div>`
}

${
  waiting.length
    ? `<div class="section-head"><h2>Assigned, nothing recorded yet</h2></div>
     <div class="rows">${waiting.map(rowFor).join('')}</div>`
    : ''
}

${
  finished.length
    ? `<div class="section-head">
     <div><h2>Finished</h2><p class="lede">Songs you've completed. The recordings stay here.</p></div>
   </div>
   <div class="rows">${finished.map(rowFor).join('')}</div>`
    : ''
}

${lessonLog(sessions, { isTeacher: false, studentId: user.id, assigned })}`,
    { title: 'My songs', user, siteName, nav: 'mine' },
  );
}

export function notFound(user: User | null, siteName: string): string {
  return page(
    `<div style="max-width:460px;margin:8vh auto 0;text-align:center">
  <h1>Not here</h1>
  <p class="lede" style="margin:12px auto 24px">
    That page doesn't exist, or it isn't yours to open.
  </p>
  <a class="btn" href="${user ? (user.role === 'teacher' ? '/t' : '/me') : '/'}">Go back</a>
</div>`,
    { title: 'Not found', user, siteName },
  );
}
