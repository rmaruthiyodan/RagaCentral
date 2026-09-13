/* ==================================================================
 * Speaking a lesson note.
 *
 * Press the microphone, say a sentence in Malayalam, press it again.
 * The clip goes up, and the Malayalam and English come back into the
 * two boxes for the teacher to correct. Nothing is saved until he
 * presses Save, so a bad transcript costs a retry and nothing else.
 *
 * What gets sent is a 16 kHz mono WAV, not what the browser recorded.
 *
 * Browsers record what suits them — WebM/Opus in Chrome, MP4/AAC in
 * Safari — and Sarvam accepts neither:
 *
 *   Invalid file type: audio/webm;codecs=opus. Only ['audio/mpeg',
 *   'audio/mp3', … 'audio/wav', … 'audio/pcm_s16le']
 *
 * So the clip is decoded and re-encoded here. WAV rather than MP3
 * because it needs no encoder library — recorder.js pulls in 152 KB of
 * lamejs for that, and this page shouldn't have to — and 16 kHz mono
 * because that is what speech recognition actually wants: it is a
 * *smaller* upload than 48 kHz stereo Opus for a short take, and every
 * transcriber accepts it, so one format serves both providers.
 * ================================================================== */
(function () {
  var MAX_MS = 120000; // two minutes, then it stops itself

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

      toWav(blob).then(
        function (wav) {
          upload(wav);
        },
        function (err) {
          setState('idle');
          say(
            'That recording could not be read back (' + (err && err.message ? err.message : 'decode failed') +
              '). Try again, or type it.',
            'bad',
          );
        },
      );
    }

    function upload(wav) {
      var body = new FormData();
      body.append('audio', wav, 'note.wav');

      fetch('/t/api/dictate', { method: 'POST', body: body })
        .then(function (r) {
          return r.json().then(function (j) {
            return { ok: r.ok, j: j };
          });
        })
        .then(function (res) {
          setState('idle');
          if (!res.ok) return say(res.j.error || 'That did not work. Type it instead.', 'bad');
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
      say('Written down. Read it over before you save — it will have got something wrong.', 'ok');
    }

    function join(existing, added) {
      var e = (existing || '').trim();
      return e ? e + ' ' + added : added;
    }
  }

  /* ----------------------------------------------------------------
   * Whatever the browser recorded → 16 kHz mono WAV.
   * ---------------------------------------------------------------- */

  var TARGET_RATE = 16000;

  function toWav(blob) {
    return blob.arrayBuffer().then(function (buf) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('no audio support in this browser');
      var ctx = new Ctx();
      return decode(ctx, buf).then(function (decoded) {
        ctx.close();
        return resample(decoded).then(function (mono) {
          return new Blob([wavBytes(mono.samples, mono.rate)], { type: 'audio/wav' });
        });
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
     arbitrary rate, so fall back to the source rate and let the WAV
     header say so rather than failing outright. */
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

  /** 16-bit PCM in a WAV wrapper. */
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
