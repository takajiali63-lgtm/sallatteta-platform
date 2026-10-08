// Admin passkeys (WebAuthn) with a simulated phone authenticator: real P-256 keys and signatures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign as cryptoSign, randomBytes } from 'node:crypto';
import { createApp } from '../src/server.js';
import { decodeCbor } from '../src/lib/cbor.js';

let app, base, rpId, origin;
const sha = (b) => createHash('sha256').update(b).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');

// --- tiny CBOR encoder for the fake authenticator ---
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
}
function enc(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [enc(k), enc(x)])]);
  throw new Error('enc');
}

function phone() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = randomBytes(16);
  let counter = 0;
  return {
    credId: b64u(credId),
    register(challenge) {
      const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([sha(Buffer.from(rpId)), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, credId, enc(cose)]);
      const att = enc(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      const cd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin }));
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(cd), attestationObject: b64u(att) } };
    },
    assert(challenge, { originOverride, tamper } = {}) {
      counter += 1;
      const cnt = Buffer.alloc(4); cnt.writeUInt32BE(counter);
      const authData = Buffer.concat([sha(Buffer.from(rpId)), Buffer.from([0x05]), cnt]);
      const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: originOverride || origin }));
      let sig = cryptoSign('sha256', Buffer.concat([authData, sha(cd)]), privateKey);
      if (tamper) sig = Buffer.from(sig.map((x, i) => (i === 10 ? x ^ 1 : x)));
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(sig) } };
    },
  };
}

async function call(m, p, body, cookie) {
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null), headers: r.headers };
}
const login = () => call('POST', '/api/admin/login', { username: 'admin', password: 'correct-horse-battery' });

before(async () => {
  app = await createApp({ databaseUrl: 'sqlite::memory:', sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999',
    bootstrapAdmin: { username: 'admin', password: 'correct-horse-battery' }, loginLimit: 1e4, placesFetcher: async () => [] });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  rpId = '127.0.0.1'; origin = base;
});
after(async () => { await app.close(); });

test('CBOR decoder reads maps, byte strings and negative keys', () => {
  const v = decodeCbor(enc(new Map([[1, 2], [-2, Buffer.from([1, 2, 3])], ['fmt', 'none']]))).value;
  assert.equal(v.get(1), 2);
  assert.deepEqual([...v.get(-2)], [1, 2, 3]);
  assert.equal(v.get('fmt'), 'none');
});

test('passkey sign-in end to end: register → require → login with Face ID; backup codes; protections', async () => {
  const ck = (await login()).headers.get('set-cookie').split(';')[0];
  const ph = phone();
  // register
  const opts = (await call('POST', '/api/admin/passkeys/options', {}, ck)).data;
  assert.equal(opts.rp.id, '127.0.0.1');
  assert.equal(opts.authenticatorSelection.userVerification, 'required');
  assert.equal((await call('POST', '/api/admin/passkeys', { credential: ph.register(opts.challenge), name: 'iPhone Ali' }, ck)).status, 201);
  // a registration with a stale challenge is refused
  assert.equal((await call('POST', '/api/admin/passkeys', { credential: ph.register('old-challenge') }, ck)).status, 400);
  // cannot require passkeys before having backup codes (no lock-out)
  assert.equal((await call('POST', '/api/admin/mfa', { required: true }, ck)).status, 409);
  const codes = (await call('POST', '/api/admin/backup-codes', {}, ck)).data.codes;
  assert.equal(codes.length, 10);
  assert.equal((await call('POST', '/api/admin/mfa', { required: true }, ck)).status, 200);

  // password alone no longer opens the panel
  const step1 = await login();
  assert.equal(step1.data.mfa, true);
  assert.equal(step1.headers.get('set-cookie'), null);
  assert.deepEqual(step1.data.options.allowCredentials.map((c) => c.id), [ph.credId]);
  // forged signature / wrong site are refused
  assert.equal((await call('POST', '/api/admin/login/passkey', { token: step1.data.token, credential: ph.assert(step1.data.options.challenge, { tamper: true }) })).status, 401);
  const s1b = await login();
  assert.equal((await call('POST', '/api/admin/login/passkey', { token: s1b.data.token, credential: ph.assert(s1b.data.options.challenge, { originOverride: 'https://evil.example' }) })).status, 401);
  // the real thing
  const s2 = await login();
  const ok = await call('POST', '/api/admin/login/passkey', { token: s2.data.token, credential: ph.assert(s2.data.options.challenge) });
  assert.equal(ok.status, 200);
  const ck2 = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/api/admin/me', null, ck2)).status, 200);
  // a token works once (no replay)
  assert.equal((await call('POST', '/api/admin/login/passkey', { token: s2.data.token, credential: ph.assert(s2.data.options.challenge) })).status, 401);

  // backup code: works once
  const s3 = await login();
  const viaCode = await call('POST', '/api/admin/login/backup', { token: s3.data.token, code: codes[0] });
  assert.equal(viaCode.status, 200);
  const s4 = await login();
  assert.equal((await call('POST', '/api/admin/login/backup', { token: s4.data.token, code: codes[0] })).status, 401);
  assert.equal((await call('POST', '/api/admin/login/backup', { token: s4.data.token, code: codes[1].toUpperCase() })).status, 200);

  // cannot remove the last passkey while it is required; sign-in history is recorded
  const sec = (await call('GET', '/api/admin/security', null, ck2)).data;
  assert.equal(sec.passkeys.length, 1);
  assert.equal(sec.backupCodesLeft, 8);
  assert.equal((await call('DELETE', `/api/admin/passkeys/${sec.passkeys[0].id}`, null, ck2)).status, 409);
  const methods = sec.logins.map((l) => `${l.method}:${l.ok}`);
  assert.ok(methods.includes('passkey:true') && methods.includes('passkey:false') && methods.includes('backup_code:true'));
  // turning it off again (from an open session)
  await call('POST', '/api/admin/mfa', { required: false }, ck2);
  assert.ok((await login()).data.ok);
});
