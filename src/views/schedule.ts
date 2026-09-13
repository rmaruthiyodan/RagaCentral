import { page, avatar } from './layout';
import { esc } from '../util';
import type { User, ClassSlot } from '../types';
import {
  WEEKDAYS, COMMON_ZONES, TEACHER_ZONE, prettyIst, prettyIstDate,
  inZone, istToday, addDays, monthLabel, type Occurrence,
} from '../tz';
import { t, setLang } from '../i18n';

/** A student plus the zone their clock is in. */
export interface WithZone {
  id: string;
  name: string;
  avatar_url: string | null;
  time_zone: string | null;
  location: string | null;
  /** active | paused | graduated | ended — a past class of a paused student
   *  is still shown, and marked, rather than quietly disappearing. */
  status?: string;
}

export interface DayGroup {
  date: string;            // IST date
  items: { occ: Occurrence; student: WithZone }[];
}

/* ------------------------------------------------------------------ *
 * The teacher's upcoming classes
 * ------------------------------------------------------------------ */

function localLine(occ: Occurrence, student: WithZone): string {
  if (!student.time_zone) {
    return `<span class="local-unknown">${t('time zone not set — ask them to open the site once')}</span>`;
  }
  const l = inZone(occ.instant, student.time_zone);
  const sameDay = l.iso === occ.date;
  return `<span class="local"><b>${esc(l.time)}</b> ${esc(t(l.weekday))}${
    sameDay ? '' : ` ${esc(l.date)}`
  } <span class="zone">${esc(l.abbr)}</span></span>${
    sameDay ? '' : `<span class="pill p-info">${t('different day')}</span>`
  }`;
}

export function schedulePage(
  user: User,
  days: DayGroup[],
  windowDays: number,
  siteName: string,
  msg?: string,
): string {
  setLang(user.lang);
  const today = istToday();
  const total = days.reduce((n, d) => n + d.items.length, 0);

  const dayBlock = (d: DayGroup) => `<div class="sched-day${d.date === today ? ' is-today' : ''}">
  <div class="sched-date">
    <span class="sd-day">${esc(prettyIstDate(d.date))}</span>
    ${d.date === today ? `<span class="pill p-brass">${t('today')}</span>` : ''}
    ${d.date === addDays(today, 1) ? `<span class="pill p-info">${t('tomorrow')}</span>` : ''}
  </div>
  <div class="sched-items">
    ${d.items
      .map(({ occ, student }) => {
        // Both a cancellation and a missed class are "not happening", but they
        // mean different things and must not look alike.
        const off = occ.skipped || occ.missed;
        return `<div class="sched-row${occ.skipped ? ' is-skipped' : ''}${occ.missed ? ' is-missed' : ''}">
      ${avatar(student)}
      <div class="sched-who">
        <a href="/t/s/${esc(student.id)}">${esc(student.name)}</a>
        ${student.location ? `<span class="sched-loc">${esc(student.location)}</span>` : ''}
        ${occ.slot.label ? `<span class="slot-label">${esc(occ.slot.label)}</span>` : ''}
        ${occ.moved ? `<span class="pill p-warn">${t('moved')}</span>` : ''}
        ${occ.skipped ? `<span class="pill p-bad">${t('no class')}</span>` : ''}
        ${occ.missed ? `<span class="pill p-bad">${t('missed')}</span>` : ''}
        ${occ.reason ? `<span class="sched-reason">${esc(occ.reason)}</span>` : ''}
      </div>
      <div class="sched-times">
        <span class="ist"><b>${esc(prettyIst(occ.time))}</b> <span class="zone">IST</span></span>
        <span class="arrow">→</span>
        ${localLine(occ, student)}
      </div>
      <div class="sched-actions">
        <span class="dur">${t('%sm', occ.slot.duration_min)}</span>
        ${
          off
            ? `<form method="post" action="/t/slots/${esc(occ.slot.id)}/restore">
                 <input type="hidden" name="on_date" value="${esc(occ.originalDate)}">
                 <button class="btn btn-sm btn-quiet" type="submit">${t('Undo')}</button></form>
               <a class="btn btn-sm" href="/t/schedule/day/${esc(occ.date)}">${t('Reschedule')}</a>`
            : `<details class="change" data-reveal>
            <summary class="btn btn-sm btn-quiet">${t('Change')}</summary>
            <div class="change-body" data-reveal-body>
              <form method="post" action="/t/slots/${esc(occ.slot.id)}/skip">
                <input type="hidden" name="on_date" value="${esc(occ.originalDate)}">
                <label for="sk-${esc(occ.slot.id)}-${esc(occ.originalDate)}">${t('Cancel this one class')}</label>
                <input id="sk-${esc(occ.slot.id)}-${esc(occ.originalDate)}" name="reason" type="text" placeholder="${t('Onam, travelling…')}">
                <button class="btn btn-sm" type="submit">${t('No class this day')}</button>
              </form>
              <form method="post" action="/t/slots/${esc(occ.slot.id)}/missed">
                <input type="hidden" name="on_date" value="${esc(occ.originalDate)}">
                <label>${t("Or it didn't happen")}</label>
                <input name="reason" type="text" placeholder="${t('Student unwell, no-show…')}">
                <button class="btn btn-sm" type="submit">${t('Mark missed')}</button>
              </form>
              <form method="post" action="/t/slots/${esc(occ.slot.id)}/move" class="move-form">
                <input type="hidden" name="on_date" value="${esc(occ.originalDate)}">
                <label>${t('Or move it')}</label>
                <div class="move-row">
                  <input name="new_date" type="date" value="${esc(occ.date)}" required>
                  <input name="new_time_ist" type="time" value="${esc(occ.time)}" required>
                </div>
                <p class="hint">${t("Time is Indian time. The student's own time is recalculated.")}</p>
                <button class="btn btn-sm btn-primary" type="submit">${t('Move class')}</button>
              </form>
            </div>
          </details>
          <a class="btn btn-sm" href="/t/s/${esc(student.id)}#log">${t('Log')}</a>`
        }
      </div>
    </div>`;
      })
      .join('')}
  </div>
</div>`;

  return `<div class="page-head">
  <h1>${t('Upcoming classes')}</h1>
  <p class="lede">
    ${t('Times on the left are yours, in India. Times on the right are what each student sees on their own clock — recalculated for every class, so daylight saving where they live is already accounted for.')}
  </p>
</div>

${msg ? `<div class="flash">${esc(msg)}</div>` : ''}

<div class="btn-row" style="margin-bottom:18px">
  <a class="btn btn-sm${windowDays === 7 ? ' btn-primary' : ''}" href="/t/schedule?days=7">${t('Next 7 days')}</a>
  <a class="btn btn-sm${windowDays === 14 ? ' btn-primary' : ''}" href="/t/schedule?days=14">${t('14 days')}</a>
  <a class="btn btn-sm${windowDays === 30 ? ' btn-primary' : ''}" href="/t/schedule?days=30">${t('30 days')}</a>
  <span style="flex:1"></span>
  <a class="btn btn-sm" href="/t/schedule/slots">${t('Manage weekly slots')}</a>
</div>

${
  total
    ? `<div class="sched">${days.filter((d) => d.items.length).map(dayBlock).join('')}</div>`
    : `<div class="empty"><strong>${t('Nothing scheduled')}</strong>
       ${t("Set up each student's weekly slots and they'll appear here.")}
       <div style="margin-top:14px"><a class="btn btn-sm btn-primary" href="/t/schedule/slots">${t('Manage weekly slots')}</a></div></div>`
}`;
}

export function schedulePageWrapped(
  user: User, days: DayGroup[], windowDays: number, siteName: string, msg?: string,
): string {
  setLang(user.lang);
  return page(schedulePage(user, days, windowDays, siteName, msg), {
    title: t('Schedule'), user, siteName, nav: 'schedule',
  });
}

/* ------------------------------------------------------------------ *
 * Managing slots
 * ------------------------------------------------------------------ */

export interface StudentSlots {
  student: WithZone & { email: string };
  slots: ClassSlot[];
}

export function zoneOptions(current: string | null): string {
  const list = [...new Set([...(current ? [current] : []), ...COMMON_ZONES])];
  return list
    .map(
      (z) =>
        `<option value="${esc(z)}"${z === current ? ' selected' : ''}>${esc(z.replace(/_/g, ' '))}</option>`,
    )
    .join('');
}

function slotRow(s: ClassSlot, student: WithZone): string {
  const when =
    s.kind === 'weekly'
      ? t('Every %s', t(WEEKDAYS[s.weekday ?? 0]))
      : t('Once on %s', esc(prettyIstDate(s.on_date ?? '')));

  const local = student.time_zone
    ? (() => {
        // Show the next real occurrence so the student's time is concrete
        // rather than a guess about which side of a DST change we're on.
        const probe = s.kind === 'once' && s.on_date ? s.on_date : nextDateForWeekday(s.weekday ?? 0);
        const l = inZone(
          new Date(Date.UTC(
            +probe.slice(0, 4), +probe.slice(5, 7) - 1, +probe.slice(8, 10),
            +s.time_ist.slice(0, 2), +s.time_ist.slice(3, 5),
          ) - (5 * 60 + 30) * 60000),
          student.time_zone,
        );
        return `<span class="local">${esc(l.time)} ${esc(t(l.weekday))} <span class="zone">${esc(l.abbr)}</span></span>`;
      })()
    : `<span class="local-unknown">${t('zone not set')}</span>`;

  return `<div class="slot-row">
  <div class="slot-when">
    <b>${esc(when)}</b>
    <span class="slot-time">${esc(prettyIst(s.time_ist))} IST · ${t('%s min', s.duration_min)}</span>
    ${s.label ? `<span class="slot-label">${esc(s.label)}</span>` : ''}
  </div>
  <div class="slot-local">${local}</div>
  <form method="post" action="/t/slots/${esc(s.id)}/delete"
        onsubmit="return confirm('${t('Remove this weekly slot? Past lessons are untouched.')}')">
    <button class="btn btn-sm btn-danger" type="submit">${t('Remove')}</button>
  </form>
</div>`;
}

function nextDateForWeekday(weekday: number): string {
  const today = istToday();
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i);
    const [y, m, dd] = d.split('-').map(Number);
    if (new Date(Date.UTC(y, m - 1, dd)).getUTCDay() === weekday) return d;
  }
  return today;
}

export function slotsPage(
  user: User,
  rows: StudentSlots[],
  siteName: string,
  msg?: string,
): string {
  setLang(user.lang);
  const block = ({ student, slots }: StudentSlots) => `<div class="card" style="margin-bottom:14px">
  <div class="slot-head">
    ${avatar(student)}
    <div style="flex:1;min-width:0">
      <div class="row-title">${esc(student.name)}</div>
      <div class="row-meta"><span>${esc(student.email)}</span></div>
    </div>
    <form method="post" action="/t/students/${esc(student.id)}/zone" class="zone-form">
      <label for="loc-${esc(student.id)}">${t('Where they are')}</label>
      <input id="loc-${esc(student.id)}" name="location" type="text"
             value="${esc(student.location ?? '')}" placeholder="Dubai, UAE">
      <label for="tz-${esc(student.id)}" style="margin-top:8px">${t('Their time zone')}</label>
      <div class="zone-row">
        <select id="tz-${esc(student.id)}" name="time_zone">
          <option value="">${t('— not set —')}</option>
          ${zoneOptions(student.time_zone)}
        </select>
        <button class="btn btn-sm" type="submit">${t('Save')}</button>
      </div>
      ${
        student.time_zone
          ? ''
          : `<p class="hint">${t('The zone is set automatically the first time they open the site.')}</p>`
      }
    </form>
  </div>

  ${slots.length ? slots.map((s) => slotRow(s, student)).join('') : `<p class="hint" style="margin:12px 0 0">${t('No slots yet.')}</p>`}

  <details class="panel" style="margin-top:14px;border:none;background:transparent">
    <summary style="padding:8px 0;font-size:13.5px;color:var(--brass-ink)">${t('Add a class slot')}</summary>
    <div class="panel-body" style="padding:12px 0 0;border-top:1px solid var(--line)">
      <form method="post" action="/t/students/${esc(student.id)}/slots">
        <div class="field-row">
          <div class="field">
            <label for="k-${esc(student.id)}">${t('Repeats')}</label>
            <select id="k-${esc(student.id)}" name="kind">
              <option value="weekly">${t('Every week')}</option>
              <option value="once">${t('Just once')}</option>
            </select>
          </div>
          <div class="field">
            <label for="w-${esc(student.id)}">${t('Day')}</label>
            <select id="w-${esc(student.id)}" name="weekday">
              ${WEEKDAYS.map((d, i) => `<option value="${i}">${t(d)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="d-${esc(student.id)}">${t('Or a date')} <span class="opt">${t('— for one-offs')}</span></label>
            <input id="d-${esc(student.id)}" name="on_date" type="date">
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label for="t-${esc(student.id)}">${t('Time')} <span class="opt">${t('— Indian time')}</span></label>
            <input id="t-${esc(student.id)}" name="time_ist" type="time" value="19:00" required>
          </div>
          <div class="field">
            <label for="dur-${esc(student.id)}">${t('Length')}</label>
            <input id="dur-${esc(student.id)}" name="duration_min" type="number" min="15" max="240" value="60">
          </div>
          <div class="field">
            <label for="l-${esc(student.id)}">${t('Label')} <span class="opt">${t('— optional')}</span></label>
            <input id="l-${esc(student.id)}" name="label" type="text" placeholder="${t('Theory')}">
          </div>
        </div>
        <button class="btn btn-sm btn-primary" type="submit">${t('Add slot')}</button>
      </form>
    </div>
  </details>
</div>`;

  return page(
    `<a class="crumb" href="/t/schedule">← ${t('Upcoming classes')}</a>
<div class="page-head">
  <h1>${t('Weekly slots')}</h1>
  <p class="lede">
    ${t('Times are set in Indian time and stay fixed there. What each student sees shifts with their own daylight saving, which is why their zone matters more than their offset.')}
  </p>
</div>
${msg ? `<div class="flash">${esc(msg)}</div>` : ''}
${rows.length ? rows.map(block).join('') : `<div class="empty">${t('No students yet.')}</div>`}`,
    { title: t('Weekly slots'), user, siteName, nav: 'schedule' },
  );
}

/* ------------------------------------------------------------------ *
 * The student's own next classes
 * ------------------------------------------------------------------ */

export function studentSchedule(user: User, occs: Occurrence[]): string {
  if (!occs.length) return '';
  const tz = user.time_zone || TEACHER_ZONE;

  return `<div class="section-head">
    <div><h2>${t('Next classes')}</h2>
      <p class="lede">${
        user.time_zone
          ? t('In your own time.')
          : t('In your own time — set your time zone below so these are right.')
      }</p></div>
  </div>
  <div class="rows">
    ${occs
      .slice(0, 6)
      .map((o) => {
        const l = inZone(o.instant, tz);
        return `<div class="row">
      <div class="row-main">
        <div class="row-title">${esc(t(l.weekday))} ${esc(l.date)} · ${esc(l.time)}
          <span class="zone">${esc(l.abbr)}</span></div>
        <div class="row-meta">
          <span>${esc(prettyIst(o.time))} IST</span>
          <span>${t('%s minutes', o.slot.duration_min)}</span>
          ${o.moved ? `<span>${t('rescheduled')}</span>` : ''}
          ${o.slot.label ? `<span>${esc(o.slot.label)}</span>` : ''}
        </div>
      </div>
    </div>`;
      })
      .join('')}
  </div>

  <form method="post" action="/me/zone" class="tzpick">
    <label for="my-loc">${t('Where you are')}</label>
    <input id="my-loc" name="location" type="text"
           value="${esc(user.location ?? '')}" placeholder="Dubai, UAE">
    <label for="my-tz" style="margin-top:8px">${t('Your time zone')}</label>
    <div class="zone-row">
      <select id="my-tz" name="time_zone">
        <option value="">${t('— not set —')}</option>
        ${zoneOptions(user.time_zone)}
      </select>
      <button class="btn btn-sm" type="submit">${t('Save')}</button>
    </div>
    <p class="hint">${t("Filled in from your browser the first time you signed in. Change it here if you've moved — it won't be overwritten.")}</p>
  </form>`;
}

/* ==================================================================
 * Calendar views
 * ================================================================== */

/** One class as it appears in a compact calendar cell. */
function chip(occ: Occurrence, student: WithZone): string {
  const cls = occ.skipped ? 'is-skipped' : occ.missed ? 'is-missed' : occ.moved ? 'is-moved' : '';
  const local = student.time_zone ? inZone(occ.instant, student.time_zone) : null;
  // A class in a past week belonging to someone who has since paused or
  // finished is still shown — with a word saying so, or it reads as a class
  // that is still running.
  const inactive = student.status && student.status !== 'active' ? student.status : null;
  // The chip is a link into the class itself, so the calendar is a way in
  // rather than only a way to look.
  return `<a class="cal-chip ${cls}${inactive ? ' is-former' : ''}"
  href="/t/class/${esc(occ.slot.id)}/${esc(occ.originalDate)}">
  <span class="cal-time">${esc(prettyIst(occ.time))}</span>
  <span class="cal-name">${esc(student.name)}</span>
  ${inactive ? `<span class="cal-former">${esc(t(inactive))}</span>` : ''}
  ${local ? `<span class="cal-local">${esc(local.time)} ${esc(t(local.weekday))}</span>` : ''}
</a>`;
}

export function weekCalendar(
  user: User,
  weekStart: string,
  cells: DayGroup[],
  siteName: string,
  msg?: string,
): string {
  setLang(user.lang);
  const today = istToday();
  const todayItems = cells.find((c) => c.date === today)?.items ?? [];
  const prev = addDays(weekStart, -7);
  const next = addDays(weekStart, 7);
  const total = cells.reduce((n, c) => n + c.items.length, 0);

  return page(
    `${msg ? `<div class="flash">${esc(msg)}</div>` : ''}
<div class="page-head">
  <h1>${t('This week')}</h1>
  <p class="lede">
    ${t("Your week in Indian time. Each class also shows the student's own clock underneath. Open a day to change or log its classes.")}
  </p>
</div>

<div class="btn-row" style="margin-bottom:16px">
  <a class="btn btn-sm" href="/t/schedule/week?start=${esc(prev)}">← ${t('Previous week')}</a>
  <a class="btn btn-sm" href="/t/schedule/week">${t('This week')}</a>
  <a class="btn btn-sm" href="/t/schedule/week?start=${esc(next)}">${t('Next week')} →</a>
  <span style="flex:1"></span>
  <a class="btn btn-sm" href="/t/schedule">${t('List view')}</a>
  <a class="btn btn-sm" href="/t/schedule/slots">${t('Weekly slots')}</a>
</div>

${
  todayItems.length
    ? `<div class="today-strip">
    <div class="today-head">${t('Today · %s', esc(prettyIstDate(today)))}</div>
    ${todayItems
      .map(({ occ, student }) => {
        const l = student.time_zone ? inZone(occ.instant, student.time_zone) : null;
        const off = occ.skipped || occ.missed;
        return `<div class="today-row${off ? ' is-off' : ''}">
      ${avatar(student)}
      <div class="today-who">
        <b>${esc(student.name)}</b>
        ${student.location ? `<span class="sched-loc">${esc(student.location)}</span>` : ''}
        ${occ.skipped ? `<span class="pill p-bad">${t('no class')}</span>` : ''}
        ${occ.missed ? `<span class="pill p-bad">${t('missed')}</span>` : ''}
      </div>
      <div class="today-time">
        <b>${esc(prettyIst(occ.time))}</b> <span class="zone">IST</span>
        ${l ? `<span class="today-local">${esc(l.time)} ${esc(t(l.weekday))} ${esc(l.abbr)}</span>` : ''}
      </div>
      <a class="btn btn-sm${off ? '' : ' btn-primary'}"
         href="/t/class/${esc(occ.slot.id)}/${esc(occ.originalDate)}">${off ? t('Open') : t('Start class')}</a>
    </div>`;
      })
      .join('')}
  </div>`
    : `<div class="today-strip is-quiet">
       <div class="today-head">${t('Today · %s', esc(prettyIstDate(today)))}</div>
       <p class="today-none">${t('No classes today.')}</p>
     </div>`
}

<div class="cal-week">
  ${cells
    .map(
      (c) => `<div class="cal-day${c.date === today ? ' is-today' : ''}${
        c.items.length ? '' : ' is-empty'
      }">
    <a class="cal-head" href="/t/schedule/day/${esc(c.date)}">
      <span class="cal-dow">${esc(t(prettyIstDate(c.date).split(' ')[0]))}</span>
      <span class="cal-num">${esc(c.date.slice(8))}</span>
    </a>
    <div class="cal-body">
      ${c.items.length ? c.items.map((i) => chip(i.occ, i.student)).join('') : '<span class="cal-none">—</span>'}
    </div>
  </div>`,
    )
    .join('')}
</div>

<p class="hint" style="margin-top:14px">
  ${total === 1 ? t('%s class this week.', total) : t('%s classes this week.', total)}
  ${t('Struck through means no class; amber means moved; red means missed.')}
</p>`,
    { title: t('This week'), user, siteName, nav: 'schedule' },
  );
}

export function dayView(
  user: User,
  date: string,
  items: { occ: Occurrence; student: WithZone }[],
  siteName: string,
  msg?: string,
): string {
  setLang(user.lang);
  const today = istToday();

  const row = ({ occ, student }: { occ: Occurrence; student: WithZone }) => {
    const state = occ.skipped ? 'skipped' : occ.missed ? 'missed' : 'on';
    return `<div class="card" style="margin-bottom:14px">
  <div class="sched-row" style="border:none;padding:0">
    ${avatar(student)}
    <div class="sched-who">
      <a href="/t/s/${esc(student.id)}">${esc(student.name)}</a>
      ${
        student.status && student.status !== 'active'
          ? `<span class="pill p-warn">${esc(t(student.status))}</span>`
          : ''
      }
      ${student.location ? `<span class="sched-loc">${esc(student.location)}</span>` : ''}
      ${occ.slot.label ? `<span class="slot-label">${esc(occ.slot.label)}</span>` : ''}
      ${occ.moved ? `<span class="pill p-warn">${t('moved here')}</span>` : ''}
      ${occ.skipped ? `<span class="pill p-bad">${t('no class')}</span>` : ''}
      ${occ.missed ? `<span class="pill p-bad">${t('missed')}</span>` : ''}
      ${occ.reason ? `<span class="sched-reason">${esc(occ.reason)}</span>` : ''}
    </div>
    <div class="sched-times">
      <span class="ist"><b>${esc(prettyIst(occ.time))}</b> <span class="zone">IST</span></span>
      <span class="arrow">→</span>
      ${localLine(occ, student)}
    </div>
  </div>

  <div class="day-actions">
    ${
      state === 'on'
        ? `<form method="post" action="/t/slots/${esc(occ.slot.id)}/missed" class="day-form">
        <input type="hidden" name="on_date" value="${esc(occ.originalDate)}">
        <input type="hidden" name="back" value="/t/schedule/day/${esc(date)}">
        <input name="reason" type="text" placeholder="${t("Why it didn't happen — optional")}">
        <button class="btn btn-sm" type="submit">${t('Mark missed')}</button>
      </form>
      <form method="post" action="/t/slots/${esc(occ.slot.id)}/skip" class="day-form">
        <input type="hidden" name="on_date" value="${esc(occ.originalDate)}">
        <input type="hidden" name="back" value="/t/schedule/day/${esc(date)}">
        <input name="reason" type="text" placeholder="${t('Reason — Onam, travel…')}">
        <button class="btn btn-sm" type="submit">${t('Cancel this class')}</button>
      </form>`
        : `<form method="post" action="/t/slots/${esc(occ.slot.id)}/restore" class="day-form">
        <input type="hidden" name="on_date" value="${esc(occ.originalDate)}">
        <input type="hidden" name="back" value="/t/schedule/day/${esc(date)}">
        <button class="btn btn-sm" type="submit">${t('Put it back')}</button>
      </form>`
    }
    <form method="post" action="/t/slots/${esc(occ.slot.id)}/move" class="day-form">
      <input type="hidden" name="on_date" value="${esc(occ.originalDate)}">
      <input type="hidden" name="back" value="/t/schedule/day/${esc(date)}">
      <span class="day-label">${t('Reschedule to')}</span>
      <input name="new_date" type="date" value="${esc(occ.date)}" required>
      <input name="new_time_ist" type="time" value="${esc(occ.time)}" required>
      <button class="btn btn-sm btn-primary" type="submit">${t('Move')}</button>
    </form>
    <a class="btn btn-sm btn-primary" href="/t/class/${esc(occ.slot.id)}/${esc(occ.originalDate)}">${t('Open this class')}</a>
  </div>
</div>`;
  };

  return page(
    `${msg ? `<div class="flash">${esc(msg)}</div>` : ''}
<a class="crumb" href="/t/schedule/week?start=${esc(addDays(date, -((weekdayIndex(date) + 6) % 7)))}">← ${t('Week')}</a>
<div class="page-head">
  <h1>${esc(prettyIstDate(date))}${date === today ? ` · ${t('today')}` : ''}</h1>
  <p class="lede">${items.length === 1 ? t('%s class.', items.length) : t('%s classes.', items.length)} ${t(
    "Times shown in Indian time, with each student's own time beside it.",
  )}</p>
</div>

<div class="btn-row" style="margin-bottom:18px">
  <a class="btn btn-sm" href="/t/schedule/day/${esc(addDays(date, -1))}">← ${esc(prettyIstDate(addDays(date, -1)))}</a>
  <a class="btn btn-sm" href="/t/schedule/day/${esc(addDays(date, 1))}">${esc(prettyIstDate(addDays(date, 1)))} →</a>
</div>

${items.length ? items.map(row).join('') : `<div class="empty">${t('No classes on this day.')}</div>`}`,
    { title: prettyIstDate(date), user, siteName, nav: 'schedule' },
  );
}

function weekdayIndex(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/* ==================================================================
 * A student's own class history — a month at a glance
 * ================================================================== */

export function monthCalendar(
  monthStart: string,
  occs: Occurrence[],
  opts: {
    heading?: string;
    /** Where a day with classes should take you, if anywhere. */
    dayHref?: (date: string, list: Occurrence[]) => string | null;
  } = {},
): string {
  const [y, m] = monthStart.split('-').map(Number);
  const first = `${monthStart.slice(0, 7)}-01`;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = weekdayIndex(first);
  const today = istToday();

  const byDate = new Map<string, Occurrence[]>();
  for (const o of occs) {
    if (!byDate.has(o.date)) byDate.set(o.date, []);
    byDate.get(o.date)!.push(o);
  }

  const cells: string[] = [];
  for (let i = 0; i < lead; i++) cells.push('<div class="mc-cell is-blank"></div>');
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${monthStart.slice(0, 7)}-${String(d).padStart(2, '0')}`;
    const list = byDate.get(date) ?? [];
    const state = !list.length
      ? ''
      : list.some((o) => o.missed)
        ? ' is-missed'
        : list.some((o) => o.skipped)
          ? ' is-skipped'
          : date < today
            ? ' is-past'
            : ' is-upcoming';
    const href = list.length && opts.dayHref ? opts.dayHref(date, list) : null;
    const tag = href ? 'a' : 'div';
    const attrs = href ? ` href="${esc(href)}"` : '';
    cells.push(`<${tag}${attrs} class="mc-cell${state}${date === today ? ' is-today' : ''}${
      href ? ' is-link' : ''
    }"
      title="${esc(date)}${
        list.length
          ? ` · ${list.length === 1 ? t('%s class', list.length) : t('%s classes', list.length)}`
          : ''
      }${href ? ` · ${t('click to open')}` : ''}">
      <span class="mc-num">${d}</span>
      ${list.length ? `<span class="mc-dot"></span>` : ''}
    </${tag}>`);
  }

  const label = monthLabel(monthStart.slice(0, 7));

  return `<div class="monthcal">
  <div class="mc-head">
    <span class="mc-title">${opts.heading ? esc(opts.heading) + ' · ' : ''}${esc(label)}</span>
    <span class="mc-key">
      <span><i class="k-past"></i> ${t('held')}</span>
      <span><i class="k-missed"></i> ${t('missed')}</span>
      <span><i class="k-skipped"></i> ${t('cancelled')}</span>
      <span><i class="k-upcoming"></i> ${t('upcoming')}</span>
    </span>
  </div>
  <div class="mc-dows">${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
    .map((d) => `<span>${t(d)}</span>`)
    .join('')}</div>
  <div class="mc-grid">${cells.join('')}</div>
</div>`;
}
