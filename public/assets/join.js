import { initI18n, t, api, errorText, esc, setRegion, getConfig, rememberCountry, fmtMoney } from './i18n.js?v=610';
import { servedAreasEditor, getPosition, locatedText, accuracyHtml, initMenu, explainGpsError, catLabel } from './ui.js?v=610';

const $ = (s) => document.querySelector(s);
const startedAt = Date.now();
let photo = null;
let coords = null;
let editor = null;
let cfg = null;
let kind = new URLSearchParams(location.search).get('type') || null;   // any category key (checked against the list at boot)

/** Cook or restaurant: same form, different fields, prices and texts. */
function showForm(k) {
  kind = k;
  $('#kindSelect').value = k || '';
  $('#formTitle').textContent = t('join.title');
  $('#formLead').textContent = t('join.leadAll');
  $('#fullNameLabel').textContent = t(!k || k === 'cook' ? 'join.fullName' : 'join.businessName');
  renderBookingOption(k);
  // shops may sign up without a WhatsApp number (they log in with their business name); home cooks always need one
  $('#noNumberField').hidden = !k || k === 'cook';
  if (!k || k === 'cook') { $('#noNumber').checked = false; toggleNumber(); }
  const tr = cfg.site?.trial?.[k];
  $('#kindTrial').textContent = k && tr?.enabled ? `🎁 ${t('join.trialNote', { days: tr.days })}` : '';
  renderCountryParts();
  window.scrollTo({ top: 0 });
}

/** Plan prices (USD or EUR by the cook's country) and the phone example follow the country. */
function priceText(plan) {
  const cur = cfg.billing?.currency || 'USD';
  const v = cfg.site?.prices?.[kind || 'cook']?.[plan]?.[cur.toLowerCase()];
  if (v === '' || v == null) return '';
  return ` — ${fmtMoney(Number(v), cur)}`;
}
function renderTrialNotes() {
  document.querySelectorAll('[data-trial]').forEach((el) => {
    const tr = cfg.site?.trial?.[el.dataset.trial];
    el.textContent = tr?.enabled ? ` · ${t('join.trialNote', { days: tr.days })}` : '';
  });
}
function renderCountryParts() {
  renderTrialNotes();
  // only the durations the owner shows (e.g. monthly only)
  const shown = cfg.plans.filter((k) => !(cfg.site?.plansHidden || []).includes(k));
  const prev = document.querySelector('input[name="plan"]:checked')?.value;
  const current = shown.includes(prev) ? prev : shown[0];
  chips('#planChips', 'plan', shown.map((k) => [k, t(`plans.${k}`) + priceText(k)]), { checked: [current] });
  $('#whatsappHint').textContent = t('join.whatsappHintIntl', { dial: cfg.country?.dialCode || '' });
  renderDriverPlan();
}
// v7.6: one place for prices — "Prices & durations" in the admin panel: type (with / without drivers) → durations → price,
// and a preview for several branches (branches are added later from the store page, each with its own place).
let plansPub = null;
const MONTH_KEY = { 1: 'monthly', 3: 'quarterly', 12: 'yearly' };
async function renderDriverPlan() {
  try { plansPub ||= await api('/api/plans'); } catch { return; }
  const ar = (document.documentElement.lang || 'ar') === 'ar';
  const typeNow = document.querySelector('input[name="drv"]:checked')?.value || '1';
  const g = (type) => (type === '1' ? plansPub.store.delivery : plansPub.store.basic);
  const fromP = (grp) => { const v = Object.values(grp || {}); return v.length ? ` — ${ar ? 'من' : 'from'} ${fmtMoney(Math.min(...v.map(Number)), 'USD')}` : ''; };
  $('#drvPlanTitle').textContent = ar ? 'نوع الاشتراك' : 'Subscription type';
  chips('#drvPlanChips', 'drv', [['1', (ar ? 'مع ميزة طلب سائقين للتوصيل' : 'With "request a driver"') + fromP(plansPub.store.delivery)], ['0', (ar ? 'بدون طلب سائقين' : 'Without drivers') + fromP(plansPub.store.basic)]], { checked: [typeNow] });
  const branches = Math.max(1, Math.min(20, Number($('#jBranches')?.value) || 1));
  const price = (base) => Math.round((Number(base) + (branches - 1) * Number(base) * plansPub.branchPercent / 100) * 100) / 100;
  const grp = g(typeNow);
  const prev = document.querySelector('input[name="plan"]:checked')?.value;
  const oldHidden = cfg.site?.plansHidden || [];
  const items = Object.entries(grp).map(([m, base]) => [MONTH_KEY[m], `${t(`plans.${MONTH_KEY[m]}`)} — ${fmtMoney(price(base), 'USD')}`]).filter(([k]) => k && !oldHidden.includes(k));
  if (items.length) chips('#planChips', 'plan', items, { checked: [items.some(([k]) => k === prev) ? prev : items[0][0]] });
  $('#drvPlanHint').textContent = ar ? `كل فرع إضافي يضيف ${plansPub.branchPercent}% من سعر الاشتراك. تضيف فروعك بعد التفعيل من صفحتك ← «الفروع».` : `Each extra branch adds ${plansPub.branchPercent}%. Add your branches after activation from your page → "Branches".`;
  if (!$('#jBranches')) {
    $('#drvPlanHint').insertAdjacentHTML('afterend', `<label class="label" for="jBranches">${ar ? 'عدد الفروع (لحساب السعر)' : 'Number of branches (for the price)'}</label><input class="input" id="jBranches" type="number" min="1" max="20" value="1" inputmode="numeric">`);
    $('#jBranches').addEventListener('input', renderDriverPlan);
    $('#drvPlanChips').addEventListener('change', renderDriverPlan);
  }
  $('#drvPlan').hidden = false;
}

function chips(container, name, items, { type = 'radio', checked = [] } = {}) {
  $(container).innerHTML = items.map(([value, label]) =>
    `<label class="chip"><input type="${type}" name="${name}" value="${esc(value)}" ${checked.includes(value) ? 'checked' : ''}><span>${esc(label)}</span></label>`).join('');
}

function showFieldErrors(fields = {}) {
  document.querySelectorAll('[data-err]').forEach((el) => {
    const code = fields[el.dataset.err];
    el.hidden = !code;
    el.textContent = code ? t(`errors.${code}`) : '';
    const input = document.getElementById(el.dataset.err);
    if (input) input.setAttribute('aria-invalid', code ? 'true' : 'false');
  });
  const first = document.querySelector('[data-err]:not([hidden])');
  if (first) first.closest('.field')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// Resize to max 320px JPEG in the browser so uploads stay small (~20–40 KB).
function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 320;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = reject;
    img.src = url;
  });
}

function setPreview() {
  const box = $('#photoPreview');
  box.innerHTML = photo ? `<img class="avatar" src="${photo}" alt="">` : '+';
  $('#photoRemove').hidden = !photo;
}

(async function boot() {
  await initI18n(); initMenu();
  try { cfg = await getConfig(); } catch (err) { $('#formError').textContent = errorText(err); $('#formError').hidden = false; return; }
  editor = servedAreasEditor($('#servedEditor'), { districts: cfg.districts });
  chips('#serviceChips', 'services', cfg.serviceTypes.map((k) => [k, t(`services.${k}`)]), { type: 'checkbox' });
  renderTrialNotes();
  // Placeholders become links (markers survive escaping, then are swapped for safe <a> tags).
  $('#consentText').innerHTML = esc(t('legal.acceptTerms', { terms: '\u0001T\u0001', privacy: '\u0001P\u0001' }))
    .replace('\u0001T\u0001', `<a href="/terms" target="_blank" rel="noopener">${esc(t('legal.termsLink'))}</a>`)
    .replace('\u0001P\u0001', `<a href="/privacy" target="_blank" rel="noopener">${esc(t('legal.privacyLink'))}</a>`);
  // "Type of business": every category (also those hidden on the home page, so the first subscriber can join)
  const cats = cfg.site?.categories || [];
  $('#kindSelect').innerHTML = `<option value="">${esc(t('join.kindPick'))}</option>`
    + ['shops', 'crafts'].filter((g) => !(cfg.site?.groupsHidden || []).includes(g)).map((g) => { const list = cats.filter((c) => (c.group === 'crafts' ? 'crafts' : 'shops') === g); return list.length ? `<optgroup label="${g === 'shops' ? '🏪' : '🛠️'} ${esc(t(`home.tab_${g}`))}">${list.map((c) => `<option value="${esc(c.key)}">${esc(c.icon)} ${esc(catLabel(c, 'one'))}</option>`).join('')}</optgroup>` : ''; }).join('');
  if (!cats.some((c) => c.key === kind)) kind = null;
  $('#kindSelect').addEventListener('change', (e) => { showForm(e.target.value || null); renderTrialNotes(); });
  showForm(kind);
})();

$('#gpsBtn').addEventListener('click', async () => {
  const s = $('#gpsStatus');
  const btn = $('#gpsBtn');
  s.classList.remove('bad');
  s.textContent = t('location.locating');
  btn.disabled = true;
  $('#gpsAccuracy').hidden = true;
  try {
    coords = await getPosition({ precise: true, maxWaitMs: 15000, goodEnough: 25, onProgress: (m) => { s.textContent = t('join.locatingPrecise', { m }); } });
  } catch (gpsErr) {
    coords = null; btn.disabled = false; explainGpsError(s, gpsErr, () => btn.click());
    return;
  }
  s.textContent = t('join.loadingAreas');
  try {
    const r = await editor.setPoint(coords.lat, coords.lng);
    // The cook's real country (from GPS) decides the price currency and phone format.
    if (r.country && r.country !== cfg.country?.code) {
      rememberCountry(r.country);
      try { cfg = await (await fetch(`/api/config?country=${r.country}`)).json(); renderCountryParts(); } catch { /* keep current */ }
    }
    s.textContent = locatedText(r);
    s.classList.toggle('bad', r.source === 'fallback');
    $('#gpsAccuracy').innerHTML = accuracyHtml(coords);
    $('#gpsAccuracy').hidden = false;
    if (!$('#homeArea').value && r.nearest) $('#homeArea').placeholder = r.nearest.name;
    btn.textContent = t('join.gpsAgain');
    btn.classList.replace('btn-gold', 'btn-ghost');
    document.querySelector('[data-err="location"]').hidden = true;
  } catch (err) {
    s.classList.add('bad'); s.textContent = errorText(err);
  } finally { btn.disabled = false; }
});

$('#photoInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try { photo = await resizeImage(f); } catch { photo = null; }
  setPreview();
});
$('#photoRemove').addEventListener('click', () => { photo = null; $('#photoInput').value = ''; setPreview(); });

// referral link: /join?ref=CODE — remembered for 30 days on this phone
function refCode() {
  try {
    const fromUrl = new URLSearchParams(location.search).get('ref');
    if (fromUrl && /^[A-Za-z0-9]{6,12}$/.test(fromUrl)) localStorage.setItem('st_ref', JSON.stringify({ c: fromUrl, at: Date.now() }));
    const s = JSON.parse(localStorage.getItem('st_ref') || 'null');
    return s && Date.now() - s.at < 30 * 864e5 ? s.c : undefined;
  } catch { return undefined; }
}
refCode();

// opening hours are required (or 24/7); pre-booking is an optional add-on with its own price
$('#jAllDay').addEventListener('change', () => { $('#jTimes').hidden = $('#jAllDay').checked; });
function hoursOk() { return $('#jAllDay').checked || ($('#jOpen').value && $('#jClose').value && $('#jOpen').value !== $('#jClose').value); }
function renderBookingOption(k) {
  const b = cfg.site?.booking || {};
  $('#jBookingField').hidden = b.enabled === false;   // optional add-on, shown always (free unless the owner set a price)
  const price = k ? Number(b.prices?.[k] || 0) : 0;
  $('#jBookingLabel').textContent = price ? t('booking.addonPaid', { price: fmtMoney ? fmtMoney(price, cfg.billing?.currency || 'USD') : `$${price}` }) : t('booking.addonFree');
}

function toggleNumber() {
  const off = $('#noNumber').checked;
  $('#whatsapp').disabled = off; $('#whatsapp').required = !off;
  if (off) $('#whatsapp').value = '';
  $('#noNumberNote').hidden = !off;
}
$('#noNumber').addEventListener('change', toggleNumber);

$('#showPw').addEventListener('click', () => {
  const i = $('#password');
  i.type = i.type === 'password' ? 'text' : 'password';
});

$('#joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  // opening hours are required (or 24/7)
  const he = document.querySelector('[data-err="hours"]');
  if (!hoursOk()) { he.textContent = t('errors.hours_required'); he.hidden = false; $('#joinHours').scrollIntoView({ block: 'center' }); return; }
  he.hidden = true;
  const btn = $('#submitBtn');
  $('#formError').hidden = true;
  if (!coords) { showFieldErrors({ location: 'location_required' }); return; }
  if (!kind) { showFieldErrors({ kind: 'required' }); $('#kindSelect').focus(); return; }
  if ($('#password').value.length < 5) { showFieldErrors({ password: 'password_too_short' }); $('#password').focus(); return; }
  if (!$('#acceptTerms').checked) { showFieldErrors({ acceptTerms: 'required' }); $('#acceptTerms').focus(); return; }
  const body = {
    fullName: form.fullName.value,
    whatsapp: $('#noNumber').checked ? '' : form.whatsapp.value,
    noWhatsapp: $('#noNumber').checked,
    ref: refCode(),
    areaLabel: $('#homeArea').value || undefined,
    servedAreaIds: editor.ids(),
    lat: coords?.lat, lng: coords?.lng, accuracy: coords?.accuracy, locationAt: coords?.at,
    kind: kind || 'cook',
    acceptTerms: $('#acceptTerms').checked,
    password: $('#password').value,
    services: [],
    bio: form.bio.value,
    hours: $('#jAllDay').checked ? { allDay: true, closed: [...document.querySelectorAll('[data-jclosed]:checked')].map((x) => Number(x.dataset.jclosed)) }
      : { open: $('#jOpen').value, close: $('#jClose').value, closed: [...document.querySelectorAll('[data-jclosed]:checked')].map((x) => Number(x.dataset.jclosed)) },
    booking: $('#jBooking').checked,
    plan: form.querySelector('input[name="plan"]:checked')?.value,
    withDrivers: document.querySelector('input[name="drv"]:checked')?.value === '1',
    photo: photo || undefined,
    website: form.website.value,
    startedAt,
  };
  btn.disabled = true;
  btn.textContent = t('join.submitting');
  try {
    const res = await api('/api/cook-applications', { method: 'POST', body });
    $('#formView').hidden = true;
    $('#doneView').hidden = false;
    window.scrollTo({ top: 0 });
    if (res.whatsappUrl) {
      $('#doneText').textContent = t('join.doneText');
      const a = $('#adminWa');
      a.href = res.whatsappUrl;
      a.hidden = false;
      window.location.href = res.whatsappUrl; // opens WhatsApp with the application ready
    } else {
      $('#doneText').textContent = t('join.noAdmin');
    }
  } catch (err) {
    showFieldErrors(err.fields);
    $('#formError').textContent = errorText(err);
    $('#formError').hidden = false;
    if (!Object.keys(err.fields || {}).length) $('#formError').scrollIntoView({ block: 'center' });
  } finally {
    btn.disabled = false;
    btn.textContent = t('join.submit');
  }
});
