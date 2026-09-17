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
import { esc, fmtDate, fmtBytes, relativeDate } from '../util';
import { t, setLang } from '../i18n';
import type { User } from '../types';
import type { Project, AdminLogRow } from '../projects';

/** A project with the numbers worth seeing without opening it. */
export interface ProjectSummary extends Project {
  teacher_names: string | null;
  student_count: number;
  song_count: number;
  recording_count: number;
  bytes: number;
  last_activity: string | null;
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

/* ------------------------------------------------------------------ *
 * Every practice
 * ------------------------------------------------------------------ */

export function adminHome(
  user: User,
  projects: ProjectSummary[],
  siteName: string,
  msg?: string,
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
               <button class="btn btn-sm btn-primary" type="submit">${esc(t('Go in'))}</button>
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

<div class="section-head">
  <div>
    <h1>${esc(t('Practices'))}</h1>
    <p class="lede">${esc(
      t('One project is one teacher and the students they teach. Nothing crosses between them.'),
    )}</p>
  </div>
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
    { title: t('Practices'), user, siteName, nav: null, bodyClass: 'narrow' },
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
          onsubmit="return confirm('${esc(
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
             <button class="btn btn-primary" type="submit">${esc(t('Go in'))}</button>
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
    { title: p.name, user, siteName, nav: null, bodyClass: 'narrow' },
  );
}
