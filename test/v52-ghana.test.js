// v5.2 — a new country added from the admin panel (Ghana), fully separate from the others,
// and country agents who only manage their own country.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { normalizePhone, getCountry } from '../src/lib/countries.js';
import { phoneKind } from '../src/services/mapImport.js';

const ACCRA = { lat: 5.6037, lng: -0.1870 };
let app, base, owner, agent, gh1, lbShop, z;
const call = async (m, p, body, cookie = owner, headers = {}) => {
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, text, headers: r.headers };
};
const login = async (u, p) => (await call('POST', '/api/admin/login', { username: u, password: p }, null)).headers.get('set-cookie')?.split(';')[0];
const mapFetch = async (url) => {
  const u = new URL(url);
  if (u.pathname === '/v1/geocode/search') return new Response(JSON.stringify({ results: [{ formatted: 'Accra, Ghana', lat: ACCRA.lat, lon: ACCRA.lng, country_code: 'gh' }] }), { status: 200 });
  return new Response(JSON.stringify({ features: [
    { properties: { place_id: 'gh-1', name: 'Kofi Bakery', categories: ['commercial.food_and_drink.bakery'], lat: 5.605, lon: -0.186, country_code: 'gh', contact: { phone: '024 412 3457' } } },
    { properties: { place_id: 'gh-2', name: 'Osu Pharmacy', categories: ['healthcare.pharmacy'], lat: 5.556, lon: -0.182, country_code: 'gh', contact: { phone: '030 277 1234' } } },
  ] }), { status: 200 });
};

before(async () => {
  app = await createApp({ databaseUrl: 'sqlite::memory:', sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999', geoapifyKey: 'k', mapFetch,
    bootstrapAdmin: { username: 'owner', password: 'owner-password-1' }, searchLimit: 1e4, applyLimit: 1e4, loginLimit: 1e4, lookupLimit: 1e4,
    placesFetcher: async () => [], geoFetcher: async (lat) => (lat < 20 ? { country: 'GH', regionName: 'Greater Accra', locality: 'Accra' } : { country: 'LB', locality: 'زحلة' }) });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  owner = await login('owner', 'owner-password-1');
  // Ghana's towns (in production they come from "Import towns" — OpenStreetMap)
  for (const [slug, name, lat, lng] of [['gh-accra', 'Accra', 5.6037, -0.1870], ['gh-osu', 'Osu', 5.556, -0.182], ['gh-tema', 'Tema', 5.6698, -0.0166]]) {
    await app.db.query('INSERT INTO service_areas (slug, name_ar, name_en, lat, lng, country) VALUES ($1,$2,$2,$3,$4,$5)', [slug, name, lat, lng, 'GH']);
  }
  await app.areas.load();
  z = (await call('GET', `/api/areas/search?q=${encodeURIComponent('زحلة')}`)).data.areas[0].id;
});
after(async () => { await app.close(); });

test('the owner adds Ghana from the admin panel; built-in countries cannot be overwritten; bad data refused', async () => {
  assert.equal(getCountry('GH'), null, 'not built in');
  assert.equal((await call('PUT', '/api/admin/settings', { extraCountries: { LB: { dial: '1', nsn: [9], currency: 'USD', lang: 'en', timezone: 'UTC' } } })).status, 422);
  assert.equal((await call('PUT', '/api/admin/settings', { extraCountries: { GH: { dial: '233', nsn: [9], currency: 'USD', lang: 'en', timezone: 'Not/AZone' } } })).status, 422);
  const ok = await call('PUT', '/api/admin/settings', { extraCountries: { GH: { dial: '233', trunk: '0', nsn: [9], currency: 'USD', lang: 'en', timezone: 'Africa/Accra' } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(getCountry('GH').dial, '233');
  assert.equal(normalizePhone('024 412 3456', 'GH'), '233244123456');
  assert.equal(phoneKind('233244123456'), 'mobile'); assert.equal(phoneKind('233302771234'), 'landline');
  const cfg = (await call('GET', '/api/config?country=GH', null, null)).data;
  assert.equal(cfg.country.code, 'GH'); assert.equal(cfg.country.lang, 'en'); assert.equal(cfg.billing.currency, 'USD');
  assert.ok(cfg.countries.includes('GH'));
  // survives a restart (stored in the settings)
  await app.settings.load();
  assert.equal(getCountry('GH').timezone, 'Africa/Accra');
});

test('a bakery in Accra signs up in Ghana; a customer in Accra finds it; a customer in Zahle does not (and vice versa)', async () => {
  const r = await call('POST', '/api/cook-applications', { acceptTerms: true, password: 'kofi-12345', kind: 'bakery', fullName: 'Ama Bakery', whatsapp: '024 412 3456',
    lat: ACCRA.lat, lng: ACCRA.lng, servedAreaIds: [app.areas.nearest(ACCRA.lat, ACCRA.lng).id], plan: 'monthly', startedAt: Date.now() - 5000 }, null, { 'X-Locale': 'en' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.country, 'GH');
  gh1 = r.data.applicationId;
  const row = await app.db.one('SELECT whatsapp, country FROM cooks WHERE id = $1', [gh1]);
  assert.deepEqual([row.whatsapp, row.country], ['233244123456', 'GH']);
  await call('POST', `/api/admin/cooks/${gh1}/approve`, {});
  await call('POST', `/api/admin/cooks/${gh1}/subscription/activate`, { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() });
  lbShop = (await call('POST', '/api/admin/cooks', { kind: 'bakery', fullName: 'فرن زحلة', whatsapp: '+96171666111', areaId: z, lat: 33.8466, lng: 35.9031, servedAreaIds: [z],
    activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } })).data.id;
  const accra = (await call('GET', `/api/cooks/nearby?lat=${ACCRA.lat}&lng=${ACCRA.lng}&type=all`, null, null)).data.cooks.map((c) => c.name);
  const zahle = (await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=all', null, null)).data.cooks.map((c) => c.name);
  assert.ok(accra.includes('Ama Bakery') && !accra.includes('فرن زحلة'));
  assert.ok(zahle.includes('فرن زحلة') && !zahle.includes('Ama Bakery'));
  // the home feed is per country too
  const feedGH = (await call('GET', '/api/feed?country=GH', null, null)).data;
  assert.ok(JSON.stringify(feedGH).includes('Ama Bakery') && !JSON.stringify(feedGH).includes('فرن زحلة'));
});

test('import from the map in Accra: Ghana mobiles are WhatsApp, landlines are calls, shops get country GH', async () => {
  const r = (await call('GET', '/api/admin/import/places?q=Accra&radius=10')).data;
  assert.equal(r.place.country, 'GH');
  const bakery = r.groups.find((g) => g.key === 'bakery').items[0];
  const pharmacy = r.groups.find((g) => g.key === 'pharmacy').items[0];
  assert.deepEqual([bakery.phoneKind, bakery.whatsapp], ['mobile', '233244123457']);
  assert.deepEqual([pharmacy.phoneKind, pharmacy.callPhone], ['landline', '233302771234']);
  const p = await call('POST', '/api/admin/import/places', { items: [bakery, pharmacy] });
  assert.equal(p.data.created, 2);
  const rows = await app.db.query(`SELECT full_name, country FROM cooks WHERE source = 'map'`);
  assert.ok(rows.every((x) => x.country === 'GH'), JSON.stringify(rows));
});

test('a Ghana agent sees and manages only Ghana; owner-only actions are refused; the owner manages agents', async () => {
  assert.equal((await call('POST', '/api/admin/agents', { username: 'agent.gh', password: 'short', country: 'GH' })).status, 422);
  const a = await call('POST', '/api/admin/agents', { username: 'agent.gh', password: 'ghana-agent-2026', country: 'GH' });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  agent = await login('agent.gh', 'ghana-agent-2026');
  const me = (await call('GET', '/api/admin/me', null, agent)).data;
  assert.deepEqual([me.role, me.country], ['agent', 'GH']);
  // lists and numbers are always Ghana, even if the page asks for Lebanon
  const list = (await call('GET', '/api/admin/cooks?filter=all&kind=bakery&country=LB&limit=50&offset=0', null, agent)).data.cooks;
  assert.ok(list.length >= 1 && list.every((c) => c.country === 'GH'), JSON.stringify(list.map((c) => c.country)));
  const st = (await call('GET', '/api/admin/stats', null, agent)).data;
  assert.equal(st.country, 'GH'); assert.ok(st.by_kind.bakery.active >= 1); assert.equal(st.searches_total, 0);
  // another country's subscriber: refused
  assert.equal((await call('GET', `/api/admin/cooks/${lbShop}`, null, agent)).data.error, 'other_country');
  assert.equal((await call('DELETE', `/api/admin/cooks/${lbShop}`, null, agent)).status, 403);
  // owner-only actions: refused
  for (const [m, p, b] of [['PUT', '/api/admin/settings', { announcement: 'x' }], ['GET', '/api/admin/agents'], ['GET', '/api/admin/export/subscribers.csv'],
    ['POST', '/api/admin/banners', { image: 'x' }], ['PUT', '/api/admin/texts', { lang: 'en', key: 'home.allNear', value: 'x' }], ['GET', '/api/admin/import/places?q=Accra'],
    ['POST', '/api/admin/cooks', { fullName: 'x' }], ['PATCH', `/api/admin/cooks/${gh1}`, { fullName: 'x' }], ['POST', `/api/admin/cooks/${gh1}/password`, {}], ['GET', '/api/admin/backup']]) {
    const r = await call(m, p, b, agent);
    assert.equal(r.status, 403, `${m} ${p} → ${r.status}`);
  }
  // his own actions: allowed
  assert.equal((await call('POST', `/api/admin/cooks/${gh1}/subscription/suspend`, {}, agent)).status, 200);
  assert.equal((await call('POST', `/api/admin/cooks/${gh1}/subscription/activate`, { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() }, agent)).status, 200);
  const pend = await call('POST', '/api/cook-applications', { acceptTerms: true, password: 'tema-12345', kind: 'bakery', fullName: 'Tema Bread', whatsapp: '055 123 4567',
    lat: 5.6698, lng: -0.0166, servedAreaIds: [app.areas.nearest(5.6698, -0.0166).id], plan: 'monthly', startedAt: Date.now() - 5000 }, null);
  assert.equal(pend.status, 201, JSON.stringify(pend.data));
  const pendingList = (await call('GET', '/api/admin/cooks?filter=pending&kind=bakery&limit=50&offset=0', null, agent)).data.cooks;
  assert.ok(pendingList.some((c) => c.id === pend.data.applicationId), 'the agent sees Ghana join requests');
  assert.equal((await call('POST', `/api/admin/cooks/${pend.data.applicationId}/approve`, {}, agent)).status, 200);
  assert.equal((await call('DELETE', `/api/admin/cooks/${pend.data.applicationId}`, null, agent)).status, 200);
  // the owner removes the agent: his session ends
  await call('DELETE', `/api/admin/agents/${a.data.id}`, null, owner);
  assert.equal((await call('GET', '/api/admin/me', null, agent)).status, 401);
});
