// Which country and region is this GPS point in? Works anywhere in the world, automatically.
// Asks OpenStreetMap once per ~1 km cell (Overpass `is_in`), then remembers the answer in `geo_cells`.
// If the map servers don't answer, falls back to the nearest village we already know (same country, same district).
import { haversineKm } from '../lib/geo.js';
import { GOVERNORATES } from '../db/seed-data.js';
import { geoapifyReverse } from './geoapify.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const CELL = 0.01; // ~1 km
const cellKey = (lat, lng) => `${(Math.round(lat / CELL) * CELL).toFixed(2)},${(Math.round(lng / CELL) * CELL).toFixed(2)}`;
const slug = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** Raw Overpass `is_in` → { country, regionKey, regionName, regionNameAr, regionNameEn } */
export async function overpassIsIn(lat, lng, { timeoutMs = 12000 } = {}) {
  const query = `[out:json][timeout:20];is_in(${lat},${lng})->.a;area.a["boundary"="administrative"]["admin_level"~"^(2|4)$"];out tags;`;
  const ctrls = ENDPOINTS.map(() => new AbortController());
  const timer = setTimeout(() => ctrls.forEach((c) => c.abort()), timeoutMs);
  try {
    return await Promise.any(ENDPOINTS.map(async (url, i) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'aklatak-platform/3 (home cooks directory)' },
        body: 'data=' + encodeURIComponent(query),
        signal: ctrls[i].signal,
      });
      if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
      const els = (await res.json()).elements || [];
      const lvl = (n) => els.find((e) => String(e.tags?.admin_level) === String(n))?.tags;
      const c = lvl(2);
      const country = (c?.['ISO3166-1'] || c?.['ISO3166-1:alpha2'] || '').toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) throw new Error(`${new URL(url).host} no country`);
      const r = lvl(4);
      return {
        country,
        regionKey: r ? (r['ISO3166-2'] || `${country}-${slug(r['name:en'] || r.name)}`) : null,
        regionName: r?.name || null,
        regionNameAr: r?.['name:ar'] || null,
        regionNameEn: r?.['name:en'] || null,
      };
    }));
  } catch (err) {
    throw new Error(err?.errors ? err.errors.map((e) => e.message).join('; ') : err.message);
  } finally {
    clearTimeout(timer);
    ctrls.forEach((c) => c.abort());
  }
}

/** Nominatim reverse at state level: country + region (fallback when Overpass is down). */
export async function nominatimRegion(lat, lng) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=5&addressdetails=1&accept-language=ar,en`,
      { headers: { 'User-Agent': 'aklatak-platform/3 (home cooks & restaurants directory)' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`nominatim ${res.status}`);
    const a = (await res.json()).address || {};
    const country = String(a.country_code || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) throw new Error('nominatim: no country');
    const region = a.state || a.region || a.province || null;
    return { country, regionKey: region ? `${country}-${slug(region)}` : null, regionName: region, regionNameAr: null, regionNameEn: null };
  } finally { clearTimeout(t); }
}

/** Overpass first, Nominatim second. */
export async function defaultIsIn(lat, lng) {
  try { return await overpassIsIn(lat, lng); } catch (e1) {
    try { return await nominatimRegion(lat, lng); } catch (e2) { throw new Error(`${e1.message} | ${e2.message}`); }
  }
}

export function createGeoResolver({ db, areas, cfg, fetcher, log = console }) {
  const inflight = new Map();   // cell → pending lookup (bounded: entries removed when done)
  // Geoapify first when a key is configured (reliable, detailed: city / district / neighbourhood); free OSM services otherwise.
  fetcher = fetcher || (cfg.geoapifyKey
    ? async (lat, lng) => { try { return await geoapifyReverse(lat, lng, { key: cfg.geoapifyKey }); } catch (e) { log.warn?.(`[geo] ${e.message} — using OpenStreetMap`); return defaultIsIn(lat, lng); } }
    : defaultIsIn);
  const govByDistrict = new Map();
  for (const [country, govs] of Object.entries(GOVERNORATES)) {
    for (const g of govs) for (const d of g.districts) govByDistrict.set(d, { country, g });
  }
  const recentFail = new Map();

  /** Offline answer from the villages we already have (seeded Lebanon + everything fetched from the map). */
  function fromKnownPlaces(lat, lng) {
    const near = areas.nearest(lat, lng);
    if (!near || haversineKm(lat, lng, near.lat, near.lng) > 25) return null;
    const gov = govByDistrict.get(near.district);
    const country = near.country || gov?.country || null;
    if (!country) return null;
    return {
      country,
      regionKey: gov ? `${gov.country}-${gov.g.key}` : null,
      regionName: gov ? gov.g.ar : null,
      regionNameAr: gov ? gov.g.ar : null,
      regionNameEn: gov ? gov.g.en : null,
      source: 'places',
    };
  }

  return {
    /** → { country, regionKey, regionName, regionNameAr, regionNameEn, source } or { country: null } */
    async resolve(lat, lng, { wait = true } = {}) {
      const key = cellKey(lat, lng);
      const row = await db.one('SELECT * FROM geo_cells WHERE cell = $1', [key]);
      if (row) {
        return { country: row.country, regionKey: row.region_key, regionName: row.region_name, regionNameAr: row.region_name_ar, regionNameEn: row.region_name_en,
          city: row.city || null, district: row.district || null, locality: row.locality || null, source: 'cache' };
      }
      const offline = fromKnownPlaces(lat, lng);
      // Request coalescing: many visitors in the same new ~1 km cell at once → ONE external lookup, shared by all.
      const ask = () => {
        if (!inflight.has(key)) inflight.set(key, askOnce().finally(() => inflight.delete(key)));
        return inflight.get(key);
      };
      const askOnce = async () => {
        if (Date.now() - (recentFail.get(key) || 0) < 10 * 60_000) return null;
        try {
          const r = await fetcher(lat, lng);
          await db.query(
            `INSERT INTO geo_cells (cell, country, region_key, region_name, region_name_ar, region_name_en, city, district, locality, fetched_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (cell) DO NOTHING`,
            [key, r.country, r.regionKey, r.regionName, r.regionNameAr ?? null, r.regionNameEn ?? null, r.city ?? null, r.district ?? null, r.locality ?? null, Date.now()]);
          const box = 0.15; // ~15 km
          await db.query(
            `UPDATE service_areas SET country = $1 WHERE country IS NULL AND lat BETWEEN $2 AND $3 AND lng BETWEEN $4 AND $5`,
            [r.country, lat - box, lat + box, lng - box, lng + box]);
          for (const a of areas.list) {
            if (!a.country && Math.abs(a.lat - lat) <= box && Math.abs(a.lng - lng) <= box) a.country = r.country;
          }
          return { ...r, source: 'map' };
        } catch (err) {
          recentFail.set(key, Date.now());
          log.warn?.(`[geo] country lookup at ${key} unavailable: ${err.message}`);
          return null;
        }
      };
      if (!wait) { ask(); return offline || { country: null, source: 'none' }; }
      if (typeof wait === 'number') {
        const quick = await Promise.race([ask(), new Promise((r) => setTimeout(() => r(null), wait))]);
        return quick || offline || { country: null, source: 'none' };
      }
      return (await ask()) || offline || { country: null, source: 'none' };
    },
  };
}
