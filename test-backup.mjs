/* ===================================================================
 * The refresh token, and the thing that keeps it.
 *
 * This is the one genuinely new risk the Drive backup introduces: a
 * long-lived credential to somebody's Google Drive, living in this
 * application's database. Everything else in that feature fails
 * loudly and recoverably; this one fails silently and badly.
 *
 * So the properties are asserted rather than assumed: that it
 * round-trips, that the database alone is not enough to open it, and
 * that a tampered value is refused rather than half-decrypted.
 *
 * What is NOT tested here, and cannot be from a laptop: the round
 * trips to Google and to Cloudflare's export API. Those are exercised
 * by pressing "Test the connection" on the admin page, which is why
 * that button exists.
 * =================================================================== */

import { sealToken, openToken } from './src/backup.ts';

const check = (label, got, want) => {
  const ok = got === want;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok ? '' : `\n         got: ${got}\n        want: ${want}`}`);
  return ok;
};
let fails = 0;
const t = (l, g, w) => { if (!check(l, g, w)) fails++; };

const SECRET = 'a-session-secret-of-some-length';
const TOKEN = '1//0eXaMpLe-refresh-token-value_that-google-would-send.1234567890';

console.log('=== it comes back out ===');
const sealed = await sealToken(SECRET, TOKEN);
t('a token survives the round trip', await openToken(SECRET, sealed), TOKEN);
t('an empty token round-trips too', await openToken(SECRET, await sealToken(SECRET, '')), '');
t('so does a long one',
  await openToken(SECRET, await sealToken(SECRET, 'x'.repeat(4096))), 'x'.repeat(4096));

console.log('=== and is not readable without the secret ===');
t('the sealed value is not the token', sealed.includes(TOKEN.slice(0, 12)), false);
/* Every seal uses a fresh IV, so the same token twice is two different
   ciphertexts. Without this, a database leak would show which accounts
   share a token. */
t('sealing twice gives two different values', sealed === (await sealToken(SECRET, TOKEN)), false);

const wrong = async (fn) => {
  try { await fn(); return 'opened'; } catch { return 'refused'; }
};
t('another secret cannot open it', await wrong(() => openToken(SECRET + 'x', sealed)), 'refused');

console.log('=== and tampering is refused, not tolerated ===');
/* AES-GCM authenticates as well as encrypts. A single flipped byte
   must fail outright rather than return plausible-looking rubbish that
   gets sent to Google as a credential. */
const bytes = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
const flip = (i) => {
  const copy = new Uint8Array(bytes);
  copy[i] ^= 1;
  let s = '';
  for (const b of copy) s += String.fromCharCode(b);
  return btoa(s);
};
t('a flipped byte in the ciphertext is refused', await wrong(() => openToken(SECRET, flip(bytes.length - 3))), 'refused');
t('a flipped byte in the IV is refused', await wrong(() => openToken(SECRET, flip(2))), 'refused');
t('a truncated value is refused', await wrong(() => openToken(SECRET, sealed.slice(0, 20))), 'refused');
t('nonsense is refused', await wrong(() => openToken(SECRET, 'not base64 at all!!')), 'refused');

console.log(fails ? `\n${fails} FAILURES` : '\nall passed');
process.exit(fails ? 1 : 0);
