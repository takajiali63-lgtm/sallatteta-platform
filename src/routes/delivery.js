// v7 delivery API: customers order in the app, the store sets the delivery fee (paid from its balance) and sends the
// order to the nearest drivers; the first driver to accept gets it; the store then forwards the customer's location.
// The platform is an intermediary: it never sells, prepares or delivers anything itself.
import { randomInt } from 'node:crypto';
import { hmacHex } from '../lib/security.js';
import { HttpError, readJson, sendJson } from '../lib/http.js';
import { Validator, imageBytesOk } from '../lib/validate.js';
import { normalizePhone } from '../lib/whatsapp.js';
import { hashPassword, verifyPassword, clientIp, sha256 } from '../lib/security.js';
import { sessionManager, checkCsrf } from '../lib/sessions.js';
import { haversineKm, isValidLatLng } from '../lib/geo.js';
import { isOpenNow } from '../lib/hours.js';
import { isCraft, isPrivateKind } from '../services/categories.js';
import { VISIBLE_SQL } from '../services/cooks.js';
import { DESIGNS } from '../services/designs.js';
import { renewSubscription } from '../services/cooks.js';
import { creditReferral } from '../services/referrals.js';
import { journal, driverFinance, createSettlement, settlementBreakdown, verifySettlement, releaseSettlement, storeFinance, storeDriverOrders, reverseOrder, financeOverview, expireLinks, confirmOnlineSettlement, failOnlineSettlement, payStoresFor, securityEvent, autoRefunds } from '../services/finance.js';
const VIS = `${VISIBLE_SQL} AND COALESCE(c.suspended,0) = 0`;   // paid, approved, not hidden, not suspended ($1 = now)
import {
  deliverySettings, balance, ledgerAdd, dispatch, addWarning, activeWarnings, setSuspended, accountExists,
  maybeOpenPayout, storeReport, driverReport, dispatchErrand, lockAccount,
  claimOffer, resolveClaims, driverBusy, settleOrder, storePrice,
} from '../services/delivery.js';

const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA';
const DOC_KINDS = ['selfie', 'idFront', 'idBack', 'vehicleFront', 'vehicleBack', 'registration', 'criminalRecord'];
const DOC_MAX = 450_000;        // ~330 KB per image (the app shrinks photos before sending) — keeps the free database small
const iso = () => new Date().toISOString();
const meters = (a, b, c, d) => Math.round(haversineKm(a, b, c, d) * 1000);
const cents2 = (n) => Math.round(Number(n || 0) * 100);
// an order whose money is not finished yet (old rule: driver owes the store / fee waiting; new rule: not completed, or its cash not settled)
const OWED = `((customer_total IS NULL AND (fee_state = 'awaiting' OR (driver_id IS NOT NULL AND self_delivery = 0 AND store_paid = 0)))
  OR (customer_total IS NOT NULL AND (financial_status IN ('open','disputed') OR EXISTS (SELECT 1 FROM driver_cash_entries ce WHERE ce.order_id = orders.id AND ce.status IN ('open','in_settlement')))))`;
const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

export function deliveryRoutes({ db, cfg, limiters, sms, push = { notify() {}, notifyAdmins() {} }, settings = null, cache = null, roads = null, payments = { payInEnabled: false, payOutEnabled: false } }) {
  const S = deliverySettings(db);
  const custSessions = sessionManager({ db, cfg, table: 'customer_sessions', cookie: 'st_cust', ownerColumn: 'customer_id', hours: 24 * 365 });
  const driverSessions = sessionManager({ db, cfg, table: 'driver_sessions', cookie: 'st_driver', ownerColumn: 'driver_id', hours: 24 * 90 });
  const cookSessions = sessionManager({ db, cfg, table: 'cook_sessions', cookie: 'st_cook', ownerColumn: 'cook_id', hours: 24 * 60 });
  const adminSessions = sessionManager({ db, cfg, table: 'admin_sessions', cookie: 'st_admin', ownerColumn: 'admin_id', hours: 12 });

  const ip = (req) => clientIp(req, cfg.trustProxy);
  async function limit(limiter, key) {
    if (!limiter) return;
    const r = await limiter.take(key);
    if (!r.ok) throw new HttpError(429, 'rate_limited', { retryAfterSec: r.retryAfterSec });
  }

  // ---------- guards ----------
  const customer = (fn) => async (req, res, m) => {
    const id = await custSessions.ownerId(req);
    if (!id) throw new HttpError(401, 'unauthorized');
    if (req.method !== 'GET') checkCsrf(req);
    const c = await db.one('SELECT id, status FROM customers WHERE id = $1', [id]);
    if (!c) throw new HttpError(401, 'unauthorized');
    if (c.status === 'suspended' && req.method !== 'GET') throw new HttpError(403, 'account_suspended');
    return fn(req, res, m, id);
  };
  const store = (fn) => async (req, res, m) => {
    const id = await cookSessions.ownerId(req);
    if (!id) throw new HttpError(401, 'unauthorized');
    if (req.method !== 'GET') checkCsrf(req);
    const c = await db.one('SELECT id, status, suspended FROM cooks WHERE id = $1', [id]);
    if (!c || c.status === 'rejected') throw new HttpError(401, 'unauthorized');
    if (Number(c.suspended) && req.method !== 'GET') throw new HttpError(403, 'account_suspended');
    return fn(req, res, m, id);
  };
  const driver = (fn, { activeOnly = true } = {}) => async (req, res, m) => {
    const id = await driverSessions.ownerId(req);
    if (!id) throw new HttpError(401, 'unauthorized');
    if (req.method !== 'GET') checkCsrf(req);
    const d = await db.one('SELECT id, status FROM drivers WHERE id = $1', [id]);
    if (!d || d.status === 'rejected') throw new HttpError(401, 'unauthorized');
    if (activeOnly && d.status !== 'active') throw new HttpError(403, d.status === 'suspended' ? 'account_suspended' : 'account_pending');
    return fn(req, res, m, id);
  };
  const owner = (fn) => async (req, res, m) => {
    const id = await adminSessions.ownerId(req);
    if (!id) throw new HttpError(401, 'unauthorized');
    if (req.method !== 'GET') checkCsrf(req);
    const a = await db.one('SELECT id, role FROM admin_users WHERE id = $1 AND disabled = 0', [id]);
    if (!a) throw new HttpError(401, 'unauthorized');
    if (a.role === 'agent') throw new HttpError(403, 'forbidden');
    await limit(limiters.admin, `a${a.id}`);
    return fn(req, res, m, a);
  };

  const q = (req) => new URL(req.url, 'http://x').searchParams;
  const ref = (id) => `AKL${id}`;
  // Each read that matters first settles finished acceptance windows (nearest driver wins), then notifies.
  async function settleClaims() {
    await resolveClaims(db, 'order', { onWon: async (w) => {
      push.notify('driver', w.driverId, { title: 'Aklatak', body: `✅ الطلب ${ref(w.id)} لك`, url: '/driver' });
      for (const l of w.losers) push.notify('driver', l, { title: 'Aklatak', body: `الطلب ${ref(w.id)} محجوز لسائق أقرب`, url: '/driver' });
      const o = await db.one('SELECT cook_id, customer_id FROM orders WHERE id = $1', [w.id]);
      if (o) { push.notify('store', o.cook_id, { title: 'Aklatak', body: `🛵 قَبِل سائق الطلب ${ref(w.id)}`, url: '/store' }); push.notify('customer', o.customer_id, { title: 'Aklatak', body: '🛵 تم تعيين سائق لطلبك', url: `/#/o/${w.id}` }); }
    } });
    await resolveClaims(db, 'errand', { onWon: async (w) => {
      push.notify('driver', w.driverId, { title: 'Aklatak', body: '✅ طلب الزبون لك', url: '/driver' });
      const e = await db.one('SELECT customer_id FROM errands WHERE id = $1', [w.id]);
      if (e) push.notify('customer', e.customer_id, { title: 'Aklatak', body: '🛵 قَبِل سائق طلبك', url: `/#/e/${w.id}` });
    } });
  }
  const toIso = (v) => (v instanceof Date ? v.toISOString() : v ?? '');
  // tell the drivers who just got an offer (phone notification)
  async function notifyOffers(orderId) {
    const rows = await db.query(`SELECT driver_id FROM order_offers WHERE order_id = $1 AND status = 'sent'`, [orderId]);
    for (const r of rows) push.notify('driver', r.driver_id, { title: 'Aklatak', body: `🛵 طلب توصيل جديد ${ref(orderId)}`, url: '/driver' });
  }
  async function notifyErrand(id) {
    for (const r of await db.query(`SELECT driver_id FROM errand_offers WHERE errand_id = $1 AND status = 'sent'`, [id])) push.notify('driver', r.driver_id, { title: 'Aklatak', body: '🛵 طلب جديد من زبون', url: '/driver' });
  }
  async function broadcastsFor(audience, id) {
    const table = audience === 'drivers' ? 'drivers' : 'cooks';
    const me = await db.one(`SELECT COALESCE(country, 'LB') AS country FROM ${table} WHERE id = $1`, [id]);
    return db.query(`SELECT id, body, expires_at, created_at FROM broadcasts WHERE audience = $1 AND (country IS NULL OR country = $2) AND (expires_at IS NULL OR expires_at > $3) ORDER BY id DESC LIMIT 20`,
      [audience, me?.country || 'LB', iso()]);
  }
  const PLAN_DEFAULTS = {
    store: { delivery: { 1: { price: 15 }, 3: { price: 40 }, 12: { price: 150 } }, basic: { 1: { price: 10 }, 3: { price: 27 }, 12: { price: 100 } } },
    branchPercent: 50,
    driverJobs: { 1: { price: 10 }, 3: { price: 27 }, 12: { price: 100 } },
  };
  async function getPlans() {
    const row = await db.one(`SELECT value FROM app_meta WHERE key = 'plans'`);
    let saved = {};
    try { saved = row ? JSON.parse(row.value) : {}; } catch { saved = {}; }
    const merge = (def, got) => Object.fromEntries(Object.keys(def).map((k) => [k, { price: Number(got?.[k]?.price ?? def[k].price), hidden: !!got?.[k]?.hidden }]));
    return {
      store: { delivery: merge(PLAN_DEFAULTS.store.delivery, saved.store?.delivery), basic: merge(PLAN_DEFAULTS.store.basic, saved.store?.basic) },
      branchPercent: Number(saved.branchPercent ?? PLAN_DEFAULTS.branchPercent),
      driverJobs: merge(PLAN_DEFAULTS.driverJobs, saved.driverJobs),
      // where stores send money (top-ups, renewals): the platform's own Whish / OMT numbers, set by the owner
      // + countries where Whish/OMT are offered to drivers for settlements, other ways per country (bank, local wallet…),
      // and whether drivers may settle with the card gateway (works in any country)
      payTo: {
        whish: String(saved.payTo?.whish || ''), omt: String(saved.payTo?.omt || ''), name: String(saved.payTo?.name || ''),
        countries: String(saved.payTo?.countries ?? 'LB'), cardSettle: saved.payTo?.cardSettle !== false,
        extra: (Array.isArray(saved.payTo?.extra) ? saved.payTo.extra : []).slice(0, 6).map((x, i) => ({ id: `x${i + 1}`, label: String(x.label || ''), account: String(x.account || ''), name: String(x.name || ''), countries: String(x.countries || '') })),
      },
    };
  }
  const countryList = (txt) => String(txt || '').toUpperCase().split(/[\s,،]+/).filter((c) => /^[A-Z]{2}$/.test(c));
  const inCountries = (txt, c) => { const l = countryList(txt); return !l.length || l.includes(String(c || 'LB').toUpperCase()); };
  /** The settlement ways a driver of this country sees: online (amount fixed, confirmed automatically) and by hand. */
  function settleWaysFor(plans, country) {
    const p = plans.payTo;
    const ways = [];
    for (const k of ['whish', 'omt']) {
      if (!inCountries(p.countries, country)) continue;
      const online = payments.gatewayOn?.(k) || false;
      if (online || p[k]) ways.push({ key: k, label: k === 'whish' ? 'Whish Money' : 'OMT', account: p[k], name: p.name, online, manual: !!p[k] });
    }
    if (p.cardSettle && payments.gatewayOn?.('card')) ways.push({ key: 'card', label: 'card', account: '', name: '', online: true, manual: false });
    for (const x of p.extra) if (x.label && x.account && inCountries(x.countries, country)) ways.push({ key: x.id, label: x.label, account: x.account, name: x.name, online: false, manual: true });
    return ways;
  }
  async function setPlans(b) {
    const cur = await getPlans();
    const num = (x, fb) => { const n = Number(x); if (!Number.isFinite(n) || n < 0 || n > 100000) throw new HttpError(422, 'validation_failed', { fields: { price: 'invalid' } }); return Math.round(n * 100) / 100; };
    const take = (g, src) => { if (!src) return; for (const k of Object.keys(g)) if (src[k]) { if (src[k].price !== undefined) g[k].price = num(src[k].price); if (src[k].hidden !== undefined) g[k].hidden = !!src[k].hidden; } };
    take(cur.store.delivery, b.store?.delivery); take(cur.store.basic, b.store?.basic); take(cur.driverJobs, b.driverJobs);
    if (b.branchPercent !== undefined) cur.branchPercent = num(b.branchPercent);
    if (b.payTo) {
      for (const k of ['whish', 'omt']) if (b.payTo[k] !== undefined) {
        const v = String(b.payTo[k] || '').trim();
        if (v && !/^\+?[0-9 ]{6,20}$/.test(v)) throw new HttpError(422, 'validation_failed', { fields: { [`payTo.${k}`]: 'invalid' } });
        cur.payTo[k] = v;
      }
      if (b.payTo.name !== undefined) cur.payTo.name = String(b.payTo.name || '').trim().slice(0, 60);
      if (b.payTo.countries !== undefined) cur.payTo.countries = countryList(b.payTo.countries).join(',');
      if (b.payTo.cardSettle !== undefined) cur.payTo.cardSettle = !!b.payTo.cardSettle;
      if (Array.isArray(b.payTo.extra)) {
        cur.payTo.extra = b.payTo.extra.slice(0, 6).map((x, i) => ({
          id: `x${i + 1}`, label: String(x?.label || '').trim().slice(0, 40), account: String(x?.account || '').trim().slice(0, 60),
          name: String(x?.name || '').trim().slice(0, 60), countries: countryList(x?.countries).join(','),
        })).filter((x) => x.label && x.account).map((x, i) => ({ ...x, id: `x${i + 1}` }));
      }
    }
    const v = JSON.stringify(cur);
    if (await db.one(`SELECT key FROM app_meta WHERE key = 'plans'`)) await db.query(`UPDATE app_meta SET value = $1 WHERE key = 'plans'`, [v]);
    else await db.query(`INSERT INTO app_meta (key, value) VALUES ('plans', $1)`, [v]);
    return cur;
  }
  const gone = (e) => (['offer_gone', 'driver_busy', 'cash_limit_reached'].includes(e?.code) ? new HttpError(409, e.code) : e);
  const cOf = (req) => { const c = String(q(req).get('country') || '').toUpperCase(); return /^[A-Z]{2}$/.test(c) ? c : null; };
  // after a settlement is confirmed: tell each restaurant, and the owner about shares that could not be sent automatically
  async function afterStorePayouts(settlementId, stores, paidOut) {
    for (const st of stores || []) {
      const p = paidOut.find((x) => x.storeId === st.storeId);
      const body = p?.status === 'paid' ? `💵 حُوِّل لك ${st.amount}$ على ${p.provider === 'omt' ? 'OMT' : 'Whish'} من تسوية سائق S-${settlementId}` : `💵 وصلك ${st.amount}$ من تسوية سائق S-${settlementId}`;
      push.notify('store', st.storeId, { title: 'Aklatak', body, url: '/store' });
    }
    for (const p of paidOut.filter((x) => x.status === 'failed')) {
      await securityEvent(db, { kind: 'payout_failed', severity: 'warn', storeId: p.storeId, settlementId, amount: p.amount, detail: String(p.error || '').slice(0, 200) });
    }
    const waiting = paidOut.filter((x) => x.status === 'failed' || x.status === 'manual');
    if (waiting.length) push.notifyAdmins({ title: 'Aklatak — الإدارة', body: `💸 ${waiting.length} تحويل لمطاعم بانتظارك (S-${settlementId})`, url: '/admin/#dx-payouts' });
  }
  const ok = (res, data = { ok: true }, status = 200) => sendJson(res, status, data);
  // Distance by road (Geoapify) — the straight line only when that isn't available (then approx = true).
  const road = async (a, b, track = null) => {
    if (a?.lat == null || b?.lat == null) return { m: null, approx: true };
    if (roads) return roads.distance({ lat: Number(a.lat), lng: Number(a.lng) }, { lat: Number(b.lat), lng: Number(b.lng) }, { track });
    return { m: meters(a.lat, a.lng, b.lat, b.lng), approx: true };
  };
  const firstName = (n) => String(n || '').trim().split(/\s+/)[0];
  // what the customer may choose: card only when the store accepts it AND the payment provider is connected
  // A paid card order that won't be delivered: the payment is marked "to refund" (provider refund or by hand), recorded.
  async function refundIfPaid(t, orderId) {
    const o = await t.one('SELECT id, cook_id, payment_method, payment_status, customer_total, currency FROM orders WHERE id = $1', [orderId]);
    if (o?.payment_method !== 'card' || o.payment_status !== 'paid') return false;
    await t.query(`UPDATE orders SET payment_status = 'refund_pending', financial_status = 'reversed' WHERE id = $1`, [o.id]);
    await t.query(`UPDATE order_payments SET status = 'refund_pending', updated_at = $1 WHERE order_id = $2 AND status = 'paid'`, [iso(), o.id]);
    await journal(t, { kind: 'card_refund_due', orderId: o.id, storeId: o.cook_id, amount: -Number(o.customer_total), currency: o.currency || 'USD', method: 'card' });
    if (!payments.refundEnabled) push.notifyAdmins({ title: 'Aklatak — الإدارة', body: `↩️ استرداد بطاقة مطلوب للطلب ${ref(o.id)}`, url: '/admin/#dx-finance' });
    return true;
  }
  // refund through the gateway right away (the background job retries); a refund that keeps failing goes to the owner
  async function refundNow(orderId) {
    for (const r of await autoRefunds(db, payments, { orderId })) {
      if (r.failed) push.notifyAdmins({ title: 'Aklatak — الإدارة', body: `↩️ تعذّر الاسترداد التلقائي للطلب ${ref(r.orderId)} — أعِده يدوياً`, url: '/admin/#dx-finance' });
      else push.notify('customer', r.customerId, { title: 'Aklatak', body: `↩️ أُعيد إليك ${r.amount}$ للطلب ${ref(r.orderId)}`, url: `/#/o/${r.orderId}` });
    }
  }
  const payMethodsOf = (v) => { const want = String(v || 'cash'); const out = []; if (want !== 'card') out.push('cash'); if (want !== 'cash' && payments.payInEnabled) out.push('card'); return out.length ? out : ['cash']; };
  const hasPhoto = async (driverId) => !!(await db.one(`SELECT id FROM driver_documents WHERE driver_id = $1 AND kind = 'selfie'`, [driverId]));
  // The nearest drivers who got a request: photo, first name, vehicle and how far they are — never their phone
  // (the phone appears only once a driver has accepted and got the job).
  async function candidates(kind, id, target) {
    const [table, fk] = kind === 'order' ? ['order_offers', 'order_id'] : ['errand_offers', 'errand_id'];
    const rows = await db.query(`SELECT f.driver_id, f.claimed_at, d.full_name, d.vehicle, d.lat, d.lng FROM ${table} f JOIN drivers d ON d.id = f.driver_id
      WHERE f.${fk} = $1 AND f.status = 'sent' ORDER BY f.id`, [id]);
    const out = [];
    for (const r of rows) {
      const dist = await road({ lat: r.lat, lng: r.lng }, target, `d${r.driver_id}`);
      out.push({ id: r.driver_id, name: firstName(r.full_name), vehicle: r.vehicle, m: dist.m, approx: dist.approx, accepted: !!r.claimed_at, photo: await hasPhoto(r.driver_id) });
    }
    return out.sort((a, b) => (a.m ?? 1e9) - (b.m ?? 1e9));
  }
  async function sendPhoto(res, driverId) {
    const doc = await db.one(`SELECT mime, data FROM driver_documents WHERE driver_id = $1 AND kind = 'selfie' ORDER BY id DESC`, [driverId]);
    if (!doc) throw new HttpError(404, 'not_found');
    const body = Buffer.from(doc.data, 'base64');
    res.writeHead(200, { 'Content-Type': doc.mime, 'Content-Length': body.length, 'Cache-Control': 'private, max-age=600', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  }
  const mustOrder = async (sql, params) => {
    const o = await db.one(sql, params);
    if (!o) throw new HttpError(404, 'not_found');
    return o;
  };
  const stateError = () => new HttpError(409, 'invalid_state');

  async function warningsOf(type, id) {
    const s = await S.get();
    const rows = await db.query(`SELECT id, reason, created_at, expires_at FROM warnings WHERE account_type = $1 AND account_id = $2 AND expires_at > $3 ORDER BY id DESC`, [type, id, iso()]);
    return { count: rows.length, max: s.maxWarnings, items: rows.map((r) => ({ id: r.id, reason: r.reason, at: r.created_at, expiresAt: r.expires_at })) };
  }

  // ---------- customer sign-in (name + phone; SMS code once a provider key is set) ----------
  async function issueCode(phone) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await db.query('DELETE FROM otp_codes WHERE phone = $1', [phone]);
    await db.query('INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES ($1,$2,$3)',
      [phone, sha256(`${phone}:${code}`), new Date(Date.now() + 10 * 60_000).toISOString()]);
    await sms.send(phone, `${cfg.brand?.name || 'Aklatak'}: ${code}`);
  }
  async function checkCode(phone, code) {
    const row = await db.one('SELECT id, code_hash, expires_at, attempts FROM otp_codes WHERE phone = $1 ORDER BY id DESC', [phone]);
    if (!row || row.expires_at < iso() || row.attempts >= 5) throw new HttpError(401, 'code_expired');
    if (row.code_hash !== sha256(`${phone}:${String(code || '').trim()}`)) {
      await db.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      throw new HttpError(401, 'code_invalid');
    }
    await db.query('DELETE FROM otp_codes WHERE phone = $1', [phone]);
  }
  function phoneOf(v, body, field = 'phone') {
    const p = normalizePhone(body[field], body.country || 'LB');
    if (!p) v.fail(field, 'invalid');
    return p;
  }

  async function customerMe(id) {
    const c = await db.one('SELECT id, name, phone, status, country FROM customers WHERE id = $1', [id]);
    const addresses = await db.query('SELECT id, label, lat, lng, details FROM customer_addresses WHERE customer_id = $1 ORDER BY id', [id]);
    const favorites = (await db.query('SELECT cook_id FROM customer_favorites WHERE customer_id = $1', [id])).map((r) => r.cook_id);
    return { id: c.id, name: c.name, phone: c.phone, status: c.status, country: c.country, addresses, favorites, warnings: await warningsOf('customer', id), smsVerification: sms.enabled };
  }


  // ---------- subscription renewal ----------
  const MONTHS_PLAN = { 1: 'monthly', 3: 'quarterly', 6: 'semiannual', 12: 'yearly' };
  async function rootOf(cookId) {
    const c = await db.one('SELECT id, parent_id FROM cooks WHERE id = $1', [cookId]);
    return c.parent_id || c.id;
  }
  async function branchCount(rootId) {
    return (await db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM cooks WHERE (id = $1 OR parent_id = $1) AND status <> 'rejected'`, [rootId])).n || 1;
  }
  async function subscriptionInfo(cookId) {
    const rootId = await rootOf(cookId);
    const root = await db.one('SELECT id, full_name, delivery_mode, booking, wa_orders FROM cooks WHERE id = $1', [rootId]);
    const sub = await db.one('SELECT plan, status, start_date, expiry_date FROM subscriptions WHERE cook_id = $1 ORDER BY id DESC LIMIT 1', [rootId]);
    const plans = await getPlans();
    const branches = await branchCount(rootId);
    const options = ['delivery', 'basic'].map((kind) => ({
      kind,
      months: Object.entries(plans.store[kind]).filter(([, x]) => !x.hidden).map(([mo]) => ({ months: Number(mo), price: storePrice(plans, kind, Number(mo), branches) })),
    }));
    const pending = await db.query(`SELECT id, kind, months, amount, created_at FROM renewals WHERE cook_id = $1 AND status = 'pending' ORDER BY id DESC`, [rootId]);
    const exp = sub?.expiry_date ? (sub.expiry_date instanceof Date ? sub.expiry_date.toISOString() : String(sub.expiry_date)) : null;
    return {
      kind: root.delivery_mode === 'delivery' ? 'delivery' : 'basic', deliveryMode: root.delivery_mode,
      plan: sub?.plan || null, status: sub?.status || null, expiry: exp, active: sub?.status === 'active' && !!exp && Date.parse(exp) > Date.now(),
      branches, branchPercent: plans.branchPercent, options, payTo: plans.payTo, pending, online: !!payments.payInEnabled, isBranch: rootId !== cookId, mainName: root.full_name,
    };
  }
  async function renewalChoice(cookId, b) {
    const v = new Validator();
    const kind = v.oneOf('kind', b.kind, ['delivery', 'basic']);
    const months = v.oneOf('months', Number(b.months), [1, 3, 12]);
    v.assert();
    const plans = await getPlans();
    if (plans.store[kind][months]?.hidden) throw new HttpError(422, 'validation_failed', { fields: { months: 'invalid' } });
    const rootId = await rootOf(cookId);
    const branches = await branchCount(rootId);
    const name = (await db.one('SELECT full_name FROM cooks WHERE id = $1', [rootId]))?.full_name || '';
    return { rootId, kind, months, branches, amount: storePrice(plans, kind, months, branches), name };
  }
  /** Extend the subscription of the main account (branches follow it) and switch "with drivers" on/off as chosen. */
  async function applyRenewal(rootId, kind, months, branch = null) {
    if (branch?.branchId) {   // payment for one extra branch: the branch goes live at once
      await db.query(`UPDATE cooks SET status = 'approved' WHERE id = $1 AND parent_id = $2`, [Number(branch.branchId), rootId]);
      cache?.clear?.();
      return;
    }
    await renewSubscription(db, rootId, { plan: MONTHS_PLAN[months] || 'monthly', months, paymentStatus: 'paid' });
    const cur = await db.one('SELECT delivery_mode FROM cooks WHERE id = $1', [rootId]);
    if (kind === 'delivery' && cur.delivery_mode !== 'delivery') await db.query(`UPDATE cooks SET delivery_mode = 'delivery', plan_delivery = 1 WHERE id = $1 OR parent_id = $1`, [rootId]);
    if (kind === 'basic' && cur.delivery_mode === 'delivery') await db.query(`UPDATE cooks SET delivery_mode = 'self', plan_delivery = 0 WHERE id = $1 OR parent_id = $1`, [rootId]);
    await creditReferral(db, rootId, 'renew').catch(() => null);   // the referral link's commission, if any
    cache?.clear?.();
  }

  /** Price of one more branch until the end of the current subscription: (monthly price × branch %) × months left. */
  async function branchFee(rootId) {
    const plans = await getPlans();
    const root = await db.one('SELECT delivery_mode FROM cooks WHERE id = $1', [rootId]);
    const kind = root.delivery_mode === 'delivery' ? 'delivery' : 'basic';
    const sub = await db.one('SELECT expiry_date FROM subscriptions WHERE cook_id = $1 ORDER BY id DESC LIMIT 1', [rootId]);
    const left = sub?.expiry_date ? Math.max(1, Math.ceil((Date.parse(sub.expiry_date instanceof Date ? sub.expiry_date.toISOString() : sub.expiry_date) - Date.now()) / (30.44 * 864e5))) : 1;
    const monthly = Number(plans.store[kind]?.[1]?.price || 0) * Number(plans.branchPercent) / 100;
    return { kind, months: left, monthly: Math.round(monthly * 100) / 100, fee: Math.round(monthly * left * 100) / 100 };
  }

  // ---------- store listing for customers ----------
  function storeView(c, lat, lng) {
    const hours = parseJson(c.hours);
    const open = Number(c.accepting_orders ?? 1) === 1 && isOpenNow(hours) !== false;
    return {
      id: c.id, name: c.full_name, kind: c.kind, specialty: c.specialty || null, photoUrl: c.photo_url || (Number(c.has_photo) ? `/media/cooks/${c.id}.jpg` : null),
      delivery: c.delivery_mode === 'delivery' || c.delivery_mode === 'self', ownDelivery: c.delivery_mode === 'self',
      // "order on WhatsApp" stays an option next to ordering in the app (the store can turn it off)
      whatsapp: c.delivery_mode === 'none' || Number(c.wa_orders ?? 1) === 1 ? c.whatsapp : null, booking: !!Number(c.booking || 0),
      pinned: !!Number(c.pinned), open,
      distanceM: Number.isFinite(lat) ? meters(lat, lng, c.lat, c.lng) : null,
      // Homes (home cooks, craftspeople) never reveal their exact location.
      ...(isPrivateKind(c.kind) ? {} : { lat: c.lat, lng: c.lng }),
    };
  }

  return [
    // ===== customer account =====
    ['GET', /^\/api\/customer\/config$/, async (req, res) => { const s = await S.get(); return ok(res, { smsVerification: sms.enabled, cartIdleMin: s.cartIdleMin, maxPurchaseValue: s.maxPurchaseValue }); }],

    ['POST', /^\/api\/customer\/code$/, async (req, res) => {
      checkCsrf(req);
      const body = await readJson(req);
      const v = new Validator();
      const phone = phoneOf(v, body);
      v.assert();
      await limit(limiters.login, `otp:${ip(req)}`);
      await limit(limiters.login, `otp:${phone}`);
      if (!sms.enabled) return ok(res, { codeRequired: false });
      try { await issueCode(phone); } catch { throw new HttpError(503, 'sms_unavailable'); }
      return ok(res, { codeRequired: true });
    }],

    ['POST', /^\/api\/customer\/login$/, async (req, res) => {
      checkCsrf(req);
      await limit(limiters.login, `cust:${ip(req)}`);
      const body = await readJson(req);
      const v = new Validator();
      const phone = phoneOf(v, body);
      v.assert();
      if (sms.enabled) await checkCode(phone, body.code);
      let c = await db.one('SELECT id, status FROM customers WHERE phone = $1', [phone]);
      if (!c) {
        const name = v.text('name', body.name, { min: 2, max: 60 });
        if (body.acceptTerms !== true) v.fail('acceptTerms', 'required');
        v.assert();
        c = await db.one(`INSERT INTO customers (name, phone, country, locale, terms_accepted_at) VALUES ($1,$2,$3,$4,$5) RETURNING id, status`,
          [name, phone, String(body.country || 'LB').slice(0, 2).toUpperCase(), body.locale ? String(body.locale).slice(0, 5) : null, iso()]);
      }
      if (c.status === 'suspended') throw new HttpError(403, 'account_suspended');
      const cookie = await custSessions.create(c.id);
      return sendJson(res, 200, await customerMe(c.id), { 'Set-Cookie': cookie });
    }],

    ['POST', /^\/api\/customer\/logout$/, async (req, res) => {
      checkCsrf(req);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': await custSessions.destroy(req) });
    }],

    ['GET', /^\/api\/customer\/me$/, customer(async (req, res, m, id) => ok(res, await customerMe(id)))],

    ['POST', /^\/api\/customer\/addresses$/, customer(async (req, res, m, id) => {
      const b = await readJson(req);
      const v = new Validator();
      const label = v.text('label', b.label, { max: 40 });
      const lat = Number(b.lat), lng = Number(b.lng);
      if (!isValidLatLng(lat, lng)) v.fail('location', 'invalid');
      const details = v.text('details', b.details, { max: 300, required: false, multiline: true });
      v.assert();
      const n = await db.one('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM customer_addresses WHERE customer_id = $1', [id]);
      if (n.n >= 10) throw new HttpError(409, 'too_many_addresses');
      const row = await db.one('INSERT INTO customer_addresses (customer_id, label, lat, lng, details) VALUES ($1,$2,$3,$4,$5) RETURNING id', [id, label, lat, lng, details]);
      return ok(res, { id: row.id }, 201);
    })],

    ['DELETE', /^\/api\/customer\/addresses\/(\d+)$/, customer(async (req, res, m, id) => {
      await db.query('DELETE FROM customer_addresses WHERE id = $1 AND customer_id = $2', [Number(m[1]), id]);
      return ok(res);
    })],

    ['POST', /^\/api\/customer\/favorites\/(\d+)$/, customer(async (req, res, m, id) => {
      const b = await readJson(req);
      const cookId = Number(m[1]);
      if (b.on === false) await db.query('DELETE FROM customer_favorites WHERE customer_id = $1 AND cook_id = $2', [id, cookId]);
      else {
        if (!(await db.one('SELECT id FROM cooks WHERE id = $1', [cookId]))) throw new HttpError(404, 'not_found');
        await db.query('INSERT INTO customer_favorites (customer_id, cook_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, cookId]);
      }
      return ok(res);
    })],

    // Google Play requires in-app account deletion. Orders stay for the store's records, without the person's details.
    ['POST', /^\/api\/customer\/me\/delete$/, customer(async (req, res, m, id) => {
      await db.query('DELETE FROM customer_addresses WHERE customer_id = $1', [id]);
      await db.query('DELETE FROM customer_favorites WHERE customer_id = $1', [id]);
      await db.query(`UPDATE customers SET name = 'محذوف', phone = $1 WHERE id = $2`, [`deleted-${id}-${Date.now()}`, id]);
      await custSessions.destroyAll(id);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': await custSessions.destroy(req) });
    })],

    // ===== stores for customers =====
    ['GET', /^\/api\/delivery\/stores$/, async (req, res) => {
      const p = q(req);
      const lat = Number(p.get('lat')), lng = Number(p.get('lng'));
      const hasLoc = isValidLatLng(lat, lng);
      const kind = p.get('category');
      const text = String(p.get('q') || '').trim().slice(0, 60);
      const params = [iso()];
      let where = VIS;
      if (kind) { params.push(kind); where += ` AND c.kind = $${params.length}`; }
      const country = String(p.get('country') || '').toUpperCase();
      if (/^[A-Z]{2}$/.test(country)) { params.push(country); where += ` AND COALESCE(c.country, 'LB') = $${params.length}`; }   // every country is separate
      const site = settings?.get?.() || {};
      if (/^[A-Z]{2}$/.test(country) && ((site.countriesHidden || []).includes(country) || (site.countriesRemoved || []).includes(country))) return ok(res, { stores: [] });
      const catOff = /^[A-Z]{2}$/.test(country) ? (site.countryCatsHidden?.[country] || []) : [];
      const deletedCats = (site.categories || []).filter((c) => c.deleted).map((c) => c.key);
      for (const k of [...catOff, ...deletedCats]) { params.push(k); where += ` AND c.kind <> $${params.length}`; }
      if (text) {
        params.push(`%${text.toLowerCase()}%`);
        const i = params.length;
        where += ` AND (LOWER(c.full_name) LIKE $${i} OR LOWER(COALESCE(c.specialty,'')) LIKE $${i}
                   OR EXISTS (SELECT 1 FROM menu_items mi WHERE mi.cook_id = c.id AND mi.is_available = 1 AND LOWER(mi.name) LIKE $${i}))`;
      }
      const rows = await db.query(`SELECT c.id, c.full_name, c.kind, c.specialty, c.photo_url, CASE WHEN c.photo IS NULL THEN 0 ELSE 1 END AS has_photo, c.delivery_mode, c.whatsapp, c.wa_orders, c.pinned, c.accepting_orders, c.hours, c.lat, c.lng, c.booking FROM cooks c WHERE ${where}`, params);
      let list = rows.map((c) => storeView(c, hasLoc ? lat : NaN, lng));
      // browsing: what's around; searching by name: every shop of the country, wherever it is (nearest first when known)
      if (hasLoc && !text) list = list.filter((s) => s.distanceM <= 25_000);
      list.sort((a, b) => (b.pinned - a.pinned) || ((a.distanceM ?? 0) - (b.distanceM ?? 0)));
      return ok(res, { stores: list.slice(0, 200) });
    }],

    ['GET', /^\/api\/delivery\/stores\/(\d+)$/, async (req, res, m) => {
      const p = q(req);
      const cc = String(p.get('country') || '').toUpperCase();
      const c = await db.one(`SELECT c.id, c.full_name, c.kind, c.specialty, c.photo_url, CASE WHEN c.photo IS NULL THEN 0 ELSE 1 END AS has_photo, c.delivery_mode, c.whatsapp, c.wa_orders, c.pinned, c.accepting_orders, c.hours, c.lat, c.lng, c.bio, c.allow_directions, c.booking
        FROM cooks c WHERE c.id = $2 AND ${VIS}${/^[A-Z]{2}$/.test(cc) ? ` AND COALESCE(c.country, 'LB') = $3` : ''}`, /^[A-Z]{2}$/.test(cc) ? [iso(), Number(m[1]), cc] : [iso(), Number(m[1])]);
      if (!c) throw new HttpError(404, 'not_found');
      const lat = Number(p.get('lat')), lng = Number(p.get('lng'));
      const menu = (await db.query(`SELECT id, name, description, price, currency, section, CASE WHEN photo IS NULL THEN 0 ELSE 1 END AS has_photo FROM menu_items WHERE cook_id = $1 AND is_available = 1 ORDER BY sort_order, id`, [c.id]))
        .map((x) => ({ id: x.id, name: x.name, description: x.description, price: x.price, currency: x.currency, section: x.section || null, photo: Number(x.has_photo) ? `/api/menu-photo/${x.id}` : null }));
      const photos = (await db.query('SELECT id, url FROM cook_photos WHERE cook_id = $1 AND COALESCE(is_hidden, 0) = 0 ORDER BY created_at DESC, id DESC LIMIT 30', [c.id])).map((x) => x.url || `/media/photos/${x.id}.jpg`);
      const extra = await db.one('SELECT accent_color, delivery_fee, pay_methods, delivery_radius_km, menu_sections FROM cooks WHERE id = $1', [c.id]);
      return ok(res, { store: { ...storeView(c, isValidLatLng(lat, lng) ? lat : NaN, lng), bio: c.bio || '', directions: Number(c.allow_directions ?? 1) === 1, hours: parseJson(c.hours), photos, accent: extra?.accent_color || null,
        deliveryFee: Number(extra?.delivery_fee ?? 0), payMethods: payMethodsOf(extra?.pay_methods), deliveryRadiusKm: Number(extra?.delivery_radius_km || 0) || null,
        sections: parseJson(extra?.menu_sections) || [] }, menu });
    }],

    // A product photo (public, cached).
    ['GET', /^\/api\/menu-photo\/(\d+)$/, async (req, res, m) => {
      const r = await db.one('SELECT photo_mime, photo FROM menu_items WHERE id = $1', [Number(m[1])]);
      if (!r?.photo) throw new HttpError(404, 'not_found');
      const body = Buffer.from(r.photo, 'base64');
      res.writeHead(200, { 'Content-Type': r.photo_mime, 'Content-Length': body.length, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    }],

    // ===== customer orders =====
    ['POST', /^\/api\/orders$/, customer(async (req, res, m, customerId) => {
      const b = await readJson(req);
      const v = new Validator();
      const storeId = v.int('storeId', b.storeId, { min: 1 });
      const lat = Number(b.lat), lng = Number(b.lng);
      if (!isValidLatLng(lat, lng)) v.fail('location', 'invalid');
      const details = v.text('details', b.details, { max: 300, required: false, multiline: true });
      const note = v.text('note', b.note, { max: 300, required: false, multiline: true });
      let scheduledAt = null;
      if (b.scheduledAt) {
        const d = new Date(b.scheduledAt);
        if (Number.isNaN(d.getTime()) || d.getTime() < Date.now() - 60_000 || d.getTime() > Date.now() + 14 * 864e5) v.fail('scheduledAt', 'invalid');
        else scheduledAt = d.toISOString();
      }
      const items = Array.isArray(b.items) ? b.items : [];
      if (!items.length || items.length > 50) v.fail('items', 'invalid');
      const payMethod = b.paymentMethod == null ? 'cash' : v.oneOf('paymentMethod', b.paymentMethod, ['cash', 'card']);
      v.assert();
      const st = await db.one(`SELECT c.id, c.lat, c.lng, c.delivery_mode, c.accepting_orders, c.hours, COALESCE(c.country, 'LB') AS country, c.delivery_fee, c.pay_methods, c.delivery_radius_km FROM cooks c WHERE c.id = $2 AND ${VIS}`, [iso(), storeId]);
      if (!st) throw new HttpError(404, 'not_found');
      const me = await db.one(`SELECT COALESCE(country, 'LB') AS country FROM customers WHERE id = $1`, [customerId]);
      if (me.country !== st.country) throw new HttpError(404, 'not_found');   // every country is separate
      if (!['delivery', 'self'].includes(st.delivery_mode)) throw new HttpError(409, 'store_no_delivery');
      if (!scheduledAt && (Number(st.accepting_orders) !== 1 || isOpenNow(parseJson(st.hours)) === false)) throw new HttpError(409, 'store_closed');
      const menu = new Map((await db.query('SELECT id, name, price, currency FROM menu_items WHERE cook_id = $1 AND is_available = 1', [storeId])).map((r) => [r.id, r]));
      const lines = [];
      for (const it of items) {
        const mi = menu.get(Number(it?.id));
        const qty = Number(it?.qty);
        if (!mi || mi.price == null || !Number.isInteger(qty) || qty < 1 || qty > 50) throw new HttpError(422, 'validation_failed', { fields: { items: 'invalid' } });
        lines.push({ id: mi.id, name: mi.name, price: Number(mi.price), qty, currency: mi.currency });
      }
      // Every amount is computed here from the store's own prices and fee — never taken from the phone.
      const total = Math.round(lines.reduce((a, l) => a + l.price * l.qty, 0) * 100) / 100;     // food / products (the store's money)
      const fee = Math.round(Number(st.delivery_fee || 0) * 100) / 100;                         // delivery fee set by the store
      const customerTotal = Math.round((total + fee) * 100) / 100;
      const methods = payMethodsOf(st.pay_methods);
      if (!methods.includes(payMethod)) throw new HttpError(422, 'validation_failed', { fields: { paymentMethod: 'not_accepted' } });
      const dist = await road(st, { lat, lng });
      const radius = Number(st.delivery_radius_km || 0);
      if (radius > 0 && (dist.m ?? meters(st.lat, st.lng, lat, lng)) > radius * 1000) throw new HttpError(422, 'out_of_delivery_area', { radiusKm: radius });
      const id = await db.tx(async (t) => {
        const o = await t.one(`INSERT INTO orders (cook_id, customer_id, total, currency, lat, lng, address_details, note, scheduled_at, distance_m, country, delivery_fee, customer_total, payment_method, payment_status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
          [storeId, customerId, total, lines[0].currency || 'USD', lat, lng, details, note, scheduledAt, dist.m ?? meters(st.lat, st.lng, lat, lng), st.country, fee, customerTotal, payMethod, payMethod === 'card' ? 'pending' : 'cash_on_delivery']);
        for (const l of lines) await t.query('INSERT INTO order_items (order_id, menu_item_id, name, price, qty) VALUES ($1,$2,$3,$4,$5)', [o.id, l.id, l.name, l.price, l.qty]);
        return o.id;
      });
      if (payMethod === 'card') {
        // the order reaches the store only after the provider confirms the payment (webhook)
        const token = payments.newToken();
        await db.query('INSERT INTO order_payments (order_id, token, amount, currency) VALUES ($1,$2,$3,$4)', [id, token, customerTotal, lines[0].currency || 'USD']);
        try {
          const base = cfg.publicBaseUrl || `https://${req.headers.host}`;
          const { url } = await payments.checkout({ reference: token, amount: customerTotal, description: `Aklatak order AKL${id}`, baseUrl: base, successPath: `/#/o/${id}`, cancelPath: `/#/o/${id}` });
          return ok(res, { id, total, deliveryFee: fee, customerTotal, payUrl: url }, 201);
        } catch {
          await db.query(`UPDATE orders SET status = 'cancelled', payment_status = 'failed', closed_at = $1, close_reason = 'payment_failed' WHERE id = $2`, [iso(), id]);
          throw new HttpError(502, 'payment_unavailable');
        }
      }
      push.notify('store', storeId, { title: 'Aklatak', body: `🧾 طلب جديد ${ref(id)}`, url: '/store' });
      return ok(res, { id, total, deliveryFee: fee, customerTotal }, 201);
    })],

    ['GET', /^\/api\/customer\/orders$/, customer(async (req, res, m, id) => {
      const rows = await db.query(`SELECT o.id, o.status, o.total, o.currency, o.created_at, o.cook_id, c.full_name AS store
        FROM orders o JOIN cooks c ON c.id = o.cook_id WHERE o.customer_id = $1 AND o.customer_hidden = 0 ORDER BY o.id DESC LIMIT 50`, [id]);
      return ok(res, { orders: rows });
    })],

    ['GET', /^\/api\/customer\/orders\/(\d+)$/, customer(async (req, res, m, id) => {
      await settleClaims();
      const o = await mustOrder(`SELECT o.*, c.full_name AS store FROM orders o JOIN cooks c ON c.id = o.cook_id WHERE o.id = $1 AND o.customer_id = $2`, [Number(m[1]), id]);
      const items = await db.query('SELECT menu_item_id AS id, name, price, qty FROM order_items WHERE order_id = $1', [o.id]);
      let drv = null;
      if (o.driver_id && ['assigned', 'picked_up', 'delivered'].includes(o.status)) {
        const d = await db.one('SELECT id, full_name, phone, vehicle, lat, lng FROM drivers WHERE id = $1', [o.driver_id]);
        if (d) {
          drv = { id: d.id, name: firstName(d.full_name), phone: d.phone, vehicle: d.vehicle, photo: await hasPhoto(d.id) };
          if (o.status === 'picked_up' && d.lat != null) { const r = await road(d, o, `d${d.id}`); drv.toYouM = r.m; drv.approx = r.approx; }
        }
      }
      // v7.6: the customer sees food + delivery fee = what he pays, and how (cash to the driver / card).
      return ok(res, { order: { id: o.id, status: o.status, store: o.store, storeId: o.cook_id, total: o.total, currency: o.currency, items,
        foodAmount: Number(o.total), deliveryFee: o.customer_total != null ? Number(o.delivery_fee || 0) : null, customerTotal: o.customer_total != null ? Number(o.customer_total) : Number(o.total),
        paymentMethod: o.payment_method, paymentStatus: o.payment_status, closeReason: o.close_reason || null, createdAt: o.created_at, scheduledAt: o.scheduled_at, driver: drv, selfDelivery: !!Number(o.self_delivery), ref: ref(o.id),
        awaitingConfirm: o.status === 'delivered' && !o.confirmed_at && !Number(o.customer_hidden), confirmAfterMin: (await S.get()).confirmAfterMin } });
    })],

    ['POST', /^\/api\/customer\/orders\/(\d+)\/cancel$/, customer(async (req, res, m, id) => {
      const o = await mustOrder('SELECT id, status FROM orders WHERE id = $1 AND customer_id = $2', [Number(m[1]), id]);
      if (o.status !== 'pending') throw stateError();
      await db.tx(async (t) => {
        await t.query(`UPDATE orders SET status = 'cancelled', closed_at = $1, close_reason = 'customer' WHERE id = $2`, [iso(), o.id]);
        await refundIfPaid(t, o.id);
      });
      return ok(res);
    })],

    // The customer confirms he received the order: the delivery fee moves to the driver at once; the order leaves his list.
    ['POST', /^\/api\/customer\/orders\/(\d+)\/confirm$/, customer(async (req, res, m, id) => {
      const o = await mustOrder('SELECT id, status, cook_id, driver_id FROM orders WHERE id = $1 AND customer_id = $2', [Number(m[1]), id]);
      if (o.status !== 'delivered') throw stateError();
      const paid = await db.tx(async (t) => {
        const done = await settleOrder(t, o.id);
        await t.query(`UPDATE orders SET customer_hidden = 1, confirmed_at = COALESCE(confirmed_at, $1) WHERE id = $2`, [iso(), o.id]);
        return done;
      });
      if (paid) push.notify('driver', o.driver_id, { title: 'Aklatak', body: `✅ أكّد الزبون استلام ${ref(o.id)}`, url: '/driver' });
      push.notify('store', o.cook_id, { title: 'Aklatak', body: `✅ أكّد الزبون استلام ${ref(o.id)}`, url: '/store' });
      return ok(res, { feePaid: paid });
    })],

    // The customer rates a delivered order (stars + an optional note) — the store sees it in its records, the owner too.
    ['POST', /^\/api\/customer\/orders\/(\d+)\/rate$/, customer(async (req, res, m, id) => {
      const b = await readJson(req);
      const v = new Validator();
      const stars = v.int('stars', b.stars, { min: 1, max: 5 });
      const note = v.text('note', b.note, { max: 500, required: false, multiline: true });
      v.assert();
      const o = await mustOrder('SELECT id, status, cook_id FROM orders WHERE id = $1 AND customer_id = $2', [Number(m[1]), id]);
      if (o.status !== 'delivered') throw stateError();
      await db.query('UPDATE orders SET rating = $1, rating_note = $2 WHERE id = $3', [stars, note || null, o.id]);
      push.notify('store', o.cook_id, { title: 'Aklatak', body: `${'⭐'.repeat(stars)} تقييم جديد ${ref(o.id)}`, url: '/store' });
      return ok(res);
    })],

    // While the order is on its way, the customer's phone keeps his exact position up to date (live location).
    ['POST', /^\/api\/customer\/orders\/(\d+)\/location$/, customer(async (req, res, m, id) => {
      const b = await readJson(req);
      const lat = Number(b.lat), lng = Number(b.lng);
      if (!isValidLatLng(lat, lng)) throw new HttpError(422, 'validation_failed', { fields: { location: 'invalid' } });
      const o = await mustOrder('SELECT id, status, lat, lng FROM orders WHERE id = $1 AND customer_id = $2', [Number(m[1]), id]);
      if (!['pending', 'preparing', 'searching', 'assigned', 'picked_up'].includes(o.status)) throw stateError();
      if (meters(o.lat, o.lng, lat, lng) > 3000) throw new HttpError(422, 'validation_failed', { fields: { location: 'too_far' } });   // a new place = a new order
      await db.query('UPDATE orders SET lat = $1, lng = $2 WHERE id = $3', [lat, lng, o.id]);
      return ok(res);
    })],

    // ===== store (merchant) =====
    ['GET', /^\/api\/store\/orders$/, store(async (req, res, m, cookId) => {
      await settleClaims();
      const s = await S.get();
      const p = q(req);
      // views: active (default) · history · unpaid (driver still owes the order money) · paid
      const view = p.get('active') === '0' ? 'history' : (p.get('view') || 'active');
      const where = {
        // a card order reaches the store only once paid
        active: `AND o.status IN ('pending','preparing','searching','assigned','picked_up') AND o.payment_status NOT IN ('pending','failed')`,
        history: `AND o.status IN ('delivered','rejected','cancelled') AND o.store_hidden = 0`,
        unpaid: `AND o.status = 'delivered' AND o.store_paid = 0 AND o.driver_id IS NOT NULL AND o.self_delivery = 0 AND o.store_hidden = 0`,
        paid: `AND o.status = 'delivered' AND o.store_paid = 1 AND o.store_hidden = 0`,
      }[view] || '';
      const st = await db.one('SELECT lat, lng, record_limit FROM cooks WHERE id = $1', [cookId]);
      const rows = await db.query(`SELECT o.*, cu.name AS customer_name, cu.phone AS customer_phone FROM orders o JOIN customers cu ON cu.id = o.customer_id
        WHERE o.cook_id = $1 ${where} ORDER BY o.id DESC LIMIT ${view === 'active' ? 100 : 1000}`, [cookId]);
      const out = [];
      for (const o of rows) {
        const items = await db.query('SELECT name, price, qty FROM order_items WHERE order_id = $1', [o.id]);
        let drv = null;
        if (o.driver_id) {
          const d = await db.one('SELECT id, full_name, phone, vehicle, lat, lng, loc_at FROM drivers WHERE id = $1', [o.driver_id]);
          if (d) {
            drv = { id: d.id, name: d.full_name, phone: d.phone, vehicle: d.vehicle, photo: await hasPhoto(d.id) };
            if (['assigned', 'picked_up'].includes(o.status) && d.lat != null) {   // live position while he is on this order (distance by road)
              drv.lat = d.lat; drv.lng = d.lng; drv.locAt = d.loc_at;
              const r = o.status === 'assigned' ? await road(d, st, `d${d.id}`) : await road(d, o, `d${d.id}`);
              if (o.status === 'assigned') drv.toStoreM = r.m; else drv.toCustomerM = r.m;
              drv.approx = r.approx;
            }
          }
        }
        const cands = o.status === 'searching' ? await candidates('order', o.id, st) : [];
        const sent = cands.length;
        const addon = o.status === 'searching' ? await db.one(`SELECT f.status, d.full_name FROM order_offers f JOIN drivers d ON d.id = f.driver_id WHERE f.order_id = $1 AND f.addon = 1 ORDER BY f.id DESC`, [o.id]) : null;
        const sinceAssigned = o.assigned_at ? (Date.now() - Date.parse(o.assigned_at)) / 60000 : 0;
        out.push({
          id: o.id, ref: ref(o.id), status: o.status, total: o.total, currency: o.currency, items, note: o.note, scheduledAt: o.scheduled_at,
          // the customer's exact place (kept live by his phone while he follows the order) — for the store's own delivery and the driver
          customer: { name: o.customer_name, phone: o.customer_phone, ...(['pending', 'preparing', 'searching', 'assigned', 'picked_up'].includes(o.status) ? { lat: o.lat, lng: o.lng, details: o.address_details } : {}) },
          distanceM: o.distance_m, deliveryFee: o.delivery_fee,
          foodAmount: Number(o.total), customerTotal: o.customer_total != null ? Number(o.customer_total) : null, paymentMethod: o.payment_method, paymentStatus: o.payment_status,
          financialStatus: o.financial_status, bonus: Number(o.bonus_fee || 0), legacy: o.customer_total == null, rating: o.rating || null, ratingNote: o.rating_note || null,
          driversNotified: sent, candidates: cands, locationSent: !!Number(o.location_sent), driver: drv, createdAt: o.created_at, deliveredAt: o.delivered_at,
          selfDelivery: !!Number(o.self_delivery), feeState: o.fee_state, confirmedAt: o.confirmed_at, storePaid: !!Number(o.store_paid), storePaidAt: o.store_paid_at,
          addon: addon ? { status: addon.status, driver: addon.full_name } : null, closeReason: o.close_reason, cancelNote: o.cancel_note,
          canRaise: o.status === 'searching' && o.search_started_at && (Date.now() - Date.parse(o.search_started_at)) >= s.raiseAfterSec * 1000,
          late: o.status === 'assigned' && sinceAssigned >= s.lateAfterMin,
          canRefund: o.status === 'delivered' && (o.customer_total == null ? o.fee_state === 'awaiting' : o.financial_status === 'open'),
        });
      }
      const hist = await db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM orders WHERE cook_id = $1 AND status IN ('delivered','rejected','cancelled') AND store_hidden = 0`, [cookId]);
      const unpaid = await db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n, COALESCE(SUM(total),0) AS s FROM orders WHERE cook_id = $1 AND status = 'delivered' AND store_paid = 0 AND driver_id IS NOT NULL AND self_delivery = 0 AND store_hidden = 0`, [cookId]);
      return ok(res, {
        orders: out, balance: await balance(db, 'store', cookId), view,
        records: { count: hist.n, limit: Number(st.record_limit) || 1000, full: hist.n >= (Number(st.record_limit) || 1000) },
        unpaid: { count: unpaid.n, total: Math.round(Number(unpaid.s) * 100) / 100 },
        lateAfterMin: s.lateAfterMin,
      });
    })],

    // reject: a plain refusal, or "we don't deliver to your area" (search by name is open to everyone, so a customer far away
    // can order — the store tells him clearly, and a card payment is refunded)
    ['POST', /^\/api\/store\/orders\/(\d+)\/(accept|reject|out-of-area)$/, store(async (req, res, m, cookId) => {
      const o = await mustOrder('SELECT id, status, customer_id FROM orders WHERE id = $1 AND cook_id = $2', [Number(m[1]), cookId]);
      if (o.status !== 'pending') throw stateError();
      if (m[2] === 'accept') await db.query(`UPDATE orders SET status = 'preparing', accepted_at = $1 WHERE id = $2`, [iso(), o.id]);
      else {
        const reason = m[2] === 'out-of-area' ? 'out_of_area' : 'store';
        const done = await db.tx(async (t) => {
          const r = await t.query(`UPDATE orders SET status = 'rejected', closed_at = $1, close_reason = $2 WHERE id = $3 AND status = 'pending' RETURNING id`, [iso(), reason, o.id]);
          if (r.length) await refundIfPaid(t, o.id);
          return r.length > 0;
        });
        if (!done) throw stateError();
        await refundNow(o.id);
        push.notify('customer', o.customer_id, { title: 'Aklatak', body: reason === 'out_of_area' ? `📍 عذراً، المتجر لا يوصل إلى منطقتك (${ref(o.id)})` : `❌ لم يقبل المتجر طلبك ${ref(o.id)}`, url: `/#/o/${o.id}` });
      }
      return ok(res);
    })],

    // Look for a driver. The customer pays the delivery fee (set by the store) with the order — nothing is taken from the
    // store's account. "raise" = an optional bonus the store pays the driver in cash at pick-up (shown on the offer).
    // Orders from before v7.6 (customer_total NULL) keep the old rule (fee held from the store's balance).
    ['POST', /^\/api\/store\/orders\/(\d+)\/(search|raise)$/, store(async (req, res, m, cookId) => {
      const b = await readJson(req);
      const s = await S.get();
      const st = await db.one('SELECT id, lat, lng, country FROM cooks WHERE id = $1', [cookId]);
      const result = await db.tx(async (t) => {
        const o = await t.one('SELECT * FROM orders WHERE id = $1 AND cook_id = $2', [Number(m[1]), cookId]);
        if (!o) throw new HttpError(404, 'not_found');
        const raising = m[2] === 'raise';
        if (raising ? o.status !== 'searching' : o.status !== 'preparing') throw stateError();
        const mode = (await t.one('SELECT delivery_mode FROM cooks WHERE id = $1', [cookId])).delivery_mode;
        if (mode !== 'delivery') throw new HttpError(409, 'drivers_not_in_plan');
        if (o.customer_total != null) {
          const v = new Validator();
          const bonus = raising ? v.number('bonus', b.bonus, { min: 0.5, max: 100 }) : (b.bonus == null || b.bonus === '' ? 0 : v.number('bonus', b.bonus, { min: 0, max: 100 }));
          v.assert();
          const next = raising ? Math.round((Number(o.bonus_fee || 0) + bonus) * 100) / 100 : bonus;
          await t.query(`UPDATE orders SET status = 'searching', bonus_fee = $1, search_started_at = $2 WHERE id = $3`, [next, iso(), o.id]);
          return { ...o, bonus_fee: next };
        }
        // ----- legacy order -----
        const v = new Validator();
        const fee = v.number('fee', b.fee ?? o.delivery_fee, { min: 0.5, max: 1000 });
        v.assert();
        if (raising && fee <= Number(o.delivery_fee)) throw new HttpError(422, 'validation_failed', { fields: { fee: 'must_be_higher' } });
        const held = raising ? Number(o.delivery_fee) : 0;
        await lockAccount(t, db.kind, 'store', cookId);
        const bal = await balance(t, 'store', cookId);
        if (bal + held < fee) throw new HttpError(402, 'insufficient_balance', { balance: bal, needed: fee });
        if (raising) await ledgerAdd(t, 'store', cookId, held, 'release', { orderId: o.id, note: 'fee raised' });
        await ledgerAdd(t, 'store', cookId, -fee, 'hold', { orderId: o.id });
        await t.query(`UPDATE orders SET status = 'searching', delivery_fee = $1, search_started_at = $2 WHERE id = $3`, [fee, iso(), o.id]);
        return { ...o, delivery_fee: fee };
      });
      const sent = await dispatch(db, result, st, s, roads);
      notifyOffers(result.id);
      return ok(res, { driversNotified: sent, balance: await balance(db, 'store', cookId) });
    })],

    ['POST', /^\/api\/store\/orders\/(\d+)\/send-location$/, store(async (req, res, m, cookId) => {
      const o = await mustOrder('SELECT id, status FROM orders WHERE id = $1 AND cook_id = $2', [Number(m[1]), cookId]);
      if (!['assigned', 'picked_up'].includes(o.status)) throw stateError();
      await db.query('UPDATE orders SET location_sent = 1 WHERE id = $1', [o.id]);
      return ok(res);
    })],

    ['POST', /^\/api\/store\/orders\/(\d+)\/cancel$/, store(async (req, res, m, cookId) => {
      await db.tx(async (t) => {
        const o = await t.one('SELECT id, status, delivery_fee FROM orders WHERE id = $1 AND cook_id = $2', [Number(m[1]), cookId]);
        if (!o) throw new HttpError(404, 'not_found');
        if (!['preparing', 'searching', 'assigned'].includes(o.status)) throw stateError();
        const legacy = (await t.one('SELECT customer_total FROM orders WHERE id = $1', [o.id])).customer_total == null;
        if (legacy && ['searching', 'assigned'].includes(o.status) && o.delivery_fee) await ledgerAdd(t, 'store', cookId, Number(o.delivery_fee), 'release', { orderId: o.id, note: 'cancelled' });
        await t.query(`UPDATE order_offers SET status = 'lost' WHERE order_id = $1 AND status = 'sent'`, [o.id]);
        await t.query(`UPDATE orders SET status = 'cancelled', closed_at = $1, close_reason = 'store' WHERE id = $2`, [iso(), o.id]);
        await refundIfPaid(t, o.id);
      });
      return ok(res);
    })],

    ['POST', /^\/api\/store\/accepting$/, store(async (req, res, m, cookId) => {
      const b = await readJson(req);
      await db.query('UPDATE cooks SET accepting_orders = $1 WHERE id = $2', [b.on === false ? 0 : 1, cookId]);
      return ok(res);
    })],

    ['GET', /^\/api\/store\/wallet$/, store(async (req, res, m, cookId) => {
      const ledger = await db.query('SELECT amount, kind, order_id, note, created_at FROM wallet_ledger WHERE account_type = $1 AND account_id = $2 ORDER BY id DESC LIMIT 50', ['store', cookId]);
      const topups = await db.query('SELECT id, amount, method, status, created_at FROM topups WHERE cook_id = $1 ORDER BY id DESC LIMIT 20', [cookId]);
      const c = await db.one('SELECT delivery_mode, accepting_orders FROM cooks WHERE id = $1', [cookId]);
      return ok(res, { balance: await balance(db, 'store', cookId), ledger, topups, deliveryMode: c.delivery_mode, accepting: Number(c.accepting_orders ?? 1) === 1, warnings: await warningsOf('store', cookId) });
    })],

    ['POST', /^\/api\/store\/topups$/, store(async (req, res, m, cookId) => {
      await limit(limiters.upload, `topup:${cookId}`);
      const b = await readJson(req, 600_000);
      const v = new Validator();
      const amount = v.number('amount', b.amount, { min: 1, max: 10000 });
      const method = v.oneOf('method', b.method, ['whish', 'omt', 'other']);
      const reference = v.text('reference', b.reference, { max: 80, required: false });
      if (!b.receipt || !imageBytesOk(b.receipt) || String(b.receipt).length > DOC_MAX) v.fail('receipt', 'invalid');
      v.assert();
      const pending = await db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM topups WHERE cook_id = $1 AND status = 'pending'`, [cookId]);
      if (pending.n >= 5) throw new HttpError(409, 'too_many_pending');
      const mime = /^data:(image\/\w+);/.exec(b.receipt)[1];
      const row = await db.one('INSERT INTO topups (cook_id, amount, method, reference, receipt_mime, receipt) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [cookId, amount, method, reference, mime, String(b.receipt).split(',')[1]]);
      const who = await db.one('SELECT full_name FROM cooks WHERE id = $1', [cookId]);
      push.notifyAdmins({ title: 'Aklatak — الإدارة', body: `💳 طلب شحن رصيد ${amount}$ من ${who?.full_name || ''}`, url: '/admin/#dx-topups' });
      return ok(res, { id: row.id }, 201);
    })],

    ['GET', /^\/api\/store\/report$/, store(async (req, res, m, cookId) => {
      const p = q(req);
      return ok(res, { report: await storeReport(db, cookId, { period: p.get('period'), from: p.get('from'), to: p.get('to') }) });
    })],

    // ===== drivers =====
    ['POST', /^\/api\/driver\/apply$/, async (req, res) => {
      checkCsrf(req);
      await limit(limiters.apply, `driver:${ip(req)}`);
      const b = await readJson(req, 3_500_000);
      const v = new Validator();
      const fullName = v.text('fullName', b.fullName, { min: 3, max: 80 });
      const phone = phoneOf(v, b);
      const password = String(b.password || '');
      if (password.length < 5 || password.length > 100) v.fail('password', 'too_short');
      const vehicle = v.oneOf('vehicle', b.vehicle, ['moto', 'car']);
      const plate = v.text('plate', b.plate, { max: 20 });
      const walletProvider = v.oneOf('walletProvider', b.walletProvider, ['whish', 'omt']);
      const walletNumber = normalizePhone(b.walletNumber, b.country || 'LB') || v.fail('walletNumber', 'invalid');
      if (b.acceptTerms !== true) v.fail('acceptTerms', 'required');
      if (b.adult !== true) v.fail('adult', 'required');                       // "I am over 18" box
      const birth = /^\d{4}-\d{2}-\d{2}$/.test(String(b.birthDate || '')) ? new Date(`${b.birthDate}T00:00:00Z`) : null;
      if (!birth || Number.isNaN(birth.getTime())) v.fail('birthDate', 'required');
      else {
        const adultOn = new Date(birth); adultOn.setUTCFullYear(adultOn.getUTCFullYear() + 18);
        if (adultOn > new Date() || birth.getUTCFullYear() < 1930) v.fail('birthDate', 'under_18');
      }
      const jobsMonths = b.jobsMonths == null || b.jobsMonths === '' || b.jobsMonths === 0 ? null : v.oneOf('jobsMonths', Number(b.jobsMonths), [1, 3, 12]);
      const docs = b.docs || {};
      for (const k of DOC_KINDS) {
        if (!docs[k] || !imageBytesOk(docs[k])) v.fail(`docs.${k}`, 'required');
        else if (String(docs[k]).length > DOC_MAX) v.fail(`docs.${k}`, 'too_large');
      }
      v.assert();
      if (await db.one('SELECT id FROM drivers WHERE phone = $1', [phone])) throw new HttpError(409, 'phone_taken');
      const hash = await hashPassword(password);
      const id = await db.tx(async (t) => {
        const d = await t.one(`INSERT INTO drivers (full_name, phone, password_hash, vehicle, plate, wallet_provider, wallet_number, country, locale, terms_accepted_at, birth_date, jobs_request_months)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [fullName, phone, hash, vehicle, plate, walletProvider, walletNumber, String(b.country || 'LB').slice(0, 2).toUpperCase(), b.locale ? String(b.locale).slice(0, 5) : null, iso(), String(b.birthDate), jobsMonths]);
        for (const k of DOC_KINDS) {
          const s = String(docs[k]);
          await t.query('INSERT INTO driver_documents (driver_id, kind, mime, data) VALUES ($1,$2,$3,$4)', [d.id, k, /^data:(image\/\w+);/.exec(s)[1], s.split(',')[1]]);
        }
        return d.id;
      });
      push.notifyAdmins({ title: 'Aklatak — الإدارة', body: `🛵 طلب انضمام سائق جديد: ${fullName}`, url: '/admin/#dx-drivers' });
      return ok(res, { id, status: 'pending' }, 201);
    }],

    ['POST', /^\/api\/driver\/login$/, async (req, res) => {
      checkCsrf(req);
      await limit(limiters.login, `driver:${ip(req)}`);
      const b = await readJson(req);
      const phone = normalizePhone(b.phone, b.country || 'LB');
      const d = phone ? await db.one('SELECT id, password_hash, status FROM drivers WHERE phone = $1', [phone]) : null;
      const good = await verifyPassword(String(b.password || ''), d?.password_hash || DUMMY_HASH);
      if (!d || !good || d.status === 'rejected') throw new HttpError(401, 'invalid_credentials');
      const cookie = await driverSessions.create(d.id);
      return sendJson(res, 200, { ok: true, status: d.status }, { 'Set-Cookie': cookie });
    }],

    ['POST', /^\/api\/driver\/logout$/, async (req, res) => {
      checkCsrf(req);
      const id = await driverSessions.ownerId(req);
      if (id) await db.query('UPDATE drivers SET available = 0 WHERE id = $1', [id]);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': await driverSessions.destroy(req) });
    }],

    ['GET', /^\/api\/driver\/me$/, driver(async (req, res, m, id) => {
      const d = await db.one('SELECT id, full_name, phone, vehicle, plate, wallet_provider, wallet_number, status, available, loc_at, jobs_until FROM drivers WHERE id = $1', [id]);
      const s = await S.get();
      const fresh = d.loc_at && Date.now() - Date.parse(d.loc_at) < s.driverStaleSec * 1000;
      return ok(res, {
        id: d.id, name: d.full_name, phone: d.phone, vehicle: d.vehicle, plate: d.plate, wallet: { provider: d.wallet_provider, number: d.wallet_number },
        status: d.status, available: !!Number(d.available) && !!fresh, balance: await balance(db, 'driver', id), payoutThreshold: s.payoutThreshold,
        warnings: await warningsOf('driver', id),
        jobs: { active: !!d.jobs_until && d.jobs_until > iso(), until: d.jobs_until || null, price: s.jobsPrice },
      });
    }, { activeOnly: false })],

    ['POST', /^\/api\/driver\/availability$/, driver(async (req, res, m, id) => {
      const b = await readJson(req);
      const on = b.available === true;
      const lat = Number(b.lat), lng = Number(b.lng);
      if (on && !isValidLatLng(lat, lng)) throw new HttpError(422, 'validation_failed', { fields: { location: 'required' } });
      if (on) await db.query('UPDATE drivers SET available = 1, lat = $1, lng = $2, loc_at = $3 WHERE id = $4', [lat, lng, iso(), id]);
      else await db.query('UPDATE drivers SET available = 0 WHERE id = $1', [id]);
      return ok(res, { available: on });
    })],

    ['POST', /^\/api\/driver\/location$/, driver(async (req, res, m, id) => {
      const b = await readJson(req);
      const lat = Number(b.lat), lng = Number(b.lng);
      if (!isValidLatLng(lat, lng)) throw new HttpError(422, 'validation_failed', { fields: { location: 'invalid' } });
      await db.query('UPDATE drivers SET lat = $1, lng = $2, loc_at = $3 WHERE id = $4', [lat, lng, iso(), id]);
      return ok(res);
    })],

    // Offers show distances and the fee only — never the customer's exact location.
    // Offers: the nearest drivers only; distances, fee and what is wanted (no addresses). An offer another driver got
    // stays visible as "reserved" for a moment, then disappears.
    ['GET', /^\/api\/driver\/offers$/, driver(async (req, res, m, id) => {
      await settleClaims();
      const s = await S.get();
      const d = await db.one('SELECT lat, lng FROM drivers WHERE id = $1', [id]);
      const recent = new Date(Date.now() - s.reserveShowSec * 1000).toISOString();
      const busy = await db.one(`SELECT id FROM orders WHERE driver_id = $1 AND status IN ('assigned','picked_up') UNION SELECT id FROM errands WHERE driver_id = $1 AND status IN ('assigned','picked_up')`, [id]);
      const rows = await db.query(`SELECT f.id, f.fee, f.status, f.claimed_at, f.addon, o.id AS order_id, o.distance_m, o.claim_until, o.payment_method, o.customer_total, o.total AS food, o.bonus_fee, c.full_name AS store, c.lat, c.lng
        FROM order_offers f JOIN orders o ON o.id = f.order_id JOIN cooks c ON c.id = o.cook_id
        WHERE f.driver_id = $1 AND ((f.status = 'sent' AND o.status = 'searching') OR (f.status = 'lost' AND f.lost_at >= $2)) ORDER BY f.id DESC`, [id, recent]);
      const er = await db.query(`SELECT f.id, f.status, f.claimed_at, e.id AS errand_id, e.kind, e.description, e.price, e.purchase_value, e.distance_m, e.from_lat, e.from_lng, e.claim_until
        FROM errand_offers f JOIN errands e ON e.id = f.errand_id
        WHERE f.driver_id = $1 AND ((f.status = 'sent' AND e.status = 'searching') OR (f.status = 'lost' AND f.lost_at >= $2)) ORDER BY f.id DESC`, [id, recent]);
      const state = (r) => (r.status === 'lost' ? 'reserved' : r.claimed_at ? 'waiting' : 'open');
      const offers = [];
      for (const r of rows.filter((x) => !busy || Number(x.addon))) {
        const dist = await road(d, r, `d${id}`);
        offers.push({
          type: 'store', id: r.id, orderId: r.order_id, ref: ref(r.order_id), store: r.store, fee: r.fee, storeToCustomerM: r.distance_m, addon: !!Number(r.addon),
          toStoreM: dist.m, approx: dist.approx, state: state(r), decideAt: r.claimed_at ? r.claim_until : null,
          paymentMethod: r.customer_total != null ? r.payment_method : null, collect: r.customer_total != null && r.payment_method === 'cash' ? Number(r.customer_total) : 0, bonus: Number(r.bonus_fee || 0),
        });
      }
      for (const r of busy ? [] : er) {
        const dist = await road(d, { lat: r.from_lat, lng: r.from_lng }, `d${id}`);
        offers.push({
          type: 'errand', id: r.id, errandId: r.errand_id, kind: r.kind, description: r.description, fee: r.price, purchaseValue: r.purchase_value,
          totalM: r.distance_m, toStartM: dist.m, approx: dist.approx, state: state(r), decideAt: r.claimed_at ? r.claim_until : null,
        });
      }
      offers.sort((a, b) => (a.state === 'reserved') - (b.state === 'reserved') || (a.toStoreM ?? a.toStartM ?? 0) - (b.toStoreM ?? b.toStartM ?? 0));   // nearest first
      return ok(res, { offers, busy: !!busy });
    })],

    ['POST', /^\/api\/driver\/offers\/(\d+)\/(accept|decline)$/, driver(async (req, res, m, id) => {
      const offerId = Number(m[1]);
      if (m[2] === 'decline') {
        const f = await db.one(`SELECT f.id, f.addon, o.cook_id, o.id AS order_id FROM order_offers f JOIN orders o ON o.id = f.order_id WHERE f.id = $1 AND f.driver_id = $2 AND f.status = 'sent'`, [offerId, id]);
        await db.query(`UPDATE order_offers SET status = 'declined' WHERE id = $1 AND driver_id = $2 AND status = 'sent'`, [offerId, id]);
        if (f && Number(f.addon)) push.notify('store', f.cook_id, { title: 'Aklatak', body: `رفض السائق إضافة ${ref(f.order_id)} — اطلب سائقاً آخر`, url: '/store' });
        return ok(res);
      }
      const f = await db.one('SELECT f.addon, o.cook_id FROM order_offers f JOIN orders o ON o.id = f.order_id WHERE f.id = $1 AND f.driver_id = $2', [offerId, id]);
      const addon = !!Number(f?.addon);
      let r;
      try { r = await claimOffer(db, await S.get(), 'order', { offerId, driverId: id, exceptCook: addon ? f.cook_id : null, instant: addon, roads }); } catch (e) {
        if (e?.code === 'cash_limit_reached') await securityEvent(db, { kind: 'cash_limit_attempt', severity: 'info', driverId: id, detail: `offer ${offerId}`, dedupeMin: 60 });
        throw gone(e);
      }
      await settleClaims();
      const o = await db.one('SELECT driver_id, status FROM orders WHERE id = $1', [r.pid]);
      if (o.driver_id === id) return ok(res, { orderId: r.pid, won: true });
      if (o.status !== 'searching') throw new HttpError(409, 'offer_gone');
      return ok(res, { orderId: r.pid, won: false, pending: true, decideAt: r.until });   // nearest within the window wins
    })],

    ['GET', /^\/api\/driver\/current$/, driver(async (req, res, m, id) => {
      await settleClaims();
      const rows = await db.query(`SELECT o.*, c.full_name AS store, c.whatsapp AS store_phone, c.payout_number, c.lat AS slat, c.lng AS slng, c.area_label,
          cu.name AS customer_name, cu.phone AS customer_phone
        FROM orders o JOIN cooks c ON c.id = o.cook_id JOIN customers cu ON cu.id = o.customer_id
        WHERE o.driver_id = $1 AND o.status IN ('assigned','picked_up') ORDER BY o.id`, [id]);
      if (!rows.length) {
        const e = await db.one(`SELECT e.*, cu.name AS customer_name, cu.phone AS customer_phone FROM errands e JOIN customers cu ON cu.id = e.customer_id
          WHERE e.driver_id = $1 AND e.status IN ('assigned','picked_up') ORDER BY e.id DESC`, [id]);
        if (!e) return ok(res, { order: null, orders: [], errand: null });
        const messages = await db.query('SELECT id, from_type, body, created_at FROM errand_messages WHERE errand_id = $1 ORDER BY id', [e.id]);
        return ok(res, {
          order: null, orders: [],
          errand: {
            id: e.id, kind: e.kind, status: e.status, description: e.description, fee: e.price, purchaseValue: e.purchase_value, totalM: e.distance_m,
            from: { lat: e.from_lat, lng: e.from_lng, details: e.from_details }, to: { lat: e.to_lat, lng: e.to_lng, details: e.to_details },
            customer: { name: e.customer_name, phone: e.customer_phone }, messages,
          },
        });
      }
      // The store sends BOTH places with one tap; until then the driver sees the store only.
      const orders = rows.map((o) => {
        const sent = !!Number(o.location_sent);
        return {
          id: o.id, ref: ref(o.id), status: o.status, fee: o.delivery_fee, total: o.total, currency: o.currency, storeToCustomerM: o.distance_m,
          // v7.6: what to collect from the customer (cash) — the food part is the restaurant's (settled later), the fee is his
          legacy: o.customer_total == null, paymentMethod: o.payment_method, customerTotal: o.customer_total != null ? Number(o.customer_total) : null,
          collect: o.customer_total != null && o.payment_method === 'cash' ? Number(o.customer_total) : 0, bonus: Number(o.bonus_fee || 0),
          store: { name: o.store, phone: o.store_phone, payTo: o.payout_number || o.store_phone, lat: o.slat, lng: o.slng, area: o.area_label },
          locationSent: sent,
          customer: sent ? { name: o.customer_name, phone: o.customer_phone, lat: o.lat, lng: o.lng, details: o.address_details } : null,
        };
      });
      return ok(res, { order: orders[0], orders, errand: null });
    })],

    // Delivered: the places disappear from the driver at once; the fee is paid when the customer confirms (or automatically later).
    ['POST', /^\/api\/driver\/orders\/(\d+)\/(picked|delivered)$/, driver(async (req, res, m, id) => {
      const o = await db.tx(async (t) => {
        const o = await t.one('SELECT id, status, delivery_fee, customer_id, cook_id FROM orders WHERE id = $1 AND driver_id = $2', [Number(m[1]), id]);
        if (!o) throw new HttpError(404, 'not_found');
        if (m[2] === 'picked') {
          if (o.status !== 'assigned') throw stateError();
          await t.query(`UPDATE orders SET status = 'picked_up', picked_at = $1 WHERE id = $2`, [iso(), o.id]);
        } else {
          if (!['assigned', 'picked_up'].includes(o.status)) throw stateError();
          await t.query(`UPDATE orders SET status = 'delivered', delivered_at = $1, closed_at = $1, fee_state = $3 WHERE id = $2`, [iso(), o.id, Number(o.delivery_fee) > 0 ? 'awaiting' : null]);
        }
        return o;
      });
      if (m[2] === 'picked') push.notify('customer', o.customer_id, { title: 'Aklatak', body: '🛵 طلبك في الطريق إليك', url: `/#/o/${o.id}` });
      else {
        push.notify('customer', o.customer_id, { title: 'Aklatak', body: '📦 وصل طلبك؟ يرجى تأكيد استلام الطلبية', url: `/#/o/${o.id}` });
        push.notify('store', o.cook_id, { title: 'Aklatak', body: `📦 سلّم السائق ${ref(o.id)} — بانتظار تأكيد الزبون`, url: '/store' });
      }
      return ok(res, { balance: await balance(db, 'driver', id) });
    })],

    ['GET', /^\/api\/driver\/report$/, driver(async (req, res, m, id) => {
      const p = q(req);
      return ok(res, { report: await driverReport(db, id, { period: p.get('period'), from: p.get('from'), to: p.get('to') }) });
    }, { activeOnly: false })],

    // Store with its own delivery: no driver, no fee from the balance. preparing → on the way → delivered.
    ['POST', /^\/api\/store\/orders\/(\d+)\/(self-dispatch|self-delivered)$/, store(async (req, res, m, cookId) => {
      const o = await mustOrder('SELECT id, status, self_delivery FROM orders WHERE id = $1 AND cook_id = $2', [Number(m[1]), cookId]);
      if (m[2] === 'self-dispatch') {
        if (o.status !== 'preparing') throw stateError();
        await db.query(`UPDATE orders SET status = 'picked_up', self_delivery = 1, picked_at = $1 WHERE id = $2`, [iso(), o.id]);
      } else {
        if (o.status !== 'picked_up' || !Number(o.self_delivery)) throw stateError();
        await db.query(`UPDATE orders SET status = 'delivered', delivered_at = $1, closed_at = $1 WHERE id = $2`, [iso(), o.id]);
      }
      return ok(res);
    })],

    // ===== appointments (clinics, salons …): only where the booking option is on =====
    ['POST', /^\/api\/appointments$/, customer(async (req, res, m, customerId) => {
      const b = await readJson(req);
      const v = new Validator();
      const storeId = v.int('storeId', b.storeId, { min: 1 });
      const service = v.text('service', b.service, { min: 2, max: 100 });
      const note = v.text('note', b.note, { max: 300, required: false, multiline: true });
      const d = new Date(b.startsAt);
      if (Number.isNaN(d.getTime()) || d.getTime() < Date.now() || d.getTime() > Date.now() + 90 * 864e5) v.fail('startsAt', 'invalid');
      v.assert();
      const st = await db.one(`SELECT c.id, c.booking FROM cooks c WHERE c.id = $2 AND ${VIS}`, [iso(), storeId]);
      if (!st) throw new HttpError(404, 'not_found');
      if (!Number(st.booking)) throw new HttpError(409, 'booking_not_in_plan');
      const open = await db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM appointments WHERE customer_id = $1 AND status IN ('pending','confirmed') AND starts_at > $2`, [customerId, iso()]);
      if (open.n >= 10) throw new HttpError(409, 'too_many_pending');
      const row = await db.one('INSERT INTO appointments (cook_id, customer_id, service, starts_at, note) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [storeId, customerId, service, d.toISOString(), note]);
      push.notify('store', storeId, { title: 'Aklatak', body: `📅 حجز جديد: ${service}`, url: '/store' });
      return ok(res, { id: row.id }, 201);
    })],

    // "My bookings" (customer): details, the store's reply, cancel, delete from the list.
    ['GET', /^\/api\/customer\/appointments$/, customer(async (req, res, m, id) => {
      const rows = await db.query(`SELECT a.id, a.service, a.starts_at, a.status, a.note, a.store_reply, a.cancelled_by, a.created_at, c.full_name AS store, a.cook_id, c.whatsapp AS store_phone
        FROM appointments a JOIN cooks c ON c.id = a.cook_id WHERE a.customer_id = $1 AND a.customer_hidden = 0 ORDER BY a.starts_at DESC LIMIT 100`, [id]);
      return ok(res, { appointments: rows.map((r) => ({ ...r, store_phone: r.status === 'confirmed' ? r.store_phone : null })) });
    })],

    ['POST', /^\/api\/customer\/appointments\/(\d+)\/(cancel|hide)$/, customer(async (req, res, m, id) => {
      const a = await mustOrder('SELECT id, status, cook_id, service FROM appointments WHERE id = $1 AND customer_id = $2', [Number(m[1]), id]);
      const live = ['pending', 'confirmed'].includes(a.status);
      if (m[2] === 'cancel' && !live) throw stateError();
      if (live) {   // deleting a live booking cancels it first, so the store is never left waiting
        await db.query(`UPDATE appointments SET status = 'cancelled', cancelled_by = 'customer', decided_at = $1 WHERE id = $2`, [iso(), a.id]);
        push.notify('store', a.cook_id, { title: 'Aklatak', body: `❌ ألغى الزبون الحجز: ${a.service}`, url: '/store' });
      }
      if (m[2] === 'hide') await db.query('UPDATE appointments SET customer_hidden = 1 WHERE id = $1', [a.id]);
      return ok(res);
    })],

    // The subscriber's appointment book.
    ['GET', /^\/api\/store\/appointments$/, store(async (req, res, m, cookId) => {
      const rows = await db.query(`SELECT a.id, a.service, a.starts_at, a.status, a.note, a.store_reply, a.cancelled_by, a.created_at, cu.name AS customer_name, cu.phone AS customer_phone
        FROM appointments a JOIN customers cu ON cu.id = a.customer_id WHERE a.cook_id = $1 AND a.store_hidden = 0 ORDER BY a.starts_at LIMIT 300`, [cookId]);
      return ok(res, { appointments: rows });
    })],

    // confirm / decline (with a message to the customer), done, cancel (with a reason), delete from the book
    ['POST', /^\/api\/store\/appointments\/(\d+)\/(confirm|decline|done|cancel|hide)$/, store(async (req, res, m, cookId) => {
      const a = await mustOrder('SELECT id, status, customer_id, service FROM appointments WHERE id = $1 AND cook_id = $2', [Number(m[1]), cookId]);
      const b = await readJson(req).catch(() => ({}));
      const v = new Validator();
      const reply = v.text('reply', b?.reply, { max: 300, required: false, multiline: true });
      v.assert();
      if (m[2] === 'hide') {
        if (['pending', 'confirmed'].includes(a.status)) {
          await db.query(`UPDATE appointments SET status = 'cancelled', cancelled_by = 'store', decided_at = $1 WHERE id = $2`, [iso(), a.id]);
          push.notify('customer', a.customer_id, { title: 'Aklatak', body: `❌ أُلغي حجزك: ${a.service}`, url: '/#/orders/appointments' });
        }
        await db.query('UPDATE appointments SET store_hidden = 1 WHERE id = $1', [a.id]);
        return ok(res);
      }
      const next = { confirm: 'confirmed', decline: 'declined', done: 'done', cancel: 'cancelled' }[m[2]];
      const from = { confirm: ['pending'], decline: ['pending'], done: ['confirmed'], cancel: ['pending', 'confirmed'] }[m[2]];
      if (!from.includes(a.status)) throw stateError();
      await db.query(`UPDATE appointments SET status = $1, decided_at = $2, store_reply = COALESCE($3, store_reply), cancelled_by = $4 WHERE id = $5`,
        [next, iso(), reply || null, next === 'cancelled' ? 'store' : null, a.id]);
      const msg = { confirmed: '✅ تأكّد حجزك', declined: '❌ اعتذر المحل عن الحجز', cancelled: '❌ أُلغي حجزك', done: '✔️ تمّ موعدك' }[next];
      push.notify('customer', a.customer_id, { title: 'Aklatak', body: `${msg}: ${a.service}${reply ? ` — ${reply}` : ''}`, url: '/#/orders/appointments' });
      return ok(res);
    })],

    // ===== "come to me": the customer calls a craftsperson to his place =====
    ['POST', /^\/api\/visits$/, customer(async (req, res, m, customerId) => {
      const b = await readJson(req);
      const v = new Validator();
      const storeId = v.int('craftId', b.craftId, { min: 1 });
      const description = v.text('description', b.description, { min: 5, max: 500, multiline: true });
      const details = v.text('details', b.details, { max: 300, required: false, multiline: true });
      const lat = Number(b.lat), lng = Number(b.lng);
      if (!isValidLatLng(lat, lng)) v.fail('location', 'invalid');
      v.assert();
      const c = await db.one(`SELECT c.id, c.kind, c.lat, c.lng FROM cooks c WHERE c.id = $2 AND ${VIS}`, [iso(), storeId]);
      if (!c || !isCraft(c.kind)) throw new HttpError(404, 'not_found');
      const open = await db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM visit_requests WHERE customer_id = $1 AND status = 'pending'`, [customerId]);
      if (open.n >= 5) throw new HttpError(409, 'too_many_pending');
      const row = await db.one('INSERT INTO visit_requests (cook_id, customer_id, description, lat, lng, details, distance_m) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [c.id, customerId, description, lat, lng, details, meters(c.lat, c.lng, lat, lng)]);
      return ok(res, { id: row.id }, 201);
    })],

    ['GET', /^\/api\/customer\/visits$/, customer(async (req, res, m, id) => {
      const rows = await db.query(`SELECT v.id, v.description, v.status, v.created_at, c.full_name AS craft, CASE WHEN v.status = 'accepted' THEN c.whatsapp ELSE NULL END AS phone
        FROM visit_requests v JOIN cooks c ON c.id = v.cook_id WHERE v.customer_id = $1 ORDER BY v.id DESC LIMIT 50`, [id]);
      return ok(res, { visits: rows });
    })],

    ['POST', /^\/api\/customer\/visits\/(\d+)\/cancel$/, customer(async (req, res, m, id) => {
      const r = await mustOrder('SELECT id, status FROM visit_requests WHERE id = $1 AND customer_id = $2', [Number(m[1]), id]);
      if (!['pending', 'accepted'].includes(r.status)) throw stateError();
      await db.query(`UPDATE visit_requests SET status = 'cancelled', decided_at = $1 WHERE id = $2`, [iso(), r.id]);
      return ok(res);
    })],

    // The craftsperson sees the distance first; the customer's location and phone only after accepting.
    ['GET', /^\/api\/store\/visits$/, store(async (req, res, m, cookId) => {
      const rows = await db.query(`SELECT v.*, cu.name AS customer_name, cu.phone AS customer_phone FROM visit_requests v JOIN customers cu ON cu.id = v.customer_id
        WHERE v.cook_id = $1 ORDER BY v.id DESC LIMIT 100`, [cookId]);
      return ok(res, {
        visits: rows.map((r) => {
          const shared = ['accepted', 'done'].includes(r.status);
          return {
            id: r.id, description: r.description, status: r.status, distanceM: r.distance_m, createdAt: r.created_at, customerName: r.customer_name,
            customer: shared ? { phone: r.customer_phone, lat: r.lat, lng: r.lng, details: r.details } : null,
          };
        }),
      });
    })],

    ['POST', /^\/api\/store\/visits\/(\d+)\/(accept|decline|done)$/, store(async (req, res, m, cookId) => {
      const r = await mustOrder('SELECT id, status FROM visit_requests WHERE id = $1 AND cook_id = $2', [Number(m[1]), cookId]);
      const next = { accept: 'accepted', decline: 'declined', done: 'done' }[m[2]];
      if ((m[2] === 'done' ? 'accepted' : 'pending') !== r.status) throw stateError();
      await db.query('UPDATE visit_requests SET status = $1, decided_at = $2 WHERE id = $3', [next, iso(), r.id]);
      return ok(res);
    })],

    // ===== withdrawals: driver & store, to any Whish/OMT number, confirmed with the account password =====
    ['GET', /^\/api\/(driver|store)\/withdrawals$/, async (req, res, m) => {
      const type = m[1];
      const id = type === 'driver' ? await driverSessions.ownerId(req) : await cookSessions.ownerId(req);
      if (!id) throw new HttpError(401, 'unauthorized');
      const s = await S.get();
      const rows = await db.query('SELECT id, amount, provider, number, status, created_at, decided_at FROM withdrawals WHERE account_type = $1 AND account_id = $2 ORDER BY id DESC LIMIT 100', [type, id]);
      const ledger = await db.query('SELECT amount, kind, order_id, note, created_at FROM wallet_ledger WHERE account_type = $1 AND account_id = $2 ORDER BY id DESC LIMIT 100', [type, id]);
      return ok(res, { balance: await balance(db, type, id), minimum: type === 'driver' ? s.payoutThreshold : s.storeMinWithdraw, dailyMax: s.dailyWithdrawMax, withdrawals: rows, ledger });
    }],

    ['POST', /^\/api\/(driver|store)\/withdrawals$/, async (req, res, m) => {
      checkCsrf(req);
      const type = m[1];
      const id = type === 'driver' ? await driverSessions.ownerId(req) : await cookSessions.ownerId(req);
      if (!id) throw new HttpError(401, 'unauthorized');
      await limit(limiters.login, `wd:${type}:${id}`);            // slows down password guessing
      const acct = type === 'driver'
        ? await db.one('SELECT password_hash, status FROM drivers WHERE id = $1', [id])
        : await db.one('SELECT password_hash, status, suspended FROM cooks WHERE id = $1', [id]);
      if (!acct || acct.status === 'suspended' || acct.status === 'rejected' || Number(acct.suspended)) throw new HttpError(403, 'account_suspended');
      const b = await readJson(req);
      const v = new Validator();
      const amount = v.number('amount', b.amount, { min: 0.01, max: 100000 });
      // exactly what was typed, in whole cents: 10 means 10.00 — never more, never rounded up
      if (Number.isFinite(amount) && Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) v.fail('amount', 'invalid');
      const provider = v.oneOf('provider', b.provider, ['whish', 'omt']);
      const number = normalizePhone(b.number, b.country || 'LB') || v.fail('number', 'invalid');
      v.assert();
      if (!(await verifyPassword(String(b.password || ''), acct.password_hash || DUMMY_HASH))) throw new HttpError(401, 'wrong_password');
      const s = await S.get();
      const minimum = type === 'driver' ? s.payoutThreshold : s.storeMinWithdraw;
      const row = await db.tx(async (t) => {
        await lockAccount(t, db.kind, type, id);
        const bal = await balance(t, type, id);
        if (amount > bal) throw new HttpError(402, 'insufficient_balance', { balance: bal });
        if (amount < minimum) throw new HttpError(422, 'below_minimum', { minimum });
        const day = await t.one(`SELECT COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE account_type = $1 AND account_id = $2 AND status <> 'rejected' AND created_at >= $3`,
          [type, id, new Date(Date.now() - 864e5).toISOString()]);
        if (Number(day.s) + amount > s.dailyWithdrawMax) throw new HttpError(422, 'daily_limit', { dailyMax: s.dailyWithdrawMax });
        const w = await t.one('INSERT INTO withdrawals (account_type, account_id, amount, provider, number, ip_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
          [type, id, Math.round(amount * 100) / 100, provider, number, hmacHex(cfg.sessionSecret, ip(req)).slice(0, 16)]);
        await ledgerAdd(t, type, id, -amount, 'payout', { note: `withdrawal #${w.id} ${provider} ${number}` });
        return w;
      });
      // A driver who withdraws starts a clean list: settled deliveries leave his screen (they stay in the records).
      if (type === 'driver') {
        await db.query(`UPDATE orders SET driver_hidden = 1 WHERE driver_id = $1 AND status = 'delivered' AND NOT ${OWED}`, [id]);
        await db.query(`UPDATE errands SET driver_hidden = 1 WHERE driver_id = $1 AND status IN ('delivered','cancelled')`, [id]);
      }
      // When the payout keys are set (PAYOUT_API_URL/KEY), the transfer is sent automatically; otherwise the owner pays it by hand.
      let status = 'pending';
      if (payments.payOutEnabled) {
        const w = await db.one('SELECT id, amount, provider, number FROM withdrawals WHERE id = $1', [row.id]);
        const r = await payments.payout({ reference: `W${w.id}`, amount: Number(w.amount), provider: w.provider, number: w.number });
        if (r.ok) {
          const done = await db.query(`UPDATE withdrawals SET status = 'paid', decided_at = $1, auto_ref = $2 WHERE id = $3 AND status = 'pending' RETURNING id`, [iso(), String(r.id || 'auto'), w.id]);
          if (done.length) status = 'paid';
        }
      }
      if (status === 'pending') push.notifyAdmins({ title: 'Aklatak — الإدارة', body: `💸 طلب سحب ${Math.round(amount * 100) / 100}$ (${type === 'driver' ? 'سائق' : 'متجر'})`, url: '/admin/#dx-payouts' });
      return ok(res, { id: row.id, status, amount: Math.round(amount * 100) / 100, balance: await balance(db, type, id) }, 201);
    }],

    ['GET', /^\/api\/admin\/withdrawals$/, owner(async (req, res) => {
      const p = q(req);
      const st = p.get('status') || 'pending';
      const params = [st];
      let extra = '';
      if (p.get('type') && p.get('id')) { params.push(p.get('type'), Number(p.get('id'))); extra = ' AND w.account_type = $2 AND w.account_id = $3'; }
      const rows = await db.query(`SELECT w.*, CASE WHEN w.account_type = 'driver' THEN d.full_name ELSE c.full_name END AS name,
          CASE WHEN w.account_type = 'driver' THEN d.phone ELSE c.whatsapp END AS phone
        FROM withdrawals w LEFT JOIN drivers d ON w.account_type = 'driver' AND d.id = w.account_id LEFT JOIN cooks c ON w.account_type = 'store' AND c.id = w.account_id
        WHERE ${st === 'all' ? '$1 = $1' : 'w.status = $1'}${extra} ORDER BY w.id DESC LIMIT 300`, params);
      return ok(res, { withdrawals: rows });
    })],

    ['POST', /^\/api\/admin\/withdrawals\/(\d+)\/(paid|reject)$/, owner(async (req, res, m) => {
      await db.tx(async (t) => {
        const w = await t.one('SELECT id, account_type, account_id, amount, status FROM withdrawals WHERE id = $1', [Number(m[1])]);
        if (!w) throw new HttpError(404, 'not_found');
        if (w.status !== 'pending') throw stateError();
        const done = await t.query(`UPDATE withdrawals SET status = $1, decided_at = $2 WHERE id = $3 AND status = 'pending' RETURNING id`, [m[2] === 'paid' ? 'paid' : 'rejected', iso(), w.id]);
        if (!done.length) throw stateError();
        if (m[2] === 'reject') await ledgerAdd(t, w.account_type, w.account_id, Number(w.amount), 'adjust', { note: `withdrawal #${w.id} refused` });
      });
      return ok(res);
    })],

    // Full money log of one account (admin).
    ['GET', /^\/api\/admin\/ledger$/, owner(async (req, res) => {
      const p = q(req);
      const v = new Validator();
      const type = v.oneOf('type', p.get('type'), ['store', 'driver']);
      const id = v.int('id', p.get('id'), { min: 1 });
      v.assert();
      const ledger = await db.query('SELECT amount, kind, order_id, note, created_at FROM wallet_ledger WHERE account_type = $1 AND account_id = $2 ORDER BY id DESC LIMIT 300', [type, id]);
      const withdrawals = await db.query('SELECT id, amount, provider, number, status, created_at, decided_at FROM withdrawals WHERE account_type = $1 AND account_id = $2 ORDER BY id DESC LIMIT 100', [type, id]);
      return ok(res, { balance: await balance(db, type, id), ledger, withdrawals, warnings: (await warningsOf(type, id)).items });
    })],

    // ===== errands: the customer asks a driver directly (deliver / bring from a shop / service). Cash between them. =====
    ['POST', /^\/api\/errands$/, customer(async (req, res, m, customerId) => {
      const b = await readJson(req);
      const s = await S.get();
      const v = new Validator();
      const kind = v.oneOf('kind', b.kind, ['deliver', 'buy', 'service']);
      const description = v.text('description', b.description, { min: 3, max: 500, multiline: true });
      const price = v.number('price', b.price, { min: s.errandMinPrice, max: 500 });
      const f = b.from || {}, to = b.to || {};
      const fl = [Number(f.lat), Number(f.lng)], tl = [Number(to.lat), Number(to.lng)];
      if (!isValidLatLng(...fl)) v.fail('from', 'invalid');
      if (!isValidLatLng(...tl)) v.fail('to', 'invalid');
      const fromDetails = v.text('fromDetails', f.details, { max: 300, required: false });
      const toDetails = v.text('toDetails', to.details, { max: 300, required: false });
      let purchase = null;
      if (kind === 'buy' && b.purchaseValue != null && b.purchaseValue !== '') purchase = v.number('purchaseValue', b.purchaseValue, { min: 0, max: s.maxPurchaseValue });
      v.assert();
      const open = await db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM errands WHERE customer_id = $1 AND status IN ('searching','assigned','picked_up')`, [customerId]);
      if (open.n >= 3) throw new HttpError(409, 'too_many_pending');
      await limit(limiters.contact, `errand:${customerId}`);
      const me = await db.one(`SELECT COALESCE(country, 'LB') AS country FROM customers WHERE id = $1`, [customerId]);
      const trip = await road({ lat: fl[0], lng: fl[1] }, { lat: tl[0], lng: tl[1] });
      const e = await db.one(`INSERT INTO errands (customer_id, kind, description, from_lat, from_lng, from_details, to_lat, to_lng, to_details, price, purchase_value, distance_m, search_started_at, country)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [customerId, kind, description, fl[0], fl[1], fromDetails, tl[0], tl[1], toDetails, price, purchase, trip.m ?? meters(fl[0], fl[1], tl[0], tl[1]), iso(), me.country]);
      const sent = await dispatchErrand(db, e, s, roads);
      notifyErrand(e.id);
      return ok(res, { id: e.id, driversNotified: sent, distanceM: e.distance_m }, 201);
    })],

    ['GET', /^\/api\/customer\/errands$/, customer(async (req, res, m, id) => {
      const rows = await db.query(`SELECT id, kind, description, status, price, created_at FROM errands WHERE customer_id = $1 AND customer_hidden = 0 ORDER BY id DESC LIMIT 50`, [id]);
      return ok(res, { errands: rows });
    })],

    ['GET', /^\/api\/customer\/errands\/(\d+)$/, customer(async (req, res, m, id) => {
      await settleClaims();
      const e = await mustOrder('SELECT * FROM errands WHERE id = $1 AND customer_id = $2', [Number(m[1]), id]);
      const s = await S.get();
      let drv = null;
      if (e.driver_id) {
        const d = await db.one('SELECT id, full_name, phone, vehicle, lat, lng FROM drivers WHERE id = $1', [e.driver_id]);
        if (d) {
          drv = { id: d.id, name: firstName(d.full_name), phone: d.phone, vehicle: d.vehicle, photo: await hasPhoto(d.id) };
          if (['assigned', 'picked_up'].includes(e.status) && d.lat != null) {
            const target = e.status === 'assigned' ? { lat: e.from_lat, lng: e.from_lng } : { lat: e.to_lat, lng: e.to_lng };
            const r = await road(d, target, `d${d.id}`); drv.awayM = r.m; drv.approx = r.approx; drv.toStart = e.status === 'assigned';
          }
        }
      }
      const cands = e.status === 'searching' ? await candidates('errand', e.id, { lat: e.from_lat, lng: e.from_lng }) : [];
      const sent = cands.length;
      const messages = e.driver_id ? await db.query('SELECT id, from_type, body, created_at FROM errand_messages WHERE errand_id = $1 ORDER BY id', [e.id]) : [];
      return ok(res, {
        errand: {
          id: e.id, kind: e.kind, description: e.description, status: e.status, price: e.price, purchaseValue: e.purchase_value, distanceM: e.distance_m,
          from: { lat: e.from_lat, lng: e.from_lng, details: e.from_details }, to: { lat: e.to_lat, lng: e.to_lng, details: e.to_details },
          driversNotified: sent, candidates: cands, canRaise: e.status === 'searching' && (Date.now() - Date.parse(e.search_started_at)) >= s.raiseAfterSec * 1000,
          driver: drv, createdAt: e.created_at, messages,
        },
      });
    })],

    ['POST', /^\/api\/customer\/errands\/(\d+)\/(cancel|raise)$/, customer(async (req, res, m, id) => {
      const e = await mustOrder('SELECT * FROM errands WHERE id = $1 AND customer_id = $2', [Number(m[1]), id]);
      if (m[2] === 'cancel') {
        if (!['searching', 'assigned'].includes(e.status)) throw stateError();
        await db.query(`UPDATE errand_offers SET status = 'lost' WHERE errand_id = $1 AND status = 'sent'`, [e.id]);
        await db.query(`UPDATE errands SET status = 'cancelled', closed_at = $1, close_reason = 'customer' WHERE id = $2`, [iso(), e.id]);
        return ok(res);
      }
      if (e.status !== 'searching') throw stateError();
      const b = await readJson(req);
      const v = new Validator();
      const price = v.number('price', b.price, { min: Number(e.price) + 0.01, max: 500 });
      v.assert();
      await db.query('UPDATE errands SET price = $1, search_started_at = $2 WHERE id = $3', [price, iso(), e.id]);
      const sent = await dispatchErrand(db, { ...e, price }, await S.get(), roads);
      notifyErrand(e.id);
      return ok(res, { driversNotified: sent });
    })],

    // Chat (after a driver accepted). Both sides post; the owner only sees it when a complaint is filed.
    ['POST', /^\/api\/errands\/(\d+)\/messages$/, async (req, res, m) => {
      checkCsrf(req);
      const e = await db.one('SELECT id, customer_id, driver_id, status FROM errands WHERE id = $1', [Number(m[1])]);
      if (!e) throw new HttpError(404, 'not_found');
      const cid = await custSessions.ownerId(req), did = await driverSessions.ownerId(req);
      const from = cid && cid === e.customer_id ? 'customer' : did && did === e.driver_id ? 'driver' : null;
      if (!from) throw new HttpError(403, 'forbidden');
      if (!e.driver_id || ['cancelled'].includes(e.status)) throw stateError();
      await limit(limiters.lookup, `chat:${from}:${from === 'customer' ? cid : did}`);
      const b = await readJson(req);
      const v = new Validator();
      const body = v.text('body', b.body, { min: 1, max: 1000, multiline: true });
      v.assert();
      await db.query('INSERT INTO errand_messages (errand_id, from_type, body) VALUES ($1,$2,$3)', [e.id, from, body]);
      return ok(res, { ok: true }, 201);
    }],

    // Driver photos (his selfie): only to a store or customer who has a request with him, and to himself.
    ['GET', /^\/api\/store\/driver-photo\/(\d+)$/, store(async (req, res, m, cookId) => {
      const did = Number(m[1]);
      const rel = await db.one(`SELECT 1 AS x FROM orders o WHERE o.cook_id = $1 AND (o.driver_id = $2 OR EXISTS (SELECT 1 FROM order_offers f WHERE f.order_id = o.id AND f.driver_id = $2)) LIMIT 1`, [cookId, did]);
      if (!rel) throw new HttpError(404, 'not_found');
      return sendPhoto(res, did);
    })],
    ['GET', /^\/api\/customer\/driver-photo\/(\d+)$/, customer(async (req, res, m, cid) => {
      const did = Number(m[1]);
      const rel = await db.one(`SELECT 1 AS x FROM orders WHERE customer_id = $1 AND driver_id = $2
        UNION SELECT 1 AS x FROM errands e WHERE e.customer_id = $1 AND (e.driver_id = $2 OR EXISTS (SELECT 1 FROM errand_offers f WHERE f.errand_id = e.id AND f.driver_id = $2))`, [cid, did]);
      if (!rel) throw new HttpError(404, 'not_found');
      return sendPhoto(res, did);
    })],
    ['GET', /^\/api\/driver\/photo$/, driver(async (req, res, m, id) => sendPhoto(res, id), { activeOnly: false })],

    ['POST', /^\/api\/driver\/errand-offers\/(\d+)\/(accept|decline)$/, driver(async (req, res, m, id) => {
      const offerId = Number(m[1]);
      if (m[2] === 'decline') {
        await db.query(`UPDATE errand_offers SET status = 'declined' WHERE id = $1 AND driver_id = $2 AND status = 'sent'`, [offerId, id]);
        return ok(res);
      }
      const d = await db.one('SELECT jobs_until FROM drivers WHERE id = $1', [id]);
      if (!d.jobs_until || d.jobs_until <= iso()) throw new HttpError(403, 'jobs_subscription_required');
      let r;
      try { r = await claimOffer(db, await S.get(), 'errand', { offerId, driverId: id, roads }); } catch (e) { throw gone(e); }
      await settleClaims();
      const e = await db.one('SELECT driver_id, status FROM errands WHERE id = $1', [r.pid]);
      if (e.driver_id === id) return ok(res, { errandId: r.pid, won: true });
      if (e.status !== 'searching') throw new HttpError(409, 'offer_gone');
      return ok(res, { errandId: r.pid, won: false, pending: true, decideAt: r.until });
    })],

    ['POST', /^\/api\/driver\/errands\/(\d+)\/(picked|delivered)$/, driver(async (req, res, m, id) => {
      const e = await mustOrder('SELECT id, status FROM errands WHERE id = $1 AND driver_id = $2', [Number(m[1]), id]);
      if (m[2] === 'picked') {
        if (e.status !== 'assigned') throw stateError();
        await db.query(`UPDATE errands SET status = 'picked_up', picked_at = $1 WHERE id = $2`, [iso(), e.id]);
      } else {
        if (!['assigned', 'picked_up'].includes(e.status)) throw stateError();
        await db.query(`UPDATE errands SET status = 'delivered', delivered_at = $1, closed_at = $1 WHERE id = $2`, [iso(), e.id]);
      }
      return ok(res);
    })],

    ['POST', /^\/api\/admin\/drivers\/(\d+)\/jobs$/, owner(async (req, res, m) => {
      const b = await readJson(req);
      const v = new Validator();
      const months = v.int('months', b.months, { min: 0, max: 24 });
      v.assert();
      const d = await db.one('SELECT id, jobs_until FROM drivers WHERE id = $1', [Number(m[1])]);
      if (!d) throw new HttpError(404, 'not_found');
      let until = null;
      if (months > 0) {
        const from = d.jobs_until && d.jobs_until > iso() ? new Date(d.jobs_until) : new Date();
        from.setUTCMonth(from.getUTCMonth() + months);
        until = from.toISOString();
      }
      await db.query('UPDATE drivers SET jobs_until = $1 WHERE id = $2', [until, d.id]);
      return ok(res, { until });
    })],

    ['GET', /^\/api\/admin\/errands$/, owner(async (req, res) => {
      const rows = await db.query(`SELECT e.id, e.kind, e.status, e.price, e.purchase_value, e.distance_m, e.created_at, cu.name AS customer, d.full_name AS driver,
          EXISTS (SELECT 1 FROM complaints c WHERE c.errand_id = e.id) AS has_complaint
        FROM errands e JOIN customers cu ON cu.id = e.customer_id LEFT JOIN drivers d ON d.id = e.driver_id ${cOf(req) ? `WHERE COALESCE(e.country,'LB') = $1` : ''} ORDER BY e.id DESC LIMIT 200`, cOf(req) ? [cOf(req)] : []);
      return ok(res, { errands: rows });
    })],

    // The private chat is shown to the owner only when there is a complaint about this errand.
    ['GET', /^\/api\/admin\/errands\/(\d+)\/messages$/, owner(async (req, res, m) => {
      const id = Number(m[1]);
      if (!(await db.one('SELECT id FROM complaints WHERE errand_id = $1', [id]))) throw new HttpError(403, 'no_complaint');
      return ok(res, { messages: await db.query('SELECT from_type, body, created_at FROM errand_messages WHERE errand_id = $1 ORDER BY id', [id]) });
    })],

    // ===== delete anything (owner): keeps the admin panel tidy =====
    ['DELETE', /^\/api\/admin\/(drivers|customers|orders|errands|complaints|warnings|withdrawals|topups)\/(\d+)$/, owner(async (req, res, m) => {
      const what = m[1], id = Number(m[2]);
      await db.tx(async (t) => {
        if (what === 'drivers') {
          if (!(await t.one('SELECT id FROM drivers WHERE id = $1', [id]))) throw new HttpError(404, 'not_found');
          await t.query(`DELETE FROM wallet_ledger WHERE account_type = 'driver' AND account_id = $1`, [id]);
          await t.query(`DELETE FROM withdrawals WHERE account_type = 'driver' AND account_id = $1`, [id]);
          await t.query(`DELETE FROM warnings WHERE account_type = 'driver' AND account_id = $1`, [id]);
          await t.query(`DELETE FROM complaints WHERE (from_type = 'driver' AND from_id = $1) OR (against_type = 'driver' AND against_id = $1)`, [id]);
          await t.query('DELETE FROM drivers WHERE id = $1', [id]);            // documents, sessions and offers go with it
        } else if (what === 'customers') {
          if (!(await t.one('SELECT id FROM customers WHERE id = $1', [id]))) throw new HttpError(404, 'not_found');
          await t.query(`DELETE FROM warnings WHERE account_type = 'customer' AND account_id = $1`, [id]);
          await t.query(`DELETE FROM complaints WHERE (from_type = 'customer' AND from_id = $1) OR (against_type = 'customer' AND against_id = $1)`, [id]);
          await t.query('DELETE FROM customers WHERE id = $1', [id]);          // addresses, orders, errands, chats, appointments go with it
        } else if (what === 'withdrawals' || what === 'topups') {
          const r = await t.one(`SELECT status FROM ${what} WHERE id = $1`, [id]);
          if (!r) throw new HttpError(404, 'not_found');
          if (r.status === 'pending') throw stateError();                   // decide it first (money is involved)
          await t.query(`DELETE FROM ${what} WHERE id = $1`, [id]);
        } else {
          const table = { orders: 'orders', errands: 'errands', complaints: 'complaints', warnings: 'warnings' }[what];
          const r = await t.query(`DELETE FROM ${table} WHERE id = $1 RETURNING id`, [id]);
          if (!r.length) throw new HttpError(404, 'not_found');
        }
      });
      return ok(res);
    })],

    // Store: remove its delivery data (balance history, withdrawals, warnings, complaints) before deleting the store itself.
    ['DELETE', /^\/api\/admin\/delivery\/stores\/(\d+)\/leftovers$/, owner(async (req, res, m) => {
      const id = Number(m[1]);
      await db.query(`DELETE FROM wallet_ledger WHERE account_type = 'store' AND account_id = $1`, [id]);
      await db.query(`DELETE FROM withdrawals WHERE account_type = 'store' AND account_id = $1`, [id]);
      await db.query(`DELETE FROM warnings WHERE account_type = 'store' AND account_id = $1`, [id]);
      await db.query(`DELETE FROM complaints WHERE (from_type = 'store' AND from_id = $1) OR (against_type = 'store' AND against_id = $1)`, [id]);
      return ok(res);
    })],

    // Clear finished things older than N days in one go (balances are not touched).
    ['POST', /^\/api\/admin\/delivery\/cleanup$/, owner(async (req, res) => {
      const b = await readJson(req);
      const v = new Validator();
      // only when the owner presses the button; "all" = everything finished, whatever its age
      const days = b.all === true ? 0 : v.int('days', b.days, { min: 1, max: 3650 });
      v.assert();
      const before = new Date(Date.now() - days * 864e5 + (days ? 0 : 1000)).toISOString();
      const n = async (sql) => (await db.query(sql, [before])).length;
      const out = {
        // never orders whose money isn't finished; orders under the v7.6 money rules are financial records → kept (only hidden)
        orders: await n(`DELETE FROM orders WHERE status IN ('delivered','rejected','cancelled') AND created_at < $1
          AND NOT (status = 'delivered' AND ${OWED}) AND NOT (customer_total IS NOT NULL AND (status = 'delivered' OR payment_status IN ('paid','refund_pending','refunded'))) RETURNING id`),
        errands: await n(`DELETE FROM errands WHERE status IN ('delivered','cancelled') AND created_at < $1 RETURNING id`),
        complaints: await n(`DELETE FROM complaints WHERE status <> 'open' AND created_at < $1 RETURNING id`),
        withdrawals: await n(`DELETE FROM withdrawals WHERE status <> 'pending' AND created_at < $1 RETURNING id`),
        topups: await n(`DELETE FROM topups WHERE status <> 'pending' AND created_at < $1 RETURNING id`),
        appointments: await n(`DELETE FROM appointments WHERE status IN ('declined','cancelled','done') AND created_at < $1 RETURNING id`),
        visits: await n(`DELETE FROM visit_requests WHERE status IN ('declined','cancelled','done') AND created_at < $1 RETURNING id`),
      };
      return ok(res, out);
    })],

    // ===== owner: delete a whole country (its shops and, if asked, its drivers and customers) or a whole category =====
    ['DELETE', /^\/api\/admin\/countries\/([A-Za-z]{2})$/, owner(async (req, res, m) => {
      const cc = m[1].toUpperCase();
      const p = q(req);
      const n = { stores: 0, drivers: 0, customers: 0 };
      const stores = await db.query(`SELECT id FROM cooks WHERE COALESCE(country, 'LB') = $1`, [cc]);
      for (const { id } of stores) {
        await db.query(`DELETE FROM wallet_ledger WHERE account_type = 'store' AND account_id = $1`, [id]);
        await db.query(`DELETE FROM withdrawals WHERE account_type = 'store' AND account_id = $1`, [id]);
        await db.query(`DELETE FROM warnings WHERE account_type = 'store' AND account_id = $1`, [id]);
      }
      n.stores = (await db.query(`DELETE FROM cooks WHERE COALESCE(country, 'LB') = $1 RETURNING id`, [cc])).length;
      if (p.get('people') === '1') {
        for (const { id } of await db.query(`SELECT id FROM drivers WHERE COALESCE(country, 'LB') = $1`, [cc])) {
          for (const t of ['wallet_ledger', 'withdrawals', 'warnings']) await db.query(`DELETE FROM ${t} WHERE account_type = 'driver' AND account_id = $1`, [id]);
        }
        n.drivers = (await db.query(`DELETE FROM drivers WHERE COALESCE(country, 'LB') = $1 RETURNING id`, [cc])).length;
        n.customers = (await db.query(`DELETE FROM customers WHERE COALESCE(country, 'LB') = $1 RETURNING id`, [cc])).length;
      }
      if (settings) {
        const cur = settings.get();
        const extra = { ...(cur.extraCountries || {}) }; delete extra[cc];
        const cats = { ...(cur.countryCatsHidden || {}) }; delete cats[cc];
        await settings.save({ extraCountries: extra, countryCatsHidden: cats, countriesHidden: (cur.countriesHidden || []).filter((x) => x !== cc), countriesRemoved: [...(cur.countriesRemoved || []), cc] });
      }
      cache?.clear?.('');
      return ok(res, n);
    })],
    ['POST', /^\/api\/admin\/countries\/([A-Za-z]{2})\/restore$/, owner(async (req, res, m) => {
      const cc = m[1].toUpperCase();
      if (settings) await settings.save({ countriesRemoved: (settings.get().countriesRemoved || []).filter((x) => x !== cc) });
      cache?.clear?.('');
      return ok(res);
    })],
    ['DELETE', /^\/api\/admin\/categories\/([a-z][a-z0-9_]{1,30})$/, owner(async (req, res, m) => {
      const key = m[1];
      const withShops = q(req).get('shops') === '1';
      let stores = 0;
      if (withShops) stores = (await db.query(`DELETE FROM cooks WHERE kind = $1 RETURNING id`, [key])).length;
      if (settings) {
        const cats = (settings.get().categories || []).map((c) => (c.key === key ? { ...c, deleted: true } : c));
        await settings.save({ categories: cats });
      }
      cache?.clear?.('');
      return ok(res, { stores });
    })],

    ['GET', /^\/api\/admin\/designs$/, owner(async (req, res) => ok(res, {
      current: settings?.get?.().designPreset || 'emerald',
      designs: [...Object.entries(DESIGNS).map(([key, d]) => ({ key, name: d.name, colors: [d.vars.bg, d.vars.brand, d.vars.accent, d.vars.ink] })), { key: 'custom', name: { ar: 'ألواني الخاصة (من «التصميم»)', en: 'My own colours' }, colors: [] }],
    }))],
    ['PUT', /^\/api\/admin\/designs$/, owner(async (req, res) => {
      const b = await readJson(req);
      if (b.key !== 'custom' && !DESIGNS[b.key]) throw new HttpError(422, 'validation_failed', { fields: { key: 'invalid' } });
      await settings?.save?.({ designPreset: b.key });
      cache?.clear?.('');
      return ok(res, { current: b.key });
    })],

    /* ======================= v7.5 operations ======================= */

    // Send to drivers again with the same fee (e.g. after a driver refused an add-on).
    ['POST', /^\/api\/store\/orders\/(\d+)\/redispatch$/, store(async (req, res, m, cookId) => {
      const o = await mustOrder('SELECT * FROM orders WHERE id = $1 AND cook_id = $2', [Number(m[1]), cookId]);
      if (o.status !== 'searching') throw stateError();
      await db.query(`UPDATE orders SET search_started_at = $1, claim_until = NULL WHERE id = $2`, [iso(), o.id]);
      await db.query(`UPDATE order_offers SET addon = 0 WHERE order_id = $1`, [o.id]);
      const st = await db.one('SELECT id, lat, lng, country FROM cooks WHERE id = $1', [cookId]);
      const sent = await dispatch(db, o, st, await S.get(), roads);
      notifyOffers(o.id);
      return ok(res, { driversNotified: sent });
    })],

    // Same driver takes a second order from this store — only if HE accepts. The customer's delivery fee is his; the store may
    // add a bonus (paid in cash at pick-up). Old orders (before v7.6) keep the old rule (extra fee held from the store).
    ['POST', /^\/api\/store\/orders\/(\d+)\/same-driver$/, store(async (req, res, m, cookId) => {
      const b = await readJson(req);
      const v = new Validator();
      const driverId = v.int('driverId', b.driverId, { min: 1 });
      const extra = b.bonus ?? b.fee;
      const amount = extra == null || extra === '' ? 0 : v.number('bonus', extra, { min: 0, max: 1000 });
      v.assert();
      const out = await db.tx(async (t) => {
        const o = await t.one('SELECT * FROM orders WHERE id = $1 AND cook_id = $2', [Number(m[1]), cookId]);
        if (!o) throw new HttpError(404, 'not_found');
        if (o.status !== 'preparing') throw stateError();
        const mode = (await t.one('SELECT delivery_mode FROM cooks WHERE id = $1', [cookId])).delivery_mode;
        if (mode !== 'delivery') throw new HttpError(409, 'drivers_not_in_plan');
        const onMine = await t.one(`SELECT id FROM orders WHERE driver_id = $1 AND cook_id = $2 AND status IN ('assigned','picked_up')`, [driverId, cookId]);
        if (!onMine) throw new HttpError(409, 'driver_not_with_you');
        let offerFee;
        if (o.customer_total != null) {
          await t.query(`UPDATE orders SET status = 'searching', bonus_fee = $1, search_started_at = $2 WHERE id = $3`, [amount, iso(), o.id]);
          offerFee = Math.round((Number(o.delivery_fee || 0) + amount) * 100) / 100;
        } else {
          if (!(amount >= 0.5)) throw new HttpError(422, 'validation_failed', { fields: { fee: 'invalid' } });
          await lockAccount(t, db.kind, 'store', cookId);
          const bal = await balance(t, 'store', cookId);
          if (bal < amount) throw new HttpError(402, 'insufficient_balance', { balance: bal, needed: amount });
          await ledgerAdd(t, 'store', cookId, -amount, 'hold', { orderId: o.id, note: 'same driver' });
          await t.query(`UPDATE orders SET status = 'searching', delivery_fee = $1, search_started_at = $2 WHERE id = $3`, [amount, iso(), o.id]);
          offerFee = amount;
        }
        await t.query(`INSERT INTO order_offers (order_id, driver_id, fee, addon) VALUES ($1,$2,$3,1)`, [o.id, driverId, offerFee]);
        return { ...o, offerFee };
      });
      push.notify('driver', driverId, { title: 'Aklatak', body: `➕ طلب إضافي من نفس المتجر ${ref(out.id)} — أجرتك ${out.offerFee}$`, url: '/driver' });
      return ok(res, { ok: true, balance: await balance(db, 'store', cookId) });
    })],

    // Driver late / no delivery bag / not suitable: take the order back from him (before pick-up) and send it again.
    ['POST', /^\/api\/store\/orders\/(\d+)\/replace-driver$/, store(async (req, res, m, cookId) => {
      const b = await readJson(req);
      const v = new Validator();
      const reason = v.text('reason', b.reason, { min: 3, max: 300 });
      v.assert();
      const o = await db.tx(async (t) => {
        const o = await t.one('SELECT * FROM orders WHERE id = $1 AND cook_id = $2', [Number(m[1]), cookId]);
        if (!o) throw new HttpError(404, 'not_found');
        if (o.status !== 'assigned') throw stateError();
        await t.query(`UPDATE order_offers SET status = 'declined' WHERE order_id = $1 AND driver_id = $2`, [o.id, o.driver_id]);
        await t.query(`UPDATE orders SET status = 'searching', driver_id = NULL, assigned_at = NULL, location_sent = 0, claim_until = NULL, search_started_at = $1, reassigns = reassigns + 1 WHERE id = $2`, [iso(), o.id]);
        await t.query('INSERT INTO complaints (order_id, from_type, from_id, against_type, against_id, text) VALUES ($1,$2,$3,$4,$5,$6)',
          [o.id, 'store', cookId, 'driver', o.driver_id, `[استبدال السائق] ${reason}`]);
        return o;
      });
      push.notify('driver', o.driver_id, { title: 'Aklatak', body: `أُلغي تكليفك بالطلب ${ref(o.id)}: ${reason}`, url: '/driver' });
      const st = await db.one('SELECT id, lat, lng, country FROM cooks WHERE id = $1', [cookId]);
      const sent = await dispatch(db, o, st, await S.get(), roads);
      notifyOffers(o.id);
      return ok(res, { driversNotified: sent });
    })],

    // The driver pressed "delivered" but the order never arrived: before the customer confirms, the store takes its fee back.
    ['POST', /^\/api\/store\/orders\/(\d+)\/not-delivered$/, store(async (req, res, m, cookId) => {
      const b = await readJson(req);
      const v = new Validator();
      const reason = v.text('reason', b.reason, { min: 3, max: 300 });
      v.assert();
      const o = await db.tx(async (t) => {
        const o = await t.one('SELECT * FROM orders WHERE id = $1 AND cook_id = $2', [Number(m[1]), cookId]);
        if (!o) throw new HttpError(404, 'not_found');
        if (o.customer_total == null) {   // legacy: the store's held fee comes back
          const r = await t.query(`UPDATE orders SET fee_state = 'refunded', cancel_note = $1 WHERE id = $2 AND status = 'delivered' AND fee_state = 'awaiting' RETURNING id`, [reason, o.id]);
          if (!r.length) throw stateError();
          await ledgerAdd(t, 'store', cookId, Number(o.delivery_fee), 'release', { orderId: o.id, note: 'not delivered' });
        } else {          // v7.6: the order is frozen (no money moves) until the owner decides
          const r = await t.query(`UPDATE orders SET financial_status = 'disputed', cancel_note = $1 WHERE id = $2 AND status = 'delivered' AND financial_status = 'open' RETURNING id`, [reason, o.id]);
          if (!r.length) throw stateError();
          await journal(t, { kind: 'dispute_opened', orderId: o.id, storeId: cookId, driverId: o.driver_id, amount: 0, note: reason });
        }
        await t.query('INSERT INTO complaints (order_id, from_type, from_id, against_type, against_id, text) VALUES ($1,$2,$3,$4,$5,$6)',
          [o.id, 'store', cookId, 'driver', o.driver_id, `[لم يُسلَّم] ${reason}`]);
        return o;
      });
      push.notify('driver', o.driver_id, { title: 'Aklatak', body: `⚠️ أبلغ المتجر أن ${ref(o.id)} لم يُسلَّم — بانتظار قرار الإدارة`, url: '/driver' });
      push.notifyAdmins({ title: 'Aklatak — الإدارة', body: `⚠️ نزاع: ${ref(o.id)} لم يُسلَّم`, url: '/admin/#dx-complaints' });
      return ok(res, { balance: await balance(db, 'store', cookId) });
    })],

    // The driver paid the store for the order (Whish/OMT with the reference AKL…, or cash).
    ['POST', /^\/api\/store\/orders\/(\d+)\/(paid|unpaid)$/, store(async (req, res, m, cookId) => {
      const o = await mustOrder('SELECT id, status, driver_id FROM orders WHERE id = $1 AND cook_id = $2', [Number(m[1]), cookId]);
      if (!['delivered', 'picked_up', 'assigned'].includes(o.status)) throw stateError();
      const paid = m[2] === 'paid';
      await db.query('UPDATE orders SET store_paid = $1, store_paid_at = $2 WHERE id = $3', [paid ? 1 : 0, paid ? iso() : null, o.id]);
      if (paid && o.driver_id) push.notify('driver', o.driver_id, { title: 'Aklatak', body: `✅ أكّد المتجر استلام ثمن ${ref(o.id)}`, url: '/driver' });
      return ok(res);
    })],

    // Store records: remove one, remove all finished, download as a spreadsheet, choose the size (≤ 1000).
    ['POST', /^\/api\/store\/orders\/(\d+)\/hide$/, store(async (req, res, m, cookId) => {
      await mustOrder('SELECT id FROM orders WHERE id = $1 AND cook_id = $2', [Number(m[1]), cookId]);
      const r = await db.query(`UPDATE orders SET store_hidden = 1 WHERE id = $1 AND cook_id = $2 AND status IN ('delivered','rejected','cancelled') AND NOT (status = 'delivered' AND ${OWED}) RETURNING id`, [Number(m[1]), cookId]);
      if (!r.length) throw stateError();
      return ok(res);
    })],
    ['POST', /^\/api\/store\/orders\/hide-all$/, store(async (req, res, m, cookId) => {
      const r = await db.query(`UPDATE orders SET store_hidden = 1 WHERE cook_id = $1 AND status IN ('delivered','rejected','cancelled') AND store_hidden = 0
        AND NOT (status = 'delivered' AND ${OWED}) RETURNING id`, [cookId]);
      return ok(res, { hidden: r.length });   // orders the driver still owes money for stay
    })],
    ['GET', /^\/api\/store\/orders\.csv$/, store(async (req, res, m, cookId) => {
      const rows = await db.query(`SELECT o.id, o.status, o.total, o.currency, o.delivery_fee, o.delivered_at, o.created_at, o.store_paid, o.fee_state, d.full_name AS driver, d.phone AS driver_phone, cu.name AS customer
        FROM orders o JOIN customers cu ON cu.id = o.customer_id LEFT JOIN drivers d ON d.id = o.driver_id WHERE o.cook_id = $1 AND o.store_hidden = 0 ORDER BY o.id DESC LIMIT 5000`, [cookId]);
      const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = ['ref,status,total,currency,delivery_fee,driver,driver_phone,customer,delivered_at,created_at,paid_to_store,fee'].concat(rows.map((o) =>
        [ref(o.id), o.status, o.total, o.currency, o.delivery_fee ?? '', cell(o.driver), cell(o.driver_phone), cell(o.customer), o.delivered_at ?? '', toIso(o.created_at), Number(o.store_paid) ? 'yes' : 'no', o.fee_state ?? ''].join(',')));
      const body = Buffer.from('﻿' + lines.join('\n'));
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="aklatak-orders-${iso().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store, private', 'Content-Length': body.length });
      res.end(body);
    })],

    ['GET', /^\/api\/store\/settings$/, store(async (req, res, m, cookId) => {
      const c = await db.one('SELECT id, full_name, parent_id, record_limit, payout_number, payout_provider, accent_color, delivery_mode, plan_delivery, whatsapp, wa_orders, booking, kind, delivery_fee, pay_methods, delivery_radius_km FROM cooks WHERE id = $1', [cookId]);
      const rootId = c.parent_id || c.id;
      const branches = await db.query(`SELECT id, full_name, area_label, status, parent_id FROM cooks WHERE id = $1 OR parent_id = $1 ORDER BY (parent_id IS NOT NULL), id`, [rootId]);
      const plans = await getPlans();
      return ok(res, {
        recordLimit: Number(c.record_limit) || 1000, payoutNumber: c.payout_number || '', payoutProvider: c.payout_provider || 'whish', accentColor: c.accent_color || '',
        autoPayout: !!payments.payOutEnabled,
        deliveryFee: Number(c.delivery_fee ?? 0), payMethods: c.pay_methods || 'cash', cardAvailable: !!payments.payInEnabled, deliveryRadiusKm: Number(c.delivery_radius_km || 0),
        waOrders: Number(c.wa_orders ?? 1) === 1, booking: !!Number(c.booking || 0), bookingPrice: Number(settings?.get?.().booking?.prices?.[c.kind] || 0), bookingAvailable: settings?.get?.().booking?.enabled !== false,
        deliveryMode: c.delivery_mode, branches: branches.map((x) => ({ id: x.id, name: x.full_name, area: x.area_label, status: x.status, main: !x.parent_id, current: x.id === cookId })),
        price: storePrice(plans, c.delivery_mode === 'delivery' ? 'delivery' : 'basic', 1, branches.length),
        broadcasts: await broadcastsFor('stores', cookId),
      });
    })],
    ['POST', /^\/api\/store\/settings$/, store(async (req, res, m, cookId) => {
      const b = await readJson(req);
      const v = new Validator();
      const limitN = b.recordLimit === undefined ? undefined : v.int('recordLimit', b.recordLimit, { min: 50, max: 1000 });
      const color = b.accentColor === undefined || b.accentColor === '' ? b.accentColor : (/^#[0-9a-fA-F]{6}$/.test(b.accentColor) ? b.accentColor : v.fail('accentColor', 'invalid'));
      let payTo;
      if (b.payoutNumber !== undefined) payTo = b.payoutNumber === '' ? '' : (normalizePhone(b.payoutNumber, b.country || 'LB') || v.fail('payoutNumber', 'invalid'));
      v.assert();
      if (limitN !== undefined) await db.query('UPDATE cooks SET record_limit = $1 WHERE id = $2', [limitN, cookId]);
      if (color !== undefined) await db.query('UPDATE cooks SET accent_color = $1 WHERE id = $2', [color || null, cookId]);
      if (payTo !== undefined) await db.query('UPDATE cooks SET payout_number = $1 WHERE id = $2', [payTo || null, cookId]);
      if (b.payoutProvider !== undefined) {
        if (!['whish', 'omt'].includes(b.payoutProvider)) throw new HttpError(422, 'validation_failed', { fields: { payoutProvider: 'invalid' } });
        await db.query('UPDATE cooks SET payout_provider = $1 WHERE id = $2', [b.payoutProvider, cookId]);
      }
      if (b.waOrders !== undefined) await db.query('UPDATE cooks SET wa_orders = $1 WHERE id = $2', [b.waOrders ? 1 : 0, cookId]);
      // what the customer pays for delivery, how he may pay, how far the store delivers (0 = the platform's radius)
      if (b.deliveryFee !== undefined || b.payMethods !== undefined || b.deliveryRadiusKm !== undefined) {
        const w = new Validator();
        const fee = b.deliveryFee === undefined ? undefined : w.number('deliveryFee', b.deliveryFee, { min: 0, max: 100 });
        const pm = b.payMethods === undefined ? undefined : w.oneOf('payMethods', b.payMethods, ['cash', 'card', 'both']);
        const rad = b.deliveryRadiusKm === undefined ? undefined : w.number('deliveryRadiusKm', b.deliveryRadiusKm, { min: 0, max: 100 });
        w.assert();
        if (fee !== undefined) await db.query('UPDATE cooks SET delivery_fee = $1 WHERE id = $2', [Math.round(fee * 100) / 100, cookId]);
        if (pm !== undefined) await db.query('UPDATE cooks SET pay_methods = $1 WHERE id = $2', [pm, cookId]);
        if (rad !== undefined) await db.query('UPDATE cooks SET delivery_radius_km = $1 WHERE id = $2', [rad, cookId]);
      }
      // appointments are optional: the store turns them on/off itself (free unless the owner set a price for its category)
      if (b.booking !== undefined) {
        if (b.booking && settings?.get?.().booking?.enabled === false) throw new HttpError(409, 'booking_off');
        await db.query('UPDATE cooks SET booking = $1 WHERE id = $2', [b.booking ? 1 : 0, cookId]);
        cache?.clear?.();
      }
      return ok(res);
    })],

    // ===== branches: each with its own place, photos, menu, orders and records; billed with the main account =====
    ['POST', /^\/api\/store\/branches$/, store(async (req, res, m, cookId) => {
      const b = await readJson(req);
      const v = new Validator();
      const name = v.text('name', b.name, { min: 2, max: 80 });
      const lat = Number(b.lat), lng = Number(b.lng);
      if (!isValidLatLng(lat, lng)) v.fail('location', 'invalid');
      const label = v.text('area', b.area, { max: 80, required: false });
      v.assert();
      const me = await db.one('SELECT id, parent_id FROM cooks WHERE id = $1', [cookId]);
      const rootId = me.parent_id || me.id;
      const root = await db.one('SELECT * FROM cooks WHERE id = $1', [rootId]);
      const n = await db.one('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM cooks WHERE parent_id = $1', [rootId]);
      if (n.n >= 50) throw new HttpError(409, 'too_many_branches');
      const row = await db.one(`INSERT INTO cooks (full_name, whatsapp, area_id, area_label, lat, lng, service_radius_km, bio, status, kind, specialty, country, delivery_mode, booking, hours, parent_id, name_norm, terms_accepted_at, locale, allow_directions)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
        [name, root.whatsapp, root.area_id, label || root.area_label, lat, lng, root.service_radius_km, root.bio, root.kind, root.specialty, root.country, root.delivery_mode, root.booking || 0, root.hours, rootId, String(name).toLowerCase(), root.terms_accepted_at, root.locale, root.allow_directions ?? 1]);
      await db.query('INSERT INTO cook_service_types (cook_id, service_type_id) SELECT $1, service_type_id FROM cook_service_types WHERE cook_id = $2', [row.id, rootId]).catch(() => {});
      await db.query('INSERT INTO cook_service_areas (cook_id, area_id) SELECT $1, area_id FROM cook_service_areas WHERE cook_id = $2', [row.id, rootId]).catch(() => {});
      const price = await branchFee(rootId);
      if (!(price.fee > 0)) { await db.query(`UPDATE cooks SET status = 'approved' WHERE id = $1`, [row.id]); return ok(res, { id: row.id, status: 'approved', ...price }, 201); }   // free → live at once
      return ok(res, { id: row.id, status: 'pending', ...price, online: !!payments.payInEnabled }, 201);
    })],
    // Pay for an extra branch: online → live automatically once paid; or a receipt → the owner confirms.
    ['GET', /^\/api\/store\/branches\/quote$/, store(async (req, res, m, cookId) => ok(res, { ...(await branchFee(await rootOf(cookId))), online: !!payments.payInEnabled }))],
    ['POST', /^\/api\/store\/branches\/(\d+)\/pay$/, store(async (req, res, m, cookId) => {
      const rootId = await rootOf(cookId);
      const br = await db.one(`SELECT id, status FROM cooks WHERE id = $1 AND parent_id = $2`, [Number(m[1]), rootId]);
      if (!br) throw new HttpError(404, 'not_found');
      if (br.status !== 'pending') throw stateError();
      const price = await branchFee(rootId);
      const b = await readJson(req, 600_000);
      if (b.method === 'online') {
        if (!payments.payInEnabled) throw new HttpError(409, 'online_payment_off');
        const token = payments.newToken();
        await db.query('INSERT INTO payments (cook_id, purpose, amount, details, token) VALUES ($1,$2,$3,$4,$5)', [rootId, 'renewal', price.fee, JSON.stringify({ branchAdd: true, branchId: br.id }), token]);
        const base = cfg.publicBaseUrl || `https://${req.headers.host}`;
        try { const { url } = await payments.checkout({ reference: token, amount: price.fee, description: 'Aklatak extra branch', baseUrl: base }); return ok(res, { url }); } catch { throw new HttpError(502, 'payment_unavailable'); }
      }
      const v = new Validator();
      const method = v.oneOf('method', b.method, ['whish', 'omt', 'other']);
      const reference = v.text('reference', b.reference, { max: 80, required: false });
      if (!b.receipt || !imageBytesOk(b.receipt) || String(b.receipt).length > DOC_MAX) v.fail('receipt', 'invalid');
      v.assert();
      if (await db.one(`SELECT id FROM renewals WHERE branch_id = $1 AND status = 'pending'`, [br.id])) throw new HttpError(409, 'too_many_pending');
      const row = await db.one(`INSERT INTO renewals (cook_id, kind, months, branches, amount, method, reference, receipt_mime, receipt, branch_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [rootId, price.kind, price.months, 1, price.fee, method, reference, /^data:(image\/\w+);/.exec(b.receipt)[1], String(b.receipt).split(',')[1], br.id]);
      push.notifyAdmins({ title: 'Aklatak — الإدارة', body: `🏬 دفع فرع إضافي ${price.fee}$`, url: '/admin/#dx-renewals' });
      return ok(res, { id: row.id, amount: price.fee }, 201);
    })],
    ['POST', /^\/api\/store\/branches\/(\d+)\/switch$/, store(async (req, res, m, cookId) => {
      const me = await db.one('SELECT id, parent_id FROM cooks WHERE id = $1', [cookId]);
      const rootId = me.parent_id || me.id;
      const target = await db.one('SELECT id, parent_id, status FROM cooks WHERE id = $1', [Number(m[1])]);
      if (!target || (target.parent_id || target.id) !== rootId || target.status === 'rejected') throw new HttpError(404, 'not_found');
      await cookSessions.destroy(req);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': await cookSessions.create(target.id) });
    })],

    // ===== driver: delivery list (store place kept until he pays the store; he can remove each line) =====
    ['GET', /^\/api\/driver\/history$/, driver(async (req, res, m, id) => {
      const rows = await db.query(`SELECT o.id, o.total, o.currency, o.delivery_fee, o.bonus_fee, o.fee_state, o.store_paid, o.delivered_at, o.self_delivery, o.customer_total, o.payment_method, o.financial_status,
          (SELECT e.status FROM driver_cash_entries e WHERE e.order_id = o.id) AS cash_status,
          c.full_name AS store, c.whatsapp AS store_phone, c.payout_number, c.lat, c.lng
        FROM orders o JOIN cooks c ON c.id = o.cook_id WHERE o.driver_id = $1 AND o.status = 'delivered' AND o.driver_hidden = 0 ORDER BY o.id DESC LIMIT 300`, [id]);
      return ok(res, {
        orders: rows.map((o) => ({
          id: o.id, ref: ref(o.id), total: o.total, currency: o.currency, fee: Number(o.delivery_fee || 0) + Number(o.bonus_fee || 0), feeState: o.fee_state, storePaid: !!Number(o.store_paid), deliveredAt: o.delivered_at,
          legacy: o.customer_total == null, paymentMethod: o.payment_method, financialStatus: o.financial_status, cashStatus: o.cash_status || null,
          store: { name: o.store, phone: o.store_phone, payTo: o.payout_number || o.store_phone, lat: o.lat, lng: o.lng },
        })),
      });
    }, { activeOnly: false })],
    ['POST', /^\/api\/driver\/history\/(\d+)\/hide$/, driver(async (req, res, m, id) => {
      const r = await db.query(`UPDATE orders SET driver_hidden = 1 WHERE id = $1 AND driver_id = $2 AND status = 'delivered' RETURNING id`, [Number(m[1]), id]);
      if (!r.length) throw stateError();
      return ok(res);
    }, { activeOnly: false })],
    ['GET', /^\/api\/driver\/broadcasts$/, driver(async (req, res, m, id) => ok(res, { broadcasts: await broadcastsFor('drivers', id) }), { activeOnly: false })],

    // Customer confirms an errand is done: it leaves his list.
    ['POST', /^\/api\/customer\/errands\/(\d+)\/confirm$/, customer(async (req, res, m, id) => {
      const r = await db.query(`UPDATE errands SET customer_hidden = 1 WHERE id = $1 AND customer_id = $2 AND status IN ('delivered','cancelled') RETURNING id`, [Number(m[1]), id]);
      if (!r.length) throw stateError();
      return ok(res);
    })],

    // ===== the store's subscription: see it, renew it (receipt → the owner approves, or online when a gateway is set) =====
    ['GET', /^\/api\/store\/subscription$/, store(async (req, res, m, cookId) => ok(res, await subscriptionInfo(cookId)))],

    ['POST', /^\/api\/store\/renewals$/, store(async (req, res, m, cookId) => {
      await limit(limiters.upload, `renew:${cookId}`);
      const b = await readJson(req, 600_000);
      const v = new Validator();
      const method = v.oneOf('method', b.method, ['whish', 'omt', 'other']);
      const reference = v.text('reference', b.reference, { max: 80, required: false });
      if (!b.receipt || !imageBytesOk(b.receipt) || String(b.receipt).length > DOC_MAX) v.fail('receipt', 'invalid');
      v.assert();
      const pick = await renewalChoice(cookId, b);
      const pending = await db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM renewals WHERE cook_id = $1 AND status = 'pending'`, [pick.rootId]);
      if (pending.n >= 2) throw new HttpError(409, 'too_many_pending');
      const row = await db.one(`INSERT INTO renewals (cook_id, kind, months, branches, amount, method, reference, receipt_mime, receipt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [pick.rootId, pick.kind, pick.months, pick.branches, pick.amount, method, reference, /^data:(image\/\w+);/.exec(b.receipt)[1], String(b.receipt).split(',')[1]]);
      push.notifyAdmins({ title: 'Aklatak — الإدارة', body: `🧾 طلب تجديد اشتراك ${pick.amount}$ — ${pick.name}`, url: '/admin/#dx-renewals' });
      return ok(res, { id: row.id, amount: pick.amount }, 201);
    })],

    // Online payment (top-up or renewal) — only when the payment gateway keys are set; otherwise 409 and the app shows the receipt way.
    ['POST', /^\/api\/store\/pay$/, store(async (req, res, m, cookId) => {
      if (!payments.payInEnabled) throw new HttpError(409, 'online_payment_off');
      await limit(limiters.upload, `pay:${cookId}`);
      const b = await readJson(req);
      const v = new Validator();
      const purpose = v.oneOf('purpose', b.purpose, ['topup', 'renewal']);
      let amount = purpose === 'topup' ? v.number('amount', b.amount, { min: 1, max: 10000 }) : 0;
      v.assert();
      let details = null, payer = cookId;
      if (purpose === 'renewal') { const pick = await renewalChoice(cookId, b); amount = pick.amount; payer = pick.rootId; details = JSON.stringify({ kind: pick.kind, months: pick.months, branches: pick.branches }); }
      if (!(amount > 0)) throw new HttpError(422, 'validation_failed', { fields: { amount: 'invalid' } });
      const token = payments.newToken();
      await db.query('INSERT INTO payments (cook_id, purpose, amount, details, token) VALUES ($1,$2,$3,$4,$5)', [payer, purpose, amount, details, token]);
      const base = cfg.publicBaseUrl || `https://${req.headers.host}`;
      try {
        const { url } = await payments.checkout({ reference: token, amount, description: purpose === 'topup' ? 'Aklatak balance' : 'Aklatak subscription', baseUrl: base });
        return ok(res, { url });
      } catch { throw new HttpError(502, 'payment_unavailable'); }
    })],

    // The gateway tells us a payment is done (signed). Applied exactly once.
    ['POST', /^\/api\/pay\/webhook(?:\/(whish|omt))?$/, async (req, res, m) => {
      const gateway = m[1] || 'card';
      let size = 0; const chunks = [];
      for await (const c of req) { size += c.length; if (size > 64 * 1024) throw new HttpError(413, 'payload_too_large'); chunks.push(c); }
      const raw = Buffer.concat(chunks);
      if (!payments.verify?.(raw, req.headers['x-signature'], gateway)) {
        // a callback not signed by the provider = someone trying to fake a payment
        const ev = await securityEvent(db, { kind: 'bad_signature', severity: 'high', detail: `${gateway} webhook`, ipHash: hmacHex(cfg.sessionSecret, ip(req)).slice(0, 16), dedupeMin: 60 });
        if (ev) push.notifyAdmins({ title: 'Aklatak — الإدارة', body: '🚨 محاولة تأكيد دفع مزوّرة (توقيع غير صحيح)', url: '/admin/#dx-finance' });
        throw new HttpError(401, 'bad_signature');
      }
      let b; try { b = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'invalid_json'); }
      const reference = String(b.reference || '');
      const status = String(b.status || '');
      // duplicate callbacks (providers retry): the same event is applied once — by its id, else by its exact content
      const eventKey = b.eventId ? `${gateway === 'card' ? '' : `${gateway}:`}id:${String(b.eventId).slice(0, 120)}` : `h:${sha256(raw.toString('utf8'))}`;
      try { await db.query('INSERT INTO payment_events (event_key, reference, status) VALUES ($1,$2,$3)', [eventKey, reference.slice(0, 80), status.slice(0, 30)]); }
      catch { return ok(res, { duplicate: true }); }
      // ---- a driver's settlement paid online (Whish / OMT / card) ----
      const sl = await db.one('SELECT id, driver_id, gateway FROM settlements WHERE pay_token = $1', [reference]);
      if (sl) {
        if (sl.gateway !== gateway) {   // signed by another gateway than the one the link was made with
          await securityEvent(db, { kind: 'settle_wrong_gateway', severity: 'high', driverId: sl.driver_id, settlementId: sl.id, detail: `${gateway} ≠ ${sl.gateway}` });
          throw new HttpError(409, 'wrong_gateway');
        }
        if (status === 'paid') {
          const payerRaw = b.payer || b.from || b.sender || null;
          const payer = payerRaw ? normalizePhone(String(payerRaw), 'LB') : null;
          const r = await confirmOnlineSettlement(db, { token: reference, amount: b.amount ?? null, currency: b.currency || null, providerRef: String(b.id || '').slice(0, 100) || null, payer });
          if (r.result === 'verified') {
            push.notify('driver', sl.driver_id, { title: 'Aklatak', body: `✅ وصلت تسويتك S-${sl.id} وتأكدت تلقائياً — تستقبل الطلبات النقدية من جديد`, url: '/driver' });
            const sx = await S.get();
            const paidOut = await payStoresFor(db, payments, sl.id, { enabled: Number(sx.autoPayStores ?? 1) === 1 });
            await afterStorePayouts(sl.id, r.stores, paidOut);
            const me = await db.one('SELECT wallet_number FROM drivers WHERE id = $1', [sl.driver_id]);
            if (payer && me?.wallet_number && payer !== me.wallet_number) await securityEvent(db, { kind: 'settle_other_sender', severity: 'info', driverId: sl.driver_id, settlementId: sl.id, detail: `online from ${payer}` });
          } else if (r.event) {
            await securityEvent(db, { ...r.event, driverId: sl.driver_id, settlementId: sl.id, detail: `${gateway} ${String(b.id || '')}` });
            push.notifyAdmins({ title: 'Aklatak — الإدارة', body: `🚨 تسوية S-${sl.id}: دُفع ${r.event.amount}$ والمطلوب ${r.event.expected}$ — لم تُؤكَّد`, url: '/admin/#dx-finance' });
            push.notify('driver', sl.driver_id, { title: 'Aklatak', body: `⚠️ التسوية S-${sl.id} لم تُقبل — راجع الإدارة`, url: '/driver' });
          }
        } else if (status === 'failed' || status === 'cancelled') {
          const f = await failOnlineSettlement(db, reference);
          if (f) await securityEvent(db, { kind: 'settle_payment_failed', severity: 'info', driverId: sl.driver_id, settlementId: sl.id, detail: gateway, dedupeMin: 30 });
        }
        return ok(res);
      }
      if (gateway !== 'card') throw new HttpError(404, 'not_found');   // Whish/OMT links are only used for settlements
      // ---- a customer's card order ----
      const op = await db.one('SELECT * FROM order_payments WHERE token = $1', [reference]);
      if (op) {
        if (status === 'paid') {
          const done = await db.tx(async (t) => {
            const r = await t.query(`UPDATE order_payments SET status = 'paid', provider_ref = $1, updated_at = $2 WHERE id = $3 AND status = 'created' RETURNING id`, [String(b.id || '').slice(0, 100), iso(), op.id]);
            if (!r.length) return false;
            if (cents2(b.amount ?? op.amount) !== cents2(op.amount)) throw new HttpError(422, 'amount_mismatch');   // never trust a different amount
            const o = await t.one(`UPDATE orders SET payment_status = 'paid' WHERE id = $1 AND payment_status = 'pending' RETURNING id, cook_id, status, customer_total, currency`, [op.order_id]);
            if (o) await journal(t, { kind: 'card_payment_received', orderId: o.id, storeId: o.cook_id, paymentId: op.id, amount: Number(op.amount), currency: o.currency || 'USD', method: 'card' });
            if (o && o.status === 'cancelled') await refundIfPaid(t, o.id);   // paid after it was cancelled → refund
            return o;
          });
          if (done && done.status !== 'cancelled') push.notify('store', done.cook_id, { title: 'Aklatak', body: `🧾 طلب جديد ${ref(done.id)} (مدفوع بالبطاقة)`, url: '/store' });
        } else if (status === 'failed') {
          await db.tx(async (t) => {
            const r = await t.query(`UPDATE order_payments SET status = 'failed', updated_at = $1 WHERE id = $2 AND status = 'created' RETURNING id`, [iso(), op.id]);
            if (r.length) await t.query(`UPDATE orders SET payment_status = 'failed', status = 'cancelled', closed_at = $1, close_reason = 'payment_failed' WHERE id = $2 AND payment_status = 'pending'`, [iso(), op.order_id]);
          });
        } else if (status === 'refunded') {
          await db.tx(async (t) => {
            const r = await t.query(`UPDATE order_payments SET status = 'refunded', updated_at = $1 WHERE id = $2 AND status IN ('paid','refund_pending') RETURNING id`, [iso(), op.id]);
            if (r.length) {
              await t.query(`UPDATE orders SET payment_status = 'refunded' WHERE id = $1`, [op.order_id]);
              await journal(t, { kind: 'card_refunded', orderId: op.order_id, paymentId: op.id, amount: -Number(op.amount), method: 'card' });
            }
          });
        }
        return ok(res);
      }
      // ---- a store's top-up / renewal ----
      const p = await db.one('SELECT * FROM payments WHERE token = $1', [reference]);
      if (!p) throw new HttpError(404, 'not_found');
      if (status !== 'paid') { await db.query(`UPDATE payments SET status = 'failed' WHERE id = $1 AND status = 'created'`, [p.id]); return ok(res); }
      const applied = await db.tx(async (t) => {
        const r = await t.query(`UPDATE payments SET status = 'paid', paid_at = $1, provider_ref = $2 WHERE id = $3 AND status = 'created' RETURNING id`, [iso(), String(b.id || '').slice(0, 100), p.id]);
        if (!r.length) return false;   // already applied (the gateway may call twice)
        if (p.purpose === 'topup') await ledgerAdd(t, 'store', p.cook_id, Number(p.amount), 'topup', { note: `online #${p.id}` });
        return true;
      });
      if (applied && p.purpose === 'renewal') { const d = parseJson(p.details) || {}; await applyRenewal(p.cook_id, d.kind, Number(d.months), d.branchAdd ? d : null); }
      if (applied) push.notify('store', p.cook_id, { title: 'Aklatak', body: p.purpose === 'topup' ? `💳 أُضيف ${p.amount}$ إلى رصيدك` : '✅ تجدّد اشتراكك', url: '/store' });
      return ok(res);
    }],

    // owner: subscription renewals sent by stores
    ['GET', /^\/api\/admin\/renewals$/, owner(async (req, res) => {
      const st = q(req).get('status') || 'pending';
      const rows = await db.query(`SELECT r.id, r.cook_id, r.kind, r.months, r.branches, r.amount, r.method, r.reference, r.status, r.created_at, r.decided_at, r.branch_id, c.full_name AS store, c.whatsapp
        FROM renewals r JOIN cooks c ON c.id = r.cook_id WHERE ${st === 'all' ? '$1 = $1' : 'r.status = $1'} ORDER BY r.id DESC LIMIT 300`, [st]);
      return ok(res, { renewals: rows });
    })],
    ['GET', /^\/api\/admin\/renewals\/(\d+)\/receipt$/, owner(async (req, res, m) => {
      const r = await db.one('SELECT receipt_mime, receipt FROM renewals WHERE id = $1', [Number(m[1])]);
      if (!r?.receipt) throw new HttpError(404, 'not_found');
      const body = Buffer.from(r.receipt, 'base64');
      res.writeHead(200, { 'Content-Type': r.receipt_mime, 'Content-Length': body.length, 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    })],
    ['POST', /^\/api\/admin\/renewals\/(\d+)\/(approve|reject)$/, owner(async (req, res, m) => {
      const r = await db.one('SELECT * FROM renewals WHERE id = $1', [Number(m[1])]);
      if (!r) throw new HttpError(404, 'not_found');
      const done = await db.query(`UPDATE renewals SET status = $1, decided_at = $2 WHERE id = $3 AND status = 'pending' RETURNING id`, [m[2] === 'approve' ? 'approved' : 'rejected', iso(), r.id]);
      if (!done.length) throw stateError();
      if (m[2] === 'approve') await applyRenewal(r.cook_id, r.kind, Number(r.months), r.branch_id ? { branchId: r.branch_id } : null);
      push.notify('store', r.cook_id, { title: 'Aklatak', body: m[2] === 'approve' ? '✅ تجدّد اشتراكك' : '❌ لم يُقبل طلب تجديد الاشتراك — تواصل مع الإدارة', url: '/store' });
      return ok(res);
    })],

    // ===== v7.6 money: restaurant / driver / owner financial views and the driver's cash settlements =====
    ['GET', /^\/api\/store\/finance$/, store(async (req, res, m, cookId) => ok(res, { finance: await storeFinance(db, cookId) }))],
    ['GET', /^\/api\/store\/finance\/drivers\/(\d+)$/, store(async (req, res, m, cookId) => ok(res, { orders: await storeDriverOrders(db, cookId, Number(m[1])) }))],

    ['GET', /^\/api\/driver\/finance$/, driver(async (req, res, m, id) => {
      const s = await S.get();
      await expireLinks(db);   // unpaid online links past their time give their orders back
      const settlements = await db.query(`SELECT id, amount, method, reference, status, note, gateway, paid_amount, expires_at, created_at, decided_at FROM settlements WHERE driver_id = $1 ORDER BY id DESC LIMIT 50`, [id]);
      const me = await db.one('SELECT wallet_number, country FROM drivers WHERE id = $1', [id]);
      const plans = await getPlans();
      return ok(res, { finance: await driverFinance(db, s, id), settlements: settlements.map((x) => ({ ...x, ref: `S-${x.id}` })), payTo: plans.payTo, ways: settleWaysFor(plans, me.country), linkMin: Number(s.settleLinkMin || 30), code: `D${id}`, myNumber: me.wallet_number });
    }, { activeOnly: false })],
    ['GET', /^\/api\/driver\/settlements\/(\d+)$/, driver(async (req, res, m, id) => {
      const sx = await db.one('SELECT id, amount, method, reference, status, note, gateway, paid_amount, created_at FROM settlements WHERE id = $1 AND driver_id = $2', [Number(m[1]), id]);
      if (!sx) throw new HttpError(404, 'not_found');
      return ok(res, { settlement: { ...sx, ref: `S-${sx.id}` }, breakdown: await settlementBreakdown(db, sx.id) });
    }, { activeOnly: false })],
    // Pay online: the system makes a Whish / OMT / card payment page with the EXACT amount owed; the provider's signed
    // callback confirms the settlement automatically (no receipt, no waiting for the owner).
    ['POST', /^\/api\/driver\/settlements\/online$/, driver(async (req, res, m, id) => {
      await limit(limiters.upload, `settle:${id}`);
      const b = await readJson(req);
      const me = await db.one('SELECT country FROM drivers WHERE id = $1', [id]);
      const s = await S.get();
      const ways = settleWaysFor(await getPlans(), me.country).filter((w) => w.online);
      const gateway = String(b.gateway || '');
      if (!ways.some((w) => w.key === gateway)) throw new HttpError(409, 'online_payment_off');
      const storeIds = Array.isArray(b.storeIds) && b.storeIds.length ? b.storeIds.map(Number).filter((x) => Number.isInteger(x) && x > 0) : null;
      await expireLinks(db, { driverId: id });   // one live link at a time: an older unpaid one is closed
      const token = payments.newToken();
      const r = await createSettlement(db, id, { storeIds, online: { gateway, token, expiresAt: new Date(Date.now() + Number(s.settleLinkMin || 30) * 60_000).toISOString() } });
      const base = cfg.publicBaseUrl || `https://${req.headers.host}`;
      try {
        const { url } = await payments.checkout({ gateway, reference: token, amount: r.amount, description: `Aklatak settlement S-${r.id} (D${id})`, baseUrl: base, successPath: `/driver?settle=${r.id}`, cancelPath: `/driver?settle=${r.id}` });
        return ok(res, { id: r.id, ref: `S-${r.id}`, amount: r.amount, url }, 201);
      } catch {
        await failOnlineSettlement(db, token);
        throw new HttpError(502, 'payment_unavailable');
      }
    }, { activeOnly: false })],
    ['POST', /^\/api\/driver\/settlements$/, driver(async (req, res, m, id) => {
      await limit(limiters.upload, `settle:${id}`);
      const b = await readJson(req, 600_000);
      const v = new Validator();
      const me = await db.one('SELECT wallet_number, country FROM drivers WHERE id = $1', [id]);
      const manualWays = settleWaysFor(await getPlans(), me.country).filter((w) => w.manual).map((w) => w.key);
      const amount = v.number('amount', b.amount, { min: 0.01, max: 100000 });
      const method = v.oneOf('method', b.method, manualWays.length ? manualWays : ['whish', 'omt']);
      const reference = v.text('reference', b.reference, { min: 3, max: 80 });
      let receipt = null, mime = null;
      if (b.receipt) { if (!imageBytesOk(b.receipt) || String(b.receipt).length > DOC_MAX) v.fail('receipt', 'invalid'); else { mime = /^data:(image\/\w+);/.exec(b.receipt)[1]; receipt = String(b.receipt).split(',')[1]; } }
      const storeIds = Array.isArray(b.storeIds) && b.storeIds.length ? b.storeIds.map(Number).filter((x) => Number.isInteger(x) && x > 0) : null;
      // sent from another number (a friend, a shop…)? then the receipt photo is required, so the owner can match it
      const sender = b.senderNumber ? normalizePhone(b.senderNumber, me.country || 'LB') : me.wallet_number;
      if (b.senderNumber && !sender) v.fail('senderNumber', 'invalid');
      v.assert();
      // a bank / local-wallet transfer always needs the receipt photo
      if (!['whish', 'omt'].includes(method) && !receipt) throw new HttpError(422, 'receipt_required');
      if (sender && sender !== me.wallet_number && !receipt) throw new HttpError(422, 'receipt_required_other_sender');
      const ipHash = hmacHex(cfg.sessionSecret, ip(req)).slice(0, 16);
      let r;
      try {
        r = await createSettlement(db, id, { amount, method, reference, receipt, receiptMime: mime, storeIds, senderNumber: sender || null });
      } catch (e) {
        if (e?.code === 'settlement_amount_mismatch') {
          await securityEvent(db, { kind: 'settle_amount_mismatch', severity: 'warn', driverId: id, amount: Math.round(amount * 100) / 100, expected: e.extra?.expected ?? null, detail: `ref ${reference}`, ipHash, dedupeMin: 10 });
        } else if (e?.code === 'duplicate_settlement') {
          const ev = await securityEvent(db, { kind: 'settle_duplicate_reference', severity: 'high', driverId: id, amount, detail: `ref ${reference}`, ipHash });
          if (ev) push.notifyAdmins({ title: 'Aklatak — الإدارة', body: `🚨 سائق D${id} استعمل رقم عملية مسجّلاً من قبل (${reference})`, url: '/admin/#dx-finance' });
        }
        throw e;
      }
      if (sender && sender !== me.wallet_number) await securityEvent(db, { kind: 'settle_other_sender', severity: 'info', driverId: id, settlementId: r.id, amount: r.amount, detail: `from ${sender}` });
      push.notifyAdmins({ title: 'Aklatak — الإدارة', body: `💵 تسوية سائق S-${r.id}: ${r.amount}$ (${method})`, url: '/admin/#dx-finance' });
      return ok(res, { id: r.id, ref: `S-${r.id}`, amount: r.amount, status: 'pending', breakdown: await settlementBreakdown(db, r.id) }, 201);
    }, { activeOnly: false })],

    ['GET', /^\/api\/admin\/finance\/overview$/, owner(async (req, res) => ok(res, { overview: await financeOverview(db) }))],
    ['GET', /^\/api\/admin\/settlements$/, owner(async (req, res) => {
      const p = q(req);
      const params = [];
      let where = '1 = 1';
      const st = p.get('status') || 'pending';
      if (st !== 'all') { params.push(st); where += ` AND s.status = $${params.length}`; }
      if (p.get('driver')) { params.push(Number(p.get('driver'))); where += ` AND s.driver_id = $${params.length}`; }
      if (['whish', 'omt'].includes(p.get('method'))) { params.push(p.get('method')); where += ` AND s.method = $${params.length}`; }
      if (p.get('store')) { params.push(Number(p.get('store'))); where += ` AND EXISTS (SELECT 1 FROM settlement_allocations a WHERE a.settlement_id = s.id AND a.store_id = $${params.length})`; }
      if (p.get('from')) { params.push(String(p.get('from'))); where += ` AND s.created_at >= $${params.length}`; }
      if (p.get('to')) { params.push(String(p.get('to'))); where += ` AND s.created_at <= $${params.length}`; }
      const rows = await db.query(`SELECT s.id, s.driver_id, s.amount, s.method, s.reference, s.status, s.note, s.created_at, s.decided_at, s.gateway, s.paid_amount, s.provider_ref, s.expires_at, CASE WHEN s.receipt IS NULL THEN 0 ELSE 1 END AS has_receipt, d.full_name AS driver, d.phone, d.wallet_provider, d.wallet_number, s.sender_number
        FROM settlements s JOIN drivers d ON d.id = s.driver_id WHERE ${where} ORDER BY s.id DESC LIMIT 300`, params);
      const out = [];
      const extra = (await getPlans()).payTo.extra;
      const label = (k) => ({ whish: 'Whish', omt: 'OMT', card: 'بطاقة' }[k] || extra.find((x) => x.id === k)?.label || k);
      for (const r of rows) out.push({ ...r, ref: `S-${r.id}`, methodLabel: label(r.method), hasReceipt: !!Number(r.has_receipt), breakdown: await settlementBreakdown(db, r.id) });
      return ok(res, { settlements: out });
    })],
    ['GET', /^\/api\/admin\/settlements\/(\d+)\/receipt$/, owner(async (req, res, m) => {
      const r = await db.one('SELECT receipt_mime, receipt FROM settlements WHERE id = $1', [Number(m[1])]);
      if (!r?.receipt) throw new HttpError(404, 'not_found');
      const body = Buffer.from(r.receipt, 'base64');
      res.writeHead(200, { 'Content-Type': r.receipt_mime, 'Content-Length': body.length, 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    })],
    ['POST', /^\/api\/admin\/settlements\/(\d+)\/(verify|reject|correction)$/, owner(async (req, res, m, a) => {
      const b = await readJson(req).catch(() => ({}));
      const id = Number(m[1]);
      const sx = await db.one('SELECT driver_id FROM settlements WHERE id = $1', [id]);
      if (!sx) throw new HttpError(404, 'not_found');
      if (m[2] === 'verify') {
        const r = await verifySettlement(db, id, a.id);
        push.notify('driver', sx.driver_id, { title: 'Aklatak', body: `✅ تم التحقق من التسوية S-${id} — صفر عليك للمطاعم`, url: '/driver' });
        const sx2 = await S.get();
        const paidOut = await payStoresFor(db, payments, id, { enabled: Number(sx2.autoPayStores ?? 1) === 1 });
        await afterStorePayouts(id, r.stores, paidOut);
        return ok(res, { ...r, payouts: paidOut });
      }
      const v = new Validator();
      const note = v.text('note', b?.note, { max: 300, required: m[2] === 'correction' });
      v.assert();
      await releaseSettlement(db, id, a.id, m[2] === 'reject' ? 'rejected' : 'correction', note);
      if (m[2] === 'reject') await securityEvent(db, { kind: 'settle_rejected', severity: 'warn', driverId: sx.driver_id, settlementId: id, detail: note || null });
      push.notify('driver', sx.driver_id, { title: 'Aklatak', body: m[2] === 'reject' ? `❌ رُفضت التسوية S-${id}` : `✏️ صحّح التسوية S-${id}: ${note || ''}`, url: '/driver' });
      return ok(res);
    })],
    // trace: driver → settlement → restaurant → orders → customer payment
    ['GET', /^\/api\/admin\/finance\/entries$/, owner(async (req, res) => {
      const p = q(req);
      const params = [];
      let where = '1 = 1';
      for (const [k, col] of [['driver', 'e.driver_id'], ['store', 'e.store_id'], ['order', 'e.order_id'], ['settlement', 'e.settlement_id']]) if (p.get(k)) { params.push(Number(p.get(k))); where += ` AND ${col} = $${params.length}`; }
      if (['open', 'in_settlement', 'settled', 'reversed'].includes(p.get('status'))) { params.push(p.get('status')); where += ` AND e.status = $${params.length}`; }
      if (p.get('from')) { params.push(String(p.get('from'))); where += ` AND e.created_at >= $${params.length}`; }
      if (p.get('to')) { params.push(String(p.get('to'))); where += ` AND e.created_at <= $${params.length}`; }
      const rows = await db.query(`SELECT e.*, d.full_name AS driver, c.full_name AS store, o.customer_total, o.delivery_fee, o.payment_method, o.payment_status, o.delivered_at, o.confirmed_at
        FROM driver_cash_entries e JOIN drivers d ON d.id = e.driver_id JOIN cooks c ON c.id = e.store_id LEFT JOIN orders o ON o.id = e.order_id WHERE ${where} ORDER BY e.id DESC LIMIT 500`, params);
      return ok(res, { entries: rows.map((r) => ({ ...r, ref: `AKL${r.order_id}`, settlementRef: r.settlement_id ? `S-${r.settlement_id}` : null })) });
    })],
    ['GET', /^\/api\/admin\/finance\/journal$/, owner(async (req, res) => {
      const p = q(req);
      const params = [];
      let where = '1 = 1';
      for (const [k, col] of [['order', 'order_id'], ['driver', 'driver_id'], ['store', 'store_id'], ['settlement', 'settlement_id']]) if (p.get(k)) { params.push(Number(p.get(k))); where += ` AND ${col} = $${params.length}`; }
      if (['cash', 'card'].includes(p.get('method'))) { params.push(p.get('method')); where += ` AND payment_method = $${params.length}`; }
      return ok(res, { journal: await db.query(`SELECT * FROM financial_ledger WHERE ${where} ORDER BY id DESC LIMIT 500`, params) });
    })],
    // refunds / corrections (reversal entries; history is never deleted) and disputes
    ['POST', /^\/api\/admin\/orders\/(\d+)\/reverse$/, owner(async (req, res, m, a) => {
      const b = await readJson(req);
      const v = new Validator();
      const reason = v.text('reason', b.reason, { min: 3, max: 300 });
      v.assert();
      return ok(res, await reverseOrder(db, Number(m[1]), { includeFee: b.includeFee !== false, adminId: a.id, reason }));
    })],
    ['POST', /^\/api\/admin\/orders\/(\d+)\/complete$/, owner(async (req, res, m) => {   // dispute settled in favour of delivery
      const o = await db.one('SELECT id FROM orders WHERE id = $1 AND status = $2', [Number(m[1]), 'delivered']);
      if (!o) throw new HttpError(404, 'not_found');
      await db.query(`UPDATE orders SET financial_status = 'open' WHERE id = $1 AND financial_status = 'disputed'`, [o.id]);
      const done = await db.tx((t) => settleOrder(t, o.id));
      if (!done) throw stateError();
      return ok(res);
    })],
    ['POST', /^\/api\/admin\/orders\/(\d+)\/refunded$/, owner(async (req, res, m) => {   // a card refund done in the provider's dashboard
      const r = await db.tx(async (t) => {
        const x = await t.query(`UPDATE order_payments SET status = 'refunded', updated_at = $1 WHERE order_id = $2 AND status = 'refund_pending' RETURNING id, amount`, [iso(), Number(m[1])]);
        if (!x.length) return null;
        await t.query(`UPDATE orders SET payment_status = 'refunded' WHERE id = $1`, [Number(m[1])]);
        await journal(t, { kind: 'card_refunded', orderId: Number(m[1]), paymentId: x[0].id, amount: -Number(x[0].amount), method: 'card', note: 'marked by owner' });
        return x[0];
      });
      if (!r) throw stateError();
      return ok(res);
    })],
    // what the platform holds for each store (card sales + verified driver cash − withdrawals): who to send money to
    ['GET', /^\/api\/admin\/finance\/stores-owed$/, owner(async (req, res) => ok(res, { stores: (await db.query(`SELECT w.account_id AS id, c.full_name AS store, c.whatsapp, c.payout_number, c.payout_provider, COALESCE(c.country, 'LB') AS country, SUM(w.amount) AS balance
      FROM wallet_ledger w JOIN cooks c ON c.id = w.account_id WHERE w.account_type = 'store' GROUP BY w.account_id, c.full_name, c.whatsapp, c.payout_number, c.payout_provider, c.country HAVING SUM(w.amount) > 0.004 ORDER BY SUM(w.amount) DESC LIMIT 500`))
      .map((r) => ({ ...r, balance: Math.round(Number(r.balance) * 100) / 100 })) }))],
    // violations: everything suspicious about money, newest first, with a per-driver count (the owner can suspend from here)
    ['GET', /^\/api\/admin\/finance\/violations$/, owner(async (req, res) => {
      const p = q(req);
      const params = [];
      let where = '1 = 1';
      if (p.get('seen') === '0') where += ' AND e.seen = 0';
      if (p.get('driver')) { params.push(Number(p.get('driver'))); where += ` AND e.driver_id = $${params.length}`; }
      const events = await db.query(`SELECT e.*, d.full_name AS driver, d.phone AS driver_phone, d.status AS driver_status, c.full_name AS store
        FROM security_events e LEFT JOIN drivers d ON d.id = e.driver_id LEFT JOIN cooks c ON c.id = e.store_id WHERE ${where} ORDER BY e.id DESC LIMIT 300`, params);
      const drivers = await db.query(`SELECT e.driver_id, d.full_name AS driver, d.status, CAST(COUNT(*) AS INTEGER) AS n,
          CAST(SUM(CASE WHEN e.severity = 'high' THEN 1 ELSE 0 END) AS INTEGER) AS high
        FROM security_events e JOIN drivers d ON d.id = e.driver_id WHERE e.severity <> 'info' GROUP BY e.driver_id, d.full_name, d.status ORDER BY COUNT(*) DESC LIMIT 50`);
      return ok(res, { events: events.map((e) => ({ ...e, settlementRef: e.settlement_id ? `S-${e.settlement_id}` : null, driverCode: e.driver_id ? `D${e.driver_id}` : null })), drivers });
    })],
    ['POST', /^\/api\/admin\/finance\/violations\/(\d+|all)\/seen$/, owner(async (req, res, m) => {
      if (m[1] === 'all') await db.query('UPDATE security_events SET seen = 1 WHERE seen = 0');
      else await db.query('UPDATE security_events SET seen = 1 WHERE id = $1', [Number(m[1])]);
      return ok(res);
    })],
    ['GET', /^\/api\/admin\/finance\/refunds$/, owner(async (req, res) => ok(res, { refunds: await db.query(`SELECT o.id, o.customer_total, o.currency, o.payment_status, o.cancel_note, o.close_reason, c.full_name AS store, cu.name AS customer, cu.phone,
        (SELECT MAX(p.refund_error) FROM order_payments p WHERE p.order_id = o.id) AS refund_error, (SELECT MAX(p.refund_tries) FROM order_payments p WHERE p.order_id = o.id) AS refund_tries
      FROM orders o JOIN cooks c ON c.id = o.cook_id JOIN customers cu ON cu.id = o.customer_id WHERE o.payment_status = 'refund_pending' ORDER BY o.id DESC LIMIT 200`) }))],
    ['GET', /^\/api\/admin\/finance\/disputes$/, owner(async (req, res) => ok(res, { disputes: await db.query(`SELECT o.id, o.total, o.delivery_fee, o.customer_total, o.payment_method, o.cancel_note, o.delivered_at, c.full_name AS store, d.full_name AS driver
      FROM orders o JOIN cooks c ON c.id = o.cook_id LEFT JOIN drivers d ON d.id = o.driver_id WHERE o.financial_status = 'disputed' ORDER BY o.id DESC LIMIT 200`) }))],

    // ===== phone notifications =====
    ['GET', /^\/api\/push\/key$/, async (req, res) => ok(res, { key: await push.publicKey?.() })],
    ['POST', /^\/api\/push\/subscribe$/, async (req, res) => {
      checkCsrf(req);
      const b = await readJson(req, 8 * 1024);
      const role = ['customer', 'driver', 'store', 'admin'].includes(b.role) ? b.role : null;
      let id = role === 'customer' ? await custSessions.ownerId(req) : role === 'driver' ? await driverSessions.ownerId(req) : role === 'store' ? await cookSessions.ownerId(req) : null;
      if (role === 'admin') {   // the owner's phone: new top-ups, renewals, withdrawals, drivers and complaints (agents excluded)
        const aid = await adminSessions.ownerId(req);
        const a = aid ? await db.one('SELECT id, role FROM admin_users WHERE id = $1 AND disabled = 0', [aid]) : null;
        id = a && a.role !== 'agent' ? a.id : null;
      }
      if (!id) throw new HttpError(401, 'unauthorized');
      const ep = String(b.endpoint || '');
      // only the phones' real push services (never an address of our choosing → no requests to internal servers)
      let host = '';
      try { host = new URL(ep).hostname; } catch { host = ''; }
      const PUSH_HOSTS = /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.apple\.com)$/;
      if (!PUSH_HOSTS.test(host)) throw new HttpError(422, 'validation_failed', { fields: { endpoint: 'invalid' } });
      if (!/^https:\/\/[^\s]{10,800}$/.test(ep) || !b.keys?.p256dh || !b.keys?.auth || String(b.keys.p256dh).length > 200 || String(b.keys.auth).length > 100) throw new HttpError(422, 'validation_failed');
      await push.subscribe(role, id, { endpoint: ep, p256dh: String(b.keys.p256dh), auth: String(b.keys.auth) });
      return ok(res);
    }],

    // ===== owner: messages to all drivers / all stores, with an end date; delete removes them everywhere =====
    ['GET', /^\/api\/admin\/broadcasts$/, owner(async (req, res) => ok(res, { broadcasts: await db.query('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 200') }))],
    ['POST', /^\/api\/admin\/broadcasts$/, owner(async (req, res) => {
      const b = await readJson(req);
      const v = new Validator();
      const audience = v.oneOf('audience', b.audience, ['drivers', 'stores']);
      const body = v.text('body', b.body, { min: 2, max: 2000, multiline: true });
      const days = b.days == null || b.days === '' ? null : v.int('days', b.days, { min: 1, max: 3650 });
      const country = b.country && /^[A-Z]{2}$/.test(b.country) ? b.country : null;
      v.assert();
      const row = await db.one('INSERT INTO broadcasts (audience, country, body, expires_at) VALUES ($1,$2,$3,$4) RETURNING id',
        [audience, country, body, days ? new Date(Date.now() + days * 864e5).toISOString() : null]);
      const subs = await db.query(`SELECT DISTINCT owner_id FROM push_targets WHERE owner_type = $1`, [audience === 'drivers' ? 'driver' : 'store']);
      for (const s2 of subs) push.notify(audience === 'drivers' ? 'driver' : 'store', s2.owner_id, { title: 'Aklatak', body: `📢 ${body.slice(0, 120)}`, url: audience === 'drivers' ? '/driver' : '/store' });
      return ok(res, { id: row.id }, 201);
    })],
    ['DELETE', /^\/api\/admin\/broadcasts\/(\d+)$/, owner(async (req, res, m) => {
      await db.query('DELETE FROM broadcasts WHERE id = $1', [Number(m[1])]);
      return ok(res);
    })],

    // ===== owner: prices and durations (stores with / without drivers, branches, drivers' customer requests) =====
    ['GET', /^\/api\/admin\/plans$/, owner(async (req, res) => ok(res, { plans: await getPlans(),
      gateways: { card: !!payments.gatewayOn?.('card'), whish: !!payments.gatewayOn?.('whish'), omt: !!payments.gatewayOn?.('omt'), payoutWhish: !!payments.payOutOn?.('whish'), payoutOmt: !!payments.payOutOn?.('omt'), refund: !!payments.refundEnabled } }))],
    ['PUT', /^\/api\/admin\/plans$/, owner(async (req, res) => ok(res, { plans: await setPlans(await readJson(req)) }))],
    ['GET', /^\/api\/plans$/, async (req, res) => {
      const p = await getPlans();
      const pub = (g) => Object.fromEntries(Object.entries(g).filter(([, x]) => !x.hidden).map(([k, x]) => [k, x.price]));
      return ok(res, { store: { delivery: pub(p.store.delivery), basic: pub(p.store.basic) }, branchPercent: p.branchPercent, driverJobs: pub(p.driverJobs), currency: 'USD', payTo: p.payTo });
    }],
    ['POST', /^\/api\/admin\/stores\/(\d+)\/branch-status$/, owner(async (req, res, m) => {
      const b = await readJson(req);
      const st = b.status === 'approved' ? 'approved' : 'rejected';
      const r = await db.query('UPDATE cooks SET status = $1 WHERE id = $2 AND parent_id IS NOT NULL RETURNING id', [st, Number(m[1])]);
      if (!r.length) throw new HttpError(404, 'not_found');
      return ok(res);
    })],

    // Readable balance sheet (opens in Excel / Google Sheets).
    ['GET', /^\/api\/admin\/delivery\/balances\.csv$/, owner(async (req, res) => {
      const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = [['type', 'id', 'name', 'phone', 'country', 'balance', 'pending_withdrawals'].join(',')];
      const pend = async (type, id) => (await db.one(`SELECT COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE account_type = $1 AND account_id = $2 AND status = 'pending'`, [type, id])).s;
      for (const c of await db.query('SELECT id, full_name, whatsapp, country FROM cooks ORDER BY id')) {
        const b = await balance(db, 'store', c.id), p = await pend('store', c.id);
        if (b || Number(p)) lines.push(['store', c.id, cell(c.full_name), cell(c.whatsapp), c.country || 'LB', b, p].join(','));
      }
      for (const d of await db.query('SELECT id, full_name, phone, country FROM drivers ORDER BY id')) {
        lines.push(['driver', d.id, cell(d.full_name), cell(d.phone), d.country || 'LB', await balance(db, 'driver', d.id), await pend('driver', d.id)].join(','));
      }
      const body = Buffer.from('﻿' + lines.join('\n'));
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="aklatak-balances-${iso().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store, private', 'Content-Length': body.length });
      res.end(body);
    })],

    // ===== complaints: any party of an order can complain about another party =====
    ['POST', /^\/api\/complaints$/, async (req, res) => {
      checkCsrf(req);
      const b = await readJson(req);
      const v = new Validator();
      const isErrand = b.errandId != null;
      const orderId = v.int(isErrand ? 'errandId' : 'orderId', isErrand ? b.errandId : b.orderId, { min: 1 });
      const against = v.oneOf('against', b.against, isErrand ? ['driver', 'customer'] : ['store', 'driver', 'customer']);
      const text = v.text('text', b.text, { min: 5, max: 1000, multiline: true });
      v.assert();
      const o = isErrand
        ? await db.one('SELECT id, NULL AS cook_id, customer_id, driver_id FROM errands WHERE id = $1', [orderId])
        : await db.one('SELECT id, cook_id, customer_id, driver_id FROM orders WHERE id = $1', [orderId]);
      if (!o) throw new HttpError(404, 'not_found');
      const who = [
        ['customer', await custSessions.ownerId(req), o.customer_id],
        ['store', await cookSessions.ownerId(req), o.cook_id],
        ['driver', await driverSessions.ownerId(req), o.driver_id],
      ].find(([, sid, oid]) => sid && sid === oid);
      if (!who) throw new HttpError(403, 'forbidden');
      const targetId = { customer: o.customer_id, store: o.cook_id, driver: o.driver_id }[against];
      if (!targetId || against === who[0]) throw new HttpError(422, 'validation_failed', { fields: { against: 'invalid' } });
      await limit(limiters.feedback, `complaint:${who[0]}:${who[1]}`);
      await db.query('INSERT INTO complaints (order_id, errand_id, from_type, from_id, against_type, against_id, text) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [isErrand ? null : o.id, isErrand ? o.id : null, who[0], who[1], against, targetId, text]);
      push.notifyAdmins({ title: 'Aklatak — الإدارة', body: '⚠️ شكوى جديدة', url: '/admin/#dx-complaints' });
      return ok(res, { ok: true }, 201);
    }],

    // ===== admin (owner) =====
    ['GET', /^\/api\/admin\/delivery\/overview$/, owner(async (req, res) => {
      const s = await S.get();
      const day = new Date(); day.setUTCHours(0, 0, 0, 0);
      const cn = cOf(req);
      // with a country chosen, every number is for that country only
      const n = async (sql, p = []) => (await db.one(sql, cn ? [...p, cn] : p)).n;
      const C = (col, i) => (cn ? ` AND COALESCE(${col},'LB') = $${i}` : '');
      return ok(res, {
        ordersToday: await n(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM orders o WHERE o.created_at >= $1${C('o.country', 2)}`, [day.toISOString()]),
        activeOrders: await n(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM orders o WHERE o.status IN ('pending','preparing','searching','assigned','picked_up')${C('o.country', 1)}`),
        driversAvailable: await n(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM drivers WHERE status = 'active' AND available = 1 AND loc_at >= $1${C('country', 2)}`, [new Date(Date.now() - s.driverStaleSec * 1000).toISOString()]),
        driversPending: await n(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM drivers WHERE status = 'pending'${C('country', 1)}`),
        topupsPending: await n(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM topups t JOIN cooks c ON c.id = t.cook_id WHERE t.status = 'pending'${C('c.country', 1)}`),
        renewalsPending: await n(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM renewals t JOIN cooks c ON c.id = t.cook_id WHERE t.status = 'pending'${C('c.country', 1)}`),
        payoutsDue: await n(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM withdrawals w LEFT JOIN drivers d ON w.account_type = 'driver' AND d.id = w.account_id LEFT JOIN cooks c ON w.account_type = 'store' AND c.id = w.account_id
          WHERE w.status = 'pending'${cn ? ` AND COALESCE(d.country, c.country, 'LB') = $1` : ''}`),
        complaintsOpen: await n(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM complaints WHERE status = 'open'${cn ? ' AND $1 = $1' : ''}`),
      });
    })],

    ['GET', /^\/api\/admin\/delivery\/settings$/, owner(async (req, res) => ok(res, { settings: await S.get(), smsVerification: sms.enabled, roads: roads?.stats?.() || { enabled: false } }))],
    ['PUT', /^\/api\/admin\/delivery\/settings$/, owner(async (req, res) => ok(res, { settings: await S.set(await readJson(req)) }))],

    ['GET', /^\/api\/admin\/drivers$/, owner(async (req, res) => {
      const st = q(req).get('status'), cn = cOf(req);
      const conds = [], params = [];
      if (st) { params.push(st); conds.push(`status = $${params.length}`); }
      if (cn) { params.push(cn); conds.push(`COALESCE(country,'LB') = $${params.length}`); }
      const rows = await db.query(`SELECT id, full_name, phone, vehicle, plate, status, available, country, wallet_provider, wallet_number, created_at FROM drivers
        ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`, params);
      for (const r of rows) { r.balance = await balance(db, 'driver', r.id); r.warnings = await activeWarnings(db, 'driver', r.id); }
      return ok(res, { drivers: rows });
    })],

    ['GET', /^\/api\/admin\/drivers\/(\d+)$/, owner(async (req, res, m) => {
      const d = await db.one('SELECT id, full_name, phone, vehicle, plate, status, available, country, wallet_provider, wallet_number, admin_notes, terms_accepted_at, jobs_until, birth_date, jobs_request_months, created_at FROM drivers WHERE id = $1', [Number(m[1])]);
      if (!d) throw new HttpError(404, 'not_found');
      const docs = await db.query('SELECT id, kind FROM driver_documents WHERE driver_id = $1 ORDER BY id', [d.id]);
      return ok(res, { driver: { ...d, balance: await balance(db, 'driver', d.id), warnings: await warningsOf('driver', d.id) }, documents: docs });
    })],

    // Private documents: streamed to the owner only, never cached, never on public storage.
    ['GET', /^\/api\/admin\/drivers\/(\d+)\/documents\/(\d+)$/, owner(async (req, res, m) => {
      const doc = await db.one('SELECT mime, data FROM driver_documents WHERE id = $1 AND driver_id = $2', [Number(m[2]), Number(m[1])]);
      if (!doc) throw new HttpError(404, 'not_found');
      const body = Buffer.from(doc.data, 'base64');
      res.writeHead(200, { 'Content-Type': doc.mime, 'Content-Length': body.length, 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    })],

    ['POST', /^\/api\/admin\/drivers\/(\d+)\/status$/, owner(async (req, res, m) => {
      const b = await readJson(req);
      const v = new Validator();
      const status = v.oneOf('status', b.status, ['active', 'rejected', 'suspended']);
      v.assert();
      const id = Number(m[1]);
      if (!(await accountExists(db, 'driver', id))) throw new HttpError(404, 'not_found');
      if (status === 'suspended') await setSuspended(db, 'driver', id, true);
      else await db.query(`UPDATE drivers SET status = $1, available = 0 WHERE id = $2`, [status, id]);
      return ok(res);
    })],

    ['GET', /^\/api\/admin\/customers$/, owner(async (req, res) => {
      const text = String(q(req).get('q') || '').trim().slice(0, 40), cn = cOf(req);
      const rows = await db.query(`SELECT id, name, phone, status, country, created_at FROM customers WHERE phone NOT LIKE 'deleted-%'
        ${text ? 'AND (LOWER(name) LIKE $1 OR phone LIKE $1)' : ''} ${cn ? `AND COALESCE(country,'LB') = $${text ? 2 : 1}` : ''} ORDER BY id DESC LIMIT 300`,
        [...(text ? [`%${text.toLowerCase()}%`] : []), ...(cn ? [cn] : [])]);
      for (const r of rows) r.warnings = await activeWarnings(db, 'customer', r.id);
      return ok(res, { customers: rows });
    })],

    ['GET', /^\/api\/admin\/orders$/, owner(async (req, res) => {
      const st = q(req).get('status');
      const rows = await db.query(`SELECT o.id, o.status, o.total, o.delivery_fee, o.created_at, c.full_name AS store, cu.name AS customer, d.full_name AS driver
        FROM orders o JOIN cooks c ON c.id = o.cook_id JOIN customers cu ON cu.id = o.customer_id LEFT JOIN drivers d ON d.id = o.driver_id
        WHERE 1 = 1 ${st === 'active' ? `AND o.status IN ('pending','preparing','searching','assigned','picked_up')` : ''} ${cOf(req) ? `AND COALESCE(c.country,'LB') = $1` : ''} ORDER BY o.id DESC LIMIT 200`, cOf(req) ? [cOf(req)] : []);
      return ok(res, { orders: rows });
    })],

    ['GET', /^\/api\/admin\/topups$/, owner(async (req, res) => {
      const st = q(req).get('status') || 'pending';
      const rows = await db.query(`SELECT t.id, t.cook_id, t.amount, t.method, t.reference, t.status, t.created_at, c.full_name AS store
        FROM topups t JOIN cooks c ON c.id = t.cook_id WHERE t.status = $1 ORDER BY t.id DESC LIMIT 200`, [st]);
      return ok(res, { topups: rows });
    })],

    ['GET', /^\/api\/admin\/topups\/(\d+)\/receipt$/, owner(async (req, res, m) => {
      const t = await db.one('SELECT receipt_mime, receipt FROM topups WHERE id = $1', [Number(m[1])]);
      if (!t?.receipt) throw new HttpError(404, 'not_found');
      const body = Buffer.from(t.receipt, 'base64');
      res.writeHead(200, { 'Content-Type': t.receipt_mime, 'Content-Length': body.length, 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' });
      res.end(body);
    })],

    ['POST', /^\/api\/admin\/topups\/(\d+)\/(approve|reject)$/, owner(async (req, res, m) => {
      await db.tx(async (t) => {
        const tp = await t.one(`SELECT id, cook_id, amount, method, status FROM topups WHERE id = $1`, [Number(m[1])]);
        if (!tp) throw new HttpError(404, 'not_found');
        if (tp.status !== 'pending') throw stateError();
        const done = await t.query(`UPDATE topups SET status = $1, decided_at = $2 WHERE id = $3 AND status = 'pending' RETURNING id`, [m[2] === 'approve' ? 'approved' : 'rejected', iso(), tp.id]);
        if (!done.length) throw stateError();
        if (m[2] === 'approve') await ledgerAdd(t, 'store', tp.cook_id, Number(tp.amount), 'topup', { note: `${tp.method} #${tp.id}` });
      });
      return ok(res);
    })],

    ['POST', /^\/api\/admin\/stores\/(\d+)\/wallet-adjust$/, owner(async (req, res, m) => {
      const b = await readJson(req);
      const v = new Validator();
      const amount = v.number('amount', b.amount, { min: -10000, max: 10000 });
      const note = v.text('note', b.note, { max: 120 });
      v.assert();
      if (!(await accountExists(db, 'store', Number(m[1])))) throw new HttpError(404, 'not_found');
      await ledgerAdd(db, 'store', Number(m[1]), amount, 'adjust', { note });
      return ok(res, { balance: await balance(db, 'store', Number(m[1])) });
    })],

    ['GET', /^\/api\/admin\/payouts$/, owner(async (req, res) => {
      const st = q(req).get('status') || 'due';
      const rows = await db.query(`SELECT p.id, p.driver_id, p.amount, p.provider, p.number, p.status, p.paid_at, p.created_at, d.full_name AS driver
        FROM payouts p JOIN drivers d ON d.id = p.driver_id WHERE p.status = $1 ORDER BY p.id DESC LIMIT 200`, [st]);
      return ok(res, { payouts: rows });
    })],

    ['POST', /^\/api\/admin\/payouts\/(\d+)\/paid$/, owner(async (req, res, m) => {
      const s = await S.get();
      const driverId = await db.tx(async (t) => {
        const p = await t.one('SELECT id, driver_id, amount, status FROM payouts WHERE id = $1', [Number(m[1])]);
        if (!p) throw new HttpError(404, 'not_found');
        if (p.status !== 'due') throw stateError();
        await t.query(`UPDATE payouts SET status = 'paid', paid_at = $1 WHERE id = $2`, [iso(), p.id]);
        await ledgerAdd(t, 'driver', p.driver_id, -Number(p.amount), 'payout', { note: `payout #${p.id}` });
        return p.driver_id;
      });
      return ok(res);
    })],

    ['GET', /^\/api\/admin\/complaints$/, owner(async (req, res) => {
      const st = q(req).get('status') || 'open';
      const rows = await db.query('SELECT id, order_id, errand_id, from_type, from_id, against_type, against_id, text, status, created_at FROM complaints WHERE status = $1 ORDER BY id DESC LIMIT 300', [st]);
      return ok(res, { complaints: rows });
    })],

    ['POST', /^\/api\/admin\/complaints\/(\d+)\/(warn|dismiss)$/, owner(async (req, res, m) => {
      const c = await db.one('SELECT id, against_type, against_id, status FROM complaints WHERE id = $1', [Number(m[1])]);
      if (!c) throw new HttpError(404, 'not_found');
      if (c.status !== 'open') throw stateError();
      if (m[2] === 'dismiss') {
        await db.query(`UPDATE complaints SET status = 'dismissed', decided_at = $1 WHERE id = $2`, [iso(), c.id]);
        return ok(res);
      }
      const b = await readJson(req);
      const v = new Validator();
      const reason = v.text('reason', b.reason, { min: 3, max: 300 });
      v.assert();
      const w = await addWarning(db, await S.get(), { type: c.against_type, id: c.against_id, reason, complaintId: c.id });
      await db.query(`UPDATE complaints SET status = 'warned', decided_at = $1 WHERE id = $2`, [iso(), c.id]);
      return ok(res, w);
    })],

    ['POST', /^\/api\/admin\/warnings$/, owner(async (req, res) => {
      const b = await readJson(req);
      const v = new Validator();
      const type = v.oneOf('type', b.type, ['store', 'driver', 'customer']);
      const id = v.int('id', b.id, { min: 1 });
      const reason = v.text('reason', b.reason, { min: 3, max: 300 });
      v.assert();
      if (!(await accountExists(db, type, id))) throw new HttpError(404, 'not_found');
      return ok(res, await addWarning(db, await S.get(), { type, id, reason }), 201);
    })],

    ['GET', /^\/api\/admin\/warnings$/, owner(async (req, res) => {
      const p = q(req);
      const v = new Validator();
      const type = v.oneOf('type', p.get('type'), ['store', 'driver', 'customer']);
      const id = v.int('id', p.get('id'), { min: 1 });
      v.assert();
      return ok(res, await warningsOf(type, id));
    })],

    ['POST', /^\/api\/admin\/accounts\/(store|driver|customer)\/(\d+)\/(suspend|activate)$/, owner(async (req, res, m) => {
      const id = Number(m[2]);
      if (!(await accountExists(db, m[1], id))) throw new HttpError(404, 'not_found');
      await setSuspended(db, m[1], id, m[3] === 'suspend');
      return ok(res);
    })],

    ['GET', /^\/api\/admin\/delivery\/stores$/, owner(async (req, res) => {
      const text = String(q(req).get('q') || '').trim().slice(0, 40), cn = cOf(req);
      const rows = await db.query(`SELECT id, full_name, kind, country, whatsapp, delivery_mode, booking, pinned, suspended, is_hidden, status, parent_id, area_label FROM cooks
        WHERE status <> 'rejected' ${text ? 'AND (LOWER(full_name) LIKE $1 OR whatsapp LIKE $1)' : ''} ${cn ? `AND COALESCE(country,'LB') = $${text ? 2 : 1}` : ''} ORDER BY COALESCE(parent_id, id) DESC, parent_id IS NOT NULL, id LIMIT 300`,
        [...(text ? [`%${text.toLowerCase()}%`] : []), ...(cn ? [cn] : [])]);
      const plans = await getPlans();
      for (const r of rows) {
        r.balance = await balance(db, 'store', r.id); r.warnings = await activeWarnings(db, 'store', r.id);
        if (!r.parent_id) {
          const n = (await db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM cooks WHERE parent_id = $1 AND status <> 'rejected'`, [r.id])).n;
          r.branches = n; r.price = storePrice(plans, r.delivery_mode === 'delivery' ? 'delivery' : 'basic', 1, n + 1);
        }
      }
      return ok(res, { stores: rows });
    })],

    ['POST', /^\/api\/admin\/stores\/(\d+)\/delivery$/, owner(async (req, res, m) => {
      const b = await readJson(req);
      const v = new Validator();
      const mode = b.mode === undefined ? undefined : v.oneOf('mode', b.mode, ['delivery', 'self', 'none']);
      v.assert();
      const id = Number(m[1]);
      if (!(await accountExists(db, 'store', id))) throw new HttpError(404, 'not_found');
      if (mode) await db.query('UPDATE cooks SET delivery_mode = $1 WHERE id = $2', [mode, id]);
      if (b.pinned !== undefined) await db.query('UPDATE cooks SET pinned = $1 WHERE id = $2', [b.pinned ? 1 : 0, id]);
      if (b.booking !== undefined) await db.query('UPDATE cooks SET booking = $1 WHERE id = $2', [b.booking ? 1 : 0, id]);
      return ok(res);
    })],
  ];
}
