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
 * ------------------------------------------------------------------
 * WHY THIS FILE IS SHAPED SO ODDLY: 10 MILLISECONDS
 *
 * A Worker on the free plan gets **10 ms of CPU per request**. Waiting
 * on the network is free and there is no wall-clock limit, so a request
 * may sit for thirty seconds waiting for Whisper — but it may not
 * *compute* for more than ten milliseconds, and when it does the
 * runtime kills it. The browser sees a dead connection, which reads
 * exactly like "the transcriber timed out" and is nothing of the kind.
 *
 * Audio is megabytes. Every operation that walks those bytes in
 * JavaScript costs milliseconds:
 *
 *     encoding 30 s of WAV to base64 in the Worker   ~48 ms   ✗
 *     encoding 120 s of WAV to base64 in the Worker  ~137 ms  ✗
 *
 * That is the bug this file used to have. So the rule now is:
 *
 *   THE WORKER NEVER TOUCHES THE AUDIO BYTES.
 *
 * The browser records it, downmixes it, encodes it to a 16 kHz mono
 * MP3 (a twentieth of the size of the WAV it used to send) and base64s
 * it there, where CPU is free and plentiful. What arrives here is
 * already the string the model wants. All this file does is hand it
 * over — one string, one model call.
 *
 * Which is also why there is one Whisper pass and not two. Whisper can
 * transcribe or translate, not both, so English used to mean a second
 * pass over the same audio — and a second trip through the serialiser,
 * doubling the one cost that is unavoidable. The English rendering now
 * comes from translating the *transcript*: a few hundred bytes of text
 * instead of a megabyte of sound.
 *
 * Both answers are still only a draft. Nothing is stored without the
 * teacher seeing it first — this fills in a form, it does not save.
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
 * `b64` is base64 audio — already encoded, by the browser, for the
 * reason set out at the top of this file. `mime` says what it is inside
 * the encoding; the browser sends audio/mpeg, and older cached copies
 * of the page may still send audio/wav.
 *
 * `keyterms` are only used by Sarvam; Whisper takes a free-text
 * `initial_prompt` instead, which nudges its vocabulary the same way
 * but far more weakly.
 */
export async function transcribe(
  env: Env,
  b64: string,
  mime: string,
  keyterms: string[] = [],
): Promise<Transcript> {
  const provider = (env.DICTATE_PROVIDER || 'workers-ai').trim();
  if (provider === 'sarvam') return viaSarvam(env, b64, mime, keyterms);
  if (provider === 'workers-ai') return viaWorkersAi(env, b64, keyterms);
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

async function viaWorkersAi(env: Env, b64: string, keyterms: string[]): Promise<Transcript> {
  if (!env.AI) throw new DictateError('Workers AI is not bound — add [ai] binding = "AI" to wrangler.toml.');

  /* Whisper's own knob for vocabulary. It is a hint, not a constraint,
     and much less effective than Sarvam's keyterms — but it costs
     nothing and it does reduce the mangling of the obvious words. */
  const initial_prompt = keyterms.length
    ? `Carnatic music lesson. Terms: ${keyterms.slice(0, 40).join(', ')}.`
    : 'Carnatic music lesson.';

  /* The one pass. `b64` is handed straight to the binding and never
     read, copied or re-encoded here — see the note at the top. */
  const ml = (
    await runWhisper(env, { audio: b64, task: 'transcribe', language: 'ml', initial_prompt })
  ).trim();

  /* English from the words, not from the sound. If it fails the note is
     still perfectly usable — he can type the gist himself — so this
     never takes the dictation down with it. */
  const en = ml ? await translateToEnglish(env, ml) : '';

  return { ml, en, provider: 'workers-ai' };
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

/**
 * Malayalam text to English text.
 *
 * m2m100 is a translation model rather than a chat model, so there is
 * no prompt to get wrong and nothing for it to answer back with. The
 * payload is the transcript — a sentence or two — so this is the cheap
 * half of the request by three orders of magnitude.
 */
async function translateToEnglish(env: Env, ml: string): Promise<string> {
  try {
    const res = (await withDeadline(
      env.AI!.run('@cf/meta/m2m100-1.2b', {
        text: ml.slice(0, 2000),
        source_lang: 'malayalam',
        target_lang: 'english',
      }),
      'the translator',
    )) as { translated_text?: string } | null;
    const out = res?.translated_text;
    return typeof out === 'string' ? out.trim() : '';
  } catch {
    /* No English this time. The Malayalam is the note; this was the
       courtesy for the students abroad. */
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * Sarvam
 * ------------------------------------------------------------------ */

async function viaSarvam(
  env: Env,
  b64: string,
  mime: string,
  keyterms: string[],
): Promise<Transcript> {
  if (!env.SARVAM_API_KEY)
    throw new DictateError('SARVAM_API_KEY is not set — `npx wrangler secret put SARVAM_API_KEY`.');

  const name = `note.${extFor(mime)}`;
  const type = mime || 'audio/mpeg';
  const audio = fromBase64(b64);

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
  audio: Uint8Array,
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
 * Base64 back to bytes, for Sarvam — which wants a file upload, not a
 * string, and so is the one path that cannot avoid walking the audio.
 *
 * `atob` is native and the Uint8Array.from callback is the cheapest way
 * to get from its byte-string to bytes, but it is still a pass over
 * every byte in JavaScript: a megabyte of MP3 is a few milliseconds.
 * That fits inside the free plan's 10 ms only because the browser now
 * sends MP3 rather than WAV. If Sarvam is ever the default here, check
 * this number again — or be on the paid plan, where it is irrelevant.
 */
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}
