// v4.7: Aklatak brand, menus for every category, 300 limits, auto categories, "everything near me", contact the team, translation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { translateText } from '../src/services/translate.js';

const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';
let app, base, ck, z;
const call = async (m, p, body, cookie = ck) => {
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, text };
};
const add = (kind, name, phone, lat, extra = {}) => call('POST', '/api/admin/cooks', { kind, fullName: name, whatsapp: phone, areaId: z, lat, lng: 35.9031, servedAreaIds: [z],
  activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() }, ...extra }).then((r) => r.data);

before(async () => {
  app = await createApp({ databaseUrl: 'sqlite::memory:', sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999',
    bootstrapAdmin: { username: 'admin', password: 'correct-horse-battery' }, searchLimit: 1e4, applyLimit: 1e4, loginLimit: 1e4, lookupLimit: 1e4, feedbackLimit: 1e4,
    placesFetcher: async () => [], geoFetcher: async () => ({ country: 'LB', locality: 'زحلة' }) });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const l = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery' }) });
  ck = l.headers.get('set-cookie').split(';')[0];
  z = (await call('GET', `/api/areas/search?q=${encodeURIComponent('زحلة')}`)).data.areas[0].id;
});
after(async () => { await app.close(); });

test('brand is Aklatak everywhere; texts or a brand saved as "LTEZE" show Aklatak', async () => {
  const ar = (await call('GET', '/locales/ar.json', null, null)).text;
  assert.ok(ar.includes('Aklatak') && !ar.includes('LTE' + 'ZE'));
  const man = (await call('GET', '/manifest.webmanifest', null, null)).data;
  assert.equal(man.name, 'Aklatak');
  await call('PUT', '/api/admin/texts', { lang: 'ar', key: 'home.allNear', value: 'كل شيء على LTE' + 'ZE' });
  assert.equal((await call('GET', '/locales/ar.json', null, null)).data.home.allNear, 'كل شيء على Aklatak');
  await call('PUT', '/api/admin/texts', { lang: 'ar', key: 'home.allNear', value: null });
  assert.equal((await call('PUT', '/api/admin/settings', { brandName: 'LTE' + 'ZE' })).status, 200);
  assert.equal((await call('GET', '/api/admin/settings')).data.brandName, 'Aklatak');
});

test('old saved limits (12/30/150) become 300 once; a limit the admin chooses afterwards is kept, even after a restart', async () => {
  const f = `/tmp/limits-${Date.now()}.db`;
  const o = { databaseUrl: `sqlite:${f}`, sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999', placesFetcher: async () => [] };
  const a1 = await createApp(o);
  await new Promise((r) => a1.server.listen(0, r));
  await a1.db.query(`INSERT INTO app_meta (key, value) VALUES ('site_settings', $1)`, [JSON.stringify({ limits: { cookPhotos: 12, restaurantPhotos: 30, menuItems: 150 } })]);
  await a1.close();
  const a2 = await createApp(o);
  await new Promise((r) => a2.server.listen(0, r));
  assert.deepEqual([a2.settings.get().limits.cookPhotos, a2.settings.get().limits.restaurantPhotos, a2.settings.get().limits.menuItems], [300, 300, 300]);
  await a2.settings.save({ limits: { cookPhotos: 12 } });          // the owner chooses 12 on purpose
  await a2.close();
  const a3 = await createApp(o);
  await new Promise((r) => a3.server.listen(0, r));
  assert.equal(a3.settings.get().limits.cookPhotos, 12, 'kept after a restart');
  await a3.close();
});

test('every category (cooks included) has a menu customers can see; limits are 300', async () => {
  const s = (await call('GET', '/api/admin/settings')).data;
  assert.deepEqual([s.limits.cookPhotos, s.limits.restaurantPhotos, s.limits.menuItems], [300, 300, 300]);
  assert.equal((await call('PUT', '/api/admin/settings', { limits: { cookPhotos: 300, restaurantPhotos: 300, menuItems: 300 } })).status, 200);
  const bakery = await add('bakery', 'فرن الضيعة', '+96171666001', 33.8470);
  await call('POST', `/api/admin/cooks/${bakery.id}/menu`, { name: 'ربطة خبز', price: 1 });
  assert.equal((await call('GET', `/api/cooks/${bakery.id}`, null, null)).data.menu[0].name, 'ربطة خبز', 'menu visible to customers');
  const cook = await add('cook', 'أم علي', '+96171666002', 33.8475);
  await call('POST', `/api/admin/cooks/${cook.id}/menu`, { name: 'صينية كبة', price: 25 });
  assert.equal((await call('GET', `/api/cooks/${cook.id}`, null, null)).data.menu.length, 1, 'cooks can have a menu too');
});

test('"everything near me": every category, each nearest first; categories can appear automatically', async () => {
  await add('pharmacy', 'صيدلية الشفاء', '+96171666003', 33.8490);
  await add('pharmacy', 'صيدلية النور', '+96171666004', 33.8468);
  const all = (await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=all', null, null)).data.cooks;
  assert.ok(new Set(all.map((c) => c.kind)).size >= 3);
  const ph = all.filter((c) => c.kind === 'pharmacy');
  assert.deepEqual(ph.map((c) => c.name), ['صيدلية النور', 'صيدلية الشفاء']);
  const cats = (await call('GET', '/api/admin/settings')).data.categories;
  cats.find((c) => c.key === 'gym').home = 'auto';
  await call('PUT', '/api/admin/settings', { categories: cats });
  assert.equal((await call('GET', '/api/config', null, null)).data.site.categories.find((c) => c.key === 'gym').home, 'auto');
  const live = (await call('GET', '/api/config', null, null)).data.liveKinds;
  assert.ok(live.includes('pharmacy') && !live.includes('gym'));
});

test('contact the team: message reaches the admin panel', async () => {
  assert.equal((await call('POST', '/api/contact-admin', { message: 'hi', startedAt: Date.now() - 5000 }, null)).status, 422);
  assert.equal((await call('POST', '/api/contact-admin', { name: 'سامي', contact: '71 222 333', message: 'عندي اقتراح للمنصة', startedAt: Date.now() - 5000, website: '' }, null)).status, 201);
  const list = (await call('GET', '/api/admin/messages')).data.messages;
  assert.equal(list[0].body, 'عندي اقتراح للمنصة');
  assert.equal((await call('GET', '/api/admin/stats')).data.new_messages, 1);
  await call('POST', `/api/admin/messages/${list[0].id}/read`, {});
  assert.equal((await call('GET', '/api/admin/stats')).data.new_messages, 0);
  assert.equal((await call('GET', '/api/admin/messages', null, null)).status, 401);
});

test('translation: placeholders kept; without a key the text is saved in its own language only', async () => {
  let sent;
  const fake = async (url, opts) => { sent = JSON.parse(opts.body); return new Response(JSON.stringify({ translations: [{ text: 'Hello <x i="0"/>, you are <x i="1"/> away' }] }), { status: 200 }); };
  const out = await translateText('مرحبا {name}، أنت على بعد {distance}', 'ar', 'en', { key: 'k:fx', fetchImpl: fake });
  assert.equal(out, 'Hello {name}, you are {distance} away');
  assert.equal(sent.target_lang, 'EN-US'); assert.equal(sent.tag_handling, 'xml');
  assert.equal(await translateText('x', 'ar', 'en', { key: '' }), null);
  const r = await call('PUT', '/api/admin/texts', { lang: 'ar', key: 'home.allNear', value: 'كل شيء حولك', translate: true });
  assert.equal(r.data.translationAvailable, false);
  assert.deepEqual(r.data.translated, []);
  await call('PUT', '/api/admin/texts', { lang: 'ar', key: 'home.allNear', value: null, translate: true });
});
