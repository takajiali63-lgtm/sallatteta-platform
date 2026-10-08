import { scrypt as scryptCb, randomBytes, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(String(password), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [algo, n, r, p, saltB64, keyB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scrypt(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: +n, r: +r, p: +p });
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
export const hmacHex = (secret, s) => createHmac('sha256', secret).update(String(s)).digest('hex').slice(0, 32);

export function clientIp(req, trustProxy) {
  const hops = trustProxy === true ? 1 : Number(trustProxy) || 0;
  if (hops > 0) {
    // Each trusted proxy appends the address it saw. The client can forge entries on the LEFT,
    // so we count `hops` entries from the RIGHT.
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (parts.length >= hops) return parts[parts.length - hops];
    if (parts.length) return parts[0];
  }
  return req.socket.remoteAddress || 'unknown';
}

