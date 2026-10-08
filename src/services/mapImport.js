// Import shops from the map (Geoapify Places, OpenStreetMap data) into categories — admin panel "Import from the map".
// Every shop is offered, whatever its phone: mobile → WhatsApp orders · landline → call · none → directions only.
import { geoapifyGet } from './geoapify.js';
import { normalizePhone } from '../lib/whatsapp.js';
import { normalizeName } from '../../public/assets/normalize.js';
import { haversineKm } from '../lib/geo.js';

// Map types per default category (Geoapify / OpenStreetMap categories). A category's own `map` field overrides this.
export const DEFAULT_MAP_TYPES = {
  restaurant: ['catering.restaurant', 'catering.fast_food', 'catering.cafe', 'catering.food_court'],
  bakery: ['commercial.food_and_drink.bakery'],
  butcher: ['commercial.food_and_drink.butcher'],
  supermarket: ['commercial.supermarket'],
  minimarket: ['commercial.convenience'],
  produce: ['commercial.food_and_drink.fruit_and_vegetable'],
  juice: ['commercial.food_and_drink.confectionery', 'catering.ice_cream', 'commercial.food_and_drink.drinks'],
  pharmacy: ['healthcare.pharmacy', 'commercial.chemist'],
  gym: ['sport.fitness.fitness_centre', 'sport.sports_centre'],
};
export const MAP_TYPE_RE = /^[a-z_]+(\.[a-z_]+)*$/;

// A category added by the owner without a map type: understood from its name (any language).
const NAME_HINTS = [
  [/مستشف|hospital|hôpital|hospital/i, ['healthcare.hospital']],
  [/عياد|clinic|clinique|clínica/i, ['healthcare.clinic_or_praxis']],
  [/أسنان|اسنان|dentist|dentiste|dentista/i, ['healthcare.dentist']],
  [/صيدل|pharmac|farmac/i, ['healthcare.pharmacy']],
  [/بنزين|وقود|محروقات|محط|fuel|petrol|gas station|essence|gasolin/i, ['service.vehicle.fuel']],
  [/صراف|atm|distributeur|cajero/i, ['service.financial.atm']],
  [/مصرف|بنك|bank|banque|banco/i, ['service.financial.bank']],
  [/فندق|hotel|hôtel/i, ['accommodation.hotel']],
  [/مقه|كافي|caf[eé]/i, ['catering.cafe']],
  [/مطعم|restaurant|restaurante/i, ['catering.restaurant', 'catering.fast_food']],
  [/فرن|مخبز|bakery|boulanger|panader/i, ['commercial.food_and_drink.bakery']],
  [/لحام|ملحم|butcher|boucher|carnicer/i, ['commercial.food_and_drink.butcher']],
  [/سوبرماركت|supermarket|supermarch|supermercad/i, ['commercial.supermarket']],
  [/ميني ماركت|دكان|convenience|supérette|minimercad/i, ['commercial.convenience']],
  [/خضار|فواكه|fruit|vegetable|primeur|fruter/i, ['commercial.food_and_drink.fruit_and_vegetable']],
  [/كهرب|الكترون|إلكترون|electr|élec/i, ['commercial.elektronics']],
  [/ألبس|البس|ملابس|cloth|vêtement|ropa/i, ['commercial.clothing']],
  [/مكتب[ةه]|كتب|book|librair|librer/i, ['commercial.books']],
  [/ورود|زهور|flor/i, ['commercial.florist']],
  [/مدرس|school|école|escuela/i, ['education.school']],
  [/جامع[ةه]|university|université|universidad/i, ['education.university']],
  [/نادي|رياض|gym|fitness|sport/i, ['sport.fitness.fitness_centre']],
];
export const mapTypesOf = (cat) => {
  const own = String(cat?.map || '').split(',').map((x) => x.trim()).filter((x) => MAP_TYPE_RE.test(x));
  if (own.length) return own;
  if (DEFAULT_MAP_TYPES[cat?.key]) return DEFAULT_MAP_TYPES[cat.key];
  const names = Object.values(cat?.names || {}).flatMap((n) => [n?.one, n?.many]).filter(Boolean).join(' ');
  return NAME_HINTS.find(([re]) => re.test(names))?.[1] || [];
};

/** Is this number a mobile (WhatsApp) number? 'mobile' | 'landline' | 'unknown' (country without rules). */
export function phoneKind(raw) {
  const e164 = `+${String(raw || '').replace(/^\+/, '')}`;   // stored numbers have no '+'
  if (/^\+961/.test(e164)) return /^\+961(3\d{6}|7[0-9]\d{6}|81\d{6})$/.test(e164) ? 'mobile' : 'landline';
  if (/^\+33/.test(e164)) return /^\+33[67]\d{8}$/.test(e164) ? 'mobile' : 'landline';
  if (/^\+34/.test(e164)) return /^\+34[67]\d{8}$/.test(e164) ? 'mobile' : 'landline';
  if (/^\+971/.test(e164)) return /^\+9715\d{8}$/.test(e164) ? 'mobile' : 'landline';
  if (/^\+966/.test(e164)) return /^\+9665\d{8}$/.test(e164) ? 'mobile' : 'landline';
  if (/^\+44/.test(e164)) return /^\+447\d{9}$/.test(e164) ? 'mobile' : 'landline';
  if (/^\+233/.test(e164)) return /^\+233[25]\d{8}$/.test(e164) ? 'mobile' : 'landline';   // Ghana: 02x / 05x mobiles (03x = landlines)
  if (/^\+234/.test(e164)) return /^\+234[789]\d{9}$/.test(e164) ? 'mobile' : 'landline';   // Nigeria
  return 'unknown';
}

export async function findPlaceAndShops({ q, radiusKm, categories, key, fetchImpl, db }) {
  // a place name — or coordinates of a village ("33.8466, 35.9031")
  const xy = String(q).match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,،]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
  let at;
  if (xy && Math.abs(+xy[1]) <= 90 && Math.abs(+xy[2]) <= 180) {
    const rev = await geoapifyGet('/v1/geocode/reverse', { lat: xy[1], lon: xy[2], format: 'json' }, { key, fetchImpl, timeoutMs: 20_000 }).catch(() => null);
    const r0 = rev?.results?.[0] || {};
    at = { formatted: r0.formatted || `${xy[1]}, ${xy[2]}`, lat: +xy[1], lon: +xy[2], country_code: r0.country_code || '' };
  } else {
    const geo = await geoapifyGet('/v1/geocode/search', { text: q, limit: '1', format: 'json' }, { key, fetchImpl, timeoutMs: 20_000 });   // big areas take longer than a normal map call
    at = geo?.results?.[0];
  }
  if (!at) return { place: null, groups: [] };
  const center = { name: at.formatted || q, lat: at.lat, lng: at.lon, country: String(at.country_code || '').toUpperCase() };
  const cats = categories.filter((c) => !c.deleted && mapTypesOf(c).length);
  if (!cats.length) return { place: center, groups: [], failed: [], noType: categories.filter((c) => !c.deleted && !mapTypesOf(c).length).map((c) => c.key) };
  // ONE request per category: a category the map service doesn't know can't block the others
  const failed = [];
  const features = [];
  for (let i = 0; i < cats.length; i += 4) {
    await Promise.all(cats.slice(i, i + 4).map(async (c) => {
      try {
        const r = await geoapifyGet('/v2/places', {
          categories: mapTypesOf(c).join(','), filter: `circle:${center.lng},${center.lat},${Math.round(radiusKm * 1000)}`,
          bias: `proximity:${center.lng},${center.lat}`, limit: '500',
        }, { key, fetchImpl, timeoutMs: 20_000 });   // big areas take longer than a normal map call
        for (const f of r?.features || []) features.push({ f, kind: c.key });
      } catch { failed.push(c.key); }
    }));
  }
  const r = { features };
  const existing = await db.query(`SELECT ext_ref, name_norm, lat, lng FROM cooks WHERE lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4`,
    [center.lat - 0.2, center.lat + 0.2, center.lng - 0.25, center.lng + 0.25]);
  const refs = new Set(existing.map((e) => e.ext_ref).filter(Boolean));
  const groups = new Map(cats.map((c) => [c.key, []]));
  const seen = new Set();
  for (const { f, kind: askedFor } of r.features) {
    const p = f.properties || {};
    if (!p.name || p.lat == null || p.lon == null || seen.has(p.place_id)) continue;
    seen.add(p.place_id);
    // a place is taken only if its own map type matches one of our categories (never just because it came back)
    const kind = cats.find((c) => mapTypesOf(c).some((t) => (p.categories || []).some((pc) => pc === t || pc.startsWith(`${t}.`))))?.key;
    void askedFor;
    if (!kind) continue;
    const ref = `geoapify:${p.place_id}`;
    const country = String(p.country_code || center.country || '').toUpperCase();
    const raw = p.contact?.phone || p.datasource?.raw?.phone || p.datasource?.raw?.['contact:phone'] || '';
    const e164 = raw ? normalizePhone(String(raw).split(/[;,/]/)[0], country) : null;
    const pk = e164 ? phoneKind(e164) : null;
    const nn = normalizeName(p.name);
    const exists = refs.has(ref) || existing.some((e) => e.name_norm === nn && haversineKm(e.lat, e.lng, p.lat, p.lon) < 0.2);
    groups.get(kind).push({
      ref, name: String(p.name).slice(0, 80), kind, lat: p.lat, lng: p.lon, country,
      address: String(p.address_line2 || p.street || '').slice(0, 120),
      whatsapp: pk === 'mobile' || pk === 'unknown' ? e164 : null, callPhone: pk === 'landline' ? e164 : null, phoneKind: pk, exists,
      distanceM: Math.round(haversineKm(center.lat, center.lng, p.lat, p.lon) * 1000),
    });
  }
  return { place: center, failed, noType: categories.filter((c) => !c.deleted && !mapTypesOf(c).length).map((c) => c.key),
    groups: [...groups.entries()].map(([key, items]) => ({ key, items: items.sort((a, b) => a.distanceM - b.distanceM) })) };
}

/**
 * A whole governorate / province / state: all shops inside its boundary, category by category, grouped by the
 * platform's nearest town ("area") → { region, areas: [{ name, groups: [{ key, items }] }] }.
 */
export async function findRegionShops({ q, categories, key, fetchImpl, db, areas }) {
  const geo = await geoapifyGet('/v1/geocode/search', { text: q, type: 'state', limit: '1', format: 'json' }, { key, fetchImpl, timeoutMs: 20_000 });
  const at = geo?.results?.[0];
  if (!at?.place_id) return { region: null, areas: [] };
  const region = { name: at.formatted || q, country: String(at.country_code || '').toUpperCase(), lat: at.lat, lng: at.lon };
  const cats = categories.filter((c) => !c.deleted && mapTypesOf(c).length);
  const results = await Promise.allSettled(cats.map((c) => geoapifyGet('/v2/places', { categories: mapTypesOf(c).join(','), filter: `place:${at.place_id}`, limit: '500' },
    { key, fetchImpl, timeoutMs: 20_000 })));
  const failed = cats.filter((c, i) => results[i].status === 'rejected').map((c) => c.key);
  const refs = new Set((await db.query("SELECT ext_ref FROM cooks WHERE source = 'map'")).map((r) => r.ext_ref));
  const byArea = new Map(); const seen = new Set();
  cats.forEach((c, i) => {
    if (results[i].status !== 'fulfilled') return;
    for (const f of results[i].value?.features || []) {
      const p = f.properties || {};
      if (!p.name || p.lat == null || p.lon == null || seen.has(p.place_id)) continue;
      seen.add(p.place_id);
      const raw = p.contact?.phone || p.datasource?.raw?.phone || '';
      const country = String(p.country_code || region.country || '').toUpperCase();
      const e164 = raw ? normalizePhone(String(raw).split(/[;,/]/)[0], country) : null;
      const pk = e164 ? phoneKind(e164) : null;
      const near = areas?.nearest?.(p.lat, p.lon);
      const areaName = near ? (near.name_ar || near.name_en) : (p.city || p.suburb || region.name);
      if (!byArea.has(areaName)) byArea.set(areaName, new Map());
      const g = byArea.get(areaName); if (!g.has(c.key)) g.set(c.key, []);
      g.get(c.key).push({ ref: `geoapify:${p.place_id}`, name: String(p.name).slice(0, 80), kind: c.key, lat: p.lat, lng: p.lon, country,
        address: String(p.address_line2 || p.street || '').slice(0, 120), whatsapp: pk === 'mobile' || pk === 'unknown' ? e164 : null,
        callPhone: pk === 'landline' ? e164 : null, phoneKind: pk, exists: refs.has(`geoapify:${p.place_id}`) });
    }
  });
  const list = [...byArea.entries()].map(([name, g]) => ({ name, groups: [...g.entries()].map(([k, items]) => ({ key: k, items })) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  return { region, failed, areas: list };
}
