// PORTABILITY TEST: export everything from one database, restore into a brand-new one, check nothing is lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { openDb, migrate } from '../src/db/index.js';
import { exportAll, importAll } from '../src/lib/portability.js';

const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';

test('export → new database → restore: same rows, same relations, still works', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aklatak-export-'));
  const app = await createApp({
    databaseUrl: 'sqlite::memory:', sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999',
    bootstrapAdmin: { username: 'admin', password: 'correct-horse-battery' }, placesFetcher: async () => [], geoFetcher: async () => { throw new Error('off'); },
  });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (m, p, body, cookie) => {
    const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null), headers: r.headers };
  };
  const login = await call('POST', '/api/admin/login', { username: 'admin', password: 'correct-horse-battery' });
  const ck = login.headers.get('set-cookie').split(';')[0];
  const zahle = (await call('GET', `/api/areas/search?q=${encodeURIComponent('زحلة')}`)).data.areas[0].id;
  const cook = (await call('POST', '/api/admin/cooks', { kind: 'restaurant', specialty: 'مشاوي', fullName: 'مطعم التجربة', whatsapp: '+96171555111', areaId: zahle, servedAreaIds: [zahle], photo: IMG,
    activate: { plan: 'monthly', startDate: new Date(Date.now() - 60_000).toISOString() } }, ck)).data;
  await app.db.query('INSERT INTO menu_items (cook_id, name, price, currency) VALUES ($1,$2,$3,$4)', [cook.id, 'كفتة', 9, 'USD']);
  await app.db.query('INSERT INTO support_messages (cook_id, body) VALUES ($1,$2)', [cook.id, 'مرحبا']);
  const before = await exportAll(app.db, dir, { appVersion: 'test' });
  await app.close();

  const db2 = await openDb({ databaseUrl: 'sqlite::memory:' });
  await migrate(db2);
  const r = await importAll(db2, dir);
  for (const [t, n] of Object.entries(before.counts)) assert.equal(r.inserted[t], n, `table ${t}`);
  const c2 = await db2.one('SELECT full_name, kind, specialty, photo FROM cooks WHERE id = $1', [cook.id]);
  assert.equal(c2.full_name, 'مطعم التجربة');
  assert.equal(c2.kind, 'restaurant');
  assert.equal(c2.photo, IMG, 'photos stored in the database come back');
  assert.equal((await db2.one('SELECT name FROM menu_items WHERE cook_id = $1', [cook.id])).name, 'كفتة');
  assert.equal(Number((await db2.one('SELECT COUNT(*) AS n FROM cook_service_areas WHERE cook_id = $1', [cook.id])).n), 1);
  assert.equal(Number((await db2.one(`SELECT COUNT(*) AS n FROM subscriptions WHERE cook_id = $1 AND status = 'active'`, [cook.id])).n), 1);
  // the restored admin can still log in (password hashes are portable)
  assert.ok((await db2.one(`SELECT password_hash FROM admin_users WHERE username = 'admin'`)).password_hash.startsWith('scrypt$'));
  // foreign keys intact
  assert.equal((await db2.query('PRAGMA foreign_key_check')).length, 0);
  await db2.close();
  await rm(dir, { recursive: true, force: true });
});
