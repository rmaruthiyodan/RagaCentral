/* ==================================================================
 * The admin's screens — above every project, looking down.
 *
 * Two pages and nothing more: a list of practices, and one practice.
 * Everything else an admin might want to do, they do by switching into
 * a project and using the teacher's own screens, which is why there is
 * no third page here duplicating them.
 *
 * Deliberately plainer than the teaching screens. This is a back
 * office: it is read rarely, by one person who already knows what
 * everything means, and it should not look like the app a student sees.
 * ================================================================== */

import { page, avatar, disclosure } from './layout';
import { esc, escConfirm, fmtDate, fmtBytes, relativeDate } from '../util';
import { t, setLang } from '../i18n';
import type { User } from '../types';
import type { Project, AdminLogRow } from '../projects';
import type { DriveLink, BackupRun } from '../backup';

/** A project with the numbers worth seeing without opening it. */
export interface ProjectSummary extends Project {
  teacher_names: string | null;
  student_count: number;
  song_count: number;
  recording_count: number;
  bytes: number;
  last_activity: string | null;
}

/**
 * Somebody who signed in and belongs to no practice.
 *
 * They are invisible to every teacher — the approvals page joins
 * project_members, and these people have no membership to join to — so
 * this is the only screen in the app where they appear at all.
 */
export interface Stranded {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  created_at: string;
  turned_away_at: string | null;
}

/**
 * Sent to a practice, waiting for its teacher to answer.
 *
 * Pending memberships are per-project by design — one teacher must not
 * see another's queue — which means nobody at all could see them across
 * practices. An admin looking for "the new student who signed up" had
 * nowhere to look: not the teacher's approvals page, which only shows
 * the practice they happen to be acting in, and not here. This is that
 * missing view.
 */
export interface AwaitingRow {
  user_id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  project_id: string;
  project_name: string;
  joined_at: string;
  role: string;
}

/** One person's place in a project, as the admin sees it. */
export interface MemberRow {
  user_id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  role: 'teacher' | 'student';
  status: string;
  joined_at: string;
}

const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  pending: 'Waiting for approval',
  paused: 'Paused',
  graduated: 'Graduated',
  ended: 'Ended',
  disabled: 'Declined',
};


/**
 * People a teacher has been asked about and has not answered.
 *
 * The one screen in the app that looks across every practice's queue at
 * once, and the reason it exists: a pending membership belongs to one
 * project, the teacher's approvals page shows only the project they are
 * currently acting in, and so somebody who signs up and is waiting can
 * be invisible to everyone — including the admin, who is usually the
 * person being asked where they went.
 */
function awaitingBlock(awaiting: AwaitingRow[], projects: ProjectSummary[]): string {
  if (!awaiting.length) return '';
  const open = projects.filter((p) => p.status === 'active');

  const row = (a: AwaitingRow) => `<div class="row place-row">
    ${avatar(a)}
    <div class="row-main">
      <div class="row-title">${esc(a.name)}</div>
      <div class="row-meta">
        <span>${esc(a.email)}</span>
        <span>${esc(t('for %s', a.project_name))}</span>
        <span>${esc(t('asked %s', relativeDate(a.joined_at)))}</span>
      </div>
    </div>
    <div class="row-actions">
      <form method="post" action="/admin/switch/${esc(a.project_id)}">
        <input type="hidden" name="to" value="/t/approvals">
        <button class="btn btn-sm btn-primary" type="submit">${esc(t('Open approvals'))}</button>
      </form>
      ${
        open.length > 1
          ? `<form method="post" action="/admin/move" class="place-form">
               <input type="hidden" name="user_id" value="${esc(a.user_id)}">
               <select name="project_id" aria-label="${esc(t('Practice'))}">
                 ${open
                   .filter((p) => p.id !== a.project_id)
                   .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
                   .join('')}
               </select>
               <button class="btn btn-sm" type="submit">${esc(t('Move'))}</button>
             </form>`
          : ''
      }
    </div>
  </div>`;

  return `<div class="section-head">
    <div><h2>${esc(
      awaiting.length === 1
        ? t('1 person is waiting for a teacher')
        : t('%s people are waiting for a teacher', awaiting.length),
    )}</h2>
      <p class="lede">${t(
        'Sent to a practice and not yet answered. Only that practice’s teacher sees them on their own Approvals page, so this is the only place they can all be seen at once.',
      )}</p>
    </div>
  </div>
  <div class="rows">${awaiting.map(row).join('')}</div>`;
}

/**
 * The people nobody can see but the admin.
 *
 * Put at the top of the page and not behind a link, because the whole
 * failure this fixes is that nothing anywhere said these people were
 * waiting. A list you have to remember to go and look at is the same
 * bug with an extra click.
 */
function waitingBlock(
  waiting: Stranded[],
  projects: ProjectSummary[],
  showTurnedAway: boolean,
): string {
  const open = projects.filter((p) => p.status === 'active');
  const here = waiting.filter((w) => !w.turned_away_at);
  const aside = waiting.filter((w) => w.turned_away_at);

  if (!here.length && !aside.length) return '';

  const options = open
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
    .join('');

  const row = (w: Stranded) => `<div class="row place-row">
    ${avatar(w)}
    <div class="row-main">
      <div class="row-title">${esc(w.name)}</div>
      <div class="row-meta">
        <span>${esc(w.email)}</span>
        <span>${esc(t('signed in %s', relativeDate(w.created_at)))}</span>
      </div>
    </div>
    <div class="row-actions">
      ${
        open.length
          ? `<form method="post" action="/admin/place" class="place-form">
               <input type="hidden" name="user_id" value="${esc(w.id)}">
               <label class="sr-only" for="p-${esc(w.id)}">${esc(t('Practice'))}</label>
               <select id="p-${esc(w.id)}" name="project_id">${options}</select>
               <label class="sr-only" for="r-${esc(w.id)}">${esc(t('Role'))}</label>
               <select id="r-${esc(w.id)}" name="role">
                 <option value="student">${esc(t('Student'))}</option>
                 <option value="teacher">${esc(t('Teacher'))}</option>
               </select>
               <button class="btn btn-sm btn-primary" type="submit">${esc(t('Add them'))}</button>
             </form>`
          : `<span class="local-unknown">${esc(t('make a practice first'))}</span>`
      }
      <form method="post" action="/admin/turn-away">
        <input type="hidden" name="user_id" value="${esc(w.id)}">
        <button class="btn btn-sm btn-quiet" type="submit">${esc(t('Not ours'))}</button>
      </form>
    </div>
  </div>`;

  const asideRow = (w: Stranded) => `<div class="row is-dim">
    <div class="row-main">
      <div class="row-title">${esc(w.name)}</div>
      <div class="row-meta"><span>${esc(w.email)}</span>
        <span>${esc(t('set aside %s', relativeDate(w.turned_away_at ?? '')))}</span></div>
    </div>
    <div class="row-actions">
      <form method="post" action="/admin/allow-again">
        <input type="hidden" name="user_id" value="${esc(w.id)}">
        <button class="btn btn-sm" type="submit">${esc(t('Put back'))}</button>
      </form>
    </div>
  </div>`;

  return `${
    here.length
      ? `<div class="section-head">
           <div><h2>${esc(
             here.length === 1 ? t('1 person is waiting') : t('%s people are waiting', here.length),
           )}</h2>
             <p class="lede">${t(
               'They signed in and belong to no practice yet, so no teacher can see them. Put them where they belong.',
             )}</p>
           </div>
         </div>
         <div class="rows">${here.map(row).join('')}</div>`
      : ''
  }
${
  aside.length && showTurnedAway
    ? `<div class="section-head" style="margin-top:18px">
         <div><h2>${esc(t('Set aside'))}</h2></div>
         <a class="btn btn-sm" href="/admin">${esc(t('Hide these'))}</a>
       </div>
       <div class="rows">${aside.map(asideRow).join('')}</div>`
    : aside.length
      ? `<p class="hint" style="margin:8px 0 18px">
           ${t('%s set aside.', aside.length)}
           <a href="/admin?aside=1">${esc(t('Show them'))}</a>
         </p>`
      : ''
}`;
}

/* ------------------------------------------------------------------ *
 * Every practice
 * ------------------------------------------------------------------ */

export function adminHome(
  user: User,
  projects: ProjectSummary[],
  waiting: Stranded[],
  awaiting: AwaitingRow[],
  siteName: string,
  msg?: string,
  showTurnedAway = false,
): string {
  setLang(user.lang);

  const row = (p: ProjectSummary) => {
    const teachers = (p.teacher_names || '').trim();
    return `<div class="row${p.status === 'archived' ? ' is-dim' : ''}">
    <div class="row-main">
      <div class="row-title">
        <a href="/admin/p/${esc(p.id)}">${esc(p.name)}</a>
        ${p.name_ml ? `<span class="ml">· ${esc(p.name_ml)}</span>` : ''}
        ${p.status === 'archived' ? `<span class="pill p-warn">${esc(t('archived'))}</span>` : ''}
      </div>
      <div class="row-meta">
        <span>${teachers ? esc(teachers) : `<span class="local-unknown">${esc(t('no teacher yet'))}</span>`}</span>
        <span>${esc(p.student_count === 1 ? t('%s student', 1) : t('%s students', p.student_count))}</span>
        <span>${esc(p.song_count === 1 ? t('%s song', 1) : t('%s songs', p.song_count))}</span>
        <span>${esc(
          p.recording_count === 1 ? t('%s recording', 1) : t('%s recordings', p.recording_count),
        )}</span>
        <span>${esc(fmtBytes(p.bytes))}</span>
        ${
          p.last_activity
            ? `<span>${esc(t('last added %s', relativeDate(p.last_activity)))}</span>`
            : ''
        }
      </div>
    </div>
    <div class="row-actions">
      ${
        p.status === 'active'
          ? `<form method="post" action="/admin/switch/${esc(p.id)}">
               <button class="btn btn-sm btn-primary" type="submit">${esc(t('Teach it'))}</button>
             </form>`
          : ''
      }
      <a class="btn btn-sm" href="/admin/p/${esc(p.id)}">${esc(t('Manage'))}</a>
    </div>
  </div>`;
  };

  const active = projects.filter((p) => p.status === 'active');
  const archived = projects.filter((p) => p.status !== 'active');

  return page(
    `${msg ? `<div class="flash">${esc(msg)}</div>` : ''}

${awaitingBlock(awaiting, projects)}
${waitingBlock(waiting, projects, showTurnedAway)}

<div class="section-head">
  <div>
    <h1>${esc(t('Practices'))}</h1>
    <p class="lede">${esc(
      t('One project is one teacher and the students they teach. Nothing crosses between them.'),
    )}</p>
  </div>
  <a class="btn btn-sm" href="/admin/backup">${esc(t('Backup'))}</a>
</div>

${
  active.length
    ? `<div class="rows">${active.map(row).join('')}</div>`
    : `<div class="empty"><strong>${esc(t('No practices yet'))}</strong>
       ${esc(t('Add one below, then add the teacher who runs it.'))}</div>`
}

${
  archived.length
    ? `<div class="section-head" style="margin-top:22px"><h2>${esc(t('Archived'))}</h2>
     <p class="lede">${esc(
       t('Nothing is deleted. An archived practice is hidden and cannot be entered, and can be brought back.'),
     )}</p></div>
   <div class="rows">${archived.map(row).join('')}</div>`
    : ''
}

<details class="panel" style="margin-top:18px">
  <summary>${esc(t('Add a practice'))}</summary>
  <div class="panel-body">
    <form method="post" action="/admin/projects">
      <div class="field">
        <label for="p-name">${esc(t('Name'))}</label>
        <input id="p-name" name="name" type="text" required placeholder="RP Sajeev Music">
      </div>
      <div class="field">
        <label for="p-name-ml">${esc(t('Title in Malayalam'))}
          <span class="opt">— ${esc(t('optional'))}</span></label>
        <input id="p-name-ml" name="name_ml" type="text" lang="ml">
      </div>
      <div class="field">
        <label for="p-note">${esc(t('Note'))} <span class="opt">— ${esc(t('optional'))}</span></label>
        <input id="p-note" name="note" type="text"
               placeholder="${esc(t('Anything you want to remember about this practice'))}">
      </div>
      <button class="btn btn-primary" type="submit">${esc(t('Add a practice'))}</button>
    </form>
  </div>
</details>`,
    { title: t('Practices'), user, siteName, nav: null, hideNav: true, bodyClass: 'narrow' },
  );
}

/* ------------------------------------------------------------------ *
 * One practice
 * ------------------------------------------------------------------ */

export function adminProject(
  user: User,
  p: ProjectSummary,
  members: MemberRow[],
  log: AdminLogRow[],
  siteName: string,
  msg?: string,
): string {
  setLang(user.lang);

  const teachers = members.filter((m) => m.role === 'teacher');
  const students = members.filter((m) => m.role === 'student');

  const memberRow = (m: MemberRow) => `<div class="row">
  <div class="row-main">
    <div class="row-title">${avatar(m)} ${esc(m.name)}</div>
    <div class="row-meta">
      <span>${esc(m.email)}</span>
      <span>${esc(t(STATUS_LABEL[m.status] ?? m.status))}</span>
      <span>${esc(t('joined %s', fmtDate(m.joined_at)))}</span>
    </div>
  </div>
  <div class="row-actions">
    <form method="post" action="/admin/p/${esc(p.id)}/members/${esc(m.user_id)}/remove"
          onsubmit="return confirm('${escConfirm(
            t('Take %s out of this practice? Their recordings and lessons stay.', m.name),
          )}')">
      <button class="btn btn-sm btn-danger" type="submit">${esc(t('Remove'))}</button>
    </form>
  </div>
</div>`;

  const addForm = (role: 'teacher' | 'student') => `<form method="post"
      action="/admin/p/${esc(p.id)}/members">
  <input type="hidden" name="role" value="${role}">
  <div class="field">
    <label for="add-${role}">${esc(t('Google email'))}</label>
    <input id="add-${role}" name="email" type="email" required
           placeholder="${role === 'teacher' ? 'sajeev@gmail.com' : 'anjali@gmail.com'}">
    <p class="hint">${esc(
      t('They are in as soon as they sign in with that address. No second step.'),
    )}</p>
  </div>
  <button class="btn btn-sm btn-primary" type="submit">${esc(
    role === 'teacher' ? t('Add teacher') : t('Add student'),
  )}</button>
</form>`;

  return page(
    `${msg ? `<div class="flash">${esc(msg)}</div>` : ''}

<p class="crumb"><a href="/admin">← ${esc(t('Practices'))}</a></p>

<div class="section-head">
  <div>
    <h1>${esc(p.name)}${p.name_ml ? ` <span class="ml">${esc(p.name_ml)}</span>` : ''}</h1>
    <p class="lede">
      ${esc(t('%s students', p.student_count))} ·
      ${esc(t('%s songs', p.song_count))} ·
      ${esc(t('%s recordings', p.recording_count))} ·
      ${esc(fmtBytes(p.bytes))}
      ${p.note ? `<br>${esc(p.note)}` : ''}
    </p>
  </div>
  <div class="row-actions">
    ${
      p.status === 'active'
        ? `<form method="post" action="/admin/switch/${esc(p.id)}">
             <button class="btn btn-primary" type="submit">${esc(t('Teach it'))}</button>
           </form>`
        : `<span class="pill p-warn">${esc(t('archived'))}</span>`
    }
  </div>
</div>

${
  !teachers.length && p.status === 'active'
    ? `<div class="empty" style="margin-bottom:14px"><strong>${esc(
        t('This practice has no teacher'),
      )}</strong> ${esc(
        t('Add their Google address below. Until then only you can see inside it.'),
      )}</div>`
    : ''
}

${disclosure({
  key: `adm:teachers:${p.id}`,
  title: esc(t('Teachers')),
  meta: `<span class="row-meta">${esc(
    teachers.length === 1 ? t('%s person', 1) : t('%s people', teachers.length),
  )}</span>`,
  open: true,
  body: `${
    teachers.length
      ? `<div class="rows">${teachers.map(memberRow).join('')}</div>`
      : `<div class="empty">${esc(t('Nobody teaches here yet.'))}</div>`
  }
  <div class="panel-body" style="padding-top:12px">${addForm('teacher')}</div>`,
})}

${disclosure({
  key: `adm:students:${p.id}`,
  title: esc(t('Students')),
  meta: `<span class="row-meta">${esc(
    students.length === 1 ? t('%s person', 1) : t('%s people', students.length),
  )}</span>`,
  body: `${
    students.length
      ? `<div class="rows">${students.map(memberRow).join('')}</div>`
      : `<div class="empty">${esc(t('No students here yet.'))}</div>`
  }
  <div class="panel-body" style="padding-top:12px">${addForm('student')}</div>`,
})}

${disclosure({
  key: `adm:log:${p.id}`,
  title: esc(t('What an admin changed here')),
  meta: `<span class="row-meta">${esc(
    log.length === 1 ? t('%s entry', 1) : t('%s entries', log.length),
  )}</span>`,
  body: log.length
    ? `<div class="rows">${log
        .map(
          (l) => `<div class="row"><div class="row-main">
            <div class="row-title">${esc(l.detail || l.action)}</div>
            <div class="row-meta">
              <span>${esc(l.actor_name || t('an admin'))}</span>
              <span>${esc(fmtDate(l.at))}</span>
              <span>${esc(relativeDate(l.at))}</span>
            </div></div></div>`,
        )
        .join('')}</div>`
    : `<div class="empty">${esc(
        t('Nothing. A teacher working in their own practice is not recorded here — only an admin acting inside it.'),
      )}</div>`,
})}

<details class="panel" style="margin-top:18px">
  <summary>${esc(t('Rename, or write a note'))}</summary>
  <div class="panel-body">
    <form method="post" action="/admin/p/${esc(p.id)}">
      <div class="field">
        <label for="e-name">${esc(t('Name'))}</label>
        <input id="e-name" name="name" type="text" required value="${esc(p.name)}">
      </div>
      <div class="field">
        <label for="e-name-ml">${esc(t('Title in Malayalam'))}</label>
        <input id="e-name-ml" name="name_ml" type="text" lang="ml" value="${esc(p.name_ml ?? '')}">
      </div>
      <div class="field">
        <label for="e-note">${esc(t('Note'))}</label>
        <input id="e-note" name="note" type="text" value="${esc(p.note ?? '')}">
      </div>
      <div class="btn-row"><button class="btn btn-primary" type="submit">${esc(
        t('Save changes'),
      )}</button></div>
    </form>

    <form method="post" action="/admin/p/${esc(p.id)}/archive" style="margin-top:14px"
          onsubmit="return confirm('${esc(
            p.status === 'active'
              ? t('Archive this practice? Nothing is deleted and it can be brought back.')
              : t('Bring this practice back?'),
          )}')">
      <button class="btn btn-sm ${p.status === 'active' ? 'btn-danger' : ''}" type="submit">${esc(
        p.status === 'active' ? t('Archive this practice') : t('Bring it back'),
      )}</button>
      <p class="hint">${esc(
        t('Archiving hides a practice and stops anyone entering it. Recordings, lessons and students are untouched.'),
      )}</p>
    </form>
  </div>
</details>`,
    { title: p.name, user, siteName, nav: null, hideNav: true, bodyClass: 'narrow' },
  );
}

/* ------------------------------------------------------------------ *
 * Backing up into Google Drive
 * ------------------------------------------------------------------ */

/**
 * The backup page.
 *
 * Three things, in the order somebody actually needs them: is this set
 * up, a button, and what happened last time. The settings check is
 * first and not hidden, because "nothing happens when I press it" is
 * the failure this page exists to prevent.
 */
export function adminBackup(
  user: User,
  link: DriveLink | null,
  runs: BackupRun[],
  cf: { accountId: boolean; databaseId: boolean; apiToken: boolean },
  siteName: string,
  msg?: string,
  err?: string,
): string {
  setLang(user.lang);

  const ready = cf.accountId && cf.databaseId && cf.apiToken;
  const missing = [
    cf.accountId ? null : 'CF_ACCOUNT_ID',
    cf.databaseId ? null : 'D1_DATABASE_ID',
    cf.apiToken ? null : 'CF_API_TOKEN',
  ].filter(Boolean) as string[];

  const runRow = (r: BackupRun) => `<div class="row">
    <div class="row-main">
      <div class="row-title">${esc(fmtDate(r.started_at))}
        ${
          r.status === 'done'
            ? `<span class="pill p-good">${esc(t('saved'))}</span>`
            : `<span class="pill p-bad">${esc(t('failed'))}</span>`
        }</div>
      <div class="row-meta">
        ${r.file_name ? `<span>${esc(r.file_name)}</span>` : ''}
        ${r.bytes ? `<span>${esc(fmtBytes(r.bytes))}</span>` : ''}
        ${r.detail ? `<span>${esc(r.detail)}</span>` : ''}
      </div>
    </div>
  </div>`;

  return page(
    `${msg ? `<div class="flash">${esc(msg)}</div>` : ''}
${err ? `<div class="flash err">${esc(err)}</div>` : ''}
<a class="crumb" href="/admin">← ${esc(t('Every practice'))}</a>
<div class="page-head">
  <h1>${esc(t('Backup'))}</h1>
  <p class="lede">${t(
    'A copy of the database, in a Google Drive you choose. The recordings are not included — they are backed up separately; see BACKUP.md.',
  )}</p>
</div>

<div class="section-head"><h2>${esc(t('Google Drive'))}</h2></div>
<div class="panel"><div class="panel-body">
${
  link
    ? `<p>${t(
        'Connected%s, since %s.',
        link.account_email ? ` — <strong>${esc(link.account_email)}</strong>` : '',
        esc(fmtDate(link.connected_at)),
      )}</p>
       <p class="hint">${t(
         'This site can only see the files it puts there. It cannot read anything else in that Drive.',
       )}</p>
       <div class="btn-row" style="margin-top:12px">
         <form method="post" action="/admin/backup/run">
           <button class="btn btn-primary" type="submit"${ready ? '' : ' disabled'}>${esc(
             t('Back up now'),
           )}</button>
         </form>
         <form method="post" action="/admin/backup/check">
           <button class="btn" type="submit">${esc(t('Test the connection'))}</button>
         </form>
         <form method="post" action="/admin/drive/disconnect">
           <button class="btn btn-quiet" type="submit">${esc(t('Disconnect'))}</button>
         </form>
       </div>`
    : `<p>${t('No Drive is connected yet.')}</p>
       <p class="hint">${t(
         'You will be asked to allow this site to add files to your Drive. It is only ever able to see the files it creates there.',
       )}</p>
       <form method="post" action="/admin/drive/connect" style="margin-top:12px">
         <button class="btn btn-primary" type="submit">${esc(t('Connect Google Drive'))}</button>
       </form>`
}
</div></div>

${
  ready
    ? ''
    : `<div class="empty" style="margin-top:14px"><strong>${esc(
        t('Cloudflare is not configured yet'),
      )}</strong>
       ${t(
         'The dump is made by Cloudflare rather than by this site, which needs %s. Until they are set, the button stays off.',
         `<code>${missing.map(esc).join('</code>, <code>')}</code>`,
       )}</div>`
}

<div class="section-head"><h2>${esc(t('Last few'))}</h2></div>
${
  runs.length
    ? `<div class="rows">${runs.map(runRow).join('')}</div>`
    : `<div class="empty">${esc(t('Nothing has been backed up from here yet.'))}</div>`
}`,
    { title: t('Backup'), user, siteName, nav: null, hideNav: true, bodyClass: 'narrow' },
  );
}
