// v4.0: worldwide use (any country, automatic), restaurants (menu ordering, more photos, own prices),
// support messages to the admin, ads/logos, trials, worldwide counters toggle.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { chainPlaces } from '../src/services/placeProviders.js';

const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';
const PARIS = { lat: 48.8867, lng: 2.3431 };          // Montmartre
const PARIS_PLACES = [
  { osmId: 7001, nameAr: 'Montmartre', nameEn: 'Montmartre', lat: 48.8867, lng: 2.3431 },
  { osmId: 7002, nameAr: 'Pigalle', nameEn: 'Pigalle', lat: 48.8822, lng: 2.3376 },
  { osmId: 7003, nameAr: 'Batignolles', nameEn: 'Batignolles', lat: 48.8870, lng: 2.3190 },
];
let app, base, cookie;

async function http(method, path, { body, cookie: c, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method, redirect: 'manual',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'X-Requested-With': 'fetch', ...(c ? { Cookie: c } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const admin = (m, p, b) => http(m, p, { body: b, cookie });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  app = await createApp({
    databaseUrl: 'sqlite::memory:', adminWhatsapp: '96170999999', sessionSecret: 'x'.repeat(40), quiet: true,
    bootstrapAdmin: { username: 'admin', password: 'correct-horse-battery' },
    searchLimit: 1e4, applyLimit: 1e4, loginLimit: 1e4, lookupLimit: 1e4, placesLimit: 1e4, feedbackLimit: 1e4,
    placesFetcher: async (lat) => (lat > 40 ? PARIS_PLACES : []),
    geoFetcher: async (lat) => (lat > 40
      ? { country: 'FR', regionKey: 'FR-IDF', regionName: 'Île-de-France', regionNameAr: 'إيل دو فرانس', regionNameEn: 'Île-de-France' }
      : { country: 'LB', regionKey: 'LB-beqaa', regionName: 'البقاع', regionNameAr: 'البقاع', regionNameEn: 'Beqaa' }),
  });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const l = await http('POST', '/api/admin/login', { body: { username: 'admin', password: 'correct-horse-battery' } });
  cookie = l.headers.get('set-cookie').split(';')[0];
  await admin('PUT', '/api/admin/settings', { prices: {
    cook: { monthly: { usd: 20, eur: 18 } },
    restaurant: { monthly: { usd: 50, eur: 45 } },
  } });
});
after(async () => { await app.close(); });

let restId, restCookie, restPhone;
describe('worldwide: a restaurant in Paris, fully automatic', () => {
  test('towns around Paris come from the map; country, region, phone and currency follow the location', async () => {
    const around = await http('GET', `/api/areas/around?lat=${PARIS.lat}&lng=${PARIS.lng}`);
    const names = around.data.areas.map((a) => a.name);
    assert.ok(names.includes('Montmartre') && names.includes('Pigalle'));
    assert.equal(around.data.nearest.name, 'Montmartre');
    const ids = around.data.areas.filter((a) => ['Montmartre', 'Pigalle'].includes(a.name)).map((a) => a.id);

    const cfgFR = await http('GET', '/api/config?country=FR');
    assert.equal(cfgFR.data.country.lang, 'fr');
    assert.equal(cfgFR.data.billing.currency, 'EUR');
    assert.equal(cfgFR.data.site.prices.restaurant.monthly.eur, 45);

    await sleep(1600);
    const r = await http('POST', '/api/cook-applications', { body: {
      acceptTerms: true, password: 'pass12345', kind: 'restaurant', fullName: 'Chez Teta', whatsapp: '06 12 34 56 78', specialty: 'Cuisine libanaise, grillades',
      lat: PARIS.lat, lng: PARIS.lng, servedAreaIds: ids, plan: 'monthly', startedAt: Date.now() - 5000,
    } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.country, 'FR');
    assert.equal(r.data.kind, 'restaurant');
    const text = new URL(r.data.whatsappUrl).searchParams.get('text');
    assert.ok(text.includes('+33612345678'), 'French local number normalised with +33');
    assert.ok(text.includes('Île-de-France'));
    assert.ok(text.includes('€45'), 'restaurant price in EUR');
    assert.ok(/مطعم|Restaurant/.test(text) && text.includes('Chez Teta'), 'the category and the name are in the sign-up message');
    restId = r.data.applicationId; restPhone = '0612345678';
    const c = await admin('GET', `/api/admin/cooks/${restId}`);
    assert.equal(c.data.kind, 'restaurant');
    assert.equal(c.data.country, 'FR');
    assert.equal(c.data.region_name, 'Île-de-France');
    assert.equal(c.data.subscription.currency, 'EUR');
    assert.ok(Array.isArray(c.data.menu) && 'unreadSupport' in c.data, 'admin detail has menu & support count');
    assert.ok(!('country' in (c.data.reviews[0] || {})), 'reviews carry no stray fields');
    assert.equal(Number(c.data.subscription.amount), 45);
  });

  test('the specialty and service types are optional now (one sign-up form for every category)', async () => {
    await sleep(1600);
    const r = await http('POST', '/api/cook-applications', { body: {
      acceptTerms: true, password: 'pass12345', kind: 'restaurant', fullName: 'X', whatsapp: '06 99 88 77 66', lat: PARIS.lat, lng: PARIS.lng, servedAreaIds: [1], plan: 'monthly', startedAt: Date.now() - 5000,
    } });
    assert.ok(r.status === 201 || r.status === 422, JSON.stringify(r.data));
    if (r.status === 422) assert.ok(!('specialty' in r.data.fields) && !('services' in r.data.fields), JSON.stringify(r.data.fields));
  });

  test('trial activation, menu, 30 photos, and ordering from the menu on WhatsApp', async () => {
    const tr = await admin('POST', `/api/admin/cooks/${restId}/subscription/trial`, {});
    assert.equal(tr.data.effectiveStatus, 'active');
    assert.equal(Number(tr.data.subscription.is_trial), 1);
    await admin('POST', `/api/admin/cooks/${restId}/approve`, {});
    const pw = await admin('POST', `/api/admin/cooks/${restId}/password`, {});
    const l = await http('POST', '/api/cook/login', { body: { whatsapp: '+33612345678', password: pw.data.password } });
    restCookie = l.headers.get('set-cookie').split(';')[0];

    let me = (await http('POST', '/api/cook/menu', { cookie: restCookie, body: { name: 'Shawarma', price: 9.5 } })).data;
    me = (await http('POST', '/api/cook/menu', { cookie: restCookie, body: { name: 'Taboulé', price: 6 } })).data;
    me = (await http('POST', '/api/cook/menu', { cookie: restCookie, body: { name: 'Plat du jour' } })).data;
    assert.equal(me.menu.length, 3);
    assert.equal(me.menu[0].currency, 'EUR');
    assert.equal(me.maxPhotos, 300);
    for (let i = 0; i < 15; i++) assert.equal((await http('POST', '/api/cook/photos', { cookie: restCookie, body: { data: IMG, caption: `plat ${i}` } })).status, 201);

    const page = await http('GET', `/api/cooks/${restId}`);
    assert.equal(page.data.kind, 'restaurant');
    assert.equal(page.data.specialty, 'Cuisine libanaise, grillades');
    assert.equal(page.data.menu.length, 3);

    const [shawarma, taboule] = page.data.menu;
    await sleep(1600);
    const req = await http('POST', `/api/cooks/${restId}/request`, { body: {
      items: [{ id: shawarma.id, qty: 2 }, { id: taboule.id, qty: 1 }], text: 'sans oignons', lat: 48.8820, lng: 2.3380, startedAt: Date.now() - 5000,
    } });
    assert.equal(req.status, 200, JSON.stringify(req.data));
    assert.equal(req.data.type, 'order');
    const c = await http('POST', '/api/contact', { body: { requestId: req.data.requestId, cookId: restId } });
    const msg = new URL(c.data.whatsappUrl).searchParams.get('text');
    assert.equal(new URL(c.data.whatsappUrl).pathname, '/33612345678');
    for (const s of ['2 × Shawarma', '€19', '1 × Taboulé', '€6', '€25', 'sans oignons']) assert.ok(msg.includes(s), `order message missing ${s}`);

    // no dish chosen → a simple "I'd like to contact you" message, no text required
    await sleep(1600);
    const r2 = await http('POST', `/api/cooks/${restId}/request`, { body: { lat: 48.8820, lng: 2.3380, startedAt: Date.now() - 5000 } });
    assert.equal(r2.data.type, 'contact');
    const c2 = await http('POST', '/api/contact', { body: { requestId: r2.data.requestId, cookId: restId } });
    assert.ok(new URL(c2.data.whatsappUrl).searchParams.get('text').length > 10);
    // unknown dish id is refused
    const bad = await http('POST', `/api/cooks/${restId}/request`, { body: { items: [{ id: 99999, qty: 1 }], lat: 48.88, lng: 2.33, startedAt: Date.now() - 5000 } });
    assert.equal(bad.status, 422);
  });

  test('customers in Paris find the restaurant; Paris regions; the home restaurant slider', async () => {
    const near = await http('GET', '/api/cooks/nearby?lat=48.8825&lng=2.3378&type=restaurant');
    assert.deepEqual(near.data.cooks.map((c) => c.name), ['Chez Teta']);
    assert.equal(near.data.country, 'FR');
    const cooksOnly = await http('GET', '/api/cooks/nearby?lat=48.8825&lng=2.3378');
    assert.equal(cooksOnly.data.cooks.length, 0, 'restaurants are not mixed into the cook search');
    const reg = await http('GET', '/api/cooks/by-region?country=FR&type=restaurant');
    assert.equal(reg.data.regions[0].name, 'إيل دو فرانس');
    assert.deepEqual(reg.data.regions[0].cooks.map((c) => c.name), ['Chez Teta']);
    const lb = await http('GET', '/api/cooks/by-region?country=LB&type=restaurant');
    assert.ok(lb.data.regions.every((g) => g.cooks.length === 0), 'Paris restaurant not listed in Lebanon');
    const feed = await http('GET', '/api/feed?country=FR');   // one country per visitor (never a mix)
    assert.ok(feed.data.restaurantPhotos.length >= 10);
    assert.equal(feed.data.restaurantPhotos[0].restaurantName, 'Chez Teta');
  });
});

describe('support, ads, counters', () => {
  test('a restaurant writes to the admin inside the site; the admin replies; unread counters', async () => {
    assert.equal((await http('POST', '/api/cook/support', { cookie: restCookie, body: { body: 'Je ne vois pas mes photos' } })).status, 201);
    const stats = await admin('GET', '/api/admin/stats');
    assert.equal(stats.data.new_support, 1);
    const threads = await admin('GET', '/api/admin/support');
    assert.equal(threads.data.threads[0].name, 'Chez Teta');
    assert.equal(threads.data.threads[0].unread, 1);
    const t1 = await admin('GET', `/api/admin/support/${restId}`);
    assert.equal(t1.data.messages[0].body, 'Je ne vois pas mes photos');
    assert.equal((await admin('GET', '/api/admin/stats')).data.new_support, 0);
    await admin('POST', `/api/admin/support/${restId}`, { body: 'C’est réglé ✓' });
    assert.equal((await http('GET', '/api/cook/me', { cookie: restCookie })).data.unreadSupport, 1);
    const mine = await http('GET', '/api/cook/support', { cookie: restCookie });
    assert.deepEqual(mine.data.messages.map((x) => x.fromAdmin), [false, true]);
    assert.equal((await http('GET', '/api/cook/me', { cookie: restCookie })).data.unreadSupport, 0);
    assert.equal((await http('POST', '/api/cook/support', { body: { body: 'x x' } })).status, 401);
  });

  test('admin uploads an ad, places it, turns it off, deletes it', async () => {
    const add = await admin('POST', '/api/admin/banners', { image: IMG, placement: 'home_top', linkUrl: 'https://example.com', title: 'Promo' });
    assert.equal(add.status, 201);
    let pub = await http('GET', '/api/banners');
    assert.equal(pub.data.banners.length, 1);
    assert.equal(pub.data.banners[0].placement, 'home_top');
    const id = pub.data.banners[0].id;
    assert.equal((await fetch(base + pub.data.banners[0].imageUrl)).status, 200);
    await admin('PATCH', `/api/admin/banners/${id}`, { placement: 'cook_page' });
    await admin('PATCH', `/api/admin/banners/${id}`, { active: false });
    pub = await http('GET', '/api/banners');
    assert.equal(pub.data.banners.length, 0);
    assert.equal((await admin('POST', '/api/admin/banners', { image: IMG, placement: 'nowhere' })).status, 422);
    assert.equal((await admin('POST', '/api/admin/banners', { image: IMG, placement: 'home_top', linkUrl: 'javascript:alert(1)' })).status, 422);
    await admin('DELETE', `/api/admin/banners/${id}`);
    assert.equal((await admin('GET', '/api/admin/banners')).data.banners.length, 0);
  });

  test('worldwide counters are off until the admin turns them on', async () => {
    assert.equal((await http('GET', '/api/stats/public')).data.enabled, false);
    await admin('PUT', '/api/admin/settings', { sections: { globalCounters: true } });
    const s = await http('GET', '/api/stats/public');
    assert.equal(s.data.enabled, true);
    assert.equal(s.data.restaurants, 1);
    assert.ok(s.data.countries >= 1);
    await admin('PUT', '/api/admin/settings', { sections: { globalCounters: false } });
  });

  test('admin lists restaurants and cooks separately', async () => {
    const r = await admin('GET', '/api/admin/cooks?filter=all&kind=restaurant');
    assert.deepEqual(r.data.cooks.map((c) => c.kind), ['restaurant']);
    const c = await admin('GET', '/api/admin/cooks?filter=all&kind=cook');
    assert.ok(c.data.cooks.every((x) => x.kind === 'cook'));
  });

  test('delete really removes a restaurant with its menu, photos and messages', async () => {
    assert.equal((await admin('DELETE', `/api/admin/cooks/${restId}`)).status, 200);
    for (const t of ['menu_items', 'support_messages', 'cook_photos']) {
      assert.equal(Number((await app.db.one(`SELECT COUNT(*) AS n FROM ${t} WHERE cook_id = $1`, [restId])).n), 0, t);
    }
    assert.equal((await http('GET', `/api/cooks/${restId}`)).status, 404);
  });
});

describe('place providers', () => {
  test('first provider that answers wins; the chain survives failures', async () => {
    const fail = async () => { throw new Error('down'); };
    const empty = async () => [];
    const ok = async () => [{ osmId: 1, nameAr: 'Here', lat: 1, lng: 1 }];
    const r = await chainPlaces([['a', fail], ['b', empty], ['c', ok]])(1, 1, 15);
    assert.equal(r.provider, 'c');
    await assert.rejects(chainPlaces([['a', fail], ['b', empty]])(1, 1, 15), /a: down \| b: empty/);
  });
});
