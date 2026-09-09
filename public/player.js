/* Practice controls: slow playback without pitch shift, and an A–B loop.
   Both attach to whatever <audio> or <video> sits inside the same .rec block. */

(function () {
  'use strict';

  function mediaIn(block) {
    return block.querySelector('audio, video');
  }

  /* ---------- speed, pitch preserved ---------- */

  document.querySelectorAll('[data-speeds]').forEach(function (group) {
    var block = group.closest('.rec');
    var media = mediaIn(block);
    if (!media) return;

    group.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-rate]');
      if (!btn) return;
      var rate = parseFloat(btn.dataset.rate);

      // Without these the voice turns into a chipmunk when slowed down.
      media.preservesPitch = true;
      media.mozPreservesPitch = true;
      media.webkitPreservesPitch = true;
      media.playbackRate = rate;

      group.querySelectorAll('button').forEach(function (b) {
        b.setAttribute('aria-pressed', String(b === btn));
      });
    });
  });

  /* ---------- A–B loop ---------- */

  document.querySelectorAll('[data-loop]').forEach(function (btn) {
    var block = btn.closest('.rec');
    var media = mediaIn(block);
    var state = block.querySelector('[data-loop-state]');
    if (!media) return;

    var a = null;
    var b = null;

    function fmt(t) {
      var m = Math.floor(t / 60);
      var s = Math.floor(t % 60);
      return m + ':' + String(s).padStart(2, '0');
    }

    function render() {
      if (a === null) {
        btn.textContent = 'Set A';
        state.textContent = '';
      } else if (b === null) {
        btn.textContent = 'Set B';
        state.textContent = 'A ' + fmt(a);
      } else {
        btn.textContent = 'Clear loop';
        state.textContent = fmt(a) + ' → ' + fmt(b) + ' repeating';
      }
    }

    btn.addEventListener('click', function () {
      if (a === null) {
        a = media.currentTime;
      } else if (b === null) {
        var t = media.currentTime;
        if (t <= a + 0.3) {
          state.textContent = 'Let it play a little further first';
          return;
        }
        b = t;
        media.currentTime = a;
        media.play().catch(function () {});
      } else {
        a = null;
        b = null;
      }
      render();
    });

    media.addEventListener('timeupdate', function () {
      if (a !== null && b !== null && media.currentTime >= b) {
        media.currentTime = a;
      }
    });

    render();
  });

  /* ---------- tabs (record / upload) ---------- */

  var tabs = document.querySelector('.tabs');
  if (tabs) {
    tabs.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      tabs.querySelectorAll('button').forEach(function (b) {
        b.setAttribute('aria-selected', String(b === btn));
      });
      document.querySelectorAll('[data-panel]').forEach(function (p) {
        p.hidden = p.dataset.panel !== btn.dataset.tab;
      });
    });
  }
})();
