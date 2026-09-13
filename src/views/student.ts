/* ==================================================================
 * One student, across five tabs.
 *
 * This used to be a single page carrying songs, the schedule, a month
 * calendar, the whole lesson history, a log form and the settings. It
 * had become impossible to scan — finding one past class meant scrolling
 * past everything else. Each tab now answers one question.
 * ================================================================== */

import { page, avatar, inlineTitle } from './layout';
import { resumeCard, lessonLog } from './sessions';
import { monthCalendar, zoneOptions } from './schedule';
import { esc, fmtDate, relativeDate, waLink } from '../util';
import { prettyIst, prettyIstDate, WEEKDAYS, inZone, type Occurrence } from '../tz';
import type { User, Section, SessionRow, ClassSlot, AssignedRow } from '../types';

export type StudentTab = 'overview' | 'songs' | 'lessons' | 'schedule' | 'settings';

export const STATUS_LABEL: Record<string, string> = {
  active: 'Active', paused: 'Paused', graduated: 'Graduated', ended: 'Ended',
  pending: 'Waiting for approval', disabled: 'Declined',
};
export const STATUS_CLASS: Record<string, string> = {
  active: 'p-good', paused: 'p-warn', graduated: 'p-info', ended: 'p-bad',
  pending: 'p-warn', disabled: 'p-bad',
};

export interface TabCounts {
  songs: number;
  lessons: number;
}

function shell(student: User, tab: StudentTab, counts: TabCounts, body: string): string {
  const t = (id: StudentTab, href: string, label: string, badge?: number) =>
    `<a class="stab${tab === id ? ' is-on' : ''}" href="${esc(href)}">${esc(label)}${
      badge ? ` <span class="stab-n">${badge}</span>` : ''
    }</a>`;

  return `<a class="crumb" href="/t">← Students</a>
<div class="student-head">
  ${avatar(student)}
  <div class="sh-who">
    <h1>${esc(student.name)}</h1>
    <p class="lede">${esc(student.email)}${student.location ? ` · ${esc(student.location)}` : ''}${
      student.phone
        ? ` · ${
            waLink(student.phone)
              ? `<a class="wa" href="${esc(waLink(student.phone)!)}" target="_blank" rel="noopener"
                   title="Open WhatsApp">${esc(student.phone)}</a>`
              : esc(student.phone)
          }`
        : ''
    }</p>
  </div>
  <span class="pill ${STATUS_CLASS[student.status] ?? 'p-warn'}">${esc(
    STATUS_LABEL[student.status] ?? student.status,
  )}</span>
</div>

${
  student.status !== 'active'
    ? `<div class="flash" style="border-left-color:var(--warn);background:var(--warn-soft);color:var(--warn)">
     ${esc(STATUS_LABEL[student.status] ?? student.status)}${
       student.status_note ? ` — ${esc(student.status_note)}` : ''
     }${student.status_changed_at ? ` · since ${esc(fmtDate(student.status_changed_at))}` : ''}
   </div>`
    : ''
}

<nav class="stabs">
  ${t('overview', `/t/s/${student.id}`, 'Overview')}
  ${t('songs', `/t/s/${student.id}/songs`, 'Songs', counts.songs)}
  ${t('lessons', `/t/s/${student.id}/lessons`, 'Past classes', counts.lessons)}
  ${t('schedule', `/t/s/${student.id}/schedule`, 'Schedule')}
  ${t('settings', `/t/s/${student.id}/settings`, 'Settings')}
</nav>

${body}`;
}

/* ------------------------------------------------------------------ *
 * Overview — what you need before a class
 * ------------------------------------------------------------------ */

export function overviewTab(
  user: User,
  student: User,
  counts: TabCounts,
  d: {
    sessions: SessionRow[];
    upcoming: Occurrence[];
    learning: AssignedRow[];
  },
  siteName: string,
  msg?: string,
): string {
  const next = d.upcoming[0];
  const tz = student.time_zone;

  return page(
    shell(
      student,
      'overview',
      counts,
      `${msg ? `<div class="flash">${esc(msg)}</div>` : ''}

${resumeCard(d.sessions[0] ?? null, { isTeacher: true, firstName: student.name.split(' ')[0] })}

${
  next
    ? `<div class="section-head"><h2>Next class</h2></div>
  <div class="rows" style="margin-bottom:6px">
    <div class="row">
      <div class="row-main">
        <div class="row-title">${esc(prettyIstDate(next.date))} · ${esc(prettyIst(next.time))} IST</div>
        <div class="row-meta">
          ${
            tz
              ? (() => {
                  const l = inZone(next.instant, tz);
                  return `<span>${esc(l.time)} ${esc(l.weekday)} their time</span>`;
                })()
              : '<span class="local-unknown">their time zone is not set</span>'
          }
          <span>${next.slot.duration_min} minutes</span>
          ${next.moved ? '<span>rescheduled</span>' : ''}
        </div>
      </div>
      <div class="row-actions">
        <a class="btn btn-sm btn-primary"
           href="/t/class/${esc(next.slot.id)}/${esc(next.originalDate)}">Open this class</a>
      </div>
    </div>
  </div>`
    : ''
}

<div class="section-head">
  <div><h2>Learning now</h2></div>
  <a class="btn btn-sm" href="/t/s/${esc(student.id)}/songs">All songs</a>
</div>
${
  d.learning.length
    ? `<div class="rows">${d.learning
        .slice(0, 5)
        .map(
          (a) => `<a class="row" href="/t/s/${esc(student.id)}/${esc(a.id)}">
      <div class="row-main">
        <div class="row-title">${inlineTitle(a.title, a.title_ml)}</div>
        <div class="row-meta">
          ${a.raga ? `<span>Raga ${esc(a.raga)}</span>` : ''}
          <span class="num">${a.rec_count} ${a.rec_count === 1 ? 'recording' : 'recordings'}</span>
          ${a.note_count ? `<span class="num">${a.note_count} ${a.note_count === 1 ? 'note' : 'notes'}</span>` : ''}
        </div>
      </div>
      <div class="row-actions"><span class="btn btn-sm">Open</span></div>
    </a>`,
        )
        .join('')}</div>`
    : `<div class="empty">Nothing assigned yet.
       <a href="/t/s/${esc(student.id)}/songs">Assign a song</a>.</div>`
}

<div class="section-head">
  <div><h2>Recent classes</h2></div>
  <a class="btn btn-sm" href="/t/s/${esc(student.id)}/lessons">All ${counts.lessons} past classes</a>
</div>
${
  d.sessions.length
    ? `<div class="rows">${d.sessions
        .slice(0, 3)
        .map(
          (s) => `<a class="row" href="/t/s/${esc(student.id)}/lessons#l-${esc(s.id)}">
      <div class="row-main">
        <div class="row-title">${esc(fmtDate(s.held_on))}
          ${
            s.status === 'ongoing'
              ? '<span class="pill p-brass">ongoing</span>'
              : '<span class="pill p-good">completed</span>'
          }</div>
        <div class="row-meta">${
          s.left_off ? `<span>${esc(s.left_off.slice(0, 110))}</span>` : '<span>no stopping point noted</span>'
        }</div>
      </div>
      <div class="row-actions"><span class="btn btn-sm">Read</span></div>
    </a>`,
        )
        .join('')}</div>`
    : '<div class="empty">No classes logged yet.</div>'
}`,
    ),
    { title: student.name, user, siteName, nav: 'students' },
  );
}

/* ------------------------------------------------------------------ *
 * Songs
 * ------------------------------------------------------------------ */

export function songsTab(
  user: User,
  student: User,
  counts: TabCounts,
  assigned: AssignedRow[],
  catalogue: (Section & { group_name: string | null })[],
  siteName: string,
  msg?: string,
): string {
  const inProgress = assigned.filter((a) => !a.completed_at);
  const finished = assigned.filter((a) => a.completed_at);
  const assignedIds = new Set(assigned.map((a) => a.id));
  const available = catalogue.filter((s) => !assignedIds.has(s.id));

  const opts = (() => {
    const byGroup = new Map<string, string[]>();
    for (const s of available) {
      const g = s.group_name ?? 'Ungrouped';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(
        `<option value="${esc(s.id)}">${esc(s.title)}${s.raga ? ` — ${esc(s.raga)}` : ''}</option>`,
      );
    }
    return [...byGroup.entries()]
      .map(([g, o]) => `<optgroup label="${esc(g)}">${o.join('')}</optgroup>`)
      .join('');
  })();

  const row = (a: AssignedRow) => `<div class="row${a.completed_at ? ' is-done' : ''}">
  <div class="row-main">
    <a href="/t/s/${esc(student.id)}/${esc(a.id)}" style="text-decoration:none;color:inherit">
      <div class="row-title">${inlineTitle(a.title, a.title_ml)}${
        a.completed_at ? ' <span class="pill p-good">finished</span>' : ''
      }</div>
      <div class="row-meta">
        ${a.group_name ? `<span>${esc(a.group_name)}</span>` : ''}
        ${a.raga ? `<span>Raga ${esc(a.raga)}</span>` : ''}
        <span class="num">${a.rec_count} ${a.rec_count === 1 ? 'recording' : 'recordings'}</span>
        ${a.note_count ? `<span class="num">${a.note_count} ${a.note_count === 1 ? 'note' : 'notes'}</span>` : ''}
        ${a.completed_at ? `<span>finished ${esc(fmtDate(a.completed_at))}</span>` : ''}
      </div>
    </a>
  </div>
  <div class="row-actions">
    <a class="btn btn-sm${a.completed_at ? '' : ' btn-primary'}"
       href="/t/s/${esc(student.id)}/${esc(a.id)}">Open</a>
    <form method="post" action="/t/s/${esc(student.id)}/complete-song">
      <input type="hidden" name="section_id" value="${esc(a.id)}">
      <input type="hidden" name="back" value="/t/s/${esc(student.id)}/songs">
      ${a.completed_at ? '<input type="hidden" name="undo" value="1">' : ''}
      <button class="btn btn-sm" type="submit">${a.completed_at ? 'Reopen' : 'Mark finished'}</button>
    </form>
    <form method="post" action="/t/s/${esc(student.id)}/unassign"
          onsubmit="return confirm('Remove this song from their list? Recordings are kept.')">
      <input type="hidden" name="section_id" value="${esc(a.id)}">
      <input type="hidden" name="back" value="/t/s/${esc(student.id)}/songs">
      <button class="btn btn-sm btn-quiet" type="submit">Remove</button>
    </form>
  </div>
</div>`;

  return page(
    shell(
      student,
      'songs',
      counts,
      `${msg ? `<div class="flash">${esc(msg)}</div>` : ''}

<div class="section-head"><h2>Learning now</h2></div>
${
  inProgress.length
    ? `<div class="rows">${inProgress.map(row).join('')}</div>`
    : '<div class="empty">Nothing in progress.</div>'
}

${
  finished.length
    ? `<div class="section-head"><div><h2>Finished</h2>
       <p class="lede">Recordings stay available to practise.</p></div></div>
     <div class="rows">${finished.map(row).join('')}</div>`
    : ''
}

<div class="section-head"><h2>Assign another song</h2></div>
<div class="card">
  ${
    available.length
      ? `<form method="post" action="/t/s/${esc(student.id)}/assign"
        style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
      <input type="hidden" name="back" value="/t/s/${esc(student.id)}/songs">
      <div class="field" style="flex:1;min-width:240px;margin-bottom:0">
        <label for="assign-sel">From the catalogue</label>
        <select id="assign-sel" name="section_id" required>${opts}</select>
      </div>
      <button class="btn btn-primary" type="submit">Assign</button>
    </form>`
      : `<p class="hint" style="margin:0">Every song in the catalogue is already assigned.
         <a href="/t/catalogue">Add a new one</a>.</p>`
  }
</div>`,
    ),
    { title: `${student.name} · Songs`, user, siteName, nav: 'students' },
  );
}

/* ------------------------------------------------------------------ *
 * Past classes — the tab that was hardest to find before
 * ------------------------------------------------------------------ */

export function lessonsTab(
  user: User,
  student: User,
  counts: TabCounts,
  d: {
    sessions: SessionRow[];
    assigned: AssignedRow[];
    month: string;
    monthOccs: Occurrence[];
    prevMonth: string;
    nextMonth: string;
    dictate?: boolean;
    monthLabelPrev: string;
    monthLabelNext: string;
  },
  siteName: string,
  msg?: string,
): string {
  return page(
    shell(
      student,
      'lessons',
      counts,
      `${msg ? `<div class="flash">${esc(msg)}</div>` : ''}

<div class="section-head">
  <div><h2>Class calendar</h2>
    <p class="lede">Every class that happened, was missed, or was cancelled.</p></div>
</div>
<div class="btn-row" style="margin-bottom:10px">
  <a class="btn btn-sm" href="?month=${esc(d.prevMonth)}">← ${esc(d.monthLabelPrev)}</a>
  <a class="btn btn-sm" href="?month=${esc(d.nextMonth)}">${esc(d.monthLabelNext)} →</a>
</div>
${monthCalendar(d.month, d.monthOccs, {
  dayHref: (date, list) => {
    const logged = d.sessions.find((s) => s.held_on === date);
    if (logged) return `#l-${logged.id}`;
    const o = list.find((x) => !x.skipped && !x.missed);
    return o ? `/t/class/${o.slot.id}/${o.originalDate}` : null;
  },
})}

${lessonLog(d.sessions, { isTeacher: true, studentId: student.id, assigned: d.assigned, dictate: d.dictate })}`,
    ),
    {
      title: `${student.name} · Past classes`,
      user,
      siteName,
      nav: 'students',
      scripts: d.dictate ? ['/dictate.js'] : [],
    },
  );
}

/* ------------------------------------------------------------------ *
 * Schedule
 * ------------------------------------------------------------------ */

export function scheduleTab(
  user: User,
  student: User,
  counts: TabCounts,
  d: { slots: ClassSlot[]; upcoming: Occurrence[] },
  siteName: string,
  msg?: string,
): string {
  const tz = student.time_zone;
  const onHold = student.status !== 'active';

  return page(
    shell(
      student,
      'schedule',
      counts,
      `${msg ? `<div class="flash">${esc(msg)}</div>` : ''}
${
  onHold
    ? `<div class="flash err">${esc(student.name.split(' ')[0])} is
       <b>${esc(student.status)}</b>, so these classes are off the calendar &mdash; nothing is
       deleted, and they come back the moment the status is set to active again.
       <a href="/t/s/${esc(student.id)}/settings">Change status</a></div>`
    : ''
}

<div class="section-head">
  <div><h2>Weekly slots</h2>
    <p class="lede">Set in Indian time. What ${esc(student.name.split(' ')[0])} sees shifts with
      their own daylight saving.</p></div>
  <a class="btn btn-sm" href="/t/schedule/slots">Add or change slots</a>
</div>
${
  d.slots.length
    ? `<div class="rows">${d.slots
        .map(
          (s) => `<div class="row">
      <div class="row-main">
        <div class="row-title">${
          s.kind === 'weekly'
            ? `Every ${esc(WEEKDAYS[s.weekday ?? 0])}`
            : `Once on ${esc(prettyIstDate(s.on_date ?? ''))}`
        }${s.label ? ` <span class="slot-label">${esc(s.label)}</span>` : ''}</div>
        <div class="row-meta">
          <span class="num">${esc(prettyIst(s.time_ist))} IST</span>
          <span>${s.duration_min} minutes</span>
        </div>
      </div>
    </div>`,
        )
        .join('')}</div>`
    : '<div class="empty">No slots set up yet.</div>'
}

<div class="section-head"><h2>Next classes</h2></div>
${
  d.upcoming.length
    ? `<div class="rows">${d.upcoming
        .slice(0, 8)
        .map((o) => {
          const l = tz ? inZone(o.instant, tz) : null;
          return `<div class="row">
        <div class="row-main">
          <div class="row-title">${esc(prettyIstDate(o.date))} · ${esc(prettyIst(o.time))} IST</div>
          <div class="row-meta">
            ${l ? `<span>${esc(l.time)} ${esc(l.weekday)} their time</span>` : ''}
            ${o.moved ? '<span>rescheduled</span>' : ''}
            ${o.slot.label ? `<span>${esc(o.slot.label)}</span>` : ''}
          </div>
        </div>
        <div class="row-actions">
          <a class="btn btn-sm" href="/t/class/${esc(o.slot.id)}/${esc(o.originalDate)}">Open</a>
        </div>
      </div>`;
        })
        .join('')}</div>`
    : '<div class="empty">Nothing coming up.</div>'
}`,
    ),
    { title: `${student.name} · Schedule`, user, siteName, nav: 'students' },
  );
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export function settingsTab(
  user: User,
  student: User,
  counts: TabCounts,
  siteName: string,
  msg?: string,
): string {
  return page(
    shell(
      student,
      'settings',
      counts,
      `${msg ? `<div class="flash">${esc(msg)}</div>` : ''}

<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">
  <div class="card">
    <h3>Details</h3>
    <form method="post" action="/t/students/${esc(student.id)}/details" style="margin-top:12px">
      <div class="field"><label for="sd-name">Name</label>
        <input id="sd-name" name="name" type="text" value="${esc(student.name)}" required></div>
      <div class="field"><label for="sd-loc">Where they are</label>
        <input id="sd-loc" name="location" type="text" value="${esc(student.location ?? '')}"
               placeholder="Dubai, UAE"></div>
      <div class="field"><label for="sd-phone">WhatsApp number</label>
        <input id="sd-phone" name="phone" type="tel" inputmode="tel" value="${esc(student.phone ?? '')}"
               placeholder="+91 98470 12345">
        <p class="hint">With the country code, so the link opens the right chat from anywhere.</p></div>
      <div class="field">
        <label for="sd-tz">Time zone</label>
        <select id="sd-tz" name="time_zone">
          <option value="">— not set —</option>
          ${zoneOptions(student.time_zone)}
        </select>
        <p class="hint">Filled in automatically the first time they open the site. Change it only
          if that's wrong, or if they've moved.</p>
      </div>
      <button class="btn btn-primary" type="submit">Save details</button>
    </form>
  </div>

  <div class="card">
    <h3>Status</h3>
    <form method="post" action="/t/students/${esc(student.id)}/status" style="margin-top:12px">
      <input type="hidden" name="back" value="/t/s/${esc(student.id)}/settings">
      <div class="field">
        <label for="sd-status">Currently</label>
        <select id="sd-status" name="status">
          ${['active', 'paused', 'graduated', 'ended']
            .map(
              (v) =>
                `<option value="${v}"${v === student.status ? ' selected' : ''}>${esc(STATUS_LABEL[v])}</option>`,
            )
            .join('')}
        </select>
      </div>
      <div class="field">
        <label for="sd-note">Note <span class="opt">— optional</span></label>
        <input id="sd-note" name="status_note" type="text" value="${esc(student.status_note ?? '')}"
               placeholder="Back after exams in June">
      </div>
      <button class="btn" type="submit">Update status</button>
      <p class="hint">Nothing is deleted. Their recordings, lesson history and schedule stay, and
        they can be made active again at any time.</p>
    </form>
  </div>
</div>

<div class="section-head"><h2>Account</h2></div>
<div class="card">
  <div class="row-meta" style="margin:0">
    <span>${esc(student.email)}</span>
    <span>joined ${esc(fmtDate(student.created_at))}</span>
    <span>${student.google_sub ? 'has signed in with Google' : 'has not signed in yet'}</span>
    ${student.time_zone ? `<span>${esc(student.time_zone.replace(/_/g, ' '))}</span>` : ''}
  </div>
</div>`,
    ),
    { title: `${student.name} · Settings`, user, siteName, nav: 'students' },
  );
}
