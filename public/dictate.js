/* ==================================================================
 * Speaking a lesson note.
 *
 * Press the microphone, say a sentence in Malayalam, press it again.
 * The clip goes up, and the Malayalam and English come back into the
 * two boxes for the teacher to correct. Nothing is saved until he
 * presses Save, so a bad transcript costs a retry and nothing else.
 *
 * ------------------------------------------------------------------
 * WHAT GETS SENT, AND WHY IT IS NOT WHAT WAS RECORDED
 *
 * A base64 string of a 16 kHz mono MP3 — not the WebM the browser
 * recorded, and not the WAV this file used to send. Three reasons,
 * in the order they were discovered:
 *
 * 1. Browsers record what suits them — WebM/Opus in Chrome, MP4/AAC in
 *    Safari — and Sarvam accepts neither:
 *
 *      Invalid file type: audio/webm;codecs=opus. Only ['audio/mpeg',
 *      'audio/mp3', … 'audio/wav', … 'audio/pcm_s16le']
 *
 *    So it has to be re-encoded somewhere regardless.
 *
 * 2. 16 kHz mono is what speech recognition actually wants, and it is
 *    less data than 48 kHz stereo.
 *
 * 3. And the one that rewrote this file: the server gets **10 ms of
 *    CPU per request** on Cloudflare's free plan. Handing it a
 *    megabyte of audio to base64 costs it fifty. It was dying every
 *    time, which arrived here as a connection that simply stopped —
 *    indistinguishable, from the teacher's side, from the transcriber
 *    being slow.
 *
 *    So this page does the work instead. MP3 at 32 kbps is about a
 *    twentieth the size of the same audio as WAV, and the base64 is
 *    done here too, where CPU is a phone's and free. The server now
 *    receives the exact string the model wants and passes it along
 *    without looking at it.
 *
 * The MP3 encoder is the same lamejs that recorder.js uses, loaded on
 * first press and shared. If it will not load, this falls back to WAV
 * and a short clip still works — the server's limit is generous enough
 * for a sentence either way.
 * ================================================================== */
(function () {
  var MAX_MS = 120000; // two minutes, then it stops itself
  var TARGET_RATE = 16000;
  var MP3_KBPS = 32; // speech, mono, 16 kHz — plenty, and small

  if (!navigator.mediaDevices || !window.MediaRecorder) {
    // No recording in this browser: leave the buttons out entirely rather
    // than offering something that will fail on the first press.
    document.querySelectorAll('[data-mic]').forEach(function (b) {
      b.remove();
    });
    return;
  }

  document.querySelectorAll('[data-spoken]').forEach(setup);

  function setup(field) {
    var btn = field.querySelector('[data-mic]');
    if (!btn) return;

    var label = btn.querySelector('[data-mic-label]');
    var status = field.querySelector('[data-mic-status]');
    var mlWrap = field.querySelector('[data-ml-wrap]');
    var mlBox = field.querySelector('[data-ml]');
    var enBox = field.querySelector('[data-en]');
    var enTag = field.querySelector('[data-en-tag]');

    var rec = null;
    var chunks = [];
    var stopTimer = null;
    var ticker = null;

    function say(msg, kind) {
      status.hidden = !msg;
      status.textContent = msg || '';
      status.className = 'mic-status' + (kind ? ' is-' + kind : '');
    }

    function setState(s) {
      field.setAttribute('data-mic-state', s);
      btn.disabled = s === 'working';
      label.textContent = s === 'recording' ? 'Stop' : s === 'working' ? 'Reading it…' : 'Speak it';
      btn.setAttribute(
        'aria-label',
        s === 'recording' ? 'Stop recording' : 'Speak this in Malayalam',
      );
    }

    btn.addEventListener('click', function () {
      if (rec && rec.state === 'recording') return stop();
      start();
    });

    function start() {
      say('');
      /* Start fetching the encoder now rather than after the take: by
         the time he has finished a sentence it is already here, and the
         wait disappears into the recording. */
      loadLame().catch(function () {});
      navigator.mediaDevices.getUserMedia({ audio: true }).then(
        function (stream) {
          chunks = [];
          try {
            rec = new MediaRecorder(stream);
          } catch (e) {
            release(stream);
            return say('This browser would not start the microphone.', 'bad');
          }
          rec.ondataavailable = function (e) {
            if (e.data && e.data.size) chunks.push(e.data);
          };
          rec.onstop = function () {
            release(stream);
            clearInterval(ticker);
            clearTimeout(stopTimer);
            send(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
          };
          rec.start();
          setState('recording');

          var began = Date.now();
          say('Listening… 0:00');
          ticker = setInterval(function () {
            var s = Math.floor((Date.now() - began) / 1000);
            say('Listening… ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'));
          }, 250);
          // Long dictations get expensive and transcribe badly. Stop at two
          // minutes rather than let a pocketed phone record the whole class.
          stopTimer = setTimeout(stop, MAX_MS);
        },
        function (err) {
          say(
            err && err.name === 'NotAllowedError'
              ? 'The microphone is blocked for this site. Allow it in the address bar and try again.'
              : 'No microphone was available.',
            'bad',
          );
        },
      );
    }

    function stop() {
      if (rec && rec.state === 'recording') rec.stop();
    }

    function release(stream) {
      stream.getTracks().forEach(function (t) {
        t.stop();
      });
    }

    function send(blob) {
      if (!blob.size) {
        setState('idle');
        return say('Nothing was recorded.', 'bad');
      }
      setState('working');
      say('Reading it back…');

      prepare(blob).then(
        function (clip) {
          upload(clip);
        },
        function (err) {
          setState('idle');
          say(
            'That recording could not be read back (' +
              (err && err.message ? err.message : 'decode failed') +
              '). Try again, or type it.',
            'bad',
          );
        },
      );
    }

    function upload(clip) {
      fetch('/t/api/dictate', {
        method: 'POST',
        headers: {
          'content-type': 'text/plain;charset=utf-8',
          'x-audio-type': clip.mime,
        },
        body: clip.b64,
      })
        .then(function (r) {
          /* A Worker that runs out of CPU does not answer with JSON — it
             answers with Cloudflare's error page, or with nothing. Read
             the body as text first so that case produces a sentence
             instead of a SyntaxError in the console. */
          return r.text().then(function (body) {
            var j = null;
            try {
              j = JSON.parse(body);
            } catch (e) {
              /* not JSON */
            }
            return { ok: r.ok, status: r.status, j: j };
          });
        })
        .then(function (res) {
          setState('idle');
          if (res.j && res.j.error) return say(res.j.error, 'bad');
          if (!res.ok || !res.j)
            return say(
              'The site could not read that clip back (error ' + res.status + '). ' +
                'A shorter clip usually works. Otherwise type it.',
              'bad',
            );
          fill(res.j);
        })
        .catch(function () {
          setState('idle');
          say('Could not reach the server. Type it instead.', 'bad');
        });
    }

    /* Appends rather than replaces: two sentences spoken one after the
       other should both survive, and a correction already typed into the
       box should not be wiped by the next press. */
    function fill(t) {
      var got = false;
      if (t.ml) {
        mlWrap.hidden = false;
        if (enTag) enTag.hidden = false;
        mlBox.value = join(mlBox.value, t.ml);
        got = true;
      }
      if (t.en) {
        enBox.value = join(enBox.value, t.en);
        got = true;
      }
      if (!got) return say('Nothing came back — try saying it again.', 'bad');
      /* The server says when the result is not what was asked for —
         Malayalam that came back in the Latin alphabet, most often.
         Better to explain it than to let him wonder why one box is
         empty. */
      if (t.note) return say(t.note, 'warn');
      say('Written down. Read it over before you save — it will have got something wrong.', 'ok');
    }

    function join(existing, added) {
      var e = (existing || '').trim();
      return e ? e + ' ' + added : added;
    }
  }

  /* ----------------------------------------------------------------
   * Whatever the browser recorded → base64 of a 16 kHz mono MP3.
   * ---------------------------------------------------------------- */

  function prepare(blob) {
    return blob
      .arrayBuffer()
      .then(function (buf) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) throw new Error('no audio support in this browser');
        var ctx = new Ctx();
        return decode(ctx, buf).then(function (decoded) {
          ctx.close();
          return resample(decoded);
        });
      })
      .then(function (mono) {
        return toMp3(mono.samples, mono.rate).then(
          function (mp3) {
            return mp3;
          },
          function () {
            /* No encoder. WAV is twenty times the size, which is fine
               for a sentence and refused for a monologue — better than
               no dictation at all. */
            return new Blob([wavBytes(mono.samples, mono.rate)], { type: 'audio/wav' });
          },
        );
      })
      .then(function (file) {
        return toBase64(file).then(function (b64) {
          return { b64: b64, mime: file.type || 'audio/mpeg' };
        });
      });
  }

  /* Safari's decodeAudioData only learned to return a promise recently;
     the callback form works everywhere. */
  function decode(ctx, buf) {
    return new Promise(function (resolve, reject) {
      var p = ctx.decodeAudioData(
        buf,
        function (d) { resolve(d); },
        function (e) { reject(e || new Error('could not decode the recording')); },
      );
      if (p && p.then) p.then(resolve, reject);
    });
  }

  /* OfflineAudioContext does the mixdown and the rate conversion, and it
     does them properly — a hand-rolled sample-skipping resample aliases
     badly, which a transcriber hears as noise. Some browsers refuse an
     arbitrary rate, so fall back to the source rate and let the encoder
     say so rather than failing outright. */
  function resample(decoded) {
    var OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var length = Math.ceil((decoded.duration || 0) * TARGET_RATE);
    if (!OC || !length) return Promise.resolve(flatten(decoded));

    var off;
    try {
      off = new OC(1, length, TARGET_RATE);
    } catch (e) {
      return Promise.resolve(flatten(decoded)); // rate refused; send as recorded
    }
    var src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    return off.startRendering().then(
      function (out) { return { samples: out.getChannelData(0), rate: out.sampleRate }; },
      function () { return flatten(decoded); },
    );
  }

  /** Average the channels down to one, at whatever rate they came in. */
  function flatten(decoded) {
    var n = decoded.length;
    var chans = decoded.numberOfChannels;
    if (chans === 1) return { samples: decoded.getChannelData(0), rate: decoded.sampleRate };
    var out = new Float32Array(n);
    for (var c = 0; c < chans; c++) {
      var data = decoded.getChannelData(c);
      for (var i = 0; i < n; i++) out[i] += data[i] / chans;
    }
    return { samples: out, rate: decoded.sampleRate };
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
      s.onerror = function () {
        lameLoading = null; // let the next press try again
        reject(new Error('Could not load the MP3 encoder'));
      };
      document.head.appendChild(s);
    });
    return lameLoading;
  }

  /* Two minutes of speech is about two seconds of encoding on a phone,
     so it yields between blocks: a page frozen mid-dictation looks
     broken, and the button already says "Reading it…". */
  function toMp3(samples, rate) {
    return loadLame().then(function () {
      var n = samples.length;
      var pcm = new Int16Array(n);
      for (var i = 0; i < n; i++) {
        var v = samples[i];
        v = v < -1 ? -1 : v > 1 ? 1 : v;
        pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }

      return new Promise(function (resolve, reject) {
        var enc;
        try {
          enc = new window.lamejs.Mp3Encoder(1, rate, MP3_KBPS);
        } catch (e) {
          reject(e);
          return;
        }
        var FRAME = 1152;
        var PER_TICK = FRAME * 20; // ~1.4 s of audio per yield: ~40 ms of work, no visible jank
        var out = [];
        var i = 0;

        function step() {
          var end = Math.min(pcm.length, i + PER_TICK);
          try {
            while (i < end) {
              var buf = enc.encodeBuffer(pcm.subarray(i, Math.min(i + FRAME, pcm.length)));
              if (buf.length > 0) out.push(new Int8Array(buf));
              i += FRAME;
            }
          } catch (e) {
            reject(e);
            return;
          }
          if (i < pcm.length) return setTimeout(step, 0);
          var tail = enc.flush();
          if (tail.length > 0) out.push(new Int8Array(tail));
          resolve(new Blob(out, { type: 'audio/mpeg' }));
        }
        step();
      });
    });
  }

  /* ---------------- base64, done by the browser ---------------- */

  /**
   * FileReader rather than a loop over the bytes: it is the browser's
   * own encoder, it runs off the main thread, and it does not care how
   * big the blob is. A hand-written chunked encoder is the thing that
   * was killing the server, and it would be no faster here.
   */
  function toBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result || '');
        var comma = s.indexOf(',');
        if (comma < 0) return reject(new Error('could not encode the clip'));
        resolve(s.slice(comma + 1));
      };
      fr.onerror = function () { reject(new Error('could not encode the clip')); };
      fr.readAsDataURL(blob);
    });
  }

  /** 16-bit PCM in a WAV wrapper — the fallback when lamejs will not load. */
  function wavBytes(samples, rate) {
    var n = samples.length;
    var buf = new ArrayBuffer(44 + n * 2);
    var v = new DataView(buf);
    var write = function (at, s) { for (var i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };

    write(0, 'RIFF');
    v.setUint32(4, 36 + n * 2, true);
    write(8, 'WAVE');
    write(12, 'fmt ');
    v.setUint32(16, 16, true);        // PCM header length
    v.setUint16(20, 1, true);         // format: PCM
    v.setUint16(22, 1, true);         // channels: mono
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true);  // bytes per second
    v.setUint16(32, 2, true);         // block align
    v.setUint16(34, 16, true);        // bits per sample
    write(36, 'data');
    v.setUint32(40, n * 2, true);

    for (var i = 0, at = 44; i < n; i++, at += 2) {
      var s = samples[i];
      s = s < -1 ? -1 : s > 1 ? 1 : s;         // clip rather than wrap
      v.setInt16(at, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  }
})();
