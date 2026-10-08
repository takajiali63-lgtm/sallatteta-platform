// v5.1: customer choices (order / order then go / directions / call), shops without WhatsApp (login by name),
// import from the map into categories (any category, any country, optional period), quick hide/delete, Excel export.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { phoneKind } from '../src/services/mapImport.js';

let app, base, ck, z;
const call = async (m, p, body, cookie = ck) => {
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, text, headers: r.headers };
};
// fake Geoapify: one place search + shops around Zahle (and one in Paris for the country check)
const feat = (id, name, cats, lat, lon, phone, cc = 'lb') => ({ properties: { place_id: id, name, categories: cats, lat, lon, country_code: cc, address_line2: 'شارع البولفار', ...(phone ? { contact: { phone } } : {}) } });
const mapFetch = async (url) => {
  const u = new URL(url);
  if (u.pathname === '/v1/geocode/search') {
    const paris = /paris/i.test(u.searchParams.get('text'));
    return new Response(JSON.stringify({ results: [paris ? { formatted: 'Paris, France', lat: 48.8566, lon: 2.3522, country_code: 'fr' } : { formatted: 'زحلة، لبنان', lat: 33.8466, lon: 35.9031, country_code: 'lb' }] }), { status: 200 });
  }
  if (/paris|2\.35/.test(u.searchParams.get('filter') || '')) return new Response(JSON.stringify({ features: [feat('fr1', 'Boulangerie Paul', ['commercial.food_and_drink.bakery'], 48.857, 2.353, '+33 6 12 34 56 78', 'fr')] }), { status: 200 });
  return new Response(JSON.stringify({ features: [
    feat('a1', 'مطعم الضيعة', ['catering', 'catering.restaurant'], 33.848, 35.904, '71 123 456'),
    feat('a2', 'فرن البلد', ['commercial.food_and_drink.bakery'], 33.847, 35.902, '08 812 345'),
    feat('a3', 'صيدلية الشفاء', ['healthcare.pharmacy'], 33.8475, 35.9035, null),
    feat('a4', 'مستشفى تل شيحا', ['healthcare', 'healthcare.hospital'], 33.85, 35.91, null),
    feat('a5', 'Unknown place', ['leisure.park'], 33.849, 35.905, null),
  ] }), { status: 200 });
};

before(async () => {
  app = await createApp({ databaseUrl: 'sqlite::memory:', sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999', geoapifyKey: 'test-key', mapFetch,
    bootstrapAdmin: { username: 'admin', password: 'correct-horse-battery' }, searchLimit: 1e4, applyLimit: 1e4, loginLimit: 1e4, lookupLimit: 1e4,
    placesFetcher: async () => [], geoFetcher: async () => ({ country: 'LB', locality: 'زحلة' }) });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  ck = (await call('POST', '/api/admin/login', { username: 'admin', password: 'correct-horse-battery' }, null)).headers.get('set-cookie').split(';')[0];
  z = (await call('GET', `/api/areas/search?q=${encodeURIComponent('زحلة')}`)).data.areas[0].id;
});
after(async () => { await app.close(); });

test('phone types: Lebanese / French / Gulf mobiles are WhatsApp, landlines are calls, other countries are flagged', () => {
  assert.equal(phoneKind('+96171123456'), 'mobile'); assert.equal(phoneKind('+9613123456'), 'mobile'); assert.equal(phoneKind('+96181123456'), 'mobile');
  assert.equal(phoneKind('+9618812345'), 'landline'); assert.equal(phoneKind('+33612345678'), 'mobile'); assert.equal(phoneKind('+33142000000'), 'landline');
  assert.equal(phoneKind('+971501234567'), 'mobile'); assert.equal(phoneKind('+2348012345678'), 'mobile'); assert.equal(phoneKind('+254712345678'), 'unknown');
});

test('a shop can sign up without a WhatsApp number and sign in with its business name; home cooks always need a number', async () => {
  const base1 = { acceptTerms: true, password: 'bake12345', kind: 'bakery', fullName: 'فرن الأمل', lat: 33.8466, lng: 35.9031, servedAreaIds: [z], plan: 'monthly', startedAt: Date.now() - 5000 };
  const r = await call('POST', '/api/cook-applications', { ...base1, noWhatsapp: true, whatsapp: '' }, null);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const msg = new URL(r.data.whatsappUrl).searchParams.get('text');
  assert.ok(msg.includes('فرن الأمل') && msg.includes('kلمة') === false, msg);
  assert.equal((await call('POST', '/api/cook-applications', { ...base1, noWhatsapp: true, whatsapp: '' }, null)).data.fields?.fullName, 'name_taken');
  const cookTry = await call('POST', '/api/cook-applications', { ...base1, kind: 'cook', fullName: 'أم سامي', noWhatsapp: true, whatsapp: '' }, null);
  assert.equal(cookTry.data.fields?.whatsapp, 'required', 'home cooks must give a number');
  await call('POST', `/api/admin/cooks/${r.data.applicationId}/approve`, {});
  await call('POST', `/api/admin/cooks/${r.data.applicationId}/subscription/activate`, { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() });
  const login = await call('POST', '/api/cook/login', { whatsapp: 'فرن الامل', password: 'bake12345' }, null);
  assert.equal(login.status, 200, 'name login (Arabic, letters normalised)');
  assert.ok(login.headers.get('set-cookie').includes('st_cook='));
  assert.equal((await call('POST', '/api/cook/login', { whatsapp: 'فرن الأمل', password: 'wrong-pass' }, null)).status, 401);
  // customers: no WhatsApp ordering, directions only
  const prof = (await call('GET', `/api/cooks/${r.data.applicationId}`, null, null)).data;
  assert.equal(prof.canOrder, false);
  assert.ok(prof.nav && Math.abs(prof.nav.lat - 33.8466) < 0.001);
  const req = await call('POST', `/api/cooks/${r.data.applicationId}/request`, { lat: 33.8466, lng: 35.9031, startedAt: Date.now() - 5000, website: '' }, null);
  assert.equal((await call('POST', '/api/contact', { requestId: req.data.requestId, cookId: r.data.applicationId }, null)).data.error, 'no_whatsapp');
});

test('directions: every shop with a location gets them, never a home cook', async () => {
  const shop = (await call('POST', '/api/admin/cooks', { kind: 'pharmacy', fullName: 'صيدلية', whatsapp: '+96171555001', areaId: z, lat: 33.847, lng: 35.903, servedAreaIds: [z], activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } })).data;
  const cook = (await call('POST', '/api/admin/cooks', { kind: 'cook', fullName: 'أم علي', whatsapp: '+96171555002', areaId: z, lat: 33.8471, lng: 35.9031, servedAreaIds: [z], activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } })).data;
  const ps = (await call('GET', `/api/cooks/${shop.id}`, null, null)).data;
  assert.ok(ps.nav && ps.canOrder === true);
  assert.equal((await call('GET', `/api/cooks/${cook.id}`, null, null)).data.nav, null, "a home cook's house is never shown");
});

test('import from the map: sorted into categories (incl. one added by the admin), phones classified, publish one or many, optional period, no duplicates, countries separate', async () => {
  const cats = (await call('GET', '/api/admin/settings')).data.categories;
  cats.push({ key: 'hospital', icon: '🏥', home: 'auto', map: 'healthcare.hospital', names: { ar: { one: 'مستشفى', many: 'مستشفيات' }, en: { one: 'Hospital', many: 'Hospitals' } } });
  assert.equal((await call('PUT', '/api/admin/settings', { categories: cats })).status, 200);
  const r = (await call('GET', `/api/admin/import/places?q=${encodeURIComponent('زحلة')}&radius=5`)).data;
  assert.equal(r.place.country, 'LB');
  const g = Object.fromEntries(r.groups.map((x) => [x.key, x.items]));
  assert.equal(g.restaurant[0].phoneKind, 'mobile'); assert.equal(g.restaurant[0].whatsapp, '96171123456');
  assert.equal(g.bakery[0].phoneKind, 'landline'); assert.equal(g.bakery[0].callPhone, '9618812345'); assert.equal(g.bakery[0].whatsapp, null);
  assert.equal(g.pharmacy[0].phoneKind, null);
  assert.equal(g.hospital[0].name, 'مستشفى تل شيحا', 'a category the admin added is imported too');
  assert.ok(!r.groups.some((x) => x.items.some((i) => i.name === 'Unknown place')), 'places outside the categories are ignored');
  // publish one with a 30-day period, then the rest
  const one = await call('POST', '/api/admin/import/places', { items: [g.restaurant[0]], days: 30 });
  assert.equal(one.data.created, 1);
  const all = await call('POST', '/api/admin/import/places', { items: [g.restaurant[0], g.bakery[0], g.pharmacy[0], g.hospital[0]] });
  assert.deepEqual([all.data.created, all.data.skipped], [3, 1], 'the restaurant is not duplicated');
  const again = (await call('GET', `/api/admin/import/places?q=${encodeURIComponent('زحلة')}&radius=5`)).data;
  assert.ok(again.groups.every((x) => x.items.every((i) => i.exists)), 'already-imported shops are marked');
  // customers see them by category, nearest first, with the right options
  const near = (await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=all', null, null)).data.cooks;
  const resto = near.find((c) => c.name === 'مطعم الضيعة'), bakery = near.find((c) => c.name === 'فرن البلد'), hosp = near.find((c) => c.name === 'مستشفى تل شيحا');
  assert.ok(resto.canOrder && resto.nav && resto.fromMap);
  assert.ok(!bakery.canOrder && bakery.callPhone === '9618812345' && bakery.nav);
  assert.ok(hosp && hosp.kind === 'hospital' && !hosp.canOrder && hosp.nav);
  const exp = await app.db.one(`SELECT s.expiry_date FROM subscriptions s JOIN cooks c ON c.id = s.cook_id WHERE c.full_name = 'مطعم الضيعة'`);
  const d = (new Date(exp.expiry_date) - Date.now()) / 864e5;
  assert.ok(d > 29 && d <= 30, 'optional 30-day period');
  // another country stays separate
  const fr = (await call('GET', '/api/admin/import/places?q=Paris&radius=3')).data;
  assert.equal(fr.place.country, 'FR');
  assert.equal(fr.groups.find((x) => x.key === 'bakery').items[0].phoneKind, 'mobile');
  assert.equal((await call('GET', '/api/admin/import/places?q=x', null, null)).status, 401);
});

test('quick hide/delete from the list; Excel export with subscription dates (per country)', async () => {
  const s = (await call('POST', '/api/admin/cooks', { kind: 'bakery', fullName: 'فرن التجربة', whatsapp: '+96171555009', areaId: z, lat: 33.8466, lng: 35.9031, servedAreaIds: [z], activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } })).data;
  assert.equal((await call('POST', `/api/admin/cooks/${s.id}/hide`, {})).status, 200);
  assert.equal((await call('GET', `/api/cooks/${s.id}`, null, null)).status, 404);
  assert.equal((await call('POST', `/api/admin/cooks/${s.id}/unhide`, {})).status, 200);
  const raw = new Uint8Array(await (await fetch(base + '/api/admin/export/subscribers.csv', { headers: { 'X-Requested-With': 'fetch', Cookie: ck } })).arrayBuffer());
  assert.deepEqual([...raw.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'UTF-8 BOM so Excel shows Arabic correctly');
  const csv = await call('GET', '/api/admin/export/subscribers.csv');
  assert.equal(csv.status, 200);
  assert.ok(csv.text.includes('id,name,category,country,area,whatsapp,phone,status,hidden,source,plan,start,expiry,days_left'));
  assert.ok(csv.text.includes('فرن التجربة') && csv.text.includes('+96171555009'));
  const line = csv.text.split('\r\n').find((l) => l.includes('فرن التجربة'));
  assert.ok(/,(29|30|31),/.test(line), line);
  assert.ok(!(await call('GET', '/api/admin/export/subscribers.csv?country=FR')).text.includes('فرن التجربة'));
  assert.equal((await call('DELETE', `/api/admin/cooks/${s.id}`)).status, 200);
  assert.equal((await call('GET', '/api/admin/export/subscribers.csv', null, null)).status, 401);
});
