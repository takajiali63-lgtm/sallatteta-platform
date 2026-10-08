import { initI18n, t, esc, api, errorText } from './i18n.js?v=610';
import { initMenu, getSiteConfig, resizeImage } from './ui.js?v=610';

// Terms / privacy / about — texts come from the language files and can be edited from the admin panel.
const slug = location.pathname.replace(/\/+$/, '').slice(1);
const allowed = ['terms', 'privacy', 'about', 'delete-account'];

/** Tiny formatter: "## " → heading, "- " → bullet list, blank line → new paragraph. Text only (escaped). */
function render(body) {
  return String(body).split(/\n\s*\n/).map((block) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return '';
    if (lines[0].startsWith('## ')) {
      const rest = lines.slice(1);
      return `<h2>${esc(lines[0].slice(3))}</h2>${rest.length ? render(rest.join('\n')) : ''}`;
    }
    if (lines.every((l) => l.startsWith('- '))) return `<ul>${lines.map((l) => `<li>${esc(l.slice(2))}</li>`).join('')}</ul>`;
    return `<p>${lines.map(esc).join('<br>')}</p>`;
  }).join('');
}

/** "Get the app": store links set by the admin + how to install the site as an app meanwhile. */
async function renderAppPage() {
  const cfg = await getSiteConfig();
  const links = cfg.site?.appLinks || {};
  document.title = `${t('app.title')} — ${t('brand.name')}`;
  document.getElementById('pageTitle').textContent = t('app.title');
  const ua = navigator.userAgent;
  const isIos = /iPhone|iPad|iPod/.test(ua);
  const btn = (href, label) => `<p><a class="btn btn-gold" href="${esc(href)}" rel="noopener">${esc(label)}</a></p>`;
  document.getElementById('pageBody').innerHTML = `
    <p class="lead">${esc(t('app.lead'))}</p>
    ${links.android ? btn(links.android, t('app.android')) : ''}
    ${links.ios ? btn(links.ios, t('app.ios')) : ''}
    <h2>${esc(t('app.installTitle'))}</h2>
    <p>${esc(t(isIos ? 'app.installIos' : 'app.installAndroid'))}</p>`;
}

/** "Advertise with us": a business sends its ad; it is published after the owner approves it (and, later, pays online). */
async function renderAdvertisePage() {
  const cfg = await getSiteConfig();
  const cur = (cfg.billing?.currency || 'USD').toLowerCase();
  const price = (d) => { const v = cfg.site?.adPrices?.[d]?.[cur]; return v === '' || v == null ? '' : ` — ${cur === 'eur' ? '€' : '$'}${v}`; };
  const places = ['home_top', 'home_middle', 'home_bottom', 'browse_top', 'cook_page'];
  document.title = `${t('ads.title')} — ${t('brand.name')}`;
  document.getElementById('pageTitle').textContent = t('ads.title');
  document.getElementById('pageBody').innerHTML = `
    <p class="lead">${esc(t('ads.lead'))}</p>
    <form id="adForm" novalidate>
      <div class="field"><label for="adName">${esc(t('ads.name'))}</label><input class="input" id="adName" maxlength="80" required></div>
      <div class="field"><label for="adWa">${esc(t('join.whatsapp'))}</label><input class="input" id="adWa" type="tel" inputmode="tel" dir="ltr" required></div>
      <div class="field"><label for="adPlace">${esc(t('ads.placement'))}</label><select class="input" id="adPlace">${places.map((p) => `<option value="${p}">${esc(t(`ads.place_${p}`))}</option>`).join('')}</select></div>
      <div class="field"><label for="adDur">${esc(t('ads.duration'))}</label><select class="input" id="adDur">
        <option value="week">${esc(t('ads.week'))}${esc(price('week'))}</option><option value="month">${esc(t('ads.month'))}${esc(price('month'))}</option></select></div>
      <div class="field"><label>${esc(t('ads.image'))}</label>
        <input class="sr-only" type="file" id="adFile" accept="image/*"><label class="btn btn-ghost" for="adFile">${esc(t('join.photoPick'))}</label>
        <img id="adPreview" class="ad-preview" alt="" hidden><p class="hint">${esc(t('ads.imageHint'))}</p></div>
      <div class="field"><label for="adLink">${esc(t('ads.link'))}</label><input class="input" id="adLink" type="url" dir="ltr" placeholder="https://"></div>
      <div class="field"><label for="adNote">${esc(t('ads.note'))}</label><textarea class="input" id="adNote" maxlength="300"></textarea></div>
      <p class="notice">${esc(t('ads.howItWorks'))}</p>
      <p class="err" id="adErr" hidden></p>
      <button class="btn btn-gold" type="submit" id="adSend">${esc(t('ads.send'))}</button>
    </form>
    <div id="adDone" hidden><p class="lead">✅ ${esc(t('ads.done'))}</p><a class="btn btn-wa" id="adWaBtn" href="#" hidden>${esc(t('join.sendToAdmin'))}</a></div>`;
  let image = null;
  const startedAt = Date.now();
  document.getElementById('adFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      for (const [w, q] of [[1400, 0.85], [1200, 0.78], [1000, 0.7], [800, 0.62]]) { image = await resizeImage(f, w, q); if (image.length < 900_000) break; }
      const pv = document.getElementById('adPreview'); pv.src = image; pv.hidden = false;
    } catch { image = null; }
  });
  document.getElementById('adForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('adErr'); err.hidden = true;
    if (!image) { err.textContent = t('ads.imageRequired'); err.hidden = false; return; }
    const btn = document.getElementById('adSend'); btn.disabled = true;
    try {
      const r = await api('/api/ads', { method: 'POST', body: {
        name: document.getElementById('adName').value, whatsapp: document.getElementById('adWa').value,
        placement: document.getElementById('adPlace').value, duration: document.getElementById('adDur').value,
        linkUrl: document.getElementById('adLink').value, note: document.getElementById('adNote').value,
        image, country: cfg.country?.code, startedAt, website: '' } });
      document.getElementById('adForm').hidden = true; document.getElementById('adDone').hidden = false;
      if (r.whatsappUrl) { const a = document.getElementById('adWaBtn'); a.href = r.whatsappUrl; a.hidden = false; window.location.href = r.whatsappUrl; }
    } catch (ex) {
      err.textContent = ex.fields ? Object.values(ex.fields).map((c) => t(`errors.${c}`)).join(' — ') : errorText(ex);
      err.hidden = false;
    } finally { btn.disabled = false; }
  });
}

/** "Contact the team": a short form; the message reaches the admin panel. */
function renderContactPage() {
  document.title = `${t('contact.title')} — ${t('brand.name')}`;
  document.getElementById('pageTitle').textContent = t('contact.title');
  document.getElementById('pageBody').innerHTML = `
    <p class="lead">${esc(t('contact.lead'))}</p>
    <form id="cForm" novalidate>
      <div class="field"><label for="cName">${esc(t('contact.name'))}</label><input class="input" id="cName" maxlength="80"></div>
      <div class="field"><label for="cContact">${esc(t('contact.contact'))}</label><input class="input" id="cContact" maxlength="120" dir="auto"></div>
      <div class="field"><label for="cMsg">${esc(t('contact.message'))}</label><textarea class="input" id="cMsg" maxlength="2000" required></textarea></div>
      <p class="err" id="cErr" hidden></p>
      <button class="btn btn-gold" type="submit">${esc(t('contact.send'))}</button>
    </form>
    <p class="lead" id="cDone" hidden>✅ ${esc(t('contact.done'))}</p>`;
  const startedAt = Date.now();
  document.getElementById('cForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('cErr'); err.hidden = true;
    try {
      await api('/api/contact-admin', { method: 'POST', body: { name: document.getElementById('cName').value, contact: document.getElementById('cContact').value,
        message: document.getElementById('cMsg').value, startedAt, website: '' } });
      document.getElementById('cForm').hidden = true; document.getElementById('cDone').hidden = false;
    } catch (ex) { err.textContent = ex.fields?.message ? t(`errors.${ex.fields.message}`) : errorText(ex); err.hidden = false; }
  });
}

(async function boot() {
  await initI18n();
  initMenu();
  if (slug === 'app') return renderAppPage();
  if (slug === 'advertise') return renderAdvertisePage();
  if (slug === 'contact') return renderContactPage();
  const key = allowed.includes(slug) ? slug : 'about';
  const title = t(`pages.${key}.title`);
  document.title = `${title} — ${t('brand.name')}`;
  document.getElementById('pageTitle').textContent = title;
  document.getElementById('pageBody').innerHTML = render(t(`pages.${key}.body`));
})();
