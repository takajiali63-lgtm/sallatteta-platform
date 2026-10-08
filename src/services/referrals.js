// Referral links: /join?ref=CODE. A subscriber who joins through a link is tied to its owner, who earns the commission
// set by the admin on EVERY paid activation or renewal (free trials never count). Paid out weekly/monthly by the owner.
import { randomBytes } from 'node:crypto';

export const newCode = () => randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8);

/** The active referrer for a code, allowed for this country (a country agent's links work in his country only). */
export async function referrerFor(db, code, country) {
  if (!/^[A-Za-z0-9]{6,12}$/.test(String(code || ''))) return null;
  const r = await db.one('SELECT id, country FROM referrers WHERE code = $1 AND is_active = 1', [String(code)]);
  if (!r) return null;
  if (r.country && country && String(r.country).toUpperCase() !== String(country).toUpperCase()) return null;
  return r;
}

/** Record the commission for a paid activation/renewal of a subscriber brought by a link. */
export async function creditReferral(db, cookId, reason) {
  const c = await db.one('SELECT c.full_name, c.referrer_id, r.commission, r.currency, r.is_active FROM cooks c JOIN referrers r ON r.id = c.referrer_id WHERE c.id = $1', [cookId]);
  if (!c || !Number(c.is_active) || !(Number(c.commission) > 0)) return null;
  await db.query('INSERT INTO referral_earnings (referrer_id, cook_id, cook_name, reason, amount, currency) VALUES ($1,$2,$3,$4,$5,$6)',
    [c.referrer_id, cookId, c.full_name, reason, Number(c.commission), c.currency]);
  return Number(c.commission);
}
