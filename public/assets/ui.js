// Shared UI building blocks used by the customer pages, the cook account and the admin panel.
import { t, api, esc, getConfig, chosenLang, currentLang, fmtDistanceM, visitorRegion } from './i18n.js?v=610';

export const $ = (s, r = document) => r.querySelector(s);

/* ---------- site menu (☰): added to every public page's header ---------- */
// "Join" and "Log in" stay as buttons in the header, not in the menu.
const MENU = [
  ['/', 'menu.home', null],
  ['/nearby', 'menu.nearby', 'nearby'],
  ['/nearby?type=restaurant', 'menu.nearbyRestaurants', 'restaurants'],
  ['/regions', 'menu.regions', 'regions'],
  ['/dishes', 'menu.dishes', 'dishes'],
];
let siteConfig = null;
export async function getSiteConfig() {
  if (!siteConfig) siteConfig = (getConfig() || api('/api/config')).catch(() => ({ site: { sections: {} } }));
  return siteConfig;
}
function injectMenu() {
  const head = document.querySelector('.masthead');
  if (!head || head.querySelector('.menu-btn')) return;
  const actions = head.querySelector('.nav-actions') || head;
  actions.insertAdjacentHTML('beforeend',
    `<button class="menu-btn" type="button" aria-expanded="false" aria-controls="siteMenu" aria-label="${esc(t('menu.open'))}" title="${esc(t('menu.open'))}">
       <span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true"></span></button>`);
  head.insertAdjacentHTML('afterend', `<nav class="site-menu" id="siteMenu" hidden></nav>`);
  const btn = head.querySelector('.menu-btn');
  const nav = document.getElementById('siteMenu');
  // ☰ = the categories shown on the home page (same order, same names), then the app and "advertise".
  const render = (site = {}, live = []) => {
    const here = location.pathname + location.search;
    const hidden = new Set(site.menuHidden || []);
    let reg = ''; try { reg = visitorRegion(cfg0 || {}); } catch { /* ignore */ }
    const hc = (site.countriesHidden || []).includes(reg), hcats = new Set(site.countryCatsHidden?.[reg] || []);
    const cats = hc ? [] : (site.categories || []).filter((c) => showOnHome(c, live) && !hidden.has(`cat:${c.key}`) && !hcats.has(c.key));
    const link = (href, label) => `<a href="${href}"${here === href ? ' aria-current="page"' : ''}>${label}</a>`;
    const section = (g, icon) => { if ((site.groupsHidden || []).includes(g)) return ''; const list = cats.filter((c) => (c.group === 'crafts' ? 'crafts' : 'shops') === g); return list.length ? `<p class="menu-head">${icon} ${esc(t(`home.tab_${g}`))}</p>` + list.map((c) => link(`/nearby?type=${encodeURIComponent(c.key)}`, `${esc(c.icon)} ${esc(catLabel(c, 'many'))}`)).join('') : ''; };
    nav.innerHTML = section('shops', '🏪') + (cats.some((c) => c.group === 'crafts') ? '<hr>' : '') + section('crafts', '🛠️')
      + `<hr>${hidden.has('app') ? '' : link('/app', `📲 ${esc(t('menu.app'))}`)}${hidden.has('advertise') ? '' : link('/advertise', `📣 ${esc(t('menu.advertise'))}`)}`;
    // top bar buttons the owner chose to hide
    if (hidden.has('join')) document.querySelectorAll('.masthead a[href="/join"]').forEach((a) => { a.hidden = true; });
    if (hidden.has('login')) document.querySelectorAll('.masthead a[href="/account"]').forEach((a) => { a.hidden = true; });
  };
  render();
  let cfg0 = null;
  getSiteConfig().then((c) => { cfg0 = c; render(c.site || {}, c.liveKinds || []); });
  const close = () => { nav.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    nav.hidden = !nav.hidden;
    btn.setAttribute('aria-expanded', String(!nav.hidden));
  });
  document.addEventListener('click', (e) => { if (!nav.hidden && !nav.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}
/* ---------- ads & logos placed by the admin ---------- */
let bannersPromise = null;
/** Fill every element with data-banners="<placement>" on the page. */
export async function renderBanners(root = document) {
  const slots = root.querySelectorAll('[data-banners]');
  if (!slots.length) return;
  if (!bannersPromise) bannersPromise = api('/api/banners').then((r) => r.banners).catch(() => []);
  const all = await bannersPromise;
  slots.forEach((slot) => {
    const list = all.filter((b) => b.placement === slot.dataset.banners);
    slot.hidden = !list.length;
    slot.innerHTML = list.map((b) => {
      const img = `<img src="${esc(b.imageUrl)}" alt="${esc(b.title)}" loading="lazy">`;
      return b.linkUrl ? `<a class="banner" href="${esc(b.linkUrl)}" ${/^https?:/i.test(b.linkUrl) ? 'target="_blank" rel="noopener"' : ''}>${img}</a>` : `<div class="banner">${img}</div>`;
    }).join('');
  });
}

/** Call once per page, after initI18n() (so the menu shows real texts). */
/**
 * Directions to a shop: opens the phone's maps app and starts turn-by-turn navigation right away
 * (it stops by itself on arrival). iPhone → Apple Maps, others → Google Maps.
 */
export function directionsUrl(nav) {
  if (!nav) return null;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  return ios ? `https://maps.apple.com/?daddr=${nav.lat},${nav.lng}&dirflg=d`
    : `https://www.google.com/maps/dir/?api=1&destination=${nav.lat},${nav.lng}&travelmode=driving&dir_action=navigate`;
}

/** The customer's options for a subscriber — nothing mandatory: order (WhatsApp), call, directions. */
export function actionButtons(c, { order = true } = {}) {
  const out = [];
  if (order && c.canOrder !== false) out.push(`<a class="act act-order" href="${esc(c.profileUrl)}">💬 ${esc(t('act.order'))}</a>`);
  if (c.callPhone) out.push(`<a class="act act-call" href="tel:+${esc(String(c.callPhone).replace(/^\+/, ''))}">📞 ${esc(t('act.call'))}</a>`);
  if (c.nav) out.push(`<a class="act act-nav" href="${esc(directionsUrl(c.nav))}" target="_blank" rel="noopener">🧭 ${esc(t('act.directions'))}</a>`);
  return out.length ? `<span class="acts">${out.join('')}</span>` : '';
}

/** Shown on the home page / menu: always, or 'auto' once the category has a live subscriber. */
export const showOnHome = (c, live = []) => c.home === true || (c.home === 'auto' && live.includes(c.key));

/** A category's name in the visitor's language (form: 'one' = "pharmacy", 'many' = "pharmacies"). */
export function catLabel(c, form = 'one') {
  const l = currentLang();
  return c?.names?.[l]?.[form] || c?.names?.en?.[form] || c?.names?.ar?.[form] || c?.key || '';
}

/* ---------- language button 🌐 (home page only): Ar · En · Fr · Sp — the choice applies to the whole site ---------- */
const LANG_SHORT = { ar: 'Ar', en: 'En', fr: 'Fr', es: 'Sp' };
export async function initLangButton() {
  const actions = document.querySelector('.masthead .nav-actions');
  if (!actions || document.querySelector('.lang-btn')) return;
  const cfg = await getSiteConfig();
  const langs = (cfg.locales || ['ar', 'en', 'fr', 'es']).filter((l) => LANG_SHORT[l] || l);
  const cur = currentLang();
  const href = (l) => { const u = new URL(location.href); u.searchParams.set('lang', l); return u.pathname + u.search; };
  actions.insertAdjacentHTML('afterbegin', `
    <span class="lang-wrap">
      <button class="lang-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="${esc(t('lang.title'))}" title="${esc(t('lang.title'))}">🌐</button>
      <span class="lang-pop" hidden>${langs.map((l) => `<a href="${href(l)}" lang="${l}"${l === cur ? ' aria-current="true"' : ''}>${esc(LANG_SHORT[l] || l.toUpperCase())}</a>`).join('')}</span>
    </span>`);
  const btn = actions.querySelector('.lang-btn');
  const pop = actions.querySelector('.lang-pop');
  btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; btn.setAttribute('aria-expanded', String(!pop.hidden)); });
  document.addEventListener('click', () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); });
}

function injectFooter() {
  if (document.querySelector('.legal-links')) return;
  const main = document.querySelector('main.shell') || document.body;
  main.insertAdjacentHTML('beforeend', `<nav class="legal-links">
    <a href="/about">${esc(t('legal.aboutLink'))}</a> · <a href="/terms">${esc(t('legal.termsLink'))}</a> · <a href="/privacy">${esc(t('legal.privacyLink'))}</a> · <a href="/contact">${esc(t('legal.contactLink'))}</a>
    <span class="geo-credit" hidden> · <a href="https://www.geoapify.com/" target="_blank" rel="noopener" dir="ltr">${esc(t('legal.poweredGeo'))}</a></span></nav>`);
  // Credit required by Geoapify's free plan — shown only when the platform uses Geoapify.
  getSiteConfig().then((c) => { if (c.geoAttribution) document.querySelector('.legal-links .geo-credit')?.removeAttribute('hidden'); });
}
/**
 * Location permission, the friendly way: the button itself triggers the phone's "Allow" box.
 * If the person refused before (the phone then never asks again), show 3 short steps for THEIR device, right here.
 * err: GeolocationPositionError (1 denied, 2 unavailable, 3 timeout) or anything else.
 */
export function explainGpsError(el, err, onRetry) {
  if (!el) return;
  el.classList.add('bad');
  const code = err?.code;
  if (code !== 1) { el.textContent = t(code === 3 ? 'gps.timeout' : 'gps.unavailable'); return; }
  const ua = navigator.userAgent;
  const inApp = window.matchMedia?.('(display-mode: standalone)').matches;
  const key = inApp ? 'gps.stepsApp' : /iPhone|iPad|iPod/.test(ua) ? 'gps.stepsIos' : 'gps.stepsAndroid';
  el.innerHTML = `<span class="gps-help"><b>${esc(t('gps.deniedTitle'))}</b>
    <ol>${t(key).split('|').map((x) => `<li>${esc(x.trim())}</li>`).join('')}</ol>
    <button type="button" class="btn btn-gold gps-retry">${esc(t('gps.retry'))}</button></span>`;
  // Try again in place — never reload the page (what the person typed stays where it is).
  el.querySelector('.gps-retry').addEventListener('click', () => {
    el.classList.remove('bad'); el.textContent = t('location.locating');
    if (typeof onRetry === 'function') onRetry();
  });
}

/** Installable app + offline screen (no personal data cached). */
function registerServiceWorker() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
/** The owner's logo (admin panel → Design), when one was uploaded. */
function applyLogo() {
  getSiteConfig().then((c) => {
    const th = c.site?.theme || {};
    let src = null;
    if (th.logo?.startsWith('preset:')) src = `/assets/logos/${th.logo.slice(7)}.svg`;     // ready-made logos
    else if (th.logo?.startsWith('asset:')) src = `/media/asset/${th.logo.slice(6)}`;      // uploaded by the owner
    else if (th.logoVersion) src = `/media/logo?v=${th.logoVersion}`;                     // older single upload
    if (!src) return;
    document.querySelectorAll('img.logo-mark').forEach((img) => { img.src = src; });
  });
}
/* ---------- 🔍 search next to the logo: categories and subscribers by name ---------- */
function injectSearch() {
  const mark = document.querySelector('.masthead .wordmark');
  if (!mark || document.querySelector('.site-search-btn')) return;
  mark.insertAdjacentHTML('afterend', `<button class="site-search-btn" type="button" aria-label="${esc(t('search.open'))}" title="${esc(t('search.open'))}">🔍</button>`);
  document.body.insertAdjacentHTML('beforeend', `<div class="site-search" hidden role="dialog" aria-modal="true" aria-label="${esc(t('search.open'))}">
      <div class="site-search-box"><input class="input" type="search" id="siteSearchQ" placeholder="${esc(t('search.placeholder'))}" autocomplete="off">
        <button class="btn-text" type="button" id="siteSearchClose">${esc(t('common.close'))}</button></div>
      <div id="siteSearchResults" class="site-search-results"></div></div>`);
  const box = document.querySelector('.site-search');
  const q = document.getElementById('siteSearchQ');
  const out = document.getElementById('siteSearchResults');
  const norm = (x) => String(x || '').toLowerCase().normalize('NFKD').replace(/[\u064B-\u065F\u0670\u0300-\u036f]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي');
  let timer; let seq = 0;
  const run = async () => {
    const term = q.value.trim(); const my = ++seq;
    if (term.length < 2) { out.innerHTML = `<p class="fine">${esc(t('search.hint'))}</p>`; return; }
    const cfg = await getSiteConfig();
    const n = norm(term);
    let tab = 'shops'; try { tab = sessionStorage.getItem('st_tab') === 'crafts' ? 'crafts' : 'shops'; } catch { /* ignore */ }
    if ((cfg.site?.groupsHidden || []).includes(tab)) tab = tab === 'shops' ? 'crafts' : 'shops';
    const inTab = (k) => ((cfg.site?.categories || []).find((c) => c.key === k)?.group === 'crafts' ? 'crafts' : 'shops') === tab;
    const cats = (cfg.site?.categories || []).filter((c) => !c.deleted && inTab(c.key) && Object.values(c.names || {}).some((v) => norm(v.one).includes(n) || norm(v.many).includes(n)));
    let people = [];
    try { people = ((await api(`/api/cooks/search?q=${encodeURIComponent(term)}&country=${visitorRegion(cfg) || ''}`)).cooks || []).filter((p) => inTab(p.kind || 'cook')); } catch { /* ignore */ }   // own country, current tab
    if (my !== seq) return;
    out.innerHTML = (cats.length ? `<p class="label">${esc(t('search.categories'))}</p>` + cats.map((c) => `<a class="ss-item" href="/nearby?type=${encodeURIComponent(c.key)}">${esc(c.icon)} ${esc(catLabel(c, 'many'))}</a>`).join('') : '')
      + (people.length ? `<p class="label">${esc(t('search.subscribers'))}</p>` + people.map((p) => `<a class="ss-item" href="${esc(p.profileUrl)}">👤 ${esc(p.name)} <small>${esc(p.area || '')}</small></a>`).join('') : '')
      || `<p class="fine">${esc(t('search.none'))}</p>`;
  };
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 280); });
  document.querySelector('.site-search-btn').addEventListener('click', () => { box.hidden = false; q.focus(); run(); });
  document.getElementById('siteSearchClose').addEventListener('click', () => { box.hidden = true; });
  box.addEventListener('click', (e) => { if (e.target === box) box.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') box.hidden = true; });
}

export function initMenu() { injectMenu(); renderBanners(); injectFooter(); registerServiceWorker(); applyLogo(); injectSearch(); }

/* ---------- header back button: previous page on this site, otherwise home ---------- */
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-back]')) return;
  let sameSite = false;
  try { sameSite = !!document.referrer && new URL(document.referrer).origin === location.origin; } catch { /* ignore */ }
  if (sameSite && history.length > 1) history.back();
  else location.href = '/';
});

/**
 * Current position.
 * precise=true: keeps listening to the phone's GPS (up to maxWaitMs) and returns the MOST ACCURATE reading,
 * stopping early once it is within goodEnough metres. onProgress(accuracyMetres) reports live accuracy.
 * Resolves { lat, lng, accuracy }.
 */
/**
 * Before the phone asks for the FIRST time, explain which button to press ("Allow while using the app").
 * Phones stop asking for good after the box is refused or dismissed a few times — this prevents mistaken refusals.
 * Shown once per visit, only when the permission is still undecided.
 */
async function primeLocationPermission() {
  try {
    if (sessionStorage.getItem('st_gps_primed')) return;
    const state = navigator.permissions ? (await navigator.permissions.query({ name: 'geolocation' })).state : 'prompt';
    if (state !== 'prompt') return;
    sessionStorage.setItem('st_gps_primed', '1');
    await new Promise((done) => {
      document.body.insertAdjacentHTML('beforeend', `<div class="gps-prime" role="dialog" aria-modal="true">
        <div class="gps-prime-box"><p class="gps-prime-icon" aria-hidden="true">📍</p>
          <p><b>${esc(t('gps.primeTitle'))}</b></p><p>${esc(t('gps.primeText'))}</p>
          <button class="btn btn-gold" type="button">${esc(t('gps.primeOk'))}</button></div></div>`);
      const box = document.querySelector('.gps-prime');
      box.querySelector('button').addEventListener('click', () => { box.remove(); done(); }, { once: true });
    });
  } catch { /* permissions API missing: just ask */ }
}

export function getPosition(opts = {}) {
  // preview mode: the place given in the link instead of this phone's GPS
  try { const pv = JSON.parse(sessionStorage.getItem('st_preview') || 'null'); if (pv?.at) return Promise.resolve({ lat: pv.at.lat, lng: pv.at.lng, accuracy: 10, ts: Date.now(), source: 'preview' }); } catch { /* ignore */ }
  return primeLocationPermission().then(() => getPositionNow(opts)).then((p) => { if (opts.precise) saveLocation(p); return p; });
}

/**
 * Single source of the customer's current position for every distance on the site/app.
 * A newer fix always wins (an older one never overwrites it); readers say how old they accept (default 2 min).
 */
const LOC_KEY = 'st_loc';
export const MAX_LOCATION_AGE_MS = 2 * 60_000;
function saveLocation(p) {
  try {
    const cur = JSON.parse(sessionStorage.getItem(LOC_KEY) || 'null');
    if (cur && cur.at > p.at) return;
    sessionStorage.setItem(LOC_KEY, JSON.stringify({ lat: p.lat, lng: p.lng, accuracy: p.accuracy, at: p.at }));
  } catch { /* private mode */ }
}
export function lastLocation(maxAgeMs = MAX_LOCATION_AGE_MS) {
  try {
    const v = JSON.parse(sessionStorage.getItem(LOC_KEY) || 'null');
    return v && Date.now() - v.at <= maxAgeMs ? v : null;
  } catch { return null; }
}

/** One way to write a distance everywhere: road (like the maps app) or, when no route is known, "≈" straight line. */
export function distanceLabel(c, { long = false } = {}) {
  if (c?.distanceM == null) return '';
  const d = fmtDistanceM(c.distanceM);
  if (c.distanceKind === 'road') return long ? `${d} ${t('dist.road')}${c.driveMin ? ` · ${t('dist.min', { n: c.driveMin })}` : ''}` : d;
  return long ? `≈ ${d} ${t('dist.straight')}` : `≈ ${d}`;
}

function getPositionNow({ precise = false, maxWaitMs = 15000, goodEnough = 25, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('unavailable'));
    const digits = precise ? 100000 : 1000;   // precise: ≈1 m
    const out = (p) => ({
      lat: Math.round(p.coords.latitude * digits) / digits,
      lng: Math.round(p.coords.longitude * digits) / digits,
      accuracy: Math.round(p.coords.accuracy || 0),
      at: p.timestamp || Date.now(),
    });
    if (!precise) {
      navigator.geolocation.getCurrentPosition((p) => resolve(out(p)), reject, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
      return;
    }
    let best = null, done = false, id = null;
    const finish = (err) => {
      if (done) return;
      done = true;
      if (id != null) navigator.geolocation.clearWatch(id);
      clearTimeout(timer);
      if (best) resolve(out(best)); else reject(err || new Error('timeout'));
    };
    const timer = setTimeout(() => finish(), maxWaitMs);
    id = navigator.geolocation.watchPosition(
      (p) => {
        if (p.timestamp && Date.now() - p.timestamp > 2 * 60_000) return;   // ignore a stale (cached) reading
        if (!best || p.coords.accuracy < best.coords.accuracy) best = p;
        onProgress?.(Math.round(best.coords.accuracy));
        if (best.coords.accuracy <= goodEnough) finish();
      },
      (err) => { if (err.code === 1 || !best) finish(err); }, // 1 = permission denied
      { enableHighAccuracy: true, maximumAge: 0, timeout: maxWaitMs },
    );
  });
}

/** "View on map" link + accuracy line shown after locating. */
export function accuracyHtml(pos) {
  const weak = pos.accuracy > 100;
  return `<span class="${weak ? 'bad' : ''}">${esc(t(weak ? 'join.accuracyWeak' : 'join.accuracy', { m: pos.accuracy }))}</span>
    <a href="https://maps.google.com/?q=${pos.lat},${pos.lng}" target="_blank" rel="noopener">${esc(t('join.viewOnMap'))}</a>`;
}

/** Honest text after locating: "near X" only when really close, and say when the map was unavailable. */
export function locatedText(r) {
  const n = r.nearest;
  if (!n || n.distanceKm > 30) return t('join.gpsDoneNoTowns');
  const main = n.distanceKm > 1.5 ? t('join.gpsDoneFar', { area: n.name, d: n.distanceKm }) : t('join.gpsDone', { area: n.name });
  return r.source === 'fallback' ? `${main} — ${t('join.mapUnavailable')}` : main;
}

/* ---------- device-local memory (no account needed for customers) ---------- */
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

export function viewerId() {
  let id = store.get('st_vid', null);
  if (!id) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    id = btoa(String.fromCharCode(...b)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]));
    store.set('st_vid', id);
  }
  return id;
}

/** "My cooks": cooks this customer contacted, with the private token that lets her rate them. */
export const myCooks = {
  list() { return store.get('st_my_cooks', []); },
  remember({ id, name, reviewToken }) {
    const list = this.list().filter((c) => c.id !== id);
    list.unshift({ id, name, reviewToken, at: Date.now(), rating: null, dismissed: false });
    store.set('st_my_cooks', list.slice(0, 20));
  },
  update(id, patch) { store.set('st_my_cooks', this.list().map((c) => (c.id === id ? { ...c, ...patch } : c))); },
  get(id) { return this.list().find((c) => c.id === Number(id)) || null; },
};

/* ---------- stars ---------- */
export function starsHtml(rating, { size = '' } = {}) {
  if (!rating || !rating.count) return `<span class="stars-new">${esc(t('results.newCook'))}</span>`;
  return `<span class="stars ${size}" aria-label="${rating.avg} / 5"><span class="star-glyph" aria-hidden="true">★</span> ${rating.avg}<span class="stars-count"> (${rating.count})</span></span>`;
}

/** Interactive 1–5 star input. */
export function starInput(container, { value = 0, onPick }) {
  container.innerHTML = `<div class="star-input" role="radiogroup">${[1, 2, 3, 4, 5].map((n) =>
    `<button type="button" role="radio" aria-checked="${n === value}" aria-label="${n}" data-n="${n}" class="${n <= value ? 'on' : ''}">★</button>`).join('')}</div>`;
  container.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.n);
    container.querySelectorAll('button').forEach((x) => { x.classList.toggle('on', Number(x.dataset.n) <= n); x.setAttribute('aria-checked', String(Number(x.dataset.n) === n)); });
    onPick(n);
  }));
}

/* ---------- avatar ---------- */
export function avatarHtml(c, cls = 'avatar') {
  return c.photoUrl
    ? `<img class="${cls}" src="${esc(c.photoUrl)}" alt="" loading="lazy">`
    : `<span class="${cls}" aria-hidden="true">${esc([...(c.name || '').trim()][0] || '')}</span>`;
}

/* ---------- images ---------- */
export function resizeImage(file, max = 900, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      // WebP is ~30% lighter; browsers that can't encode it silently return PNG, so fall back to JPEG.
      const webp = c.toDataURL('image/webp', quality);
      resolve(webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    img.src = url;
  });
}

/* ---------- village search (autocomplete) ---------- */
/**
 * Turns a text input into a village search. Calls onPick({id, name, districtName}).
 * base = API prefix for lookups (same for everyone).
 */
export function areaSearch(input, { onPick, list = null }) {
  const box = list || document.createElement('ul');
  if (!list) { box.className = 'suggest'; input.insertAdjacentElement('afterend', box); }
  box.setAttribute('role', 'listbox');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('autocomplete', 'off');
  let timer, items = [], active = -1, seq = 0;
  const close = () => { box.hidden = true; box.innerHTML = ''; items = []; active = -1; input.setAttribute('aria-expanded', 'false'); };
  const render = () => {
    box.innerHTML = items.length
      ? items.map((a, i) => `<li role="option" data-i="${i}" aria-selected="${i === active}"><b>${esc(a.name)}</b><span>${esc(a.districtName || '')}</span></li>`).join('')
      : `<li class="suggest-empty">${esc(t('location.noMatch'))}</li>`;
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };
  const pick = (a) => { input.value = a.name; close(); onPick(a); };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) return close();
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const r = await api(`/api/areas/search?q=${encodeURIComponent(q)}`);
        if (my !== seq) return;
        items = r.areas; active = items.length ? 0 : -1; render();
      } catch { /* ignore */ }
    }, 180);
  });
  input.addEventListener('keydown', (e) => {
    if (box.hidden || !items.length) return;
    if (e.key === 'ArrowDown') { active = (active + 1) % items.length; render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = (active - 1 + items.length) % items.length; render(); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(items[Math.max(0, active)]); }
    else if (e.key === 'Escape') close();
  });
  box.addEventListener('mousedown', (e) => e.preventDefault());
  box.addEventListener('click', (e) => { const li = e.target.closest('[data-i]'); if (li) pick(items[Number(li.dataset.i)]); });
  input.addEventListener('blur', () => setTimeout(close, 150));
  close();
  return { close };
}

/* ---------- "where do you deliver?" editor (cook signup, cook account, admin) ---------- */
/**
 * Villages around the cook's GPS position are suggested UNTICKED — the cook picks the ones they deliver to.
 * They can also search any village, or add a whole district.
 */
export function servedAreasEditor(root, { initial = [], point = null, districts = [] } = {}) {
  const selected = new Map(initial.map((a) => [a.id, a]));
  root.innerHTML = `
    <p class="hint" data-role="hint"></p>
    <div class="chips" data-role="nearby"></div>
    <div class="area-add">
      <input class="input" data-role="search" placeholder="${esc(t('areasPicker.search'))}" aria-label="${esc(t('areasPicker.search'))}">
    </div>
    <div class="district-row" data-role="districtRow" hidden><button type="button" class="btn-text" data-role="district"></button></div>
    <div class="selected-head"><span class="label" data-role="count"></span><button type="button" class="btn-text" data-role="clear">${esc(t('areasPicker.clear'))}</button></div>
    <div class="chips" data-role="selected"></div>`;
  const nearbyBox = $('[data-role="nearby"]', root);
  const selBox = $('[data-role="selected"]', root);
  let nearby = [], currentDistrict = null;

  const renderSelected = () => {
    $('[data-role="count"]', root).textContent = t('areasPicker.selected', { n: selected.size });
    $('[data-role="clear"]', root).hidden = !selected.size;
    selBox.innerHTML = [...selected.values()].map((a) =>
      `<button type="button" class="chip-sel" data-id="${a.id}" aria-label="${esc(t('areasPicker.remove', { name: a.name }))}">${esc(a.name)} <span aria-hidden="true">×</span></button>`).join('');
  };
  const renderNearby = () => {
    $('[data-role="hint"]', root).textContent = nearby.length ? t('areasPicker.nearby') : t('areasPicker.noHome');
    nearbyBox.innerHTML = nearby.map((a) =>
      `<label class="chip"><input type="checkbox" value="${a.id}" ${selected.has(a.id) ? 'checked' : ''}><span>${esc(a.name)}</span></label>`).join('');
  };
  const add = (a) => { selected.set(a.id, a); renderSelected(); renderNearby(); };
  const remove = (id) => { selected.delete(id); renderSelected(); renderNearby(); };

  nearbyBox.addEventListener('change', (e) => {
    const id = Number(e.target.value);
    const a = nearby.find((x) => x.id === id);
    if (e.target.checked) add(a); else remove(id);
  });
  selBox.addEventListener('click', (e) => { const b = e.target.closest('[data-id]'); if (b) remove(Number(b.dataset.id)); });
  $('[data-role="clear"]', root).addEventListener('click', () => { selected.clear(); renderSelected(); renderNearby(); });
  const search = $('[data-role="search"]', root);
  areaSearch(search, { onPick: (a) => { add(a); search.value = ''; } });
  $('[data-role="district"]', root).addEventListener('click', async () => {
    if (!currentDistrict) return;
    const r = await api(`/api/areas/district?key=${encodeURIComponent(currentDistrict)}`);
    r.areas.forEach((a) => selected.set(a.id, a));
    renderSelected(); renderNearby();
  });

  /** Load the villages & areas around a GPS point (from the map), all unticked. */
  async function setPoint(lat, lng) {
    const r = await api(`/api/areas/around?lat=${lat}&lng=${lng}`);
    nearby = r.areas;
    currentDistrict = r.nearest?.district || null;
    const d = districts.find((x) => x.key === currentDistrict);
    $('[data-role="districtRow"]', root).hidden = !d;
    if (d) $('[data-role="district"]', root).textContent = t('areasPicker.district', { name: d.name });
    renderNearby();
    return r;
  }

  renderSelected();
  renderNearby();
  if (point) setPoint(point.lat, point.lng).catch(() => {});
  return { setPoint, ids: () => [...selected.keys()], count: () => selected.size };
}
