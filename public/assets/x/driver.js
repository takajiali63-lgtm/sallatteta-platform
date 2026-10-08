// Aklatak v7 — driver app. While "available", the GPS position is sent every 15 s and the screen stays on.
// (A browser/PWA can't track in the background; the native driver app will — see docs/DRIVER-APP.md.)
import { initI18n, t, esc, $, $$, api, sheet, errText, toast, fmtDist, money, mapsLink, telLink, shrinkImage, beep, langPicker, registerSW, openWithdraw, detectCountry, enablePush, refreshPush, pushSupported, fmtTime, copyText, fmtRoad } from './core.js';

const ICON = { deliver: '📦', buy: '🛍️', service: '🧾' };
const DOCS = ['selfie', 'idFront', 'idBack', 'vehicleFront', 'vehicleBack', 'registration', 'criminalRecord'];
const S = { me: null, watch: null, lastSent: 0, pos: null, poll: null, wake: null, seen: new Set() };
const main = () => $('#main');

function loginView() {
  stopWork();
  main().innerHTML = `<div class="row"><h1>${esc(t('driver.loginTitle'))}</h1><button class="iconbtn" id="lang">🌐</button></div>
    <form id="lf" class="card"><label class="f">${esc(t('driver.phone'))}<input class="in" name="phone" type="tel" inputmode="tel" required autocomplete="username"></label>
    <label class="f">${esc(t('merchant.password'))}<input class="in" name="pw" type="password" required autocomplete="current-password"></label>
    <button class="btn">${esc(t('common.login'))}</button></form><button class="btn alt" id="apply">🛵 ${esc(t('driver.apply'))}</button>`;
  $('#lang').onclick = langPicker;
  $('#apply').onclick = applyView;
  $('#lf').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('POST', '/api/driver/login', { phone: e.target.phone.value, password: e.target.pw.value, country: await detectCountry() }); boot2(); } catch (x) { toast(errText(x)); }
  });
}

async function applyView() {
  const docs = {};
  let plans = {};
  try { plans = (await api('GET', '/api/plans')).driverJobs || {}; } catch { /* optional */ }
  main().innerHTML = `<h1>${esc(t('driver.apply'))}</h1><form id="af">
    <label class="f">${esc(t('driver.fullName'))}<input class="in" name="fullName" required minlength="3" maxlength="80"></label>
    <label class="f">${esc(t('driver.phone'))}<input class="in" name="phone" type="tel" inputmode="tel" required></label>
    <label class="f">${esc(t('driver.password'))}<input class="in" name="password" type="password" minlength="5" required autocomplete="new-password"></label>
    <label class="f">${esc(t('driver.vehicle'))}<select class="in" name="vehicle"><option value="moto">${esc(t('driver.moto'))}</option><option value="car">${esc(t('driver.car'))}</option></select></label>
    <label class="f">${esc(t('driver.plate'))}<input class="in" name="plate" required maxlength="20"></label>
    <label class="f">${esc(t('driver.walletProvider'))}<select class="in" name="walletProvider"><option value="whish">${esc(t('driver.whish'))}</option><option value="omt">${esc(t('driver.omt'))}</option></select></label>
    <label class="f">${esc(t('driver.walletNumber'))}<input class="in" name="walletNumber" type="tel" inputmode="tel" required></label>
    <label class="f">${esc(t('driver.birthDate'))}<input class="in" name="birthDate" type="date" required max="${new Date(Date.now() - 18 * 365.25 * 864e5).toISOString().slice(0, 10)}"></label>
    <h2>${esc(t('driver.docs'))}</h2>
    ${DOCS.map((k) => `<div class="row item"><span>${esc(t(`driver.doc_${k}`))}</span><label class="btn sm alt" id="lb_${k}">${esc(t('driver.pick'))}<input type="file" accept="image/*" class="hide" data-doc="${k}"></label></div>`).join('')}
    <h2>${esc(t('driver.safetyTitle'))}</h2><div class="card legal small">${esc(t('driver.safety'))}</div>
    <div class="card"><h3>📦 ${esc(t('driver.jobsTitle'))}</h3><p class="mute small">${esc(t('driver.jobsHint'))}</p>
      <label class="check"><input type="radio" name="jobs" value="" checked><span>${esc(t('driver.jobsNone'))}</span></label>
      ${Object.entries(plans).map(([m, price]) => `<label class="check"><input type="radio" name="jobs" value="${esc(m)}"><span>${esc(t('driver.months', { n: m }))} — <b>${esc(money(price))}</b></span></label>`).join('')}</div>
    <label class="check"><input type="checkbox" name="adult" required><span>${esc(t('driver.adult'))}</span></label>
    <label class="check"><input type="checkbox" name="terms" required><span>${esc(t('driver.acceptSafety'))} — <a href="/#/legal/terms" target="_blank">${esc(t('me.terms'))}</a> · <a href="/#/legal/privacy" target="_blank">${esc(t('me.privacy'))}</a></span></label>
    <button class="btn" id="sub">${esc(t('driver.submit'))}</button></form><button class="btn alt" id="have">${esc(t('driver.haveAccount'))}</button>`;
  $('#have').onclick = loginView;
  $$('[data-doc]').forEach((inp) => {
    inp.onchange = async () => {
      const k = inp.dataset.doc;
      try { docs[k] = await shrinkImage(inp.files[0]); $(`#lb_${k}`).firstChild.textContent = t('driver.docDone'); $(`#lb_${k}`).classList.remove('alt'); } catch { toast(t('errors.validation_failed')); }
    };
  });
  $('#af').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const missing = DOCS.filter((k) => !docs[k]);
    if (missing.length) return toast(`${t('driver.docs')}: ${missing.map((k) => t(`driver.doc_${k}`)).join('، ')}`);
    const btn = $('#sub');
    btn.disabled = true;
    try {
      await api('POST', '/api/driver/apply', {
        fullName: f.fullName.value, phone: f.phone.value, password: f.password.value, vehicle: f.vehicle.value, plate: f.plate.value,
        walletProvider: f.walletProvider.value, walletNumber: f.walletNumber.value, acceptTerms: f.terms.checked, adult: f.adult.checked, birthDate: f.birthDate.value,
        jobsMonths: f.jobs.value ? Number(f.jobs.value) : null, docs, country: await detectCountry(),
      });
      await api('POST', '/api/driver/login', { phone: f.phone.value, password: f.password.value, country: await detectCountry() });
      boot2();
    } catch (x) { toast(errText(x)); btn.disabled = false; }
  });
}

/* ---------- working: GPS + screen awake + polling ---------- */
async function keepAwake() { try { S.wake = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ } }
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.me?.available) keepAwake(); });
function startWork() {
  if (!navigator.geolocation) return toast(t('errors.location'));
  keepAwake();
  S.watch ??= navigator.geolocation.watchPosition(async (p) => {
    S.pos = { lat: p.coords.latitude, lng: p.coords.longitude };
    if (Date.now() - S.lastSent > 15_000) { S.lastSent = Date.now(); api('POST', '/api/driver/location', S.pos).catch(() => {}); }
  }, () => toast(t('errors.location')), { enableHighAccuracy: true, maximumAge: 10_000 });
}
function stopWork() {
  if (S.watch != null) navigator.geolocation.clearWatch(S.watch);
  S.watch = null;
  S.wake?.release?.().catch(() => {}); S.wake = null;
  clearInterval(S.poll); S.poll = null;
}

// The driver's page: everything in its own section — work, my deliveries, my balance, reports, my account.
const TABS = [['work', '🛵'], ['deliveries', '🧾'], ['wallet', '💵'], ['report', '📊'], ['account', '👤']];
async function home(tab = S.tab || 'work') {
  S.tab = tab;
  let me;
  try { me = await api('GET', '/api/driver/me'); } catch (e) { return e.status === 401 ? loginView() : toast(errText(e)); }
  S.me = me;
  clearInterval(S.poll); S.poll = null;
  if (me.status !== 'active') {
    stopWork();
    main().innerHTML = `<h1>${esc(me.name)}</h1><div class="note ${me.status === 'suspended' ? 'b' : ''}">${esc(me.status === 'suspended' ? t('driver.suspendedMsg') : t('driver.pendingMsg'))}</div>
      ${me.warnings.count ? `<div class="card">${me.warnings.items.map((w) => `<p>⚠️ ${esc(w.reason)}</p>`).join('')}</div>` : ''}<button class="btn alt" id="out">${esc(t('common.logout'))}</button>`;
    $('#out').onclick = logout;
    return;
  }
  main().innerHTML = `
    <div class="dhead"><img class="dface" src="/api/driver/photo" alt="" data-face><div><h1>${esc(me.name)}</h1><span class="mute small">${esc(t(`driver.${me.vehicle}`))} · ${esc(me.plate || '')}</span></div>
      <span class="chip ${me.available ? 'g' : ''}">${esc(me.available ? t('driver.available') : t('driver.unavailable'))}</span></div>
    <div class="tabs dtabs">${TABS.map(([k, i]) => `<button data-dt="${k}" class="${k === tab ? 'on' : ''}">${i} ${esc(t(`dtab.${k}`))}</button>`).join('')}</div>
    <div id="pane"></div>`;
  $$('[data-dt]').forEach((b) => { b.onclick = () => home(b.dataset.dt); });
  if (me.available) startWork();
  ({ work: tabWork, deliveries: deliveriesView, wallet: tabWallet, report, account: tabAccount }[tab] || tabWork)();
}
const pane = () => $('#pane');

async function tabWork() {
  const me = S.me;
  pane().innerHTML = `
    <div class="toggle"><div><b>${esc(me.available ? t('driver.available') : t('driver.unavailable'))}</b><div class="mute small">${esc(t('driver.availableHint'))}</div></div><button class="sw${me.available ? ' on' : ''}" id="sw" aria-label="${esc(t('driver.available'))}"></button></div>
    ${me.available ? `<div class="note">📲 ${esc(t('driver.keepOpen'))}</div>` : ''}
    ${me.warnings.count ? `<div class="note b">${esc(t('common.warnings', { n: me.warnings.count, max: me.warnings.max }))}</div>` : ''}
    <div id="bc"></div>
    ${pushSupported() && Notification.permission === 'default' ? `<button class="btn alt" id="pushOn">🔔 ${esc(t('me.notifOn'))}</button>` : ''}
    <div id="cashlim"></div>
    <div id="work"></div>`;
  api('GET', '/api/driver/finance').then(({ finance: f }) => { const el = $('#cashlim'); if (el && !f.cashOrders) el.innerHTML = `<div class="note b">💵 ${esc(t('dmoney.limitReached'))}</div>`; }).catch(() => {});
  $('#pushOn')?.addEventListener('click', async () => { const r = await enablePush('driver'); toast(r === 'on' ? t('me.notifDone') : r === 'denied' ? t('me.notifDenied') : t('me.notifNo')); home('work'); });
  refreshPush('driver');
  api('GET', '/api/driver/broadcasts').then(({ broadcasts }) => { const el = $('#bc'); if (el && broadcasts.length) el.innerHTML = `<div class="card warnc"><h3>📢 ${esc(t('driver.messages'))}</h3>${broadcasts.map((b) => `<p class="legal">${esc(b.body)}</p>`).join('<hr>')}</div>`; }).catch(() => {});
  $('#sw').onclick = async () => {
    try {
      if (!me.available) {
        const p = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition((x) => res({ lat: x.coords.latitude, lng: x.coords.longitude }), rej, { enableHighAccuracy: true, timeout: 15000 }));
        await api('POST', '/api/driver/availability', { available: true, ...p });
        S.lastSent = Date.now();
      } else { await api('POST', '/api/driver/availability', { available: false }); stopWork(); }
      home('work');
    } catch (x) { toast(x?.code ? errText(x) : t('errors.location')); }
  };
  await work();
  S.poll = setInterval(work, 5000);
}

// My money: delivery earnings, the restaurants' cash I hold (limit 200 $), settle it, withdraw my own account.
// Settle ONLINE (Whish / OMT / card): the system makes a payment page with the exact amount → confirmed automatically.
// Or by hand: transfer, then send the transfer number (+ receipt) → the owner checks.
const wayName = (w) => (w.key === 'card' ? t('dmoney.payCard') : w.label);
async function tabWallet() {
  let f, settlements, code, myNumber, ways = [], linkMin = 30;
  try { ({ finance: f, settlements, code, myNumber, ways = [], linkMin = 30 } = await api('GET', '/api/driver/finance')); } catch (x) { return toast(errText(x)); }
  const me = S.me;
  const online = ways.filter((w) => w.online), manual = ways.filter((w) => w.manual);
  const label = (k) => { const w = ways.find((x) => x.key === k); return w ? wayName(w) : k === 'omt' ? 'OMT' : k === 'whish' ? 'Whish' : k; };
  const pct = Math.min(100, Math.round((f.exposure / (f.cashLimit || 200)) * 100));
  const stChip = (st) => (st === 'verified' ? 'g' : st === 'pending' || st === 'awaiting_payment' ? 'w' : 'b');
  pane().innerHTML = `<div class="grid2">
      <div class="stat"><b>${esc(money(f.earnings))}</b><span>${esc(t('dmoney.earnings'))}</span></div>
      <div class="stat"><b>${esc(money(f.restaurantCash))}</b><span>${esc(t('dmoney.cashHold'))}</span></div></div>
    <div class="card"><div class="row"><b>${esc(t('dmoney.limit', { l: money(f.cashLimit) }))}</b><span>${esc(t('dmoney.remaining', { r: money(f.remaining) }))}</span></div>
      <div class="meter"><i class="${pct >= 100 ? 'full' : pct >= 80 ? 'warn' : ''}" data-w="${pct}"></i></div>
      <div class="chips"><span class="chip ${f.cashOrders ? 'g' : 'b'}">💵 ${esc(t(f.cashOrders ? 'dmoney.cashOn' : 'dmoney.cashOff'))}</span><span class="chip g">💳 ${esc(t('dmoney.cardOn'))}</span></div>
      ${f.cashOrders ? '' : `<p class="note small">${esc(t('dmoney.limitReached'))}</p>`}
      ${f.pendingInSettlement ? `<p class="note small">⏳ ${esc(t('dmoney.pendingSettle', { t: money(f.pendingInSettlement) }))}</p>` : ''}</div>
    <h2>🏪 ${esc(t('dmoney.owed'))}</h2>
    <div class="list">${f.owed.map((x) => `<label class="row item check"><input type="checkbox" data-st="${x.storeId}" data-amt="${x.amount}" checked><span>${esc(x.store)} <small class="mute">(${x.orders})</small></span><b>${esc(money(x.amount))}</b></label>`).join('') || `<div class="empty">${esc(t('dmoney.nothingOwed'))}</div>`}</div>
    ${f.owed.length && online.length ? `<div class="card hl" id="payNow"><h3>⚡ ${esc(t('dmoney.payNowTitle'))}</h3>
      <div class="row"><span>${esc(t('dmoney.amountAuto'))}</span><b class="big" data-samt></b></div>
      <p class="small">${esc(t('dmoney.payNowHint'))}</p>
      <div class="paybtns">${online.map((w) => `<button class="btn ${w.key === 'card' ? 'alt' : ''}" data-pay="${esc(w.key)}">${w.key === 'card' ? '💳' : '📲'} ${esc(t('dmoney.payWith', { w: wayName(w) }))}</button>`).join('')}</div>
      <p class="mute tiny">${esc(t('dmoney.payNowRules', { m: linkMin }))}</p></div>` : ''}
    ${f.owed.length && manual.length ? `<details class="card" id="manualBox" ${online.length ? '' : 'open'}><summary><b>🧾 ${esc(t(online.length ? 'dmoney.manualTitle' : 'dmoney.settleTitle'))}</b></summary><form id="sf">
      <div class="row"><span>${esc(t('dmoney.amountAuto'))}</span><b data-samt></b></div>
      <label class="f">${esc(t('merchant.method'))}<select class="in" name="method">${manual.map((w) => `<option value="${esc(w.key)}">${esc(wayName(w))}</option>`).join('')}</select></label>
      <p class="small" id="sendTo"></p>
      <div class="note small">✍️ ${esc(t('dmoney.writeCode'))} <b dir="ltr">${esc(code)}</b> <button type="button" class="btn sm alt" data-copy="${esc(code)}">${esc(t('common.copy'))}</button></div>
      <label class="f">${esc(t('dmoney.reference'))}<input class="in" name="ref" required minlength="3" maxlength="80" placeholder="WH-938273"></label>
      <label class="f">${esc(t('dmoney.sender'))}<input class="in" name="sender" type="tel" inputmode="tel" dir="ltr" value="${esc(myNumber ? `+${myNumber}` : '')}"></label>
      <p class="mute tiny">${esc(t('dmoney.senderHint'))}</p>
      <label class="f">${esc(t('merchant.receipt'))} <small class="mute">(${esc(t('dmoney.receiptWhen'))})</small><input class="in" name="file" type="file" accept="image/*"></label>
      <button class="btn">${esc(t('dmoney.settleSend'))}</button><p class="mute tiny">${esc(t('dmoney.settleHow'))}</p></form></details>` : ''}
    ${f.owed.length && !ways.length ? `<div class="note">${esc(t('dmoney.noWays'))}</div>` : ''}
    <h2>🧾 ${esc(t('dmoney.settlements'))}</h2>
    <div class="list">${settlements.map((x) => `<div class="row item"><span>${esc(x.ref)} · ${esc(label(x.method))}${x.gateway ? ' · ⚡' : ` · ${esc(x.reference)}`}<br><small class="mute">${esc(fmtTime(x.created_at))}${x.note && !x.gateway ? ` — ${esc(x.note)}` : ''}</small></span>
      <span><b>${esc(money(x.amount))}</b><br><span class="chip ${stChip(x.status)}">${esc(t(`dmoney.s_${x.status}`))}</span></span></div>`).join('') || `<div class="empty">—</div>`}</div>
    <h2>💸 ${esc(t('dmoney.myAccount'))}</h2>
    <div class="stat"><b>${esc(money(f.withdrawable))}</b><span>${esc(t('dmoney.withdrawable'))}</span></div>
    <button class="btn ${f.withdrawable >= me.payoutThreshold ? 'acc' : 'alt'}" id="wd">💸 ${esc(t('wd.button'))}</button>
    <p class="mute tiny">${esc(t('driver.payoutNote', { t: money(me.payoutThreshold) }))}</p>
    <h2>${esc(t('dtab.withdrawals'))}</h2><div id="wl" class="list"><div class="skel cover"></div></div>`;
  for (const m of $$('.meter i', pane())) m.style.width = `${m.dataset.w}%`;   // CSSOM (inline styles are not allowed)
  const picked = () => $$('[data-st]:checked', pane()).map((c) => Number(c.dataset.st));
  const sum = () => { const v = $$('[data-st]:checked', pane()).reduce((a, c) => a + Math.round(Number(c.dataset.amt) * 100), 0) / 100; $$('[data-samt]', pane()).forEach((el) => { el.textContent = money(v); }); return v; };
  $$('[data-st]', pane()).forEach((c) => { c.onchange = sum; });
  sum();
  const showTo = () => {
    const el = $('#sendTo'); if (!el) return;
    const w = manual.find((x) => x.key === $('#sf').method.value);
    el.innerHTML = w ? `${esc(t('dmoney.sendTo'))} <b dir="ltr">${esc(w.account)}</b>${w.name ? ` (${esc(w.name)})` : ''} <button type="button" class="btn sm alt" data-copy="${esc(w.account)}">${esc(t('common.copy'))}</button>` : '';
  };
  $('#sf')?.method.addEventListener('change', showTo);
  showTo();
  $$('[data-pay]', pane()).forEach((b) => { b.onclick = async () => {
    const ids = picked();
    if (!ids.length) return toast(t('dmoney.pickStore'));
    b.disabled = true;
    try {
      const r = await api('POST', '/api/driver/settlements/online', { gateway: b.dataset.pay, storeIds: ids.length === f.owed.length ? undefined : ids });
      location.href = r.url;   // the provider's page — the amount there is fixed
    } catch (x) { b.disabled = false; toast(errText(x)); }
  }; });
  let receipt = null;
  $('#sf input[name=file]')?.addEventListener('change', async (e) => { try { receipt = await shrinkImage(e.target.files[0]); } catch { receipt = null; } });
  $('#sf')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ids = picked();
    if (!ids.length) return toast(t('dmoney.pickStore'));
    const all = ids.length === f.owed.length;
    try {
      const r = await api('POST', '/api/driver/settlements', { amount: sum(), method: e.target.method.value, reference: e.target.ref.value, senderNumber: e.target.sender.value || undefined, receipt: receipt || undefined, storeIds: all ? undefined : ids });
      toast(t('dmoney.settleSent', { r: r.ref })); home('wallet');
    } catch (x) { toast(errText(x)); }
  });
  $('#wd').onclick = () => openWithdraw('driver', () => home('wallet'));
  try {
    const { withdrawals } = await api('GET', '/api/driver/withdrawals');
    $('#wl').innerHTML = withdrawals.length ? withdrawals.map((w) => `<div class="row item"><span>${esc(w.provider === 'omt' ? 'OMT' : 'Whish')} · +${esc(w.number)}<br><small class="mute">${esc(fmtTime(w.created_at))}</small></span>
      <span><b>${esc(money(w.amount))}</b><br><span class="chip ${w.status === 'paid' ? 'g' : w.status === 'rejected' ? 'b' : 'w'}">${esc(t(`wd.${w.status}`))}</span></span></div>`).join('') : `<div class="empty">${esc(t('dtab.noWithdrawals'))}</div>`;
  } catch { /* ignore */ }
}

// Back from the payment page (/driver?settle=ID): wait a few seconds for the provider's confirmation, then show the result.
async function settleReturn(id) {
  window.history.replaceState(null, '', '/driver');
  const sh = sheet(`<h2>⏳ ${esc(t('dmoney.checking'))}</h2><p class="mute small">${esc(t('dmoney.checkingHint'))}</p>`);
  let st = null;
  for (let i = 0; i < 8; i += 1) {
    try { st = (await api('GET', `/api/driver/settlements/${id}`)).settlement; } catch { break; }
    if (st && st.status !== 'awaiting_payment') break;
    await new Promise((r) => setTimeout(r, 2500));
  }
  sh.close();
  const key = !st ? 'dmoney.r_unknown' : st.status === 'verified' ? 'dmoney.r_verified' : st.status === 'awaiting_payment' ? 'dmoney.r_waiting' : st.status === 'correction' ? 'dmoney.r_mismatch' : 'dmoney.r_failed';
  sheet(`<h2>${esc(t(key, { r: st ? `S-${st.id}` : '' }))}</h2>${st ? `<p class="big">${esc(money(st.amount))}</p>` : ''}<button class="btn" data-close>${esc(t('common.confirm'))}</button>`);
  home('wallet');
}

function tabAccount() {
  const me = S.me;
  pane().innerHTML = `<div class="card"><h3>👤 ${esc(t('dtab.myInfo'))}</h3>
      <div class="row item"><span>${esc(t('driver.phone'))}</span><b dir="ltr">+${esc(me.phone)}</b></div>
      <div class="row item"><span>${esc(t('driver.vehicle'))}</span><b>${esc(t(`driver.${me.vehicle}`))} · ${esc(me.plate || '')}</b></div>
      <div class="row item"><span>${esc(t('driver.walletNumber'))}</span><b dir="ltr">${esc(me.wallet.provider === 'omt' ? 'OMT' : 'Whish')} +${esc(me.wallet.number || '')}</b></div>
      <p class="mute tiny">📁 ${esc(t('dtab.docsKept'))}</p></div>
    <div class="card ${me.jobs.active ? '' : 'warnc'}"><h3>📦 ${esc(t('driver.jobsTitle'))}</h3><p class="small">${esc(me.jobs.active ? t('errand.jobsActive', { d: new Date(me.jobs.until).toLocaleDateString() }) : t('errand.jobsInactive', { p: money(me.jobs.price) }))}</p><p class="mute tiny">${esc(t('dtab.jobsHow'))}</p></div>
    <div class="card"><h3>🦺 ${esc(t('driver.safetyTitle'))}</h3><p class="legal small">${esc(t('driver.safety'))}</p></div>
    <div class="list">
      ${pushSupported() ? `<button class="li" id="pushOn">🔔 ${esc(t('me.notifOn'))}</button>` : ''}
      <button class="li" id="lang">🌐 ${esc(t('dtab.language'))}</button>
      <a href="/#/legal/terms">📄 ${esc(t('me.terms'))}</a><a href="/#/legal/privacy">🔒 ${esc(t('me.privacy'))}</a>
      <button class="li" id="out">↩ ${esc(t('common.logout'))}</button></div>`;
  $('#lang').onclick = langPicker;
  $('#out').onclick = logout;
  $('#pushOn')?.addEventListener('click', async () => { const r = await enablePush('driver'); toast(r === 'on' ? t('me.notifDone') : r === 'denied' ? t('me.notifDenied') : t('me.notifNo')); });
}

async function work() {
  const box = $('#work');
  if (!box) return;
  try {
    const { orders, errand } = await api('GET', '/api/driver/current');
    if (errand) {
      if (document.activeElement?.id === 'dmsg' && errand.messages.length === S.msgCount) return;
      S.msgCount = errand.messages.length;
      const typed = $('#dmsg')?.value || '';
      const e = errand;
      box.innerHTML = `<div class="card hl errandc"><div class="row"><b>${ICON[e.kind]} ${esc(t('errand.offer'))}: ${esc(t(`errand.kind_${e.kind}`))} #${e.id}</b><span class="big">${esc(money(e.fee))}</span></div>
        <p>${esc(e.description)}</p>${e.purchaseValue != null ? `<p class="small">🛍️ ${esc(t('errand.purchaseD'))}: <b>${esc(money(e.purchaseValue))}</b></p>` : ''}
        <p class="small">📍 ${esc(t('errand.from'))}: ${esc(e.from.details || '')}<br>🏁 ${esc(t('errand.to'))}: ${esc(e.to.details || '')} · ${esc(fmtDist(e.totalM))}</p>
        <div class="grid2"><a class="btn alt" href="${esc(mapsLink(e.from.lat, e.from.lng))}" target="_blank" rel="noopener">🧭 ${esc(t('errand.openFrom'))}</a><a class="btn alt" href="${esc(mapsLink(e.to.lat, e.to.lng))}" target="_blank" rel="noopener">🏁 ${esc(t('errand.openTo'))}</a></div>
        <p>👤 ${esc(e.customer.name)}</p>
        <div class="grid2"><a class="btn alt" href="${esc(telLink(e.customer.phone))}">📞 ${esc(t('driver.callCustomer'))}</a><a class="btn alt" href="https://wa.me/${esc(e.customer.phone)}" target="_blank" rel="noopener">🟢 ${esc(t('common.whatsapp'))}</a></div>
        <h3>💬 ${esc(t('errand.chat'))}</h3><div class="chat">${e.messages.map((m) => `<p class="${m.from_type === 'driver' ? 'me' : ''}"><b>${esc(m.from_type === 'driver' ? t('errand.you') : t('errand.customerW'))}:</b> ${esc(m.body)}</p>`).join('')}</div>
        <div class="row"><input class="in" id="dmsg" maxlength="1000" placeholder="${esc(t('errand.chatPh'))}" value="${esc(typed)}"><button class="btn sm" id="dsend">${esc(t('errand.sendMsg'))}</button></div>
        <div class="note">${esc(t('errand.agree'))}</div>
        ${e.status === 'assigned' ? `<button class="btn" data-eo="picked" data-id="${e.id}">📦 ${esc(t('driver.picked'))}</button>` : ''}
        <button class="btn acc" data-eo="delivered" data-id="${e.id}">✅ ${esc(t('driver.delivered'))}</button></div>`;
      const send = async () => { const v = $('#dmsg').value.trim(); if (!v) return; try { await api('POST', `/api/errands/${e.id}/messages`, { body: v }); $('#dmsg').value = ''; $('#dmsg').blur(); S.msgCount = -1; work(); } catch (x) { toast(errText(x)); } };
      $('#dsend').onclick = send;
      $('#dmsg').onkeydown = (ev) => { if (ev.key === 'Enter') send(); };
      return;
    }
    if (orders && orders.length) {
      box.innerHTML = orders.map((order) => `<div class="card hl"><div class="row"><b>✅ ${esc(t('driver.yourOrder'))} ${esc(order.ref)}</b><span class="big">${esc(money(order.fee))}</span></div>
        <p>🏪 <b>${esc(order.store.name)}</b> ${order.store.area ? `<span class="mute small">— ${esc(order.store.area)}</span>` : ''}</p>
        <div class="grid2"><a class="btn alt" href="${esc(mapsLink(order.store.lat, order.store.lng))}" target="_blank" rel="noopener">🧭 ${esc(t('driver.openStore'))}</a>${order.store.phone ? `<a class="btn alt" href="${esc(telLink(order.store.phone))}">📞 ${esc(t('driver.callStore'))}</a>` : ''}</div>
        ${order.customer ? `<p>👤 ${esc(order.customer.name)}${order.customer.details ? ` — <span class="small">${esc(order.customer.details)}</span>` : ''}</p>
          <p class="mute tiny">📍 ${esc(t('driver.customerPlace'))}</p>
          <div class="grid2"><a class="btn" href="${esc(mapsLink(order.customer.lat, order.customer.lng))}" target="_blank" rel="noopener">🧭 ${esc(t('driver.openCustomer'))}</a><a class="btn alt" href="${esc(telLink(order.customer.phone))}">📞 ${esc(t('driver.callCustomer'))}</a></div>`
          : `<div class="note">⏳ ${esc(t('driver.waitingLocation'))}</div>`}
        ${order.legacy ? `<div class="note small">💵 ${esc(t('driver.payStore', { t: money(order.total, order.currency), n: '+' + order.store.payTo, ref: order.ref }))} <button class="btn sm alt" data-copy="${esc(order.ref)}">${esc(t('common.copy'))}</button></div>`
          : order.paymentMethod === 'card' ? `<div class="moneyline card-pay"><span class="paybadge">💳 ${esc(t('dmoney.paidCard'))}</span><b>${esc(t('dmoney.collectNothing'))}</b></div>`
          : `<div class="moneyline cash-pay"><span class="paybadge">💵 ${esc(t('dmoney.collect'))}</span><b>${esc(money(order.collect, order.currency))}</b></div>
             <p class="small">${esc(t('dmoney.split', { f: money(order.total, order.currency), d: money(order.fee, order.currency) }))}</p>`}
        ${order.bonus ? `<p class="small">🎁 ${esc(t('dmoney.bonus', { b: money(order.bonus) }))}</p>` : ''}
        ${order.status === 'assigned' ? `<button class="btn" data-o="picked" data-id="${order.id}">📦 ${esc(t('driver.picked'))}</button>` : ''}
        <button class="btn acc" data-o="delivered" data-id="${order.id}">✅ ${esc(t('driver.delivered'))}</button>
        <p class="mute tiny">🔔 ${esc(t('driver.remindCustomer'))}</p></div>`).join('');
    } else if (S.me?.available) {
      const { offers } = await api('GET', '/api/driver/offers');
      if (offers.some((o) => o.state === 'open' && !S.seen.has(o.type + o.id))) beep();
      offers.forEach((o) => S.seen.add(o.type + o.id));
      box.innerHTML = offers.length ? offers.map((o) => o.type === 'errand' ? `<div class="card hl errandc"><div class="row"><b>${ICON[o.kind]} ${esc(t('errand.offer'))}: ${esc(t(`errand.kind_${o.kind}`))}</b></div>
        <p>${esc(o.description)}</p>
        <div class="row"><span>📍 ${esc(t('errand.fromStart'))}</span><b>${esc(fmtRoad(o.toStartM, o.approx))}</b></div>
        <div class="row"><span>📏 ${esc(t('errand.total'))}</span><b>${esc(fmtDist(o.totalM))}</b></div>
        ${o.purchaseValue != null ? `<div class="row"><span>🛍️ ${esc(t('errand.purchaseD'))}</span><b>${esc(money(o.purchaseValue))}</b></div>` : ''}
        <div class="row"><span>💵 ${esc(t('errand.yourFee'))}</span><span class="big">${esc(money(o.fee))}</span></div>
        <div class="note">${esc(t('errand.agree'))}</div>
        ${offerActions(o, 'ef')}</div>`
        : `<div class="card hl ${o.state === 'reserved' ? 'reserved' : ''}"><div class="row"><b>🏪 ${esc(t('errand.storeOrder'))} ${esc(o.ref || '')}</b></div>${o.addon ? `<p class="chip a">${esc(t('driver.addonTag'))}</p>` : ''}<p>🏪 ${esc(o.store)}</p>
        <div class="row"><span>📍 ${esc(t('driver.toStore'))}</span><b>${esc(fmtRoad(o.toStoreM, o.approx))}</b></div>
        <div class="row"><span>🏠 ${esc(t('driver.toCustomer'))}</span><b>${esc(fmtDist(o.storeToCustomerM))}</b></div>
        <div class="row"><span>💵 ${esc(t('driver.fee'))}</span><span class="big">${esc(money(o.fee))}</span></div>
        ${o.paymentMethod ? (o.paymentMethod === 'card' ? `<div class="moneyline card-pay"><span class="paybadge">💳 ${esc(t('dmoney.paidCard'))}</span><b>${esc(t('dmoney.collectNothing'))}</b></div>` : `<div class="moneyline cash-pay"><span class="paybadge">💵 ${esc(t('dmoney.collect'))}</span><b>${esc(money(o.collect))}</b></div>`) : ''}
        ${offerActions(o, 'f')}</div>`).join('')
        : `<div class="empty">${esc(t('driver.noOffers'))}</div>`;
    } else box.innerHTML = '';
  } catch (e) { if (e.status === 401) loginView(); else if (e.status === 403) home('work'); }
}
function offerActions(o, attr) {
  if (o.state === 'reserved') return `<div class="note b">🔒 ${esc(t('driver.reserved'))}</div>`;
  if (o.state === 'waiting') return `<div class="note g">⏳ ${esc(t('driver.waiting'))}</div>`;
  return `<div class="grid2"><button class="btn" data-${attr}="accept" data-id="${o.id}">${esc(t('driver.accept'))}</button><button class="btn alt" data-${attr}="decline" data-id="${o.id}">${esc(t('driver.decline'))}</button></div>`;
}
document.addEventListener('click', (e) => { const c = e.target.closest('[data-copy]'); if (c) copyText(c.dataset.copy); });

async function deliveriesView() {
  pane().innerHTML = `<div id="hl"><div class="skel cover"></div></div>`;
  const draw = async () => {
    const { orders } = await api('GET', '/api/driver/history');
    $('#hl').innerHTML = orders.length ? orders.map((o) => `<div class="card"><div class="row"><b>${esc(o.ref)}</b><span class="mute small">${esc(fmtTime(o.deliveredAt))}</span></div>
      <p>🏪 ${esc(o.store.name)} · ${esc(money(o.total, o.currency))}</p>
      ${o.legacy ? `<div class="chips"><span class="chip ${o.storePaid ? 'g' : 'w'}">${esc(o.storePaid ? t('driver.paidStore') : t('driver.owes'))}</span>
        <span class="chip ${o.feeState === 'paid' ? 'g' : o.feeState === 'refunded' ? 'b' : ''}">${esc(o.feeState === 'paid' ? t('driver.feePaid') : o.feeState === 'refunded' ? t('driver.feeRefunded') : t('driver.feePending'))} · ${esc(money(o.fee))}</span></div>
      ${o.storePaid ? '' : `<p class="small">💵 ${esc(t('driver.payStore', { t: money(o.total, o.currency), n: '+' + o.store.payTo, ref: o.ref }))}</p>`}`
      : `<div class="chips"><span class="chip ${o.paymentMethod === 'card' ? 'g' : 'w'}">${o.paymentMethod === 'card' ? '💳' : '💵'} ${esc(t(o.paymentMethod === 'card' ? 'pay.card' : 'pay.cash'))}</span>
        <span class="chip">${esc(t('dmoney.yourFee'))} ${esc(money(o.fee))}</span>
        ${o.paymentMethod === 'cash' ? `<span class="chip ${o.cashStatus === 'settled' ? 'g' : 'w'}">${esc(t(`money.st_${o.cashStatus || (o.financialStatus === 'completed' ? 'open' : 'waiting')}`))}</span>` : ''}</div>`}
      <button class="btn sm alt" data-scmp="${o.id}">⚠️ ${esc(t('dmoney.complainStore'))}</button>
      <div class="grid2"><a class="btn alt" href="${esc(mapsLink(o.store.lat, o.store.lng))}" target="_blank" rel="noopener">🧭 ${esc(t('driver.storePlace'))}</a><button class="btn bad" data-hide="${o.id}">${esc(t('driver.hide'))}</button></div></div>`).join('')
      : `<div class="empty">${esc(t('driver.noDeliveries'))}</div>`;
    $$('[data-hide]').forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/driver/history/${b.dataset.hide}/hide`, {}); draw(); } catch (x) { toast(errText(x)); } }; });
    $$('[data-scmp]').forEach((b) => { b.onclick = () => {
      const sh = sheet(`<h2>⚠️ ${esc(t('dmoney.complainStore'))}</h2><form id="cf"><textarea class="in" name="text" required minlength="5" maxlength="1000" placeholder="${esc(t('track.complainPh'))}"></textarea><button class="btn">${esc(t('common.confirm'))}</button></form>`);
      $('#cf', sh.el).addEventListener('submit', async (e) => { e.preventDefault(); try { await api('POST', '/api/complaints', { orderId: Number(b.dataset.scmp), against: 'store', text: e.target.text.value }); sh.close(); toast(t('common.sent')); } catch (x) { toast(errText(x)); } });
    }; });
  };
  try { await draw(); } catch (x) { toast(errText(x)); }
}

document.addEventListener('click', async (e) => {
  const f = e.target.closest('[data-f]'), o = e.target.closest('[data-o]'), ef = e.target.closest('[data-ef]'), eo = e.target.closest('[data-eo]');
  if (!f && !o && !ef && !eo) return;
  const b = f || o || ef || eo;
  b.disabled = true;
  try {
    if (f) await api('POST', `/api/driver/offers/${f.dataset.id}/${f.dataset.f}`, {});
    else if (o) await api('POST', `/api/driver/orders/${o.dataset.id}/${o.dataset.o}`, {});
    else if (ef) await api('POST', `/api/driver/errand-offers/${ef.dataset.id}/${ef.dataset.ef}`, {});
    else await api('POST', `/api/driver/errands/${eo.dataset.id}/${eo.dataset.eo}`, {});
    if (o?.dataset.o === 'delivered' || eo?.dataset.eo === 'delivered') return home('work');
    work();
  } catch (x) { toast(errText(x)); work(); }
});

async function report(period = 'month') {
  pane().innerHTML = `<div class="tabs">${['today', 'week', 'month'].map((p) => `<button data-p="${p}" class="${p === period ? 'on' : ''}">${esc(t(`merchant.${p}`))}</button>`).join('')}</div><div id="rep"></div>`;
  $$('[data-p]').forEach((b) => { b.onclick = () => report(b.dataset.p); });
  try {
    const { report: r } = await api('GET', `/api/driver/report?period=${period}`);
    $('#rep').innerHTML = `<div class="grid2"><div class="stat"><b>${r.deliveries}</b><span>${esc(t('driver.rDeliveries'))}</span></div><div class="stat"><b>${r.km} ${esc(t('common.km'))}</b><span>${esc(t('driver.rKm'))}</span></div>
      <div class="stat"><b>${esc(money(r.earnings))}</b><span>${esc(t('driver.rEarnings'))}</span></div><div class="stat"><b>${esc(money(r.paid))}</b><span>${esc(t('driver.rPaid'))}</span></div></div>
      <div class="stat"><b>${r.errands}</b><span>${esc(t('errand.tab'))}</span></div>
      ${r.topStores.length ? `<h2>${esc(t('driver.rTop'))}</h2><div class="list">${r.topStores.map((s) => `<div class="row item"><span>${esc(s.name)}</span><b>${s.deliveries}</b></div>`).join('')}</div>` : ''}
      <button class="btn alt noprint" id="print">${esc(t('merchant.print'))}</button>`;
    $('#print').onclick = () => window.print();
  } catch (e) { toast(errText(e)); }
}

async function logout() { S.tab = 'work'; stopWork(); await api('POST', '/api/driver/logout', {}).catch(() => {}); loginView(); }
function boot2() {
  if (location.hash === '#apply') { window.history.replaceState(null, '', '/driver'); return applyView(); }
  const back = new URLSearchParams(location.search).get('settle');
  if (/^\d+$/.test(back || '')) { S.tab = 'wallet'; return settleReturn(Number(back)); }
  home('work');
}
(async () => { registerSW(); await initI18n(); boot2(); })();
