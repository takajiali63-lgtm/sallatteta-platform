import { HttpError } from './http.js';

// Removes control chars (keeps new lines), trims, collapses 3+ blank lines.
export function cleanText(v) {
  return String(v ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class Validator {
  constructor() { this.errors = {}; }
  fail(field, code) { if (!this.errors[field]) this.errors[field] = code; return undefined; }
  text(field, v, { min = 0, max = 200, required = true, multiline = false } = {}) {
    let s = cleanText(v);
    if (!multiline) s = s.replace(/\s+/g, ' ');
    if (!s) return required ? this.fail(field, 'required') : null;
    if (s.length < min) return this.fail(field, 'too_short');
    if (s.length > max) return this.fail(field, 'too_long');
    return s;
  }
  number(field, v, { min, max, required = true } = {}) {
    if (v === undefined || v === null || v === '') return required ? this.fail(field, 'required') : null;
    const n = Number(v);
    if (!Number.isFinite(n)) return this.fail(field, 'invalid');
    if ((min !== undefined && n < min) || (max !== undefined && n > max)) return this.fail(field, 'out_of_range');
    return n;
  }
  int(field, v, opts) {
    const n = this.number(field, v, opts);
    if (n === undefined || n === null) return n;
    return Number.isInteger(n) ? n : this.fail(field, 'invalid');
  }
  oneOf(field, v, allowed, { required = true } = {}) {
    if (v === undefined || v === null || v === '') return required ? this.fail(field, 'required') : null;
    return allowed.includes(v) ? v : this.fail(field, 'invalid');
  }
  date(field, v, { required = true } = {}) {
    if (!v) return required ? this.fail(field, 'required') : null;
    const s = String(v);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00.000Z') : new Date(s);
    return Number.isNaN(d.getTime()) ? this.fail(field, 'invalid') : d;
  }
  assert() {
    if (Object.keys(this.errors).length) throw new HttpError(422, 'validation_failed', { fields: this.errors });
  }
}

// Small JPEG/PNG/WebP data-URL photo (resized client-side). ~150 KB max.
/**
 * True only if the bytes really are the declared image type (magic numbers), not just the label.
 * Blocks HTML/SVG/scripts renamed as images.
 */
export function imageBytesOk(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return false;
  const head = Buffer.from(m[2].slice(0, 24), 'base64');
  if (m[1] === 'jpeg') return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (m[1] === 'png') return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP';
}

export function validatePhoto(v, validator, field = 'photo', { maxBytes = 200_000 } = {}) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const s = String(v);
  if (!imageBytesOk(s)) return validator.fail(field, 'invalid');
  if (s.length > maxBytes) return validator.fail(field, 'too_large');
  return s;
}
