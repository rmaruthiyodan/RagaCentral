/* Recording in the browser — one big button, then cut out what you don't want.
 *
 * Capture uses MediaRecorder, which runs off the main thread and doesn't glitch.
 * But what it produces differs by browser — Chrome and Firefox give WebM/Opus,
 * Safari gives MP4/AAC — and Safari could not play WebM until 18.4. Since students
 * are on whatever phone they own, audio is decoded here, and that decoded audio
 * is what the editor shows: split it anywhere, remove pieces, listen to the
 * result. Only on Save is what's kept encoded to MP3 and uploaded. One format,
 * plays everywhere, and nothing that was cut ever leaves the phone.
 *
 * Video is left in whatever the browser produced: re-encoding (or cutting)
 * video in a page is not worth it, and video is the exception, not the rule.
 *
 * The markup and every word on screen come from views/recorder.ts.
 */

(function () {
  'use strict';

  var root = document.querySelector('.recorder');
  if (!root) return;

  var STUDENT = root.dataset.student;
  var SECTION = root.dataset.section;
  /* 160, not 96. A single voice is transparent enough either way at normal
     speed, but these are reference takes: a student slows one to 0.5x and
     loops a phrase, and that is exactly where 96 kbps smearing lands — in
     the same range as the gamaka detail they are listening for. 1.2 MB a
     minute instead of 0.7, against R2's free 10 GB, is a trade worth making.
     Raising this changes new recordings only; everything already uploaded
     stays as it was encoded. */
  var MP3_KBPS = 160;             // mono; ~1.2 MB per minute
  // One ceiling for every take, audio or video, recorded here or dropped in
  // as a file — the same number /api/recordings enforces server-side, so a
  // take that's allowed to finish here is never rejected once it arrives.
  var MAX_RECORD_SEC = 6 * 60;
  var MIN_PART = 0.15;            // seconds; no sliver of a part smaller than this
  var FADE = 0.008;               // seconds of fade at every cut, so joins don't click

  var S = {};
  try { S = JSON.parse(root.dataset.strings || '{}'); } catch (e) { S = {}; }
  function L(k, a) {
    var s = S[k] || k;
    return a === undefined ? s : s.replace('%s', a);
  }

  var $ = function (sel) { return root.querySelector(sel); };
  var stage = $('[data-stage]');
  var timerEl = $('[data-timer]');
  var waveEl = $('[data-wave]');
  var cam = $('[data-cam]');
  var kindBox = $('[data-kind]');
  var videoToggle = $('[data-video]');
  var live = $('[data-live]');
  var liveText = $('[data-live-text]');
  var big = $('[data-big]');
  var cancelBtn = $('[data-cancel]');
  var pauseBtn = $('[data-pause]');
  var pauseIcon = $('[data-pause-icon]');
  var pauseText = $('[data-pause-text]');
  var labelEl = $('[data-label]');
  var statusEl = $('[data-status]');
  var preview = $('[data-preview]');
  var doneStatus = $('[data-done-status]');
  var playerBox = $('[data-player]');
  var titleInput = $('[data-title]');
  var partInput = $('[data-part]');
  var descInput = $('[data-desc]');
  var saveBtn = $('[data-save]');
  var discardBtn = $('[data-discard]');
  var progress = $('[data-progress]');
  var progressFill = $('[data-progress-fill]');

  var PAUSE_SVG = pauseIcon ? pauseIcon.innerHTML : '';
  var RESUME_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="6"/></svg>';
  var PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>';
  var STOP_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  var TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';
  var UNDO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>';

  /* idle → asking → recording ⇄ paused → readying → done → (save | discard → idle) */
  var state = 'idle';
  var stream = null, recorder = null, chunks = [], ticker = null;
  var acc = 0, runStart = 0;      // ms recorded before the current run, and when this run began
  var throwAway = false;
  var audioCtx = null, analyser = null, meterRaf = null;
  var levels = [], lastPush = 0;
  var pending = null;             // { blob?, mime?, duration, kind, edit? }
  var lameLoading = null;

  function say(msg) {
    var el = preview.hidden ? statusEl : doneStatus;
    if (el) el.textContent = msg;
  }

  function fmt(t) {
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + String(s).padStart(2, '0');
  }
  function fmtTenths(t) {
    var m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }
  function css(name, fallback) {
    var v = getComputedStyle(root).getPropertyValue(name).trim();
    return v || fallback;
  }
  function elapsed() {
    return (acc + (state === 'recording' ? Date.now() - runStart : 0)) / 1000;
  }

  /* ---------------- the MP3 encoder, loaded only when needed ---------------- */

  function loadLame() {
    if (window.lamejs && window.lamejs.Mp3Encoder) return Promise.resolve();
    if (lameLoading) return lameLoading;
    lameLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/vendor/lame.min.js';
      s.onload = resolve;
      s.onerror = function () { lameLoading = null; reject(new Error('Could not load the MP3 encoder')); };
      document.head.appendChild(s);
    });
    return lameLoading;
  }

  /* ---------------- the live waveform ---------------- */

  function sizeCanvas(c) {
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return dpr;
  }

  function drawLive() {
    if (!waveEl || !waveEl.clientWidth) return;
    var dpr = sizeCanvas(waveEl);
    var g = waveEl.getContext('2d');
    var W = waveEl.width, H = waveEl.height;
    g.clearRect(0, 0, W, H);
    var bw = 3 * dpr, gap = 2 * dpr, step = bw + gap;
    var n = Math.floor((W + gap) / step);
    var shown = levels.length > n ? levels.slice(levels.length - n) : levels;
    var hot = css('--rx-red', '#D93025'), cold = css('--line-strong', '#C3C8D1');
    for (var i = 0; i < n; i++) {
      var x = i * step;
      if (i < shown.length) {
        var h = Math.max(3 * dpr, shown[i] * H);
        g.fillStyle = state === 'paused' ? cold : hot;
        roundBar(g, x, (H - h) / 2, bw, h);
      } else {
        g.fillStyle = cold;
        roundBar(g, x, (H - 3 * dpr) / 2, bw, 3 * dpr);
      }
    }
  }

  function roundBar(g, x, y, w, h) {
    var r = Math.min(w / 2, h / 2);
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h);
    g.fill();
  }

  function startMeter(srcStream) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var src = audioCtx.createMediaStreamSource(srcStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      var buf = new Float32Array(analyser.fftSize);
      var peak = 0;

      (function draw() {
        meterRaf = requestAnimationFrame(draw);
        if (state !== 'recording') return;
        if (analyser.getFloatTimeDomainData) analyser.getFloatTimeDomainData(buf);
        var p = 0;
        for (var i = 0; i < buf.length; i++) { var v = Math.abs(buf[i]); if (v > p) p = v; }
        if (p > peak) peak = p;
        var now = performance.now();
        if (now - lastPush >= 90) {
          // A square root, so a soft alaap still shows as more than a line.
          levels.push(Math.min(1, Math.sqrt(peak) * 1.15));
          peak = 0;
          lastPush = now;
          drawLive();
        }
      })();
    } catch (e) { /* the waveform is a nicety, not a requirement */ }
  }

  function stopMeter() {
    if (meterRaf) cancelAnimationFrame(meterRaf);
    meterRaf = null;
    if (audioCtx && audioCtx.state !== 'closed') audioCtx.close();
    audioCtx = null;
  }

  /* ---------------- the stage: what the big button looks like now ---------------- */

  function show() {
    var rec = state === 'recording', paused = state === 'paused', busy = state === 'asking' || state === 'readying';
    var going = rec || paused;
    kindBox.hidden = going || busy;
    live.hidden = !going;
    live.classList.toggle('paused', paused);
    liveText.textContent = paused ? L('paused') : L('recording');
    big.classList.toggle('stop', going);
    big.disabled = busy;
    big.setAttribute('aria-label', going ? L('tapToStop') : L('tapToRecord'));
    cancelBtn.hidden = !going;
    pauseBtn.hidden = !going || !(recorder && typeof recorder.pause === 'function');
    pauseIcon.innerHTML = paused ? RESUME_SVG : PAUSE_SVG;
    pauseText.textContent = paused ? L('resume') : L('pause');
    labelEl.textContent =
      state === 'asking' ? L('asking') :
      state === 'readying' ? L('readying') :
      going ? L('tapToStop') : L('tapToRecord');
    if (state === 'idle') statusEl.textContent = L('idleHint');
    else if (rec) statusEl.textContent = L('spaceHint');
    else if (paused) statusEl.textContent = L('pausedHint');
    drawLive();
  }

  function pickMime(wantVideo) {
    var candidates = wantVideo
      ? ['video/mp4;codecs=h264,aac', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < candidates.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  function start() {
    var wantVideo = !!(videoToggle && videoToggle.checked);
    var constraints = wantVideo
      ? { audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } }
      : { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } };

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      say('This browser cannot record here. Try the latest Safari or Chrome, or use Upload files.');
      return;
    }
    state = 'asking'; show();
    navigator.mediaDevices.getUserMedia(constraints).then(function (s) {
      stream = s;
      chunks = [];
      var mime = pickMime(wantVideo);
      try {
        recorder = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s);
      } catch (e) {
        recorder = new MediaRecorder(s);
      }
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = onCaptureStopped;
      recorder.start(1000);

      if (wantVideo && cam) {
        cam.hidden = false;
        cam.srcObject = s;
        var p = cam.play(); if (p && p.catch) p.catch(function () {});
      }
      acc = 0; runStart = Date.now(); throwAway = false;
      levels = []; lastPush = 0;
      state = 'recording';
      startMeter(s);
      show();

      ticker = setInterval(function () {
        var secs = elapsed();
        timerEl.textContent = fmt(secs);
        if (secs >= MAX_RECORD_SEC) {
          say('Reached the ' + (MAX_RECORD_SEC / 60) + '-minute limit — stopping.');
          stop();
        }
      }, 200);
    }).catch(function (err) {
      console.error(err);
      state = 'idle'; show();
      say(
        err && err.name === 'NotAllowedError'
          ? 'Microphone access was blocked. Allow it in your browser’s address bar, then try again.'
          : 'Could not start recording: ' + (err && err.message ? err.message : 'unknown error')
      );
    });
  }

  function stop() {
    if (state !== 'recording' && state !== 'paused') return;
    if (state === 'recording') acc += Date.now() - runStart;
    clearInterval(ticker);
    state = 'readying'; show();
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  big.addEventListener('click', function () {
    if (state === 'idle') start();
    else if (state === 'recording' || state === 'paused') stop();
  });

  pauseBtn.addEventListener('click', function () {
    if (!recorder) return;
    if (state === 'recording') {
      try { recorder.pause(); } catch (e) { return; }
      acc += Date.now() - runStart;
      state = 'paused';
    } else if (state === 'paused') {
      try { recorder.resume(); } catch (e) { return; }
      runStart = Date.now();
      state = 'recording';
    }
    show();
  });

  cancelBtn.addEventListener('click', function () {
    if (state !== 'recording' && state !== 'paused') return;
    if (elapsed() > 5 && !window.confirm(L('throwAway'))) return;
    throwAway = true;
    stop();
  });

  /* Space stops (or finishes a paused take) — but never while typing, and
     never starts one: a stray space on a long page shouldn't switch on the mic. */
  var spaceHandled = false;
  document.addEventListener('keydown', function (e) {
    if (e.key !== ' ' && e.code !== 'Space') return;
    if (state !== 'recording' && state !== 'paused') return;
    var t = e.target;
    // The recorder's own buttons count too: after tapping Pause, Space
    // should still stop, not quietly press Pause again.
    var ours = t && t.closest && stage.contains(t);
    if (!ours && t && t.closest && t.closest('input, textarea, select, button, a, [contenteditable]')) return;
    e.preventDefault();
    spaceHandled = true;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    stop();
  });
  // A button is pressed on the key's release, so swallow that too.
  document.addEventListener('keyup', function (e) {
    if (spaceHandled && (e.key === ' ' || e.code === 'Space')) { e.preventDefault(); spaceHandled = false; }
  });

  window.addEventListener('beforeunload', function (e) {
    if (state === 'recording' || state === 'paused' || pending) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  function releaseStream() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    stopMeter();
    if (cam) { cam.pause(); cam.srcObject = null; cam.hidden = true; }
  }

  function resetStage() {
    state = 'idle';
    recorder = null;
    levels = [];
    timerEl.textContent = '0:00';
    stage.hidden = false;
    preview.hidden = true;
    show();
  }

  function onCaptureStopped() {
    var wasVideo = !!(videoToggle && videoToggle.checked);
    var duration = acc / 1000;
    var raw = new Blob(chunks, { type: recorder.mimeType || (wasVideo ? 'video/webm' : 'audio/webm') });
    chunks = [];
    releaseStream();

    if (throwAway) { resetStage(); return; }

    if (wasVideo) {
      finishPlain(raw, raw.type, duration, 'video', L('videoNoCut'));
      return;
    }

    decode(raw).then(function (buffer) {
      pending = { kind: 'audio', edit: true, duration: buffer.duration };
      openDone();
      Editor.open(buffer);
    }).catch(function (err) {
      console.error(err);
      // Better to keep the take in its original format than lose it.
      finishPlain(raw, raw.type, duration, 'audio', L('noCut'));
    });
  }

  function openDone() {
    state = 'done';
    stage.hidden = true;
    preview.hidden = false;
    doneStatus.textContent = '';
    try { preview.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { preview.scrollIntoView(false); }
  }

  /* No editor: a player, the fields, Save. For video, and for audio the
     browser could not decode. */
  function finishPlain(blob, mime, duration, kind, note) {
    pending = { blob: blob, mime: mime, duration: duration, kind: kind };
    openDone();
    Editor.close();
    playerBox.innerHTML = '';
    var el = document.createElement(kind === 'video' ? 'video' : 'audio');
    el.controls = true;
    el.src = URL.createObjectURL(blob);
    if (kind === 'video') el.playsInline = true;
    playerBox.appendChild(el);
    say(note + ' ' + fmt(duration) + ', ' + (blob.size / 1048576).toFixed(1) + ' MB.');
  }

  /* ---------------- decode and downmix ---------------- */

  /* One mono AudioBuffer: what the editor draws, what it plays, and what is
     encoded on Save. Keeping it in an AudioBuffer (not a loose array) means
     playback needs no second copy of a six-minute take. */
  function decode(blob) {
    return blob.arrayBuffer()
      .then(function (buf) {
        var ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
        return new Promise(function (resolve, reject) {
          // Safari still wants the callback form.
          var p = ctx.decodeAudioData(buf, resolve, reject);
          if (p && p.then) p.then(resolve, reject);
        });
      })
      .then(function (ab) {
        if (ab.numberOfChannels === 1) return ab;
        var n = ab.length, ch = ab.numberOfChannels, mono;
        try {
          mono = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: ab.sampleRate });
        } catch (e) {
          mono = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, ab.sampleRate)
            .createBuffer(1, n, ab.sampleRate);
        }
        var out = mono.getChannelData(0);
        for (var c = 0; c < ch; c++) {
          var data = ab.getChannelData(c);
          for (var i = 0; i < n; i++) out[i] += data[i] / ch;
        }
        return mono;
      });
  }

  /* ================================================================
   * The editor: split anywhere, remove pieces, hear the result.
   *
   * The take is a list of parts, each { s, e, cut } in seconds, end to
   * end. Split cuts one part in two at the playhead; a part is either
   * kept or removed; the split lines can be dragged. Every change is
   * undoable. Nothing is thrown away until Save, when only what's kept
   * is encoded.
   * ================================================================ */
  var Editor = (function () {
    var box = $('[data-box]');
    if (!box) return { open: function () {}, close: function () {}, active: function () { return false; }, ranges: function () { return []; }, buffer: function () { return null; }, stopPlay: function () {} };
    var edit = $('[data-editor]');
    var canvas = $('[data-ewave]');
    var segsEl = $('[data-segs]');
    var headEl = $('[data-head]');
    var pop = $('[data-pop]');
    var popPlay = $('[data-pop-play]');
    var popSplit = $('[data-pop-split]');
    var popToggle = $('[data-pop-toggle]');
    var scaleEl = $('[data-scale]');
    var listEl = $('[data-list]');
    var playAll = $('[data-play-all]');
    var playAllText = $('[data-play-all-text]');
    var undoBtn = $('[data-undo]');
    var redoBtn = $('[data-redo]');

    var buffer = null, dur = 0, segs = [], sel = 0, head = 0;
    var past = [], future = [];
    var peaks = null, peaksN = 0;
    var ac = null, voices = [], plan = null, playMode = null, playSeg = -1, raf = 0;
    var drag = null;

    function active() { return !!buffer; }

    function open(b) {
      buffer = b; dur = b.duration;
      segs = [{ s: 0, e: dur, cut: false }];
      sel = 0; head = 0; past = []; future = []; peaks = null;
      edit.hidden = false;
      playerBox.innerHTML = '';
      // Whole seconds repeat themselves on a short take, so those get tenths.
      scaleEl.innerHTML = [0, 0.25, 0.5, 0.75, 1].map(function (f) {
        return '<span>' + (dur < 30 ? fmtTenths(dur * f) : fmt(dur * f)) + '</span>';
      }).join('');
      render();
    }

    function close() {
      stopPlay();
      buffer = null; peaks = null; segs = [];
      edit.hidden = true;
    }

    function kept() { return segs.filter(function (x) { return !x.cut; }); }
    function keptLen() { return kept().reduce(function (a, x) { return a + (x.e - x.s); }, 0); }
    function at(t) {
      for (var i = 0; i < segs.length; i++) if (t < segs[i].e) return i;
      return segs.length - 1;
    }
    function pct(t) { return (t / dur) * 100; }
    function name(i) { return i < 26 ? String.fromCharCode(65 + i) : String(i + 1); }

    function remember() {
      past.push(JSON.stringify(segs));
      if (past.length > 100) past.shift();
      future = [];
    }
    function restore(json) {
      segs = JSON.parse(json);
      sel = Math.min(sel, segs.length - 1);
    }

    /* ---------- drawing ---------- */

    function computePeaks(n) {
      var data = buffer.getChannelData(0), len = data.length;
      var per = len / n, out = new Float32Array(n), max = 0;
      var stride = Math.max(1, Math.floor(per / 1500));
      for (var i = 0; i < n; i++) {
        var a = Math.floor(i * per), b = Math.min(len, Math.floor((i + 1) * per)), p = 0;
        for (var j = a; j < b; j += stride) { var v = data[j]; if (v < 0) v = -v; if (v > p) p = v; }
        out[i] = p; if (p > max) max = p;
      }
      // Scaled to the loudest moment, so a quiet take still fills the box.
      if (max > 0) for (var k = 0; k < n; k++) out[k] = Math.sqrt(out[k] / max);
      return out;
    }

    function drawWave() {
      if (!buffer || !canvas.clientWidth) return;
      var dpr = sizeCanvas(canvas);
      var g = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
      var bw = 2.5 * dpr, gap = 1.5 * dpr, step = bw + gap;
      var n = Math.max(1, Math.floor((W + gap) / step));
      if (!peaks || peaksN !== n) { peaks = computePeaks(n); peaksN = n; }
      g.clearRect(0, 0, W, H);
      var on = css('--peacock', '#3B5566'), off = css('--line-strong', '#C3C8D1');
      for (var i = 0; i < n; i++) {
        var t = ((i + 0.5) / n) * dur;
        var seg = segs[at(t)];
        var h = Math.max(2 * dpr, peaks[i] * H * 0.96);
        g.fillStyle = seg && seg.cut ? off : on;
        roundBar(g, i * step, (H - h) / 2, bw, h);
      }
    }

    function placeHead() { headEl.style.left = pct(head) + '%'; }

    function placePop() {
      var s = segs[sel];
      if (!s) { pop.hidden = true; return; }
      pop.hidden = false;
      popToggle.className = s.cut ? 'k' : 'd';
      popToggle.innerHTML = (s.cut ? UNDO_SVG : TRASH_SVG) + '<span>' + (s.cut ? L('keep') : L('remove')) + '</span>';
      var playing = playMode === 'seg' && playSeg === sel;
      popPlay.innerHTML = (playing ? STOP_SVG : PLAY_SVG) + '<span>' + (playing ? L('pauseShort') : L('play')) + '</span>';
      var W = box.clientWidth, pw = pop.offsetWidth || 220;
      var cx = ((s.s + s.e) / 2 / dur) * W;
      var x = Math.max(pw / 2 + 2, Math.min(W - pw / 2 - 2, cx));
      pop.style.left = x + 'px';
      pop.style.setProperty('--arrow', Math.max(12, Math.min(pw - 12, pw / 2 + (cx - x))) + 'px');
    }

    function render() {
      if (!buffer) return;
      segsEl.innerHTML = segs.map(function (s, i) {
        return '<div class="rx-seg' + (s.cut ? ' cut' : '') + (i === sel ? ' sel' : '') + '" style="left:' + pct(s.s) + '%;width:' + pct(s.e - s.s) + '%">' +
          '<span class="rx-tag">' + name(i) + '</span></div>';
      }).join('') + segs.slice(1).map(function (s, i) {
        return '<div class="rx-split" data-split="' + (i + 1) + '" style="left:' + pct(s.s) + '%"></div>';
      }).join('');
      listEl.innerHTML = segs.map(function (s, i) {
        var playing = playMode === 'row' && playSeg === i;
        return '<div class="rx-li' + (s.cut ? ' cut' : '') + (i === sel ? ' sel' : '') + '" data-i="' + i + '">' +
          '<span class="rx-sw"></span>' +
          '<span class="txt" data-pick="' + i + '" aria-label="' + L('partOf', name(i)) + '"><b>' + name(i) + '</b>' + fmtTenths(s.s) + '–' + fmtTenths(s.e) + '</span>' +
          '<button type="button" class="rx-lplay' + (playing ? ' on' : '') + '" data-rowplay="' + i + '" aria-label="' + L('play') + ' ' + name(i) + '">' + (playing ? STOP_SVG : PLAY_SVG) + '</button>' +
          '<span class="rx-tog"><button type="button" data-keep="' + i + '" class="' + (s.cut ? '' : 'on') + '">' + L('keep') + '</button>' +
          '<button type="button" data-cut="' + i + '" class="' + (s.cut ? 'on x' : '') + '">' + (s.cut ? L('removed') : L('remove')) + '</button></span>' +
          '</div>';
      }).join('');
      playAllText.textContent = playMode === 'all' ? L('stopPlaying') : L('playResult', fmt(keptLen()));
      playAll.firstElementChild && (playAll.querySelector('svg').outerHTML = playMode === 'all' ? STOP_SVG : PLAY_SVG);
      undoBtn.disabled = !past.length;
      redoBtn.disabled = !future.length;
      drawWave();
      placeHead();
      placePop();
    }

    /* ---------- editing ---------- */

    function select(i) { sel = Math.max(0, Math.min(segs.length - 1, i)); }

    function split() {
      var i = at(head), s = segs[i];
      if (head - s.s < MIN_PART || s.e - head < MIN_PART) { say(L('tooShort')); return; }
      remember();
      segs.splice(i, 1, { s: s.s, e: head, cut: s.cut }, { s: head, e: s.e, cut: s.cut });
      select(i + 1);
      say('');
      render();
    }

    function setCut(i, cut) {
      if (!segs[i] || segs[i].cut === cut) { select(i); render(); return; }
      if (playMode) stopPlay();
      remember();
      segs[i].cut = cut;
      select(i);
      render();
    }

    function timeAt(clientX) {
      var r = box.getBoundingClientRect();
      return Math.max(0, Math.min(dur, ((clientX - r.left) / r.width) * dur));
    }

    box.addEventListener('pointerdown', function (e) {
      if (!buffer || e.button > 0) return;
      if (pop.contains(e.target)) return;
      var sp = e.target.closest && e.target.closest('[data-split]');
      if (sp) {
        var k = Number(sp.getAttribute('data-split'));
        drag = { k: k, el: sp, moved: false };
        sp.classList.add('drag');
        try { box.setPointerCapture(e.pointerId); } catch (err) {}
        e.preventDefault();
        return;
      }
      if (playMode) stopPlay();
      head = timeAt(e.clientX);
      select(at(head));
      render();
    });
    box.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var k = drag.k, t = timeAt(e.clientX);
      t = Math.max(segs[k - 1].s + MIN_PART, Math.min(segs[k].e - MIN_PART, t));
      if (!drag.moved) { remember(); drag.moved = true; if (playMode) stopPlay(); }
      segs[k - 1].e = segs[k].s = t;
      head = t;
      render();
      drag.el = segsEl.querySelector('[data-split="' + k + '"]');
      if (drag.el) drag.el.classList.add('drag');
    });
    function endDrag() {
      if (!drag) return;
      if (drag.el) drag.el.classList.remove('drag');
      drag = null;
      render();
    }
    box.addEventListener('pointerup', endDrag);
    box.addEventListener('pointercancel', endDrag);

    /* The keyboard, for anyone editing at a desk: arrows move the playhead,
       S splits, Delete removes (or brings back) the part, Space plays it. */
    box.addEventListener('keydown', function (e) {
      if (!buffer) return;
      var k = e.key;
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        var d = (e.shiftKey ? 1 : 0.1) * (k === 'ArrowLeft' ? -1 : 1);
        head = Math.max(0, Math.min(dur, head + d));
        select(at(head));
        render();
      } else if (k === 's' || k === 'S') {
        split();
      } else if (k === 'Delete' || k === 'Backspace') {
        setCut(sel, !segs[sel].cut);
      } else if (k === ' ') {
        togglePlay('seg', sel);
      } else return;
      e.preventDefault();
    });

    popSplit.addEventListener('click', split);
    popToggle.addEventListener('click', function () { setCut(sel, !segs[sel].cut); });
    popPlay.addEventListener('click', function () { togglePlay('seg', sel); });
    playAll.addEventListener('click', function () { togglePlay('all', -1); });
    undoBtn.addEventListener('click', function () {
      if (!past.length) return;
      stopPlay();
      future.push(JSON.stringify(segs));
      restore(past.pop());
      render();
    });
    redoBtn.addEventListener('click', function () {
      if (!future.length) return;
      stopPlay();
      past.push(JSON.stringify(segs));
      restore(future.pop());
      render();
    });
    listEl.addEventListener('click', function (e) {
      var b = e.target.closest('button, [data-pick]');
      if (!b) return;
      if (b.hasAttribute('data-keep')) setCut(Number(b.getAttribute('data-keep')), false);
      else if (b.hasAttribute('data-cut')) setCut(Number(b.getAttribute('data-cut')), true);
      else if (b.hasAttribute('data-rowplay')) togglePlay('row', Number(b.getAttribute('data-rowplay')));
      else if (b.hasAttribute('data-pick')) {
        var i = Number(b.getAttribute('data-pick'));
        if (playMode) stopPlay();
        select(i); head = segs[i].s; render();
      }
    });
    window.addEventListener('resize', function () { if (buffer) render(); });

    /* ---------- listening ---------- */

    function togglePlay(mode, i) {
      var same = playMode === mode && (mode === 'all' || playSeg === i);
      stopPlay();
      if (same) { render(); return; }
      var ranges;
      if (mode === 'all') {
        ranges = kept().map(function (x) { return [x.s, x.e]; });
        if (!ranges.length) { say(L('keepAll')); render(); return; }
      } else {
        var s = segs[i];
        // From the playhead if it sits inside this part, otherwise from its start.
        var from = mode === 'seg' && head > s.s && head < s.e - 0.05 ? head : s.s;
        ranges = [[from, s.e]];
      }
      play(ranges, mode, i);
    }

    function play(ranges, mode, i) {
      try {
        ac = ac || new (window.AudioContext || window.webkitAudioContext)();
        if (ac.state === 'suspended') ac.resume();
      } catch (e) { return; }
      var when = ac.currentTime + 0.05;
      plan = [];
      voices = ranges.map(function (r) {
        var len = r[1] - r[0];
        var src = ac.createBufferSource(), gain = ac.createGain();
        src.buffer = buffer;
        src.connect(gain); gain.connect(ac.destination);
        gain.gain.setValueAtTime(0, when);
        gain.gain.linearRampToValueAtTime(1, when + FADE);
        gain.gain.setValueAtTime(1, when + Math.max(FADE, len - FADE));
        gain.gain.linearRampToValueAtTime(0, when + len);
        src.start(when, r[0], len);
        plan.push({ at: when, s: r[0], e: r[1] });
        when += len;
        return src;
      });
      playMode = mode; playSeg = i;
      render();
      (function tick() {
        var now = ac.currentTime, last = plan[plan.length - 1];
        if (now >= last.at + (last.e - last.s)) { head = last.e; stopPlay(); render(); return; }
        for (var k = 0; k < plan.length; k++) {
          var p = plan[k];
          if (now < p.at + (p.e - p.s)) { head = Math.max(p.s, p.s + (now - p.at)); break; }
        }
        placeHead();
        raf = requestAnimationFrame(tick);
      })();
    }

    function stopPlay() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      voices.forEach(function (v) { try { v.stop(); } catch (e) {} });
      voices = [];
      var was = playMode;
      playMode = null; playSeg = -1;
      if (was && buffer) render();
    }

    return {
      open: open,
      close: close,
      active: active,
      stopPlay: stopPlay,
      buffer: function () { return buffer; },
      ranges: function () { return kept().map(function (x) { return [x.s, x.e]; }); },
      keptLen: keptLen,
      redraw: function () { if (buffer) render(); },
    };
  })();

  /* The recorder usually starts inside a closed panel, where the canvas has
     no size to draw into. Redraw whenever it gets one — opening the panel,
     switching tabs, turning the phone. */
  if (window.ResizeObserver) {
    new ResizeObserver(function () { drawLive(); Editor.redraw(); }).observe(root);
  }

  /* ---------------- encode only what is kept ---------------- */

  /* Walks the kept ranges one 1152-sample MP3 frame at a time, straight out
     of the decoded buffer — no second full-length copy — with a short fade
     either side of every cut so the joins don't click. Yields to the
     browser between blocks so the page stays responsive and the bar moves. */
  function encodeKept(buffer, ranges) {
    return loadLame().then(function () {
      return new Promise(function (resolve, reject) {
        var rate = buffer.sampleRate, data = buffer.getChannelData(0), total = data.length;
        var enc;
        try { enc = new window.lamejs.Mp3Encoder(1, rate, MP3_KBPS); } catch (e) { reject(e); return; }
        var fadeN = Math.max(1, Math.round(rate * FADE));
        var rs = ranges.map(function (r) {
          return { a: Math.max(0, Math.round(r[0] * rate)), b: Math.min(total, Math.round(r[1] * rate)) };
        }).filter(function (r) { return r.b > r.a; });
        var all = rs.reduce(function (n, r) { return n + (r.b - r.a); }, 0);
        var FRAME = 1152, PER_TICK = FRAME * 80;
        var frame = new Int16Array(FRAME), out = [], done = 0, ri = 0, pos = rs.length ? rs[0].a : 0;
        progress.classList.add('on');

        function sample() {
          var r = rs[ri], v = data[pos];
          if (r.a > 0 && pos - r.a < fadeN) v *= (pos - r.a) / fadeN;
          if (r.b < total && r.b - pos <= fadeN) v *= (r.b - pos - 1) / fadeN;
          v = v > 1 ? 1 : v < -1 ? -1 : v;
          pos++;
          if (pos >= r.b) { ri++; if (ri < rs.length) pos = rs[ri].a; }
          return v < 0 ? v * 0x8000 : v * 0x7fff;
        }

        function step() {
          try {
            var budget = PER_TICK;
            while (ri < rs.length && budget > 0) {
              var n = 0;
              while (n < FRAME && ri < rs.length) frame[n++] = sample();
              var mp3 = enc.encodeBuffer(n === FRAME ? frame : frame.subarray(0, n));
              if (mp3.length) out.push(new Int8Array(mp3));
              done += n; budget -= n;
            }
          } catch (e) { progress.classList.remove('on'); reject(e); return; }
          progressFill.style.width = Math.round((done / Math.max(1, all)) * 100) + '%';
          if (ri < rs.length) { setTimeout(step, 0); return; }
          var tail = enc.flush();
          if (tail.length) out.push(new Int8Array(tail));
          progress.classList.remove('on');
          progressFill.style.width = '0%';
          resolve({ blob: new Blob(out, { type: 'audio/mpeg' }), duration: all / rate });
        }
        step();
      });
    });
  }

  /* ---------------- saving ---------------- */

  discardBtn.addEventListener('click', function () {
    Editor.close();
    pending = null;
    playerBox.innerHTML = '';
    titleInput.value = '';
    if (partInput) partInput.value = '';
    if (descInput) descInput.value = '';
    resetStage();
  });

  /* Every recording carries a name, so this is the one field that gates Save. */
  saveBtn.addEventListener('click', function () {
    if (!pending) return;
    if (!titleInput.value.trim()) {
      titleInput.focus();
      titleInput.classList.add('needs-value');
      say('Give this take a name first — "Pallavi, slow" is enough.');
      return;
    }
    titleInput.classList.remove('needs-value');

    var ready;
    if (pending.edit && Editor.active()) {
      var ranges = Editor.ranges();
      if (!ranges.length) { say(L('keepAll')); return; }
      Editor.stopPlay();
      say(L('encoding'));
      ready = encodeKept(Editor.buffer(), ranges).then(function (r) {
        return { blob: r.blob, mime: 'audio/mpeg', duration: r.duration, kind: 'audio' };
      });
    } else {
      ready = Promise.resolve(pending);
    }

    saveBtn.disabled = true;
    discardBtn.disabled = true;
    ready.then(function (take) {
      var fd = new FormData();
      var ext = take.mime.indexOf('mp4') > -1 ? 'mp4' : take.mime.indexOf('mpeg') > -1 ? 'mp3' : 'webm';
      fd.append('file', take.blob, 'take.' + ext);
      if (STUDENT) fd.append('student_id', STUDENT);
      fd.append('section_id', SECTION);
      fd.append('title', titleInput.value.trim());
      if (partInput) fd.append('part', partInput.value.trim());
      if (descInput) fd.append('description', descInput.value.trim());
      fd.append('kind', take.kind);
      fd.append('duration_sec', String(Math.round(take.duration)));
      fd.append('source', 'recorded');
      addAudience(fd);

      say('Saving…');
      return upload(fd, function (pct) { progress.classList.add('on'); progressFill.style.width = pct + '%'; });
    }).then(function () {
      pending = null;
      window.location.reload();
    }).catch(function (err) {
      console.error(err);
      progress.classList.remove('on');
      saveBtn.disabled = false;
      discardBtn.disabled = false;
      say(err && err.message ? err.message : 'Could not save that take. Please try again.');
    });
  });

  show();

  /* Who the new recording is for. The picker sits above the record and upload
     panels and is shared by both; with no picker on the page, nothing is sent
     and the server files it as shared with everyone learning the song. */
  function addAudience(fd) {
    var picker = document.querySelector('[data-audience]');
    if (!picker) return;
    var mode = picker.querySelector('input[name="visibility"]:checked');
    if (!mode || mode.value !== 'chosen') return;
    var ticked = picker.querySelectorAll('input[name="share_ids"]:checked');
    if (!ticked.length) return; // nobody ticked means everyone, same as the server
    fd.append('visibility', 'chosen');
    for (var i = 0; i < ticked.length; i++) fd.append('share_ids', ticked[i].value);
  }

  /* XHR rather than fetch, purely because it reports upload progress. */
  function upload(formData, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/recordings');
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        var msg = 'Upload failed.';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch (e) {}
        reject(new Error(msg));
      };
      xhr.onerror = function () { reject(new Error('Network error while uploading.')); };
      xhr.send(formData);
    });
  }

  /* ---------------- file uploads ---------------- */

  /* How long a dropped-in file runs, read from the file itself rather than
     guessed from its size — an upload's bitrate is unknown, so size alone
     can't stand in for duration the way it can for browser-recorded MP3.
     An offscreen <audio>/<video> element loading only its metadata is the
     cheapest way to ask the browser. Some files (a webm with no duration in
     its header is the common case) come back as Infinity or NaN; those are
     resolved as null rather than guessed at, and the server lets an unknown
     duration through rather than blocking a file it can't itself measure. */
  function probeDuration(file) {
    return new Promise(function (resolve) {
      var isVideo = file.type.indexOf('video/') === 0;
      var el = document.createElement(isVideo ? 'video' : 'audio');
      el.preload = 'metadata';
      var url = URL.createObjectURL(file);
      var settle = function (secs) {
        URL.revokeObjectURL(url);
        el.removeAttribute('src');
        resolve(secs);
      };
      el.onloadedmetadata = function () {
        settle(isFinite(el.duration) && el.duration > 0 ? el.duration : null);
      };
      el.onerror = function () { settle(null); };
      el.src = url;
    });
  }

  var drop = document.querySelector('[data-drop]');
  if (drop) {
    var fileInput = drop.querySelector('[data-file]');
    var queue = document.querySelector('[data-queue]');

    drop.addEventListener('click', function () { fileInput.click(); });
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      drop.classList.remove('over');
      handleFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', function () { handleFiles(fileInput.files); });

    function handleFiles(files) {
      var list = Array.prototype.slice.call(files);
      if (!list.length) return;
      queue.innerHTML = '';
      var items = list.map(function (f) {
        var el = document.createElement('div');
        el.className = 'qitem';
        el.innerHTML =
          '<span class="qname"></span><span class="qsize"></span><span class="qstate">waiting</span>';
        el.querySelector('.qname').textContent = f.name;
        el.querySelector('.qsize').textContent = (f.size / 1048576).toFixed(1) + ' MB';
        queue.appendChild(el);
        return el;
      });

      var i = 0;
      (function next() {
        if (i >= list.length) { window.location.reload(); return; }
        var file = list[i];
        var el = items[i];
        var state = el.querySelector('.qstate');
        state.textContent = 'checking…';

        probeDuration(file).then(function (secs) {
          // Caught here, the file never leaves the browser — the same limit
          // the server would apply, just without the wait. A length that
          // couldn't be read is sent up and left for the server to decide.
          if (secs !== null && secs > MAX_RECORD_SEC) {
            state.textContent = 'too long — over ' + (MAX_RECORD_SEC / 60) + ' min, not uploaded';
            i++; next();
            return;
          }

          state.textContent = 'uploading…';
          var fd = new FormData();
          fd.append('file', file, file.name);
          if (drop.dataset.student) fd.append('student_id', drop.dataset.student);
          fd.append('section_id', drop.dataset.section);
          fd.append('title', file.name.replace(/\.[^.]+$/, ''));
          fd.append('kind', file.type.indexOf('video/') === 0 ? 'video' : 'audio');
          fd.append('source', 'upload');
          if (secs !== null) fd.append('duration_sec', String(Math.round(secs)));
          addAudience(fd);

          upload(fd, function (pct) { state.textContent = pct + '%'; })
            .then(function () { state.textContent = 'saved'; i++; next(); })
            .catch(function (err) { state.textContent = err.message; i++; next(); });
        });
      })();
    }
  }

  /* ---------------- paste an image straight into a note ---------------- */

  document.querySelectorAll('form textarea[name="body"]').forEach(function (ta) {
    ta.addEventListener('paste', function (e) {
      var items = (e.clipboardData || {}).items || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image/') === 0) {
          var file = items[i].getAsFile();
          var input = ta.closest('form').querySelector('input[type="file"]');
          if (input && file) {
            var dt = new DataTransfer();
            dt.items.add(file);
            input.files = dt.files;
            var hint = document.createElement('p');
            hint.className = 'hint';
            hint.textContent = 'Image attached from clipboard — save the note to keep it.';
            input.parentNode.appendChild(hint);
            e.preventDefault();
          }
          break;
        }
      }
    });
  });
})();
