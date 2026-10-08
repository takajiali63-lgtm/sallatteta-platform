// v7.6 money model — the customer pays FOOD + DELIVERY FEE.
//   CASH: the customer pays the driver; the food money is the restaurant's (a "cash payable" the driver holds),
//         the delivery fee is the driver's (already in his pocket).
//   CARD: the customer pays electronically; the food money is credited to the restaurant's account, the delivery fee to
//         the driver's account (both withdrawable). The driver holds nothing.
// A driver may hold at most `cashLimit` (default 200 $) of restaurants' cash: over it he gets no NEW cash orders
// (card orders keep coming). He hands the cash over with a settlement (Whish / OMT) that the system breaks down per
// restaurant automatically; only the owner's verification changes balances. Ledgers are the source of truth; every money
// event is also written to the append-only financial_ledger.
import { HttpError } from '../lib/http.js';
import { ledgerAdd, balance } from './delivery.js';

const cents = (n) => Math.round(Number(n || 0) * 100);
const money = (c) => Math.round(c) / 100;
const iso = () => new Date().toISOString();

export async function journal(t, e) {
  await t.query(`INSERT INTO financial_ledger (kind, order_id, store_id, driver_id, payment_id, settlement_id, amount, currency, payment_method, note)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [e.kind, e.orderId ?? null, e.storeId ?? null, e.driverId ?? null, e.paymentId ?? null, e.settlementId ?? null, money(cents(e.amount)), e.currency || 'USD', e.method ?? null, e.note ?? null]);
}

/** Restaurant cash a driver holds or is about to hold: completed-but-not-settled + delivered/active cash orders. */
export async function driverCashExposure(db, driverId) {
  const a = await db.one(`SELECT COALESCE(SUM(amount), 0) AS s FROM driver_cash_entries WHERE driver_id = $1 AND status IN ('open','in_settlement')`, [driverId]);
  const b = await db.one(`SELECT COALESCE(SUM(total), 0) AS s FROM orders WHERE driver_id = $1 AND payment_method = 'cash' AND customer_total IS NOT NULL AND self_delivery = 0
    AND (status IN ('assigned','picked_up') OR (status = 'delivered' AND financial_status IN ('open','disputed')))`, [driverId]);
  return money(cents(a.s) + cents(b.s));
}
/** Held = completed cash orders not yet verified in a settlement (what the driver must hand over). */
export async function driverCashHeld(db, driverId) {
  const a = await db.one(`SELECT COALESCE(SUM(amount), 0) AS s FROM driver_cash_entries WHERE driver_id = $1 AND status IN ('open','in_settlement')`, [driverId]);
  return money(cents(a.s));
}
/** May this driver take a NEW cash order? Backend rule: while the restaurant cash he holds is under the limit — any size
 *  (180 $ + a 50 $ order is fine → 230 $); from the limit up, no new cash orders until he settles. Card orders: always. */
export async function cashAllowed(db, s, driverId) {
  const limit = Number(s.cashLimit ?? 200);
  return cents(await driverCashExposure(db, driverId)) < cents(limit);
}

/** Driver's money summary (his own only). */
export async function driverFinance(db, s, driverId) {
  const limit = Number(s.cashLimit ?? 200);
  const held = await driverCashHeld(db, driverId);
  const exposure = await driverCashExposure(db, driverId);
  const earn = await db.one(`SELECT COALESCE(SUM(fee + bonus), 0) AS total,
      COALESCE(SUM(CASE WHEN method = 'cash' THEN fee ELSE 0 END) + SUM(bonus), 0) AS cash_in_hand
    FROM driver_earnings WHERE driver_id = $1 AND reversed = 0`, [driverId]);
  const byStore = await db.query(`SELECT e.store_id, c.full_name AS store, COALESCE(SUM(e.amount), 0) AS amount, CAST(COUNT(*) AS INTEGER) AS orders
    FROM driver_cash_entries e JOIN cooks c ON c.id = e.store_id WHERE e.driver_id = $1 AND e.status = 'open' GROUP BY e.store_id, c.full_name ORDER BY c.full_name`, [driverId]);
  const inSettlement = await db.one(`SELECT COALESCE(SUM(amount), 0) AS s FROM driver_cash_entries WHERE driver_id = $1 AND status = 'in_settlement'`, [driverId]);
  return {
    earnings: money(cents(earn.total)), cashEarningsInHand: money(cents(earn.cash_in_hand)), withdrawable: await balance(db, 'driver', driverId),
    restaurantCash: held, pendingInSettlement: money(cents(inSettlement.s)), exposure, cashLimit: limit, remaining: money(Math.max(0, cents(limit) - cents(exposure))),
    cashOrders: cents(exposure) < cents(limit), cardOrders: true,
    owed: byStore.map((r) => ({ storeId: r.store_id, store: r.store, amount: money(cents(r.amount)), orders: r.orders })),
  };
}

/**
 * An order is COMPLETED (customer confirmed, or automatically after the waiting time). Exactly once.
 * Old orders (before v7.6, customer_total NULL) keep the old rule: the store-paid fee goes to the driver.
 */
export async function completeOrder(t, orderId, { auto = false } = {}) {
  const o = await t.one(`SELECT id, cook_id, driver_id, total, delivery_fee, bonus_fee, customer_total, payment_method, payment_status, self_delivery, currency, financial_status, fee_state
    FROM orders WHERE id = $1 AND status = 'delivered'`, [orderId]);
  if (!o) return false;
  const now = iso();
  if (o.customer_total == null) {   // legacy order
    const r = await t.query(`UPDATE orders SET fee_state = 'paid', confirmed_at = COALESCE(confirmed_at, $1) WHERE id = $2 AND fee_state = 'awaiting' RETURNING id`, [now, o.id]);
    if (!r.length) return false;
    if (o.driver_id) await ledgerAdd(t, 'driver', o.driver_id, Number(o.delivery_fee || 0), 'earning', { orderId: o.id, note: auto ? 'auto-confirmed' : 'customer confirmed' });
    return true;
  }
  const r = await t.query(`UPDATE orders SET financial_status = 'completed', fee_state = 'paid', confirmed_at = COALESCE(confirmed_at, $1) WHERE id = $2 AND financial_status = 'open' RETURNING id`, [now, o.id]);
  if (!r.length) return false;
  const food = Number(o.total), fee = Number(o.delivery_fee || 0), bonus = Number(o.bonus_fee || 0);
  const card = o.payment_method === 'card';
  const base = { orderId: o.id, storeId: o.cook_id, driverId: o.driver_id, currency: o.currency || 'USD', method: o.payment_method };
  if (card) {
    // the provider collected everything: the restaurant's food money and (for its own delivery) the fee go to its account
    const storeGets = food + (Number(o.self_delivery) || !o.driver_id ? fee : 0);
    await ledgerAdd(t, 'store', o.cook_id, storeGets, 'earning', { orderId: o.id, note: `card sale #${o.id}` });
    await journal(t, { ...base, kind: 'card_sale_store', amount: storeGets });
  } else {
    await journal(t, { ...base, kind: Number(o.self_delivery) || !o.driver_id ? 'cash_sale_store_direct' : 'cash_sale_via_driver', amount: food });
  }
  if (o.driver_id && !Number(o.self_delivery)) {
    if (!card) {
      await t.query(`INSERT INTO driver_cash_entries (order_id, driver_id, store_id, amount, currency) VALUES ($1,$2,$3,$4,$5)`, [o.id, o.driver_id, o.cook_id, food, o.currency || 'USD']);
      await journal(t, { ...base, kind: 'driver_cash_payable', amount: food });
    } else {
      await ledgerAdd(t, 'driver', o.driver_id, fee, 'earning', { orderId: o.id, note: `card delivery fee #${o.id}` });
    }
    await t.query(`INSERT INTO driver_earnings (order_id, driver_id, store_id, fee, bonus, method) VALUES ($1,$2,$3,$4,$5,$6)`, [o.id, o.driver_id, o.cook_id, fee, bonus, o.payment_method]);
    await journal(t, { ...base, kind: card ? 'driver_fee_card' : 'driver_fee_cash', amount: fee });
    if (bonus > 0) await journal(t, { ...base, kind: 'driver_bonus_cash_from_store', amount: bonus });   // paid by the store in cash at pick-up
  }
  return true;
}

export async function completeDue(db, s) {
  const before = new Date(Date.now() - s.confirmAfterMin * 60_000).toISOString();
  const due = await db.query(`SELECT id, cook_id, driver_id FROM orders WHERE status = 'delivered' AND delivered_at <= $1
    AND ((customer_total IS NULL AND fee_state = 'awaiting') OR (customer_total IS NOT NULL AND financial_status = 'open'))`, [before]);
  const done = [];
  for (const o of due) if (await db.tx((t) => completeOrder(t, o.id, { auto: true }))) done.push(o);
  return done;
}

/* ---------------- settlements ---------------- */
/** The driver hands over cash: all his open restaurant cash, or only some restaurants'. Amount must match EXACTLY. */
export async function createSettlement(db, driverId, { amount, method, reference, receipt = null, receiptMime = null, storeIds = null, senderNumber = null, online = null }) {
  return db.tx(async (t) => {
    const all = await t.query(`SELECT id, order_id, store_id, amount FROM driver_cash_entries WHERE driver_id = $1 AND status = 'open' ORDER BY id`, [driverId]);
    const pick = storeIds?.length ? all.filter((e) => storeIds.includes(e.store_id)) : all;
    if (!pick.length) throw new HttpError(409, 'nothing_to_settle');
    const due = pick.reduce((a, e) => a + cents(e.amount), 0);
    // online: the system fixes the amount itself (the payment page can't be changed); by hand: it must match exactly
    if (!online && cents(amount) !== due) throw new HttpError(422, 'settlement_amount_mismatch', { expected: money(due), got: money(cents(amount)) });
    // a transfer number can be used once, by anyone (two drivers can't claim the same transfer)
    if (!online) {
      // …including the transaction number of a payment made online (it can't be claimed again by hand)
      const used = await t.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM settlements WHERE (LOWER(reference) = LOWER($1) OR LOWER(COALESCE(provider_ref, '')) = LOWER($1))
        AND (status IN ('pending','verified') OR provider_ref IS NOT NULL)`, [reference]);
      if (used.n) throw new HttpError(409, 'duplicate_settlement');
    }
    const s = online
      ? await t.one(`INSERT INTO settlements (driver_id, amount, method, reference, status, gateway, pay_token, expires_at) VALUES ($1,$2,$3,$4,'awaiting_payment',$5,$6,$7) RETURNING id`,
        [driverId, money(due), online.gateway, `${online.gateway.toUpperCase()}-${online.token.slice(0, 10)}`, online.gateway, online.token, online.expiresAt])
      : await t.one(`INSERT INTO settlements (driver_id, amount, method, reference, receipt_mime, receipt, sender_number) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [driverId, money(due), method, reference, receiptMime, receipt, senderNumber]);
    for (const e of pick) {
      // only entries still open move (a concurrent settlement can't take the same order twice)
      const moved = await t.query(`UPDATE driver_cash_entries SET status = 'in_settlement', settlement_id = $1, updated_at = $2 WHERE id = $3 AND status = 'open' RETURNING id`, [s.id, iso(), e.id]);
      if (!moved.length) throw new HttpError(409, 'order_already_settled');
      await t.query(`INSERT INTO settlement_allocations (settlement_id, entry_id, order_id, store_id, amount) VALUES ($1,$2,$3,$4,$5)`, [s.id, e.id, e.order_id, e.store_id, e.amount]);
    }
    await journal(t, { kind: online ? 'settlement_link_created' : 'settlement_submitted', driverId, settlementId: s.id, amount: money(due), method: online ? online.gateway : method });
    return { id: s.id, amount: money(due) };
  });
}

/** Breakdown of a settlement per restaurant, with the orders behind every amount. */
export async function settlementBreakdown(db, settlementId) {
  const rows = await db.query(`SELECT a.store_id, c.full_name AS store, a.order_id, a.amount, o.delivered_at, o.created_at, o.payment_method
    FROM settlement_allocations a JOIN cooks c ON c.id = a.store_id LEFT JOIN orders o ON o.id = a.order_id
    WHERE a.settlement_id = $1 AND a.active = 1 ORDER BY c.full_name, a.order_id`, [settlementId]);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.store_id)) map.set(r.store_id, { storeId: r.store_id, store: r.store, amount: 0, orders: [] });
    const g = map.get(r.store_id);
    g.amount += cents(r.amount);
    g.orders.push({ orderId: r.order_id, ref: `AKL${r.order_id}`, amount: Number(r.amount), deliveredAt: r.delivered_at, method: r.payment_method });
  }
  const stores = [...map.values()].map((g) => ({ ...g, amount: money(g.amount) }));
  return { stores, total: money(stores.reduce((a, g) => a + cents(g.amount), 0)) };
}

/** Zero-tolerance check, then each restaurant is credited its exact share, once. Runs inside a transaction. */
async function verifyIn(t, s, { adminId = null, auto = false } = {}) {
  const allocs = await t.query('SELECT entry_id, order_id, store_id, amount FROM settlement_allocations WHERE settlement_id = $1 AND active = 1', [s.id]);
  const sum = allocs.reduce((a, x) => a + cents(x.amount), 0);
  if (!allocs.length || sum !== cents(s.amount)) throw new HttpError(422, 'settlement_amount_mismatch', { expected: money(cents(s.amount)), allocated: money(sum) });
  const done = await t.query(`UPDATE settlements SET status = 'verified', decided_by = $1, decided_at = $2 WHERE id = $3 AND status = 'pending' RETURNING id`, [adminId, iso(), s.id]);
  if (!done.length) throw new HttpError(409, 'invalid_state');
  for (const a of allocs) {
    const r = await t.query(`UPDATE driver_cash_entries SET status = 'settled', updated_at = $1 WHERE id = $2 AND status = 'in_settlement' AND settlement_id = $3 RETURNING id`, [iso(), a.entry_id, s.id]);
    if (!r.length) throw new HttpError(409, 'order_already_settled');
  }
  const perStore = new Map();
  for (const a of allocs) perStore.set(a.store_id, (perStore.get(a.store_id) || 0) + cents(a.amount));
  for (const [storeId, c] of perStore) {
    await ledgerAdd(t, 'store', storeId, money(c), 'earning', { note: `cash settled by driver — settlement S-${s.id}` });
    await journal(t, { kind: 'settlement_paid_store', storeId, driverId: s.driver_id, settlementId: s.id, amount: money(c), method: s.method });
  }
  if (auto) await journal(t, { kind: 'settlement_auto_verified', driverId: s.driver_id, settlementId: s.id, amount: Number(s.amount), method: s.method });
  else await t.query('INSERT INTO admin_actions (admin_id, cook_id, action, details) VALUES ($1,$2,$3,$4)', [adminId, null, 'settlement_verify', JSON.stringify({ id: s.id, amount: Number(s.amount) })]);
  return { id: s.id, driverId: s.driver_id, stores: [...perStore.entries()].map(([storeId, c]) => ({ storeId, amount: money(c) })) };
}

/** Owner verifies a settlement sent by hand. */
export async function verifySettlement(db, settlementId, adminId) {
  return db.tx(async (t) => {
    const s = await t.one('SELECT * FROM settlements WHERE id = $1', [settlementId]);
    if (!s) throw new HttpError(404, 'not_found');
    if (s.status !== 'pending') throw new HttpError(409, 'invalid_state');
    return verifyIn(t, s, { adminId });
  });
}

/* ---------------- online settlements (Whish / OMT / card link, confirmed by the provider's signed callback) ---------------- */
async function releaseIn(t, s, status, note) {
  await t.query(`UPDATE settlements SET status = $1, note = COALESCE($2, note), decided_at = $3 WHERE id = $4`, [status, note || null, iso(), s.id]);
  await t.query(`UPDATE driver_cash_entries SET status = 'open', settlement_id = NULL, updated_at = $1 WHERE settlement_id = $2 AND status = 'in_settlement'`, [iso(), s.id]);
  await t.query('UPDATE settlement_allocations SET active = 0 WHERE settlement_id = $1', [s.id]);
  await journal(t, { kind: `settlement_${status}`, driverId: s.driver_id, settlementId: s.id, amount: Number(s.amount), note });
}

/** Unpaid links past their time (or a driver's older links when he makes a new one) give their orders back. */
export async function expireLinks(db, { driverId = null } = {}) {
  const now = iso();
  const rows = driverId
    ? await db.query(`SELECT * FROM settlements WHERE status = 'awaiting_payment' AND driver_id = $1`, [driverId])
    : await db.query(`SELECT * FROM settlements WHERE status = 'awaiting_payment' AND expires_at <= $1`, [now]);
  let n = 0;
  for (const s of rows) {
    if (!driverId && !(s.expires_at <= now)) continue;
    const ok = await db.tx(async (t) => {
      const r = await t.query(`UPDATE settlements SET status = 'expired' WHERE id = $1 AND status = 'awaiting_payment' RETURNING id`, [s.id]);
      if (!r.length) return false;
      await releaseIn(t, s, 'expired', null);
      return true;
    });
    if (ok) n += 1;
  }
  return n;
}

/**
 * The provider says a settlement link was paid. Exactly the fixed amount → verified automatically and the restaurants
 * credited. Any other amount, or a payment for orders already settled another way → NOT verified, held for the owner and
 * recorded as a violation. Returns { result, settlement, stores?, event? }.
 */
export async function confirmOnlineSettlement(db, { token, amount, currency = null, providerRef = null, payer = null }) {
  return db.tx(async (t) => {
    const s = await t.one('SELECT * FROM settlements WHERE pay_token = $1', [token]);
    if (!s) return { result: 'unknown' };
    if (s.status === 'verified') return { result: 'already', settlement: s };
    const paid = amount == null ? Number(s.amount) : Number(amount);
    await t.query('UPDATE settlements SET paid_amount = $1, provider_ref = $2, sender_number = COALESCE($3, sender_number) WHERE id = $4', [money(cents(paid)), providerRef, payer, s.id]);
    const wrongCurrency = currency && String(currency).toUpperCase() !== String(s.currency || 'USD').toUpperCase();
    if (cents(paid) !== cents(s.amount) || wrongCurrency) {
      if (s.status === 'awaiting_payment') await releaseIn(t, s, 'correction', `paid ${money(cents(paid))} ${currency || ''} ≠ ${Number(s.amount)}`);
      else await t.query(`UPDATE settlements SET status = 'correction', note = $1 WHERE id = $2 AND status <> 'verified'`, [`paid ${money(cents(paid))} ≠ ${Number(s.amount)}`, s.id]);
      return { result: 'mismatch', settlement: s, event: { kind: 'settle_amount_mismatch', severity: 'high', amount: money(cents(paid)), expected: Number(s.amount) } };
    }
    if (s.status === 'expired' || s.status === 'awaiting_payment') {
      if (s.status === 'expired') {
        // paid after the link's time: take its orders back if they are still unsettled (or only in another unpaid link of his)
        const allocs = await t.query('SELECT * FROM settlement_allocations WHERE settlement_id = $1', [s.id]);
        const ids = [...new Set(allocs.map((a) => a.entry_id))];
        const entries = ids.length ? await t.query(`SELECT e.id, e.status, e.settlement_id, x.status AS sstatus, x.driver_id AS sdriver FROM driver_cash_entries e
          LEFT JOIN settlements x ON x.id = e.settlement_id WHERE e.id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})`, ids) : [];
        const free = entries.length === ids.length && entries.every((e) => e.status === 'open' || (e.status === 'in_settlement' && e.sstatus === 'awaiting_payment' && e.sdriver === s.driver_id));
        if (!free) {
          await t.query(`UPDATE settlements SET status = 'correction', note = $1 WHERE id = $2`, ['paid after expiry — orders already settled another way (refund or keep as credit)', s.id]);
          return { result: 'paid_twice', settlement: s, event: { kind: 'settle_paid_twice', severity: 'high', amount: money(cents(paid)), expected: Number(s.amount) } };
        }
        for (const other of [...new Set(entries.filter((e) => e.status === 'in_settlement').map((e) => e.settlement_id))]) {
          const o = await t.one('SELECT * FROM settlements WHERE id = $1', [other]);
          await t.query(`UPDATE settlements SET status = 'expired' WHERE id = $1 AND status = 'awaiting_payment'`, [other]);
          await releaseIn(t, o, 'expired', `replaced by S-${s.id}`);
        }
        const groups = new Map();
        for (const a of allocs) if (!groups.has(a.entry_id)) groups.set(a.entry_id, a);
        for (const a of groups.values()) {
          const moved = await t.query(`UPDATE driver_cash_entries SET status = 'in_settlement', settlement_id = $1, updated_at = $2 WHERE id = $3 AND status = 'open' RETURNING id`, [s.id, iso(), a.entry_id]);
          if (!moved.length) throw new HttpError(409, 'order_already_settled');
          await t.query('UPDATE settlement_allocations SET active = 1 WHERE id = $1', [a.id]);
        }
      }
      await t.query(`UPDATE settlements SET status = 'pending' WHERE id = $1`, [s.id]);
      const r = await verifyIn(t, { ...s, status: 'pending' }, { auto: true });
      return { result: 'verified', settlement: s, stores: r.stores };
    }
    // paid while the owner had already rejected / corrected it: keep the money on record, the owner decides
    await t.query(`UPDATE settlements SET note = $1 WHERE id = $2`, [`paid online while ${s.status}`, s.id]);
    return { result: 'unexpected', settlement: s, event: { kind: 'settle_unexpected_payment', severity: 'high', amount: money(cents(paid)), expected: Number(s.amount) } };
  });
}

/** A failed / cancelled online payment: the link is closed and the orders are free to settle again. */
export async function failOnlineSettlement(db, token) {
  return db.tx(async (t) => {
    const s = await t.one(`SELECT * FROM settlements WHERE pay_token = $1`, [token]);
    if (!s) return null;
    const r = await t.query(`UPDATE settlements SET status = 'expired' WHERE id = $1 AND status = 'awaiting_payment' RETURNING id`, [s.id]);
    if (!r.length) return null;
    await releaseIn(t, s, 'expired', 'payment failed or cancelled');
    return s;
  });
}

/* ---------------- automatic payouts of the restaurants' shares ---------------- */
/**
 * After a settlement is verified, each restaurant's share leaves its balance as a payout to its Whish/OMT number.
 * Sent automatically when the payout keys are set; a failure (or no keys) stays "pending" in the owner's payouts list.
 * A restaurant without a receiving number keeps the money in its balance (shown in "restaurants owed").
 */
export async function payStoresFor(db, payments, settlementId, { enabled = true } = {}) {
  const out = [];
  if (!enabled) return out;
  const shares = await db.query(`SELECT a.store_id, SUM(a.amount) AS amount, c.payout_provider, c.payout_number FROM settlement_allocations a JOIN cooks c ON c.id = a.store_id
    WHERE a.settlement_id = $1 AND a.active = 1 GROUP BY a.store_id, c.payout_provider, c.payout_number`, [settlementId]);
  for (const sh of shares) {
    const amount = money(cents(sh.amount));
    if (!['whish', 'omt'].includes(sh.payout_provider) || !sh.payout_number) { out.push({ storeId: sh.store_id, amount, status: 'no_number' }); continue; }
    const w = await db.tx(async (t) => {
      const dup = await t.one(`SELECT id FROM withdrawals WHERE settlement_id = $1 AND account_type = 'store' AND account_id = $2`, [settlementId, sh.store_id]);
      if (dup) return null;
      if (cents(await balance(t, 'store', sh.store_id)) < cents(amount)) return null;
      const row = await t.one(`INSERT INTO withdrawals (account_type, account_id, amount, provider, number, settlement_id) VALUES ('store',$1,$2,$3,$4,$5) RETURNING id`,
        [sh.store_id, amount, sh.payout_provider, sh.payout_number, settlementId]);
      await ledgerAdd(t, 'store', sh.store_id, -amount, 'payout', { note: `settlement S-${settlementId} → ${sh.payout_provider} ${sh.payout_number} (#${row.id})` });
      await journal(t, { kind: 'store_payout_created', storeId: sh.store_id, settlementId, amount, note: `withdrawal #${row.id}` });
      return row;
    });
    if (!w) { out.push({ storeId: sh.store_id, amount, status: 'skipped' }); continue; }
    if (!payments?.payOutOn?.(sh.payout_provider)) { out.push({ storeId: sh.store_id, amount, status: 'manual', withdrawalId: w.id }); continue; }
    const r = await payments.payout({ reference: `W${w.id}`, amount, provider: sh.payout_provider, number: sh.payout_number });
    if (r.ok) {
      await db.query(`UPDATE withdrawals SET status = 'paid', decided_at = $1, auto_ref = $2 WHERE id = $3 AND status = 'pending'`, [iso(), String(r.id || 'auto'), w.id]);
      out.push({ storeId: sh.store_id, amount, status: 'paid', withdrawalId: w.id, provider: sh.payout_provider });
    } else {
      await db.query('UPDATE withdrawals SET last_error = $1 WHERE id = $2', [String(r.error || 'refused').slice(0, 200), w.id]);
      out.push({ storeId: sh.store_id, amount, status: 'failed', withdrawalId: w.id, error: r.error || 'refused' });
    }
  }
  return out;
}

/* ---------------- automatic card refunds ---------------- */
/** Paid card orders marked "to refund" are refunded through the gateway (5 tries); returns the orders refunded now. */
export async function autoRefunds(db, payments, { orderId = null } = {}) {
  const done = [];
  if (!payments?.refundEnabled) return done;
  const rows = await db.query(`SELECT p.id, p.order_id, p.token, p.amount, p.currency, p.provider_ref, o.customer_id FROM order_payments p JOIN orders o ON o.id = p.order_id
    WHERE p.status = 'refund_pending' AND COALESCE(p.refund_tries, 0) < 5 ${orderId ? 'AND p.order_id = $1' : ''} ORDER BY p.id LIMIT 50`, orderId ? [orderId] : []);
  for (const p of rows) {
    const r = await payments.refund({ reference: p.token, amount: Number(p.amount), currency: p.currency || 'USD', providerRef: p.provider_ref });
    if (r.ok) {
      const ok = await db.tx(async (t) => {
        const x = await t.query(`UPDATE order_payments SET status = 'refunded', updated_at = $1, refund_error = NULL WHERE id = $2 AND status = 'refund_pending' RETURNING id`, [iso(), p.id]);
        if (!x.length) return false;
        await t.query(`UPDATE orders SET payment_status = 'refunded' WHERE id = $1`, [p.order_id]);
        await journal(t, { kind: 'card_refunded', orderId: p.order_id, paymentId: p.id, amount: -Number(p.amount), method: 'card', note: `automatic ${r.id || ''}`.trim() });
        return true;
      });
      if (ok) done.push({ orderId: p.order_id, customerId: p.customer_id, amount: Number(p.amount), failed: false });
    } else if (!r.skipped) {
      const x = await db.one(`UPDATE order_payments SET refund_tries = COALESCE(refund_tries, 0) + 1, refund_error = $1 WHERE id = $2 RETURNING refund_tries`, [String(r.error || 'refused').slice(0, 200), p.id]);
      if (Number(x?.refund_tries) >= 5) done.push({ orderId: p.order_id, customerId: p.customer_id, amount: Number(p.amount), failed: true });
    }
  }
  return done;
}

/* ---------------- violations the owner sees ---------------- */
export async function securityEvent(db, e) {
  try {
    if (e.dedupeMin) {   // the same thing again shortly after: recorded once
      const since = new Date(Date.now() - e.dedupeMin * 60_000).toISOString();
      const x = await db.one(`SELECT id FROM security_events WHERE kind = $1 AND COALESCE(driver_id, 0) = $2 AND COALESCE(ip_hash, '') = $3 AND created_at >= $4`,
        [e.kind, e.driverId || 0, e.ipHash || '', since]);
      if (x) return null;
    }
    return await db.one(`INSERT INTO security_events (kind, severity, driver_id, store_id, settlement_id, amount, expected, detail, ip_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [e.kind, e.severity || 'warn', e.driverId ?? null, e.storeId ?? null, e.settlementId ?? null, e.amount ?? null, e.expected ?? null, e.detail ? String(e.detail).slice(0, 400) : null, e.ipHash ?? null]);
  } catch { return null; }   // never blocks the money flow
}

/** Reject or ask for a correction: the orders go back to "open" (they can be settled again), history is kept. */
export async function releaseSettlement(db, settlementId, adminId, status, note) {
  return db.tx(async (t) => {
    const r = await t.query(`UPDATE settlements SET status = $1, note = $2, decided_by = $3, decided_at = $4 WHERE id = $5 AND status = 'pending' RETURNING id, driver_id, amount`,
      [status, note || null, adminId, iso(), settlementId]);
    if (!r.length) throw new HttpError(409, 'invalid_state');
    await t.query(`UPDATE driver_cash_entries SET status = 'open', settlement_id = NULL, updated_at = $1 WHERE settlement_id = $2 AND status = 'in_settlement'`, [iso(), settlementId]);
    await t.query('UPDATE settlement_allocations SET active = 0 WHERE settlement_id = $1', [settlementId]);
    await journal(t, { kind: `settlement_${status}`, driverId: r[0].driver_id, settlementId, amount: r[0].amount, note });
    await t.query('INSERT INTO admin_actions (admin_id, cook_id, action, details) VALUES ($1,$2,$3,$4)', [adminId, null, `settlement_${status}`, JSON.stringify({ id: settlementId, note })]);
    return true;
  });
}

/** A restaurant's own money picture: sales by method, cash still with drivers (per driver), settled. */
export async function storeFinance(db, cookId) {
  const sales = await db.one(`SELECT COALESCE(SUM(total), 0) AS food,
      COALESCE(SUM(CASE WHEN payment_method = 'card' THEN total ELSE 0 END), 0) AS card,
      COALESCE(SUM(CASE WHEN payment_method = 'cash' AND self_delivery = 0 AND driver_id IS NOT NULL THEN total ELSE 0 END), 0) AS cash_drivers,
      COALESCE(SUM(CASE WHEN payment_method = 'cash' AND (self_delivery = 1 OR driver_id IS NULL) THEN total ELSE 0 END), 0) AS cash_direct
    FROM orders WHERE cook_id = $1 AND customer_total IS NOT NULL AND financial_status IN ('completed')`, [cookId]);
  const ent = await db.one(`SELECT COALESCE(SUM(CASE WHEN status IN ('open','in_settlement') THEN amount ELSE 0 END), 0) AS outstanding,
      COALESCE(SUM(CASE WHEN status = 'settled' THEN amount ELSE 0 END), 0) AS settled FROM driver_cash_entries WHERE store_id = $1`, [cookId]);
  const drivers = await db.query(`SELECT e.driver_id, d.full_name AS driver, d.phone, COALESCE(SUM(e.amount), 0) AS owes, CAST(COUNT(*) AS INTEGER) AS orders
    FROM driver_cash_entries e JOIN drivers d ON d.id = e.driver_id WHERE e.store_id = $1 AND e.status IN ('open','in_settlement')
    GROUP BY e.driver_id, d.full_name, d.phone ORDER BY SUM(e.amount) DESC`, [cookId]);
  return {
    foodSales: money(cents(sales.food)), cardSales: money(cents(sales.card)), cashByDrivers: money(cents(sales.cash_drivers)), cashDirect: money(cents(sales.cash_direct)),
    outstandingWithDrivers: money(cents(ent.outstanding)), settled: money(cents(ent.settled)), balance: await balance(db, 'store', cookId),
    drivers: drivers.map((d) => ({ driverId: d.driver_id, driver: d.driver, phone: d.phone, owes: money(cents(d.owes)), orders: d.orders })),
  };
}
export async function storeDriverOrders(db, cookId, driverId) {
  return (await db.query(`SELECT e.order_id, e.amount, e.status, e.settlement_id, e.created_at, o.payment_method, o.delivered_at
    FROM driver_cash_entries e LEFT JOIN orders o ON o.id = e.order_id WHERE e.store_id = $1 AND e.driver_id = $2 ORDER BY e.id DESC LIMIT 500`, [cookId, driverId]))
    .map((r) => ({ orderId: r.order_id, ref: `AKL${r.order_id}`, amount: Number(r.amount), method: r.payment_method, status: r.status, settlementId: r.settlement_id ? `S-${r.settlement_id}` : null, date: r.delivered_at || r.created_at }));
}

/** Owner: refund / reverse an order (never deletes history; writes reversal entries). */
export async function reverseOrder(db, orderId, { includeFee = true, adminId, reason } = {}) {
  return db.tx(async (t) => {
    const o = await t.one('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (!o) throw new HttpError(404, 'not_found');
    if (o.financial_status === 'reversed') throw new HttpError(409, 'already_reversed');
    const food = Number(o.total), fee = Number(o.delivery_fee || 0);
    const base = { orderId: o.id, storeId: o.cook_id, driverId: o.driver_id, method: o.payment_method, currency: o.currency || 'USD', note: reason };
    if (o.financial_status === 'completed') {
      if (o.payment_method === 'card') {
        const storeGot = food + (Number(o.self_delivery) || !o.driver_id ? fee : 0);
        await ledgerAdd(t, 'store', o.cook_id, -storeGot, 'adjust', { orderId: o.id, note: `refund #${o.id}` });
        await journal(t, { ...base, kind: 'reversal_store', amount: -storeGot });
        if (includeFee && o.driver_id && !Number(o.self_delivery)) {
          await ledgerAdd(t, 'driver', o.driver_id, -fee, 'adjust', { orderId: o.id, note: `refund #${o.id}` });
          await journal(t, { ...base, kind: 'reversal_driver_fee', amount: -fee });
        }
      } else {
        const e = await t.one('SELECT id, status FROM driver_cash_entries WHERE order_id = $1', [o.id]);
        if (e?.status === 'in_settlement') throw new HttpError(409, 'in_settlement');
        if (e?.status === 'open') { await t.query(`UPDATE driver_cash_entries SET status = 'reversed', updated_at = $1 WHERE id = $2`, [iso(), e.id]); await journal(t, { ...base, kind: 'reversal_cash_payable', amount: -food }); }
        if (e?.status === 'settled') { await ledgerAdd(t, 'store', o.cook_id, -food, 'adjust', { orderId: o.id, note: `refund #${o.id}` }); await journal(t, { ...base, kind: 'reversal_store', amount: -food }); }
      }
      if (includeFee) await t.query('UPDATE driver_earnings SET reversed = 1 WHERE order_id = $1', [o.id]);
    }
    const payStatus = o.payment_method === 'card' && ['paid'].includes(o.payment_status) ? 'refund_pending' : o.payment_status;
    await t.query(`UPDATE orders SET financial_status = 'reversed', payment_status = $1, cancel_note = COALESCE($2, cancel_note) WHERE id = $3`, [payStatus, reason || null, o.id]);
    if (payStatus === 'refund_pending') await t.query(`UPDATE order_payments SET status = 'refund_pending', updated_at = $1 WHERE order_id = $2 AND status = 'paid'`, [iso(), o.id]);
    if (adminId) await t.query('INSERT INTO admin_actions (admin_id, cook_id, action, details) VALUES ($1,$2,$3,$4)', [adminId, o.cook_id, 'order_reverse', JSON.stringify({ orderId: o.id, includeFee, reason })]);
    return { refundPending: payStatus === 'refund_pending' };
  });
}

/** Owner's financial center totals. */
export async function financeOverview(db) {
  const held = await db.one(`SELECT COALESCE(SUM(amount), 0) AS s FROM driver_cash_entries WHERE status IN ('open','in_settlement')`);
  const pend = await db.one(`SELECT COALESCE(SUM(amount), 0) AS s, CAST(COUNT(*) AS INTEGER) AS n FROM settlements WHERE status = 'pending'`);
  const ver = await db.one(`SELECT COALESCE(SUM(amount), 0) AS s FROM settlements WHERE status = 'verified'`);
  const earn = await db.one(`SELECT COALESCE(SUM(fee + bonus), 0) AS s FROM driver_earnings WHERE reversed = 0`);
  const card = await db.one(`SELECT COALESCE(SUM(customer_total), 0) AS s FROM orders WHERE payment_method = 'card' AND payment_status = 'paid'`);
  const sec = await db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM security_events WHERE seen = 0`);
  const fail = await db.one(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM withdrawals WHERE status = 'pending' AND settlement_id IS NOT NULL`);
  return { cashHeldByDrivers: money(cents(held.s)), pendingSettlements: money(cents(pend.s)), pendingCount: pend.n, verifiedSettlements: money(cents(ver.s)), driverEarnings: money(cents(earn.s)), cardCollected: money(cents(card.s)), violations: sec.n, storePayoutsWaiting: fail.n };
}
