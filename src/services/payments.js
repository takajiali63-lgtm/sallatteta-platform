// Online money — ready, switched on by keys in Render. Until then everything works by hand (receipt → the owner approves).
//
// Three gateways can be connected, each with its own keys (any of them may be missing):
//   "card"  — a card / online gateway   PAY_CHECKOUT_URL, PAY_API_KEY, PAY_WEBHOOK_SECRET          callback: /api/pay/webhook
//   "whish" — Whish Pay (merchant)      WHISH_PAY_URL, WHISH_PAY_KEY, WHISH_PAY_SECRET              callback: /api/pay/webhook/whish
//   "omt"   — OMT Pay (merchant)        OMT_PAY_URL, OMT_PAY_KEY, OMT_PAY_SECRET                    callback: /api/pay/webhook/omt
//
// 1) PAY-IN (a customer pays a card order, a store renews, a DRIVER PAYS HIS SETTLEMENT)
//    We send:    { reference, amount, currency, description, successUrl, cancelUrl, callbackUrl }   (Authorization: Bearer <key>)
//    We expect:  { url }  — the provider's page, where the amount is FIXED (the payer can't change it)
//    Callback:   { reference, status: "paid" | "failed", amount, currency, id, eventId? }  signed: header X-Signature =
//                hex HMAC-SHA256 of the raw body with the gateway's secret. Applied exactly once.
//
//    REFUND (optional, PAY_REFUND_URL): { reference, amount, currency, paymentId } → { ok: true, id } — a paid order that the
//    store refused / cancelled is refunded to the customer automatically; otherwise it waits in the owner's refunds list.
//
// 2) PAY-OUT (money sent automatically to a Whish / OMT number: withdrawals and restaurants' shares of settlements)
//    WHISH_PAYOUT_URL/KEY and OMT_PAYOUT_URL/KEY (or one PAYOUT_API_URL/KEY for both)
//    We send:    { reference, amount, currency, provider: "whish"|"omt", number }
//    We expect:  { ok: true, id }  → marked paid automatically; anything else → it waits for the owner ("needs review").
//
// Each provider names these fields its own way: when Whish/OMT give their API documents, only the small "shape"
// functions below change — nothing else in the app.
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const shapeCheckout = (gateway, p) => p;              // ← adapt to each provider's field names
const readCheckout = (gateway, j) => ({ url: j?.url || j?.checkout_url || j?.redirect_url || j?.collectUrl || null });
const shapePayout = (provider, p) => p;               // ← adapt to each provider's field names
const shapeRefund = (p) => p;                        // ← adapt to the card gateway's refund fields
const readRefund = (j) => ({ ok: j?.ok === true || ['refunded', 'success', 'succeeded'].includes(j?.status), id: j?.id || j?.refund_id || null });
const readPayout = (provider, j) => ({ ok: j?.ok === true || j?.status === 'success' || j?.status === 'paid', id: j?.id || j?.reference || null });

export const GATEWAYS = ['card', 'whish', 'omt'];

export function createPayments({ env = process.env, fetchImpl = fetch, log = console } = {}) {
  const gw = {
    card: { url: env.PAY_CHECKOUT_URL || '', key: env.PAY_API_KEY || '', secret: env.PAY_WEBHOOK_SECRET || '', refund: env.PAY_REFUND_URL || '' },
    whish: { url: env.WHISH_PAY_URL || '', key: env.WHISH_PAY_KEY || '', secret: env.WHISH_PAY_SECRET || '' },
    omt: { url: env.OMT_PAY_URL || '', key: env.OMT_PAY_KEY || '', secret: env.OMT_PAY_SECRET || '' },
  };
  const out = {
    whish: { url: env.WHISH_PAYOUT_URL || env.PAYOUT_API_URL || '', key: env.WHISH_PAYOUT_KEY || env.PAYOUT_API_KEY || '' },
    omt: { url: env.OMT_PAYOUT_URL || env.PAYOUT_API_URL || '', key: env.OMT_PAYOUT_KEY || env.PAYOUT_API_KEY || '' },
  };
  const on = (g) => !!(gw[g]?.url && gw[g]?.key && gw[g]?.secret);
  const outOn = (p) => !!(out[p]?.url && out[p]?.key);
  const post = async (url, key, body, timeoutMs = 15_000) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return j;
    } finally { clearTimeout(timer); }
  };
  return {
    /** The card gateway (customer card orders, store renewals). */
    payInEnabled: on('card'),
    /** Any Whish / OMT payout connected. */
    payOutEnabled: outOn('whish') || outOn('omt'),
    gatewayOn: on,
    payOutOn: outOn,
    /** Gateways a driver can pay a settlement with, online. */
    settleGateways: () => GATEWAYS.filter(on),
    /** Card payments of refused / cancelled orders sent back to the customer automatically (PAY_REFUND_URL). */
    refundEnabled: on('card') && !!gw.card.refund,
    newToken: () => randomBytes(12).toString('hex'),
    async refund({ reference, amount, currency = 'USD', providerRef = null }) {
      if (!(on('card') && gw.card.refund)) return { ok: false, skipped: true };
      try { return readRefund(await post(gw.card.refund, gw.card.key, shapeRefund({ reference, amount, currency, paymentId: providerRef }))); }
      catch (e) { log.warn?.(`[refund] ${reference}: ${e.message} — left for the owner`); return { ok: false, error: e.message }; }
    },
    async checkout({ reference, amount, currency = 'USD', description, baseUrl, successPath = null, cancelPath = null, gateway = 'card' }) {
      if (!on(gateway)) throw new Error(`payment gateway ${gateway} is off`);
      const g = gw[gateway];
      const j = await post(g.url, g.key, shapeCheckout(gateway, {
        reference, amount, currency, description,
        successUrl: `${baseUrl}${successPath || `/store?paid=${reference}`}`, cancelUrl: `${baseUrl}${cancelPath || '/store?paid=cancel'}`,
        callbackUrl: `${baseUrl}/api/pay/webhook${gateway === 'card' ? '' : `/${gateway}`}`,
      }));
      const r = readCheckout(gateway, j);
      if (!r.url || !/^https:\/\//.test(r.url)) throw new Error('payment gateway: no checkout url');
      return r;
    },
    /** True only for a callback really signed by that gateway. */
    verify(rawBody, signature, gateway = 'card') {
      const secret = gw[gateway]?.secret;
      if (!secret || !signature) return false;
      const want = createHmac('sha256', secret).update(rawBody).digest();
      let got;
      try { got = Buffer.from(String(signature).replace(/^sha256=/, ''), 'hex'); } catch { return false; }
      return got.length === want.length && timingSafeEqual(got, want);
    },
    async payout({ reference, amount, currency = 'USD', provider, number }) {
      if (!outOn(provider)) return { ok: false, skipped: true };
      try {
        return readPayout(provider, await post(out[provider].url, out[provider].key, shapePayout(provider, { reference, amount, currency, provider, number })));
      } catch (e) {
        log.warn?.(`[payout] ${reference}: ${e.message} — left for the owner to pay by hand`);
        return { ok: false, error: e.message };
      }
    },
  };
}
