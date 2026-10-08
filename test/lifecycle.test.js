// End-to-end business flows through the real HTTP API (the same calls the web app and future mobile apps make).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

let app, base, admin;
const req = async (method, path, body, cookie) => {
  const r = await fetch(base + path, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
  return { status: r.status, data, headers: r.headers };
};
const ZAHLE = { lat: 33.8466, lng: 35.9031 };
const gpsSearch = () => req('POST', '/api/v1/search', { text: 'بدي صينية كبة لـ 8 أشخاص نهار الجمعة', location: { type: 'gps', ...ZAHLE } });
const names = (r) => r.data.cooks.map((c) => c.name);

before(async () => {
  app = await createApp({ databaseUrl: 'sqlite::memory:', sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96176691688',
    bootstrapAdmin: { username: 'ali.takaji', password: 'correct-horse-battery' }, rateLimitScale: 1000, placesFetcher: async () => [] });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const l = await req('POST', '/api/v1/admin/login', { username: 'Ali.Takaji', password: 'correct-horse-battery' });
  admin = l.headers.get('set-cookie').split(';')[0];
});
after(async () => { await app.close(); });

describe('cook lifecycle', () => {
  let cookId;
  test('application → pending (not visible)', async () => {
    const zahle = (await req('GET', `/api/v1/areas/nearest?lat=${ZAHLE.lat}&lng=${ZAHLE.lng}`)).data.area;
    const r = await req('POST', '/api/v1/cook-applications', { acceptTerms: true, password: 'pass12345', fullName: 'أم علي', whatsapp: '71 000 111', ...ZAHLE, servedAreaIds: [zahle.id], services: ['home_cooking'], plan: 'monthly' });
    assert.equal(r.status, 201);
    cookId = r.data.applicationId;
    assert.equal(new URL(r.data.whatsappUrl).pathname, '/96176691688');
    assert.equal((await req('GET', `/api/v1/admin/cooks/${cookId}`, null, admin)).data.effectiveStatus, 'pending');
    assert.ok(!names(await gpsSearch()).includes('أم علي'));
  });
  test('admin approval + subscription → active → appears in search', async () => {
    await req('POST', `/api/v1/admin/cooks/${cookId}/approve`, {}, admin);
    const a = await req('POST', `/api/v1/admin/cooks/${cookId}/subscription/activate`, { plan: 'monthly', startDate: new Date(Date.now() - 60_000).toISOString() }, admin);
    assert.equal(a.data.effectiveStatus, 'active');
    assert.ok(names(await gpsSearch()).includes('أم علي'));
  });
  test('the order reaches the cook on WhatsApp exactly as written', async () => {
    const s = await gpsSearch();
    const c = await req('POST', '/api/v1/contact', { requestId: s.data.requestId, cookId });
    const u = new URL(c.data.whatsappUrl);
    assert.equal(u.host, 'wa.me');
    assert.equal(u.pathname, '/96171000111');
    assert.ok(u.searchParams.get('text').includes('بدي صينية كبة لـ 8 أشخاص نهار الجمعة'));
  });
  test('subscription ends → disappears automatically (background job)', async () => {
    await app.db.query(`UPDATE subscriptions SET expiry_date = $1 WHERE cook_id = $2`, [new Date(Date.now() - 1000).toISOString(), cookId]);
    assert.ok(!names(await gpsSearch()).includes('أم علي'), 'hidden immediately (search checks dates live)');
    await app.jobs.runNow('expire-subscriptions');
    assert.equal((await req('GET', `/api/v1/admin/cooks/${cookId}`, null, admin)).data.effectiveStatus, 'expired');
  });
  test('renewal → appears again', async () => {
    const r = await req('POST', `/api/v1/admin/cooks/${cookId}/subscription/renew`, { plan: 'quarterly' }, admin);
    assert.equal(r.data.effectiveStatus, 'active');
    assert.ok(names(await gpsSearch()).includes('أم علي'));
  });
  test('suspend → hidden; reactivate → visible; reject → hidden', async () => {
    await req('POST', `/api/v1/admin/cooks/${cookId}/subscription/suspend`, {}, admin);
    assert.ok(!names(await gpsSearch()).includes('أم علي'));
    await req('POST', `/api/v1/admin/cooks/${cookId}/subscription/activate`, { plan: 'monthly' }, admin);
    assert.ok(names(await gpsSearch()).includes('أم علي'));
    await req('POST', `/api/v1/admin/cooks/${cookId}/reject`, {}, admin);
    assert.ok(!names(await gpsSearch()).includes('أم علي'));
  });
  test('sensitive admin actions are audited', async () => {
    const rows = await app.db.query('SELECT action FROM admin_actions WHERE cook_id = $1 ORDER BY id', [cookId]);
    const actions = rows.map((r) => r.action);
    for (const a of ['approve', 'activate', 'renew', 'suspend', 'reject']) assert.ok(actions.includes(a), a);
  });
});
