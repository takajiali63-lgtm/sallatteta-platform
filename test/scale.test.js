// Tests for the "scale" features: object storage for images, admin pagination, gzip, country import.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';
let app, base, cookie;
const s3Calls = [];

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

before(async () => {
  app = await createApp({
    databaseUrl: 'sqlite::memory:', adminWhatsapp: '96170999999', sessionSecret: 'x'.repeat(40), quiet: true,
    bootstrapAdmin: { username: 'admin', password: 'correct-horse-battery' },
    searchLimit: 1e4, applyLimit: 1e4, loginLimit: 1e4, lookupLimit: 1e4, placesLimit: 1e4,
    placesFetcher: async () => [],
    countryPlacesFetcher: async (iso) => [
      { osmId: 901, nameAr: 'ضيعة من الاستيراد', nameEn: 'Imported Village', lat: 33.95, lng: 35.95 },
      { osmId: 902, nameAr: 'زحلة', nameEn: 'Zahle', lat: 33.8466, lng: 35.9021 }, // already known → skipped
    ],
    s3: { endpoint: 'https://acc.r2.cloudflarestorage.com', bucket: 'teta', accessKeyId: 'AK', secretAccessKey: 'SK', publicUrl: 'https://img.example.com', region: 'auto' },
    storageFetch: async (url, opts) => { s3Calls.push({ url, method: opts.method, auth: opts.headers.Authorization, type: opts.headers['content-type'] }); return new Response('', { status: 200 }); },
  });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const l = await http('POST', '/api/admin/login', { body: { username: 'admin', password: 'correct-horse-battery' } });
  cookie = l.headers.get('set-cookie').split(';')[0];
});
after(async () => { await app.close(); });

const admin = (m, p, b) => http(m, p, { body: b, cookie });
const zahle = async () => (await http('GET', `/api/areas/search?q=${encodeURIComponent('زحلة')}`)).data.areas[0].id;

describe('images on object storage (Cloudflare R2 / S3)', () => {
  test('uploads go to storage, pages link the CDN, deleting removes the file', async () => {
    assert.equal(app.storage.kind, 's3');
    const z = await zahle();
    const c = await admin('POST', '/api/admin/cooks', {
      fullName: 'ذات صور', whatsapp: '+96171555000', areaId: z, services: ['home_cooking'], servedAreaIds: [z], photo: IMG,
      activate: { plan: 'monthly', startDate: new Date(Date.now() - 60_000).toISOString() },
    });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    assert.match(c.data.photo_url, /^https:\/\/img\.example\.com\/cooks\//);
    const put = s3Calls.find((x) => x.method === 'PUT');
    assert.match(put.url, /^https:\/\/acc\.r2\.cloudflarestorage\.com\/teta\/cooks\//);
    assert.match(put.auth, /^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request/);
    assert.equal(put.type, 'image/jpeg');

    const pw = await admin('POST', `/api/admin/cooks/${c.data.id}/password`, {});
    const login = await http('POST', '/api/cook/login', { body: { whatsapp: '71555000', password: pw.data.password } });
    const cc = login.headers.get('set-cookie').split(';')[0];
    const up = await http('POST', '/api/cook/photos', { cookie: cc, body: { data: IMG, caption: 'كبة' } });
    assert.equal(up.status, 201);
    const photo = up.data.photos[0];
    assert.match(photo.url, /^https:\/\/img\.example\.com\/dishes\//);

    const feed = await http('GET', '/api/feed');
    assert.match(feed.data.dishes[0].photoUrl, /^https:\/\/img\.example\.com\//);
    assert.match(feed.data.cooks[0].photoUrl, /^https:\/\/img\.example\.com\//);
    const row = await app.db.one('SELECT data FROM cook_photos WHERE id = $1', [photo.id]);
    assert.equal(row.data, '', 'image bytes are not kept in the database');

    const r = await fetch(`${base}/media/photos/${photo.id}.jpg`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), photo.url);

    await http('DELETE', `/api/cook/photos/${photo.id}`, { cookie: cc });
    assert.ok(s3Calls.some((x) => x.method === 'DELETE' && x.url.includes('/teta/dishes/')));
  });
});

describe('admin list scales (SQL pagination & filters)', () => {
  test('pages of results with total and hasMore; search by name uses the normalised index', async () => {
    const z = await zahle();
    for (let i = 0; i < 5; i++) {
      await admin('POST', '/api/admin/cooks', { fullName: `طبّاخ رقم ${i}`, whatsapp: `+9617160000${i}`, areaId: z, services: ['home_cooking'], servedAreaIds: [z] });
    }
    const p1 = await admin('GET', '/api/admin/cooks?filter=all&limit=2&offset=0');
    assert.equal(p1.data.cooks.length, 2);
    assert.ok(p1.data.total >= 6);
    assert.equal(p1.data.hasMore, true);
    const p2 = await admin('GET', '/api/admin/cooks?filter=all&limit=2&offset=2');
    assert.notEqual(p2.data.cooks[0].id, p1.data.cooks[0].id);
    const s = await admin('GET', `/api/admin/cooks?filter=all&q=${encodeURIComponent('رقم 3')}`);
    assert.equal(s.data.total, 1);
    assert.equal(s.data.cooks[0].fullName, 'طبّاخ رقم 3');
    const byPhone = await admin('GET', '/api/admin/cooks?filter=all&q=71600004');
    assert.equal(byPhone.data.cooks[0].fullName, 'طبّاخ رقم 4');
    const active = await admin('GET', '/api/admin/cooks?filter=active');
    assert.ok(active.data.cooks.every((c) => c.effectiveStatus === 'active'));
    const none = await admin('GET', '/api/admin/cooks?filter=no_subscription');
    assert.ok(none.data.total >= 5);
  });
});

describe('speed', () => {
  test('text responses are gzip-compressed', async () => {
    const r = await fetch(base + '/assets/x/app.js', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(r.headers.get('content-encoding'), 'gzip');
    assert.match(await r.text(), /import/); // still decodes fine
    const j = await fetch(base + '/api/areas/district?key=zahle', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(j.headers.get('content-encoding'), 'gzip');
    assert.ok((await j.json()).areas.length > 5);
  });
});

describe('precise villages for the whole country', () => {
  test('admin imports every village of Lebanon in the background, without duplicates', async () => {
    const start = await admin('POST', '/api/admin/areas/import', { country: 'LB' });
    assert.equal(start.status, 202);
    let st;
    for (let i = 0; i < 50; i++) {
      st = await admin('GET', '/api/admin/areas/import?country=LB');
      if (st.data.state !== 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(st.data.state, 'done');
    assert.equal(st.data.found, 2);
    assert.equal(st.data.added, 1);
    const s = await http('GET', `/api/areas/search?q=${encodeURIComponent('ضيعة من الاست')}`);
    assert.equal(s.data.areas[0].name, 'ضيعة من الاستيراد');
  });
});
