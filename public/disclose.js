/* ==================================================================
 * Collapsible sections — the memory, not the mechanism.
 *
 * The sections are plain <details>, so they open and close with no
 * JavaScript. This file only adds the two things markup can't do:
 * remembering what you left open, and expand-all / collapse-all.
 *
 * State is per browser, keyed by the section's stable `data-disc` key,
 * and nothing here is sent to the server.
 * ================================================================== */
(function () {
  var KEY = 'sruti.disclosure';
  var state = {};

  try {
    state = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch (e) {
    state = {}; // private window, or storage blocked — carry on without memory
  }

  var save = function () {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      /* nothing to do; the page still works, it just won't remember */
    }
  };

  var all = function () {
    return Array.prototype.slice.call(document.querySelectorAll('details[data-disc]'));
  };

  all().forEach(function (d) {
    var k = d.getAttribute('data-disc');
    if (Object.prototype.hasOwnProperty.call(state, k)) d.open = !!state[k];
    d.addEventListener('toggle', function () {
      state[k] = d.open;
      save();
    });
  });

  /* The buttons are hidden in the markup so they never appear without
     the script that makes them work. */
  Array.prototype.slice.call(document.querySelectorAll('[data-disc-all-bar]')).forEach(function (bar) {
    bar.hidden = false;
  });

  /* Buttons that live inside a <summary> — the reorder arrows. A click
     anywhere in a summary toggles its <details>, so without this the
     section would collapse (or spring open) as the page navigates away.
     Capture phase, because the toggle is the browser's own default on
     the summary, and stopPropagation alone wouldn't reach it. */
  document.addEventListener(
    'click',
    function (ev) {
      var keep = ev.target.closest && ev.target.closest('[data-keep-open]');
      if (!keep) return;
      var sum = keep.closest('summary');
      if (!sum) return;
      var d = sum.parentElement;
      if (!d || d.tagName !== 'DETAILS') return;
      var was = d.open;
      // Let the button submit, then put the section back how it was.
      setTimeout(function () {
        if (d.open !== was) d.open = was;
      }, 0);
    },
    true,
  );

  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest && ev.target.closest('[data-disc-all]');
    if (!btn) return;
    var want = btn.getAttribute('data-disc-all') === 'open';
    all().forEach(function (d) {
      if (d.open !== want) d.open = want; // fires toggle, which records it
    });
  });
})();
