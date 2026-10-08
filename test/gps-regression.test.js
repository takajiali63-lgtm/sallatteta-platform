// GPS / matching regression: the new spatial-grid index must give EXACTLY the same answers
// as the original brute-force algorithm (same nearest village, same villages around, same order, same cooks).
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from '../src/db/index.js';
import { AreaIndex } from '../src/services/areas.js';
import { haversineKm } from '../src/lib/geo.js';
import { searchCooksForArea, activateSubscription, setServedAreas, setCookServices } from '../src/services/cooks.js';

// ---- the ORIGINAL algorithms (v2.3), kept here as the reference ----
const old = {
  nearest(list, lat, lng) {
    let best = null;
    for (const a of list) { const d = haversineKm(lat, lng, a.lat, a.lng); if (!best || d < best.d) best = { d, a }; }
    return best ? best.a : null;
  },
  around(list, lat, lng, km, limit = 120) {
    return list.map((a) => [haversineKm(lat, lng, a.lat, a.lng), a]).filter(([d]) => d <= km).sort((x, y) => x[0] - y[0]).slice(0, limit).map(([, a]) => a.id);
  },
  idsNear(list, lat, lng, km) {
    const ids = new Set(); const n = old.nearest(list, lat, lng); if (n) ids.add(n.id);
    for (const a of list) if (haversineKm(lat, lng, a.lat, a.lng) <= km) ids.add(a.id);
    return [...ids];
  },
};

let db, idx;
let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; // deterministic

before(async () => {
  db = await openDb({ databaseUrl: 'sqlite::memory:' });
  await migrate(db);
  // 20,000 extra places: spread over Lebanon, dense clusters, exact duplicates (ties) and far-away points.
  await db.exec('BEGIN');
  for (let i = 0; i < 20_000; i++) {
    let lat, lng;
    if (i % 10 === 0) { lat = 33.8463; lng = 35.9020 + (i % 3) * 1e-9; }                // ties around Zahle centre
    else if (i % 7 === 0) { lat = 33.80 + rnd() * 0.1; lng = 35.85 + rnd() * 0.1; }      // dense cluster
    else if (i % 97 === 0) { lat = -60 + rnd() * 120; lng = -170 + rnd() * 340; }        // world
    else { lat = 33.0 + rnd() * 1.7; lng = 35.1 + rnd() * 1.6; }                          // Lebanon box
    await db.query('INSERT INTO service_areas (slug, name_ar, name_en, name_fr, region, district, lat, lng, sort_order) VALUES ($1,$2,$3,$3,$4,$4,$5,$6,$7)',
      [`t${i}`, `مكان ${i}`, `Place ${i}`, 'zahle', lat, lng, 3000 + i]);
  }
  await db.exec('COMMIT');
  idx = await new AreaIndex(db).load();
});

function queries(n) {
  const q = [];
  for (let i = 0; i < n; i++) {
    if (i % 5 === 0) { const a = idx.list[Math.floor(rnd() * idx.list.length)]; q.push([a.lat, a.lng]); }   // exactly on a place
    else if (i % 11 === 0) q.push([34.9 + rnd(), 34.0 + rnd()]);                                            // at sea / outside
    else if (i % 13 === 0) q.push([-50 + rnd() * 100, -150 + rnd() * 300]);                                 // far away
    else q.push([33.0 + rnd() * 1.7, 35.1 + rnd() * 1.6]);                                                  // Lebanon
  }
  return q;
}

describe('GPS regression: new index = original results', () => {
  test('nearest village — 5,000 positions', () => {
    let diff = 0;
    for (const [lat, lng] of queries(5000)) if (idx.nearest(lat, lng).id !== old.nearest(idx.list, lat, lng).id) diff++;
    assert.equal(diff, 0);
  });

  test('villages around a cook (15 km, order included) — 2,000 positions', () => {
    let diff = 0;
    for (const [lat, lng] of queries(2000)) {
      const a = idx.around(lat, lng, { km: 15 }).map((x) => x.id);
      if (JSON.stringify(a) !== JSON.stringify(old.around(idx.list, lat, lng, 15))) diff++;
    }
    assert.equal(diff, 0);
  });

  test('customer villages (nearest + within 1.5 km, order included) — 5,000 positions', () => {
    let diff = 0;
    for (const [lat, lng] of queries(5000)) {
      if (JSON.stringify(idx.idsNear(lat, lng, 1.5)) !== JSON.stringify(old.idsNear(idx.list, lat, lng, 1.5))) diff++;
    }
    assert.equal(diff, 0);
  });

  test('cook search results (who appears, in which order, at what distance) — 1,000 customers', async () => {
    // 60 active cooks, each serving 3–30 villages near home
    const now = new Date(Date.now() - 60_000);
    for (let i = 0; i < 60; i++) {
      const home = idx.list[Math.floor(rnd() * 180)];
      const c = await db.one(`INSERT INTO cooks (full_name, whatsapp, area_id, area_label, lat, lng, service_radius_km, status, name_norm)
        VALUES ($1,$2,$3,$4,$5,$6,0,'approved',$1) RETURNING id`, [`طبّاخ ${i}`, `9617100${1000 + i}`, home.id, home.name_ar, home.lat + (rnd() - 0.5) * 0.02, home.lng + (rnd() - 0.5) * 0.02]);
      await setCookServices(db, c.id, ['home_cooking']);
      const served = old.around(idx.list, home.lat, home.lng, 8).slice(0, 3 + Math.floor(rnd() * 28));
      await setServedAreas(db, c.id, served);
      await activateSubscription(db, c.id, { plan: 'monthly', startDate: now, paymentStatus: 'paid' });
    }
    let diff = 0, nonEmpty = 0;
    for (const [lat, lng] of queries(1000).filter(([la, ln]) => la > 33 && la < 34.7 && ln > 35.1 && ln < 36.7)) {
      const point = { lat, lng };
      const newer = await searchCooksForArea(db, idx, { areaIds: idx.idsNear(lat, lng, 1.5), point });
      const older = await searchCooksForArea(db, idx, { areaIds: old.idsNear(idx.list, lat, lng, 1.5), point });
      if (newer.length) nonEmpty++;
      if (JSON.stringify(newer.map((c) => [c.id, c.distanceKm])) !== JSON.stringify(older.map((c) => [c.id, c.distanceKm]))) diff++;
    }
    assert.equal(diff, 0);
    assert.ok(nonEmpty > 20, `enough searches found cooks to be meaningful (${nonEmpty})`);
  });

  test('speed: the index is much faster than scanning every place', () => {
    const q = queries(2000);
    let t = performance.now(); for (const [la, ln] of q) old.idsNear(idx.list, la, ln, 1.5); const tOld = performance.now() - t;
    t = performance.now(); for (const [la, ln] of q) idx.idsNear(la, ln, 1.5); const tNew = performance.now() - t;
    console.log(`# idsNear over ${idx.list.length} places: original ${(tOld / q.length).toFixed(3)} ms/query, new ${(tNew / q.length).toFixed(3)} ms/query (${(tOld / tNew).toFixed(0)}× faster)`);
    assert.ok(tNew < tOld);
  });
});
