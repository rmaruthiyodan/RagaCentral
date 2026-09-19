/* ==================================================================
 * The student's own side, across five tabs.
 *
 * It used to be one page: the resume card, the next classes, the time
 * zone form, three separate song lists and the entire lesson history,
 * stacked. On a phone — which is where a student actually opens this,
 * usually standing at a harmonium — finding last week's note meant
 * scrolling past everything they own.
 *
 * The teacher's view of a student was split into tabs for exactly this
 * reason (see student.ts). This is the same treatment for the person
 * the app is actually for, and deliberately the same shape: one app,
 * learned once.
 *
 * What each tab answers:
 *
 *   Home          what do I do today?
 *   My songs      where is that piece?
 *   Past classes  what did we cover, and when?
 *   Schedule      when am I next on?
 *   Settings      the clock everything is shown on
 *
 * The next class sits in the header rather than on a tab, because it is
 * the one thing worth knowing on every screen and it is small.
 * ================================================================== */

import { page, inlineTitle } from './layout';
import { resumeCard, lessonLog } from './sessions';
import { monthCalendar, studentUpcoming, studentZoneForm } from './schedule';
import { esc, fmtDate, relativeDate } from '../util';
import { prettyIstZ, inZone, TEACHER_ZONE, type Occurrence } from '../tz';
import type { User, SessionRow, AssignedRow } from '../types';
import { t, setLang } from '../i18n';

export type MeTab = 'home' | 'songs' | 'lessons' | 'schedule' | 'settings';

export interface MeCounts {
  songs: number;
  lessons: number;
}

/* ------------------------------------------------------------------ *
 * The shell
 * ------------------------------------------------------------------ */

/** Whole days from one ISO date to another. Both are plain dates, so no
    clock arithmetic and no daylight saving to get wrong. */
function daysBetween(fromIso: string, toIso: string): number {
  const p = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((p(toIso) - p(fromIso)) / 86400000);
}

/** "today", "tomorrow", "in 4 days" — on the student's own calendar. */
function whenWord(days: number): string {
  if (days <= 0) return t('today');
  if (days === 1) return t('tomorrow');
  if (days < 7) return t('in %s days', days);
  if (days < 14) return t('next week');
  return t('in %s weeks', Math.round(days / 7));
}

/**
 * The next class, as it appears at the top of every tab.
 *
 * Both clocks, always. A student in Perth reading "7:00 pm" has no way
 * to know whether that is their evening or the teacher's, and the whole
 * cost of getting it wrong is missing the class.
 */
function nextStrip(user: User, next: Occurrence | undefined): string {
  if (!next) {
    return `<div class="me-next is-none">
      <span class="me-next-lab">${esc(t('Next class'))}</span>
      <span class="me-next-none">${esc(t('nothing scheduled'))}</span>
    </div>`;
  }
  const tz = user.time_zone || TEACHER_ZONE;
  const l = inZone(next.instant, tz);
  const days = daysBetween(inZone(new Date(), tz).iso, l.iso);

  return `<div class="me-next">
    <span class="me-next-lab">${esc(t('Next class'))}</span>
    <span class="me-next-when">${esc(t(l.weekday))} ${esc(l.date)}</span>
    <span class="me-next-time">${esc(l.time)} <span class="zone">${esc(l.abbr)}</span></span>
    <span class="me-next-ist">${esc(prettyIstZ(next.time))}</span>
    <span class="me-next-in">${esc(whenWord(days))}</span>
  </div>`;
}

function shell(
  user: User,
  tab: MeTab,
  counts: MeCounts,
  next: Occurrence | undefined,
  siteName: string,
  body: string,
): string {
  const mtab = (id: MeTab, href: string, label: string, badge?: number) =>
    `<a class="stab${tab === id ? ' is-on' : ''}" href="${esc(href)}"${
      tab === id ? ' aria-current="page"' : ''
    }>${esc(label)}${badge ? ` <span class="stab-n">${badge}</span>` : ''}</a>`;

  return `<header class="me-head">
  <div class="me-who">
    <h1>${esc(user.name)}</h1>
    <p class="lede">${esc(siteName)}</p>
  </div>
  ${nextStrip(user, next)}
</header>

<nav class="stabs">
  ${mtab('home', '/me', t('Home'))}
  ${mtab('songs', '/me/songs', t('My songs'), counts.songs)}
  ${mtab('lessons', '/me/lessons', t('Past classes'), counts.lessons)}
  ${mtab('schedule', '/me/schedule', t('Schedule'))}
  ${mtab('settings', '/me/settings', t('Settings'))}
</nav>

${body}`;
}

/* ------------------------------------------------------------------ *
 * A song, as a row
 * ------------------------------------------------------------------ */

function songRow(a: AssignedRow): string {
  return `<a class="row${a.completed_at ? ' is-done' : ''}" href="/me/${esc(a.id)}">
  <div class="row-main">
    <div class="row-title">${inlineTitle(a.title, a.title_ml)}${
      a.completed_at ? ` <span class="pill p-good">${t('finished')}</span>` : ''
    }</div>
    <div class="row-meta">
      ${a.group_name ? `<span>${esc(a.group_name)}</span>` : ''}
      ${a.raga ? `<span>${t('Raga %s', esc(a.raga))}</span>` : ''}
      ${
        a.rec_count
          ? `<span class="num">${
              a.rec_count === 1 ? t('%s recording', a.rec_count) : t('%s recordings', a.rec_count)
            }</span>`
          : ''
      }
      ${
        a.note_count
          ? `<span class="num">${
              a.note_count === 1 ? t('%s note', a.note_count) : t('%s notes', a.note_count)
            }</span>`
          : ''
      }
      ${a.started_at ? `<span>${t('started %s', esc(fmtDate(a.started_at)))}</span>` : ''}
      ${a.last_added ? `<span>${t('updated %s', esc(relativeDate(a.last_added)))}</span>` : ''}
    </div>
  </div>
  <div class="row-actions"><span class="btn btn-sm">${
    a.rec_count ? t('Listen') : t('Open')
  }</span></div>
</a>`;
}

/* ------------------------------------------------------------------ *
 * Home — what do I do today?
 * ------------------------------------------------------------------ */

export function homeTab(
  user: User,
  counts: MeCounts,
  d: { sessions: SessionRow[]; upcoming: Occurrence[]; assigned: AssignedRow[] },
  siteName: string,
  msg?: string,
): string {
  setLang(user.lang);

  /* Recordings first, because those are the ones that can actually be
     practised — but not ONLY those. A student whose teacher has
     assigned three songs and recorded none of them yet would otherwise
     open the app to an empty page, which reads as "nothing here for
     you" rather than "nothing recorded yet". */
  const live = d.assigned.filter((a) => !a.completed_at);
  const practise = [
    ...live.filter((a) => a.rec_count > 0),
    ...live.filter((a) => a.rec_count === 0),
  ];

  return page(
    shell(
      user,
      'home',
      counts,
      d.upcoming[0],
      siteName,
      `${msg ? `<div class="flash">${esc(msg)}</div>` : ''}

${resumeCard(d.sessions[0] ?? null, {
  isTeacher: false,
  firstName: user.name.split(' ')[0],
  logHref: '/me/lessons',
})}

<div class="section-head">
  <div><h2>${t('Practise now')}</h2>
    <p class="lede">${t('Slow any recording down without changing the pitch, and loop the phrase you are working on.')}</p>
  </div>
  ${counts.songs > practise.length ? `<a class="btn btn-sm" href="/me/songs">${t('All songs')}</a>` : ''}
</div>
${
  practise.length
    ? `<div class="rows">${practise.slice(0, 5).map(songRow).join('')}</div>`
    : `<div class="empty"><strong>${t('Nothing to practise yet')}</strong>
       ${t('As soon as your teacher adds a recording, it appears here.')}</div>`
}

<div class="section-head">
  <div><h2>${t('Recent classes')}</h2></div>
  ${
    counts.lessons
      ? `<a class="btn btn-sm" href="/me/lessons">${t('All %s past classes', counts.lessons)}</a>`
      : ''
  }
</div>
${
  d.sessions.length
    ? `<div class="rows">${d.sessions
        .slice(0, 3)
        .map(
          (s) => `<a class="row" href="/me/lessons#l-${esc(s.id)}">
      <div class="row-main">
        <div class="row-title">${esc(fmtDate(s.held_on))}${
          s.status === 'ongoing' ? ` <span class="pill p-brass">${t('ongoing')}</span>` : ''
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
    { title: t('Home'), user, siteName, nav: 'mine', hideNav: true },
  );
}

/* ------------------------------------------------------------------ *
 * My songs
 * ------------------------------------------------------------------ */

export function songsTab(
  user: User,
  counts: MeCounts,
  assigned: AssignedRow[],
  siteName: string,
  next: Occurrence | undefined,
  q = '',
): string {
  setLang(user.lang);

  const live = assigned.filter((a) => !a.completed_at);
  const withRecs = live.filter((a) => a.rec_count > 0);
  const waiting = live.filter((a) => a.rec_count === 0);
  const finished = assigned.filter((a) => a.completed_at);

  const group = (heading: string, lede: string, list: AssignedRow[]) =>
    list.length
      ? `<div class="section-head">
           <div><h2>${esc(heading)}</h2>${lede ? `<p class="lede">${esc(lede)}</p>` : ''}</div>
         </div>
         <div class="rows">${list.map(songRow).join('')}</div>`
      : '';

  return page(
    shell(
      user,
      'songs',
      counts,
      next,
      siteName,
      `<form class="searchbox" method="get" action="/me/songs" role="search">
  <input type="search" name="q" value="${esc(q)}"
         placeholder="${esc(t('Search your songs by name or raga…'))}" aria-label="${esc(t('Search'))}">
  <button class="btn btn-sm" type="submit">${t('Search')}</button>
  ${q ? `<a class="btn btn-sm btn-quiet" href="/me/songs">${t('Clear')}</a>` : ''}
</form>

${
  assigned.length
    ? `${group(t('With recordings'), t('Ready to practise.'), withRecs)}
       ${group(t('Assigned, nothing recorded yet'), '', waiting)}
       ${group(t('Finished'), t('The recordings stay here.'), finished)}`
    : q
      ? `<div class="empty"><strong>${t('Nothing matches "%s"', esc(q))}</strong>
         ${t('Search covers the song name in either script, plus raga and composer.')}</div>`
      : `<div class="empty"><strong>${t('No songs yet')}</strong>
         ${t('Your teacher assigns these. They will appear here.')}</div>`
}`,
    ),
    { title: t('My songs'), user, siteName, nav: 'mine', hideNav: true },
  );
}

/* ------------------------------------------------------------------ *
 * Past classes
 * ------------------------------------------------------------------ */

export function lessonsTab(
  user: User,
  counts: MeCounts,
  sessions: SessionRow[],
  assigned: AssignedRow[],
  siteName: string,
  next: Occurrence | undefined,
): string {
  setLang(user.lang);
  return page(
    shell(
      user,
      'lessons',
      counts,
      next,
      siteName,
      `<div class="page-head">
  <h2>${t('Past classes')}</h2>
  <p class="lede">${t('What you covered, and where each class stopped.')}</p>
</div>
${lessonLog(sessions, { isTeacher: false, studentId: user.id, assigned })}`,
    ),
    { title: t('Past classes'), user, siteName, nav: 'mine', hideNav: true },
  );
}

/* ------------------------------------------------------------------ *
 * Schedule
 * ------------------------------------------------------------------ */

export function scheduleTab(
  user: User,
  counts: MeCounts,
  upcoming: Occurrence[],
  month: string,
  siteName: string,
): string {
  setLang(user.lang);
  const tz = user.time_zone || TEACHER_ZONE;

  return page(
    shell(
      user,
      'schedule',
      counts,
      upcoming[0],
      siteName,
      `${
        upcoming.length
          ? studentUpcoming(user, upcoming)
          : `<div class="empty"><strong>${t('No classes scheduled')}</strong>
             ${t('Your teacher sets these up. Ask them if you were expecting one.')}</div>`
      }

${monthCalendar(month, upcoming, { heading: t('This month') })}

<p class="hint" style="margin-top:14px">${
        user.time_zone
          ? t('Times are shown on your clock (%s) and on the teacher’s. Change yours in Settings.', esc(tz.replace(/_/g, ' ')))
          : t('Your time zone is not set, so these are shown on the teacher’s clock. Set it in Settings.')
      }</p>`,
    ),
    { title: t('Schedule'), user, siteName, nav: 'mine', hideNav: true },
  );
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export function settingsTab(
  user: User,
  counts: MeCounts,
  siteName: string,
  next: Occurrence | undefined,
  msg?: string,
): string {
  setLang(user.lang);

  return page(
    shell(
      user,
      'settings',
      counts,
      next,
      siteName,
      `${msg ? `<div class="flash">${esc(msg)}</div>` : ''}

<div class="page-head">
  <h2>${t('Settings')}</h2>
  <p class="lede">${t('The clock your classes are shown on, and how to reach you.')}</p>
</div>

<div class="panel">
  <div class="panel-body">
    ${studentZoneForm(user)}
  </div>
</div>

<div class="section-head"><h2>${t('Your account')}</h2></div>
<div class="rows">
  <div class="row">
    <div class="row-main">
      <div class="row-title">${esc(user.name)}</div>
      <div class="row-meta"><span>${esc(user.email)}</span></div>
    </div>
  </div>
</div>
<p class="hint">${t('Your name and photo come from the Google account you sign in with. Colours and language are in the menu beside your name.')}</p>`,
    ),
    { title: t('Settings'), user, siteName, nav: 'mine', hideNav: true },
  );
}
