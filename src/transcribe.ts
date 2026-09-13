/* ==================================================================
 * Speaking a lesson note.
 *
 * The teacher writes his notes on an iPhone, and Apple's dictation has
 * no Malayalam — only English (India) and Hindi among Indian languages.
 * Safari's in-browser speech recognition borrows that same list. So the
 * only route that works is the one that doesn't ask the phone to know
 * Malayalam at all: record the audio, send it up, transcribe it here.
 *
 * Two providers, one interface, chosen by DICTATE_PROVIDER:
 *
 *   workers-ai  (default)  Whisper on Cloudflare. Free — 10,000 neurons
 *                          a day and Whisper costs 46.63 per audio
 *                          minute, so ~200 minutes daily at no charge —
 *                          and needs no account beyond the one already
 *                          running the app. Whisper is a general
 *                          multilingual model, though, and much weaker
 *                          on Indic languages than European ones.
 *
 *   sarvam                 Built for Indian languages, and the reason
 *                          to pay for it is `keyterms`: the Carnatic
 *                          vocabulary and this teacher's own song
 *                          titles, handed to the model so "gamaka" and
 *                          "Vatapi Ganapatim" come back as themselves.
 *                          ~₹0.50 a minute.
 *
 * Both are asked for the same two things: the Malayalam as spoken, and
 * an English rendering, because students abroad may not read the script.
 * Neither result is ever stored without the teacher seeing it first —
 * this fills in a form, it does not save anything.
 * ================================================================== */

import type { Env } from './types';

export interface Transcript {
  ml: string;
  en: string;
  provider: string;
}

/** Carnatic words a general model has no reason to know. */
export const CARNATIC_TERMS = [
  'pallavi', 'anupallavi', 'charanam', 'krithi', 'kriti', 'varnam', 'geetham',
  'sarali varisai', 'janta varisai', 'alankaram', 'swaram', 'sangati', 'gamaka',
  'arohanam', 'avarohanam', 'raga', 'ragam', 'taala', 'talam', 'adi talam',
  'sruti', 'shruti', 'tanpura', 'shishya', 'akaram',
];

/**
 * One clip in, Malayalam and English out.
 *
 * `keyterms` are only used by Sarvam; Whisper takes a free-text
 * `initial_prompt` instead, which nudges its vocabulary the same way
 * but far more weakly.
 */
export async function transcribe(
  env: Env,
  audio: ArrayBuffer,
  mime: string,
  keyterms: string[] = [],
): Promise<Transcript> {
  const provider = (env.DICTATE_PROVIDER || 'workers-ai').trim();
  if (provider === 'sarvam') return viaSarvam(env, audio, mime, keyterms);
  if (provider === 'workers-ai') return viaWorkersAi(env, audio, keyterms);
  throw new DictateError(`Unknown DICTATE_PROVIDER "${provider}" — use workers-ai or sarvam.`);
}

/** Thrown for anything the teacher could act on; the message reaches the UI. */
export class DictateError extends Error {}

/* A provider that never answers is worse than one that says no: the
   teacher sits watching "Reading it back…" with no way to tell whether
   to wait or retype. Give up at 45 seconds and say so. */
const DEADLINE_MS = 45_000;

function withDeadline<T>(work: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new DictateError(`${what} did not answer in time. Try again, or type it.`)),
        DEADLINE_MS,
      ),
    ),
  ]);
}

/* ------------------------------------------------------------------ *
 * Cloudflare Workers AI
 * ------------------------------------------------------------------ */

async function viaWorkersAi(env: Env, audio: ArrayBuffer, keyterms: string[]): Promise<Transcript> {
  if (!env.AI) throw new DictateError('Workers AI is not bound — add [ai] binding = "AI" to wrangler.toml.');

  const b64 = toBase64(audio);
  /* Whisper's own knob for vocabulary. It is a hint, not a constraint,
     and much less effective than Sarvam's keyterms — but it costs
     nothing and it does reduce the mangling of the obvious words. */
  const initial_prompt = keyterms.length
    ? `Carnatic music lesson. Terms: ${keyterms.slice(0, 40).join(', ')}.`
    : 'Carnatic music lesson.';

  /* Two passes over the same clip: Whisper can transcribe OR translate,
     not both at once. Two audio-minutes of the daily allowance per
     spoken minute, which at ~100 free minutes a day is still far more
     than a week of lesson notes. */
  const [ml, en] = await Promise.all([
    runWhisper(env, { audio: b64, task: 'transcribe', language: 'ml', initial_prompt }),
    runWhisper(env, { audio: b64, task: 'translate', initial_prompt }),
  ]);

  return { ml: ml.trim(), en: en.trim(), provider: 'workers-ai' };
}

async function runWhisper(env: Env, input: Record<string, unknown>): Promise<string> {
  let res: unknown;
  try {
    res = await withDeadline(
      env.AI!.run('@cf/openai/whisper-large-v3-turbo', input),
      'Workers AI',
    );
  } catch (e) {
    throw new DictateError(`Workers AI refused the clip: ${(e as Error).message}`);
  }
  const text = (res as { text?: string } | null)?.text;
  if (typeof text !== 'string') throw new DictateError('Workers AI returned no text.');
  return text;
}

/* ------------------------------------------------------------------ *
 * Sarvam
 * ------------------------------------------------------------------ */

async function viaSarvam(
  env: Env,
  audio: ArrayBuffer,
  mime: string,
  keyterms: string[],
): Promise<Transcript> {
  if (!env.SARVAM_API_KEY)
    throw new DictateError('SARVAM_API_KEY is not set — `npx wrangler secret put SARVAM_API_KEY`.');

  const name = `note.${extFor(mime)}`;
  const type = mime || 'audio/webm';

  /* `codemix` is the mode that matters here: he speaks Malayalam with
     the Carnatic terms and the odd English word left in, and that is
     what the note should say. A pure-Malayalam mode would transliterate
     "gamaka" into the script and read oddly.

     One after the other, each with its own Blob: two requests reading a
     single Blob at the same time is a stream two things are pulling on,
     and the second second of latency is cheaper than finding out which
     runtime minds. */
  const ml = await callSarvam(env, audio, type, name, { mode: 'codemix', language_code: 'ml-IN' }, keyterms);
  const en = await callSarvam(env, audio, type, name, { mode: 'translate', language_code: 'ml-IN' }, keyterms);

  return { ml: ml.trim(), en: en.trim(), provider: 'sarvam' };
}

async function callSarvam(
  env: Env,
  audio: ArrayBuffer,
  type: string,
  name: string,
  opts: Record<string, string>,
  keyterms: string[],
): Promise<string> {
  const model = env.SARVAM_MODEL || 'saaras:v3';
  const body = new FormData();
  body.append('file', new Blob([audio], { type }), name);
  body.append('model', model);
  for (const [k, v] of Object.entries(opts)) body.append(k, v);
  // keyterms are a v4 feature; sending them to v3 is ignored, not an error.
  if (keyterms.length && model.startsWith('saaras:v4'))
    for (const t of keyterms.slice(0, 50)) body.append('keyterms', t);

  /* The base is overridable so the whole path can be rehearsed against a
     stand-in without spending credits — and because Sarvam publishes
     region endpoints. It defaults to the real one. */
  const base = (env.SARVAM_BASE || 'https://api.sarvam.ai').replace(/\/$/, '');
  let res: Response;
  try {
    res = await withDeadline(
      fetch(`${base}/speech-to-text`, {
        method: 'POST',
        headers: { 'api-subscription-key': env.SARVAM_API_KEY! },
        body,
      }),
      'Sarvam',
    );
  } catch (e) {
    if (e instanceof DictateError) throw e;
    const msg = (e as Error).message || String(e);
    /* A container built on a slim base has no CA bundle, and the runtime
       cannot verify anyone's certificate. It reads as a mysterious
       internal error unless you say what it is. */
    if (/certificate|TLS|self.signed|local issuer/i.test(msg))
      throw new DictateError(
        'Could not verify Sarvam\'s certificate. The container is missing its CA ' +
          'certificates — rebuild with `docker compose build --no-cache` on the current ' +
          'Dockerfile, which installs them.',
      );
    throw new DictateError(`Could not reach Sarvam: ${msg}`);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    if (res.status === 401 || res.status === 403)
      throw new DictateError('Sarvam rejected the key. Check SARVAM_API_KEY.');
    if (res.status === 429)
      throw new DictateError('Sarvam is rate-limiting, or the credits have run out.');
    throw new DictateError(`Sarvam returned ${res.status}. ${detail}`);
  }

  const json = (await res.json()) as { transcript?: string };
  if (typeof json.transcript !== 'string') throw new DictateError('Sarvam returned no transcript.');
  return json.transcript;
}

/* ------------------------------------------------------------------ */

function extFor(mime: string): string {
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

/**
 * Base64 without pulling in Buffer. Chunked, because spreading a whole
 * megabyte into String.fromCharCode blows the argument limit and throws
 * a RangeError that reads like anything but "the clip was too long".
 */
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(s);
}
