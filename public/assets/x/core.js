// Aklatak v7 front-end core, shared by the customer app, the store dashboard and the driver app.
// Texts come from /locales/<lang>.json → "dx" (editable from the admin "texts" editor), in 4 languages.
export const LANGS = ['ar', 'en', 'fr', 'es'];
const RTL = new Set(['ar']);
let dict = {}, fallback = {}, lang = 'ar';

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};
export const session = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

let cfgCache = null, countryCode = 'LB';
function pickLang(countryLang) {
  const q = new URLSearchParams(location.search).get('lang');
  if (LANGS.includes(q)) { store.set('st_lang', q); return q; }
  const saved = store.get('st_lang');
  if (LANGS.includes(saved)) return saved;
  // a visitor opening the app in a new country gets that country's language (he can still switch with 🌐)
  if (LANGS.includes(countryLang)) return countryLang;
  const nav = (navigator.languages || [navigator.language || 'ar']).map((l) => String(l).slice(0, 2));
  return nav.find((l) => LANGS.includes(l)) || 'ar';
}

/** Loads the site config, finds the visitor's country (each country is separate) and its language, then the texts. */
export async function initI18n() {
  try {
    const c0 = await (await fetch('/api/config', { credentials: 'same-origin' })).json();
    countryCode = countryFromConfig(c0);
    cfgCache = countryCode === c0.country?.code ? c0 : await (await fetch(`/api/config?country=${countryCode}`, { credentials: 'same-origin' })).json();
  } catch { cfgCache = { site: { categories: [] }, liveKinds: [] }; }
  lang = pickLang(cfgCache?.country?.lang);
  const load = async (l) => { try { return (await (await fetch(`/locales/${l}.json`)).json()).dx || {}; } catch { return {}; } };
  [dict, fallback] = await Promise.all([load(lang), lang === 'ar' ? Promise.resolve({}) : load('ar')]);
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL.has(lang) ? 'rtl' : 'ltr';
  return lang;
}
export const getConfig = () => cfgCache;
export const getCountry = () => countryCode;
export const getLang = () => lang;
export function setLang(l) { if (LANGS.includes(l)) { store.set('st_lang', l); location.reload(); } }

const dig = (o, key) => key.split('.').reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), o);
export function t(key, vars) {
  let s = dig(dict, key) ?? dig(fallback, key) ?? key;
  if (vars) s = String(s).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  return s;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

export class ApiError extends Error { constructor(status, code, data) { super(code); this.status = status; this.code = code; this.data = data; } }
export async function api(method, path, body) {
  let r;
  try {
    r = await fetch(path, {
      method, credentials: 'same-origin',
      headers: { 'X-Requested-With': 'fetch', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch { throw new ApiError(0, 'network'); }
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  if (!r.ok) throw new ApiError(r.status, data?.error || 'generic', data);
  return data;
}
export function errText(e) {
  const code = e?.code || 'generic';
  const s = t(`errors.${code}`);
  return s === `errors.${code}` ? t('errors.generic') : s;
}

let toastTimer;
export function toast(msg) {
  let el = $('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.remove('hide');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hide'), 3200);
}

/** Bottom sheet. Returns { el, close }. Clicking the dim background closes it. */
export function sheet(html, { onClose } = {}) {
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => { bg.remove(); onClose?.(); };
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  document.body.appendChild(bg);
  return { el: bg.querySelector('.sheet'), close };
}

export function fmtDist(m) {
  if (m == null || !Number.isFinite(Number(m))) return '';
  m = Number(m);
  return m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} ${t('common.m')}` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} ${t('common.km')}`;
}
const SYM = { USD: '$', EUR: '€', LBP: 'ل.ل' };
export function money(n, cur = 'USD') {
  const v = Math.round(Number(n || 0) * 100) / 100;
  const s = Number.isInteger(v) ? String(v) : v.toFixed(2);
  return SYM[cur] ? `${s}${SYM[cur]}` : `${s} ${cur}`;
}
export function fmtTime(iso) {
  try { return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch { return iso; }
}

/** Precise GPS: listens up to 10 s and keeps the most accurate reading (stops early once within 25 m). */
export function locate({ maxWaitMs = 10000, goodM = 25 } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('location'));
    let best = null, done = false;
    const finish = () => { if (done) return; done = true; navigator.geolocation.clearWatch(id); clearTimeout(timer); best ? resolve(best) : reject(new Error('location')); };
    const id = navigator.geolocation.watchPosition((p) => {
      const r = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
      if (!best || r.acc < best.acc) best = r;
      if (r.acc <= goodM) finish();
    }, () => { if (!best) { done = true; navigator.geolocation.clearWatch(id); clearTimeout(timer); reject(new Error('location')); } }, { enableHighAccuracy: true, timeout: maxWaitMs, maximumAge: 0 });
    const timer = setTimeout(finish, maxWaitMs);
  });
}
export const mapsLink = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
export const telLink = (phone) => `tel:+${String(phone).replace(/^\+/, '')}`;

/** Shrink a photo on the phone before sending (keeps the database small). Returns a JPEG data URL. */
export function shrinkImage(file, { max = 1280, quality = 0.72, limit = 330_000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let { width: w, height: h } = img;
      const scale = Math.min(1, max / Math.max(w, h));
      w = Math.round(w * scale); h = Math.round(h * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      let q = quality, out = c.toDataURL('image/jpeg', q);
      while (out.length > limit && q > 0.35) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
      if (out.length > limit) { const c2 = document.createElement('canvas'); c2.width = Math.round(w * 0.7); c2.height = Math.round(h * 0.7); c2.getContext('2d').drawImage(c, 0, 0, c2.width, c2.height); out = c2.toDataURL('image/jpeg', 0.6); }
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
    img.src = url;
  });
}

/** Short beep for new orders (no audio file needed). */
let audioCtx;
export function beep() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.value = 880; g.gain.value = 0.15;
    o.start(); o.stop(audioCtx.currentTime + 0.35);
    navigator.vibrate?.([200, 100, 200]);
  } catch { /* no audio */ }
}

/** Time zone → country (from /api/config), so each country stays separate. */
export function countryFromConfig(cfg) {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const map = cfg.countryTimezones || {};   // { 'Asia/Beirut': 'LB', … }
    if (typeof map[tz] === 'string') return map[tz];
  } catch { /* ignore */ }
  return cfg.country?.code || 'LB';
}

export function langPicker() {
  const names = { ar: 'العربية', en: 'English', fr: 'Français', es: 'Español' };
  const s = sheet(`<h2>${esc(t('me.language'))}</h2><div class="list">${LANGS.map((l) => `<button class="li" data-l="${l}">${names[l]}${l === lang ? ' ✓' : ''}</button>`).join('')}</div>`);
  s.el.addEventListener('click', (e) => { const b = e.target.closest('[data-l]'); if (b) setLang(b.dataset.l); });
}

export function registerSW() { if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {}); }

/** Withdraw sheet for drivers and stores: any Whish/OMT number, confirmed with the account password; history + money log. */
export async function openWithdraw(type, onDone) {
  let info;
  try { info = await api('GET', `/api/${type}/withdrawals`); } catch (e) { toast(errText(e)); return; }
  const kinds = { topup: 'merchant.k_topup', hold: 'merchant.k_hold', release: 'merchant.k_release', adjust: 'merchant.k_adjust', earning: 'merchant.k_earning', payout: 'merchant.k_payout' };
  const can = info.balance >= info.minimum;
  const s = sheet(`<h2>${esc(t('wd.title'))}</h2>
    <div class="stat"><b>${esc(money(info.balance))}</b><span>${esc(t('wd.available'))}</span></div>
    <p class="mute small">${esc(t('wd.minimum', { m: money(info.minimum) }))} · ${esc(t('wd.daily', { m: money(info.dailyMax) }))}</p>
    ${can ? `<form id="wf">
      <label class="f">${esc(t('wd.amount'))}<input class="in" name="amount" type="number" step="0.01" min="${info.minimum}" max="${info.balance}" value="${info.balance}" inputmode="decimal" required></label>
      <label class="f">${esc(t('wd.via'))}<select class="in" name="provider"><option value="whish">Whish Money</option><option value="omt">OMT</option></select></label>
      <label class="f">${esc(t('wd.number'))}<input class="in" name="number" type="tel" inputmode="tel" required></label>
      <label class="f">${esc(t('wd.password'))}<input class="in" name="password" type="password" required autocomplete="current-password"></label>
      <div class="note">${esc(t('wd.warn'))}</div>
      <button class="btn">${esc(t('wd.send'))}</button></form>` : ''}
    <h2>${esc(t('wd.history'))}</h2>
    <div class="list">${info.withdrawals.map((w) => `<div class="row item"><span>${esc(money(w.amount))} — ${esc(w.provider.toUpperCase())} +${esc(w.number)}<br><small>${esc(fmtTime(w.created_at))}</small></span><span class="chip ${w.status === 'paid' ? 'g' : w.status === 'rejected' ? 'b' : 'w'}">${esc(t(`wd.${w.status}`))}</span></div>`).join('') || `<div class="empty">${esc(t('orders.none'))}</div>`}</div>
    <h2>${esc(t('wd.log'))}</h2>
    <div class="list">${info.ledger.map((l) => `<div class="row item"><span>${esc(t(kinds[l.kind] || l.kind))}${l.order_id ? ` #${l.order_id}` : ''}<br><small>${esc(fmtTime(l.created_at))}</small></span><b>${esc(money(l.amount))}</b></div>`).join('')}</div>
    <button class="btn alt" data-close>${esc(t('common.close'))}</button>`);
  $('#wf', s.el)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, btn = $('button', f);
    btn.disabled = true;
    try {
      await api('POST', `/api/${type}/withdrawals`, { amount: Number(f.amount.value), provider: f.provider.value, number: f.number.value, password: f.password.value, country: await detectCountry() });
      s.close(); toast(t('wd.sent')); onDone?.();
    } catch (x) { toast(errText(x)); btn.disabled = false; }
  });
}

/** The visitor's country (from the time zone), asked once. Every country is separate. */
export async function detectCountry() { return countryCode; }

/* ---------- phone notifications (reach the phone even when the app is closed) ---------- */
export function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
export async function enablePush(role, { ask = true } = {}) {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') {
    if (!ask) return 'ask';
    const p = await Notification.requestPermission();
    if (p !== 'granted') return p === 'denied' ? 'denied' : 'ask';
  }
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await api('GET', '/api/push/key');
      const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((key.length + 3) % 4)), (ch) => ch.charCodeAt(0));
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
    }
    const j = sub.toJSON();
    await api('POST', '/api/push/subscribe', { role, endpoint: j.endpoint, keys: j.keys });
    return 'on';
  } catch { return 'error'; }
}
/** Quietly re-register when permission was already given (new device key, new account on the same phone). */
export function refreshPush(role) { if (pushSupported() && Notification.permission === 'granted') enablePush(role, { ask: false }); }

/** Read a place from a Google Maps link (…@33.89,35.50… / ?q=33.89,35.50 / !3d…!4d…) or "33.89, 35.50". */
export function parseMapsLink(text) {
  const s = String(text || '');
  const m = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(s) || /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(s) || /[?&](?:q|query|ll|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/.exec(s) || /^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/.exec(s);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}
export function copyText(text) { return navigator.clipboard?.writeText(String(text)).then(() => toast(t('common.copied'))).catch(() => {}); }

/* ---------- readable colours (same maths as src/lib/contrast.js) ---------- */
const hexRgb = (h) => { h = h.slice(1); if (h.length === 3) h = [...h].map((x) => x + x).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const rgbHex = (c) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const lumOf = (c) => { const a = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]; };
const ratioOf = (a, b) => { const x = lumOf(a), y = lumOf(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
function cssRgb(s) { const m = String(s).match(/rgba?\(([^)]+)\)/); return m ? m[1].split(/[ ,/]+/).filter(Boolean).slice(0, 3).map(Number) : [255, 255, 255]; }
function towardReadable(fg, bgs, min = 4.5) {
  const ok = (c) => bgs.every((b) => ratioOf(c, b) >= min);
  if (ok(fg)) return fg;
  const to = lumOf(bgs[0]) < 0.2 ? [255, 255, 255] : [0, 0, 0];
  for (let t = 0.05; t <= 1.0001; t += 0.05) { const c = fg.map((v, i) => v + (to[i] - v) * t); if (ok(c)) return c; }
  return to;
}
/** A store's own colour on its page: buttons, prices and labels stay readable on light and dark screens. */
export function applyAccent(el, hex) {
  const props = ['--brand', '--brand-ink', '--brand-text', '--brand-soft'];
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) { props.forEach((p) => el.style.removeProperty(p)); return; }
  const c = hexRgb(hex);
  const bg = cssRgb(getComputedStyle(document.body).backgroundColor);
  const soft = c.map((v, i) => bg[i] + (v - bg[i]) * 0.12);
  el.style.setProperty('--brand', hex);
  el.style.setProperty('--brand-soft', rgbHex(soft));
  el.style.setProperty('--brand-ink', ratioOf([255, 255, 255], c) >= ratioOf([17, 24, 39], c) ? '#FFFFFF' : '#111827');
  el.style.setProperty('--brand-text', rgbHex(towardReadable(c, [bg, soft])));
}

/* ---------- drivers shown to a store or a customer ---------- */
export const fmtRoad = (m, approx) => (m == null ? '' : `${approx ? '≈ ' : ''}${fmtDist(m)}`);
const VEH = { moto: '🛵', car: '🚗' };
function face(d, photoBase) {
  return d.photo ? `<img class="dface" src="${esc(photoBase + d.id)}" alt="" loading="lazy" data-face>` : `<span class="dface">${VEH[d.vehicle] || '🛵'}</span>`;
}
// a broken photo falls back to the vehicle icon (no inline handlers: the page's security rules forbid them)
document.addEventListener('error', (e) => { const im = e.target; if (im?.matches?.('img[data-face]')) { const s = document.createElement('span'); s.className = 'dface'; s.textContent = '🛵'; im.replaceWith(s); } }, true);
/** The nearest drivers who got the request: photo, first name, distance. No phone until one accepts. */
export function candidatesHtml(list, photoBase) {
  if (!list?.length) return '';
  return `<div class="cands"><p class="mute small">${esc(t('cand.title'))}</p>${list.map((d) => `<div class="cand">${face(d, photoBase)}
    <div><b>${esc(d.name)}</b> <span class="mute small">${esc(t(`driver.${d.vehicle || 'moto'}`))}</span><br><span class="small">📍 ${esc(t('cand.away', { d: fmtRoad(d.m, d.approx) }))}</span></div>
    ${d.accepted ? `<span class="chip g">✓ ${esc(t('cand.accepted'))}</span>` : ''}</div>`).join('')}
    <p class="mute tiny">🔒 ${esc(t('cand.phoneLater'))}</p></div>`;
}
/** The driver who got the job: photo, name, distance (live), and now his phone. */
export function driverHtml(d, photoBase, { distLabel = '' } = {}) {
  return `<div class="cand big">${face(d, photoBase)}<div><b>${esc(d.name)}</b> <span class="mute small">${esc(t(`driver.${d.vehicle || 'moto'}`))}</span>${distLabel ? `<br><span class="small">📍 ${esc(distLabel)}</span>` : ''}</div></div>`;
}

/** A clear bill for one order (printable / saved as PDF from the phone's print menu). */
export function invoiceSheet({ ref, store, customer, items, total, currency, createdAt, note, deliveryFee = null, customerTotal = null, method = null }) {
  const rows = (items || []).map((i) => `<tr><td>${esc(i.name)}</td><td>${Number(i.qty)}</td><td>${esc(money(i.price, currency))}</td><td>${esc(money(Number(i.price) * Number(i.qty), currency))}</td></tr>`).join('');
  const sh = sheet(`<div class="invoice" id="inv"><h2>🧾 ${esc(t('inv.title'))} ${esc(ref || '')}</h2>
    <p class="small">${store ? `🏪 ${esc(store)}<br>` : ''}${customer ? `👤 ${esc(customer)}<br>` : ''}🕐 ${esc(fmtTime(createdAt))}</p>
    <table class="inv"><thead><tr><th>${esc(t('inv.item'))}</th><th>${esc(t('inv.qty'))}</th><th>${esc(t('inv.price'))}</th><th>${esc(t('inv.sum'))}</th></tr></thead><tbody>${rows}</tbody>
    <tfoot>${deliveryFee != null ? `<tr><td colspan="3">${esc(t('pay.food'))}</td><td>${esc(money(total, currency))}</td></tr><tr><td colspan="3">${esc(t('pay.fee'))}</td><td>${esc(money(deliveryFee, currency))}</td></tr>` : ''}
    <tr><td colspan="3"><b>${esc(t('common.total'))}</b></td><td><b>${esc(money(customerTotal ?? total, currency))}</b></td></tr></tfoot></table>
    ${note ? `<p class="mute small">📝 ${esc(note)}</p>` : ''}<p class="mute tiny">${esc(method === 'card' ? t('pay.paidCard') : t('inv.cash'))}</p></div>
    <div class="grid2 noprint"><button class="btn" id="invPrint">🖨 ${esc(t('merchant.print'))}</button><button class="btn alt" data-close>${esc(t('common.close'))}</button></div>`);
  $('#invPrint', sh.el).onclick = () => { document.body.classList.add('printing-inv'); window.print(); setTimeout(() => document.body.classList.remove('printing-inv'), 500); };
  return sh;
}

/* ---------- 📌 choose a place on the map (an extra option next to GPS and a Google Maps link) ----------
   A small map of our own (OpenStreetMap tiles): drag the map under the pin, zoom with + / − or two fingers. */
const TILE = 256;
const lng2x = (lng, z) => ((lng + 180) / 360) * TILE * 2 ** z;
const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z; };
const x2lng = (x, z) => (x / (TILE * 2 ** z)) * 360 - 180;
const y2lat = (y, z) => { const n = Math.PI - (2 * Math.PI * y) / (TILE * 2 ** z); return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };
export function pickOnMap(start) {
  return new Promise((resolve) => {
    let z = start?.lat != null ? 17 : 13;
    let c = { lat: Number(start?.lat ?? 33.8938), lng: Number(start?.lng ?? 35.5018) };
    let finished = false;
    const sh = sheet(`<h2>📌 ${esc(t('map.title'))}</h2><p class="mute small">${esc(t('map.hint'))}</p>
      <div class="pmap" id="pmap"><div class="ptiles" id="ptiles"></div><div class="ppin" aria-hidden="true">📍</div>
        <div class="pzoom"><button type="button" id="zin" aria-label="+">+</button><button type="button" id="zout" aria-label="−">−</button><button type="button" id="zme" aria-label="${esc(t('map.me'))}">🎯</button></div>
        <a class="pattr" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a></div>
      <p class="small mute" id="pll" dir="ltr"></p>
      <button class="btn" id="pok">✅ ${esc(t('map.use'))}</button>`, { onClose: () => { if (!finished) resolve(null); } });
    const box = $('#pmap', sh.el), tiles = $('#ptiles', sh.el);
    function draw() {
      const w = box.clientWidth, h = box.clientHeight;
      const cx = lng2x(c.lng, z), cy = lat2y(c.lat, z);
      const x0 = cx - w / 2, y0 = cy - h / 2, n = 2 ** z;
      const html = [];
      for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + w) / TILE); tx++) {
        for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + h) / TILE); ty++) {
          if (ty < 0 || ty >= n) continue;
          const wx = ((tx % n) + n) % n;
          html.push(`<img src="https://tile.openstreetmap.org/${z}/${wx}/${ty}.png" alt="" draggable="false" data-l="${Math.round(tx * TILE - x0)}" data-t="${Math.round(ty * TILE - y0)}">`);
        }
      }
      tiles.innerHTML = html.join('');
      // positions through the CSS object model (the page's security rules forbid inline styles)
      for (const im of tiles.children) { im.style.left = `${im.dataset.l}px`; im.style.top = `${im.dataset.t}px`; }
      $('#pll', sh.el).textContent = `${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`;
    }
    const pts = new Map();
    let last = null, pinch = null;
    box.addEventListener('pointerdown', (e) => { if (e.target.closest('.pzoom,.pattr')) return; box.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); last = { x: e.clientX, y: e.clientY }; pinch = null; });
    box.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (!pinch) pinch = d;
        else if (d / pinch > 1.5 && z < 19) { z++; pinch = d; draw(); }
        else if (pinch / d > 1.5 && z > 3) { z--; pinch = d; draw(); }
        return;
      }
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
      c = { lat: y2lat(lat2y(c.lat, z) - dy, z), lng: x2lng(lng2x(c.lng, z) - dx, z) };
      draw();
    });
    const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (pts.size === 1) last = [...pts.values()][0]; };
    box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up);
    box.addEventListener('dblclick', () => { if (z < 19) { z++; draw(); } });
    $('#zin', sh.el).onclick = () => { if (z < 19) { z++; draw(); } };
    $('#zout', sh.el).onclick = () => { if (z > 3) { z--; draw(); } };
    $('#zme', sh.el).onclick = async () => { try { const p = await locate(); c = { lat: p.lat, lng: p.lng }; z = 17; draw(); } catch { toast(t('errors.location')); } };
    $('#pok', sh.el).onclick = () => { finished = true; sh.close(); resolve({ lat: Number(c.lat.toFixed(6)), lng: Number(c.lng.toFixed(6)), acc: 0, map: true }); };
    requestAnimationFrame(draw);
  });
}
