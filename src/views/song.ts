/* ==================================================================
 * The song page — the teacher's workbench for one song.
 *
 * Recordings and notes live on the SONG, not on a student, and are
 * shared with everyone learning it. A recording can be made private to
 * one student when it's a correction meant only for them.
 *
 * This replaces the old popover on the catalogue row, which was clipped
 * by the list's own overflow and effectively invisible.
 * ================================================================== */

import { page, avatar, titleWithScript, disclosure, discloseAll } from './layout';
import type { Visiting } from './layout';
import { esc, fmtBytes, fmtDuration, fmtDate, relativeDate } from '../util';
import { spoken } from './sessions';
import type { User, Group, Section, Recording, Note } from '../types';
import { t, setLang } from '../i18n';

/** Common parts of a Carnatic piece, offered as suggestions rather than a fixed list. */
export const SONG_PARTS = [
  'Pallavi', 'Anupallavi', 'Charanam', 'Chittaswaram', 'Muktayi Swaram',
  'Ettugada Swaram', 'Sahitya', 'Full song', 'Slow speed', 'Second speed',
];

export interface SongStudent {
  id: string;
  name: string;
  avatar_url: string | null;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  rec_count: number;
}

export interface SongPageData {
  section: Section & { group_name: string | null };
  groups: Group[];
  recordings: (Recording & { student_name: string | null })[];
  /** Every note on the song — pinned to a recording, or song-wide. */
  notes: (Note & { student_name: string | null })[];
  /** recording id → the student ids it was given to. */
  recShares: Map<string, string[]>;
  /** note id → the student ids it was given to. */
  noteShares: Map<string, string[]>;
  learning: SongStudent[];
  finished: SongStudent[];
  assignable: SongStudent[];
  /** Show the speak-it button on note bodies (dictation is configured). */
  dictate?: boolean;
  /** Set when an admin is acting inside a practice they do not teach. */
  visiting?: Visiting | null;
}

function partsDatalist(): string {
  return `<datalist id="song-parts">${SONG_PARTS.map((p) => `<option value="${esc(p)}"></option>`).join('')}</datalist>`;
}

/**
 * Who this item reaches, as a pill you can read at a glance.
 *
 * Never called with a 'self' recording here — those are filtered out of
 * this page entirely (see songPage above) — so there's no branch for it.
 */
function audiencePill(visibility: string, shared: string[], students: SongStudent[]): string {
  if (visibility === 'shared') return `<span class="pill p-info">${t('everyone')}</span>`;
  if (!shared.length) return `<span class="pill p-warn">${t('nobody yet')}</span>`;
  if (shared.length === 1) {
    const s = students.find((x) => x.id === shared[0]);
    return `<span class="pill p-brass">${esc(s ? s.name.split(' ')[0] : t('%s student', 1))}</span>`;
  }
  return `<span class="pill p-brass">${t('%s students', shared.length)}</span>`;
}

/**
 * The audience editor: everyone, or a named set. One item can go to any
 * number of students, which is why this is checkboxes and not a dropdown.
 *
 * It posts on its own, sending only `visibility` and `share_ids`, so saving
 * an audience never touches the item's name or text.
 */
function audienceForm(o: {
  action: string;
  back: string;
  visibility: string;
  shared: string[];
  students: SongStudent[];
  idPrefix: string;
  noun: string;
}): string {
  const chosen = o.visibility !== 'shared';
  const set = new Set(o.shared);

  if (!o.students.length) {
    return `<p class="hint">${t(
      'Nobody is assigned this song yet, so there is no one to choose from. Until then this %s is for everyone learning it.',
      esc(t(o.noun)),
    )}</p>`;
  }

  return `<form method="post" action="${esc(o.action)}" class="audience">
  <input type="hidden" name="back" value="${esc(o.back)}">
  <div class="aud-choice">
    <label>
      <input type="radio" name="visibility" value="shared"${chosen ? '' : ' checked'}>
      <span><b>${t('Everyone learning this song')}</b></span>
    </label>
    <label>
      <input type="radio" name="visibility" value="chosen"${chosen ? ' checked' : ''}>
      <span><b>${t('Only the students I tick')}</b></span>
    </label>
  </div>
  <div class="aud-who">
    ${o.students
      .map(
        (s) => `<label for="${esc(o.idPrefix)}${esc(s.id)}">
      <input id="${esc(o.idPrefix)}${esc(s.id)}" type="checkbox" name="share_ids" value="${esc(s.id)}"${
        set.has(s.id) ? ' checked' : ''
      }>
      <span>${esc(s.name)}${s.completed_at ? ` <span class="opt">${t('— finished')}</span>` : ''}</span>
    </label>`,
      )
      .join('')}
  </div>
  <div class="btn-row">
    <button class="btn btn-sm btn-primary" type="submit">${t("Save who it's for")}</button>
    <span class="hint" style="margin:0">${t('Ticking nobody leaves it with everyone.')}</span>
  </div>
</form>`;
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ *
 * One note.
 *
 * The same block serves a note pinned to a recording and a note about the
 * whole song; `move` says which list it reorders inside, and `back` brings
 * you to the same place after any of its forms post.
 * ------------------------------------------------------------------ */

function noteBlock(
  n: Note & { student_name: string | null },
  idx: number,
  total: number,
  o: { students: SongStudent[]; shared: string[]; back: string; dictate?: boolean },
): string {
  const p = `n${n.id}-`;
  return `<div class="note" id="note-${esc(n.id)}">
  <div class="note-meta">
    <span>${esc(fmtDate(n.created_at))} ${audiencePill(n.visibility, o.shared, o.students)}</span>
    <span class="reorder">
      <form method="post" action="/t/notes/${esc(n.id)}/move">
        <input type="hidden" name="dir" value="up">
        <input type="hidden" name="back" value="${esc(o.back)}">
        <button class="btn btn-sm" type="submit" title="${esc(t('Move up'))}"${idx === 0 ? ' disabled' : ''}>&uarr;</button></form>
      <form method="post" action="/t/notes/${esc(n.id)}/move">
        <input type="hidden" name="dir" value="down">
        <input type="hidden" name="back" value="${esc(o.back)}">
        <button class="btn btn-sm" type="submit" title="${esc(t('Move down'))}"${idx === total - 1 ? ' disabled' : ''}>&darr;</button></form>
    </span>
  </div>
  ${n.title ? `<p class="note-title">${esc(n.title)}</p>` : ''}
  ${n.body_ml ? `<p class="note-body ml">${esc(n.body_ml)}</p>` : ''}
  ${n.body ? `<p class="note-body${n.body_ml ? ' said-en' : ''}">${esc(n.body)}</p>` : ''}
  ${n.image_key ? `<img class="note-img" src="/img/${esc(n.id)}" alt="${esc(t('Note attachment'))}" loading="lazy">` : ''}

  <div class="note-tools">
    <a class="note-dl" href="/note/${esc(n.id)}/download">${t('Download note')}</a>
    ${n.image_key ? `<a class="note-dl" href="/img/${esc(n.id)}?download=1">${t('Download image')}</a>` : ''}
    <details class="inline-edit">
      <summary>${t('Edit')}</summary>
      <div class="inline-edit-body">
        <form method="post" action="/t/notes/${esc(n.id)}">
          <input type="hidden" name="back" value="${esc(o.back)}">
          <div class="field">
            <label for="${p}t">${t('Heading')} <span class="opt">${t('— optional')}</span></label>
            <input id="${p}t" name="title" type="text" value="${esc(n.title ?? '')}"
                   placeholder="${esc(t('Anupallavi — gamaka'))}">
          </div>
          ${spoken({
            id: `${p}b`,
            name: 'body',
            label: t('Note'),
            placeholder: '',
            en: n.body ?? '',
            ml: n.body_ml ?? '',
            dictate: Boolean(o.dictate),
          })}
          <div class="btn-row">
            <button class="btn btn-sm btn-primary" type="submit">${t('Save note')}</button>
          </div>
        </form>
        <form method="post" action="/notes/${esc(n.id)}/delete" style="margin-top:10px"
              onsubmit="return confirm('${t('Delete this note?')}')">
          <button class="btn btn-sm btn-danger" type="submit">${t('Delete note')}</button>
        </form>
      </div>
    </details>

    <details class="inline-edit">
      <summary>${t('Who can see it')}</summary>
      <div class="inline-edit-body">
        ${audienceForm({
          action: `/t/notes/${n.id}`,
          back: o.back,
          visibility: n.visibility,
          shared: o.shared,
          students: o.students,
          idPrefix: `ns${n.id}-`,
          noun: 'note',
        })}
      </div>
    </details>
  </div>
</div>`;
}

/** The form for adding a note, used under a recording and under the song. */
function noteForm(o: {
  sectionId: string;
  recordingId: string | null;
  students: SongStudent[];
  back: string;
  idPrefix: string;
  dictate?: boolean;
}): string {
  const p = o.idPrefix;
  return `<form method="post" action="/t/notes" enctype="multipart/form-data">
  <input type="hidden" name="section_id" value="${esc(o.sectionId)}">
  ${o.recordingId ? `<input type="hidden" name="recording_id" value="${esc(o.recordingId)}">` : ''}
  <input type="hidden" name="back" value="${esc(o.back)}">
  <div class="field">
    <label for="${p}title">${t('Heading')} <span class="opt">${t('— optional')}</span></label>
    <input id="${p}title" name="title" type="text" placeholder="${esc(t('Anupallavi — gamaka'))}">
  </div>
  ${spoken({
    id: `${p}body`,
    name: 'body',
    label: t('Note'),
    placeholder: t('The gamaka on the second sangati should be slower than it looks written.'),
    en: '',
    ml: '',
    dictate: Boolean(o.dictate),
  })}
  <div class="field">
    <label for="${p}img">${t('Screenshot or notation')} <span class="opt">${t('— optional')}</span></label>
    <input id="${p}img" name="image" type="file" accept="image/*">
  </div>
  ${
    o.students.length
      ? `<details class="inline-edit" style="margin-top:0">
    <summary>${t('Who can see it — everyone, unless you say otherwise')}</summary>
    <div class="inline-edit-body">
      <div class="aud-choice">
        <label><input type="radio" name="visibility" value="shared" checked>
          <span><b>${t('Everyone learning this song')}</b></span></label>
        <label><input type="radio" name="visibility" value="chosen">
          <span><b>${t('Only the students I tick')}</b></span></label>
      </div>
      <div class="aud-who">
        ${o.students
          .map(
            (s) => `<label for="${p}s${esc(s.id)}">
          <input id="${p}s${esc(s.id)}" type="checkbox" name="share_ids" value="${esc(s.id)}">
          <span>${esc(s.name)}</span></label>`,
          )
          .join('')}
      </div>
    </div>
  </details>`
      : ''
  }
  <div class="btn-row"><button class="btn btn-sm btn-primary" type="submit">${t('Save note')}</button></div>
</form>`;
}

/* ------------------------------------------------------------------ *
 * One recording, with the notes that belong to it.
 * ------------------------------------------------------------------ */

function recordingBlock(
  r: Recording & { student_name: string | null },
  idx: number,
  total: number,
  o: {
    students: SongStudent[];
    shared: string[];
    notes: (Note & { student_name: string | null })[];
    noteShares: Map<string, string[]>;
    back: string;
    open: boolean;
    dictate?: boolean;
  },
): string {
  const media =
    r.kind === 'video'
      ? `<video controls preload="metadata" playsinline src="/media/${esc(r.id)}"></video>`
      : `<audio controls preload="metadata" src="/media/${esc(r.id)}"></audio>`;
  const p = `r${r.id}-`;
  const noteCount = o.notes.length;

  /* The reorder form lives outside the <details> and the buttons reach it
     by id. A <form> is not valid inside a <summary>, and anything that is
     inside the details is hidden while it's closed — which is exactly
     when you want to reorder, without opening every take first. */
  return `<form id="mv-${esc(r.id)}" method="post" action="/t/recordings/${esc(r.id)}/move" class="mv-form">
  <input type="hidden" name="back" value="${esc(o.back)}">
</form>
<details class="rec" data-disc="rec:${esc(r.id)}"${o.open ? ' open' : ''}>
  <summary>
    <span class="disc-mark" aria-hidden="true"></span>
    <span class="rec-sum">
      <span class="rec-sum-top">
        <span class="rec-title">
          ${esc(r.title || (r.kind === 'video' ? t('Video clip') : t('Recording')))}
          ${r.part ? `<span class="part-tag">${esc(r.part)}</span>` : ''}
          ${audiencePill(r.visibility, o.shared, o.students)}
          ${noteCount ? `<span class="note-count">${noteCount === 1 ? t('%s note', noteCount) : t('%s notes', noteCount)}</span>` : ''}
        </span>
        <span class="rec-meta">
          <span>${esc(fmtDate(r.created_at))}</span>
          <span>${esc(fmtDuration(r.duration_sec))}</span>
          <span>${esc(fmtBytes(r.size_bytes))}</span>
        </span>
      </span>
      ${r.description ? `<span class="rec-sum-desc">${esc(r.description)}</span>` : ''}
    </span>
    <span class="rec-order">
      <button class="btn btn-sm" type="submit" form="mv-${esc(r.id)}" name="dir" value="up"
        data-keep-open title="${esc(t('Move up within %s', r.part || t('this song')))}"
        ${idx === 0 ? 'disabled' : ''}>&uarr;</button>
      <button class="btn btn-sm" type="submit" form="mv-${esc(r.id)}" name="dir" value="down"
        data-keep-open title="${esc(t('Move down within %s', r.part || t('this song')))}"
        ${idx === total - 1 ? 'disabled' : ''}>&darr;</button>
    </span>
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
      </div>
    </div>

    <div class="rec-notes">
      <div class="rec-notes-head">${t('Notes on this recording')}${
        noteCount ? ` <span class="num">${noteCount}</span>` : ''
      }</div>
      ${
        noteCount
          ? o.notes
              .map((n, i) =>
                noteBlock(n, i, noteCount, {
                  students: o.students,
                  shared: o.noteShares.get(n.id) ?? [],
                  back: o.back,
                  dictate: o.dictate,
                }),
              )
              .join('')
          : `<p class="hint" style="margin:0 0 10px">${t('Nothing written about this take yet.')}</p>`
      }
      <details class="inline-edit">
        <summary>${t('Add a note to this recording')}</summary>
        <div class="inline-edit-body">
          ${noteForm({
            sectionId: r.section_id,
            recordingId: r.id,
            students: o.students,
            back: o.back,
            idPrefix: `${p}n-`,
            dictate: o.dictate,
          })}
        </div>
      </details>
    </div>

    <div class="rec-tools">
      <details class="inline-edit">
        <summary>${t('Edit this recording')}</summary>
        <div class="inline-edit-body">
          <form method="post" action="/t/recordings/${esc(r.id)}">
            <input type="hidden" name="back" value="${esc(o.back)}">
            <div class="field-row">
              <div class="field">
                <label for="${p}t">${t('Name')} <span class="opt">${t('— what this take is')}</span></label>
                <input id="${p}t" name="title" type="text" value="${esc(r.title ?? '')}"
                       placeholder="${esc(t('Pallavi, slow'))}" required>
              </div>
              <div class="field">
                <label for="${p}p">${t('Part of the song')}</label>
                <input id="${p}p" name="part" type="text" list="song-parts" value="${esc(r.part ?? '')}"
                       placeholder="Pallavi">
              </div>
            </div>
            <div class="field">
              <label for="${p}d">${t('Description')} <span class="opt">${t('— a few lines on what this take shows')}</span></label>
              <textarea id="${p}d" name="description" rows="3"
                placeholder="${esc(t('Anupallavi at half speed. The gamaka before the arohanam is held longer than the notation suggests.'))}">${esc(r.description ?? '')}</textarea>
            </div>
            <div class="btn-row">
              <button class="btn btn-sm btn-primary" type="submit">${t('Save')}</button>
            </div>
          </form>
          <form method="post" action="/t/recordings/${esc(r.id)}/delete" style="margin-top:10px"
                onsubmit="return confirm('${t('Delete this recording permanently?')}')">
            <input type="hidden" name="back" value="${esc(o.back)}">
            <button class="btn btn-sm btn-danger" type="submit">${t('Delete recording')}</button>
          </form>
        </div>
      </details>

      <details class="inline-edit">
        <summary>${t('Who can hear it')}</summary>
        <div class="inline-edit-body">
          ${audienceForm({
            action: `/t/recordings/${r.id}`,
            back: o.back,
            visibility: r.visibility,
            shared: o.shared,
            students: o.students,
            idPrefix: `rs${r.id}-`,
            noun: 'recording',
          })}
        </div>
      </details>
    </div>
  </div>
</details>`;
}

/* ------------------------------------------------------------------ */

export function songPage(user: User, d: SongPageData, siteName: string, msg?: string): string {
  setLang(user.lang);
  const { section, groups, notes, recShares, noteShares, learning, finished, assignable } = d;
  // A 'self' recording is a student's own practice take — private to them
  // and any teacher. It belongs on that student's own song page
  // (/t/s/:id/:section, see pages.ts), not mixed into this shared catalogue
  // view where every student learning the song can see who reordered what.
  const recordings = d.recordings.filter((r) => r.visibility !== 'self');
  const everyone = [...learning, ...finished];
  const back = `/t/song/${section.id}`;

  // Notes split two ways: the ones about a particular take, and the ones about
  // the song. The first lot are shown inside their recording.
  const notesByRec = new Map<string, (Note & { student_name: string | null })[]>();
  const songNotes: (Note & { student_name: string | null })[] = [];
  for (const n of notes) {
    if (n.recording_id) {
      if (!notesByRec.has(n.recording_id)) notesByRec.set(n.recording_id, []);
      notesByRec.get(n.recording_id)!.push(n);
    } else {
      songNotes.push(n);
    }
  }

  // Group recordings by the part they cover, keeping "no part set" last.
  const byPart = new Map<string, typeof recordings>();
  for (const r of recordings) {
    const k = r.part?.trim() || '';
    if (!byPart.has(k)) byPart.set(k, []);
    byPart.get(k)!.push(r);
  }
  const partKeys = [...byPart.keys()].sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    const ia = SONG_PARTS.indexOf(a);
    const ib = SONG_PARTS.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });

  const studentRow = (s: SongStudent) => `<div class="row">
  ${avatar(s)}
  <div class="row-main">
    <div class="row-title"><a href="/t/s/${esc(s.id)}/${esc(section.id)}"
      style="color:inherit;text-decoration:none">${esc(s.name)}</a></div>
    <div class="row-meta">
      ${s.started_at ? `<span>${t('started %s', esc(fmtDate(s.started_at)))}</span>` : ''}
      ${s.completed_at ? `<span>${t('finished %s', esc(relativeDate(s.completed_at)))}</span>` : ''}
      ${
        s.rec_count
          ? `<span class="num">${
              s.rec_count === 1
                ? t('%s private recording', s.rec_count)
                : t('%s private recordings', s.rec_count)
            }</span>`
          : ''
      }
      ${s.status !== 'active' ? `<span class="pill p-warn">${esc(t(s.status))}</span>` : ''}
    </div>
  </div>
  <div class="row-actions">
    <a class="btn btn-sm" href="/t/s/${esc(s.id)}/${esc(section.id)}">${t('Open')}</a>
    <form method="post" action="/t/s/${esc(s.id)}/complete-song">
      <input type="hidden" name="section_id" value="${esc(section.id)}">
      ${s.completed_at ? '<input type="hidden" name="undo" value="1">' : ''}
      <input type="hidden" name="back" value="/t/song/${esc(section.id)}">
      <button class="btn btn-sm btn-quiet" type="submit">${s.completed_at ? t('Reopen') : t('Mark finished')}</button>
    </form>
  </div>
</div>`;

  return page(
    `${msg ? `<div class="flash">${esc(msg)}</div>` : ''}
<a class="crumb" href="/t/catalogue">← ${t('Songs')}</a>
<div class="page-head">
  <h1>${titleWithScript(section.title, section.title_ml)}</h1>
  <p class="lede">${[
    section.group_name ? esc(section.group_name) : '',
    section.raga ? t('Raga %s', esc(section.raga)) : '',
    section.taala ? t('Taala %s', esc(section.taala)) : '',
    section.composer ? esc(section.composer) : '',
  ]
    .filter(Boolean)
    .join(' · ')}</p>
</div>

${partsDatalist()}

<details class="panel" style="margin-bottom:22px">
  <summary>${t('Edit song details')}</summary>
  <div class="panel-body">
    <form method="post" action="/t/sections/${esc(section.id)}">
      <input type="hidden" name="back" value="/t/song/${esc(section.id)}">
      <div class="field">
        <label for="e-title">${t('Title')}</label>
        <input id="e-title" name="title" type="text" value="${esc(section.title)}" required>
      </div>
      <div class="field">
        <label for="e-ml">${t('Title in Malayalam')} <span class="opt">${t('— optional')}</span></label>
        <input id="e-ml" name="title_ml" type="text" class="ml" lang="ml" value="${esc(section.title_ml ?? '')}">
      </div>
      <div class="field-row">
        <div class="field"><label for="e-raga">${t('Raga')}</label>
          <input id="e-raga" name="raga" type="text" value="${esc(section.raga ?? '')}"></div>
        <div class="field"><label for="e-taala">${t('Taala')}</label>
          <input id="e-taala" name="taala" type="text" value="${esc(section.taala ?? '')}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="e-comp">${t('Composer')}</label>
          <input id="e-comp" name="composer" type="text" value="${esc(section.composer ?? '')}"></div>
        <div class="field"><label for="e-group">${t('Group')}</label>
          <select id="e-group" name="group_id">
            <option value="">${t('— none —')}</option>
            ${groups
              .map(
                (g) =>
                  `<option value="${esc(g.id)}"${g.id === section.group_id ? ' selected' : ''}>${esc(g.name)}</option>`,
              )
              .join('')}
          </select></div>
      </div>
      <button class="btn btn-primary" type="submit">${t('Save details')}</button>
    </form>
    <form method="post" action="/t/sections/${esc(section.id)}/delete" style="margin-top:14px"
          onsubmit="return confirm('${t('Delete this song and every recording and note filed under it?')}')">
      <button class="btn btn-sm btn-danger" type="submit">${t('Delete this song')}</button>
    </form>
  </div>
</details>

<div class="section-head">
  <div><h2>${t('Recordings')}</h2>
    <p class="lede">${t('%s in total, grouped by the part they cover.', recordings.length)}
      ${t("Open one to play it, read its notes, and set who it's for.")}</p></div>
</div>

${recordings.length > 1 ? discloseAll(t('Your browser remembers what you leave open.')) : ''}
${
  recordings.length
    ? partKeys
        .map((k) => {
          const list = byPart.get(k)!;
          return disclosure({
            key: `part:${section.id}:${k}`,
            cls: 'disc-part',
            open: true,
            title: k ? esc(k) : esc(t('No part set')),
            meta:
              list.length === 1
                ? t('%s recording', list.length)
                : t('%s recordings', list.length),
            // The first take in a part opens; the rest wait to be asked for.
            body: list
              .map((r, i) =>
                recordingBlock(r, i, list.length, {
                  students: everyone,
                  shared: recShares.get(r.id) ?? [],
                  notes: notesByRec.get(r.id) ?? [],
                  noteShares,
                  back,
                  open: i === 0 || list.length <= 2,
                  dictate: d.dictate,
                }),
              )
              .join(''),
          });
        })
        .join('')
    : `<div class="empty"><strong>${t('No recordings yet')}</strong>
       ${t('Add one below and everyone learning this song will have it.')}</div>`
}

<!-- Recording is something you go and do, not something you read on the way
     past, so the whole apparatus stays shut until it's wanted. No data-disc:
     this one is always closed on load rather than remembering, because a
     recorder left open is not a state worth restoring. -->
<details class="panel addrec">
  <summary>
    <span class="addrec-t">${t('Add a recording')}</span>
    <span class="addrec-s">${t('record in the browser, or drop in files')}</span>
  </summary>
  <div class="panel-body">

<p class="lede" style="margin-top:10px">${t('Audio becomes MP3 before it uploads.')}
  ${t("Every take needs a name — it's how you'll find it again.")}</p>

${
  everyone.length
    ? `<details class="panel" style="margin-bottom:14px">
  <summary>${t('Who these are for — everyone learning this song')}</summary>
  <div class="panel-body">
    <div data-audience>
      <div class="aud-choice">
        <label><input type="radio" name="visibility" value="shared" checked>
          <span><b>${t('Everyone learning this song')}</b></span></label>
        <label><input type="radio" name="visibility" value="chosen">
          <span><b>${t('Only the students I tick')}</b></span></label>
      </div>
      <div class="aud-who">
        ${everyone
          .map(
            (s) => `<label for="new-share-${esc(s.id)}">
          <input id="new-share-${esc(s.id)}" type="checkbox" name="share_ids" value="${esc(s.id)}">
          <span>${esc(s.name)}</span></label>`,
          )
          .join('')}
      </div>
      <p class="hint">${t('This applies to whatever you record or upload next.')}
        ${t('You can change it on any recording afterwards.')}</p>
    </div>
  </div>
</details>`
    : ''
}

<div class="tabs" role="tablist">
  <button role="tab" aria-selected="true" data-tab="record">${t('Record now')}</button>
  <button role="tab" aria-selected="false" data-tab="upload">${t('Upload files')}</button>
</div>

<div data-panel="record">
  <div class="recorder" data-student="" data-section="${esc(section.id)}" data-part-input="1">
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
      <div class="field-row" style="margin-top:12px">
        <div class="field">
          <label for="rec-title">${t('Name this take')} <span class="req">${t('— required')}</span></label>
          <input id="rec-title" type="text" data-title placeholder="${esc(t('Pallavi, slow'))}" required>
        </div>
        <div class="field">
          <label for="rec-part">${t('Part of the song')}</label>
          <input id="rec-part" type="text" data-part list="song-parts" placeholder="Pallavi">
        </div>
      </div>
      <div class="field">
        <label for="rec-desc">${t('Description')} <span class="opt">${t('— optional, a few lines')}</span></label>
        <textarea id="rec-desc" rows="2" data-desc
          placeholder="${esc(t('Second sangati, slowly. Hold the gamaka longer than written.'))}"></textarea>
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
  <div class="dropzone" data-drop data-student="" data-section="${esc(section.id)}">
    <strong>${t('Drop audio or video here')}</strong>
    ${t('or click to choose files — MP3, M4A, WAV, MP4 and MOV all work.')}
    ${t("Each one is named after its file; rename it afterwards if that isn't right.")}
    <input type="file" data-file multiple accept="audio/*,video/*" hidden>
  </div>
  <div class="queue" data-queue></div>
</div>

  </div>
</details>

<div class="section-head">
  <div><h2>${t('Notes about the whole song')}</h2>
    <p class="lede">${t('Notes that belong to one take live with it, above.')}
      ${t('These are the ones about the song itself — everyone learning it sees them unless you pick people.')}</p></div>
</div>

${
  songNotes.length
    ? songNotes
        .map((n, i) =>
          noteBlock(n, i, songNotes.length, {
            students: everyone,
            shared: noteShares.get(n.id) ?? [],
            back,
            dictate: d.dictate,
          }),
        )
        .join('')
    : `<div class="empty">${t('No notes about the song yet.')}</div>`
}

<details class="panel" style="margin-top:14px">
  <summary>${t('Add a note about the song')}</summary>
  <div class="panel-body">
    ${noteForm({
      sectionId: section.id,
      recordingId: null,
      students: everyone,
      back,
      idPrefix: 'song-note-',
      dictate: d.dictate,
    })}
  </div>
</details>

<div class="section-head">
  <div><h2>${t('Learning this now')}</h2></div>
</div>
${
  learning.length
    ? `<div class="rows">${learning.map(studentRow).join('')}</div>`
    : `<div class="empty">${t('Nobody is on this song at the moment.')}</div>`
}

${
  finished.length
    ? `<div class="section-head"><div><h2>${t('Finished it')}</h2>
       <p class="lede">${
         finished.length === 1
           ? t('%s student has completed this song.', finished.length)
           : t('%s students have completed this song.', finished.length)
       }</p></div></div>
     <div class="rows">${finished.map(studentRow).join('')}</div>`
    : ''
}

${
  assignable.length
    ? `<div class="section-head"><h2>${t('Assign to a student')}</h2></div>
  <div class="card">
    <form method="post" action="/t/song/${esc(section.id)}/assign"
          style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
      <div class="field" style="flex:1;min-width:240px;margin-bottom:0">
        <label for="assign-student">${t('Student')}</label>
        <select id="assign-student" name="student_id" required>
          ${assignable.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}
        </select>
      </div>
      <button class="btn btn-primary" type="submit">${t('Assign')}</button>
    </form>
  </div>`
    : ''
}`,
    {
      title: section.title,
      user,
      siteName,
      nav: 'catalogue',
      visiting: d.visiting ?? null,
      scripts: d.dictate
        ? ['/player.js', '/recorder.js', '/dictate.js']
        : ['/player.js', '/recorder.js'],
    },
  );
}
