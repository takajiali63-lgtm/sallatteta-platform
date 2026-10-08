// v5.3: road distance (same number in the list, the subscriber page and close to the maps app), 10 km radius,
// one country per visitor, import for categories added by the owner, agent suspend / password / country.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { clearRouteCache } from '../src/services/routing.js';
import { mapTypesOf } from '../src/services/mapImport.js';

let app, base, ck, z, routeCalls = 0, routingDown = false;
const call = async (m, p, body, cookie = ck) => {
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
};
// fake map services: road distance = 2 × straight line (mountain roads); places for import
const hav = (a, b) => { const R = 6371000, r = (x) => (x * Math.PI) / 180; const dLat = r(b[1] - a[1]), dLng = r(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[1])) * Math.cos(r(b[1])) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const mapFetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.pathname === '/v1/routematrix') {
    routeCalls++;
    if (routingDown) return new Response('down', { status: 503 });
    const b = JSON.parse(opts.body);
    const src = b.sources[0].location;
    return new Response(JSON.stringify({ sources_to_targets: [b.targets.map((t) => ({ distance: hav(src, t.location) * 2, time: hav(src, t.location) * 2 / 10 }))] }), { status: 200 });
  }
  if (u.pathname === '/v1/geocode/search') return new Response(JSON.stringify({ results: [{ formatted: 'زحلة', lat: 33.8466, lon: 35.9031, country_code: 'lb' }] }), { status: 200 });
  if (u.pathname === '/v2/places') {
    const cats = u.searchParams.get('categories');
    if (cats.includes('broken.type')) return new Response('bad', { status: 400 });
    if (cats.includes('healthcare.hospital')) return new Response(JSON.stringify({ features: [{ properties: { place_id: 'h1', name: 'مستشفى تل شيحا', categories: ['healthcare.hospital'], lat: 33.85, lon: 35.91, country_code: 'lb' } }] }), { status: 200 });
    return new Response(JSON.stringify({ features: [] }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};
const mk = (kind, name, phone, lat, lng, extra = {}) => call('POST', '/api/admin/cooks', { kind, fullName: name, whatsapp: phone, areaId: z, lat, lng, servedAreaIds: [z],
  activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() }, ...extra }).then((r) => r.data);

before(async () => {
  app = await createApp({ databaseUrl: 'sqlite::memory:', sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999', geoapifyKey: 'k', mapFetch,
    bootstrapAdmin: { username: 'owner', password: 'owner-password-1' }, searchLimit: 1e4, applyLimit: 1e4, loginLimit: 1e4, lookupLimit: 1e4,
    placesFetcher: async () => [], geoFetcher: async (lat) => (lat > 40 ? { country: 'FR', locality: 'Paris' } : { country: 'LB', locality: 'زحلة' }) });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  ck = (await call('POST', '/api/admin/login', { username: 'owner', password: 'owner-password-1' }, null)).headers.get('set-cookie').split(';')[0];
  z = (await call('GET', `/api/areas/search?q=${encodeURIComponent('زحلة')}`)).data.areas[0].id;
  await mk('pharmacy', 'صيدلية قريبة', '+96171000101', 33.8500, 35.9031);    // ~380 m straight
  await mk('pharmacy', 'صيدلية متوسطة', '+96171000102', 33.8800, 35.9031);   // ~3.7 km straight → ~7.4 km road
  await mk('pharmacy', 'صيدلية بعيدة', '+96171000103', 33.9200, 35.9031);    // ~8.2 km straight → ~16 km road (outside 10 km by road)
  await mk('pharmacy', 'صيدلية خارج المجال', '+96171000104', 34.0000, 35.9031);  // ~17 km straight
});
after(async () => { await app.close(); });

test('road distance: the list shows the road distance, nearest first, only within 10 km by road', async () => {
  clearRouteCache(); routeCalls = 0;
  const r = (await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=pharmacy', null, null)).data.cooks;
  assert.deepEqual(r.map((c) => c.name), ['صيدلية قريبة', 'صيدلية متوسطة'], 'the one 16 km away by road is not shown');
  assert.equal(r[0].distanceKind, 'road');
  assert.ok(Math.abs(r[0].distanceM - 2 * r[0].straightM) < 3, `${r[0].distanceM} vs ${r[0].straightM}`);
  assert.ok(r[0].driveMin >= 1);
  assert.equal(routeCalls, 1, 'one request for all the places');
});

test('the subscriber page shows exactly the same distance as the list (same position, same calculation, cached)', async () => {
  const list = (await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=pharmacy', null, null)).data.cooks;
  const before = routeCalls;
  for (const c of list) {
    const p = (await call('GET', `/api/cooks/${c.id}?lat=33.8466&lng=35.9031`, null, null)).data;
    assert.equal(p.distanceM, c.distanceM, c.name);
    assert.equal(p.distanceKind, 'road');
  }
  assert.equal(routeCalls, before, 'no extra request (same ~100 m cell)');
});

test('when road distances are unavailable: honest straight-line distance (labelled), nothing breaks', async () => {
  clearRouteCache(); routingDown = true;
  const r = (await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=pharmacy', null, null)).data.cooks;
  routingDown = false;
  assert.ok(r.length >= 2);
  assert.ok(r.every((c) => c.distanceKind === 'straight' && c.distanceM === c.straightM));
  assert.ok(!r.some((c) => c.name === 'صيدلية خارج المجال'), '10 km straight-line limit still applies');
});

test('a home cook never gets an exact point; the list is still sorted', async () => {
  clearRouteCache();
  await mk('cook', 'أم علي', '+96171000105', 33.8470, 35.9035);
  const all = (await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=all', null, null)).data.cooks;
  const cook = all.find((c) => c.name === 'أم علي');
  assert.ok(cook && cook.nav === null && cook.distanceKind === 'straight');
  for (let i = 1; i < all.length; i++) assert.ok(all[i].distanceM >= all[i - 1].distanceM);
});

test('import: a category added by the owner is understood from its name; a broken map type does not block the others', async () => {
  assert.deepEqual(mapTypesOf({ key: 'x1', names: { ar: { one: 'مستشفى', many: 'مستشفيات' } } }), ['healthcare.hospital']);
  assert.deepEqual(mapTypesOf({ key: 'x2', names: { ar: { one: 'محطة بنزين', many: 'محطات بنزين' } } }), ['service.vehicle.fuel']);
  const cats = (await call('GET', '/api/admin/settings')).data.categories;
  cats.push({ key: 'hospitals', icon: '🏥', home: 'auto', names: { ar: { one: 'مستشفى', many: 'مستشفيات' }, en: { one: 'Hospital', many: 'Hospitals' } } });
  cats.push({ key: 'oddity', icon: '❓', home: false, map: 'broken.type', names: { ar: { one: 'شيء', many: 'أشياء' } } });
  assert.equal((await call('PUT', '/api/admin/settings', { categories: cats })).status, 200);
  const r = (await call('GET', `/api/admin/import/places?q=${encodeURIComponent('زحلة')}&radius=5`)).data;
  assert.equal(r.groups.find((g) => g.key === 'hospitals').items[0].name, 'مستشفى تل شيحا');
  assert.ok(r.failed.includes('oddity'));
});

test('one country per visitor: no country → the default only; a subscriber added in France is French', async () => {
  const paris = await app.db.one(`INSERT INTO service_areas (slug, name_ar, name_en, lat, lng, country) VALUES ('fr-paris', 'Paris', 'Paris', 48.8566, 2.3522, 'FR') RETURNING id`);
  await app.areas.load();
  const fr = await call('POST', '/api/admin/cooks', { kind: 'bakery', fullName: 'Boulangerie Paul', whatsapp: '+33612345678', areaId: paris.id, lat: 48.857, lng: 2.353, servedAreaIds: [paris.id],
    activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } });
  assert.equal((await app.db.one('SELECT country FROM cooks WHERE id = $1', [fr.data.id])).country, 'FR');
  const noCountry = JSON.stringify((await call('GET', '/api/feed', null, null)).data);
  const lb = JSON.stringify((await call('GET', '/api/feed?country=LB', null, null)).data);
  const frFeed = JSON.stringify((await call('GET', '/api/feed?country=FR', null, null)).data);
  assert.ok(!noCountry.includes('Boulangerie Paul') && !lb.includes('Boulangerie Paul') && frFeed.includes('Boulangerie Paul'));
  assert.ok(!frFeed.includes('صيدلية قريبة'));
});

test('agents: suspend (signed out, cannot sign in), reactivate, new password, new country', async () => {
  const a = (await call('POST', '/api/admin/agents', { username: 'agent.lb', password: 'lebanon-agent-1', country: 'LB' })).data;
  const ag = (await call('POST', '/api/admin/login', { username: 'agent.lb', password: 'lebanon-agent-1' }, null)).headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/api/admin/me', null, ag)).status, 200);
  await call('PATCH', `/api/admin/agents/${a.id}`, { disabled: true });
  assert.equal((await call('GET', '/api/admin/me', null, ag)).status, 401, 'signed out at once');
  assert.equal((await call('POST', '/api/admin/login', { username: 'agent.lb', password: 'lebanon-agent-1' }, null)).status, 401, 'cannot sign in');
  await call('PATCH', `/api/admin/agents/${a.id}`, { disabled: false, password: 'new-agent-password-2', country: 'FR' });
  assert.equal((await call('POST', '/api/admin/login', { username: 'agent.lb', password: 'lebanon-agent-1' }, null)).status, 401, 'old password refused');
  const ag2 = (await call('POST', '/api/admin/login', { username: 'agent.lb', password: 'new-agent-password-2' }, null)).headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/api/admin/me', null, ag2)).data.country, 'FR');
  const list = (await call('GET', '/api/admin/cooks?filter=all&kind=bakery&limit=50&offset=0', null, ag2)).data.cooks;
  assert.ok(list.length && list.every((c) => c.country === 'FR'));
  assert.equal((await call('PATCH', `/api/admin/agents/${a.id}`, { disabled: true }, ag2)).status, 403, 'an agent cannot manage agents');
});
