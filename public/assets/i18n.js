// Shared i18n: all UI text lives in /locales/<lang>.json. Any file there is a language (ar, en, fr, es, ...).
// The language follows the visitor's COUNTRY (GPS / time zone), unless a ?lang= link was used.
// Missing keys fall back to English, then Arabic. Direction (RTL/LTR) follows the language.
const RTL = ['ar', 'fa', 'he', 'ur'];
let region = { code: 'LB', locale: 'ar-LB', units: 'km' };
let dict = {};
let fallback = { ar: {}, en: {} };
export let lang = 'ar';

const get = (obj, key) => key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);

/** Language the user chose explicitly (?lang=xx link); otherwise the language follows the country. */
function explicitLang() {
  const q = new URLSearchParams(location.search).get('lang');
  const valid = (x) => /^[a-z]{2}$/.test(x || '');
  try {
    if (q === 'auto') { localStorage.removeItem('st_lang'); return null; }
    if (valid(q)) { localStorage.setItem('st_lang', q); return q; }
    const saved = localStorage.getItem('st_lang');
    return valid(saved) ? saved : null;
  } catch { return valid(q) ? q : null; }
}

/** The visitor's country: last GPS result → CDN hint → device time zone → device locale region → platform default. */
/** Preview mode for the owner: /?as=GH&at=5.6037,-0.187 — see the site as a visitor in that country and place (this tab only). */
export function preview() {
  try {
    const u = new URLSearchParams(location.search);
    const as = (u.get('as') || '').toUpperCase(), at = (u.get('at') || '').split(',').map(Number);
    if (/^[A-Z]{2}$/.test(as)) sessionStorage.setItem('st_preview', JSON.stringify({ as, at: at.length === 2 && at.every(Number.isFinite) ? { lat: at[0], lng: at[1] } : null }));
    if (u.get('as') === 'off') sessionStorage.removeItem('st_preview');
    return JSON.parse(sessionStorage.getItem('st_preview') || 'null');
  } catch { return null; }
}

function guessCountry(cfg) {
  const pv = preview(); if (pv?.as) return pv.as;
  let saved = null;
  try { saved = localStorage.getItem('st_country'); } catch { /* ignore */ }
  const known = (c) => (c && cfg.countries?.includes(c) ? c : null);
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* ignore */ }
  const navRegion = (navigator.language || '').split('-')[1]?.toUpperCase();
  return known(saved) || known(cfg.countryHint) || known(cfg.countryTimezones?.[tz]) || known(navRegion) || cfg.country?.code || 'LB';
}

/** For the home page shops: the visitor's region even if it's NOT on the platform yet (then no shops, never Lebanon's). */
export function visitorRegion(cfg) {
  const pv = preview(); if (pv?.as) return pv.as;
  let saved = null;
  try { saved = localStorage.getItem('st_country'); } catch { /* ignore */ }
  if (saved) return saved;
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* ignore */ }
  const fromTz = cfg.countryTimezones?.[tz];
  const navRegion = (navigator.language || '').split('-')[1]?.toUpperCase();
  return cfg.countryHint || fromTz || (/^[A-Z]{2}$/.test(navRegion || '') ? navRegion : null) || cfg.country?.code || 'LB';
}

/** Remember the country found from GPS (used for language, currency and phone format from now on). */
export function rememberCountry(code) {
  if (!/^[A-Z]{2}$/.test(code || '')) return false;
  if (preview()?.as) return false;   // preview never changes the owner's own country
  let prev = null;
  try { prev = localStorage.getItem('st_country'); localStorage.setItem('st_country', code); } catch { /* ignore */ }
  return prev !== code;
}

let configPromise = null;
/** Site configuration for the visitor's country (shared by every script on the page). */
export const getConfig = () => configPromise;

async function loadConfig() {
  let cfg = await (await fetch('/api/config', { headers: { 'X-Requested-With': 'fetch' } })).json();
  const c = guessCountry(cfg);
  if (c !== cfg.country?.code) cfg = await (await fetch(`/api/config?country=${c}`, { headers: { 'X-Requested-With': 'fetch' } })).json();
  return cfg;
}

export async function initI18n() {
  configPromise = configPromise || loadConfig();
  let cfg = null;
  try { cfg = await configPromise; } catch { /* offline: Arabic defaults */ }
  if (cfg) setRegion(cfg.country);
  const available = cfg?.locales || ['ar'];
  const countryLang = cfg?.country?.lang;
  // First visit, country not known yet (no GPS so far): use the phone's language instead of guessing Lebanon/Arabic.
  let knownCountry = null; try { knownCountry = localStorage.getItem('st_country'); } catch { /* private mode */ }
  const phoneLang = knownCountry ? null : (navigator.languages || [navigator.language]).map((x) => String(x || '').slice(0, 2).toLowerCase()).find((l) => available.includes(l));
  // Phone language not available and the visitor's time zone is not one of our countries (e.g. Angola, Portuguese) → English
  let tzKnown = false;
  try { tzKnown = !!cfg?.countryTimezones?.[Intl.DateTimeFormat().resolvedOptions().timeZone || '']; } catch { /* ignore */ }
  const unknownPlace = !knownCountry && !phoneLang && !tzKnown;
  const wanted = explicitLang() || phoneLang || (unknownPlace && available.includes('en') ? 'en'
    : (countryLang && available.includes(countryLang) ? countryLang : (cfg ? 'en' : 'ar')));
  lang = available.includes(wanted) ? wanted : (available.includes('en') ? 'en' : 'ar');
  // Missing keys: the chosen language → English → Arabic.
  const load = async (l) => { const r = await fetch(`/locales/${l}.json`).catch(() => null); return r && r.ok ? r.json().catch(() => ({})) : {}; };
  const ar = await load('ar');
  const en = lang === 'ar' ? {} : await load('en');
  dict = lang === 'ar' ? ar : lang === 'en' ? en : await load(lang);
  fallback = { ar, en };
  document.documentElement.lang = lang;
  // texts are in place: show the page (main stays hidden while booting, so no flash of old placeholder texts)
  requestAnimationFrame(() => document.documentElement.classList.remove('booting'));
  { const pv = preview(); if (pv?.as && !document.getElementById('previewBar')) {
    const flag = String.fromCodePoint(...[...pv.as].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
    document.body.insertAdjacentHTML('afterbegin', `<div id="previewBar" class="preview-bar">👁️ ${flag} ${pv.as}${pv.at ? ` · ${pv.at.lat.toFixed(3)}, ${pv.at.lng.toFixed(3)}` : ''} · <a href="/?as=off">✕</a></div>`);
  } }
  document.documentElement.dir = RTL.includes(lang) ? 'rtl' : 'ltr';
  applyI18n(document);
}

/** Raw locale value (arrays/objects), with Arabic fallback. */
export const raw = (key) => get(dict, key) ?? get(fallback.en, key) ?? get(fallback.ar, key);

export function t(key, vars = {}) {
  const s = get(dict, key) ?? get(fallback.en, key) ?? get(fallback.ar, key) ?? key;
  return String(s).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}

/** data-i18n="key" → textContent, data-i18n-placeholder / -aria / -title → attributes */
export function applyI18n(rootEl) {
  rootEl.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  rootEl.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  rootEl.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  rootEl.querySelectorAll('[data-i18n-title]').forEach((el) => { document.title = t(el.dataset.i18nTitle); });
  // tooltip of a button (NOT the page title)
  rootEl.querySelectorAll('[data-i18n-tip]').forEach((el) => { el.title = t(el.dataset.i18nTip); });
}

/** Country settings from /api/config (dates, numbers, distance units). */
export function setRegion(country) { if (country) region = { ...region, ...country }; }
export const getRegion = () => region;
/** e.g. "ar-LB-u-nu-latn": the user's language + the platform country, Western digits. */
export const localeTag = () => `${lang}-${region.code}-u-nu-latn`;
export const fmtNumber = (n) => new Intl.NumberFormat(localeTag()).format(n);
export const fmtDate = (v, opts = { year: 'numeric', month: 'long', day: 'numeric' }) => (v ? new Date(v).toLocaleDateString(localeTag(), opts) : '—');
/**
 * Distance for display, same rules as the server and the WhatsApp message:
 * < 1 km → metres rounded to 10 ("150 m"); 1–10 km → one decimal ("1.2 km"); ≥ 10 km → whole km. Feet/miles where the country uses miles.
 * Accepts metres (preferred) or { km } for older callers.
 */
export function fmtDistanceM(meters) {
  const m = Math.max(0, Number(meters) || 0);
  const one = (x) => { const r = Math.round(x * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); };
  if (region.units === 'mi') {
    const mi = m / 1609.344; const ft = Math.max(50, Math.round((m * 3.28084) / 50) * 50);
    if (mi < 0.1 && ft < 528) return t('units.ft', { d: ft });
    return t('units.mi', { d: mi < 10 ? one(mi) : Math.round(mi) });
  }
  const tens = Math.max(10, Math.round(m / 10) * 10);
  if (tens < 1000) return t('units.m', { d: tens });
  const km = m / 1000;
  return t('units.km', { d: km < 10 ? one(km) : Math.round(km) });
}
export function fmtDistance(km) { return fmtDistanceM(Number(km) * 1000); }

/** JSON API call. Throws { code, fields, status } on failure. */
export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: {
        'X-Locale': lang,
        'X-Requested-With': 'fetch',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw { code: 'network' };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw { status: res.status, code: data.error || 'server_error', fields: data.fields || {} };
  return data;
}

export const errorText = (err) => t(`errors.${err?.code || 'server_error'}`);

/** Escape text for safe insertion into HTML strings. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Approximate position from the browser, rounded to ~100 m before it ever leaves the device. */
export function getApproxPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('unavailable'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: Math.round(p.coords.latitude * 1000) / 1000, lng: Math.round(p.coords.longitude * 1000) / 1000 }),
      reject,
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 },
    );
  });
}

/** Money as people read it everywhere: $20, €45, £9.50 (Western digits), other currencies with their code. */
export function fmtMoney(v, currency = 'USD') {
  const sym = { USD: '$', EUR: '€', GBP: '£' }[currency];
  const n = new Intl.NumberFormat('en-US', { minimumFractionDigits: Number(v) % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(Number(v));
  return sym ? `${sym}${n}` : `${n} ${currency}`;
}

/** Language chosen by the user (null = automatic, by country). */
export function chosenLang() { try { return localStorage.getItem('st_lang'); } catch { return null; } }
export const currentLang = () => lang;
