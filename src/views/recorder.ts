/* ==================================================================
 * The recorder — one big button, then an editor to cut parts out.
 *
 * Used on the song page (teacher) and on a student's page for a song
 * (teacher or student). public/recorder.js does the work; this is only
 * the markup it expects, plus the words it shows, which go through t()
 * here so they come out in Malayalam too (the script itself has no
 * dictionary).
 *
 * Nothing works without the script, so the stage starts as it will look
 * before the first tap, and the editor is hidden until a take exists.
 * ================================================================== */

import { esc } from '../util';
import { t } from '../i18n';

export interface RecorderOpts {
  /** Empty on the song page: the recording belongs to the song, not a student. */
  studentId: string;
  sectionId: string;
  /** The song page also asks for a part and a description. */
  full: boolean;
}

const ICON = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg>',
  cut: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.5 8.5L20 20M8.5 15.5L20 4"/></svg>',
};

export function recorderPanel(o: RecorderOpts): string {
  /* Everything the script writes on screen. JSON in an attribute, so the
     one esc() below is all the escaping it needs. */
  const strings = {
    tapToRecord: t('Tap to record'),
    tapToStop: t('Tap the square to stop'),
    asking: t('Allow the microphone when your browser asks'),
    recording: t('Recording'),
    paused: t('Paused'),
    pause: t('Pause'),
    resume: t('Resume'),
    discard: t('Discard'),
    readying: t('Getting your take ready…'),
    spaceHint: t('Space bar also stops · nothing is saved until you choose to'),
    pausedHint: t('Paused — tap Resume to carry on, or the square to finish'),
    idleHint: t('Saved as MP3 so it plays on every phone · up to %s minutes', 6),
    throwAway: t('Throw this take away?'),
    keep: t('Keep'),
    remove: t('Remove'),
    removed: t('Removed'),
    play: t('Play'),
    pauseShort: t('Stop'),
    playResult: t('Play the result · %s'),
    stopPlaying: t('Stop playing'),
    split: t('Split'),
    keepAll: t('Keep at least one part — or Discard the whole take.'),
    tooShort: t('Too close to the edge of a part to split there.'),
    partOf: t('Part %s'),
    videoNoCut: t('Cutting parts out works on audio takes. This video is saved as it is.'),
    noCut: t('This take could not be opened for cutting, so it is saved as recorded.'),
    encoding: t('Preparing the MP3…'),
  };

  return `<div class="recorder rx" data-student="${esc(o.studentId)}" data-section="${esc(o.sectionId)}"
     data-strings="${esc(JSON.stringify(strings))}">
  <div class="rx-stage" data-stage>
    <div class="rx-top">
      <div class="rx-kind" role="radiogroup" aria-label="${esc(t('What to record'))}" data-kind>
        <label><input type="radio" name="rx-kind" value="audio" checked><span>${ICON.mic} ${t('Audio')}</span></label>
        <label><input type="radio" name="rx-kind" value="video" data-video><span>${ICON.cam} ${t('Video')}</span></label>
      </div>
      <div class="rx-live" data-live hidden><i></i><span data-live-text>${t('Recording')}</span></div>
    </div>
    <video class="rx-cam" data-cam muted playsinline hidden></video>
    <div class="rx-time"><span data-timer>0:00</span><small>/ 6:00</small></div>
    <canvas class="rx-wave" data-wave aria-hidden="true"></canvas>
    <div class="rx-ctrls">
      <button type="button" class="rx-side" data-cancel hidden>
        <span class="rx-c">${ICON.trash}</span><span>${t('Discard')}</span></button>
      <button type="button" class="rx-big" data-big aria-label="${esc(t('Tap to record'))}"><span></span></button>
      <button type="button" class="rx-side" data-pause hidden>
        <span class="rx-c" data-pause-icon>${ICON.pause}</span><span data-pause-text>${t('Pause')}</span></button>
    </div>
    <div class="rx-label" data-label>${t('Tap to record')}</div>
    <p class="rx-hint rec-status" data-status>${t('Saved as MP3 so it plays on every phone · up to %s minutes', 6)}</p>
  </div>

  <div class="rx-done" data-preview hidden>
    <div class="rx-edit" data-editor hidden>
      <div class="rx-edit-head">
        <h3>${t('Cut out any part')}</h3>
        <span class="muted">${t('Tap the waveform to move the playhead, Split there, then remove the pieces you don’t want. Drag a split line to fine-tune it.')}</span>
      </div>
      <div class="rx-box" data-box tabindex="0" aria-label="${esc(t('Waveform — tap to move the playhead'))}">
        <canvas data-ewave aria-hidden="true"></canvas>
        <div class="rx-segs" data-segs></div>
        <div class="rx-head" data-head></div>
        <div class="rx-pop" data-pop hidden>
          <button type="button" data-pop-play>${ICON.play}<span>${t('Play')}</span></button>
          <button type="button" data-pop-split>${ICON.cut}<span>${t('Split')}</span></button>
          <button type="button" class="d" data-pop-toggle>${ICON.trash}<span>${t('Remove')}</span></button>
        </div>
      </div>
      <div class="rx-scale" data-scale></div>
      <div class="rx-list" data-list></div>
      <div class="btn-row rx-tools">
        <button class="btn btn-primary rx-ib" type="button" data-play-all>${ICON.play}<span data-play-all-text></span></button>
        <button class="btn btn-quiet rx-ib" type="button" data-undo disabled>${ICON.undo}<span>${t('Undo')}</span></button>
        <button class="btn btn-quiet rx-ib" type="button" data-redo disabled>${ICON.redo}<span>${t('Redo')}</span></button>
      </div>
    </div>
    <div data-player></div>
    <div class="rx-fields">
      ${
        o.full
          ? `<div class="field-row">
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
      </div>`
          : `<div class="field">
        <label for="rec-title">${t('Name this take')}</label>
        <input id="rec-title" type="text" data-title placeholder="${esc(t('Pallavi, slow'))}">
      </div>`
      }
      <div class="btn-row">
        <button class="btn btn-primary" type="button" data-save>${t('Save recording')}</button>
        <button class="btn btn-quiet" type="button" data-discard>${t('Discard')}</button>
      </div>
      <p class="rec-status" data-done-status></p>
      <div class="progress" data-progress><div class="progress-fill" data-progress-fill></div></div>
    </div>
  </div>
</div>`;
}
