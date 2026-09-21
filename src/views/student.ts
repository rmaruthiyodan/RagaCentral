/* ==================================================================
 * One student, across five tabs.
 *
 * This used to be a single page carrying songs, the schedule, a month
 * calendar, the whole lesson history, a log form and the settings. It
 * had become impossible to scan — finding one past class meant scrolling
 * past everything else. Each tab now answers one question.
 * ================================================================== */

import { page, avatar, inlineTitle } from './layout';
import type { Visiting } from './layout';
import { resumeCard, lessonLog, logForm } from './sessions';
import { monthCalendar, zoneOptions } from './schedule';
import { esc, fmtDate, relativeDate, waLink } from '../util';
import { prettyIst, prettyIstZ, prettyIstDate, WEEKDAYS, inZone, monthLabel, type Occurrence } from '../tz';
import type { User, Section, SessionRow, ClassSlot, AssignedRow, ProjectPerson } from '../types';
import { t, setLang } from '../i18n';

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

function shell(student: ProjectPerson, tab: StudentTab, counts: TabCounts, body: string): string {
  const stab = (id: StudentTab, href: string, label: string, badge?: number) =>
    `<a class="stab${tab === id ? ' is-on' : ''}" href="${esc(href)}">${esc(label)}${
      badge ? ` <span class="stab-n">${badge}</span>` : ''
    }</a>`;

  return `<a class="crumb" href="/t">← ${t('Students')}</a>
<div class="student-head">
  ${avatar(student)}
  <div class="sh-who">
    <h1>${esc(student.name)}</h1>
    <p class="lede">${esc(student.email)}${student.location ? ` · ${esc(student.location)}` : ''}${
      student.phone
        ? ` · ${
            waLink(student.phone)
              ? `<a class="wa" href="${esc(waLink(student.phone)!)}" target="_blank" rel="noopener"
                   title="${esc(t('Open WhatsApp'))}">${esc(student.phone)}</a>`
              : esc(student.phone)
          }`
        : ''
    }</p>
  </div>
  <span class="pill ${STATUS_CLASS[student.status] ?? 'p-warn'}">${esc(
    t(STATUS_LABEL[student.status] ?? student.status),
  )}</span>
</div>

${
  student.status !== 'active'
    ? `<div class="flash" style="border-left-color:var(--warn);background:var(--warn-soft);color:var(--warn)">
     ${esc(t(STATUS_LABEL[student.status] ?? student.status))}${
       student.status_note ? ` — ${esc(student.status_note)}` : ''
     }${
       student.status_changed_at
         ? ` · ${t('since %s', esc(fmtDate(student.status_changed_at)))}`
         : ''
     }
   </div>`
    : ''
}

<nav class="stabs">
  ${stab('overview', `/t/s/${student.id}`, t('Overview'))}
  ${stab('songs', `/t/s/${student.id}/songs`, t('Songs'), counts.songs)}
  ${stab('lessons', `/t/s/${student.id}/lessons`, t('Past classes'), counts.lessons)}
  ${stab('schedule', `/t/s/${student.id}/schedule`, t('Schedule'))}
  ${stab('settings', `/t/s/${student.id}/settings`, t('Settings'))}
</nav>

${body}`;
}

/* ------------------------------------------------------------------ *
 * Overview — what you need before a class
 * ------------------------------------------------------------------ */

export function overviewTab(
  user: User,
  student: ProjectPerson,
  counts: TabCounts,
  d: {
    sessions: SessionRow[];
    upcoming: Occurrence[];
    learning: AssignedRow[];
    visiting?: Visiting | null;
  },
  siteName: string,
  msg?: string,
): string {
  setLang(user.lang);
  const next = d.upcoming[0];
  const tz = student.time_zone;

  return page(
    shell(
      student,
      'overview',
      counts,
      `${msg ? `<div class="flash">${esc(msg)}</div>` : ''}

${resumeCard(d.sessions[0] ?? null, {
  isTeacher: true,
  firstName: student.name.split(' ')[0],
  logHref: `/t/s/${student.id}/lessons#log`,
})}

${
  next
    ? `<div class="section-head"><h2>${t('Next class')}</h2></div>
  <div class="rows" style="margin-bottom:6px">
    <div class="row">
      <div class="row-main">
        <div class="row-title">${esc(prettyIstDate(next.date))} · ${esc(prettyIstZ(next.time))}</div>
        <div class="row-meta">
          ${
            tz
              ? (() => {
                  const l = inZone(next.instant, tz);
                  return `<span>${t('%s %s their time', esc(l.time), esc(l.weekday))}</span>`;
                })()
              : `<span class="local-unknown">${t('their time zone is not set')}</span>`
          }
          <span>${t('%s minutes', next.slot.duration_min)}</span>
          ${next.moved ? `<span>${t('rescheduled')}</span>` : ''}
        </div>
      </div>
      <div class="row-actions">
        <a class="btn btn-sm btn-primary"
           href="/t/class/${esc(next.slot.id)}/${esc(next.originalDate)}">${t('Open this class')}</a>
      </div>
    </div>
  </div>`
    : ''
}

<div class="section-head">
  <div><h2>${t('Learning now')}</h2></div>
  <a class="btn btn-sm" href="/t/s/${esc(student.id)}/songs">${t('All songs')}</a>
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
          ${a.raga ? `<span>${t('Raga %s', esc(a.raga))}</span>` : ''}
          <span class="num">${
            a.rec_count === 1 ? t('%s recording', a.rec_count) : t('%s recordings', a.rec_count)
          }</span>
          ${
            a.note_count
              ? `<span class="num">${
                  a.note_count === 1 ? t('%s note', a.note_count) : t('%s notes', a.note_count)
                }</span>`
              : ''
          }
        </div>
      </div>
      <div class="row-actions"><span class="btn btn-sm">${t('Open')}</span></div>
    </a>`,
        )
        .join('')}</div>`
    : `<div class="empty">${t('Nothing assigned yet.')}
       <a href="/t/s/${esc(student.id)}/songs">${t('Assign a song')}</a>.</div>`
}

<div class="section-head">
  <div><h2>${t('Recent classes')}</h2></div>
  <a class="btn btn-sm" href="/t/s/${esc(student.id)}/lessons">${t('All %s past classes', counts.lessons)}</a>
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
              ? `<span class="pill p-brass">${t('ongoing')}</span>`
              : `<span class="pill p-good">${t('completed')}</span>`
          }</div>
        <div class="row-meta">${
          s.left_off
            ? `<span>${esc(s.left_off.slice(0, 110))}</span>`
            : `<span>${t('no stopping point noted')}</span>`
        }</div>
      </div>
      <div class="row-actions"><span class="btn btn-sm">${t('Read')}</span></div>
    </a>`,
        )
        .join('')}</div>`
    : `<div class="empty">${t('No classes logged yet.')}</div>`
}`,
    ),
    { title: student.name, user, siteName, nav: 'students', visiting: d.visiting ?? null },
  );
}

/* ------------------------------------------------------------------ *
 * Songs
 * ------------------------------------------------------------------ */

export function songsTab(
  user: User,
  student: ProjectPerson,
  counts: TabCounts,
  assigned: AssignedRow[],
  catalogue: (Section & { group_name: string | null })[],
  siteName: string,
  msg?: string,
  visiting?: Visiting | null,
): string {
  setLang(user.lang);
  const inProgress = assigned.filter((a) => !a.completed_at);
  const finished = assigned.filter((a) => a.completed_at);
  const assignedIds = new Set(assigned.map((a) => a.id));
  const available = catalogue.filter((s) => !assignedIds.has(s.id));

  const opts = (() => {
    const byGroup = new Map<string, string[]>();
    for (const s of available) {
      const g = s.group_name ?? t('Ungrouped');
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
        a.completed_at ? ` <span class="pill p-good">${t('finished')}</span>` : ''
      }</div>
      <div class="row-meta">
        ${a.group_name ? `<span>${esc(a.group_name)}</span>` : ''}
        ${a.raga ? `<span>${t('Raga %s', esc(a.raga))}</span>` : ''}
        <span class="num">${
          a.rec_count === 1 ? t('%s recording', a.rec_count) : t('%s recordings', a.rec_count)
        }</span>
        ${
          a.note_count
            ? `<span class="num">${
                a.note_count === 1 ? t('%s note', a.note_count) : t('%s notes', a.note_count)
              }</span>`
            : ''
        }
        ${a.started_at ? `<span>${t('started %s', esc(fmtDate(a.started_at)))}</span>` : ''}
        ${a.completed_at ? `<span>${t('finished %s', esc(fmtDate(a.completed_at)))}</span>` : ''}
      </div>
    </a>
  </div>
  <div class="row-actions">
    <a class="btn btn-sm${a.completed_at ? '' : ' btn-primary'}"
       href="/t/s/${esc(student.id)}/${esc(a.id)}">${t('Open')}</a>
    <form method="post" action="/t/s/${esc(student.id)}/complete-song">
      <input type="hidden" name="section_id" value="${esc(a.id)}">
      <input type="hidden" name="back" value="/t/s/${esc(student.id)}/songs">
      ${a.completed_at ? '<input type="hidden" name="undo" value="1">' : ''}
      <button class="btn btn-sm" type="submit">${
        a.completed_at ? t('Reopen') : t('Mark finished')
      }</button>
    </form>
    <form method="post" action="/t/s/${esc(student.id)}/unassign"
          onsubmit="return confirm('${t('Remove this song from their list? Recordings are kept.')}')">
      <input type="hidden" name="section_id" value="${esc(a.id)}">
      <input type="hidden" name="back" value="/t/s/${esc(student.id)}/songs">
      <button class="btn btn-sm btn-quiet" type="submit">${t('Remove')}</button>
    </form>
  </div>
</div>`;

  return page(
    shell(
      student,
      'songs',
      counts,
      `${msg ? `<div class="flash">${esc(msg)}</div>` : ''}

<div class="section-head"><h2>${t('Learning now')}</h2></div>
${
  inProgress.length
    ? `<div class="rows">${inProgress.map(row).join('')}</div>`
    : `<div class="empty">${t('Nothing in progress.')}</div>`
}

${
  finished.length
    ? `<div class="section-head"><div><h2>${t('Finished')}</h2>
       <p class="lede">${t('Recordings stay available to practise.')}</p></div></div>
     <div class="rows">${finished.map(row).join('')}</div>`
    : ''
}

<div class="section-head"><h2>${t('Assign another song')}</h2></div>
<div class="card">
  ${
    available.length
      ? `<form method="post" action="/t/s/${esc(student.id)}/assign"
        style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
      <input type="hidden" name="back" value="/t/s/${esc(student.id)}/songs">
      <div class="field" style="flex:1;min-width:240px;margin-bottom:0">
        <label for="assign-sel">${t('From the catalogue')}</label>
        <select id="assign-sel" name="section_id" required>${opts}</select>
      </div>
      <button class="btn btn-primary" type="submit">${t('Assign')}</button>
    </form>`
      : `<p class="hint" style="margin:0">${t('Every song in the catalogue is already assigned.')}
         <a href="/t/catalogue">${t('Add a new one')}</a>.</p>`
  }
</div>`,
    ),
    { title: t('%s · Songs', student.name), user, siteName, nav: 'students', visiting },
  );
}

/* ------------------------------------------------------------------ *
 * Past classes — the tab that was hardest to find before
 * ------------------------------------------------------------------ */

export function lessonsTab(
  user: User,
  student: ProjectPerson,
  counts: TabCounts,
  d: {
    sessions: SessionRow[];
    /** The whole history behind this one page of it. */
    totals: { total: number; completed: number; ongoing: number };
    pager: { page: number; pages: number; href: (p: number) => string };
    assigned: AssignedRow[];
    month: string;
    monthOccs: Occurrence[];
    prevMonth: string;
    nextMonth: string;
    dictate?: boolean;
    visiting?: Visiting | null;
    /** The id of the class logged on this day, if there is one — so a
        calendar cell can link to a lesson that is not on this page. */
    lessonOn?: (date: string) => string | null;
  },
  siteName: string,
  msg?: string,
): string {
  setLang(user.lang);
  return page(
    shell(
      student,
      'lessons',
      counts,
      `${msg ? `<div class="flash">${esc(msg)}</div>` : ''}

${/* The log first, four classes of it, then the pager.
      This was briefly a box with its own scrollbar, which solved the
      length and introduced something worse: a scroll inside a scroll,
      where the wheel does one thing over the box and another either
      side of it, and where no scrollbar position means anything. Four
      on the page and a link to the next four is the same amount of
      reading with none of that. */ ''}
${lessonLog(d.sessions, {
    isTeacher: true,
    studentId: student.id,
    assigned: d.assigned,
    dictate: d.dictate,
    withForm: false,
    totals: d.totals,
    pager: d.pager,
  })}

${/* Outside the box, and directly under it. Writing down the class that
      just finished is the most frequent thing done on this tab; it must
      not be the thing you reach by scrolling through a year. */ ''}
${logForm(student.id, d.assigned, Boolean(d.dictate))}

<div class="section-head" style="margin-top:26px">
  <div><h2>${t('Class calendar')}</h2>
    <p class="lede">${t('Every class that happened, was missed, or was cancelled.')}</p></div>
</div>
<div class="btn-row" style="margin-bottom:10px">
  <a class="btn btn-sm" href="?month=${esc(d.prevMonth)}">← ${esc(monthLabel(d.prevMonth, 'short'))}</a>
  <a class="btn btn-sm" href="?month=${esc(d.nextMonth)}">${esc(monthLabel(d.nextMonth, 'short'))} →</a>
</div>
${monthCalendar(d.month, d.monthOccs, {
  dayHref: (date, list) => {
    /* A logged class may be forty lessons back and therefore not on
       this page at all. Rather than a bare #anchor that would silently
       do nothing, ask for the day: the server finds its page and lands
       on it, anchor and all. */
    const logged = d.sessions.find((s) => s.held_on === date);
    if (logged) return `#l-${logged.id}`;
    const elsewhere = d.lessonOn?.(date);
    if (elsewhere) return `?on=${date}#l-${elsewhere}`;
    const o = list.find((x) => !x.skipped && !x.missed);
    return o ? `/t/class/${o.slot.id}/${o.originalDate}` : null;
  },
})}`,
    ),
    {
      title: t('%s · Past classes', student.name),
      user,
      siteName,
      nav: 'students',
      visiting: d.visiting ?? null,
      scripts: d.dictate ? ['/dictate.js'] : [],
    },
  );
}

/* ------------------------------------------------------------------ *
 * Schedule
 * ------------------------------------------------------------------ */

export function scheduleTab(
  user: User,
  student: ProjectPerson,
  counts: TabCounts,
  d: { slots: ClassSlot[]; upcoming: Occurrence[]; visiting?: Visiting | null },
  siteName: string,
  msg?: string,
): string {
  setLang(user.lang);
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
    ? `<div class="flash err">${t(
        '%s is %s, so these classes are off the calendar &mdash; nothing is deleted, and they come back the moment the status is set to active again.',
        esc(student.name.split(' ')[0]),
        `<b>${esc(student.status)}</b>`,
      )}
       <a href="/t/s/${esc(student.id)}/settings">${t('Change status')}</a></div>`
    : ''
}

<div class="section-head">
  <div><h2>${t('Weekly slots')}</h2>
    <p class="lede">${t(
      'Set in Indian time. What %s sees shifts with their own daylight saving.',
      esc(student.name.split(' ')[0]),
    )}</p></div>
  <a class="btn btn-sm" href="/t/schedule/slots">${t('Add or change slots')}</a>
</div>
${
  d.slots.length
    ? `<div class="rows">${d.slots
        .map(
          (s) => `<div class="row">
      <div class="row-main">
        <div class="row-title">${
          s.kind === 'weekly'
            ? t('Every %s', esc(WEEKDAYS[s.weekday ?? 0]))
            : t('Once on %s', esc(prettyIstDate(s.on_date ?? '')))
        }${s.label ? ` <span class="slot-label">${esc(s.label)}</span>` : ''}</div>
        <div class="row-meta">
          <span class="num">${esc(prettyIstZ(s.time_ist))}</span>
          <span>${t('%s minutes', s.duration_min)}</span>
        </div>
      </div>
    </div>`,
        )
        .join('')}</div>`
    : `<div class="empty">${t('No slots set up yet.')}</div>`
}

<div class="section-head"><h2>${t('Next classes')}</h2></div>
${
  d.upcoming.length
    ? `<div class="rows">${d.upcoming
        .slice(0, 8)
        .map((o) => {
          const l = tz ? inZone(o.instant, tz) : null;
          return `<div class="row">
        <div class="row-main">
          <div class="row-title">${esc(prettyIstDate(o.date))} · ${esc(prettyIstZ(o.time))}</div>
          <div class="row-meta">
            ${l ? `<span>${t('%s %s their time', esc(l.time), esc(l.weekday))}</span>` : ''}
            ${o.moved ? `<span>${t('rescheduled')}</span>` : ''}
            ${o.slot.label ? `<span>${esc(o.slot.label)}</span>` : ''}
          </div>
        </div>
        <div class="row-actions">
          <a class="btn btn-sm" href="/t/class/${esc(o.slot.id)}/${esc(o.originalDate)}">${t('Open')}</a>
        </div>
      </div>`;
        })
        .join('')}</div>`
    : `<div class="empty">${t('Nothing coming up.')}</div>`
}`,
    ),
    { title: t('%s · Schedule', student.name), user, siteName, nav: 'students', visiting: d.visiting ?? null },
  );
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export function settingsTab(
  user: User,
  student: ProjectPerson,
  counts: TabCounts,
  siteName: string,
  msg?: string,
  visiting?: Visiting | null,
): string {
  setLang(user.lang);
  return page(
    shell(
      student,
      'settings',
      counts,
      `${msg ? `<div class="flash">${esc(msg)}</div>` : ''}

<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">
  <div class="card">
    <h3>${t('Details')}</h3>
    <form method="post" action="/t/students/${esc(student.id)}/details" style="margin-top:12px">
      <div class="field"><label for="sd-name">${t('Name')}</label>
        <input id="sd-name" name="name" type="text" value="${esc(student.name)}" required></div>
      <div class="field"><label for="sd-loc">${t('Where they are')}</label>
        <input id="sd-loc" name="location" type="text" value="${esc(student.location ?? '')}"
               placeholder="Dubai, UAE"></div>
      <div class="field"><label for="sd-phone">${t('WhatsApp number')}</label>
        <input id="sd-phone" name="phone" type="tel" inputmode="tel" value="${esc(student.phone ?? '')}"
               placeholder="+91 98470 12345">
        <p class="hint">${t('With the country code, so the link opens the right chat from anywhere.')}</p></div>
      <div class="field">
        <label for="sd-tz">${t('Time zone')}</label>
        <select id="sd-tz" name="time_zone">
          <option value="">${t('— not set —')}</option>
          ${zoneOptions(student.time_zone)}
        </select>
        <p class="hint">${t(
          "Filled in automatically the first time they open the site. Change it only if that's wrong, or if they've moved.",
        )}</p>
      </div>
      <button class="btn btn-primary" type="submit">${t('Save details')}</button>
    </form>
  </div>

  <div class="card">
    <h3>${t('Status')}</h3>
    <form method="post" action="/t/students/${esc(student.id)}/status" style="margin-top:12px">
      <input type="hidden" name="back" value="/t/s/${esc(student.id)}/settings">
      <div class="field">
        <label for="sd-status">${t('Currently')}</label>
        <select id="sd-status" name="status">
          ${['active', 'paused', 'graduated', 'ended']
            .map(
              (v) =>
                `<option value="${v}"${v === student.status ? ' selected' : ''}>${esc(t(STATUS_LABEL[v]))}</option>`,
            )
            .join('')}
        </select>
      </div>
      <div class="field">
        <label for="sd-note">${t('Note')} <span class="opt">${t('— optional')}</span></label>
        <input id="sd-note" name="status_note" type="text" value="${esc(student.status_note ?? '')}"
               placeholder="${esc(t('Back after exams in June'))}">
      </div>
      <button class="btn" type="submit">${t('Update status')}</button>
      <p class="hint">${t(
        'Nothing is deleted. Their recordings, lesson history and schedule stay, and they can be made active again at any time.',
      )}</p>
    </form>
  </div>
</div>

<div class="section-head"><h2>${t('Account')}</h2></div>
<div class="card">
  <div class="row-meta" style="margin:0">
    <span>${esc(student.email)}</span>
    <span>${t('joined %s', esc(fmtDate(student.created_at)))}</span>
    <span>${
      student.google_sub ? t('has signed in with Google') : t('has not signed in yet')
    }</span>
    ${student.time_zone ? `<span>${esc(student.time_zone.replace(/_/g, ' '))}</span>` : ''}
  </div>
</div>`,
    ),
    { title: t('%s · Settings', student.name), user, siteName, nav: 'students', visiting },
  );
}
