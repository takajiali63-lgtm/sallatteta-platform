// Delivery core: settings, wallet balances, sending an order to the nearest drivers, warnings, reports.
import { haversineKm } from '../lib/geo.js';
import { HttpError } from '../lib/http.js';
import { cashAllowed } from './finance.js';

export const DELIVERY_DEFAULTS = {
  payoutThreshold: 20,      // a driver can ask to withdraw once his balance reaches this
  storeMinWithdraw: 5,      // smallest withdrawal a store can ask for
  dailyWithdrawMax: 500,    // most an account can withdraw in 24 hours
  warningMonths: 6,         // a warning stops counting after this many months
  maxWarnings: 3,           // this many active warnings = account suspended automatically
  dispatchRadiusKm: 10,     // drivers farther than this (by road) from the store don't get the order
  errandRadiusKm: 10,       // drivers farther than this (by road) from where a customer's request starts don't get it
  routeDailyMax: 2500,      // road-distance calls per day (Geoapify free plan = 3000/day); above it: estimated distances
  offerBatch: 5,            // how many nearest drivers get each order at once
  driverStaleSec: 120,      // a driver whose GPS hasn't updated for this long is treated as unavailable
  raiseAfterSec: 300,       // after this, the store is offered to raise the fee (5 minutes)
  cartIdleMin: 30,          // the customer's cart empties after this long away from the app
  maxPurchaseValue: 50,     // "bring me from a shop": highest purchase value a customer may ask for
  errandMinPrice: 1,        // lowest price a customer can offer a driver
  claimWindowSec: 5,        // drivers who accept within this window compete: the NEAREST to the store wins
  reserveShowSec: 2,        // how long the others still see "reserved" before the offer disappears
  confirmAfterMin: 120,     // the customer confirms receipt; after this the delivery is confirmed automatically
  lateAfterMin: 10,         // after this, the store is offered to replace a driver who hasn't picked up
  cashLimit: 200,           // most restaurant CASH a driver may hold; over it no new cash orders (card orders continue)
  settleLinkMin: 30,        // an online settlement link (Whish / OMT / card) must be paid within this many minutes
  autoPayStores: 1,         // 1 = after a settlement is confirmed, each restaurant's share is sent to its Whish/OMT automatically
  jobsPrice: 10,            // drivers' monthly "customer requests" subscription (shown to drivers; billing via the admin / Google Play)
};

const now = () => new Date().toISOString();
const round2 = (n) => Math.round(Number(n) * 100) / 100;

export function deliverySettings(db) {
  let cached = null, at = 0;
  return {
    async get() {
      if (cached && Date.now() - at < 30_000) return cached;
      const row = await db.one(`SELECT value FROM app_meta WHERE key = 'delivery_settings'`);
      let saved = {};
      try { saved = row ? JSON.parse(row.value) : {}; } catch { saved = {}; }
      cached = { ...DELIVERY_DEFAULTS, ...saved };
      at = Date.now();
      return cached;
    },
    async set(patch) {
      const next = { ...(await this.get()) };
      for (const k of Object.keys(DELIVERY_DEFAULTS)) {
        if (patch[k] === undefined) continue;
        const n = Number(patch[k]);
        if (!Number.isFinite(n) || n < 0 || n > 100000) throw new HttpError(422, 'validation_failed', { fields: { [k]: 'invalid' } });
        next[k] = n;
      }
      const exists = await db.one(`SELECT key FROM app_meta WHERE key = 'delivery_settings'`);
      if (exists) await db.query(`UPDATE app_meta SET value = $1 WHERE key = 'delivery_settings'`, [JSON.stringify(next)]);
      else await db.query(`INSERT INTO app_meta (key, value) VALUES ('delivery_settings', $1)`, [JSON.stringify(next)]);
      cached = next; at = Date.now();
      return next;
    },
  };
}

export async function balance(db, type, id) {
  const r = await db.one(`SELECT COALESCE(SUM(amount), 0) AS b FROM wallet_ledger WHERE account_type = $1 AND account_id = $2`, [type, id]);
  return round2(r?.b || 0);
}

export async function ledgerAdd(db, type, id, amount, kind, { orderId = null, note = null } = {}) {
  await db.query(`INSERT INTO wallet_ledger (account_type, account_id, amount, kind, order_id, note) VALUES ($1,$2,$3,$4,$5,$6)`,
    [type, id, round2(amount), kind, orderId, note]);
}

/** Nearest available, active drivers with a fresh GPS position, within the radius (by road when Geoapify is set). */
export async function nearestDrivers(db, store, s, { exclude = [], jobsOnly = false, country = 'LB', roads = null, radiusKm = null, cashFood = 0 } = {}) {
  const fresh = new Date(Date.now() - s.driverStaleSec * 1000).toISOString();
  const radius = Number(radiusKm ?? s.dispatchRadiusKm);
  // every country is fully separate: only drivers of the same country
  const rows = await db.query(
    `SELECT id, lat, lng FROM drivers WHERE status = 'active' AND available = 1 AND loc_at >= $1 AND lat IS NOT NULL AND COALESCE(country, 'LB') = $${jobsOnly ? 3 : 2}
     AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.driver_id = drivers.id AND o.status IN ('assigned','picked_up'))
     AND NOT EXISTS (SELECT 1 FROM errands e WHERE e.driver_id = drivers.id AND e.status IN ('assigned','picked_up'))
     AND NOT EXISTS (SELECT 1 FROM order_offers f WHERE f.driver_id = drivers.id AND f.status = 'sent' AND f.claimed_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM errand_offers f WHERE f.driver_id = drivers.id AND f.status = 'sent' AND f.claimed_at IS NOT NULL)
     ${jobsOnly ? 'AND jobs_until > $2' : ''}`, jobsOnly ? [fresh, new Date().toISOString(), country] : [fresh, country]);
  // a road is never shorter than the straight line: drop the far ones first, then measure the rest by road
  let list = rows
    .filter((d) => !exclude.includes(d.id))
    .map((d) => ({ id: d.id, lat: d.lat, lng: d.lng, km: haversineKm(store.lat, store.lng, d.lat, d.lng) }))
    .filter((d) => d.km <= radius)
    .sort((a, b) => a.km - b.km)
    .slice(0, Math.max(s.offerBatch * 3, 12));
  // a cash order only goes to drivers who can still hold its food money (card orders: everyone)
  if (cashFood > 0) {
    const ok = [];
    for (const d of list) if (await cashAllowed(db, s, d.id)) ok.push(d);
    list = ok;
  }
  if (roads && list.length) {
    const road = await roads.many(list.map((d) => ({ lat: d.lat, lng: d.lng, track: `d${d.id}` })), store);
    list = list.map((d, i) => ({ ...d, m: road[i].m, approx: road[i].approx, km: road[i].m / 1000 }))
      .filter((d) => d.approx || d.km <= radius)
      .sort((a, b) => a.km - b.km);
  }
  return list.slice(0, s.offerBatch).map((d) => ({ id: d.id, km: d.km, m: Math.round(d.m ?? d.km * 1000) }));
}

/** Send (or re-send with a new fee) a 'searching' order to the nearest drivers. Returns how many got it. */
export async function dispatch(db, order, store, s, roads = null) {
  const tried = (await db.query(`SELECT driver_id FROM order_offers WHERE order_id = $1 AND status = 'declined'`, [order.id])).map((r) => r.driver_id);
  await db.query(`UPDATE order_offers SET status = 'lost' WHERE order_id = $1 AND status = 'sent'`, [order.id]);
  const cashFood = order.customer_total != null && order.payment_method === 'cash' && !Number(order.self_delivery) ? Number(order.total) : 0;
  const drivers = await nearestDrivers(db, store, s, { exclude: tried, country: store.country || 'LB', roads, cashFood });
  for (const d of drivers) {
    await db.query(`INSERT INTO order_offers (order_id, driver_id, fee) VALUES ($1,$2,$3)`, [order.id, d.id, Math.round((Number(order.delivery_fee || 0) + Number(order.bonus_fee || 0)) * 100) / 100]);
  }
  return drivers.length;
}

const TYPE_TABLE = { store: 'cooks', driver: 'drivers', customer: 'customers' };

export async function accountExists(db, type, id) {
  if (!TYPE_TABLE[type]) return false;
  return !!(await db.one(`SELECT id FROM ${TYPE_TABLE[type]} WHERE id = $1`, [id]));
}

/** Suspend = hidden from the app and can't receive/send orders until the admin re-activates. */
export async function setSuspended(db, type, id, suspended) {
  if (type === 'store') {
    await db.query(`UPDATE cooks SET suspended = $1, is_hidden = $1 WHERE id = $2`, [suspended ? 1 : 0, id]);
  } else if (type === 'driver') {
    if (suspended) await db.query(`UPDATE drivers SET status = 'suspended', available = 0 WHERE id = $1`, [id]);
    else await db.query(`UPDATE drivers SET status = 'active' WHERE id = $1`, [id]);
  } else if (type === 'customer') {
    await db.query(`UPDATE customers SET status = $1 WHERE id = $2`, [suspended ? 'suspended' : 'active', id]);
  }
}

export async function activeWarnings(db, type, id) {
  const r = await db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM warnings WHERE account_type = $1 AND account_id = $2 AND expires_at > $3`, [type, id, now()]);
  return r?.n || 0;
}

/** Add a warning; the Nth active warning (default 3) suspends the account automatically. */
export async function addWarning(db, s, { type, id, reason, complaintId = null }) {
  const exp = new Date(Date.now() + s.warningMonths * 30.44 * 24 * 3600_000).toISOString();
  await db.query(`INSERT INTO warnings (account_type, account_id, reason, complaint_id, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [type, id, reason, complaintId, exp]);
  const count = await activeWarnings(db, type, id);
  const suspended = count >= s.maxWarnings;
  if (suspended) await setSuspended(db, type, id, true);
  return { count, max: s.maxWarnings, suspended };
}

/** After a delivery: pay the driver into his balance; open a payout each time it reaches the threshold. */
export async function maybeOpenPayout(db, driverId, s) {
  const open = await db.one(`SELECT id FROM payouts WHERE driver_id = $1 AND status = 'due'`, [driverId]);
  if (open) return null;
  const b = await balance(db, 'driver', driverId);
  if (b < s.payoutThreshold) return null;
  const d = await db.one(`SELECT wallet_provider, wallet_number FROM drivers WHERE id = $1`, [driverId]);
  await db.query(`INSERT INTO payouts (driver_id, amount, provider, number) VALUES ($1,$2,$3,$4)`, [driverId, b, d?.wallet_provider || null, d?.wallet_number || null]);
  return b;
}

function rangeOf(q) {
  const to = q.to ? new Date(q.to) : new Date();
  let from;
  if (q.from) from = new Date(q.from);
  else if (q.period === 'today') { from = new Date(); from.setUTCHours(0, 0, 0, 0); }
  else if (q.period === 'week') from = new Date(Date.now() - 7 * 864e5);
  else from = new Date(Date.now() - 30 * 864e5);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new HttpError(422, 'validation_failed', { fields: { from: 'invalid' } });
  return { from: from.toISOString(), to: to.toISOString() };
}

export async function storeReport(db, cookId, q) {
  const { from, to } = rangeOf(q);
  const orders = await db.query(`SELECT id, status, total, delivery_fee FROM orders WHERE cook_id = $1 AND created_at >= $2 AND created_at <= $3`, [cookId, from, to]);
  const delivered = orders.filter((o) => o.status === 'delivered');
  const ids = delivered.map((o) => o.id);
  let top = [];
  if (ids.length) {
    const ph = ids.map((_, i) => `$${i + 1}`).join(',');
    top = await db.query(`SELECT name, CAST(SUM(qty) AS INTEGER) AS qty, SUM(qty * price) AS amount FROM order_items WHERE order_id IN (${ph}) GROUP BY name ORDER BY SUM(qty) DESC LIMIT 5`, ids);
  }
  const views = await db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM cook_page_views WHERE cook_id = $1 AND created_at >= $2 AND created_at <= $3`, [cookId, from, to]).catch(() => ({ n: 0 }));
  return {
    from, to,
    orders: orders.length,
    delivered: delivered.length,
    rejected: orders.filter((o) => o.status === 'rejected').length,
    cancelled: orders.filter((o) => o.status === 'cancelled').length,
    sales: round2(delivered.reduce((a, o) => a + Number(o.total), 0)),
    deliveryFeesPaid: round2(delivered.reduce((a, o) => a + Number(o.delivery_fee || 0), 0)),
    topItems: top.map((t) => ({ name: t.name, qty: Number(t.qty), amount: round2(t.amount) })),
    pageViews: views?.n || 0,
    balance: await balance(db, 'store', cookId),
  };
}

export async function driverReport(db, driverId, q) {
  const { from, to } = rangeOf(q);
  const rows = await db.query(
    `SELECT o.id, o.delivery_fee + COALESCE(o.bonus_fee, 0) AS delivery_fee, o.distance_m, c.full_name AS store FROM orders o JOIN cooks c ON c.id = o.cook_id
     WHERE o.driver_id = $1 AND o.status = 'delivered' AND o.delivered_at >= $2 AND o.delivered_at <= $3`, [driverId, from, to]);
  const paid = await db.one(`SELECT COALESCE(SUM(amount),0) AS s FROM payouts WHERE driver_id = $1 AND status = 'paid' AND paid_at >= $2 AND paid_at <= $3`, [driverId, from, to]);
  const byStore = {};
  for (const r of rows) byStore[r.store] = (byStore[r.store] || 0) + 1;
  const er = await db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM errands WHERE driver_id = $1 AND status = 'delivered' AND delivered_at >= $2 AND delivered_at <= $3`, [driverId, from, to]);
  return {
    from, to,
    errands: er?.n || 0,
    deliveries: rows.length,
    km: round2(rows.reduce((a, r) => a + Number(r.distance_m || 0), 0) / 1000),
    earnings: round2(rows.reduce((a, r) => a + Number(r.delivery_fee || 0), 0)),
    paid: round2(paid?.s || 0),
    balance: await balance(db, 'driver', driverId),
    topStores: Object.entries(byStore).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => ({ name, deliveries: n })),
  };
}

/** Send a customer's errand to the nearest drivers who have the "customer requests" subscription. */
export async function dispatchErrand(db, errand, s, roads = null) {
  const tried = (await db.query(`SELECT driver_id FROM errand_offers WHERE errand_id = $1 AND status = 'declined'`, [errand.id])).map((r) => r.driver_id);
  await db.query(`UPDATE errand_offers SET status = 'lost' WHERE errand_id = $1 AND status = 'sent'`, [errand.id]);
  const drivers = await nearestDrivers(db, { lat: errand.from_lat, lng: errand.from_lng }, s, { exclude: tried, jobsOnly: true, country: errand.country || 'LB', roads, radiusKm: s.errandRadiusKm });
  for (const d of drivers) await db.query(`INSERT INTO errand_offers (errand_id, driver_id) VALUES ($1,$2)`, [errand.id, d.id]);
  return drivers.length;
}

/** Lock one account row for the rest of the transaction (PostgreSQL), so two requests can't spend the same balance. */
export async function lockAccount(t, kind, type, id) {
  if (kind !== 'pg') return;
  const table = { store: 'cooks', driver: 'drivers' }[type];
  await t.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
}

/* ---------------- nearest-wins acceptance ---------------- */
const CLAIM = {
  order: { offers: 'order_offers', parent: 'orders', fk: 'order_id' },
  errand: { offers: 'errand_offers', parent: 'errands', fk: 'errand_id' },
};
/** Is this driver busy (an active delivery, or a pending claim)? `exceptCook` lets an add-on offer from the same store through. */
export async function driverBusy(t, driverId, { exceptCook = null } = {}) {
  const active = await t.query(`SELECT id, cook_id FROM orders WHERE driver_id = $1 AND status IN ('assigned','picked_up')`, [driverId]);
  const er = await t.one(`SELECT id FROM errands WHERE driver_id = $1 AND status IN ('assigned','picked_up')`, [driverId]);
  if (er) return true;
  if (active.length && !(exceptCook && active.every((o) => o.cook_id === exceptCook))) return true;
  const claims = await t.one(`SELECT (SELECT CAST(COUNT(*) AS INTEGER) FROM order_offers WHERE driver_id = $1 AND status = 'sent' AND claimed_at IS NOT NULL)
    + (SELECT CAST(COUNT(*) AS INTEGER) FROM errand_offers WHERE driver_id = $1 AND status = 'sent' AND claimed_at IS NOT NULL) AS n`, [driverId]);
  return Number(claims.n) > 0;
}

/** Give each order whose acceptance window ended to the nearest driver who accepted. Safe to call often and concurrently. */
export async function resolveClaims(db, kind = 'order', { onWon } = {}) {
  const c = CLAIM[kind];
  const due = await db.query(`SELECT id FROM ${c.parent} WHERE status = 'searching' AND claim_until IS NOT NULL AND claim_until <= $1`, [new Date().toISOString()]);
  const winners = [];
  for (const { id } of due) {
    const won = await db.tx(async (t) => {
      const claims = await t.query(`SELECT id, driver_id, claim_m FROM ${c.offers} WHERE ${c.fk} = $1 AND status = 'sent' AND claimed_at IS NOT NULL ORDER BY claim_m ASC, claimed_at ASC, id ASC`, [id]);
      const now = new Date().toISOString();
      for (const f of claims) {
        // never two jobs for one driver (even if two windows end together): a driver who got another job meanwhile is skipped
        const other = await t.one(`SELECT id FROM ${c.parent} WHERE driver_id = $1 AND id <> $2 AND status IN ('assigned','picked_up')`, [f.driver_id, id]);
        if (other && kind === 'errand') { await t.query(`UPDATE ${c.offers} SET status = 'lost', lost_at = $2 WHERE id = $1`, [f.id, new Date().toISOString()]); continue; }
        if (other && kind === 'order') {
          const mine = await t.one('SELECT cook_id FROM orders WHERE id = $1', [id]);
          const diff = await t.one(`SELECT id FROM orders WHERE driver_id = $1 AND id <> $2 AND status IN ('assigned','picked_up') AND cook_id <> $3`, [f.driver_id, id, mine.cook_id]);
          if (diff) { await t.query(`UPDATE ${c.offers} SET status = 'lost', lost_at = $2 WHERE id = $1`, [f.id, new Date().toISOString()]); continue; }
        }
        // only the first update wins, even with several servers resolving at the same moment
        const r = await t.query(`UPDATE ${c.parent} SET status = 'assigned', driver_id = $1, assigned_at = $2, claim_until = NULL WHERE id = $3 AND status = 'searching' RETURNING id`, [f.driver_id, now, id]);
        if (!r.length) return null;
        await t.query(`UPDATE ${c.offers} SET status = 'won' WHERE id = $1`, [f.id]);
        await t.query(`UPDATE ${c.offers} SET status = 'lost', lost_at = $2 WHERE ${c.fk} = $1 AND id <> $3 AND status = 'sent'`, [id, now, f.id]);
        return { id, driverId: f.driver_id, losers: claims.filter((x) => x.id !== f.id).map((x) => x.driver_id) };
      }
      await t.query(`UPDATE ${c.parent} SET claim_until = NULL WHERE id = $1`, [id]);
      return null;
    });
    if (won) { winners.push(won); onWon?.(won); }
  }
  return winners;
}

/** A driver accepts: he joins the window; when it ends (or at once if the window is 0) the nearest one gets it. */
export async function claimOffer(db, s, kind, { offerId, driverId, exceptCook = null, instant = false, roads = null }) {
  const c = CLAIM[kind];
  // the road distance is measured before the transaction (no network call while rows are locked)
  let roadM = null;
  if (roads) {
    const d = await db.one('SELECT lat, lng FROM drivers WHERE id = $1', [driverId]);
    const p = kind === 'order'
      ? await db.one(`SELECT c.lat, c.lng FROM order_offers f JOIN orders o ON o.id = f.order_id JOIN cooks c ON c.id = o.cook_id WHERE f.id = $1`, [offerId])
      : await db.one(`SELECT e.from_lat AS lat, e.from_lng AS lng FROM errand_offers f JOIN errands e ON e.id = f.errand_id WHERE f.id = $1`, [offerId]);
    if (d?.lat != null && p) roadM = (await roads.distance(d, p, { track: `d${driverId}` })).m;
  }
  if (kind === 'order') {   // backend rule: no new cash order over the driver's cash limit (card orders always allowed)
    const o = await db.one(`SELECT o.total, o.payment_method, o.customer_total FROM order_offers f JOIN orders o ON o.id = f.order_id WHERE f.id = $1`, [offerId]);
    if (o && o.customer_total != null && o.payment_method === 'cash' && !(await cashAllowed(db, s, driverId))) {
      throw Object.assign(new Error('cash_limit_reached'), { code: 'cash_limit_reached' });
    }
  }
  const res = await db.tx(async (t) => {
    // one claim at a time per driver: on PostgreSQL two "accept" taps at the same moment would both see him free
    await lockAccount(t, db.kind, 'driver', driverId);
    const f = await t.one(`SELECT f.id, f.${c.fk} AS pid, f.claimed_at, p.status, p.claim_until FROM ${c.offers} f JOIN ${c.parent} p ON p.id = f.${c.fk}
      WHERE f.id = $1 AND f.driver_id = $2 AND f.status = 'sent'`, [offerId, driverId]);
    if (!f || f.status !== 'searching') throw Object.assign(new Error('offer_gone'), { code: 'offer_gone' });
    if (f.claimed_at) return { pid: f.pid, until: f.claim_until };
    if (await driverBusy(t, driverId, { exceptCook })) throw Object.assign(new Error('driver_busy'), { code: 'driver_busy' });
    const d = await t.one('SELECT lat, lng FROM drivers WHERE id = $1', [driverId]);
    const p = kind === 'order'
      ? await t.one('SELECT c.lat, c.lng FROM orders o JOIN cooks c ON c.id = o.cook_id WHERE o.id = $1', [f.pid])
      : await t.one('SELECT from_lat AS lat, from_lng AS lng FROM errands WHERE id = $1', [f.pid]);
    const m = roadM != null ? roadM : d?.lat != null ? Math.round(haversineKm(p.lat, p.lng, d.lat, d.lng) * 1000) : 999999;
    const now = Date.now();
    await t.query(`UPDATE ${c.offers} SET claimed_at = $1, claim_m = $2 WHERE id = $3`, [new Date(now).toISOString(), m, f.id]);
    const until = instant || !s.claimWindowSec ? new Date(now).toISOString() : new Date(now + s.claimWindowSec * 1000).toISOString();
    await t.query(`UPDATE ${c.parent} SET claim_until = $1 WHERE id = $2 AND claim_until IS NULL`, [until, f.pid]);
    const cur = await t.one(`SELECT claim_until FROM ${c.parent} WHERE id = $1`, [f.pid]);
    return { pid: f.pid, until: cur.claim_until };
  });
  return res;
}

// Completing an order (customer confirmed / automatic) lives in finance.js (cash vs card rules).
export { completeOrder as settleOrder, completeDue as settleDue } from './finance.js';

/** Subscription price: first branch full price, each extra branch + branchPercent % (e.g. 10 + 5 + 5 = 20). */
export function storePrice(plans, kind, months, branches = 1) {
  const base = Number(plans.store[kind]?.[months]?.price || 0);
  const extra = Math.max(0, branches - 1) * base * (Number(plans.branchPercent) / 100);
  return Math.round((base + extra) * 100) / 100;
}
