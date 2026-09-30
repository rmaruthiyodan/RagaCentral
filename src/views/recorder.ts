/* ==================================================================
 * The recorder — one big button — and the editor for cutting parts
 * out of a recording once it has been saved.
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

import { esc, escConfirm, fmtBytes } from '../util';
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
    readyHint: t('Take ready — listen back, name it and save. To cut parts out, use Edit audio on the recording once it is saved.'),
    videoHint: t('Video ready — name it and save.'),
    noMp3: t('Could not convert this take to MP3, so it is saved in the browser’s own format.'),
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

/**
 * The editor, once per page, as a <template>: audio-edit.js copies it
 * under whichever recording's "Edit audio" was pressed.
 */
export function audioEditorTemplate(): string {
  const strings = {
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
    loading: t('Opening the recording…'),
    cantOpen: t('This recording could not be opened for editing in this browser.'),
    nothingCut: t('Nothing has changed yet. Remove a part, or use the Advanced settings.'),
    replaceConfirm: t('Save these changes? The recording before this edit is kept as a second copy until you choose which one to keep.'),
    encoding: t('Preparing the MP3…'),
    saving: t('Saving…'),
    savedMsg: t('Changes saved. The original is kept as a second copy — choose which one to keep, on the recording.'),
    playChanged: t('Play with changes · %s'),
    applying: t('Applying the changes… %s%'),
    fxFailed: t('The sound changes could not be applied in this browser.'),
    off: t('Off'),
    noiseAuto: t('Automatic — the quietest moments'),
    nOn: t('%s on'),
    showAll: t('Show all controls'),
    hideAll: t('Hide controls'),
    noChanges: t('No sound changes yet'),
    chipEven: t('Even volume'),
    chipFadeIn: t('Fade in %s'),
    chipFadeOut: t('Fade out %s'),
    chipNoise: t('Noise %s'),
    chipEcho: t('Echo %s'),
    chipRumble: t('Rumble'),
    chipHum: t('Hum %s Hz'),
    chipRoom: t('Room reverb %s'),
    chipHall: t('Hall reverb %s'),
    chipTemple: t('Temple reverb %s'),
    noisePicked: t('The stretch you picked'),
    saveFailed: t('Could not save the edited recording. Please try again.'),
    offline: t('Could not reach the site to save. Check the connection and try again.'),
  };
  /** A row of choices where a dropdown would hide them — fades, hum, the room. */
  const seg = (k: string, opts: [string, string][]) =>
    `<div class="fx-seg" role="group" data-fx-seg="${k}">${opts
      .map(([v, label]) => `<button type="button" data-v="${esc(v)}" aria-pressed="false">${label}</button>`)
      .join('')}</div>`;
  /** One tool: a switch, its name, what it's for in three words, and its value. */
  const head = (o: { id: string; label: string; sub: string; toggle?: string; val?: string }) => `
          <div class="fx-row-head">
            ${o.toggle ? `<label class="fx-switch"><input type="checkbox" data-fx-toggle="${o.toggle}" aria-label="${esc(o.label)}"><span></span></label>` : ''}
            <label class="fx-name" for="${o.id}">${o.label}<small>${o.sub}</small></label>
            ${o.val ? `<output class="fx-val" ${o.val}></output>` : ''}
          </div>`;
  return `<template id="rx-edit-tpl" data-strings="${esc(JSON.stringify(strings))}">
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
      <button class="btn rx-ib" type="button" data-play-all>${ICON.play}<span data-play-all-text></span></button>
      <button class="btn btn-quiet rx-ib" type="button" data-undo disabled>${ICON.undo}<span>${t('Undo')}</span></button>
      <button class="btn btn-quiet rx-ib" type="button" data-redo disabled>${ICON.redo}<span>${t('Redo')}</span></button>
      <span class="rx-ab" data-ab-wrap hidden role="group" aria-label="${esc(t('Which version plays'))}">
        <button type="button" data-ab="before" aria-pressed="false">${t('Original')}</button>
        <button type="button" data-ab="after" aria-pressed="true">${t('With changes')}</button>
      </span>
    </div>

    <details class="rx-adv" open>
      <summary>
        <span class="fx-sum-t">${t('Sound')}</span>
        <span class="fx-sum-s">${t('Start from a preset, then fine-tune if you like')}</span>
        <span class="fx-on" data-fx-on hidden>${t('on')}</span>
      </summary>
      <div class="rx-adv-body" data-fx-panel>
        <div class="fx-presets" role="group" aria-label="${esc(t('Presets'))}">
          ${[
            ['none', t('As recorded'), t('No sound changes')],
            ['clean', t('Clean voice'), t('Less background noise and rumble, even volume')],
            ['quiet', t('Quiet room'), t('Stronger noise and echo reduction for a busy home')],
            ['concert', t('Concert feel'), t('Even volume with a touch of hall reverb')],
          ]
            .map(
              ([k, name, what]) =>
                `<button type="button" class="fx-preset" data-fx-preset="${k}" aria-pressed="false"><b>${name}</b><span>${what}</span></button>`,
            )
            .join('')}
        </div>
        <div class="fx-fine">
          <span class="fx-fine-t">${t('Fine-tune')}</span>
          <span class="fx-chips" data-fx-chips></span>
          <button type="button" class="fx-more" data-fx-more aria-expanded="false"></button>
        </div>
        <div class="fx-all" data-fx-all hidden>
        <section class="fx-mod">
          <h4>${t('Volume')}</h4>
          <div class="fx-row">
            <div class="fx-row-head">
              <span class="fx-part" data-fx-part>A</span>
              <label class="fx-name" for="fx-gain">${t('Selected part')}<small>${t('Pick a part on the waveform')}</small></label>
              <output class="fx-val" data-fx-gain-val>0 dB</output>
              <button type="button" class="fx-icon" data-fx-gain-reset title="${esc(t('Reset this part'))}" aria-label="${esc(t('Reset this part'))}">${ICON.undo}</button>
            </div>
            <input id="fx-gain" class="fx-range fx-center" type="range" min="-12" max="12" step="1" value="0" data-fx-gain>
            <div class="fx-scale"><span>−12</span><span>0</span><span>+12 dB</span></div>
          </div>
          <div class="fx-row">
            ${head({ id: 'fx-norm', label: t('Even out the volume'), sub: t('A steady, standard level'), toggle: 'normalize' })}
          </div>
          <div class="fx-row">
            <div class="fx-row-head"><span class="fx-name">${t('Fade in')}</span></div>
            ${seg('fadeIn', [['0', t('Off')], ['0.5', '0.5s'], ['1', '1s'], ['2', '2s'], ['3', '3s']])}
          </div>
          <div class="fx-row">
            <div class="fx-row-head"><span class="fx-name">${t('Fade out')}</span></div>
            ${seg('fadeOut', [['0', t('Off')], ['0.5', '0.5s'], ['1', '1s'], ['2', '2s'], ['3', '3s']])}
          </div>
        </section>

        <section class="fx-mod">
          <h4>${t('Clean up')}</h4>
          <div class="fx-row" data-fx-row="noise">
            ${head({ id: 'fx-noise', label: t('Background noise'), sub: t('Fans, fridges, cookers'), toggle: 'noise', val: 'data-fx-val="noise"' })}
            <input id="fx-noise" class="fx-range" type="range" min="5" max="100" step="5" value="40" data-fx="noise">
            <label class="fx-from">${t('Learn from')}
              <select data-fx="noiseFrom"><option value="auto">${t('Automatic — the quietest moments')}</option></select></label>
          </div>
          <div class="fx-row" data-fx-row="echo">
            ${head({ id: 'fx-echo', label: t('Room echo'), sub: t('Quietens the pauses'), toggle: 'echo', val: 'data-fx-val="echo"' })}
            <input id="fx-echo" class="fx-range" type="range" min="5" max="100" step="5" value="30" data-fx="echo">
          </div>
          <div class="fx-row">
            ${head({ id: 'fx-rumble', label: t('Rumble'), sub: t('Traffic, fans, bumps'), toggle: 'rumble' })}
          </div>
          <div class="fx-row">
            <div class="fx-row-head"><span class="fx-name">${t('Electrical hum')}<small>${t('50 Hz in India, UK, Gulf · 60 Hz in the USA')}</small></span></div>
            ${seg('hum', [['0', t('Off')], ['50', '50 Hz'], ['60', '60 Hz']])}
          </div>
        </section>

        <section class="fx-mod">
          <h4>${t('Reverb')}</h4>
          <div class="fx-row">
            <div class="fx-row-head"><span class="fx-name">${t('Space')}<small>${t('A sense of space around the voice')}</small></span></div>
            ${seg('reverb', [['none', t('None')], ['room', t('Room')], ['hall', t('Hall')], ['temple', t('Temple')]])}
          </div>
          <div class="fx-row" data-fx-row="reverbAmt">
            ${head({ id: 'fx-rv', label: t('Amount'), sub: t('A little goes a long way'), val: 'data-fx-val="reverbAmt"' })}
            <input id="fx-rv" class="fx-range" type="range" min="5" max="100" step="5" value="30" data-fx="reverbAmt">
          </div>
        </section>

        <div class="fx-foot">
          <span class="muted">${t('Steady noise and pauses clean up well; a voice or clatter during singing can’t be separated from it. Nothing changes until you save.')}</span>
          <button type="button" class="btn btn-sm btn-quiet" data-fx-reset>${t('Reset all')}</button>
        </div>
        </div>
      </div>
    </details>
  </div>
  <div class="btn-row rx-edit-actions">
    <button class="btn btn-primary" type="button" data-edit-save>${t('Save changes')}</button>
    <button class="btn btn-quiet" type="button" data-edit-cancel>${t('Cancel')}</button>
  </div>
  <p class="rec-status" data-edit-status></p>
  <div class="progress" data-progress><div class="progress-fill" data-progress-fill></div></div>
</template>`;
}

/** The button that opens it, for an audio recording this person may edit. */
export function editAudioButton(r: { id: string; r2_key: string }): string {
  return `<button type="button" class="btn btn-sm" data-edit-audio="${esc(r.id)}" data-src="${esc(mediaSrc(r))}"
    aria-expanded="false">${t('Edit audio')}</button>`;
}

/**
 * Where a recording plays from. The file behind /media/:id changes when it
 * is edited, and the browser keeps /media/:id for an hour — so the URL
 * carries a short fingerprint of the stored key, and an edited recording
 * gets a new one.
 */
export function mediaSrc(r: { id: string; r2_key: string }): string {
  return `/media/${r.id}?v=${fingerprint(r.r2_key)}`;
}

function fingerprint(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * An edited recording that still has its pre-edit copy: say so plainly,
 * let them hear the original, and ask them to keep one of the two.
 */
export function twoCopiesNotice(
  r: { id: string; r2_key: string; original_r2_key?: string | null; original_size?: number | null },
  back: string,
): string {
  if (!r.original_r2_key) return '';
  const size = r.original_size ? fmtBytes(r.original_size) : '';
  return `<div class="rx-copies" role="note">
  <div class="rx-copies-head"><strong>${t('Edited — two copies for now')}</strong>
    <span class="muted">${
      size
        ? t('The original (%s) is kept as a separate copy so the edit can be undone. Keep just one of them.', esc(size))
        : t('The original is kept as a separate copy so the edit can be undone. Keep just one of them.')
    }</span></div>
  <div class="rx-copies-orig">
    <span class="ctrl-label">${t('Original')}</span>
    <audio controls preload="none" src="/media/${esc(r.id)}?original=1&amp;v=${esc(fingerprint(r.original_r2_key))}"></audio>
  </div>
  <div class="btn-row">
    <form method="post" action="/recordings/${esc(r.id)}/original"
      onsubmit="return confirm('${escConfirm(t('Keep the edited version and delete the original copy? This cannot be undone.'))}')">
      <input type="hidden" name="action" value="keep"><input type="hidden" name="back" value="${esc(back)}">
      <button class="btn btn-sm btn-primary" type="submit">${t('Keep the edited version')}</button></form>
    <form method="post" action="/recordings/${esc(r.id)}/original"
      onsubmit="return confirm('${escConfirm(t('Go back to the original and delete the edited copy? This cannot be undone.'))}')">
      <input type="hidden" name="action" value="restore"><input type="hidden" name="back" value="${esc(back)}">
      <button class="btn btn-sm" type="submit">${t('Restore the original')}</button></form>
  </div>
</div>`;
}

/** The little tag in a recording's heading while it has two copies. */
export function twoCopiesPill(r: { original_r2_key?: string | null }): string {
  return r.original_r2_key ? `<span class="pill p-warn">${t('Edited · 2 copies')}</span>` : '';
}
