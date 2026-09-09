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

/** The one thing the teacher should see first: where the last lesson stopped. */
export function resumeCard(
  latest: SessionRow | null,
  o: { isTeacher: boolean; firstName: string },
): string {
  if (!latest) {
    return o.isTeacher
      ? `<div class="empty" style="margin-bottom:6px"><strong>No lessons logged yet</strong>
         After your next class with ${esc(o.firstName)}, write down what you covered and where you
         stopped. It shows up here, so you can pick straight up next time.</div>`
      : '';
  }

  const ongoing = latest.status === 'ongoing';
  const stopped = latest.left_off?.trim();
  const next = latest.next_focus?.trim();

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
      ? `<p class="resume-text">${esc(stopped)}</p>`
      : `<p class="resume-text" style="color:var(--ink-3)">${
          latest.covered ? esc(latest.covered) : 'No note was left about where you stopped.'
        }</p>`
  }

  ${next ? `<p class="resume-sub"><b>Before next time:</b> ${esc(next)}</p>` : ''}
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
      <a class="btn btn-sm" href="#log">Log the next lesson</a>
    </div>`
      : ''
  }
</div>`;
}

function logFields(assigned: AssignedRow[], s?: SessionRow): string {
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

  <div class="field">
    <label for="${p}covered">What you covered</label>
    <textarea id="${p}covered" name="covered" rows="2"
      placeholder="Sarali 1 to 7 at two speeds. Started the pallavi of Vatapi.">${esc(s?.covered ?? '')}</textarea>
  </div>

  <div class="field">
    <label for="${p}left">Where you stopped</label>
    <textarea id="${p}left" name="left_off" rows="2"
      placeholder="Midway through the second sangati — the phrase before the arohanam still needs work.">${esc(s?.left_off ?? '')}</textarea>
    <p class="hint">This is the line pinned to the top of the page next time. Be as specific as
      you'd want to be reminded.</p>
  </div>

  <div class="field">
    <label for="${p}next">To practise before next time <span class="opt">&mdash; optional</span></label>
    <textarea id="${p}next" name="next_focus" rows="2"
      placeholder="Sarali 1 to 5 daily, slowly, with the tanpura.">${esc(s?.next_focus ?? '')}</textarea>
  </div>

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
  o: { isTeacher: boolean; studentId: string; assigned: AssignedRow[] },
): string {
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
  ${s.covered ? `<div class="lesson-field"><span class="fl">Covered</span><p>${esc(s.covered)}</p></div>` : ''}
  ${s.left_off ? `<div class="lesson-field stop"><span class="fl">Stopped at</span><p>${esc(s.left_off)}</p></div>` : ''}
  ${s.next_focus ? `<div class="lesson-field"><span class="fl">To practise</span><p>${esc(s.next_focus)}</p></div>` : ''}

  ${
    o.isTeacher
      ? `<details class="lesson-edit">
    <summary>Edit this lesson</summary>
    <form method="post" action="/t/sessions/${esc(s.id)}">
      ${logFields(o.assigned, s)}
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

  return `<div class="section-head" id="log">
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
      ? `<div class="section-head"><h2>Log a lesson</h2></div>
    <div class="card">
      <form method="post" action="/t/s/${esc(o.studentId)}/sessions">
        ${logFields(o.assigned)}
        <button class="btn btn-primary" type="submit">Save lesson</button>
      </form>
    </div>`
      : ''
  }`;
}
