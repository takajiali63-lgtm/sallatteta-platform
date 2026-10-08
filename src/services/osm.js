// Villages & areas around a point, taken from OpenStreetMap (Overpass API).
// Every place fetched is saved into service_areas, so the village list grows by itself.
// If OpenStreetMap is slow or down, callers simply fall back to the villages already saved.
import { haversineKm } from '../lib/geo.js';
import { normalizeName } from '../../public/assets/normalize.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const PLACE_TYPES = 'city|town|village|hamlet|suburb|neighbourhood|quarter|locality';
const CELL_DEG = 0.05; // ~5 km grid: one OpenStreetMap request per cell
const CELL_TTL_DAYS = 30;
const hasArabic = (s) => /[\u0600-\u06FF]/.test(s || '');

const parse = (json) => (json.elements || []).map((e) => {
  const t = e.tags || {};
  const nameAr = t['name:ar'] || (hasArabic(t.name) ? t.name : null);
  const nameEn = t['name:en'] || t['name:latin'] || (!hasArabic(t.name) ? t.name : null);
  return { osmId: e.id, nameAr: nameAr || nameEn, nameEn: nameEn || null, lat: e.lat, lng: e.lon, type: t.place };
}).filter((p) => p.nameAr && Number.isFinite(p.lat) && Number.isFinite(p.lng));

/** Asks all Overpass servers at once and takes the first good answer → [{osmId, nameAr, nameEn, lat, lng}] */
export async function overpassPlaces(lat, lng, km, { timeoutMs = 20000 } = {}) {
  const query = `[out:json][timeout:25];node["place"~"^(${PLACE_TYPES})$"](around:${Math.round(km * 1000)},${lat},${lng});out body 400;`;
  const ctrls = ENDPOINTS.map(() => new AbortController());
  const timer = setTimeout(() => ctrls.forEach((c) => c.abort()), timeoutMs);
  try {
    return await Promise.any(ENDPOINTS.map(async (url, i) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'sallatteta-platform/2 (home cooks directory)' },
        body: 'data=' + encodeURIComponent(query),
        signal: ctrls[i].signal,
      });
      if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
      const places = parse(await res.json());
      if (!places.length) throw new Error(`${new URL(url).host} empty`);
      return places;
    }));
  } catch (err) {
    const why = err?.errors ? err.errors.map((e) => e.message).join('; ') : err.message;
    throw new Error(why);
  } finally {
    clearTimeout(timer);
    ctrls.forEach((c) => c.abort());
  }
}

// Cells where the map just failed: don't make the next visitor wait again for 10 minutes.
const recentFailures = new Map();

/**
 * Make sure the places around (lat,lng) are saved. Cached per ~5 km cell for 30 days.
 * fetcher is injectable for tests. Never throws: returns { source: 'osm' | 'cache' | 'fallback' }.
 */
export async function ensurePlacesAround(db, areas, lat, lng, { km = 15, fetcher = overpassPlaces, log = console, country = null } = {}) {
  const cell = `osm:${(Math.round(lat / CELL_DEG) * CELL_DEG).toFixed(2)},${(Math.round(lng / CELL_DEG) * CELL_DEG).toFixed(2)}`;
  const cached = await db.one('SELECT value FROM app_meta WHERE key = $1', [cell]);
  if (cached && Date.now() - Number(cached.value) < CELL_TTL_DAYS * 86400_000) return { source: 'cache' };

  if (Date.now() - (recentFailures.get(cell) || 0) < 10 * 60_000) return { source: 'fallback' };
  let places;
  try {
    places = await fetcher(lat, lng, km);
  } catch (err) {
    recentFailures.set(cell, Date.now());
    log.warn?.(`[osm] places around ${lat},${lng} unavailable: ${err.message}`);
    return { source: 'fallback' };
  }
  recentFailures.delete(cell);

  const added = await savePlaces(db, areas, places, { country });
  if (cached) await db.query('UPDATE app_meta SET value = $1 WHERE key = $2', [String(Date.now()), cell]);
  else await db.query('INSERT INTO app_meta (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [cell, String(Date.now())]);
  log.info?.(`[osm] ${places.length} places near ${lat},${lng} (${added} new)`);
  return { source: 'osm', added };
}

/** Save places into service_areas, skipping ones we already have (same name within 3 km). Returns how many were new. */
export async function savePlaces(db, areas, places, { country = null } = {}) {
  let added = 0;
  for (const p of places) {
    const n = normalizeName(p.nameAr);
    const dup = areas.list.find((a) => a.names.includes(n) && haversineKm(a.lat, a.lng, p.lat, p.lng) < 3);
    if (dup) continue;
    // Borrow the district of the nearest known village only if it is really close (never across countries).
    const near = areas.nearest(p.lat, p.lng);
    const ref = near && haversineKm(near.lat, near.lng, p.lat, p.lng) <= 30 ? near : null;
    const placeCountry = country || ref?.country || null;
    const r = await db.query(
      `INSERT INTO service_areas (slug, name_ar, name_en, name_fr, region, district, lat, lng, sort_order, country)
       VALUES ($1,$2,$3,$3,$4,$4,$5,$6,2000,$7) ON CONFLICT (slug) DO NOTHING RETURNING id`,
      [`osm-${p.osmId}`, p.nameAr.slice(0, 80), (p.nameEn || '').slice(0, 80) || null, ref?.district || null, p.lat, p.lng, placeCountry]);
    if (r.length) {
      added++;
      areas.add({ id: r[0].id, name_ar: p.nameAr, name_en: p.nameEn, district: ref?.district || null, lat: p.lat, lng: p.lng, names: [n] });
    }
  }
  if (added) await areas.load();
  return added;
}

/**
 * Every city, town, village, hamlet and neighbourhood of a whole country (ISO code, e.g. "LB"), in one go.
 * Used by the admin "import all villages" button so the site no longer depends on live map servers.
 */
export async function overpassCountryPlaces(iso, { timeoutMs = 170000 } = {}) {
  const query = `[out:json][timeout:180];area["ISO3166-1"="${String(iso).toUpperCase().replace(/[^A-Z]/g, '')}"][admin_level=2]->.c;` +
    `node["place"~"^(${PLACE_TYPES})$"](area.c);out body;`;
  const ctrls = ENDPOINTS.map(() => new AbortController());
  const timer = setTimeout(() => ctrls.forEach((c) => c.abort()), timeoutMs);
  try {
    return await Promise.any(ENDPOINTS.map(async (url, i) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'sallatteta-platform/2 (home cooks directory)' },
        body: 'data=' + encodeURIComponent(query),
        signal: ctrls[i].signal,
      });
      if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
      const places = parse(await res.json());
      if (places.length < 10) throw new Error(`${new URL(url).host} too few`);
      return places;
    }));
  } catch (err) {
    throw new Error(err?.errors ? err.errors.map((e) => e.message).join('; ') : err.message);
  } finally {
    clearTimeout(timer);
    ctrls.forEach((c) => c.abort());
  }
}
