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
 *   Catalogue     (catalogue helpers only) the whole song list, to keep tidy
 *
 * The next class sits in the header rather than on a tab, because it is
 * the one thing worth knowing on every screen and it is small.
 * ================================================================== */

import { page, inlineTitle, disclosure, discloseAll } from './layout';
import { resumeCard, lessonLog } from './sessions';
import { monthCalendar, studentUpcoming, studentZoneForm } from './schedule';
import { esc, fmtDate, relativeDate } from '../util';
import { prettyIstZ, inZone, TEACHER_ZONE, type Occurrence } from '../tz';
import type { User, SessionRow, AssignedRow, Group, Section } from '../types';
import { t, setLang } from '../i18n';

export type MeTab = 'home' | 'songs' | 'lessons' | 'schedule' | 'settings' | 'catalogue';

export interface MeCounts {
  songs: number;
  lessons: number;
  /** 1 when the teacher has made them a catalogue helper. */
  curator?: number | null;
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
  ${counts.curator ? mtab('catalogue', '/me/catalogue', t('Song Catalog')) : ''}
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
  totals: { total: number; completed: number; ongoing: number },
  pager: { page: number; pages: number; href: (p: number) => string },
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
${/* Four at a time, like the teacher's. What is not on this page was
     never fetched, so a student two years in loads no more than one two
     months in. */ ''}
${lessonLog(sessions, { isTeacher: false, studentId: user.id, assigned, totals, pager })}`,
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

/* ------------------------------------------------------------------ *
 * Catalogue — for a student the teacher has made a catalogue helper
 * ------------------------------------------------------------------ */

export interface CatalogueSong extends Section {
  /** 1 when this song is on the helper's own list — then it opens. */
  mine: number;
  /** Active students learning it now (finished ones not counted). */
  learners: number;
}

/** A student as a helper sees them on a song: a name, and where they are with it. */
export interface HelperStudent {
  id: string;
  name: string;
  completed_at: string | null;
  /** Who put it on their list, when that was someone else. */
  added_by: string | null;
}

export interface PendingDeletion {
  id: string;
  kind: string;
  target_id: string;
  requested_by: string;
}

/**
 * The whole song list, with what a helper can do to it: add a group, add
 * a song, correct a song's details, and ask for a song or group to be
 * deleted. Recordings and notes are not here at all — a song that is not
 * theirs opens nowhere, exactly as before.
 */
export function catalogueTab(
  user: User,
  counts: MeCounts,
  siteName: string,
  next: Occurrence | undefined,
  groups: Group[],
  songs: CatalogueSong[],
  pending: PendingDeletion[],
  q = '',
  msg?: string,
): string {
  setLang(user.lang);
  const asked = (kind: string, id: string) => pending.find((p) => p.kind === kind && p.target_id === id);
  const groupOptions = (current: string | null) =>
    `<option value="">${t('— none —')}</option>${groups
      .map((g) => `<option value="${esc(g.id)}"${g.id === current ? ' selected' : ''}>${esc(g.name)}</option>`)
      .join('')}`;

  /** Asking to delete — or, once asked, the state of it. */
  const deleteControl = (kind: 'section' | 'group', id: string, label: string) => {
    const p = asked(kind, id);
    if (p)
      return `<span class="pill p-warn">${t('Deletion asked for')}</span>${
        p.requested_by === user.id
          ? `<form method="post" action="/me/catalogue/delete-request/${esc(p.id)}/withdraw" class="inline-form">
               <button class="btn btn-sm btn-quiet" type="submit">${t('Withdraw')}</button></form>`
          : ''
      }`;
    return `<details class="inline-edit cat-del">
      <summary>${esc(label)}</summary>
      <form method="post" action="/me/catalogue/delete-request" class="inline-edit-body">
        <input type="hidden" name="kind" value="${kind}">
        <input type="hidden" name="target_id" value="${esc(id)}">
        <label for="dr-${esc(id)}">${t('Why')} <span class="opt">${t('— optional')}</span></label>
        <input id="dr-${esc(id)}" name="reason" type="text" maxlength="300" placeholder="${esc(t('Added twice by mistake'))}">
        <p class="hint">${
          kind === 'section'
            ? t('Your teacher decides. Deleting a song also deletes every recording and note filed under it.')
            : t('Your teacher decides. The songs in it stay; they just lose their group.')
        }</p>
        <button class="btn btn-sm" type="submit">${t('Send to my teacher')}</button>
      </form>
    </details>`;
  };

  const songForm = (s: CatalogueSong | null, idp: string) => `
      <div class="field-row">
        <div class="field"><label for="${idp}-t">${t('Title')}</label>
          <input id="${idp}-t" name="title" type="text" required maxlength="200" value="${esc(s?.title ?? '')}" placeholder="Vatapi Ganapatim"></div>
        <div class="field"><label for="${idp}-ml">${t('In Malayalam')} <span class="opt">${t('— optional')}</span></label>
          <input id="${idp}-ml" name="title_ml" type="text" class="ml" lang="ml" maxlength="200" value="${esc(s?.title_ml ?? '')}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="${idp}-r">${t('Raga')}</label><input id="${idp}-r" name="raga" type="text" maxlength="200" value="${esc(s?.raga ?? '')}" placeholder="Hamsadhwani"></div>
        <div class="field"><label for="${idp}-tl">${t('Taala')}</label><input id="${idp}-tl" name="taala" type="text" maxlength="200" value="${esc(s?.taala ?? '')}" placeholder="Adi"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="${idp}-c">${t('Composer')}</label><input id="${idp}-c" name="composer" type="text" maxlength="200" value="${esc(s?.composer ?? '')}" placeholder="Muthuswami Dikshitar"></div>
        <div class="field"><label for="${idp}-g">${t('Group')}</label>
          <select id="${idp}-g" name="group_id">${groupOptions(s?.group_id ?? null)}</select></div>
      </div>`;

  const songRowC = (s: CatalogueSong) => `<div class="row cat-row">
    <div class="row-main">
      <div class="row-title">${
        s.mine ? `<a href="/me/${esc(s.id)}">${inlineTitle(s.title, s.title_ml)}</a>` : inlineTitle(s.title, s.title_ml)
      }${s.mine ? ` <span class="pill p-info">${t('on your list')}</span>` : ''}</div>
      <div class="row-meta">
        ${s.raga ? `<span>${t('Raga %s', esc(s.raga))}</span>` : ''}
        ${s.taala ? `<span>${t('Taala %s', esc(s.taala))}</span>` : ''}
        ${s.composer ? `<span>${esc(s.composer)}</span>` : ''}
      </div>
      <div class="cat-tools">
        <details class="inline-edit">
          <summary>${t('Edit details')}</summary>
          <form method="post" action="/me/catalogue/sections/${esc(s.id)}" class="inline-edit-body">
            ${songForm(s, `e-${s.id}`)}
            <button class="btn btn-sm btn-primary" type="submit">${t('Save details')}</button>
          </form>
        </details>
        <a class="cat-who" href="/me/catalogue/song/${esc(s.id)}">${
          s.learners ? t('Students · %s learning', s.learners) : t('Assign to students')
        }</a>
        ${deleteControl('section', s.id, t('Ask to delete this song'))}
      </div>
    </div>
  </div>`;

  const byGroup = new Map<string, CatalogueSong[]>();
  for (const s of songs) {
    const k = s.group_id ?? '__none';
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k)!.push(s);
  }
  const block = (id: string, name: string, nameMl: string | null) => {
    const items = byGroup.get(id) ?? [];
    return disclosure({
      key: `helper-group:${id}`,
      cls: 'disc-group',
      open: groups.length <= 3,
      title: `${esc(name)}${nameMl ? ` <span class="ml" style="font-weight:400;color:var(--ink-3)">${esc(nameMl)}</span>` : ''}`,
      meta: items.length === 1 ? t('%s song', items.length) : t('%s songs', items.length),
      body: `${items.length ? `<div class="rows">${items.map(songRowC).join('')}</div>` : `<div class="empty">${t('Nothing in this group yet.')}</div>`}
        ${id !== '__none' ? `<div class="cat-group-del">${deleteControl('group', id, t('Ask to delete this group'))}</div>` : ''}`,
    });
  };

  return page(
    shell(
      user,
      'catalogue',
      counts,
      next,
      siteName,
      `${msg ? `<div class="flash">${esc(msg)}</div>` : ''}
<div class="page-head">
  <h2>${t('Song Catalog')}</h2>
  <p class="lede">${t('Your teacher has asked you to help keep the song list. You can add groups and songs, correct their details, and put songs on students\' lists. Deleting anything goes to your teacher to approve first.')}</p>
</div>

<form class="searchbox" method="get" action="/me/catalogue" role="search">
  <input type="search" name="q" value="${esc(q)}" placeholder="${esc(t('Title, Malayalam, raga, taala or composer…'))}" aria-label="${esc(t('Search'))}">
  <button class="btn btn-sm" type="submit">${t('Search')}</button>
  ${q ? `<a class="btn btn-sm btn-quiet" href="/me/catalogue">${t('Clear')}</a>` : ''}
</form>

<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr));margin-bottom:22px">
  <details class="panel">
    <summary>${t('Add a song')}</summary>
    <div class="panel-body">
      <form method="post" action="/me/catalogue/sections">
        ${songForm(null, 'ns')}
        <button class="btn btn-primary" type="submit">${t('Add song')}</button>
      </form>
    </div>
  </details>
  <details class="panel">
    <summary>${t('Add a group')}</summary>
    <div class="panel-body">
      <form method="post" action="/me/catalogue/groups">
        <div class="field"><label for="ng-name">${t('Group name')}</label>
          <input id="ng-name" name="name" type="text" required maxlength="120" placeholder="Sarali varisai"></div>
        <div class="field"><label for="ng-ml">${t('In Malayalam')} <span class="opt">${t('— optional')}</span></label>
          <input id="ng-ml" name="name_ml" type="text" class="ml" lang="ml" maxlength="120"></div>
        <button class="btn btn-primary" type="submit">${t('Add group')}</button>
      </form>
    </div>
  </details>
</div>

${
  q
    ? songs.length
      ? `<div class="rows">${songs.map(songRowC).join('')}</div>`
      : `<div class="empty"><strong>${t('No songs match "%s"', esc(q))}</strong></div>`
    : songs.length || groups.length
      ? `${discloseAll(t('Open a group to see its songs.'))}
         ${groups.map((g) => block(g.id, g.name, g.name_ml)).join('')}
         ${byGroup.has('__none') ? block('__none', t('Ungrouped'), null) : ''}`
      : `<div class="empty"><strong>${t('No songs yet')}</strong> ${t('Add the first one above.')}</div>`
}`,
    ),
    { title: t('Song Catalog'), user, siteName, nav: 'mine', hideNav: true },
  );
}


/**
 * One song, and who is learning it — the only place a helper sees the
 * other students, and only their names. Put the song on someone's list,
 * or take it off while they are still learning it. Finished songs are
 * shown but left alone: that is the teacher's record.
 */
export function catalogueSong(
  user: User,
  counts: MeCounts,
  siteName: string,
  next: Occurrence | undefined,
  song: Section & { group_name: string | null },
  who: { learning: HelperStudent[]; finished: HelperStudent[]; others: HelperStudent[] },
  msg?: string,
): string {
  setLang(user.lang);
  const action = (verb: 'assign' | 'unassign') => `/me/catalogue/song/${esc(song.id)}/${verb}`;
  const name = (s: HelperStudent) =>
    `${esc(s.name)}${s.id === user.id ? ` <span class="pill p-info">${t('you')}</span>` : ''}`;
  const mineNow = who.learning.some((s) => s.id === user.id) || who.finished.some((s) => s.id === user.id);
  const meToAdd = who.others.find((s) => s.id === user.id);
  const othersToAdd = who.others.filter((s) => s.id !== user.id);

  const learningRow = (s: HelperStudent) => `<div class="row sa-row">
    <div class="row-main">
      <div class="row-title">${name(s)}</div>
      ${s.added_by ? `<div class="row-meta"><span>${t('added by %s', esc(s.added_by))}</span></div>` : ''}
    </div>
    <div class="row-actions">
      <form method="post" action="${action('unassign')}">
        <input type="hidden" name="student_id" value="${esc(s.id)}">
        <button class="btn btn-sm btn-quiet" type="submit">${s.id === user.id ? t('Take off my list') : t('Take off their list')}</button>
      </form>
    </div>
  </div>`;
  const finishedRow = (s: HelperStudent) => `<div class="row sa-row">
    <div class="row-main">
      <div class="row-title">${name(s)}</div>
      <div class="row-meta"><span>${t('finished %s', esc(relativeDate(s.completed_at!)))}</span></div>
    </div>
  </div>`;

  const meta = [
    song.group_name ? esc(song.group_name) : '',
    song.raga ? t('Raga %s', esc(song.raga)) : '',
    song.taala ? t('Taala %s', esc(song.taala)) : '',
    song.composer ? esc(song.composer) : '',
  ].filter(Boolean).join(' · ');

  return page(
    shell(
      user,
      'catalogue',
      counts,
      next,
      siteName,
      `${msg ? `<div class="flash">${esc(msg)}</div>` : ''}
<a class="crumb" href="/me/catalogue">← ${t('Song Catalog')}</a>
<div class="page-head">
  <h2>${inlineTitle(song.title, song.title_ml)}</h2>
  ${meta ? `<p class="lede">${meta}</p>` : ''}
  ${mineNow ? `<p><a class="btn btn-sm" href="/me/${esc(song.id)}">${t('Open it in My songs')}</a></p>` : ''}
</div>

<section class="card sa-card">
  <h3>${t('Put it on a list')}</h3>
  ${
    meToAdd
      ? `<form method="post" action="${action('assign')}" class="sa-me">
           <input type="hidden" name="student_id" value="${esc(user.id)}">
           <button class="btn btn-primary" type="submit">${t('Add to my list')}</button>
         </form>`
      : ''
  }
  ${
    othersToAdd.length
      ? `<form method="post" action="${action('assign')}" class="sa-pick">
           <label for="sa-s">${t('Another student')}</label>
           <div class="sa-pick-row">
             <select id="sa-s" name="student_id" required>
               <option value="">${t('Choose a student…')}</option>
               ${othersToAdd.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}
             </select>
             <button class="btn" type="submit">${t('Assign')}</button>
           </div>
         </form>`
      : meToAdd
        ? ''
        : `<p class="hint">${t('Everyone already has this song.')}</p>`
  }
  <p class="hint">${t('They see it in My songs straight away. Only names are shown here — recordings and notes stay private.')}</p>
</section>

<div class="section-head"><h2>${t('Learning it')} <span class="sa-n num">${who.learning.length}</span></h2></div>
${who.learning.length ? `<div class="rows">${who.learning.map(learningRow).join('')}</div>`
  : `<div class="empty">${t('Nobody is learning this song yet.')}</div>`}
<p class="hint">${t('Taking a song off a list keeps its recordings; putting it back brings them back.')}</p>

${who.finished.length ? `<div class="section-head"><h2>${t('Finished')} <span class="sa-n num">${who.finished.length}</span></h2></div>
<div class="rows">${who.finished.map(finishedRow).join('')}</div>
<p class="hint">${t('Only your teacher changes a finished song.')}</p>` : ''}`,
    ),
    { title: song.title, user, siteName, nav: 'mine', hideNav: true },
  );
}
