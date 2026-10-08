// Road distances (by the streets, not a straight line) with Geoapify Routing — accurate to a few hundred metres.
// Cost control: every answer is remembered; a moving driver re-uses his last road/straight ratio until he has moved
// ~700 m or 10 minutes passed; a daily budget (admin setting) caps the paid calls. Without a key, or if Geoapify
// is down, the straight line is used (marked approx) so nothing ever stops working.
import { haversineKm } from '../lib/geo.js';
import { geoapifyGet, geoapifyPost } from './geoapify.js';

const PAIR_TTL = 6 * 3600_000;     // roads don't move: a place-to-place answer stays good for hours
const TRACK_TTL = 10 * 60_000;     // a moving driver: refresh at least every 10 minutes …
const TRACK_MOVE = 700;            // … or after ~700 m
const NEAR = 150;                  // under this, straight line = road
const FALLBACK_RATIO = 1.3;        // typical road/straight ratio when Geoapify can't answer (marked approx)
const MAX = 20000;

const r3 = (p) => `${Number(p.lat).toFixed(3)},${Number(p.lng).toFixed(3)}`;
const straight = (a, b) => haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000;
const clampRatio = (x) => Math.min(4, Math.max(1, x));

export function createRoads({ key = '', fetchImpl = fetch, dailyMax = async () => 2500, log = console } = {}) {
  const pairs = new Map();   // "a|b" (≈100 m cells) → { ratio, at }
  const tracks = new Map();  // "track|b" → { ratio, lat, lng, at }
  let day = '', used = 0, calls = 0;
  const trim = (m) => { if (m.size > MAX) for (const k of [...m.keys()].slice(0, m.size - MAX * 0.8)) m.delete(k); };

  async function canSpend(n) {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) { day = today; used = 0; }
    if (!key) return false;
    const max = Number(await dailyMax()) || 0;
    return used + n <= max;
  }
  function remember(a, b, road, track) {
    const s = straight(a, b);
    if (!(road > 0) || s < NEAR) return;
    const ratio = clampRatio(road / s);
    pairs.set(`${r3(a)}|${r3(b)}`, { ratio, at: Date.now() });
    if (track) tracks.set(`${track}|${r3(b)}`, { ratio, lat: a.lat, lng: a.lng, at: Date.now() });
    trim(pairs); trim(tracks);
  }
  /** Known without a paid call? → { m, approx:false } or null */
  function cached(a, b, track) {
    const s = straight(a, b);
    if (s < NEAR) return { m: Math.round(s), approx: false };
    const p = pairs.get(`${r3(a)}|${r3(b)}`);
    if (p && Date.now() - p.at < PAIR_TTL) return { m: Math.round(s * p.ratio), approx: false };
    if (track) {
      const t = tracks.get(`${track}|${r3(b)}`);
      if (t && Date.now() - t.at < TRACK_TTL && straight(t, a) < TRACK_MOVE) return { m: Math.round(s * t.ratio), approx: false };
    }
    return null;
  }
  function fallback(a, b, track) {
    const s = straight(a, b);
    const t = track && tracks.get(`${track}|${r3(b)}`);
    const ratio = t ? t.ratio : key ? FALLBACK_RATIO : 1;
    return { m: Math.round(s * ratio), approx: true };
  }

  /** One distance by road, in metres. `track` = an id for something that moves (a driver) so its ratio is re-used. */
  async function distance(a, b, { track = null } = {}) {
    if (![a?.lat, a?.lng, b?.lat, b?.lng].every((x) => x != null && Number.isFinite(Number(x)))) return { m: null, approx: true };
    const hit = cached(a, b, track);
    if (hit) return hit;
    if (!(await canSpend(1))) return fallback(a, b, track);
    try {
      used += 1; calls += 1;
      const j = await geoapifyGet('/v1/routing', { waypoints: `${a.lat},${a.lng}|${b.lat},${b.lng}`, mode: 'drive' }, { key, fetchImpl, timeoutMs: 5000 });
      const m = Number(j?.features?.[0]?.properties?.distance);
      if (!(m > 0)) return fallback(a, b, track);
      remember(a, b, m, track);
      return { m: Math.round(m), approx: false };
    } catch (e) {
      log.warn?.(`[roads] ${e.message} — straight line used`);
      return fallback(a, b, track);
    }
  }

  /** Many sources → one place (nearest drivers to a store). One paid call for all the unknown ones. */
  async function many(points, b) {
    const out = points.map((p) => cached(p, b, p.track));
    const need = points.map((p, i) => (out[i] ? -1 : i)).filter((i) => i >= 0);
    if (need.length && (await canSpend(need.length))) {
      try {
        used += need.length; calls += 1;
        const j = await geoapifyPost('/v1/routematrix', {}, {
          mode: 'drive',
          sources: need.map((i) => ({ location: [Number(points[i].lng), Number(points[i].lat)] })),
          targets: [{ location: [Number(b.lng), Number(b.lat)] }],
        }, { key, fetchImpl, timeoutMs: 8000 });
        need.forEach((i, k) => {
          const m = Number(j?.sources_to_targets?.[k]?.[0]?.distance);
          if (m > 0) { remember(points[i], b, m, points[i].track); out[i] = { m: Math.round(m), approx: false }; }
        });
      } catch (e) { log.warn?.(`[roads] matrix: ${e.message} — straight line used`); }
    }
    return out.map((r, i) => r || fallback(points[i], b, points[i].track));
  }

  return { distance, many, stats: () => ({ day, used, calls, cachedPairs: pairs.size, tracked: tracks.size, enabled: !!key }) };
}
