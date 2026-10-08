// Aklatak v7 — store dashboard (restaurants, cafés, shops, clinics, craftspeople).
import { initI18n, t, esc, $, $$, api, errText, toast, sheet, fmtDist, money, fmtTime, beep, shrinkImage, mapsLink, telLink, langPicker, registerSW, getLang, openWithdraw, enablePush, refreshPush, pushSupported, parseMapsLink, locate, copyText, candidatesHtml, driverHtml, fmtRoad, invoiceSheet, pickOnMap } from './core.js';

const S = { me: null, wallet: null, tab: 'orders', timer: null, seen: new Set(), cats: [], byId: new Map() };
const invBtn = (o) => `<button class="btn sm alt" data-inv="${o.id}">🧾 ${esc(t('inv.title'))}</button>`;
// the bill of any order on screen (orders and records)
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-inv]');
  const o = b && S.byId.get(Number(b.dataset.inv));
  if (o) invoiceSheet({ ref: o.ref, store: S.me?.name, customer: `${o.customer.name} · +${o.customer.phone}`, items: o.items, total: o.total, currency: o.currency, createdAt: o.createdAt, note: o.note });
});
const main = () => $('#main');
const err = (e) => toast(e?.code === 'invalid_cook_credentials' ? t('errors.invalid_credentials') : errText(e));
const isCraft = () => S.cats.find((c) => c.key === S.me?.kind)?.group === 'crafts';

function loginView() {
  main().innerHTML = `<div class="row"><h1>${esc(t('merchant.loginTitle'))}</h1><button class="iconbtn" id="lang">🌐</button></div>
    <form id="lf" class="card"><label class="f">${esc(t('merchant.phone'))}<input class="in" name="phone" type="tel" inputmode="tel" required autocomplete="username"></label>
    <label class="f">${esc(t('merchant.password'))}<input class="in" name="pw" type="password" required autocomplete="current-password"></label>
    <button class="btn">${esc(t('common.login'))}</button></form>
    <a class="btn alt" href="/join">${esc(t('me.forStores'))}</a>`;
  $('#lang').onclick = langPicker;
  $('#lf').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/api/cook/login', { whatsapp: e.target.phone.value, password: e.target.pw.value });
      if (r?.admin && r.redirect) { location.href = r.redirect; return; }   // the owner's username opens the admin panel
      boot2();
    } catch (x) { err(x); }
  });
}

const hasMoney = () => S.wallet?.deliveryMode === 'delivery' || (S.settings?.payMethods && S.settings.payMethods !== 'cash') || Number(S.wallet?.balance || 0) !== 0;
function tabs() {
  const list = ['orders', 'products'];
  if (S.me.booking) list.push('appointments');
  if (isCraft()) list.push('visits');
  list.push('records');
  if (hasMoney()) list.push('wallet');   // the money account: only for stores with drivers, card payments or a balance
  list.push('plan', 'report', 'branches', 'settings');
  return list;
}

function frame() {
  const on = S.accepting;
  main().innerHTML = `
    <div class="row"><div><h1>${esc(S.me.name)}</h1><span class="mute small">${esc(t('merchant.title'))}</span></div><button class="iconbtn" id="lang">🌐</button></div>
    <div class="toggle"><b>${esc(on ? t('merchant.accepting') : t('merchant.notAccepting'))}</b><button class="sw${on ? ' on' : ''}" id="acc" aria-label="${esc(t('merchant.accepting'))}"></button></div>
    ${S.wallet?.warnings?.count ? `<div class="note">${esc(t('common.warnings', { n: S.wallet.warnings.count, max: S.wallet.warnings.max }))}</div>` : ''}
    <div id="bc"></div>
    ${pushSupported() && Notification.permission === 'default' ? `<button class="btn alt" id="pushOn">🔔 ${esc(t('me.notifOn'))}</button>` : ''}
    <div class="tabs">${tabs().map((k) => `<button data-t="${k}" class="${k === S.tab ? 'on' : ''}">${esc(t(`merchant.tab${k[0].toUpperCase() + k.slice(1)}`))}</button>`).join('')}</div>
    <div id="pane"></div>`;
  $('#lang').onclick = langPicker;
  $('#acc').onclick = async () => { try { await api('POST', '/api/store/accepting', { on: !S.accepting }); S.accepting = !S.accepting; frame(); } catch (e) { err(e); } };
  $$('[data-t]').forEach((b) => { b.onclick = () => { S.tab = b.dataset.t; frame(); }; });
  $('#pushOn')?.addEventListener('click', async () => { const r = await enablePush('store'); toast(r === 'on' ? t('me.notifDone') : r === 'denied' ? t('me.notifDenied') : t('me.notifNo')); frame(); });
  if (S.settings?.broadcasts?.length) $('#bc').innerHTML = `<div class="card warnc"><h3>📢 ${esc(t('merchant.messages'))}</h3>${S.settings.broadcasts.map((b) => `<p class="legal">${esc(b.body)}</p>`).join('<hr>')}</div>`;
  clearInterval(S.timer); S.timer = null;
  ({ orders: paneOrders, products: paneProducts, appointments: paneAppts, visits: paneVisits, records: paneRecords, wallet: paneWallet, plan: panePlan, report: paneReport, branches: paneBranches, settings: paneSettings }[S.tab] || paneOrders)();
}
const pane = () => $('#pane');

/* ---------- orders ---------- */
function driverBlock(o) {
  const d = o.driver;
  if (!d) return '';
  const dist = d.toStoreM != null ? t('merchant.driverAway', { d: fmtRoad(d.toStoreM, d.approx) }) : d.toCustomerM != null ? t('cand.toCustomer', { d: fmtRoad(d.toCustomerM, d.approx) }) : '';
  return `<div class="note g">✅ ${esc(t('merchant.driverAccepted', { name: d.name }))}</div>
    ${driverHtml(d, '/api/store/driver-photo/', { distLabel: dist })}
    <div class="grid2"><a class="btn sm alt" href="${esc(telLink(d.phone))}">📞 ${esc(t('common.call'))}</a>${d.lat != null ? `<a class="btn sm alt" href="https://www.google.com/maps?q=${d.lat},${d.lng}" target="_blank" rel="noopener">🗺 ${esc(t('merchant.driverOnMap'))}</a>` : ''}</div>`;
}
/** Food + delivery fee = what the customer pays, and how — so nobody mixes cash and card. */
function moneyLine(o) {
  if (o.legacy || o.customerTotal == null) return `<div class="row"><span></span><b>${esc(money(o.total, o.currency))}</b></div>`;
  const card = o.paymentMethod === 'card';
  return `<div class="moneyline ${card ? 'card-pay' : 'cash-pay'}"><span class="paybadge">${card ? `💳 ${esc(t('money.card'))}` : `💵 ${esc(t('money.cash'))}`}</span>
    <span class="small">${esc(t('money.breakdown', { f: money(o.total, o.currency), d: money(o.deliveryFee, o.currency) }))}</span><b>${esc(money(o.customerTotal, o.currency))}</b></div>
    ${o.bonus ? `<p class="small">🎁 ${esc(t('money.bonusLine', { b: money(o.bonus) }))}</p>` : ''}`;
}
function orderCard(o) {
  const items = o.items.map((i) => `${i.qty} × ${esc(i.name)}`).join('، ');
  const mode = S.wallet?.deliveryMode;
  const myDrivers = S.activeDrivers || [];
  let actions = '';
  if (o.status === 'pending') actions = `<div class="grid2"><button class="btn" data-a="accept" data-id="${o.id}">${esc(t('merchant.accept'))}</button><button class="btn alt" data-a="reject" data-id="${o.id}">${esc(t('merchant.reject'))}</button></div>
    <button class="btn sm alt" data-a="area" data-id="${o.id}">📍 ${esc(t('merchant.outOfArea'))}</button>`;
  else if (o.status === 'preparing') {
    actions = mode === 'delivery'
      ? `${o.legacy ? `<label class="f">${esc(t('merchant.fee'))}<input class="in" type="number" min="0.5" step="0.5" inputmode="decimal" value="${Number(o.deliveryFee) || 2}" id="fee${o.id}"></label>`
          : `<details class="small"><summary>🎁 ${esc(t('money.bonusAdd'))}</summary><input class="in" type="number" min="0" step="0.5" inputmode="decimal" placeholder="0" id="bn${o.id}"><p class="mute tiny">${esc(t('money.bonusHint'))}</p></details>`}
         <button class="btn" data-a="search" data-id="${o.id}">🛵 ${esc(t('merchant.findDriver'))}</button>
         ${myDrivers.length ? `<details class="card"><summary>➕ ${esc(t('merchant.sameDriver'))}</summary><p class="mute tiny">${esc(t('merchant.sameDriverHint'))}</p>
           <select class="in" id="sd${o.id}">${myDrivers.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select>
           <label class="f">🎁 ${esc(t('money.bonusAdd'))}<input class="in" type="number" min="0" step="0.5" value="0" id="sf${o.id}"></label>
           <button class="btn alt" data-a="same" data-id="${o.id}">${esc(t('merchant.sameDriver'))}</button></details>` : ''}
         <button class="btn alt" data-a="self" data-id="${o.id}">${esc(t('merchant.selfDispatch'))}</button>`
      : `<button class="btn" data-a="self" data-id="${o.id}">🛵 ${esc(t('merchant.onTheWay'))}</button>`;
    actions += `<button class="btn bad" data-a="cancel" data-id="${o.id}">${esc(t('merchant.cancelOrder'))}</button>`;
  } else if (o.status === 'searching') {
    if (o.addon) actions = o.addon.status === 'declined' ? `<div class="note b">${esc(t('merchant.addonDeclined'))}</div><button class="btn" data-a="redispatch" data-id="${o.id}">🛵 ${esc(t('merchant.redispatch'))}</button>`
      : `<div class="note">⏳ ${esc(t('merchant.addonWaiting', { name: o.addon.driver }))}</div>`;
    else actions = `<div class="note">${esc(o.driversNotified ? t('merchant.searching', { n: o.driversNotified }) : t('merchant.noDrivers'))}</div>
      ${candidatesHtml(o.candidates, '/api/store/driver-photo/')}
      ${o.canRaise || !o.driversNotified ? (o.legacy ? `<p class="small">${esc(t('merchant.raiseHint'))}</p><div class="row"><input class="in" type="number" min="1" step="0.5" value="${Number(o.deliveryFee) + 1}" id="fee${o.id}"><button class="btn sm acc" data-a="raise" data-id="${o.id}">${esc(t('merchant.raise'))}</button></div>`
        : `<p class="small">${esc(t('money.bonusRaiseHint'))}</p><div class="row"><input class="in" type="number" min="0.5" step="0.5" value="1" id="bn${o.id}"><button class="btn sm acc" data-a="raise" data-id="${o.id}">🎁 ${esc(t('money.bonusAddBtn'))}</button></div>`) + `
        <button class="btn alt" data-a="redispatch" data-id="${o.id}">🔁 ${esc(t('merchant.redispatch'))}</button>` : ''}`;
    actions += `<button class="btn bad" data-a="cancel" data-id="${o.id}">${esc(t('merchant.cancelOrder'))}</button>`;
  } else if (o.status === 'assigned' || (o.status === 'picked_up' && !o.selfDelivery)) {
    actions = `${driverBlock(o)}
      ${o.locationSent ? `<div class="note g">📍 ${esc(t('merchant.locationSent'))}</div>` : `<button class="btn acc" data-a="loc" data-id="${o.id}">📍 ${esc(t('merchant.sendBoth'))}</button>`}
      ${o.status === 'assigned' ? `${o.late ? `<div class="note">⏰ ${esc(t('merchant.late'))}</div>` : ''}<button class="btn sm bad" data-a="replace" data-id="${o.id}">🔄 ${esc(t('merchant.replace'))}</button>` : ''}`;
  } else if (o.status === 'picked_up' && o.selfDelivery) {
    actions = `<button class="btn" data-a="selfdone" data-id="${o.id}">✅ ${esc(t('merchant.selfDelivered'))}</button>`;
  }
  const c = o.customer;
  const wa = String(c.phone || '').replace(/^\+/, '');
  return `<div class="card ${o.status === 'pending' ? 'hl' : ''}">
    <div class="row"><b>${esc(t('merchant.newOrder', { id: o.ref || o.id }))}</b><span class="chip">${esc(t(`mstatus.${o.status === 'picked_up' && o.selfDelivery ? 'picked_up_self' : o.status}`))}</span></div>
    <p>${items}</p>${o.note ? `<p class="mute small">📝 ${esc(o.note)}</p>` : ''}${o.scheduledAt ? `<p class="small">🕐 ${esc(fmtTime(o.scheduledAt))}</p>` : ''}
    <div class="row small"><span>👤 ${esc(c.name)}</span><span class="mute">${esc(t('merchant.customerAway', { d: fmtRoad(o.distanceM) }))}</span></div>
    ${c.details ? `<p class="small mute">🏠 ${esc(c.details)}</p>` : ''}
    <div class="ctabs">${c.lat != null ? `<a class="btn sm alt" href="https://www.google.com/maps?q=${c.lat},${c.lng}" target="_blank" rel="noopener">📍 ${esc(t('money.customerLive'))}</a>` : ''}
      <a class="btn sm alt" href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener">🟢 ${esc(t('common.whatsapp'))}</a><a class="btn sm alt" href="${esc(telLink(c.phone))}">📞 ${esc(t('common.call'))}</a></div>
    ${moneyLine(o)}
    <div class="row"><span class="mute small">${esc(fmtTime(o.createdAt))}</span>${o.rating ? `<span class="small">${'⭐'.repeat(o.rating)}</span>` : ''}</div>${actions}${invBtn(o)}</div>`;
}
async function paneOrders() {
  const draw = async () => {
    let r;
    try { r = await api('GET', '/api/store/orders'); } catch (e) { if (e.status === 401) return loginView(); return; }
    if (S.tab !== 'orders' || !pane()) return;
    if (pane().contains(document.activeElement) && document.activeElement.matches('input,select')) return;   // don't redraw while typing a fee
    const fresh = r.orders.filter((o) => o.status === 'pending' && !S.seen.has(o.id));
    if (fresh.length && S.seen.size) beep();
    r.orders.forEach((o) => { S.seen.add(o.id); S.byId.set(o.id, o); });
    if (S.wallet?.deliveryMode === 'delivery') api('GET', '/api/store/finance').then((x) => { S.finance = x.finance; }).catch(() => {});
    S.wallet = { ...(S.wallet || {}), balance: r.balance };
    S.activeDrivers = [...new Map(r.orders.filter((o) => o.driver && ['assigned', 'picked_up'].includes(o.status)).map((o) => [o.driver.id, o.driver])).values()];
    // delivered orders waiting for the customer: the store can still take its fee back
    let awaiting = [];
    try { awaiting = (await api('GET', '/api/store/orders?view=history')).orders.filter((o) => o.canRefund); } catch { /* ignore */ }
    pane().innerHTML = `${S.finance?.outstandingWithDrivers ? `<button class="note" data-go="records">💵 ${esc(t('money.withDrivers', { t: money(S.finance.outstandingWithDrivers) }))}</button>` : ''}
      <h2></h2>
      ${r.orders.length ? r.orders.map(orderCard).join('') : `<div class="empty">${esc(t('merchant.noOrders'))}</div>`}
      ${awaiting.map((o) => `<div class="card"><div class="row"><b>${esc(o.ref)}</b><span class="chip w">${esc(t('merchant.awaiting'))}</span></div>${driverBlock({ driver: o.driver && { ...o.driver, lat: null } })}
        <button class="btn sm bad" data-a="notdel" data-id="${o.id}">${esc(t('merchant.notDelivered'))}</button></div>`).join('')}`;
  };
  pane().onclick = async (e) => {
    const go = e.target.closest('[data-go]');
    if (go) { S.tab = go.dataset.go; S.recView = 'finance'; return frame(); }
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const id = b.dataset.id, a = b.dataset.a;
    if (a === 'replace' || a === 'notdel') return reasonSheet(id, a === 'replace' ? 'replace-driver' : 'not-delivered', a === 'replace' ? t('merchant.replace') : t('merchant.notDelivered'), draw);
    if (a === 'area' && !confirm(t('merchant.outOfAreaConfirm'))) return;
    const path = { accept: 'accept', reject: 'reject', area: 'out-of-area', search: 'search', raise: 'raise', loc: 'send-location', cancel: 'cancel', self: 'self-dispatch', selfdone: 'self-delivered', redispatch: 'redispatch', same: 'same-driver' }[a];
    const body = ['search', 'raise'].includes(a) ? ($(`#fee${id}`) ? { fee: Number($(`#fee${id}`).value) } : { bonus: Number($(`#bn${id}`)?.value || 0) }) : a === 'same' ? { driverId: Number($(`#sd${id}`).value), bonus: Number($(`#sf${id}`).value || 0) } : {};
    b.disabled = true;
    try { await api('POST', `/api/store/orders/${id}/${path}`, body); document.activeElement?.blur?.(); await draw(); } catch (x) { err(x); b.disabled = false; }
  };
  await draw();
  S.timer = setInterval(draw, 6000);
}
function reasonSheet(id, path, title, then) {
  const sh = sheet(`<h2>${esc(title)}</h2><form id="rf"><label class="f">${esc(t('merchant.replaceReason'))}<textarea class="in" name="r" required minlength="3" maxlength="300" placeholder="${esc(t('merchant.reasonPh'))}"></textarea></label><button class="btn bad">${esc(t('common.confirm'))}</button></form>`);
  $('#rf', sh.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await api('POST', `/api/store/orders/${id}/${path}`, { reason: e.target.r.value }); sh.close(); toast(path === 'not-delivered' ? t('merchant.refundDone') : t('common.done')); then?.(); return r; } catch (x) { err(x); }
  });
}

/* ---------- records: everything delivered / paid / unpaid, delete one or all, download ---------- */
async function paneRecords() {
  const view = S.recView === 'finance' && S.wallet?.deliveryMode === 'delivery' ? 'finance' : 'history';
  const views = S.wallet?.deliveryMode === 'delivery' ? ['history', 'finance'] : ['history'];
  pane().innerHTML = `${views.length > 1 ? `<div class="tabs">${views.map((v) => `<button data-v="${v}" class="${v === view ? 'on' : ''}">${esc(t(v === 'finance' ? 'money.tabCash' : 'merchant.vHistory'))}</button>`).join('')}</div>` : ''}<div id="rl"><div class="skel cover"></div></div>`;
  $$('[data-v]', pane()).forEach((b) => { b.onclick = () => { S.recView = b.dataset.v; paneRecords(); }; });
  if (view === 'finance') return paneFinance();
  let r;
  try { r = await api('GET', '/api/store/orders?view=history'); } catch (e) { return err(e); }
  r.orders.forEach((o) => S.byId.set(o.id, o));
  $('#rl').innerHTML = `
    ${r.records.full ? `<div class="note b">${esc(t('merchant.recordFull', { n: r.records.limit }))}</div>` : ''}
    <div class="grid2"><a class="btn alt" href="/api/store/orders.csv">⬇️ ${esc(t('merchant.download'))}</a><button class="btn bad" id="hideAll">🗑 ${esc(t('merchant.hideAll'))}</button></div>
    <label class="f">${esc(t('merchant.recordLimit'))}<div class="row"><input class="in" id="rlim" type="number" min="50" max="1000" step="50" value="${r.records.limit}"><button class="btn sm" id="rlimSave">${esc(t('common.save'))}</button></div></label>
    <p class="mute small">${r.records.count} / ${r.records.limit}</p>
    ${r.orders.map((o) => `<div class="card"><div class="row"><b>${esc(o.ref)}</b><span class="chip">${esc(t(`mstatus.${o.status}`))}</span></div>
      <p class="small">${esc(fmtTime(o.deliveredAt || o.createdAt))} · 👤 ${esc(o.customer.name)}</p>
      ${moneyLine(o)}
      ${o.driver ? `<p class="small">🛵 ${esc(o.driver.name)} · <a href="${esc(telLink(o.driver.phone))}">+${esc(o.driver.phone)}</a></p>` : ''}
      ${o.financialStatus === 'disputed' ? `<p class="note small">⚖️ ${esc(t('money.disputed'))}</p>` : ''}
      ${o.rating ? `<p class="small">${'⭐'.repeat(o.rating)}${o.ratingNote ? ` — ${esc(o.ratingNote)}` : ''}</p>` : ''}
      ${o.canRefund && o.driver ? `<button class="btn sm bad" data-nd="${o.id}">${esc(t('merchant.notDelivered'))}</button>` : ''}
      <div class="grid2">${invBtn(o)}${o.driver ? `<button class="btn sm alt" data-cmp="${o.id}">⚠️ ${esc(t('money.complainDriver'))}</button>` : ''}</div>
      <button class="btn sm alt" data-hide="${o.id}">🗑 ${esc(t('merchant.hideOne'))}</button></div>`).join('') || `<div class="empty">${esc(t('orders.none'))}</div>`}`;
  $('#hideAll').onclick = async () => { if (!confirm(t('merchant.hideAllConfirm'))) return; try { await api('POST', '/api/store/orders/hide-all', {}); paneRecords(); } catch (x) { err(x); } };
  $('#rlimSave').onclick = async () => { try { await api('POST', '/api/store/settings', { recordLimit: Number($('#rlim').value) }); toast(t('common.saved')); paneRecords(); } catch (x) { err(x); } };
  $$('[data-hide]', pane()).forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/store/orders/${b.dataset.hide}/hide`, {}); paneRecords(); } catch (x) { err(x); } }; });
  $$('[data-nd]', pane()).forEach((b) => { b.onclick = () => reasonSheet(b.dataset.nd, 'not-delivered', t('merchant.notDelivered'), paneRecords); });
  $$('[data-cmp]', pane()).forEach((b) => { b.onclick = () => complainDriver(Number(b.dataset.cmp)); });
}
/** A store complains about the driver of one of its orders (the owner reviews it; 3 warnings suspend). */
function complainDriver(orderId) {
  const sh = sheet(`<h2>⚠️ ${esc(t('money.complainDriver'))}</h2><form id="cf"><textarea class="in" name="text" required minlength="5" maxlength="1000" placeholder="${esc(t('track.complainPh'))}"></textarea><button class="btn">${esc(t('common.confirm'))}</button></form>`);
  $('#cf', sh.el).addEventListener('submit', async (e) => { e.preventDefault(); try { await api('POST', '/api/complaints', { orderId, against: 'driver', text: e.target.text.value }); sh.close(); toast(t('common.sent')); } catch (x) { err(x); } });
}
/** Restaurant money: sales by method, cash still with drivers (per driver, with the orders), settled. */
async function paneFinance() {
  let f;
  try { f = (await api('GET', '/api/store/finance')).finance; } catch (e) { return err(e); }
  S.finance = f;
  $('#rl').innerHTML = `<div class="grid2">
      <div class="stat"><b>${esc(money(f.foodSales))}</b><span>${esc(t('money.foodSales'))}</span></div>
      <div class="stat"><b>${esc(money(f.cardSales))}</b><span>💳 ${esc(t('money.cardSales'))}</span></div>
      <div class="stat"><b>${esc(money(f.cashByDrivers))}</b><span>💵 ${esc(t('money.cashByDrivers'))}</span></div>
      <div class="stat"><b>${esc(money(f.outstandingWithDrivers))}</b><span>⏳ ${esc(t('money.outstanding'))}</span></div>
      <div class="stat"><b>${esc(money(f.settled))}</b><span>✅ ${esc(t('money.settled'))}</span></div>
      <div class="stat"><b>${esc(money(f.balance))}</b><span>${esc(t('money.myAccount'))}</span></div></div>
    <p class="mute small">${esc(t('money.storeHow'))}</p>
    <h2>${esc(t('money.driversOweMe'))}</h2>
    <div class="list">${f.drivers.map((d) => `<button class="li" data-drv="${d.driverId}">🛵 ${esc(d.driver)} <span>${esc(t('money.owes', { t: money(d.owes), n: d.orders }))}</span></button>`).join('') || `<div class="empty">${esc(t('money.nobodyOwes'))}</div>`}</div>`;
  $$('[data-drv]', pane()).forEach((b) => { b.onclick = async () => {
    try {
      const { orders } = await api('GET', `/api/store/finance/drivers/${b.dataset.drv}`);
      sheet(`<h2>🛵 ${esc(b.textContent.split('  ')[0])}</h2><table class="inv"><thead><tr><th>${esc(t('money.order'))}</th><th>${esc(t('money.date'))}</th><th>${esc(t('money.amount'))}</th><th>${esc(t('money.state'))}</th></tr></thead>
        <tbody>${orders.map((o) => `<tr><td>${esc(o.ref)}</td><td>${esc(fmtTime(o.date))}</td><td>${esc(money(o.amount))}</td><td>${esc(t(`money.st_${o.status}`))}${o.settlementId ? ` · ${esc(o.settlementId)}` : ''}</td></tr>`).join('')}</tbody></table><button class="btn alt" data-close>${esc(t('common.close'))}</button>`);
    } catch (x) { err(x); }
  }; });
}

/* ---------- branches: each has its own place, menu, photos, orders and records ---------- */
async function paneBranches() {
  let st;
  try { st = await api('GET', '/api/store/settings'); } catch (e) { return err(e); }
  S.settings = st;
  let plans = { branchPercent: 50 };
  try { plans = await api('GET', '/api/plans'); } catch { /* optional */ }
  pane().innerHTML = `<p class="note g">${esc(t('merchant.priceNow', { p: money(st.price), n: st.branches.length }))}</p>
    <p class="mute small">${esc(t('merchant.branchHint', { pc: plans.branchPercent }))}</p>
    <h2>${esc(t('merchant.branches'))}</h2>
    <div class="list">${st.branches.map((b) => `<div class="row item"><span><b>${esc(b.name)}</b> ${b.main ? `<span class="chip">${esc(t('merchant.branchMain'))}</span>` : ''} ${b.status === 'pending' ? `<span class="chip w">${esc(t('merchant.branchPending'))}</span>` : ''}<br><small class="mute">${esc(b.area || '')}</small></span>
      <span>${b.status === 'pending' ? `<button class="btn sm acc" data-bpay="${b.id}">💳 ${esc(t('branch.pay'))}</button>` : ''}${b.current ? '<span class="chip g">✓</span>' : `<button class="btn sm" data-sw="${b.id}">${esc(t('merchant.open'))}</button>`}</span></div>`).join('')}</div>
    <h2>➕ ${esc(t('merchant.addBranch'))}</h2>
    <form id="bf" class="card"><label class="f">${esc(t('merchant.branchName'))}<input class="in" name="name" required minlength="2" maxlength="80"></label>
      <div class="grid2"><button class="btn alt" type="button" id="bhere">📍 ${esc(t('merchant.useHere'))}</button><button class="btn alt" type="button" id="bmap">📌 ${esc(t('map.pick'))}</button></div>
      <label class="f">${esc(t('merchant.pasteLink'))}<input class="in" name="link" dir="ltr" placeholder="https://maps.google.com/…"></label>
      <p class="small" id="bplace"></p>
      <button class="btn">${esc(t('merchant.addBranch'))}</button></form>`;
  let place = null;
  $('#bmap').onclick = async () => { const p = await pickOnMap(S.me?.lat != null ? { lat: S.me.lat, lng: S.me.lng } : null); if (p) { place = p; $('#bplace').textContent = `${t('merchant.placeSet')} 📌`; } };
  $('#bhere').onclick = async () => { try { const p = await locate(); place = p; $('#bplace').textContent = `${t('merchant.placeSet')} (±${Math.round(p.acc)} ${t('common.m')})`; } catch { toast(t('errors.location')); } };
  $('#bf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fromLink = parseMapsLink(e.target.link.value);
    const p = fromLink || place;
    if (!p) return toast(t('errand.linkBad'));
    try {
      const r = await api('POST', '/api/store/branches', { name: e.target.name.value, lat: p.lat, lng: p.lng });
      if (r.status === 'approved') { toast(t('branch.live')); return paneBranches(); }
      paneBranches(); branchPay(r.id, r);
    } catch (x) { err(x); }
  });
  $$('[data-sw]', pane()).forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/store/branches/${b.dataset.sw}/switch`, {}); S.tab = 'orders'; S.seen = new Set(); boot2(); } catch (x) { err(x); } }; });
  $$('[data-bpay]', pane()).forEach((b) => { b.onclick = async () => { try { branchPay(Number(b.dataset.bpay), await api('GET', '/api/store/branches/quote')); } catch (x) { err(x); } }; });
}
/** Pay for an extra branch: online → live by itself as soon as it's paid; or the receipt way (the owner confirms). */
async function branchPay(id, price) {
  try { S.sub = await api('GET', '/api/store/subscription'); } catch { /* numbers optional */ }
  let receipt = null;
  const sh = sheet(`<h2>🏬 ${esc(t('branch.payTitle'))}</h2><p>${esc(t('branch.price', { p: money(price.fee), m: price.months, x: money(price.monthly) }))}</p>
    ${price.online ? `<button class="btn acc" id="bpOnline">⚡ ${esc(t('plan.payNow'))} — ${esc(t('branch.auto'))}</button><p class="mute small">${esc(t('plan.orReceipt'))}</p>` : `<p class="note small">${esc(t('branch.manual'))}</p>`}
    ${payToHtml()}
    <form id="bpf"><label class="f">${esc(t('merchant.method'))}<select class="in" name="method"><option value="whish">Whish Money</option><option value="omt">OMT</option></select></label>
      <label class="f">${esc(t('merchant.reference'))}<input class="in" name="ref" maxlength="80"></label>
      <label class="f">${esc(t('merchant.receipt'))}<input class="in" name="file" type="file" accept="image/*" required></label>
      <button class="btn">${esc(t('plan.sendRenew'))}</button></form>`);
  $('input[name=file]', sh.el).onchange = async (e) => { try { receipt = await shrinkImage(e.target.files[0]); } catch { receipt = null; } };
  $('#bpOnline', sh.el)?.addEventListener('click', async () => { try { const { url } = await api('POST', `/api/store/branches/${id}/pay`, { method: 'online' }); location.href = url; } catch (x) { err(x); } });
  $('#bpf', sh.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!receipt) return toast(t('plan.needReceipt'));
    try { await api('POST', `/api/store/branches/${id}/pay`, { method: e.target.method.value, reference: e.target.ref.value, receipt }); sh.close(); toast(t('plan.renewSent')); paneBranches(); } catch (x) { err(x); }
  });
}

/* ---------- products ---------- */
// Products in the store's own sections; each section shows 2, the rest behind "show all". Photo optional.
function paneProducts() {
  const menu = S.me.menu || [];
  const sections = S.me.menuSections || [];
  const groups = [...sections.map((n) => ({ name: n, items: menu.filter((m) => m.section === n) })),
    ...[...new Set(menu.map((m) => m.section).filter((x) => x && !sections.includes(x)))].map((n) => ({ name: n, items: menu.filter((m) => m.section === n) })),
    { name: null, items: menu.filter((m) => !m.section) }].filter((g) => g.items.length || (g.name && sections.includes(g.name)));
  pane().innerHTML = `<div class="grid2"><button class="btn" id="add">➕ ${esc(t('merchant.addProduct'))}</button><button class="btn alt" id="secs">🗂 ${esc(t('menu.sections'))}</button></div>
    ${groups.map((g, gi) => `<section class="mgroup"><h3>${esc(g.name || t('menu.other'))} <small class="mute">(${g.items.length})</small></h3>
      ${g.items.length ? '' : `<p class="mute small">${esc(t('menu.emptySection'))}</p>`}
      ${g.items.map((m, i) => `<div class="item${i >= 2 ? ' more hide' : ''}" data-g="${gi}">${m.photo ? `<img class="pthumb" src="${esc(m.photo)}" alt="">` : '<span class="pthumb ph">📷</span>'}<div class="txt"><b>${esc(m.name)}</b>${m.description ? `<p>${esc(m.description)}</p>` : ''}<span class="price">${m.price != null ? esc(money(m.price, m.currency || 'USD')) : ''}</span></div>
        <div><button class="btn sm ${m.available ? 'alt' : 'bad'}" data-av="${m.id}">${esc(m.available ? t('merchant.available') : t('merchant.unavailable'))}</button>
        <button class="btn sm alt" data-ed="${m.id}" aria-label="${esc(t('menu.edit'))}">✏️</button></div></div>`).join('')}
      ${g.items.length > 2 ? `<button class="btn sm alt moreg" data-mg="${gi}">⌄ ${esc(t('menu.showAll', { n: g.items.length }))}</button>` : ''}</section>`).join('') || `<div class="empty">${esc(t('menu.none'))}</div>`}`;
  $$('[data-mg]', pane()).forEach((b) => { b.onclick = () => { const open = b.dataset.open !== '1'; $$(`.item.more[data-g="${b.dataset.mg}"]`, pane()).forEach((x) => x.classList.toggle('hide', !open)); b.dataset.open = open ? '1' : ''; b.textContent = open ? `⌃ ${t('menu.showLess')}` : `⌄ ${t('menu.showAll', { n: $$(`.item[data-g="${b.dataset.mg}"]`, pane()).length })}`; }; });
  const form = (m = {}) => {
    let photo; // undefined = unchanged, null = removed, string = new
    const allSecs = [...new Set([...sections, ...menu.map((x) => x.section).filter(Boolean)])];
    const sh = sheet(`<h2>${esc(m.id ? m.name : t('merchant.addProduct'))}</h2><form id="pf">
      <div class="photopick"><label class="phbox" id="phbox">${m.photo ? `<img src="${esc(m.photo)}" alt="">` : '<span>＋<br><small>' + esc(t('menu.photo')) + '</small></span>'}<input type="file" accept="image/*" class="hide" id="pph"></label>
        ${m.photo ? `<button class="btn sm bad" type="button" id="phdel">${esc(t('menu.removePhoto'))}</button>` : `<p class="mute tiny">${esc(t('menu.photoOptional'))}</p>`}</div>
      <label class="f">${esc(t('merchant.pName'))}<input class="in" name="name" required maxlength="80" value="${esc(m.name || '')}"></label>
      <label class="f">${esc(t('merchant.pPrice'))}<input class="in" name="price" type="number" step="0.01" min="0" inputmode="decimal" value="${m.price ?? ''}"></label>
      <label class="f">${esc(t('merchant.pDesc'))}<input class="in" name="desc" maxlength="200" value="${esc(m.description || '')}"></label>
      <label class="f">${esc(t('menu.section'))}<select class="in" name="sec"><option value="">— ${esc(t('menu.other'))} —</option>${allSecs.map((n) => `<option ${m.section === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}<option value="__new">➕ ${esc(t('menu.newSection'))}</option></select></label>
      <input class="in hide" name="newsec" maxlength="40" placeholder="${esc(t('menu.newSectionPh'))}">
      <button class="btn">${esc(t('common.save'))}</button>${m.id ? `<button class="btn bad" type="button" id="del">${esc(t('merchant.delete'))}</button>` : ''}</form>`);
    const f = $('#pf', sh.el);
    f.sec.onchange = () => f.newsec.classList.toggle('hide', f.sec.value !== '__new');
    $('#pph', sh.el).onchange = async (e) => {
      try { photo = await shrinkImage(e.target.files[0], { max: 900, limit: 300_000 }); $('#phbox', sh.el).firstChild.replaceWith(Object.assign(document.createElement('img'), { src: photo, alt: '' })); } catch { toast(t('errors.validation_failed')); }
    };
    $('#phdel', sh.el)?.addEventListener('click', () => { photo = null; $('#phbox', sh.el).firstChild.replaceWith(Object.assign(document.createElement('span'), { textContent: '＋' })); });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const section = f.sec.value === '__new' ? f.newsec.value.trim() : f.sec.value;
      const body = { name: f.name.value, price: f.price.value === '' ? null : Number(f.price.value), description: f.desc.value, section };
      if (photo !== undefined) body.photo = photo;
      try { S.me = await api(m.id ? 'PATCH' : 'POST', m.id ? `/api/cook/menu/${m.id}` : '/api/cook/menu', body); sh.close(); paneProducts(); } catch (x) { err(x); }
    });
    $('#del', sh.el)?.addEventListener('click', async () => { if (!confirm(t('merchant.deleteConfirm'))) return; try { S.me = await api('DELETE', `/api/cook/menu/${m.id}`); sh.close(); paneProducts(); } catch (x) { err(x); } });
  };
  // sections: add, rename, reorder (↑), delete (its products stay, without a section)
  const sectionsSheet = () => {
    let list = [...sections];
    const renamed = [];
    const sh = sheet(`<h2>🗂 ${esc(t('menu.sections'))}</h2><p class="mute small">${esc(t('menu.sectionsHint'))}</p><div id="sl"></div>
      <div class="row"><input class="in" id="ns" maxlength="40" placeholder="${esc(t('menu.newSectionPh'))}"><button class="btn sm" id="nsb">➕</button></div>
      <button class="btn" id="ssave">${esc(t('common.save'))}</button>`);
    const draw = () => {
      $('#sl', sh.el).innerHTML = list.map((n, i) => `<div class="row item"><input class="in" data-rn="${i}" value="${esc(n)}" maxlength="40"><span><button class="btn sm alt" data-up="${i}" ${i ? '' : 'disabled'}>↑</button><button class="btn sm bad" data-rm="${i}">✕</button></span></div>`).join('') || `<p class="mute">${esc(t('menu.noSections'))}</p>`;
      $$('[data-up]', sh.el).forEach((b) => { b.onclick = () => { const i = Number(b.dataset.up); [list[i - 1], list[i]] = [list[i], list[i - 1]]; draw(); }; });
      $$('[data-rm]', sh.el).forEach((b) => { b.onclick = () => { list.splice(Number(b.dataset.rm), 1); draw(); }; });
      $$('[data-rn]', sh.el).forEach((inp) => { inp.onchange = () => { const i = Number(inp.dataset.rn); const to = inp.value.trim(); if (to && to !== list[i]) { renamed.push({ from: list[i], to }); list[i] = to; } }; });
    };
    draw();
    $('#nsb', sh.el).onclick = () => { const v = $('#ns', sh.el).value.trim(); if (v && !list.includes(v)) { list.push(v); $('#ns', sh.el).value = ''; draw(); } };
    $('#ssave', sh.el).onclick = async () => { try { S.me = await api('PUT', '/api/cook/menu-sections', { sections: list, renamed }); sh.close(); paneProducts(); } catch (x) { err(x); } };
  };
  $('#add').onclick = () => form();
  $('#secs').onclick = sectionsSheet;
  $$('[data-ed]').forEach((b) => { b.onclick = () => form(menu.find((x) => String(x.id) === b.dataset.ed)); });
  $$('[data-av]').forEach((b) => { b.onclick = async () => { const m = menu.find((x) => String(x.id) === b.dataset.av); try { S.me = await api('PATCH', `/api/cook/menu/${m.id}`, { available: !m.available }); paneProducts(); } catch (x) { err(x); } }; });
}

/* ---------- appointments & visits ---------- */
async function paneAppts() {
  try {
    const { appointments } = await api('GET', '/api/store/appointments');
    pane().innerHTML = appointments.length ? appointments.map((a) => `<div class="card ${a.status === 'pending' ? 'hl' : ''}"><div class="row"><b>📅 ${esc(fmtTime(a.starts_at))}</b><span class="chip ${a.status === 'confirmed' ? 'g' : ['declined', 'cancelled'].includes(a.status) ? 'b' : ''}">${esc(t(`appt.${a.status}`))}</span></div>
      <p>${esc(a.service)}</p><p class="small">👤 ${esc(a.customer_name)} · <a href="${esc(telLink(a.customer_phone))}">📞 +${esc(a.customer_phone)}</a></p>${a.note ? `<p class="mute small">📝 ${esc(a.note)}</p>` : ''}
      ${a.store_reply ? `<p class="note g small">💬 ${esc(a.store_reply)}</p>` : ''}${a.cancelled_by === 'customer' ? `<p class="mute tiny">${esc(t('appt.byCustomer'))}</p>` : ''}
      ${['pending', 'confirmed'].includes(a.status) ? `<label class="f">${esc(t('appt.replyLabel'))}<input class="in" id="rp${a.id}" maxlength="300" placeholder="${esc(t('appt.replyPh'))}"></label>` : ''}
      ${a.status === 'pending' ? `<div class="grid2"><button class="btn" data-ap="${a.id}" data-x="confirm">${esc(t('merchant.aConfirm'))}</button><button class="btn alt" data-ap="${a.id}" data-x="decline">${esc(t('merchant.aDecline'))}</button></div>` : ''}
      ${a.status === 'confirmed' ? `<div class="grid2"><button class="btn alt" data-ap="${a.id}" data-x="done">${esc(t('merchant.aDone'))}</button><button class="btn bad" data-ap="${a.id}" data-x="cancel">${esc(t('appt.cancel'))}</button></div>` : ''}
      <button class="btn sm alt" data-ap="${a.id}" data-x="hide">🗑 ${esc(t('appt.delete'))}</button></div>`).join('') : `<div class="empty">${esc(t('appt.none'))}</div>`;
    $$('[data-ap]').forEach((b) => { b.onclick = async () => {
      const x = b.dataset.x;
      if ((x === 'hide' || x === 'cancel') && !confirm(t(x === 'cancel' ? 'appt.cancelQ' : 'appt.deleteQ'))) return;
      try { await api('POST', `/api/store/appointments/${b.dataset.ap}/${x}`, { reply: $(`#rp${b.dataset.ap}`)?.value || '' }); paneAppts(); } catch (e) { err(e); }
    }; });
  } catch (e) { err(e); }
}
async function paneVisits() {
  const draw = async () => {
    try {
      const { visits } = await api('GET', '/api/store/visits');
      if (S.tab !== 'visits') return;
      pane().innerHTML = visits.length ? visits.map((v) => `<div class="card ${v.status === 'pending' ? 'hl' : ''}"><div class="row"><b>👤 ${esc(v.customerName)}</b><span class="chip">${esc(t(`visit.${v.status}`))}</span></div>
        <p>${esc(v.description)}</p><p class="mute small">📍 ${esc(t('merchant.vAway', { d: fmtDist(v.distanceM) }))}</p>
        ${v.customer ? `<div class="grid2"><a class="btn" href="${esc(mapsLink(v.customer.lat, v.customer.lng))}" target="_blank" rel="noopener">🧭 ${esc(t('common.map'))}</a><a class="btn alt" href="${esc(telLink(v.customer.phone))}">📞 ${esc(t('common.call'))}</a></div>${v.customer.details ? `<p class="small">${esc(v.customer.details)}</p>` : ''}` : ''}
        ${v.status === 'pending' ? `<div class="grid2"><button class="btn" data-v="${v.id}" data-x="accept">${esc(t('merchant.vAccept'))}</button><button class="btn alt" data-v="${v.id}" data-x="decline">${esc(t('merchant.vDecline'))}</button></div>` : ''}
        ${v.status === 'accepted' ? `<button class="btn alt" data-v="${v.id}" data-x="done">${esc(t('merchant.vDone'))}</button>` : ''}</div>`).join('') : `<div class="empty">${esc(t('orders.none'))}</div>`;
      $$('[data-v]').forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/store/visits/${b.dataset.v}/${b.dataset.x}`, {}); draw(); } catch (x) { err(x); } }; });
    } catch (e) { err(e); }
  };
  await draw();
  S.timer = setInterval(draw, 15000);
}

/* ---------- wallet ---------- */
// The store's money account (v7.6: no top-up — the customer pays the delivery fee). Money arrives from card sales and
// from drivers' verified cash settlements; the store withdraws it to Whish / OMT.
async function paneWallet() {
  try { S.wallet = await api('GET', '/api/store/wallet'); } catch (e) { return err(e); }
  const w = S.wallet;
  const label = (l) => (/settlement S-(\d+)/.test(l.note || '') ? `💵 ${t('money.k_settled')} S-${/S-(\d+)/.exec(l.note)[1]}` : /card sale/.test(l.note || '') ? `💳 ${t('money.k_card')}` : t(`merchant.k_${l.kind}`));
  pane().innerHTML = `<div class="stat"><b>${esc(money(w.balance))}</b><span>${esc(t('money.myAccount'))}</span></div>
    <p class="mute small">${esc(t('money.accountHow'))}</p>
    <button class="btn" id="wd">💸 ${esc(t('wd.button'))}</button>
    <h2>${esc(t('merchant.ledger'))}</h2>
    <div class="list">${w.ledger.map((l) => `<div class="row item"><span>${esc(label(l))}${l.order_id ? ` · AKL${l.order_id}` : ''}<br><small>${esc(fmtTime(l.created_at))}</small></span><b class="${l.amount < 0 ? '' : 'big'}">${esc(money(l.amount))}</b></div>`).join('') || `<div class="empty">${esc(t('orders.none'))}</div>`}</div>`;
  $('#wd').onclick = () => openWithdraw('store', paneWallet);
}


/* ---------- my subscription: status, renew (receipt or online), branches, optional services ---------- */
function payToHtml() {
  const p = S.sub?.payTo || {};
  if (!p.whish && !p.omt) return `<p class="note small">${esc(t('plan.noPayTo'))}</p>`;
  return `<div class="card"><h3>📲 ${esc(t('plan.sendTo'))}</h3>${p.name ? `<p class="small">👤 ${esc(p.name)}</p>` : ''}
    ${p.whish ? `<div class="row item"><span>Whish Money</span><span><b dir="ltr">${esc(p.whish)}</b> <button class="btn sm alt" data-copy="${esc(p.whish)}">${esc(t('common.copy'))}</button></span></div>` : ''}
    ${p.omt ? `<div class="row item"><span>OMT</span><span><b dir="ltr">${esc(p.omt)}</b> <button class="btn sm alt" data-copy="${esc(p.omt)}">${esc(t('common.copy'))}</button></span></div>` : ''}
    <p class="mute tiny">${esc(t('plan.sendHint'))}</p></div>`;
}
document.addEventListener('click', (e) => { const c = e.target.closest('[data-copy]'); if (c) copyText(c.dataset.copy); });
async function panePlan() {
  let sub, st;
  try { sub = S.sub = await api('GET', '/api/store/subscription'); st = S.settings = await api('GET', '/api/store/settings'); } catch (e) { return err(e); }
  const kindName = (k) => t(k === 'delivery' ? 'plan.withDrivers' : 'plan.withoutDrivers');
  pane().innerHTML = `<div class="card ${sub.active ? '' : 'warnc'}"><h3>🧾 ${esc(t('plan.title'))}</h3>
      <p><b>${esc(kindName(sub.kind))}</b> · ${esc(t('plan.branchesN', { n: sub.branches }))}</p>
      <p class="${sub.active ? '' : 'note b'}">${sub.expiry ? esc(t(sub.active ? 'plan.until' : 'plan.ended', { d: new Date(sub.expiry).toLocaleDateString() })) : esc(t('plan.none'))}</p>
      ${sub.isBranch ? `<p class="mute small">${esc(t('plan.branchOf', { name: sub.mainName }))}</p>` : ''}
      ${sub.pending.map((r) => `<p class="note small">⏳ ${esc(t('plan.pending', { m: r.months, p: money(r.amount) }))}</p>`).join('')}</div>
    <h2>🔄 ${esc(t('plan.renew'))}</h2>
    <form id="rnf" class="card">
      ${sub.options.map((o) => `<h3>${esc(kindName(o.kind))}</h3>${o.months.length ? o.months.map((x) => `<label class="check"><input type="radio" name="pick" value="${o.kind}:${x.months}" ${o.kind === sub.kind && x.months === 1 ? 'checked' : ''}><span>${esc(t('driver.months', { n: x.months }))} — <b>${esc(money(x.price))}</b></span></label>`).join('') : `<p class="mute small">—</p>`}`).join('')}
      <p class="mute tiny">${esc(t('plan.priceNote', { n: sub.branches, pc: sub.branchPercent }))}</p>
      ${sub.online ? `<button class="btn acc" type="button" id="payOnline">⚡ ${esc(t('plan.payNow'))}</button><p class="mute small">${esc(t('plan.orReceipt'))}</p>` : ''}
      ${payToHtml()}
      <label class="f">${esc(t('merchant.method'))}<select class="in" name="method"><option value="whish">Whish Money</option><option value="omt">OMT</option><option value="other">—</option></select></label>
      <label class="f">${esc(t('merchant.reference'))}<input class="in" name="ref" maxlength="80"></label>
      <label class="f">${esc(t('merchant.receipt'))}<input class="in" name="file" type="file" accept="image/*"></label>
      <button class="btn">${esc(t('plan.sendRenew'))}</button></form>
    <h2>🏬 ${esc(t('merchant.branches'))}</h2>
    <div class="card"><p class="small">${esc(t('plan.branchesHint', { pc: sub.branchPercent }))}</p><button class="btn" id="goBranch">➕ ${esc(t('merchant.addBranch'))}</button></div>
    <h2>✨ ${esc(t('plan.extras'))}</h2>
    <div class="card">
      ${st.bookingAvailable ? `<div class="toggle"><div><b>📅 ${esc(t('plan.booking'))}</b><div class="mute small">${esc(st.bookingPrice ? t('plan.bookingPaid', { p: money(st.bookingPrice) }) : t('plan.free'))}</div></div><button class="sw${st.booking ? ' on' : ''}" id="swBook" aria-label="${esc(t('plan.booking'))}"></button></div>` : ''}
      <div class="toggle"><div><b>💬 ${esc(t('plan.waOrders'))}</b><div class="mute small">${esc(t('plan.free'))}</div></div><button class="sw${st.waOrders ? ' on' : ''}" id="swWa" aria-label="${esc(t('plan.waOrders'))}"></button></div>
    </div>`;
  let receipt = null;
  $('input[name=file]', pane()).onchange = async (e) => { try { receipt = await shrinkImage(e.target.files[0]); } catch { receipt = null; } };
  const choice = () => { const [kind, months] = ($('input[name=pick]:checked', pane())?.value || '').split(':'); return { kind, months: Number(months) }; };
  $('#rnf').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!$('input[name=pick]:checked', pane())) return toast(t('plan.pickFirst'));
    if (!receipt) return toast(t('plan.needReceipt'));
    try { await api('POST', '/api/store/renewals', { ...choice(), method: e.target.method.value, reference: e.target.ref.value, receipt }); toast(t('plan.renewSent')); panePlan(); } catch (x) { err(x); }
  });
  $('#payOnline')?.addEventListener('click', async () => { try { const { url } = await api('POST', '/api/store/pay', { purpose: 'renewal', ...choice() }); location.href = url; } catch (x) { err(x); } });
  $('#goBranch').onclick = () => { S.tab = 'branches'; frame(); };
  const toggle = (id, key, on) => { $(id)?.addEventListener('click', async () => { try { await api('POST', '/api/store/settings', { [key]: !on }); S.me = await api('GET', '/api/cook/me'); toast(t('common.saved')); frame(); } catch (x) { err(x); } }); };
  toggle('#swBook', 'booking', st.booking);
  toggle('#swWa', 'waOrders', st.waOrders);
}

/* ---------- report ---------- */
async function paneReport(period = 'month') {
  pane().innerHTML = `<div class="tabs">${['today', 'week', 'month'].map((p) => `<button data-p="${p}" class="${p === period ? 'on' : ''}">${esc(t(`merchant.${p}`))}</button>`).join('')}</div><div id="rep"><div class="skel cover"></div></div>`;
  $$('[data-p]').forEach((b) => { b.onclick = () => paneReport(b.dataset.p); });
  try {
    const { report: r } = await api('GET', `/api/store/report?period=${period}`);
    const text = [
      `📊 ${S.me.name} — ${t(`merchant.${period}`)}`,
      `${t('merchant.rOrders')}: ${r.orders} (${t('merchant.rDelivered')} ${r.delivered} · ${t('merchant.rRejected')} ${r.rejected})`,
      `${t('merchant.rSales')}: ${money(r.sales)}`, `${t('merchant.rFees')}: ${money(r.deliveryFeesPaid)}`,
      `${t('merchant.rViews')}: ${r.pageViews}`,
      ...(r.topItems.length ? [`${t('merchant.rTop')}: ${r.topItems.map((i) => `${i.name} (${i.qty})`).join('، ')}`] : []),
    ].join('\n');
    $('#rep').innerHTML = `<div class="grid2">
      <div class="stat"><b>${r.orders}</b><span>${esc(t('merchant.rOrders'))}</span></div><div class="stat"><b>${r.delivered}</b><span>${esc(t('merchant.rDelivered'))}</span></div>
      <div class="stat"><b>${esc(money(r.sales))}</b><span>${esc(t('merchant.rSales'))}</span></div><div class="stat"><b>${esc(money(r.deliveryFeesPaid))}</b><span>${esc(t('merchant.rFees'))}</span></div>
      <div class="stat"><b>${r.rejected}</b><span>${esc(t('merchant.rRejected'))}</span></div><div class="stat"><b>${r.pageViews}</b><span>${esc(t('merchant.rViews'))}</span></div></div>
      ${r.topItems.length ? `<h2>${esc(t('merchant.rTop'))}</h2><div class="list">${r.topItems.map((i) => `<div class="row item"><span>${esc(i.name)}</span><b>${i.qty}</b></div>`).join('')}</div>` : ''}
      <div class="grid2 noprint"><button class="btn" id="share">${esc(t('merchant.share'))}</button><button class="btn alt" id="print">${esc(t('merchant.print'))}</button></div>`;
    $('#share').onclick = async () => { try { if (navigator.share) await navigator.share({ text }); else { await navigator.clipboard.writeText(text); toast(t('common.done')); } } catch { /* cancelled */ } };
    $('#print').onclick = () => window.print();
  } catch (e) { err(e); }
}

/* ---------- settings ---------- */
async function paneSettings() {
  let st = S.settings;
  try { st = S.settings = await api('GET', '/api/store/settings'); } catch { /* keep */ }
  const photos = S.me.photos || [];
  pane().innerHTML = `<div class="card"><h3>${esc(t('merchant.photo'))}</h3>${S.me.photoUrl ? `<img src="${esc(S.me.photoUrl)}" alt="" class="cover">` : ''}
    <label class="btn alt">${esc(t('merchant.changePhoto'))}<input type="file" accept="image/*" id="ph" class="hide"></label></div>
    <div class="card"><h3>🖼 ${esc(t('merchant.gallery'))}</h3><div class="docs">${photos.map((p) => `<figure><img src="${esc(p.url)}" alt=""><button class="btn sm bad" data-delph="${p.id}">✕</button></figure>`).join('')}</div>
      <label class="btn alt">➕ ${esc(t('merchant.addPhotos'))}<input type="file" accept="image/*" multiple id="gal" class="hide"></label></div>
    ${S.wallet?.deliveryMode !== 'none' ? `<div class="card"><h3>🛵 ${esc(t('money.deliverySettings'))}</h3>
      <label class="f">${esc(t('money.feeLabel'))}<input class="in" id="dfee" type="number" min="0" step="0.5" inputmode="decimal" value="${esc(st?.deliveryFee ?? 2)}"></label>
      <p class="mute tiny">${esc(t('money.feeHelp'))}</p>
      <label class="f">${esc(t('money.payMethods'))}<select class="in" id="pmeth"><option value="cash" ${st?.payMethods === 'cash' ? 'selected' : ''}>💵 ${esc(t('pay.cash'))}</option>
        <option value="card" ${st?.payMethods === 'card' ? 'selected' : ''} ${st?.cardAvailable ? '' : 'disabled'}>💳 ${esc(t('pay.card'))}</option><option value="both" ${st?.payMethods === 'both' ? 'selected' : ''} ${st?.cardAvailable ? '' : 'disabled'}>💵 + 💳</option></select></label>
      ${st?.cardAvailable ? '' : `<p class="mute tiny">${esc(t('money.cardSoon'))}</p>`}
      <label class="f">${esc(t('money.radius'))}<input class="in" id="drad" type="number" min="0" max="100" step="0.5" value="${esc(st?.deliveryRadiusKm || 0)}"></label>
      <p class="mute tiny">${esc(t('money.radiusHelp'))}</p>
      <button class="btn" id="saveDel">${esc(t('common.save'))}</button></div>
    <div class="card" id="rcv"><h3>📲 ${esc(t('money.receiveTitle'))}</h3>
      <p class="small">${esc(t(st?.autoPayout ? 'money.receiveAuto' : 'money.receiveHint'))}</p>
      <label class="f">${esc(t('merchant.method'))}<select class="in" id="pprov"><option value="whish" ${st?.payoutProvider !== 'omt' ? 'selected' : ''}>Whish Money</option><option value="omt" ${st?.payoutProvider === 'omt' ? 'selected' : ''}>OMT</option></select></label>
      <label class="f">${esc(t('money.receiveNumber'))}<input class="in" id="pnum" type="tel" inputmode="tel" dir="ltr" value="${esc(st?.payoutNumber ? `+${st.payoutNumber}` : '')}" placeholder="+961 70 000000"></label>
      <button class="btn" id="savePay">${esc(t('common.save'))}</button></div>` : ''}
    <div class="card"><h3>🎨 ${esc(t('merchant.appearance'))}</h3>
      <label class="f">${esc(t('merchant.accent'))}<input class="in" type="color" id="acc2" value="${esc(st?.accentColor || '#0E9F7E')}"></label>

      <button class="btn" id="saveSt">${esc(t('common.save'))}</button></div>
    <div class="list"><a href="/#/s/${S.me.id}">👁 ${esc(S.me.name)}</a><a href="/#/legal/terms">📄 ${esc(t('me.terms'))}</a><a href="/#/legal/privacy">🔒 ${esc(t('me.privacy'))}</a>
    <button class="li" id="out">↩ ${esc(t('common.logout'))}</button></div>`;
  $('#ph').onchange = async (e) => {
    try { const photo = await shrinkImage(e.target.files[0], { max: 800, limit: 190_000 }); S.me = await api('PATCH', '/api/cook/me', { photo }); toast(t('common.saved')); paneSettings(); } catch (x) { err(x); }
  };
  $('#gal').onchange = async (e) => {
    for (const f of [...e.target.files].slice(0, 10)) {
      try { const data = await shrinkImage(f, { max: 1280, limit: 500_000 }); S.me = await api('POST', '/api/cook/photos', { data }); } catch (x) { err(x); break; }
    }
    paneSettings();
  };
  $$('[data-delph]', pane()).forEach((b) => { b.onclick = async () => { try { S.me = await api('DELETE', `/api/cook/photos/${b.dataset.delph}`); paneSettings(); } catch (x) { err(x); } }; });
  $('#saveDel')?.addEventListener('click', async () => { try { await api('POST', '/api/store/settings', { deliveryFee: Number($('#dfee').value || 0), payMethods: $('#pmeth').value, deliveryRadiusKm: Number($('#drad').value || 0) }); toast(t('common.saved')); } catch (x) { err(x); } });
  $('#savePay')?.addEventListener('click', async () => { try { await api('POST', '/api/store/settings', { payoutProvider: $('#pprov').value, payoutNumber: $('#pnum').value.trim() }); toast(t('common.saved')); } catch (x) { err(x); } });
  $('#saveSt').onclick = async () => { try { await api('POST', '/api/store/settings', { accentColor: $('#acc2').value }); toast(t('common.saved')); } catch (x) { err(x); } };
  $('#out').onclick = async () => { await api('POST', '/api/cook/logout', {}).catch(() => {}); clearInterval(S.timer); loginView(); };
}

async function boot2() {
  try { S.me = await api('GET', '/api/cook/me'); } catch { return loginView(); }
  try { S.wallet = await api('GET', '/api/store/wallet'); } catch { S.wallet = { deliveryMode: 'none', balance: 0 }; }
  try { const cfg = await api('GET', '/api/config'); S.cats = cfg.site?.categories || []; } catch { /* ignore */ }
  S.accepting = S.wallet.accepting !== false;
  try { S.settings = await api('GET', '/api/store/settings'); } catch { S.settings = null; }
  refreshPush('store');
  // back from the online payment page
  const paid = new URLSearchParams(location.search).get('paid');
  if (paid) { toast(paid === 'cancel' ? t('plan.payCancelled') : t('plan.payBack')); S.tab = 'plan'; window.history.replaceState(null, '', '/store'); }
  frame();
}
(async () => { registerSW(); await initI18n(); document.documentElement.lang = getLang(); boot2(); })();
