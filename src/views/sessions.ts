/* ==================================================================
 * The lesson log
 *
 * A session is one dated class with one student. Its most valuable
 * field by far is `left_off` — the resume point — so that gets pinned
 * to the top of the page rather than buried in a history list.
 * Students see all of it.
 * ================================================================== */

import { esc, fmtDate, relativeDate } from '../util';
import type { SessionRow, AssignedRow } from '../types';

/** Separator used by group_concat in the session queries. */
export const SEP = ' ~|~ ';

function songChips(titles: string | null): string {
  if (!titles) return '';
  const list = titles.split(SEP).filter(Boolean);
  if (!list.length) return '';
  return `<div class="resume-chips">${list
    .map((t) => `<span class="chip">${esc(t)}</span>`)
    .join('')}</div>`;
}

/* ------------------------------------------------------------------ *
 * Reading a note back.
 *
 * His words first, in Malayalam, then the English under them — the same
 * order a song title uses. When there is only one of the two, show that
 * one and no label; a lone "English" tag over the only text there is
 * would be noise.
 * ------------------------------------------------------------------ */
function bilingual(ml: string | null | undefined, en: string | null | undefined): string {
  const m = ml?.trim();
  const e = en?.trim();
  if (!m) return e ? `<p>${esc(e)}</p>` : '';
  if (!e) return `<p class="ml">${esc(m)}</p>`;
  return `<p class="ml">${esc(m)}</p><p class="said-en">${esc(e)}</p>`;
}

/**
 * The one thing the teacher should see first: where the last lesson stopped.
 *
 * `logHref` is where "Log the next lesson" goes. It used to be a bare
 * "#log", which works on the Past classes tab where the form lives and
 * does nothing at all on Overview, where the card is most often read —
 * the anchor pointed at an id that isn't on the page.
 */
export function resumeCard(
  latest: SessionRow | null,
  o: { isTeacher: boolean; firstName: string; logHref?: string },
): string {
  const logHref = o.logHref || '#log';
  if (!latest) {
    return o.isTeacher
      ? `<div class="empty" style="margin-bottom:6px"><strong>No lessons logged yet</strong>
         After your next class with ${esc(o.firstName)}, write down what you covered and where you
         stopped. It shows up here, so you can pick straight up next time.</div>`
      : '';
  }

  const ongoing = latest.status === 'ongoing';
  const stopped = (latest.left_off_ml || latest.left_off || '').trim();
  const next = bilingual(latest.next_focus_ml, latest.next_focus);

  return `<div class="resume">
  <div class="resume-eyebrow">
    <span>${ongoing ? 'Pick up from here' : 'Last lesson'}</span>
    <span class="dotsep">&middot;</span>
    <span>${esc(fmtDate(latest.held_on))}</span>
    <span class="dotsep">&middot;</span>
    <span>${esc(relativeDate(latest.held_on))}</span>
    ${
      ongoing
        ? '<span class="pill p-brass">still in progress</span>'
        : '<span class="pill p-good">finished</span>'
    }
  </div>

  ${
    stopped
      ? `<div class="resume-text">${bilingual(latest.left_off_ml, latest.left_off)}</div>`
      : latest.covered || latest.covered_ml
        ? `<div class="resume-text is-fallback">${bilingual(latest.covered_ml, latest.covered)}</div>`
        : `<p class="resume-text" style="color:var(--ink-3)">No note was left about where you
             stopped.</p>`
  }

  ${next ? `<div class="resume-sub"><b>Before next time:</b>${next}</div>` : ''}
  ${songChips(latest.section_titles)}

  ${
    o.isTeacher
      ? `<div class="resume-actions">
      ${
        ongoing
          ? `<form method="post" action="/t/sessions/${esc(latest.id)}/complete">
               <button class="btn btn-sm btn-primary" type="submit">Mark this lesson finished</button>
             </form>`
          : ''
      }
      <a class="btn btn-sm" href="${esc(logHref)}">Log the next lesson</a>
    </div>`
      : ''
  }
</div>`;
}

/* ------------------------------------------------------------------ *
 * A field you can speak into.
 *
 * Two boxes, not one: the Malayalam he actually said, and an English
 * rendering for the students abroad who don't read the script — the same
 * pairing a song has with title and title_ml. The microphone fills both
 * and then gets out of the way; nothing is saved until he presses Save,
 * so a bad transcript costs a retry, not a lesson.
 *
 * The Malayalam box only appears once there is Malayalam in it, or once
 * he dictates. Typing a note by hand should not mean staring at an empty
 * second box every time.
 * ------------------------------------------------------------------ */
export function spoken(o: {
  id: string;
  name: string;
  label: string;
  placeholder: string;
  en: string;
  ml: string;
  hint?: string;
  optional?: boolean;
  dictate: boolean;
}): string {
  return `<div class="field spoken" data-spoken>
    <div class="spoken-head">
      <label for="${esc(o.id)}">${esc(o.label)}${
        o.optional ? ' <span class="opt">&mdash; optional</span>' : ''
      }</label>
      ${
        o.dictate
          ? `<button class="mic" type="button" data-mic aria-label="Speak this in Malayalam">
        <span class="mic-dot" aria-hidden="true"></span><span data-mic-label>Speak it</span>
      </button>`
          : ''
      }
    </div>

    <div class="spoken-ml"${o.ml ? '' : ' hidden'} data-ml-wrap>
      <span class="spoken-tag">മലയാളം</span>
      <textarea id="${esc(o.id)}-ml" class="ml" name="${esc(o.name)}_ml" rows="2"
        data-ml placeholder="നിങ്ങൾ പറഞ്ഞത് ഇവിടെ വരും">${esc(o.ml)}</textarea>
    </div>

    <div class="spoken-en">
      <span class="spoken-tag"${o.ml ? '' : ' hidden'} data-en-tag>English</span>
      <textarea id="${esc(o.id)}" name="${esc(o.name)}" rows="2"
        data-en placeholder="${esc(o.placeholder)}">${esc(o.en)}</textarea>
    </div>

    <p class="mic-status" data-mic-status hidden role="status"></p>
    ${o.hint ? `<p class="hint">${o.hint}</p>` : ''}
  </div>`;
}

function field(
  label: string,
  ml: string | null,
  en: string | null,
  cls = '',
): string {
  const body = bilingual(ml, en);
  if (!body) return '';
  return `<div class="lesson-field${cls ? ` ${cls}` : ''}"><span class="fl">${esc(label)}</span>${body}</div>`;
}

function logFields(assigned: AssignedRow[], s: SessionRow | undefined, dictate: boolean): string {
  const checked = new Set((s?.section_ids ?? '').split(SEP).filter(Boolean));
  const today = new Date().toISOString().slice(0, 10);
  const p = s ? `e${s.id}-` : 'new-';

  return `<div class="field-row">
    <div class="field">
      <label for="${p}date">Date</label>
      <input id="${p}date" name="held_on" type="date" value="${esc(s?.held_on ?? today)}" required>
    </div>
    <div class="field">
      <label for="${p}dur">How long <span class="opt">&mdash; minutes, optional</span></label>
      <input id="${p}dur" name="duration_min" type="number" min="1" max="600"
             value="${esc(s?.duration_min ?? '')}" placeholder="45">
    </div>
  </div>

  ${
    assigned.length
      ? `<div class="field">
      <label>Songs you worked on</label>
      <div class="songpick">
        ${assigned
          .map(
            (a) => `<label for="${p}s${esc(a.id)}">
          <input id="${p}s${esc(a.id)}" type="checkbox" name="section_ids" value="${esc(a.id)}"${
            checked.has(a.id) ? ' checked' : ''
          }>
          <span>${esc(a.title)}</span></label>`,
          )
          .join('')}
      </div>
    </div>`
      : ''
  }

  ${spoken({
    id: `${p}covered`,
    name: 'covered',
    label: 'What you covered',
    placeholder: 'Sarali 1 to 7 at two speeds. Started the pallavi of Vatapi.',
    en: s?.covered ?? '',
    ml: s?.covered_ml ?? '',
    dictate,
  })}

  ${spoken({
    id: `${p}left`,
    name: 'left_off',
    label: 'Where you stopped',
    placeholder: 'Midway through the second sangati — the phrase before the arohanam still needs work.',
    hint: `This is the line pinned to the top of the page next time. Be as specific as
      you'd want to be reminded.`,
    en: s?.left_off ?? '',
    ml: s?.left_off_ml ?? '',
    dictate,
  })}

  ${spoken({
    id: `${p}next`,
    name: 'next_focus',
    label: 'To practise before next time',
    optional: true,
    placeholder: 'Sarali 1 to 5 daily, slowly, with the tanpura.',
    en: s?.next_focus ?? '',
    ml: s?.next_focus_ml ?? '',
    dictate,
  })}

  <div class="field">
    <label>How did it end?</label>
    <div class="statuspick">
      <label>
        <input type="radio" name="status" value="completed"${s?.status !== 'ongoing' ? ' checked' : ''}>
        <span><b>Finished what we planned</b><span>Ready to start something new next time.</span></span>
      </label>
      <label>
        <input type="radio" name="status" value="ongoing"${s?.status === 'ongoing' ? ' checked' : ''}>
        <span><b>Still in the middle of it</b><span>Carry on from the same place next lesson.</span></span>
      </label>
    </div>
  </div>`;
}

export function lessonLog(
  sessions: SessionRow[],
  o: { isTeacher: boolean; studentId: string; assigned: AssignedRow[]; dictate?: boolean },
): string {
  const dictate = Boolean(o.dictate);
  const done = sessions.filter((s) => s.status === 'completed').length;
  const open = sessions.length - done;

  const tally = `<div class="tally">
    <div><div class="t-num">${sessions.length}</div><div class="t-lab">lessons</div></div>
    <div><div class="t-num">${done}</div><div class="t-lab">completed</div></div>
    <div class="ongoing"><div class="t-num">${open}</div><div class="t-lab">ongoing</div></div>
  </div>`;

  const one = (s: SessionRow) => `<div id="l-${esc(s.id)}"
  class="lesson${s.status === 'ongoing' ? ' is-ongoing' : ''}">
  <div class="lesson-head">
    <span class="lesson-date">${esc(fmtDate(s.held_on))}</span>
    ${
      s.status === 'ongoing'
        ? '<span class="pill p-brass">ongoing</span>'
        : '<span class="pill p-good">completed</span>'
    }
    ${s.duration_min ? `<span class="lesson-dur">${s.duration_min} min</span>` : ''}
    <span class="spacer"></span>
    ${
      o.isTeacher && s.status === 'ongoing'
        ? `<form method="post" action="/t/sessions/${esc(s.id)}/complete">
             <button class="btn btn-sm" type="submit">Mark finished</button></form>`
        : ''
    }
  </div>

  ${songChips(s.section_titles)}
  ${field('Covered', s.covered_ml, s.covered)}
  ${field('Stopped at', s.left_off_ml, s.left_off, 'stop')}
  ${field('To practise', s.next_focus_ml, s.next_focus)}

  ${
    o.isTeacher
      ? `<details class="lesson-edit">
    <summary>Edit this lesson</summary>
    <form method="post" action="/t/sessions/${esc(s.id)}">
      ${logFields(o.assigned, s, dictate)}
      <div class="btn-row"><button class="btn btn-sm btn-primary" type="submit">Save changes</button></div>
    </form>
    <form method="post" action="/t/sessions/${esc(s.id)}/delete" style="margin-top:10px"
          onsubmit="return confirm('Delete this lesson from the log?')">
      <button class="btn btn-sm btn-danger" type="submit">Delete lesson</button>
    </form>
  </details>`
      : ''
  }
</div>`;

  return `<div class="section-head">
    <div>
      <h2>Lessons</h2>
      <p class="lede">${
        o.isTeacher
          ? 'Every class, most recent first. An ongoing one is a lesson to carry on from.'
          : 'What you covered in each class with your teacher.'
      }</p>
    </div>
  </div>

  ${sessions.length ? tally : ''}
  ${
    sessions.length
      ? `<div class="rows" style="margin-top:14px">${sessions.map(one).join('')}</div>`
      : o.isTeacher
        ? ''
        : '<div class="empty">No lessons logged yet.</div>'
  }

  ${
    o.isTeacher
      ? `<div class="section-head" id="log"><h2>Log a lesson</h2></div>
    <div class="card">
      <form method="post" action="/t/s/${esc(o.studentId)}/sessions">
        ${logFields(o.assigned, undefined, dictate)}
        <button class="btn btn-primary" type="submit">Save lesson</button>
      </form>
    </div>`
      : ''
  }`;
}
