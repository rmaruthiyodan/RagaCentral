import { esc } from '../util';
import type { User } from '../types';

interface LayoutOpts {
  title: string;
  user?: User | null;
  siteName?: string;
  nav?: 'students' | 'catalogue' | 'approvals' | 'schedule' | 'mine' | null;
  scripts?: string[];
  bodyClass?: string;
}

const FONTS =
  'https://fonts.googleapis.com/css2?family=Literata:opsz,wght@7..72,400;7..72,600;7..72,700' +
  '&family=Public+Sans:wght@400;500;600;700' +
  '&family=JetBrains+Mono:wght@400;500' +
  '&family=Noto+Sans+Malayalam:wght@400;500;600&display=swap';

/**
 * The mark. Served at 96px and drawn at 30, so it stays sharp on a retina
 * screen; alt is empty because the name sits right beside it.
 */
const MARK = `<img class="brand-mark" src="/logo.png" alt="" width="30" height="30">`;

/**
 * The palettes anyone can pick, and the dot shown beside each name.
 * The tokens themselves live in app.css under [data-palette]; this is
 * only the menu. Adding one means adding it in both places.
 */
export const PALETTES: { id: string; name: string; dot: string }[] = [
  { id: 'brass', name: 'Brass & Peacock', dot: '#9A6A28' },
  { id: 'indigo', name: 'Indigo & Copper', dot: '#33408C' },
  { id: 'palm', name: 'Palm & Sandalwood', dot: '#2F6146' },
  { id: 'kumkum', name: 'Kumkum & Slate', dot: '#B03A2E' },
  { id: 'night', name: 'Night Practice', dot: '#A8681B' },
];

const MODES: { id: string; name: string }[] = [
  { id: 'auto', name: 'Match my device' },
  { id: 'light', name: 'Always light' },
  { id: 'dark', name: 'Always dark' },
];

export function isPalette(v: string): boolean {
  return PALETTES.some((p) => p.id === v);
}
export function isMode(v: string): boolean {
  return MODES.some((m) => m.id === v);
}

/**
 * The picker, in the top bar. A <details> rather than a menu widget, and
 * a form post rather than a fetch: choosing a colour has to work on a
 * phone with a bad connection and no JavaScript. The route sends you
 * back where you were using the Referer header, so this doesn't have to
 * be threaded through thirty call sites.
 */
function themePicker(palette: string, mode: string): string {
  const current = PALETTES.find((p) => p.id === palette) ?? PALETTES[0];
  return `<details class="themepick">
  <summary title="Colours" aria-label="Change colours">
    <span class="tp-dot" style="background:${esc(current.dot)}"></span>
  </summary>
  <div class="tp-menu">
    <form method="post" action="/settings/theme">
      <div class="tp-h">Colours</div>
      ${PALETTES.map(
        (p) => `<button class="tp-opt${p.id === current.id ? ' is-on' : ''}"
          name="palette" value="${esc(p.id)}" type="submit">
        <span class="tp-dot" style="background:${esc(p.dot)}"></span>${esc(p.name)}</button>`,
      ).join('')}
      <div class="tp-h">Light or dark</div>
      ${MODES.map(
        (m) => `<button class="tp-opt${m.id === mode ? ' is-on' : ''}"
          name="theme_mode" value="${esc(m.id)}" type="submit">${esc(m.name)}</button>`,
      ).join('')}
    </form>
  </div>
</details>`;
}

export function page(body: string, o: LayoutOpts): string {
  const site = o.siteName || 'RP Sajeev Music';
  const u = o.user;
  const isTeacher = u?.role === 'teacher';
  const palette = u?.palette && isPalette(u.palette) ? u.palette : 'brass';
  const mode = u?.theme_mode && isMode(u.theme_mode) ? u.theme_mode : 'auto';

  const nav = u
    ? isTeacher
      ? `<nav class="nav">
           <a href="/t"${o.nav === 'students' ? ' aria-current="page"' : ''}>Students</a>
           <a href="/t/schedule/week"${o.nav === 'schedule' ? ' aria-current="page"' : ''}>Schedule</a>
           <a href="/t/catalogue"${o.nav === 'catalogue' ? ' aria-current="page"' : ''}>Songs</a>
           <a href="/t/approvals"${o.nav === 'approvals' ? ' aria-current="page"' : ''}>Approvals</a>
         </nav>`
      : `<nav class="nav"><a href="/me"${o.nav === 'mine' ? ' aria-current="page"' : ''}>My songs</a></nav>`
    : '<div class="nav"></div>';

  const whoami = u
    ? `<div class="whoami">
         ${themePicker(palette, mode)}
         ${u.avatar_url ? `<img src="${esc(u.avatar_url)}" alt="" referrerpolicy="no-referrer">` : ''}
         <span class="who-name">${esc(u.name)}</span>
         <form method="post" action="/auth/logout"><button class="btn btn-sm btn-quiet" type="submit">Sign out</button></form>
       </div>`
    : '';

  /* Rendered on the server, so the right colours are there in the first
     paint. A class that flips the theme in JavaScript after load gives
     every page a flash of the previous one. */
  return `<!doctype html>
<html lang="en" data-palette="${esc(palette)}"${mode === 'auto' ? '' : ` data-theme="${esc(mode)}"`}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)} · ${esc(site)}</title>
<meta name="robots" content="noindex,nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="/app.css">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/logo.png">
</head>
<body class="${esc(o.bodyClass ?? '')}">
<header class="topbar">
  <div class="topbar-in">
    <a class="brand" href="${u ? (isTeacher ? '/t' : '/me') : '/'}">${MARK}${esc(site)}</a>
    ${nav}
    ${whoami}
  </div>
</header>
<main${o.bodyClass === 'narrow' ? ' class="narrow"' : ''}>
${body}
</main>
${['/disclose.js', ...(o.scripts ?? [])]
  .map((s) => `<script src="${esc(s)}" defer></script>`)
  .join('\n')}
${u ? `<script>
/* Report this browser's IANA time zone once, so class times can be shown on
   the right clock. Only posts when it differs from what the server has, so a
   student travelling for a week doesn't silently repoint their schedule more
   than once. */
(function(){try{
  var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz && tz !== ${JSON.stringify(u.time_zone ?? '')}) {
    fetch('/api/tz', {method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({tz: tz})});
  }
}catch(e){}})();
</script>` : ''}
</body>
</html>`;
}

/** Renders a title with its Malayalam form underneath, when there is one. */
export function titleWithScript(title: string, ml: string | null | undefined): string {
  return ml
    ? `${esc(title)}<span class="sub-ml ml">${esc(ml)}</span>`
    : esc(title);
}

/** Inline version for list rows. */
export function inlineTitle(title: string, ml: string | null | undefined): string {
  return ml ? `${esc(title)} <span class="ml">· ${esc(ml)}</span>` : esc(title);
}

export function avatar(u: { name: string; avatar_url?: string | null }): string {
  if (u.avatar_url)
    return `<img class="avatar" src="${esc(u.avatar_url)}" alt="" referrerpolicy="no-referrer">`;
  const initial = (u.name || '?').trim().charAt(0).toUpperCase();
  return `<div class="avatar avatar-fallback">${esc(initial)}</div>`;
}

/* ------------------------------------------------------------------ *
 * Disclosure
 *
 * A collapsible section. Plain <details>, so it works with no JavaScript
 * at all; disclose.js only adds the memory of what you left open and the
 * expand-all buttons. `title` and `meta` are HTML — callers escape.
 * `key` must be stable across renders, or the memory attaches to the
 * wrong section after an edit.
 * ------------------------------------------------------------------ */
export function disclosure(o: {
  key: string;
  title: string;
  meta?: string;
  body: string;
  open?: boolean;
  cls?: string;
}): string {
  return `<details class="disc${o.cls ? ` ${o.cls}` : ''}" data-disc="${esc(o.key)}"${
    o.open ? ' open' : ''
  }>
  <summary>
    <span class="disc-mark" aria-hidden="true"></span>
    <span class="disc-title">${o.title}</span>
    ${o.meta ? `<span class="disc-meta">${o.meta}</span>` : ''}
  </summary>
  <div class="disc-body">${o.body}</div>
</details>`;
}

/** The expand-all / collapse-all pair. Hidden when JavaScript is off. */
export function discloseAll(label = 'sections'): string {
  return `<div class="disc-all" hidden data-disc-all-bar>
  <button class="btn btn-sm btn-quiet" type="button" data-disc-all="open">Expand all</button>
  <button class="btn btn-sm btn-quiet" type="button" data-disc-all="close">Collapse all</button>
  <span class="disc-all-note">${esc(label)}</span>
</div>`;
}

export function flash(msg: string | undefined, kind: 'ok' | 'err' = 'ok'): string {
  if (!msg) return '';
  return `<div class="flash${kind === 'err' ? ' err' : ''}">${esc(msg)}</div>`;
}
