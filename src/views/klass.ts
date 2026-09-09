/* ==================================================================
 * One class, opened to teach it.
 *
 * This is the screen the teacher has in front of them while the lesson
 * is happening. It answers, in order: who, when, where did we stop last
 * time, what are we working on, and — afterwards — what happened.
 * ================================================================== */

import { page, avatar, inlineTitle } from './layout';
import { esc, fmtDate, relativeDate, waLink } from '../util';
import type { User, SessionRow, AssignedRow } from '../types';
import { prettyIst, prettyIstDate, inZone, type Occurrence } from '../tz';
import type { WithZone } from './schedule';

export interface ClassPageData {
  student: WithZone & { email: string; phone?: string | null };
  occ: Occurrence;
  lastLesson: SessionRow | null;
  songs: AssignedRow[];
  alreadyLogged: SessionRow | null;
}

export function classPage(user: User, d: ClassPageData, siteName: string, msg?: string): string {
  const { student, occ, lastLesson, songs, alreadyLogged } = d;
  const local = student.time_zone ? inZone(occ.instant, student.time_zone) : null;
  const off = occ.skipped || occ.missed;

  const stopped = lastLesson?.left_off?.trim();
  const practise = lastLesson?.next_focus?.trim();

  return page(
    `${msg ? `<div class="flash">${esc(msg)}</div>` : ''}
<a class="crumb" href="/t/schedule/day/${esc(occ.date)}">← ${esc(prettyIstDate(occ.date))}</a>

<div class="class-head">
  ${avatar(student)}
  <div class="class-who">
    <h1>${esc(student.name)}</h1>
    <p class="lede">${[
      student.location ? esc(student.location) : '',
      // Worth having to hand mid-class: "are you joining?" is a WhatsApp
      // message, not an email.
      student.phone
        ? waLink(student.phone)
          ? `<a class="wa" href="${esc(waLink(student.phone)!)}" target="_blank" rel="noopener">${esc(
              student.phone,
            )}</a>`
          : esc(student.phone)
        : '',
      occ.slot.label ? esc(occ.slot.label) : '',
    ]
      .filter(Boolean)
      .join(' · ')}</p>
  </div>
  <div class="class-when">
    <div class="cw-line"><b>${esc(prettyIst(occ.time))}</b> <span class="zone">IST</span></div>
    ${
      local
        ? `<div class="cw-line cw-local">${esc(local.time)} ${esc(local.weekday)}
           <span class="zone">${esc(local.abbr)}</span></div>`
        : '<div class="cw-line local-unknown">their time zone is not set</div>'
    }
    <div class="cw-meta">${esc(prettyIstDate(occ.date))} · ${occ.slot.duration_min} min</div>
  </div>
</div>

${
  off
    ? `<div class="flash err">This class is marked ${occ.missed ? 'missed' : 'cancelled'}${
        occ.reason ? ` — ${esc(occ.reason)}` : ''
      }.
   <form method="post" action="/t/slots/${esc(occ.slot.id)}/restore" style="display:inline;margin-left:8px">
     <input type="hidden" name="on_date" value="${esc(occ.originalDate)}">
     <input type="hidden" name="back" value="/t/class/${esc(occ.slot.id)}/${esc(occ.originalDate)}">
     <button class="btn btn-sm" type="submit">Put it back</button></form>
 </div>`
    : ''
}

<div class="section-head"><h2>Pick up from here</h2></div>
${
  lastLesson
    ? `<div class="resume">
  <div class="resume-eyebrow">
    <span>Last lesson</span><span class="dotsep">·</span>
    <span>${esc(fmtDate(lastLesson.held_on))}</span><span class="dotsep">·</span>
    <span>${esc(relativeDate(lastLesson.held_on))}</span>
    ${
      lastLesson.status === 'ongoing'
        ? '<span class="pill p-brass">was still in progress</span>'
        : '<span class="pill p-good">finished</span>'
    }
  </div>
  ${
    stopped
      ? `<p class="resume-text">${esc(stopped)}</p>`
      : `<p class="resume-text" style="color:var(--ink-3)">${
          lastLesson.covered ? esc(lastLesson.covered) : 'Nothing was noted about where you stopped.'
        }</p>`
  }
  ${practise ? `<p class="resume-sub"><b>They were asked to practise:</b> ${esc(practise)}</p>` : ''}
  ${
    lastLesson.covered && stopped
      ? `<p class="resume-sub"><b>Covered:</b> ${esc(lastLesson.covered)}</p>`
      : ''
  }
  <div class="resume-actions">
    <a class="btn btn-sm" href="/t/s/${esc(student.id)}/lessons">All previous lessons</a>
  </div>
</div>`
    : `<div class="empty">No previous lesson logged for ${esc(student.name.split(' ')[0])}.</div>`
}

<div class="section-head">
  <div><h2>Songs to work on</h2>
    <p class="lede">Open one to play its recordings and read its notes.</p></div>
</div>
${
  songs.length
    ? `<div class="rows">${songs
        .map(
          (a) => `<a class="row" href="/t/s/${esc(student.id)}/${esc(a.id)}">
    <div class="row-main">
      <div class="row-title">${inlineTitle(a.title, a.title_ml)}</div>
      <div class="row-meta">
        ${a.group_name ? `<span>${esc(a.group_name)}</span>` : ''}
        ${a.raga ? `<span>Raga ${esc(a.raga)}</span>` : ''}
        <span class="num">${a.rec_count} ${a.rec_count === 1 ? 'recording' : 'recordings'}</span>
        ${a.note_count ? `<span class="num">${a.note_count} ${a.note_count === 1 ? 'note' : 'notes'}</span>` : ''}
      </div>
    </div>
    <div class="row-actions"><span class="btn btn-sm btn-primary">Open</span></div>
  </a>`,
        )
        .join('')}</div>`
    : `<div class="empty">No songs assigned yet.
       <a href="/t/s/${esc(student.id)}/songs">Assign one</a>.</div>`
}

<div class="section-head" id="log">
  <div><h2>${alreadyLogged ? 'This lesson is logged' : 'Log this lesson'}</h2>
    <p class="lede">${
      alreadyLogged
        ? 'You already wrote this one up. Edit it under Lessons if anything changed.'
        : 'Fill this in at the end and the stopping point carries into next week.'
    }</p></div>
</div>

${
  alreadyLogged
    ? `<div class="card">
    ${alreadyLogged.covered ? `<div class="lesson-field"><span class="fl">Covered</span><p>${esc(alreadyLogged.covered)}</p></div>` : ''}
    ${alreadyLogged.left_off ? `<div class="lesson-field stop"><span class="fl">Stopped at</span><p>${esc(alreadyLogged.left_off)}</p></div>` : ''}
    <div class="btn-row" style="margin-top:14px">
      <a class="btn btn-sm" href="/t/s/${esc(student.id)}/lessons">Edit it</a>
    </div>
  </div>`
    : `<div class="card">
  <form method="post" action="/t/s/${esc(student.id)}/sessions">
    <input type="hidden" name="held_on" value="${esc(occ.date)}">
    <input type="hidden" name="duration_min" value="${occ.slot.duration_min}">
    <input type="hidden" name="back" value="/t/class/${esc(occ.slot.id)}/${esc(occ.originalDate)}">
    ${
      songs.length
        ? `<div class="field">
      <label>Songs you worked on</label>
      <div class="songpick">
        ${songs
          .map(
            (a) => `<label for="cl-${esc(a.id)}">
          <input id="cl-${esc(a.id)}" type="checkbox" name="section_ids" value="${esc(a.id)}">
          <span>${esc(a.title)}</span></label>`,
          )
          .join('')}
      </div>
    </div>`
        : ''
    }
    <div class="field">
      <label for="cl-covered">What you covered</label>
      <textarea id="cl-covered" name="covered" rows="2"
        placeholder="Sarali 1 to 7 at two speeds. Started the pallavi."></textarea>
    </div>
    <div class="field">
      <label for="cl-left">Where you stopped</label>
      <textarea id="cl-left" name="left_off" rows="2"
        placeholder="Midway through the second sangati — start there next time."></textarea>
      <p class="hint">This is what you'll see at the top of this screen next week.</p>
    </div>
    <div class="field">
      <label for="cl-next">To practise before next time <span class="opt">— optional</span></label>
      <textarea id="cl-next" name="next_focus" rows="2"
        placeholder="That one phrase, slowly, with the recording at 0.75x."></textarea>
    </div>
    <div class="field">
      <label>How did it end?</label>
      <div class="statuspick">
        <label><input type="radio" name="status" value="completed" checked>
          <span><b>Finished what we planned</b><span>Ready for something new next time.</span></span></label>
        <label><input type="radio" name="status" value="ongoing">
          <span><b>Still in the middle of it</b><span>Carry on from the same place.</span></span></label>
      </div>
    </div>
    <button class="btn btn-primary" type="submit">Save lesson</button>
  </form>
</div>`
}

${
  off
    ? ''
    : `<div class="section-head"><h2>If it isn't happening</h2></div>
<div class="card">
  <div class="day-actions" style="margin:0;padding:0;border:none">
    <form method="post" action="/t/slots/${esc(occ.slot.id)}/missed" class="day-form">
      <input type="hidden" name="on_date" value="${esc(occ.originalDate)}">
      <input type="hidden" name="back" value="/t/class/${esc(occ.slot.id)}/${esc(occ.originalDate)}">
      <input name="reason" type="text" placeholder="Why it didn't happen — optional">
      <button class="btn btn-sm" type="submit">Mark missed</button>
    </form>
    <form method="post" action="/t/slots/${esc(occ.slot.id)}/skip" class="day-form">
      <input type="hidden" name="on_date" value="${esc(occ.originalDate)}">
      <input type="hidden" name="back" value="/t/class/${esc(occ.slot.id)}/${esc(occ.originalDate)}">
      <input name="reason" type="text" placeholder="Reason — Onam, travel…">
      <button class="btn btn-sm" type="submit">Cancel this class</button>
    </form>
    <form method="post" action="/t/slots/${esc(occ.slot.id)}/move" class="day-form">
      <input type="hidden" name="on_date" value="${esc(occ.originalDate)}">
      <input type="hidden" name="back" value="/t/schedule/day/${esc(occ.date)}">
      <span class="day-label">Reschedule to</span>
      <input name="new_date" type="date" value="${esc(occ.date)}" required>
      <input name="new_time_ist" type="time" value="${esc(occ.time)}" required>
      <button class="btn btn-sm" type="submit">Move</button>
    </form>
  </div>
</div>`
}`,
    { title: `${student.name} · ${prettyIstDate(occ.date)}`, user, siteName, nav: 'schedule' },
  );
}
