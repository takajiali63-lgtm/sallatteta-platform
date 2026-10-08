// Admin panel layout: a side menu (☰) with every section on its own page. Nothing shows until a section is chosen.
// The existing panels are moved, not rebuilt, so all their buttons keep working.
(() => {
const MENU = [
  { group: 'الرئيسية', items: [
    { id: 'main', icon: '🏠', label: 'المشتركون وطلبات الانضمام' },
  ] },
  { group: 'التوصيل', items: [
    { id: 'dx-overview', icon: '📊', label: 'نظرة عامة' },
    { id: 'dx-orders', icon: '🧾', label: 'الطلبات' },
    { id: 'dx-drivers', icon: '🛵', label: 'السائقون' },
    { id: 'dx-stores', icon: '🏪', label: 'المتاجر والفروع' },
    { id: 'dx-customers', icon: '👤', label: 'الزبائن' },
    { id: 'dx-topups', icon: '💳', label: 'شحن الرصيد' },
    { id: 'dx-renewals', icon: '🔄', label: 'تجديد الاشتراكات' },
    { id: 'dx-finance', icon: '💰', label: 'المال والتسويات (نقدي/بطاقة)' },
    { id: 'dx-payouts', icon: '💸', label: 'السحوبات' },
    { id: 'dx-complaints', icon: '⚠️', label: 'الشكاوى والإنذارات' },
    { id: 'dx-broadcasts', icon: '📢', label: 'رسائل للسائقين والمتاجر' },
    { id: 'dx-plans', icon: '💲', label: 'الأسعار ومدد الاشتراك' },
    { id: 'dx-settings', icon: '⚙️', label: 'إعدادات التوصيل والتنظيف' },
  ] },
  { group: 'البلدان والأقسام', items: [
    { id: 'countriesPanel', icon: '🌍', label: 'البلدان والوكلاء (إضافة/إخفاء)' },
    { id: 'dx-places', icon: '🗑', label: 'حذف بلد أو قسم بالكامل' },
    { id: 'catsPanel', icon: '🗂', label: 'الأقسام وترتيبها' },
    { id: 'mapImportPanel', icon: '🗺', label: 'استيراد المحلات من الخريطة' },
    { id: 'importPanel', icon: '🏘', label: 'استيراد البلدات' },
    { id: 'areaPanel', icon: '➕', label: 'إضافة منطقة' },
  ] },
  { group: 'المظهر والمحتوى', items: [
    { id: 'dx-designs', icon: '✨', label: 'التصاميم الجاهزة' },
    { id: 'designPanel', icon: '🎨', label: 'الألوان والشعار والخلفية' },
    { id: 'textsPanel', icon: '✏️', label: 'تعديل النصوص' },
    { id: 'bannersPanel', icon: '📣', label: 'الإعلانات' },
    { id: 'pagesPanel', icon: '📄', label: 'الصفحات والأقسام الظاهرة' },
  ] },
  { group: 'الإدارة', items: [
    { id: 'settingsPanel', icon: '🧾', label: 'الاشتراكات والحدود' },
    { id: 'refPanel', icon: '🔗', label: 'روابط الإحالة' },
    { id: 'msgPanel', icon: '💬', label: 'رسائل الدعم' },
    { id: 'waPanel', icon: '📲', label: 'رسائل واتساب' },
    { id: 'backupPanel', icon: '💾', label: 'النسخ الاحتياطي' },
    { id: 'securityPanel', icon: '🔒', label: 'الأمان وتسجيل الدخول' },
  ] },
];

const $ = (s, r = document) => r.querySelector(s);
const dash = () => document.getElementById('dashView');
let built = false;

function build() {
  if (built) return;
  built = true;
  const d = dash();
  // 1) everything above the first panel = the subscribers list
  const main = document.createElement('div');
  main.id = 'secMain'; main.className = 'as-sec';
  const firstPanel = d.querySelector(':scope > details.panel');
  while (d.firstChild && d.firstChild !== firstPanel) main.appendChild(d.firstChild);
  d.prepend(main);
  main.querySelector('.delivery-link')?.remove();
  // 2) every panel becomes its own page (always open, its title shown in the header)
  for (const p of d.querySelectorAll(':scope > details.panel')) p.classList.add('as-sec', 'as-panel');
  // 3) the delivery sections live in one box
  const dx = document.createElement('div');
  dx.id = 'dxRoot'; dx.className = 'as-sec dx';
  d.appendChild(dx);
  // 4) top bar + side menu
  const bar = document.createElement('div');
  bar.className = 'as-bar';
  bar.innerHTML = `<button class="as-burger" id="asOpen" aria-label="القائمة" aria-expanded="false">☰</button><b id="asTitle"></b>`;
  d.prepend(bar);
  const nav = document.createElement('nav');
  nav.className = 'as-nav'; nav.id = 'asNav'; nav.setAttribute('aria-label', 'أقسام لوحة الإدارة');
  nav.innerHTML = `<div class="as-head"><b>لوحة الإدارة</b><button class="as-x" id="asClose" aria-label="إغلاق">✕</button></div>
    ${MENU.map((g) => `<div class="as-group"><small>${g.group}</small>${g.items.filter((i) => i.id === 'main' || i.id.startsWith('dx-') || document.getElementById(i.id))
      .map((i) => `<button data-go="${i.id}"><span>${i.icon}</span>${i.label}</button>`).join('')}</div>`).join('')}`;
  const shade = document.createElement('div');
  shade.className = 'as-shade'; shade.id = 'asShade';
  document.body.append(nav, shade);
  const open = (on) => { document.body.classList.toggle('as-open', on); $('#asOpen').setAttribute('aria-expanded', String(on)); };
  $('#asOpen').onclick = () => open(true);
  $('#asClose').onclick = () => open(false);
  shade.onclick = () => open(false);
  nav.addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) { go(b.dataset.go); open(false); } });
  window.adminGo = go;
  const start = (location.hash.match(/^#((?:dx-)?[A-Za-z-]+)$/) || [])[1];
  go(start && (start === 'main' || start.startsWith('dx-') || document.getElementById(start)) ? start : 'main');
  window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (h && h !== current) go(h); });
}

let current = null;
function go(id) {
  current = id;
  const d = dash();
  for (const s of d.querySelectorAll('.as-sec')) s.hidden = true;
  const item = MENU.flatMap((g) => g.items).find((i) => i.id === id);
  $('#asTitle').textContent = item ? `${item.icon} ${item.label}` : '';
  for (const b of document.querySelectorAll('#asNav [data-go]')) b.classList.toggle('on', b.dataset.go === id);
  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  if (id === 'main') { $('#secMain').hidden = false; }
  else if (id.startsWith('dx-')) { $('#dxRoot').hidden = false; window.dxOpen?.(id.slice(3)); }
  else {
    const p = document.getElementById(id);
    if (!p) return go('main');
    p.hidden = false;
    if (!p.open) p.open = true;   // fires the panel's own "toggle" loader
  }
  window.scrollTo(0, 0);
}

// The dashboard appears after login: build the menu then.
const obs = new MutationObserver(() => { if (dash() && !dash().hidden) { build(); } });
document.addEventListener('DOMContentLoaded', () => {
  if (!dash()) return;
  if (!dash().hidden) build();
  obs.observe(dash(), { attributes: true, attributeFilter: ['hidden'] });
});
})();
