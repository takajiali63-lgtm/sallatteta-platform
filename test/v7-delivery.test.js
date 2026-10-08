// v7 delivery system: customer order → store fee from balance → nearest drivers → first accept wins →
// store forwards the location → delivered → driver balance → automatic payout at 20$ → complaints & 3 warnings.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';
let app, base, admin;
const smsSent = [];

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

let areaId, storeId, storeCookie, storePw, menu;
const STORE = { lat: 33.8938, lng: 35.5018 };

async function makeDriver(phone, lat, lng) {
  const docs = Object.fromEntries(['selfie', 'idFront', 'idBack', 'vehicleFront', 'vehicleBack', 'registration', 'criminalRecord'].map((k) => [k, JPG]));
  const r = await http('POST', '/api/driver/apply', { body: { fullName: 'سائق ' + phone.slice(-2), phone, password: 'pass123', vehicle: 'moto', plate: 'B 1234', walletProvider: 'whish', walletNumber: '71000000', acceptTerms: true, adult: true, birthDate: '1995-04-02', docs } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await A('POST', `/api/admin/drivers/${r.data.id}/status`, { status: 'active' })).status, 200);
  const l = await http('POST', '/api/driver/login', { body: { phone, password: 'pass123' } });
  const cookie = ck(l);
  assert.equal((await http('POST', '/api/driver/availability', { body: { available: true, lat, lng }, cookie })).status, 200);
  return { id: r.data.id, cookie };
}

before(async () => {
  app = await createApp({
    databaseUrl: 'sqlite::memory:', adminWhatsapp: '96170999999', sessionSecret: 'x'.repeat(40), quiet: true,
    bootstrapAdmin: { username: 'admin', password: 'correct-horse-battery' },
    searchLimit: 1e4, applyLimit: 1e4, loginLimit: 1e4, lookupLimit: 1e4, placesLimit: 1e4, feedbackLimit: 1e4, uploadLimit: 1e4,
    placesFetcher: async () => [],
  });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  areaId = (await app.db.one(`SELECT id FROM service_areas WHERE slug = 'zahle'`)).id;
  admin = ck(await http('POST', '/api/admin/login', { body: { username: 'admin', password: 'correct-horse-battery' } }));
  const s = await A('POST', '/api/admin/cooks', {
    fullName: 'مطعم الضيعة', whatsapp: '+96171100001', areaId, services: ['home_cooking'], servedAreaIds: [areaId], ...STORE,
    activate: { plan: 'monthly', startDate: new Date(Date.now() - 60_000).toISOString() },
  });
  assert.equal(s.status, 201, JSON.stringify(s.data));
  storeId = s.data.id;
  await app.db.query(`INSERT INTO menu_items (cook_id, name, price, currency) VALUES ($1,'شاورما',4,'USD'), ($1,'بطاطا',2,'USD')`, [storeId]);
  menu = await app.db.query('SELECT id, name FROM menu_items WHERE cook_id = $1 ORDER BY id', [storeId]);
  const pw = await A('POST', `/api/admin/cooks/${storeId}/password`, {});
  storePw = pw.data.password;
  storeCookie = ck(await http('POST', '/api/cook/login', { body: { whatsapp: '+96171100001', password: pw.data.password } }));
  await A('PUT', '/api/admin/delivery/settings', { claimWindowSec: 0 });   // older tests: first to accept wins; nearest-wins has its own tests
});
after(async () => { await app.close(); });

describe('delivery flow', () => {
  let cust, orderId, near, far;

  test('customer signs in with name + phone only (no SMS key yet) and stays signed in', async () => {
    const c = await http('POST', '/api/customer/code', { body: { phone: '03123456' } });
    assert.equal(c.data.codeRequired, false);
    const noTerms = await http('POST', '/api/customer/login', { body: { name: 'محمد', phone: '03123456' } });
    assert.equal(noTerms.status, 422);
    const l = await http('POST', '/api/customer/login', { body: { name: 'محمد', phone: '03123456', acceptTerms: true } });
    assert.equal(l.status, 200);
    assert.match(l.headers.get('set-cookie'), /Max-Age=31536000/);
    cust = ck(l);
    const me = await http('GET', '/api/customer/me', { cookie: cust });
    assert.equal(me.data.name, 'محمد');
  });

  test('a WhatsApp-only store cannot receive in-app orders; a delivery store can', async () => {
    const no = await http('POST', '/api/orders', { cookie: cust, body: { storeId, items: [{ id: menu[0].id, qty: 1 }], lat: 33.90, lng: 35.51 } });
    assert.equal(no.status, 409);
    assert.equal((await A('POST', `/api/admin/stores/${storeId}/delivery`, { mode: 'delivery' })).status, 200);
    const r = await http('POST', '/api/orders', { cookie: cust, body: { storeId, items: [{ id: menu[0].id, qty: 2 }, { id: menu[1].id, qty: 1 }], lat: 33.9100, lng: 35.5100 } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.total, 10);           // prices come from the server, not the phone
    orderId = r.data.id;
  });

  test('store search finds it by product name; nearest first', async () => {
    const r = await http('GET', `/api/delivery/stores?q=${encodeURIComponent('شاورما')}&lat=33.90&lng=35.51`);
    assert.equal(r.data.stores[0].id, storeId);
    assert.equal(r.data.stores[0].delivery, true);
  });

  test('v7.6: the customer pays food + the store\'s delivery fee; calling a driver needs no top-up', async () => {
    const o = (await http('GET', `/api/customer/orders/${orderId}`, { cookie: cust })).data.order;
    assert.deepEqual([o.foodAmount, o.deliveryFee, o.customerTotal, o.paymentMethod], [10, 2, 12, 'cash']);
    assert.equal((await http('POST', `/api/store/orders/${orderId}/accept`, { cookie: storeCookie, body: {} })).status, 200);
    const w = await http('GET', '/api/store/wallet', { cookie: storeCookie });
    assert.equal(w.data.balance, 0, 'nothing in the store\'s account and it can still call a driver');
  });

  test('order goes to the nearest available drivers; offer shows distances, fee and cash to collect — never the customer location', async () => {
    near = await makeDriver('71200001', 33.8950, 35.5020);
    far = await makeDriver('71200002', 33.8990, 35.5060);
    await makeDriver('71200003', 34.4367, 35.8497);          // Tripoli: too far, must not get it
    const r = await http('POST', `/api/store/orders/${orderId}/search`, { cookie: storeCookie, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.driversNotified, 2);
    assert.equal(r.data.balance, 0, 'no fee held from the store');
    const offers = await http('GET', '/api/driver/offers', { cookie: near.cookie });
    assert.equal(offers.data.offers.length, 1);
    const o = offers.data.offers[0];
    assert.equal(o.fee, 2);
    assert.equal(o.collect, 12, 'cash to collect from the customer');
    assert.ok(o.toStoreM > 0 && o.storeToCustomerM > 0);
    assert.equal(JSON.stringify(o).includes('33.91'), false);
    near.offer = o.id;
    far.offer = (await http('GET', '/api/driver/offers', { cookie: far.cookie })).data.offers[0].id;
  });

  test('the store can add a bonus for the driver (paid by the store in cash at pick-up); nothing is held', async () => {
    const r = await http('POST', `/api/store/orders/${orderId}/raise`, { cookie: storeCookie, body: { bonus: 1 } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.balance, 0);
    const off = (await http('GET', '/api/driver/offers', { cookie: near.cookie })).data.offers[0];
    assert.equal(off.fee, 3); assert.equal(off.bonus, 1);
    near.offer = off.id;
    far.offer = (await http('GET', '/api/driver/offers', { cookie: far.cookie })).data.offers[0].id;
  });

  test('first driver to accept wins; the other gets "offer_gone"', async () => {
    const a = await http('POST', `/api/driver/offers/${near.offer}/accept`, { cookie: near.cookie, body: {} });
    assert.equal(a.status, 200, JSON.stringify(a.data));
    const b = await http('POST', `/api/driver/offers/${far.offer}/accept`, { cookie: far.cookie, body: {} });
    assert.equal(b.status, 409);
  });

  test('the driver sees the customer only after the store sends the location', async () => {
    let cur = await http('GET', '/api/driver/current', { cookie: near.cookie });
    assert.equal(cur.data.order.customer, null);
    assert.equal(cur.data.order.collect, 12);
    assert.equal((await http('POST', `/api/store/orders/${orderId}/send-location`, { cookie: storeCookie, body: {} })).status, 200);
    cur = await http('GET', '/api/driver/current', { cookie: near.cookie });
    assert.equal(cur.data.order.customer.lat, 33.91);
    const track = await http('GET', `/api/customer/orders/${orderId}`, { cookie: cust });
    assert.equal(track.data.order.status, 'assigned');
    assert.equal(track.data.order.driver.vehicle, 'moto');
    // the store sees where the customer is (live) for its own delivery or to guide the driver
    const sv = (await http('GET', '/api/store/orders', { cookie: storeCookie })).data.orders.find((x) => x.id === orderId);
    assert.equal(sv.customer.lat, 33.91);
  });

  test('delivered → the customer confirms → COMPLETED: food = restaurant cash with the driver, fee = driver\'s earning (in his pocket)', async () => {
    assert.equal((await http('POST', `/api/driver/orders/${orderId}/picked`, { cookie: near.cookie, body: {} })).status, 200);
    const d = await http('POST', `/api/driver/orders/${orderId}/delivered`, { cookie: near.cookie, body: {} });
    assert.equal(d.data.balance, 0);
    assert.equal((await http('GET', '/api/driver/current', { cookie: near.cookie })).data.order, null);   // places gone from the driver
    const t = await http('GET', `/api/customer/orders/${orderId}`, { cookie: cust });
    assert.equal(t.data.order.awaitingConfirm, true);
    const c = await http('POST', `/api/customer/orders/${orderId}/confirm`, { cookie: cust, body: {} });
    assert.equal(c.data.feePaid, true);
    assert.equal((await http('POST', `/api/customer/orders/${orderId}/confirm`, { cookie: cust, body: {} })).data.feePaid, false);   // never twice
    const f = (await http('GET', '/api/driver/finance', { cookie: near.cookie })).data.finance;
    assert.deepEqual([f.earnings, f.restaurantCash, f.withdrawable], [3, 10, 0]);
    assert.equal((await http('GET', '/api/customer/orders', { cookie: cust })).data.orders.some((o) => o.id === orderId), false);   // leaves his list
    const rep = await http('GET', '/api/store/report?period=today', { cookie: storeCookie });
    assert.equal(rep.data.report.delivered, 1);
    assert.equal(rep.data.report.sales, 10);
    assert.equal(rep.data.report.topItems[0].name, 'شاورما');
    const drep = await http('GET', '/api/driver/report?period=today', { cookie: near.cookie });
    assert.equal(drep.data.report.deliveries, 1);
    assert.equal(drep.data.report.earnings, 3);
    const sf = (await http('GET', '/api/store/finance', { cookie: storeCookie })).data.finance;
    assert.equal(sf.outstandingWithDrivers, 10);
    assert.equal(sf.drivers[0].owes, 10);
  });

  test('withdrawals: from the driver\'s own account (card fees …), with his password, minimum 20$; nothing opens automatically', async () => {
    for (let i = 0; i < 6; i++) {
      const r = await http('POST', '/api/orders', { cookie: cust, body: { storeId, items: [{ id: menu[1].id, qty: 1 }], lat: 33.91, lng: 35.51 } });
      await http('POST', `/api/store/orders/${r.data.id}/accept`, { cookie: storeCookie, body: {} });
      await http('POST', `/api/store/orders/${r.data.id}/search`, { cookie: storeCookie, body: {} });
      const off = (await http('GET', '/api/driver/offers', { cookie: near.cookie })).data.offers.find((o) => o.orderId === r.data.id);
      await http('POST', `/api/driver/offers/${off.id}/accept`, { cookie: near.cookie, body: {} });
      await http('POST', `/api/driver/orders/${r.data.id}/delivered`, { cookie: near.cookie, body: {} });
      await http('POST', `/api/customer/orders/${r.data.id}/confirm`, { cookie: cust, body: {} });
    }
    assert.equal((await http('GET', '/api/driver/finance', { cookie: near.cookie })).data.finance.restaurantCash, 22, '10 + 6 × 2');
    await app.db.query(`INSERT INTO wallet_ledger (account_type, account_id, amount, kind, note) VALUES ('driver', $1, 21, 'earning', 'card fees')`, [near.id]);
    assert.equal((await A('GET', '/api/admin/withdrawals')).data.withdrawals.length, 0);   // no automatic payout
    const info = await http('GET', '/api/driver/withdrawals', { cookie: near.cookie });
    assert.equal(info.data.balance, 21);
    assert.equal(info.data.minimum, 20);
    const small = await http('POST', '/api/driver/withdrawals', { cookie: near.cookie, body: { amount: 5, provider: 'whish', number: '03777666', password: 'pass123' } });
    assert.equal(small.data.error, 'below_minimum');
    const badPw = await http('POST', '/api/driver/withdrawals', { cookie: near.cookie, body: { amount: 21, provider: 'whish', number: '03777666', password: 'nope' } });
    assert.equal(badPw.data.error, 'wrong_password');
    const tooMuch = await http('POST', '/api/driver/withdrawals', { cookie: near.cookie, body: { amount: 50, provider: 'whish', number: '03777666', password: 'pass123' } });
    assert.equal(tooMuch.status, 402);
    const w = await http('POST', '/api/driver/withdrawals', { cookie: near.cookie, body: { amount: 21, provider: 'omt', number: '03777666', password: 'pass123' } });
    assert.equal(w.status, 201, JSON.stringify(w.data));
    assert.equal(w.data.balance, 0);
    const again = await http('POST', '/api/driver/withdrawals', { cookie: near.cookie, body: { amount: 21, provider: 'omt', number: '03777666', password: 'pass123' } });
    assert.equal(again.status, 402);
    const list = await A('GET', '/api/admin/withdrawals');
    assert.equal(list.data.withdrawals[0].number, '9613777666');
    assert.equal(list.data.withdrawals[0].provider, 'omt');
    assert.equal((await A('POST', `/api/admin/withdrawals/${list.data.withdrawals[0].id}/paid`, {})).status, 200);
    const mine = await http('GET', '/api/driver/withdrawals', { cookie: near.cookie });
    assert.equal(mine.data.withdrawals[0].status, 'paid');
    assert.ok(mine.data.ledger.some((l) => l.kind === 'earning') && mine.data.ledger.some((l) => l.kind === 'payout'));
  });

  test('the driver settles the restaurant cash; after the owner verifies, the store withdraws it; a refused withdrawal gives it back', async () => {
    const s = await http('POST', '/api/driver/settlements', { cookie: near.cookie, body: { amount: 22, method: 'whish', reference: 'WH-1001' } });
    assert.equal(s.status, 201, JSON.stringify(s.data));
    assert.equal((await A('POST', `/api/admin/settlements/${s.data.id}/verify`, {})).status, 200);
    const before = (await http('GET', '/api/store/withdrawals', { cookie: storeCookie })).data.balance;
    assert.equal(before, 22);
    const w = await http('POST', '/api/store/withdrawals', { cookie: storeCookie, body: { amount: 5, provider: 'whish', number: '76123456', password: storePw } });
    assert.equal(w.status, 201, JSON.stringify(w.data));
    assert.equal(w.data.balance, Math.round((before - 5) * 100) / 100);
    const list = await A('GET', `/api/admin/withdrawals?type=store&id=${storeId}`);
    await A('POST', `/api/admin/withdrawals/${list.data.withdrawals[0].id}/reject`, {});
    assert.equal((await http('GET', '/api/store/withdrawals', { cookie: storeCookie })).data.balance, before);
    const log = await A('GET', `/api/admin/ledger?type=store&id=${storeId}`);
    assert.ok(log.data.withdrawals[0].status === 'rejected' && log.data.ledger.length >= 3);
  });

  test('complaint → warnings; the 3rd warning suspends the driver automatically', async () => {
    const c = await http('POST', '/api/complaints', { cookie: cust, body: { orderId, against: 'driver', text: 'تأخر كثيراً في التوصيل' } });
    assert.equal(c.status, 201);
    const notParty = await http('POST', '/api/complaints', { cookie: far.cookie, body: { orderId, against: 'store', text: 'لست طرفاً في هذا الطلب' } });
    assert.equal(notParty.status, 403);
    const list = await A('GET', '/api/admin/complaints');
    const w1 = await A('POST', `/api/admin/complaints/${list.data.complaints[0].id}/warn`, { reason: 'تأخير' });
    assert.deepEqual([w1.data.count, w1.data.suspended], [1, false]);
    await A('POST', '/api/admin/warnings', { type: 'driver', id: near.id, reason: 'بلا خوذة' });
    const w3 = await A('POST', '/api/admin/warnings', { type: 'driver', id: near.id, reason: 'قيادة متهورة' });
    assert.deepEqual([w3.data.count, w3.data.suspended], [3, true]);
    const blocked = await http('POST', '/api/driver/location', { cookie: near.cookie, body: { lat: 33.9, lng: 35.5 } });
    assert.equal(blocked.status, 403);
    const me = await http('GET', '/api/driver/me', { cookie: near.cookie });
    assert.equal(me.data.warnings.count, 3);
    assert.equal((await A('POST', `/api/admin/accounts/driver/${near.id}/activate`, {})).status, 200);
  });

  test('suspended store is hidden and cannot take orders until re-activated', async () => {
    await A('POST', `/api/admin/accounts/store/${storeId}/suspend`, {});
    const s = await http('GET', '/api/delivery/stores?lat=33.90&lng=35.51');
    assert.equal(s.data.stores.some((x) => x.id === storeId), false);
    const o = await http('POST', '/api/orders', { cookie: cust, body: { storeId, items: [{ id: menu[0].id, qty: 1 }], lat: 33.91, lng: 35.51 } });
    assert.equal(o.status, 404);
    await A('POST', `/api/admin/accounts/store/${storeId}/activate`, {});
  });

  test('driver papers are private: admin only', async () => {
    const d = await A('GET', `/api/admin/drivers/${near.id}`);
    assert.equal(d.data.documents.length, 7);
    const docUrl = `/api/admin/drivers/${near.id}/documents/${d.data.documents[0].id}`;
    assert.equal((await http('GET', docUrl)).status, 401);
    assert.equal((await http('GET', docUrl, { cookie: near.cookie })).status, 401);
    const ok = await fetch(base + docUrl, { headers: { Cookie: admin } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('cache-control'), /no-store/);
  });

  test('customer can delete his account (Google Play rule)', async () => {
    const r = await http('POST', '/api/customer/me/delete', { cookie: cust, body: {} });
    assert.equal(r.status, 200);
    assert.equal((await http('GET', '/api/customer/me', { cookie: cust })).status, 401);
  });
});

describe('own delivery, appointments, "come to me"', () => {
  let cust2, selfStore, selfCookie, clinic, clinicCookie, electrician, elCookie;
  async function sub(name, phone, kind, extra = {}) {
    const r = await A('POST', '/api/admin/cooks', {
      fullName: name, whatsapp: phone, areaId, services: ['home_cooking'], servedAreaIds: [areaId], kind, ...STORE, ...extra,
      activate: { plan: 'monthly', startDate: new Date(Date.now() - 60_000).toISOString() },
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const pw = await A('POST', `/api/admin/cooks/${r.data.id}/password`, {});
    return { id: r.data.id, cookie: ck(await http('POST', '/api/cook/login', { body: { whatsapp: phone, password: pw.data.password } })) };
  }
  before(async () => {
    cust2 = ck(await http('POST', '/api/customer/login', { body: { name: 'ريم', phone: '03555444', acceptTerms: true } }));
    ({ id: selfStore, cookie: selfCookie } = await sub('فرن الحي', '+96171100011', 'cook'));
    ({ id: clinic, cookie: clinicCookie } = await sub('صالون ليلى', '+96171100012', 'cook'));
    ({ id: electrician, cookie: elCookie } = await sub('أبو أحمد', '+96171100013', 'electrician'));
    await app.db.query(`INSERT INTO menu_items (cook_id, name, price, currency) VALUES ($1,'منقوشة',1.5,'USD')`, [selfStore]);
  });

  test('a store with its own delivery accepts and delivers without a driver or a fee', async () => {
    await A('POST', `/api/admin/stores/${selfStore}/delivery`, { mode: 'self' });
    const item = (await app.db.one('SELECT id FROM menu_items WHERE cook_id = $1', [selfStore])).id;
    const o = await http('POST', '/api/orders', { cookie: cust2, body: { storeId: selfStore, items: [{ id: item, qty: 4 }], lat: 33.90, lng: 35.51 } });
    assert.equal(o.status, 201);
    await http('POST', `/api/store/orders/${o.data.id}/accept`, { cookie: selfCookie, body: {} });
    const noDrivers = await http('POST', `/api/store/orders/${o.data.id}/search`, { cookie: selfCookie, body: { fee: 2 } });
    assert.equal(noDrivers.data.error, 'drivers_not_in_plan');
    assert.equal((await http('POST', `/api/store/orders/${o.data.id}/self-dispatch`, { cookie: selfCookie, body: {} })).status, 200);
    let t = await http('GET', `/api/customer/orders/${o.data.id}`, { cookie: cust2 });
    assert.equal(t.data.order.status, 'picked_up');
    assert.equal(t.data.order.selfDelivery, true);
    assert.equal((await http('POST', `/api/store/orders/${o.data.id}/self-delivered`, { cookie: selfCookie, body: {} })).status, 200);
    t = await http('GET', `/api/customer/orders/${o.data.id}`, { cookie: cust2 });
    assert.equal(t.data.order.status, 'delivered');
    assert.equal((await http('GET', '/api/store/wallet', { cookie: selfCookie })).data.balance, 0);
  });

  test('appointments only when the booking option is on; the subscriber confirms them', async () => {
    const when = new Date(Date.now() + 2 * 864e5).toISOString();
    const off = await http('POST', '/api/appointments', { cookie: cust2, body: { storeId: clinic, service: 'قص شعر', startsAt: when } });
    assert.equal(off.data.error, 'booking_not_in_plan');
    await A('POST', `/api/admin/stores/${clinic}/delivery`, { booking: true });
    const a = await http('POST', '/api/appointments', { cookie: cust2, body: { storeId: clinic, service: 'قص شعر', startsAt: when } });
    assert.equal(a.status, 201);
    const book = await http('GET', '/api/store/appointments', { cookie: clinicCookie });
    assert.equal(book.data.appointments[0].customer_name, 'ريم');
    assert.equal((await http('POST', `/api/store/appointments/${a.data.id}/confirm`, { cookie: clinicCookie, body: {} })).status, 200);
    const mine = await http('GET', '/api/customer/appointments', { cookie: cust2 });
    assert.equal(mine.data.appointments[0].status, 'confirmed');
  });

  test('"come to me": craftsperson sees the location only after accepting; his home is never listed', async () => {
    const list = await http('GET', '/api/delivery/stores?category=electrician&lat=33.90&lng=35.51');
    const el = list.data.stores.find((x) => x.id === electrician);
    assert.ok(el && el.lat === undefined);
    const r = await http('POST', '/api/visits', { cookie: cust2, body: { craftId: electrician, description: 'انقطاع كهرباء في المطبخ', lat: 33.905, lng: 35.512 } });
    assert.equal(r.status, 201);
    let v = await http('GET', '/api/store/visits', { cookie: elCookie });
    assert.equal(v.data.visits[0].customer, null);
    assert.ok(v.data.visits[0].distanceM > 0);
    await http('POST', `/api/store/visits/${r.data.id}/accept`, { cookie: elCookie, body: {} });
    v = await http('GET', '/api/store/visits', { cookie: elCookie });
    assert.equal(v.data.visits[0].customer.lat, 33.905);
    const mine = await http('GET', '/api/customer/visits', { cookie: cust2 });
    assert.equal(mine.data.visits[0].phone, '96171100013');
    const notCraft = await http('POST', '/api/visits', { cookie: cust2, body: { craftId: selfStore, description: 'تعال إلى منزلي', lat: 33.9, lng: 35.5 } });
    assert.equal(notCraft.status, 404);
  });
});

describe('customer asks a driver directly (errands)', () => {
  let c3, subDriver, plainDriver, errandId;
  before(async () => {
    c3 = ck(await http('POST', '/api/customer/login', { body: { name: 'هلا', phone: '03222111', acceptTerms: true } }));
    subDriver = await makeDriver('71300001', 33.9500, 35.6000);
    plainDriver = await makeDriver('71300002', 33.9502, 35.6002);
    assert.equal((await A('POST', `/api/admin/drivers/${subDriver.id}/jobs`, { months: 1 })).status, 200);
  });

  test('only drivers with the "customer requests" subscription get it; distances and price, not addresses', async () => {
    const big = await http('POST', '/api/errands', { cookie: c3, body: { kind: 'buy', description: 'ربطة خبز وحليب', price: 4, purchaseValue: 500, from: { lat: 33.951, lng: 35.601 }, to: { lat: 33.96, lng: 35.61 } } });
    assert.equal(big.status, 422);                          // above the purchase limit
    const r = await http('POST', '/api/errands', { cookie: c3, body: { kind: 'buy', description: 'ربطة خبز وحليب', price: 4, purchaseValue: 15, from: { lat: 33.951, lng: 35.601, details: 'فرن أبو سمير' }, to: { lat: 33.96, lng: 35.61, details: 'بناية النور ط2' } } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.driversNotified, 1);
    errandId = r.data.id;
    assert.equal((await http('GET', '/api/driver/offers', { cookie: plainDriver.cookie })).data.offers.filter((o) => o.type === 'errand').length, 0);
    const offers = (await http('GET', '/api/driver/offers', { cookie: subDriver.cookie })).data.offers.filter((o) => o.type === 'errand');
    assert.equal(offers.length, 1);
    assert.equal(offers[0].kind, 'buy');
    assert.equal(offers[0].purchaseValue, 15);
    assert.ok(offers[0].totalM > 0 && offers[0].toStartM >= 0);
    assert.equal(JSON.stringify(offers[0]).includes('أبو سمير'), false);
    subDriver.offer = offers[0].id;
  });

  test('accept → addresses + customer phone; customer sees the driver; chat both ways; delivered', async () => {
    assert.equal((await http('POST', `/api/driver/errand-offers/${subDriver.offer}/accept`, { cookie: subDriver.cookie, body: {} })).status, 200);
    const cur = (await http('GET', '/api/driver/current', { cookie: subDriver.cookie })).data.errand;
    assert.equal(cur.from.details, 'فرن أبو سمير');
    assert.equal(cur.customer.phone, '9613222111');
    assert.equal((await http('POST', `/api/errands/${errandId}/messages`, { cookie: c3, body: { body: 'الحليب كامل الدسم' } })).status, 201);
    assert.equal((await http('POST', `/api/errands/${errandId}/messages`, { cookie: subDriver.cookie, body: { body: 'حوّلي 15$ على Whish' } })).status, 201);
    assert.equal((await http('POST', `/api/errands/${errandId}/messages`, { cookie: plainDriver.cookie, body: { body: 'تطفّل' } })).status, 403);
    const t = (await http('GET', `/api/customer/errands/${errandId}`, { cookie: c3 })).data.errand;
    assert.equal(t.status, 'assigned');
    assert.equal(t.driver.phone, '96171300001');
    assert.equal(t.messages.length, 2);
    // the owner can't read the chat without a complaint
    assert.equal((await A('GET', `/api/admin/errands/${errandId}/messages`)).status, 403);
    await http('POST', `/api/driver/errands/${errandId}/picked`, { cookie: subDriver.cookie, body: {} });
    assert.equal((await http('POST', `/api/driver/errands/${errandId}/delivered`, { cookie: subDriver.cookie, body: {} })).status, 200);
    assert.equal((await http('GET', `/api/customer/errands/${errandId}`, { cookie: c3 })).data.errand.status, 'delivered');
    assert.equal((await http('GET', '/api/driver/report?period=today', { cookie: subDriver.cookie })).data.report.errands, 1);
  });

  test('a complaint on an errand lets the owner read its chat', async () => {
    assert.equal((await http('POST', '/api/complaints', { cookie: subDriver.cookie, body: { errandId, against: 'customer', text: 'رفض استلام المشتريات' } })).status, 201);
    const msgs = await A('GET', `/api/admin/errands/${errandId}/messages`);
    assert.equal(msgs.status, 200);
    assert.equal(msgs.data.messages.length, 2);
  });

  test('subscription ends → no more customer requests', async () => {
    await A('POST', `/api/admin/drivers/${subDriver.id}/jobs`, { months: 0 });
    const r = await http('POST', '/api/errands', { cookie: c3, body: { kind: 'deliver', description: 'مفاتيح', price: 3, from: { lat: 33.951, lng: 35.601 }, to: { lat: 33.96, lng: 35.61 } } });
    assert.equal(r.data.driversNotified, 0);
  });
});

describe('every country is separate; one phone can be subscriber, driver and customer; admin deletes anything', () => {
  let frStore, frCookie, lbCust, frDriver;
  before(async () => {
    const r = await A('POST', '/api/admin/cooks', {
      fullName: 'Bistro Paris', whatsapp: '+33612345678', areaId, services: ['home_cooking'], servedAreaIds: [areaId], kind: 'restaurant', lat: 33.8939, lng: 35.5019,
      activate: { plan: 'monthly', startDate: new Date(Date.now() - 60_000).toISOString() },
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    frStore = r.data.id;
    await app.db.query(`UPDATE cooks SET country = 'FR' WHERE id = $1`, [frStore]);   // same street, other country (worst case)
    await A('POST', `/api/admin/stores/${frStore}/delivery`, { mode: 'delivery' });
    await app.db.query(`INSERT INTO menu_items (cook_id, name, price, currency) VALUES ($1,'Croissant',2,'EUR')`, [frStore]);
    const pw = await A('POST', `/api/admin/cooks/${frStore}/password`, {});
    frCookie = ck(await http('POST', '/api/cook/login', { body: { whatsapp: '+33612345678', password: pw.data.password } }));
    lbCust = ck(await http('POST', '/api/customer/login', { body: { name: 'لبناني', phone: '03444555', country: 'LB', acceptTerms: true } }));
  });

  test('a Lebanese customer never sees or orders from a French store, even next door', async () => {
    const list = await http('GET', '/api/delivery/stores?lat=33.894&lng=35.502&country=LB');
    assert.equal(list.data.stores.some((x) => x.id === frStore), false);
    assert.equal((await http('GET', `/api/delivery/stores/${frStore}?country=LB`)).status, 404);
    const item = (await app.db.one('SELECT id FROM menu_items WHERE cook_id = $1', [frStore])).id;
    assert.equal((await http('POST', '/api/orders', { cookie: lbCust, body: { storeId: frStore, items: [{ id: item, qty: 1 }], lat: 33.894, lng: 35.502 } })).status, 404);
    const fr = await http('GET', '/api/delivery/stores?lat=33.894&lng=35.502&country=FR');
    assert.equal(fr.data.stores.some((x) => x.id === frStore), true);
  });

  test('a French order only reaches French drivers', async () => {
    const lbNear = await makeDriver('71400001', 33.8939, 35.5019);            // Lebanese, right there
    const docs = Object.fromEntries(['selfie', 'idFront', 'idBack', 'vehicleFront', 'vehicleBack', 'registration', 'criminalRecord'].map((k) => [k, JPG]));
    const d = await http('POST', '/api/driver/apply', { body: { fullName: 'Jean Dupont', phone: '+33698765432', country: 'FR', password: 'pass123', vehicle: 'moto', plate: 'AB-123', walletProvider: 'whish', walletNumber: '+33698765432', acceptTerms: true, adult: true, birthDate: '1995-04-02', docs } });
    assert.equal(d.status, 201, JSON.stringify(d.data));
    await A('POST', `/api/admin/drivers/${d.data.id}/status`, { status: 'active' });
    frDriver = { id: d.data.id, cookie: ck(await http('POST', '/api/driver/login', { body: { phone: '+33698765432', password: 'pass123' } })) };
    await http('POST', '/api/driver/availability', { cookie: frDriver.cookie, body: { available: true, lat: 33.8941, lng: 35.5021 } });
    const frCust = ck(await http('POST', '/api/customer/login', { body: { name: 'Marie', phone: '+33611112222', country: 'FR', acceptTerms: true } }));
    const item = (await app.db.one('SELECT id FROM menu_items WHERE cook_id = $1', [frStore])).id;
    const o = await http('POST', '/api/orders', { cookie: frCust, body: { storeId: frStore, items: [{ id: item, qty: 2 }], lat: 33.895, lng: 35.503 } });
    assert.equal(o.status, 201, JSON.stringify(o.data));
    await A('POST', `/api/admin/stores/${frStore}/wallet-adjust`, { amount: 20, note: 'test' });
    await http('POST', `/api/store/orders/${o.data.id}/accept`, { cookie: frCookie, body: {} });
    const r = await http('POST', `/api/store/orders/${o.data.id}/search`, { cookie: frCookie, body: { fee: 2 } });
    assert.equal(r.data.driversNotified, 1);
    assert.equal((await http('GET', '/api/driver/offers', { cookie: lbNear.cookie })).data.offers.filter((x) => x.orderId === o.data.id).length, 0);
    assert.equal((await http('GET', '/api/driver/offers', { cookie: frDriver.cookie })).data.offers.filter((x) => x.orderId === o.data.id).length, 1);
    const adminFr = await A('GET', '/api/admin/drivers?country=FR');
    assert.deepEqual(adminFr.data.drivers.map((x) => x.id), [frDriver.id]);
  });

  test('the same phone as subscriber, driver and customer: separate accounts, nothing affects the subscription', async () => {
    // the store's own WhatsApp number signs up as a customer
    const asCust = await http('POST', '/api/customer/login', { body: { name: 'صاحب المطعم', phone: '+96171100001', acceptTerms: true } });
    assert.equal(asCust.status, 200);
    const custCookie = ck(asCust);
    const sub = await http('GET', '/api/cook/me', { cookie: storeCookie });
    assert.equal(sub.status, 200);
    assert.equal(sub.data.subscription.status, 'active');
    await http('POST', '/api/customer/me/delete', { cookie: custCookie, body: {} });   // deleting the customer account…
    assert.equal((await http('GET', '/api/cook/me', { cookie: storeCookie })).status, 200);   // …leaves the store untouched
    assert.equal((await http('GET', '/api/store/wallet', { cookie: storeCookie })).status, 200);
  });

  test('admin can delete orders, complaints, warnings, drivers, customers; and clear old finished items', async () => {
    const ord = (await A('GET', '/api/admin/orders')).data.orders[0];
    assert.equal((await A('DELETE', `/api/admin/orders/${ord.id}`)).status, 200);
    const w = await A('POST', '/api/admin/warnings', { type: 'driver', id: frDriver.id, reason: 'تجربة الحذف' });
    assert.equal(w.data.count, 1);
    const log = await A('GET', `/api/admin/ledger?type=driver&id=${frDriver.id}`);
    assert.equal((await A('DELETE', `/api/admin/warnings/${log.data.warnings[0].id}`)).status, 200);
    assert.equal((await A('GET', `/api/admin/warnings?type=driver&id=${frDriver.id}`)).data.count, 0);
    assert.equal((await A('DELETE', `/api/admin/drivers/${frDriver.id}`)).status, 200);
    assert.equal((await http('GET', '/api/driver/me', { cookie: frDriver.cookie })).status, 401);
    const cust = (await A('GET', '/api/admin/customers?q=' + encodeURIComponent('لبناني'))).data.customers[0];
    assert.equal((await A('DELETE', `/api/admin/customers/${cust.id}`)).status, 200);
    assert.equal((await http('GET', '/api/customer/me', { cookie: lbCust })).status, 401);
    const pendingW = await http('POST', '/api/store/withdrawals', { cookie: storeCookie, body: { amount: 5, provider: 'whish', number: '76123456', password: storePw } });
    assert.equal((await A('DELETE', `/api/admin/withdrawals/${pendingW.data.id}`)).status, 409);   // decide money first
    const c = await A('POST', '/api/admin/delivery/cleanup', { all: true });
    assert.equal(c.status, 200);
    assert.ok('orders' in c.data && 'errands' in c.data);
    assert.equal((await http('DELETE', `/api/admin/orders/1`)).status, 401);                       // not without the owner
  });
});

describe('SMS codes switch on by themselves when a provider is set', () => {
  let app2, base2;
  before(async () => {
    app2 = await createApp({
      databaseUrl: 'sqlite::memory:', adminWhatsapp: '96170999999', sessionSecret: 'y'.repeat(40), quiet: true, loginLimit: 1e4,
      sms: { enabled: true, send: async (phone, text) => smsSent.push({ phone, text }) }, placesFetcher: async () => [],
    });
    await new Promise((r) => app2.server.listen(0, r));
    base2 = `http://127.0.0.1:${app2.server.address().port}`;
  });
  after(async () => { await app2.close(); });
  const h = (p, body) => fetch(base2 + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) });

  test('wrong code refused, right code signs in', async () => {
    const c = await (await h('/api/customer/code', { phone: '03999888' })).json();
    assert.equal(c.codeRequired, true);
    const code = smsSent.at(-1).text.match(/(\d{6})/)[1];
    assert.equal((await h('/api/customer/login', { phone: '03999888', name: 'سارة', acceptTerms: true, code: '000000' === code ? '111111' : '000000' })).status, 401);
    assert.equal((await h('/api/customer/login', { phone: '03999888', name: 'سارة', acceptTerms: true, code })).status, 200);
  });
});
