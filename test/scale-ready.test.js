// Ready to scale: shared Redis cache (works with a real RESP server; survives Redis being down) and optional PostGIS.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRedis } from '../src/lib/redis.js';
import { RedisCache } from '../src/lib/cache.js';
import { enablePostgis } from '../src/db/postgis.js';
import { createApp } from '../src/server.js';
import { searchCooksForArea } from '../src/services/cooks.js';

// --- a tiny Redis look-alike speaking the real protocol (RESP): PING GET SET PX SCAN DEL ---
const store = new Map();
let server, port;
function respParse(buf) {
  const out = []; let i = 0; const s = buf.toString();
  while (i < s.length) {
    if (s[i] !== '*') break;
    let j = s.indexOf('\r\n', i); const n = Number(s.slice(i + 1, j)); i = j + 2; const args = [];
    for (let k = 0; k < n; k++) { j = s.indexOf('\r\n', i); const len = Number(s.slice(i + 1, j)); i = j + 2; args.push(s.slice(i, i + len)); i += len + 2; }
    out.push(args);
  }
  return out;
}
const bulk = (v) => (v == null ? '$-1\r\n' : `$${Buffer.byteLength(v)}\r\n${v}\r\n`);
before(async () => {
  server = net.createServer((sock) => sock.on('data', (d) => {
    for (const [cmd, ...a] of respParse(d)) {
      const c = cmd.toUpperCase(); const now = Date.now();
      for (const [k, v] of store) if (v.exp && v.exp < now) store.delete(k);
      if (c === 'PING') sock.write('+PONG\r\n');
      else if (c === 'GET') sock.write(bulk(store.get(a[0])?.v ?? null));
      else if (c === 'SET') { store.set(a[0], { v: a[1], exp: a[2] === 'PX' ? now + Number(a[3]) : 0 }); sock.write('+OK\r\n'); }
      else if (c === 'DEL') { let n = 0; for (const k of a) n += store.delete(k) ? 1 : 0; sock.write(`:${n}\r\n`); }
      else if (c === 'SCAN') { const pat = a[2].replace(/\*$/, ''); const keys = [...store.keys()].filter((k) => k.startsWith(pat)); sock.write(`*2\r\n${bulk('0')}*${keys.length}\r\n${keys.map(bulk).join('')}`); }
      else sock.write('-ERR unknown\r\n');
    }
  }));
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
});
after(() => server.close());

test('Redis cache: one load for many readers, shared between instances, Dates kept, clear works everywhere', async () => {
  const r1 = createRedis(`redis://127.0.0.1:${port}`, { log: {} });
  const r2 = createRedis(`redis://127.0.0.1:${port}`, { log: {} });
  const ready = async (r) => { for (let i = 0; i < 50; i++) { try { if (await r.ping()) return; } catch { /* connecting */ } await new Promise((x) => setTimeout(x, 20)); } };
  await ready(r1); await ready(r2);
  const a = new RedisCache(r1, { log: {} }); const b = new RedisCache(r2, { log: {} });
  let loads = 0;
  const load = async () => { loads++; await new Promise((r) => setTimeout(r, 30)); return { n: 7, at: new Date('2026-10-03T10:00:00Z') }; };
  const results = await Promise.all(Array.from({ length: 20 }, () => a.get('feed:LB', 60_000, load)));
  assert.equal(loads, 1, 'twenty simultaneous readers → one load');
  await new Promise((r) => setTimeout(r, 30));
  const fromOther = await b.get('feed:LB', 60_000, load);   // another instance: served from Redis
  assert.equal(loads, 1);
  assert.equal(fromOther.n, 7); assert.ok(fromOther.at instanceof Date); assert.equal(results[0].at.toISOString(), '2026-10-03T10:00:00.000Z');
  a.clear('feed:'); await new Promise((r) => setTimeout(r, 50));
  assert.equal(store.has('cache:feed:LB'), false, 'cleared for every instance');
  await r1.close(); await r2.close();
});

test('Redis down: the site keeps working (value loaded directly)', async () => {
  const dead = createRedis('redis://127.0.0.1:1', { log: {}, connectTimeoutMs: 200, commandTimeoutMs: 200 });
  const c = new RedisCache(dead, { log: {} });
  assert.deepEqual(await c.get('config:ar', 60_000, async () => ({ ok: true })), { ok: true });
  await dead.close();
});

test('PostGIS: off on SQLite; enabled on Postgres with the spatial index', async () => {
  const sqlite = { kind: 'sqlite' };
  assert.equal(await enablePostgis(sqlite, { log: {} }), false);
  const seen = [];
  const pg = { kind: 'pg', query: async (q) => { seen.push(q); return []; }, one: async () => ({ v: '3.5 USE_GEOS=1' }) };
  assert.equal(await enablePostgis(pg, { log: {} }), true);
  assert.ok(seen.some((q) => /CREATE EXTENSION IF NOT EXISTS postgis/.test(q)));
  assert.ok(seen.some((q) => /CREATE INDEX IF NOT EXISTS cooks_geog_gist ON cooks USING GIST/.test(q)));
  const refused = { kind: 'pg', query: async () => { throw new Error('permission denied'); }, one: async () => null };
  assert.equal(await enablePostgis(refused, { log: {} }), false, 'no permission → regular search, no crash');
});

test('PostGIS search: KNN query when enabled; any failure falls back to the regular search with the same results', async () => {
  const app = await createApp({ databaseUrl: 'sqlite::memory:', sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999', placesFetcher: async () => [] });
  const z = app.areas.list.find((a) => a.name_ar === 'زحلة') || app.areas.list[0];
  const now = new Date().toISOString(); const end = new Date(Date.now() + 864e5).toISOString();
  for (const [i, lat] of [[1, 33.849], [2, 33.8468], [3, 33.86]]) {
    await app.db.query(`INSERT INTO cooks (id, full_name, name_norm, whatsapp, area_id, area_label, lat, lng, service_radius_km, status, kind) VALUES ($1,$2,$2,$3,$4,'z',$5,35.9031,5,'approved','bakery')`, [i, `فرن ${i}`, `+9617000000${i}`, z.id, lat]);
    await app.db.query('INSERT INTO cook_service_areas (cook_id, area_id) VALUES ($1,$2)', [i, z.id]);
    await app.db.query(`INSERT INTO subscriptions (cook_id, plan, status, start_date, expiry_date) VALUES ($1,'monthly','active',$2,$3)`, [i, now, end]);
  }
  const args = { areaIds: [z.id], point: { lat: 33.8466, lng: 35.9031 }, kind: 'bakery' };
  const regular = (await searchCooksForArea(app.db, app.areas, args)).map((c) => c.name);
  // 1) PostGIS on but the spatial query fails (here: SQLite has no ST_ functions) → same answer, path switched off
  app.db.postgis = true;
  assert.deepEqual((await searchCooksForArea(app.db, app.areas, args)).map((c) => c.name), regular);
  assert.equal(app.db.postgis, false);
  // 2) PostGIS on and working: the KNN operator is used with (lng, lat)
  const orig = app.db.query.bind(app.db); let knn = null;
  app.db.postgis = true;
  app.db.query = async (q, p) => { if (q.includes('<->')) { knn = { q, p }; return orig(q.replace(/ORDER BY ST_SetSRID[\s\S]*?geography, c\.id/, 'ORDER BY c.id'), p.slice(0, -2)); } return orig(q, p); };
  await searchCooksForArea(app.db, app.areas, args);
  assert.ok(knn && /ST_SetSRID\(ST_MakePoint\(c\.lng, c\.lat\), 4326\)::geography <-> ST_SetSRID\(ST_MakePoint\(\$\d+, \$\d+\), 4326\)::geography/.test(knn.q));
  assert.deepEqual(knn.p.slice(-2), [35.9031, 33.8466], 'longitude first, then latitude');
  assert.equal(regular[0], 'فرن 2', 'nearest first');
  app.db.query = orig;
  await app.close();
});
