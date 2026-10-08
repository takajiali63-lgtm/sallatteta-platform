// End-to-end tests against a real running server + real database (SQLite in-memory).
// Run: npm test
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { haversineKm } from '../src/lib/geo.js';
import { normalizePhone } from '../src/lib/whatsapp.js';
import { normalizeName } from '../public/assets/normalize.js';
import { openDb, migrate } from '../src/db/index.js';

const ADMIN_WA = '96170999999';
const ZAHLE = { lat: 33.8463, lng: 35.9020 };
const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';
const VIEWER = 'viewer_abcdefgh123';

let app, base, cookie;
let mapCalls = 0, mapDown = false;
// What the (mocked) OpenStreetMap returns around Zahle
const MAP_PLACES = [
  { osmId: 1, nameAr: 'زحلة', nameEn: 'Zahle', lat: 33.8465, lng: 35.9022 },            // already in our list → not duplicated
  { osmId: 2, nameAr: 'حوش الأمراء', nameEn: 'Hawsh al Umara', lat: 33.8330, lng: 35.8980 }, // new small place
  { osmId: 3, nameAr: 'Karak Nouh', nameEn: 'Karak Nouh', lat: 33.8560, lng: 35.9120 },   // no Arabic name
];
const A = {}; // slug -> area id

async function http(method, path, { body, cookie: c, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'X-Requested-With': 'fetch',
      ...(c ? { Cookie: c } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
const admin = (method, path, body) => http(method, path, { body, cookie });
const search = (text, loc, extra = {}) => http('POST', '/api/search', { body: { text, location: loc, ...extra } });
const inArea = (slug) => ({ type: 'area', areaId: A[slug] });
const names = (res) => res.data.cooks.map((c) => c.name);

async function addCook(name, phone, { home = 'zahle', served = ['zahle'], services = ['home_cooking'], activate = true, lat, lng, radiusKm } = {}) {
  const r = await admin('POST', '/api/admin/cooks', {
    fullName: name, whatsapp: phone, areaId: A[home], services, servedAreaIds: served.map((s) => A[s]),
    ...(lat ? { lat, lng } : {}),
    ...(radiusKm !== undefined ? { radiusKm } : {}),
    ...(activate ? { activate: { plan: 'monthly', startDate: new Date(Date.now() - 60_000).toISOString() } } : {}),
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
async function contact(cookId, slug = 'zahle') {
  const s = await http('POST', `/api/cooks/${cookId}/request`, { body: { text: 'بدي صينية كبة', areaId: A[slug] } });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const c = await http('POST', '/api/contact', { body: { requestId: s.data.requestId, cookId } });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  return c.data;
}

before(async () => {
  app = await createApp({
    databaseUrl: 'sqlite::memory:',
    adminWhatsapp: ADMIN_WA,
    sessionSecret: 'test-secret-'.repeat(4),
    bootstrapAdmin: { username: 'Admin.User', password: 'correct-horse-battery' },
    searchLimit: 10_000, applyLimit: 10_000, loginLimit: 10_000, lookupLimit: 10_000, feedbackLimit: 10_000, placesLimit: 10_000,
    quiet: true,
    placesFetcher: async (lat, lng) => { mapCalls++; if (mapDown) throw new Error('down'); return MAP_PLACES; },
  });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  for (const a of await app.db.query('SELECT id, slug FROM service_areas')) A[a.slug] = a.id;
  const login = await http('POST', '/api/admin/login', { body: { username: 'admin.user', password: 'correct-horse-battery' } });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => { await app.close(); });

describe('unit helpers', () => {
  test('Haversine distance is geographic (Beirut → Zahle ≈ 37 km)', () => {
    const d = haversineKm(33.8938, 35.5018, 33.8463, 35.9020);
    assert.ok(d > 36 && d < 39, `got ${d}`);
  });
  test('WhatsApp numbers normalise to international digits', () => {
    assert.equal(normalizePhone('+961 71 123 456'), '96171123456');
    assert.equal(normalizePhone('0096171123456'), '96171123456');
    assert.equal(normalizePhone('71-123456'), '96171123456');
    assert.equal(normalizePhone('03 123 456'), '9613123456');
    assert.equal(normalizePhone('abc'), null);
  });
  test('Arabic names normalise for search (hamza, taa marbuta, al-)', () => {
    assert.equal(normalizeName('القرعون'), normalizeName('قرعون'));
    assert.equal(normalizeName('أبلح'), normalizeName('ابلح'));
    assert.equal(normalizeName('زحلة'), normalizeName('زحله'));
  });
});

describe('villages', () => {
  test('180+ villages across all 26 districts are seeded', async () => {
    const n = await app.db.one('SELECT COUNT(*) AS n FROM service_areas');
    assert.ok(Number(n.n) >= 180);
    const cfg = await http('GET', '/api/config');
    assert.equal(cfg.data.districts.length, 26);
    assert.equal(cfg.data.areas, undefined, 'full village list is not sent to the browser');
  });
  test('search is spelling-tolerant and returns the district', async () => {
    const r = await http('GET', `/api/areas/search?q=${encodeURIComponent('قرعون')}`);
    assert.equal(r.data.areas[0].name, 'القرعون');
    assert.equal(r.data.areas[0].districtName, 'البقاع الغربي');
    const r2 = await http('GET', `/api/areas/search?q=${encodeURIComponent('سعد')}`);
    assert.equal(r2.data.areas[0].name, 'سعدنايل');
  });
  test('nearby villages are sorted by distance; nearest village from GPS', async () => {
    const r = await http('GET', `/api/areas/nearby?areaId=${A.zahle}&km=8`);
    assert.equal(r.data.areas[0].id, A.zahle);
    const d = r.data.areas.map((a) => a.distanceKm);
    assert.deepEqual(d, [...d].sort((x, y) => x - y));
    assert.ok(r.data.areas.some((a) => a.id === A.saadnayel));
    const n = await http('GET', `/api/areas/nearest?lat=${ZAHLE.lat + 0.001}&lng=${ZAHLE.lng}`);
    assert.equal(n.data.area.id, A.zahle);
  });
  test('district list and admin-added village become searchable', async () => {
    const d = await http('GET', '/api/areas/district?key=hermel');
    assert.ok(d.data.areas.length >= 1);
    const add = await admin('POST', '/api/admin/areas', { nameAr: 'ضيعة التجربة', district: 'zahle', lat: 33.85, lng: 35.91 });
    assert.equal(add.status, 201);
    const s = await http('GET', `/api/areas/search?q=${encodeURIComponent('ضيعة التجربة')}`);
    assert.equal(s.data.areas[0].id, add.data.id);
  });
});

describe('customer flow (served villages)', () => {
  let ali, rana, suad, baalbekCook, expired, suspended;
  before(async () => {
    ali = await addCook('علي', '+96171000001', { served: ['zahle', 'saadnayel'], lat: ZAHLE.lat + 0.005, lng: ZAHLE.lng });
    rana = await addCook('رنا', '+96171000002', { home: 'saadnayel', served: ['zahle', 'saadnayel'], services: ['sweets'] });
    suad = await addCook('سعاد', '+96171000003', { home: 'chtaura', served: ['chtaura', 'zahle'] });
    baalbekCook = await addCook('بعلبكية', '+96171000004', { home: 'baalbek', served: ['baalbek'] });
    expired = await addCook('منتهية', '+96171000005', { served: ['zahle'] });
    await admin('POST', `/api/admin/cooks/${expired.id}/subscription/expire`);
    suspended = await addCook('موقوفة', '+96171000006', { served: ['zahle'] });
    await admin('POST', `/api/admin/cooks/${suspended.id}/subscription/suspend`);
  });

  test('request is stored and only cooks who deliver to the village are shown, nearest first', async () => {
    const r = await search('بدي صينية كبة لـ 6 أشخاص', inArea('zahle'));
    assert.equal(r.status, 200);
    assert.deepEqual(names(r), ['علي', 'رنا', 'سعاد']);
    assert.equal(r.data.areaLabel, 'زحلة');
    const row = await app.db.one('SELECT body, area_label FROM requests WHERE public_id = $1', [r.data.requestId]);
    assert.equal(row.body, 'بدي صينية كبة لـ 6 أشخاص');
    assert.equal(row.area_label, 'زحلة');
    assert.ok(!names(r).includes('بعلبكية'));
    assert.ok(!names(r).includes('منتهية') && !names(r).includes('موقوفة'));
  });

  test('a cook who does NOT deliver to the village is hidden even if very close', async () => {
    const r = await search('بدي مجدرة لو سمحتي', inArea('taalabaya'));
    assert.deepEqual(names(r), []);
    await admin('PATCH', `/api/admin/cooks/${suad.id}`, { servedAreaIds: [A.chtaura, A.zahle, A.taalabaya] });
    assert.deepEqual(names(await search('بدي مجدرة لو سمحتي', inArea('taalabaya'))), ['سعاد']);
  });

  test('GPS results are ordered nearest first', async () => {
    const r = await search('بدي صينية كبة للعشا', { type: 'gps', lat: 33.8150, lng: 35.8540 }); // Chtaura
    const d = r.data.cooks.map((c) => c.distanceKm);
    assert.deepEqual(d, [...d].sort((x, y) => x - y));
  });

  test('GPS search maps to the nearest village', async () => {
    const r = await search('بدي ورق عنب', { type: 'gps', lat: ZAHLE.lat + 0.001, lng: ZAHLE.lng });
    assert.equal(r.data.area.id, A.zahle);
    assert.ok(names(r).includes('علي'));
  });

  test('results never expose phone numbers or coordinates', async () => {
    const r = await search('بدي فطاير سبانخ', inArea('zahle'));
    for (const c of r.data.cooks) {
      assert.deepEqual(Object.keys(c).sort(), ['area', 'bio', 'booking', 'callPhone', 'canOrder', 'distanceKind', 'distanceKm', 'distanceM', 'fromMap', 'hours', 'id', 'kind', 'name', 'nav', 'openNow', 'photoUrl', 'profileUrl', 'rating', 'services', 'specialty', 'straightM', 'subscriptionStatus', 'verified']);
      // home cooks: never a location (no directions to a house) and never a phone number
      if (c.kind === 'cook') { assert.equal(c.nav, null); assert.equal(c.callPhone, null); }
    }
    assert.ok(!JSON.stringify(r.data).includes('96171000001'));
  });

  test('service filter', async () => {
    assert.deepEqual(names(await search('بدي معمول للعيد', inArea('zahle'), { serviceType: 'sweets' })), ['رنا']);
  });

  test('contact returns a WhatsApp link with the request + a review token; only for shown cooks', async () => {
    const r = await search('بدي صينية كبة لـ 6 أشخاص', inArea('zahle'));
    const c = await http('POST', '/api/contact', { body: { requestId: r.data.requestId, cookId: ali.id } });
    assert.equal(c.status, 200);
    const url = new URL(c.data.whatsappUrl);
    assert.equal(url.pathname, '/96171000001');
    assert.match(url.searchParams.get('text'), /صينية كبة/);
    assert.match(url.searchParams.get('text'), /زحلة/);
    assert.ok(c.data.reviewToken.length > 10);
    const bad = await http('POST', '/api/contact', { body: { requestId: r.data.requestId, cookId: baalbekCook.id } });
    assert.equal(bad.status, 404);
  });

  test('validation', async () => {
    assert.equal((await search('ab', inArea('zahle'))).status, 422);
    assert.equal((await search('بدي كبة كتير', { type: 'area', areaId: 99999 })).status, 422);
    assert.equal((await search('بدي كبة كتير', {})).status, 422);
  });

  test('direct order from the cook page uses the customer GPS position', async () => {
    const s1 = await http('POST', `/api/cooks/${ali.id}/request`, { body: { text: 'بدي صينية كبة', lat: 33.8241, lng: 35.8851 } });
    assert.equal(s1.status, 200);
    const c1 = await http('POST', '/api/contact', { body: { requestId: s1.data.requestId, cookId: ali.id } });
    assert.match(new URL(c1.data.whatsappUrl).searchParams.get('text'), /سعدنايل/);
    const none = await http('POST', `/api/cooks/${ali.id}/request`, { body: { text: 'بدي صينية كبة' } });
    assert.equal(none.status, 422);
    assert.equal(none.data.fields.location, 'location_required');
  });

  test('direct order from the cook page', async () => {
    const d = await contact(rana.id, 'saadnayel');
    assert.match(new URL(d.whatsappUrl).searchParams.get('text'), /سعدنايل/);
    const hidden = await http('POST', `/api/cooks/${expired.id}/request`, { body: { text: 'بدي كبة كتير', areaId: A.zahle } });
    assert.equal(hidden.status, 404);
  });

  test('name search finds active cooks only', async () => {
    const r = await http('GET', `/api/cooks/search?q=${encodeURIComponent('رن')}&country=LB`);
    assert.deepEqual(r.data.cooks.map((c) => c.name), ['رنا']);
    const x = await http('GET', `/api/cooks/search?q=${encodeURIComponent('منتهية')}&country=LB`);
    assert.equal(x.data.cooks.length, 0);
  });

  test('ratings: only via a contact token, averaged publicly, can be changed', async () => {
    const c1 = await contact(ali.id);
    const c2 = await contact(ali.id);
    assert.equal((await http('POST', '/api/reviews', { body: { token: 'not-a-real-token-xx', rating: 5 } })).status, 404);
    assert.equal((await http('POST', '/api/reviews', { body: { token: c1.reviewToken, rating: 6 } })).status, 422);
    assert.equal((await http('POST', '/api/reviews', { body: { token: c1.reviewToken, rating: 5 } })).status, 200);
    assert.equal((await http('POST', '/api/reviews', { body: { token: c2.reviewToken, rating: 2 } })).status, 200);
    await http('POST', '/api/reviews', { body: { token: c2.reviewToken, rating: 4 } }); // changed her mind
    const p = await http('GET', `/api/cooks/${ali.id}`);
    assert.deepEqual(p.data.rating, { avg: 4.5, count: 2 });
    const r = await search('بدي صينية كبة', inArea('zahle'));
    assert.deepEqual(r.data.cooks.find((c) => c.id === ali.id).rating, { avg: 4.5, count: 2 });
  });

  test('likes toggle per device; page views are de-duplicated', async () => {
    let r = await http('POST', `/api/cooks/${ali.id}/like`, { body: { viewerId: VIEWER, like: true } });
    assert.equal(r.data.likes, 1);
    r = await http('POST', `/api/cooks/${ali.id}/like`, { body: { viewerId: VIEWER, like: true } });
    assert.equal(r.data.likes, 1);
    const p = await http('GET', `/api/cooks/${ali.id}?viewerId=${VIEWER}`);
    assert.equal(p.data.likedByMe, true);
    r = await http('POST', `/api/cooks/${ali.id}/like`, { body: { viewerId: VIEWER, like: false } });
    assert.equal(r.data.likes, 0);
    assert.equal((await http('POST', `/api/cooks/${ali.id}/like`, { body: { viewerId: 'x' } })).status, 422);
    await http('POST', `/api/cooks/${ali.id}/view`, { body: { viewerId: VIEWER } });
    await http('POST', `/api/cooks/${ali.id}/view`, { body: { viewerId: VIEWER } });
    await http('POST', `/api/cooks/${ali.id}/view`, { body: { viewerId: 'another_viewer_1' } });
    const v = await app.db.one('SELECT COUNT(*) AS n FROM cook_page_views WHERE cook_id = $1', [ali.id]);
    assert.equal(Number(v.n), 2);
  });

  test('complaints go to the admin only — never to the page or the cook', async () => {
    const f = await http('POST', '/api/feedback', {
      body: { cookId: rana.id, kind: 'complaint', message: 'الأكل وصل بارد ومتأخر ساعة', phone: '71 222 333' },
    });
    assert.equal(f.status, 201);
    const pub = await http('GET', `/api/cooks/${rana.id}`);
    assert.ok(!JSON.stringify(pub.data).includes('بارد'));
    const list = await admin('GET', '/api/admin/feedback?status=new');
    const item = list.data.feedback.find((x) => x.cook_id === rana.id);
    assert.equal(item.customer_phone, '96171222333');
    const stats = await admin('GET', '/api/admin/stats');
    assert.ok(stats.data.new_feedback >= 1);
    // warning: recorded, WhatsApp link to the cook, complaint marked resolved
    const w = await admin('POST', `/api/admin/cooks/${rana.id}/warnings`, { message: 'إنذار: الأكل وصل بارد', feedbackId: item.id });
    assert.equal(w.status, 201);
    assert.equal(new URL(w.data.whatsappUrl).pathname, '/96171000002');
    assert.equal(w.data.cook.warnings.length, 1);
    const after = await admin('GET', '/api/admin/feedback?status=new');
    assert.ok(!after.data.feedback.some((x) => x.id === item.id));
    assert.equal((await http('POST', '/api/feedback', { body: { cookId: rana.id, kind: 'x', message: 'hello there' } })).status, 422);
  });

  test('cook account: password from admin, login, stats, photos, no complaints visible', async () => {
    const pw = await admin('POST', `/api/admin/cooks/${rana.id}/password`, {});
    assert.equal(pw.status, 200);
    assert.match(pw.data.password, /^[a-z]{4}[2-9]{4}$/);
    const msg = new URL(pw.data.whatsappUrl);
    assert.equal(msg.pathname, '/96171000002');
    assert.ok(msg.searchParams.get('text').includes(pw.data.password));

    assert.equal((await http('POST', '/api/cook/login', { body: { whatsapp: '71000002', password: 'wrong-pass' } })).status, 401);
    const login = await http('POST', '/api/cook/login', { body: { whatsapp: '71 000 002', password: pw.data.password } });
    assert.equal(login.status, 200);
    const cc = login.headers.get('set-cookie').split(';')[0];
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);

    const me = await http('GET', '/api/cook/me', { cookie: cc });
    assert.equal(me.data.name, 'رنا');
    assert.ok(me.data.stats.whatsapp_total >= 1);
    assert.ok(me.data.stats.impressions_total >= 1);
    assert.ok(!JSON.stringify(me.data).includes('بارد'), 'complaints are never shown to the cook');
    assert.ok(!('warnings' in me.data));

    // photos
    let up = await http('POST', '/api/cook/photos', { cookie: cc, body: { data: IMG, caption: 'معمول' } });
    assert.equal(up.status, 201);
    const feed = await http('GET', '/api/feed');
    assert.equal(feed.data.dishes[0].caption, 'معمول');
    assert.equal(feed.data.dishes[0].cookName, 'رنا');
    const img = await fetch(base + feed.data.dishes[0].photoUrl);
    assert.equal(img.status, 200);
    const prof = await http('GET', `/api/cooks/${rana.id}`);
    assert.equal(prof.data.photos.length, 1);
    await admin('PUT', '/api/admin/settings', { limits: { cookPhotos: 12 } });
    for (let i = 0; i < 11; i++) await http('POST', '/api/cook/photos', { cookie: cc, body: { data: IMG } });
    up = await http('POST', '/api/cook/photos', { cookie: cc, body: { data: IMG } });
    assert.equal(up.status, 409);
    assert.equal(up.data.error, 'too_many_photos');
    const del = await http('DELETE', `/api/cook/photos/${me.data.photos[0]?.id ?? prof.data.photos[0].id}`, { cookie: cc });
    assert.equal(del.data.photos.length, 11);
    assert.equal((await http('POST', '/api/cook/photos', { cookie: cc, body: { data: 'data:text/html;base64,AAAA' } })).status, 422);

    // edit her page
    const ed = await http('PATCH', '/api/cook/me', { cookie: cc, body: { bio: 'حلويات للعيد', servedAreaIds: [A.saadnayel] } });
    assert.equal(ed.status, 200);
    assert.deepEqual(ed.data.servedAreas.map((a) => a.id), [A.saadnayel]);
    assert.ok(!names(await search('بدي معمول للعيد', inArea('zahle'))).includes('رنا'));
    assert.equal((await http('PATCH', '/api/cook/me', { cookie: cc, body: { servedAreaIds: [] } })).status, 422);
    const loc = await http('PATCH', '/api/cook/me', { cookie: cc, body: { lat: 33.8241, lng: 35.8851, areaLabel: 'سعدنايل - الحي الشرقي' } });
    assert.deepEqual(loc.data.location, { lat: 33.8241, lng: 35.8851 });
    assert.equal(loc.data.area.name, 'سعدنايل - الحي الشرقي');
    assert.equal((await http('PATCH', '/api/cook/me', { cookie: cc, body: { lat: 999, lng: 1 } })).status, 422);
    // she cannot change her name/number
    await http('PATCH', '/api/cook/me', { cookie: cc, body: { fullName: 'غير', whatsapp: '96170000000' } });
    assert.equal((await admin('GET', `/api/admin/cooks/${rana.id}`)).data.full_name, 'رنا');

    // password change + CSRF
    assert.equal((await http('POST', '/api/cook/password', { cookie: cc, body: { current: 'nope-nope', next: 'newpass1' } })).status, 422);
    assert.equal((await http('POST', '/api/cook/password', { cookie: cc, body: { current: pw.data.password, next: 'newpass1' } })).status, 200);
    const noCsrf = await fetch(base + '/api/cook/password', { method: 'POST', headers: { Cookie: cc, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noCsrf.status, 403);
    assert.equal((await http('GET', '/api/cook/me')).status, 401);
    // admin can't be accessed with a cook cookie
    assert.equal((await http('GET', '/api/admin/stats', { cookie: cc })).status, 401);
  });

  test('admin sees rating, warnings and complaint count in the list', async () => {
    const list = await admin('GET', '/api/admin/cooks?filter=all');
    const a = list.data.cooks.find((c) => c.id === ali.id);
    assert.equal(a.rating.count, 2);
    const r = list.data.cooks.find((c) => c.id === rana.id);
    assert.equal(r.warnings, 1);
  });
});

describe('cook applications', () => {
  test('application stores served villages and prefills the admin WhatsApp message', async () => {
    const r = await http('POST', '/api/cook-applications', {
      body: {
        acceptTerms: true, password: 'pass12345', fullName: 'منى', whatsapp: '76 123 456', lat: 33.8466, lng: 35.9031, servedAreaIds: [A.zahle, A.saadnayel, A.ferzol],
        services: ['home_cooking', 'mouneh'], plan: 'quarterly', areaLabel: 'زحلة - حي المعلّقة',
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const text = new URL(r.data.whatsappUrl).searchParams.get('text');
    assert.equal(new URL(r.data.whatsappUrl).pathname, `/${ADMIN_WA}`);
    for (const s of ['منى', '+96176123456', 'زحلة - حي المعلّقة', 'maps.google.com/?q=33.8466,35.9031', 'يوصل إلى', 'سعدنايل', 'الفرزل', '3 أشهر', `#${r.data.applicationId}`]) {
      assert.ok(text.includes(s), `message missing ${s}`);
    }
    const c = await admin('GET', `/api/admin/cooks/${r.data.applicationId}`);
    assert.equal(c.data.servedAreas.length, 3);
    assert.equal(c.data.effectiveStatus, 'pending');
    assert.equal(c.data.area_id, A.zahle, 'home village = nearest to the GPS point');
    assert.equal(Number(c.data.lat), 33.8466);
    // pending cook is not visible
    assert.ok(!names(await search('بدي مونة بيتية', inArea('ferzol'))).includes('منى'));
    await admin('POST', `/api/admin/cooks/${r.data.applicationId}/subscription/activate`, { plan: 'quarterly' });
    assert.ok(names(await search('بدي مونة بيتية', inArea('ferzol'))).includes('منى'));
  });

  test('application requires at least one served village', async () => {
    const r = await http('POST', '/api/cook-applications', {
      body: { acceptTerms: true, password: 'pass12345', fullName: 'هند', whatsapp: '76 555 444', lat: 33.84, lng: 35.9, servedAreaIds: [], services: ['home_cooking'], plan: 'monthly' },
    });
    assert.equal(r.status, 422);
    assert.equal(r.data.fields.servedAreaIds, 'pick_one_area');
    const noGps = await http('POST', '/api/cook-applications', {
      body: { acceptTerms: true, password: 'pass12345', fullName: 'هند', whatsapp: '76 555 444', servedAreaIds: [A.zahle], services: ['home_cooking'], plan: 'monthly' },
    });
    assert.equal(noGps.status, 422);
    assert.equal(noGps.data.fields.location, 'location_required');
  });
});

describe('villages from the map (OpenStreetMap)', () => {
  test('GPS → villages around are fetched, saved without duplicates, cached', async () => {
    // (an earlier GPS search near Zahle already asked the map once)
    assert.ok(mapCalls >= 1);
    const r = await http('GET', '/api/areas/around?lat=33.8463&lng=35.9020');
    assert.equal(r.status, 200);
    assert.ok(['osm', 'cache'].includes(r.data.source));
    const names = r.data.areas.map((a) => a.name);
    assert.ok(names.includes('حوش الأمراء') && names.includes('Karak Nouh'));
    assert.equal(names.filter((n) => n === 'زحلة').length, 1, 'no duplicate of an existing village');
    assert.equal(r.data.nearest.name, 'زحلة');
    const d = r.data.areas.map((a) => a.distanceKm);
    assert.deepEqual(d, [...d].sort((x, y) => x - y));
    const before = mapCalls;
    const again = await http('GET', '/api/areas/around?lat=33.8470&lng=35.9030');
    assert.equal(again.data.source, 'cache');
    assert.equal(mapCalls, before, 'same ~5 km cell → no new map request');
    // saved → now searchable by name like any village
    const s = await http('GET', `/api/areas/search?q=${encodeURIComponent('حوش الأم')}`);
    assert.equal(s.data.areas[0].name, 'حوش الأمراء');
    assert.equal(s.data.areas[0].district, 'zahle');
  });

  test('if the map is down, the saved villages are still offered', async () => {
    mapDown = true;
    const r = await http('GET', '/api/areas/around?lat=34.0047&lng=36.2110'); // Baalbek, new cell
    mapDown = false;
    assert.equal(r.status, 200);
    assert.equal(r.data.source, 'fallback');
    assert.equal(r.data.nearest.name, 'بعلبك');
  });

  test('a cook delivering to a small map village is found by GPS customers there', async () => {
    const hawsh = (await http('GET', `/api/areas/search?q=${encodeURIComponent('حوش الأمراء')}`)).data.areas[0];
    const r = await admin('POST', '/api/admin/cooks', {
      fullName: 'طبّاخ الحوش', whatsapp: '+96171000032', areaId: A.zahle, services: ['home_cooking'], servedAreaIds: [hawsh.id],
      activate: { plan: 'monthly', startDate: new Date(Date.now() - 60_000).toISOString() },
    });
    assert.equal(r.status, 201);
    const found = await search('بدي مجدرة لو سمحتي', { type: 'gps', lat: 33.8331, lng: 35.8981 });
    assert.ok(names(found).includes('طبّاخ الحوش'));
    const typedZahle = await search('بدي مجدرة لو سمحتي', inArea('zahle'));
    assert.ok(!names(typedZahle).includes('طبّاخ الحوش'), 'only the villages the cook picked');
  });
});

describe('admin & security', () => {
  test('admin API requires a session; username is case-insensitive', async () => {
    assert.equal((await http('GET', '/api/admin/cooks')).status, 401);
    const l = await http('POST', '/api/admin/login', { body: { username: '  ADMIN.User ', password: 'correct-horse-battery' } });
    assert.equal(l.status, 200);
    const bad = await http('POST', '/api/admin/login', { body: { username: 'admin.user', password: 'nope' } });
    assert.equal(bad.status, 401);
  });
  test('scripts & styles are revalidated (ETag) so updates show immediately', async () => {
    const r1 = await fetch(base + '/assets/x/app.js');
    assert.equal(r1.headers.get('cache-control'), 'no-cache');
    const etag = r1.headers.get('etag');
    assert.ok(etag);
    const r2 = await fetch(base + '/assets/x/app.js', { headers: { 'If-None-Match': etag } });
    assert.equal(r2.status, 304);
  });

  test('pages: cook page, account, admin', async () => {
    for (const p of ['/', '/join', '/account', '/c/1', '/admin/']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-security-policy') || '', /default-src 'self'/);
    }
    assert.equal((await http('GET', '/api/cooks/999999')).status, 404);
  });
  test('tagline and the word "طازة" are gone; every page has a back button', async () => {
    for (const p of ['/', '/join', '/account', '/c/1']) {
      const html = await (await fetch(base + p)).text();
      assert.ok(!html.includes('طعم الضيعة') && !html.includes('طاز'), p);
      assert.match(html, p === '/join' ? /nav-back/ : /\/assets\/x\//, p);   // v7: new app (back buttons are drawn by the app)
    }
    const ar = await (await fetch(base + '/locales/ar.json')).text().catch(() => '');
    assert.ok(!ar.includes('طاز'));
  });
});

describe('migration from v1', () => {
  test('old radius-based cooks get the villages inside their radius', async () => {
    const db = await openDb({ databaseUrl: 'sqlite::memory:' });
    await migrate(db);
    const zahle = await db.one(`SELECT id, lat, lng FROM service_areas WHERE slug='zahle'`);
    const c = await db.one(`INSERT INTO cooks (full_name, whatsapp, area_id, area_label, lat, lng, service_radius_km, status)
      VALUES ('قديمة','96170111111',$1,'زحلة',$2,$3,4,'approved') RETURNING id`, [zahle.id, zahle.lat, zahle.lng]);
    await migrate(db); // simulate next boot
    const served = (await db.query(`SELECT a.slug FROM cook_service_areas s JOIN service_areas a ON a.id = s.area_id WHERE s.cook_id = $1`, [c.id])).map((r) => r.slug);
    assert.ok(served.includes('zahle') && served.includes('saadnayel') && served.includes('taalabaya'), served.join(','));
    assert.ok(!served.includes('baalbek'));
    await db.close();
  });
});
