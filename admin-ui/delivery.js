// لوحة الإدارة — التوصيل (للمالك فقط). كل قسم وحده، بلا عجقة.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `${Math.round(Number(n || 0) * 100) / 100}$`;
const when = (s) => { try { return new Date(s).toLocaleString('ar-LB', { dateStyle: 'short', timeStyle: 'short' }); } catch { return s; } };
const ERR = { unauthorized: 'سجّل الدخول إلى لوحة الإدارة أولاً', forbidden: 'هذا القسم للمالك فقط', invalid_state: 'تغيّرت الحالة، حدّث الصفحة', not_found: 'غير موجود', validation_failed: 'تحقّق من البيانات' };

async function api(method, path, body) {
  const r = await fetch(path, { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch { /* binary */ }
  if (!r.ok) { const e = new Error(d?.error || 'error'); e.status = r.status; e.code = d?.error; throw e; }
  return d;
}
function toast(m) { let el = $('.dx > .toast'); if (!el) { const w = document.createElement('div'); w.className = 'dx'; el = document.createElement('div'); el.className = 'toast'; w.appendChild(el); document.body.appendChild(w); } el.textContent = m; el.classList.remove('hide'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hide'), 3000); }
const fail = (e) => { if (e.status === 401 && !document.getElementById('dxRoot')) { location.href = './'; return; } toast(ERR[e.code] || 'حدث خطأ'); };
function sheet(html) {
  const w = document.createElement('div'); w.className = 'dx';
  const bg = document.createElement('div'); bg.className = 'sheet-bg'; bg.innerHTML = `<div class="sheet">${html}</div>`; w.appendChild(bg);
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) w.remove(); });
  document.body.appendChild(w); return { el: bg.querySelector('.sheet'), close: () => w.remove() };
}
function ask(title, label, { min = 3 } = {}) {
  return new Promise((resolve) => {
    const s = sheet(`<h2>${esc(title)}</h2><form><label class="f">${esc(label)}<input class="in" name="v" required minlength="${min}"></label><button class="btn">تأكيد</button></form>`);
    $('form', s.el).addEventListener('submit', (e) => { e.preventDefault(); const v = e.target.v.value.trim(); s.close(); resolve(v); });
  });
}
async function openPrivateImage(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) return toast('تعذّر فتح الصورة');
  const blobUrl = URL.createObjectURL(await r.blob());
  sheet(`<img src="${blobUrl}" alt=""><button class="btn alt" data-close>إغلاق</button>`);
}

const TABS = [
  ['overview', '📊 نظرة عامة'], ['orders', '🧾 الطلبات'], ['drivers', '🛵 السائقون'], ['stores', '🏪 المتاجر'], ['customers', '👤 الزبائن'],
  ['topups', '💳 شحن الرصيد'], ['payouts', '💸 السحوبات'], ['complaints', '⚠️ الشكاوى'], ['settings', '⚙️ الإعدادات'],
];
let tab = new URLSearchParams(location.hash.slice(1)).get('t') || 'overview';
let country = '';
let COUNTRIES = [];
const cq = (sep = '?') => (country ? `${sep}country=${country}` : '');
async function confirmDel(msg, url, then) { if (!confirm(msg)) return; try { await api('DELETE', url); toast('حُذف'); then?.(); } catch (e) { fail(e); } }
const STATUS = { pending: 'بانتظار المتجر', rejected: 'مرفوض', preparing: 'قيد التحضير', searching: 'يبحث عن سائق', assigned: 'السائق متجه للمتجر', picked_up: 'في الطريق', delivered: 'تم التسليم', cancelled: 'ملغى', active: 'مفعّل', suspended: 'موقوف', due: 'مستحقة', paid: 'مدفوعة', approved: 'مقبول', open: 'مفتوحة', warned: 'أُرسل إنذار', dismissed: 'مرفوضة' };
const MODE = { delivery: 'سائقو المنصة', self: 'توصيل خاص', none: 'واتساب فقط' };
const TYPE = { store: 'متجر', driver: 'سائق', customer: 'زبون' };
const DOC = { selfie: 'صورة شخصية', idFront: 'الهوية (الوجه الأمامي)', idBack: 'الهوية (الوجه الخلفي)', idCard: 'الهوية', license: 'رخصة القيادة', vehicleFront: 'المركبة من الأمام', vehicleBack: 'المركبة من الخلف', registration: 'دفتر المركبة', criminalRecord: 'السجل العدلي' };

const ROOT = () => document.getElementById('dxRoot') || document.body;
function frame() {
  const embedded = !!document.getElementById('dxRoot');
  ROOT().innerHTML = `${embedded ? '' : `<main class="wrap wide"><div class="row"><h1>التوصيل</h1><a class="btn sm alt" href="./">← لوحة الإدارة</a></div>`}
    <label class="small">البلد <select class="in" id="cty"><option value="">كل البلدان</option>${COUNTRIES.map((c) => `<option value="${c}" ${c === country ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    ${embedded ? '' : `<div class="tabs">${TABS.map(([k, n]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${n}</button>`).join('')}</div>`}<div id="pane"><div class="skel cover"></div></div>${embedded ? '' : '</main>'}`;
  $$('[data-t]').forEach((b) => { b.onclick = () => { tab = b.dataset.t; location.hash = `t=${tab}`; frame(); }; });
  $('#cty').onchange = (e) => { country = e.target.value; frame(); };
  ({ overview, orders, drivers, stores, customers, topups, payouts, complaints, settings, plans, broadcasts, designs, places, renewals, finance }[tab] || overview)().catch(fail);
}
// opened from the side menu of the admin panel
window.dxOpen = async (t) => { tab = t; if (!COUNTRIES.length) { try { COUNTRIES = (await api('GET', '/api/config')).countries || []; } catch { /* ignore */ } } frame(); };
const pane = () => $('#pane');

async function overview() {
  const o = await api('GET', `/api/admin/delivery/overview${cq()}`);
  const box = (n, l, t) => `<button class="stat" data-go="${t}"><b>${n}</b><span>${l}</span></button>`;
  pane().innerHTML = `<div class="grid2">${box(o.ordersToday, 'طلبات اليوم', 'orders')}${box(o.activeOrders, 'طلبات جارية', 'orders')}${box(o.driversAvailable, 'سائقون متاحون الآن', 'drivers')}${box(o.driversPending, 'سائقون بانتظار المراجعة', 'drivers')}
    ${box(o.topupsPending, 'طلبات شحن بانتظارك', 'topups')}${box(o.renewalsPending ?? 0, 'طلبات تجديد اشتراك', 'renewals')}${box(o.payoutsDue, 'طلبات سحب بانتظارك', 'payouts')}${box(o.complaintsOpen, 'شكاوى مفتوحة', 'complaints')}</div>
    <div class="card"><h3>🔔 إشعارات الإدارة على هاتفك</h3><p class="small mute">يصلك إشعار فوراً عند كل طلب شحن أو تجديد أو سحب، وكل سائق جديد، وكل شكوى — حتى والتطبيق مغلق.</p><button class="btn" id="admPush">🔔 تفعيل على هذا الهاتف</button></div>`;
  $('#admPush').onclick = () => adminPush().catch(fail);
  $$('[data-go]').forEach((b) => { b.onclick = () => { if (window.adminGo) window.adminGo(`dx-${b.dataset.go}`); else { tab = b.dataset.go; frame(); } }; });
}

async function orders() {
  const { orders: rows } = await api('GET', `/api/admin/orders${cq()}`);
  const { errands } = await api('GET', `/api/admin/errands${cq()}`);
  pane().innerHTML = `<div class="scrollx"><table class="tbl"><tr><th>#</th><th>المتجر</th><th>الزبون</th><th>السائق</th><th>الحالة</th><th>المبلغ</th><th>الأجرة</th><th>الوقت</th></tr>
    ${rows.map((o) => `<tr><td>${o.id}</td><td>${esc(o.store)}</td><td>${esc(o.customer)}</td><td>${esc(o.driver || '—')}</td><td>${esc(STATUS[o.status] || o.status)}</td><td>${money(o.total)}</td><td>${o.delivery_fee ? money(o.delivery_fee) : '—'}</td><td class="small">${esc(when(o.created_at))}</td><td><button class="btn sm bad" data-do="${o.id}">✕</button></td></tr>`).join('')}</table></div>
    <h2>🛵 طلبات الزبائن المباشرة للسائقين</h2>
    <div class="scrollx"><table class="tbl"><tr><th>#</th><th>النوع</th><th>الزبون</th><th>السائق</th><th>الحالة</th><th>السعر</th><th>المشتريات</th><th>الوقت</th></tr>
    ${errands.map((e) => `<tr><td>${e.id}</td><td>${{ deliver: '📦 توصيل', buy: '🛍️ جلب من محل', service: '🧾 خدمة' }[e.kind]}</td><td>${esc(e.customer)}</td><td>${esc(e.driver || '—')}</td><td>${esc({ searching: 'يبحث عن سائق', assigned: 'قَبِل السائق', picked_up: 'في الطريق', delivered: 'تم', cancelled: 'ملغى' }[e.status])}</td><td>${money(e.price)}</td><td>${e.purchase_value != null ? money(e.purchase_value) : '—'}</td><td class="small">${esc(when(e.created_at))}</td><td><button class="btn sm bad" data-de="${e.id}">✕</button></td></tr>`).join('')}</table></div>`;
  $$('[data-do]').forEach((b) => { b.onclick = () => confirmDel(`حذف الطلب #${b.dataset.do} نهائياً؟`, `/api/admin/orders/${b.dataset.do}`, orders); });
  $$('[data-de]').forEach((b) => { b.onclick = () => confirmDel(`حذف طلب السائق #${b.dataset.de} مع الدردشة نهائياً؟`, `/api/admin/errands/${b.dataset.de}`, orders); });
}

async function drivers(filter = 'pending') {
  const { drivers: rows } = await api('GET', `/api/admin/drivers${filter ? `?status=${filter}${cq('&')}` : cq()}`);
  pane().innerHTML = `<div class="tabs">${[['pending', 'بانتظار المراجعة'], ['active', 'مفعّلون'], ['suspended', 'موقوفون'], ['', 'الكل']].map(([k, n]) => `<button data-f="${k}" class="${k === filter ? 'on' : ''}">${n}</button>`).join('')}</div>
    ${rows.length ? rows.map((d) => `<div class="card"><div class="row"><b>${esc(d.full_name)}</b><span class="chip ${d.status === 'active' ? 'g' : d.status === 'suspended' ? 'b' : 'w'}">${esc(STATUS[d.status] || d.status)}</span></div>
      <p class="small">📞 +${esc(d.phone)} · ${d.vehicle === 'car' ? 'سيارة' : 'دراجة نارية'} ${esc(d.plate || '')} · ${esc((d.wallet_provider || '').toUpperCase())} ${esc(d.wallet_number || '')}</p>
      <p class="small">الرصيد: <b>${money(d.balance)}</b> · الإنذارات: ${d.warnings} · ${d.available ? '🟢 متاح' : '⚪ غير متاح'}</p>
      <button class="btn sm alt" data-open="${d.id}">الوثائق والتفاصيل</button></div>`).join('') : '<div class="empty">لا يوجد</div>'}`;
  $$('[data-f]').forEach((b) => { b.onclick = () => drivers(b.dataset.f).catch(fail); });
  $$('[data-open]').forEach((b) => { b.onclick = () => driverSheet(Number(b.dataset.open), filter).catch(fail); });
}
async function driverSheet(id, filter) {
  const { driver: d, documents } = await api('GET', `/api/admin/drivers/${id}`);
  const s = sheet(`<h2>${esc(d.full_name)}</h2><p class="small">📞 +${esc(d.phone)} · وافق على الشروط: ${esc(when(d.terms_accepted_at))}</p>
    <p class="small">🎂 تاريخ الميلاد: ${esc(d.birth_date || '—')}${d.jobs_request_months ? ` · <b>طلب اشتراك طلبات الزبائن: ${d.jobs_request_months} شهر</b>` : ''}</p>
    <div class="docs">${documents.map((x) => `<button class="btn alt" data-doc="${x.id}">📄 ${esc(DOC[x.kind] || x.kind)}</button>`).join('')}</div>
    ${d.warnings.items.map((w) => `<p class="small">⚠️ ${esc(w.reason)} — ${esc(when(w.at))}</p>`).join('')}
    <div class="card"><b>اشتراك طلبات الزبائن</b><p class="small">${d.jobs_until && new Date(d.jobs_until) > new Date() ? `✅ فعّال حتى ${esc(when(d.jobs_until))}` : 'غير مفعّل — لا تصله طلبات الزبائن المباشرة'}</p>
      <div class="row"><select class="in" id="jm"><option value="1">شهر</option><option value="3">3 أشهر</option><option value="6">6 أشهر</option><option value="12">سنة</option><option value="0">إيقاف</option></select><button class="btn sm" id="jset">تطبيق</button></div></div>
    <div class="grid2">${d.status !== 'active' ? '<button class="btn" data-s="active">تفعيل</button>' : ''}${d.status === 'pending' ? '<button class="btn bad" data-s="rejected">رفض</button>' : ''}
    ${d.status === 'active' ? '<button class="btn bad" data-s="suspended">إيقاف وإخفاء</button>' : ''}<button class="btn acc" data-w>إنذار</button><button class="btn alt" data-lg>سجل الرصيد والسحوبات</button><button class="btn bad" data-xd>حذف الحساب نهائياً</button></div>
    <button class="btn alt" data-close>إغلاق</button>`);
  $$('[data-doc]', s.el).forEach((b) => { b.onclick = () => openPrivateImage(`/api/admin/drivers/${id}/documents/${b.dataset.doc}`); });
  $$('[data-s]', s.el).forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/admin/drivers/${id}/status`, { status: b.dataset.s }); s.close(); toast('تم'); drivers(filter); } catch (e) { fail(e); } }; });
  $('[data-w]', s.el).onclick = () => warn('driver', id, () => { s.close(); drivers(filter); });
  $('[data-lg]', s.el).onclick = () => accountLog('driver', id).catch(fail);
  $('[data-xd]', s.el).onclick = () => confirmDel('حذف السائق مع وثائقه ورصيده وسجله نهائياً؟', `/api/admin/drivers/${id}`, () => { s.close(); drivers(filter); });
  $('#jset', s.el).onclick = async () => { try { await api('POST', `/api/admin/drivers/${id}/jobs`, { months: Number($('#jm', s.el).value) }); s.close(); toast('تم'); drivers(filter); } catch (e) { fail(e); } };
}
async function warn(type, id, then) {
  const reason = await ask(`إنذار ${TYPE[type]}`, 'سبب الإنذار');
  try { const r = await api('POST', '/api/admin/warnings', { type, id, reason }); toast(r.suspended ? `الإنذار ${r.count} من ${r.max} — أُوقف الحساب تلقائياً` : `الإنذار ${r.count} من ${r.max}`); then?.(); } catch (e) { fail(e); }
}

async function stores(q = '') {
  const { stores: rows } = await api('GET', `/api/admin/delivery/stores${q ? `?q=${encodeURIComponent(q)}${cq('&')}` : cq()}`);
  pane().innerHTML = `<div class="search"><span>🔍</span><input id="sq" placeholder="ابحث بالاسم أو الرقم" value="${esc(q)}"></div>
    ${rows.map((c) => `<div class="card ${c.parent_id ? 'branchc' : ''}"><div class="row"><b>${c.parent_id ? '↳ فرع: ' : ''}${c.pinned ? '📌 ' : ''}${esc(c.full_name)}</b><span class="chip ${Number(c.suspended) ? 'b' : 'g'}">${Number(c.suspended) ? 'موقوف' : 'ظاهر'}</span></div>
      <p class="small">${esc(c.kind)} · ${esc(c.country || 'LB')} · ${esc(c.area_label || '')} · رصيد ${money(c.balance)} · إنذارات ${c.warnings}</p>
      ${!c.parent_id ? `<p class="small">💳 الاشتراك المستحق شهرياً: <b>${money(c.price)}</b> (${c.branches + 1} فرع)</p>` : ''}
      ${c.parent_id && c.status === 'pending' ? `<div class="row"><span class="chip w">فرع جديد بانتظار موافقتك</span><button class="btn sm" data-br="${c.id}" data-st="approved">موافقة</button><button class="btn sm bad" data-br="${c.id}" data-st="rejected">رفض</button></div>` : ''}
      <div class="row"><label class="small">التوصيل <select class="in" data-mode="${c.id}">${Object.entries(MODE).map(([k, n]) => `<option value="${k}" ${c.delivery_mode === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" data-book="${c.id}" ${Number(c.booking) ? 'checked' : ''}><span>المواعيد</span></label>
      <label class="check"><input type="checkbox" data-pin="${c.id}" ${Number(c.pinned) ? 'checked' : ''}><span>تثبيت</span></label></div>
      <div class="row"><button class="btn sm ${Number(c.suspended) ? '' : 'bad'}" data-sus="${c.id}" data-on="${Number(c.suspended) ? 0 : 1}">${Number(c.suspended) ? 'تفعيل' : 'إيقاف وإخفاء'}</button>
      <button class="btn sm acc" data-wr="${c.id}">إنذار</button><button class="btn sm alt" data-adj="${c.id}">تعديل الرصيد</button><button class="btn sm alt" data-lg="${c.id}">السجل</button><button class="btn sm bad" data-xs="${c.id}">حذف نهائي</button></div></div>`).join('')}`;
  let deb; $('#sq').oninput = (e) => { clearTimeout(deb); deb = setTimeout(() => stores(e.target.value.trim()).catch(fail), 400); };
  const set = (id, body) => api('POST', `/api/admin/stores/${id}/delivery`, body).then(() => toast('تم الحفظ')).catch(fail);
  $$('[data-mode]').forEach((s) => { s.onchange = () => set(s.dataset.mode, { mode: s.value }); });
  $$('[data-book]').forEach((s) => { s.onchange = () => set(s.dataset.book, { booking: s.checked }); });
  $$('[data-pin]').forEach((s) => { s.onchange = () => set(s.dataset.pin, { pinned: s.checked }); });
  $$('[data-sus]').forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/admin/accounts/store/${b.dataset.sus}/${b.dataset.on === '1' ? 'suspend' : 'activate'}`, {}); stores(q); } catch (e) { fail(e); } }; });
  $$('[data-wr]').forEach((b) => { b.onclick = () => warn('store', Number(b.dataset.wr), () => stores(q)); });
  $$('[data-br]').forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/admin/stores/${b.dataset.br}/branch-status`, { status: b.dataset.st }); stores(q); } catch (e) { fail(e); } }; });
  $$('[data-lg]').forEach((b) => { b.onclick = () => accountLog('store', Number(b.dataset.lg)).catch(fail); });
  $$('[data-xs]').forEach((b) => { b.onclick = async () => {
    if (!confirm('حذف المتجر مع منيوه وصوره وطلباته ورصيده وسجله نهائياً؟')) return;
    try { await api('DELETE', `/api/admin/delivery/stores/${b.dataset.xs}/leftovers`); await api('DELETE', `/api/admin/cooks/${b.dataset.xs}`); toast('حُذف'); stores(q); } catch (e) { fail(e); }
  }; });
  $$('[data-adj]').forEach((b) => { b.onclick = async () => {
    const amount = Number(await ask('تعديل رصيد المتجر', 'المبلغ (سالب للخصم)', { min: 1 }));
    const note = await ask('سبب التعديل', 'السبب');
    try { await api('POST', `/api/admin/stores/${b.dataset.adj}/wallet-adjust`, { amount, note }); stores(q); } catch (e) { fail(e); }
  }; });
}

async function customers(q = '') {
  const { customers: rows } = await api('GET', `/api/admin/customers${q ? `?q=${encodeURIComponent(q)}${cq('&')}` : cq()}`);
  pane().innerHTML = `<div class="search"><span>🔍</span><input id="cq" placeholder="ابحث بالاسم أو الرقم" value="${esc(q)}"></div>
    ${rows.map((c) => `<div class="card row"><span><b>${esc(c.name)}</b><br><small class="mute">+${esc(c.phone)} · ${esc(c.country || '')} · إنذارات ${c.warnings}</small></span>
      <span><button class="btn sm ${c.status === 'suspended' ? '' : 'bad'}" data-cs="${c.id}" data-on="${c.status === 'suspended' ? 0 : 1}">${c.status === 'suspended' ? 'تفعيل' : 'إيقاف'}</button> <button class="btn sm acc" data-cw="${c.id}">إنذار</button> <button class="btn sm bad" data-cx="${c.id}">حذف</button></span></div>`).join('')}`;
  $$('[data-cx]').forEach((b) => { b.onclick = () => confirmDel('حذف الزبون مع عناوينه وطلباته ودردشاته نهائياً؟', `/api/admin/customers/${b.dataset.cx}`, () => customers(q)); });
  let deb; $('#cq').oninput = (e) => { clearTimeout(deb); deb = setTimeout(() => customers(e.target.value.trim()).catch(fail), 400); };
  $$('[data-cs]').forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/admin/accounts/customer/${b.dataset.cs}/${b.dataset.on === '1' ? 'suspend' : 'activate'}`, {}); customers(q); } catch (e) { fail(e); } }; });
  $$('[data-cw]').forEach((b) => { b.onclick = () => warn('customer', Number(b.dataset.cw), () => customers(q)); });
}

async function topups() {
  const { topups: rows } = await api('GET', '/api/admin/topups?status=pending');
  pane().innerHTML = rows.length ? rows.map((x) => `<div class="card"><div class="row"><b>${esc(x.store)}</b><span class="big">${money(x.amount)}</span></div>
    <p class="small">${esc(x.method.toUpperCase())} ${x.reference ? `· ${esc(x.reference)}` : ''} · ${esc(when(x.created_at))}</p>
    <div class="row"><button class="btn sm alt" data-rc="${x.id}">🧾 الإيصال</button><button class="btn sm" data-ok="${x.id}">تأكيد وإضافة الرصيد</button><button class="btn sm bad" data-no="${x.id}">رفض</button></div></div>`).join('') : '<div class="empty">لا توجد طلبات شحن بانتظارك</div>';
  $$('[data-rc]').forEach((b) => { b.onclick = () => openPrivateImage(`/api/admin/topups/${b.dataset.rc}/receipt`); });
  $$('[data-ok],[data-no]').forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/admin/topups/${b.dataset.ok || b.dataset.no}/${b.dataset.ok ? 'approve' : 'reject'}`, {}); topups(); } catch (e) { fail(e); } }; });
}

async function payouts(filter = 'pending') {
  const { withdrawals: rows } = await api('GET', `/api/admin/withdrawals?status=${filter}`);
  pane().innerHTML = `<p class="mute small">السائق والمتجر يطلبان السحب إلى أي رقم Whish أو OMT بعد تأكيد كلمة سر الحساب. حوّل المبلغ ثم اضغط «تم التحويل». الرفض يعيد المبلغ إلى رصيده.</p>
    <div class="tabs">${[['pending', 'بانتظار التحويل'], ['paid', 'تم التحويل'], ['rejected', 'مرفوضة'], ['all', 'الكل']].map(([k, n]) => `<button data-f="${k}" class="${k === filter ? 'on' : ''}">${n}</button>`).join('')}</div>
    ${rows.length ? rows.map((w) => `<div class="card"><div class="row"><b>${w.account_type === 'driver' ? '🛵' : '🏪'} ${esc(w.name || '')}</b><span class="big">${money(w.amount)}</span></div>
      <p>${esc(w.provider.toUpperCase())}: <b>${esc(w.number)}</b> <button class="btn sm alt" data-copy="${esc(w.number)}">نسخ الرقم</button></p>
      <p class="small mute">${esc(when(w.created_at))} · هاتف الحساب +${esc(w.phone || '')}</p>
      ${w.settlement_id ? `<p class="small">🔗 حصة المطعم من تسوية S-${w.settlement_id}${w.auto_ref ? ` · ✅ حُوِّلت تلقائياً (${esc(w.auto_ref)})` : ''}</p>` : ''}${w.last_error ? `<p class="small"><span class="chip w">فشل التحويل التلقائي: ${esc(w.last_error)}</span> — حوّلها يدوياً ثم اضغط «تم التحويل»</p>` : ''}
      ${w.status === 'pending' ? `<div class="grid2"><button class="btn" data-paid="${w.id}">تم التحويل</button><button class="btn bad" data-rej="${w.id}">رفض وإعادة المبلغ</button></div>` : `<span class="chip">${w.status === 'paid' ? 'تم التحويل' : 'مرفوض'}</span> <button class="btn sm bad" data-wdel="${w.id}">حذف من السجل</button>`}
      <button class="btn sm alt" data-log="${w.account_type}:${w.account_id}">سجل الحساب</button></div>`).join('') : '<div class="empty">لا يوجد</div>'}`;
  $$('[data-f]').forEach((b) => { b.onclick = () => payouts(b.dataset.f).catch(fail); });
  $$('[data-copy]').forEach((b) => { b.onclick = () => navigator.clipboard?.writeText(b.dataset.copy).then(() => toast('نُسخ الرقم')); });
  $$('[data-paid],[data-rej]').forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/admin/withdrawals/${b.dataset.paid || b.dataset.rej}/${b.dataset.paid ? 'paid' : 'reject'}`, {}); payouts(filter); } catch (e) { fail(e); } }; });
  $$('[data-log]').forEach((b) => { const [t2, id] = b.dataset.log.split(':'); b.onclick = () => accountLog(t2, Number(id)).catch(fail); });
  $$('[data-wdel]').forEach((b) => { b.onclick = () => confirmDel('حذف هذا السحب من السجل؟', `/api/admin/withdrawals/${b.dataset.wdel}`, () => payouts(filter)); });
}
const WD = { pending: 'بانتظار التحويل', paid: 'تم التحويل', rejected: 'مرفوض' };
const KIND = { topup: 'شحن', hold: 'أجرة توصيل', release: 'استرجاع', adjust: 'تعديل', earning: 'أجرة', payout: 'سحب' };
async function accountLog(type, id) {
  const r = await api('GET', `/api/admin/ledger?type=${type}&id=${id}`);
  sheet(`<h2>سجل ${TYPE[type]} #${id}</h2><div class="stat"><b>${money(r.balance)}</b><span>الرصيد</span></div>
    <h3>الإنذارات</h3><div class="list">${(r.warnings || []).map((w) => `<div class="row item"><span>⚠️ ${esc(w.reason)}<br><small>${esc(when(w.at))}</small></span><button class="btn sm bad" data-wx="${w.id}">حذف</button></div>`).join('') || '<p class="mute">لا يوجد</p>'}</div>
    <h3>السحوبات</h3><div class="list">${r.withdrawals.map((w) => `<div class="row item"><span>${money(w.amount)} — ${esc(w.provider.toUpperCase())} ${esc(w.number)}<br><small>${esc(when(w.created_at))}</small></span><span class="chip">${esc(WD[w.status] || w.status)}</span></div>`).join('') || '<p class="mute">لا يوجد</p>'}</div>
    <h3>الحركات</h3><div class="list">${r.ledger.map((l) => `<div class="row item"><span>${KIND[l.kind] || l.kind}${l.order_id ? ` #${l.order_id}` : ''}<br><small>${esc(l.note || '')} ${esc(when(l.created_at))}</small></span><b>${money(l.amount)}</b></div>`).join('')}</div>
    <button class="btn alt" data-close>إغلاق</button>`);
  $$('[data-wx]').forEach((b) => { b.onclick = () => confirmDel('حذف هذا الإنذار؟ (إذا كان الحساب موقوفاً بسببه فعّله من جديد يدوياً)', `/api/admin/warnings/${b.dataset.wx}`, () => { document.querySelector('.dx .sheet-bg')?.parentElement.remove(); accountLog(type, id); }); });
}

async function complaints() {
  const { complaints: rows } = await api('GET', '/api/admin/complaints?status=open');
  pane().innerHTML = rows.length ? rows.map((c) => `<div class="card"><div class="row"><b>${TYPE[c.from_type]} #${c.from_id} ← بحق ${TYPE[c.against_type]} #${c.against_id}</b><span class="small mute">${c.errand_id ? `طلب سائق مباشر #${c.errand_id}` : `طلب #${c.order_id ?? '—'}`}</span></div>
    <p>${esc(c.text)}</p><p class="small mute">${esc(when(c.created_at))}</p>
    <div class="row">${c.errand_id ? `<button class="btn sm alt" data-chat="${c.errand_id}">💬 الدردشة</button>` : ''}<button class="btn sm acc" data-cw="${c.id}">إرسال إنذار</button><button class="btn sm alt" data-cd="${c.id}">رفض الشكوى</button><button class="btn sm bad" data-cdel="${c.id}">حذف</button></div></div>`).join('') : '<div class="empty">لا توجد شكاوى مفتوحة</div>';
  $$('[data-cw]').forEach((b) => { b.onclick = async () => {
    const reason = await ask('إنذار', 'سبب الإنذار (يظهر لصاحب الحساب)');
    try { const r = await api('POST', `/api/admin/complaints/${b.dataset.cw}/warn`, { reason }); toast(r.suspended ? `الإنذار ${r.count} — أُوقف الحساب تلقائياً` : `الإنذار ${r.count} من ${r.max}`); complaints(); } catch (e) { fail(e); }
  }; });
  $$('[data-cdel]').forEach((b) => { b.onclick = () => confirmDel('حذف الشكوى؟', `/api/admin/complaints/${b.dataset.cdel}`, complaints); });
  $$('[data-chat]').forEach((b) => { b.onclick = async () => {
    try { const { messages } = await api('GET', `/api/admin/errands/${b.dataset.chat}/messages`); sheet(`<h2>الدردشة — طلب #${b.dataset.chat}</h2><div class="chat">${messages.map((m) => `<p class="${m.from_type === 'driver' ? 'me' : ''}"><b>${m.from_type === 'driver' ? 'السائق' : 'الزبون'}:</b> ${esc(m.body)}<br><small class="mute">${esc(when(m.created_at))}</small></p>`).join('') || '<p class="mute">لا توجد رسائل</p>'}</div><button class="btn alt" data-close>إغلاق</button>`); } catch (e) { fail(e); }
  }; });
  $$('[data-cd]').forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/admin/complaints/${b.dataset.cd}/dismiss`, {}); complaints(); } catch (e) { fail(e); } }; });
}

async function settings() {
  const { settings: s, smsVerification, roads } = await api('GET', '/api/admin/delivery/settings');
  const F = [['payoutThreshold', 'الحد الأدنى لسحب السائق ($)'], ['cashLimit', 'حدّ نقود المطاعم مع السائق ($) — فوقه تتوقف عنه الطلبات النقدية فقط'], ['claimWindowSec', 'مهلة القبول بالثواني (الأقرب يفوز)'], ['reserveShowSec', 'مدة ظهور «محجوز» للآخرين (ثانية)'], ['confirmAfterMin', 'التأكيد التلقائي للاستلام بعد (دقيقة)'], ['lateAfterMin', 'السائق متأخر بعد (دقيقة)'], ['storeMinWithdraw', 'الحد الأدنى لسحب المتجر ($)'], ['dailyWithdrawMax', 'أقصى سحب للحساب في اليوم ($)'], ['maxWarnings', 'عدد الإنذارات للإيقاف التلقائي'], ['warningMonths', 'مدة احتساب الإنذار (أشهر)'], ['dispatchRadiusKm', 'مسافة ظهور طلبات المتاجر للسائق — بالطريق (كم)'], ['errandRadiusKm', 'مسافة ظهور طلبات الزبائن «اطلب سائقاً» للسائق — بالطريق (كم)'], ['routeDailyMax', 'حدّ حسابات المسافة بالطريق في اليوم (Geoapify: المجاني 3000)'], ['offerBatch', 'عدد السائقين الذين يصلهم الطلب'], ['raiseAfterSec', 'بعد كم ثانية يُعرض رفع الأجرة'], ['driverStaleSec', 'السائق غير متاح إذا لم يتحدّث موقعه خلال (ثانية)'], ['cartIdleMin', 'تُفرغ السلّة بعد الغياب (دقيقة)'], ['maxPurchaseValue', 'أقصى قيمة مشتريات في «أحضر لي من محل» ($)'], ['errandMinPrice', 'أقل سعر يعرضه الزبون على السائق ($)'], ['settleLinkMin', 'مهلة دفع رابط التسوية أونلاين (دقيقة) — بعدها يُلغى الرابط'], ['autoPayStores', 'تحويل حصة كل مطعم تلقائياً بعد تأكيد التسوية (1 = نعم، 0 = لا)']];
  pane().innerHTML = `<form id="sf" class="card">${F.map(([k, l]) => `<label class="f">${l}<input class="in" name="${k}" type="number" min="0" step="any" value="${s[k]}"></label>`).join('')}<button class="btn">حفظ</button></form>
    <div class="card"><h3>💾 النسخ الاحتياطي</h3><p class="small">النسخة الكاملة (كل شيء: المتاجر والفروع، الزبائن، السائقون ووثائقهم، الطلبات، الأرصدة، السحوبات، الدردشات…) من القائمة ← «النسخ الاحتياطي». احفظها في Google Drive وعلى هاتفك. النسخة اليومية التلقائية تعمل عند ضبط مفاتيح BACKUP_S3 (انظر docs/PLAN.md).</p>
      <a class="btn alt" href="/api/admin/delivery/balances.csv">📄 تنزيل كشف الأرصدة (Excel)</a></div>
    <div class="card"><h3>🧹 تنظيف اللوحة</h3><p class="small mute">يحذف نهائياً كل الطلبات المنتهية والطلبات المباشرة والشكاوى المغلقة والسحوبات وطلبات الشحن المنتهية والمواعيد المنتهية. لا يحدث إلا عند ضغطك. الأرصدة والطلبات غير المدفوعة للمتاجر لا تتأثر.</p>
      <button class="btn bad" id="clean">🧹 تنظيف الآن</button></div>
    <div class="card"><h3>📏 المسافات بالطريق</h3><p class="${roads.enabled ? '' : 'mute'}">${roads.enabled ? `✅ تعمل (Geoapify) — اليوم: ${roads.used || 0} من ${s.routeDailyMax}. بعد الحد تُقدَّر المسافة من آخر قياس بالطريق.` : 'غير مفعّلة — تُحسب المسافة بخط مستقيم إلى أن يُضاف مفتاح GEOAPIFY_API_KEY في Render.'}</p></div>
    <div class="card"><h3>رمز التحقق بالـ SMS</h3><p class="${smsVerification ? '' : 'mute'}">${smsVerification ? '✅ مفعّل' : 'غير مفعّل — يعمل تلقائياً عند وضع مفاتيح SMS في Render (انظر docs/DELIVERY.md)'}</p></div>
    <div class="card"><h3>النصوص والأقسام والتصميم</h3><p class="small">كل نصوص التطبيق الجديد (بالأربع لغات) تحت المفتاح <b>dx</b> في محرّر النصوص. الأقسام وترتيبها وأسعار الاشتراكات من لوحة الإدارة الرئيسية.</p></div>`;
  $('#clean').onclick = async () => {
    if (!confirm('تأكيد الحذف النهائي للعناصر المنتهية القديمة؟')) return;
    try { const r = await api('POST', '/api/admin/delivery/cleanup', { all: true }); toast(`حُذف: ${r.orders} طلب، ${r.errands} طلب سائق، ${r.complaints} شكوى، ${r.withdrawals} سحب`); } catch (e) { fail(e); }
  };
  $('#sf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(F.map(([k]) => [k, Number(e.target[k].value)]));
    try { await api('PUT', '/api/admin/delivery/settings', body); toast('تم الحفظ'); } catch (x) { fail(x); }
  });
}

window.addEventListener('hashchange', () => { const t2 = new URLSearchParams(location.hash.slice(1)).get('t'); if (t2 && t2 !== tab) { tab = t2; frame(); } });
if (/delivery\.html$/.test(location.pathname)) location.replace('./#dx-overview');   // everything lives in the admin panel's side menu now


/* ---------- prices & durations ---------- */
async function plans() {
  const { plans: p, gateways: gw = {} } = await api('GET', '/api/admin/plans');
  const M = { 1: 'شهر', 3: '3 أشهر', 12: 'سنة' };
  const grp = (key, title, g) => `<div class="card"><h3>${title}</h3>${Object.entries(g).map(([m, x]) => `<div class="row"><span>${M[m] || m}</span>
    <input class="in price-in" type="number" min="0" step="0.5" data-g="${key}" data-m="${m}" value="${x.price}">
    <label class="check"><input type="checkbox" data-hid="${key}:${m}" ${x.hidden ? 'checked' : ''}><span>إخفاء</span></label></div>`).join('')}</div>`;
  pane().innerHTML = `<p class="mute small">الأسعار بالدولار. المدة المخفية لا تظهر في صفحات الاشتراك.</p>
    ${grp('store.delivery', '🏪 اشتراك المتاجر مع ميزة طلب السائقين', p.store.delivery)}
    ${grp('store.basic', '🏪 اشتراك المتاجر بدون طلب سائقين', p.store.basic)}
    <div class="card"><h3>🏬 الفروع</h3><label class="f">نسبة كل فرع إضافي من سعر الاشتراك (%)<input class="in" id="bp" type="number" min="0" max="100" value="${p.branchPercent}"></label>
      <p class="mute small">مثال: اشتراك 10$ و50% ← فرعان = 15$، ثلاثة فروع = 20$ (تُحسب تلقائياً).</p></div>
    ${grp('driverJobs', '🛵 اشتراك السائق لاستقبال طلبات الزبائن', p.driverJobs)}
    <div class="card"><h3>📲 أرقام استلام الدفع (للمتاجر عند التجديد، وللسائقين عند التسوية)</h3>
      <label class="f">رقم Whish Money<input class="in" id="ptW" type="tel" value="${esc(p.payTo?.whish || '')}" placeholder="+961 70 000000"></label>
      <label class="f">رقم OMT<input class="in" id="ptO" type="tel" value="${esc(p.payTo?.omt || '')}"></label>
      <label class="f">الاسم على الحساب<input class="in" id="ptN" maxlength="60" value="${esc(p.payTo?.name || '')}"></label>
      <label class="f">بلدان Whish و OMT (رموز البلدان مفصولة بفاصلة، فارغ = كل البلدان)<input class="in" id="ptC" dir="ltr" value="${esc(p.payTo?.countries ?? 'LB')}" placeholder="LB"></label>
      <label class="check"><input type="checkbox" id="ptCard" ${p.payTo?.cardSettle !== false ? 'checked' : ''}><span>السماح للسائقين بدفع التسوية بالبطاقة (يعمل في كل البلدان عند ربط بوابة البطاقة)</span></label></div>
    <div class="card"><h3>🌍 طرق تسوية إضافية لكل بلد</h3>
      <p class="mute small">للبلدان التي لا يوجد فيها Whish أو OMT: تحويل بنكي، محفظة محلية… يظهر للسائق في بلده فقط، ويرفع صورة الإيصال وتتحقّق منها أنت.</p>
      ${[0, 1, 2, 3, 4, 5].map((i) => { const x = p.payTo?.extra?.[i] || {}; return `<div class="grid2 xm" data-xm="${i}">
        <label class="f">اسم الطريقة<input class="in" data-k="label" maxlength="40" value="${esc(x.label || '')}" placeholder="${i ? '' : 'تحويل بنكي'}"></label>
        <label class="f">الرقم / IBAN<input class="in" data-k="account" dir="ltr" maxlength="60" value="${esc(x.account || '')}"></label>
        <label class="f">الاسم على الحساب<input class="in" data-k="name" maxlength="60" value="${esc(x.name || '')}"></label>
        <label class="f">البلدان<input class="in" data-k="countries" dir="ltr" value="${esc(x.countries || '')}" placeholder="${i ? '' : 'SY, IQ'}"></label></div>`; }).join('<hr>')}</div>
    <div class="card"><h3>⚡ الدفع والتحويل التلقائي</h3>
      ${[['whish', 'استلام تسويات السائقين عبر Whish (رابط بمبلغ محدد)', 'WHISH_PAY_URL / KEY / SECRET'], ['omt', 'استلام تسويات السائقين عبر OMT', 'OMT_PAY_URL / KEY / SECRET'], ['card', 'بوابة البطاقة (طلبات الزبائن، التجديد، تسويات بالبطاقة)', 'PAY_CHECKOUT_URL / PAY_API_KEY / PAY_WEBHOOK_SECRET'], ['payoutWhish', 'تحويل حصص المطاعم والسحوبات إلى Whish تلقائياً', 'WHISH_PAYOUT_URL / KEY'], ['payoutOmt', 'تحويل حصص المطاعم والسحوبات إلى OMT تلقائياً', 'OMT_PAYOUT_URL / KEY'], ['refund', 'إعادة مبلغ البطاقة للزبون تلقائياً عند رفض/إلغاء طلب مدفوع', 'PAY_REFUND_URL']]
        .map(([k, l, env]) => `<p class="small">${gw[k] ? '✅' : '⏸'} ${l}${gw[k] ? '' : ` — <span class="mute">يعمل عند وضع ${env} في Render</span>`}</p>`).join('')}</div>
    <p class="mute small">💡 كل الميزات اختيارية: ضع السعر 0 لتكون مجانية، أو أخفِ المدة. سعر «حجز المواعيد» لكل قسم من «الاشتراكات والحدود» (0 = مجاني).</p>
    <button class="btn" id="psave">حفظ الأسعار</button>`;
  $('#psave').onclick = async () => {
    const body = { store: { delivery: {}, basic: {} }, driverJobs: {}, branchPercent: Number($('#bp').value), payTo: { whish: $('#ptW').value, omt: $('#ptO').value, name: $('#ptN').value, countries: $('#ptC').value, cardSettle: $('#ptCard').checked,
      extra: $$('[data-xm]').map((r) => Object.fromEntries([...r.querySelectorAll('[data-k]')].map((i) => [i.dataset.k, i.value.trim()]))).filter((x) => x.label && x.account) } };
    const put = (key, m, k, v) => { const [a, b2] = key.split('.'); const tgt = b2 ? body[a][b2] : body[a]; (tgt[m] ||= {})[k] = v; };
    $$('[data-g]').forEach((i) => put(i.dataset.g, i.dataset.m, 'price', Number(i.value)));
    $$('[data-hid]').forEach((c) => { const [key, m] = c.dataset.hid.split(':'); put(key, m, 'hidden', c.checked); });
    try { await api('PUT', '/api/admin/plans', body); toast('تم الحفظ'); } catch (e) { fail(e); }
  };
}


/* ---------- money center: cash held by drivers, settlements (automatic breakdown), disputes, card refunds, journal ---------- */
const SST = { pending: 'بانتظار التحقق', verified: 'تم التحقق', rejected: 'مرفوضة', correction: 'طُلب تصحيحها', awaiting_payment: 'رابط بانتظار الدفع', expired: 'انتهت مهلة الرابط' };
const SEC = {
  settle_amount_mismatch: '💰 مبلغ تسوية غير مطابق', settle_duplicate_reference: '🔁 رقم عملية مستعمل من قبل', settle_other_sender: '📤 تحويل من رقم غير رقم السائق',
  bad_signature: '🛑 إشعار دفع مزوّر (توقيع خاطئ)', settle_payment_failed: '❌ فشل/إلغاء دفع أونلاين', settle_paid_twice: '⚠️ دفع متأخر/مكرر لتسوية',
  settle_unexpected_payment: '⚠️ دفع لتسوية مرفوضة', settle_wrong_gateway: '🛑 إشعار من مزوّد غير المزوّد الصحيح', settle_rejected: '⛔ تسوية رفضتها',
  payout_failed: '💸 فشل التحويل التلقائي لمطعم', cash_limit_attempt: '🚧 محاولة أخذ طلب نقدي فوق الحد',
};
const SEV = { high: 'b', warn: 'w', info: '' };
async function finance(view = 'pending') {
  const { overview: o } = await api('GET', '/api/admin/finance/overview');
  const head = `<div class="grid2">
    <div class="stat"><b>${money(o.cashHeldByDrivers)}</b><span>نقود المطاعم لدى السائقين</span></div>
    <div class="stat"><b>${money(o.pendingSettlements)}</b><span>تسويات بانتظارك (${o.pendingCount})</span></div>
    <div class="stat"><b>${money(o.verifiedSettlements)}</b><span>تسويات تم التحقق منها</span></div>
    <div class="stat"><b>${money(o.driverEarnings)}</b><span>أرباح السائقين من التوصيل</span></div>
    <div class="stat"><b>${money(o.cardCollected)}</b><span>مدفوع بالبطاقة</span></div>
    <div class="stat ${o.violations ? 'hl' : ''}"><b>${o.violations || 0}</b><span>🚨 مخالفات لم تُراجَع</span></div></div>
    <div class="tabs">${[['pending', 'بانتظار التحقق'], ['awaiting_payment', '⏳ روابط بانتظار الدفع'], ['verified', 'المُحقَّقة'], ['correction', 'للتصحيح'], ['rejected', 'المرفوضة'], ['security', `🚨 المخالفات${o.violations ? ` (${o.violations})` : ''}`], ['owed', '💵 مستحقات المطاعم'], ['disputes', '⚖️ نزاعات'], ['refunds', '↩️ استرداد بطاقة'], ['journal', '📒 السجل المالي']].map(([k, n]) => `<button data-fv="${k}" class="${k === view ? 'on' : ''}">${n}</button>`).join('')}</div>`;
  let body = '';
  if (['pending', 'verified', 'correction', 'rejected', 'awaiting_payment'].includes(view)) {
    const { settlements } = await api('GET', `/api/admin/settlements?status=${view}`);
    body = settlements.map((x) => `<div class="card"><div class="row"><b>${esc(x.ref)} — 🛵 ${esc(x.driver)}</b><b>${money(x.amount)}</b></div>
      <p class="small">${esc(x.methodLabel || x.method)} · رقم العملية: <b dir="ltr">${esc(x.provider_ref || x.reference)}</b> · ${esc(when(x.created_at))} · <span class="chip">${SST[x.status] || x.status}</span></p>
      ${x.gateway ? `<p class="small">🌐 دفع أونلاين برابط مبلغه ثابت ${money(x.amount)}${x.paid_amount != null ? ` · المدفوع فعلاً: <b>${money(x.paid_amount)}</b> ${Math.round(x.paid_amount * 100) === Math.round(x.amount * 100) ? '<span class="chip g">مطابق — تأكد تلقائياً</span>' : '<span class="chip b">غير مطابق</span>'}` : ''}${x.status === 'awaiting_payment' && x.expires_at ? ` · ينتهي ${esc(when(x.expires_at))}` : ''}</p>` : ''}
      <p class="small">🆔 رمز السائق في ملاحظة التحويل: <b dir="ltr">D${x.driver_id}</b> · 📱 هاتفه: <b dir="ltr">+${esc(x.phone)}</b>${x.wallet_number ? ` · حسابه: <b dir="ltr">+${esc(x.wallet_number)}</b>` : ''}</p>
      <p class="small">📤 حُوِّل من رقم: <b dir="ltr">${x.sender_number ? `+${esc(x.sender_number)}` : '—'}</b> ${x.sender_number && x.sender_number !== x.wallet_number ? '<span class="chip w">⚠️ ليس رقم السائق — راجِع الإيصال</span>' : ''}</p>
      <p class="mute tiny">🔎 للتأكد: في سجل Whish/OMT عندك ابحث عن رقم العملية نفسه، والمبلغ ${money(x.amount)} بالضبط، والرقم المُرسِل أو الرمز D${x.driver_id} في الملاحظة.</p>
      ${x.note ? `<p class="small mute">📝 ${esc(x.note)}</p>` : ''}
      <h3>التوزيع التلقائي على المطاعم</h3>
      ${x.breakdown.stores.map((g) => `<details><summary><b>${esc(g.store)}</b> ← ${money(g.amount)} (${g.orders.length} طلب)</summary>
        <table class="inv"><tbody>${g.orders.map((r) => `<tr><td>${esc(r.ref)}</td><td>${esc(when(r.deliveredAt))}</td><td>${money(r.amount)}</td></tr>`).join('')}</tbody></table></details>`).join('')}
      <div class="row"><b>المجموع</b><b>${money(x.breakdown.total)}</b></div>
      ${x.hasReceipt ? `<button class="btn sm alt" data-rc="${x.id}">🧾 الإيصال</button>` : ''}
      ${x.status === 'pending' ? `<div class="grid2"><button class="btn" data-sv="${x.id}" data-x="verify">✅ تحقّقت من التحويل</button><button class="btn alt" data-sv="${x.id}" data-x="correction">✏️ طلب تصحيح</button></div><button class="btn bad" data-sv="${x.id}" data-x="reject">رفض</button>` : ''}</div>`).join('') || '<div class="empty">لا شيء</div>';
  } else if (view === 'security') {
    const { events, drivers } = await api('GET', '/api/admin/finance/violations');
    body = `<p class="small">كل ما هو مشبوه في المال يُسجَّل هنا تلقائياً مع اسم السائق والوقت. الأحمر خطير، والأصفر للمراجعة، والرمادي للعلم.</p>
      ${drivers.length ? `<div class="card"><h3>السائقون الأكثر مخالفات</h3>${drivers.map((d) => `<div class="row item"><span>🛵 ${esc(d.driver)} <small class="mute">D${d.driver_id}</small><br><small>${d.n} مخالفة${d.high ? ` · <b class="chip b">${d.high} خطيرة</b>` : ''}</small></span>
        ${d.status === 'suspended' ? '<span class="chip">موقوف</span>' : `<button class="btn sm bad" data-susp="${d.driver_id}">⛔ إيقاف السائق</button>`}</div>`).join('')}</div>` : ''}
      <button class="btn sm alt" id="seenAll">✔️ تعليم الكل كمُراجَع</button>
      ${events.map((e) => `<div class="card ${e.seen ? '' : 'hl'}"><div class="row"><b>${SEC[e.kind] || esc(e.kind)}</b><span class="chip ${SEV[e.severity] || ''}">${e.severity === 'high' ? 'خطير' : e.severity === 'warn' ? 'للمراجعة' : 'للعلم'}</span></div>
        <p class="small">${e.driver ? `🛵 ${esc(e.driver)} <b dir="ltr">${esc(e.driverCode)}</b> · +${esc(e.driver_phone || '')}` : ''}${e.store ? ` 🏪 ${esc(e.store)}` : ''}${e.settlementRef ? ` · ${esc(e.settlementRef)}` : ''}</p>
        ${e.amount != null ? `<p class="small">المبلغ: <b>${money(e.amount)}</b>${e.expected != null ? ` · المطلوب: <b>${money(e.expected)}</b>` : ''}</p>` : ''}
        ${e.detail ? `<p class="small mute" dir="auto">${esc(e.detail)}</p>` : ''}<p class="tiny mute">${esc(when(e.created_at))}</p>
        ${e.seen ? '' : `<button class="btn sm alt" data-seen="${e.id}">✔️ راجعتها</button>`}</div>`).join('') || '<div class="empty">لا مخالفات 👌</div>'}`;
  } else if (view === 'owed') {
    const { stores } = await api('GET', '/api/admin/finance/stores-owed');
    const total = stores.reduce((a, x) => a + Math.round(x.balance * 100), 0) / 100;
    body = `<p class="small">أموال المطاعم الموجودة عندك ولم تُحوَّل بعد. بعد كل تسوية تُحوَّل حصة كل مطعم تلقائياً إلى رقم استلامه (عند ربط مفاتيح التحويل)؛ ما فشل تحويله يظهر في «السحوبات» بانتظارك. المطعم يستطيع أيضاً طلب السحب من صفحته.</p>
      <div class="stat"><b>${money(total)}</b><span>المجموع المستحق للمطاعم</span></div>` + (stores.map((x) => `<div class="card"><div class="row"><b>🏪 ${esc(x.store)} <small class="mute">${esc(x.country)}</small></b><b>${money(x.balance)}</b></div>
      <p class="small">📱 <b dir="ltr">+${esc(x.whatsapp || '')}</b>${x.payout_number ? ` · رقم الاستلام (${esc((x.payout_provider || 'whish').toUpperCase())}): <b dir="ltr">+${esc(x.payout_number)}</b>` : ' · <span class="chip w">لم يضع رقم استلام — لا يمكن التحويل التلقائي</span>'}</p></div>`).join('') || '<div class="empty">لا مستحقات</div>');
  } else if (view === 'disputes') {
    const { disputes } = await api('GET', '/api/admin/finance/disputes');
    body = disputes.map((d) => `<div class="card"><div class="row"><b>AKL${d.id} — ${esc(d.store)}</b><span>${money(d.customer_total ?? d.total)}</span></div>
      <p class="small">🛵 ${esc(d.driver || '—')} · ${d.payment_method === 'card' ? '💳 بطاقة' : '💵 نقدي'} · ${esc(when(d.delivered_at))}</p><p class="small">📝 ${esc(d.cancel_note || '')}</p>
      <div class="grid2"><button class="btn" data-dc="${d.id}">✅ وصل الطلب — أكمِل</button><button class="btn bad" data-dr="${d.id}">↩️ عكس/استرداد</button></div></div>`).join('') || '<div class="empty">لا نزاعات</div>';
  } else if (view === 'refunds') {
    const { refunds } = await api('GET', '/api/admin/finance/refunds');
    body = `<p class="mute small">طلبات دُفعت بالبطاقة ثم أُلغيت/رُفضت/عُكست. عند ربط PAY_REFUND_URL تُعاد تلقائياً للزبون (حتى 5 محاولات) ولا يبقى هنا إلا ما فشل. غير ذلك: أعِد المبلغ من لوحة مزوّد الدفع ثم اضغط «تم الاسترداد».</p>` + (refunds.map((r) => `<div class="card"><div class="row"><b>AKL${r.id} — ${esc(r.store)}</b><b>${money(r.customer_total)}</b></div>
      <p class="small">👤 ${esc(r.customer)} · +${esc(r.phone)}${r.close_reason === 'out_of_area' ? ' · 📍 خارج منطقة التوصيل' : ''}${r.cancel_note ? ` · ${esc(r.cancel_note)}` : ''}</p>${r.refund_error ? `<p class="small"><span class="chip w">فشل الاسترداد التلقائي (${Number(r.refund_tries) || 0}): ${esc(r.refund_error)}</span></p>` : ''}<button class="btn" data-rf="${r.id}">✅ تم الاسترداد</button></div>`).join('') || '<div class="empty">لا شيء</div>');
  } else {
    body = `<form id="jf" class="card"><div class="grid2"><label class="f">رقم الطلب<input class="in" name="order" inputmode="numeric"></label><label class="f">رقم التسوية<input class="in" name="settlement" inputmode="numeric"></label>
      <label class="f">رقم السائق<input class="in" name="driver" inputmode="numeric"></label><label class="f">رقم المتجر<input class="in" name="store" inputmode="numeric"></label></div>
      <label class="f">طريقة الدفع<select class="in" name="method"><option value="">الكل</option><option value="cash">نقدي</option><option value="card">بطاقة</option></select></label><button class="btn">بحث</button></form><div id="jr"></div>`;
  }
  pane().innerHTML = head + body;
  $$('[data-fv]').forEach((b) => { b.onclick = () => finance(b.dataset.fv).catch(fail); });
  $$('[data-seen]').forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/admin/finance/violations/${b.dataset.seen}/seen`, {}); finance('security'); } catch (e) { fail(e); } }; });
  $('#seenAll')?.addEventListener('click', async () => { try { await api('POST', '/api/admin/finance/violations/all/seen', {}); finance('security'); } catch (e) { fail(e); } });
  $$('[data-susp]').forEach((b) => { b.onclick = async () => { if (!confirm('إيقاف هذا السائق؟ لن يستقبل أي طلب حتى تعيد تفعيله.')) return; try { await api('POST', `/api/admin/accounts/driver/${b.dataset.susp}/suspend`, {}); toast('أُوقف السائق'); finance('security'); } catch (e) { fail(e); } }; });
  $$('[data-rc]').forEach((b) => { b.onclick = () => openPrivateImage(`/api/admin/settlements/${b.dataset.rc}/receipt`); });
  $$('[data-sv]').forEach((b) => { b.onclick = async () => {
    const x = b.dataset.x;
    let note = '';
    if (x !== 'verify') { note = await ask(x === 'reject' ? 'سبب الرفض' : 'ماذا يجب أن يصحّح السائق؟', 'الملاحظة', { min: x === 'correction' ? 3 : 0 }); }
    else if (!confirm('تأكيد: وصل التحويل كاملاً؟ سيُضاف لكل مطعم نصيبه ويُصفَّر ما على السائق.')) return;
    try { await api('POST', `/api/admin/settlements/${b.dataset.sv}/${x}`, { note }); toast('تم'); finance(view); } catch (e) { toast(e.code === 'settlement_amount_mismatch' ? '⛔ المبلغ لا يطابق التوزيع — لم يتغيّر شيء' : (ERR[e.code] || 'حدث خطأ')); }
  }; });
  $$('[data-dc]').forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/admin/orders/${b.dataset.dc}/complete`, {}); toast('اكتمل الطلب'); finance('disputes'); } catch (e) { fail(e); } }; });
  $$('[data-dr]').forEach((b) => { b.onclick = async () => { const reason = await ask('سبب العكس/الاسترداد', 'السبب'); try { await api('POST', `/api/admin/orders/${b.dataset.dr}/reverse`, { reason }); toast('تم'); finance('disputes'); } catch (e) { fail(e); } }; });
  $$('[data-rf]').forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/admin/orders/${b.dataset.rf}/refunded`, {}); toast('تم'); finance('refunds'); } catch (e) { fail(e); } }; });
  $('#jf')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const qs = new URLSearchParams([...new FormData(e.target)].filter(([, v]) => v)).toString();
    try {
      const { journal } = await api('GET', `/api/admin/finance/journal?${qs}`);
      $('#jr').innerHTML = `<table class="inv"><thead><tr><th>#</th><th>النوع</th><th>الطلب</th><th>المبلغ</th><th>الطريقة</th><th>الوقت</th></tr></thead><tbody>${journal.map((j) => `<tr><td>${j.id}</td><td>${esc(j.kind)}</td><td>${j.order_id ? `AKL${j.order_id}` : j.settlement_id ? `S-${j.settlement_id}` : ''}</td><td>${money(j.amount)}</td><td>${esc(j.payment_method || '')}</td><td>${esc(when(j.created_at))}</td></tr>`).join('')}</tbody></table>`;
    } catch (x) { fail(x); }
  });
}

/* ---------- subscription renewals sent by stores ---------- */
async function renewals(status = 'pending') {
  const { renewals: rows } = await api('GET', `/api/admin/renewals?status=${status}`);
  const KIND = { delivery: 'مع طلب السائقين', basic: 'بدون سائقين' };
  pane().innerHTML = `<div class="tabs">${[['pending', 'بانتظار الموافقة'], ['approved', 'المقبولة'], ['rejected', 'المرفوضة'], ['all', 'الكل']].map(([k, n]) => `<button data-rs="${k}" class="${k === status ? 'on' : ''}">${n}</button>`).join('')}</div>
    ${rows.map((r) => `<div class="card"><div class="row"><b>🏪 ${esc(r.store)}</b><b>${money(r.amount)}</b></div>
      <p class="small">${r.branch_id ? `🏬 فرع إضافي (حتى نهاية الاشتراك: ${r.months} شهر)` : `${KIND[r.kind] || r.kind} · ${r.months === 12 ? 'سنة' : r.months === 1 ? 'شهر' : `${r.months} أشهر`} · ${r.branches} ${r.branches > 1 ? 'فروع' : 'فرع'}`}</p>
      <p class="small mute">${esc(r.method)}${r.reference ? ` · مرجع: ${esc(r.reference)}` : ''} · ${esc(when(r.created_at))}</p>
      <button class="btn sm alt" data-rr="${r.id}">🧾 الإيصال</button>
      ${r.status === 'pending' ? `<div class="grid2"><button class="btn" data-ra="${r.id}" data-x="approve">✅ قبول وتجديد</button><button class="btn bad" data-ra="${r.id}" data-x="reject">رفض</button></div>` : `<span class="chip">${STATUS[r.status] || r.status}</span>`}</div>`).join('') || '<div class="empty">لا طلبات</div>'}
    <p class="mute small">عند القبول يتجدّد الاشتراك تلقائياً (ويُضاف إلى نهايته إن كان سارياً)، وتُحتسب عمولة رابط الإحالة إن وُجد.</p>`;
  $$('[data-rs]').forEach((b) => { b.onclick = () => renewals(b.dataset.rs).catch(fail); });
  $$('[data-rr]').forEach((b) => { b.onclick = () => openPrivateImage(`/api/admin/renewals/${b.dataset.rr}/receipt`); });
  $$('[data-ra]').forEach((b) => { b.onclick = async () => { if (b.dataset.x === 'reject' && !confirm('رفض الطلب؟')) return; try { await api('POST', `/api/admin/renewals/${b.dataset.ra}/${b.dataset.x}`, {}); toast('تم'); renewals(status); } catch (e) { fail(e); } }; });
}

/* ---------- the owner's phone gets a notification for every new money request, driver and complaint ---------- */
async function adminPush() {
  if (!('serviceWorker' in navigator && 'PushManager' in window)) return toast('هذا المتصفح لا يدعم الإشعارات');
  if (await Notification.requestPermission() !== 'granted') return toast('لم يُسمح بالإشعارات');
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { key } = await api('GET', '/api/push/key');
    const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((key.length + 3) % 4)), (c) => c.charCodeAt(0));
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
  }
  const j = sub.toJSON();
  await api('POST', '/api/push/subscribe', { role: 'admin', endpoint: j.endpoint, keys: j.keys });
  toast('✅ ستصلك الإشعارات على هذا الهاتف');
}

/* ---------- messages to all drivers / all stores ---------- */
async function broadcasts() {
  const { broadcasts: rows } = await api('GET', '/api/admin/broadcasts');
  pane().innerHTML = `<form id="bf" class="card"><h3>رسالة جديدة</h3>
    <label class="f">إلى<select class="in" name="aud"><option value="drivers">🛵 كل السائقين</option><option value="stores">🏪 كل المتاجر والمطاعم</option></select></label>
    <label class="f">البلد<select class="in" name="cc"><option value="">كل البلدان</option>${COUNTRIES.map((c) => `<option value="${c}">${c}</option>`).join('')}</select></label>
    <label class="f">النص (قوانين جديدة، تنبيه…)<textarea class="in" name="body" required minlength="2" maxlength="2000"></textarea></label>
    <label class="f">مدة الظهور<select class="in" name="days"><option value="1">يوم</option><option value="3">3 أيام</option><option value="7" selected>أسبوع</option><option value="30">شهر</option><option value="">حتى أحذفها</option></select></label>
    <p class="mute small">تظهر في صفحاتهم فقط (لا يراها الزبائن)، وتصلهم كإشعار على الهاتف.</p>
    <button class="btn">إرسال</button></form>
    ${rows.map((b) => `<div class="card"><div class="row"><b>${b.audience === 'drivers' ? '🛵 السائقون' : '🏪 المتاجر'} ${b.country ? `· ${esc(b.country)}` : ''}</b><span class="small mute">${b.expires_at ? `حتى ${esc(when(b.expires_at))}` : 'بلا انتهاء'}</span></div>
      <p class="legal">${esc(b.body)}</p><button class="btn sm bad" data-bx="${b.id}">حذف من عند الجميع</button></div>`).join('')}`;
  $('#bf').addEventListener('submit', async (e) => {
    e.preventDefault(); const f = e.target;
    try { await api('POST', '/api/admin/broadcasts', { audience: f.aud.value, country: f.cc.value || null, body: f.body.value, days: f.days.value ? Number(f.days.value) : null }); toast('أُرسلت'); broadcasts(); } catch (x) { fail(x); }
  });
  $$('[data-bx]').forEach((b) => { b.onclick = () => confirmDel('حذف الرسالة من عند الجميع؟', `/api/admin/broadcasts/${b.dataset.bx}`, broadcasts); });
}

/* ---------- ready designs for the whole platform ---------- */
async function designs() {
  const d = await api('GET', '/api/admin/designs');
  pane().innerHTML = `<p class="mute small">اختر تصميماً جاهزاً للتطبيق والمنصة ولوحة الإدارة (ألوان، أشكال البطاقات والصور، وتأثيرات ثلاثية الأبعاد). «ألواني الخاصة» يستعمل الألوان التي اخترتها في قسم «التصميم».</p>
    <div class="designs">${d.designs.map((x) => `<button class="card design ${x.key === d.current ? 'hl' : ''}" data-dz="${x.key}">
      <div class="swatch">${x.colors.map((c) => `<i data-c="${esc(c)}"></i>`).join('') || '🎨'}</div><b>${esc(x.name.ar)}</b>${x.key === d.current ? '<span class="chip g">مفعّل</span>' : ''}</button>`).join('')}</div>
    <a class="btn alt" href="/" target="_blank">👁 معاينة التطبيق</a>`;
  $$('[data-c]').forEach((i) => { i.style.background = i.dataset.c; });   // CSSOM is allowed by the security policy
  $$('[data-dz]').forEach((b) => { b.onclick = async () => { try { await api('PUT', '/api/admin/designs', { key: b.dataset.dz }); toast('تم تطبيق التصميم'); location.reload(); } catch (e) { fail(e); } }; });
}

/* ---------- delete a whole country / category ---------- */
async function places() {
  const cfg = await api('GET', '/api/config');
  const cats = (cfg.site?.categories || []);
  pane().innerHTML = `<div class="card"><h3>🌍 حذف بلد بالكامل</h3><p class="mute small">يحذف كل المحلات المستوردة والمشتركين في هذا البلد ويخفيه من كل القوائم. لإخفائه فقط دون حذف استعمل «البلدان والوكلاء».</p>
      <select class="in" id="dc">${(cfg.countries || []).map((c) => `<option value="${c}">${c}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" id="dpeople"><span>احذف أيضاً السائقين والزبائن المسجّلين في هذا البلد</span></label>
      <button class="btn bad" id="dcgo">حذف البلد</button></div>
    <div class="card"><h3>🗂 حذف قسم بالكامل</h3><p class="mute small">يحذف القسم ويختفي من التطبيق. يمكنك حذف كل محلاته معه.</p>
      <select class="in" id="dk">${cats.map((c) => `<option value="${esc(c.key)}">${esc(c.icon || '')} ${esc(c.names?.ar?.many || c.key)}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" id="dkshops" checked><span>احذف كل المحلات في هذا القسم</span></label>
      <button class="btn bad" id="dkgo">حذف القسم</button></div>`;
  $('#dcgo').onclick = async () => {
    const cc = $('#dc').value;
    if (prompt(`للتأكيد اكتب رمز البلد ${cc}`) !== cc) return;
    try { const r = await api('DELETE', `/api/admin/countries/${cc}?people=${$('#dpeople').checked ? 1 : 0}`); toast(`حُذف: ${r.stores} محل، ${r.drivers} سائق، ${r.customers} زبون`); places(); } catch (e) { fail(e); }
  };
  $('#dkgo').onclick = async () => {
    const k = $('#dk').value;
    if (!confirm('حذف القسم نهائياً؟')) return;
    try { const r = await api('DELETE', `/api/admin/categories/${k}?shops=${$('#dkshops').checked ? 1 : 0}`); toast(`حُذف القسم و${r.stores} محل`); places(); } catch (e) { fail(e); }
  };
}
