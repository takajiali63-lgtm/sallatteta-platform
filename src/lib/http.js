import { gzipSync } from 'node:zlib';
import { applyBrand } from './i18n.js';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

export class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const acceptsGzip = (res) => /\bgzip\b/.test(String(res.req?.headers?.['accept-encoding'] || ''));

export function sendJson(res, status, data, headers = {}) {
  let body = Buffer.from(JSON.stringify(data));
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...headers };
  if (body.length > 1024 && acceptsGzip(res)) { body = gzipSync(body, { level: 5 }); h['Content-Encoding'] = 'gzip'; }
  h['Content-Length'] = body.length;
  res.writeHead(status, h);
  res.end(body);
}



export async function readJson(req, limitBytes = 64 * 1024) {
  const type = String(req.headers['content-type'] || '');
  if (!type.includes('application/json')) throw new HttpError(415, 'unsupported_media_type');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, 'payload_too_large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

/** Serve a file from rootDir; refuses path traversal. Returns false if not found. */
// Static files are kept in memory (with their ETag and gzip copy) and only re-read when the file changes.
const fileCache = new Map();

export async function serveFile(res, rootDir, relPath, { cache = 'no-cache', extraHeaders = {}, brand } = {}) {
  let clean;
  try { clean = normalize(decodeURIComponent(relPath)).replace(/^([/\\])+/, ''); } catch { return false; }
  const full = join(rootDir, clean);
  if (!full.startsWith(rootDir + sep) && full !== rootDir) return false; // no path traversal
  let st;
  try { st = await stat(full); } catch { return false; }
  if (!st.isFile()) return false;
  const brandKey = brand ? `${brand.name}|${brand.nameEn}` : '';
  let entry = fileCache.get(full);
  if (!entry || entry.mtime !== st.mtimeMs || entry.size !== st.size || entry.brandKey !== brandKey) {
    let body = await readFile(full);
    if (brand && /\.(html|json|webmanifest)$/.test(full)) body = Buffer.from(applyBrand(body.toString('utf8'), brand));
    const type = TYPES[extname(full).toLowerCase()] || 'application/octet-stream';
    const etag = '"' + createHash('sha1').update(body).digest('base64url').slice(0, 20) + '"';
    const gz = body.length > 1024 && /text|javascript|json|svg|manifest/.test(type) ? gzipSync(body, { level: 9 }) : null;
    entry = { mtime: st.mtimeMs, size: st.size, brandKey, body, type, etag, gz };
    fileCache.set(full, entry);
  }
  const headers = { 'Cache-Control': cache, ETag: entry.etag, Vary: 'Accept-Encoding', ...extraHeaders };
  if (res.req?.headers?.['if-none-match'] === entry.etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  const useGz = entry.gz && acceptsGzip(res);
  const out = useGz ? entry.gz : entry.body;
  if (useGz) headers['Content-Encoding'] = 'gzip';
  res.writeHead(200, { 'Content-Type': entry.type, 'Content-Length': out.length, ...headers });
  res.end(res.req?.method === 'HEAD' ? undefined : out);
  return true;
}

/** Text body with ETag revalidation and gzip (for generated content such as locale files). */
export function sendText(req, res, text, type) {
  const body = Buffer.from(text);
  const etag = '"' + createHash('sha1').update(body).digest('base64url').slice(0, 20) + '"';
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); res.end(); return; }
  let out = body;
  const h = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag, Vary: 'Accept-Encoding' };
  if (body.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) { out = gzipSync(body, { level: 6 }); h['Content-Encoding'] = 'gzip'; }
  h['Content-Length'] = out.length;
  res.writeHead(200, h);
  res.end(out);
}
