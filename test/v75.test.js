// v7.5: nearest driver wins, "reserved" then gone, one job at a time, 10 stores at once, exact withdrawals under race,
// confirm-then-pay, store refund, same driver + extra, replace a late driver, order money to the store (AKL…),
// records, branches with +50 %, broadcasts, plans, phone-notification encryption.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createHmac, createDecipheriv, randomBytes } from 'node:crypto';
import { createApp } from '../src/server.js';
import { encryptPayload } from '../src/services/push.js';
import { settleDue, deliverySettings } from '../src/services/delivery.js';

const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';
const DOCS = Object.fromEntries(['selfie', 'idFront', 'idBack', 'vehicleFront', 'vehicleBack', 'registration', 'criminalRecord'].map((k) => [k, JPG]));
let app, base, admin, areaId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, path, { body, cookie } = {}) {
  const res = await fetch(base + path, {
    method, redirect: 'manual',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'X-Requested-With': 'fetch', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const ck = (r) => r.headers.get('set-cookie').split(';')[0];
const A = (m, p, b) => http(m, p, { body: b, cookie: admin });
let phoneN = 0;
const nextPhone = () => `7150${String(1000 + phoneN++).padStart(4, '0')}`;

async function makeDriver(lat, lng, extra = {}) {
  const phone = nextPhone();
  const r = await http('POST', '/api/driver/apply', { body: { fullName: 'سائق ' + phone.slice(-3), phone, password: 'pass123', vehicle: 'moto', plate: 'B 1', walletProvider: 'whish', walletNumber: '71000000', acceptTerms: true, adult: true, birthDate: '1990-01-01', docs: DOCS, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await A('POST', `/api/admin/drivers/${r.data.id}/status`, { status: 'active' });
  const cookie = ck(await http('POST', '/api/driver/login', { body: { phone, password: 'pass123' } }));
  await http('POST', '/api/driver/availability', { body: { available: true, lat, lng }, cookie });
  return { id: r.data.id, cookie, phone };
}
let storeN = 0;
async function makeStore(lat, lng, { topup = 100 } = {}) {
  const wa = `+9617120${String(1000 + storeN++).padStart(4, '0')}`;
  const r = await A('POST', '/api/admin/cooks', { fullName: 'متجر ' + storeN, whatsapp: wa, areaId, services: ['home_cooking'], servedAreaIds: [areaId], kind: 'restaurant', lat, lng, activate: { plan: 'monthly', startDate: new Date(Date.now() - 60_000).toISOString() } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await A('POST', `/api/admin/stores/${r.data.id}/delivery`, { mode: 'delivery' });
  await app.db.query(`INSERT INTO menu_items (cook_id, name, price, currency) VALUES ($1,'منقوشة',2,'USD')`, [r.data.id]);
  const item = (await app.db.one('SELECT id FROM menu_items WHERE cook_id = $1', [r.data.id])).id;
  const pw = (await A('POST', `/api/admin/cooks/${r.data.id}/password`, {})).data.password;
  const cookie = ck(await http('POST', '/api/cook/login', { body: { whatsapp: wa, password: pw } }));
  if (topup) await A('POST', `/api/admin/stores/${r.data.id}/wallet-adjust`, { amount: topup, note: 'test' });
  return { id: r.data.id, cookie, item, pw, wa };
}
let cust;
async function newOrder(st, { fee = 2, search = true } = {}) {
  const o = await http('POST', '/api/orders', { cookie: cust, body: { storeId: st.id, items: [{ id: st.item, qty: 2 }], lat: st.lat ?? 33.9, lng: st.lng ?? 35.51 } });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  await http('POST', `/api/store/orders/${o.data.id}/accept`, { cookie: st.cookie, body: {} });
  if (search) await http('POST', `/api/store/orders/${o.data.id}/search`, { cookie: st.cookie, body: { fee } });
  return o.data.id;
}
const offerFor = async (d, orderId) => (await http('GET', '/api/driver/offers', { cookie: d.cookie })).data.offers.find((x) => x.orderId === orderId);
const setS = (b) => A('PUT', '/api/admin/delivery/settings', b);
// every driver ends free before the next test
async function finish(d, orderId) {
  await http('POST', `/api/driver/orders/${orderId}/delivered`, { cookie: d.cookie, body: {} });
}

before(async () => {
  app = await createApp({
    databaseUrl: 'sqlite::memory:', adminWhatsapp: '96170999999', sessionSecret: 'x'.repeat(40), quiet: true,
    bootstrapAdmin: { username: 'admin', password: 'correct-horse-battery' },
    searchLimit: 1e4, applyLimit: 1e4, loginLimit: 1e4, lookupLimit: 1e4, placesLimit: 1e4, feedbackLimit: 1e4, uploadLimit: 1e4, adminLimit: 1e5,
    placesFetcher: async () => [],
  });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  areaId = (await app.db.one(`SELECT id FROM service_areas WHERE slug = 'zahle'`)).id;
  admin = ck(await http('POST', '/api/admin/login', { body: { username: 'admin', password: 'correct-horse-battery' } }));
  cust = ck(await http('POST', '/api/customer/login', { body: { name: 'زبون', phone: '03999111', acceptTerms: true } }));
});
after(async () => { await app.close(); });

describe('dispatch: nearest wins, reserved, one job at a time', () => {
  test('driver 4 km accepts first, driver 2 km accepts second within the window → the 2 km driver gets it', async () => {
    await setS({ claimWindowSec: 1, reserveShowSec: 2 });
    const st = await makeStore(33.80, 35.50);
    const far = await makeDriver(33.836, 35.50);   // ~4 km
    const near = await makeDriver(33.818, 35.50);  // ~2 km
    const id = await newOrder(st);
    const offFar = await offerFor(far, id), offNear = await offerFor(near, id);
    assert.ok(offFar.toStoreM > offNear.toStoreM, 'distance to the store is shown');
    const a1 = await http('POST', `/api/driver/offers/${offFar.id}/accept`, { cookie: far.cookie, body: {} });
    assert.equal(a1.data.pending, true);
    const a2 = await http('POST', `/api/driver/offers/${offNear.id}/accept`, { cookie: near.cookie, body: {} });
    assert.equal(a2.data.pending, true);
    await sleep(1100);
    const nearCur = await http('GET', '/api/driver/current', { cookie: near.cookie });
    assert.equal(nearCur.data.order.id, id);
    const farOffers = (await http('GET', '/api/driver/offers', { cookie: far.cookie })).data.offers;
    assert.equal(farOffers.find((x) => x.orderId === id).state, 'reserved');   // "reserved" for a moment…
    await sleep(2100);
    assert.equal((await http('GET', '/api/driver/offers', { cookie: far.cookie })).data.offers.some((x) => x.orderId === id), false);   // …then gone
    assert.equal((await http('GET', '/api/driver/current', { cookie: far.cookie })).data.order, null);
    await finish(near, id);
    await http('POST', '/api/driver/availability', { cookie: far.cookie, body: { available: false } });
    await http('POST', '/api/driver/availability', { cookie: near.cookie, body: { available: false } });
  });

  test('a driver can hold only one claim and, once he has an order, sees no new offers until he delivers', async () => {
    await setS({ claimWindowSec: 0 });
    const s1 = await makeStore(34.10, 35.60), s2 = await makeStore(34.101, 35.601);
    const d = await makeDriver(34.1005, 35.6005);
    const o1 = await newOrder(s1), o2 = await newOrder(s2);
    const f1 = await offerFor(d, o1), f2 = await offerFor(d, o2);
    assert.equal((await http('POST', `/api/driver/offers/${f1.id}/accept`, { cookie: d.cookie, body: {} })).data.won, true);
    assert.equal((await http('POST', `/api/driver/offers/${f2.id}/accept`, { cookie: d.cookie, body: {} })).status, 409);
    const view = await http('GET', '/api/driver/offers', { cookie: d.cookie });
    assert.equal(view.data.busy, true);
    assert.equal(view.data.offers.length, 0);
    await finish(d, o1);
    await http('POST', '/api/driver/availability', { cookie: d.cookie, body: { available: false } });
    await http('POST', `/api/store/orders/${o2}/cancel`, { cookie: s2.cookie, body: {} });
  });

  test('10 stores send at the same time to 6 drivers: no driver gets two orders, no order gets two drivers', async () => {
    await setS({ claimWindowSec: 1 });
    const stores = [];
    for (let i = 0; i < 10; i++) stores.push(await makeStore(34.50 + i * 0.001, 35.80));
    const drivers = [];
    for (let i = 0; i < 6; i++) drivers.push(await makeDriver(34.502 + i * 0.0007, 35.801));
    const orders = await Promise.all(stores.map((s) => newOrder(s)));
    // rounds: every free driver taps "accept" on EVERY offer he sees, all at the same moment
    let rounds = 0;
    for (; rounds < 6; rounds++) {
      let tried = 0;
      await Promise.all(drivers.map(async (d) => {
        const offs = (await http('GET', '/api/driver/offers', { cookie: d.cookie })).data.offers.filter((o) => o.state === 'open');
        tried += offs.length;
        await Promise.all(offs.map((o) => http('POST', `/api/driver/offers/${o.id}/accept`, { cookie: d.cookie, body: {} })));
      }));
      await sleep(1100);
      for (const d of drivers) await http('GET', '/api/driver/offers', { cookie: d.cookie });   // settle windows
      if (!tried) break;
    }
    const assigned = await app.db.query(`SELECT id, driver_id FROM orders WHERE id IN (${orders.join(',')}) AND driver_id IS NOT NULL`);
    const perDriver = {};
    for (const o of assigned) perDriver[o.driver_id] = (perDriver[o.driver_id] || 0) + 1;
    assert.equal(assigned.length, 6, `assigned ${assigned.length}`);   // all 6 drivers busy, 4 orders still waiting
    assert.ok(Object.values(perDriver).every((n) => n === 1), JSON.stringify(perDriver));
    const won = await app.db.query(`SELECT order_id, CAST(COUNT(*) AS INTEGER) AS n FROM order_offers WHERE order_id IN (${orders.join(',')}) AND status = 'won' GROUP BY order_id`);
    assert.ok(won.every((w) => w.n === 1));
    for (const o of assigned) await finish(drivers.find((d) => d.id === o.driver_id), o.id);
    for (const d of drivers) await http('POST', '/api/driver/availability', { cookie: d.cookie, body: { available: false } });
    console.log(`# 10 stores at once: ${assigned.length} orders taken by ${Object.keys(perDriver).length} drivers in ${rounds} rounds, ${10 - assigned.length} still searching`);
  });
});

describe('money', () => {
  let st, d;
  before(async () => {
    await setS({ claimWindowSec: 0, payoutThreshold: 5 });
    st = await makeStore(35.00, 35.90, { topup: 100 });
    d = await makeDriver(35.001, 35.901);
  });

  test('withdraw exactly what was typed; 10 taps at the same time cannot take more than the balance', async () => {
    await app.db.query(`INSERT INTO wallet_ledger (account_type, account_id, amount, kind, note) VALUES ('driver', $1, 25, 'adjust', 'test')`, [d.id]);
    const bad = await http('POST', '/api/driver/withdrawals', { cookie: d.cookie, body: { amount: 10.005, provider: 'whish', number: '03111222', password: 'pass123' } });
    assert.equal(bad.status, 422);
    const results = await Promise.all(Array.from({ length: 10 }, () => http('POST', '/api/driver/withdrawals', { cookie: d.cookie, body: { amount: 10, provider: 'whish', number: '03111222', password: 'pass123' } })));
    const okN = results.filter((r) => r.status === 201).length;
    assert.equal(okN, 2);
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 402));
    const rows = await app.db.query(`SELECT amount FROM withdrawals WHERE account_type = 'driver' AND account_id = $1`, [d.id]);
    assert.deepEqual(rows.map((r) => r.amount), [10, 10]);
    assert.equal((await http('GET', '/api/driver/me', { cookie: d.cookie })).data.balance, 5);
  });

  test('store says "not delivered" → dispute: no money moves; the owner decides (complete or reverse)', async () => {
    const id = await newOrder(st);
    const f = await offerFor(d, id);
    await http('POST', `/api/driver/offers/${f.id}/accept`, { cookie: d.cookie, body: {} });
    await http('POST', `/api/driver/orders/${id}/delivered`, { cookie: d.cookie, body: {} });
    const r = await http('POST', `/api/store/orders/${id}/not-delivered`, { cookie: st.cookie, body: { reason: 'لم يصل الطلب' } });
    assert.equal(r.status, 200);
    assert.equal((await http('POST', `/api/store/orders/${id}/not-delivered`, { cookie: st.cookie, body: { reason: 'مرة ثانية' } })).status, 409);
    const c = await http('POST', `/api/customer/orders/${id}/confirm`, { cookie: cust, body: {} });
    assert.equal(c.data.feePaid, false, 'frozen while disputed');
    assert.equal((await http('GET', '/api/driver/finance', { cookie: d.cookie })).data.finance.restaurantCash, 0);
    assert.ok((await A('GET', '/api/admin/finance/disputes')).data.disputes.some((x) => x.id === id));
    assert.equal((await A('POST', `/api/admin/orders/${id}/reverse`, { reason: 'لم يُسلَّم فعلاً' })).status, 200);
    assert.equal((await A('POST', `/api/admin/orders/${id}/reverse`, { reason: 'مرة ثانية' })).status, 409);
    assert.equal((await A('POST', `/api/admin/orders/${id}/complete`, {})).status, 409, 'a reversed order cannot be completed');
    assert.equal((await http('GET', '/api/driver/finance', { cookie: d.cookie })).data.finance.restaurantCash, 0);
  });

  test('not confirmed by the customer → completed automatically after the set time (once)', async () => {
    const id = await newOrder(st);
    const f = await offerFor(d, id);
    await http('POST', `/api/driver/offers/${f.id}/accept`, { cookie: d.cookie, body: {} });
    await http('POST', `/api/driver/orders/${id}/delivered`, { cookie: d.cookie, body: {} });
    const s = await deliverySettings(app.db).get();
    assert.equal((await settleDue(app.db, s)).length, 0);              // too early
    await app.db.query('UPDATE orders SET delivered_at = $1 WHERE id = $2', [new Date(Date.now() - (s.confirmAfterMin + 1) * 60_000).toISOString(), id]);
    assert.equal((await settleDue(app.db, s)).length, 1);
    assert.equal((await settleDue(app.db, s)).length, 0);              // never twice
    assert.equal((await http('GET', '/api/driver/finance', { cookie: d.cookie })).data.finance.restaurantCash, 4, 'the food money (2 × 2 $) is now owed to the store');
  });

  test('records: AKL refs; orders whose cash is not settled stay; CSV; record limit; the driver hides a line', async () => {
    const hist = await http('GET', '/api/driver/history', { cookie: d.cookie });
    const line = hist.data.orders[0];
    assert.match(line.ref, /^AKL\d+$/);
    assert.ok(line.store.lat, 'store place kept');
    const fin = (await http('GET', '/api/store/finance', { cookie: st.cookie })).data.finance;
    assert.equal(fin.outstandingWithDrivers, 4);
    const all = await http('POST', '/api/store/orders/hide-all', { cookie: st.cookie, body: {} });
    assert.ok(all.data.hidden >= 1, 'the reversed order can go');
    const left = (await http('GET', '/api/store/orders?view=history', { cookie: st.cookie })).data.orders;
    assert.ok(left.some((o) => o.id === line.id), 'still owed → stays');
    const csv = await fetch(base + '/api/store/orders.csv', { headers: { Cookie: st.cookie } });
    assert.match(await csv.text(), /ref,status,total/);
    assert.equal((await http('POST', '/api/store/settings', { cookie: st.cookie, body: { recordLimit: 5000 } })).status, 422);   // max 1000
    assert.equal((await http('POST', '/api/store/settings', { cookie: st.cookie, body: { recordLimit: 200 } })).status, 200);
    assert.equal((await http('POST', `/api/driver/history/${line.id}/hide`, { cookie: d.cookie, body: {} })).status, 200);
    assert.equal((await http('GET', '/api/driver/history', { cookie: d.cookie })).data.orders.some((o) => o.id === line.id), false);
  });
});

describe('store tools: same driver + extra, replace a late driver', () => {
  test('same driver takes a second order only if he accepts; refusing frees the store to search', async () => {
    await setS({ claimWindowSec: 0 });
    const st = await makeStore(35.50, 35.95);
    const d = await makeDriver(35.501, 35.951);
    const o1 = await newOrder(st);
    await http('POST', `/api/driver/offers/${(await offerFor(d, o1)).id}/accept`, { cookie: d.cookie, body: {} });
    const o2 = await newOrder(st, { search: false });
    const r = await http('POST', `/api/store/orders/${o2}/same-driver`, { cookie: st.cookie, body: { driverId: d.id, fee: 3 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const add = await offerFor(d, o2);
    assert.equal(add.addon, true);
    assert.equal((await http('POST', `/api/driver/offers/${add.id}/accept`, { cookie: d.cookie, body: {} })).data.won, true);
    const cur = await http('GET', '/api/driver/current', { cookie: d.cookie });
    assert.equal(cur.data.orders.length, 2);
    // another driver, other store: no add-on possible for a driver who isn't on your order
    const other = await makeStore(35.502, 35.952);
    const o3 = await newOrder(other, { search: false });
    assert.equal((await http('POST', `/api/store/orders/${o3}/same-driver`, { cookie: other.cookie, body: { driverId: d.id, fee: 3 } })).status, 409);
    await finish(d, o1); await finish(d, o2);
    await http('POST', '/api/driver/availability', { cookie: d.cookie, body: { available: false } });
  });

  test('replace the driver before pick-up: back to searching, he is not offered it again, a complaint is recorded', async () => {
    const st = await makeStore(36.00, 36.00);
    const d1 = await makeDriver(36.001, 36.001), d2 = await makeDriver(36.002, 36.002);
    const id = await newOrder(st);
    await http('POST', `/api/driver/offers/${(await offerFor(d1, id)).id}/accept`, { cookie: d1.cookie, body: {} });
    const r = await http('POST', `/api/store/orders/${id}/replace-driver`, { cookie: st.cookie, body: { reason: 'ليس معه حقيبة توصيل' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(await offerFor(d1, id), undefined);
    assert.ok(await offerFor(d2, id));
    const c = await A('GET', '/api/admin/complaints');
    assert.ok(c.data.complaints.some((x) => x.against_id === d1.id && /حقيبة/.test(x.text)));
    for (const d of [d1, d2]) await http('POST', '/api/driver/availability', { cookie: d.cookie, body: { available: false } });
  });
});

describe('sign-up, plans, branches, messages, notifications', () => {
  test('driver under 18 or without the 18+ box is refused; optional customer-requests plan is recorded', async () => {
    const young = new Date(); young.setUTCFullYear(young.getUTCFullYear() - 16);
    const base1 = { fullName: 'شاب صغير', phone: '71666001', password: 'pass123', vehicle: 'moto', plate: 'B 2', walletProvider: 'whish', walletNumber: '71000000', acceptTerms: true, docs: DOCS };
    assert.equal((await http('POST', '/api/driver/apply', { body: { ...base1, adult: true, birthDate: young.toISOString().slice(0, 10) } })).status, 422);
    assert.equal((await http('POST', '/api/driver/apply', { body: { ...base1, birthDate: '1990-01-01' } })).status, 422);
    const ok = await http('POST', '/api/driver/apply', { body: { ...base1, adult: true, birthDate: '1990-01-01', jobsMonths: 3 } });
    assert.equal(ok.status, 201);
    const d = await A('GET', `/api/admin/drivers/${ok.data.id}`);
    assert.equal(d.data.driver.jobs_request_months, 3);
    assert.equal(d.data.driver.status, 'pending');                    // the team still checks the papers
  });

  test('prices from the panel: hidden durations disappear; branches add 50 % each (10 + 5 + 5 = 20)', async () => {
    const p = await A('PUT', '/api/admin/plans', { store: { basic: { 1: { price: 10 }, 12: { hidden: true } } }, branchPercent: 50 });
    assert.equal(p.status, 200);
    const pub = await http('GET', '/api/plans');
    assert.equal(pub.data.store.basic['1'], 10);
    assert.equal('12' in pub.data.store.basic, false);
    const st = await makeStore(36.50, 36.50, { topup: 0 });
    await A('POST', `/api/admin/stores/${st.id}/delivery`, { mode: 'none' });
    const b1 = await http('POST', '/api/store/branches', { cookie: st.cookie, body: { name: 'فرع الحمرا', lat: 36.51, lng: 36.51 } });
    const b2 = await http('POST', '/api/store/branches', { cookie: st.cookie, body: { name: 'فرع فردان', lat: 36.52, lng: 36.52 } });
    assert.equal(b1.status, 201);
    const set = await http('GET', '/api/store/settings', { cookie: st.cookie });
    assert.equal(set.data.branches.length, 3);
    assert.equal(set.data.price, 20);
    // pending until the team approves; then visible with the main subscription
    assert.equal((await http('GET', `/api/delivery/stores/${b1.data.id}`)).status, 404);
    await A('POST', `/api/admin/stores/${b1.data.id}/branch-status`, { status: 'approved' });
    assert.equal((await http('GET', `/api/delivery/stores/${b1.data.id}`)).status, 200);
    // switch into the branch: its own menu and orders
    const sw = await http('POST', `/api/store/branches/${b1.data.id}/switch`, { cookie: st.cookie, body: {} });
    const bc = ck(sw);
    assert.equal((await http('GET', '/api/cook/me', { cookie: bc })).data.id, b1.data.id);
    assert.equal((await http('POST', `/api/store/branches/${b2.data.id}/switch`, { cookie: bc, body: {} })).status, 200);
    const stranger = await makeStore(36.6, 36.6, { topup: 0 });
    assert.equal((await http('POST', `/api/store/branches/${b1.data.id}/switch`, { cookie: stranger.cookie, body: {} })).status, 404);
  });

  test('messages to drivers / stores show only to them, until their end or deletion', async () => {
    const d = await makeDriver(37, 37);
    const st = await makeStore(37.1, 37.1, { topup: 0 });
    const m1 = await A('POST', '/api/admin/broadcasts', { audience: 'drivers', body: 'قانون جديد: الخوذة إلزامية', days: 7 });
    await A('POST', '/api/admin/broadcasts', { audience: 'stores', body: 'رسالة للمتاجر' });
    assert.equal((await http('GET', '/api/driver/broadcasts', { cookie: d.cookie })).data.broadcasts[0].body, 'قانون جديد: الخوذة إلزامية');
    const sset = await http('GET', '/api/store/settings', { cookie: st.cookie });
    assert.ok(sset.data.broadcasts.every((b) => b.body !== 'قانون جديد: الخوذة إلزامية'));
    await A('DELETE', `/api/admin/broadcasts/${m1.data.id}`);
    assert.equal((await http('GET', '/api/driver/broadcasts', { cookie: d.cookie })).data.broadcasts.length, 0);
  });

  test('phone notifications are encrypted so only that phone can read them', async () => {
    const ua = createECDH('prime256v1'); ua.generateKeys();
    const auth = randomBytes(16);
    const sub = { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
    const body = encryptPayload(sub, JSON.stringify({ body: 'طلب جديد AKL7' }));
    const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
    const h = (k, d) => createHmac('sha256', k).update(d).digest();
    const ikm = h(h(auth, ua.computeSecret(asPub)), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub, Buffer.from([1])]));
    const prk = h(salt, ikm);
    const cek = h(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
    const nonce = h(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
    const dec = createDecipheriv('aes-128-gcm', cek, nonce);
    dec.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]);
    assert.equal(plain[plain.length - 1], 2);
    assert.equal(JSON.parse(plain.subarray(0, -1).toString()).body, 'طلب جديد AKL7');
    const key = await http('GET', '/api/push/key');
    assert.match(key.data.key, /^[A-Za-z0-9_-]{80,90}$/);
    assert.equal((await http('POST', '/api/push/subscribe', { body: { role: 'driver', endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: sub } })).status, 401);
  });
});

describe('admin: designs, whole country / category delete, cleanup only on demand', () => {
  test('ready designs change /theme.css; unknown design refused', async () => {
    const d = await A('GET', '/api/admin/designs');
    assert.ok(d.data.designs.length >= 6);
    assert.equal((await A('PUT', '/api/admin/designs', { key: 'midnight' })).status, 200);
    assert.match(await (await fetch(base + '/theme.css')).text(), /design: midnight/);
    assert.equal((await A('PUT', '/api/admin/designs', { key: 'hack;}' })).status, 422);
    assert.equal((await http('PUT', '/api/admin/designs', { body: { key: 'glass' } })).status, 401);
  });

  test('a deleted country disappears with its shops; a hidden one shows nothing', async () => {
    const r = await A('POST', '/api/admin/cooks', { fullName: 'Café Lyon', whatsapp: '+33611110000', areaId, services: ['home_cooking'], servedAreaIds: [areaId], kind: 'restaurant', lat: 38, lng: 38, activate: { plan: 'monthly', startDate: new Date(Date.now() - 60_000).toISOString() } });
    await app.db.query(`UPDATE cooks SET country = 'FR' WHERE id = $1`, [r.data.id]);
    assert.equal((await http('GET', '/api/delivery/stores?lat=38&lng=38&country=FR')).data.stores.length, 1);
    const del = await A('DELETE', '/api/admin/countries/FR?people=1');
    assert.equal(del.data.stores, 1);
    assert.equal((await http('GET', '/api/delivery/stores?lat=38&lng=38&country=FR')).data.stores.length, 0);
    const cfg = await http('GET', '/api/config');
    assert.equal(cfg.data.countries.includes('FR'), false);
    await A('POST', '/api/admin/countries/FR/restore', {});
    assert.equal((await http('GET', '/api/config')).data.countries.includes('FR'), true);
  });

  test('delete a category with all its shops', async () => {
    const st = await makeStore(39, 39, { topup: 0 });
    await app.db.query(`UPDATE cooks SET kind = 'florist' WHERE id = $1`, [st.id]);
    const r = await A('DELETE', '/api/admin/categories/florist?shops=1');
    assert.equal(r.data.stores, 1);
    assert.equal((await http('GET', `/api/delivery/stores/${st.id}`)).status, 404);
  });

  test('cleanup removes finished items but keeps money still owed', async () => {
    const before = await app.db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM orders WHERE status = 'delivered' AND driver_id IS NOT NULL AND self_delivery = 0 AND store_paid = 0`);
    const r = await A('POST', '/api/admin/delivery/cleanup', { all: true });
    assert.equal(r.status, 200);
    const after = await app.db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM orders WHERE status = 'delivered' AND driver_id IS NOT NULL AND self_delivery = 0 AND store_paid = 0`);
    assert.equal(after.n, before.n);
  });
});

describe('security', () => {
  test('phone notifications only go to real push services (no requests to other addresses)', async () => {
    const d = await makeDriver(40, 40);
    const keys = { p256dh: 'BOr' + 'a'.repeat(84), auth: 'abcdefghijklmnopqrstuv' };
    assert.equal((await http('POST', '/api/push/subscribe', { cookie: d.cookie, body: { role: 'driver', endpoint: 'https://169.254.169.254/latest/meta-data/xx', keys } })).status, 422);
    assert.equal((await http('POST', '/api/push/subscribe', { cookie: d.cookie, body: { role: 'driver', endpoint: 'https://evil.example.com/push/abcdef', keys } })).status, 422);
    assert.equal((await http('POST', '/api/push/subscribe', { cookie: d.cookie, body: { role: 'driver', endpoint: 'https://fcm.googleapis.com/fcm/send/abcdef123', keys } })).status, 200);
    assert.equal((await http('POST', '/api/push/subscribe', { cookie: d.cookie, body: { role: 'store', endpoint: 'https://fcm.googleapis.com/fcm/send/abcdef124', keys } })).status, 401);   // not a store
  });

  test('every money/admin action refuses requests without the app header (forged from another site)', async () => {
    for (const [m, p] of [['POST', '/api/driver/withdrawals'], ['POST', '/api/store/orders/1/paid'], ['DELETE', '/api/admin/countries/LB'], ['PUT', '/api/admin/plans'], ['POST', '/api/admin/broadcasts']]) {
      const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', Cookie: admin }, body: '{}' });
      assert.ok([401, 403].includes(r.status), `${m} ${p} → ${r.status}`);
    }
  });

  test('one account cannot touch another one\'s orders', async () => {
    const a = await makeStore(41, 41), b2 = await makeStore(41.01, 41.01);
    const id = await newOrder(a, { search: false });
    for (const p of ['accept', 'paid', 'hide', 'redispatch', 'cancel']) assert.equal((await http('POST', `/api/store/orders/${id}/${p}`, { cookie: b2.cookie, body: {} })).status, 404, p);
    assert.equal((await http('POST', `/api/store/orders/${id}/replace-driver`, { cookie: b2.cookie, body: { reason: 'تجربة' } })).status, 404);
  });
});

describe('backup carries everything (move to another provider without losing anything)', () => {
  test('export → fresh database → import: same rows, same balances, papers and chats included', async () => {
    const { exportAll, importAll } = await import('../src/lib/portability.js');
    const { openDb, migrate } = await import('../src/db/index.js');
    const { balance } = await import('../src/services/delivery.js');
    const dir = `/tmp/aklatak-export-${Date.now()}`;
    const m = await exportAll(app.db, dir);
    for (const t of ['customers', 'drivers', 'driver_documents', 'orders', 'order_offers', 'wallet_ledger', 'withdrawals', 'errands', 'errand_messages', 'broadcasts', 'warnings', 'complaints']) assert.ok(m.tables.includes(t), t);
    assert.ok(!m.tables.includes('customer_sessions') && !m.tables.includes('driver_sessions') && !m.tables.includes('otp_codes'));
    const db2 = await openDb({ databaseUrl: 'sqlite::memory:' });
    await migrate(db2);
    const r = await importAll(db2, dir);
    for (const t of Object.keys(r.expected)) assert.equal(r.inserted[t], r.expected[t], t);
    const stores = await app.db.query('SELECT id FROM cooks');
    for (const s of stores) assert.equal(await balance(db2, 'store', s.id), await balance(app.db, 'store', s.id));
    const drivers = await app.db.query('SELECT id FROM drivers');
    for (const d of drivers) assert.equal(await balance(db2, 'driver', d.id), await balance(app.db, 'driver', d.id));
    await db2.close();
  });

  test('daily automatic copy goes to a PRIVATE bucket with a signed upload, only when its keys are set', async () => {
    const { backupTarget, runOffsiteBackup } = await import('../src/jobs.js');
    assert.equal(backupTarget({}), null);
    const target = backupTarget({ BACKUP_S3_ENDPOINT: 'https://acc.r2.cloudflarestorage.com', BACKUP_S3_BUCKET: 'aklatak-backups', BACKUP_S3_ACCESS_KEY_ID: 'k', BACKUP_S3_SECRET_ACCESS_KEY: 's' });
    let put;
    const r = await runOffsiteBackup({ db: app.db, target, fetchImpl: async (url, opt) => { put = { url, opt }; return { ok: true }; } });
    assert.match(put.url, /^https:\/\/acc\.r2\.cloudflarestorage\.com\/aklatak-backups\/backups\/aklatak-data-\d{4}-\d{2}-\d{2}\.zip$/);
    assert.match(put.opt.headers.Authorization, /^AWS4-HMAC-SHA256/);
    assert.ok(r.bytes > 1000 && r.rows > 10);
  });

  test('balance sheet (Excel) for the owner only', async () => {
    const r = await fetch(base + '/api/admin/delivery/balances.csv', { headers: { Cookie: admin } });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /type,id,name,phone,country,balance/);
    assert.equal((await fetch(base + '/api/admin/delivery/balances.csv')).status, 401);
  });
});
