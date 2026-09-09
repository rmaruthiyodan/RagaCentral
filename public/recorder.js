/* Recording in the browser.
 *
 * Capture uses MediaRecorder, which runs off the main thread and doesn't glitch.
 * But what it produces differs by browser — Chrome and Firefox give WebM/Opus,
 * Safari gives MP4/AAC — and Safari could not play WebM until 18.4. Since students
 * are on whatever phone they own, audio is decoded and re-encoded to MP3 here
 * before it's uploaded. One format, plays everywhere.
 *
 * Video is left in whatever the browser produced: re-encoding video in a page is
 * not worth it, and video is the exception rather than the rule.
 */

(function () {
  'use strict';

  var root = document.querySelector('.recorder');
  if (!root) return;

  var STUDENT = root.dataset.student;
  var SECTION = root.dataset.section;
  var MP3_KBPS = 96;              // plenty for a solo voice; ~0.7 MB per minute
  var VIDEO_MAX_SEC = 120;        // keep clips short so storage stays predictable
  var AUDIO_MAX_SEC = 20 * 60;

  var $ = function (sel) { return root.querySelector(sel); };
  var dot = $('[data-dot]');
  var timerEl = $('[data-timer]');
  var levelEl = $('[data-level]');
  var levelWrap = $('[data-level-wrap]');
  var startBtn = $('[data-start]');
  var stopBtn = $('[data-stop]');
  var videoToggle = $('[data-video]');
  var statusEl = $('[data-status]');
  var preview = $('[data-preview]');
  var playerBox = $('[data-player]');
  var titleInput = $('[data-title]');
  var partInput = $('[data-part]');
  var descInput = $('[data-desc]');
  var saveBtn = $('[data-save]');
  var discardBtn = $('[data-discard]');
  var progress = $('[data-progress]');
  var progressFill = $('[data-progress-fill]');

  var stream = null, recorder = null, chunks = [], startedAt = 0, ticker = null;
  var audioCtx = null, analyser = null, meterRaf = null;
  var pending = null; // { blob, mime, duration, kind }
  var lameLoading = null;

  function say(msg) { statusEl.textContent = msg; }

  function fmt(t) {
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  /* ---------------- the MP3 encoder, loaded only when needed ---------------- */

  function loadLame() {
    if (window.lamejs && window.lamejs.Mp3Encoder) return Promise.resolve();
    if (lameLoading) return lameLoading;
    lameLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/vendor/lame.min.js';
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load the MP3 encoder')); };
      document.head.appendChild(s);
    });
    return lameLoading;
  }

  /* ---------------- level meter ---------------- */

  function startMeter(srcStream) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var src = audioCtx.createMediaStreamSource(srcStream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      var buf = new Uint8Array(analyser.fftSize);

      (function draw() {
        meterRaf = requestAnimationFrame(draw);
        analyser.getByteTimeDomainData(buf);
        var peak = 0;
        for (var i = 0; i < buf.length; i++) {
          var v = Math.abs(buf[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        var pct = Math.min(100, peak * 140);
        levelEl.style.width = pct + '%';
        levelEl.className = 'level-fill' + (pct > 92 ? ' clip' : pct > 72 ? ' hot' : '');
      })();
    } catch (e) { /* meter is a nicety, not a requirement */ }
  }

  function stopMeter() {
    if (meterRaf) cancelAnimationFrame(meterRaf);
    meterRaf = null;
    levelEl.style.width = '0%';
    if (levelWrap) levelWrap.hidden = true;
    if (audioCtx && audioCtx.state !== 'closed') audioCtx.close();
    audioCtx = null;
  }

  /* ---------------- capture ---------------- */

  function pickMime(wantVideo) {
    var candidates = wantVideo
      ? ['video/mp4;codecs=h264,aac', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < candidates.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  startBtn.addEventListener('click', function () {
    var wantVideo = videoToggle.checked;
    var constraints = wantVideo
      ? { audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } }
      : { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } };

    say('Asking for permission…');
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

      startedAt = Date.now();
      dot.classList.add('live');
      startBtn.disabled = true;
      stopBtn.disabled = false;
      videoToggle.disabled = true;
      preview.hidden = true;
      if (levelWrap) levelWrap.hidden = false;
      startMeter(s);
      say(wantVideo ? 'Recording video. Clips are capped at two minutes.' : 'Recording.');

      var cap = wantVideo ? VIDEO_MAX_SEC : AUDIO_MAX_SEC;
      ticker = setInterval(function () {
        var secs = (Date.now() - startedAt) / 1000;
        timerEl.textContent = fmt(secs);
        if (secs >= cap) {
          say('Reached the ' + (cap / 60) + '-minute limit — stopping.');
          stopBtn.click();
        }
      }, 200);
    }).catch(function (err) {
      console.error(err);
      say(
        err && err.name === 'NotAllowedError'
          ? 'Microphone access was blocked. Allow it in your browser’s address bar, then try again.'
          : 'Could not start recording: ' + (err && err.message ? err.message : 'unknown error')
      );
    });
  });

  stopBtn.addEventListener('click', function () {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    stopBtn.disabled = true;
    clearInterval(ticker);
    dot.classList.remove('live');
  });

  function releaseStream() {
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    stopMeter();
  }

  function onCaptureStopped() {
    var wasVideo = videoToggle.checked;
    var duration = (Date.now() - startedAt) / 1000;
    var raw = new Blob(chunks, { type: recorder.mimeType || (wasVideo ? 'video/webm' : 'audio/webm') });
    releaseStream();
    startBtn.disabled = false;
    videoToggle.disabled = false;

    if (wasVideo) {
      finish(raw, raw.type, duration, 'video');
      return;
    }

    say('Converting to MP3 so it plays on every device…');
    toMp3(raw).then(function (mp3) {
      finish(mp3, 'audio/mpeg', duration, 'audio');
    }).catch(function (err) {
      console.error(err);
      // Better to keep the take in its original format than lose it.
      say('Could not convert to MP3, so this take is saved in the browser’s own format.');
      finish(raw, raw.type, duration, 'audio');
    });
  }

  function finish(blob, mime, duration, kind) {
    pending = { blob: blob, mime: mime, duration: duration, kind: kind };
    playerBox.innerHTML = '';
    var el = document.createElement(kind === 'video' ? 'video' : 'audio');
    el.controls = true;
    el.src = URL.createObjectURL(blob);
    if (kind === 'video') el.playsInline = true;
    playerBox.appendChild(el);
    preview.hidden = false;
    titleInput.focus();
    say('Take ready — ' + fmt(duration) + ', ' + (blob.size / 1048576).toFixed(1) + ' MB. Name it and save.');
  }

  /* ---------------- decode, downmix, encode ---------------- */

  function toMp3(blob) {
    return loadLame()
      .then(function () { return blob.arrayBuffer(); })
      .then(function (buf) {
        var ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
        return new Promise(function (resolve, reject) {
          // Safari still wants the callback form.
          var p = ctx.decodeAudioData(buf, resolve, reject);
          if (p && p.then) p.then(resolve, reject);
        });
      })
      .then(function (audioBuffer) {
        var rate = audioBuffer.sampleRate;
        var n = audioBuffer.length;
        var mono = new Float32Array(n);
        var ch = audioBuffer.numberOfChannels;
        for (var c = 0; c < ch; c++) {
          var data = audioBuffer.getChannelData(c);
          for (var i = 0; i < n; i++) mono[i] += data[i] / ch;
        }

        var pcm = new Int16Array(n);
        for (var j = 0; j < n; j++) {
          var v = Math.max(-1, Math.min(1, mono[j]));
          pcm[j] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }

        return encodeChunked(pcm, rate);
      });
  }

  /* Encoding a five-minute take takes a couple of seconds, so it yields to the
     browser between blocks — the page stays responsive and the bar moves. */
  function encodeChunked(pcm, sampleRate) {
    return new Promise(function (resolve, reject) {
      var enc;
      try {
        enc = new window.lamejs.Mp3Encoder(1, sampleRate, MP3_KBPS);
      } catch (e) { reject(e); return; }

      var FRAME = 1152;
      var PER_TICK = FRAME * 80; // ~2 seconds of audio per yield
      var out = [];
      var i = 0;
      progress.classList.add('on');

      function step() {
        var end = Math.min(pcm.length, i + PER_TICK);
        try {
          while (i < end) {
            var slice = pcm.subarray(i, Math.min(i + FRAME, pcm.length));
            var buf = enc.encodeBuffer(slice);
            if (buf.length > 0) out.push(new Int8Array(buf));
            i += FRAME;
          }
        } catch (e) { progress.classList.remove('on'); reject(e); return; }

        progressFill.style.width = Math.round((i / pcm.length) * 100) + '%';

        if (i < pcm.length) {
          setTimeout(step, 0);
        } else {
          var tail = enc.flush();
          if (tail.length > 0) out.push(new Int8Array(tail));
          progress.classList.remove('on');
          progressFill.style.width = '0%';
          resolve(new Blob(out, { type: 'audio/mpeg' }));
        }
      }
      step();
    });
  }

  /* ---------------- saving ---------------- */

  discardBtn.addEventListener('click', function () {
    pending = null;
    preview.hidden = true;
    playerBox.innerHTML = '';
    titleInput.value = '';
    if (partInput) partInput.value = '';
    if (descInput) descInput.value = '';
    timerEl.textContent = '0:00';
    say('Discarded. Record another whenever you’re ready.');
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

    var fd = new FormData();
    var ext = pending.mime.indexOf('mp4') > -1 ? 'mp4' : pending.mime.indexOf('mpeg') > -1 ? 'mp3' : 'webm';
    fd.append('file', pending.blob, 'take.' + ext);
    if (STUDENT) fd.append('student_id', STUDENT);
    fd.append('section_id', SECTION);
    fd.append('title', titleInput.value.trim());
    if (partInput) fd.append('part', partInput.value.trim());
    if (descInput) fd.append('description', descInput.value.trim());
    fd.append('kind', pending.kind);
    fd.append('duration_sec', String(Math.round(pending.duration)));
    fd.append('source', 'recorded');
    addAudience(fd);

    say('Saving…');
    upload(fd, function (pct) { progress.classList.add('on'); progressFill.style.width = pct + '%'; })
      .then(function () { window.location.reload(); })
      .catch(function (err) {
        progress.classList.remove('on');
        saveBtn.disabled = false;
        discardBtn.disabled = false;
        say(err.message || 'Could not save that take. Please try again.');
      });
  });

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
        state.textContent = 'uploading…';

        var fd = new FormData();
        fd.append('file', file, file.name);
        if (drop.dataset.student) fd.append('student_id', drop.dataset.student);
        fd.append('section_id', drop.dataset.section);
        fd.append('title', file.name.replace(/\.[^.]+$/, ''));
        fd.append('kind', file.type.indexOf('video/') === 0 ? 'video' : 'audio');
        fd.append('source', 'upload');
        addAudience(fd);

        upload(fd, function (pct) { state.textContent = pct + '%'; })
          .then(function () { state.textContent = 'saved'; i++; next(); })
          .catch(function (err) { state.textContent = err.message; i++; next(); });
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
