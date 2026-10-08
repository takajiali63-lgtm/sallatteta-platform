// v7.6 money model: customer pays FOOD + DELIVERY FEE; cash vs card; the driver's 200 $ restaurant-cash limit (cash orders
// only); settlements (Whish / OMT) broken down per restaurant automatically, verified by the owner, never twice;
// restaurant / driver / owner money views; refunds, failed and duplicate card payments; manipulation attempts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/server.js';
import { createPayments } from '../src/services/payments.js';

const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';
const DOCS = Object.fromEntries(['selfie', 'idFront', 'idBack', 'vehicleFront', 'vehicleBack', 'registration', 'criminalRecord'].map((k) => [k, JPG]));
let app, base, admin, areaId, cust;
const PAY_ENV = { PAY_CHECKOUT_URL: 'https://pay.example/create', PAY_API_KEY: 'k', PAY_WEBHOOK_SECRET: 'whsec' };
const fakePay = async (url, opts) => { const b = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ url: `https://pay.example/c/${b.reference}` }) }; };
const sign = (raw) => createHmac('sha256', 'whsec').update(raw).digest('hex');

async function http(method, path, { body, cookie, raw, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method, redirect: 'manual',
    headers: { ...(body !== undefined || raw ? { 'Content-Type': 'application/json' } : {}), 'X-Requested-With': 'fetch', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const ck = (r) => r.headers.get('set-cookie').split(';')[0];
async function login(path, body) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) });
  return ck(res);
}
const A = (m, p, b) => http(m, p, { body: b, cookie: admin });
let n = 0;
async function makeDriver(lat, lng) {
  const phone = `7170${String(1000 + n++).padStart(4, '0')}`;
  const r = await http('POST', '/api/driver/apply', { body: { fullName: 'سائق ' + phone.slice(-3), phone, password: 'pass123', vehicle: 'moto', plate: 'B 1', walletProvider: 'whish', walletNumber: '71000000', acceptTerms: true, adult: true, birthDate: '1990-01-01', docs: DOCS } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await A('POST', `/api/admin/drivers/${r.data.id}/status`, { status: 'active' });
  const cookie = await login('/api/driver/login', { phone, password: 'pass123' });
  await http('POST', '/api/driver/availability', { body: { available: true, lat, lng }, cookie });
  return { id: r.data.id, cookie, lat, lng };
}
let sn = 0;
async function makeStore(lat, lng, { fee = 3, price = 10, pay = 'both' } = {}) {
  const wa = `+9617140${String(1000 + sn++).padStart(4, '0')}`;
  const r = await A('POST', '/api/admin/cooks', { fullName: 'مطعم ' + sn, whatsapp: wa, areaId, services: ['home_cooking'], servedAreaIds: [areaId], kind: 'restaurant', lat, lng, activate: { plan: 'monthly', startDate: new Date(Date.now() - 60_000).toISOString() } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await A('POST', `/api/admin/stores/${r.data.id}/delivery`, { mode: 'delivery' });
  await app.db.query(`INSERT INTO menu_items (cook_id, name, price, currency) VALUES ($1,'طبق',$2,'USD')`, [r.data.id, price]);
  const item = (await app.db.one('SELECT id FROM menu_items WHERE cook_id = $1', [r.data.id])).id;
  const pw = (await A('POST', `/api/admin/cooks/${r.data.id}/password`, {})).data.password;
  const cookie = await login('/api/cook/login', { whatsapp: wa, password: pw });
  assert.equal((await http('POST', '/api/store/settings', { cookie, body: { deliveryFee: fee, payMethods: pay } })).status, 200);
  return { id: r.data.id, cookie, item, lat, lng, pw };
}
async function payWebhook(token, status = 'paid', extra = {}) {
  const raw = JSON.stringify({ reference: token, status, id: `tx-${token.slice(0, 6)}`, ...extra });
  return http('POST', '/api/pay/webhook', { raw, headers: { 'X-Signature': sign(raw) } });
}
/** Customer orders → (card: pays) → store accepts & calls a driver → he accepts, delivers → customer confirms. */
async function deliver(d, st, { qty = 2, method = 'cash', confirm = true } = {}) {
  const o = await http('POST', '/api/orders', { cookie: cust, body: { storeId: st.id, items: [{ id: st.item, qty }], lat: st.lat + 0.004, lng: st.lng, paymentMethod: method, total: 1, deliveryFee: 0 } });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  if (method === 'card') assert.equal((await payWebhook(o.data.payUrl.split('/').pop())).status, 200);
  await http('POST', `/api/store/orders/${o.data.id}/accept`, { cookie: st.cookie, body: {} });
  await http('POST', `/api/store/orders/${o.data.id}/search`, { cookie: st.cookie, body: {} });
  const off = (await http('GET', '/api/driver/offers', { cookie: d.cookie })).data.offers.find((x) => x.orderId === o.data.id);
  if (!off) return { id: o.data.id, offered: false };
  const acc = await http('POST', `/api/driver/offers/${off.id}/accept`, { cookie: d.cookie, body: {} });
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  await http('POST', `/api/driver/orders/${o.data.id}/delivered`, { cookie: d.cookie, body: {} });
  if (confirm) await http('POST', `/api/customer/orders/${o.data.id}/confirm`, { cookie: cust, body: {} });
  return { id: o.data.id, offered: true, data: o.data };
}
const fin = async (d) => (await http('GET', '/api/driver/finance', { cookie: d.cookie })).data.finance;
const storeBal = async (st) => (await http('GET', '/api/store/wallet', { cookie: st.cookie })).data.balance;

before(async () => {
  app = await createApp({
    databaseUrl: 'sqlite::memory:', adminWhatsapp: '96170999999', sessionSecret: 'x'.repeat(40), quiet: true,
    bootstrapAdmin: { username: 'admin', password: 'correct-horse-battery' },
    searchLimit: 1e4, applyLimit: 1e4, loginLimit: 1e4, lookupLimit: 1e4, placesLimit: 1e4, feedbackLimit: 1e4, uploadLimit: 1e4, adminLimit: 1e5,
    placesFetcher: async () => [],
    payments: createPayments({ env: PAY_ENV, fetchImpl: fakePay, log: {} }),
  });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  areaId = (await app.db.one(`SELECT id FROM service_areas WHERE slug = 'zahle'`)).id;
  admin = await login('/api/admin/login', { username: 'admin', password: 'correct-horse-battery' });
  cust = await login('/api/customer/login', { name: 'زبون', phone: '03999444', acceptTerms: true });
  await A('PUT', '/api/admin/delivery/settings', { claimWindowSec: 0, offerBatch: 5, cashLimit: 200 });
});
after(() => app?.close?.());

test('1+18. cash order 20 $ + 3 $: the customer pays 23 $ to the driver; on confirmation 20 $ = restaurant cash he holds, 3 $ = his earning', async () => {
  const st = await makeStore(34.00, 35.60);
  const d = await makeDriver(34.001, 35.601);
  const r = await deliver(d, st, { qty: 2 });
  assert.deepEqual([r.data.total, r.data.deliveryFee, r.data.customerTotal], [20, 3, 23], 'computed by the server, the phone\'s numbers ignored (19.)');
  const f = await fin(d);
  assert.deepEqual([f.restaurantCash, f.earnings, f.withdrawable, f.remaining, f.cashOrders, f.cardOrders], [20, 3, 0, 180, true, true]);
  assert.deepEqual(f.owed.map((x) => [x.storeId, x.amount]), [[st.id, 20]]);
  const o = await app.db.one('SELECT financial_status, confirmed_at FROM orders WHERE id = $1', [r.id]);
  assert.equal(o.financial_status, 'completed'); assert.ok(o.confirmed_at);
  assert.equal(await storeBal(st), 0, 'the store gets its cash through the settlement');
});

test('2+17. card order 20 $ + 3 $: food to the restaurant, fee to the driver, nothing in his cash; duplicate webhook counted once', async () => {
  const st = await makeStore(34.10, 35.60);
  const d = await makeDriver(34.101, 35.601);
  const o = await http('POST', '/api/orders', { cookie: cust, body: { storeId: st.id, items: [{ id: st.item, qty: 2 }], lat: 34.104, lng: 35.60, paymentMethod: 'card' } });
  assert.equal(o.status, 201);
  assert.ok(!(await http('GET', '/api/store/orders', { cookie: st.cookie })).data.orders.some((x) => x.id === o.data.id), 'not shown to the store before payment');
  const token = o.data.payUrl.split('/').pop();
  assert.equal((await payWebhook(token)).status, 200);
  assert.equal((await payWebhook(token)).data.duplicate, true);
  const raw = JSON.stringify({ reference: token, status: 'paid', id: 'x' });
  assert.equal((await http('POST', '/api/pay/webhook', { raw, headers: { 'X-Signature': 'forged' } })).status, 401);
  assert.equal((await app.db.query(`SELECT id FROM financial_ledger WHERE order_id = $1 AND kind = 'card_payment_received'`, [o.data.id])).length, 1);
  await http('POST', `/api/store/orders/${o.data.id}/accept`, { cookie: st.cookie, body: {} });
  await http('POST', `/api/store/orders/${o.data.id}/search`, { cookie: st.cookie, body: {} });
  const off = (await http('GET', '/api/driver/offers', { cookie: d.cookie })).data.offers.find((x) => x.orderId === o.data.id);
  assert.equal(off.collect, 0, 'nothing to collect: paid by card');
  await http('POST', `/api/driver/offers/${off.id}/accept`, { cookie: d.cookie, body: {} });
  await http('POST', `/api/driver/orders/${o.data.id}/delivered`, { cookie: d.cookie, body: {} });
  await http('POST', `/api/customer/orders/${o.data.id}/confirm`, { cookie: cust, body: {} });
  const f = await fin(d);
  assert.deepEqual([f.restaurantCash, f.earnings, f.withdrawable], [0, 3, 3]);
  assert.equal(await storeBal(st), 20);
  const sf = (await http('GET', '/api/store/finance', { cookie: st.cookie })).data.finance;
  assert.deepEqual([sf.foodSales, sf.cardSales, sf.cashByDrivers, sf.outstandingWithDrivers], [20, 20, 0, 0]);
});

test('16. failed card payment: the order is cancelled and never reaches the store', async () => {
  const st = await makeStore(34.20, 35.60);
  const o = await http('POST', '/api/orders', { cookie: cust, body: { storeId: st.id, items: [{ id: st.item, qty: 1 }], lat: 34.204, lng: 35.60, paymentMethod: 'card' } });
  await payWebhook(o.data.payUrl.split('/').pop(), 'failed');
  const row = await app.db.one('SELECT status, payment_status FROM orders WHERE id = $1', [o.data.id]);
  assert.deepEqual([row.status, row.payment_status], ['cancelled', 'failed']);
  assert.ok(!(await http('GET', '/api/store/orders', { cookie: st.cookie })).data.orders.some((x) => x.id === o.data.id));
  // a store that takes cash only
  const cashOnly = await makeStore(34.21, 35.60, { pay: 'cash' });
  const bad = await http('POST', '/api/orders', { cookie: cust, body: { storeId: cashOnly.id, items: [{ id: cashOnly.item, qty: 1 }], lat: 34.214, lng: 35.60, paymentMethod: 'card' } });
  assert.equal(bad.status, 422);
});

test('under the limit any cash order is allowed even if it passes it: 180 $ + a 50 $ order → 230 $, then cash stops', async () => {
  const st = await makeStore(34.35, 35.60, { price: 10 });
  const d = await makeDriver(34.351, 35.601);
  await deliver(d, st, { qty: 18 });                          // 180 $
  const big = await deliver(d, st, { qty: 5 });              // + 50 $ → allowed
  assert.equal(big.offered, true);
  const f = await fin(d);
  assert.deepEqual([f.restaurantCash, f.remaining, f.cashOrders, f.cardOrders], [230, 0, false, true]);
  const next = await deliver(d, st, { qty: 1 });
  assert.equal(next.offered, false, 'over the limit: no new cash order');
  await http('POST', `/api/store/orders/${next.id}/cancel`, { cookie: st.cookie, body: {} });
  assert.equal((await deliver(d, st, { qty: 1, method: 'card' })).offered, true, 'card orders keep coming');
});

test('3–5, 24–25. the 200 $ cash limit: 190 + 10 allowed; at 200 no NEW cash order (backend), card orders continue; settling re-opens cash', async () => {
  const st = await makeStore(34.30, 35.60, { price: 10 });
  const d = await makeDriver(34.301, 35.601);
  await deliver(d, st, { qty: 19 });                          // 190 $
  assert.equal((await fin(d)).restaurantCash, 190);
  const r10 = await deliver(d, st, { qty: 1 });              // + 10 = 200 → allowed (still under the limit when it came)
  assert.equal(r10.offered, true);
  let f = await fin(d);
  assert.deepEqual([f.restaurantCash, f.remaining, f.cashOrders, f.cardOrders], [200, 0, false, true]);
  // a new cash order does not reach him …
  const blocked = await deliver(d, st, { qty: 1 });
  assert.equal(blocked.offered, false);
  // … and even forcing an offer to him is refused by the server
  await app.db.query(`INSERT INTO order_offers (order_id, driver_id, fee) VALUES ($1,$2,3)`, [blocked.id, d.id]);
  const forced = (await app.db.one('SELECT id FROM order_offers WHERE order_id = $1 AND driver_id = $2', [blocked.id, d.id])).id;
  const tryIt = await http('POST', `/api/driver/offers/${forced}/accept`, { cookie: d.cookie, body: {} });
  assert.equal(tryIt.status, 409); assert.equal(tryIt.data.error, 'cash_limit_reached');
  await http('POST', `/api/store/orders/${blocked.id}/cancel`, { cookie: st.cookie, body: {} });
  // card order: still allowed, and his cash stays 200 (not 300)
  const card = await deliver(d, st, { qty: 10, method: 'card' });
  assert.equal(card.offered, true);
  f = await fin(d);
  assert.deepEqual([f.restaurantCash, f.withdrawable], [200, 3]);
  // 6. settles 200 $ by Whish → owner verifies → 0 → cash orders back
  const s = await http('POST', '/api/driver/settlements', { cookie: d.cookie, body: { amount: 200, method: 'whish', reference: 'WH-938273', receipt: JPG } });
  assert.equal(s.status, 201, JSON.stringify(s.data));
  assert.deepEqual(s.data.breakdown.stores.map((x) => [x.storeId, x.amount]), [[st.id, 200]]);
  assert.equal((await fin(d)).cashOrders, false, 'pending settlement does not change balances');
  assert.equal((await A('POST', `/api/admin/settlements/${s.data.id}/verify`, {})).status, 200);
  f = await fin(d);
  assert.deepEqual([f.restaurantCash, f.remaining, f.cashOrders], [0, 200, true]);
  assert.equal((await deliver(d, st, { qty: 1 })).offered, true, 'cash orders enabled again');
});

test('7–13, 20–23. settlements: OMT, exact amount, automatic per-restaurant breakdown, never twice; one restaurant owed by several drivers', async () => {
  const A1 = await makeStore(34.40, 35.60, { price: 10 }), B1 = await makeStore(34.402, 35.60, { price: 15 }), C1 = await makeStore(34.404, 35.60, { price: 5 });
  const d = await makeDriver(34.401, 35.601), d2 = await makeDriver(34.4012, 35.6012);
  await http('POST', '/api/driver/availability', { cookie: d2.cookie, body: { available: false } });
  await deliver(d, A1, { qty: 3 }); await deliver(d, A1, { qty: 5 });    // A = 30 + 50 = 80
  await deliver(d, B1, { qty: 3 });                                      // B = 45
  await deliver(d, C1, { qty: 7 });                                      // C = 35
  let f = await fin(d);
  assert.equal(f.restaurantCash, 160);
  assert.deepEqual(Object.fromEntries(f.owed.map((x) => [x.storeId, x.amount])), { [A1.id]: 80, [B1.id]: 45, [C1.id]: 35 });
  // the second driver also owes restaurant A
  await http('POST', '/api/driver/availability', { cookie: d.cookie, body: { available: false } });
  await http('POST', '/api/driver/availability', { cookie: d2.cookie, body: { available: true, lat: d2.lat, lng: d2.lng } });
  await deliver(d2, A1, { qty: 4 });                                     // 40
  const af = (await http('GET', '/api/store/finance', { cookie: A1.cookie })).data.finance;
  assert.equal(af.outstandingWithDrivers, 120);
  assert.deepEqual(af.drivers.map((x) => x.owes).sort(), [40, 80]);
  const perDriver = (await http('GET', `/api/store/finance/drivers/${d.id}`, { cookie: A1.cookie })).data.orders;
  assert.deepEqual(perDriver.map((x) => x.amount).sort(), [30, 50]);
  // 8. wrong amount → mismatch; 19. the driver can't choose the numbers
  const wrong = await http('POST', '/api/driver/settlements', { cookie: d.cookie, body: { amount: 159.5, method: 'omt', reference: 'OMT-1' } });
  assert.equal(wrong.status, 422); assert.equal(wrong.data.error, 'settlement_amount_mismatch');
  // 7. OMT, only restaurants A and C (80 + 35)
  const s1 = await http('POST', '/api/driver/settlements', { cookie: d.cookie, body: { amount: 115, method: 'omt', reference: 'OMT-2', storeIds: [A1.id, C1.id] } });
  assert.equal(s1.status, 201, JSON.stringify(s1.data));
  assert.deepEqual(Object.fromEntries(s1.data.breakdown.stores.map((x) => [x.storeId, x.amount])), { [A1.id]: 80, [C1.id]: 35 });
  // 9. same orders again → nothing left to settle; same reference twice → duplicate
  assert.equal((await http('POST', '/api/driver/settlements', { cookie: d.cookie, body: { amount: 115, method: 'omt', reference: 'OMT-3', storeIds: [A1.id, C1.id] } })).data.error, 'nothing_to_settle');
  assert.equal((await http('POST', '/api/driver/settlements', { cookie: d.cookie, body: { amount: 45, method: 'whish', reference: 'OMT-2' } })).data.error, 'duplicate_settlement');
  // sent from someone else's number → the receipt is required; the same transfer number can't be claimed by another driver
  const other = await http('POST', '/api/driver/settlements', { cookie: d.cookie, body: { amount: 45, method: 'whish', reference: 'WH-OTHER', senderNumber: '03111999' } });
  assert.equal(other.data.error, 'receipt_required_other_sender');
  assert.equal((await http('POST', '/api/driver/settlements', { cookie: d2.cookie, body: { amount: 40, method: 'omt', reference: 'omt-2' } })).data.error, 'duplicate_settlement', 'a transfer number is used once, by anyone');
  // owner sees the breakdown and the orders behind it
  const list = (await A('GET', '/api/admin/settlements')).data.settlements.find((x) => x.id === s1.data.id);
  assert.equal(list.breakdown.stores.find((x) => x.storeId === A1.id).orders.length, 2);
  assert.ok(list.sender_number, 'the sending number is shown to the owner');
  // 21. reject → orders back to open, can be settled again
  assert.equal((await A('POST', `/api/admin/settlements/${s1.data.id}/reject`, { note: 'لم يصل التحويل' })).status, 200);
  assert.equal((await A('POST', `/api/admin/settlements/${s1.data.id}/verify`, {})).status, 409, 'a rejected settlement cannot be verified');
  const s2 = await http('POST', '/api/driver/settlements', { cookie: d.cookie, body: { amount: 160, method: 'whish', reference: 'WH-160' } });
  assert.equal(s2.status, 201);
  // 14 (mismatch guard on the owner side): a tampered allocation is caught before anything moves
  await app.db.query('UPDATE settlement_allocations SET amount = amount - 0.5 WHERE settlement_id = $1 AND id = (SELECT MIN(id) FROM settlement_allocations WHERE settlement_id = $1)', [s2.data.id]);
  const mm = await A('POST', `/api/admin/settlements/${s2.data.id}/verify`, {});
  assert.equal(mm.status, 422); assert.equal(mm.data.error, 'settlement_amount_mismatch');
  await app.db.query('UPDATE settlement_allocations SET amount = amount + 0.5 WHERE settlement_id = $1 AND id = (SELECT MIN(id) FROM settlement_allocations WHERE settlement_id = $1)', [s2.data.id]);
  // 20, 22, 23. verify → each restaurant credited its exact share; driver back to 0
  const v = await A('POST', `/api/admin/settlements/${s2.data.id}/verify`, {});
  assert.equal(v.status, 200, JSON.stringify(v.data));
  assert.deepEqual([await storeBal(A1), await storeBal(B1), await storeBal(C1)], [80, 45, 35]);
  f = await fin(d);
  assert.equal(f.restaurantCash, 0);
  assert.equal((await A('POST', `/api/admin/settlements/${s2.data.id}/verify`, {})).status, 409, 'never twice');
  const owed = (await A('GET', '/api/admin/finance/stores-owed')).data.stores;
  assert.equal(owed.find((x) => x.id === B1.id).balance, 45, 'who the platform owes, and how much');
  // 10. the database itself refuses a second live allocation of the same order
  const e = await app.db.one(`SELECT id, order_id, store_id FROM driver_cash_entries WHERE driver_id = $1 LIMIT 1`, [d.id]);
  const s3 = await app.db.one(`INSERT INTO settlements (driver_id, amount, method, reference) VALUES ($1, 1, 'whish', 'X') RETURNING id`, [d.id]);
  await assert.rejects(app.db.query('INSERT INTO settlement_allocations (settlement_id, entry_id, order_id, store_id, amount) VALUES ($1,$2,$3,$4,1)', [s3.id, e.id, e.order_id, e.store_id]).then(() => app.db.query('INSERT INTO settlement_allocations (settlement_id, entry_id, order_id, store_id, amount) VALUES ($1,$2,$3,$4,1)', [s3.id, e.id, e.order_id, e.store_id])));
  // restaurant A still waits for the second driver's 40 $
  assert.equal((await http('GET', '/api/store/finance', { cookie: A1.cookie })).data.finance.outstandingWithDrivers, 40);
  const ov = (await A('GET', '/api/admin/finance/overview')).data.overview;
  assert.ok(ov.cashHeldByDrivers >= 40 && ov.verifiedSettlements >= 360);
  const trace = (await A('GET', `/api/admin/finance/entries?settlement=${s2.data.id}`)).data.entries;
  assert.equal(trace.length, 4);
});

test('14–15. cancelled order: no money entries; refunded card order: reversal entries, payment marked to refund, history kept', async () => {
  const st = await makeStore(34.50, 35.60);
  const d = await makeDriver(34.501, 35.601);
  const o = await http('POST', '/api/orders', { cookie: cust, body: { storeId: st.id, items: [{ id: st.item, qty: 1 }], lat: 34.504, lng: 35.60 } });
  await http('POST', `/api/customer/orders/${o.data.id}/cancel`, { cookie: cust, body: {} });
  assert.equal((await app.db.query('SELECT id FROM driver_cash_entries WHERE order_id = $1', [o.data.id])).length, 0);
  const paidCancel = await http('POST', '/api/orders', { cookie: cust, body: { storeId: st.id, items: [{ id: st.item, qty: 1 }], lat: 34.504, lng: 35.60, paymentMethod: 'card' } });
  await payWebhook(paidCancel.data.payUrl.split('/').pop());
  await http('POST', `/api/store/orders/${paidCancel.data.id}/reject`, { cookie: st.cookie, body: {} });
  assert.equal((await app.db.one('SELECT payment_status FROM orders WHERE id = $1', [paidCancel.data.id])).payment_status, 'refund_pending', 'rejected after payment → refund due');
  assert.ok((await A('GET', '/api/admin/finance/refunds')).data.refunds.some((x) => x.id === paidCancel.data.id));
  assert.equal((await A('POST', `/api/admin/orders/${paidCancel.data.id}/refunded`, {})).status, 200);
  // a completed card order refunded by the owner
  const r = await deliver(d, st, { qty: 2, method: 'card' });
  assert.equal(await storeBal(st), 20);
  assert.equal((await A('POST', `/api/admin/orders/${r.id}/reverse`, { reason: 'طلب خاطئ' })).status, 200);
  assert.equal(await storeBal(st), 0);
  assert.equal((await fin(d)).withdrawable, 0);
  const j = (await A('GET', `/api/admin/finance/journal?order=${r.id}`)).data.journal.map((x) => x.kind);
  assert.ok(j.includes('card_sale_store') && j.includes('reversal_store') && j.includes('reversal_driver_fee'), j.join(','));
});

test('privacy: a store sees only its own money; a driver only his own; a customer none', async () => {
  const st = await makeStore(34.60, 35.60);
  const other = await makeStore(34.61, 35.60);
  const d = await makeDriver(34.601, 35.601);
  await deliver(d, st, { qty: 1 });
  assert.deepEqual((await http('GET', `/api/store/finance/drivers/${d.id}`, { cookie: other.cookie })).data.orders, []);
  assert.equal((await http('GET', '/api/admin/settlements', { cookie: st.cookie })).status, 401);
  assert.equal((await http('GET', '/api/driver/finance', { cookie: cust })).status, 401);
  assert.equal((await http('GET', '/api/store/finance', { cookie: cust })).status, 401);
  const track = (await http('GET', '/api/customer/orders', { cookie: cust })).data;
  assert.ok(!JSON.stringify(track).includes('restaurantCash'));
});

test('search by name: every shop of the country, even far away or without a location; ratings; product sections & photos; extra branch price', async () => {
  const far = await makeStore(34.95, 36.30);   // ~100 km from the others
  await app.db.query(`UPDATE cooks SET full_name = 'مطعم البعيد جداً' WHERE id = $1`, [far.id]);
  const noLoc = (await http('GET', `/api/delivery/stores?q=${encodeURIComponent('البعيد')}&country=LB`)).data.stores;
  assert.ok(noLoc.some((x) => x.id === far.id), 'found without a location');
  const withLoc = (await http('GET', `/api/delivery/stores?q=${encodeURIComponent('البعيد')}&lat=33.9&lng=35.5&country=LB`)).data.stores;
  assert.ok(withLoc.some((x) => x.id === far.id), 'found even 100 km away when searching by name');
  const browse = (await http('GET', '/api/delivery/stores?lat=33.9&lng=35.5&country=LB')).data.stores;
  assert.ok(!browse.some((x) => x.id === far.id), 'browsing nearby still shows what is around');
  // rating after delivery
  const d = await makeDriver(34.951, 36.301);
  const r = await deliver(d, far, { qty: 1 });
  assert.equal((await http('POST', `/api/customer/orders/${r.id}/rate`, { cookie: cust, body: { stars: 4, note: 'ممتاز' } })).status, 200);
  assert.equal((await http('POST', `/api/customer/orders/${r.id}/rate`, { cookie: cust, body: { stars: 9 } })).status, 422);
  const rec = (await http('GET', '/api/store/orders?view=history', { cookie: far.cookie })).data.orders.find((x) => x.id === r.id);
  assert.deepEqual([rec.rating, rec.ratingNote], [4, 'ممتاز']);
  // products in sections, with an optional photo
  const PNG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';
  let me = (await http('POST', '/api/cook/menu', { cookie: far.cookie, body: { name: 'كنافة', price: 3, section: 'حلويات', photo: PNG } })).data;
  me = (await http('PUT', '/api/cook/menu-sections', { cookie: far.cookie, body: { sections: ['حلويات', 'مشروبات'] } })).data;
  assert.deepEqual(me.menuSections, ['حلويات', 'مشروبات']);
  const k = me.menu.find((x) => x.name === 'كنافة');
  assert.equal(k.section, 'حلويات'); assert.ok(k.photo);
  const pub = (await http('GET', `/api/delivery/stores/${far.id}`)).data;
  assert.deepEqual(pub.store.sections, ['حلويات', 'مشروبات']);
  const ph = pub.menu.find((x) => x.name === 'كنافة').photo;
  assert.equal((await fetch(base + ph)).status, 200);
  me = (await http('PUT', '/api/cook/menu-sections', { cookie: far.cookie, body: { sections: ['تحلية', 'مشروبات'], renamed: [{ from: 'حلويات', to: 'تحلية' }] } })).data;
  assert.equal(me.menu.find((x) => x.name === 'كنافة').section, 'تحلية', 'renaming a section moves its products');
  assert.equal((await http('POST', '/api/cook/menu', { cookie: far.cookie, body: { name: 'سيء', price: 1, photo: 'data:text/html;base64,PHNjcmlwdD4=' } })).status, 422);
  // an extra branch: priced at branch % of the monthly price × months left; free → live at once
  const br = await http('POST', '/api/store/branches', { cookie: far.cookie, body: { name: 'فرع 2', lat: 34.96, lng: 36.31 } });
  assert.equal(br.status, 201); assert.equal(br.data.status, 'pending'); assert.ok(br.data.fee > 0);
  const pay = await http('POST', `/api/store/branches/${br.data.id}/pay`, { cookie: far.cookie, body: { method: 'online' } });
  assert.equal(pay.status, 200, JSON.stringify(pay.data));
  const tok = pay.data.url.split('/').pop();
  await payWebhook(tok);
  assert.equal((await app.db.one('SELECT status FROM cooks WHERE id = $1', [br.data.id])).status, 'approved', 'paid online → live with no owner action');
});
