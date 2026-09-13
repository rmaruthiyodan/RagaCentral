/* ==================================================================
 * Speaking a lesson note.
 *
 * Press the microphone, say a sentence in Malayalam, press it again.
 * The clip goes up, and the Malayalam and English come back into the
 * two boxes for the teacher to correct. Nothing is saved until he
 * presses Save, so a bad transcript costs a retry and nothing else.
 *
 * Deliberately does NOT reuse recorder.js: that one encodes to MP3 with
 * lamejs so a take plays on every phone forever. This clip is thrown
 * away the moment it has been read, so whatever the browser records
 * natively is fine — WebM/Opus in Chrome, MP4/AAC in Safari — and both
 * transcribers take either. It saves a 152 KB download and a few
 * seconds of encoding on every note.
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

      var body = new FormData();
      body.append('audio', blob, 'note.' + ext(blob.type));

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

  function ext(mime) {
    if (!mime) return 'webm';
    if (mime.indexOf('mp4') > -1 || mime.indexOf('m4a') > -1) return 'm4a';
    if (mime.indexOf('ogg') > -1) return 'ogg';
    if (mime.indexOf('wav') > -1) return 'wav';
    return 'webm';
  }
})();
