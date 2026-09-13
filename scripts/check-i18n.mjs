#!/usr/bin/env node
/* ==================================================================
 * Is the Malayalam glossary safe to ship?
 *
 * Run it after editing src/i18n/ml.ts:   node scripts/check-i18n.mjs
 *
 * It catches the four mistakes that actually break a page, none of
 * which TypeScript can see, because to TypeScript every line here is
 * just a string:
 *
 *   SLOTS  a %s was dropped or added, so a number or a name would
 *          vanish from the sentence, or an empty gap would appear.
 *   HTML   a stray < > or & — these go into the page as written, and
 *          a bare & can swallow the words after it. The named ones
 *          (&mdash; &nbsp;) are punctuation and allowed.
 *   QUOTE  an apostrophe inside a Malayalam line. Some of these sit
 *          in onsubmit="confirm('…')" and an apostrophe ends the
 *          string early, which breaks the button.
 *   POS    a %2$s pointing at a blank the English does not have.
 *
 * It also reports any key in the views with no Malayalam yet — those
 * are not errors, they just stay in English.
 * ================================================================== */

import { readFileSync, readdirSync } from 'node:fs';
const src = readFileSync('src/i18n/ml.ts','utf8');
const body = src.slice(src.indexOf('{', src.indexOf('export const ML')));
const ML = eval('(' + body.replace(/;\s*$/,'') + ')');
let bad = 0;
const count = (s) => (s.match(/%(?:\d\$)?s/g) || []).length;
const positional = (s) => new Set((s.match(/%(\d)\$s/g)||[]).map(x=>x[1]));
for (const [en, ml] of Object.entries(ML)) {
  const ce = count(en), cm = count(ml);
  if (ce !== cm) { console.log(`SLOTS ${ce}->${cm}  ${JSON.stringify(en)}`); bad++; }
  // an html-unsafe character we would write raw into the page
  const stray = ml.replace(/&(mdash|nbsp|times|amp|quot|lt|gt|#\d+);/g,'');
  if (/[<>]/.test(stray) || /&/.test(stray)) { console.log(`HTML  ${JSON.stringify(ml)}`); bad++; }
  if (ml.includes("'")) { console.log(`QUOTE ${JSON.stringify(ml)}`); bad++; }
  if (!ml.trim()) { console.log(`EMPTY ${JSON.stringify(en)}`); bad++; }
  const pe = positional(en), pm = positional(ml);
  if (pm.size && ![...pm].every(n=>Number(n)<=ce)) { console.log(`POS   ${JSON.stringify(en)}`); bad++; }
}
/* Everything the views ask for, so we can say what is still English. */
const wanted = new Set();
for (const f of readdirSync('src/views').filter((f) => f.endsWith('.ts'))) {
  const code = readFileSync('src/views/' + f, 'utf8');
  const re = /\bt\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m;
  while ((m = re.exec(code)))
    wanted.add(m[2].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
}
const untranslated = [...wanted].filter((k) => !(k in ML)).sort();
if (untranslated.length) {
  console.log(`\n${untranslated.length} phrases have no Malayalam yet (they stay in English):`);
  for (const k of untranslated) console.log('  ' + JSON.stringify(k));
}

console.log(bad ? `\n${bad} problems` : '\nglossary clean');
process.exit(bad ? 1 : 0);
