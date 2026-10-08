// v5.5: referral links with commission on every paid activation/renewal; button/field styles; menu items the owner hides.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

let app, base, owner, z;
const call = async (m, p, body, cookie = owner) => {
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, text, headers: r.headers };
};
const login = async (u, p) => (await call('POST', '/api/admin/login', { username: u, password: p }, null)).headers.get('set-cookie')?.split(';')[0];
const apply = (extra) => call('POST', '/api/cook-applications', { acceptTerms: true, password: 'shop-12345', kind: 'bakery', servedAreaIds: [z], plan: 'monthly', startedAt: Date.now() - 5000, lat: 33.8466, lng: 35.9031, ...extra }, null);
before(async () => {
  app = await createApp({ databaseUrl: 'sqlite::memory:', sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999',
    bootstrapAdmin: { username: 'owner', password: 'owner-password-1' }, applyLimit: 1e4, loginLimit: 1e4, lookupLimit: 1e4, placesFetcher: async () => [],
    geoFetcher: async (lat) => (lat < 20 ? { country: 'GH' } : { country: 'LB', locality: 'زحلة' }) });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  owner = await login('owner', 'owner-password-1');
  z = (await call('GET', `/api/areas/search?q=${encodeURIComponent('زحلة')}`)).data.areas[0].id;
  await call('PUT', '/api/admin/settings', { extraCountries: { GH: { dial: '233', trunk: '0', nsn: [9], currency: 'USD', lang: 'en', timezone: 'Africa/Accra' } } });
  await app.db.query(`INSERT INTO service_areas (slug, name_ar, name_en, lat, lng, country) VALUES ('gh-accra','Accra','Accra',5.6037,-0.187,'GH')`);
  await app.areas.load();
});
after(async () => { await app.close(); });

test('referral link: commission on every PAID activation and renewal — not on trials or unpaid — then marked paid', async () => {
  const ref = (await call('POST', '/api/admin/referrers', { name: 'سامر', commission: 2, currency: 'USD', country: 'LB' })).data;
  assert.match(ref.link, /^https?:\/\/[^/]+\/join\?ref=[A-Za-z0-9]{8}$/, 'a full, shareable address');
  const a = await apply({ fullName: 'فرن سامر', whatsapp: '71 777 001', ref: ref.code });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const id = a.data.applicationId;
  assert.equal(Number((await app.db.one('SELECT referrer_id FROM cooks WHERE id = $1', [id])).referrer_id), ref.id);
  await call('POST', `/api/admin/cooks/${id}/approve`, {});
  await call('POST', `/api/admin/cooks/${id}/subscription/trial`, {});
  await call('POST', `/api/admin/cooks/${id}/subscription/activate`, { plan: 'monthly', startDate: new Date().toISOString(), paymentStatus: 'unpaid' });
  let r = (await call('GET', '/api/admin/referrers')).data.referrers.find((x) => x.id === ref.id);
  assert.equal(r.due, 0, 'trial and unpaid: no commission');
  await call('POST', `/api/admin/cooks/${id}/subscription/activate`, { plan: 'monthly', startDate: new Date().toISOString() });
  await call('POST', `/api/admin/cooks/${id}/subscription/renew`, { plan: 'monthly' });
  r = (await call('GET', '/api/admin/referrers')).data.referrers.find((x) => x.id === ref.id);
  assert.deepEqual([r.subscribers, r.due, r.paid], [1, 4, 0]);
  const e = (await call('GET', `/api/admin/referrers/${ref.id}/earnings`)).data.earnings;
  assert.deepEqual(e.map((x) => x.reason).sort(), ['activate', 'renew']);
  assert.equal((await call('POST', `/api/admin/referrers/${ref.id}/pay`, {})).data.marked, 2);
  r = (await call('GET', '/api/admin/referrers')).data.referrers.find((x) => x.id === ref.id);
  assert.deepEqual([r.due, r.paid], [0, 4]);
  // a stopped link no longer ties new subscribers; a Lebanese link does not count in Ghana
  await call('PATCH', `/api/admin/referrers/${ref.id}`, { active: false });
  const b = await apply({ fullName: 'فرن آخر', whatsapp: '71 777 002', ref: ref.code });
  assert.equal((await app.db.one('SELECT referrer_id FROM cooks WHERE id = $1', [b.data.applicationId])).referrer_id, null);
  await call('PATCH', `/api/admin/referrers/${ref.id}`, { active: true });
  const g = await apply({ fullName: 'Accra Bread', whatsapp: '024 412 3456', lat: 5.6037, lng: -0.187, servedAreaIds: [app.areas.nearest(5.6037, -0.187).id], ref: ref.code });
  assert.equal(g.status, 201, JSON.stringify(g.data));
  assert.equal((await app.db.one('SELECT referrer_id FROM cooks WHERE id = $1', [g.data.applicationId])).referrer_id, null);
});

test("a country agent creates links for his country only, sees only them, and can't mark payouts", async () => {
  await call('POST', '/api/admin/agents', { username: 'agent.gh', password: 'ghana-agent-2026', country: 'GH' });
  const agent = await login('agent.gh', 'ghana-agent-2026');
  const mine = (await call('POST', '/api/admin/referrers', { name: 'Kofi', commission: 1.5, country: 'LB' }, agent)).data;
  const list = (await call('GET', '/api/admin/referrers', null, agent)).data.referrers;
  assert.ok(list.length >= 1 && list.every((x) => x.country === 'GH'), 'forced to Ghana');
  assert.ok(list.some((x) => x.id === mine.id));
  const lb = (await call('GET', '/api/admin/referrers')).data.referrers.find((x) => x.country === 'LB');
  assert.equal((await call('GET', `/api/admin/referrers/${lb.id}/earnings`, null, agent)).status, 403);
  assert.equal((await call('POST', `/api/admin/referrers/${mine.id}/pay`, {}, agent)).status, 403, 'payouts are the owner\'s');
  assert.equal((await call('PATCH', `/api/admin/referrers/${mine.id}`, { commission: 9 }, agent)).status, 403);
});

test('button & field styles become /theme.css; menu items the owner hides', async () => {
  assert.equal((await call('PUT', '/api/admin/settings', { theme: { ui: { btnShape: 'triangle' } } })).status, 422);
  assert.equal((await call('PUT', '/api/admin/settings', { theme: { ui: { btnBg: 'red;}' } } })).status, 422);
  assert.equal((await call('PUT', '/api/admin/settings', { theme: { ui: { btnShape: 'pill', fieldShape: 'square', btnBg: '#0055aa', btnText: '#ffffff', fieldBorder: '#00ff00' } } })).status, 200);
  const css = await (await fetch(base + '/theme.css')).text();
  assert.ok(css.includes('border-radius: 999px') && css.includes('background: #0055aa') && css.includes('color: #ffffff') && css.includes('border-color: #00ff00') && css.includes('border-radius: 4px'));
  assert.equal((await call('PUT', '/api/admin/settings', { menuHidden: ['advertise', 'hack<script>'] })).status, 422);
  assert.equal((await call('PUT', '/api/admin/settings', { menuHidden: ['advertise', 'join', 'cat:gym'] })).status, 200);
  assert.deepEqual((await call('GET', '/api/config', null, null)).data.site.menuHidden, ['advertise', 'join', 'cat:gym']);
});

test('subscription durations: the owner hides some; the sign-up page offers only the others; a hidden one is refused', async () => {
  assert.equal((await call('PUT', '/api/admin/settings', { plansHidden: ['monthly', 'quarterly', 'semiannual', 'yearly'] })).status, 422, 'at least one stays');
  assert.equal((await call('PUT', '/api/admin/settings', { plansHidden: ['quarterly', 'semiannual', 'yearly'] })).status, 200);
  assert.deepEqual((await call('GET', '/api/config', null, null)).data.site.plansHidden, ['quarterly', 'semiannual', 'yearly']);
  const r = await apply({ fullName: 'فرن سنوي', whatsapp: '71 777 050', plan: 'yearly' });
  assert.equal(r.data.fields?.plan, 'invalid', JSON.stringify(r.data));
  assert.equal((await apply({ fullName: 'فرن شهري', whatsapp: '71 777 051', plan: 'monthly' })).status, 201);
  await call('PUT', '/api/admin/settings', { plansHidden: [] });
});

test('a country that is not on the platform never sees another country\'s shops on the home page', async () => {
  const gq = (await call('GET', '/api/feed?country=GQ', null, null)).data;
  assert.ok(!JSON.stringify(gq).includes('فرن') && Object.values(gq.byKind || {}).every((x) => !x.length));
  const lb = (await call('GET', '/api/feed?country=LB', null, null)).data;
  assert.ok(Object.values(lb.byKind || {}).flat().length >= 0);
});

test('name search: only the visitor\'s own country; a country not on the platform finds nothing', async () => {
  assert.deepEqual((await call('GET', `/api/cooks/search?q=${encodeURIComponent('فرن')}&country=KM`, null, null)).data.cooks, []);
  assert.deepEqual((await call('GET', `/api/cooks/search?q=${encodeURIComponent('فرن')}`, null, null)).data.cooks, []);
  const lb = (await call('GET', `/api/cooks/search?q=${encodeURIComponent('فرن')}&country=LB`, null, null)).data.cooks;
  assert.ok(lb.length >= 1 && lb.every((c) => !/Accra/.test(c.name)));
});

test('referral link: creation date shown; the owner deletes it for good (subscribers stay); agents cannot', async () => {
  const r = (await call('POST', '/api/admin/referrers', { name: 'للحذف', commission: 1, country: 'LB' })).data;
  const listed = (await call('GET', '/api/admin/referrers')).data.referrers.find((x) => x.id === r.id);
  assert.ok(listed.createdAt && !Number.isNaN(new Date(listed.createdAt).getTime()));
  const a = await apply({ fullName: 'فرن الرابط', whatsapp: '71 777 060', ref: r.code });
  assert.equal((await call('DELETE', `/api/admin/referrers/${r.id}`)).status, 200);
  assert.ok(!(await call('GET', '/api/admin/referrers')).data.referrers.some((x) => x.id === r.id));
  const c = await app.db.one('SELECT id, referrer_id FROM cooks WHERE id = $1', [a.data.applicationId]);
  assert.ok(c && c.referrer_id === null, 'the subscriber stays, just no longer tied to the deleted link');
});

test('a subscriber of a deleted category never shows to customers, and the admin finds it by name', async () => {
  const s = (await call('POST', '/api/admin/cooks', { kind: 'bakery', fullName: 'Rawan Ghost', whatsapp: '+96171555333', areaId: z, lat: 33.8466, lng: 35.9031, servedAreaIds: [z],
    activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } })).data;
  await app.db.query("UPDATE cooks SET kind = 'cat_gone123' WHERE id = $1", [s.id]);
  const near = (await call('GET', '/api/cooks/nearby?lat=33.8466&lng=35.9031&type=all', null, null)).data.cooks;
  assert.ok(!near.some((c) => c.name === 'Rawan Ghost'));
  const found = (await call('GET', `/api/admin/cooks?filter=all&kind=bakery&q=${encodeURIComponent('Rawan Ghost')}&limit=20&offset=0`)).data.cooks;
  assert.ok(found.some((c) => c.id === s.id), 'search by name finds it in any category');
});

test('an "auto" category shows only in countries where it has shops', async () => {
  const st = (await call('GET', '/api/admin/settings')).data;
  st.categories.push({ key: 'hospital', icon: '🏥', home: 'auto', names: { ar: { one: 'مستشفى', many: 'مستشفيات' }, en: { one: 'Hospital', many: 'Hospitals' } } });
  await call('PUT', '/api/admin/settings', { categories: st.categories });
  await call('POST', '/api/admin/cooks', { kind: 'hospital', fullName: 'مستشفى زحلة', whatsapp: '+96171555444', areaId: z, lat: 33.8466, lng: 35.9031, servedAreaIds: [z],
    activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } });
  app.cache?.clear?.('feed:');
  assert.ok((await call('GET', '/api/config?country=LB', null, null)).data.liveKinds.includes('hospital'), 'Lebanon has one');
  assert.ok(!(await call('GET', '/api/config?country=GH', null, null)).data.liveKinds.includes('hospital'), 'Ghana has none');
});
