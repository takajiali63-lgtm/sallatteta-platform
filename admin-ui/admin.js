import { initI18n, t, api, errorText, esc, applyI18n, fmtNumber, fmtDate as fmtD, setRegion } from '/assets/i18n.js?v=610';
import { areaSearch, servedAreasEditor, starsHtml, resizeImage } from '/assets/ui.js?v=610';

const $ = (s, r = document) => r.querySelector(s);
const FILTERS = ['verified', 'imported', 'pending', 'active', 'expired', 'suspended', 'rejected', 'no_subscription', 'hidden', 'all', 'feedback', 'support'];
const st = { filter: 'pending', fbStatus: 'new', q: '', config: null, current: null, kind: 'cook', country: '' };

const dateOnly = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');
const fmtDate = (v) => fmtD(v, { year: 'numeric', month: 'short', day: 'numeric' });
const pill = (s) => `<span class="pill ${esc(s)}">${esc(t(`status.${s}`))}</span>`;

/* ---------- auth ---------- */
async function boot() {
  await initI18n();
  st.config = await api('/api/config');
  renderKindTabs();
  setRegion(st.config.country);
  $('#districtSel').innerHTML = st.config.districts.map((d) => `<option value="${d.key}">${esc(d.name)}</option>`).join('');
  const names = (() => { try { return new Intl.DisplayNames([document.documentElement.lang || 'ar'], { type: 'region' }); } catch { return null; } })();
  const flag = (c) => String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
  const countryOpts = (st.config.countries || [])
    .map((c) => ({ c, n: names?.of(c) || c }))
    .sort((a, b) => a.n.localeCompare(b.n, document.documentElement.lang || 'ar'))
    .map(({ c, n }) => `<option value="${c}">${flag(c)} ${esc(n)}</option>`).join('');
  $('#countryFilter').innerHTML = `<option value="">${esc(t('admin.allCountries'))}</option>${countryOpts}`;
  $('#importCountry').innerHTML = countryOpts;
  $('#importCountry').value = st.config.country?.code || 'LB';
  try {
    const me = await api('/api/admin/me');
    $('#adminWarn').hidden = me.adminWhatsappConfigured;
    showDash();
  } catch { showLogin(); }
}
function showLogin() { $('#loginView').hidden = false; $('#dashView').hidden = true; $('#logoutBtn').hidden = true; $('#u').focus(); }
async function showDash() {
  // a country agent sees one country and only his actions (the server enforces it too)
  try {
    const me = await api('/api/admin/me');
    st.role = me.role || 'owner';
    document.body.classList.toggle('agent-mode', st.role === 'agent');
    if (st.role === 'agent') {
      st.country = me.country;
      $('#agentBanner').hidden = false;
      $('#agentBanner').textContent = t('admin.agBanner', { country: `${flagOf(me.country)} ${countryName(me.country)}` });
      if (st.filter === 'feedback' || st.filter === 'support') st.filter = 'pending';
    }
  } catch { /* the login check above already ran */ }
  if ($('#securityPanel')?.open) loadSecurity();
  call('/api/admin/settings').then((r) => { st.settings = r; }).catch(() => {});
  $('#loginView').hidden = true; $('#dashView').hidden = false; $('#logoutBtn').hidden = false;
  renderTabs();
  await Promise.all([loadStats(), loadView()]);
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').hidden = true;
  try {
    const r = await api('/api/admin/login', { method: 'POST', body: { username: e.target.username.value, password: e.target.password.value } });
    if (r.mfa) { st.mfa = r; $('#loginForm').hidden = true; $('#mfaStep').hidden = false; return; }
    e.target.reset();
    const me = await api('/api/admin/me');
    $('#adminWarn').hidden = me.adminWhatsappConfigured;
    showDash();
  } catch (err) { $('#loginError').textContent = errorText(err); $('#loginError').hidden = false; }
});
/* ---------- passkeys (WebAuthn) helpers ---------- */
const toBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const credJson = (c) => ({
  id: c.id, rawId: toB64u(c.rawId), type: c.type,
  response: Object.fromEntries(['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature', 'userHandle']
    .filter((k) => c.response[k]).map((k) => [k, toB64u(c.response[k])])),
});
async function finishLogin(path, body) {
  try {
    await api(path, { method: 'POST', body });
    $('#mfaStep').hidden = true; $('#loginForm').hidden = false; $('#loginForm').reset();
    const me = await api('/api/admin/me');
    $('#adminWarn').hidden = me.adminWhatsappConfigured;
    showDash();
  } catch (err) {
    $('#loginError').textContent = errorText(err); $('#loginError').hidden = false;
    if (err.code === 'login_expired') { $('#mfaStep').hidden = true; $('#loginForm').hidden = false; }
  }
}
$('#passkeyLogin').addEventListener('click', async () => {
  const o = st.mfa.options;
  try {
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: toBuf(o.challenge), rpId: o.rpId, timeout: o.timeout, userVerification: o.userVerification,
      allowCredentials: o.allowCredentials.map((c) => ({ type: 'public-key', id: toBuf(c.id) })),
    } });
    await finishLogin('/api/admin/login/passkey', { token: st.mfa.token, credential: credJson(cred) });
  } catch (err) { if (err?.name !== 'NotAllowedError') { $('#loginError').textContent = errorText(err); $('#loginError').hidden = false; } }
});
$('#backupForm').addEventListener('submit', (e) => { e.preventDefault(); finishLogin('/api/admin/login/backup', { token: st.mfa.token, code: e.target.code.value }); });

$('#logoutBtn').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST', body: {} }).catch(() => {}); showLogin(); });

async function call(path, opts) {
  try { return await api(path, opts); }
  catch (err) { if (err.status === 401) { $('#dlg').close(); showLogin(); } throw err; }
}

/* ---------- dashboard ---------- */
async function loadStats() {
  const s = await call(`/api/admin/stats${st.country ? `?country=${st.country}` : ''}`);
  if (s.by_country) st.byCountry = s.by_country;
  if (st.byCountry) renderCountryBar(st.byCountry);   // stays visible while one country is selected
  renderKindTabs(s.by_kind || {});
  $('#msgCount').textContent = s.new_messages ? `(${s.new_messages})` : '';
  st.newFeedback = s.new_feedback;
  st.newSupport = s.new_support || 0;
  const items = [
    // totals over every category (each category's own numbers are on its tab)
    [Object.values(s.by_kind || {}).reduce((a, k) => a + k.active, 0), 'admin.stats.activeAll'],
    [Object.values(s.by_kind || {}).reduce((a, k) => a + k.pending, 0), 'admin.stats.pendingAll'],
    [s.pending_ads || 0, 'admin.stats.pendingAds'], [s.new_messages || 0, 'admin.stats.newMessages'],
    [s.new_feedback, 'admin.stats.feedback'], [s.new_support || 0, 'admin.stats.support'],
    [s.searches_30d, 'admin.stats.searches'], [s.whatsapp_clicks_30d, 'admin.stats.clicks'], [s.empty_searches_30d, 'admin.stats.empty'],
  ];
  $('#stats').innerHTML = items.map(([n, k]) => `<div class="stat"><b>${fmtNumber(n)}</b><span>${esc(t(k))}</span></div>`).join('');
  renderTabs();
}

function renderTabs() {
  $('#tabs').innerHTML = FILTERS.map((f) => {
    const label = f === 'feedback' ? t('admin.feedbackTab') : f === 'support' ? t('admin.supportTab') : t(`admin.filters.${f}`);
    const n = f === 'feedback' ? st.newFeedback : f === 'support' ? st.newSupport : 0;
    const badge = n ? `<em>${n}</em>` : '';
    return `<button type="button" role="tab" data-f="${f}" aria-selected="${f === st.filter}">${esc(label)}${badge}</button>`;
  }).join('');
}
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]');
  if (!b) return;
  st.filter = b.dataset.f;
  renderTabs();
  loadView();
});
/* ---------- categories (from the site settings) ---------- */
const activeCats = () => (st.config?.site?.categories || []);
const catName = (c, form = 'one') => {
  const l = document.documentElement.lang || 'ar';
  return c?.names?.[l]?.[form] || c?.names?.en?.[form] || c?.names?.ar?.[form] || c?.key || '';
};
const catByKey = (k) => activeCats().find((c) => c.key === k);
const addLabel = () => t('admin.addSubscriber', { name: catName(catByKey(st.kind) || { key: st.kind }) });
function renderKindTabs(byKind = {}) {
  $('#kindTabs').innerHTML = activeCats().map((c) => `<button type="button" data-kind="${esc(c.key)}" aria-selected="${c.key === st.kind}">
    ${esc(c.icon)} ${esc(catName(c, 'many'))}${byKind[c.key] ? ` <b class="tab-count">${byKind[c.key].active}${byKind[c.key].pending ? ` · +${byKind[c.key].pending}` : ''}</b>` : ''}</button>`).join('');
  $('#addBtn').textContent = addLabel();
}

$('#kindTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kind]');
  if (!b) return;
  st.kind = b.dataset.kind;
  document.querySelectorAll('#kindTabs [data-kind]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  $('#addBtn').textContent = addLabel();
  if (st.filter === 'support' || st.filter === 'feedback') st.filter = 'all';
  renderTabs();
  loadView();
});
$('#countryFilter').addEventListener('change', (e) => { st.country = e.target.value; loadView(); loadStats(); });

/* ---------- one country at a time: a flag for every country that has subscribers ---------- */
const flagOf = (c) => String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
const countryName = (c) => { try { return new Intl.DisplayNames([document.documentElement.lang || 'ar'], { type: 'region' }).of(c); } catch { return c; } };
function renderCountryBar(byCountry) {
  const codes = Object.keys(byCountry).sort((a, b) => byCountry[b] - byCountry[a]);
  if (st.country && !codes.includes(st.country)) codes.unshift(st.country);
  $('#countryBar').innerHTML = `<button type="button" data-cc="" class="${st.country ? '' : 'on'}">🌍 ${esc(t('admin.allCountries'))}</button>`
    + codes.map((c) => `<button type="button" data-cc="${c}" class="${st.country === c ? 'on' : ''}">${flagOf(c)} ${esc(countryName(c))} <b>${byCountry[c] || 0}</b></button>`).join('');
}
$('#countryBar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cc]'); if (!b) return;
  st.country = b.dataset.cc; $('#countryFilter').value = st.country;
  loadView(); loadStats();
});

/* ---------- referral links ---------- */
async function loadRefs() {
  const r = await call('/api/admin/referrers');
  const money = (n, c) => `${c === 'EUR' ? '€' : c === 'USD' ? '$' : ''}${Number(n).toFixed(2).replace(/\.00$/, '')}${['EUR', 'USD'].includes(c) ? '' : ` ${c}`}`;
  $('#refList').innerHTML = r.referrers.length ? r.referrers.map((x) => `<div class="text-item" data-ref="${x.id}">
      <p><b>${esc(x.name)}</b> ${x.country ? `· ${flagOf(x.country)}` : ''} · ${esc(t('admin.refPer', { amount: money(x.commission, x.currency) }))} ${x.active ? '' : `· <b>${esc(t('admin.refStopped'))}</b>`}</p>
      <p class="fine" dir="ltr">${esc(x.link)} <button class="btn-text" type="button" data-copy="${esc(x.link)}">${esc(t('admin.refCopy'))}</button></p>
      <p class="fine">${esc(t('admin.refStats', { n: x.subscribers, due: money(x.due, x.currency), paid: money(x.paid, x.currency) }))}</p>
      <p class="fine">${esc(t('admin.refCreated', { date: new Date(x.createdAt).toLocaleDateString(document.documentElement.lang || 'ar', { year: 'numeric', month: 'long', day: 'numeric' }) }))}</p>
      <p>${st.role === 'agent' ? '' : `${x.due > 0 ? `<button class="btn btn-gold" type="button" data-pay="${x.id}">${esc(t('admin.refPay', { due: money(x.due, x.currency) }))}</button>` : ''}
        <button class="btn-text" type="button" data-refactive="${x.id}" data-to="${x.active ? 0 : 1}">${esc(t(x.active ? 'admin.refStop' : 'admin.refResume'))}</button>
        <button class="btn-text danger" type="button" data-refdel="${x.id}">${esc(t('admin.rowDelete'))}</button>`}</p></div>`).join('')
    : `<p class="fine">${esc(t('admin.refNone'))}</p>`;
  const all = [...new Set([...(st.config.countries || [])])].sort((a, b) => countryName(a).localeCompare(countryName(b)));
  if (!$('#refCountry').options.length) $('#refCountry').innerHTML = all.map((c) => `<option value="${c}">${flagOf(c)} ${esc(countryName(c))}</option>`).join('');
}
$('#refPanel').addEventListener('toggle', (e) => { if (e.target.open) loadRefs(); });
$('#refAdd').addEventListener('click', async () => {
  try {
    const r = await call('/api/admin/referrers', { method: 'POST', body: { name: $('#refName').value, contact: $('#refContact').value,
      commission: $('#refCommission').value, currency: $('#refCurrency').value, country: st.role === 'agent' ? undefined : $('#refCountry').value } });
    $('#refMsg').textContent = t('admin.refAdded', { link: r.link }); $('#refName').value = ''; $('#refContact').value = '';
    loadRefs();
  } catch (err) { $('#refMsg').textContent = err.fields ? Object.values(err.fields).map((c) => t(`errors.${c}`)).join(' — ') : errorText(err); }
});
$('#refList').addEventListener('click', async (e) => {
  const cp = e.target.closest('[data-copy]'); const pay = e.target.closest('[data-pay]'); const act = e.target.closest('[data-refactive]');
  if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); cp.textContent = t('admin.refCopied'); } catch { prompt('', cp.dataset.copy); } return; }
  if (pay && confirm(t('admin.refPayConfirm'))) { await call(`/api/admin/referrers/${pay.dataset.pay}/pay`, { method: 'POST', body: {} }); loadRefs(); }
  if (act) { await call(`/api/admin/referrers/${act.dataset.refactive}`, { method: 'PATCH', body: { active: act.dataset.to === '1' } }); loadRefs(); }
  const del = e.target.closest('[data-refdel]');
  if (del && confirm(t('admin.refDeleteConfirm'))) { await call(`/api/admin/referrers/${del.dataset.refdel}`, { method: 'DELETE' }); loadRefs(); }
});

/* ---------- countries added by the owner + country agents ---------- */
async function loadCountries() {
  const [s, ag] = await Promise.all([call('/api/admin/settings'), call('/api/admin/agents')]);
  const extra = s.extraCountries || {};
  $('#ctList').innerHTML = Object.keys(extra).length ? Object.entries(extra).map(([c, d]) => `<p class="fine">${flagOf(c)} <b>${esc(countryName(c))}</b> · +${esc(d.dial)} · ${esc(d.currency)} · ${esc(d.lang)} · <span dir="ltr">${esc(d.timezone)}</span>
      <button class="btn-text danger" type="button" data-ctdel="${c}">${esc(t('admin.rowDelete'))}</button></p>`).join('') : `<p class="fine">${esc(t('admin.ctNone'))}</p>`;
  $('#agList').innerHTML = ag.agents.length ? ag.agents.map((a) => `<div class="ag-row${a.disabled ? ' off' : ''}">👤 <b dir="ltr">${esc(a.username)}</b> · ${flagOf(a.country)} ${esc(countryName(a.country))}
      ${a.disabled ? `<small>(${esc(t('admin.agStopped'))})</small>` : ''}<br>
      <button class="btn-text" type="button" data-ag="${a.id}" data-agdo="${a.disabled ? 'start' : 'stop'}">${esc(t(a.disabled ? 'admin.agStart' : 'admin.agStop'))}</button>
      <button class="btn-text" type="button" data-ag="${a.id}" data-agdo="pass">${esc(t('admin.agNewPass'))}</button>
      <button class="btn-text" type="button" data-ag="${a.id}" data-agdo="country">${esc(t('admin.agNewCountry'))}</button>
      <button class="btn-text danger" type="button" data-agdel="${a.id}">${esc(t('admin.rowDelete'))}</button></div>`).join('') : `<p class="fine">${esc(t('admin.agNone'))}</p>`;
  const all = [...new Set([...(st.config.countries || []), ...Object.keys(extra)])].sort((a, b) => countryName(a).localeCompare(countryName(b)));
  $('#agCountry').innerHTML = all.map((c) => `<option value="${c}">${flagOf(c)} ${esc(countryName(c))}</option>`).join('');
  if (!$('#tzList').options.length) { try { $('#tzList').innerHTML = Intl.supportedValuesOf('timeZone').map((z) => `<option value="${z}">`).join(''); } catch { /* old browser */ } }
}
$('#countriesPanel').addEventListener('toggle', (e) => { if (e.target.open) loadCountries(); });
$('#ctSave').addEventListener('click', async () => {
  const code = $('#ctCode').value.trim().toUpperCase();
  const s = await call('/api/admin/settings');
  const extra = { ...(s.extraCountries || {}), [code]: { dial: $('#ctDial').value.replace(/\D/g, ''), trunk: $('#ctTrunk').checked ? '0' : '',
    nsn: $('#ctLen').value.split(/[ ,،]+/).map(Number).filter(Boolean), currency: $('#ctCur').value.trim().toUpperCase(), lang: $('#ctLang').value, timezone: $('#ctTz').value.trim() } };
  try {
    await call('/api/admin/settings', { method: 'PUT', body: { extraCountries: extra } });
    st.config = await api('/api/config');
    $('#ctMsg').textContent = t('admin.ctSaved', { name: countryName(code) });
    loadCountries();
  } catch (err) { $('#ctMsg').textContent = err.fields ? t('admin.ctInvalid') : errorText(err); }
});
$('#countriesPanel').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-agdo]');
  if (act) {
    const id = act.dataset.ag, what = act.dataset.agdo;
    const body = what === 'stop' ? { disabled: true } : what === 'start' ? { disabled: false }
      : what === 'pass' ? { password: prompt(t('admin.agPassPrompt')) || '' } : { country: (prompt(t('admin.agCountryPrompt')) || '').trim().toUpperCase() };
    if ((what === 'pass' && !body.password) || (what === 'country' && !body.country)) return;
    try { await call(`/api/admin/agents/${id}`, { method: 'PATCH', body }); $('#ctMsg').textContent = t('admin.saved'); }
    catch (err) { $('#ctMsg').textContent = err.fields ? Object.values(err.fields).map((c) => t(`errors.${c}`)).join(' — ') : errorText(err); }
    return loadCountries();
  }
  const cd = e.target.closest('[data-ctdel]'); const ad = e.target.closest('[data-agdel]');
  if (!cd && !ad) return;
  if (!confirm(t('admin.rowDeleteConfirm'))) return;
  if (cd) { const s = await call('/api/admin/settings'); const extra = { ...(s.extraCountries || {}) }; delete extra[cd.dataset.ctdel]; await call('/api/admin/settings', { method: 'PUT', body: { extraCountries: extra } }); }
  if (ad) await call(`/api/admin/agents/${ad.dataset.agdel}`, { method: 'DELETE' });
  loadCountries();
});
$('#agAdd').addEventListener('click', async () => {
  try {
    await call('/api/admin/agents', { method: 'POST', body: { username: $('#agUser').value, password: $('#agPass').value, country: $('#agCountry').value } });
    $('#ctMsg').textContent = t('admin.agAdded'); $('#agUser').value = ''; $('#agPass').value = '';
    loadCountries();
  } catch (err) { $('#ctMsg').textContent = err.fields ? Object.values(err.fields).map((c) => t(`errors.${c}`)).join(' — ') : errorText(err); }
});
let qTimer;
$('#q').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { st.q = e.target.value; loadView(); }, 250); });

function loadView() {
  const fb = st.filter === 'feedback';
  const sup = st.filter === 'support';
  $('#feedbackView').hidden = !fb;
  $('#supportView').hidden = !sup;
  $('#list').hidden = fb || sup;
  if (sup) { $('#moreBtn').hidden = true; $('#listTotal').textContent = ''; $('#emptyList').hidden = true; return loadSupport(); }
  $('#moreBtn').hidden = true;
  $('#listTotal').textContent = '';
  $('#emptyList').hidden = true;
  return fb ? loadFeedback() : loadList();
}

const rowHtml = (c) => `
    <li><button class="admin-row" type="button" data-id="${c.id}">
      <span>
        <span class="cook-name">${esc(c.fullName)}${c.hidden ? ` <span class="pill suspended">${esc(t('admin.hiddenBadge'))}</span>` : ''}</span>
        <span class="cook-meta">${c.country ? `${esc(c.country)} · ` : ''}${esc(c.area)} — <span dir="ltr">+${esc(c.whatsapp)}</span></span>
        <span class="cook-meta">${starsHtml(c.rating)} ${c.warnings ? ` · ${esc(t('admin.warningsCount', { n: c.warnings }))}` : ''} ${c.openFeedback ? ` · <b class="warn">${esc(t('admin.openFeedback', { n: c.openFeedback }))}</b>` : ''}</span>
      </span>
      <span class="nums">
        ${pill(c.effectiveStatus)}<br>
        ${c.expiryDate ? esc(t('admin.expires', { date: fmtDate(c.expiryDate) })) : c.requestedPlan ? esc(t(`plans.${c.requestedPlan}`)) : ''}<br>
        ${esc(t('admin.impressions'))}: ${c.impressions} — WhatsApp: ${c.whatsappClicks}
      </span>
    </button>
    <span class="row-acts">
      <button class="btn-text" type="button" data-quick="${c.hidden ? 'unhide' : 'hide'}" data-qid="${c.id}">${esc(t(c.hidden ? 'admin.unhide' : 'admin.hide'))}</button>
      <button class="btn-text" type="button" data-quick="${c.verified ? 'unverify' : 'verify'}" data-qid="${c.id}">${c.verified ? '✓ ' : ''}${esc(t(c.verified ? 'admin.unverify' : 'admin.verify'))}</button>
      <button class="btn-text" type="button" data-quick="report" data-qid="${c.id}">📊 ${esc(t('admin.sendReport'))}</button>
      <button class="btn-text danger" type="button" data-quick="delete" data-qid="${c.id}">${esc(t('admin.rowDelete'))}</button>
    </span></li>`;

// 50 at a time; "show more" loads the next page.
async function loadList(append = false) {
  // "imported" tab: one button to delete every imported place of this category in this country
  const delAll = document.getElementById('delImported');
  if (delAll) delAll.hidden = !(st.filter === 'imported' && st.kind && st.country && st.role !== 'agent');
  $('#exportCsv').href = `/api/admin/export/subscribers.csv${st.country ? `?country=${st.country}` : ''}`;
  if (!append) st.offset = 0;
  const r = await call(`/api/admin/cooks?filter=${st.filter}&kind=${st.kind}&country=${st.country}&q=${encodeURIComponent(st.q)}&limit=50&offset=${st.offset}`);
  st.offset += r.cooks.length;
  $('#emptyList').hidden = r.total > 0;
  $('#listTotal').textContent = r.total ? t('admin.totalCount', { n: r.total }) : '';
  const html = r.cooks.map(rowHtml).join('');
  if (append) $('#list').insertAdjacentHTML('beforeend', html); else $('#list').innerHTML = html;
  $('#moreBtn').hidden = !r.hasMore;
}
$('#moreBtn').addEventListener('click', () => loadList(true));
$('#list').addEventListener('click', async (e) => {
  // quick actions right in the list (no need to open the subscriber)
  const q = e.target.closest('[data-quick]');
  if (q) {
    e.stopPropagation();
    const id = Number(q.dataset.qid), act = q.dataset.quick;
    if (act === 'delete' && !confirm(t('admin.rowDeleteConfirm'))) return;
    try {
      if (act === 'report') { const r = await call(`/api/admin/cooks/${id}/report`); if (r.whatsappUrl) window.open(r.whatsappUrl, '_blank'); else alert(r.text); return; }
      if (act === 'delete') await call(`/api/admin/cooks/${id}`, { method: 'DELETE' });
      else if (act === 'verify' || act === 'unverify') await call(`/api/admin/cooks/${id}/verify`, { method: 'POST', body: { on: act === 'verify' } });
      else await call(`/api/admin/cooks/${id}/${act}`, { method: 'POST', body: {} });
      loadList(); loadStats();
    } catch (err) { alert(errorText(err)); }
    return;
  }
  const b = e.target.closest('[data-id]'); if (b) openCook(Number(b.dataset.id));
});
$('#addBtn').addEventListener('click', () => openNew());

/* ---------- complaints & notes ---------- */
async function loadFeedback() {
  $('#fbTabs').innerHTML = [['new', 'admin.newFeedback'], ['resolved', 'admin.resolved'], ['all', 'admin.allFeedback']]
    .map(([k, l]) => `<button type="button" data-s="${k}" aria-selected="${k === st.fbStatus}">${esc(t(l))}</button>`).join('');
  const { feedback } = await call(`/api/admin/feedback?status=${st.fbStatus}`);
  $('#fbEmpty').hidden = feedback.length > 0;
  $('#fbList').innerHTML = feedback.map((f) => `
    <li class="fb-item">
      <div class="fb-head"><span class="pill ${f.kind === 'complaint' ? 'expired' : 'active'}">${esc(t(`admin.${f.kind}`))}</span>
        <button class="btn-text" type="button" data-cook="${f.cook_id}">${esc(f.cook_name)}</button>
        <span class="fine">${fmtDate(f.created_at)}${f.cook_warnings ? ` · ${esc(t('admin.warningsCount', { n: f.cook_warnings }))}` : ''}</span></div>
      <p class="fb-msg">${esc(f.message)}</p>
      <p class="fine">${esc(t('admin.customer'))}: ${esc(f.customer_name || '—')} ${f.customer_phone ? `· <a dir="ltr" href="https://wa.me/${esc(f.customer_phone)}" target="_blank" rel="noopener">+${esc(f.customer_phone)}</a>` : ''}</p>
      ${f.admin_note ? `<p class="fine">${esc(t('admin.adminNote'))}: ${esc(f.admin_note)}</p>` : ''}
      <div class="actions">
        <button class="btn btn-danger" type="button" data-warn="${f.id}" data-cookid="${f.cook_id}" data-name="${esc(f.cook_name)}" data-msg="${esc(f.message)}" data-n="${f.cook_warnings + 1}">${esc(t('admin.warn'))}</button>
        <button class="btn btn-ghost" type="button" data-fb="${f.id}" data-to="${f.status === 'new' ? 'resolved' : 'new'}">${esc(t(f.status === 'new' ? 'admin.resolve' : 'admin.reopen'))}</button>
      </div>
    </li>`).join('');
}
$('#fbTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (b) { st.fbStatus = b.dataset.s; loadFeedback(); } });
$('#fbList').addEventListener('click', async (e) => {
  const cookBtn = e.target.closest('[data-cook]');
  if (cookBtn) return openCook(Number(cookBtn.dataset.cook));
  const fbBtn = e.target.closest('[data-fb]');
  if (fbBtn) { await call(`/api/admin/feedback/${fbBtn.dataset.fb}`, { method: 'PATCH', body: { status: fbBtn.dataset.to } }); loadFeedback(); loadStats(); return; }
  const w = e.target.closest('[data-warn]');
  if (w) openWarning({ cookId: Number(w.dataset.cookid), name: w.dataset.name, message: w.dataset.msg, n: Number(w.dataset.n), feedbackId: Number(w.dataset.warn) });
});

/* ---------- dialog ---------- */
const dlg = $('#dlg');
$('#dlgClose').addEventListener('click', () => dlg.close());
dlg.addEventListener('close', () => { loadView(); loadStats(); });
function msg(text, ok = true) { const m = $('#dlgMsg'); m.textContent = text; m.className = `alert ${ok ? 'ok' : ''}`; m.hidden = !text; if (text) m.scrollIntoView({ block: 'nearest' }); }
function errMsg(err) {
  const fields = Object.entries(err.fields || {}).map(([k, v]) => `${k}: ${t(`errors.${v}`)}`).join(' — ');
  msg(`${errorText(err)}${fields ? ' — ' + fields : ''}`, false);
}

async function openWarning({ cookId, name, message, n, feedbackId }) {
  msg('');
  $('#dlgTitle').textContent = `${t('admin.warn')} — ${name}`;
  const text = await warningText(st.current?.locale, { name, message: message || '…', n });
  $('#dlgBody').innerHTML = `<div class="panel"><form id="warnForm">
    <div class="field"><textarea class="input" name="message" rows="9">${esc(text)}</textarea></div>
    <button class="btn btn-danger" type="submit">${esc(t('admin.warnSend'))}</button></form></div>`;
  $('#warnForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await call(`/api/admin/cooks/${cookId}/warnings`, { method: 'POST', body: { message: e.target.message.value, feedbackId: feedbackId || undefined } });
      window.open(r.whatsappUrl, '_blank', 'noopener');
      await openCook(cookId);
      msg(t('admin.saved'));
    } catch (err) { errMsg(err); }
  });
  if (!dlg.open) dlg.showModal();
}

function buildForm(cook) {
  const frag = $('#cookFormTpl').content.cloneNode(true);
  const form = $('form', frag);
  applyI18n(frag);
  let homeId = cook?.area_id || null;
  const formKind = cook?.kind || st.kind;
  $('[data-specialty-field]', form).hidden = formKind === 'cook';
  $('[data-services-field]', form).hidden = formKind !== 'cook';
  form.specialty.value = cook?.specialty || '';
  $('[data-services]', form).innerHTML = st.config.serviceTypes.map((k) =>
    `<label class="chip"><input type="checkbox" name="services" value="${k}" ${cook?.services?.includes(k) ? 'checked' : ''}><span>${esc(t(`services.${k}`))}</span></label>`).join('');
  const editor = servedAreasEditor($('[data-served]', form), { initial: cook?.servedAreas || [], point: cook ? { lat: cook.lat, lng: cook.lng } : null, districts: st.config.districts });
  const homeLabel = $('[data-home]', form);
  homeLabel.textContent = cook ? t('location.picked', { area: cook.area_label }) : '';
  areaSearch(form.areaSearch, { onPick: (a) => { homeId = a.id; homeLabel.textContent = t('location.picked', { area: a.name }); editor.setPoint(a.lat, a.lng).catch(() => {}); } });
  // Any address in the world (Geoapify on the server): sets the exact point, then shows the towns around it.
  let placeTimer;
  form.placeSearch.addEventListener('input', () => {
    clearTimeout(placeTimer);
    const q = form.placeSearch.value.trim();
    const box = $('[data-place-results]', form);
    if (q.length < 2) { box.innerHTML = ''; return; }
    placeTimer = setTimeout(async () => {
      const r = await call(`/api/admin/geocode?q=${encodeURIComponent(q)}`).catch(() => ({ places: [] }));
      box.innerHTML = r.places.map((p, i) => `<button type="button" class="place-item" data-pi="${i}">📍 ${esc(p.name)}</button>`).join('');
      box.querySelectorAll('[data-pi]').forEach((b) => b.addEventListener('click', async () => {
        const p = r.places[Number(b.dataset.pi)];
        form.lat.value = Number(p.lat).toFixed(5); form.lng.value = Number(p.lng).toFixed(5);
        $('[data-place-picked]', form).textContent = t('admin.placePicked', { name: p.name });
        box.innerHTML = '';
        await editor.setPoint(p.lat, p.lng).catch(() => {});
        try {
          const near = await call(`/api/areas/nearest?lat=${p.lat}&lng=${p.lng}`);
          if (near.area) { homeId = near.area.id; homeLabel.textContent = t('location.picked', { area: near.area.name }); }
        } catch { /* optional */ }
      }));
    }, 350);
  });
  if (cook) {
    form.fullName.value = cook.full_name;
    form.whatsapp.value = '+' + cook.whatsapp;
    form.lat.value = cook.lat; form.lng.value = cook.lng;
    form.bio.value = cook.bio || '';
    form.adminNotes.value = cook.admin_notes || '';
    if (cook.has_photo) {
      $('[data-photo-field]', form).hidden = false;
      $('[data-photo]', form).src = `/api/admin/cooks/${cook.id}/photo?ts=${Date.now()}`;
    }
  } else {
    $('[data-activate-block]', form).hidden = false;
  }
  $('[data-submit]', form).textContent = t(cook ? 'admin.save' : 'admin.create');
  let removePhoto = false;
  $('[data-photo-remove]', form)?.addEventListener('click', () => { removePhoto = true; $('[data-photo-field]', form).hidden = true; });
  form.readBody = () => {
    const b = {
      fullName: form.fullName.value, whatsapp: form.whatsapp.value, areaId: homeId,
      bio: form.bio.value, adminNotes: form.adminNotes.value,
      services: [...form.querySelectorAll('input[name="services"]:checked')].map((i) => i.value),
      servedAreaIds: editor.ids(),
      ...(formKind !== 'cook' ? { specialty: form.specialty.value } : {}),
      ...(!cook ? { kind: formKind } : {}),
    };
    const latChanged = cook && (String(form.lat.value) !== String(cook.lat) || String(form.lng.value) !== String(cook.lng));
    if ((!cook || latChanged) && form.lat.value !== '' && form.lng.value !== '') { b.lat = Number(form.lat.value); b.lng = Number(form.lng.value); }
    if (removePhoto) b.photo = null;
    return b;
  };
  return form;
}

function subscriptionPanel(c) {
  const s = c.subscription;
  const planOpts = st.config.plans.map((p) => `<option value="${p}" ${p === (s?.plan || c.requested_plan) ? 'selected' : ''}>${esc(t(`plans.${p}`))}</option>`).join('');
  const payOpts = ['paid', 'unpaid', 'waived'].map((p) => `<option value="${p}" ${p === (s?.payment_status === 'unpaid' ? 'paid' : s?.payment_status || 'paid') ? 'selected' : ''}>${esc(t(`payment.${p}`))}</option>`).join('');
  return `
  <div class="panel">
    <h3>${esc(t('admin.subscription'))}</h3>
    ${s ? `<dl class="kv">
      <dt>${esc(t('admin.status'))}</dt><dd>${pill(c.effectiveStatus)}</dd>
      <dt>${esc(t('admin.plan'))}</dt><dd>${esc(t(`plans.${s.plan}`))}</dd>
      <dt>${esc(t('admin.paymentStatus'))}</dt><dd>${esc(t(`payment.${s.payment_status}`))}</dd>
      <dt>${esc(t('admin.startDate'))}</dt><dd>${fmtDate(s.start_date)}</dd>
      <dt>${esc(t('admin.expiryDate'))}</dt><dd>${fmtDate(s.expiry_date)}</dd>
    </dl>` : `<p class="fine">${esc(t('admin.noSubscription'))}</p>`}
    <form id="subForm">
      <div class="grid2">
        <div class="field"><label>${esc(t('admin.plan'))}</label><select class="input" name="plan">${planOpts}</select></div>
        <div class="field"><label>${esc(t('admin.paymentStatus'))}</label><select class="input" name="paymentStatus">${payOpts}</select></div>
      </div>
      <div class="grid2">
        <div class="field"><label>${esc(t('admin.startDate'))}</label><input class="input" type="date" name="startDate" value="${dateOnly(s?.start_date) || dateOnly(new Date())}"></div>
        <div class="field"><label>${esc(t('admin.expiryDate'))}</label><input class="input" type="date" name="expiryDate" value="${dateOnly(s?.expiry_date)}"><span class="hint">${esc(t('admin.expiryAuto'))}</span></div>
      </div>
      <div class="actions">
        <button class="btn btn-gold" type="button" data-act="activate">${esc(t('admin.activate'))}</button>
        ${s ? `<button class="btn btn-ghost" type="button" data-act="renew">${esc(t('admin.renew'))}</button>
        <button class="btn btn-ghost" type="button" data-act="saveDates">${esc(t('admin.saveDates'))}</button>
        <button class="btn btn-danger" type="button" data-act="suspend">${esc(t('admin.suspend'))}</button>
        <button class="btn btn-danger" type="button" data-act="expire">${esc(t('admin.expireNow'))}</button>` : ''}
      </div>
    </form>
  </div>`;
}

async function openCook(id) {
  msg('');
  let c;
  try { c = await call(`/api/admin/cooks/${id}`); } catch { return; }
  st.current = c;
  $('#dlgTitle').textContent = c.full_name;
  const r = c.stats.rating;
  $('#dlgBody').innerHTML = `
    <div class="panel">
      <dl class="kv">
        <dt>${esc(t('admin.status'))}</dt><dd>${pill(c.effectiveStatus)}</dd>
        <dt>WhatsApp</dt><dd><a dir="ltr" href="https://wa.me/${esc(c.whatsapp)}" target="_blank" rel="noopener">+${esc(c.whatsapp)}</a></dd>
        <dt>${esc(t('admin.ratingLabel'))}</dt><dd>${starsHtml(r)}</dd>
        <dt>${esc(t('account.views'))}</dt><dd>${c.stats.views_total}</dd>
        <dt>${esc(t('account.likes'))}</dt><dd>${c.stats.likes}</dd>
        <dt>${esc(t('admin.impressions'))}</dt><dd>${c.stats.impressions}</dd>
        <dt>${esc(t('admin.clicks'))}</dt><dd>${c.stats.whatsapp_clicks}</dd>
        ${c.requested_plan ? `<dt>${esc(t('admin.requestedPlan'))}</dt><dd>${esc(t(`plans.${c.requested_plan}`))}</dd>` : ''}
        <dt>${esc(t('admin.createdAt'))}</dt><dd>${fmtDate(c.created_at)}</dd>
      </dl>
      <div class="actions">
        ${c.status !== 'approved' ? `<button class="btn btn-ghost" type="button" data-act="approve">${esc(t('admin.approve'))}</button>` : ''}
        ${c.status !== 'rejected' ? `<button class="btn btn-danger" type="button" data-act="reject">${esc(t('admin.reject'))}</button>` : ''}
        <a class="btn btn-ghost" href="/c/${c.id}" target="_blank" rel="noopener">${esc(t('results.viewProfile'))}</a>
        ${Number(c.is_hidden) ? `<button class="btn btn-gold" type="button" data-act="unhide">${esc(t('admin.unhide'))}</button>`
          : `<button class="btn btn-ghost" type="button" data-act="hide">${esc(t('admin.hide'))}</button>`}
      </div>
      ${Number(c.is_hidden) ? `<p class="alert">${esc(t('admin.hiddenNote'))}</p>` : ''}
    </div>
    ${subscriptionPanel(c)}
    <div class="panel">
      <h3>${esc(t('account.loginTitle'))}</h3>
      <p class="fine">${esc(t(c.has_password ? 'admin.hasPassword' : 'admin.noPassword'))}</p>
      <p class="fine" id="pwOut"></p>
      <button class="btn btn-gold" type="button" data-act="password">${esc(t('admin.passwordBtn'))}</button>
      <button class="btn btn-ghost" type="button" data-act="trial">${esc(t('admin.trialBtn', { days: trialDays(c) }))}</button>
      <button class="btn btn-ghost" type="button" data-act="support">${esc(t('admin.supportTab'))}${c.unreadSupport ? ` (${c.unreadSupport})` : ''}</button>
    </div>
    <div class="panel">
      <h3>${esc(t('admin.warningsTitle'))} (${c.warnings.length})</h3>
      ${c.warnings.map((w) => `<p class="fine">${fmtDate(w.created_at)} — ${esc(w.message.slice(0, 140))}${w.message.length > 140 ? '…' : ''}</p>`).join('')}
      <button class="btn btn-danger" type="button" data-act="warn">${esc(t('admin.warn'))}</button>
    </div>
    <div class="panel">
      ${c.specialty ? `<p class="fine"><b>${esc(t('admin.specialty'))}:</b> ${esc(c.specialty || '—')}</p>
        <h3>${esc(t('admin.menuTitle'))} (${c.menu.length})</h3>
        ${c.menu.map((it) => `<p class="fine review-row">${esc(it.name)}${it.price != null ? ` — ${it.price} ${esc(it.currency || '')}` : ''} ${it.available ? '' : esc(t('admin.hiddenItem'))}
          <button class="btn-text" type="button" data-delitem="${it.id}">${esc(t('admin.deletePhoto'))}</button></p>`).join('')}
        <form class="menu-add" data-menuadd>
          <input class="input" name="name" maxlength="80" required placeholder="${esc(t('admin.menuName'))}">
          <input class="input" name="price" type="number" min="0" step="0.01" dir="ltr" placeholder="${esc(t('admin.menuPrice'))}">
          <button class="btn btn-ghost" type="submit">${esc(t('admin.addMenuItem'))}</button></form>` : ''}
      <h3>${esc(t('admin.photosTitle'))} (${c.photos.length})</h3>
      <input class="sr-only" type="file" id="adminPhotoFile" accept="image/*">
      <label class="btn btn-ghost" for="adminPhotoFile">${esc(t('admin.addPhoto'))}</label>
      <div class="photo-grid">${c.photos.map((p) => `<figure${p.hidden ? ' class="is-hidden"' : ''}><img src="${esc(p.url)}" alt="">
        <button class="del" type="button" data-delphoto="${p.id}">${esc(t('admin.deletePhoto'))}</button>
        <button class="del del-2" type="button" data-hidephoto="${p.id}" data-hidden="${p.hidden ? 0 : 1}">${esc(t(p.hidden ? 'admin.showItem' : 'admin.hideItem'))}</button>
        <figcaption>${esc(p.caption)} ${p.hidden ? esc(t('admin.hiddenItem')) : ''}</figcaption></figure>`).join('')}</div>
    </div>
    <div class="panel">
      <h3>${esc(t('admin.reviewsTitle'))} (${c.reviews.length})</h3>
      ${c.reviews.map((r) => `<p class="fine review-row">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)} — ${fmtDate(r.createdAt)} ${r.hidden ? esc(t('admin.hiddenItem')) : ''}
        <button class="btn-text" type="button" data-hidereview="${r.id}" data-hidden="${r.hidden ? 0 : 1}">${esc(t(r.hidden ? 'admin.showItem' : 'admin.hideItem'))}</button></p>`).join('')}
    </div>
    <div class="panel danger-zone">
      <button class="btn btn-danger" type="button" data-act="delete">${esc(t('admin.deleteAccount'))}</button>
    </div>
    <div class="panel"><h3>${esc(t('admin.info'))}</h3><div id="editSlot"></div></div>`;
  const form = buildForm(c);
  $('#editSlot').appendChild(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await call(`/api/admin/cooks/${c.id}`, { method: 'PATCH', body: form.readBody() }); await openCook(c.id); msg(t('admin.saved')); }
    catch (err) { errMsg(err); }
  });
  $('#dlgBody').querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => act(b.dataset.act)));
  $('#dlgBody').querySelectorAll('[data-delitem]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(t('account.confirmDelete'))) return;
    await call(`/api/admin/menu/${b.dataset.delitem}`, { method: 'DELETE' });
    await openCook(c.id);
  }));
  $('#dlgBody').querySelectorAll('[data-hidephoto]').forEach((b) => b.addEventListener('click', async () => {
    await call(`/api/admin/photos/${b.dataset.hidephoto}`, { method: 'PATCH', body: { hidden: b.dataset.hidden === '1' } });
    await openCook(c.id);
  }));
  $('#dlgBody').querySelectorAll('[data-hidereview]').forEach((b) => b.addEventListener('click', async () => {
    await call(`/api/admin/reviews/${b.dataset.hidereview}`, { method: 'PATCH', body: { hidden: b.dataset.hidden === '1' } });
    await openCook(c.id);
  }));
  $('#dlgBody').querySelectorAll('[data-delphoto]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(t('account.confirmDelete'))) return;
    await call(`/api/admin/photos/${b.dataset.delphoto}`, { method: 'DELETE' });
    await openCook(c.id);
  }));
  if (!dlg.open) dlg.showModal();
}

async function act(action) {
  const c = st.current;
  if (action === 'warn') return openWarning({ cookId: c.id, name: c.full_name, message: '', n: c.warnings.length + 1 });
  if (action === 'trial') {
    try { await call(`/api/admin/cooks/${c.id}/subscription/trial`, { method: 'POST', body: {} }); await openCook(c.id); msg(t('admin.saved')); }
    catch (err) { errMsg(err); }
    return;
  }
  if (action === 'support') return openSupport(c.id, c.full_name);
  if (action === 'hide' || action === 'unhide') {
    if (action === 'hide' && !confirm(t('admin.confirmHide'))) return;
    try { await call(`/api/admin/cooks/${c.id}/${action}`, { method: 'POST', body: {} }); await openCook(c.id); msg(t('admin.saved')); }
    catch (err) { errMsg(err); }
    return;
  }
  if (action === 'delete') {
    if (!confirm(t('admin.confirmDeleteSimple'))) return;
    try { await call(`/api/admin/cooks/${c.id}`, { method: 'DELETE' }); dlg.close(); loadView(); loadStats(); }
    catch (err) { errMsg(err); }
    return;
  }
  if (action === 'password') {
    try {
      const r = await call(`/api/admin/cooks/${c.id}/password`, { method: 'POST', body: {} });
      $('#pwOut').textContent = t('admin.passwordSet', { p: r.password });
      window.open(r.whatsappUrl, '_blank', 'noopener');
    } catch (err) { errMsg(err); }
    return;
  }
  const f = $('#subForm');
  const sub = { plan: f.plan.value, paymentStatus: f.paymentStatus.value, startDate: f.startDate.value || undefined, expiryDate: f.expiryDate.value || undefined };
  const confirms = { reject: 'admin.confirmReject', suspend: 'admin.confirmSuspend', expire: 'admin.confirmExpire' };
  if (confirms[action] && !confirm(t(confirms[action]))) return;
  const base = `/api/admin/cooks/${c.id}`;
  const req = {
    approve: [`${base}/approve`, 'POST', {}],
    reject: [`${base}/reject`, 'POST', {}],
    activate: [`${base}/subscription/activate`, 'POST', sub],
    renew: [`${base}/subscription/renew`, 'POST', { plan: sub.plan, paymentStatus: sub.paymentStatus }],
    saveDates: [`${base}/subscription`, 'PATCH', { plan: sub.plan, paymentStatus: sub.paymentStatus, startDate: sub.startDate, expiryDate: sub.expiryDate }],
    suspend: [`${base}/subscription/suspend`, 'POST', {}],
    expire: [`${base}/subscription/expire`, 'POST', {}],
  }[action];
  try { await call(req[0], { method: req[1], body: req[2] }); await openCook(c.id); msg(t('admin.saved')); }
  catch (err) { errMsg(err); }
}

function openNew() {
  msg('');
  st.current = null;
  $('#dlgTitle').textContent = addLabel();
  $('#dlgBody').innerHTML = '<div class="panel" id="newSlot"></div>';
  const form = buildForm(null);
  $('#newSlot').appendChild(form);
  const planSel = st.config.plans.map((p) => `<option value="${p}">${esc(t(`plans.${p}`))}</option>`).join('');
  $('[data-activate-block]', form).insertAdjacentHTML('beforeend',
    `<div class="grid2"><div class="field"><label>${esc(t('admin.plan'))}</label><select class="input" name="plan">${planSel}</select></div>
     <div class="field"><label>${esc(t('admin.startDate'))}</label><input class="input" type="date" name="startDate" value="${dateOnly(new Date())}"></div></div>`);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = form.readBody();
    if (form.activateNow.checked) b.activate = { plan: form.plan.value, startDate: form.startDate.value, paymentStatus: 'paid' };
    try { const c = await call('/api/admin/cooks', { method: 'POST', body: b }); await openCook(c.id); msg(t('admin.saved')); }
    catch (err) { errMsg(err); }
  });
  dlg.showModal();
}

$('#areaForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await call('/api/admin/areas', { method: 'POST', body: { nameAr: f.nameAr.value, district: f.district.value, lat: f.lat.value || undefined, lng: f.lng.value || undefined } });
    f.reset();
    $('#areaMsg').textContent = t('admin.areaAdded');
  } catch (err) { $('#areaMsg').textContent = errorText(err); }
});

/* ---------- import all villages of the country ---------- */
let importTimer = null;
async function showImport() {
  const r = await call(`/api/admin/areas/import?country=${$('#importCountry').value}`);
  const el = $('#importStatus');
  const vars = { found: r.found, added: r.added, total: r.totalAreas, error: r.error };
  el.textContent = t({ running: 'admin.importRunning', done: 'admin.importDone', failed: 'admin.importFailed' }[r.state] || 'admin.importNever', vars);
  $('#importBtn').disabled = r.state === 'running';
  clearTimeout(importTimer);
  if (r.state === 'running') importTimer = setTimeout(showImport, 5000);
}
$('#importPanel').addEventListener('toggle', (e) => { if (e.target.open) showImport(); });
$('#importBtn').addEventListener('click', async () => {
  await call('/api/admin/areas/import', { method: 'POST', body: { country: $('#importCountry').value } });
  showImport();
});

/* ---------- whole-site settings ---------- */
async function loadSettings() {
  const r = await call('/api/admin/settings');
  const f = $('#settingsForm');
  f.brandName.value = r.brandName || '';
  f.brandName.placeholder = r.effectiveBrand?.name || '';
  f.brandNameEn.value = r.brandNameEn || '';
  f.brandNameEn.placeholder = r.effectiveBrand?.nameEn || '';
  f.announcement.value = r.announcement || '';
  f.adminWhatsapp.value = r.adminWhatsapp ? '+' + r.adminWhatsapp : '';
  f.adminWhatsapp.placeholder = r.effectiveAdminWhatsapp ? '+' + r.effectiveAdminWhatsapp : '';
  for (const k of ['nearby', 'regions', 'dishes', 'nameSearch', 'cooksSlider', 'restaurants', 'dailyCounters']) f[`sec_${k}`].checked = r.sections?.[k] !== false;
  f.sec_globalCounters.checked = !!r.sections?.globalCounters;
  st.settings = r;
  // prices: one table per kind (plans × USD/EUR)
  $('#pricesGrid').innerHTML = activeCats().map((c) => c.key).map((kind) => `
    <p class="label">${esc(catByKey(kind)?.icon || '')} ${esc(catName(catByKey(kind), 'many'))}</p>
    <div class="price-table">${st.config.plans.map((plan) => `
      <span>${esc(t(`plans.${plan}`))}</span>
      <input class="input" type="number" min="0" step="0.01" dir="ltr" placeholder="USD" data-price="${kind}.${plan}.usd" value="${r.prices?.[kind]?.[plan]?.usd ?? ''}">
      <input class="input" type="number" min="0" step="0.01" dir="ltr" placeholder="EUR" data-price="${kind}.${plan}.eur" value="${r.prices?.[kind]?.[plan]?.eur ?? ''}">`).join('')}
    </div>`).join('');
  $('#trialGrid').innerHTML = activeCats().map((c) => c.key).map((kind) => `
    <div class="field"><span class="label">${esc(catByKey(kind)?.icon || '')} ${esc(catName(catByKey(kind), 'many'))}</span>
      <label class="chip"><input type="checkbox" data-trial-on="${kind}" ${r.trial?.[kind]?.enabled ? 'checked' : ''}><span>${esc(t('admin.trialEnabled'))}</span></label>
      <label class="fine">${esc(t('admin.trialDays'))} <input class="input" type="number" min="1" max="365" dir="ltr" data-trial-days="${kind}" value="${r.trial?.[kind]?.days ?? 14}"></label>
    </div>`).join('');
  f.appAndroid.value = r.appLinks?.android || '';
  document.querySelectorAll('[data-planshow]').forEach((x) => { x.checked = !(r.plansHidden || []).includes(x.dataset.planshow); });
  document.querySelectorAll('[data-groupshow]').forEach((x) => { x.checked = !(r.groupsHidden || []).includes(x.dataset.groupshow); });
  // 📅 pre-booking add-on: on/off + monthly price per category (0 = free)
  $('#bkEnabled').checked = r.booking?.enabled !== false;
  $('#bkPrices').innerHTML = (r.categories || []).filter((c) => !c.deleted).map((c) => `<div class="field"><label>${esc(c.icon)} ${esc(catName(c, 'many'))}</label>
    <input class="input" type="number" min="0" step="0.5" dir="ltr" data-bkprice="${esc(c.key)}" value="${Number(r.booking?.prices?.[c.key] || 0)}"></div>`).join('');
  f.adWeekUsd.value = r.adPrices?.week?.usd ?? ''; f.adWeekEur.value = r.adPrices?.week?.eur ?? '';
  f.adMonthUsd.value = r.adPrices?.month?.usd ?? ''; f.adMonthEur.value = r.adPrices?.month?.eur ?? '';
  f.appIos.value = r.appLinks?.ios || '';
  f.lim_cookPhotos.value = r.limits?.cookPhotos ?? 12;
  f.lim_restaurantPhotos.value = r.limits?.restaurantPhotos ?? 30;
  f.lim_menuItems.value = r.limits?.menuItems ?? 150;
}
$('#settingsPanel').addEventListener('toggle', (e) => { if (e.target.open) loadSettings(); });
$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const sections = {};
  for (const k of ['nearby', 'regions', 'dishes', 'nameSearch', 'cooksSlider', 'restaurants', 'globalCounters', 'dailyCounters']) sections[k] = f[`sec_${k}`].checked;
  const prices = Object.fromEntries(activeCats().map((c) => [c.key, {}]));
  document.querySelectorAll('[data-price]').forEach((i) => {
    const [kind, plan, cur] = i.dataset.price.split('.');
    (prices[kind][plan] ||= {})[cur] = i.value;
  });
  const trial = {};
  for (const kind of activeCats().map((c) => c.key)) {
    trial[kind] = { enabled: document.querySelector(`[data-trial-on="${kind}"]`).checked, days: Number(document.querySelector(`[data-trial-days="${kind}"]`).value) || 14 };
  }
  const limits = { cookPhotos: f.lim_cookPhotos.value, restaurantPhotos: f.lim_restaurantPhotos.value, menuItems: f.lim_menuItems.value };
  try {
    st.settings = await call('/api/admin/settings', { method: 'PUT', body: {
      brandName: f.brandName.value, brandNameEn: f.brandNameEn.value, announcement: f.announcement.value, adminWhatsapp: f.adminWhatsapp.value, sections, prices, trial, limits,
      appLinks: { android: f.appAndroid.value, ios: f.appIos.value },
      plansHidden: [...document.querySelectorAll('[data-planshow]')].filter((x) => !x.checked).map((x) => x.dataset.planshow),
      groupsHidden: [...document.querySelectorAll('[data-groupshow]')].filter((x) => !x.checked).map((x) => x.dataset.groupshow),
      booking: { enabled: $('#bkEnabled').checked, prices: Object.fromEntries([...document.querySelectorAll('[data-bkprice]')].map((x) => [x.dataset.bkprice, Number(x.value) || 0])) },
      adPrices: { week: { usd: f.adWeekUsd.value, eur: f.adWeekEur.value }, month: { usd: f.adMonthUsd.value, eur: f.adMonthEur.value } },
    } });
    $('#settingsMsg').textContent = t('admin.settingsSaved');
  } catch (err) { $('#settingsMsg').textContent = errorText(err); }
});

/* ---------- messages to a subscriber go out in THEIR language ---------- */
const localeCache = {};
async function warningText(lang, vars) {
  const l = (st.config?.locales || []).includes(lang) ? lang : null;
  if (!l || l === document.documentElement.lang) return t('wa.warning', vars);
  localeCache[l] ||= await fetch(`/locales/${l}.json`).then((r) => r.json()).catch(() => ({}));
  const tpl = localeCache[l]?.wa?.warning || t('wa.warning');
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

/* ---------- trial days (from settings) ---------- */
function trialDays(c) {
  return st.settings?.trial?.[c.kind || 'cook']?.days || 14;
}

/* ---------- support conversations ---------- */
async function loadSupport() {
  const { threads } = await call('/api/admin/support');
  $('#supportEmpty').hidden = threads.length > 0;
  $('#supportList').innerHTML = threads.map((th) => `
    <li><button class="admin-row" type="button" data-thread="${th.cookId}" data-name="${esc(th.name)}">
      <span><span class="cook-name">${esc(th.name)} ${catByKey(th.kind || 'cook') ? `<span class="pill active">${esc(catByKey(th.kind || 'cook').icon)} ${esc(catName(catByKey(th.kind || 'cook')))}</span>` : ''}</span>
        <span class="cook-meta">${esc((th.lastBody || '').slice(0, 90))}</span></span>
      <span class="nums">${th.unread ? `<b class="warn">${th.unread}</b><br>` : ''}${fmtDate(th.lastAt)}</span>
    </button></li>`).join('');
}
$('#supportList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-thread]');
  if (b) openSupport(Number(b.dataset.thread), b.dataset.name);
});
async function openSupport(cookId, name) {
  msg('');
  $('#dlgTitle').textContent = t('admin.supportFrom', { name });
  const { messages } = await call(`/api/admin/support/${cookId}`);
  $('#dlgBody').innerHTML = `<div class="panel">
    <div class="thread">${messages.map((m) => `<div class="bubble ${m.fromAdmin ? 'team' : 'me'}"><small>${esc(m.fromAdmin ? t('account.supportTeam') : name)} · ${fmtDate(m.createdAt)}</small>${esc(m.body)}</div>`).join('')}</div>
    <form id="replyForm"><textarea class="input" name="body" rows="3" maxlength="2000" placeholder="${esc(t('admin.supportPlaceholder'))}"></textarea>
      <button class="btn btn-gold" type="submit">${esc(t('admin.supportReply'))}</button></form></div>`;
  $('#replyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = e.target.body.value.trim();
    if (!body) return;
    try { await call(`/api/admin/support/${cookId}`, { method: 'POST', body: { body } }); await openSupport(cookId, name); } catch (err) { errMsg(err); }
  });
  if (!dlg.open) dlg.showModal();
  loadStats();
}

/* ---------- ads & logos ---------- */
/** Shrink a photo until it is small enough to upload (phone photos can be several MB). */
async function compressForUpload(file, maxChars = 900_000) {
  for (const [w, q] of [[1600, 0.85], [1400, 0.8], [1200, 0.75], [1000, 0.7], [800, 0.65], [700, 0.6]]) {
    const data = await resizeImage(file, w, q);
    if (data.length <= maxChars) return data;
  }
  return resizeImage(file, 600, 0.55);
}
async function loadBanners() {
  const r = await call('/api/admin/banners');
  $('#bannerPlacement').innerHTML = r.placements.map((p) => `<option value="${p}">${esc(t(`admin.place_${p}`))}</option>`).join('');
  $('#bannerList').innerHTML = r.banners.map((b) => `
    <div class="banner-admin">
      <img src="${esc(b.imageUrl)}" alt="">
      <div>
        <select class="input" data-bplace="${b.id}">${r.placements.map((p) => `<option value="${p}" ${p === b.placement ? 'selected' : ''}>${esc(t(`admin.place_${p}`))}</option>`).join('')}</select>
        <p class="fine">${esc(b.title)} ${b.linkUrl ? `· <span dir="ltr">${esc(b.linkUrl)}</span>` : ''}
          ${b.expiresAt ? `· <b>${esc(b.expired ? t('admin.bannerExpired') : t('admin.bannerUntil', { date: fmtDate(b.expiresAt) }))}</b>` : ''}</p>
        <label class="fine">${esc(t('admin.bannerExpires'))} <input class="input" type="date" dir="ltr" data-bexp="${b.id}" value="${b.expiresAt ? b.expiresAt.slice(0, 10) : ''}"></label>
        ${b.advertiser ? `<p class="fine ad-from">📣 ${esc(b.advertiser.name)} · <a href="https://wa.me/${esc(String(b.advertiser.whatsapp).replace(/^\+/, ''))}" target="_blank" rel="noopener" dir="ltr">${esc(b.advertiser.whatsapp)}</a>
          · ${esc(t('admin.adDays', { n: b.advertiser.days }))}${b.advertiser.price ? ` · ${esc(b.advertiser.price)}` : ''}${b.advertiser.note ? `<br>${esc(b.advertiser.note)}` : ''}</p>` : ''}
        ${b.status === 'pending' ? `<p><b class="pill pill-pending">${esc(t('admin.adPending'))}</b>
          <button class="btn btn-gold" type="button" data-adok="${b.id}">${esc(t('admin.adApprove'))}</button>
          <button class="btn-text danger" type="button" data-adno="${b.id}">${esc(t('admin.adReject'))}</button></p>` : ''}
        ${b.status === 'rejected' ? `<p><b class="pill">${esc(t('admin.adRejected'))}</b></p>` : ''}
        <button class="btn-text" type="button" data-btoggle="${b.id}" data-to="${b.active ? 0 : 1}">${esc(t(b.active ? 'admin.bannerShown' : 'admin.bannerOff'))}</button>
        <button class="btn-text" type="button" data-bdel="${b.id}">${esc(t('admin.deletePhoto'))}</button>
      </div>
    </div>`).join('');
}
$('#bannersPanel').addEventListener('toggle', (e) => { if (e.target.open) loadBanners(); });
$('#bannerList').addEventListener('click', async (e) => {
  const ok = e.target.closest('[data-adok]'); const no = e.target.closest('[data-adno]');
  if (!ok && !no) return;
  await call(`/api/admin/banners/${(ok || no).dataset[ok ? 'adok' : 'adno']}/${ok ? 'approve' : 'reject'}`, { method: 'POST', body: {} }).catch(() => {});
  loadBanners(); loadStats();
});
$('#bannerList').addEventListener('change', async (e) => {
  const d = e.target.closest('[data-bexp]');
  if (!d) return;
  await call(`/api/admin/banners/${d.dataset.bexp}`, { method: 'PATCH', body: { expiresAt: d.value || null } }).catch(() => {});
  loadBanners();
});
let pendingBanner = null;
$('#bannerFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $('#bannerMsg').textContent = t('account.uploading');
  try {
    pendingBanner = await compressForUpload(file);
    $('#bannerPreview').src = pendingBanner; $('#bannerPreview').hidden = false;
    $('#bannerSave').hidden = false; $('#bannerMsg').textContent = '';
  } catch (err) { $('#bannerMsg').textContent = errorText(err); }
  e.target.value = '';
});
$('#bannerSave').addEventListener('click', async () => {
  if (!pendingBanner) return;
  const f = $('#bannerForm');
  $('#bannerSave').disabled = true;
  try {
    await call('/api/admin/banners', { method: 'POST', body: { image: pendingBanner, placement: f.placement.value, title: f.title.value, linkUrl: f.linkUrl.value, expiresAt: f.expiresAt.value || null } });
    pendingBanner = null; f.reset(); $('#bannerPreview').hidden = true; $('#bannerSave').hidden = true;
    $('#bannerMsg').textContent = t('admin.bannerAdded');
    loadBanners();
  } catch (err) {
    const fields = err.fields ? Object.values(err.fields).map((c) => t(`errors.${c}`)).join(' — ') : '';
    $('#bannerMsg').textContent = fields || errorText(err);
  } finally { $('#bannerSave').disabled = false; }
});
$('#bannerList').addEventListener('change', async (e) => {
  const s2 = e.target.closest('[data-bplace]');
  if (s2) { await call(`/api/admin/banners/${s2.dataset.bplace}`, { method: 'PATCH', body: { placement: s2.value } }); loadBanners(); }
});
$('#bannerList').addEventListener('click', async (e) => {
  const tg = e.target.closest('[data-btoggle]'); const del = e.target.closest('[data-bdel]');
  if (tg) await call(`/api/admin/banners/${tg.dataset.btoggle}`, { method: 'PATCH', body: { active: tg.dataset.to === '1' } });
  else if (del) { if (!confirm(t('account.confirmDelete'))) return; await call(`/api/admin/banners/${del.dataset.bdel}`, { method: 'DELETE' }); }
  else return;
  loadBanners();
});

/* ---------- site texts editor ---------- */
let textsTimer;
async function loadTexts() {
  const lang = $('#textsLang').value || 'ar';
  const q = $('#textsQ').value.trim();
  const r = await call(`/api/admin/texts?lang=${lang}&q=${encodeURIComponent(q)}`);
  if (!$('#textsLang').options.length) {
    $('#textsLang').innerHTML = r.langs.map((l) => `<option value="${l}">${l.toUpperCase()}</option>`).join('');
    // start with the language this browser shows the site in (edits in another language are invisible to you)
    const seen = (() => { try { return localStorage.getItem('st_lang'); } catch { return null; } })() || document.documentElement.lang || 'ar';
    if (r.langs.includes(seen) && seen !== lang) { $('#textsLang').value = seen; return loadTexts(); }
  }
  $('#textsSeen').textContent = t('admin.textsSeen', { lang: (document.documentElement.lang || 'ar').toUpperCase() });
  $('#textsList').innerHTML = r.items.map((it) => `
    <div class="text-item" data-key="${esc(it.key)}">
      <small dir="ltr">${esc(it.key)}${it.value !== null ? ` · <b>${esc(t('admin.textsEdited'))}</b>` : ''}</small>
      <textarea class="input" rows="${Math.min(10, Math.max(2, Math.ceil((it.value ?? it.base).length / 60)))}" dir="auto">${esc(it.value ?? it.base)}</textarea>
      <div><button class="btn-text" type="button" data-tsave>${esc(t('admin.textsSave'))}</button>
        <button class="btn-text" type="button" data-thide>${esc(t('admin.textDelete'))}</button>
        ${it.value !== null ? `<button class="btn-text" type="button" data-treset>${esc(t('admin.textsReset'))}</button>` : ''}
        <span class="fine" data-tmsg></span></div>
    </div>`).join('');
}
$('#textsPanel').addEventListener('toggle', (e) => { if (e.target.open) loadTexts(); });
$('#textsQ').addEventListener('input', () => { clearTimeout(textsTimer); textsTimer = setTimeout(loadTexts, 300); });
$('#textsLang').addEventListener('change', loadTexts);
$('#textsList').addEventListener('click', async (e) => {
  const item = e.target.closest('.text-item');
  if (!item) return;
  const save = e.target.closest('[data-tsave]'); const reset = e.target.closest('[data-treset]'); const hide = e.target.closest('[data-thide]');
  if (!save && !reset && !hide) return;
  const value = reset ? null : hide ? '\u200b' : item.querySelector('textarea').value;   // hidden = an invisible character
  try {
    const r = await call('/api/admin/texts', { method: 'PUT', body: { lang: $('#textsLang').value || 'ar', key: item.dataset.key, value,
      allLangs: $('#textsAll')?.checked, translate: !$('#textsAll')?.checked && $('#textsTranslate').checked } });
    if (!reset && !hide && $('#textsTranslate').checked && !$('#textsAll')?.checked) {
      item.querySelector('[data-tmsg]').textContent = r.translated?.length ? t('admin.textsTranslated', { langs: r.translated.join(', ').toUpperCase() })
        : r.translationAvailable ? t('admin.textsSaved') : t('admin.translateOff');
      return;
    }
    if (reset || hide) loadTexts(); else item.querySelector('[data-tmsg]').textContent = t('admin.textsSaved');
  } catch (err) { item.querySelector('[data-tmsg]').textContent = errorText(err); }
});

/* ---------- my account security ---------- */
async function loadSecurity() {
  const r = await call('/api/admin/security');
  $('#passkeyList').innerHTML = r.passkeys.length
    ? r.passkeys.map((k) => `<p class="fine review-row">🔑 <b>${esc(k.name)}</b> · ${fmtDate(k.createdAt)}${k.lastUsedAt ? ` · ${esc(t('admin.lastUsed', { date: fmtDate(k.lastUsedAt) }))}` : ''}
        <button class="btn-text" type="button" data-delkey="${k.id}">${esc(t('admin.deletePhoto'))}</button></p>`).join('')
    : `<p class="fine">${esc(t('admin.noPasskeys'))}</p>`;
  $('#backupLeft').textContent = t('admin.backupLeft', { n: r.backupCodesLeft });
  $('#mfaToggle').checked = r.mfaRequired;
  $('#loginList').innerHTML = r.logins.map((l) => `<p class="fine">${l.ok ? '✅' : '⛔'} ${fmtDate(l.at)} · ${esc(t(`admin.method_${l.method}`))} · <span dir="ltr">${esc(deviceName(l.device))}</span></p>`).join('');
  try { const h = await (await fetch('/readyz')).json(); $('#fingerprint').textContent = `v${h.version || ''} · ${h.fingerprint || '—'}`; } catch { /* ignore */ }
}
const deviceName = (ua) => (/iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Other') + (/Chrome/.test(ua) ? ' · Chrome' : /Safari/.test(ua) ? ' · Safari' : /Firefox/.test(ua) ? ' · Firefox' : '');
$('#securityPanel').addEventListener('toggle', (e) => { if (e.target.open) loadSecurity(); });
$('#addPasskey').addEventListener('click', async () => {
  try {
    const o = await call('/api/admin/passkeys/options', { method: 'POST', body: {} });
    const cred = await navigator.credentials.create({ publicKey: {
      ...o, challenge: toBuf(o.challenge), user: { ...o.user, id: toBuf(o.user.id) },
      excludeCredentials: o.excludeCredentials.map((c) => ({ type: 'public-key', id: toBuf(c.id) })),
    } });
    const name = prompt(t('admin.passkeyName'), /iPhone/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : 'Passkey') || 'Passkey';
    await call('/api/admin/passkeys', { method: 'POST', body: { credential: credJson(cred), name } });
    $('#secMsg').textContent = t('admin.passkeyAdded');
    loadSecurity();
  } catch (err) { if (err?.name !== 'NotAllowedError') $('#secMsg').textContent = errorText(err); }
});
$('#passkeyList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-delkey]');
  if (!b || !confirm(t('account.confirmDelete'))) return;
  try { await call(`/api/admin/passkeys/${b.dataset.delkey}`, { method: 'DELETE' }); loadSecurity(); }
  catch (err) { $('#secMsg').textContent = t(`errors.${err.code}`) !== `errors.${err.code}` ? t(`errors.${err.code}`) : errorText(err); }
});
$('#newCodes').addEventListener('click', async () => {
  if (!confirm(t('admin.newCodesConfirm'))) return;
  const r = await call('/api/admin/backup-codes', { method: 'POST', body: {} });
  $('#codesBox').textContent = `${t('admin.codesSaveNow')}\n\n${r.codes.join('\n')}`;
  $('#codesBox').hidden = false;
  loadSecurity();
});
$('#mfaToggle').addEventListener('change', async (e) => {
  try { await call('/api/admin/mfa', { method: 'POST', body: { required: e.target.checked } }); $('#secMsg').textContent = t('admin.saved'); }
  catch (err) { e.target.checked = false; $('#secMsg').textContent = t(`errors.${err.code}`); }
});

/* ---------- full backup & restore ---------- */
$('#restoreFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $('#restoreMsg').textContent = t('common.loading');
  try {
    const res = await fetch('/api/admin/restore', { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Requested-With': 'fetch' }, body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error), { code: data.error });
    $('#restoreMsg').textContent = t('admin.restoreDone', { rows: data.rows });
    setTimeout(() => location.reload(), 4000);
  } catch (err) { $('#restoreMsg').textContent = t(`errors.${err.code}`) !== `errors.${err.code}` ? t(`errors.${err.code}`) : errorText(err); }
  finally { e.target.value = ''; }
});

/* ---------- photos & menu of any subscriber (restaurants published by the admin) ---------- */
$('#dlgBody').addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-menuadd]');
  if (!f || !st.current) return;
  e.preventDefault();
  try {
    await call(`/api/admin/cooks/${st.current.id}/menu`, { method: 'POST', body: { name: f.name.value, price: f.price.value } });
    openCook(st.current.id);
  } catch (err) { msg(errorText(err), false); }
});
$('#dlgBody').addEventListener('change', async (e) => {
  if (e.target.id !== 'adminPhotoFile' || !st.current) return;
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = await resizeImage(file, 1200, 0.82);
    await call(`/api/admin/cooks/${st.current.id}/photos`, { method: 'POST', body: { data } });
    openCook(st.current.id);
  } catch (err) { msg(t(`errors.${err.code}`) !== `errors.${err.code}` ? t(`errors.${err.code}`) : errorText(err), false); }
});

/* ---------- photo storage (Cloudflare R2): status + move ---------- */
let storageTimer;
async function loadStorage() {
  clearTimeout(storageTimer);
  const r = await call('/api/admin/storage');
  const c = r.counts;
  const lines = [r.enabled ? t('admin.storageOn', { host: r.publicHost }) : t('admin.storageOff'),
    t('admin.storageCounts', { db: c.photosInDb + c.avatarsInDb, ext: c.photosInStorage + c.avatarsInStorage })];
  if (r.running) lines.push(t('admin.storageRunning', { n: (r.progress?.moved || 0) + (r.progress?.avatars || 0) }));
  else if (r.lastResult) lines.push(t('admin.storageDone', { n: r.lastResult.moved + r.lastResult.avatars, kept: r.lastResult.kept }));
  if (r.error) lines.push(`⚠️ ${r.error}`);
  $('#storageStatus').innerHTML = lines.map(esc).join('<br>');
  $('#storageMove').hidden = !r.enabled || r.running || !(c.photosInDb + c.avatarsInDb);
  if (r.running) storageTimer = setTimeout(loadStorage, 2500);
}
$('#backupPanel').addEventListener('toggle', (e) => { if (e.target.open) loadStorage(); });
$('#storageMove').addEventListener('click', async () => {
  if (!confirm(t('admin.storageConfirm'))) return;
  await call('/api/admin/storage/migrate', { method: 'POST', body: {} }).catch((err) => alert(errorText(err)));
  loadStorage();
});

/* ---------- import shops from the map ---------- */
let importData = null;
const phoneBadge = (it) => it.phoneKind === 'mobile' ? `📱 <span dir="ltr">${esc(it.whatsapp)}</span>`
  : it.phoneKind === 'unknown' ? `⚠️ <span dir="ltr">${esc(it.whatsapp)}</span> <small>${esc(t('admin.importUnsure'))}</small>`
  : it.phoneKind === 'landline' ? `☎️ <span dir="ltr">${esc(it.callPhone)}</span>` : `🧭 ${esc(t('admin.importNoPhone'))}`;
function countSelected() {
  const n = $('#importResults').querySelectorAll('input[data-imp]:checked').length;
  $('#importPublish').textContent = t('admin.importPublish', { n });
  $('#importPublish').hidden = !n;
}
$('#importFetch').addEventListener('click', async () => {
  const q = $('#importQ').value.trim(); if (q.length < 2) return;
  $('#importMsg').textContent = t('admin.importSearching'); $('#importResults').innerHTML = ''; $('#importPublish').hidden = true;
  try {
    importData = await call(`/api/admin/import/places?q=${encodeURIComponent(q)}&radius=${$('#importR').value}`);
    if (!importData.place) { $('#importMsg').textContent = t('admin.importNoPlace'); return; }
    const total = importData.groups.reduce((a, g) => a + g.items.length, 0);
    const warn = [];
    if (importData.noType?.length) warn.push(t('admin.importNoType', { list: importData.noType.map((k) => catName(catByKey(k) || { key: k })).join('، ') }));
    if (importData.failed?.length) warn.push(t('admin.importFailed', { list: importData.failed.map((k) => catName(catByKey(k) || { key: k })).join('، ') }));
    $('#importMsg').textContent = [t('admin.importFound', { place: importData.place.name, n: total }), ...warn].join(' — ');
    $('#importResults').innerHTML = importData.groups.filter((g) => g.items.length).map((g) => {
      const c = catByKey(g.key) || { key: g.key, icon: '🏷️', names: {} };
      return `<div class="imp-group"><p class="label"><label><input type="checkbox" data-impall="${esc(g.key)}" checked> ${esc(c.icon)} ${esc(catName(c, 'many'))} (${g.items.length})</label></p>
        ${g.items.map((it, i) => `<label class="imp-item${it.exists ? ' exists' : ''}">
          <input type="checkbox" data-imp="${esc(g.key)}:${i}" ${it.exists ? 'disabled' : 'checked'}>
          <span><b>${esc(it.name)}</b> <small>${esc(it.address || '')} · ${it.distanceM < 1000 ? `${Math.round(it.distanceM / 10) * 10} m` : `${(it.distanceM / 1000).toFixed(1)} km`}</small><br>
          ${it.exists ? `<small>✓ ${esc(t('admin.importExists'))}</small>` : phoneBadge(it)}</span>
          ${it.exists ? '' : `<button class="btn-text imp-one" type="button" data-one="${esc(g.key)}:${i}">${esc(t('admin.importOne'))}</button>`}</label>`).join('')}</div>`;
    }).join('') || `<p class="fine">${esc(t('admin.importNone'))}</p>`;
    countSelected();
  } catch (err) { $('#importMsg').textContent = errorText(err); }
});
$('#importResults').addEventListener('click', async (e) => {
  const one = e.target.closest('[data-one]'); if (!one) return;
  e.preventDefault();
  const [k, i] = one.dataset.one.split(':');
  const it = importData.groups.find((g) => g.key === k).items[Number(i)];
  one.disabled = true;
  try {
    await call('/api/admin/import/places', { method: 'POST', body: { items: [it], days: Number($('#importDays').value) } });
    it.exists = true;
    const row = one.closest('.imp-item'); row.classList.add('exists');
    row.querySelector('input').checked = false; row.querySelector('input').disabled = true;
    one.replaceWith(Object.assign(document.createElement('small'), { textContent: `✓ ${t('admin.importPublished')}` }));
    countSelected(); loadStats();
  } catch (err) { one.disabled = false; alert(errorText(err)); }
});
$('#importResults').addEventListener('change', (e) => {
  const all = e.target.dataset.impall;
  if (all) $('#importResults').querySelectorAll(`input[data-imp^="${all}:"]:not(:disabled)`).forEach((x) => { x.checked = e.target.checked; });
  countSelected();
});
$('#importPublish').addEventListener('click', async () => {
  const items = [...$('#importResults').querySelectorAll('input[data-imp]:checked')].map((x) => {
    const [k, i] = x.dataset.imp.split(':'); return importData.groups.find((g) => g.key === k).items[Number(i)];
  });
  if (!items.length || !confirm(t('admin.importConfirm', { n: items.length }))) return;
  $('#importPublish').disabled = true;
  try {
    let created = 0;
    for (let i = 0; i < items.length; i += 200) {   // batches: the server takes up to 300 per request
      const r = await call('/api/admin/import/places', { method: 'POST', body: { items: items.slice(i, i + 200), days: Number($('#importDays').value) } });
      created += r.created;
      $('#importMsg').textContent = `${t('admin.importSearching')} ${Math.min(i + 200, items.length)}/${items.length}`;
    }
    $('#importMsg').textContent = t('admin.importDone', { n: created });
    $('#importResults').innerHTML = ''; $('#importPublish').hidden = true;
    loadStats();
  } catch (err) { $('#importMsg').textContent = errorText(err); } finally { $('#importPublish').disabled = false; }
});

/* ---------- messages from visitors ("Contact the team") ---------- */
async function loadMessages() {
  const r = await call('/api/admin/messages');
  $('#msgList').innerHTML = r.messages.length ? r.messages.map((m) => `
    <div class="text-item${m.read ? '' : ' unread'}" data-mid="${m.id}">
      <small>${fmtDate(m.at)} · ${esc(m.name || '—')} · <span dir="auto">${esc(m.contact || '—')}</span></small>
      <p dir="auto">${esc(m.body)}</p>
      <div>${m.read ? '' : `<button class="btn-text" type="button" data-mread>${esc(t('admin.msgRead'))}</button>`}
        ${/^\+?\d[\d\s-]{6,}$/.test(m.contact) ? `<a class="btn-text" href="https://wa.me/${esc(m.contact.replace(/\D/g, ''))}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
        <button class="btn-text danger" type="button" data-mdel>${esc(t('admin.deletePhoto'))}</button></div></div>`).join('')
    : `<p class="fine">${esc(t('admin.msgEmpty'))}</p>`;
}
$('#msgPanel').addEventListener('toggle', (e) => { if (e.target.open) loadMessages(); });
$('#msgList').addEventListener('click', async (e) => {
  const box = e.target.closest('[data-mid]'); if (!box) return;
  if (e.target.closest('[data-mread]')) await call(`/api/admin/messages/${box.dataset.mid}/read`, { method: 'POST', body: {} });
  else if (e.target.closest('[data-mdel]')) { if (!confirm(t('account.confirmDelete'))) return; await call(`/api/admin/messages/${box.dataset.mid}`, { method: 'DELETE' }); }
  else return;
  loadMessages(); loadStats();
});

/* ---------- categories manager: add, rename (4 languages), icon, order, show on home, delete ---------- */
const LANGS = ['ar', 'en', 'fr', 'es'];
let catState = [];
async function loadCats() {
  const r = await call('/api/admin/settings');
  catState = JSON.parse(JSON.stringify(r.categories || []));
  drawCats();
}
function drawCats() {
  $('#catList').innerHTML = catState.map((c, i) => c.deleted ? '' : `
    <div class="cat-edit" data-ci="${i}">
      <div class="cat-edit-head">
        <input class="input cat-icon" data-f="icon" value="${esc(c.icon)}" maxlength="8" aria-label="icon">
        <b>${esc(catName(c, 'many'))}</b>
        <span class="cat-actions">
          <button class="btn-text" type="button" data-move="-1" ${i === 0 ? 'disabled' : ''}>▲</button>
          <button class="btn-text" type="button" data-move="1" ${i === catState.length - 1 ? 'disabled' : ''}>▼</button>
          ${['cook', 'restaurant'].includes(c.key) ? '' : `<button class="btn-text danger" type="button" data-del>${esc(t('admin.deleteCategory'))}</button>`}
        </span>
      </div>
      <div class="cat-row-ctrls">
        <select class="input" data-f="group" aria-label="group">
          <option value="shops" ${c.group !== 'crafts' ? 'selected' : ''}>🏪 ${esc(t('home.tab_shops'))}</option>
          <option value="crafts" ${c.group === 'crafts' ? 'selected' : ''}>🛠️ ${esc(t('home.tab_crafts'))}</option>
        </select>
        <select class="input" data-f="home">
          <option value="true" ${c.home === true ? 'selected' : ''}>${esc(t('admin.catShowAlways'))}</option>
          <option value="auto" ${c.home === 'auto' ? 'selected' : ''}>${esc(t('admin.catShowAuto'))}</option>
          <option value="false" ${c.home === false ? 'selected' : ''}>${esc(t('admin.catHidden'))}</option></select>
        <select class="input" data-moveto aria-label="${esc(t('admin.catMoveTo'))}">${catState.map((_, j) => `<option value="${j}" ${j === i ? 'selected' : ''}>${esc(t('admin.catPosition', { n: j + 1 }))}</option>`).join('')}</select>
      </div>
      <input class="input" data-f="map" dir="ltr" list="mapTypes" value="${esc(c.map || '')}" placeholder="${esc(t('admin.catMapPh'))}" title="${esc(t('admin.catMap'))}">
      <div class="cat-names">${LANGS.map((l) => `
        <span dir="ltr" class="fine">${l.toUpperCase()}</span>
        <input class="input" data-l="${l}" data-form="one" value="${esc(c.names?.[l]?.one || '')}" placeholder="${esc(t('admin.catOne'))}" dir="auto">
        <input class="input" data-l="${l}" data-form="many" value="${esc(c.names?.[l]?.many || '')}" placeholder="${esc(t('admin.catMany'))}" dir="auto">`).join('')}
      </div>
    </div>`).join('');
}
$('#catsPanel').addEventListener('toggle', (e) => { if (e.target.open) loadCats(); });
$('#catList').addEventListener('input', (e) => {
  const box = e.target.closest('[data-ci]'); if (!box) return;
  const c = catState[Number(box.dataset.ci)];
  if (e.target.dataset.f === 'icon') c.icon = e.target.value;
  if (e.target.dataset.f === 'map') c.map = e.target.value;
  if (e.target.dataset.l) { (c.names[e.target.dataset.l] ||= {})[e.target.dataset.form] = e.target.value; }
});
$('#catList').addEventListener('change', (e) => {
  const box = e.target.closest('[data-ci]'); if (!box) return;
  const i = Number(box.dataset.ci);
  if (e.target.dataset.f === 'home') catState[i].home = e.target.value === 'auto' ? 'auto' : e.target.value === 'true';
  if (e.target.dataset.f === 'group') catState[i].group = e.target.value === 'crafts' ? 'crafts' : 'shops';
  if (e.target.matches('[data-moveto]')) { const [moved] = catState.splice(i, 1); catState.splice(Number(e.target.value), 0, moved); drawCats(); }
});
$('#catList').addEventListener('click', (e) => {
  const box = e.target.closest('[data-ci]'); if (!box) return;
  const i = Number(box.dataset.ci);
  const mv = e.target.closest('[data-move]');
  if (mv) { const j = i + Number(mv.dataset.move); [catState[i], catState[j]] = [catState[j], catState[i]]; drawCats(); }
  if (e.target.closest('[data-del]') && confirm(t('admin.deleteCategoryConfirm'))) { catState[i].deleted = true; drawCats(); }
});
$('#catAdd').addEventListener('click', () => {
  const ar = prompt(t('admin.catNewAr')); if (!ar) return;
  const en = prompt(t('admin.catNewEn')) || ar;
  let key = en.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  if (!/^[a-z]/.test(key)) key = `cat_${key}`;
  if (key.length < 2 || catState.some((c) => c.key === key)) key = `cat_${Date.now().toString(36)}`;
  catState.push({ key, icon: '🏷️', home: 'auto', names: { ar: { one: ar, many: ar }, en: { one: en, many: en } } });
  drawCats();
});
$('#catSave').addEventListener('click', async () => {
  try {
    await call('/api/admin/settings', { method: 'PUT', body: { categories: catState } });
    st.config = await api('/api/config');
    renderKindTabs();
    $('#catMsg').textContent = t('admin.saved');
  } catch (err) { $('#catMsg').textContent = errorText(err); }
});

/* ---------- WhatsApp messages (text, layout, emojis — every language) ---------- */
const WA_SAMPLE = {
  request: 'صينية كبة لـ 6 أشخاص', area: 'حوش الأمراء', distanceLine: '📍 أنا بعيد عنك 150 متر\n', distance: '150 متر',
  name: 'أم علي', whatsapp: '96171123456', phone: '96171123456', password: 'ali2026', id: '124', country: 'لبنان — البقاع',
  map: 'https://maps.google.com/?q=33.85,35.90', served: 'زحلة، سعدنايل', services: 'طبخ منزلي + حلويات', plan: 'شهر', price: '$20',
  specialty: 'مشاوي', url: 'https://aklatak.net', message: 'تأخّر الطلب', n: '1',
};
const fillSample = (tpl) => String(tpl).replace(/\{(\w+)\}/g, (_, k) => WA_SAMPLE[k] ?? `{${k}}`);
async function loadWa() {
  const lang = $('#waLang').value || 'ar';
  const r = await call(`/api/admin/texts?lang=${lang}&prefix=wa.`);
  if (!$('#waLang').options.length) { $('#waLang').innerHTML = r.langs.map((l) => `<option value="${l}">${l.toUpperCase()}</option>`).join(''); $('#waLang').value = lang; }
  $('#waList').innerHTML = r.items.filter((it) => it.base.length > 20 || it.value).map((it) => {
    const text = it.value ?? it.base;
    const vars = [...new Set((it.base.match(/\{(\w+)\}/g) || []))].join(' ');
    return `<div class="text-item" data-key="${esc(it.key)}">
      <small dir="ltr">${esc(it.key)}${it.value !== null ? ` · <b>${esc(t('admin.textsEdited'))}</b>` : ''}</small>
      <textarea class="input" rows="${Math.min(14, text.split('\n').length + 1)}" dir="auto">${esc(text)}</textarea>
      <p class="fine">${esc(t('admin.waVars'))} <span dir="ltr">${esc(vars)}</span></p>
      <details><summary class="fine">${esc(t('admin.waPreview'))}</summary><pre class="wa-preview" dir="auto">${esc(fillSample(text))}</pre></details>
      <div><button class="btn-text" type="button" data-tsave>${esc(t('admin.textsSave'))}</button>
        ${it.value !== null ? `<button class="btn-text" type="button" data-treset>${esc(t('admin.textsReset'))}</button>` : ''}
        <span class="fine" data-tmsg></span></div></div>`;
  }).join('');
}
$('#waPanel').addEventListener('toggle', (e) => { if (e.target.open) loadWa(); });
$('#waLang').addEventListener('change', loadWa);
$('#waList').addEventListener('input', (e) => {
  const item = e.target.closest('.text-item');
  if (item && e.target.tagName === 'TEXTAREA') item.querySelector('.wa-preview').textContent = fillSample(e.target.value);
});
$('#waList').addEventListener('click', async (e) => {
  const item = e.target.closest('.text-item');
  const save = e.target.closest('[data-tsave]'); const reset = e.target.closest('[data-treset]');
  if (!item || (!save && !reset)) return;
  try {
    await call('/api/admin/texts', { method: 'PUT', body: { lang: $('#waLang').value || 'ar', key: item.dataset.key, value: reset ? null : item.querySelector('textarea').value, translate: !reset } });
    if (reset) loadWa(); else item.querySelector('[data-tmsg]').textContent = t('admin.textsSaved');
  } catch (err) { item.querySelector('[data-tmsg]').textContent = errorText(err); }
});

/* ---------- Design: colours, text size, layouts, logo ---------- */
const COLOR_FIELDS = [['gold', 'admin.colorGold', '#d4af37'], ['goldSoft', 'admin.colorGoldSoft', '#e6c866'], ['bg', 'admin.colorBg', '#121212'],
  ['surface', 'admin.colorSurface', '#1b1916'], ['text', 'admin.colorText', '#efe6d4'], ['muted', 'admin.colorMuted', '#a89d89']];
let designState = null;
async function loadDesign() {
  const r = await call('/api/admin/settings');
  designState = JSON.parse(JSON.stringify(r.theme || { colors: {}, layouts: {}, fontScale: 1 }));
  $('#colorList').innerHTML = COLOR_FIELDS.map(([k, label, def]) => `
    <div class="field color-field"><label>${esc(t(label))}</label>
      <span class="color-row"><input type="color" data-color="${k}" value="${esc(designState.colors?.[k] || def)}">
      <button class="btn-text" type="button" data-color-reset="${k}">${esc(t('admin.colorDefault'))}</button>
      <small data-color-state="${k}">${designState.colors?.[k] ? esc(designState.colors[k]) : esc(t('admin.colorDefault'))}</small></span></div>`).join('');
  $('#fontScale').value = String(designState.fontScale || 1);
  $('#layoutCooks').value = designState.layouts?.cooks || 'slider';
  $('#layoutRestaurants').value = designState.layouts?.restaurants || 'slider';
  document.querySelectorAll('[data-size]').forEach((sel) => { sel.value = designState.sizes?.[sel.dataset.size] || 'm'; });
  $('#logoPreview').src = designState.logoVersion ? `/media/logo?v=${designState.logoVersion}` : '/assets/logo.svg';
}
$('#designPanel').addEventListener('toggle', (e) => { if (e.target.open) { loadDesign(); loadGallery(); } });
async function loadGallery() {
  const r = await call('/api/admin/assets');
  const th = designState?.logo !== undefined ? designState : (await call('/api/admin/settings')).theme || {};
  const tile = (kind, value, src, label, removable) => `<button type="button" class="gal-tile${(th[kind] || (kind === 'logo' ? 'preset:bowl' : 'preset:food')) === value ? ' on' : ''}" data-pick="${kind}" data-val="${esc(value)}" title="${esc(label)}">
      <img src="${esc(src)}" alt="">${removable ? `<span class="gal-del" data-delasset="${removable}" aria-label="×">×</span>` : ''}</button>`;
  $('#logoGallery').innerHTML = r.logoPresets.map((p) => tile('logo', `preset:${p}`, `/assets/logos/${p}.svg`, p))
    .concat(r.assets.filter((a) => a.kind === 'logo').map((a) => tile('logo', `asset:${a.id}`, a.url, a.label, a.id))).join('');
  $('#bgGallery').innerHTML = r.bgPresets.map((p) => tile('background', `preset:${p}`, p === 'food' ? '/assets/food-pattern.svg' : p === 'plain' ? '/assets/bg/plain.svg' : `/assets/bg/${p}.svg`, p))
    .concat(r.assets.filter((a) => a.kind === 'background').map((a) => tile('background', `asset:${a.id}`, a.url, a.label, a.id))).join('');
}
$('#designPanel').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-delasset]');
  if (del) { e.stopPropagation(); if (confirm(t('account.confirmDelete'))) { await call(`/api/admin/assets/${del.dataset.delasset}`, { method: 'DELETE' }); loadGallery(); } return; }
  const pick = e.target.closest('[data-pick]');
  if (!pick) return;
  try {
    await call('/api/admin/settings', { method: 'PUT', body: { theme: { [pick.dataset.pick]: pick.dataset.val } } });
    designState[pick.dataset.pick] = pick.dataset.val;
    $('#designMsg').textContent = t('admin.saved');
    loadGallery();
  } catch (err) { $('#designMsg').textContent = errorText(err); }
});
for (const [input, kind] of [['#logoUpload', 'logo'], ['#bgUpload', 'background']]) {
  $(input).addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const image = kind === 'logo' ? await resizeImage(file, 256, 0.9) : await compressForUpload(file);
      const r = await call('/api/admin/assets', { method: 'POST', body: { kind, image, label: file.name.slice(0, 60) } });
      await call('/api/admin/settings', { method: 'PUT', body: { theme: { [kind]: `asset:${r.id}` } } });
      designState[kind] = `asset:${r.id}`;
      $('#designMsg').textContent = t('admin.saved');
      loadGallery();
    } catch (err) { $('#designMsg').textContent = errorText(err); }
    e.target.value = '';
  });
}
$('#colorList').addEventListener('input', (e) => {
  const k = e.target.dataset.color; if (!k) return;
  designState.colors[k] = e.target.value;
  $(`[data-color-state="${k}"]`).textContent = e.target.value;
});
$('#colorList').addEventListener('click', (e) => {
  const k = e.target.dataset.colorReset; if (!k) return;
  designState.colors[k] = '';
  $(`[data-color-state="${k}"]`).textContent = t('admin.colorDefault');
});
const UI_IDS = { uiBtnBg: 'btnBg', uiBtnText: 'btnText', uiFieldBg: 'fieldBg', uiFieldText: 'fieldText', uiFieldBorder: 'fieldBorder' };
const uiState = {};
async function loadUiAndMenu() {
  const s = await call('/api/admin/settings');
  const ui = s.theme?.ui || {};
  $('#uiBtnShape').value = ui.btnShape || ''; $('#uiFieldShape').value = ui.fieldShape || '';
  for (const [id, k] of Object.entries(UI_IDS)) { uiState[k] = ui[k] || ''; $(`#${id}`).value = ui[k] || '#888888'; }
  const hidden = new Set(s.menuHidden || []);
  const items = [['join', t('admin.menuJoin')], ['login', t('admin.menuLogin')], ['app', t('menu.app')], ['advertise', t('menu.advertise')],
    ...activeCats().map((c) => [`cat:${c.key}`, `${c.icon} ${catName(c, 'many')}`])];
  $('#menuItems').innerHTML = items.map(([k, label]) => `<label class="chip"><input type="checkbox" data-menu="${esc(k)}" ${hidden.has(k) ? '' : 'checked'}><span>${esc(label)}</span></label>`).join('');
}
$('#designPanel').addEventListener('toggle', (e) => { if (e.target.open) loadUiAndMenu(); });
for (const [id, k] of Object.entries(UI_IDS)) $(`#${id}`).addEventListener('input', (e) => { uiState[k] = e.target.value; });
$('#designPanel').addEventListener('click', (e) => { const r = e.target.closest('[data-uireset]'); if (r) { uiState[UI_IDS[r.dataset.uireset]] = ''; $(`#${r.dataset.uireset}`).value = '#888888'; } });

$('#designSave').addEventListener('click', async () => {
  try {
    await call('/api/admin/settings', { method: 'PUT', body: {
      menuHidden: [...document.querySelectorAll('#menuItems [data-menu]')].filter((x) => !x.checked).map((x) => x.dataset.menu),
      theme: { ui: { btnShape: $('#uiBtnShape').value, fieldShape: $('#uiFieldShape').value, ...uiState },
      colors: designState.colors, fontScale: Number($('#fontScale').value),
      layouts: { cooks: $('#layoutCooks').value, restaurants: $('#layoutRestaurants').value },
      sizes: Object.fromEntries([...document.querySelectorAll('[data-size]')].map((sel) => [sel.dataset.size, sel.value])),
    } } });
    $('#designMsg').textContent = t('admin.saved');
  } catch (err) { $('#designMsg').textContent = errorText(err); }
});
$('#logoFile').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const image = await resizeImage(file, 256, 0.9);
    await call('/api/admin/logo', { method: 'POST', body: { image } });
    $('#designMsg').textContent = t('admin.logoSaved');
    loadDesign();
  } catch (err) { $('#designMsg').textContent = errorText(err); }
  e.target.value = '';
});
$('#logoReset').addEventListener('click', async () => {
  await call('/api/admin/logo', { method: 'DELETE' }).catch(() => {});
  $('#designMsg').textContent = t('admin.saved');
  loadDesign();
});

boot();

document.getElementById('delImported')?.addEventListener('click', async () => {
  if (!confirm(t('admin.delImportedConfirm'))) return;
  const r = await call(`/api/admin/imported?kind=${encodeURIComponent(st.kind)}&country=${st.country}`, { method: 'DELETE' });
  alert(t('admin.delImportedDone', { n: r.deleted })); loadList(); loadStats();
});

/* ---------- pages: about · terms · privacy · delete-account (edited from here, translated on save) ---------- */
async function loadPage() {
  const key = $('#pgKey').value, lang = $('#pgLang').value;
  const r = await call(`/api/admin/texts?lang=${lang}&prefix=pages.`);
  const val = (k) => { const it = r.items.find((x) => x.key === `pages.${key}.${k}`); return it ? (it.value ?? it.base) : ''; };
  $('#pgTitle').value = val('title'); $('#pgBody').value = val('body'); $('#pgMsg').textContent = '';
}
$('#pagesPanel')?.addEventListener('toggle', (e) => { if (e.target.open) loadPage(); });
$('#pgKey')?.addEventListener('change', loadPage); $('#pgLang')?.addEventListener('change', loadPage);
$('#pgSave')?.addEventListener('click', async () => {
  const key = $('#pgKey').value, lang = $('#pgLang').value, translate = $('#pgTranslate').checked;
  try {
    for (const [k, v] of [['title', $('#pgTitle').value], ['body', $('#pgBody').value]]) {
      await call('/api/admin/texts', { method: 'PUT', body: { lang, key: `pages.${key}.${k}`, value: v.trim() || null, translate } });
    }
    $('#pgMsg').textContent = t('admin.saved');
  } catch (err) { $('#pgMsg').textContent = errorText(err); }
});

/* ---------- import a whole governorate: area → categories → "publish all" ---------- */
let regionData = null;
async function publishItems(items, btn) {
  const fresh = items.filter((x) => !x.exists);
  if (!fresh.length) return 0;
  btn.disabled = true; let created = 0;
  for (let i = 0; i < fresh.length; i += 200) {   // the server takes up to 300 at a time
    const r = await call('/api/admin/import/places', { method: 'POST', body: { items: fresh.slice(i, i + 200), days: Number($('#importDays')?.value || 0) } });
    created += r.created;
  }
  fresh.forEach((x) => { x.exists = true; });
  btn.textContent = `✓ ${t('admin.importPublished')} (${created})`;
  return created;
}
$('#regionFetch')?.addEventListener('click', async () => {
  const q = $('#regionQ').value.trim(); if (q.length < 2) return;
  $('#regionMsg').textContent = t('admin.importSearching'); $('#regionResults').innerHTML = '';
  try {
    regionData = await call(`/api/admin/import/region?q=${encodeURIComponent(q)}`);
    if (!regionData.region) { $('#regionMsg').textContent = t('admin.importNoPlace'); return; }
    const total = regionData.areas.reduce((s, a) => s + a.groups.reduce((n, g) => n + g.items.length, 0), 0);
    $('#regionMsg').textContent = t('admin.importFound', { place: regionData.region.name, n: total })
      + (regionData.failed?.length ? ` — ⚠️ ${t('admin.importFailed', { list: regionData.failed.join('، ') })}` : '');
    $('#regionResults').innerHTML = regionData.areas.map((ar, ai) => `<div class="imp-group"><p class="label">📍 <b>${esc(ar.name)}</b>
        <button class="btn-text" type="button" data-rarea="${ai}">${esc(t('admin.publishArea'))}</button></p>
      ${ar.groups.map((g, gi) => { const c = catByKey(g.key) || { key: g.key, icon: '🏷️', names: {} }; const fresh = g.items.filter((x) => !x.exists).length;
        return `<p class="fine">${esc(c.icon)} ${esc(catName(c, 'many'))} (${g.items.length}) ${fresh ? `<button class="btn-text" type="button" data-rcat="${ai}:${gi}">${esc(t('admin.publishAll'))} (${fresh})</button>` : `✓ ${esc(t('admin.importExists'))}`}</p>`; }).join('')}</div>`).join('');
  } catch (err) { $('#regionMsg').textContent = errorText(err); }
});
$('#regionResults')?.addEventListener('click', async (e) => {
  const bc = e.target.closest('[data-rcat]'); const ba = e.target.closest('[data-rarea]');
  try {
    if (bc) { const [ai, gi] = bc.dataset.rcat.split(':').map(Number); await publishItems(regionData.areas[ai].groups[gi].items, bc); }
    if (ba) { const ar = regionData.areas[Number(ba.dataset.rarea)]; if (!confirm(t('admin.publishAreaConfirm', { name: ar.name }))) return; await publishItems(ar.groups.flatMap((g) => g.items), ba); }
    loadStats();
  } catch (err) { alert(errorText(err)); }
});

/* ---------- hide a whole country, or some categories in one country (nothing is deleted) ---------- */
let chSettings = null;
async function loadCountryHide() {
  chSettings = await call('/api/admin/settings');
  const all = [...new Set([...(st.config.countries || []), ...Object.keys(chSettings.extraCountries || {})])].sort((a, b) => countryName(a).localeCompare(countryName(b)));
  if (!$('#chCountry').options.length) $('#chCountry').innerHTML = all.map((c) => `<option value="${c}">${flagOf(c)} ${esc(countryName(c))}</option>`).join('');
  renderCountryHide();
}
function renderCountryHide() {
  const cc = $('#chCountry').value; const hidden = new Set(chSettings.countryCatsHidden?.[cc] || []);
  $('#chHide').checked = (chSettings.countriesHidden || []).includes(cc);
  $('#chCats').innerHTML = (chSettings.categories || []).filter((c) => !c.deleted).map((c) => `<label class="chip"><input type="checkbox" data-chcat="${esc(c.key)}" ${hidden.has(c.key) ? '' : 'checked'}><span>${esc(c.icon)} ${esc(catName(c, 'many'))}</span></label>`).join('');
}
$('#countriesPanel')?.addEventListener('toggle', (e) => { if (e.target.open) loadCountryHide(); });
$('#chCountry')?.addEventListener('change', renderCountryHide);
$('#chSave')?.addEventListener('click', async () => {
  const cc = $('#chCountry').value;
  const ch = new Set(chSettings.countriesHidden || []); if ($('#chHide').checked) ch.add(cc); else ch.delete(cc);
  const cats = { ...(chSettings.countryCatsHidden || {}) }; cats[cc] = [...document.querySelectorAll('[data-chcat]')].filter((x) => !x.checked).map((x) => x.dataset.chcat);
  try { await call('/api/admin/settings', { method: 'PUT', body: { countriesHidden: [...ch], countryCatsHidden: cats } }); $('#ctMsg').textContent = t('admin.saved'); await loadCountryHide(); }
  catch (err) { $('#ctMsg').textContent = errorText(err); }
});
