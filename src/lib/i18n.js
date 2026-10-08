// Server-side access to the same locale files the frontend uses (/locales/*.json).
// Any locales/<lang>.json file is a supported language; missing keys fall back to Arabic, then to the key.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../locales');
export const DEFAULT_BRAND = { name: 'Aklatak', nameEn: 'Aklatak' };
let brand = DEFAULT_BRAND;
const cache = {};

/** Replace the default brand name everywhere in a text (used for locale strings, pages and manifests). */
export function applyBrand(text, b = brand) {
  // Texts saved while the brand was briefly "LTEZE" (e.g. WhatsApp messages edited in the admin panel): show the current brand.
  const out = String(text).split('LTEZE').join(b.name);
  if (b.name === DEFAULT_BRAND.name && b.nameEn === DEFAULT_BRAND.nameEn) return out;
  return out.split(DEFAULT_BRAND.name).join(b.name).split(DEFAULT_BRAND.nameEn).join(b.nameEn);
}
export function setBrand(b) { brand = { ...DEFAULT_BRAND, ...b }; for (const k of Object.keys(cache)) delete cache[k]; }

// Texts edited by the admin from the dashboard: { lang: { 'home.title': 'new text', … } } — applied on top of the files.
let overrides = {};
export function setTextOverrides(o) { overrides = o || {}; for (const k of Object.keys(cache)) delete cache[k]; }

const setPath = (obj, key, val) => {
  const parts = key.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) { if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {}; cur = cur[p]; }
  cur[parts.at(-1)] = val;
};

/** Original texts of a language file (no brand, no admin edits) — used by the admin text editor. */
export function baseLocale(lang) {
  try { return JSON.parse(readFileSync(resolve(dir, `${lang}.json`), 'utf8')); } catch { return {}; }
}

function load(lang) {
  if (!cache[lang]) {
    let data;
    try { data = JSON.parse(applyBrand(readFileSync(resolve(dir, `${lang}.json`), 'utf8'))); } catch { data = {}; }
    for (const [k, v] of Object.entries(overrides[lang] || {})) if (typeof v === 'string') setPath(data, k, applyBrand(v));
    cache[lang] = data;
  }
  return cache[lang];
}
const get = (obj, key) => key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);

/** A language as served to browsers: file + brand + admin edits. */
export function localeJson(lang) { return JSON.stringify(load(lang)); }

export function t(lang, key, vars) {
  const s = get(load(lang), key) ?? get(load('en'), key) ?? get(load('ar'), key) ?? key;
  return vars ? String(s).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '')) : s;
}

export function availableLocales() {
  try { return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort(); } catch { return ['ar']; }
}

/** Language chosen by the client (X-Locale header, set by the frontend); otherwise the default. Unchanged behaviour. */
export function pickLocale(req, supported, fallback = 'ar') {
  const h = String(req.headers['x-locale'] || '').toLowerCase();
  return supported.includes(h) ? h : fallback;
}
