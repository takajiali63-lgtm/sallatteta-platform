// v7.7: settlements paid ONLINE (Whish / OMT / card link with a fixed amount) and confirmed automatically by the provider's
// signed callback; restaurants' shares sent automatically to their Whish/OMT; violations log; per-country settlement ways.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/server.js';
import { createPayments } from '../src/services/payments.js';

const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';
const DOCS = Object.fromEntries(['selfie', 'idFront', 'idBack', 'vehicleFront', 'vehicleBack', 'registration', 'criminalRecord'].map((k) => [k, JPG]));
let app, base, admin, areaId, cust;
const PAY_ENV = {
  PAY_CHECKOUT_URL: 'https://pay.example/create', PAY_API_KEY: 'k', PAY_WEBHOOK_SECRET: 'whsec',
  WHISH_PAY_URL: 'https://whish.example/collect', WHISH_PAY_KEY: 'wk', WHISH_PAY_SECRET: 'whish-secret',
  OMT_PAY_URL: 'https://omt.example/collect', OMT_PAY_KEY: 'ok', OMT_PAY_SECRET: 'omt-secret',
  WHISH_PAYOUT_URL: 'https://whish.example/payout', WHISH_PAYOUT_KEY: 'wpk',
  PAY_REFUND_URL: 'https://pay.example/refund',
};
const failRefunds = new Set();
const calls = [];
const fakePay = async (url, opts) => {
  const b = JSON.parse(opts.body);
  calls.push({ url, body: b });
  if (url.includes('/refund')) {
    if (failRefunds.has(b.reference)) return { ok: false, status: 502, json: async () => ({ error: 'down' }) };
    return { ok: true, status: 200, json: async () => ({ status: 'refunded', id: `RF-${b.reference.slice(0, 4)}` }) };
  }
  if (url.includes('/payout')) {
    if (String(b.number).includes('71999999')) return { ok: false, status: 500, json: async () => ({ error: 'refused' }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, id: `PO-${b.reference}` }) };
  }
  return { ok: true, status: 200, json: async () => ({ url: `https://${new URL(url).host}/pay/${b.reference}` }) };
};
const SECRET = { card: 'whsec', whish: 'whish-secret', omt: 'omt-secret' };
const sign = (raw, gw) => createHmac('sha256', SECRET[gw]).update(raw).digest('hex');

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
async function login(path, body) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify(body) });
  return res.headers.get('set-cookie').split(';')[0];
}
const A = (m, p, b) => http(m, p, { body: b, cookie: admin });
let n = 0;
async function makeDriver(lat, lng) {
  const phone = `7180${String(1000 + n++).padStart(4, '0')}`;
  const r = await http('POST', '/api/driver/apply', { body: { fullName: 'سائق ' + phone.slice(-3), phone, password: 'pass123', vehicle: 'moto', plate: 'B 1', walletProvider: 'whish', walletNumber: `7155${phone.slice(-4)}`, acceptTerms: true, adult: true, birthDate: '1990-01-01', docs: DOCS } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await A('POST', `/api/admin/drivers/${r.data.id}/status`, { status: 'active' });
  const cookie = await login('/api/driver/login', { phone, password: 'pass123' });
  await http('POST', '/api/driver/availability', { body: { available: true, lat, lng }, cookie });
  const w = (await app.db.one('SELECT wallet_number FROM drivers WHERE id = $1', [r.data.id])).wallet_number;
  return { id: r.data.id, cookie, lat, lng, wallet: w };
}
let sn = 0;
async function makeStore(lat, lng, { price = 10, payout = null } = {}) {
  const wa = `+9617150${String(1000 + sn++).padStart(4, '0')}`;
  const r = await A('POST', '/api/admin/cooks', { fullName: 'مطعم ' + sn, whatsapp: wa, areaId, services: ['home_cooking'], servedAreaIds: [areaId], kind: 'restaurant', lat, lng, activate: { plan: 'monthly', startDate: new Date(Date.now() - 60_000).toISOString() } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await A('POST', `/api/admin/stores/${r.data.id}/delivery`, { mode: 'delivery' });
  await app.db.query(`INSERT INTO menu_items (cook_id, name, price, currency) VALUES ($1,'طبق',$2,'USD')`, [r.data.id, price]);
  const item = (await app.db.one('SELECT id FROM menu_items WHERE cook_id = $1', [r.data.id])).id;
  const pw = (await A('POST', `/api/admin/cooks/${r.data.id}/password`, {})).data.password;
  const cookie = await login('/api/cook/login', { whatsapp: wa, password: pw });
  assert.equal((await http('POST', '/api/store/settings', { cookie, body: { deliveryFee: 3, payMethods: 'both' } })).status, 200);
  if (payout) assert.equal((await http('POST', '/api/store/settings', { cookie, body: { payoutProvider: payout.provider, payoutNumber: payout.number } })).status, 200);
  return { id: r.data.id, cookie, item, lat, lng };
}
async function deliver(d, st, qty) {
  const o = await http('POST', '/api/orders', { cookie: cust, body: { storeId: st.id, items: [{ id: st.item, qty }], lat: st.lat + 0.004, lng: st.lng, paymentMethod: 'cash' } });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  await http('POST', `/api/store/orders/${o.data.id}/accept`, { cookie: st.cookie, body: {} });
  await http('POST', `/api/store/orders/${o.data.id}/search`, { cookie: st.cookie, body: {} });
  const off = (await http('GET', '/api/driver/offers', { cookie: d.cookie })).data.offers.find((x) => x.orderId === o.data.id);
  assert.ok(off, 'offered');
  assert.equal((await http('POST', `/api/driver/offers/${off.id}/accept`, { cookie: d.cookie, body: {} })).status, 200);
  await http('POST', `/api/driver/orders/${o.data.id}/delivered`, { cookie: d.cookie, body: {} });
  await http('POST', `/api/customer/orders/${o.data.id}/confirm`, { cookie: cust, body: {} });
  return o.data.id;
}
const fin = async (d) => (await http('GET', '/api/driver/finance', { cookie: d.cookie })).data;
const storeBal = async (st) => (await http('GET', '/api/store/wallet', { cookie: st.cookie })).data.balance;
async function hook(gw, body, { signAs = gw } = {}) {
  const raw = JSON.stringify(body);
  return http('POST', gw === 'card' ? '/api/pay/webhook' : `/api/pay/webhook/${gw}`, { raw, headers: { 'X-Signature': sign(raw, signAs) } });
}
const link = (d, gateway, storeIds) => http('POST', '/api/driver/settlements/online', { cookie: d.cookie, body: { gateway, storeIds } });
const tokenOf = async (id) => (await app.db.one('SELECT pay_token FROM settlements WHERE id = $1', [id])).pay_token;
const events = async (kind) => app.db.query('SELECT * FROM security_events WHERE kind = $1 ORDER BY id', [kind]);

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
  cust = await login('/api/customer/login', { name: 'زبون', phone: '03999555', acceptTerms: true });
  await A('PUT', '/api/admin/delivery/settings', { claimWindowSec: 0, offerBatch: 5, cashLimit: 200 });
  await A('PUT', '/api/admin/plans', { payTo: { whish: '+96170111222', omt: '+96170111333', name: 'Aklatak', countries: 'LB' } });
});
after(() => app?.close?.());

test('online Whish settlement: exact amount fixed by the system → provider confirms → verified automatically, shares sent to the restaurants', async () => {
  const A1 = await makeStore(33.00, 35.50, { price: 10, payout: { provider: 'whish', number: '+96171555001' } });
  const B1 = await makeStore(33.002, 35.50, { price: 15 });           // no receiving number
  const d = await makeDriver(33.001, 35.501);
  await deliver(d, A1, 3); await deliver(d, B1, 2);                    // 30 + 30 = 60 $
  const f0 = await fin(d);
  assert.deepEqual(f0.ways.map((w) => [w.key, w.online, w.manual]), [['whish', true, true], ['omt', true, true], ['card', true, false]]);
  const l = await link(d, 'whish');
  assert.equal(l.status, 201, JSON.stringify(l.data));
  assert.equal(l.data.amount, 60);
  assert.match(l.data.url, /^https:\/\/whish\.example\/pay\//);
  const sent = calls.findLast((c) => c.url === PAY_ENV.WHISH_PAY_URL).body;
  assert.equal(sent.amount, 60, 'the payment page is made with the exact amount');
  assert.match(sent.callbackUrl, /\/api\/pay\/webhook\/whish$/);
  let row = await app.db.one('SELECT status, gateway FROM settlements WHERE id = $1', [l.data.id]);
  assert.deepEqual([row.status, row.gateway], ['awaiting_payment', 'whish']);
  assert.equal((await A('GET', '/api/admin/settlements?status=pending')).data.settlements.some((x) => x.id === l.data.id), false, 'not in the owner\'s to-check list');
  const token = await tokenOf(l.data.id);
  const ok = await hook('whish', { reference: token, status: 'paid', amount: 60, currency: 'USD', id: 'WH-1', payer: d.wallet });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  row = await app.db.one('SELECT status, paid_amount, provider_ref, decided_by FROM settlements WHERE id = $1', [l.data.id]);
  assert.deepEqual([row.status, row.paid_amount, row.provider_ref, row.decided_by], ['verified', 60, 'WH-1', null]);
  const f = (await fin(d)).finance;
  assert.deepEqual([f.restaurantCash, f.cashOrders], [0, true]);
  // restaurant A: credited 30 then paid out automatically to its Whish; B (no number) keeps 30 in its balance
  const wA = await app.db.one(`SELECT * FROM withdrawals WHERE account_type = 'store' AND account_id = $1`, [A1.id]);
  assert.deepEqual([wA.status, wA.amount, wA.provider, wA.settlement_id], ['paid', 30, 'whish', l.data.id]);
  assert.ok(wA.auto_ref);
  assert.equal(await storeBal(A1), 0);
  assert.equal(await storeBal(B1), 30);
  assert.ok((await A('GET', '/api/admin/finance/stores-owed')).data.stores.some((x) => x.id === B1.id && x.balance === 30));
  assert.equal((await app.db.query(`SELECT id FROM financial_ledger WHERE settlement_id = $1 AND kind = 'settlement_auto_verified'`, [l.data.id])).length, 1);
  // the provider retries: applied once
  assert.equal((await hook('whish', { reference: token, status: 'paid', amount: 60, currency: 'USD', id: 'WH-1', payer: d.wallet })).data.duplicate, true);
  assert.equal((await hook('whish', { reference: token, status: 'paid', amount: 60, id: 'WH-1b' })).status, 200);
  assert.equal((await app.db.query(`SELECT id FROM withdrawals WHERE settlement_id = $1`, [l.data.id])).length, 1, 'never paid out twice');
  assert.equal(await storeBal(B1), 30, 'never credited twice');
});

test('a smaller amount is refused: 230 $ owed, 200 $ arrives → not confirmed, still blocked, violation for the owner', async () => {
  const st = await makeStore(33.10, 35.50, { price: 10 });
  const d = await makeDriver(33.101, 35.501);
  await deliver(d, st, 18); await deliver(d, st, 5);                   // 230 $
  const l = await link(d, 'omt');
  assert.equal(l.data.amount, 230);
  const token = await tokenOf(l.data.id);
  assert.equal((await hook('omt', { reference: token, status: 'paid', amount: 200, currency: 'USD', id: 'OMT-9' })).status, 200);
  const row = await app.db.one('SELECT status, paid_amount FROM settlements WHERE id = $1', [l.data.id]);
  assert.deepEqual([row.status, row.paid_amount], ['correction', 200]);
  const f = (await fin(d)).finance;
  assert.deepEqual([f.restaurantCash, f.cashOrders], [230, false], 'nothing settled, cash orders still stopped');
  assert.equal(f.owed[0].amount, 230, 'the orders are free to settle again');
  assert.equal(await storeBal(st), 0);
  const ev = (await events('settle_amount_mismatch')).find((e) => e.settlement_id === l.data.id);
  assert.deepEqual([ev.severity, ev.driver_id, ev.amount, ev.expected], ['high', d.id, 200, 230]);
  // the owner sees it with the driver's name and count, and can suspend him from there
  const v = (await A('GET', '/api/admin/finance/violations')).data;
  assert.ok(v.events.some((e) => e.id === ev.id && e.driverCode === `D${d.id}`));
  assert.ok(v.drivers.some((x) => x.driver_id === d.id && x.high >= 1));
  assert.ok((await A('GET', '/api/admin/finance/overview')).data.overview.violations >= 1);
  assert.equal((await A('POST', `/api/admin/finance/violations/${ev.id}/seen`, {})).status, 200);
  assert.equal((await app.db.one('SELECT seen FROM security_events WHERE id = $1', [ev.id])).seen, 1);
  // a different currency is refused too
  const l2 = await link(d, 'omt');
  await hook('omt', { reference: await tokenOf(l2.data.id), status: 'paid', amount: 230, currency: 'LBP', id: 'OMT-10' });
  assert.equal((await app.db.one('SELECT status FROM settlements WHERE id = $1', [l2.data.id])).status, 'correction');
  // and then the exact amount works
  const l3 = await link(d, 'omt');
  await hook('omt', { reference: await tokenOf(l3.data.id), status: 'paid', amount: 230, currency: 'USD', id: 'OMT-11' });
  assert.equal((await app.db.one('SELECT status FROM settlements WHERE id = $1', [l3.data.id])).status, 'verified');
  assert.equal((await fin(d)).finance.cashOrders, true);
  assert.equal(await storeBal(st), 230, 'no receiving number: the money waits in the restaurant\'s balance');
});

test('forged and misrouted callbacks are refused and recorded', async () => {
  const st = await makeStore(33.20, 35.50);
  const d = await makeDriver(33.201, 35.501);
  await deliver(d, st, 2);
  const l = await link(d, 'whish');
  const token = await tokenOf(l.data.id);
  const raw = JSON.stringify({ reference: token, status: 'paid', amount: 20 });
  assert.equal((await http('POST', '/api/pay/webhook/whish', { raw, headers: { 'X-Signature': 'forged' } })).status, 401);
  assert.ok((await events('bad_signature')).length >= 1);
  // a valid OMT signature for a Whish link
  assert.equal((await hook('omt', { reference: token, status: 'paid', amount: 20, id: 'x1' })).status, 409);
  assert.equal((await events('settle_wrong_gateway')).at(-1).settlement_id, l.data.id);
  // the card secret can't confirm it either (signed for another gateway → bad signature on the whish route)
  assert.equal((await hook('whish', { reference: token, status: 'paid', amount: 20, id: 'x2' }, { signAs: 'card' })).status, 401);
  assert.equal((await app.db.one('SELECT status FROM settlements WHERE id = $1', [l.data.id])).status, 'awaiting_payment');
  assert.equal((await fin(d)).finance.restaurantCash, 20);
});

test('unpaid links expire and give the orders back; a failed payment closes the link; a late payment is still matched safely', async () => {
  const st = await makeStore(33.30, 35.50);
  const d = await makeDriver(33.301, 35.501);
  await deliver(d, st, 4);                                              // 40 $
  // failed payment
  const l1 = await link(d, 'whish');
  await hook('whish', { reference: await tokenOf(l1.data.id), status: 'failed', id: 'f1' });
  assert.equal((await app.db.one('SELECT status FROM settlements WHERE id = $1', [l1.data.id])).status, 'expired');
  assert.equal((await fin(d)).finance.owed[0].amount, 40);
  assert.ok((await events('settle_payment_failed')).some((e) => e.settlement_id === l1.data.id));
  // expiry by time
  const l2 = await link(d, 'whish');
  await app.db.query('UPDATE settlements SET expires_at = $1 WHERE id = $2', [new Date(Date.now() - 1000).toISOString(), l2.data.id]);
  const f = await fin(d);
  assert.equal((await app.db.one('SELECT status FROM settlements WHERE id = $1', [l2.data.id])).status, 'expired');
  assert.equal(f.finance.owed[0].amount, 40);
  // he paid it anyway, late: the orders are still unsettled → taken back and verified
  await hook('whish', { reference: await tokenOf(l2.data.id), status: 'paid', amount: 40, id: 'late-1' });
  assert.equal((await app.db.one('SELECT status FROM settlements WHERE id = $1', [l2.data.id])).status, 'verified');
  assert.equal((await fin(d)).finance.restaurantCash, 0);
  assert.equal(await storeBal(st), 40);
  // two links for the same orders: the newer one replaces the older; paying both → the second is held, never counted twice
  await deliver(d, st, 1);                                              // 10 $
  const a = await link(d, 'whish');
  const b = await link(d, 'omt');
  assert.equal((await app.db.one('SELECT status FROM settlements WHERE id = $1', [a.data.id])).status, 'expired', 'one live link at a time');
  await hook('omt', { reference: await tokenOf(b.data.id), status: 'paid', amount: 10, id: 'b-1' });
  await hook('whish', { reference: await tokenOf(a.data.id), status: 'paid', amount: 10, id: 'a-1' });
  assert.equal((await app.db.one('SELECT status FROM settlements WHERE id = $1', [a.data.id])).status, 'correction');
  assert.equal(await storeBal(st), 50, 'credited once');
  assert.ok((await events('settle_paid_twice')).some((e) => e.settlement_id === a.data.id));
});

test('card gateway works for settlements too (any country); the background job closes old links', async () => {
  const st = await makeStore(33.40, 35.50);
  const d = await makeDriver(33.401, 35.501);
  await deliver(d, st, 2);
  const l = await link(d, 'card');
  assert.match(l.data.url, /^https:\/\/pay\.example\//);
  await hook('card', { reference: await tokenOf(l.data.id), status: 'paid', amount: 20, id: 'c-1' });
  assert.equal((await app.db.one('SELECT status FROM settlements WHERE id = $1', [l.data.id])).status, 'verified');
  await deliver(d, st, 1);
  const l2 = await link(d, 'whish');
  await app.db.query('UPDATE settlements SET expires_at = $1 WHERE id = $2', [new Date(Date.now() - 1000).toISOString(), l2.data.id]);
  const { defineJobs } = await import('../src/jobs.js');
  const job = defineJobs({ db: app.db }).find((j) => j.name === 'expire-settlement-links');
  assert.ok((await job.run()).expired >= 1);
  assert.equal((await app.db.one('SELECT status FROM settlements WHERE id = $1', [l2.data.id])).status, 'expired');
  // a gateway that is not offered is refused
  assert.equal((await link(d, 'paypal')).status, 409);
});

test('by-hand settlements: wrong amounts, reused transfer numbers, other senders and rejections are all recorded', async () => {
  const st = await makeStore(33.50, 35.50);
  const d = await makeDriver(33.501, 35.501);
  await deliver(d, st, 3);                                              // 30 $
  const bad = await http('POST', '/api/driver/settlements', { cookie: d.cookie, body: { amount: 25, method: 'whish', reference: 'WH-7001' } });
  assert.equal(bad.status, 422);
  assert.ok((await events('settle_amount_mismatch')).some((e) => e.driver_id === d.id && e.amount === 25 && e.expected === 30));
  const okR = await http('POST', '/api/driver/settlements', { cookie: d.cookie, body: { amount: 30, method: 'whish', reference: 'WH-7002', senderNumber: '+96171222333', receipt: JPG } });
  assert.equal(okR.status, 201, JSON.stringify(okR.data));
  assert.ok((await events('settle_other_sender')).some((e) => e.settlement_id === okR.data.id));
  assert.equal((await A('POST', `/api/admin/settlements/${okR.data.id}/reject`, { note: 'لم يصل' })).status, 200);
  assert.ok((await events('settle_rejected')).some((e) => e.settlement_id === okR.data.id));
  // another driver tries the same transfer number
  const d2 = await makeDriver(33.5012, 35.5012);
  await http('POST', '/api/driver/availability', { cookie: d.cookie, body: { available: false } });
  await deliver(d2, st, 3);
  const s1 = await http('POST', '/api/driver/settlements', { cookie: d2.cookie, body: { amount: 30, method: 'omt', reference: 'OMT-55' } });
  assert.equal(s1.status, 201);
  const s2 = await http('POST', '/api/driver/settlements', { cookie: d.cookie, body: { amount: 30, method: 'omt', reference: 'omt-55' } });
  assert.equal(s2.status, 409);
  assert.ok((await events('settle_duplicate_reference')).some((e) => e.driver_id === d.id && e.severity === 'high'));
  // the transaction number of a payment already made ONLINE (test 1: WH-1) can't be claimed by hand either
  assert.equal((await http('POST', '/api/driver/settlements', { cookie: d.cookie, body: { amount: 30, method: 'whish', reference: 'wh-1' } })).data.error, 'duplicate_settlement');
  // the owner verifies d2's → the restaurant's share is sent automatically when it has a number (it has none here)
  const v = await A('POST', `/api/admin/settlements/${s1.data.id}/verify`, {});
  assert.equal(v.status, 200);
  assert.deepEqual(v.data.payouts.map((p) => p.status), ['no_number']);
});

test('restaurant payout failures wait for the owner; auto payouts can be switched off', async () => {
  const st = await makeStore(33.60, 35.50, { payout: { provider: 'whish', number: '+96171999999' } });   // the fake provider refuses it
  const d = await makeDriver(33.601, 35.501);
  await deliver(d, st, 2);
  const l = await link(d, 'whish');
  await hook('whish', { reference: await tokenOf(l.data.id), status: 'paid', amount: 20, id: 'p-1' });
  const w = await app.db.one(`SELECT * FROM withdrawals WHERE settlement_id = $1`, [l.data.id]);
  assert.equal(w.status, 'pending');
  assert.ok(w.last_error);
  assert.ok((await events('payout_failed')).some((e) => e.store_id === st.id));
  assert.ok((await A('GET', '/api/admin/withdrawals?status=pending')).data.withdrawals.some((x) => x.id === w.id && x.settlement_id === l.data.id));
  assert.equal((await A('POST', `/api/admin/withdrawals/${w.id}/paid`, {})).status, 200);
  assert.equal(await storeBal(st), 0);
  // switched off: the share stays in the restaurant's balance
  await A('PUT', '/api/admin/delivery/settings', { autoPayStores: 0 });
  await deliver(d, st, 1);
  const l2 = await link(d, 'whish');
  await hook('whish', { reference: await tokenOf(l2.data.id), status: 'paid', amount: 10, id: 'p-2' });
  assert.equal((await app.db.query(`SELECT id FROM withdrawals WHERE settlement_id = $1`, [l2.data.id])).length, 0);
  assert.equal(await storeBal(st), 10);
  await A('PUT', '/api/admin/delivery/settings', { autoPayStores: 1 });
});

test('per-country settlement ways: a country without Whish/OMT gets the owner\'s bank / wallet way (receipt required) and the card', async () => {
  await A('PUT', '/api/admin/plans', { payTo: { countries: 'LB', extra: [{ label: 'تحويل بنكي', account: 'SY12 3456 7890', name: 'Aklatak', countries: 'SY' }, { label: 'محفظة', account: '+963900', countries: 'JO' }] } });
  const plans = (await A('GET', '/api/admin/plans')).data;
  assert.deepEqual(plans.plans.payTo.extra.map((x) => [x.id, x.countries]), [['x1', 'SY'], ['x2', 'JO']]);
  assert.deepEqual(plans.gateways, { card: true, whish: true, omt: true, payoutWhish: true, payoutOmt: false, refund: true });
  const st = await makeStore(33.70, 35.50);
  const d = await makeDriver(33.701, 35.501);
  await deliver(d, st, 2);
  await app.db.query(`UPDATE drivers SET country = 'SY' WHERE id = $1`, [d.id]);   // (orders follow the driver's country; here only his settlement ways matter)
  const f = await fin(d);
  assert.deepEqual(f.ways.map((w) => [w.key, w.online, w.manual]), [['card', true, false], ['x1', false, true]]);
  assert.equal((await link(d, 'whish')).status, 409, 'no Whish in his country');
  assert.equal((await http('POST', '/api/driver/settlements', { cookie: d.cookie, body: { amount: 20, method: 'whish', reference: 'WH-1' } })).status, 422);
  const noRc = await http('POST', '/api/driver/settlements', { cookie: d.cookie, body: { amount: 20, method: 'x1', reference: 'BANK-1' } });
  assert.deepEqual([noRc.status, noRc.data.error], [422, 'receipt_required']);
  const ok = await http('POST', '/api/driver/settlements', { cookie: d.cookie, body: { amount: 20, method: 'x1', reference: 'BANK-1', receipt: JPG } });
  assert.equal(ok.status, 201);
  assert.equal((await A('GET', '/api/admin/settlements?status=pending')).data.settlements.find((x) => x.id === ok.data.id).methodLabel, 'تحويل بنكي');
  // a Lebanese driver doesn't see the Syrian bank way
  const lb = await makeDriver(33.80, 35.50);
  assert.ok(!(await fin(lb)).ways.some((w) => w.key === 'x1'));
  // card for settlements can be switched off
  await A('PUT', '/api/admin/plans', { payTo: { cardSettle: false } });
  assert.deepEqual((await fin(d)).ways.map((w) => w.key), ['x1']);
  await A('PUT', '/api/admin/plans', { payTo: { cardSettle: true } });
});

test('the store sets where it receives its money', async () => {
  const st = await makeStore(33.90, 35.50, { payout: { provider: 'omt', number: '+9613123456' } });
  const s = (await http('GET', '/api/store/settings', { cookie: st.cookie })).data;
  assert.deepEqual([s.payoutProvider, s.payoutNumber, s.autoPayout], ['omt', '9613123456', true]);
  assert.equal((await http('POST', '/api/store/settings', { cookie: st.cookie, body: { payoutProvider: 'paypal' } })).status, 422);
});

test('"we don\'t deliver to your area": the store refuses, the customer is told clearly, a card payment is refunded automatically', async () => {
  const st = await makeStore(34.50, 35.50);
  const o = await http('POST', '/api/orders', { cookie: cust, body: { storeId: st.id, items: [{ id: st.item, qty: 1 }], lat: 34.504, lng: 35.50, paymentMethod: 'card' } });
  assert.equal(o.status, 201);
  const token = o.data.payUrl.split('/').pop();
  await hook('card', { reference: token, status: 'paid', id: `ord-${token.slice(0, 5)}` });
  const r = await http('POST', `/api/store/orders/${o.data.id}/out-of-area`, { cookie: st.cookie, body: {} });
  assert.equal(r.status, 200);
  const v = (await http('GET', `/api/customer/orders/${o.data.id}`, { cookie: cust })).data.order;
  assert.deepEqual([v.status, v.closeReason, v.paymentStatus], ['rejected', 'out_of_area', 'refunded'], 'refunded through the gateway automatically');
  const rf = calls.findLast((c) => c.url === PAY_ENV.PAY_REFUND_URL).body;
  assert.deepEqual([rf.reference, rf.amount], [token, 13]);
  assert.equal((await app.db.query(`SELECT id FROM financial_ledger WHERE order_id = $1 AND kind = 'card_refunded'`, [o.data.id])).length, 1);
  assert.equal(await storeBal(st), 0, 'the store was never credited');
  // the gateway is down: the order waits, the job retries (5 times) then it stays in the owner's list
  const o3 = await http('POST', '/api/orders', { cookie: cust, body: { storeId: st.id, items: [{ id: st.item, qty: 1 }], lat: 34.504, lng: 35.50, paymentMethod: 'card' } });
  const t3 = o3.data.payUrl.split('/').pop();
  failRefunds.add(t3);
  await hook('card', { reference: t3, status: 'paid', id: `ord-${t3.slice(0, 5)}` });
  await http('POST', `/api/store/orders/${o3.data.id}/reject`, { cookie: st.cookie, body: {} });
  assert.equal((await http('GET', `/api/customer/orders/${o3.data.id}`, { cookie: cust })).data.order.paymentStatus, 'refund_pending');
  const { defineJobs } = await import('../src/jobs.js');
  const job = defineJobs({ db: app.db, payments: createPayments({ env: PAY_ENV, fetchImpl: fakePay, log: {} }) }).find((j) => j.name === 'auto-refunds');
  for (let i = 0; i < 6; i += 1) await job.run();
  const rl = (await A('GET', '/api/admin/finance/refunds')).data.refunds.find((x) => x.id === o3.data.id);
  assert.equal(rl.refund_tries, 5); assert.ok(rl.refund_error);
  failRefunds.delete(t3);
  await job.run();
  assert.equal((await app.db.one('SELECT payment_status FROM orders WHERE id = $1', [o3.data.id])).payment_status, 'refund_pending', 'after 5 tries only the owner decides');
  assert.equal((await A('POST', `/api/admin/orders/${o3.data.id}/refunded`, {})).status, 200);
  assert.equal((await http('POST', `/api/store/orders/${o.data.id}/out-of-area`, { cookie: st.cookie, body: {} })).status, 409, 'only a new order');
  // plain refusal keeps its own reason
  const o2 = await http('POST', '/api/orders', { cookie: cust, body: { storeId: st.id, items: [{ id: st.item, qty: 1 }], lat: 34.504, lng: 35.50, paymentMethod: 'cash' } });
  await http('POST', `/api/store/orders/${o2.data.id}/reject`, { cookie: st.cookie, body: {} });
  assert.equal((await http('GET', `/api/customer/orders/${o2.data.id}`, { cookie: cust })).data.order.closeReason, 'store');
  // another store can't touch it
  const other = await makeStore(34.60, 35.50);
  assert.equal((await http('POST', `/api/store/orders/${o2.data.id}/out-of-area`, { cookie: other.cookie, body: {} })).status, 404);
});
