// v3.1 features: hide / delete accounts, "near me" (GPS only), cooks by governorate, dish photos page,
// site settings from the admin panel, review & photo moderation, Aklatak brand.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';
let app, base, cookie;
const A = {};

async function http(method, path, { body, cookie: c } = {}) {
  const res = await fetch(base + path, {
    method, redirect: 'manual',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), 'X-Requested-With': 'fetch', ...(c ? { Cookie: c } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const admin = (m, p, b) => http(m, p, { body: b, cookie });
const ids = (r) => r.data.cooks.map((c) => c.id);

async function addCook(name, phone, home, served, { lat, lng } = {}) {
  const r = await admin('POST', '/api/admin/cooks', {
    fullName: name, whatsapp: phone, areaId: A[home], services: ['home_cooking'], servedAreaIds: served.map((s) => A[s]),
    ...(lat ? { lat, lng } : {}),
    activate: { plan: 'monthly', startDate: new Date(Date.now() - 60_000).toISOString() },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
async function cookSession(id, phone) {
  const pw = await admin('POST', `/api/admin/cooks/${id}/password`, {});
  const l = await http('POST', '/api/cook/login', { body: { whatsapp: phone, password: pw.data.password } });
  return l.headers.get('set-cookie').split(';')[0];
}

let zahleCook, saadCook, tripoliCook;
before(async () => {
  app = await createApp({
    databaseUrl: 'sqlite::memory:', adminWhatsapp: '96170999999', sessionSecret: 'x'.repeat(40), quiet: true,
    bootstrapAdmin: { username: 'admin', password: 'correct-horse-battery' },
    searchLimit: 1e4, applyLimit: 1e4, loginLimit: 1e4, lookupLimit: 1e4, placesLimit: 1e4, feedbackLimit: 1e4,
    placesFetcher: async () => [],
  });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  for (const a of await app.db.query('SELECT id, slug FROM service_areas')) A[a.slug] = a.id;
  const l = await http('POST', '/api/admin/login', { body: { username: 'admin', password: 'correct-horse-battery' } });
  cookie = l.headers.get('set-cookie').split(';')[0];
  zahleCook = await addCook('أم علي', '+96171100001', 'zahle', ['zahle', 'saadnayel'], { lat: 33.847, lng: 35.903 });
  saadCook = await addCook('رنا', '+96171100002', 'saadnayel', ['zahle', 'saadnayel']);
  tripoliCook = await addCook('سمير', '+96171100003', 'tripoli', ['tripoli']);
});
after(async () => { await app.close(); });

describe('find a cook near me (GPS only, no request text)', () => {
  test('same cooks in the same order as the normal search, and nothing is saved as a request', async () => {
    const pts = [[33.8463, 35.9020], [33.8240, 35.8850], [34.4367, 35.8497], [33.8938, 35.5018]];
    for (const [lat, lng] of pts) {
      const near = await http('GET', `/api/cooks/nearby?lat=${lat}&lng=${lng}`);
      const search = await http('POST', '/api/search', { body: { text: 'بدي طبخة بيتية', location: { type: 'gps', lat, lng } } });
      assert.deepEqual(ids(near), ids(search), `different results at ${lat},${lng}`);
      const d = near.data.cooks.map((c) => c.distanceKm);
      assert.deepEqual(d, [...d].sort((x, y) => x - y));
    }
    const before = (await app.db.one('SELECT COUNT(*) AS n FROM requests')).n;
    await http('GET', '/api/cooks/nearby?lat=33.8463&lng=35.9020');
    assert.equal((await app.db.one('SELECT COUNT(*) AS n FROM requests')).n, before, 'browsing does not create requests');
    assert.equal((await http('GET', '/api/cooks/nearby?lat=999&lng=1')).status, 422);
  });
});

describe('cooks by governorate', () => {
  test('grouped under the right governorate', async () => {
    const r = await http('GET', '/api/cooks/by-region');
    const g = Object.fromEntries(r.data.regions.map((x) => [x.key, x]));
    assert.equal(g.beqaa.name, 'البقاع');
    assert.deepEqual(g.beqaa.cooks.map((c) => c.name).sort(), ['أم علي', 'رنا'].sort());
    assert.deepEqual(g.north.cooks.map((c) => c.name), ['سمير']);
    assert.equal(g.beirut.cooks.length, 0);
    assert.equal(r.data.regions[0].key, 'beirut', 'governorates in a fixed order');
  });
});

describe('dish photos page', () => {
  test('10 at a time, newest first, with "more"', async () => {
    const cc = await cookSession(zahleCook.id, '71100001');
    for (let i = 0; i < 12; i++) await http('POST', '/api/cook/photos', { cookie: cc, body: { data: IMG, caption: `طبق ${i}` } });
    const p1 = await http('GET', '/api/dishes?offset=0&limit=10');
    assert.equal(p1.data.dishes.length, 10);
    assert.equal(p1.data.hasMore, true);
    assert.equal(p1.data.dishes[0].caption, 'طبق 11');
    const p2 = await http('GET', '/api/dishes?offset=10&limit=10');
    assert.equal(p2.data.dishes.length, 2);
    assert.equal(p2.data.hasMore, false);
  });
});

describe('admin: hide and delete accounts', () => {
  test('hidden = gone from the whole public site until shown again', async () => {
    const h = await admin('POST', `/api/admin/cooks/${saadCook.id}/hide`, {});
    assert.equal(Number(h.data.is_hidden), 1);
    const search = await http('POST', '/api/search', { body: { text: 'بدي طبخة بيتية', location: { type: 'area', areaId: A.zahle } } });
    assert.ok(!ids(search).includes(saadCook.id));
    assert.ok(!ids(await http('GET', '/api/cooks/nearby?lat=33.8463&lng=35.9020')).includes(saadCook.id));
    assert.equal((await http('GET', `/api/cooks/${saadCook.id}`)).status, 404);
    assert.equal((await http('GET', `/api/cooks/search?q=${encodeURIComponent('رنا')}`)).data.cooks.length, 0);
    const regions = await http('GET', '/api/cooks/by-region');
    assert.ok(!JSON.stringify(regions.data).includes('"رنا"'));
    const list = await admin('GET', '/api/admin/cooks?filter=hidden');
    assert.deepEqual(list.data.cooks.map((c) => c.id), [saadCook.id]);
    assert.equal(list.data.cooks[0].hidden, true);
    // the cook still has an account and sees why
    const cc = await cookSession(saadCook.id, '71100002');
    assert.equal((await http('GET', '/api/cook/me', { cookie: cc })).data.hidden, true);
    // shown again
    await admin('POST', `/api/admin/cooks/${saadCook.id}/unhide`, {});
    assert.equal((await http('GET', `/api/cooks/${saadCook.id}`)).status, 200);
  });

  test('delete = everything about the account is removed permanently', async () => {
    const cc = await cookSession(tripoliCook.id, '71100003');
    await http('POST', '/api/cook/photos', { cookie: cc, body: { data: IMG } });
    const r = await admin('DELETE', `/api/admin/cooks/${tripoliCook.id}`);
    assert.equal(r.status, 200);
    assert.equal((await admin('GET', `/api/admin/cooks/${tripoliCook.id}`)).status, 404);
    const all = await admin('GET', '/api/admin/cooks?filter=all');
    assert.ok(!all.data.cooks.some((c) => c.id === tripoliCook.id));
    for (const table of ['subscriptions', 'cook_photos', 'cook_service_areas', 'cook_sessions', 'cook_service_types']) {
      const n = await app.db.one(`SELECT COUNT(*) AS n FROM ${table} WHERE cook_id = $1`, [tripoliCook.id]);
      assert.equal(Number(n.n), 0, `${table} not cleaned`);
    }
    assert.equal((await http('GET', '/api/cook/me', { cookie: cc })).status, 401, 'session gone');
    assert.equal((await admin('DELETE', `/api/admin/cooks/${tripoliCook.id}`)).status, 404);
  });
});

describe('admin: moderation & whole-site settings', () => {
  test('hiding a review removes it from the public rating; hiding a photo removes it from pages', async () => {
    const s = await http('POST', `/api/cooks/${zahleCook.id}/request`, { body: { text: 'بدي صينية كبة', lat: 33.8463, lng: 35.9020 } });
    const c = await http('POST', '/api/contact', { body: { requestId: s.data.requestId, cookId: zahleCook.id } });
    await http('POST', '/api/reviews', { body: { token: c.data.reviewToken, rating: 2 } });
    let cook = await admin('GET', `/api/admin/cooks/${zahleCook.id}`);
    assert.equal(cook.data.reviews.length, 1);
    assert.equal((await http('GET', `/api/cooks/${zahleCook.id}`)).data.rating.count, 1);
    await admin('PATCH', `/api/admin/reviews/${cook.data.reviews[0].id}`, { hidden: true });
    assert.equal((await http('GET', `/api/cooks/${zahleCook.id}`)).data.rating.count, 0);

    const photoId = cook.data.photos[0].id;
    await admin('PATCH', `/api/admin/photos/${photoId}`, { hidden: true });
    const dishes = await http('GET', '/api/dishes?offset=0&limit=30');
    assert.ok(!dishes.data.dishes.some((d) => d.id === photoId));
    assert.equal((await fetch(`${base}/media/photos/${photoId}.jpg`)).status, 404);
  });

  test('brand, announcement, admin number and visible sections are controlled from the admin panel', async () => {
    const r = await admin('PUT', '/api/admin/settings', {
      brandName: 'أكلاتك', announcement: 'عروض العيد هذا الأسبوع', adminWhatsapp: '71 222 333', sections: { dishes: false },
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.effectiveAdminWhatsapp, '96171222333');
    const cfg = await http('GET', '/api/config');
    assert.equal(cfg.data.site.announcement, 'عروض العيد هذا الأسبوع');
    assert.equal(cfg.data.site.sections.dishes, false);
    assert.equal(cfg.data.site.sections.nearby, true);
    assert.equal(cfg.data.brand.name, 'أكلاتك');
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes('أكلاتك'), 'brand applied to pages');
    assert.ok(!('adminWhatsapp' in cfg.data.site), 'admin number is never public');
    // back to defaults
    await admin('PUT', '/api/admin/settings', { brandName: '', announcement: '', adminWhatsapp: '', sections: { dishes: true } });
    assert.equal((await http('GET', '/api/config')).data.brand.name, 'Aklatak');
    assert.equal((await admin('PUT', '/api/admin/settings', { adminWhatsapp: 'abc' })).status, 422);
    assert.equal((await http('PUT', '/api/admin/settings', { body: { brandName: 'x' } })).status, 401);
  });
});

describe('pages & brand', () => {
  test('menu pages exist; Aklatak brand and logo everywhere; back button is an arrow only', async () => {
    for (const p of ['/nearby', '/regions', '/dishes', '/', '/join', '/account', '/c/1']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 200, p);
      const html = await res.text();
      assert.ok(html.includes('Aklatak') && !html.includes('سلة تيتا'), `brand on ${p}`);
      assert.ok(html.includes('/assets/logo.svg'), `logo on ${p}`);
      assert.ok(!/nav-back[^>]*>[^<]*<span aria-hidden="true">→<\/span> <span/.test(html), `back text removed on ${p}`);
    }
    const logo = await fetch(base + '/assets/logo.svg');
    assert.equal(logo.status, 200);
  });
});
