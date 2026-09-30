/* The "Advanced" sound tools behind Edit audio: volume, clean-up, reverb.
 *
 * Everything runs here in the browser, on the decoded recording, in one pass
 * that audio-edit.js asks for when you press Play (with changes) or Save:
 *
 *   1. put the kept parts end to end, each at its own volume
 *      (short ramps where the volume changes, short fades at every cut);
 *   2. reduce steady background noise — a fan, a fridge, a pressure cooker —
 *      by learning what the room sounds like on its own (the quietest moments,
 *      or a part you pick) and taking that out of every moment, frequency by
 *      frequency;
 *   3. reduce room echo — and whatever clatter sits in the pauses — by
 *      lowering the sound between phrases, not during them;
 *   4. filters: rumble (below ~80 Hz: traffic, fans, bumps) and electrical
 *      hum (50 or 60 Hz and its first overtones);
 *   5. reverb, from a room shape made here, mixed under the dry voice;
 *   6. even out the volume, keep the peaks clear of clipping, and fade the
 *      ends if asked.
 *
 * What it can't do, honestly: a child talking or a vessel dropped during a
 * phrase is sound in the same range as the voice, and no setting separates
 * them without damaging the singing. The noise and echo tools are gentle by
 * default for the same reason — the tail of a gamaka is quiet too.
 */
(function () {
  'use strict';

  function defaults() {
    return {
      normalize: false, fadeIn: 0, fadeOut: 0,
      rumble: false, hum: 0, noise: 0, noiseFrom: 'auto', echo: 0,
      reverb: 'none', reverbAmt: 30,
    };
  }

  function isActive(S, segs) {
    return !!(S.normalize || S.fadeIn || S.fadeOut || S.rumble || S.hum || S.noise > 0 || S.echo > 0 ||
      S.reverb !== 'none' || segs.some(function (x) { return !x.cut && x.g; }));
  }

  var yieldNow = function () { return new Promise(function (r) { setTimeout(r, 0); }); };
  var dbToLin = function (db) { return Math.pow(10, db / 20); };

  /* ---------------- 1. the kept parts, end to end ---------------- */

  function assemble(src, segs) {
    var rate = src.sampleRate, data = src.getChannelData(0), total = data.length;
    var fadeN = Math.round(rate * 0.008), rampN = Math.round(rate * 0.02);
    // Runs: neighbouring kept parts play straight through; only a cut breaks them.
    var runs = [], cur = null;
    segs.forEach(function (sg) {
      if (sg.cut) { cur = null; return; }
      var a = Math.max(0, Math.round(sg.s * rate)), b = Math.min(total, Math.round(sg.e * rate));
      if (b <= a) return;
      if (!cur) { cur = { a: a, b: b, parts: [] }; runs.push(cur); }
      cur.b = b;
      cur.parts.push({ a: a, b: b, g: dbToLin(sg.g || 0) });
    });
    var len = runs.reduce(function (n, r) { return n + (r.b - r.a); }, 0);
    var out = new Float32Array(len), o = 0, map = [];
    runs.forEach(function (r) {
      map.push({ src: r.a / rate, out: o / rate, len: (r.b - r.a) / rate });
      var prevG = null;
      r.parts.forEach(function (p) {
        for (var i = p.a; i < p.b; i++) {
          var g = p.g;
          if (prevG !== null && i - p.a < rampN) g = prevG + (p.g - prevG) * ((i - p.a) / rampN);
          if (r.a > 0 && i - r.a < fadeN) g *= (i - r.a) / fadeN;
          if (r.b < total && r.b - i <= fadeN) g *= (r.b - i - 1) / fadeN;
          out[o++] = data[i] * g;
        }
        prevG = p.g;
      });
    });
    return { data: out, rate: rate, map: map };
  }

  /* ---------------- 2. background noise, frequency by frequency ---------------- */

  var N = 2048, HOP = 512, BINS = N / 2 + 1;
  var WIN = new Float32Array(N);
  for (var w = 0; w < N; w++) WIN[w] = 0.5 - 0.5 * Math.cos((2 * Math.PI * w) / N);
  var FFT = (function () {
    var cos = new Float32Array(N / 2), sin = new Float32Array(N / 2), rev = new Uint32Array(N), bits = Math.log2(N);
    for (var i = 0; i < N / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / N); sin[i] = Math.sin((2 * Math.PI * i) / N); }
    for (var j = 0; j < N; j++) {
      var r = 0, x = j;
      for (var b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[j] = r;
    }
    return function (re, im, inverse) {
      for (var i = 0; i < N; i++) {
        var k = rev[i];
        if (k > i) { var t = re[i]; re[i] = re[k]; re[k] = t; t = im[i]; im[i] = im[k]; im[k] = t; }
      }
      for (var size = 2; size <= N; size <<= 1) {
        var half = size >> 1, step = N / size;
        for (var s = 0; s < N; s += size) {
          for (var j2 = 0, k2 = 0; j2 < half; j2++, k2 += step) {
            var l = s + j2 + half, c = cos[k2], sn = inverse ? sin[k2] : -sin[k2];
            var tr = re[l] * c - im[l] * sn, ti = re[l] * sn + im[l] * c;
            re[l] = re[s + j2] - tr; im[l] = im[s + j2] - ti;
            re[s + j2] += tr; im[s + j2] += ti;
          }
        }
      }
      if (inverse) for (var q = 0; q < N; q++) { re[q] /= N; im[q] /= N; }
    };
  })();

  function magnitudes(data, start, re, im, mag) {
    for (var i = 0; i < N; i++) {
      var p = start + i;
      re[i] = p >= 0 && p < data.length ? data[p] * WIN[i] : 0;
      im[i] = 0;
    }
    FFT(re, im, false);
    for (var k = 0; k < BINS; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  }

  /* What the room sounds like with nobody singing: from a part picked by
     hand, or from the quietest tenth of the recording (which usually
     includes the moments before the first note — even ones later cut). */
  function noiseProfile(src, from) {
    var data = src.getChannelData(0), rate = src.sampleRate;
    var starts = [];
    if (from && from !== 'auto') {
      for (var p = Math.round(from.s * rate); p + N <= Math.round(from.e * rate); p += HOP) starts.push(p);
    }
    if (starts.length < 4) {
      var frames = [];
      for (var q = 0; q + N <= data.length; q += HOP) {
        var e = 0;
        for (var i = 0; i < N; i += 4) e += data[q + i] * data[q + i];
        if (e > 1e-9) frames.push({ p: q, e: e });
      }
      frames.sort(function (a, b) { return a.e - b.e; });
      starts = frames.slice(0, Math.max(8, Math.floor(frames.length / 10))).map(function (f) { return f.p; });
    }
    if (starts.length > 400) {
      var every = starts.length / 400;
      starts = starts.filter(function (_, k) { return Math.floor(k % every) === 0; }).slice(0, 400);
    }
    var re = new Float32Array(N), im = new Float32Array(N), mag = new Float32Array(BINS), sum = new Float32Array(BINS);
    starts.forEach(function (s) {
      magnitudes(data, s, re, im, mag);
      for (var k = 0; k < BINS; k++) sum[k] += mag[k];
    });
    for (var k2 = 0; k2 < BINS; k2++) sum[k2] /= Math.max(1, starts.length);
    return sum;
  }

  function denoise(x, profile, strength, onProgress) {
    var over = 1 + 1.5 * strength;                    // how hard to subtract
    var floor = dbToLin(-(6 + 18 * strength));        // how far a bin may be turned down
    var out = new Float32Array(x.length);
    var re = new Float32Array(N), im = new Float32Array(N);
    var gain = new Float32Array(BINS), prev = new Float32Array(BINS).fill(1), sm = new Float32Array(BINS);
    var frames = Math.ceil((x.length + N) / HOP), f = 0;
    return new Promise(function (resolve) {
      (function step() {
        var until = Math.min(frames, f + 250);
        for (; f < until; f++) {
          var start = f * HOP - N;
          for (var i = 0; i < N; i++) {
            var p = start + i;
            re[i] = p >= 0 && p < x.length ? x[p] * WIN[i] : 0;
            im[i] = 0;
          }
          FFT(re, im, false);
          for (var k = 0; k < BINS; k++) {
            var m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) + 1e-12;
            var g = 1 - (over * profile[k]) / m;
            gain[k] = g < floor ? floor : g;
          }
          // Smoothed across neighbouring frequencies, and opened fast but closed
          // slowly over time — what keeps it from sounding bubbly.
          for (var k3 = 0; k3 < BINS; k3++) {
            var a = gain[k3 > 0 ? k3 - 1 : 0], b = gain[k3], c = gain[k3 < BINS - 1 ? k3 + 1 : k3];
            var v = (a + 2 * b + c) / 4;
            sm[k3] = v > prev[k3] ? v : prev[k3] * 0.6 + v * 0.4;
            prev[k3] = sm[k3];
          }
          for (var k4 = 0; k4 < BINS; k4++) {
            re[k4] *= sm[k4]; im[k4] *= sm[k4];
            if (k4 > 0 && k4 < N / 2) { re[N - k4] *= sm[k4]; im[N - k4] *= sm[k4]; }
          }
          FFT(re, im, true);
          for (var j = 0; j < N; j++) {
            var q = start + j;
            if (q >= 0 && q < out.length) out[q] += (re[j] * WIN[j]) / 1.5; // Hann², 75% overlap, sums to 1.5
          }
        }
        if (onProgress) onProgress(f / frames);
        if (f < frames) setTimeout(step, 0); else resolve(out);
      })();
    });
  }

  /* ---------------- 3. the pauses: echo and clatter between phrases ---------------- */

  function quietenPauses(x, rate, amount) {
    // Level: a 10 ms running average of power — the same measure as the
    // blocks below, so the threshold and the level agree. The gain, not
    // the level, is what opens fast and closes slowly.
    var avg = Math.exp(-1 / (rate * 0.01));
    var blockN = Math.round(rate * 0.01), levels = [], env = 0, i;
    for (i = 0; i < x.length; i += blockN) {
      var e = 0, n = 0;
      for (var j = i; j < Math.min(x.length, i + blockN); j++) { e += x[j] * x[j]; n++; }
      if (e > 0) levels.push(10 * Math.log10(e / n + 1e-20));
    }
    if (!levels.length) return;
    levels.sort(function (a, b) { return a - b; });
    var ref = levels[Math.floor(levels.length * 0.95)];         // the singing
    var thr = ref - (24 - 12 * amount);                           // below this is a pause
    var ratio = 2 + 3 * amount, maxRed = 6 + 18 * amount;
    var open = Math.exp(-1 / (rate * 0.002)), close = Math.exp(-1 / (rate * 0.08)), g = 1;
    for (i = 0; i < x.length; i++) {
      var s2 = x[i] * x[i];
      env = avg * env + (1 - avg) * s2;
      var lvl = 10 * Math.log10(env + 1e-20);
      var red = lvl < thr ? Math.min(maxRed, (thr - lvl) * (ratio - 1)) : 0;
      var target = dbToLin(-red);
      g = target > g ? open * g + (1 - open) * target : close * g + (1 - close) * target;
      x[i] *= g;
    }
  }

  /* ---------------- 5. a room for the reverb ---------------- */

  var ROOMS = {
    room: { t: 0.7, pre: 0.008, damp: 0.55 },
    hall: { t: 1.8, pre: 0.02, damp: 0.35 },
    temple: { t: 3.0, pre: 0.035, damp: 0.18 },
  };

  function impulse(ctx, style) {
    var P = ROOMS[style] || ROOMS.hall, rate = ctx.sampleRate;
    var pre = Math.round(P.pre * rate), len = pre + Math.round(P.t * rate);
    var ir = ctx.createBuffer(1, len, rate), d = ir.getChannelData(0);
    var seed = 12345, lp = 0;
    for (var i = pre; i < len; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      var noise = (seed / 0x7fffffff) * 2 - 1, n = i - pre;
      // Darker as it dies away, as a real room's air soaks up the highs.
      lp += (1 - P.damp * (0.4 + (0.6 * n) / len)) * (noise - lp);
      d[i] = lp * Math.exp((-6.9 * n) / (P.t * rate));
    }
    // A few early reflections off the nearest walls.
    [0.011, 0.019, 0.027, 0.041].forEach(function (s, k) {
      var at = pre + Math.round(s * rate * (P.t / 1.8));
      if (at < len) d[at] += 0.5 / (k + 1);
    });
    return ir;
  }

  /* ---------------- the whole pass ---------------- */

  /**
   * @returns Promise<{ buffer: AudioBuffer, map: {src,out,len}[] }> — the
   * result, and where each stretch of it came from in the original (so the
   * playhead can follow while the result plays).
   */
  function render(src, segs, S, onProgress) {
    var tick = function (p) { if (onProgress) onProgress(Math.round(p * 100)); };
    var A = assemble(src, segs), x = A.data, rate = A.rate;
    var withNoise = S.noise > 0;
    tick(0.05);
    var chain = Promise.resolve(x);
    if (withNoise) {
      chain = yieldNow().then(function () {
        var from = S.noiseFrom;
        return denoise(x, noiseProfile(src, from), S.noise / 100, function (p) { tick(0.05 + 0.7 * p); });
      });
    }
    return chain.then(function (y) {
      if (S.echo > 0) quietenPauses(y, rate, S.echo / 100);
      tick(withNoise ? 0.8 : 0.4);
      var reverb = S.reverb !== 'none' && S.reverbAmt > 0;
      var tail = reverb ? Math.round(Math.min(2.5, (ROOMS[S.reverb] || ROOMS.hall).t) * rate) : 0;
      var Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      var ctx = new Off(1, Math.max(1, y.length + tail), rate);
      var inBuf = ctx.createBuffer(1, Math.max(1, y.length), rate);
      inBuf.getChannelData(0).set(y);
      if (!S.rumble && !S.hum && !reverb) return inBuf;
      var srcNode = ctx.createBufferSource();
      srcNode.buffer = inBuf;
      var node = srcNode;
      if (S.rumble) {
        // Two stages (a steep 4th-order Butterworth) so 50 Hz traffic drops
        // well down while a man's lowest sa, around 100 Hz, is left alone.
        [0.541, 1.307].forEach(function (q) {
          var hp = ctx.createBiquadFilter();
          hp.type = 'highpass'; hp.frequency.value = 80; hp.Q.value = q;
          node.connect(hp); node = hp;
        });
      }
      if (S.hum) {
        [1, 2, 3, 4].forEach(function (h) {
          var n = ctx.createBiquadFilter();
          n.type = 'notch'; n.frequency.value = S.hum * h; n.Q.value = 30;
          node.connect(n); node = n;
        });
      }
      node.connect(ctx.destination);
      if (reverb) {
        var conv = ctx.createConvolver();
        conv.normalize = true;
        conv.buffer = impulse(ctx, S.reverb);
        var wet = ctx.createGain();
        wet.gain.value = (S.reverbAmt / 100) * 0.6;
        node.connect(conv); conv.connect(wet); wet.connect(ctx.destination);
      }
      srcNode.start(0);
      return new Promise(function (resolve, reject) {
        ctx.oncomplete = function (e) { resolve(e.renderedBuffer); };
        var p = ctx.startRendering();
        if (p && p.then) p.then(resolve, reject);
      });
    }).then(function (out) {
      tick(0.92);
      var d = out.getChannelData(0), n = d.length, i;
      var peak = 0;
      for (i = 0; i < n; i++) { var a = d[i] < 0 ? -d[i] : d[i]; if (a > peak) peak = a; }
      var gain = 1;
      if (S.normalize && peak > 0) {
        // Loudness of the singing only — the pauses don't count.
        var blockN = Math.round(rate * 0.05), blocks = [];
        for (i = 0; i < n; i += blockN) {
          var e = 0, m = 0;
          for (var j = i; j < Math.min(n, i + blockN); j++) { e += d[j] * d[j]; m++; }
          blocks.push(Math.sqrt(e / Math.max(1, m)));
        }
        var loud = blocks.reduce(function (a2, b2) { return b2 > a2 ? b2 : a2; }, 0);
        var act = blocks.filter(function (b3) { return b3 > loud * 0.05; });
        var rms = Math.sqrt(act.reduce(function (s, b4) { return s + b4 * b4; }, 0) / Math.max(1, act.length));
        if (rms > 0) gain = dbToLin(-20) / rms;           // about -20 dBFS while singing
      }
      if (peak * gain > 0.89) gain = 0.89 / peak;         // and never within 1 dB of clipping
      var fi = Math.round(S.fadeIn * rate), fo = Math.round(S.fadeOut * rate);
      for (i = 0; i < n; i++) {
        var g = gain;
        if (fi && i < fi) g *= Math.sin((Math.PI / 2) * (i / fi));
        if (fo && n - i <= fo) g *= Math.sin((Math.PI / 2) * ((n - i) / fo));
        d[i] *= g;
      }
      tick(1);
      return { buffer: out, map: A.map };
    });
  }

  /* One-tap starting points. Each sets only the clean-up, loudness and
     reverb settings; fades, hum and per-part volume stay as they were. */
  var PRESET_KEYS = ['normalize', 'rumble', 'noise', 'echo', 'reverb', 'reverbAmt'];
  var PRESETS = {
    none: { normalize: false, rumble: false, noise: 0, echo: 0, reverb: 'none', reverbAmt: 30 },
    clean: { normalize: true, rumble: true, noise: 30, echo: 0, reverb: 'none', reverbAmt: 30 },
    quiet: { normalize: true, rumble: true, noise: 55, echo: 40, reverb: 'none', reverbAmt: 30 },
    concert: { normalize: true, rumble: true, noise: 0, echo: 0, reverb: 'hall', reverbAmt: 25 },
  };
  function applyPreset(S, key) {
    var p = PRESETS[key];
    if (p) PRESET_KEYS.forEach(function (k) { S[k] = p[k]; });
    return S;
  }
  /** Which preset the settings match, or null when they've been fine-tuned. */
  function whichPreset(S) {
    for (var key in PRESETS) {
      var p = PRESETS[key], same = PRESET_KEYS.every(function (k) {
        if (k === 'reverbAmt' && p.reverb === 'none') return true;
        return S[k] === p[k];
      });
      if (same) return key;
    }
    return null;
  }

  window.SrutiFx = { defaults: defaults, isActive: isActive, render: render, applyPreset: applyPreset, whichPreset: whichPreset };
})();
