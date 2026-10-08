// Passkeys (WebAuthn) for the admin panel — sign in with Face ID / fingerprint, no codes to copy.
// Verification follows the W3C WebAuthn spec: challenge, origin, RP ID hash, user presence & verification,
// signature over authenticatorData || SHA-256(clientDataJSON), and the signature counter.
import { createHash, createPublicKey, verify as cryptoVerify, randomBytes } from 'node:crypto';
import { decodeCbor } from './cbor.js';

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64url = (s) => Buffer.from(String(s || ''), 'base64url');
const sha256 = (b) => createHash('sha256').update(b).digest();

export const newChallenge = () => b64url(randomBytes(32));

/** RP ID = the site's host name (no port). Origin = scheme://host[:port] the browser reports. */
export function rpFromRequest(req, cfg) {
  const base = cfg.publicBaseUrl || `${String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const u = new URL(base);
  return { rpId: u.hostname, origin: u.origin };
}

function parseAuthData(buf) {
  if (buf.length < 37) throw new Error('authData too short');
  const rpIdHash = buf.subarray(0, 32);
  const flags = buf[32];
  const signCount = buf.readUInt32BE(33);
  const out = { rpIdHash, flags, signCount, up: !!(flags & 0x01), uv: !!(flags & 0x04), at: !!(flags & 0x40) };
  if (out.at) {
    let p = 37;
    out.aaguid = buf.subarray(p, p + 16); p += 16;
    const len = buf.readUInt16BE(p); p += 2;
    out.credentialId = buf.subarray(p, p + len); p += len;
    const { value, length } = decodeCbor(buf.subarray(p));
    out.cosePublicKey = value;
    p += length;
  }
  return out;
}

/** COSE key → JWK (ES256 P-256, or RS256). */
function coseToJwk(cose) {
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (kty === 2 && cose.get(-1) === 1) {
    return { jwk: { kty: 'EC', crv: 'P-256', x: b64url(cose.get(-2)), y: b64url(cose.get(-3)) }, alg: alg ?? -7 };
  }
  if (kty === 3) return { jwk: { kty: 'RSA', n: b64url(cose.get(-1)), e: b64url(cose.get(-2)) }, alg: alg ?? -257 };
  throw new Error('unsupported key type');
}

function checkClientData(clientDataJSON, { type, challenge, origin }) {
  const cd = JSON.parse(Buffer.from(clientDataJSON).toString('utf8'));
  if (cd.type !== type) throw new Error('wrong type');
  if (cd.challenge !== challenge) throw new Error('wrong challenge');
  if (cd.origin !== origin) throw new Error(`wrong origin ${cd.origin}`);
  return cd;
}

/** Registration: returns { credentialId, publicKeyJwk, alg, signCount } to store. */
export function verifyRegistration(credential, { challenge, origin, rpId }) {
  const clientDataJSON = fromB64url(credential?.response?.clientDataJSON);
  checkClientData(clientDataJSON, { type: 'webauthn.create', challenge, origin });
  const att = decodeCbor(fromB64url(credential.response.attestationObject)).value;
  const authData = parseAuthData(att.get('authData'));
  if (!authData.rpIdHash.equals(sha256(Buffer.from(rpId)))) throw new Error('wrong rp id');
  if (!authData.up || !authData.uv) throw new Error('user not verified');
  if (!authData.credentialId) throw new Error('no credential');
  const { jwk, alg } = coseToJwk(authData.cosePublicKey);
  createPublicKey({ key: jwk, format: 'jwk' }); // throws if the key is invalid
  return { credentialId: b64url(authData.credentialId), publicKeyJwk: jwk, alg, signCount: authData.signCount };
}

/** Login: verifies the signature; returns the new signature counter. */
export function verifyAssertion(credential, stored, { challenge, origin, rpId }) {
  const clientDataJSON = fromB64url(credential?.response?.clientDataJSON);
  checkClientData(clientDataJSON, { type: 'webauthn.get', challenge, origin });
  const authDataBuf = fromB64url(credential.response.authenticatorData);
  const authData = parseAuthData(authDataBuf);
  if (!authData.rpIdHash.equals(sha256(Buffer.from(rpId)))) throw new Error('wrong rp id');
  if (!authData.up || !authData.uv) throw new Error('user not verified');
  const signed = Buffer.concat([authDataBuf, sha256(clientDataJSON)]);
  const key = createPublicKey({ key: stored.publicKeyJwk, format: 'jwk' });
  const sig = fromB64url(credential.response.signature);
  const ok = stored.alg === -257
    ? cryptoVerify('RSA-SHA256', signed, key, sig)
    : cryptoVerify('sha256', signed, { key, dsaEncoding: 'der' }, sig);
  if (!ok) throw new Error('bad signature');
  // Cloned-key protection: counters must increase (0 means the authenticator doesn't count, e.g. synced passkeys).
  if (authData.signCount !== 0 && stored.signCount !== 0 && authData.signCount <= stored.signCount) throw new Error('counter did not increase');
  return { signCount: authData.signCount };
}
