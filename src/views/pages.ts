import {
  page, avatar, inlineTitle, titleWithScript, flash, disclosure, discloseAll,
} from './layout';
import type { Visiting } from './layout';
import { resumeCard, lessonLog, spoken } from './sessions';
import { zoneOptions } from './schedule';
import { prettyIst, prettyIstDate, WEEKDAYS, inZone, type Occurrence } from '../tz';
import { esc, fmtBytes, fmtDuration, fmtDate, relativeDate } from '../util';
import type { User, Group, Section, Recording, Note, SessionRow, ClassSlot, AssignedRow, ProjectPerson } from '../types';
import type { Hat } from '../projects';
import { t, setLang } from '../i18n';

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
  <input type="search" name="q" value="${esc(q)}" placeholder="${esc(placeholder)}" aria-label="${esc(t('Search'))}">
  <button class="btn btn-sm" type="submit">${t('Search')}</button>
  ${q ? `<a class="btn btn-sm btn-quiet" href="${esc(action)}">${t('Clear')}</a>` : ''}
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
  setLang(null);
  return page(
    `${flash(error, 'err')}
<div style="max-width:520px;margin:8vh auto 0;text-align:center">
  <h1 style="font-size:2.6rem">${esc(siteName)}</h1>
  <p class="lede" style="margin:14px auto 30px;max-width:42ch">
    ${t('Recordings and notes from your Carnatic vocal lessons, kept in one place. Sign in with the Google account your teacher has for you.')}
  </p>
  <a class="google-btn" href="/auth/google">${GOOGLE_G} ${t('Sign in with Google')}</a>
  <p class="hint" style="margin-top:26px">
    ${t('Your recordings are private. Only you and your teacher can play them.')}
  </p>
</div>`,
    { title: t('Sign in'), siteName, bodyClass: 'narrow' },
  );
}

export function waiting(user: User, siteName: string): string {
  setLang(user.lang);
  return page(
    `<div style="max-width:520px;margin:8vh auto 0;text-align:center">
  <h1>${t('Almost there')}</h1>
  <p class="lede" style="margin:14px auto 26px;max-width:44ch">
    ${t("You're signed in as %s. Your teacher needs to approve this account before your lessons appear. You'll see them here as soon as that happens.", `<strong>${esc(user.email)}</strong>`)}
  </p>
  <div class="btn-row" style="justify-content:center">
    <a class="btn" href="/waiting">${t('Check again')}</a>
    <form method="post" action="/auth/logout"><button class="btn btn-quiet" type="submit">${t('Sign out')}</button></form>
  </div>
</div>`,
    { title: t('Waiting for approval'), siteName, user: null },
  );
}

/* ================================================================== *
 * Which hat?
 * ================================================================== */

/**
 * The chooser, shown to anyone who holds more than one standing.
 *
 * It is not a settings page and it is not permanent: choosing writes a
 * cookie, and the header offers this page again from every screen. The
 * one rule it follows is that the hats are the *real* ones — derived
 * from memberships, checked again on the way in — so there is nothing
 * here to choose that the chooser cannot actually give you.
 */
export function chooseHat(
  user: User,
  hats: Hat[],
  siteName: string,
  current?: string,
): string {
  setLang(user.lang);

  const card = (h: Hat) => {
    const isNow = h.id === current;
    const what =
      h.kind === 'admin'
        ? t('Manage every practice, and step into any of them.')
        : h.role === 'teacher'
          ? t('Your students, songs, lessons and schedule.')
          : t('Your songs, your recordings and your teacher’s notes.');
    const badge =
      h.kind === 'admin'
        ? t('Admin')
        : h.role === 'teacher'
          ? t('Teacher')
          : t('Student');
    return `<form method="post" action="/hats/choose" class="hat-form">
  <input type="hidden" name="to" value="${esc(h.id)}">
  <button class="hat${isNow ? ' is-now' : ''}" type="submit">
    <span class="hat-role">${esc(badge)}</span>
    <span class="hat-name">${h.kind === 'admin' ? esc(t('Every practice')) : titleWithScript(h.name, h.nameMl)}</span>
    <span class="hat-what">${esc(what)}</span>
    ${isNow ? `<span class="hat-now">${esc(t('Where you are now'))}</span>` : ''}
  </button>
</form>`;
  };

  return page(
    `<div style="max-width:640px;margin:6vh auto 0">
  <h1 style="text-align:center">${esc(t('Which hat today?'))}</h1>
  <p class="lede" style="margin:12px auto 28px;max-width:46ch;text-align:center">
    ${t('You hold more than one standing here. Pick the one you want to work in — you can change it any time from the menu beside your name.')}
  </p>
  <div class="hat-list">
    ${hats.map(card).join('')}
  </div>
  <p class="hint" style="text-align:center;margin-top:26px">
    ${t('Signed in as %s.', `<strong>${esc(user.email)}</strong>`)}
    <form method="post" action="/auth/logout" style="display:inline">
      <button class="btn btn-sm btn-quiet" type="submit">${esc(t('Sign out'))}</button>
    </form>
  </p>
</div>`,
    { title: t('Which hat today?'), siteName, user: null, bodyClass: 'narrow' },
  );
}

/* ================================================================== *
 * Teacher — students
 * ================================================================== */

export interface StudentRow extends ProjectPerson {
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
  visiting?: Visiting | null,
): string {
  setLang(user.lang);
  const pct = Math.min(100, (storage.bytes / (10 * 1024 ** 3)) * 100);

  const rows = students.length
    ? `<div class="rows">${students
        .map(
          (s) => `<a class="row" href="/t/s/${esc(s.id)}">
      ${avatar(s)}
      <div class="row-main">
        <div class="row-title">${esc(s.name)}${
          s.status !== 'active'
            ? ` <span class="pill ${STATUS_CLASS[s.status] ?? 'p-warn'}">${esc(t(STATUS_LABEL[s.status] ?? s.status))}</span>`
            : ''
        }</div>
        <div class="row-meta">
          <span>${esc(s.email)}</span>
          ${s.location ? `<span class="loc">${esc(s.location)}</span>` : ''}
          ${s.phone ? `<span class="loc">${esc(s.phone)}</span>` : ''}
          <span class="num">${s.song_count === 1 ? t('%s song', s.song_count) : t('%s songs', s.song_count)}</span>
          <span class="num">${s.rec_count === 1 ? t('%s recording', s.rec_count) : t('%s recordings', s.rec_count)}</span>
          <span>${t('last added %s', esc(relativeDate(s.last_activity)))}</span>
        </div>
      </div>
      <div class="row-actions"><span class="btn btn-sm">${t('Open')}</span></div>
    </a>`,
        )
        .join('')}</div>`
    : q
      ? `<div class="empty"><strong>${t('Nobody matches "%s"', esc(q))}</strong>
         ${t('Try part of a name, an email address, or where they live.')}</div>`
      : `<div class="empty"><strong>${t('No students yet')}</strong>
       ${t("Ask them to open this site and sign in with Google. They'll appear under Approvals, and you decide who gets in.")}</div>`;

  return page(
    `${flash(msg)}
<div class="page-head">
  <h1>${t('Students')}</h1>
  <p class="lede">${t('Everyone you teach. Open a student to assign songs and add recordings.')}</p>
</div>

<div class="listbar">
  ${searchBox('/t', q, t('Name, email, place or number…'))}
  ${
    filter.hiddenCount || filter.showAll
      ? `<form method="get" action="/t" class="showall">
      ${q ? `<input type="hidden" name="q" value="${esc(q)}">` : ''}
      <label>
        <input type="checkbox" name="all" value="1"${filter.showAll ? ' checked' : ''}
               onchange="this.form.submit()">
        ${t('Include paused, graduated and ended')}
        ${!filter.showAll ? `<span class="num">(${filter.hiddenCount})</span>` : ''}
      </label>
    </form>`
      : ''
  }
</div>

${
  pendingCount
    ? `<div class="flash" style="border-left-color:var(--brass);background:var(--brass-soft);color:var(--brass-ink)">
     ${
       pendingCount === 1
         ? t('%s person is waiting to be let in', pendingCount)
         : t('%s people are waiting to be let in', pendingCount)
     } ·
     <a href="/t/approvals" style="color:inherit;font-weight:600">${t('Review')}</a>
   </div>`
    : ''
}

${rows}

<div class="section-head"><h2>${t('Add a student')}</h2></div>
<div class="card">
  <p class="hint" style="margin-top:0;margin-bottom:14px">
    ${t("Add the Google address you have for them. They're approved the moment they first sign in, so there's no second step for you.")}
  </p>
  <form method="post" action="/t/students">
    <div class="field-row">
      <div class="field"><label for="ns-name">${t('Name')}</label>
        <input id="ns-name" name="name" type="text" required placeholder="Anjali Menon"></div>
      <div class="field"><label for="ns-email">${t('Google email')}</label>
        <input id="ns-email" name="email" type="email" required placeholder="anjali@gmail.com"></div>
    </div>
    <div class="field-row">
      <div class="field"><label for="ns-loc">${t('Where they are')} <span class="opt">${t('— optional')}</span></label>
        <input id="ns-loc" name="location" type="text" placeholder="Dubai, UAE"></div>
      <div class="field"><label for="ns-phone">${t('WhatsApp number')} <span class="opt">${t('— optional')}</span></label>
        <input id="ns-phone" name="phone" type="tel" inputmode="tel" placeholder="+91 98470 12345"></div>
      <div class="field"><label for="ns-tz">${t('Time zone')} <span class="opt">${t('— optional')}</span></label>
        <select id="ns-tz" name="time_zone">
          <option value="">${t('Set on their first sign-in')}</option>
          ${zoneOptions(null)}
        </select></div>
    </div>
    <div class="form-actions">
      <button class="btn btn-primary" type="submit">${t('Add student')}</button>
      <span class="hint">${t('Only the name and email are needed — the rest can wait.')}</span>
    </div>
  </form>
</div>

<div class="section-head"><h2>${t('Storage')}</h2></div>
<div class="card">
  <div class="meter-wrap">
    <div class="meter"><i style="width:${pct.toFixed(1)}%"></i></div>
    <span>${t('%s of 10 GB free tier used', `<strong class="num">${esc(fmtBytes(storage.bytes))}</strong>`)}</span>
  </div>
  <p class="hint" style="margin-top:10px">
    ${t('Beyond 10 GB it costs about 1.5 cents per gigabyte per month. Playback is always free.')}
  </p>
</div>`,
    { title: t('Students'), user, siteName, nav: 'students', visiting },
  );
}

export function teacherApprovals(
  user: User,
  pending: User[],
  siteName: string,
  msg?: string,
  visiting?: Visiting | null,
): string {
  setLang(user.lang);
  const rows = pending.length
    ? `<div class="rows">${pending
        .map(
          (p) => `<div class="row">
      ${avatar(p)}
      <div class="row-main">
        <div class="row-title">${esc(p.name)}</div>
        <div class="row-meta"><span>${esc(p.email)}</span><span>${t('signed in %s', esc(relativeDate(p.created_at)))}</span></div>
      </div>
      <div class="row-actions">
        <form method="post" action="/t/approvals/${esc(p.id)}" style="display:flex;gap:6px">
          <button class="btn btn-sm btn-primary" name="action" value="student">${t('Approve as student')}</button>
          <button class="btn btn-sm" name="action" value="teacher">${t('Make teacher')}</button>
          <button class="btn btn-sm btn-danger" name="action" value="reject">${t('Reject')}</button>
        </form>
      </div>
    </div>`,
        )
        .join('')}</div>`
    : `<div class="empty"><strong>${t('Nobody waiting')}</strong>
       ${t("When someone signs in with Google for the first time, they'll appear here.")}</div>`;

  return page(
    `${flash(msg)}
<div class="page-head">
  <h1>${t('Approvals')}</h1>
  <p class="lede">${t('Nobody sees a single recording until you approve them here.')}</p>
</div>
${rows}

<div class="section-head"><h2>${t('Invite someone by email')}</h2></div>
<div class="card">
  <p class="hint" style="margin-top:0;margin-bottom:14px">
    ${t("Add the Google address you have for a student and they'll be approved automatically the first time they sign in — no second step for you.")}
  </p>
  <form method="post" action="/t/invite">
    <div class="field-row">
      <div class="field"><label for="inv-name">${t('Name')}</label><input id="inv-name" name="name" type="text" required placeholder="Anjali Menon"></div>
      <div class="field"><label for="inv-email">${t('Google email')}</label><input id="inv-email" name="email" type="email" required placeholder="anjali@gmail.com"></div>
    </div>
    <button class="btn btn-primary" type="submit">${t('Add student')}</button>
  </form>
</div>`,
    { title: t('Approvals'), user, siteName, nav: 'approvals', visiting },
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
  visiting?: Visiting | null,
): string {
  setLang(user.lang);
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
           data-keep-open title="${esc(t('Move this group up'))}"${gi === 0 ? ' disabled' : ''}>&uarr;</button>
         <button class="btn btn-sm" type="submit" form="gmv-${esc(id)}" name="dir" value="down"
           data-keep-open title="${esc(t('Move this group down'))}"${
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
            ${s.raga ? `<span>${t('Raga %s', esc(s.raga))}</span>` : ''}
            ${s.taala ? `<span>${t('Taala %s', esc(s.taala))}</span>` : ''}
            ${s.composer ? `<span>${esc(s.composer)}</span>` : ''}
            <span class="num">${
              s.assigned_count === 1
                ? t('%s student', s.assigned_count)
                : t('%s students', s.assigned_count)
            }</span>
          </div>
        </div>
        <div class="row-actions">
          <span class="rec-order">
            <form method="post" action="/t/sections/${esc(s.id)}/move">
              <button class="btn btn-sm" name="dir" value="up" type="submit"
                title="${esc(t('Move up within this group'))}"${i === 0 ? ' disabled' : ''}>&uarr;</button></form>
            <form method="post" action="/t/sections/${esc(s.id)}/move">
              <button class="btn btn-sm" name="dir" value="down" type="submit"
                title="${esc(t('Move down within this group'))}"${
                  i === items.length - 1 ? ' disabled' : ''
                }>&darr;</button></form>
          </span>
          <a class="btn btn-sm btn-primary" href="/t/song/${esc(s.id)}">${t('Open')}</a>
          <form method="post" action="/t/sections/${esc(s.id)}/delete" onsubmit="return confirm('${t(
            'Delete %s? Every recording and note filed under it will be deleted too.',
            `&quot;${esc(s.title)}&quot;`,
          )}')">
            <button class="btn btn-sm btn-danger" type="submit">${t('Delete')}</button></form>
        </div>
      </div>`,
          )
          .join('')}</div>`
      : `<div class="empty">${t('Nothing in this group yet.')}</div>`
  }${
    id !== '__none'
      ? `<form method="post" action="/t/groups/${esc(id)}/delete" style="margin-top:14px"
           onsubmit="return confirm('${t('Delete this group? The songs in it stay, but lose their group.')}')">
           <button class="btn btn-sm btn-danger" type="submit">${t('Delete group')}</button></form>`
      : ''
  }`;

    return disclosure({
      key: `group:${id}`,
      cls: 'disc-group',
      open: openByDefault,
      title: `${esc(name)}${
        nameMl ? ` <span class="ml" style="font-weight:400;color:var(--ink-3)">${esc(nameMl)}</span>` : ''
      }`,
      meta: items.length === 1 ? t('%s song', items.length) : t('%s songs', items.length),
      body,
      before,
      actions,
    });
  };

  return page(
    `${flash(msg)}
<div class="page-head">
  <h1>${t('Songs')}</h1>
  <p class="lede">
    ${t('One shared list. Assigning a song to a student is a separate step, so the same song can sit at a different stage for each of them.')}
  </p>
</div>

${searchBox('/t/catalogue', q, t('Title, Malayalam, raga, taala or composer…'))}

${
  !sections.length && !q
    ? `<div class="card" style="margin-bottom:20px">
    <h3>${t('Start from the standard repertoire')}</h3>
    <p class="hint" style="margin:6px 0 12px">
      ${t('Loads the usual beginner-to-varnam course — sarali, janta, dhatu and sthayi varisai, alankarams, geethams, swarajatis and the Adi and Ata tala varnams, with raga, taala and composer filled in. Nothing is overwritten, and you can edit or delete any of it.')}
    </p>
    <form method="post" action="/t/catalogue/seed">
      <button class="btn btn-primary" type="submit">${t('Load starter catalogue')}</button>
    </form>
  </div>`
    : ''
}

<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr));margin-bottom:10px">
  <details class="panel">
    <summary>${t('Add a song')}</summary>
    <div class="panel-body">
      <form method="post" action="/t/sections">
        <div class="field">
          <label for="s-title">${t('Title')} <span class="opt">${t('— transliterated')}</span></label>
          <input id="s-title" name="title" type="text" required placeholder="Vatapi Ganapatim">
        </div>
        <div class="field">
          <label for="s-title-ml">${t('Title in Malayalam')} <span class="opt">${t('— optional')}</span></label>
          <input id="s-title-ml" name="title_ml" type="text" class="ml" lang="ml" placeholder="വാതാപി ഗണപതിം">
          <p class="hint">${t("Type or paste Malayalam here. Leave it blank if you'd rather not.")}</p>
        </div>
        <div class="field-row">
          <div class="field"><label for="s-raga">${t('Raga')}</label><input id="s-raga" name="raga" type="text" placeholder="Hamsadhwani"></div>
          <div class="field"><label for="s-taala">${t('Taala')}</label><input id="s-taala" name="taala" type="text" placeholder="Adi"></div>
        </div>
        <div class="field-row">
          <div class="field"><label for="s-composer">${t('Composer')}</label><input id="s-composer" name="composer" type="text" placeholder="Muthuswami Dikshitar"></div>
          <div class="field"><label for="s-group">${t('Group')}</label>
            <select id="s-group" name="group_id"><option value="">${t('— none —')}</option>${groupOptions}</select>
          </div>
        </div>
        <button class="btn btn-primary" type="submit">${t('Add song')}</button>
      </form>
    </div>
  </details>

  <details class="panel">
    <summary>${t('Add a group')}</summary>
    <div class="panel-body">
      <p class="hint" style="margin-top:0">
        ${t('Group songs however you actually teach — by stage, by raga, by whatever you call it.')}
      </p>
      <form method="post" action="/t/groups">
        <div class="field"><label for="g-name">${t('Group name')}</label>
          <input id="g-name" name="name" type="text" required placeholder="Sarali varisai"></div>
        <div class="field"><label for="g-name-ml">${t('In Malayalam')} <span class="opt">${t('— optional')}</span></label>
          <input id="g-name-ml" name="name_ml" type="text" class="ml" lang="ml"></div>
        <button class="btn btn-primary" type="submit">${t('Add group')}</button>
      </form>
    </div>
  </details>
</div>

${
  q
    ? sections.length
      ? `<div class="section-head"><div><h2>${
          sections.length === 1
            ? t('%s match for "%s"', sections.length, esc(q))
            : t('%s matches for "%s"', sections.length, esc(q))
        }</h2></div></div>
       <div class="rows">${sections
         .map(
           (s) => `<div class="row">
         <div class="row-main">
           <div class="row-title">${inlineTitle(s.title, s.title_ml)}</div>
           <div class="row-meta">
             ${s.raga ? `<span>${t('Raga %s', esc(s.raga))}</span>` : ''}
             ${s.taala ? `<span>${t('Taala %s', esc(s.taala))}</span>` : ''}
             ${s.composer ? `<span>${esc(s.composer)}</span>` : ''}
             <span class="num">${
               s.assigned_count === 1
                 ? t('%s student', s.assigned_count)
                 : t('%s students', s.assigned_count)
             }</span>
           </div>
         </div>
       </div>`,
         )
         .join('')}</div>`
      : `<div class="empty"><strong>${t('No songs match "%s"', esc(q))}</strong>
         ${t('Search covers the title in either script, plus raga, taala and composer.')}</div>`
    : `${groups.length + (byGroup.has('__none') ? 1 : 0) > 1 ? discloseAll(t('Open a group to see its songs.')) : ''}
${groups.map((g, gi) => groupBlock(g.id, g.name, g.name_ml, gi)).join('')}
${byGroup.has('__none') ? groupBlock('__none', t('Ungrouped'), null) : ''}`
}
${
  !groups.length && !sections.length
    ? `<div class="empty"><strong>${t('Nothing here yet')}</strong>
       ${t('Start by adding a group like "Sarali varisai", then put songs in it.')}</div>`
    : ''
}`,
    { title: t('Songs'), user, siteName, nav: 'catalogue', visiting },
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
  /** Teacher of THIS project — from the acting membership. */
  isTeacher?: boolean;
  /** Set when an admin is acting inside a practice they do not teach. */
  visiting?: Visiting | null;
}): string {
  setLang(opts.viewer.lang);
  const { viewer, student, section, recordings, notes, siteName, msg } = opts;
  const dictate = Boolean(opts.dictate);
  /* Which way the back link points. Not viewer.role — that is the dead
     global column, and a teacher of another project is a student here. */
  const isTeacher = Boolean(opts.isTeacher);
  const backHref = isTeacher ? `/t/s/${student.id}` : '/me/songs';
  const backLabel = isTeacher ? `← ${student.name}` : `← ${t('My songs')}`;

  const notesFor = (recId: string | null) =>
    notes.filter((n) => (recId === null ? !n.recording_id : n.recording_id === recId));

  const renderNote = (n: Note) => `<div class="note">
  <div class="note-meta">
    <span>${esc(fmtDate(n.created_at))}</span>
    ${
      isTeacher
        ? `<form method="post" action="/notes/${esc(n.id)}/delete">
             <button class="btn btn-sm btn-danger" type="submit" style="padding:2px 6px;font-size:11px">${t('Delete')}</button>
           </form>`
        : ''
    }
  </div>
  ${n.title ? `<p class="note-title">${esc(n.title)}</p>` : ''}
  ${n.body_ml ? `<p class="note-body ml">${esc(n.body_ml)}</p>` : ''}
  ${n.body ? `<p class="note-body${n.body_ml ? ' said-en' : ''}">${esc(n.body)}</p>` : ''}
  ${n.image_key ? `<img class="note-img" src="/img/${esc(n.id)}" alt="${esc(t('Note attachment'))}" loading="lazy">` : ''}
  <div class="note-tools">
    <a class="note-dl" href="/note/${esc(n.id)}/download">${t('Download note')}</a>
    ${n.image_key ? `<a class="note-dl" href="/img/${esc(n.id)}?download=1">${t('Download image')}</a>` : ''}
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
      ${esc(r.title || (r.kind === 'video' ? t('Video clip') : t('Recording')))}
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
        ? `<span class="locked-note">${t("%s can't hear this one.", esc(student.name.split(' ')[0]))}</span>
      <form method="post" action="/t/recordings/${esc(r.id)}/share">
        <input type="hidden" name="student_id" value="${esc(student.id)}">
        <input type="hidden" name="back" value="${esc(isTeacher ? `/t/s/${student.id}/${section.id}` : '/me/songs')}">
        <button class="btn btn-sm btn-primary" type="submit">${t('Unlock for %s', esc(student.name.split(' ')[0]))}</button>
      </form>`
        : `<span class="locked-note">${t("Your teacher hasn't shared this one with you yet.")}</span>`
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
          ${esc(r.title || (r.kind === 'video' ? t('Video clip') : t('Recording')))}
          ${r.part ? `<span class="part-tag">${esc(r.part)}</span>` : ''}
        </span>
        <span class="rec-meta">
          <span>${esc(fmtDate(r.created_at))}</span>
          <span>${esc(fmtDuration(r.duration_sec))}</span>
          <span>${esc(fmtBytes(r.size_bytes))}</span>
          ${r.source === 'recorded' ? `<span>${t('recorded in browser')}</span>` : ''}
        </span>
      </span>
      ${r.description ? `<span class="rec-sum-desc">${esc(r.description)}</span>` : ''}
    </span>
    ${
      isTeacher
        ? `<span class="rec-order">
      <button class="btn btn-sm" type="submit" form="mv-${esc(r.id)}" name="dir" value="up"
        data-keep-open title="${esc(t('Move up'))}"${idx === 0 ? ' disabled' : ''}>&uarr;</button>
      <button class="btn btn-sm" type="submit" form="mv-${esc(r.id)}" name="dir" value="down"
        data-keep-open title="${esc(t('Move down'))}"${idx === total - 1 ? ' disabled' : ''}>&darr;</button>
    </span>`
        : ''
    }
  </summary>
  <div class="rec-body">
  ${r.description ? `<p class="rec-desc">${esc(r.description)}</p>` : ''}
  ${media}
  <div class="controls">
    <div class="ctrl-group">
      <span class="ctrl-label">${t('Speed')}</span>
      <div class="speeds" data-speeds>
        <button type="button" data-rate="0.5">0.5&times;</button>
        <button type="button" data-rate="0.75">0.75&times;</button>
        <button type="button" data-rate="1" aria-pressed="true">1&times;</button>
        <button type="button" data-rate="1.25">1.25&times;</button>
      </div>
    </div>
    <div class="ctrl-group">
      <span class="ctrl-label">${t('Loop')}</span>
      <button type="button" class="btn btn-sm" data-loop>${t('Set A')}</button>
      <span class="loop-state" data-loop-state></span>
    </div>
    <div class="ctrl-group" style="margin-left:auto">
      <a class="btn btn-sm" href="/media/${esc(r.id)}?download=1">${t('Download')}</a>
      ${
        isTeacher
          ? `<form method="post" action="/t/recordings/${esc(r.id)}/unshare">
               <input type="hidden" name="student_id" value="${esc(student.id)}">
               <input type="hidden" name="back" value="/t/s/${esc(student.id)}/${esc(section.id)}">
               <button class="btn btn-sm" type="submit"
                 title="${t('Take this one back from %s', esc(student.name.split(' ')[0]))}">${t('Lock')}</button></form>
             <form method="post" action="/t/recordings/${esc(
               r.id,
             )}/delete" onsubmit="return confirm('${t('Delete this recording permanently?')}')">
               <button class="btn btn-sm btn-danger" type="submit">${t('Delete')}</button></form>`
          : ''
      }
    </div>
  </div>
  ${attached.length ? `<div style="margin-top:13px">${attached.map(renderNote).join('')}</div>` : ''}
  ${
    isTeacher
      ? `<details class="panel" style="margin-top:12px;border:none;background:transparent">
      <summary style="padding:6px 0;font-size:13px;color:var(--ink-3)">${t('Add a note on this recording')}</summary>
      <div class="panel-body" style="padding:10px 0 0;border-top:1px solid var(--line)">
        <form method="post" action="/t/notes" enctype="multipart/form-data">
          <input type="hidden" name="section_id" value="${esc(section.id)}">
          <input type="hidden" name="student_id" value="${esc(student.id)}">
          <input type="hidden" name="recording_id" value="${esc(r.id)}">
          <div class="field"><textarea name="body" rows="2" placeholder="${esc(t('Watch the gamaka at 0:42 — it should be slower.'))}"></textarea></div>
          <div class="field"><label>${t('Screenshot')} <span class="opt">${t('— optional')}</span></label>
            <input type="file" name="image" accept="image/*"></div>
          <button class="btn btn-sm btn-primary" type="submit">${t('Save note')}</button>
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
    <span class="addrec-t">${t('Add a recording')}</span>
    <span class="addrec-s">${t('record in the browser, or drop in files')}</span>
  </summary>
  <div class="panel-body">
  <div class="tabs" role="tablist">
    <button role="tab" aria-selected="true" data-tab="record">${t('Record now')}</button>
    <button role="tab" aria-selected="false" data-tab="upload">${t('Upload files')}</button>
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
        <button class="btn btn-primary" type="button" data-start>${t('Start recording')}</button>
        <button class="btn" type="button" data-stop disabled>${t('Stop')}</button>
        <label style="display:flex;align-items:center;gap:7px;margin:0 0 0 6px;font-size:13.5px;font-weight:500;color:var(--ink-2)">
          <input type="checkbox" data-video style="width:auto"> ${t('Record video instead')}
        </label>
      </div>
      <p class="rec-status" data-status>${t('Audio is saved as MP3 so it plays on every phone, including older iPhones.')}</p>
      <div data-preview hidden style="margin-top:14px;padding-top:16px;border-top:1px solid var(--line)">
        <div data-player></div>
        <div class="field" style="margin-top:12px">
          <label for="rec-title">${t('Name this take')}</label>
          <input id="rec-title" type="text" data-title placeholder="${esc(t('Pallavi, slow'))}">
        </div>
        <div class="btn-row">
          <button class="btn btn-primary" type="button" data-save>${t('Save recording')}</button>
          <button class="btn btn-quiet" type="button" data-discard>${t('Discard')}</button>
        </div>
        <div class="progress" data-progress><div class="progress-fill" data-progress-fill></div></div>
      </div>
    </div>
  </div>

  <div data-panel="upload" hidden>
    <div class="dropzone" data-drop
         data-student="${esc(student.id)}" data-section="${esc(section.id)}">
      <strong>${t('Drop audio or video here')}</strong>
      ${t('or click to choose files — MP3, M4A, WAV, MP4 and MOV all work')}
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
      section.raga ? t('Raga %s', esc(section.raga)) : '',
      section.taala ? t('Taala %s', esc(section.taala)) : '',
      section.composer ? esc(section.composer) : '',
      isTeacher ? t('for %s', esc(student.name)) : '',
    ]
      .filter(Boolean)
      .join(' · ')}
  </p>
</div>

${
  generalNotes.length
    ? `<div class="section-head"><h2>${t('Notes')}</h2></div>${generalNotes.map(renderNote).join('')}`
    : ''
}

<div class="section-head">
  <div><h2>${t('Recordings')}</h2>
    ${
      locked.length
        ? `<p class="lede">${
            isTeacher
              ? t(
                  '%s to practise, and %s not yet given to %s.',
                  open.length,
                  locked.length,
                  esc(student.name.split(' ')[0]),
                )
              : t("%s to practise, and %s your teacher hasn't shared yet.", open.length, locked.length)
          }</p>`
        : ''
    }</div>
</div>
${open.length > 2 ? discloseAll(t('Your browser remembers what you leave open.')) : ''}
${
  open.length
    ? open.map((r, i) => renderRec(r, i)).join('')
    : `<div class="empty"><strong>${t('Nothing to play yet')}</strong>${
        isTeacher
          ? t('Record a take below, or unlock one of the others.')
          : locked.length
            ? t("Your teacher hasn't shared any of these with you yet.")
            : t("Your teacher hasn't added a recording for this song yet.")
      }</div>`
}

${
  locked.length
    ? `<div class="section-head" style="margin-top:26px">
    <div><h3>${
      isTeacher ? t('Not shared with them') : t('Not yet shared with you')
    }</h3>
      <p class="lede">${
        isTeacher
          ? t('These exist on the song but are not for this student — yet.')
          : t('These takes exist for this song. Ask your teacher if you need one.')
      }</p></div>
  </div>
  ${locked.map(renderLocked).join('')}`
    : ''
}

${recorderBlock}

${
  isTeacher
    ? `<details class="panel" style="margin-top:14px">
  <summary>${t('Add a note for this song')}</summary>
  <div class="panel-body">
    <form method="post" action="/t/notes" enctype="multipart/form-data">
      <input type="hidden" name="section_id" value="${esc(section.id)}">
      <input type="hidden" name="student_id" value="${esc(student.id)}">
      ${spoken({
        id: 'note-body',
        name: 'body',
        label: t('Note'),
        placeholder: t('Sing the second sangati only after the first is steady.'),
        en: '',
        ml: '',
        dictate,
      })}
      <div class="field">
        <label for="note-img">${t('Screenshot or photo of notation')} <span class="opt">${t('— optional')}</span></label>
        <input id="note-img" name="image" type="file" accept="image/*">
        <p class="hint">${t('You can also paste an image straight into the note box.')}</p>
      </div>
      <button class="btn btn-primary" type="submit">${t('Save note')}</button>
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
      visiting: opts.visiting ?? null,
      scripts: isTeacher
        ? dictate
          ? ['/player.js', '/recorder.js', '/dictate.js']
          : ['/player.js', '/recorder.js']
        : ['/player.js'],
    },
  );
}

export function notFound(user: User | null, siteName: string): string {
  setLang(user?.lang);
  return page(
    `<div style="max-width:460px;margin:8vh auto 0;text-align:center">
  <h1>${t('Not here')}</h1>
  <p class="lede" style="margin:12px auto 24px">
    ${t("That page doesn't exist, or it isn't yours to open.")}
  </p>
  <a class="btn" href="/">${t('Go back')}</a>
</div>`,
    { title: t('Not found'), user, siteName },
  );
}
