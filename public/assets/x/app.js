// Aklatak v7 — customer app (single page, hash routes).
import {
  initI18n, t, esc, $, $$, api, errText, toast, sheet, fmtDist, money, fmtTime, locate, mapsLink, telLink,
  session, countryFromConfig, langPicker, registerSW, getLang, getConfig, getCountry, enablePush, refreshPush, parseMapsLink as parseLink, pushSupported, applyAccent, candidatesHtml, driverHtml, fmtRoad, invoiceSheet, pickOnMap,
} from './core.js';

const S = { cfg: null, country: 'LB', loc: session.get('loc'), me: null, cats: [], view: null, timer: null, cartIdleMin: 30 };
const main = () => $('#main');

/* ---------------- cart (sessionStorage: empties when the app is closed) ---------------- */
const cart = {
  get() { return session.get('cart') || null; },
  set(c) { session.set('cart', c); renderBar(); },
  count() { const c = this.get(); return c ? Object.values(c.items).reduce((a, i) => a + i.qty, 0) : 0; },
  total() { const c = this.get(); return c ? Object.values(c.items).reduce((a, i) => a + i.qty * i.price, 0) : 0; },
  add(store, item, delta) {
    let c = this.get();
    if (c && c.storeId !== store.id) {
      if (!confirm(t('cart.otherStore'))) return;
      c = null;
    }
    c ||= { storeId: store.id, storeName: store.name, currency: item.currency || 'USD', items: {} };
    const cur = c.items[item.id] || { id: item.id, name: item.name, price: Number(item.price), qty: 0 };
    cur.qty = Math.max(0, Math.min(50, cur.qty + delta));
    if (cur.qty) c.items[item.id] = cur; else delete c.items[item.id];
    this.set(Object.keys(c.items).length ? c : null);
  },
  qty(id) { return this.get()?.items[id]?.qty || 0; },
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden) session.set('cartAway', Date.now());
  else {
    const away = session.get('cartAway');
    if (away && Date.now() - away > S.cartIdleMin * 60_000) cart.set(null);
    session.set('cartAway', null);
  }
});

function renderBar() {
  const bar = $('#cartbar');
  const n = cart.count();
  const show = n > 0 && /^#\/s\//.test(location.hash);
  bar.classList.toggle('hide', !show);
  if (show) bar.innerHTML = `<span>${esc(t('store.viewCart', { n }))}</span><span>${esc(money(cart.total(), cart.get().currency))}</span>`;
}

/* ---------------- helpers ---------------- */
const catOf = (key) => S.cats.find((c) => c.key === key);
const catName = (c, many = true) => c?.names?.[getLang()]?.[many ? 'many' : 'one'] || c?.names?.ar?.[many ? 'many' : 'one'] || c?.key || '';
const isCraft = (kind) => catOf(kind)?.group === 'crafts';
const locQS = () => (S.loc ? `lat=${S.loc.lat}&lng=${S.loc.lng}&` : '');
const stopTimer = () => { clearInterval(S.timer); S.timer = null; };
function setNav(key) { $$('.nav [data-nav]').forEach((b) => b.classList.toggle('on', b.dataset.nav === key)); }

async function refreshMe() {
  try { S.me = await api('GET', '/api/customer/me'); } catch { S.me = null; }
  return S.me;
}

function ensureLogin() {
  if (S.me) return Promise.resolve(S.me);
  return new Promise((resolve) => {
    const sms = !!S.cfgCustomer?.smsVerification;
    const s = sheet(`
      <h2>${esc(t('login.title'))}</h2><p class="mute small">${esc(t('login.why'))}</p>
      <form id="lf">
        <label class="f">${esc(t('login.name'))}<input class="in" name="name" autocomplete="name" maxlength="60" required></label>
        <label class="f">${esc(t('login.phone'))}<input class="in" name="phone" type="tel" inputmode="tel" autocomplete="tel" required></label>
        <label class="check"><input type="checkbox" name="terms" required><span>${esc(t('login.accept'))} — <a href="#/legal/terms" data-close>${esc(t('me.terms'))}</a></span></label>
        <div id="codebox" class="hide"><label class="f">${esc(t('login.code'))}<input class="in" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label><p class="mute small">${esc(t('login.codeSent'))}</p></div>
        <button class="btn" type="submit">${esc(t('login.send'))}</button>
      </form>`);
    let codeStep = false;
    $('#lf', s.el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target, btn = $('button[type=submit]', f);
      const body = { name: f.name.value.trim(), phone: f.phone.value.trim(), country: S.country, locale: getLang(), acceptTerms: f.terms.checked };
      btn.disabled = true;
      try {
        if (sms && !codeStep) {
          const r = await api('POST', '/api/customer/code', { phone: body.phone, country: S.country });
          if (r.codeRequired) { codeStep = true; $('#codebox', s.el).classList.remove('hide'); btn.textContent = t('login.verify'); return; }
        }
        if (codeStep) body.code = f.code.value.trim();
        S.me = await api('POST', '/api/customer/login', body);
        s.close();
        resolve(S.me);
      } catch (err) { toast(errText(err)); } finally { btn.disabled = false; }
    });
  });
}

async function askLocation() {
  try {
    const p = await locate();
    S.loc = { lat: p.lat, lng: p.lng };
    session.set('loc', S.loc);
    return S.loc;
  } catch { toast(t('errors.location')); return null; }
}

function storeCard(s) {
  const c = catOf(s.kind);
  const icon = esc(c?.icon || '🏪');
  const delivery = s.ownDelivery ? `<span class="chip g">🛵 ${esc(t('store.ownDelivery'))}</span>` : s.delivery ? `<span class="chip g">🛵 ${esc(t('store.delivery'))}</span>`
    : isCraft(s.kind) ? `<span class="chip a">🏠 ${esc(t('store.comeToMe'))}</span>` : `<span class="chip">💬 ${esc(t('store.whatsappOnly'))}</span>`;
  return `<a class="store" href="#/s/${s.id}">
    <div class="cover">${s.photoUrl ? `<img src="${esc(s.photoUrl)}" alt="" loading="lazy">` : icon}
      <span class="badge${s.open ? '' : ' off'}">${esc(s.open ? t('common.open') : t('common.closed'))}</span>${s.pinned ? `<span class="badge pin">${esc(t('home.pinned'))}</span>` : ''}</div>
    <div class="srow"><div class="logo">${s.photoUrl ? `<img src="${esc(s.photoUrl)}" alt="">` : icon}</div><div>
      <div class="sname">${esc(s.name)}</div>
      <div class="chips">${s.distanceM != null ? `<span class="chip">📍 ${esc(fmtDist(s.distanceM))}</span>` : ''}${delivery}<span class="chip">${esc(catName(c, false))}</span>${s.booking ? `<span class="chip">📅</span>` : ''}</div>
    </div></div></a>`;
}

/* ---------------- views ---------------- */
async function viewHome(params = {}) {
  setNav(params.focus ? 'search' : 'home');
  const cat = params.cat || '';
  const shops = S.cats.filter((c) => c.group !== 'crafts' && c.home !== false && S.live.has(c.key));
  const crafts = S.cats.filter((c) => c.group === 'crafts' && S.live.has(c.key));
  main().innerHTML = `
    <div class="row"><button class="loc" id="locbtn">📍 <span><small>${esc(t('home.deliverTo'))}</small><br>${esc(S.loc ? (S.loc.label || t('cart.useCurrent')) : t('home.setLocation'))} ▾</span></button>
      <button class="iconbtn" id="langbtn" aria-label="${esc(t('me.language'))}">🌐</button></div>
    <div class="search"><span aria-hidden="true">🔍</span><input id="q" type="search" name="q_${Date.now()}" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="${esc(t('home.searchPh'))}" value="${esc(params.q || '')}" enterkeyhint="search"></div>
    <a class="card hl errand-cta" href="#/errand"><b>${esc(t('errand.cta'))}</b><span class="mute small">${esc(t('errand.ctaSub'))}</span></a>
    ${shops.length ? `<div class="cats">${[{ key: '', icon: '✨', names: { [getLang()]: { many: t('home.all') } } }, ...shops].map((c) => `<button class="cat${c.key === cat ? ' on' : ''}" data-cat="${esc(c.key)}"><span>${esc(c.icon || '🏷️')}</span>${esc(c.key ? catName(c) : t('home.all'))}</button>`).join('')}</div>` : ''}
    <div class="ads" id="ads"></div>
    ${crafts.length ? `<h2>${esc(t('home.crafts'))}</h2><div class="cats">${crafts.map((c) => `<button class="cat${c.key === cat ? ' on' : ''}" data-cat="${esc(c.key)}"><span>${esc(c.icon || '🛠️')}</span>${esc(catName(c))}</button>`).join('')}</div>` : ''}
    <h2 id="listTitle">${esc(params.q ? t('home.results') : t('home.nearby'))}</h2>
    <div id="list"><div class="skel cover"></div></div>`;
  $('#langbtn').onclick = langPicker;
  $('#locbtn').onclick = async () => { if (await askLocation()) viewHome(params); };
  $$('[data-cat]').forEach((b) => { b.onclick = () => { location.hash = b.dataset.cat ? `#/c/${b.dataset.cat}` : '#/'; }; });
  const q = $('#q');
  if (params.focus) q.focus();
  let deb;
  q.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => loadList(cat, q.value.trim()), 350); });
  loadAds();
  if (!S.loc && !params.q) {   // searching by name works without a location (every shop of the country)
    $('#list').innerHTML = `<div class="empty"><p>${esc(t('home.noLocation'))}</p><p class="small mute">${esc(t('home.searchAnywhere'))}</p><button class="btn" id="allow">${esc(t('home.allowLocation'))}</button></div>`;
    $('#allow').onclick = async () => { if (await askLocation()) viewHome(params); };
    return;
  }
  loadList(cat, params.q || '');
}
async function loadAds() {
  try {
    const { banners } = await api('GET', '/api/banners');
    const el = $('#ads');
    if (!el) return;
    el.innerHTML = banners.slice(0, 8).map((b) => `<a href="${esc(b.linkUrl || '#/')}" ${b.linkUrl && /^https?:/.test(b.linkUrl) ? 'target="_blank" rel="noopener"' : ''}><img src="${esc(b.imageUrl)}" alt="${esc(b.title)}" loading="lazy"></a>`).join('');
  } catch { /* ads are optional */ }
}
async function loadList(cat, q) {
  const list = $('#list');
  if (!list) return;
  $('#listTitle').textContent = q ? t('home.results') : t('home.nearby');
  try {
    const r = await api('GET', `/api/delivery/stores?${locQS()}country=${S.country}${cat ? `&category=${encodeURIComponent(cat)}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`);
    if (!r.stores.length) { list.innerHTML = `<div class="empty">${esc(t('home.noStores'))}</div>`; return; }
    if (cat || q) { list.innerHTML = r.stores.map(storeCard).join(''); return; }
    // home: one section per category — the 2 nearest, the rest behind "show more"
    const order = S.cats.map((c) => c.key);
    const groups = {};
    for (const st of r.stores) (groups[st.kind] ||= []).push(st);
    const keys = Object.keys(groups).sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999));
    list.innerHTML = keys.map((k) => {
      const c = catOf(k), g = groups[k];
      return `<section class="group"><div class="row"><h2>${esc(c?.icon || '🏪')} ${esc(catName(c) || k)}</h2><a class="small" href="#/c/${esc(k)}">${esc(t('home.all'))} (${g.length})</a></div>
        ${g.slice(0, 2).map(storeCard).join('')}
        ${g.length > 2 ? `<div class="more hide">${g.slice(2).map(storeCard).join('')}</div>
          <button class="btn alt moretg" aria-expanded="false">${esc(t('common.more'))} (${g.length - 2}) ▾</button>` : ''}</section>`;
    }).join('');
    $$('.moretg', list).forEach((b) => {
      const n = b.textContent.match(/\((\d+)\)/)?.[1];
      b.onclick = () => {
        const box = b.previousElementSibling, open = box.classList.toggle('hide') === false;
        b.setAttribute('aria-expanded', String(open));
        b.textContent = open ? `${t('common.less')} ▴` : `${t('common.more')} (${n}) ▾`;
      };
    });
  } catch (e) { list.innerHTML = `<div class="empty">${esc(errText(e))}</div>`; }
}

/** Products in the store's own sections (its order), then the ones without a section. */
function menuGroups(menu, order = []) {
  const map = new Map((order || []).map((n) => [n, []]));
  const rest = [];
  for (const m of menu) { if (m.section && map.has(m.section)) map.get(m.section).push(m); else if (m.section) { map.set(m.section, [m]); } else rest.push(m); }
  const out = [...map.entries()].filter(([, items]) => items.length).map(([name, items]) => ({ name, items }));
  if (rest.length) out.push({ name: out.length ? null : '', items: rest });
  return out;
}
async function viewStore(id) {
  setNav('home');
  main().innerHTML = `<div class="skel hero"></div>`;
  let r;
  try { r = await api('GET', `/api/delivery/stores/${id}?${locQS()}country=${S.country}`); } catch (e) { main().innerHTML = `<div class="empty">${esc(errText(e))}</div>`; return; }
  const s = r.store, c = catOf(s.kind), icon = esc(c?.icon || '🏪'), craft = isCraft(s.kind);
  const fav = S.me?.favorites?.includes(s.id);
  const canOrder = s.delivery;
  main().innerHTML = `
    <button class="iconbtn" id="back" aria-label="${esc(t('common.back'))}">${getLang() === 'ar' ? '→' : '←'}</button>
    ${s.photos?.length ? `<div class="slider" id="slider">${s.photos.map((u, i) => `<img src="${esc(u)}" alt="" ${i ? 'loading="lazy"' : ''}>`).join('')}</div>
      <div class="dots">${s.photos.map((_, i) => `<i class="${i ? '' : 'on'}"></i>`).join('')}</div>`
      : `<div class="hero">${s.photoUrl ? `<img src="${esc(s.photoUrl)}" alt="">` : icon}</div>`}
    <div class="shead"><div class="logo">${s.photoUrl ? `<img src="${esc(s.photoUrl)}" alt="">` : icon}</div>
      <button class="iconbtn" id="fav" aria-label="${esc(t(fav ? 'store.unfavorite' : 'store.favorite'))}">${fav ? '❤️' : '🤍'}</button></div>
    <h1>${esc(s.name)}</h1>
    <div class="chips">${s.distanceM != null ? `<span class="chip">📍 ${esc(fmtDist(s.distanceM))}</span>` : ''}<span class="chip ${s.open ? 'g' : ''}">${esc(s.open ? t('common.open') : t('common.closed'))}</span><span class="chip">${esc(catName(c, false))}</span>${s.specialty ? `<span class="chip">${esc(s.specialty)}</span>` : ''}</div>
    ${s.bio ? `<p class="mute small">${esc(s.bio)}</p>` : ''}
    <div class="grid2">
      ${s.whatsapp ? `<a class="btn" href="https://wa.me/${esc(s.whatsapp)}" target="_blank" rel="noopener">💬 ${esc(t('store.orderWhatsapp'))}</a>` : ''}
      ${s.lat != null && s.directions ? `<a class="btn alt" href="${esc(mapsLink(s.lat, s.lng))}" target="_blank" rel="noopener">🧭 ${esc(t('store.directions'))}</a>` : ''}
      ${s.booking ? `<button class="btn alt" id="book">📅 ${esc(t('store.book'))}</button>` : ''}
      ${craft ? `<button class="btn acc" id="visit">🏠 ${esc(t('store.comeToMe'))}</button>` : ''}
    </div>
    ${canOrder && !s.open ? `<div class="note">${esc(t('store.closedNote'))}</div>` : ''}
    ${canOrder ? `<p class="small mute">🛵 ${esc(t('pay.feeLine', { f: money(s.deliveryFee ?? 0) }))} · ${esc((s.payMethods || ['cash']).map((x) => t(`pay.${x}`)).join(' / '))}</p>` : ''}
    <h2>${esc(t('store.menu'))}</h2>
    <div id="menu">${r.menu.length ? menuGroups(r.menu, s.sections).map((g, gi) => `<section class="mgroup"><h3>${esc(g.name || t('menu.other'))} <small class="mute">(${g.items.length})</small></h3>
      ${g.items.map((m, i) => `<div class="item${i >= 2 ? ' more hide' : ''}" data-g="${gi}">${m.photo ? `<img class="pthumb" src="${esc(m.photo)}" alt="" loading="lazy">` : ''}<div class="txt"><b>${esc(m.name)}</b>${m.description ? `<p>${esc(m.description)}</p>` : ''}${m.price != null ? `<span class="price">${esc(money(m.price, m.currency))}</span>` : ''}</div>
        ${canOrder && m.price != null ? `<div data-q="${m.id}"></div>` : ''}</div>`).join('')}
      ${g.items.length > 2 ? `<button class="btn sm alt moreg" data-mg="${gi}">⌄ ${esc(t('menu.showAll', { n: g.items.length }))}</button>` : ''}</section>`).join('') : `<div class="empty">${esc(t('store.noMenu'))}</div>`}</div>`;
  $$('[data-mg]').forEach((b) => { b.onclick = () => { const open = b.dataset.open !== '1'; $$(`.item.more[data-g="${b.dataset.mg}"]`).forEach((x) => x.classList.toggle('hide', !open)); b.dataset.open = open ? '1' : ''; b.textContent = open ? `⌃ ${t('menu.showLess')}` : `⌄ ${t('menu.showAll', { n: $$(`.item[data-g="${b.dataset.mg}"]`).length })}`; }; });
  $('#back').onclick = () => history.length > 1 ? history.back() : (location.hash = '#/');
  applyAccent(main(), s.accent);
  const sl = $('#slider');
  if (sl) {
    const dots = $$('.dots i');
    sl.addEventListener('scroll', () => { const i = Math.round(Math.abs(sl.scrollLeft) / sl.clientWidth); dots.forEach((d, j) => d.classList.toggle('on', i === j)); }, { passive: true });
    let n = 0;
    S.slideTimer = setInterval(() => { if (!document.body.contains(sl)) return clearInterval(S.slideTimer); n = (n + 1) % dots.length; sl.scrollTo({ left: (getLang() === 'ar' ? -1 : 1) * n * sl.clientWidth, behavior: 'smooth' }); }, 4000);
  }
  $('#fav').onclick = async () => {
    await ensureLogin();
    try { await api('POST', `/api/customer/favorites/${s.id}`, { on: !S.me.favorites.includes(s.id) }); await refreshMe(); viewStore(id); } catch (e) { toast(errText(e)); }
  };
  $('#book')?.addEventListener('click', () => bookSheet(s));
  $('#visit')?.addEventListener('click', () => visitSheet(s));
  const drawQty = () => $$('[data-q]').forEach((el) => {
    const m = r.menu.find((x) => String(x.id) === el.dataset.q);
    const n = cart.qty(m.id);
    el.innerHTML = n ? `<div class="qty"><button data-d="-1" aria-label="-">−</button><b>${n}</b><button data-d="1" aria-label="+">+</button></div>` : `<button class="addbtn" data-d="1" aria-label="${esc(t('store.add'))}">+</button>`;
    el.onclick = (e) => { const b = e.target.closest('[data-d]'); if (!b) return; cart.add(s, m, Number(b.dataset.d)); drawQty(); };
  });
  drawQty();
  renderBar();
}

function bookSheet(s) {
  ensureLogin().then(() => {
    const sh = sheet(`<h2>${esc(t('appt.title'))}</h2><p class="mute">${esc(s.name)}</p><form id="bf">
      <label class="f">${esc(t('appt.service'))}<input class="in" name="service" required maxlength="100" placeholder="${esc(t('appt.servicePh'))}"></label>
      <label class="f">${esc(t('appt.date'))}<input class="in" name="when" type="datetime-local" required></label>
      <label class="f">${esc(t('appt.note'))}<textarea class="in" name="note" maxlength="300"></textarea></label>
      <button class="btn">${esc(t('appt.send'))}</button></form>`);
    $('#bf', sh.el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('POST', '/api/appointments', { storeId: s.id, service: f.service.value, startsAt: new Date(f.when.value).toISOString(), note: f.note.value });
        sh.close(); toast(t('appt.sent')); location.hash = '#/orders/appointments';
      } catch (err) { toast(errText(err)); }
    });
  });
}

function visitSheet(s) {
  ensureLogin().then(() => {
    const sh = sheet(`<h2>${esc(t('visit.title'))}</h2><p class="mute">${esc(s.name)}</p><form id="vf">
      <label class="f">${esc(t('visit.describe'))}<textarea class="in" name="d" required minlength="5" maxlength="500" placeholder="${esc(t('visit.describePh'))}"></textarea></label>
      <label class="f">${esc(t('cart.details'))}<input class="in" name="details" maxlength="300"></label>
      <p class="mute small">📍 ${esc(S.loc?.label || t('cart.useCurrent'))}</p>
      <button class="btn">${esc(t('visit.send'))}</button></form>`);
    $('#vf', sh.el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const loc = S.loc || await askLocation();
      if (!loc) return;
      try {
        await api('POST', '/api/visits', { craftId: s.id, description: f.d.value, details: f.details.value, lat: loc.lat, lng: loc.lng });
        sh.close(); toast(t('visit.sent')); location.hash = '#/orders/visits';
      } catch (err) { toast(errText(err)); }
    });
  });
}

async function viewCart() {
  setNav('home');
  const c = cart.get();
  if (!c) { main().innerHTML = `<h1>${esc(t('cart.title'))}</h1><div class="empty">${esc(t('cart.empty'))}</div><a class="btn" href="#/">${esc(t('common.home'))}</a>`; return; }
  const addrs = S.me?.addresses || [];
  let store = null;
  try { store = (await api('GET', `/api/delivery/stores/${c.storeId}?country=${S.country}`)).store; } catch { /* shown without the fee line */ }
  const fee = Number(store?.deliveryFee || 0);
  const methods = store?.payMethods || ['cash'];
  main().innerHTML = `
    <button class="iconbtn" id="back">${getLang() === 'ar' ? '→' : '←'}</button>
    <h1>${esc(t('cart.title'))}</h1><p class="mute">${esc(t('cart.from', { store: c.storeName }))}</p>
    <div class="card">${Object.values(c.items).map((i) => `<div class="row item"><div class="txt"><b>${esc(i.name)}</b><span class="mute small">${esc(money(i.price, c.currency))}</span></div>
      <div class="qty" data-id="${i.id}"><button data-d="-1">−</button><b>${i.qty}</b><button data-d="1">+</button></div></div>`).join('')}</div>
    <div class="card"><h3>📍 ${esc(t('cart.address'))}</h3>
      <label class="check"><input type="radio" name="addr" value="cur" checked><span>${esc(t('cart.useCurrent'))}</span></label>
      <label class="check"><input type="radio" name="addr" value="map"><span>📌 ${esc(t('map.pick'))}</span></label>
      ${addrs.map((a) => `<label class="check"><input type="radio" name="addr" value="${a.id}"><span>${esc(a.label)}${a.details ? ` — <span class="mute">${esc(a.details)}</span>` : ''}</span></label>`).join('')}
      <label class="f">${esc(t('cart.details'))}<input class="in" id="details" maxlength="300"></label></div>
    <div class="card"><h3>🕐 ${esc(t('cart.when'))}</h3>
      <label class="check"><input type="radio" name="when" value="now" checked><span>${esc(t('cart.now'))}</span></label>
      <label class="check"><input type="radio" name="when" value="later"><span>${esc(t('cart.schedule'))}</span></label>
      <input class="in hide" id="later" type="datetime-local">
      <label class="f">${esc(t('cart.note'))}<textarea class="in" id="note" maxlength="300"></textarea></label>
      </div>
    <div class="card"><h3>💳 ${esc(t('cart.payment'))}</h3>
      ${methods.map((mth, i) => `<label class="check"><input type="radio" name="pay" value="${mth}" ${i === 0 ? 'checked' : ''}><span>${mth === 'card' ? '💳' : '💵'} ${esc(t(`pay.${mth}Long`))}</span></label>`).join('')}</div>
    <div class="card"><div class="row"><span>${esc(t('pay.food'))}</span><b>${esc(money(cart.total(), c.currency))}</b></div>
      <div class="row"><span>${esc(t('pay.fee'))}</span><b>${esc(money(fee, c.currency))}</b></div>
      <div class="row"><h2>${esc(t('common.total'))}</h2><h2>${esc(money(Math.round((cart.total() + fee) * 100) / 100, c.currency))}</h2></div></div>
    <button class="btn" id="send">${esc(t('cart.send'))}</button>
    <div id="waBox"></div>
    <p class="mute tiny">${esc(t('cart.clearedNotice'))}</p>`;
  // also possible: send the same order to the store on WhatsApp (when the store has a number)
  api('GET', `/api/delivery/stores/${c.storeId}`).then(({ store }) => {
    if (!store?.whatsapp || !$('#waBox')) return;
    $('#waBox').innerHTML = `<button class="btn alt" id="sendWa">💬 ${esc(t('cart.sendWa'))}</button>`;
    $('#sendWa').onclick = () => {
      const lines = Object.values(c.items).map((i) => `• ${i.qty} × ${i.name} — ${money(i.price * i.qty, c.currency)}`);
      const text = [t('cart.waHello', { store: c.storeName }), ...lines, `${t('common.total')}: ${money(cart.total(), c.currency)}`, $('#details').value ? `📍 ${$('#details').value}` : '', $('#note').value ? `📝 ${$('#note').value}` : ''].filter(Boolean).join('\n');
      window.open(`https://wa.me/${store.whatsapp}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    };
  }).catch(() => {});
  $('#back').onclick = () => history.back();
  $$('.qty[data-id]').forEach((q) => { q.onclick = (e) => { const b = e.target.closest('[data-d]'); if (!b) return; const i = c.items[q.dataset.id]; cart.add({ id: c.storeId, name: c.storeName }, i, Number(b.dataset.d)); viewCart(); }; });
  $$('input[name=when]').forEach((r) => { r.onchange = () => $('#later').classList.toggle('hide', r.value !== 'later' || !r.checked); });
  $('#send').onclick = async () => {
    const btn = $('#send');
    await ensureLogin();
    const pick = $('input[name=addr]:checked').value;
    let loc;
    if (pick === 'cur') loc = (await askLocation()) || null;
    else if (pick === 'map') loc = (await pickOnMap(S.loc)) || null;
    else { const a = S.me.addresses.find((x) => String(x.id) === pick); loc = a && { lat: a.lat, lng: a.lng, details: a.details }; }
    if (!loc) return;
    const later = $('input[name=when]:checked').value === 'later' && $('#later').value;
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/orders', {
        storeId: c.storeId, items: Object.values(c.items).map((i) => ({ id: i.id, qty: i.qty })), lat: loc.lat, lng: loc.lng,
        details: $('#details').value || loc.details || '', note: $('#note').value, scheduledAt: later ? new Date(later).toISOString() : undefined,
        paymentMethod: $('input[name=pay]:checked')?.value || 'cash',
      });
      cart.set(null);
      if (r.payUrl) { location.href = r.payUrl; return; }   // card: the payment page, then back to the order
      location.hash = `#/o/${r.id}`;
      enablePush('customer');
    } catch (e) { toast(errText(e)); btn.disabled = false; }
  };
}

const STEPS = ['pending', 'preparing', 'searching', 'assigned', 'picked_up', 'delivered'];
async function viewTrack(id) {
  setNav('orders');
  const draw = async () => {
    let o;
    try { o = (await api('GET', `/api/customer/orders/${id}`)).order; } catch (e) { if (e.status === 401) { await ensureLogin(); return draw(); } main().innerHTML = `<div class="empty">${esc(errText(e))}</div>`; return; }
    if (location.hash !== `#/o/${id}`) return;
    const ended = ['rejected', 'cancelled', 'delivered'].includes(o.status);
    const idx = STEPS.indexOf(o.status);
    const steps = o.selfDelivery ? ['pending', 'preparing', 'picked_up', 'delivered'] : ['pending', 'preparing', 'assigned', 'picked_up', 'delivered'];
    main().innerHTML = `
      <h1>${esc(t('track.title', { id: o.ref || o.id }))}</h1><p class="mute">${esc(o.store)} — ${esc(fmtTime(o.createdAt))} · <button class="linkbtn" id="inv">🧾 ${esc(t('inv.title'))}</button></p>
      ${o.awaitingConfirm ? `<div class="card hl confirmc"><h3>📦 ${esc(t('track.confirmTitle'))}</h3><p class="small">${esc(t('track.confirmHint', { m: o.confirmAfterMin }))}</p>
        <button class="btn" id="confirmRx">✅ ${esc(t('track.confirmBtn'))}</button></div>` : ''}
      ${['assigned', 'picked_up', 'searching', 'preparing'].includes(o.status) && S.liveOn ? `<p class="note g small">${esc(t('track.liveLoc'))}</p>` : ''}
      <div class="card">${['rejected', 'cancelled'].includes(o.status) ? `<div class="note b">${esc(o.closeReason === 'out_of_area' ? t('track.outOfArea') : t(`status.${o.status}`))}</div>${o.closeReason === 'out_of_area' ? `<p class="small">${esc(t('track.outOfAreaHint'))}</p>` : ''}` : `<ul class="steps">${steps.map((st) => {
        const si = STEPS.indexOf(st);
        const cls = si < idx || o.status === 'delivered' ? 'done' : (si === idx || (st === 'assigned' && o.status === 'searching') || (st === 'preparing' && o.status === 'searching')) ? 'now' : '';
        const label = st === 'picked_up' && o.selfDelivery ? t('status.picked_up_self') : t(`status.${st === 'assigned' && o.status === 'searching' ? 'searching' : st}`);
        return `<li class="${cls}">${esc(label)}</li>`;
      }).join('')}</ul>`}
      ${o.driver ? `${driverHtml(o.driver, '/api/customer/driver-photo/', { distLabel: o.driver.toYouM != null ? t('cand.toYou', { d: fmtRoad(o.driver.toYouM, o.driver.approx) }) : '' })}<a class="btn sm alt" href="${esc(telLink(o.driver.phone))}">📞 ${esc(t('track.callDriver'))}</a>` : ''}</div>
      ${o.paymentStatus === 'pending' ? `<div class="note">${esc(t('pay.waiting'))}</div>` : ''}${o.paymentStatus === 'refund_pending' ? `<div class="note">${esc(t('pay.refundPending'))}</div>` : ''}${o.paymentStatus === 'refunded' ? `<div class="note g">↩️ ${esc(t('pay.refundedNote'))}</div>` : ''}
      <div class="card">${o.items.map((i) => `<div class="row"><span>${i.qty} × ${esc(i.name)}</span><b>${esc(money(i.qty * i.price, o.currency))}</b></div>`).join('')}
        ${o.deliveryFee != null ? `<div class="row"><span>${esc(t('pay.fee'))}</span><b>${esc(money(o.deliveryFee, o.currency))}</b></div>` : ''}
        <div class="row"><b>${esc(t('common.total'))}</b><b>${esc(money(o.customerTotal ?? o.total, o.currency))}</b></div>
        <p class="small"><span class="chip ${o.paymentMethod === 'card' ? 'g' : ''}">${o.paymentMethod === 'card' ? (['refunded', 'refund_pending'].includes(o.paymentStatus) ? `↩️ ${esc(t(o.paymentStatus === 'refunded' ? 'pay.refundedChip' : 'pay.refundChip'))}` : `💳 ${esc(t('pay.paidCard'))}`) : `💵 ${esc(t('pay.cashToDriver'))}`}</span></p></div>
      ${o.status === 'delivered' ? `<button class="btn alt" id="rate">⭐ ${esc(t('rate.title'))}</button>` : ''}
      ${o.status === 'pending' ? `<button class="btn bad" id="cancel">${esc(t('track.cancel'))}</button>` : ''}
      ${ended ? `<button class="btn alt" id="reorder">🔁 ${esc(t('track.reorder'))}</button>` : ''}
      <button class="btn alt" id="complain">⚠️ ${esc(t('track.complain'))}</button>`;
    $('#cancel')?.addEventListener('click', async () => { try { await api('POST', `/api/customer/orders/${id}/cancel`, {}); draw(); } catch (e) { toast(errText(e)); } });
    $('#reorder')?.addEventListener('click', () => {
      session.set('cart', { storeId: o.storeId, storeName: o.store, currency: o.currency, items: Object.fromEntries(o.items.filter((i) => i.id).map((i) => [i.id, { id: i.id, name: i.name, price: i.price, qty: i.qty }])) });
      location.hash = `#/s/${o.storeId}`;
    });
    $('#complain').onclick = () => complainSheet(o);
    $('#inv')?.addEventListener('click', () => invoiceSheet({ ref: o.ref, store: o.store, items: o.items, total: o.total, currency: o.currency, createdAt: o.createdAt, deliveryFee: o.deliveryFee, customerTotal: o.customerTotal, method: o.paymentMethod }));
    $('#rate')?.addEventListener('click', () => rateSheet(o));
    $('#confirmRx')?.addEventListener('click', async () => {
      try { await api('POST', `/api/customer/orders/${id}/confirm`, {}); toast(t('track.confirmed')); rateSheet(o, () => { location.hash = '#/orders'; }); } catch (e) { toast(errText(e)); }
    });
    // live location: while the order is on its way and this screen is open, the driver gets the customer's exact position
    if (['preparing', 'searching', 'assigned', 'picked_up'].includes(o.status)) startLive(id); else stopLive();
    if (ended && !o.awaitingConfirm) stopTimer();
  };
  stopTimer();
  await draw();
  S.timer = setInterval(draw, 8000);
}
function startLive(id) {
  if (S.liveId === id || !navigator.geolocation) return;
  stopLive();
  S.liveId = id; S.liveOn = true; S.liveSent = 0;
  S.liveWatch = navigator.geolocation.watchPosition((p) => {
    if (p.coords.accuracy > 60 || Date.now() - S.liveSent < 20000) return;
    S.liveSent = Date.now();
    api('POST', `/api/customer/orders/${id}/location`, { lat: p.coords.latitude, lng: p.coords.longitude }).catch(() => {});
  }, () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
}
function stopLive() { if (S.liveWatch != null) navigator.geolocation.clearWatch(S.liveWatch); S.liveWatch = null; S.liveId = null; S.liveOn = false; }

/** Stars + a note for the store (optional) — after receiving the order. */
function rateSheet(o, then) {
  let stars = 5;
  const sh = sheet(`<h2>⭐ ${esc(t('rate.title'))}</h2><p class="mute">${esc(o.store)}</p><div class="stars" id="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-st="${n}" aria-label="${n}">★</button>`).join('')}</div>
    <label class="f">${esc(t('rate.note'))}<textarea class="in" id="rnote" maxlength="500" placeholder="${esc(t('rate.notePh'))}"></textarea></label>
    <button class="btn" id="rsend">${esc(t('rate.send'))}</button><button class="btn alt" data-close>${esc(t('rate.later'))}</button>`, { onClose: () => then?.() });
  const paint = () => $$('[data-st]', sh.el).forEach((b) => b.classList.toggle('on', Number(b.dataset.st) <= stars));
  $$('[data-st]', sh.el).forEach((b) => { b.onclick = () => { stars = Number(b.dataset.st); paint(); }; });
  paint();
  $('#rsend', sh.el).onclick = async () => { try { await api('POST', `/api/customer/orders/${o.id}/rate`, { stars, note: $('#rnote', sh.el).value }); toast(t('rate.thanks')); sh.close(); } catch (e) { toast(errText(e)); } };
}
function complainSheet(o) {
  const sh = sheet(`<h2>${esc(t('track.complain'))}</h2><form id="cf">
    <label class="f">${esc(t('track.against'))}<select class="in" name="against"><option value="store">${esc(t('track.againstStore'))}</option>${o.driver ? `<option value="driver">${esc(t('track.againstDriver'))}</option>` : ''}</select></label>
    <label class="f"><textarea class="in" name="text" required minlength="5" maxlength="1000" placeholder="${esc(t('track.complainPh'))}"></textarea></label>
    <button class="btn">${esc(t('common.confirm'))}</button></form>`);
  $('#cf', sh.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/complaints', { orderId: o.id, against: e.target.against.value, text: e.target.text.value }); sh.close(); toast(t('common.sent')); } catch (err) { toast(errText(err)); }
  });
}

async function viewOrders(tab = 'orders') {
  setNav('orders');
  await ensureLogin();
  main().innerHTML = `<h1>${esc(t('orders.title'))}</h1>
    <div class="tabs">${['orders', 'errands', 'appointments', 'visits'].map((k) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${esc(t(`orders.tab${k[0].toUpperCase() + k.slice(1)}`))}</button>`).join('')}</div><div id="ol"></div>`;
  $$('[data-t]').forEach((b) => { b.onclick = () => { location.hash = `#/orders/${b.dataset.t}`; }; });
  const ol = $('#ol');
  try {
    if (tab === 'orders') {
      const { orders } = await api('GET', '/api/customer/orders');
      ol.innerHTML = orders.length ? `<div class="list">${orders.map((o) => `<a href="#/o/${o.id}"><span><b>${esc(o.store)}</b><br><small>#${o.id} — ${esc(t(`status.${o.status}`))}</small></span><b>${esc(money(o.total, o.currency))}</b></a>`).join('')}</div>` : `<div class="empty">${esc(t('orders.none'))}</div>`;
    } else if (tab === 'errands') {
      const { errands } = await api('GET', '/api/customer/errands');
      ol.innerHTML = errands.length ? `<div class="list">${errands.map((e) => `<a href="#/e/${e.id}"><span><b>${KIND_ICON[e.kind]} ${esc(t(`errand.kind_${e.kind}`))}</b><br><small>#${e.id} — ${esc(t(`errand.status_${e.status}`))}</small></span><b>${esc(money(e.price))}</b></a>`).join('')}</div>` : `<div class="empty">${esc(t('orders.none'))}</div>`;
    } else if (tab === 'appointments') {
      const { appointments } = await api('GET', '/api/customer/appointments');
      ol.innerHTML = appointments.length ? appointments.map((a) => `<div class="card"><div class="row"><b>${esc(a.store)}</b><span class="chip ${a.status === 'confirmed' ? 'g' : ['declined', 'cancelled'].includes(a.status) ? 'b' : ''}">${esc(t(`appt.${a.status}`))}</span></div>
        <p>📅 <b>${esc(fmtTime(a.starts_at))}</b><br>${esc(a.service)}</p>${a.note ? `<p class="mute small">📝 ${esc(a.note)}</p>` : ''}
        ${a.store_reply ? `<p class="note g small">💬 ${esc(t('appt.storeSays'))}: ${esc(a.store_reply)}</p>` : ''}
        ${a.cancelled_by ? `<p class="mute tiny">${esc(t(a.cancelled_by === 'store' ? 'appt.byStore' : 'appt.byYou'))}</p>` : ''}
        ${a.store_phone ? `<a class="btn sm alt" href="${esc(telLink(a.store_phone))}">📞 ${esc(t('common.call'))}</a>` : ''}
        <div class="grid2">${['pending', 'confirmed'].includes(a.status) ? `<button class="btn sm bad" data-ca="${a.id}" data-x="cancel">${esc(t('appt.cancel'))}</button>` : ''}<button class="btn sm alt" data-ca="${a.id}" data-x="hide">🗑 ${esc(t('appt.delete'))}</button></div></div>`).join('') : `<div class="empty">${esc(t('appt.none'))}</div>`;
      $$('[data-ca]').forEach((b) => { b.onclick = async () => {
        if (!confirm(t(b.dataset.x === 'cancel' ? 'appt.cancelQ' : 'appt.deleteQ'))) return;
        try { await api('POST', `/api/customer/appointments/${b.dataset.ca}/${b.dataset.x}`, {}); viewOrders('appointments'); } catch (e) { toast(errText(e)); }
      }; });
    } else {
      const { visits } = await api('GET', '/api/customer/visits');
      ol.innerHTML = visits.length ? visits.map((v) => `<div class="card"><div class="row"><b>${esc(v.craft)}</b><span class="chip ${v.status === 'accepted' ? 'g' : ''}">${esc(t(`visit.${v.status}`))}</span></div>
        <p class="mute">${esc(v.description)}</p>${v.phone ? `<a class="btn sm" href="${esc(telLink(v.phone))}">📞 ${esc(t('common.call'))}</a> ` : ''}${['pending', 'accepted'].includes(v.status) ? `<button class="btn sm bad" data-cv="${v.id}">${esc(t('common.cancel'))}</button>` : ''}</div>`).join('') : `<div class="empty">${esc(t('orders.none'))}</div>`;
      $$('[data-cv]').forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/customer/visits/${b.dataset.cv}/cancel`, {}); viewOrders('visits'); } catch (e) { toast(errText(e)); } }; });
    }
  } catch (e) { ol.innerHTML = `<div class="empty">${esc(errText(e))}</div>`; }
}

async function viewMe() {
  setNav('account');
  const me = S.me;
  const links = `
    <button class="li" id="lang">🌐 ${esc(t('me.language'))}<small>${esc({ ar: 'العربية', en: 'English', fr: 'Français', es: 'Español' }[getLang()])}</small></button>
    <a href="#/legal/terms">📄 ${esc(t('me.terms'))}</a><a href="#/legal/privacy">🔒 ${esc(t('me.privacy'))}</a><a href="#/legal/about">ℹ️ ${esc(t('me.about'))}</a>
    <a href="/store">🔑 ${esc(t('me.storeLogin'))}</a><a href="/driver">🔑 ${esc(t('me.driverLogin'))}</a>
    <a href="/join">🏪 ${esc(t('me.forStores'))}</a><a href="/driver#apply">🛵 ${esc(t('me.forDrivers'))}</a>`;
  if (!me) {
    main().innerHTML = `<h1>${esc(t('common.account'))}</h1><button class="btn" id="login">${esc(t('common.login'))}</button><div class="list">${links}</div>`;
    $('#login').onclick = () => ensureLogin().then(viewMe);
    $('#lang').onclick = langPicker;
    return;
  }
  const pushState = !pushSupported() ? 'unsupported' : Notification.permission;
  main().innerHTML = `
    <h1>${esc(me.name)}</h1><p class="mute">+${esc(me.phone)}</p>
    <div class="toggle"><div><b>🔔 ${esc(t('me.notifications'))}</b><div class="mute small">${esc(pushState === 'granted' ? t('me.notifDone') : pushState === 'denied' ? t('me.notifDenied') : pushState === 'unsupported' ? t('me.notifNo') : '')}</div></div>
      ${pushState === 'default' ? `<button class="btn sm" id="pushOn">${esc(t('me.notifOn'))}</button>` : ''}</div>
    ${me.warnings.count ? `<div class="note">${esc(t('common.warnings', { n: me.warnings.count, max: me.warnings.max }))}</div>` : ''}
    <h2>📍 ${esc(t('me.addresses'))}</h2>
    <div class="list">${me.addresses.map((a) => `<div class="row item"><span>${esc(a.label)}${a.details ? `<br><small class="mute">${esc(a.details)}</small>` : ''}</span><button class="btn sm alt" data-del="${a.id}">✕</button></div>`).join('')}</div>
    <button class="btn alt" id="addaddr">➕ ${esc(t('me.addAddress'))}</button>
    <h2>⭐ ${esc(t('me.favorites'))}</h2><div id="favs" class="list"></div>
    <div class="list">${links}
      <button class="li" id="logout">↩ ${esc(t('common.logout'))}</button>
      <button class="li" id="delacc">🗑 ${esc(t('me.deleteAccount'))}</button></div>`;
  $('#lang').onclick = langPicker;
  $('#pushOn')?.addEventListener('click', async () => { const r = await enablePush('customer'); toast(r === 'on' ? t('me.notifDone') : r === 'denied' ? t('me.notifDenied') : t('me.notifNo')); viewMe(); });
  $$('[data-del]').forEach((b) => { b.onclick = async () => { await api('DELETE', `/api/customer/addresses/${b.dataset.del}`).catch((e) => toast(errText(e))); await refreshMe(); viewMe(); }; });
  $('#addaddr').onclick = () => {
    const sh = sheet(`<h2>${esc(t('me.addAddress'))}</h2><form id="af"><label class="f">${esc(t('me.label'))}<input class="in" name="label" required maxlength="40" placeholder="${esc(t('me.labelPh'))}"></label>
      <label class="f">${esc(t('cart.details'))}<input class="in" name="details" maxlength="300"></label>
      <label class="check"><input type="radio" name="how" value="gps" checked><span>📍 ${esc(t('cart.useCurrent'))}</span></label>
      <label class="check"><input type="radio" name="how" value="map"><span>📌 ${esc(t('map.pick'))}</span></label>
      <button class="btn">${esc(t('common.save'))}</button></form>`);
    $('#af', sh.el).addEventListener('submit', async (e) => {
      e.preventDefault();
      const p = e.target.how.value === 'map' ? await pickOnMap(S.loc) : await askLocation();
      if (!p) return;
      try { await api('POST', '/api/customer/addresses', { label: e.target.label.value, details: e.target.details.value, lat: p.lat, lng: p.lng }); sh.close(); await refreshMe(); viewMe(); } catch (err) { toast(errText(err)); }
    });
  };
  $('#logout').onclick = async () => { await api('POST', '/api/customer/logout', {}).catch(() => {}); S.me = null; viewMe(); };
  $('#delacc').onclick = async () => { if (!confirm(t('me.deleteConfirm'))) return; await api('POST', '/api/customer/me/delete', {}).catch((e) => toast(errText(e))); S.me = null; location.hash = '#/'; };
  const favs = $('#favs');
  for (const id of me.favorites) {
    try { const { store } = await api('GET', `/api/delivery/stores/${id}`); favs.insertAdjacentHTML('beforeend', `<a href="#/s/${store.id}">${esc(store.name)}<small>›</small></a>`); } catch { /* hidden store */ }
  }
}

function viewLegal(key) {
  setNav('account');
  if (!['terms', 'privacy', 'about'].includes(key)) key = 'terms';
  main().innerHTML = `<button class="iconbtn" id="back">${getLang() === 'ar' ? '→' : '←'}</button><h1>${esc(t(`me.${key}`))}</h1><div class="legal">${esc(t(`legal.${key}`))}</div>`;
  $('#back').onclick = () => (history.length > 1 ? history.back() : (location.hash = '#/'));
}


/* ---------------- direct driver requests (errands) ---------------- */
const KIND_ICON = { deliver: '📦', buy: '🛍️', service: '🧾' };
/** Parse a Google Maps link: …@33.89,35.50… / ?q=33.89,35.50 / !3d33.89!4d35.50 */
function parseMapsLink(text) {
  const s = String(text || '');
  let m = /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/.exec(s) || /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(s) || /[?&](?:q|query|ll|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/.exec(s) || /^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/.exec(s);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}
function pickPlace() {
  return new Promise((resolve) => {
    const addrs = S.me?.addresses || [];
    const sh = sheet(`<h2>${esc(t('errand.pick'))}</h2><div class="list">
      <button class="li" data-p="cur">📍 ${esc(t('errand.pickCurrent'))}</button>
      <button class="li" data-p="map">📌 ${esc(t('map.pick'))}</button>
      ${addrs.map((a) => `<button class="li" data-a="${a.id}">🏠 ${esc(a.label)}</button>`).join('')}</div>
      <label class="f">🔎 ${esc(t('errand.pickSearch'))}<input class="in" id="ps" placeholder="${esc(t('errand.searchPh'))}"></label><div class="list" id="psr"></div>
      <label class="f">🔗 ${esc(t('errand.pickLink'))}<input class="in" id="pl" dir="ltr" placeholder="${esc(t('errand.linkPh'))}"></label>
      <button class="btn alt" id="plok">${esc(t('common.confirm'))}</button>`, { onClose: () => resolve(null) });
    const done = (v) => { resolve(v); sh.close(); };
    sh.el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-p],[data-a],[data-r]');
      if (!b) return;
      if (b.dataset.p === 'map') { const p = await pickOnMap(S.loc); if (p) done({ lat: p.lat, lng: p.lng, label: t('map.picked') }); }
      else if (b.dataset.p) { const p = await askLocation(); if (p) done({ lat: p.lat, lng: p.lng, label: t('errand.pickCurrent') }); }
      else if (b.dataset.a) { const a = addrs.find((x) => String(x.id) === b.dataset.a); done({ lat: a.lat, lng: a.lng, label: a.label, details: a.details }); }
      else { const [lat, lng, label] = b.dataset.r.split('|'); done({ lat: Number(lat), lng: Number(lng), label }); }
    });
    let deb;
    $('#ps', sh.el).addEventListener('input', (e) => {
      clearTimeout(deb);
      deb = setTimeout(async () => {
        const q = e.target.value.trim();
        if (q.length < 2) { $('#psr', sh.el).innerHTML = ''; return; }
        try {
          const { areas } = await api('GET', `/api/areas/search?q=${encodeURIComponent(q)}`);
          $('#psr', sh.el).innerHTML = areas.map((a) => `<button class="li" data-r="${a.lat}|${a.lng}|${esc(a.name)}">${esc(a.name)}<small>${esc(a.districtName || '')}</small></button>`).join('');
        } catch { /* ignore */ }
      }, 300);
    });
    $('#plok', sh.el).onclick = () => { const p = parseMapsLink($('#pl', sh.el).value); if (!p) return toast(t('errand.linkBad')); done({ ...p, label: '📍 ' + p.lat.toFixed(4) + ', ' + p.lng.toFixed(4) }); };
  });
}
const kmBetween = (a, b) => { const R = 6371, r = (x) => (x * Math.PI) / 180; const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng); const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

async function viewErrandNew() {
  setNav('home');
  await ensureLogin();
  const st = { kind: 'deliver', from: S.loc ? { ...S.loc, label: t('errand.pickCurrent') } : null, to: null };
  const draw = () => {
    const dist = st.from && st.to ? fmtDist(kmBetween(st.from, st.to) * 1000) : '';
    main().innerHTML = `<button class="iconbtn" id="back">${getLang() === 'ar' ? '→' : '←'}</button><h1>${esc(t('errand.title'))}</h1>
      <div class="stack">${['deliver', 'buy', 'service'].map((k) => `<label class="card check ${st.kind === k ? 'hl' : ''}"><input type="radio" name="kind" value="${k}" ${st.kind === k ? 'checked' : ''}><span><b>${KIND_ICON[k]} ${esc(t(`errand.kind_${k}`))}</b><br><small class="mute">${esc(t(`errand.kindHint_${k}`))}</small></span></label>`).join('')}</div>
      <div class="card"><div class="row"><b>${esc(t('errand.from'))}</b><button class="btn sm alt" id="pf">${esc(st.from?.label || t('errand.pick'))}</button></div>
        <input class="in" id="fd" maxlength="300" placeholder="${esc(t('errand.details'))}" value="${esc(st.fromDetails || st.from?.details || '')}">
        <div class="row"><b>${esc(t('errand.to'))}</b><button class="btn sm alt" id="pt">${esc(st.to?.label || t('errand.pick'))}</button></div>
        <input class="in" id="td" maxlength="300" placeholder="${esc(t('errand.details'))}" value="${esc(st.toDetails || st.to?.details || '')}">
        ${dist ? `<p class="small">📏 ${esc(t('errand.distance', { d: dist }))}</p>` : ''}</div>
      <label class="f">${esc(t('errand.what'))}<textarea class="in" id="desc" maxlength="500" placeholder="${esc(t('errand.whatPh'))}">${esc(st.desc || '')}</textarea></label>
      ${st.kind === 'buy' ? `<label class="f">${esc(t('errand.purchase'))} <span class="mute small">(${esc(t('errand.purchaseMax', { m: money(S.maxPurchase || 50) }))})</span><input class="in" id="pv" type="number" min="0" max="${S.maxPurchase || 50}" step="0.5" inputmode="decimal" value="${esc(st.pv || '')}"></label>` : ''}
      <label class="f">${esc(t('errand.price'))}<input class="in" id="price" type="number" min="1" step="0.5" inputmode="decimal" value="${esc(st.price || '')}"></label>
      <div class="note">${esc(t('errand.notice'))}</div>
      <button class="btn" id="go">${esc(t('errand.send'))}</button>`;
    const keep = () => { st.fromDetails = $('#fd').value; st.toDetails = $('#td').value; st.desc = $('#desc').value; st.price = $('#price').value; st.pv = $('#pv')?.value; };
    $('#back').onclick = () => history.back();
    $$('input[name=kind]').forEach((r) => { r.onchange = () => { keep(); st.kind = r.value; draw(); }; });
    $('#pf').onclick = async () => { keep(); const p = await pickPlace(); if (p) { st.from = p; draw(); } };
    $('#pt').onclick = async () => { keep(); const p = await pickPlace(); if (p) { st.to = p; draw(); } };
    $('#go').onclick = async () => {
      keep();
      if (!st.from || !st.to) return toast(t('errand.pick'));
      const btn = $('#go'); btn.disabled = true;
      try {
        const r = await api('POST', '/api/errands', {
          kind: st.kind, description: st.desc, price: Number(st.price), purchaseValue: st.kind === 'buy' && st.pv !== '' ? Number(st.pv) : undefined,
          from: { lat: st.from.lat, lng: st.from.lng, details: st.fromDetails }, to: { lat: st.to.lat, lng: st.to.lng, details: st.toDetails },
        });
        location.hash = `#/e/${r.id}`;
      } catch (e) { toast(errText(e)); btn.disabled = false; }
    };
  };
  draw();
}

async function viewErrand(id) {
  setNav('orders');
  let lastCount = -1;
  const draw = async () => {
    let e;
    try { e = (await api('GET', `/api/customer/errands/${id}`)).errand; } catch (x) { if (x.status === 401) { await ensureLogin(); return draw(); } main().innerHTML = `<div class="empty">${esc(errText(x))}</div>`; return; }
    if (location.hash !== `#/e/${id}`) return;
    if (document.activeElement?.id === 'msg' && e.messages.length === lastCount) return;   // don't redraw while typing
    lastCount = e.messages.length;
    const typed = $('#msg')?.value || '';
    const ended = ['delivered', 'cancelled'].includes(e.status);
    main().innerHTML = `<h1>${KIND_ICON[e.kind]} ${esc(t(`errand.kind_${e.kind}`))} #${e.id}</h1>
      <div class="card"><p>${esc(e.description)}</p>
        <p class="small">📍 ${esc(t('errand.from'))}: ${esc(e.from.details || '')} — ${esc(t('errand.to'))}: ${esc(e.to.details || '')} · ${esc(fmtDist(e.distanceM))}</p>
        <div class="row"><span>${esc(t('errand.price'))}</span><b>${esc(money(e.price))}</b></div>
        ${e.purchaseValue != null ? `<div class="row"><span>${esc(t('errand.purchase'))}</span><b>${esc(money(e.purchaseValue))}</b></div>` : ''}</div>
      <div class="card"><b>${esc(t(`errand.status_${e.status}`))}</b>
        ${e.status === 'searching' ? `<p class="small">${esc(e.driversNotified ? t('errand.searching', { n: e.driversNotified }) : t('errand.noDrivers'))}</p>${candidatesHtml(e.candidates, '/api/customer/driver-photo/')}
          ${e.canRaise || !e.driversNotified ? `<div class="row"><input class="in" id="np" type="number" step="0.5" value="${Number(e.price) + 1}"><button class="btn sm acc" id="raise">${esc(t('errand.raise'))}</button></div>` : ''}` : ''}
        ${e.driver ? `${driverHtml(e.driver, '/api/customer/driver-photo/', { distLabel: e.driver.awayM != null ? t(e.driver.toStart ? 'cand.toStart' : 'cand.toYou', { d: fmtRoad(e.driver.awayM, e.driver.approx) }) : '' })}
          <div class="grid2"><a class="btn alt" href="${esc(telLink(e.driver.phone))}">📞 ${esc(t('common.call'))}</a><a class="btn alt" href="https://wa.me/${esc(e.driver.phone)}" target="_blank" rel="noopener">🟢 ${esc(t('common.whatsapp'))}</a></div>` : ''}</div>
      ${e.driver ? `<h2>💬 ${esc(t('errand.chat'))}</h2><div class="card chat">${e.messages.map((m) => `<p class="${m.from_type === 'customer' ? 'me' : ''}"><b>${esc(m.from_type === 'customer' ? t('errand.you') : t('errand.driverW'))}:</b> ${esc(m.body)}</p>`).join('')}</div>
        ${ended ? '' : `<div class="row"><input class="in" id="msg" maxlength="1000" placeholder="${esc(t('errand.chatPh'))}" value="${esc(typed)}"><button class="btn sm" id="sendm">${esc(t('errand.sendMsg'))}</button></div>`}` : ''}
      <div class="note">${esc(t('errand.notice'))}</div>
      ${['searching', 'assigned'].includes(e.status) ? `<button class="btn bad" id="cx">${esc(t('errand.cancel'))}</button>` : ''}
      ${['delivered', 'cancelled'].includes(e.status) ? `<button class="btn" id="ehide">✅ ${esc(t('errand.confirmBtn'))}</button>` : ''}
      ${e.driver ? `<button class="btn alt" id="cmp">⚠️ ${esc(t('errand.complain'))}</button>` : ''}`;
    $('#raise')?.addEventListener('click', async () => { try { await api('POST', `/api/customer/errands/${id}/raise`, { price: Number($('#np').value) }); draw(); } catch (x) { toast(errText(x)); } });
    $('#ehide')?.addEventListener('click', async () => { try { await api('POST', `/api/customer/errands/${id}/confirm`, {}); location.hash = '#/orders/errands'; } catch (x) { toast(errText(x)); } });
    $('#cx')?.addEventListener('click', async () => { try { await api('POST', `/api/customer/errands/${id}/cancel`, {}); draw(); } catch (x) { toast(errText(x)); } });
    const send = async () => { const v = $('#msg').value.trim(); if (!v) return; try { await api('POST', `/api/errands/${id}/messages`, { body: v }); $('#msg').value = ''; lastCount = -1; $('#msg').blur(); draw(); } catch (x) { toast(errText(x)); } };
    $('#sendm')?.addEventListener('click', send);
    $('#msg')?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') send(); });
    $('#cmp')?.addEventListener('click', () => {
      const sh = sheet(`<h2>${esc(t('errand.complain'))}</h2><form id="cf"><textarea class="in" name="text" required minlength="5" maxlength="1000" placeholder="${esc(t('track.complainPh'))}"></textarea><button class="btn">${esc(t('common.confirm'))}</button></form>`);
      $('#cf', sh.el).addEventListener('submit', async (ev) => { ev.preventDefault(); try { await api('POST', '/api/complaints', { errandId: id, against: 'driver', text: ev.target.text.value }); sh.close(); toast(t('common.sent')); } catch (x) { toast(errText(x)); } });
    });
    if (ended) stopTimer();
  };
  stopTimer();
  await draw();
  S.timer = setInterval(draw, 5000);
}

/* ---------------- my favourite stores: one tap to order again, remove any ---------------- */
async function viewFavs() {
  setNav('favs');
  main().innerHTML = `<h1>❤️ ${esc(t('favs.title'))}</h1><div id="fl"><div class="skel cover"></div></div>`;
  await refreshMe();
  const box = $('#fl');
  if (!box) return;
  if (!S.me) { box.innerHTML = `<div class="empty">${esc(t('favs.login'))}</div><button class="btn" id="favLogin">${esc(t('common.login'))}</button>`; $('#favLogin').onclick = () => ensureLogin().then(viewFavs); return; }
  const ids = S.me.favorites || [];
  if (!ids.length) { box.innerHTML = `<div class="empty">${esc(t('favs.none'))}</div><a class="btn" href="#/">${esc(t('common.home'))}</a>`; return; }
  const loc = S.loc ? `?lat=${S.loc.lat}&lng=${S.loc.lng}` : '';
  const cards = [];
  for (const id of ids) {
    try { const { store } = await api('GET', `/api/delivery/stores/${id}${loc}`); cards.push(`<div class="favwrap">${storeCard(store)}<button class="btn sm bad" data-unfav="${store.id}">🗑 ${esc(t('favs.remove'))}</button></div>`); } catch { /* hidden or closed store */ }
  }
  box.innerHTML = cards.join('') || `<div class="empty">${esc(t('favs.none'))}</div>`;
  $$('[data-unfav]', box).forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/customer/favorites/${b.dataset.unfav}`, { on: false }); viewFavs(); } catch (e) { toast(errText(e)); } }; });
}

/* ---------------- router ---------------- */
function route() {
  stopTimer();
  clearInterval(S.slideTimer);
  if (!/^#\/o\//.test(location.hash)) stopLive();
  if (main()) applyAccent(main(), null);
  window.scrollTo(0, 0);
  const h = location.hash || '#/';
  let m;
  if ((m = /^#\/s\/(\d+)/.exec(h))) viewStore(Number(m[1]));
  else if ((m = /^#\/c\/([a-z0-9_]+)/.exec(h))) viewHome({ cat: m[1] });
  else if (h === '#/search') viewHome({ focus: true });
  else if (h === '#/cart') viewCart();
  else if (h === '#/errand') viewErrandNew();
  else if ((m = /^#\/e\/(\d+)/.exec(h))) viewErrand(Number(m[1]));
  else if ((m = /^#\/o\/(\d+)/.exec(h))) viewTrack(Number(m[1]));
  else if ((m = /^#\/orders(?:\/(\w+))?/.exec(h))) viewOrders(m[1] || 'orders');
  else if (h === '#/me') viewMe();
  else if (h === '#/favs') viewFavs();
  else if ((m = /^#\/legal\/(\w+)/.exec(h))) viewLegal(m[1]);
  else viewHome();
  renderBar();
}

async function boot() {
  registerSW();
  await initI18n();
  // Old addresses keep working: /c/12 → store 12; /terms, /privacy, /about → legal pages.
  const p = location.pathname;
  const old = /^\/c\/(\d+)/.exec(p);
  if (old) history.replaceState(null, '', `/#/s/${old[1]}`);
  else if (/^\/(terms|privacy|about)$/.test(p)) history.replaceState(null, '', `/#/legal/${p.slice(1)}`);
  else if (p === '/delete-account') history.replaceState(null, '', '/#/me');
  else if (p !== '/') history.replaceState(null, '', '/' + location.hash);
  document.body.insertAdjacentHTML('beforeend', `
    <button class="bar hide" id="cartbar"></button>
    <nav class="nav">
      <a href="#/" data-nav="home"><i>🏠</i>${esc(t('common.home'))}</a>
      <a href="#/search" data-nav="search"><i>🔍</i>${esc(t('common.search'))}</a>
      <a href="#/favs" data-nav="favs"><i>❤️</i>${esc(t('favs.nav'))}</a>
      <a href="#/orders" data-nav="orders"><i>🧾</i>${esc(t('common.orders'))}</a>
      <a href="#/me" data-nav="account"><i>👤</i>${esc(t('common.account'))}</a>
    </nav>`);
  $('#cartbar').onclick = () => { location.hash = '#/cart'; };
  S.cfg = getConfig() || { site: { categories: [] }, liveKinds: [] };
  S.country = getCountry();
  S.cats = S.cfg.site?.categories || [];
  S.live = new Set(S.cfg.liveKinds || []);
  try { S.cfgCustomer = await api('GET', '/api/customer/config'); S.cartIdleMin = S.cfgCustomer.cartIdleMin || 30; S.maxPurchase = S.cfgCustomer.maxPurchaseValue || 50; } catch { /* defaults */ }
  document.title = S.cfg.brand?.name || document.title;
  await refreshMe();
  if (S.me) refreshPush('customer');
  window.addEventListener('hashchange', route);
  route();
}
boot();
