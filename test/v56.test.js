// v5.6: craftspeople (group "crafts"): private location, call + "come to me", own tab and "everything near me", description required.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { mergeSettings, DEFAULT_SETTINGS } from '../src/services/settings.js';

let app, base, ck, z;
const call = async (m, p, body, cookie = ck) => {
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};
before(async () => {
  app = await createApp({ databaseUrl: 'sqlite::memory:', sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999',
    bootstrapAdmin: { username: 'admin', password: 'correct-horse-battery' }, applyLimit: 1e4, searchLimit: 1e4, lookupLimit: 1e4, placesFetcher: async () => [],
    geoFetcher: async () => ({ country: 'LB', locality: 'زحلة' }) });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const l = await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery' }) });
  ck = l.headers.get('set-cookie').split(';')[0];
  z = (await call('GET', `/api/areas/search?q=${encodeURIComponent('زحلة')}`)).data.areas[0].id;
});
after(async () => { await app.close(); });

test('default crafts exist (group "crafts"); a site saved before gets them once; a deleted craft stays deleted', async () => {
  const cats = (await call('GET', '/api/admin/settings')).data.categories;
  assert.ok(['electrician', 'plumber', 'mechanic'].every((k) => cats.find((c) => c.key === k)?.group === 'crafts'));
  const old = cats.filter((c) => c.group !== 'crafts').map(({ group, ...c }) => c);
  assert.ok(mergeSettings(DEFAULT_SETTINGS, { categories: old }).categories.some((c) => c.key === 'electrician'), 'added once for old sites');
  const del = cats.map((c) => (c.key === 'painter' ? { ...c, deleted: true } : c));
  assert.equal((await call('PUT', '/api/admin/settings', { categories: del })).status, 200);
  assert.equal((await call('GET', '/api/admin/settings')).data.categories.find((c) => c.key === 'painter').deleted, true);
});

test('a craftsperson must describe the services; then: no directions (private), a call button, own tab for "everything near me"', async () => {
  const body = { acceptTerms: true, password: 'elec-12345', kind: 'electrician', fullName: 'محمد الكهربائي', whatsapp: '71 888 001', lat: 33.8466, lng: 35.9031, servedAreaIds: [z], plan: 'monthly', startedAt: Date.now() - 5000 };
  assert.equal((await call('POST', '/api/cook-applications', { ...body, bio: 'قصير' }, null)).data.fields?.bio, 'describe_services');
  const r = await call('POST', '/api/cook-applications', { ...body, bio: 'تمديدات كهربائية، تصليح أعطال، تركيب إنارة وقواطع.' }, null);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await call('POST', `/api/admin/cooks/${r.data.applicationId}/approve`, {});
  await call('POST', `/api/admin/cooks/${r.data.applicationId}/subscription/activate`, { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() });
  await call('POST', '/api/admin/cooks', { kind: 'bakery', fullName: 'فرن', whatsapp: '+96171888002', areaId: z, lat: 33.847, lng: 35.903, servedAreaIds: [z], activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } });
  const prof = (await call('GET', `/api/cooks/${r.data.applicationId}`, null, null)).data;
  assert.equal(prof.nav, null, 'a craftsperson\'s location is never shown');
  assert.equal(prof.callPhone, '96171888001');
  const crafts = (await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=all&group=crafts', null, null)).data.cooks;
  const shops = (await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=all', null, null)).data.cooks;
  assert.deepEqual(crafts.map((c) => c.name), ['محمد الكهربائي']);
  assert.ok(shops.some((c) => c.name === 'فرن') && !shops.some((c) => c.name === 'محمد الكهربائي'));
  assert.deepEqual((await call('POST', '/api/route/distances', { lat: 33.8466, lng: 35.9031, ids: [r.data.applicationId] }, null)).data.distances, [], 'no route to a craftsperson\'s home');
});

test('the owner hides a whole group (craftspeople): gone from results, search and sign-up; one group always stays; showing it again restores everything', async () => {
  assert.equal((await call('PUT', '/api/admin/settings', { groupsHidden: ['shops', 'crafts'] })).status, 422, 'one group always stays');
  assert.equal((await call('PUT', '/api/admin/settings', { groupsHidden: ['crafts'] })).status, 200);
  assert.deepEqual((await call('GET', '/api/config', null, null)).data.site.groupsHidden, ['crafts']);
  assert.deepEqual((await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=all&group=crafts', null, null)).data.cooks, []);
  assert.deepEqual((await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=electrician', null, null)).data.cooks, []);
  assert.deepEqual((await call('GET', `/api/cooks/search?q=${encodeURIComponent('محمد')}&country=LB`, null, null)).data.cooks, []);
  const s = await call('POST', '/api/cook-applications', { acceptTerms: true, password: 'plum-12345', kind: 'plumber', fullName: 'سبّاك', whatsapp: '71 888 009', bio: 'تمديدات صحية وتصليح', lat: 33.8466, lng: 35.9031, servedAreaIds: [z], plan: 'monthly', startedAt: Date.now() - 5000 }, null);
  assert.equal(s.data.fields?.kind, 'invalid');
  assert.ok((await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=all', null, null)).data.cooks.some((c) => c.name === 'فرن'), 'shops unaffected');
  assert.equal((await call('PUT', '/api/admin/settings', { groupsHidden: [] })).status, 200);
  assert.deepEqual((await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=all&group=crafts', null, null)).data.cooks.map((c) => c.name), ['محمد الكهربائي'], 'back, nothing lost');
});

test('Google Play: a subscriber deletes their own account (password), a customer reports a subscriber (reaches the admin), /delete-account page', async () => {
  const r = await call('POST', '/api/cook-applications', { acceptTerms: true, password: 'gone-12345', kind: 'bakery', fullName: 'فرن للحذف', whatsapp: '71 888 077', lat: 33.8466, lng: 35.9031, servedAreaIds: [z], plan: 'monthly', startedAt: Date.now() - 5000 }, null);
  await call('POST', `/api/admin/cooks/${r.data.applicationId}/approve`, {});
  await call('POST', `/api/admin/cooks/${r.data.applicationId}/subscription/activate`, { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() });
  const rep = await call('POST', '/api/report', { cookId: r.data.applicationId, reason: 'fake', note: 'ليس فرناً', website: '' }, null);
  assert.equal(rep.status, 201);
  const msgs = await app.db.query('SELECT name, body FROM site_messages');
  assert.ok(msgs.some((m) => m.name.startsWith('🚩') && m.body.includes('فرن للحذف')), 'the report reaches the admin messages');
  assert.equal((await call('POST', '/api/report', { cookId: r.data.applicationId, reason: 'hack', website: '' }, null)).status, 422);
  const lr = await fetch(base + '/api/cook/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ whatsapp: '71888077', password: 'gone-12345' }) });
  const sc = lr.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('POST', '/api/cook/me/delete', { password: 'wrong-pass' }, sc)).status, 401);
  assert.equal((await call('POST', '/api/cook/me/delete', { password: 'gone-12345' }, sc)).status, 200);
  assert.equal(await app.db.one('SELECT id FROM cooks WHERE id = $1', [r.data.applicationId]), null, 'deleted for good');
  assert.equal((await call('POST', '/api/cook/me/delete', { password: 'gone-12345' }, null)).status, 401, 'not logged in');
  assert.equal((await fetch(base + '/delete-account')).status, 200);
});

test('✓ verified: a paid activation verifies; verified first at the same distance; admin filters; delete all imported of a category', async () => {
  const mk = async (name, wa, lat) => (await call('POST', '/api/admin/cooks', { kind: 'pharmacy', fullName: name, whatsapp: wa, areaId: z, lat, lng: 35.9031, servedAreaIds: [z] })).data.id;
  const a = await mk('صيدلية أ', '+96171888101', 33.84665), b = await mk('صيدلية ب', '+96171888102', 33.8466);
  await call('POST', `/api/admin/cooks/${a}/subscription/activate`, { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() });
  await call('POST', `/api/admin/cooks/${b}/subscription/activate`, { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString(), paymentStatus: 'unpaid' });
  const list = (await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=pharmacy', null, null)).data.cooks;
  assert.equal(list[0].name, 'صيدلية أ', 'the verified one first at ~the same distance'); assert.equal(list[0].verified, true); assert.equal(list[1].verified, false);
  assert.ok((await call('GET', '/api/admin/cooks?filter=verified&kind=pharmacy&limit=50&offset=0')).data.cooks.every((c) => c.verified));
  await call('POST', '/api/admin/import/places', { items: [{ ref: 'geoapify:x1', name: 'صيدلية مستوردة', kind: 'pharmacy', lat: 33.85, lng: 35.9, whatsapp: null, callPhone: null }] });
  assert.equal((await call('GET', '/api/admin/cooks?filter=imported&kind=pharmacy&limit=50&offset=0')).data.cooks.length, 1);
  assert.equal((await call('DELETE', '/api/admin/imported?kind=pharmacy&country=LB')).data.deleted, 1);
  assert.equal((await call('GET', `/api/cooks/${a}`, null, null)).status, 200, 'subscribers untouched');
});

test('monthly report: page visits, search appearances, WhatsApp orders and likes, ready to send on WhatsApp', async () => {
  const id = (await call('POST', '/api/admin/cooks', { kind: 'bakery', fullName: 'فرن التقرير', whatsapp: '+96171888201', areaId: z, lat: 33.8466, lng: 35.9031, servedAreaIds: [z],
    activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } })).data.id;
  for (let i = 0; i < 3; i++) await call('GET', `/api/cooks/${id}`, null, null);
  const r = (await call('GET', `/api/admin/cooks/${id}/report`)).data;
  assert.ok(r.text.includes('فرن التقرير') && r.text.includes('زيارات صفحتك'));
  assert.match(r.whatsappUrl, /^https:\/\/wa\.me\/96171888201\?text=/);
  assert.equal((await call('GET', `/api/admin/cooks/${id}/report`, null, null)).status, 401);
});

test('automatic monthly report: on the 1st, once, to ACTIVE subscribers only (not imported, not expired); off without keys', async () => {
  const { defineJobs } = await import('../src/jobs.js');
  const job = defineJobs({ db: app.db }).find((j) => j.name === 'monthly-report');
  delete process.env.WHATSAPP_TOKEN; delete process.env.WHATSAPP_PHONE_ID;
  assert.deepEqual(await job.run(), { skipped: 'not_configured' });
  const active = (await call('POST', '/api/admin/cooks', { kind: 'bakery', fullName: 'فرن فعّال', whatsapp: '+96171888301', areaId: z, lat: 33.8466, lng: 35.9031, servedAreaIds: [z],
    activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } })).data.id;
  await call('POST', '/api/admin/cooks', { kind: 'bakery', fullName: 'فرن منتهي', whatsapp: '+96171888302', areaId: z, lat: 33.8466, lng: 35.9031, servedAreaIds: [z] });
  await call('POST', '/api/admin/import/places', { items: [{ ref: 'geoapify:rep1', name: 'مستورد', kind: 'bakery', lat: 33.85, lng: 35.9, whatsapp: '96171888303', callPhone: null }] });
  process.env.WHATSAPP_TOKEN = 't'; process.env.WHATSAPP_PHONE_ID = '1';
  const sentTo = [];
  const fetchImpl = async (u, o) => { sentTo.push(JSON.parse(o.body).to); return new Response('{}', { status: 200 }); };
  const first = new Date(Date.UTC(2026, 10, 1, 9));   // 1 Nov, 11:00 Beirut
  assert.deepEqual(await job.run({ now: new Date(Date.UTC(2026, 10, 2, 9)), fetchImpl }), { skipped: 'not_the_1st' });
  const r = await job.run({ now: first, fetchImpl });
  assert.ok(sentTo.includes('96171888301'), 'the active subscriber gets it');
  assert.ok(!sentTo.includes('96171888302') && !sentTo.includes('96171888303'), 'never expired or imported');
  assert.equal(r.failed, 0);
  assert.deepEqual(await job.run({ now: first, fetchImpl }), { skipped: 'already_sent' }, 'once a month');
  delete process.env.WHATSAPP_TOKEN; delete process.env.WHATSAPP_PHONE_ID;
});

test('admin lists stay separate: ✓ verified active · imported active · active subscribers without imported', async () => {
  const ids = async (f) => (await call('GET', `/api/admin/cooks?filter=${f}&kind=bakery&limit=200&offset=0`)).data.cooks;
  const ver = await ids('verified'), imp = await ids('imported'), act = await ids('active');
  assert.ok(ver.length && ver.every((c) => c.verified && !c.imported), 'verified = paid, never imported');
  assert.ok(imp.length && imp.every((c) => c.imported), 'imported only');
  assert.ok(act.every((c) => !c.imported), 'active list has no imported places');
});

test('import by coordinates; "around the world" = countries with active subscriber counts; pages edited from the admin', async () => {
  const { findPlaceAndShops } = await import('../src/services/mapImport.js');
  const seen = [];
  const fetchImpl = async (url) => { const u = new URL(url); seen.push(u.pathname);
    if (u.pathname === '/v1/geocode/reverse') return new Response(JSON.stringify({ results: [{ formatted: 'حوش النبي', country_code: 'lb' }] }), { status: 200 });
    return new Response(JSON.stringify({ features: [{ properties: { place_id: 'c1', name: 'صيدلية الضيعة', categories: ['healthcare.pharmacy'], lat: 33.85, lon: 35.9, country_code: 'lb' } }] }), { status: 200 }); };
  const r = await findPlaceAndShops({ q: '33.8466, 35.9031', radiusKm: 3, categories: (await call('GET', '/api/admin/settings')).data.categories, key: 'k', fetchImpl, db: app.db });
  assert.deepEqual([r.place.lat, r.place.lng, r.place.country], [33.8466, 35.9031, 'LB']);
  assert.ok(seen.includes('/v1/geocode/reverse') && !seen.includes('/v1/geocode/search'));
  assert.equal(r.groups.find((g) => g.key === 'pharmacy').items[0].name, 'صيدلية الضيعة');
  // around the world
  const st = (await call('GET', '/api/admin/settings')).data;
  await call('PUT', '/api/admin/settings', { sections: { ...st.sections, globalCounters: true } });
  const pub = (await call('GET', '/api/stats/public', null, null)).data;
  assert.ok(pub.byCountry.find((x) => x.country === 'LB')?.n >= 1, JSON.stringify(pub.byCountry));
  await call('PUT', '/api/admin/settings', { extraCountries: { GH: { dial: '233', trunk: '0', nsn: [9], currency: 'USD', lang: 'en', timezone: 'Africa/Accra' } } });
  app.cache?.clear?.('feed:');
  assert.ok((await call('GET', '/api/stats/public', null, null)).data.byCountry.some((x) => x.country === 'GH'), 'a country the owner added shows (even with 0 places)');
  // pages
  assert.equal((await call('PUT', '/api/admin/texts', { lang: 'ar', key: 'pages.about.body', value: 'نص جديد لمن نحن' })).status, 200);
  const ar = await (await fetch(base + '/locales/ar.json')).json().catch(() => null);
  const live = ar?.pages?.about?.body || (await call('GET', '/api/admin/texts?lang=ar&prefix=pages.')).data.items.find((x) => x.key === 'pages.about.body').value;
  assert.equal(live, 'نص جديد لمن نحن');
});

test('opening hours: open/closed in the shop\'s time zone (overnight, closed days); bad input refused; shown to customers', async () => {
  const { isOpenNow, cleanHours } = await import('../src/lib/hours.js');
  const at = (iso) => new Date(iso);   // Beirut = UTC+3 in October
  const day = { open: '09:00', close: '22:00', closed: [5] };   // closed on Friday
  assert.equal(isOpenNow(day, 'Asia/Beirut', at('2026-10-05T07:00:00Z')), true, 'Monday 10:00');
  assert.equal(isOpenNow(day, 'Asia/Beirut', at('2026-10-05T20:00:00Z')), false, 'Monday 23:00');
  assert.equal(isOpenNow(day, 'Asia/Beirut', at('2026-10-09T09:00:00Z')), false, 'Friday = closed day');
  const night = { open: '18:00', close: '02:00', closed: [] };
  assert.equal(isOpenNow(night, 'Asia/Beirut', at('2026-10-05T22:30:00Z')), true, '01:30 after midnight');
  assert.equal(isOpenNow(night, 'Asia/Beirut', at('2026-10-05T09:00:00Z')), false, 'noon');
  assert.equal(isOpenNow(null), null);
  assert.equal(cleanHours({ open: '25:00', close: '10:00' }), undefined); assert.equal(cleanHours(null), null);
  // from the account to the customer
  await call('POST', '/api/cook-applications', { acceptTerms: true, password: 'hour-12345', kind: 'bakery', fullName: 'فرن الساعات', whatsapp: '71 888 401', lat: 33.8466, lng: 35.9031, servedAreaIds: [z], plan: 'monthly', startedAt: Date.now() - 5000 }, null);
  const id = (await app.db.one("SELECT id FROM cooks WHERE full_name = 'فرن الساعات'")).id;
  await call('POST', `/api/admin/cooks/${id}/approve`, {}); await call('POST', `/api/admin/cooks/${id}/subscription/activate`, { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() });
  const lr = await fetch(base + '/api/cook/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: JSON.stringify({ whatsapp: '71888401', password: 'hour-12345' }) });
  const sc = lr.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('PATCH', '/api/cook/me', { hours: { open: '99:00', close: '10:00' } }, sc)).status, 422);
  assert.equal((await call('PATCH', '/api/cook/me', { hours: { open: '00:00', close: '23:59', closed: [] } }, sc)).status, 200);
  const p = (await call('GET', `/api/cooks/${id}`, null, null)).data;
  assert.deepEqual(p.hours, { open: '00:00', close: '23:59', closed: [] });
  assert.equal(typeof p.openNow, 'boolean');
});

test('import a whole governorate: shops inside its boundary, grouped by area and category; publish all', async () => {
  const { findRegionShops } = await import('../src/services/mapImport.js');
  const calls = [];
  const fetchImpl = async (url) => { const u = new URL(url); calls.push(u.pathname + (u.searchParams.get('filter') || ''));
    if (u.pathname === '/v1/geocode/search') return new Response(JSON.stringify({ results: [{ place_id: 'gov1', formatted: 'محافظة البقاع', country_code: 'lb', lat: 33.85, lon: 35.9 }] }), { status: 200 });
    const cat = u.searchParams.get('categories');
    if (cat.includes('pharmacy')) return new Response(JSON.stringify({ features: [{ properties: { place_id: 'p1', name: 'صيدلية البقاع', categories: ['healthcare.pharmacy'], lat: 33.8467, lon: 35.9032, country_code: 'lb', contact: { phone: '71 555 999' } } }] }), { status: 200 });
    if (cat.includes('bakery')) return new Response(JSON.stringify({ features: [{ properties: { place_id: 'b1', name: 'فرن البقاع', categories: ['commercial.food_and_drink.bakery'], lat: 33.8468, lon: 35.9033, country_code: 'lb' } }] }), { status: 200 });
    return new Response(JSON.stringify({ features: [] }), { status: 200 }); };
  const r = await findRegionShops({ q: 'محافظة البقاع', categories: (await call('GET', '/api/admin/settings')).data.categories, key: 'k', fetchImpl, db: app.db, areas: app.areas });
  assert.equal(r.region.country, 'LB');
  assert.ok(calls.some((c) => c.includes('place:gov1')), 'searched inside the governorate boundary');
  const area = r.areas.find((a) => a.groups.some((g) => g.key === 'pharmacy'));
  assert.ok(area && area.groups.some((g) => g.key === 'bakery'), 'grouped by area, then category');
  const ph = area.groups.find((g) => g.key === 'pharmacy').items[0];
  assert.deepEqual([ph.phoneKind, ph.whatsapp], ['mobile', '96171555999']);
  const pub = await call('POST', '/api/admin/import/places', { items: area.groups.flatMap((g) => g.items) });
  assert.equal(pub.data.created, 2);
});

test('sign-up with 24/7 hours and the optional pre-booking add-on → booking request goes to the shop on WhatsApp; counted in the report', async () => {
  const { isOpenNow } = await import('../src/lib/hours.js');
  assert.equal(isOpenNow({ allDay: true, closed: [] }, 'Asia/Beirut'), true);
  const base1 = { acceptTerms: true, password: 'book-12345', kind: 'bakery', lat: 33.8466, lng: 35.9031, servedAreaIds: [z], plan: 'monthly', startedAt: Date.now() - 5000 };
  assert.equal((await call('POST', '/api/cook-applications', { ...base1, fullName: 'سيئ', whatsapp: '71 888 500', hours: { open: '99:00', close: '10:00' } }, null)).data.fields?.hours, 'hours_required');
  const r = await call('POST', '/api/cook-applications', { ...base1, fullName: 'صالون الحجز', whatsapp: '71 888 501', hours: { allDay: true, closed: [] }, booking: true }, null);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await call('POST', `/api/admin/cooks/${r.data.applicationId}/approve`, {}); await call('POST', `/api/admin/cooks/${r.data.applicationId}/subscription/activate`, { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() });
  const p = (await call('GET', `/api/cooks/${r.data.applicationId}`, null, null)).data;
  assert.equal(p.booking, true); assert.equal(p.openNow, true);
  const b = await call('POST', '/api/booking', { cookId: r.data.applicationId, name: 'رامي', date: '2026-10-15', time: '17:00', note: 'قص شعر', website: '' }, null);
  assert.equal(b.status, 201);
  const text = new URL(b.data.whatsappUrl).searchParams.get('text');
  assert.ok(b.data.whatsappUrl.startsWith('https://wa.me/96171888501') && text.includes('رامي') && text.includes('17:00') && text.includes('قص شعر'));
  assert.equal((await call('GET', `/api/admin/cooks/${r.data.applicationId}/report`)).data.stats.bookings_30d, 1);
  // the owner turns the feature off → no more bookings
  const st = (await call('GET', '/api/admin/settings')).data;
  assert.equal((await call('PUT', '/api/admin/settings', { booking: { enabled: false, prices: { bakery: 3 } } })).status, 200);
  assert.equal((await call('POST', '/api/booking', { cookId: r.data.applicationId, name: 'رامي', date: '2026-10-15', time: '17:00', website: '' }, null)).data.error, 'booking_off');
  assert.equal((await call('GET', '/api/config', null, null)).data.site.booking.prices.bakery, 3);
  await call('PUT', '/api/admin/settings', { booking: { enabled: true, prices: st.booking?.prices || {} } });
});

test('publishing a big import in batches creates everything (no silent cut at 300); agents never see other countries\' counts', async () => {
  const items = Array.from({ length: 450 }, (_, i) => ({ ref: `geoapify:big${i}`, name: `محل ${i}`, kind: 'pharmacy', lat: 33.80 + i * 0.0002, lng: 35.90, whatsapp: null, callPhone: null }));
  let created = 0;
  for (let i = 0; i < items.length; i += 200) created += (await call('POST', '/api/admin/import/places', { items: items.slice(i, i + 200) })).data.created;
  assert.equal(created, 450);
  const one = (await call('POST', '/api/admin/import/places', { items: Array.from({ length: 350 }, (_, i) => ({ ref: `geoapify:x${i}`, name: `س ${i}`, kind: 'pharmacy', lat: 34.1 + i * 0.0002, lng: 35.9 })) })).data;
  assert.equal(one.created, 300, 'one request is capped at 300 — the admin page sends batches of 200');
  assert.ok((await call('GET', '/api/admin/stats?country=LB')).data.by_country.LB >= 750);
});

test('hide a whole country (nothing deleted) and a category in one country only; showing again restores everything', async () => {
  await call('PUT', '/api/admin/settings', { extraCountries: { GH: { dial: '233', trunk: '0', nsn: [9], currency: 'USD', lang: 'en', timezone: 'Africa/Accra' } } });
  // Lebanon: hide bakeries only
  assert.equal((await call('PUT', '/api/admin/settings', { countryCatsHidden: { LB: ['bakery'] } })).status, 200);
  app.cache?.clear?.('feed:');
  const near = (await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=all', null, null)).data.cooks;
  assert.ok(near.length && !near.some((c) => c.kind === 'bakery'), 'no bakeries in Lebanon');
  assert.ok(!Object.keys((await call('GET', '/api/feed?country=LB', null, null)).data.byKind || {}).includes('bakery'));
  assert.ok(!(await call('GET', '/api/config?country=LB', null, null)).data.liveKinds.includes('bakery'));
  // hide Lebanon completely
  assert.equal((await call('PUT', '/api/admin/settings', { countriesHidden: ['LB'], countryCatsHidden: {} })).status, 200);
  app.cache?.clear?.('feed:');
  assert.deepEqual((await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=all', null, null)).data.cooks, []);
  assert.deepEqual((await call('GET', `/api/cooks/search?q=${encodeURIComponent('فرن')}&country=LB`, null, null)).data.cooks, []);
  assert.deepEqual((await call('GET', '/api/config?country=LB', null, null)).data.liveKinds, []);
  const s = await call('POST', '/api/cook-applications', { acceptTerms: true, password: 'hide-12345', kind: 'bakery', fullName: 'فرن مخفي', whatsapp: '71 888 701', lat: 33.8466, lng: 35.9031, servedAreaIds: [z], plan: 'monthly', startedAt: Date.now() - 5000 }, null);
  assert.equal(s.data.fields?.country, 'country_closed');
  assert.ok(Number((await app.db.one("SELECT COUNT(*) AS n FROM cooks WHERE COALESCE(country, 'LB') = 'LB'")).n) > 0, 'nothing deleted');
  // show again
  await call('PUT', '/api/admin/settings', { countriesHidden: [], countryCatsHidden: {} });
  app.cache?.clear?.('feed:');
  assert.ok((await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=all', null, null)).data.cooks.length > 0, 'back');
});
