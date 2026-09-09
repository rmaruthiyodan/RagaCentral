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

  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest && ev.target.closest('[data-disc-all]');
    if (!btn) return;
    var want = btn.getAttribute('data-disc-all') === 'open';
    all().forEach(function (d) {
      if (d.open !== want) d.open = want; // fires toggle, which records it
    });
  });
})();
