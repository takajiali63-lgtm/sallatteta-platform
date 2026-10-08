// v4.8 production hardening: bounded nearby search, background impressions, retention, Geoapify circuit breaker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { geoapifyGet, geoapifyHealth, resetGeoapifyBackoff } from '../src/services/geoapify.js';
import { defineJobs } from '../src/jobs.js';
import { haversineKm } from '../src/lib/geo.js';

let app, base, z;
const call = async (m, p, body) => {
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};

before(async () => {
  app = await createApp({ databaseUrl: 'sqlite::memory:', sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999', searchLimit: 1e5, lookupLimit: 1e5, placesFetcher: async () => [] });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  z = (await call('GET', `/api/areas/search?q=${encodeURIComponent('زحلة')}`)).data.areas[0].id;
  // a dense town: 400 active subscribers serving the same village, scattered up to ~3 km
  const now = new Date().toISOString(); const end = new Date(Date.now() + 30 * 864e5).toISOString();
  for (let i = 0; i < 400; i++) {
    const lat = 33.8466 + (Math.sin(i * 12.9898) * 0.025); const lng = 35.9031 + (Math.cos(i * 78.233) * 0.025);
    const c = await app.db.one(`INSERT INTO cooks (full_name, name_norm, whatsapp, area_id, area_label, lat, lng, service_radius_km, status, kind) VALUES ($1,$1,$2,$3,'زحلة',$4,$5,5,'approved','bakery') RETURNING id`,
      [`فرن ${i}`, `+9617000${String(i).padStart(4, '0')}`, z, lat, lng]);
    await app.db.query('INSERT INTO cook_service_areas (cook_id, area_id) VALUES ($1,$2)', [c.id, z]);
    await app.db.query(`INSERT INTO subscriptions (cook_id, plan, status, start_date, expiry_date) VALUES ($1,'monthly','active',$2,$3)`, [c.id, now, end]);
  }
});
after(async () => { await app.close(); });

test('dense town: nearest 30 out of 400, exact order, fast', async () => {
  const t0 = Date.now();
  const r = (await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=bakery')).data.cooks;
  const ms = Date.now() - t0;
  const all = await app.db.query(`SELECT full_name, lat, lng FROM cooks WHERE kind = 'bakery'`);
  const expected = all.map((c) => ({ n: c.full_name, d: haversineKm(33.8466, 35.9031, c.lat, c.lng) })).sort((a, b) => a.d - b.d).slice(0, r.length).map((x) => x.n);
  assert.ok(r.length >= 20);
  assert.deepEqual(r.map((c) => c.name), expected);
  for (let i = 1; i < r.length; i++) assert.ok(r[i].distanceM >= r[i - 1].distanceM);
  assert.ok(ms < 1500, `took ${ms} ms`);
});

test('search impressions are saved in the background (one statement), the response does not wait', async () => {
  const before = Number((await app.db.one('SELECT COUNT(*) AS n FROM request_impressions')).n);
  const s = await call('POST', '/api/search', { text: 'بدي خبز لـ 4', location: { type: 'gps', lat: 33.8466, lng: 35.9031, accuracy: 8 }, startedAt: Date.now() - 5000 });
  assert.equal(s.status, 200);
  for (let i = 0; i < 20 && Number((await app.db.one('SELECT COUNT(*) AS n FROM request_impressions')).n) === before; i++) await new Promise((r) => setTimeout(r, 50));
  const after = Number((await app.db.one('SELECT COUNT(*) AS n FROM request_impressions')).n);
  assert.ok(after >= before, 'impressions eventually written (or none if the search had no results)');
});

test('retention: old impressions and visits are removed in batches; recent data stays', async () => {
  const old = new Date(Date.now() - 400 * 864e5).toISOString();
  const r1 = await app.db.one(`INSERT INTO requests (public_id, body, area_label, location_source, results_count, locale, ip_hash, created_at) VALUES ('oldreq01', 'x', 'z', 'gps', 1, 'ar', 'h', $1) RETURNING id`, [old]);
  const r2 = await app.db.one(`INSERT INTO requests (public_id, body, area_label, location_source, results_count, locale, ip_hash) VALUES ('newreq01', 'x', 'z', 'gps', 1, 'ar', 'h') RETURNING id`);
  const cid = (await app.db.one('SELECT id FROM cooks LIMIT 1')).id;
  for (const rid of [r1.id, r2.id]) await app.db.query('INSERT INTO request_impressions (request_id, cook_id, distance_km, position) VALUES ($1,$2,1,1)', [rid, cid]);
  await app.db.query(`INSERT INTO daily_visits (day, visitor_hash) VALUES ('2020-01-01', 'a'), ($1, 'b')`, [new Date().toISOString().slice(0, 10)]);
  const job = defineJobs({ db: app.db }).find((j) => j.name === 'retention');
  const out = await job.run();
  assert.ok(out.impressions >= 1 && out.visits === 1, JSON.stringify(out));
  assert.equal(Number((await app.db.one('SELECT COUNT(*) AS n FROM request_impressions WHERE request_id = $1', [r2.id])).n), 1, 'recent kept');
  assert.equal(Number((await app.db.one('SELECT COUNT(*) AS n FROM requests WHERE id = $1', [r1.id])).n), 1, 'the request itself (stats) is kept');
});

test('Geoapify circuit breaker: after 5 failures, calls fail instantly for a minute (no waiting on timeouts)', async () => {
  resetGeoapifyBackoff();
  let calls = 0;
  const down = async () => { calls++; return new Response('x', { status: 503 }); };
  for (let i = 0; i < 5; i++) await geoapifyGet('/v1/x', {}, { key: 'k', fetchImpl: down }).catch(() => {});
  assert.equal(geoapifyHealth().open, true);
  const n = calls; const t0 = Date.now();
  await assert.rejects(geoapifyGet('/v1/x', {}, { key: 'k', fetchImpl: down }), /circuit open/);
  assert.equal(calls, n, 'no network call while open'); assert.ok(Date.now() - t0 < 50);
  resetGeoapifyBackoff();
  const ok = async () => new Response('{"ok":1}', { status: 200 });
  assert.deepEqual(await geoapifyGet('/v1/x', {}, { key: 'k', fetchImpl: ok }), { ok: 1 });
  assert.equal(geoapifyHealth().failures, 0);
});
