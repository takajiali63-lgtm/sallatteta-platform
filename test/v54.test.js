// v5.4: road distances 20 at a time (the rest when the customer scrolls), shared per ~300 m — saves map credits.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { clearRouteCache } from '../src/services/routing.js';
import { haversineKm } from '../src/lib/geo.js';

let app, base, ck, z; const calls = [];
const mapFetch = async (url, opts) => {
  if (String(url).includes('/v1/routematrix')) {
    const b = JSON.parse(opts.body); calls.push(b.targets.length);
    const [slng, slat] = b.sources[0].location;
    return new Response(JSON.stringify({ sources_to_targets: [b.targets.map((t) => ({ distance: haversineKm(slat, slng, t.location[1], t.location[0]) * 1300, time: 120 }))] }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};
const call = async (m, p, body, cookie = ck) => {
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};
before(async () => {
  app = await createApp({ databaseUrl: 'sqlite::memory:', sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999', geoapifyKey: 'k', mapFetch,
    bootstrapAdmin: { username: 'admin', password: 'correct-horse-battery' }, searchLimit: 1e4, lookupLimit: 1e4, placesFetcher: async () => [] });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const l = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery' }) });
  ck = l.headers.get('set-cookie').split(';')[0];
  z = (await call('GET', `/api/areas/search?q=${encodeURIComponent('زحلة')}`)).data.areas[0].id;
  for (let i = 0; i < 30; i++) {
    const made = await call('POST', '/api/admin/cooks', { kind: 'bakery', fullName: `فرن ${i}`, whatsapp: `+961715557${String(i).padStart(2, '0')}`, areaId: z, lat: 33.8466 + i * 0.002, lng: 35.9031, servedAreaIds: [z],
      activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } });
    if (made.status !== 201) console.log('CREATE', made.status, JSON.stringify(made.data).slice(0, 120));
  }
  clearRouteCache();
});
after(async () => { await app.close(); });

test('first 20 on screen get road distances; the rest stay "≈" until scrolled to; one request of max 20', async () => {
  calls.length = 0;
  const r = (await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=bakery', null, null)).data.cooks;
  assert.equal(r.length, 30);
  assert.deepEqual(calls, [20], 'one routing request for 20 places');
  const road = r.filter((c) => c.distanceKind === 'road'), line = r.filter((c) => c.distanceKind !== 'road');
  assert.equal(road.length, 20); assert.equal(line.length, 10);
  for (let i = 1; i < road.length; i++) assert.ok(road[i].distanceM >= road[i - 1].distanceM, 'nearest first');
  // the customer scrolls: the next 10 are measured in one request
  const more = (await call('POST', '/api/route/distances', { lat: 33.8466, lng: 35.9031, ids: line.map((c) => c.id) }, null)).data.distances;
  assert.equal(more.length, 10); assert.ok(more.every((d) => d.distanceKind === 'road' && d.distanceM > 0));
  assert.deepEqual(calls, [20, 10]);
});

test('a second customer ~40 m away (same ~100 m cell) costs nothing; home cooks are never measured; bad input refused', async () => {
  calls.length = 0;
  await call('GET', '/api/cooks/nearby?lat=33.8468&lng=35.9033&type=bakery', null, null);
  assert.deepEqual(calls, [], 'served from the shared cache');
  assert.equal((await call('POST', '/api/route/distances', { lat: 999, lng: 0, ids: [1] }, null)).status, 422);
  const cook = (await call('POST', '/api/admin/cooks', { kind: 'cook', fullName: 'أم علي', whatsapp: '+96171555799', areaId: z, lat: 33.8466, lng: 35.9031, servedAreaIds: [z],
    activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } })).data;
  assert.deepEqual((await call('POST', '/api/route/distances', { lat: 33.8466, lng: 35.9031, ids: [cook.id] }, null)).data.distances, [], "never a route to a home cook's house");
});

test('"everything near me": the first 3 of EACH category (what is on screen) get road distances, even far ones', async () => {
  // a far category: ~7 km straight (≈ 9 km by road, inside the 10 km limit), beyond the 20 nearest shops
  await call('POST', '/api/admin/cooks', { kind: 'pharmacy', fullName: 'مستشفى بعيد', whatsapp: '+96171555890', areaId: z, lat: 33.9096, lng: 35.9031, servedAreaIds: [z],
    activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } });
  clearRouteCache(); calls.length = 0;
  const all = (await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=all', null, null)).data.cooks;
  const far = all.find((c) => c.name === 'مستشفى بعيد');
  assert.ok(far, 'within 10 km');
  assert.equal(far.distanceKind, 'road', 'the first of its category is shown → measured by road');
  const bakeries = all.filter((c) => c.kind === 'bakery');
  assert.deepEqual(bakeries.slice(0, 3).map((c) => c.distanceKind), ['road', 'road', 'road']);
});
