/* Cutting parts out of an audio recording, in the browser.
 *
 * Two users:
 *   - recorder.js, which uses decode() and encodeKept() to turn a fresh take
 *     into an MP3 (a take is saved first, whole; editing comes after);
 *   - the "Edit audio" button on a recording that already exists, wired up
 *     at the bottom of this file. A teacher can edit any audio recording in
 *     their practice; a student only their own practice takes — the server
 *     checks the same thing again in POST /api/recordings/:id/audio.
 *
 * The recording is decoded here, shown as a waveform, split into parts and
 * each part kept or removed. On Save, only what's kept is encoded to MP3
 * (with a few milliseconds of fade at every cut, so joins don't click) and
 * sent up to replace the file. Nothing that was cut ever leaves the device.
 *
 * Every word on screen comes from the page (views/recorder.ts), which puts
 * them through t() so they appear in Malayalam too.
 */
(function () {
  'use strict';

  var MP3_KBPS = 160;   // the same as a fresh take — see recorder.js
  var MIN_PART = 0.15;  // seconds; no sliver of a part smaller than this
  var FADE = 0.008;     // seconds of fade at every cut

  var PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>';
  var STOP_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  var TRASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';
  var UNDO_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>';

  function esc(v) {
    return String(v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(t) {
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + String(s).padStart(2, '0');
  }
  function fmtTenths(t) {
    var m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }
  function sizeCanvas(c) {
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return dpr;
  }
  function roundBar(g, x, y, w, h) {
    var r = Math.min(w / 2, h / 2);
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h);
    g.fill();
  }

  /* ---------------- the MP3 encoder, loaded only when needed ---------------- */

  var lameLoading = null;
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

  /* ---------------- decode and downmix ---------------- */

  /* One mono AudioBuffer: what the editor draws, what it plays, and what is
     encoded. Kept as an AudioBuffer (not a loose array) so playback needs no
     second copy of a six-minute take. */
  function decode(source) {
    var getBuf = source instanceof ArrayBuffer ? Promise.resolve(source) : source.arrayBuffer();
    return getBuf
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

  /* ---------------- encode only what is kept ---------------- */

  /* Walks the kept ranges one 1152-sample MP3 frame at a time, straight out
     of the decoded buffer — no second full-length copy — with a short fade
     either side of every cut. Yields to the browser between blocks, so the
     page stays responsive and onProgress(0–100) can move a bar. */
  function encodeKept(buffer, ranges, onProgress) {
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
          } catch (e) { reject(e); return; }
          if (onProgress) onProgress(Math.round((done / Math.max(1, all)) * 100));
          if (ri < rs.length) { setTimeout(step, 0); return; }
          var tail = enc.flush();
          if (tail.length) out.push(new Int8Array(tail));
          resolve({ blob: new Blob(out, { type: 'audio/mpeg' }), duration: all / rate });
        }
        step();
      });
    });
  }

  /* ================================================================
   * The editor: split anywhere, remove pieces, hear the result.
   *
   * The recording is a list of parts, each { s, e, cut } in seconds, end
   * to end. Split cuts one part in two at the playhead; a part is either
   * kept or removed; the split lines can be dragged. Every change is
   * undoable, and nothing is thrown away until Save.
   * ================================================================ */
  function createEditor(el, L, say) {
    var $ = function (sel) { return el.querySelector(sel); };
    var css = function (name, fallback) { return getComputedStyle(el).getPropertyValue(name).trim() || fallback; };
    var box = $('[data-box]');
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
    // The Advanced panel: its settings, which version plays, and the last result made.
    var Fx = window.SrutiFx;
    var fxEl = $('[data-fx-panel]');
    var S = Fx ? Fx.defaults() : null;
    var ab = 'after', processed = null, rendering = null, gainEditing = false;

    function active() { return !!buffer; }

    function open(b) {
      buffer = b; dur = b.duration;
      segs = [{ s: 0, e: dur, cut: false, g: 0 }];
      sel = 0; head = 0; past = []; future = []; peaks = null;
      if (Fx) { S = Fx.defaults(); processed = null; rendering = null; ab = 'after'; }
      // Whole seconds repeat themselves on a short take, so those get tenths.
      scaleEl.innerHTML = [0, 0.25, 0.5, 0.75, 1].map(function (f) {
        return '<span>' + (dur < 30 ? fmtTenths(dur * f) : fmt(dur * f)) + '</span>';
      }).join('');
      render();
    }

    function close() {
      stopPlay();
      buffer = null; peaks = null; segs = []; processed = null; rendering = null;
    }

    function kept() { return segs.filter(function (x) { return !x.cut; }); }
    /* Kept parts that sit side by side play straight through — only a cut
       makes a join. */
    function keptRuns() {
      var out = [], last = null;
      segs.forEach(function (x) {
        if (x.cut) { last = null; return; }
        if (last) last[1] = x.e; else { last = [x.s, x.e]; out.push(last); }
      });
      return out;
    }
    function fxActive() { return !!(Fx && buffer && Fx.isActive(S, segs)); }
    function gainText(g) { return (g > 0 ? '+' : g < 0 ? '−' : '') + Math.abs(g) + ' dB'; }
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
      processed = null; rendering = null;
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
      var on = css('--peacock', '#3B5566'), off = css('--line-strong', '#C3C8D1'), loud = css('--brass', '#9A6A28');
      for (var i = 0; i < n; i++) {
        var t = ((i + 0.5) / n) * dur;
        var seg = segs[at(t)];
        var lin = seg && seg.g ? Math.pow(10, seg.g / 20) : 1;
        var h = Math.max(2 * dpr, Math.min(1, peaks[i] * lin) * H * 0.96);
        g.fillStyle = seg && seg.cut ? off : seg && seg.g ? loud : on;
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
          '<span class="txt" data-pick="' + i + '" aria-label="' + L('partOf', name(i)) + '"><b>' + name(i) + '</b>' + fmtTenths(s.s) + '–' + fmtTenths(s.e) +
            (s.g && !s.cut ? ' <span class="rx-gain">' + gainText(s.g) + '</span>' : '') + '</span>' +
          '<button type="button" class="rx-lplay' + (playing ? ' on' : '') + '" data-rowplay="' + i + '" aria-label="' + L('play') + ' ' + name(i) + '">' + (playing ? STOP_SVG : PLAY_SVG) + '</button>' +
          '<span class="rx-tog"><button type="button" data-keep="' + i + '" class="' + (s.cut ? '' : 'on') + '">' + L('keep') + '</button>' +
          '<button type="button" data-cut="' + i + '" class="' + (s.cut ? 'on x' : '') + '">' + (s.cut ? L('removed') : L('remove')) + '</button></span>' +
          '</div>';
      }).join('');
      playAllText.textContent = playMode === 'all' ? L('stopPlaying') :
        L(fxActive() && ab === 'after' ? 'playChanged' : 'playResult', fmt(keptLen()));
      playAll.firstElementChild && (playAll.querySelector('svg').outerHTML = playMode === 'all' ? STOP_SVG : PLAY_SVG);
      undoBtn.disabled = !past.length;
      redoBtn.disabled = !future.length;
      drawWave();
      placeHead();
      placePop();
      renderFx();
    }

    /* ---------- the Advanced panel ---------- */

    function renderFx() {
      if (!fxEl || !S) return;
      var s = segs[sel], on = fxActive();
      var q = function (sel2) { return fxEl.querySelector(sel2); };
      var part = q('[data-fx-part]');
      if (part) part.textContent = name(sel);
      var gain = q('[data-fx-gain]');
      if (gain) {
        if (s && !gainEditing) gain.value = String(s.g || 0);
        gain.disabled = !s || s.cut;
      }
      var gv = q('[data-fx-gain-val]');
      if (gv && s) gv.textContent = s.cut ? L('removed') : gainText(s.g || 0);
      var gr = q('[data-fx-gain-reset]');
      if (gr) gr.disabled = !s || !s.g;
      // Switches: noise and echo are on when their strength is above zero.
      Array.prototype.forEach.call(fxEl.querySelectorAll('[data-fx-toggle]'), function (c) {
        var k = c.getAttribute('data-fx-toggle');
        c.checked = typeof S[k] === 'number' ? S[k] > 0 : !!S[k];
      });
      ['noise', 'echo', 'reverbAmt'].forEach(function (k) {
        var r = q('[data-fx="' + k + '"]'), row = q('[data-fx-row="' + k + '"]');
        var off = k === 'reverbAmt' ? S.reverb === 'none' : !(S[k] > 0);
        if (r) {
          r.disabled = off;
          if (!off && document.activeElement !== r) r.value = String(S[k]);
        }
        if (row) row.classList.toggle('is-off', off);
        var v = q('[data-fx-val="' + k + '"]');
        if (v) v.textContent = off ? L('off') : S[k] + '%';
      });
      Array.prototype.forEach.call(fxEl.querySelectorAll('[data-fx-seg]'), function (g) {
        var k = g.getAttribute('data-fx-seg');
        Array.prototype.forEach.call(g.querySelectorAll('button'), function (b) {
          b.setAttribute('aria-pressed', String(String(S[k]) === b.getAttribute('data-v')));
        });
      });
      Array.prototype.forEach.call(fxEl.querySelectorAll('.fx-range'), paintRange);
      var nf = q('[data-fx="noiseFrom"]');
      if (nf && document.activeElement !== nf) {
        var picked = -1;
        if (S.noiseFrom !== 'auto') segs.forEach(function (x, i) { if (x.s === S.noiseFrom.s && x.e === S.noiseFrom.e) picked = i; });
        nf.innerHTML = '<option value="auto">' + esc(L('noiseAuto')) + '</option>' +
          segs.map(function (x, i) {
            return '<option value="' + i + '"' + (i === picked ? ' selected' : '') + '>' + esc(L('partOf', name(i))) + ' · ' + fmtTenths(x.s) + '–' + fmtTenths(x.e) + '</option>';
          }).join('') +
          (S.noiseFrom !== 'auto' && picked < 0 ? '<option value="kept" selected>' + esc(L('noisePicked')) + '</option>' : '');
      }
      if (nf) nf.disabled = !(S.noise > 0);
      var wrap = el.querySelector('[data-ab-wrap]');
      if (wrap) wrap.hidden = !on;
      Array.prototype.forEach.call(el.querySelectorAll('[data-ab]'), function (b) {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-ab') === ab));
      });
      var badge = el.querySelector('[data-fx-on]');
      if (badge) {
        var n = countOn();
        badge.hidden = !n;
        badge.textContent = L('nOn', n);
      }
      // Presets: the one the settings match is pressed; none when fine-tuned.
      var which = Fx.whichPreset ? Fx.whichPreset(S) : null;
      Array.prototype.forEach.call(fxEl.querySelectorAll('[data-fx-preset]'), function (b) {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-fx-preset') === which));
      });
      var chips = q('[data-fx-chips]');
      if (chips) {
        var list = chipList();
        chips.innerHTML = list.length
          ? list.map(function (c) { return '<span class="fx-chip">' + esc(c) + '</span>'; }).join('')
          : '<span class="fx-chip-none">' + esc(L('noChanges')) + '</span>';
      }
      var all = q('[data-fx-all]'), more = q('[data-fx-more]');
      if (all) all.hidden = !showAll;
      if (more) {
        more.textContent = showAll ? L('hideAll') : L('showAll');
        more.setAttribute('aria-expanded', String(showAll));
      }
    }

    /* What's switched on, in a few words each — the summary under the presets. */
    function chipList() {
      var out = [];
      segs.forEach(function (x, i) { if (!x.cut && x.g) out.push(L('partOf', name(i)) + ' ' + gainText(x.g)); });
      if (S.normalize) out.push(L('chipEven'));
      if (S.fadeIn) out.push(L('chipFadeIn', S.fadeIn + 's'));
      if (S.fadeOut) out.push(L('chipFadeOut', S.fadeOut + 's'));
      if (S.noise > 0) out.push(L('chipNoise', S.noise + '%'));
      if (S.echo > 0) out.push(L('chipEcho', S.echo + '%'));
      if (S.rumble) out.push(L('chipRumble'));
      if (S.hum) out.push(L('chipHum', S.hum));
      if (S.reverb !== 'none') {
        var key = { room: 'chipRoom', hall: 'chipHall', temple: 'chipTemple' }[S.reverb];
        out.push(L(key, S.reverbAmt + '%'));
      }
      return out;
    }

    /* How many tools are doing something — shown on the closed panel. */
    function countOn() {
      var n = 0;
      if (segs.some(function (x) { return !x.cut && x.g; })) n++;
      ['normalize', 'fadeIn', 'fadeOut', 'rumble', 'hum'].forEach(function (k) { if (S[k]) n++; });
      if (S.noise > 0) n++;
      if (S.echo > 0) n++;
      if (S.reverb !== 'none') n++;
      return n;
    }

    /* The filled part of a slider: from the left, or from the middle for
       the part volume, which goes both ways. */
    function paintRange(r) {
      var min = Number(r.min), max = Number(r.max), v = Number(r.value);
      var p = ((v - min) / (max - min)) * 100;
      if (r.classList.contains('fx-center')) {
        var a = Math.min(50, p), b = Math.max(50, p);
        r.style.setProperty('--a', a + '%'); r.style.setProperty('--b', b + '%');
      } else {
        r.style.setProperty('--a', '0%'); r.style.setProperty('--b', p + '%');
      }
    }

    function fxChanged() {
      processed = null; rendering = null;
      if (playMode) stopPlay();
      render();
    }

    var lastStrength = { noise: 40, echo: 30 };
    var showAll = false;
    if (fxEl) {
      fxEl.addEventListener('input', function (e) {
        var c = e.target;
        if (c.hasAttribute('data-fx-gain')) {
          var s = segs[sel];
          if (!s || s.cut) return;
          if (!gainEditing) { remember(); gainEditing = true; }
          s.g = Number(c.value) || 0;
          paintRange(c);
          fxChanged();
          return;
        }
        if (c.hasAttribute('data-fx-toggle')) {
          var t = c.getAttribute('data-fx-toggle');
          if (t === 'noise' || t === 'echo') {
            if (c.checked) S[t] = lastStrength[t];
            else { if (S[t] > 0) lastStrength[t] = S[t]; S[t] = 0; }
          } else S[t] = c.checked;
          fxChanged();
          return;
        }
        var k = c.getAttribute('data-fx');
        if (!k) return;
        if (k === 'noiseFrom') {
          if (c.value === 'auto') S.noiseFrom = 'auto';
          else if (c.value !== 'kept') { var x = segs[Number(c.value)]; S.noiseFrom = { s: x.s, e: x.e }; }
        } else {
          S[k] = Number(c.value) || 0;
          if (k === 'noise' || k === 'echo') lastStrength[k] = S[k];
          paintRange(c);
        }
        fxChanged();
      });
      fxEl.addEventListener('change', function (e) {
        if (e.target.hasAttribute('data-fx-gain')) { gainEditing = false; render(); }
      });
      fxEl.addEventListener('click', function (e) {
        var pr = e.target.closest('[data-fx-preset]');
        if (pr) {
          Fx.applyPreset(S, pr.getAttribute('data-fx-preset'));
          if (S.noise > 0) lastStrength.noise = S.noise;
          if (S.echo > 0) lastStrength.echo = S.echo;
          fxChanged();
          return;
        }
        if (e.target.closest('[data-fx-more]')) { showAll = !showAll; renderFx(); return; }
        var sb = e.target.closest('[data-fx-seg] button');
        if (sb) {
          var k = sb.parentNode.getAttribute('data-fx-seg'), v = sb.getAttribute('data-v');
          S[k] = k === 'reverb' ? v : Number(v);
          fxChanged();
        } else if (e.target.closest('[data-fx-gain-reset]')) {
          var s = segs[sel];
          if (s && s.g) { remember(); s.g = 0; fxChanged(); }
        } else if (e.target.closest('[data-fx-reset]')) {
          var anyGain = segs.some(function (x) { return x.g; });
          if (anyGain) { remember(); segs.forEach(function (x) { x.g = 0; }); }
          S = Fx.defaults();
          fxChanged();
        }
      });
    }
    el.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-ab]');
      if (!b || !el.contains(b)) return;
      ab = b.getAttribute('data-ab');
      if (playMode) stopPlay();
      render();
    });

    /* The result with every change applied, made when first asked for and
       kept until something changes. */
    function ensureProcessed() {
      if (processed) return Promise.resolve(processed);
      if (rendering) return rendering;
      var mine = rendering = Fx.render(buffer, segs, S, function (p) { if (rendering === mine) say(L('applying', p)); })
        .then(function (r) {
          if (rendering !== mine) return ensureProcessed(); // changed while working: start again
          processed = r; rendering = null; say('');
          return r;
        });
      return mine;
    }
    function srcToOut(t) {
      if (!processed) return null;
      for (var i = 0; i < processed.map.length; i++) {
        var m = processed.map[i];
        if (t >= m.src - 1e-6 && t < m.src + m.len) return m.out + (t - m.src);
      }
      return null;
    }

    /* ---------- editing ---------- */

    function select(i) { sel = Math.max(0, Math.min(segs.length - 1, i)); }

    function split() {
      var i = at(head), s = segs[i];
      if (head - s.s < MIN_PART || s.e - head < MIN_PART) { say(L('tooShort')); return; }
      remember();
      segs.splice(i, 1, { s: s.s, e: head, cut: s.cut, g: s.g || 0 }, { s: head, e: s.e, cut: s.cut, g: s.g || 0 });
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
      processed = null; rendering = null;
      render();
    });
    redoBtn.addEventListener('click', function () {
      if (!future.length) return;
      stopPlay();
      past.push(JSON.stringify(segs));
      restore(future.pop());
      processed = null; rendering = null;
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
    if (window.ResizeObserver) new ResizeObserver(function () { if (buffer) render(); }).observe(box);

    /* ---------- listening ---------- */

    function togglePlay(mode, i) {
      var same = playMode === mode && (mode === 'all' || playSeg === i);
      stopPlay();
      if (same) { render(); return; }
      var withFx = fxActive() && ab === 'after';
      if (mode === 'all') {
        var runs = keptRuns();
        if (!runs.length) { say(L('keepAll')); render(); return; }
        if (!withFx) { play(runs.map(function (r) { return { buf: buffer, off: r[0], len: r[1] - r[0], src: r[0] }; }), mode, i); return; }
        ensureProcessed().then(function (p) {
          if (!buffer) return;
          play([{ buf: p.buffer, off: 0, len: p.buffer.duration, map: p.map }], mode, i);
        }).catch(function (err) { console.error(err); say(L('fxFailed')); });
        return;
      }
      var s = segs[i];
      // From the playhead if it sits inside this part, otherwise from its start.
      var from = mode === 'seg' && head > s.s && head < s.e - 0.05 ? head : s.s;
      if (!withFx || s.cut) {
        play([{ buf: buffer, off: from, len: s.e - from, src: from }], mode, i);
        return;
      }
      ensureProcessed().then(function (p) {
        var o = srcToOut(from);
        if (o === null || !buffer) return;
        play([{ buf: p.buffer, off: o, len: s.e - from, src: from }], mode, i);
      }).catch(function (err) { console.error(err); say(L('fxFailed')); });
    }

    /* Each voice: { buf, off, len } to play, and where it is in the original —
       `src` for a straight stretch, or the result's `map` — so the playhead
       can follow along. */
    function play(list, mode, i) {
      try {
        ac = ac || new (window.AudioContext || window.webkitAudioContext)();
        if (ac.state === 'suspended') ac.resume();
      } catch (e) { return; }
      var when = ac.currentTime + 0.05;
      plan = [];
      voices = list.map(function (v) {
        var src = ac.createBufferSource(), gain = ac.createGain();
        src.buffer = v.buf;
        src.connect(gain); gain.connect(ac.destination);
        gain.gain.setValueAtTime(0, when);
        gain.gain.linearRampToValueAtTime(1, when + FADE);
        gain.gain.setValueAtTime(1, when + Math.max(FADE, v.len - FADE));
        gain.gain.linearRampToValueAtTime(0, when + v.len);
        src.start(when, v.off, v.len);
        plan.push({ at: when, len: v.len, off: v.off, src: v.src, map: v.map });
        when += v.len;
        return src;
      });
      var endAt = when;
      playMode = mode; playSeg = i;
      render();
      (function tick() {
        var now = ac.currentTime;
        if (now >= endAt) { stopPlay(); render(); return; }
        for (var k = 0; k < plan.length; k++) {
          var p = plan[k];
          if (now < p.at + p.len) {
            var pos = p.off + Math.max(0, now - p.at);
            if (p.map) {
              for (var m = p.map.length - 1; m >= 0; m--) {
                var r = p.map[m];
                if (pos >= r.out) { head = Math.min(r.src + r.len, r.src + (pos - r.out)); break; }
              }
            } else head = p.src + (pos - p.off);
            break;
          }
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
      ranges: keptRuns,
      keptLen: keptLen,
      /** True once anything has been removed, or a sound setting turned on — otherwise there is nothing to save. */
      changed: function () { return segs.some(function (x) { return x.cut; }) || fxActive(); },
      fxActive: fxActive,
      /** The finished result when sound settings are on (see audio-fx.js). */
      processed: ensureProcessed,
      redraw: function () { if (buffer) render(); },
    };
  }


  /* ================================================================
   * "Edit audio" on a recording that already exists
   * ================================================================ */

  var tpl = document.getElementById('rx-edit-tpl');
  var S = {};
  try { S = JSON.parse((tpl && tpl.getAttribute('data-strings')) || '{}'); } catch (e) { S = {}; }
  function L(k, a) {
    var s = S[k] || k;
    return a === undefined ? s : s.replace('%s', a);
  }

  var current = null; // { host, button, editor }

  function closeCurrent() {
    if (!current) return;
    if (current.editor) current.editor.close();
    current.host.innerHTML = '';
    current.host.hidden = true;
    current.button.disabled = false;
    current.button.setAttribute('aria-expanded', 'false');
    current = null;
  }

  function openFor(btn) {
    var id = btn.getAttribute('data-edit-audio');
    var host = document.querySelector('[data-edit-host="' + id + '"]');
    if (!tpl || !host) return;
    if (current && current.host === host) { closeCurrent(); return; }
    closeCurrent();

    // One thing playing at a time: the editor has its own playback.
    Array.prototype.forEach.call(document.querySelectorAll('audio, video'), function (m) { try { m.pause(); } catch (e) {} });
    host.innerHTML = '';
    host.appendChild(tpl.content.cloneNode(true));
    host.hidden = false;
    btn.disabled = true;
    btn.setAttribute('aria-expanded', 'true');
    var status = host.querySelector('[data-edit-status]');
    var say = function (m) { if (status) status.textContent = m; };
    var bar = host.querySelector('[data-progress]');
    var fill = host.querySelector('[data-progress-fill]');
    var saveBtn = host.querySelector('[data-edit-save]');
    var cancelBtn = host.querySelector('[data-edit-cancel]');
    var edit = host.querySelector('[data-editor]');
    var me = { host: host, button: btn, editor: null };
    current = me;

    cancelBtn.addEventListener('click', function () { if (current === me) closeCurrent(); });
    say(L('loading'));
    saveBtn.disabled = true;
    try { host.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { host.scrollIntoView(false); }

    fetch(btn.getAttribute('data-src'), { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .then(decode)
      .then(function (buffer) {
        if (current !== me) return;
        edit.hidden = false;
        me.editor = createEditor(host, L, say);
        me.editor.open(buffer);
        saveBtn.disabled = false;
        say('');
      })
      .catch(function (err) {
        console.error(err);
        if (current !== me) return;
        say(L('cantOpen') + ' (' + describe(err) + ')');
        report('edit-audio open', err).then(function (ref) {
          if (ref && current === me) say(L('cantOpen') + ' (' + describe(err) + ') — ' + L('reference', ref));
        });
      });

    saveBtn.addEventListener('click', function () {
      var ed = me.editor;
      if (!ed) return;
      if (!ed.changed()) { say(L('nothingCut')); return; }
      var ranges = ed.ranges();
      if (!ranges.length) { say(L('keepAll')); return; }
      if (!window.confirm(L('replaceConfirm'))) return;
      ed.stopPlay();
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      bar.classList.add('on');
      say(L('encoding'));
      var job = ed.fxActive()
        ? ed.processed().then(function (p) {
            say(L('encoding'));
            return encodeKept(p.buffer, [[0, p.buffer.duration]], function (q) { fill.style.width = Math.round(q / 2) + '%'; });
          })
        : encodeKept(ed.buffer(), ranges, function (p) { fill.style.width = Math.round(p / 2) + '%'; });
      job
        .then(function (r) {
          var fd = new FormData();
          fd.append('file', r.blob, 'edited.mp3');
          fd.append('duration_sec', String(Math.round(r.duration * 10) / 10));
          say(L('saving'));
          return send('/api/recordings/' + encodeURIComponent(btn.getAttribute('data-edit-audio')) + '/audio', fd, function (p) {
            fill.style.width = 50 + Math.round(p / 2) + '%';
          });
        })
        .then(function () {
          var u = new URL(window.location.href);
          u.searchParams.set('msg', L('savedMsg'));
          window.location.replace(u.toString());
        })
        .catch(function (err) {
          console.error(err);
          bar.classList.remove('on');
          saveBtn.disabled = false;
          cancelBtn.disabled = false;
          if (err && err.fromServer) { say(err.message); return; }
          // Something failed here in the browser: say what, and log it for the admin.
          var what = describe(err);
          say(L('saveFailed') + ' (' + what + ')');
          report('edit-audio save', err).then(function (ref) {
            if (ref) say(L('saveFailed') + ' (' + what + ') — ' + L('reference', ref));
          });
        });
    });
  }

  function describe(err) {
    if (!err) return 'unknown error';
    if (typeof err === 'string') return err.slice(0, 160);
    return ((err.name && err.name !== 'Error' ? err.name + ': ' : '') + (err.message || String(err))).slice(0, 160);
  }

  /* Tell the server what broke in the browser; resolves to the reference. */
  function report(where, err) {
    try {
      return fetch('/api/client-error', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ where: where, message: describe(err), stack: (err && err.stack) || '' }),
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { return j && j.ref; })
        .catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  /* What the server said went wrong: its JSON error, or a short plain-text
     page (which carries the error reference an admin can look up). */
  function serverSaid(xhr) {
    try {
      var j = JSON.parse(xhr.responseText);
      if (j && j.error) return j.error;
    } catch (e) {
      var text = (xhr.responseText || '').trim();
      if (text && text.length < 400 && text.charAt(0) !== '<') return text.replace(/\s+/g, ' ');
    }
    return '';
  }

  /* XHR rather than fetch, purely because it reports upload progress. */
  function send(url, formData, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        var e = new Error(serverSaid(xhr) || (L('saveFailed') + ' (HTTP ' + xhr.status + ')'));
        e.fromServer = true;
        reject(e);
      };
      xhr.onerror = function () { var e = new Error(L('offline')); e.fromServer = true; reject(e); };
      xhr.send(formData);
    });
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-edit-audio]');
    if (b) { e.preventDefault(); openFor(b); }
  });

  window.SrutiAudio = { decode: decode, encodeKept: encodeKept, loadLame: loadLame };
})();
