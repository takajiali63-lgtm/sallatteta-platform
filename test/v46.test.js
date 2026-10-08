// v4.6: categories managed from the admin panel, optional order text, ads sent by businesses, logos & backgrounds library.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';
let app, base, ck, z;
const call = async (m, p, body, cookie = ck, headers = {}) => {
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  app = await createApp({ databaseUrl: 'sqlite::memory:', sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999',
    bootstrapAdmin: { username: 'admin', password: 'correct-horse-battery' }, searchLimit: 1e4, applyLimit: 1e4, loginLimit: 1e4, lookupLimit: 1e4,
    placesFetcher: async () => [], geoFetcher: async () => ({ country: 'LB', regionKey: 'LB-beqaa', regionName: 'البقاع', locality: 'زحلة' }) });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const l = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery' }) });
  ck = l.headers.get('set-cookie').split(';')[0];
  z = (await call('GET', `/api/areas/search?q=${encodeURIComponent('زحلة')}`)).data.areas[0].id;
});
after(async () => { await app.close(); });

test('10 categories by default, in 4 languages; the admin adds, hides, reorders and deletes categories', async () => {
  const cfg = (await call('GET', '/api/config', null, null)).data;
  assert.deepEqual(cfg.site.categories.map((c) => c.key), ['restaurant', 'cook', 'bakery', 'butcher', 'supermarket', 'minimarket', 'produce', 'juice', 'pharmacy', 'gym',
    'electrician', 'plumber', 'mechanic', 'carpenter', 'painter', 'ac_tech', 'cleaner', 'blacksmith', 'repair_tech']);   // + the 9 default crafts (v5.6)
  assert.equal(cfg.site.categories.find((c) => c.key === 'pharmacy').names.ar.many, 'صيدليات');
  assert.equal(cfg.site.categories.find((c) => c.key === 'pharmacy').names.es.one, 'Farmacia');
  const cats = (await call('GET', '/api/admin/settings')).data.categories;
  cats.push({ key: 'electrical', icon: '🔌', home: true, names: { ar: { one: 'محل أدوات كهربائية', many: 'محلات أدوات كهربائية' }, en: { one: 'Electrical shop', many: 'Electrical shops' } } });
  cats.find((c) => c.key === 'gym').home = false;        // hidden on the home page, still in the sign-up list
  cats.find((c) => c.key === 'juice').deleted = true;    // gone everywhere
  assert.equal((await call('PUT', '/api/admin/settings', { categories: cats })).status, 200);
  const after = (await call('GET', '/api/config', null, null)).data.site.categories;
  assert.ok(after.some((c) => c.key === 'electrical'));
  assert.equal(after.find((c) => c.key === 'gym').home, false);
  assert.ok(!after.some((c) => c.key === 'juice'));
  // the two original categories can never be removed; bad keys refused
  assert.equal((await call('PUT', '/api/admin/settings', { categories: cats.filter((c) => c.key !== 'cook') })).status, 422);
  assert.equal((await call('PUT', '/api/admin/settings', { categories: [...cats, { key: 'Bad Key!', names: { ar: { one: 'x' } } }] })).status, 422);
  // prices for the new category
  assert.equal((await call('PUT', '/api/admin/settings', { prices: { electrical: { monthly: { usd: 15 } } } })).status, 200);
  assert.equal((await call('GET', '/api/config', null, null)).data.site.prices.electrical.monthly.usd, 15);
});

test('anyone can subscribe in any category (also one hidden from the home page); it shows up for customers once active', async () => {
  await sleep(10);
  const r = await call('POST', '/api/cook-applications', { acceptTerms: true, password: 'shop12345', kind: 'electrical', fullName: 'كهربائيات النور', whatsapp: '71 444 001',
    lat: 33.8466, lng: 35.9031, servedAreaIds: [z], plan: 'monthly', bio: 'لمبات وأسلاك', startedAt: Date.now() - 5000 }, null);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const msg = new URL(r.data.whatsappUrl).searchParams.get('text');
  assert.ok(msg.includes('محل أدوات كهربائية') && msg.includes('$15'), msg);
  const g = await call('POST', '/api/cook-applications', { acceptTerms: true, password: 'gym123456', kind: 'gym', fullName: 'نادي القوة', whatsapp: '71 444 002',
    lat: 33.8466, lng: 35.9031, servedAreaIds: [z], plan: 'monthly', startedAt: Date.now() - 5000 }, null);
  assert.equal(g.status, 201);
  for (const id of [r.data.applicationId, g.data.applicationId]) {
    await call('POST', `/api/admin/cooks/${id}/approve`, {});
    await call('POST', `/api/admin/cooks/${id}/subscription/activate`, { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() });
  }
  const near = (await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=electrical', null, null)).data.cooks;
  assert.deepEqual(near.map((c) => c.name), ['كهربائيات النور']);
  const s = (await call('GET', '/api/admin/stats')).data;
  assert.equal(s.by_kind.electrical.active, 1);
  assert.equal(s.by_kind.gym.active, 1);
  const feed = (await call('GET', '/api/feed?country=LB', null, null)).data;
  assert.ok(feed.byKind.electrical?.length === 1);
  // every shop category has a price list like restaurants
  const m = await call('POST', `/api/admin/cooks/${r.data.applicationId}/menu`, { name: 'لمبة LED', price: 3 });
  assert.equal(m.data.menu.length, 1);
});

test('ordering: the request text is optional everywhere; a note without dishes is kept', async () => {
  const cook = (await call('POST', '/api/admin/cooks', { fullName: 'رنا', whatsapp: '+96171444010', areaId: z, lat: 33.847, lng: 35.9031, servedAreaIds: [z],
    activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } })).data;
  const empty = await call('POST', `/api/cooks/${cook.id}/request`, { lat: 33.8466, lng: 35.9031, startedAt: Date.now() - 5000, website: '' }, null);
  assert.equal(empty.status, 200, JSON.stringify(empty.data));
  const c1 = await call('POST', '/api/contact', { requestId: empty.data.requestId, cookId: cook.id }, null);
  assert.ok(new URL(c1.data.whatsappUrl).searchParams.get('text').includes('أودّ التواصل'), 'short contact message');
  const shop = (await call('POST', '/api/admin/cooks', { kind: 'bakery', fullName: 'فرن الضيعة', whatsapp: '+96171444011', areaId: z, lat: 33.847, lng: 35.904, servedAreaIds: [z],
    activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } })).data;
  const note = await call('POST', `/api/cooks/${shop.id}/request`, { text: '3 ربطات خبز', lat: 33.8466, lng: 35.9031, startedAt: Date.now() - 5000, website: '' }, null);
  const c2 = await call('POST', '/api/contact', { requestId: note.data.requestId, cookId: shop.id }, null);
  assert.ok(new URL(c2.data.whatsappUrl).searchParams.get('text').includes('3 ربطات خبز'), 'note kept');
});

test('ads from businesses: wait for approval, then run for the paid duration; can be rejected', async () => {
  await call('PUT', '/api/admin/settings', { adPrices: { week: { usd: 10 }, month: { usd: 30 } } });
  assert.equal((await call('POST', '/api/ads', { name: 'x', whatsapp: '71 1', placement: 'home_top', duration: 'week', image: IMG, startedAt: Date.now() - 5000 }, null)).status, 422);
  const a = await call('POST', '/api/ads', { name: 'سوبرماركت الهدى', whatsapp: '71 555 300', placement: 'home_top', duration: 'week', image: IMG, linkUrl: 'https://example.com', startedAt: Date.now() - 5000, website: '' }, null);
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const msg = new URL(a.data.whatsappUrl).searchParams.get('text');
  assert.ok(msg.includes('سوبرماركت الهدى') && msg.includes('$10'), msg);
  assert.equal((await call('GET', '/api/banners', null, null)).data.banners.length, 0, 'not public before approval');
  assert.equal((await call('GET', '/api/admin/stats')).data.pending_ads, 1);
  const ok = await call('POST', `/api/admin/banners/${a.data.adId}/approve`, {});
  const days = (new Date(ok.data.expiresAt) - Date.now()) / 864e5;
  assert.ok(days > 6.9 && days <= 7);
  app.cache?.clear?.('');
  assert.equal((await call('GET', '/api/banners', null, null)).data.banners.length, 1);
  const b = await call('POST', '/api/ads', { name: 'إعلان ثاني', whatsapp: '71 555 301', placement: 'home_middle', duration: 'month', image: IMG, startedAt: Date.now() - 5000, website: '' }, null);
  await call('POST', `/api/admin/banners/${b.data.adId}/reject`, {});
  const list = (await call('GET', '/api/admin/banners')).data.banners;
  assert.equal(list.find((x) => x.id === b.data.adId).status, 'rejected');
  assert.equal(list.find((x) => x.id === a.data.adId).advertiser.name, 'سوبرماركت الهدى');
  assert.equal((await call('POST', `/api/admin/banners/${b.data.adId}/approve`, {}, null)).status, 401);
});

test('logos & backgrounds: ready-made ones, owner uploads, safe choices only', async () => {
  assert.equal((await call('PUT', '/api/admin/designs', { key: 'custom' })).status, 200);   // v7.5: own colours instead of a ready design
  assert.equal((await call('PUT', '/api/admin/settings', { theme: { logo: 'preset:pin-bag', background: 'preset:shops' } })).status, 200);
  const cfg = (await call('GET', '/api/config', null, null)).data;
  assert.equal(cfg.site.theme.logo, 'preset:pin-bag');
  assert.ok((await (await fetch(base + '/theme.css')).text()).includes("/assets/bg/shops.svg"));
  for (const f of ['/assets/logos/pin-bag.svg', '/assets/logos/basket.svg', '/assets/bg/map.svg', '/assets/bg/dots.svg']) assert.equal((await fetch(base + f)).status, 200, f);
  assert.equal((await call('PUT', '/api/admin/settings', { theme: { logo: 'preset:../../etc' } })).status, 422);
  assert.equal((await call('PUT', '/api/admin/settings', { theme: { background: 'asset:999' } })).status, 422);
  const up = await call('POST', '/api/admin/assets', { kind: 'background', image: IMG, label: 'my bg' });
  assert.equal(up.status, 201);
  assert.equal((await call('PUT', '/api/admin/settings', { theme: { background: `asset:${up.data.id}` } })).status, 200);
  assert.ok((await (await fetch(base + '/theme.css')).text()).includes(`/media/asset/${up.data.id}`));
  assert.equal((await fetch(base + `/media/asset/${up.data.id}`)).status, 200);
  // a logo asset cannot be used as background
  const lg = await call('POST', '/api/admin/assets', { kind: 'logo', image: IMG });
  assert.equal((await call('PUT', '/api/admin/settings', { theme: { background: `asset:${lg.data.id}` } })).status, 422);
  // deleting the chosen background goes back to the default
  await call('DELETE', `/api/admin/assets/${up.data.id}`);
  assert.equal((await call('GET', '/api/admin/settings')).data.theme.background, '');
  assert.equal((await call('POST', '/api/admin/assets', { kind: 'logo', image: IMG }, null)).status, 401);
});
