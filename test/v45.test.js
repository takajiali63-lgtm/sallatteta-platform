// v4.5: chosen password at sign-up, admin login from the Log in page, ads with an end date,
// today's counters, design (colours / size / layouts / logo), WhatsApp texts, admin-managed photos & menu.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';
let app, base, ck, z;
const call = async (m, p, body, cookie = ck, headers = {}) => {
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers, text };
};
const app1 = (extra) => ({ acceptTerms: true, fullName: 'سعاد', whatsapp: '71 555 777', lat: 33.8466, lng: 35.9031, servedAreaIds: [z], services: ['home_cooking'], plan: 'monthly', startedAt: Date.now() - 5000, ...extra });

before(async () => {
  app = await createApp({ databaseUrl: 'sqlite::memory:', sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999',
    bootstrapAdmin: { username: 'ali.takaji', password: 'correct-horse-battery' }, searchLimit: 1e4, applyLimit: 1e4, loginLimit: 1e4, lookupLimit: 1e4,
    placesFetcher: async () => [], geoFetcher: async () => ({ country: 'LB', regionKey: 'LB-beqaa', regionName: 'البقاع', locality: 'زحلة' }) });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  ck = (await call('POST', '/api/admin/login', { username: 'ali.takaji', password: 'correct-horse-battery' }, null)).headers.get('set-cookie').split(';')[0];
  z = (await call('GET', `/api/areas/search?q=${encodeURIComponent('زحلة')}`)).data.areas[0].id;
});
after(async () => { await app.close(); });

test('sign-up: the subscriber chooses a password (min 5); it is in the WhatsApp message (number without +) and works once activated', async () => {
  assert.equal((await call('POST', '/api/cook-applications', app1({}), null)).data.fields.password, 'required');
  assert.equal((await call('POST', '/api/cook-applications', app1({ password: 'abcd' }), null)).data.fields.password, 'password_too_short');
  const r = await call('POST', '/api/cook-applications', app1({ password: 'suad2026' }), null);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const msg = new URL(r.data.whatsappUrl).searchParams.get('text');
  assert.ok(msg.startsWith('📝 طلب اشتراك جديد في Aklatak'), msg);
  assert.ok(msg.includes('رقم الهاتف: 96171555777') && msg.includes('كلمة السر: suad2026'), msg);
  assert.ok(!msg.includes('رقم الهاتف: +'));
  // pending: cannot log in yet
  assert.equal((await call('POST', '/api/cook/login', { whatsapp: '71555777', password: 'suad2026' }, null)).status, 401);
  // the team activates (no password to send) → the chosen password works
  await call('POST', `/api/admin/cooks/${r.data.applicationId}/approve`, {});
  await call('POST', `/api/admin/cooks/${r.data.applicationId}/subscription`, { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() });
  const l = await call('POST', '/api/cook/login', { whatsapp: '71555777', password: 'suad2026' }, null);
  assert.equal(l.status, 200);
  assert.ok(l.headers.get('set-cookie').includes('st_cook='));
});

test('the owner can also open the admin panel from the normal Log in page (passkey step still enforced)', async () => {
  const bad = await call('POST', '/api/cook/login', { whatsapp: 'ali.takaji', password: 'nope-nope' }, null);
  assert.equal(bad.status, 401);
  const ok = await call('POST', '/api/cook/login', { whatsapp: 'Ali.Takaji', password: 'correct-horse-battery' }, null);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.redirect, '/admin/');
  const adminCookie = ok.headers.get('set-cookie').split(';')[0];
  assert.ok(adminCookie.startsWith('st_admin='));
  assert.equal((await call('GET', '/api/admin/me', null, adminCookie)).status, 200);
  // the original admin address keeps working
  assert.equal((await fetch(base + '/admin/')).status, 200);
  // when a passkey is required, no session is given here: the admin page asks for the fingerprint
  await app.db.query('UPDATE admin_users SET mfa_required = 1');
  const mfa = await call('POST', '/api/cook/login', { whatsapp: 'ali.takaji', password: 'correct-horse-battery' }, null);
  assert.equal(mfa.status, 200); assert.equal(mfa.headers.get('set-cookie'), null);
  await app.db.query('UPDATE admin_users SET mfa_required = 0');
});

test('ads: save with an end date; ended ads disappear by themselves; can be removed any time', async () => {
  const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
  await call('POST', '/api/admin/banners', { image: IMG, placement: 'home_top', expiresAt: day(-1), title: 'old' });
  await call('POST', '/api/admin/banners', { image: IMG, placement: 'home_top', expiresAt: day(3), title: 'live' });
  await call('POST', '/api/admin/banners', { image: IMG, placement: 'home_middle', title: 'forever' });
  const pub = (await call('GET', '/api/banners', null, null)).data.banners;
  assert.deepEqual(pub.map((b) => b.title).sort(), ['forever', 'live']);
  const list = (await call('GET', '/api/admin/banners')).data.banners;
  assert.equal(list.find((b) => b.title === 'old').expired, true);
  const live = list.find((b) => b.title === 'live');
  await call('PATCH', `/api/admin/banners/${live.id}`, { expiresAt: day(-2) });
  await call('DELETE', `/api/admin/banners/${list.find((b) => b.title === 'forever').id}`);
  await new Promise((r) => setTimeout(r, 1100));
  app.cache?.clear?.('');
  const after2 = (await call('GET', '/api/banners', null, null)).data.banners;
  assert.equal(after2.length, 0);
  assert.equal((await call('POST', '/api/admin/banners', { image: IMG, placement: 'home_top', expiresAt: 'not a date' })).status, 422);
});

test("today's counters: one visit per device, orders counted, countdown to the next midnight in Beirut", async () => {
  for (const vid of ['device-aaaa-1', 'device-aaaa-1', 'device-bbbb-2']) await call('POST', '/api/visit', { vid }, null);
  const s = (await call('GET', '/api/stats/today', null, null)).data;
  assert.equal(s.enabled, true);
  assert.equal(s.visitors, 2);
  const left = new Date(s.resetsAt).getTime() - Date.now();
  assert.ok(left > 0 && left <= 864e5);
  await call('PUT', '/api/admin/settings', { sections: { dailyCounters: false } });
  assert.equal((await call('GET', '/api/stats/today', null, null)).data.enabled, false);
  await call('PUT', '/api/admin/settings', { sections: { dailyCounters: true } });
});

test('design: colours, text size and layouts become /theme.css; unsafe values are refused; logo upload & reset', async () => {
  assert.equal((await call('PUT', '/api/admin/designs', { key: 'custom' })).status, 200);   // v7.5: own colours instead of a ready design
  assert.equal((await call('PUT', '/api/admin/settings', { theme: { colors: { gold: 'red;}body{display:none' } } })).status, 422);
  assert.equal((await call('PUT', '/api/admin/settings', { theme: { fontScale: 7 } })).status, 422);
  assert.equal((await call('PUT', '/api/admin/settings', { theme: { colors: { gold: '#ff5500', bg: '#000' }, fontScale: 1.1, layouts: { cooks: 'grid', restaurants: 'list' } } })).status, 200);
  const css = await (await fetch(base + '/theme.css')).text();
  assert.ok(css.includes('--gold: #ff5500;') && css.includes('--bg: #000;') && css.includes('font-size: 110%'));
  assert.ok(css.includes('#cookSlider { display: grid; grid-template-columns: repeat(2') && css.includes('#restSlider { display: grid; grid-template-columns: repeat(1'));
  for (const p of ['/', '/join', '/account', '/c/1']) assert.ok((await (await fetch(base + p)).text()).includes('/theme.css'), p);
  // image sizes (very small / small / current / large) per group
  assert.equal((await call('PUT', '/api/admin/settings', { theme: { sizes: { dishes: 'huge' } } })).status, 422);
  assert.equal((await call('PUT', '/api/admin/settings', { theme: { sizes: { dishes: 'xs', restaurants: 's', cooks: 'l', dishFeed: 'xs', gallery: 's' } } })).status, 200);
  const css2 = await (await fetch(base + '/theme.css')).text();
  assert.ok(css2.includes('.dish, .dish-ph { width: 9rem; }') && css2.includes('.rest-card { width: 62%') && css2.includes('.cook-card { width: 10rem; }'));
  assert.ok(css2.includes('.dish-feed { grid-template-columns: repeat(3') && css2.includes('.gallery { grid-template-columns: repeat(3'));
  await call('PUT', '/api/admin/settings', { theme: { colors: { gold: '', bg: '' }, fontScale: 1, layouts: { cooks: 'slider', restaurants: 'slider' }, sizes: { dishes: 'm', restaurants: 'm', cooks: 'm', dishFeed: 'm', gallery: 'm' } } });
  assert.ok(!(await (await fetch(base + '/theme.css')).text()).includes('--gold'));
  // logo
  assert.equal((await fetch(base + '/media/logo')).status, 404);
  assert.equal((await call('POST', '/api/admin/logo', { image: IMG })).status, 200);
  assert.equal((await fetch(base + '/media/logo')).status, 200);
  assert.ok((await call('GET', '/api/config', null, null)).data.site.theme.logoVersion > 0);
  await call('DELETE', '/api/admin/logo');
  assert.equal((await fetch(base + '/media/logo')).status, 404);
  assert.equal((await call('POST', '/api/admin/logo', { image: IMG }, null)).status, 401);
});

test('WhatsApp messages: only wa.* listed, edited text is used in the real message', async () => {
  const list = (await call('GET', '/api/admin/texts?lang=ar&prefix=wa.')).data.items;
  assert.ok(list.length > 5 && list.every((i) => i.key.startsWith('wa.')));
  await call('PUT', '/api/admin/texts', { lang: 'ar', key: 'wa.customerMessage', value: '🌟 طلب من Aklatak 🌟\n{request}\n{distanceLine}📍 {area}' });
  const cook = (await call('POST', '/api/admin/cooks', { fullName: 'رنا', whatsapp: '+96171555888', areaId: z, lat: 33.8475, lng: 35.9031, services: ['home_cooking'], servedAreaIds: [z], activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } })).data;
  const s = await call('POST', '/api/search', { text: 'بدي كبة لـ 4', location: { type: 'gps', lat: 33.8466, lng: 35.9031, accuracy: 8 }, startedAt: Date.now() - 5000 }, null);
  const c = await call('POST', '/api/contact', { requestId: s.data.requestId, cookId: cook.id }, null);
  const msg = new URL(c.data.whatsappUrl).searchParams.get('text');
  assert.ok(msg.startsWith('🌟 طلب من Aklatak 🌟\nبدي كبة لـ 4\n📍 أنا بعيد عنك 100 متر'), msg);
  await call('PUT', '/api/admin/texts', { lang: 'ar', key: 'wa.customerMessage', value: null });
});

test('restaurants added by the admin: place search, photos and menu managed from the panel, visible to customers', async () => {
  assert.equal((await call('GET', '/api/admin/geocode?q=Zahle', null, null)).status, 401);
  assert.ok(Array.isArray((await call('GET', '/api/admin/geocode?q=Zahle')).data.places));
  const r = (await call('POST', '/api/admin/cooks', { kind: 'restaurant', specialty: 'مشاوي', fullName: 'مطعم الإدارة', whatsapp: '+96171555999', areaId: z, lat: 33.8470, lng: 35.9040, servedAreaIds: [z],
    activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } })).data;
  assert.equal((await call('POST', `/api/admin/cooks/${r.id}/photos`, { data: IMG, caption: 'مشاوي' })).status, 201);
  const m = await call('POST', `/api/admin/cooks/${r.id}/menu`, { name: 'شيش طاووق', price: 8 });
  assert.equal(m.status, 201);
  assert.equal(m.data.menu.length, 1);
  const prof = (await call('GET', `/api/cooks/${r.id}`, null, null)).data;
  assert.equal(prof.menu[0].name, 'شيش طاووق');
  assert.equal(prof.photos.length, 1);
  const near = (await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=restaurant', null, null)).data.cooks;
  assert.ok(near.some((c) => c.name === 'مطعم الإدارة'));
  assert.equal((await call('POST', `/api/admin/cooks/${r.id}/menu`, { name: 'x' }, null)).status, 401);
});

test('emergency: ADMIN_RESET_PASSWORD (set in Render) resets the admin password, turns off the passkey requirement, signs out sessions', async () => {
  const dbFile = `/tmp/reset-${Date.now()}.db`;
  const opts = (extra) => ({ databaseUrl: `sqlite:${dbFile}`, sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999', loginLimit: 1e4, placesFetcher: async () => [], ...extra });
  const one = await createApp(opts({ bootstrapAdmin: { username: 'ali.takaji', password: 'old-password-123' } }));
  await new Promise((r) => one.server.listen(0, r));
  await one.db.query('UPDATE admin_users SET mfa_required = 1');
  await one.close();
  const loginWith = async (a, password) => {
    await new Promise((r) => a.server.listen(0, r));
    const b = `http://127.0.0.1:${a.server.address().port}`;
    return fetch(b + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ username: 'ali.takaji', password }) }).then((r) => r.json());
  };
  // too short → ignored
  const weak = await createApp(opts({ adminReset: { username: 'ali.takaji', password: 'short' } }));
  assert.equal((await loginWith(weak, 'short')).error, 'invalid_credentials');
  await weak.close();
  // proper reset
  const two = await createApp(opts({ adminReset: { username: 'ali.takaji', password: 'brand-new-pass-2026' } }));
  const r = await loginWith(two, 'brand-new-pass-2026');
  assert.equal(r.ok, true, 'signed in directly (passkey requirement turned off)');
  assert.equal(Number((await two.db.one("SELECT mfa_required FROM admin_users WHERE username = 'ali.takaji'")).mfa_required), 0);
  await two.close();
});
