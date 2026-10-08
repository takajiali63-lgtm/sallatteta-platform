// Infrastructure for multiple instances: shared rate limits, Redis client, client IP, jobs, observability.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, PgStore, RedisStore, RateLimiter } from '../src/lib/ratelimit.js';
import { createRedis } from '../src/lib/redis.js';
import { clientIp } from '../src/lib/security.js';
import { openDb, migrate } from '../src/db/index.js';
import { startFakeRedis } from './helpers/fake-redis.js';

const quiet = {};
const waitFor = async (fn, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

async function limiterBehaviour(store) {
  const a = new RateLimiter({ name: 't', windowMs: 60_000, max: 3, store, log: quiet });
  const now = 1_000_000_000_000;
  for (let i = 0; i < 3; i++) assert.equal((await a.take('ip1', now + i)).ok, true);
  const blocked = await a.take('ip1', now + 10);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= 61);
  assert.equal((await a.take('ip2', now + 10)).ok, true, 'other users are not affected');
  assert.equal((await a.take('ip1', now + 61_000)).ok, true, 'new window → allowed again');
}

describe('shared rate limiting', () => {
  test('memory store', async () => limiterBehaviour(new MemoryStore()));

  test('postgres store — two "instances" share one counter', async () => {
    const db = await openDb({ databaseUrl: 'sqlite::memory:' });
    await migrate(db);
    await limiterBehaviour(new PgStore(db));
    // two limiter objects (= two servers) on the same DB count together
    const s1 = new RateLimiter({ name: 'x', windowMs: 60_000, max: 2, store: new PgStore(db), log: quiet });
    const s2 = new RateLimiter({ name: 'x', windowMs: 60_000, max: 2, store: new PgStore(db), log: quiet });
    assert.equal((await s1.take('ip')).ok, true);
    assert.equal((await s2.take('ip')).ok, true);
    assert.equal((await s1.take('ip')).ok, false);
    const store = new PgStore(db);
    assert.ok((await store.cleanup(Date.now() + 10 * 60_000)) >= 1, 'expired counters are cleaned up');
    await db.close();
  });

  test('redis store (Redis/Valkey protocol, with password)', async () => {
    const fake = await startFakeRedis({ password: 's3cret' });
    const redis = createRedis(fake.url, { log: quiet });
    assert.ok(await waitFor(() => redis.ready));
    assert.equal(await redis.ping(), true);
    await limiterBehaviour(new RedisStore(redis));
    assert.ok(fake.commands.includes('AUTH') && fake.commands.includes('SELECT') && fake.commands.includes('PEXPIRE'));
    await redis.close(); await fake.stop();
  });

  test('if Redis goes down, users are NOT blocked (fail-open) and it reconnects', async () => {
    const fake = await startFakeRedis();
    const redis = createRedis(fake.url, { log: quiet, commandTimeoutMs: 300 });
    await waitFor(() => redis.ready);
    const lim = new RateLimiter({ name: 'f', windowMs: 60_000, max: 1, store: new RedisStore(redis), log: quiet });
    fake.dropConnections();
    const r = await lim.take('ip');
    assert.equal(r.ok, true);
    assert.equal(r.degraded, true);
    assert.ok(await waitFor(() => redis.ready, 3000), 'reconnects by itself');
    await redis.close(); await fake.stop();
  });
});

describe('client IP behind proxies', () => {
  const req = (xff, remote = '10.0.0.1') => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: remote } });
  test('a forged X-Forwarded-For cannot change the IP used for limits', () => {
    // Render appends the real client address at the end.
    assert.equal(clientIp(req('6.6.6.6, 203.0.113.9'), 1), '203.0.113.9');
    assert.equal(clientIp(req('203.0.113.9'), 1), '203.0.113.9');
    // Cloudflare + Render = 2 trusted hops
    assert.equal(clientIp(req('6.6.6.6, 198.51.100.7, 172.70.1.1'), 2), '198.51.100.7');
    // no proxy trust → socket address
    assert.equal(clientIp(req('6.6.6.6'), 0), '10.0.0.1');
  });
});

import { createJobRunner } from '../src/lib/jobs.js';
import { createApp } from '../src/server.js';
import { normalizePhone, toLocalFormat } from '../src/lib/countries.js';

describe('background jobs across many instances', () => {
  test('two instances never run the same job twice; failures retry; dead instance lease is taken over', async () => {
    const db = await openDb({ databaseUrl: 'sqlite::memory:' });
    await migrate(db);
    let runs = 0, fail = true;
    const job = { name: 'demo', everyMs: 60_000, timeoutMs: 1000, retryMs: 10, run: async () => { runs++; await new Promise((r) => setTimeout(r, 30)); return { ok: 1 }; } };
    const a = createJobRunner({ db, jobs: [job], log: quiet, instanceId: 'A' });
    const b = createJobRunner({ db, jobs: [job], log: quiet, instanceId: 'B' });
    await a.start({ immediate: false }); await b.start({ immediate: false });
    await Promise.all([a.tick(), b.tick(), a.tick(), b.tick()]);
    assert.equal(runs, 1, 'ran exactly once');
    await Promise.all([a.tick(), b.tick()]);
    assert.equal(runs, 1, 'not due again yet');

    const flaky = { name: 'flaky', everyMs: 60_000, retryMs: 1, run: async () => { if (fail) { fail = false; throw new Error('boom'); } return 'ok'; } };
    const c = createJobRunner({ db, jobs: [flaky], log: quiet, instanceId: 'C' });
    await c.start({ immediate: false });
    await c.tick();
    let st = (await c.status()).find((j) => j.name === 'flaky');
    assert.equal(st.last_status, 'error'); assert.equal(st.failures, 1);
    await new Promise((r) => setTimeout(r, 5));
    await c.tick();
    st = (await c.status()).find((j) => j.name === 'flaky');
    assert.equal(st.last_status, 'ok', 'retried after the failure');

    // an instance "died" holding the lease: once it expires, another instance runs the job
    await db.query(`UPDATE job_runs SET locked_until = $1, locked_by = 'dead', last_finished_at = NULL WHERE name = 'demo'`, [Date.now() + 50]);
    await a.tick(); assert.equal(runs, 1, 'lease still held by the dead instance');
    await new Promise((r) => setTimeout(r, 60));
    await a.tick(); assert.equal(runs, 2, 'taken over after the lease expired');
    await a.stop(); await b.stop(); await c.stop(); await db.close();
  });
});

describe('observability, API v1, brand, countries', () => {
  let app, base;
  const get = (p, h = {}) => fetch(base + p, { headers: h });
  test('setup: app renamed and set to Jordan', async () => {
    app = await createApp({
      databaseUrl: 'sqlite::memory:', sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '962790000000',
      brand: { name: 'طبخة', nameEn: 'Tabkha' }, defaultCountry: 'JO', metricsToken: 'metrics-secret-token',
      placesFetcher: async () => [], searchLimit: 1e4, lookupLimit: 1e4,
    });
    await new Promise((r) => app.server.listen(0, r));
    base = `http://127.0.0.1:${app.server.address().port}`;
  });

  test('every response has a request id; errors include it', async () => {
    const r = await get('/api/cooks/999999');
    const id = r.headers.get('x-request-id');
    assert.ok(id && id.length >= 8);
    assert.equal((await r.json()).requestId, id);
    const mine = await get('/api/config', { 'X-Request-Id': 'trace-12345678' });
    assert.equal(mine.headers.get('x-request-id'), 'trace-12345678');
  });

  test('/readyz reports the database and jobs; /metrics needs the token', async () => {
    const r = await get('/readyz');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.checks.database, 'ok');
    assert.equal(body.checks.jobs['expire-subscriptions'].status, 'ok');
    assert.equal((await get('/metrics')).status, 404);
    const m = await get('/metrics', { Authorization: 'Bearer metrics-secret-token' });
    assert.equal(m.status, 200);
    const text = await m.text();
    assert.match(text, /http_requests_total\{method="GET"/);
    assert.match(text, /http_p95_seconds/);
    assert.equal((await get('/healthz')).status, 200);
  });

  test('/api/v1/* is the same API as /api/*', async () => {
    const a = await (await get('/api/v1/config')).json();
    const b = await (await get('/api/config')).json();
    assert.deepEqual(a, b);
    assert.equal((await get('/api/v1/areas/search?q=zah')).status, 200);
  });

  test('renaming the platform is one setting: pages, manifest, texts and WhatsApp messages', async () => {
    const html = await (await get('/')).text();
    assert.ok(html.includes('طبخة') && !html.includes('Aklatak'));
    const manifest = await (await get('/manifest.webmanifest')).text();
    assert.ok(!manifest.includes('Aklatak'));
    const ar = await (await get('/locales/ar.json')).json();
    assert.equal(ar.brand.name, 'طبخة');
    assert.ok(ar.wa.cookLogin.includes('طبخة'));
    const cfg = await (await get('/api/config')).json();
    assert.deepEqual(cfg.brand, { name: 'طبخة', nameEn: 'Tabkha' });
  });

  test('country settings come from config (Jordan here), phone numbers use its code', async () => {
    const cfg = await (await get('/api/config')).json();
    assert.equal(cfg.country.code, 'JO');
    assert.equal(cfg.country.dialCode, '962');
    assert.equal(cfg.country.currency, 'JOD');
    assert.equal(cfg.country.timezone, 'Asia/Amman');
    const r = await fetch(base + '/api/cook-applications', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ acceptTerms: true, password: 'pass12345', fullName: 'أم خالد', whatsapp: '079 123 4567', lat: 31.95, lng: 35.93, servedAreaIds: [(await (await get('/api/areas/nearest?lat=31.95&lng=35.93')).json()).area.id], services: ['home_cooking'], plan: 'monthly' }),
    });
    assert.equal(r.status, 201);
    const row = await app.db.one('SELECT whatsapp, country FROM cooks ORDER BY id DESC LIMIT 1');
    assert.equal(row.whatsapp, '962791234567');
    assert.equal(row.country, 'JO');
    const wa = new URL((await r.json()).whatsappUrl);
    assert.equal(wa.pathname, '/962790000000');
    assert.ok(wa.searchParams.get('text').includes('طبخة'), 'admin message uses the new name');
  });

  test('phones: Lebanese numbers unchanged, other countries correct, local display', () => {
    assert.equal(normalizePhone('71-123456', 'LB'), '96171123456');
    assert.equal(normalizePhone('03 123 456', 'LB'), '9613123456');
    assert.equal(normalizePhone('06 12 34 56 78', 'FR'), '33612345678');
    assert.equal(normalizePhone('(212) 555-0199', 'US'), '12125550199');
    assert.equal(normalizePhone('+44 7911 123456', 'LB'), '447911123456');
    assert.equal(normalizePhone('71 123 4567', 'LB'), null);
    assert.equal(toLocalFormat('96171123456'), '071123456');
  });

  test('teardown', async () => { await app.close(); });
});

import { imageBytesOk } from '../src/lib/validate.js';
describe('image upload safety', () => {
  test('the bytes must really be the declared image type', () => {
    const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';
    const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString('base64');
    const webp = 'data:image/webp;base64,' + Buffer.from('RIFF\0\0\0\0WEBPVP8 ').toString('base64');
    const htmlAsJpeg = 'data:image/jpeg;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
    const pngAsJpeg = png.replace('image/png', 'image/jpeg');
    assert.ok(imageBytesOk(jpeg) && imageBytesOk(png) && imageBytesOk(webp));
    assert.equal(imageBytesOk(htmlAsJpeg), false);
    assert.equal(imageBytesOk(pngAsJpeg), false);
    assert.equal(imageBytesOk('data:image/svg+xml;base64,PHN2Zz4='), false);
    assert.equal(imageBytesOk('data:text/html;base64,PGh0bWw+'), false);
  });
});
