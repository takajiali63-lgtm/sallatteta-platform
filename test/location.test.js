// Location & distance system — the 17 cases of the specification.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { haversineKm } from '../src/lib/geo.js';
import { distanceParts, formatDistance } from '../src/lib/distance.js';
import { geoapifyGet, geoapifyReverse, resetGeoapifyBackoff, redact } from '../src/services/geoapify.js';
import { createGeoResolver } from '../src/services/geoResolve.js';

const KEY = 'test-secret-geoapify-key-123';
const ZAHLE = { lat: 33.8466, lng: 35.9031 };
const north = (p, m) => ({ lat: p.lat + m / 111_195, lng: p.lng });           // move m metres north
let app, base, ck, zahleId;
const call = async (m, p, body, cookie = ck) => {
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addCook = async (name, phone, at, extra = {}) => (await call('POST', '/api/admin/cooks', {
  fullName: name, whatsapp: phone, areaId: zahleId, ...(at ? { lat: at.lat, lng: at.lng } : {}), services: ['home_cooking'], servedAreaIds: [zahleId],
  activate: { plan: 'monthly', startDate: new Date(Date.now() - 60_000).toISOString() }, ...extra })).data;

before(async () => {
  app = await createApp({
    databaseUrl: 'sqlite::memory:', sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999', geoapifyKey: KEY,
    bootstrapAdmin: { username: 'admin', password: 'correct-horse-battery' },
    searchLimit: 1e4, applyLimit: 1e4, loginLimit: 1e4, lookupLimit: 1e4, placesLimit: 1e4,
    placesFetcher: async () => [],
    // reverse geocoding as Geoapify returns it — including a street that must NEVER reach the cook
    geoFetcher: async () => ({ country: 'LB', regionKey: 'LB-beqaa', regionName: 'البقاع', city: 'زحلة', district: null, locality: 'حوش الأمراء', street: 'شارع البريد 12' }),
  });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  ck = (await call('POST', '/api/admin/login', { username: 'admin', password: 'correct-horse-battery' }, null)).headers.get('set-cookie').split(';')[0];
  zahleId = (await call('GET', `/api/areas/search?q=${encodeURIComponent('زحلة')}`)).data.areas[0].id;
});
after(async () => { await app.close(); resetGeoapifyBackoff(); });

describe('distances (computed locally — no API call)', () => {
  test('3) about 100 m', () => {
    const b = north(ZAHLE, 100);
    const m = haversineKm(ZAHLE.lat, ZAHLE.lng, b.lat, b.lng) * 1000;
    assert.ok(Math.abs(m - 100) < 1, `${m}`);
    assert.deepEqual(distanceParts(m), { value: '100', unit: 'm' });
  });
  test('4) about 1 km, and clean rounding everywhere', () => {
    const b = north(ZAHLE, 1000);
    const m = haversineKm(ZAHLE.lat, ZAHLE.lng, b.lat, b.lng) * 1000;
    assert.deepEqual(distanceParts(m), { value: '1', unit: 'km' });
    assert.deepEqual(distanceParts(1237), { value: '1.2', unit: 'km' });
    assert.deepEqual(distanceParts(2500), { value: '2.5', unit: 'km' });
    assert.deepEqual(distanceParts(153), { value: '150', unit: 'm' });
    assert.deepEqual(distanceParts(999), { value: '1', unit: 'km' });
    const ar = (k, v) => ({ 'units.mLong': `${v.d} متر`, 'units.kmLong': `${v.d} كيلومتر` }[k]);
    assert.equal(formatDistance(ar, 150, 'km', { long: true }), '150 متر');
    assert.equal(formatDistance(ar, 1200, 'km', { long: true }), '1.2 كيلومتر');
  });
});

let kitchen;
describe('subscriber location', () => {
  test('1) a precise fix is stored with its accuracy, time and the place from reverse geocoding', async () => {
    await sleep(10);
    const r = await call('POST', '/api/cook-applications', {
      acceptTerms: true, password: 'pass12345', fullName: 'سعاد', whatsapp: '71 555 010', ...ZAHLE, accuracy: 12, locationAt: Date.now() - 5000,
      servedAreaIds: [zahleId], services: ['home_cooking'], plan: 'monthly', startedAt: Date.now() - 5000,
    }, null);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    kitchen = await app.db.one('SELECT lat, lng, location_accuracy_m, location_at, addr_city, addr_locality, country FROM cooks WHERE id = $1', [r.data.applicationId]);
    assert.equal(Number(kitchen.lat), 33.8466);
    assert.equal(kitchen.location_accuracy_m, 12);
    assert.ok(kitchen.location_at);
    assert.equal(kitchen.addr_city, 'زحلة');
    assert.equal(kitchen.addr_locality, 'حوش الأمراء');
    assert.equal(kitchen.country, 'LB');
  });
  test('8) an inexact or stale reading is not saved as a kitchen location', async () => {
    const body = { acceptTerms: true, password: 'pass12345', fullName: 'هند', whatsapp: '71 555 011', ...ZAHLE, servedAreaIds: [zahleId], services: ['home_cooking'], plan: 'monthly', startedAt: Date.now() - 5000 };
    const weak = await call('POST', '/api/cook-applications', { ...body, accuracy: 400, locationAt: Date.now() }, null);
    assert.equal(weak.status, 422); assert.equal(weak.data.fields.location, 'location_inaccurate');
    const old = await call('POST', '/api/cook-applications', { ...body, accuracy: 10, locationAt: Date.now() - 30 * 60_000 }, null);
    assert.equal(old.status, 422); assert.equal(old.data.fields.location, 'location_stale');
    // the customer side refuses a hopeless fix too (the page asks to try again)
    const c = await call('POST', '/api/search', { text: 'بدي كبة لـ 4', location: { type: 'gps', ...ZAHLE, accuracy: 5000 }, startedAt: Date.now() - 5000 }, null);
    assert.equal(c.status, 422); assert.equal(c.data.fields.location, 'location_inaccurate');
  });
});

describe('customers: nearest first, distance shown, privacy', () => {
  let cooks;
  test('5) five subscribers are sorted nearest → farthest with their distance in metres', async () => {
    cooks = [];
    for (const [i, m] of [[1, 2400], [2, 150], [3, 900], [4, 1300], [5, 60]].entries()) {
      cooks.push({ m: m[1], ...(await addCook(`طبّاخ ${m[0]}`, `+9617155502${m[0]}`, north(ZAHLE, m[1]))) });
    }
    const r = await call('POST', '/api/search', { text: 'بدي صينية كبة لـ 6', location: { type: 'gps', ...ZAHLE, accuracy: 9 }, startedAt: Date.now() - 5000 }, null);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const mine = r.data.cooks.filter((c) => c.name.startsWith('طبّاخ '));
    assert.deepEqual(mine.map((c) => c.name), ['طبّاخ 5', 'طبّاخ 2', 'طبّاخ 3', 'طبّاخ 4', 'طبّاخ 1']);
    const ds = mine.map((c) => c.distanceM);
    assert.deepEqual(ds, [...ds].sort((a, b) => a - b));
    assert.ok(Math.abs(ds[1] - 150) <= 2, `150 m expected, got ${ds[1]}`);
    assert.deepEqual(distanceParts(ds[1]), { value: '150', unit: 'm' });
  });
  test('2) the customer fix gives exact distances, but only a ~1 km copy is stored', async () => {
    const row = await app.db.one('SELECT approx_lat, approx_lng FROM requests ORDER BY id DESC LIMIT 1');
    assert.equal(Number(row.approx_lat), 33.85);
    assert.equal(Number(row.approx_lng), 35.9);
  });
  test('13/14/15) WhatsApp: "أنا بعيد عنك 150 متر" + area name, in the customer’s voice; no address, street or coordinates', async () => {
    const r = await call('POST', '/api/search', { text: 'بدي صينية كبة لـ 6', location: { type: 'gps', ...ZAHLE, accuracy: 9 }, startedAt: Date.now() - 5000 }, null);
    const target = r.data.cooks.find((c) => c.name === 'طبّاخ 2');
    const c = await call('POST', '/api/contact', { requestId: r.data.requestId, cookId: target.id }, null);
    const msg = new URL(c.data.whatsappUrl).searchParams.get('text');
    assert.ok(msg.includes('📍 أنا بعيد عنك 150 متر'), msg);
    assert.ok(msg.includes('📍 المنطقة: حوش الأمراء'), msg);
    assert.ok(msg.includes('🍽️ الطلب:\nبدي صينية كبة لـ 6'), msg);
    assert.ok(!msg.includes('الزبون يبعد'), 'never "the customer is…"');
    assert.ok(!msg.includes('شارع البريد') && !/33\.8|35\.9/.test(msg), 'no street, no coordinates');
    // English customer → English message with km
    const far = r.data.cooks.find((c) => c.name === 'طبّاخ 4');
    const r2 = await fetch(base + '/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', 'X-Locale': 'en' },
      body: JSON.stringify({ text: 'Kibbeh tray for 6', location: { type: 'gps', ...ZAHLE, accuracy: 9 }, startedAt: Date.now() - 5000 }) }).then((x) => x.json());
    const c2 = await call('POST', '/api/contact', { requestId: r2.requestId, cookId: far.id }, null);
    assert.ok(new URL(c2.data.whatsappUrl).searchParams.get('text').includes("📍 I'm 1.3 km away from you"));
  });
  test('6/7) no location (permission denied / GPS unavailable) → no search, no request saved', async () => {
    const before = Number((await app.db.one('SELECT COUNT(*) AS n FROM requests')).n);
    for (const location of [undefined, { type: 'gps' }, { type: 'gps', lat: 'x', lng: null }, { type: 'gps', lat: 999, lng: 0 }]) {
      const r = await call('POST', '/api/search', { text: 'بدي كبة لـ 4', location, startedAt: Date.now() - 5000 }, null);
      assert.equal(r.status, 422, JSON.stringify(location));
    }
    assert.equal(Number((await app.db.one('SELECT COUNT(*) AS n FROM requests')).n), before);
  });
  test('9) a subscriber added without a GPS fix uses the village centre — search keeps working', async () => {
    const c = await addCook('بلا موقع', '+96171555099', null);
    assert.ok(Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng)));
    const r = await call('POST', '/api/search', { text: 'بدي كبة لـ 4', location: { type: 'gps', ...ZAHLE, accuracy: 9 }, startedAt: Date.now() - 5000 }, null);
    assert.equal(r.status, 200);
    assert.ok(r.data.cooks.some((x) => x.name === 'بلا موقع'));
  });
});

describe('Geoapify (server side only)', () => {
  test('10) unavailable → one retry, then a clear error; the platform falls back to known places', async () => {
    resetGeoapifyBackoff();
    let calls = 0;
    const down = async () => { calls++; throw new TypeError('fetch failed'); };
    await assert.rejects(geoapifyGet('/v1/geocode/reverse', { lat: '1', lon: '1' }, { key: KEY, fetchImpl: down, timeoutMs: 200 }), /fetch failed/);
    assert.equal(calls, 2, 'retried once');
    const resolver = createGeoResolver({ db: app.db, areas: app.areas, cfg: { geoapifyKey: KEY }, fetcher: async () => { throw new Error('geoapify down'); }, log: {} });
    const r = await resolver.resolve(ZAHLE.lat + 0.031, ZAHLE.lng + 0.017);
    assert.equal(r.country, 'LB', 'still knows the country from nearby villages');
  });
  test('11) rate limit (429) → backs off without hammering the API', async () => {
    resetGeoapifyBackoff();
    let calls = 0;
    const limited = async () => { calls++; return new Response('{}', { status: 429, headers: { 'retry-after': '30' } }); };
    await assert.rejects(geoapifyGet('/v1/geocode/reverse', {}, { key: KEY, fetchImpl: limited }), /rate limited/);
    await assert.rejects(geoapifyGet('/v1/geocode/reverse', {}, { key: KEY, fetchImpl: limited }), /backing off/);
    assert.equal(calls, 1, 'second call did not reach the API');
    resetGeoapifyBackoff();
  });
  test('12) reverse geocoding failure → the order still goes out, with the nearest village as the area', async () => {
    const empty = async () => new Response(JSON.stringify({ results: [] }), { status: 200 });
    await assert.rejects(geoapifyReverse(1, 1, { key: KEY, fetchImpl: empty }), /no country/);
    const app2 = await createApp({ databaseUrl: 'sqlite::memory:', sessionSecret: 'y'.repeat(40), quiet: true, adminWhatsapp: '96170999999',
      bootstrapAdmin: { username: 'admin', password: 'correct-horse-battery' }, searchLimit: 1e4, placesFetcher: async () => [], geoFetcher: async () => { throw new Error('reverse failed'); } });
    await new Promise((r) => app2.server.listen(0, r));
    const b2 = `http://127.0.0.1:${app2.server.address().port}`;
    const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' };
    const l = await fetch(b2 + '/api/admin/login', { method: 'POST', headers: H, body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery' }) });
    const c2 = l.headers.get('set-cookie').split(';')[0];
    const z = (await (await fetch(b2 + `/api/areas/search?q=${encodeURIComponent('زحلة')}`)).json()).areas[0].id;
    const cook = await (await fetch(b2 + '/api/admin/cooks', { method: 'POST', headers: { ...H, Cookie: c2 }, body: JSON.stringify({ fullName: 'رنا', whatsapp: '+96171555111', areaId: z, ...north(ZAHLE, 300), services: ['home_cooking'], servedAreaIds: [z], activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } }) })).json();
    const s = await (await fetch(b2 + '/api/search', { method: 'POST', headers: H, body: JSON.stringify({ text: 'بدي كبة لـ 4', location: { type: 'gps', ...ZAHLE, accuracy: 9 }, startedAt: Date.now() - 5000 }) })).json();
    const c = await (await fetch(b2 + '/api/contact', { method: 'POST', headers: H, body: JSON.stringify({ requestId: s.requestId, cookId: cook.id }) })).json();
    const msg = new URL(c.whatsappUrl).searchParams.get('text');
    assert.ok(msg.includes('📍 أنا بعيد عنك 300 متر') && msg.includes('📍 المنطقة: زحلة'), msg);
    await app2.close();
  });
  test('16) the API key never leaks (errors, config, pages, messages)', async () => {
    assert.equal(redact(`https://api.geoapify.com/v1?apiKey=${KEY}`, KEY).includes(KEY), false);
    const boom = async () => { throw new Error(`connect failed for https://api.geoapify.com/x?apiKey=${KEY}`); };
    await geoapifyGet('/x', {}, { key: KEY, fetchImpl: boom, timeoutMs: 100 }).catch((e) => assert.ok(!e.message.includes(KEY)));
    const cfg = await (await fetch(base + '/api/config')).text();
    assert.ok(!cfg.includes(KEY));
    assert.equal(JSON.parse(cfg).geoAttribution, true, 'the required "Powered by Geoapify" credit is shown');
    for (const p of ['/', '/join', '/assets/app.js', '/assets/ui.js', '/locales/ar.json']) assert.ok(!(await (await fetch(base + p)).text()).includes(KEY), p);
  });
});

describe('scale', () => {
  test('17) only subscribers serving the customer’s villages are loaded (indexed), fast with thousands of others', async () => {
    const other = (await app.db.query("SELECT id FROM service_areas WHERE slug <> 'zahle' ORDER BY id LIMIT 40")).map((r) => r.id);
    const now = new Date(); const later = new Date(Date.now() + 30 * 864e5);
    for (let i = 0; i < 3000; i++) {
      const row = await app.db.one(`INSERT INTO cooks (full_name, whatsapp, area_id, area_label, lat, lng, service_radius_km, status, name_norm, kind) VALUES ($1,$2,$3,'x',$4,$5,0,'approved',$1,'cook') RETURNING id`,
        [`other ${i}`, `96172${String(i).padStart(6, '0')}`, other[i % other.length], 34.4 + (i % 50) / 1000, 35.8 + (i % 70) / 1000]);
      await app.db.query('INSERT INTO cook_service_areas (cook_id, area_id) VALUES ($1,$2)', [row.id, other[i % other.length]]);
      await app.db.query(`INSERT INTO subscriptions (cook_id, plan, status, payment_status, start_date, expiry_date) VALUES ($1,'monthly','active','paid',$2,$3)`, [row.id, now.toISOString(), later.toISOString()]);
    }
    const t0 = performance.now();
    const r = await call('POST', '/api/search', { text: 'بدي كبة لـ 4', location: { type: 'gps', ...ZAHLE, accuracy: 9 }, startedAt: Date.now() - 5000 }, null);
    const ms = performance.now() - t0;
    assert.equal(r.status, 200);
    assert.ok(r.data.cooks.every((c) => !c.name.startsWith('other ')), 'subscribers elsewhere are not even loaded');
    assert.ok(ms < 400, `search took ${Math.round(ms)} ms with 3000+ subscribers`);
  });
});
