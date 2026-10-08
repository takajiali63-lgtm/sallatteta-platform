// Site settings editable from the admin panel (stored in app_meta, shared by all instances).
// Each instance re-reads them every 30 s, so a change reaches every server within half a minute.
import { setBrand, setTextOverrides } from '../lib/i18n.js';
import { DEFAULT_CATEGORIES, cleanCategories, KEY_RE, CRAFT_DEFAULTS, setCategories } from './categories.js';
import { registerCountries } from '../lib/countries.js';

export const DEFAULT_SETTINGS = {
  brandName: '',        // empty = use BRAND_NAME env / default
  brandNameEn: '',
  announcement: '',     // short notice shown at the top of the home page
  adminWhatsapp: '',    // empty = use ADMIN_WHATSAPP_NUMBER env
  sections: {
    nearby: true, regions: true, dishes: true, nameSearch: true, cooksSlider: true,
    restaurants: true,        // restaurant slider + "find a restaurant near me"
    globalCounters: false,    // worldwide counters at the bottom of the home page (off until the admin turns it on)
    dailyCounters: true,      // visitors & orders today + countdown to midnight (Beirut)
  },
  // Subscription prices per KIND and plan, in USD (most countries) and EUR (euro countries). Empty = not shown.
  prices: {
    cook: { monthly: { usd: '', eur: '' }, quarterly: { usd: '', eur: '' }, semiannual: { usd: '', eur: '' }, yearly: { usd: '', eur: '' } },
    restaurant: { monthly: { usd: '', eur: '' }, quarterly: { usd: '', eur: '' }, semiannual: { usd: '', eur: '' }, yearly: { usd: '', eur: '' } },
  },
  // Free trial per kind (applied by the admin with one click, and announced on the join page when enabled).
  trial: { cook: { enabled: false, days: 14 }, restaurant: { enabled: false, days: 14 } },
  // Limits per kind.
  limits: { cookPhotos: 300, restaurantPhotos: 300, menuItems: 300 },
  limitsV: 2,   // settings format of the limits (2 = v4.7+, nothing to upgrade)
  // Look of the site, editable from the admin panel (empty = default design).
  theme: {
    colors: { gold: '', goldSoft: '', bg: '', surface: '', text: '', muted: '' },
    fontScale: 1,
    layouts: { cooks: 'slider', restaurants: 'slider', dishes: 'slider' },
    sizes: { dishes: 'm', restaurants: 'm', cooks: 'm', dishFeed: 'm', gallery: 'm' },
    ui: { btnShape: '', btnBg: '', btnText: '', fieldShape: '', fieldBg: '', fieldText: '', fieldBorder: '' },
    logoVersion: 0,
  },
  // Business categories (order, names, icons, home visibility) — managed from the admin panel.
  categories: DEFAULT_CATEGORIES,
  // Items hidden from the ☰ menu and the top bar: 'join', 'login', 'app', 'advertise', 'cat:<key>'
  menuHidden: [],
  // subscription durations hidden on the sign-up page (e.g. only monthly): 'monthly' | 'quarterly' | 'semiannual' | 'yearly'
  plansHidden: [],
  // a whole group hidden everywhere (home tabs, menu, sign-up, search, results): 'shops' | 'crafts' (one always stays)
  groupsHidden: [],
  // a whole country hidden (nothing deleted) and categories hidden in one country only
  countriesHidden: [],
  countryCatsHidden: {},
  // countries the owner deleted completely (built-in ones can't leave the code, so they are removed from every list)
  countriesRemoved: [],
  // look of the whole platform (app, store, driver, admin): one of the ready designs
  designPreset: 'emerald',
  // optional pre-booking add-on: on/off for the platform, monthly add-on price per category (0 = free)
  booking: { enabled: true, prices: {} },
  // Countries added by the owner (code → { dial, trunk, nsn, currency, timezone, lang, units })
  extraCountries: {},
  // Paid ads sent by businesses ("Advertise" page): prices per duration; the admin approves each ad.
  adPrices: { week: { usd: '', eur: '' }, month: { usd: '', eur: '' } },
  // Download links of the mobile apps (APK link for Android, App Store link for iPhone). Empty = not shown.
  appLinks: { android: '', ios: '' },
  // Any site text edited by the admin, per language: { ar: { 'home.title': '…' }, en: {…} }
  textOverrides: {},
};

const KIND_KEYS = ['cook', 'restaurant'];
/** Deep-merge a saved/patch object into defaults (only known keys). Old flat prices {monthly:{…}} count as cook prices. */
export function mergeSettings(base, s = {}) {
  const out = structuredClone(base);
  for (const k of ['brandName', 'brandNameEn', 'announcement', 'adminWhatsapp']) if (s[k] !== undefined) out[k] = s[k];
  if (s.limitsV) out.limitsV = s.limitsV;
  // a brand name saved as "LTEZE" goes back to Aklatak
  for (const k of ['brandName', 'brandNameEn']) if (out[k] === 'LTEZE') out[k] = 'Aklatak';
  Object.assign(out.sections, s.sections || {});
  const prices = s.prices || {};
  const legacy = prices.monthly || prices.quarterly || prices.semiannual || prices.yearly ? { cook: prices } : prices;
  // Prices and free trial for ANY category (new categories added by the admin get their own).
  const emptyPlans = () => ({ monthly: { usd: '', eur: '' }, quarterly: { usd: '', eur: '' }, semiannual: { usd: '', eur: '' }, yearly: { usd: '', eur: '' } });
  const kinds = new Set([...KIND_KEYS, ...Object.keys(legacy || {}), ...Object.keys(s.trial || {})].filter((k) => KEY_RE.test(k)));
  for (const kind of kinds) {
    out.prices[kind] ||= emptyPlans();
    out.trial[kind] ||= { enabled: false, days: 14 };
    for (const [plan, v] of Object.entries(legacy[kind] || {})) if (out.prices[kind][plan]) Object.assign(out.prices[kind][plan], v);
    Object.assign(out.trial[kind], (s.trial || {})[kind] || {});
  }
  Object.assign(out.limits, s.limits || {});

  Object.assign(out.appLinks, s.appLinks || {});
  if (s.extraCountries && typeof s.extraCountries === 'object') out.extraCountries = { ...s.extraCountries };
  if (s.booking && typeof s.booking === 'object') out.booking = { enabled: s.booking.enabled !== false, prices: Object.fromEntries(Object.entries(s.booking.prices || {}).filter(([k, v]) => /^[a-z][a-z0-9_]{1,30}$/.test(k) && Number(v) >= 0 && Number(v) <= 10000).map(([k, v]) => [k, Number(v)])) };
  if (Array.isArray(s.countriesHidden)) out.countriesHidden = s.countriesHidden.filter((x) => /^[A-Z]{2}$/.test(x));
  if (Array.isArray(s.countriesRemoved)) out.countriesRemoved = [...new Set(s.countriesRemoved.filter((x) => /^[A-Z]{2}$/.test(x)))];
  if (typeof s.designPreset === 'string' && /^[a-z]{3,20}$/.test(s.designPreset)) out.designPreset = s.designPreset;
  if (s.countryCatsHidden && typeof s.countryCatsHidden === 'object') out.countryCatsHidden = Object.fromEntries(Object.entries(s.countryCatsHidden).filter(([k, v]) => /^[A-Z]{2}$/.test(k) && Array.isArray(v)).map(([k, v]) => [k, v.filter((x) => /^[a-z][a-z0-9_]{1,30}$/.test(x))]));
  if (Array.isArray(s.groupsHidden)) out.groupsHidden = [...new Set(s.groupsHidden.filter((x) => x === 'shops' || x === 'crafts'))].slice(0, 1);
  if (Array.isArray(s.plansHidden)) out.plansHidden = s.plansHidden.filter((x) => ['monthly', 'quarterly', 'semiannual', 'yearly'].includes(x));
  if (Array.isArray(s.menuHidden)) out.menuHidden = s.menuHidden.filter((x) => /^(join|login|app|advertise|cat:[a-z][a-z0-9_]{1,30})$/.test(String(x))).slice(0, 80);
  if (Array.isArray(s.categories)) { const c = cleanCategories(s.categories); if (c) out.categories = c; }
  // v5.6: sites saved before the crafts existed get the default crafts once (a craft the owner deleted stays deleted)
  if (Array.isArray(s.categories) && !out.categories.some((c) => c.group === 'crafts' || CRAFT_DEFAULTS.some((d) => d.key === c.key))) {
    out.categories = [...out.categories, ...CRAFT_DEFAULTS.map((c) => ({ ...c }))];
  }
  for (const d of ['week', 'month']) if (s.adPrices?.[d]) Object.assign(out.adPrices[d], s.adPrices[d]);
  if (s.theme) {
    Object.assign(out.theme.colors, s.theme.colors || {});
    Object.assign(out.theme.layouts, s.theme.layouts || {});
    Object.assign(out.theme.sizes, s.theme.sizes || {});
    Object.assign(out.theme.ui, s.theme.ui || {});
    if (s.theme.fontScale !== undefined) out.theme.fontScale = s.theme.fontScale;
    if (s.theme.logoVersion !== undefined) out.theme.logoVersion = s.theme.logoVersion;
    for (const k of ['logo', 'background']) if (typeof s.theme[k] === 'string') out.theme[k] = s.theme[k];
  }
  // text edits: per language; a null value removes an edit (back to the original text)
  for (const [lang, kv] of Object.entries(s.textOverrides || {})) {
    if (!/^[a-z]{2}$/.test(lang) || typeof kv !== 'object' || !kv) continue;
    const cur = (out.textOverrides[lang] ||= {});
    for (const [k, v] of Object.entries(kv)) { if (v === null) delete cur[k]; else if (typeof v === 'string') cur[k] = v; }
  }
  return out;
}

export function createSettings(db, cfg, { log = console } = {}) {
  const base = { brand: { ...cfg.brand }, adminWhatsapp: cfg.adminWhatsapp };
  let current = structuredClone(DEFAULT_SETTINGS);
  let timer = null;

  function apply(s) {
    current = mergeSettings(DEFAULT_SETTINGS, s);
    cfg.brand = {
      name: current.brandName || base.brand.name,
      nameEn: current.brandNameEn || current.brandName || base.brand.nameEn,
    };
    setBrand(cfg.brand);
    setTextOverrides(current.textOverrides);
    registerCountries(current.extraCountries);
    setCategories(current.categories);   // which categories are crafts   // countries added by the owner work everywhere (phones, currency, language)
    cfg.adminWhatsapp = current.adminWhatsapp || base.adminWhatsapp;
  }

  async function load() {
    try {
      const row = await db.one(`SELECT value FROM app_meta WHERE key = 'site_settings'`);
      const saved = row ? JSON.parse(row.value) : {};
      // One-time upgrade of settings saved before v4.7: the old default limits (12 / 30 / 150) become 300.
      // (Only here, when reading old saved settings — a limit the admin sets later is always kept.)
      if (saved.limits && !saved.limitsV) {
        if (Number(saved.limits.cookPhotos) === 12) saved.limits.cookPhotos = 300;
        if (Number(saved.limits.restaurantPhotos) === 30) saved.limits.restaurantPhotos = 300;
        if (Number(saved.limits.menuItems) === 150) saved.limits.menuItems = 300;
      }
      saved.limitsV = 2;
      apply(saved);
    } catch (err) { log.warn?.(`[settings] could not load: ${err.message}`); }
    return current;
  }

  return {
    load,
    get: () => current,
    /** Public part only (never the admin number). */
    publicView: () => ({ announcement: current.announcement, sections: current.sections, brand: cfg.brand, prices: current.prices, trial: current.trial, limits: current.limits, appLinks: current.appLinks, theme: current.theme,
      categories: current.categories.filter((c) => !c.deleted), adPrices: current.adPrices, menuHidden: current.menuHidden, plansHidden: current.plansHidden, groupsHidden: current.groupsHidden, booking: current.booking, countriesHidden: current.countriesHidden, countryCatsHidden: current.countryCatsHidden, countriesRemoved: current.countriesRemoved, designPreset: current.designPreset }),
    async save(patch) {
      const next = mergeSettings(current, patch);
      const value = JSON.stringify(next);
      const row = await db.one(`SELECT key FROM app_meta WHERE key = 'site_settings'`);
      if (row) await db.query(`UPDATE app_meta SET value = $1 WHERE key = 'site_settings'`, [value]);
      else await db.query(`INSERT INTO app_meta (key, value) VALUES ('site_settings', $1)`, [value]);
      apply(next);
      return current;
    },
    start() { timer = setInterval(() => { load(); }, 30_000); timer.unref?.(); },
    stop() { clearInterval(timer); },
  };
}
