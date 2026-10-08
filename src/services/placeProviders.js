// Where do the towns/villages around a GPS point come from? Several providers, tried in order,
// so the feature keeps working anywhere in the world even if one provider is down:
//   1. Geoapify Places (professional, paid beyond a free tier) — used when GEOAPIFY_API_KEY is set
//   2. OpenStreetMap Overpass (free, public servers)
//   3. Nominatim reverse geocoding (free): at least the name of the user's own neighbourhood/town,
//      so a cook can ALWAYS sign up and be matched, even where no list of villages is available.
import { overpassPlaces } from './osm.js';
import { geoapifyGet } from './geoapify.js';

const UA = { 'User-Agent': 'aklatak-platform/3 (home cooks & restaurants directory)' };
const hasArabic = (s) => /[\u0600-\u06FF]/.test(s || '');

async function fetchJson(url, { timeoutMs = 10000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { ...UA, ...headers }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

/** Geoapify Places: populated places in a circle. Stable ids from OSM when available. */
export function geoapifyPlaces(apiKey) {
  return async (lat, lng, km) => {
    const json = await geoapifyGet('/v2/places', {
      categories: 'populated_place', filter: `circle:${lng},${lat},${Math.round(km * 1000)}`, limit: '300',
    }, { key: apiKey, timeoutMs: 12000 });
    return (json.features || []).map((f) => {
      const p = f.properties || {};
      const raw = p.datasource?.raw || {};
      const nameAr = raw['name:ar'] || (hasArabic(p.name) ? p.name : null);
      const nameEn = raw['name:en'] || p.name_international?.en || (!hasArabic(p.name) ? p.name : null);
      const id = raw.osm_id ? Math.abs(Number(raw.osm_id)) : `g${p.place_id}`;
      return { osmId: id, nameAr: nameAr || nameEn || p.name, nameEn: nameEn || null, lat: p.lat, lng: p.lon };
    }).filter((x) => x.nameAr && Number.isFinite(x.lat) && Number.isFinite(x.lng));
  };
}

/** Nominatim reverse: the user's own neighbourhood / village / town as a single place. */
export async function nominatimHere(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1&accept-language=ar,en`;
  const j = await fetchJson(url, { timeoutMs: 8000 });
  const a = j.address || {};
  const name = a.suburb || a.neighbourhood || a.village || a.town || a.city_district || a.city || a.municipality || a.county;
  if (!name) throw new Error('nominatim: no place name');
  return [{ osmId: `n${j.osm_id || `${lat},${lng}`}`, nameAr: name, nameEn: null, lat: Number(lat), lng: Number(lng) }];
}

/**
 * Combined fetcher used by ensurePlacesAround(): first provider that returns places wins.
 * Returns the list, tagged with the provider name for logs.
 */
export function createPlacesFetcher(cfg, { log = console } = {}) {
  const chain = [];
  if (cfg.geoapifyKey) chain.push(['geoapify', geoapifyPlaces(cfg.geoapifyKey)]);
  chain.push(['overpass', overpassPlaces]);
  chain.push(['nominatim', (lat, lng) => nominatimHere(lat, lng)]);
  return chainPlaces(chain);
}

/** Try providers in order; the first that returns places wins. */
export function chainPlaces(chain) {
  return async (lat, lng, km) => {
    const errors = [];
    for (const [name, fn] of chain) {
      try {
        const places = await fn(lat, lng, km);
        if (places.length) { places.provider = name; return places; }
        errors.push(`${name}: empty`);
      } catch (err) { errors.push(`${name}: ${err.message}`); }
    }
    throw new Error(errors.join(' | '));
  };
}
