// Phone notifications (Web Push, RFC 8291 + VAPID RFC 8292) with node:crypto only — no outside package.
// They reach Android phones even when the app/site is closed (the phone's push service wakes the service worker).
// Keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars, or generated once and kept in the database (so backups carry them).
import { createECDH, createHmac, createCipheriv, randomBytes, createPrivateKey, sign as cryptoSign } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

export function generateVapid() {
  const e = createECDH('prime256v1');
  e.generateKeys();
  return { publicKey: b64u(e.getPublicKey()), privateKey: b64u(e.getPrivateKey()) };
}

function vapidHeader(endpoint, keys, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const pub = fromB64u(keys.publicKey);
  const key = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: keys.privateKey }, format: 'jwk' });
  const sig = cryptoSign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${keys.publicKey}`;
}

/** aes128gcm body for one subscription (exported for tests). */
export function encryptPayload(subscription, text, { salt = randomBytes(16), local = null } = {}) {
  const uaPublic = fromB64u(subscription.p256dh);
  const authSecret = fromB64u(subscription.auth);
  const ecdh = local || createECDH('prime256v1');
  if (!local) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

export function createPush({ db, env = process.env, fetchImpl = globalThis.fetch, log = console } = {}) {
  let keys = env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY } : null;
  const subject = env.VAPID_SUBJECT || 'mailto:admin@aklatak.app';
  async function getKeys() {
    if (keys) return keys;
    const row = await db.one(`SELECT value FROM app_meta WHERE key = 'vapid'`);
    if (row) { try { keys = JSON.parse(row.value); return keys; } catch { /* regenerate */ } }
    const k = generateVapid();
    await db.query(`INSERT INTO app_meta (key, value) VALUES ('vapid', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(k)]);
    const again = await db.one(`SELECT value FROM app_meta WHERE key = 'vapid'`);
    keys = JSON.parse(again.value);
    return keys;
  }
  async function sendOne(sub, message) {
    const k = await getKeys();
    const body = encryptPayload(sub, JSON.stringify(message));
    const r = await fetchImpl(sub.endpoint, {
      method: 'POST',
      headers: { Authorization: vapidHeader(sub.endpoint, k, subject), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'high' },
      body,
    });
    if (r.status === 404 || r.status === 410) await db.query('DELETE FROM push_targets WHERE endpoint = $1', [sub.endpoint]);   // phone unsubscribed
    return r.status;
  }
  return {
    publicKey: async () => (await getKeys()).publicKey,
    async subscribe(ownerType, ownerId, sub) {
      // the same phone may belong to several accounts (customer + store + admin): one row per account
      await db.query('DELETE FROM push_targets WHERE owner_type = $1 AND owner_id = $2 AND endpoint = $3', [ownerType, ownerId, sub.endpoint]);
      await db.query('INSERT INTO push_targets (owner_type, owner_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4,$5)', [ownerType, ownerId, sub.endpoint, sub.p256dh, sub.auth]);
      const n = await db.query('SELECT id FROM push_targets WHERE owner_type = $1 AND owner_id = $2 ORDER BY id DESC', [ownerType, ownerId]);
      for (const old of n.slice(5)) await db.query('DELETE FROM push_targets WHERE id = $1', [old.id]);   // 5 phones max
    },
    /** Every admin/owner account (new money requests, new drivers, complaints …). */
    notifyAdmins(message) {
      (async () => {
        const subs = await db.query(`SELECT id, endpoint, p256dh, auth FROM push_targets WHERE owner_type = 'admin'`);
        for (const s of subs) await sendOne(s, message).catch((e) => log.warn?.('[push]', e.message));
      })().catch(() => {});
    },
    /** Fire and forget: never slows down or breaks the request that caused it. */
    notify(ownerType, ownerId, message) {
      if (!ownerId) return;
      (async () => {
        const subs = await db.query('SELECT id, endpoint, p256dh, auth FROM push_targets WHERE owner_type = $1 AND owner_id = $2', [ownerType, ownerId]);
        for (const s of subs) await sendOne(s, message).catch((e) => log.warn?.('[push]', e.message));
      })().catch(() => {});
    },
  };
}
