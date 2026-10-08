// Load test with realistic customer traffic.
//   Local (starts its own server + demo data):  node scripts/load-test.js --seconds 20 --concurrency 50
//   Against a staging URL:                       node scripts/load-test.js --url https://staging.example.com --seconds 60 --concurrency 100
// Staging must run with RATE_LIMIT_SCALE=1000 (all requests come from one machine). Never point this at production.
import { parseArgs } from 'node:util';

const { values: o } = parseArgs({ options: {
  url: { type: 'string' }, seconds: { type: 'string', default: '20' }, concurrency: { type: 'string', default: '50' },
  cooks: { type: 'string', default: '300' }, db: { type: 'string', default: 'sqlite::memory:' },
} });
const SECONDS = Number(o.seconds), CONC = Number(o.concurrency);
let base = o.url, app = null;
const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';

if (!base) {
  const { createApp } = await import('../src/server.js');
  const { setServedAreas, setCookServices, activateSubscription } = await import('../src/services/cooks.js');
  app = await createApp({ databaseUrl: o.db, sessionSecret: 'x'.repeat(40), quiet: true, rateLimitScale: 100_000, placesFetcher: async () => [], adminWhatsapp: '96170000000' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const areas = app.areas.list;
  const t0 = Date.now();
  for (let i = 0; i < Number(o.cooks); i++) {
    const home = areas[i % areas.length];
    const c = await app.db.one(`INSERT INTO cooks (full_name, whatsapp, area_id, area_label, lat, lng, service_radius_km, status, name_norm, bio)
      VALUES ($1,$2,$3,$4,$5,$6,0,'approved',$1,$7) RETURNING id`, [`طبّاخ ${i}`, `96171${String(100000 + i)}`, home.id, home.name_ar, home.lat, home.lng, 'أكل بيتي']);
    await setCookServices(app.db, c.id, ['home_cooking', 'sweets']);
    await setServedAreas(app.db, c.id, app.areas.around(home.lat, home.lng, { km: 10 }).slice(0, 15).map((a) => a.id));
    await activateSubscription(app.db, c.id, { plan: 'monthly', startDate: new Date(Date.now() - 60_000), paymentStatus: 'paid' });
    if (i % 3 === 0) await app.db.query('INSERT INTO cook_photos (cook_id, data, caption) VALUES ($1,$2,$3)', [c.id, IMG, 'كبة']);
  }
  console.log(`seeded ${o.cooks} active cooks in ${Date.now() - t0} ms`);
}

const rand = (a, b) => a + Math.random() * (b - a);
const startedAt = Date.now() - 5000;
const stats = new Map(); // scenario → { lat[], errors }
const record = (name, ms, ok) => { let s = stats.get(name); if (!s) { s = { lat: [], errors: 0 }; stats.set(name, s); } s.lat.push(ms); if (!ok) s.errors++; };
async function call(name, path, opts = {}) {
  const t = performance.now();
  try {
    const r = await fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', 'Accept-Encoding': 'gzip', ...(opts.headers || {}) } });
    const body = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.arrayBuffer();
    record(name, performance.now() - t, r.status < 500 && r.status !== 429);
    return { status: r.status, body };
  } catch { record(name, performance.now() - t, false); return { status: 0 }; }
}

const photoIds = [];
async function customer() {
  const r = Math.random();
  if (r < 0.10) return call('config', '/api/config');
  if (r < 0.25) { const f = await call('feed', '/api/feed'); f.body?.dishes?.forEach((d) => photoIds.length < 200 && photoIds.push(d.photoUrl)); return; }
  if (r < 0.40) return call('village search', `/api/areas/search?q=${encodeURIComponent(['زح', 'سعد', 'بعل', 'جون', 'صي', 'طرا'][Math.floor(rand(0, 6))])}`);
  if (r < 0.80) {
    const s = await call('GPS cook search', '/api/search', { method: 'POST', body: JSON.stringify({ text: 'بدي صينية كبة لـ 8 أشخاص', location: { type: 'gps', lat: rand(33.3, 34.4), lng: rand(35.4, 36.2) }, startedAt }) });
    const c = s.body?.cooks?.[0];
    if (c && Math.random() < 0.5) await call('WhatsApp contact', '/api/contact', { method: 'POST', body: JSON.stringify({ requestId: s.body.requestId, cookId: c.id }) });
    if (c && Math.random() < 0.3) await call('cook page', `/api/cooks/${c.id}`);
    return;
  }
  if (r < 0.90 && photoIds.length) return call('photo', photoIds[Math.floor(rand(0, photoIds.length))]);
  return call('home page', '/');
}

const cpu0 = process.cpuUsage(); const wall0 = performance.now();
const deadline = Date.now() + SECONDS * 1000;
await Promise.all(Array.from({ length: CONC }, async () => { while (Date.now() < deadline) await customer(); }));
const wall = (performance.now() - wall0) / 1000;
const cpu = process.cpuUsage(cpu0);

const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0; };
let total = 0, errs = 0; const all = [];
console.log(`\n${SECONDS}s, ${CONC} concurrent users → ${base}${app ? ` (local, ${app.db.kind})` : ''}\n`);
console.log('scenario'.padEnd(18), 'requests'.padStart(9), 'rps'.padStart(8), 'p50 ms'.padStart(8), 'p95 ms'.padStart(8), 'p99 ms'.padStart(8), 'errors'.padStart(7));
for (const [name, s] of stats) {
  total += s.lat.length; errs += s.errors; all.push(...s.lat);
  console.log(name.padEnd(18), String(s.lat.length).padStart(9), (s.lat.length / wall).toFixed(1).padStart(8), pct(s.lat, 0.5).toFixed(1).padStart(8), pct(s.lat, 0.95).toFixed(1).padStart(8), pct(s.lat, 0.99).toFixed(1).padStart(8), String(s.errors).padStart(7));
}
console.log('TOTAL'.padEnd(18), String(total).padStart(9), (total / wall).toFixed(1).padStart(8), pct(all, 0.5).toFixed(1).padStart(8), pct(all, 0.95).toFixed(1).padStart(8), pct(all, 0.99).toFixed(1).padStart(8), String(errs).padStart(7));
console.log(`\nerror rate ${(100 * errs / Math.max(1, total)).toFixed(2)}% · process CPU ${((cpu.user + cpu.system) / 1e6 / wall * 100).toFixed(0)}% of one core · memory ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
if (app) await app.close();
process.exit(errs / Math.max(1, total) > 0.01 ? 1 : 0);
