/* ==================================================================
 * The smallest useful R2 client.
 *
 * R2 speaks S3, and S3 means SigV4-signed HTTPS. `aws4fetch` does the
 * signing — 88 KB, no dependencies of its own, written for exactly this
 * — and everything else here is plain fetch. That is deliberate: the
 * alternative was the full AWS SDK (tens of megabytes, for four verbs)
 * or rclone (a binary to install on a Mac with no Homebrew).
 *
 * Credentials come from an R2 API token, which is NOT the same thing as
 * the Cloudflare API token wrangler uses. Cloudflare dashboard → R2 →
 * API → Create token. **Object Read only** is enough for backing up;
 * restoring needs Object Read & Write. Setup is in BACKUP.md.
 * ================================================================== */

import { AwsClient } from 'aws4fetch';
import { createWriteStream } from 'node:fs';
import { rename, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export class R2 {
  /**
   * @param {{accountId: string, accessKeyId: string, secretAccessKey: string,
   *          bucket: string, endpoint?: string}} o
   */
  constructor(o) {
    for (const k of ['accountId', 'accessKeyId', 'secretAccessKey', 'bucket'])
      if (!o[k]) throw new Error(`R2: ${k} is missing`);
    this.bucket = o.bucket;
    this.base = (o.endpoint || `https://${o.accountId}.r2.cloudflarestorage.com`).replace(/\/$/, '');
    this.client = new AwsClient({
      accessKeyId: o.accessKeyId,
      secretAccessKey: o.secretAccessKey,
      service: 's3',
      region: 'auto', // required by the signature, ignored by R2
    });
  }

  url(key = '') {
    // Keys carry '/' as a real path separator; everything else is escaped.
    const path = key.split('/').map(encodeURIComponent).join('/');
    return `${this.base}/${encodeURIComponent(this.bucket)}/${path}`;
  }

  /** One request, with retries for the failures that are worth retrying. */
  async #send(url, init = {}, tries = 3) {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await this.client.fetch(url, init);
        // 5xx and 429 are worth another go; 4xx means we asked wrongly.
        if (res.status >= 500 || res.status === 429) {
          last = new Error(`${res.status} ${res.statusText}`);
          await res.arrayBuffer().catch(() => {});
        } else {
          return res;
        }
      } catch (e) {
        last = e;
      }
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
    throw last;
  }

  /** Size and ETag, or null when the object isn't there. */
  async head(key) {
    const res = await this.#send(this.url(key), { method: 'HEAD' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HEAD ${key}: ${res.status} ${res.statusText}`);
    return {
      size: Number(res.headers.get('content-length') ?? 0),
      etag: (res.headers.get('etag') ?? '').replace(/"/g, ''),
    };
  }

  /**
   * Stream an object to a file. Written to `<dest>.part` and renamed on
   * success, so an interrupted run never leaves a half file that a later
   * run would mistake for a complete one.
   */
  async download(key, dest) {
    const res = await this.#send(this.url(key));
    if (res.status === 404) return null;
    if (!res.ok || !res.body) throw new Error(`GET ${key}: ${res.status} ${res.statusText}`);

    await mkdir(dirname(dest), { recursive: true });
    const part = `${dest}.part`;
    try {
      await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
    } catch (e) {
      await unlink(part).catch(() => {});
      throw e;
    }
    await rename(part, dest);
    return {
      size: Number(res.headers.get('content-length') ?? 0),
      etag: (res.headers.get('etag') ?? '').replace(/"/g, ''),
    };
  }

  /**
   * Put a file back. Needs a token with Object Read & Write.
   *
   * `body` is a Buffer, not a stream, on purpose: SigV4 signs a hash of
   * the payload, and hashing a stream means either buffering it anyway
   * or sending UNSIGNED-PAYLOAD. The app caps an upload at 90 MB, so
   * the memory is bounded and known, and a restore is not the moment to
   * find out whether a signing shortcut is accepted.
   */
  async upload(key, body, contentType) {
    const res = await this.#send(this.url(key), {
      method: 'PUT',
      body,
      headers: contentType ? { 'content-type': contentType } : {},
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`PUT ${key}: ${res.status} ${res.statusText} ${detail.slice(0, 120)}`.trim());
    }
    return true;
  }

  /**
   * Every key in the bucket. Only the audit needs this — the backup is
   * driven by what the database references, not by what happens to be
   * in the bucket, so a stray file can never be mistaken for data.
   */
  async *list(prefix = '') {
    let token;
    do {
      const u = new URL(`${this.base}/${encodeURIComponent(this.bucket)}`);
      u.searchParams.set('list-type', '2');
      u.searchParams.set('max-keys', '1000');
      if (prefix) u.searchParams.set('prefix', prefix);
      if (token) u.searchParams.set('continuation-token', token);
      const res = await this.#send(u.toString());
      if (!res.ok) throw new Error(`LIST: ${res.status} ${res.statusText}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = m[1].match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
        const size = Number(m[1].match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0);
        if (key) yield { key: unescapeXml(key), size };
      }
      token = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1];
      if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) token = undefined;
    } while (token);
  }

  /** Can we reach the bucket at all, with these credentials? */
  async check() {
    const u = new URL(`${this.base}/${encodeURIComponent(this.bucket)}`);
    u.searchParams.set('list-type', '2');
    u.searchParams.set('max-keys', '1');
    const res = await this.client.fetch(u.toString());
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => '');
    return {
      ok: false,
      status: res.status,
      hint: hintFor(res.status, body),
    };
  }
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/* The four ways this goes wrong in practice, each with the thing to
   check — because "403 Forbidden" on its own sends people to the wrong
   place, usually to regenerating a token that was fine. */
function hintFor(status, body) {
  if (status === 401 || status === 403)
    return 'The access key or secret is wrong, or the token does not cover this bucket.\n   R2 API tokens are separate from the Cloudflare API token wrangler uses.';
  if (status === 404)
    return `No such bucket. Check R2_BUCKET, and that R2_ACCOUNT_ID is the account that owns it.`;
  if (status === 400 && /InvalidArgument|SignatureDoesNotMatch/i.test(body))
    return 'The signature was rejected. Check the secret for stray whitespace or a truncated paste.';
  return body.slice(0, 200) || 'No detail returned.';
}
