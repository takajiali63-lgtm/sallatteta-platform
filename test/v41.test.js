// v4.1: each visitor sees only their country, mandatory terms, admin text editor, legal pages, stats per kind.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';
let app, base, ck;
const call = async (m, p, body, cookie = ck) => {
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  app = await createApp({
    databaseUrl: 'sqlite::memory:', sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999',
    bootstrapAdmin: { username: 'admin', password: 'correct-horse-battery' },
    searchLimit: 1e4, applyLimit: 1e4, loginLimit: 1e4, lookupLimit: 1e4, placesLimit: 1e4,
    placesFetcher: async (lat) => (lat > 40 ? [{ osmId: 1, nameAr: 'Montmartre', nameEn: 'Montmartre', lat: 48.8867, lng: 2.3431 }] : []),
    geoFetcher: async (lat) => (lat > 40 ? { country: 'FR', regionKey: 'FR-IDF', regionName: 'Île-de-France' } : { country: 'LB' }),
  });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const l = await call('POST', '/api/admin/login', { username: 'admin', password: 'correct-horse-battery' }, null);
  ck = l.headers.get('set-cookie').split(';')[0];
  const zahle = (await call('GET', `/api/areas/search?q=${encodeURIComponent('زحلة')}`)).data.areas[0].id;
  const montmartre = (await call('GET', '/api/areas/around?lat=48.8867&lng=2.3431')).data.areas[0].id;
  const add = async (name, phone, areaId, lat, lng, kind = 'cook') => (await call('POST', '/api/admin/cooks', {
    kind, fullName: name, whatsapp: phone, areaId, lat, lng, services: ['home_cooking'], servedAreaIds: [areaId], specialty: kind === 'restaurant' ? 'x' : undefined,
    activate: { plan: 'monthly', startDate: new Date(Date.now() - 60_000).toISOString() } })).data;
  const lb = await add('رنا اللبنانية', '+96171222001', zahle, 33.8466, 35.9031);
  const fr = await add('Chef Paris', '+33612000001', montmartre, 48.8867, 2.3431);
  const lbR = await add('مطعم بيروتي', '+96171222002', zahle, 33.8466, 35.9031, 'restaurant');
  const frR = await add('Bistro Paris', '+33612000002', montmartre, 48.8867, 2.3431, 'restaurant');
  for (const c of [lb, fr, lbR, frR]) await app.db.query('INSERT INTO cook_photos (cook_id, data, caption) VALUES ($1,$2,$3)', [c.id, IMG, c.full_name]);
});
after(async () => { await app.close(); });

test('a visitor in Lebanon never sees French cooks/restaurants (sliders, name search, dish photos) — and vice versa', async () => {
  const feedLB = (await call('GET', '/api/feed?country=LB')).data;
  assert.deepEqual(feedLB.cooks.map((c) => c.name), ['رنا اللبنانية']);
  assert.deepEqual(feedLB.restaurantPhotos.map((p) => p.restaurantName), ['مطعم بيروتي']);
  assert.ok(feedLB.dishes.every((d) => d.cookName !== 'Chef Paris' && d.cookName !== 'Bistro Paris'));
  const feedFR = (await call('GET', '/api/feed?country=FR')).data;
  assert.deepEqual(feedFR.cooks.map((c) => c.name), ['Chef Paris']);
  assert.deepEqual(feedFR.restaurantPhotos.map((p) => p.restaurantName), ['Bistro Paris']);
  assert.equal((await call('GET', `/api/cooks/search?q=${encodeURIComponent('Paris')}&country=LB`)).data.cooks.length, 0);
  assert.equal((await call('GET', `/api/cooks/search?q=${encodeURIComponent('Paris')}&country=FR`)).data.cooks.length, 2);
  const dLB = (await call('GET', '/api/dishes?country=LB&limit=30')).data.dishes.map((d) => d.cookName).sort();
  assert.deepEqual(dLB, ['رنا اللبنانية', 'مطعم بيروتي'].sort());
});

test('admin dashboard counts cooks and restaurants separately', async () => {
  const s = (await call('GET', '/api/admin/stats')).data;
  assert.equal(s.active_cooks, 2);
  assert.equal(s.active_restaurants, 2);
});

test('subscribing requires accepting the terms (checked on the server); the acceptance is recorded', async () => {
  const body = { password: 'pass12345', fullName: 'هند', whatsapp: '76 555 999', lat: 33.8466, lng: 35.9031, servedAreaIds: [1], services: ['home_cooking'], plan: 'monthly', startedAt: Date.now() - 5000 };
  await sleep(10);
  const no = await call('POST', '/api/cook-applications', body, null);
  assert.equal(no.status, 422);
  assert.equal(no.data.fields.acceptTerms, 'required');
  const yes = await call('POST', '/api/cook-applications', { ...body, acceptTerms: true }, null);
  assert.equal(yes.status, 201, JSON.stringify(yes.data));
  const row = await app.db.one('SELECT terms_accepted_at, terms_version FROM cooks WHERE id = $1', [yes.data.applicationId]);
  assert.ok(row.terms_accepted_at && row.terms_version);
});

test('admin edits any text: pages and WhatsApp messages change; reset restores; only known keys; admin only', async () => {
  const list = (await call('GET', `/api/admin/texts?lang=ar&q=${encodeURIComponent('ماذا تشتهي')}`)).data;
  assert.ok(list.items.some((i) => i.key === 'home.title'));
  assert.equal((await call('PUT', '/api/admin/texts', { lang: 'ar', key: 'home.title', value: 'شو جوعان اليوم؟' })).status, 200);
  const loc = await (await fetch(base + '/locales/ar.json')).json();
  assert.equal(loc.home.title, 'شو جوعان اليوم؟');
  await call('PUT', '/api/admin/texts', { lang: 'ar', key: 'wa.adminApplication', value: 'طلب جديد: {name}' });
  const app2 = await call('POST', '/api/cook-applications', { acceptTerms: true, password: 'pass12345', fullName: 'سهى', whatsapp: '76 555 111', lat: 33.8466, lng: 35.9031, servedAreaIds: [1], services: ['home_cooking'], plan: 'monthly', startedAt: Date.now() - 5000 }, null);
  assert.equal(new URL(app2.data.whatsappUrl).searchParams.get('text'), 'طلب جديد: سهى');
  await call('PUT', '/api/admin/texts', { lang: 'ar', key: 'home.title', value: null });
  assert.equal((await (await fetch(base + '/locales/ar.json')).json()).home.title, 'ماذا تشتهي اليوم؟');
  assert.equal((await call('PUT', '/api/admin/texts', { lang: 'ar', key: 'not.a.key', value: 'x' })).status, 422);
  assert.equal((await call('PUT', '/api/admin/texts', { lang: 'ar', key: 'home.title', value: 'x' }, null)).status, 401);
  // editing the legal pages
  await call('PUT', '/api/admin/texts', { lang: 'en', key: 'pages.terms.title', value: 'Our terms' });
  assert.equal((await (await fetch(base + '/locales/en.json')).json()).pages.terms.title, 'Our terms');
});

test('legal & info pages exist on every language; big banner images are accepted', async () => {
  for (const p of ['/terms', '/privacy', '/about']) assert.equal((await fetch(base + p)).status, 200, p);
  const ar = await (await fetch(base + '/locales/ar.json')).json();
  assert.ok(ar.pages.terms.body.includes('ليست طرفاً'));
  assert.ok(ar.legal.acceptTerms.includes('{terms}'));
  const big = 'data:image/jpeg;base64,/9j/' + 'A'.repeat(1_000_000);
  assert.equal((await call('POST', '/api/admin/banners', { image: big, placement: 'home_top' })).status, 201);
});
