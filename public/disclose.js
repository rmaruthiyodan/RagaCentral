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

  /* A panel that floats out of its row — the schedule's Change panel — can
     open below the fold, where nothing tells you it opened at all. Bring it
     into view once, gently, and only when it actually doesn't fit. */
  Array.prototype.slice.call(document.querySelectorAll('details[data-reveal]')).forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (!d.open) return;
      var body = d.querySelector('[data-reveal-body]') || d.lastElementChild;
      if (!body || !body.getBoundingClientRect) return;
      var r = body.getBoundingClientRect();
      if (r.bottom <= (window.innerHeight || 0) - 8) return; // already visible
      try {
        body.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } catch (e) {
        body.scrollIntoView(false); // older browsers take no options
      }
    });
  });

  /* Pop-ups that can be dismissed — the calendar's quick add and quick
     cancel. They are plain <details>, so the summary opens and closes them
     with no script at all; this adds the ways out people expect of a
     pop-up: a Cancel or × inside it, Escape, a click anywhere else, and
     only one open at a time. */
  var dismissable = function () {
    return Array.prototype.slice.call(document.querySelectorAll('details[data-dismiss][open]'));
  };
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    var closer = t.closest && t.closest('[data-close-details]');
    if (closer) {
      var d = closer.closest('details');
      if (d) {
        d.open = false;
        var s = d.querySelector('summary');
        if (s && s.focus) s.focus();
      }
      return;
    }
    dismissable().forEach(function (d) {
      if (!d.contains(t)) d.open = false;
    });
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape') return;
    dismissable().forEach(function (d) {
      d.open = false;
    });
  });
  Array.prototype.slice.call(document.querySelectorAll('details[data-dismiss]')).forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (!d.open) return;
      document.body.classList.add('has-pop');
      dismissable().forEach(function (o) {
        if (o !== d) o.open = false;
      });
      /* Straight to the first field, so a teacher on a phone can pick a
         student the moment the sheet is up. Not on a chip's cancel, where
         the reason is optional and the keyboard would only get in the way. */
      var first = d.querySelector('select, input:not([type=hidden])');
      if (first && d.classList.contains('cal-add') && window.matchMedia &&
          !window.matchMedia('(max-width: 720px)').matches) {
        try { first.focus({ preventScroll: true }); } catch (e) { first.focus(); }
      }
    });
    d.addEventListener('toggle', function () {
      if (!dismissable().length) document.body.classList.remove('has-pop');
    });
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
