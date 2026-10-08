// Cloudflare R2 (S3-compatible): new photos go to storage, existing ones are moved from the admin panel,
// pages are allowed to show them (CSP), and nothing is lost if storage can't serve a file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { defineJobs } from '../src/jobs.js';
import { createStorage } from '../src/services/storage.js';

const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';
let r2, r2Base, app, base, ck, z;
const objects = new Map();
let refuse = false;                       // simulate "uploaded but not reachable"
const call = async (m, p, body, cookie = ck) => {
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
};

before(async () => {
  // a tiny R2 look-alike: PUT /bucket/key (signed), public GET/HEAD /key
  r2 = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
      if (req.method === 'PUT') {
        if (!String(req.headers.authorization || '').startsWith('AWS4-HMAC-SHA256')) { res.writeHead(403); return res.end(); }
        objects.set(req.url.replace(/^\/photos-bucket\//, '/'), Buffer.concat(chunks)); res.writeHead(200); return res.end();
      }
      const key = req.url.replace(/^\/pub/, '');
      if (!refuse && objects.has(key)) { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(req.method === 'HEAD' ? undefined : objects.get(key)); }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => r2.listen(0, r));
  r2Base = `http://127.0.0.1:${r2.address().port}`;
  // photos first saved in the database (storage off) …
  app = await createApp({ databaseUrl: `sqlite:/tmp/r2-${Date.now()}.db`, sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999',
    bootstrapAdmin: { username: 'admin', password: 'correct-horse-battery' }, placesFetcher: async () => [] });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  ck = (await call('POST', '/api/admin/login', { username: 'admin', password: 'correct-horse-battery' }, null)).headers.get('set-cookie').split(';')[0];
  z = (await call('GET', `/api/areas/search?q=${encodeURIComponent('زحلة')}`)).data.areas[0].id;
  const c = (await call('POST', '/api/admin/cooks', { kind: 'bakery', fullName: 'فرن', whatsapp: '+96171777001', areaId: z, servedAreaIds: [z], photo: IMG,
    activate: { plan: 'monthly', startDate: new Date(Date.now() - 60000).toISOString() } })).data;
  for (let i = 0; i < 3; i++) await call('POST', `/api/admin/cooks/${c.id}/photos`, { data: IMG });
  const dbFile = app.cfg.databaseUrl;
  await app.close();
  // … then R2 is configured (as in Render: S3_* variables)
  app = await createApp({ databaseUrl: dbFile, sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999', placesFetcher: async () => [],
    s3: { endpoint: r2Base, bucket: 'photos-bucket', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', publicUrl: `${r2Base}/pub`, region: 'auto' } });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  ck = (await call('POST', '/api/admin/login', { username: 'admin', password: 'correct-horse-battery' }, null)).headers.get('set-cookie').split(';')[0];
});
after(async () => { await app.close(); r2.close(); });

test('pages may show photos from the storage address (and only that one)', async () => {
  const csp = (await fetch(base + '/')).headers.get('content-security-policy');
  assert.match(csp, new RegExp(`img-src 'self' data: blob: ${r2Base.replace(/\./g, '\\.')}`));
});

test('status shows photos still in the database; a failed copy keeps the photo in the database', async () => {
  const s = (await call('GET', '/api/admin/storage')).data;
  assert.equal(s.enabled, true);
  assert.equal(s.counts.photosInDb, 3); assert.equal(s.counts.avatarsInDb, 1);
  refuse = true;
  await call('POST', '/api/admin/storage/migrate', {});
  for (let i = 0; i < 400 && (await call('GET', '/api/admin/storage')).data.running; i++) await new Promise((r) => setTimeout(r, 100));
  const after1 = (await call('GET', '/api/admin/storage')).data;
  assert.equal(after1.counts.photosInDb, 3, 'nothing removed while storage could not serve the files');
  assert.equal(after1.lastResult.kept, 4);
  refuse = false;
});

test('the move button moves everything; photos then open from R2; new photos go straight to R2', async () => {
  await call('POST', '/api/admin/storage/migrate', {});
  for (let i = 0; i < 400 && (await call('GET', '/api/admin/storage')).data.running; i++) await new Promise((r) => setTimeout(r, 100));
  const s = (await call('GET', '/api/admin/storage')).data;
  assert.deepEqual([s.counts.photosInDb, s.counts.avatarsInDb, s.counts.photosInStorage, s.counts.avatarsInStorage], [0, 0, 3, 1]);
  const prof = (await call('GET', '/api/cooks/1', null, null)).data;
  for (const p of prof.photos) {
    assert.ok(p.url.startsWith(`${r2Base}/pub/`), p.url);
    assert.equal((await fetch(p.url)).status, 200);
  }
  await call('POST', '/api/admin/cooks/1/photos', { data: IMG });
  const s2 = (await call('GET', '/api/admin/storage')).data;
  assert.equal(s2.counts.photosInStorage, 4); assert.equal(s2.counts.photosInDb, 0);
  assert.equal((await call('POST', '/api/admin/storage/migrate', {}, null)).status, 401);
});

test('automatic: the background job moves photos to R2 on its own (no button needed)', async () => {
  const c = (await call('POST', '/api/admin/cooks', { kind: 'pharmacy', fullName: 'صيدلية', whatsapp: '+96171777009', areaId: 1, servedAreaIds: [1], photo: IMG })).data;
  // a photo saved in the database (as before storage existed)
  await app.db.query(`INSERT INTO cook_photos (cook_id, data, url) VALUES ($1, $2, NULL)`, [c.id, IMG]);
  const before = (await call('GET', '/api/admin/storage')).data.counts.photosInDb;
  assert.ok(before >= 1);
  const job = defineJobs({ db: app.db, storage: createStorage(app.cfg) }).find((j) => j.name === 'photo-storage');
  const r = await job.run();
  assert.ok(r.moved >= 1, JSON.stringify(r));
  assert.equal((await call('GET', '/api/admin/storage')).data.counts.photosInDb, 0);
  const off = defineJobs({ db: app.db, storage: { enabled: false } }).find((j) => j.name === 'photo-storage');
  assert.deepEqual(await off.run(), { skipped: 1 });
});
