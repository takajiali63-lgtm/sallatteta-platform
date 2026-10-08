// v7.6: distances by road (Geoapify) with cost control and fallback, nearest drivers with photo/name/distance (phone only
// after accepting), separate request radiuses, appointments with replies/cancel/delete, optional services the store turns
// on itself, subscription renewal (receipt → owner) and online payments (signed callback, applied once), automatic
// payouts, one phone for several accounts + owner notifications, readable colours, prices in one place.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/server.js';
import { createRoads } from '../src/services/roads.js';
import { createPayments } from '../src/services/payments.js';
import { haversineKm } from '../src/lib/geo.js';
import { ratio, readable, readableVars, inkOn } from '../src/lib/contrast.js';
import { DESIGNS, designCss } from '../src/services/designs.js';
import { themeCss } from '../src/services/theme.js';

const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';
const DOCS = Object.fromEntries(['selfie', 'idFront', 'idBack', 'vehicleFront', 'vehicleBack', 'registration', 'criminalRecord'].map((k) => [k, JPG]));
let app, base, admin, areaId, cust;

// A fake road network: north of 33.95 is "mountain" (roads 3× the straight line), elsewhere 1.2×.
const roadOf = (a, b) => haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000 * (Math.max(a.lat, b.lat) > 33.95 ? 3 : 1.2);
const geoCalls = [];
async function fakeGeo(url, opts = {}) {
  const u = new URL(url);
  geoCalls.push(u.pathname);
  if (u.pathname === '/v1/routing') {
    const [a, b] = u.searchParams.get('waypoints').split('|').map((p) => { const [lat, lng] = p.split(',').map(Number); return { lat, lng }; });
    return { ok: true, status: 200, json: async () => ({ features: [{ properties: { distance: roadOf(a, b) } }] }) };
  }
  if (u.pathname === '/v1/routematrix') {
    const body = JSON.parse(opts.body);
    const t = { lat: body.targets[0].location[1], lng: body.targets[0].location[0] };
    return { ok: true, status: 200, json: async () => ({ sources_to_targets: body.sources.map((s) => [{ distance: roadOf({ lat: s.location[1], lng: s.location[0] }, t) }]) }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
}
// A fake payment provider.
const payCalls = [];
async function fakePay(url, opts) {
  const body = JSON.parse(opts.body);
  payCalls.push({ url, body });
  if (url.endsWith('/create')) return { ok: true, status: 200, json: async () => ({ url: `https://pay.example/c/${body.reference}` }) };
  if (url.endsWith('/payout')) return String(body.number).endsWith('9') ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ ok: true, id: `P-${body.reference}` }) };
  return { ok: false, status: 404, json: async () => ({}) };
}
const PAY_ENV = { PAY_CHECKOUT_URL: 'https://pay.example/create', PAY_API_KEY: 'k', PAY_WEBHOOK_SECRET: 'whsec', PAYOUT_API_URL: 'https://pay.example/payout', PAYOUT_API_KEY: 'k' };
const sign = (raw) => createHmac('sha256', 'whsec').update(raw).digest('hex');

async function http(method, path, { body, cookie, raw, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method, redirect: 'manual',
    headers: { ...(body !== undefined || raw ? { 'Content-Type': 'application/json' } : {}), 'X-Requested-With': 'fetch', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data, headers: res.headers };
}
const ck = (r) => r.headers.get('set-cookie').split(';')[0];
const A = (m, p, b) => http(m, p, { body: b, cookie: admin });
let n = 0;
const nextPhone = () => `7160${String(1000 + n++).padStart(4, '0')}`;
async function makeDriver(lat, lng) {
  const phone = nextPhone();
  const r = await http('POST', '/api/driver/apply', { body: { fullName: 'سائق ' + phone.slice(-3) + ' حسن', phone, password: 'pass123', vehicle: 'moto', plate: 'B 1', walletProvider: 'whish', walletNumber: '71000000', acceptTerms: true, adult: true, birthDate: '1990-01-01', docs: DOCS, jobsMonths: 1 } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await A('POST', `/api/admin/drivers/${r.data.id}/status`, { status: 'active' });
  const cookie = ck(await http('POST', '/api/driver/login', { body: { phone, password: 'pass123' } }));
  await http('POST', '/api/driver/availability', { body: { available: true, lat, lng }, cookie });
  return { id: r.data.id, cookie, phone };
}
let sn = 0;
async function makeStore(lat, lng, { kind = 'restaurant' } = {}) {
  const wa = `+9617130${String(1000 + sn++).padStart(4, '0')}`;
  const r = await A('POST', '/api/admin/cooks', { fullName: 'متجر ' + sn, whatsapp: wa, areaId, services: ['home_cooking'], servedAreaIds: [areaId], kind, lat, lng, activate: { plan: 'monthly', startDate: new Date(Date.now() - 60_000).toISOString() } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await A('POST', `/api/admin/stores/${r.data.id}/delivery`, { mode: 'delivery' });
  await app.db.query(`INSERT INTO menu_items (cook_id, name, price, currency) VALUES ($1,'منقوشة',2,'USD')`, [r.data.id]);
  const item = (await app.db.one('SELECT id FROM menu_items WHERE cook_id = $1', [r.data.id])).id;
  const pw = (await A('POST', `/api/admin/cooks/${r.data.id}/password`, {})).data.password;
  const cookie = ck(await http('POST', '/api/cook/login', { body: { whatsapp: wa, password: pw } }));
  await A('POST', `/api/admin/stores/${r.data.id}/wallet-adjust`, { amount: 100, note: 'test' });
  return { id: r.data.id, cookie, item, lat, lng };
}
async function freeAll() {
  await app.db.query(`UPDATE orders SET status = 'cancelled' WHERE status IN ('searching','assigned','picked_up','preparing','pending')`);
  await app.db.query(`UPDATE errands SET status = 'cancelled' WHERE status IN ('searching','assigned','picked_up')`);
  await app.db.query(`UPDATE order_offers SET status = 'lost' WHERE status = 'sent'`);
  await app.db.query(`UPDATE errand_offers SET status = 'lost' WHERE status = 'sent'`);
  await app.db.query(`UPDATE drivers SET available = 0`);
}

before(async () => {
  app = await createApp({
    databaseUrl: 'sqlite::memory:', adminWhatsapp: '96170999999', sessionSecret: 'x'.repeat(40), quiet: true,
    bootstrapAdmin: { username: 'admin', password: 'correct-horse-battery' },
    searchLimit: 1e4, applyLimit: 1e4, loginLimit: 1e4, lookupLimit: 1e4, placesLimit: 1e4, feedbackLimit: 1e4, uploadLimit: 1e4, adminLimit: 1e5,
    placesFetcher: async () => [],
    roads: createRoads({ key: 'test-key', fetchImpl: fakeGeo, dailyMax: async () => 1000, log: {} }),
    payments: createPayments({ env: PAY_ENV, fetchImpl: fakePay, log: {} }),
  });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  areaId = (await app.db.one(`SELECT id FROM service_areas WHERE slug = 'zahle'`)).id;
  admin = ck(await http('POST', '/api/admin/login', { body: { username: 'admin', password: 'correct-horse-battery' } }));
  cust = ck(await http('POST', '/api/customer/login', { body: { name: 'زبون', phone: '03999222', acceptTerms: true } }));
  await A('PUT', '/api/admin/delivery/settings', { claimWindowSec: 0, offerBatch: 1 });
});
after(() => app?.close?.());

/* ---------------- road distances ---------------- */
test('roads: one paid call, then remembered; a moving driver re-uses his ratio; budget and failures fall back (marked approx)', async () => {
  const calls = [];
  const fetchImpl = async (url, o) => { calls.push(url); return fakeGeo(url, o); };
  let max = 3;
  const r = createRoads({ key: 'k', fetchImpl, dailyMax: async () => max, log: {} });
  const a = { lat: 33.89, lng: 35.50 }, b = { lat: 33.90, lng: 35.52 };
  const first = await r.distance(a, b, { track: 'd1' });
  assert.equal(first.approx, false);
  assert.ok(Math.abs(first.m - roadOf(a, b)) < 2);
  assert.equal((await r.distance(a, b)).m, first.m, 'same places: no new call');
  // the driver moved 200 m: no new call, distance scaled by his road/straight ratio (error far below 500 m)
  const moved = { lat: 33.8918, lng: 35.50 };
  const m2 = await r.distance(moved, b, { track: 'd1' });
  assert.equal(calls.length, 1);
  assert.ok(Math.abs(m2.m - roadOf(moved, b)) < 100, `${m2.m} vs ${roadOf(moved, b)}`);
  // budget used up → estimated from the straight line, flagged
  max = 1;
  const far = await r.distance({ lat: 33.80, lng: 35.60 }, b);
  assert.equal(far.approx, true);
  assert.equal(calls.length, 1);
  // Geoapify down → never throws
  const broken = createRoads({ key: 'k', fetchImpl: async () => { throw new Error('down'); }, dailyMax: async () => 99, log: {} });
  const fb = await broken.distance(a, b);
  assert.equal(fb.approx, true);
  assert.ok(fb.m > 0);
  // no key at all → straight line
  const none = createRoads({ key: '', log: {} });
  assert.equal((await none.distance(a, b)).approx, true);
});

test('the order goes to the nearest driver BY ROAD, not by straight line; distances shown by road', async () => {
  await freeAll();
  await A('PUT', '/api/admin/delivery/settings', { dispatchRadiusKm: 10 });
  const st = await makeStore(33.945, 35.50);
  const mountain = await makeDriver(33.951, 35.50);   // 0.7 km straight, but over the mountain (×3 ≈ 2 km)
  const valley = await makeDriver(33.935, 35.50);     // 1.1 km straight, road ×1.2 ≈ 1.3 km → nearer by road
  const o = await http('POST', '/api/orders', { cookie: cust, body: { storeId: st.id, items: [{ id: st.item, qty: 1 }], lat: 33.93, lng: 35.51 } });
  assert.equal(o.status, 201);
  const order = await app.db.one('SELECT distance_m FROM orders WHERE id = $1', [o.data.id]);
  assert.ok(Math.abs(order.distance_m - roadOf({ lat: 33.945, lng: 35.50 }, { lat: 33.93, lng: 35.51 })) < 5, 'store → customer by road');
  await http('POST', `/api/store/orders/${o.data.id}/accept`, { cookie: st.cookie, body: {} });
  await http('POST', `/api/store/orders/${o.data.id}/search`, { cookie: st.cookie, body: { fee: 2 } });
  const offers = await app.db.query('SELECT driver_id FROM order_offers WHERE order_id = $1', [o.data.id]);
  assert.deepEqual(offers.map((x) => x.driver_id), [valley.id], 'offerBatch 1 → the valley driver (nearer by road)');
  const off = (await http('GET', '/api/driver/offers', { cookie: valley.cookie })).data.offers[0];
  assert.equal(off.approx, false);
  assert.ok(Math.abs(off.toStoreM - roadOf({ lat: 33.935, lng: 35.50 }, { lat: 33.945, lng: 35.50 })) < 50);
  // the store sees who got it: photo, first name, distance — never the phone
  const view = (await http('GET', '/api/store/orders', { cookie: st.cookie })).data.orders.find((x) => x.id === o.data.id);
  assert.equal(view.candidates.length, 1);
  const c = view.candidates[0];
  assert.equal(c.id, valley.id); assert.equal(c.photo, true); assert.ok(c.m > 1000); assert.equal(c.name.split(' ').length, 1);
  assert.ok(!JSON.stringify(view.candidates).includes(valley.phone), 'no phone before accepting');
  // his photo: to this store yes, to another store no
  assert.equal((await http('GET', `/api/store/driver-photo/${valley.id}`, { cookie: st.cookie })).status, 200);
  const other = await makeStore(33.90, 35.52);
  assert.equal((await http('GET', `/api/store/driver-photo/${valley.id}`, { cookie: other.cookie })).status, 404);
  assert.equal((await http('GET', `/api/customer/driver-photo/${valley.id}`, { cookie: cust })).status, 404, 'not the customer\'s driver yet');
  // accepts → phone appears for store and customer, with live distance by road
  const fo = (await app.db.one(`SELECT id FROM order_offers WHERE order_id = $1 AND driver_id = $2`, [o.data.id, valley.id])).id;
  assert.equal((await http('POST', `/api/driver/offers/${fo}/accept`, { cookie: valley.cookie, body: {} })).data.won, true);
  const v2 = (await http('GET', '/api/store/orders', { cookie: st.cookie })).data.orders.find((x) => x.id === o.data.id);
  assert.equal(v2.driver.phone.endsWith(valley.phone.slice(-6)), true);
  assert.ok(v2.driver.toStoreM > 0 && v2.driver.photo === true);
  const co = (await http('GET', `/api/customer/orders/${o.data.id}`, { cookie: cust })).data.order;
  assert.ok(co.driver.phone && co.driver.photo === true);
  assert.equal((await http('GET', `/api/customer/driver-photo/${valley.id}`, { cookie: cust })).status, 200);
  assert.equal((await http('GET', '/api/driver/photo', { cookie: valley.cookie })).status, 200);
  await http('POST', `/api/driver/orders/${o.data.id}/picked`, { cookie: valley.cookie, body: {} });
  const co2 = (await http('GET', `/api/customer/orders/${o.data.id}`, { cookie: cust })).data.order;
  assert.ok(co2.driver.toYouM > 0, 'customer sees how far the driver is');
  await http('POST', `/api/driver/orders/${o.data.id}/delivered`, { cookie: valley.cookie, body: {} });
  void mountain;
});

test('customer requests ("request a driver") use their own radius; the customer sees nearby drivers, phone after accepting', async () => {
  await freeAll();
  await A('PUT', '/api/admin/delivery/settings', { errandRadiusKm: 1, dispatchRadiusKm: 10 });
  const near = await makeDriver(33.901, 35.50);   // ~120 m
  const far = await makeDriver(33.92, 35.50);     // ~2.2 km straight → outside the 1 km errand radius
  await app.db.query('UPDATE drivers SET jobs_until = $1 WHERE id IN ($2, $3)', [new Date(Date.now() + 30 * 864e5).toISOString(), near.id, far.id]);   // "customer requests" plan
  const e = await http('POST', '/api/errands', { cookie: cust, body: { kind: 'deliver', description: 'ملف إلى المكتب', price: 3, from: { lat: 33.90, lng: 35.50 }, to: { lat: 33.905, lng: 35.505 } } });
  assert.equal(e.status, 201, JSON.stringify(e.data));
  const offered = (await app.db.query('SELECT driver_id FROM errand_offers WHERE errand_id = $1', [e.data.id])).map((x) => x.driver_id);
  assert.ok(offered.includes(near.id) && !offered.includes(far.id));
  const view = (await http('GET', `/api/customer/errands/${e.data.id}`, { cookie: cust })).data.errand;
  assert.equal(view.candidates[0].id, near.id);
  assert.ok(!JSON.stringify(view.candidates).includes(near.phone));
  assert.equal((await http('GET', `/api/customer/driver-photo/${near.id}`, { cookie: cust })).status, 200, 'photo of a driver who got my request');
  const fo = (await app.db.one('SELECT id FROM errand_offers WHERE errand_id = $1 AND driver_id = $2', [e.data.id, near.id])).id;
  assert.equal((await http('POST', `/api/driver/errand-offers/${fo}/accept`, { cookie: near.cookie, body: {} })).data.won, true);
  const v2 = (await http('GET', `/api/customer/errands/${e.data.id}`, { cookie: cust })).data.errand;
  assert.ok(v2.driver.phone && v2.driver.photo && v2.driver.awayM != null);
  await A('PUT', '/api/admin/delivery/settings', { errandRadiusKm: 10 });
  await http('POST', `/api/driver/errands/${e.data.id}/delivered`, { cookie: near.cookie, body: {} });
});

/* ---------------- appointments ---------------- */
test('appointments: optional and free — the store turns them on; reply, confirm, cancel, delete on both sides', async () => {
  const st = await makeStore(33.90, 35.50, { kind: 'restaurant' });
  const when = new Date(Date.now() + 2 * 864e5).toISOString();
  assert.equal((await http('POST', '/api/appointments', { cookie: cust, body: { storeId: st.id, service: 'قص شعر', startsAt: when } })).status, 409, 'off until the store turns it on');
  const set = await http('GET', '/api/store/settings', { cookie: st.cookie });
  assert.equal(set.data.booking, false); assert.equal(set.data.bookingPrice, 0);
  assert.equal((await http('POST', '/api/store/settings', { cookie: st.cookie, body: { booking: true } })).status, 200);
  const a1 = await http('POST', '/api/appointments', { cookie: cust, body: { storeId: st.id, service: 'قص شعر', startsAt: when, note: 'قصير' } });
  assert.equal(a1.status, 201);
  assert.equal((await http('POST', `/api/store/appointments/${a1.data.id}/confirm`, { cookie: st.cookie, body: { reply: 'نراك الساعة 5' } })).status, 200);
  let mine = (await http('GET', '/api/customer/appointments', { cookie: cust })).data.appointments.find((x) => x.id === a1.data.id);
  assert.equal(mine.status, 'confirmed'); assert.equal(mine.store_reply, 'نراك الساعة 5'); assert.ok(mine.store_phone, 'the store number once confirmed');
  // the store cancels with a reason; the customer sees who cancelled
  assert.equal((await http('POST', `/api/store/appointments/${a1.data.id}/cancel`, { cookie: st.cookie, body: { reply: 'عطل طارئ' } })).status, 200);
  mine = (await http('GET', '/api/customer/appointments', { cookie: cust })).data.appointments.find((x) => x.id === a1.data.id);
  assert.equal(mine.status, 'cancelled'); assert.equal(mine.cancelled_by, 'store');
  // delete from each list independently
  assert.equal((await http('POST', `/api/customer/appointments/${a1.data.id}/hide`, { cookie: cust, body: {} })).status, 200);
  assert.ok(!(await http('GET', '/api/customer/appointments', { cookie: cust })).data.appointments.some((x) => x.id === a1.data.id));
  assert.ok((await http('GET', '/api/store/appointments', { cookie: st.cookie })).data.appointments.some((x) => x.id === a1.data.id), 'still in the store\'s book');
  // deleting a live booking cancels it first
  const a2 = await http('POST', '/api/appointments', { cookie: cust, body: { storeId: st.id, service: 'صبغة', startsAt: when } });
  await http('POST', `/api/customer/appointments/${a2.data.id}/hide`, { cookie: cust, body: {} });
  const row = await app.db.one('SELECT status, cancelled_by FROM appointments WHERE id = $1', [a2.data.id]);
  assert.equal(row.status, 'cancelled'); assert.equal(row.cancelled_by, 'customer');
  assert.equal((await http('POST', `/api/store/appointments/${a2.data.id}/hide`, { cookie: st.cookie, body: {} })).status, 200);
  assert.ok(!(await http('GET', '/api/store/appointments', { cookie: st.cookie })).data.appointments.some((x) => x.id === a2.data.id));
  // another customer's booking can't be touched
  const c2 = ck(await http('POST', '/api/customer/login', { body: { name: 'آخر', phone: '03999333', acceptTerms: true } }));
  assert.equal((await http('POST', `/api/customer/appointments/${a1.data.id}/cancel`, { cookie: c2, body: {} })).status, 404);
});

test('"order on WhatsApp" stays an option for delivery stores (on by default, the store can turn it off)', async () => {
  const st = await makeStore(33.90, 35.50);
  const get = async () => (await http('GET', `/api/delivery/stores/${st.id}`, { cookie: cust })).data.store;
  assert.ok((await get()).whatsapp);
  await http('POST', '/api/store/settings', { cookie: st.cookie, body: { waOrders: false } });
  assert.equal((await get()).whatsapp, null);
  await http('POST', '/api/store/settings', { cookie: st.cookie, body: { waOrders: true } });
  assert.ok((await get()).whatsapp);
});

/* ---------------- subscription renewal & online money ---------------- */
test('renewal: price from "Prices & durations" incl. branches; receipt → the owner approves → subscription extended, mode switched', async () => {
  await A('PUT', '/api/admin/plans', { store: { delivery: { 3: { price: 40 } }, basic: { 12: { hidden: true } } }, branchPercent: 50, payTo: { whish: '+961 70 123456', omt: '', name: 'Aklatak' } });
  assert.equal((await A('PUT', '/api/admin/plans', { payTo: { whish: 'abc' } })).status, 422);
  const pub = (await http('GET', '/api/plans')).data;
  assert.equal(pub.payTo.whish, '+961 70 123456');
  const st = await makeStore(33.90, 35.50);
  await http('POST', '/api/store/branches', { cookie: st.cookie, body: { name: 'فرع 2', lat: 33.91, lng: 35.51 } });
  const info = (await http('GET', '/api/store/subscription', { cookie: st.cookie })).data;
  assert.equal(info.branches, 2);
  assert.equal(info.options.find((o) => o.kind === 'delivery').months.find((x) => x.months === 3).price, 60, '40 + 50 %');
  assert.ok(!info.options.find((o) => o.kind === 'basic').months.some((x) => x.months === 12), 'hidden duration not offered');
  assert.equal((await http('POST', '/api/store/renewals', { cookie: st.cookie, body: { kind: 'basic', months: 12, method: 'whish', receipt: JPG } })).status, 422);
  const before = (await app.db.one('SELECT expiry_date FROM subscriptions WHERE cook_id = $1 ORDER BY id DESC', [st.id])).expiry_date;
  const r = await http('POST', '/api/store/renewals', { cookie: st.cookie, body: { kind: 'basic', months: 3, method: 'whish', reference: 'W-1', receipt: JPG } });
  assert.equal(r.status, 201); assert.equal(r.data.amount, 27 * 1.5);
  const list = (await A('GET', '/api/admin/renewals')).data.renewals;
  assert.ok(list.some((x) => x.id === r.data.id));
  assert.equal((await A('GET', `/api/admin/renewals/${r.data.id}/receipt`)).status, 200);
  assert.equal((await A('POST', `/api/admin/renewals/${r.data.id}/approve`, {})).status, 200);
  assert.equal((await A('POST', `/api/admin/renewals/${r.data.id}/approve`, {})).status, 409, 'only once');
  const after = (await app.db.one('SELECT expiry_date FROM subscriptions WHERE cook_id = $1 ORDER BY id DESC', [st.id])).expiry_date;
  assert.ok(new Date(after) - new Date(before) > 80 * 864e5, '3 months added to the running subscription');
  const modes = await app.db.query('SELECT delivery_mode FROM cooks WHERE id = $1 OR parent_id = $1', [st.id]);
  assert.ok(modes.every((x) => x.delivery_mode === 'self'), 'without drivers → own delivery, for every branch');
});

test('online payments: off → 409; on → checkout link; only a correctly signed callback counts, and only once', async () => {
  const st = await makeStore(33.90, 35.50);
  const r = await http('POST', '/api/store/pay', { cookie: st.cookie, body: { purpose: 'topup', amount: 25 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.url, /^https:\/\/pay\.example\/c\//);
  const token = r.data.url.split('/').pop();
  const bal = async () => (await http('GET', '/api/store/wallet', { cookie: st.cookie })).data.balance;
  const b0 = await bal();
  const raw = JSON.stringify({ reference: token, status: 'paid', id: 'tx1' });
  assert.equal((await http('POST', '/api/pay/webhook', { raw, headers: { 'X-Signature': 'bad' } })).status, 401);
  assert.equal((await http('POST', '/api/pay/webhook', { raw, headers: { 'X-Signature': sign(raw) } })).status, 200);
  assert.equal((await http('POST', '/api/pay/webhook', { raw, headers: { 'X-Signature': sign(raw) } })).status, 200);
  assert.equal(await bal(), b0 + 25, 'added once even if the gateway calls twice');
  // renewal online
  const rr = await http('POST', '/api/store/pay', { cookie: st.cookie, body: { purpose: 'renewal', kind: 'delivery', months: 1 } });
  const tk = rr.data.url.split('/').pop();
  const before = (await app.db.one('SELECT expiry_date FROM subscriptions WHERE cook_id = $1 ORDER BY id DESC', [st.id])).expiry_date;
  const raw2 = JSON.stringify({ reference: tk, status: 'paid' });
  await http('POST', '/api/pay/webhook', { raw: raw2, headers: { 'X-Signature': sign(raw2) } });
  const after = (await app.db.one('SELECT expiry_date FROM subscriptions WHERE cook_id = $1 ORDER BY id DESC', [st.id])).expiry_date;
  assert.ok(new Date(after) > new Date(before));
  // a gateway without keys
  const off = createPayments({ env: {}, log: {} });
  assert.equal(off.payInEnabled, false); assert.equal(off.payOutEnabled, false);
});

test('automatic payouts: with the keys a withdrawal is sent and marked paid; a failed transfer waits for the owner', async () => {
  const d = await makeDriver(33.90, 35.50);
  await A('POST', `/api/admin/drivers/${d.id}/wallet-adjust`, { amount: 50, note: 't' }).catch(() => null);
  await app.db.query(`INSERT INTO wallet_ledger (account_type, account_id, amount, kind, note) VALUES ('driver', $1, 60, 'adjust', 't')`, [d.id]);
  const w1 = await http('POST', '/api/driver/withdrawals', { cookie: d.cookie, body: { amount: 20, provider: 'whish', number: '71000001', password: 'pass123' } });
  assert.equal(w1.status, 201, JSON.stringify(w1.data)); assert.equal(w1.data.status, 'paid');
  assert.ok(payCalls.some((c) => c.body.reference === `W${w1.data.id}`));
  const w2 = await http('POST', '/api/driver/withdrawals', { cookie: d.cookie, body: { amount: 20, provider: 'omt', number: '71000009', password: 'pass123' } });
  assert.equal(w2.data.status, 'pending', 'transfer failed → stays for the owner');
});

/* ---------------- notifications ---------------- */
test('one phone, several accounts: customer + store + owner all keep their notifications', async () => {
  const st = await makeStore(33.90, 35.50);
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/same-phone-123', keys: { p256dh: 'BOr', auth: 'xx' } };
  assert.equal((await http('POST', '/api/push/subscribe', { cookie: cust, body: { role: 'customer', ...sub } })).status, 200);
  assert.equal((await http('POST', '/api/push/subscribe', { cookie: st.cookie, body: { role: 'store', ...sub } })).status, 200);
  assert.equal((await http('POST', '/api/push/subscribe', { cookie: admin, body: { role: 'admin', ...sub } })).status, 200);
  assert.equal((await http('POST', '/api/push/subscribe', { cookie: cust, body: { role: 'admin', ...sub } })).status, 401, 'a customer is not the owner');
  const rows = await app.db.query('SELECT owner_type FROM push_targets WHERE endpoint = $1 ORDER BY owner_type', [sub.endpoint]);
  assert.deepEqual(rows.map((x) => x.owner_type), ['admin', 'customer', 'store']);
});

/* ---------------- colours ---------------- */
test('readable colours: every design keeps brand text, buttons and body text readable', () => {
  assert.ok(ratio('#000000', '#FFFFFF') > 20);
  assert.equal(inkOn('#F2C94C'), '#111827', 'dark text on a light yellow button');
  assert.equal(inkOn('#0B3D91'), '#FFFFFF');
  assert.ok(ratio(readable('#F2C94C', '#FFFFFF'), '#FFFFFF') >= 4.5, 'a light colour is darkened for text');
  for (const [key, d] of Object.entries(DESIGNS)) {
    const v = readableVars({ bg: d.vars.bg, soft: d.vars.soft, brand: d.vars.brand, brandSoft: d.vars.brandSoft, accent: d.vars.accent, accentSoft: d.vars.accentSoft, ink: d.vars.ink, mute: d.vars.mute, brandInk: d.vars.brandInk });
    assert.ok(ratio(v['--brand-text'], d.vars.bg) >= 4.5, `${key}: brand text`);
    assert.ok(ratio(v['--brand-ink'], d.vars.brand) >= 3, `${key}: button text`);
    assert.ok(designCss(key).includes('--brand-text'), key);
  }
  // the owner's own colours: pale text on white is corrected
  const css = themeCss({ colors: { bg: '#FFFFFF', text: '#D1D5DB', gold: '#FDE68A' } });
  const ink = /--ink:(#[0-9A-F]{6})/.exec(css)[1];
  assert.ok(ratio(ink, '#FFFFFF') >= 7);
  assert.ok(ratio(/--brand-text:(#[0-9A-F]{6})/.exec(css)[1], '#FFFFFF') >= 4.5);
});

test('sign-up: durations follow "Prices & durations" — a duration hidden there is refused', async () => {
  await A('PUT', '/api/admin/plans', { store: { delivery: { 12: { hidden: true } } } });
  const r = await http('POST', '/api/cook-applications', { body: { fullName: 'مطعم سنوي', whatsapp: '71 666 001', kind: 'bakery', plan: 'yearly', withDrivers: true, password: 'shop-12345', acceptTerms: true, startedAt: Date.now() - 5000, lat: 33.8466, lng: 35.9031, servedAreaIds: [areaId] } });
  assert.equal(r.data.fields?.plan, 'invalid', JSON.stringify(r.data));
  await A('PUT', '/api/admin/plans', { store: { delivery: { 12: { hidden: false } } } });
});

test('owner overview counts renewals; admin settings show whether road distances are on', async () => {
  const o = (await A('GET', '/api/admin/delivery/overview')).data;
  assert.ok(Number.isInteger(o.renewalsPending));
  const s = (await A('GET', '/api/admin/delivery/settings')).data;
  assert.equal(s.roads.enabled, true);
  assert.ok(s.settings.errandRadiusKm > 0 && s.settings.routeDailyMax > 0);
});
