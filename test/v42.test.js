// v4.2: one-tap full backup & restore, zip tool, Spanish, text edits for all languages, avatar, restaurant slider,
// messages in the user's own language, build fingerprint.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createZip, readZip } from '../src/lib/zip.js';

const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';
const opts = { sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999', bootstrapAdmin: { username: 'admin', password: 'correct-horse-battery' },
  searchLimit: 1e4, applyLimit: 1e4, loginLimit: 1e4, lookupLimit: 1e4, placesFetcher: async () => [], geoFetcher: async () => ({ country: 'LB' }) };
let app, base, ck;
const mk = (b) => async (m, p, body, cookie, headers = {}) => {
  const r = await fetch(b + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
  const buf = Buffer.from(await r.arrayBuffer());
  let data; try { data = JSON.parse(buf.toString()); } catch { data = buf; }
  return { status: r.status, data, headers: r.headers };
};
let call;
before(async () => {
  app = await createApp({ databaseUrl: 'sqlite::memory:', ...opts });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  call = mk(base);
  ck = (await call('POST', '/api/admin/login', { username: 'admin', password: 'correct-horse-battery' })).headers.get('set-cookie').split(';')[0];
});
after(async () => { await app.close(); });

test('zip tool round-trips files and refuses unsafe names', () => {
  const z = createZip([{ name: 'a/b.json', data: '{"x":1}' }, { name: 'c.txt', data: Buffer.from('مرحبا') }]);
  const m = readZip(z);
  assert.equal(m.get('a/b.json').toString(), '{"x":1}');
  assert.equal(m.get('c.txt').toString(), 'مرحبا');
  assert.throws(() => readZip(createZip([{ name: '../evil.txt', data: 'x' }])), /unsafe/);
});

test('profile photo: saved, visible publicly with a changing URL (no stale image)', async () => {
  const z = (await call('GET', `/api/areas/search?q=${encodeURIComponent('زحلة')}`)).data.areas[0].id;
  const c = (await call('POST', '/api/admin/cooks', { fullName: 'صورة', whatsapp: '+96171000777', areaId: z, services: ['home_cooking'], servedAreaIds: [z],
    activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } }, ck)).data;
  const pw = (await call('POST', `/api/admin/cooks/${c.id}/password`, {}, ck)).data.password;
  const cc = (await call('POST', '/api/cook/login', { whatsapp: '71000777', password: pw })).headers.get('set-cookie').split(';')[0];
  assert.equal((await call('PATCH', '/api/cook/me', { photo: IMG }, cc)).status, 200);
  const u1 = (await call('GET', `/api/cooks/${c.id}`)).data.photoUrl;
  assert.match(u1, /\/media\/cooks\/\d+\.jpg\?v=\d+/);
  await new Promise((r) => setTimeout(r, 15));
  await call('PATCH', '/api/cook/me', { photo: IMG.replace('ABAQAAAQ', 'ABAQAAAR') }, cc);
  const u2 = (await call('GET', `/api/cooks/${c.id}`)).data.photoUrl;
  assert.notEqual(u1, u2, 'URL changes after a new photo');
  assert.equal((await fetch(base + u2)).status, 200);
});

test('Spanish: locale served, Spanish countries pick Spanish, menu offers it', async () => {
  const cfg = (await call('GET', '/api/config?country=MX')).data;
  assert.ok(cfg.locales.includes('es'));
  assert.equal(cfg.country.lang, 'es');
  const es = await (await fetch(base + '/locales/es.json')).json();
  assert.equal(es.home.title, '¿Qué se te antoja hoy?');
  assert.ok(es.pages.terms.body.includes('Aklatak no es parte del pedido'));
});

test('a customer writing in Spanish sends the cook a Spanish WhatsApp message; an applicant gets their language', async () => {
  const z = (await call('GET', `/api/areas/search?q=${encodeURIComponent('زحلة')}`)).data.areas[0].id;
  const s = await call('POST', '/api/search', { text: 'quiero kibbeh', location: { type: 'area', areaId: z } }, null, { 'X-Locale': 'es' });
  const cook = s.data.cooks[0];
  const c = await call('POST', '/api/contact', { requestId: s.data.requestId, cookId: cook.id }, null, { 'X-Locale': 'es' });
  assert.ok(new URL(c.data.whatsappUrl).searchParams.get('text').startsWith('Hola, quiero hacer un pedido'));
  const a = await call('POST', '/api/cook-applications', { acceptTerms: true, password: 'pass12345', fullName: 'Ana', whatsapp: '71 555 222', lat: 33.8466, lng: 35.9031, servedAreaIds: [z], services: ['home_cooking'], plan: 'monthly', startedAt: Date.now() - 5000 }, null, { 'X-Locale': 'en' });
  const appMsg = new URL(a.data.whatsappUrl).searchParams.get('text');
  assert.ok(appMsg.startsWith('📝 New subscription on Aklatak'), appMsg);
  assert.ok(appMsg.includes('Password: pass12345') && !/Phone: \+/.test(appMsg), 'login details: visible password, number without +');
});

test('admin text edit can apply to every language at once', async () => {
  await call('PUT', '/api/admin/texts', { lang: 'ar', key: 'home.findRestaurant', value: 'Aklatak Food', allLangs: true }, ck);
  for (const l of ['ar', 'en', 'fr', 'es']) assert.equal((await (await fetch(base + `/locales/${l}.json`)).json()).home.findRestaurant, 'Aklatak Food', l);
  await call('PUT', '/api/admin/texts', { lang: 'ar', key: 'home.findRestaurant', value: null, allLangs: true }, ck);
  assert.equal((await (await fetch(base + '/locales/es.json')).json()).home.findRestaurant, 'Busca un restaurante cerca de ti');
});

test('home feed lists restaurants for the slider even without dish photos', async () => {
  const z = (await call('GET', `/api/areas/search?q=${encodeURIComponent('زحلة')}`)).data.areas[0].id;
  await call('POST', '/api/admin/cooks', { kind: 'restaurant', specialty: 'Grill', fullName: 'Resto', whatsapp: '+96171000888', areaId: z, servedAreaIds: [z], photo: IMG,
    activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } }, ck);
  const f = (await call('GET', '/api/feed?country=LB')).data;
  assert.equal(f.restaurants.length, 1);
  assert.ok(f.restaurants[0].photoUrl);
});

test('one-tap full backup (code + data, no secrets) → restore into a new empty site', async () => {
  const b = await call('GET', '/api/admin/backup', undefined, ck);
  assert.equal(b.status, 200);
  assert.equal(b.headers.get('content-type'), 'application/zip');
  const files = readZip(b.data);
  for (const n of ['data/manifest.json', 'data/cooks.json', 'code/src/server.js', 'code/package.json', 'code/Dockerfile', 'code/docs/MIGRATION.md', 'READ-ME-FIRST.txt']) assert.ok(files.has(n), n);
  assert.ok(![...files.keys()].some((n) => /\.env$|node_modules/.test(n)), 'no secrets / deps inside');
  // real secrets never appear in the data or the platform files (test files use fake demo passwords on purpose)
  const real = [...files].filter(([n]) => !n.startsWith('code/test/')).map(([, x]) => x.toString('latin1')).join('');
  assert.ok(!real.includes('correct-horse-battery'), 'admin password is only stored hashed');
  assert.ok(!real.includes('x'.repeat(40)), 'session secret is never exported');
  // not allowed on a site that has data
  assert.equal((await call('POST', '/api/admin/restore', b.data, ck, { 'Content-Type': 'application/zip' })).status, 409);
  // a brand-new site
  const app2 = await createApp({ databaseUrl: 'sqlite::memory:', ...opts, bootstrapAdmin: { username: 'temp', password: 'temporary-pass-123' } });
  await new Promise((r) => app2.server.listen(0, r));
  const call2 = mk(`http://127.0.0.1:${app2.server.address().port}`);
  const ck2 = (await call2('POST', '/api/admin/login', { username: 'temp', password: 'temporary-pass-123' })).headers.get('set-cookie').split(';')[0];
  const r = await call2('POST', '/api/admin/restore', b.data, ck2, { 'Content-Type': 'application/zip' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.ok, true);
  // the old admin account works on the new site; the cooks are there
  assert.equal((await call2('POST', '/api/admin/login', { username: 'admin', password: 'correct-horse-battery' })).status, 200);
  const names = (await call2('GET', '/api/feed?country=LB')).data.restaurants.map((x) => x.name);
  assert.deepEqual(names, ['Resto']);
  // garbage upload is refused
  const app2b = await call2('POST', '/api/admin/restore', Buffer.from('not a zip'), ck2, { 'Content-Type': 'application/zip' });
  assert.ok([401, 409, 422].includes(app2b.status));
  await app2.close();
});

test('build fingerprint is exposed for tamper checks', async () => {
  const r = (await call('GET', '/readyz')).data;
  assert.match(r.fingerprint, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.ok(r.version);
});
