// Image storage.
// - Default ("db"): images live inside Postgres as data URLs (fine for a few hundred cooks).
// - "s3": any S3-compatible object storage (Cloudflare R2 recommended, AWS S3, Backblaze, MinIO...).
//   Images are uploaded there and served straight from its public URL / CDN, so they never load the server.
// Turned on by setting S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_PUBLIC_URL.
import { createHash, createHmac, randomBytes } from 'node:crypto';

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const encodeKey = (key) => key.split('/').map((s) => encodeURIComponent(s)).join('/');

/**
 * AWS Signature Version 4 for a single request (path-style URL).
 * Returns the headers to send (Authorization, x-amz-date, x-amz-content-sha256, + given headers).
 */
export function signV4({ method, url, headers = {}, body = '', accessKeyId, secretAccessKey, region = 'auto', service = 's3', now = new Date(), payloadHash }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const hash = payloadHash || sha256hex(body);
  const all = { ...headers, host: u.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': hash };
  const names = Object.keys(all).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalHeaders = names.map((k) => `${k}:${lower[k]}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const canonical = [method, u.pathname, query, canonicalHeaders, signedHeaders, hash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return {
    ...Object.fromEntries(names.filter((n) => n !== 'host').map((n) => [n, lower[n]])),
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export function createStorage(cfg, { fetchImpl = fetch } = {}) {
  const s3 = cfg.s3 || {};
  const enabled = !!(s3.endpoint && s3.bucket && s3.accessKeyId && s3.secretAccessKey && s3.publicUrl);
  if (!enabled) return { kind: 'db', enabled: false };

  const base = s3.endpoint.replace(/\/+$/, '');
  const publicBase = s3.publicUrl.replace(/\/+$/, '');
  const objectUrl = (key) => `${base}/${encodeURIComponent(s3.bucket)}/${encodeKey(key)}`;

  async function send(method, key, { body = '', contentType } = {}) {
    const url = objectUrl(key);
    const extra = method === 'PUT'
      ? { 'content-type': contentType, 'cache-control': 'public, max-age=31536000, immutable' }
      : {};
    const headers = signV4({ method, url, headers: extra, body, accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey, region: s3.region || 'auto' });
    const res = await fetchImpl(url, { method, headers, body: method === 'PUT' ? body : undefined });
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
      throw new Error(`storage ${method} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }
  }

  return {
    kind: 's3',
    enabled: true,
    /** Upload a data URL; returns its permanent public URL. Keys are random so URLs can be cached forever. */
    async putDataUrl(prefix, dataUrl) {
      const m = /^data:(image\/(jpeg|png|webp));base64,(.+)$/.exec(dataUrl || '');
      if (!m) throw new Error('bad image');
      const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
      const key = `${prefix}/${Date.now().toString(36)}-${randomBytes(6).toString('hex')}.${ext}`;
      await send('PUT', key, { body: Buffer.from(m[3], 'base64'), contentType: m[1] });
      return `${publicBase}/${encodeKey(key)}`;
    },
    /** Delete by public URL (ignored for URLs that are not ours). */
    async deleteUrl(url) {
      if (!url || !url.startsWith(publicBase + '/')) return;
      await send('DELETE', decodeURIComponent(url.slice(publicBase.length + 1)));
    },
  };
}
