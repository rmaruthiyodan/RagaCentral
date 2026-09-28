import { t, lang } from './i18n/index.ts';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford-ish, no look-alikes

/** Short, sortable-enough, URL-safe id. */
export function newId(prefix = ''): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % 32];
  return prefix ? `${prefix}_${out}` : out;
}

export function now(): string {
  return new Date().toISOString();
}

/** HTML-escape. Every value interpolated into a template must go through this. */
export function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escape text for use inside `onsubmit="return confirm('...')"` (a single-quoted
 * JS string literal sitting inside a double-quoted HTML attribute).
 *
 * `esc()` alone is NOT enough here: the browser HTML-decodes the attribute value
 * before handing it to the JS parser, so `esc()`'s `'` -> `&#39;` turns right back
 * into a raw `'` and breaks out of the JS string (e.g. a student named "O'Brien").
 * This backslash-escapes the JS special characters first, then HTML-escapes the
 * rest (but leaves the now-literal backslash/quote pair alone, since neither is
 * an HTML entity and both survive HTML decoding unchanged).
 */
export function escConfirm(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtBytes(n: number): string {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (!sec || sec < 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * A date the way it is written, in whichever language the page is in.
 * Malayalam gets Malayalam month names from the browser's own tables;
 * the numbers stay Western digits, which is what people here read.
 */
export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(lang() === 'ml' ? 'ml-IN-u-nu-latn' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** "5 days ago", "never" — the app's own words, so they translate. */
export function relativeDate(iso: string | null): string {
  if (!iso) return t('never');
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return t('today');
  if (days === 1) return t('yesterday');
  if (days < 30) return t('%s days ago', days);
  if (days < 60) return t('last month');
  return t('%s months ago', Math.floor(days / 30));
}

/** Pick a file extension from a MIME type so downloads land with a sensible name. */
export function extFor(mime: string): string {
  const map: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  return map[mime.split(';')[0].trim().toLowerCase()] ?? 'bin';
}

/* ------------------------------------------------------------------ *
 * What an uploaded file is allowed to be
 *
 * An upload's Content-Type is whatever the uploader's browser — or a
 * script pretending to be one — says it is. Stored and served back as
 * given, a "recording" declared as text/html or image/svg+xml would run
 * as a page on this site's own origin, signed in as whoever opened the
 * link. So an upload is only accepted as one of the types below, and a
 * download is only ever served as one of them (anything else goes out as
 * an opaque attachment), whatever the stored metadata says.
 * ------------------------------------------------------------------ */

const MEDIA_TYPES = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/x-aac',
  'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave', 'audio/webm', 'audio/ogg', 'audio/opus',
  'audio/flac', 'audio/x-flac', 'audio/aiff', 'audio/x-aiff', 'audio/3gpp', 'audio/amr',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/3gpp', 'video/x-m4v', 'video/ogg',
]);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);
const EXT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', webm: 'audio/webm',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac', aif: 'audio/aiff',
  aiff: 'audio/aiff', '3gp': 'audio/3gpp', amr: 'audio/amr', mp4: 'video/mp4', mov: 'video/quicktime',
  m4v: 'video/x-m4v', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', heic: 'image/heic', heif: 'image/heif',
};

function baseType(t: string | null | undefined): string {
  return String(t ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * The type an upload is filed under, or null to refuse it. The declared
 * type wins when it is on the list; a missing or generic one (some
 * browsers send '' or application/octet-stream for .m4a) falls back to the
 * file's extension. The codec parameters a browser recorder adds are kept.
 */
export function uploadType(declared: string, fileName: string, kind: 'media' | 'image'): string | null {
  const allowed = kind === 'media' ? MEDIA_TYPES : IMAGE_TYPES;
  const b = baseType(declared);
  if (allowed.has(b)) return declared.trim();
  if (b && b !== 'application/octet-stream') return null;
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  const byExt = EXT_TYPES[ext];
  return byExt && allowed.has(byExt) ? byExt : null;
}

/** The type to serve a stored file as: its own if on the list, otherwise an opaque download. */
export function serveType(stored: string | null | undefined, kind: 'media' | 'image'): { type: string; inline: boolean } {
  const b = baseType(stored);
  const allowed = kind === 'media' ? MEDIA_TYPES : IMAGE_TYPES;
  return allowed.has(b) ? { type: String(stored).trim(), inline: true } : { type: 'application/octet-stream', inline: false };
}

/** Headers every served upload carries, so a file can never act as a page. */
export function lockDownUpload(h: Headers): void {
  h.set('x-content-type-options', 'nosniff');
  h.set('content-security-policy', "default-src 'none'; sandbox");
}

/**
 * Where a form's hidden `back` field may send you: a path on this site,
 * and nothing else. `//evil.com`, `/\evil.com` and full URLs all start
 * like a path to a careless eye and leave the site in a browser.
 */
export function safeBack(raw: unknown, fallback: string): string {
  const v = String(raw ?? '').trim();
  if (!v) return fallback;
  if (!/^\/(?![\/\\])[A-Za-z0-9/_\-.~%?=&]*$/.test(v)) return fallback;
  return v;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'untitled';
}

/**
 * A wa.me link from a number typed any way at all — "+91 98470 12345",
 * "(044) 2847 1234", "0091-98470-12345". WhatsApp wants digits only, with the
 * country code and no leading zeros or plus, so everything else is stripped
 * and a 00 prefix is treated as the + it stands for.
 *
 * Returns null when there aren't enough digits to be a real number, so the
 * caller can show plain text instead of a link that goes nowhere.
 */
export function waLink(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  return digits.length >= 8 && digits.length <= 15 ? `https://wa.me/${digits}` : null;
}

/** A redirect target with a flash message on it, whether or not it already has a query. */
export function withMsg(path: string, msg: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}`;
}
