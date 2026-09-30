/* Recording in the browser — one big button.
 *
 * Capture uses MediaRecorder, which runs off the main thread and doesn't glitch.
 * But what it produces differs by browser — Chrome and Firefox give WebM/Opus,
 * Safari gives MP4/AAC — and Safari could not play WebM until 18.4. Since students
 * are on whatever phone they own, audio is decoded and re-encoded to MP3 here
 * (with audio-edit.js, which must load first) before it's uploaded. One
 * format, plays everywhere.
 *
 * A take is saved whole: stop, name it, save. Cutting parts out comes
 * afterwards, from "Edit audio" on the saved recording — see audio-edit.js.
 *
 * Video is left in whatever the browser produced: re-encoding video in a page
 * is not worth it, and video is the exception rather than the rule.
 *
 * The markup and every word on screen come from views/recorder.ts.
 */

(function () {
  'use strict';

  var root = document.querySelector('.recorder');
  if (!root) return;

  var STUDENT = root.dataset.student;
  var SECTION = root.dataset.section;
  var A = window.SrutiAudio; // decode + MP3 encoder, from audio-edit.js
  // One ceiling for every take, audio or video, recorded here or dropped in
  // as a file — the same number /api/recordings enforces server-side, so a
  // take that's allowed to finish here is never rejected once it arrives.
  var MAX_RECORD_SEC = 6 * 60;

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

  /* idle → asking → recording ⇄ paused → readying → done → (save | discard → idle) */
  var state = 'idle';
  var stream = null, recorder = null, chunks = [], ticker = null;
  var acc = 0, runStart = 0;      // ms recorded before the current run, and when this run began
  var throwAway = false;
  var audioCtx = null, analyser = null, meterRaf = null;
  var levels = [], lastPush = 0;
  var pending = null;             // { blob, mime, duration, kind }

  function say(msg) {
    var el = preview.hidden ? statusEl : doneStatus;
    if (el) el.textContent = msg;
  }

  function fmt(t) {
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + String(s).padStart(2, '0');
  }
  function css(name, fallback) {
    var v = getComputedStyle(root).getPropertyValue(name).trim();
    return v || fallback;
  }
  function elapsed() {
    return (acc + (state === 'recording' ? Date.now() - runStart : 0)) / 1000;
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
      finishPlain(raw, raw.type, duration, 'video', L('videoHint'));
      return;
    }

    if (!A) { finishPlain(raw, raw.type, duration, 'audio', L('noMp3')); return; }
    A.decode(raw).then(function (buffer) {
      return A.encodeKept(buffer, [[0, buffer.duration]], function (p) {
        labelEl.textContent = L('readying') + ' ' + p + '%';
      });
    }).then(function (mp3) {
      finishPlain(mp3.blob, 'audio/mpeg', mp3.duration, 'audio', L('readyHint'));
    }).catch(function (err) {
      console.error(err);
      // Better to keep the take in its original format than lose it.
      finishPlain(raw, raw.type, duration, 'audio', L('noMp3'));
    });
  }

  function openDone() {
    state = 'done';
    stage.hidden = true;
    preview.hidden = false;
    doneStatus.textContent = '';
    try { preview.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { preview.scrollIntoView(false); }
  }

  /* The take, ready to name and save: a player to check it, the fields, Save. */
  function finishPlain(blob, mime, duration, kind, note) {
    pending = { blob: blob, mime: mime, duration: duration, kind: kind };
    openDone();
    playerBox.innerHTML = '';
    var el = document.createElement(kind === 'video' ? 'video' : 'audio');
    el.controls = true;
    el.src = URL.createObjectURL(blob);
    if (kind === 'video') el.playsInline = true;
    playerBox.appendChild(el);
    say(note + ' ' + fmt(duration) + ', ' + (blob.size / 1048576).toFixed(1) + ' MB.');
  }

  /* The recorder usually starts inside a closed panel, where the canvas has
     no size to draw into. Redraw whenever it gets one — opening the panel,
     switching tabs, turning the phone. */
  if (window.ResizeObserver) {
    new ResizeObserver(function () { drawLive(); }).observe(root);
  }

  /* ---------------- saving ---------------- */

  discardBtn.addEventListener('click', function () {
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

    saveBtn.disabled = true;
    discardBtn.disabled = true;
    Promise.resolve(pending).then(function (take) {
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

  /* Opening "Add a recording" is a decision to record, so bring the
     recorder itself into view — not just the panel's heading, with the
     button somewhere below the fold — and put the focus on its button. */
  var panel = root.closest('details');
  if (panel) {
    panel.addEventListener('toggle', function () {
      if (!panel.open) return;
      requestAnimationFrame(function () {
        try { root.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { root.scrollIntoView(); }
        if (!stage.hidden) {
          try { big.focus({ preventScroll: true }); } catch (e) { big.focus(); }
        }
      });
    });
  }

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
