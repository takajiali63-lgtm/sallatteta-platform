// Road distance & driving time (like the phone's map app), so the distance shown in Aklatak matches "Directions".
// Geoapify Route Matrix, in batches of ROUTE_BATCH (default 20) — the ones on screen first, the next ones when the customer
// scrolls to them. Results are cached per ~300 m cell of the customer's position
// (the list, the subscriber page and a second visit show the SAME number). If routing is unavailable, the
// straight-line distance is used and labelled as such — never a made-up road distance.

const cacheMap = new Map();                   // key → { m, s, at } (bounded below)
const TTL = 15 * 60_000;
const MAX = 20_000;
const BREAKER = { failures: 0, openUntil: 0 };

const CELL = 0.001;   // ≈ 100 m: accuracy first — only customers within ~100 m share a computed road distance
const cell = (v) => (Math.round(v / CELL) * CELL).toFixed(3);
const keyOf = (o, t) => `${cell(o.lat)},${cell(o.lng)}>${t.id}`;
export const ROUTE_BATCH = Math.min(50, Math.max(5, Number(process.env.ROUTE_BATCH) || 20));
export const clearRouteCache = () => { cacheMap.clear(); BREAKER.failures = 0; BREAKER.openUntil = 0; };

/** origin {lat,lng}; targets [{id,lat,lng}] → Map(id → { m, s }) for the ones that have a route. */
export async function roadDistances(origin, targets, { key, fetchImpl = fetch, timeoutMs = 7000, mode = 'drive' } = {}) {
  const out = new Map();
  const now = Date.now();
  const missing = [];
  for (const t of targets) {
    if (t.lat == null || t.lng == null) continue;
    const c = cacheMap.get(keyOf(origin, t));
    if (c && now - c.at < TTL) { if (c.m != null) out.set(t.id, { m: c.m, s: c.s }); } else missing.push(t);
  }
  if (!missing.length || !key || now < BREAKER.openUntil) return out;
  for (let i = 0; i < missing.length; i += ROUTE_BATCH) {
    const batch = missing.slice(i, i + ROUTE_BATCH);
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`https://api.geoapify.com/v1/routematrix?apiKey=${encodeURIComponent(key)}`, {
        method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, sources: [{ location: [origin.lng, origin.lat] }], targets: batch.map((t) => ({ location: [t.lng, t.lat] })) }),
      });
      if (!res.ok) throw new Error(`routing: HTTP ${res.status}`);
      const row = (await res.json())?.sources_to_targets?.[0] || [];
      batch.forEach((t, j) => {
        const r = row[j];
        const m = r && Number.isFinite(r.distance) ? Math.round(r.distance) : null;
        const s = r && Number.isFinite(r.time) ? Math.round(r.time) : null;
        cacheMap.set(keyOf(origin, t), { m, s, at: Date.now() });
        if (m != null) out.set(t.id, { m, s });
      });
      BREAKER.failures = 0;
    } catch (e) {
      console.warn(`[routing] road distance unavailable (${String(e?.message || e).replace(/apiKey=[^&\s]+/g, 'apiKey=***').slice(0, 120)}) — showing "≈" straight line`);
      if (++BREAKER.failures >= 3) { BREAKER.openUntil = Date.now() + 60_000; BREAKER.failures = 0; }   // routing down → straight line for a minute
    } finally { clearTimeout(timer); }
  }
  if (cacheMap.size > MAX) for (const k of [...cacheMap.keys()].slice(0, cacheMap.size - MAX)) cacheMap.delete(k);
  return out;
}

/** Replace straight-line distances by road distances where available; keep within radiusM; nearest first. */
export async function withRoadDistances(origin, cooks, { key, fetchImpl, radiusM = null, perKind = 0 } = {}) {
  // Only the first ROUTE_BATCH places (nearest by straight line = the ones on screen) get a road distance now;
  // the others keep "≈ straight line" until the customer scrolls to them (POST /api/route/distances).
  const shops = cooks.filter((c) => c.nav);                              // exact points only (home cooks: never)
  // "everything near me" shows the first `perKind` of EACH category: measure exactly those (every number on screen is a road distance)
  let first = shops.slice(0, ROUTE_BATCH);
  if (perKind > 0) {
    const seen = new Map();
    first = shops.filter((c) => { const k = c.kind || 'cook'; const n = seen.get(k) || 0; seen.set(k, n + 1); return n < perKind; }).slice(0, 60);
  }
  const roads = await roadDistances(origin, first.map((c) => ({ id: c.id, lat: c.nav.lat, lng: c.nav.lng })), { key, fetchImpl });
  const out = cooks.map((c) => {
    const r = roads.get(c.id);
    return r ? { ...c, distanceM: r.m, distanceKm: Math.round(r.m / 100) / 10, driveMin: r.s != null ? Math.max(1, Math.round(r.s / 60)) : null, distanceKind: 'road' }
      : { ...c, distanceKind: c.distanceKind || 'line' };
  });
  // one list, nearest first by the best known distance (road when measured, "≈" otherwise) —
  // a home cook 50 m away (never road-measured, to protect their home) stays at the top where it belongs
  const bucket = (c) => Math.floor((c.distanceM || 0) / 100);
  return out.filter((c) => radiusM == null || c.distanceM <= radiusM)
    .sort((a, b) => bucket(a) - bucket(b) || (b.verified ? 1 : 0) - (a.verified ? 1 : 0) || a.distanceM - b.distanceM);   // same ~100 m: ✓ first
}
