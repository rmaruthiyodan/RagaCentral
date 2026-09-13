/* ==================================================================
 * One app, two languages.
 *
 * Every label, heading, button and hint goes through t(). The English
 * IS the key — t('Log the next lesson') — so a view still reads like
 * English prose, a string with no Malayalam yet quietly falls back to
 * the English rather than showing a bare key, and ml.ts reads as a
 * bilingual glossary the teacher can correct without touching code.
 *
 * WHAT THIS DOES NOT TOUCH: anything a person typed. Song titles,
 * ragas, composers, lesson notes, a student's name. Those already
 * carry their own Malayalam where there is one (title_ml, body_ml)
 * and are shown as entered in both languages. The switch moves the
 * chrome around the content, never the content.
 *
 * ---- why a module-level `current` is safe here -------------------
 *
 * A Worker isolate handles many requests, so module state is normally
 * a way to leak one person's data into another's page. It is safe in
 * this one case, and only because of an invariant worth stating:
 *
 *   EVERY VIEW FUNCTION IS SYNCHRONOUS.
 *
 * A handler awaits its database work first, then calls page(...) which
 * returns a string with no await anywhere inside it. JavaScript is
 * single-threaded and only yields at an await, so nothing can run
 * between setLang() and the end of that render. Two requests cannot
 * interleave inside it.
 *
 * If a view ever needs to await something, this breaks silently and a
 * student in Kochi starts seeing English mid-page. Don't make a view
 * async — load the data in the route and pass it in, the way every
 * view here already works.
 * ================================================================== */

import { ML } from './ml.ts'; // see the note in tz.ts

export type Lang = 'en' | 'ml';

export const LANGS: { id: Lang; name: string; nativeName: string }[] = [
  { id: 'en', name: 'English', nativeName: 'English' },
  { id: 'ml', name: 'Malayalam', nativeName: 'മലയാളം' },
];

export function isLang(v: string | null | undefined): v is Lang {
  return v === 'en' || v === 'ml';
}

let current: Lang = 'en';

/** Set once per request, in the route, immediately before rendering. */
export function setLang(v: string | null | undefined): void {
  current = isLang(v) ? v : 'en';
}

export function lang(): Lang {
  return current;
}

/**
 * The English text, or its Malayalam when we're in Malayalam and there
 * is one. `%s` placeholders are filled from the arguments, left to
 * right, so a sentence can be reordered in translation:
 *
 *   t('%s of %s songs', done, total)
 *   'പാട്ടുകൾ %2$s-ൽ %1$s'   ← positional form, when the order changes
 */
export function t(en: string, ...args: (string | number)[]): string {
  let s = en;
  if (current === 'ml') {
    const m = ML[en];
    if (m) s = m;
  }
  if (!args.length) return s;
  let i = 0;
  return s
    .replace(/%(\d)\$s/g, (_, n: string) => String(args[Number(n) - 1] ?? ''))
    .replace(/%s/g, () => String(args[i++] ?? ''));
}

/** For an attribute or a place where only the English will do. */
export function en(s: string): string {
  return s;
}
