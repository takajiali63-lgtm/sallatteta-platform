// Mobile app readiness: installable app (manifest, icons), offline screen, app links (Android/iOS), app download page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

let app, base, ck;
const call = async (m, p, body, cookie = ck) => {
  const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, headers: r.headers };
};

before(async () => {
  app = await createApp({ databaseUrl: 'sqlite::memory:', sessionSecret: 'x'.repeat(40), quiet: true, adminWhatsapp: '96170999999',
    bootstrapAdmin: { username: 'admin', password: 'correct-horse-battery' }, placesFetcher: async () => [],
    androidPackage: 'com.aklatak.app', androidCertSha256: ['AA:BB:CC'], iosAppId: 'TEAM123.com.aklatak.app' });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  ck = (await call('POST', '/api/admin/login', { username: 'admin', password: 'correct-horse-battery' }, null)).headers.get('set-cookie').split(';')[0];
});
after(async () => { await app.close(); });

test('installable app: manifest with PNG + maskable icons, shortcuts; icons are served', async () => {
  const m = await (await fetch(base + '/manifest.webmanifest')).json();
  assert.equal(m.display, 'standalone');
  assert.equal(m.name, 'Aklatak');
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  assert.ok(m.icons.some((i) => i.sizes === '192x192' && i.purpose === 'any'));
  assert.ok(!m.shortcuts && !m.display_override, 'build-friendly manifest (no shortcuts / overrides)');
  assert.ok(m.screenshots.length >= 2);
  for (const i of m.icons) {
    const r = await fetch(base + i.src);
    assert.equal(r.status, 200, i.src);
    assert.equal(r.headers.get('content-type'), 'image/png');
  }
  assert.equal((await fetch(base + '/assets/icons/apple-touch-icon.png')).status, 200);
});

test('every page is app-ready (manifest + iPhone tags); offline screen and service worker are served', async () => {
  for (const p of ['/', '/join', '/account', '/nearby', '/c/1', '/terms', '/app']) {
    const html = await (await fetch(base + p)).text();
    assert.ok(html.includes('rel="manifest"') && html.includes('apple-touch-icon') && html.includes('apple-mobile-web-app-capable'), p);
  }
  const sw = await fetch(base + '/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.match(sw.headers.get('cache-control') || '', /no-cache/, 'service worker must always be revalidated');
  const swText = await sw.text();
  assert.ok(!/\/api\//.test(swText.replace(/\/\/.*$/gm, '')), 'API responses are never cached');
  const off = await (await fetch(base + '/offline.html')).text();
  assert.ok(!/<style|<script|style="/.test(off), 'offline page respects the strict CSP');
});

test('links to the site open the installed apps (Android App Links / iOS Universal Links)', async () => {
  const a = await call('GET', '/.well-known/assetlinks.json');
  assert.equal(a.status, 200);
  assert.equal(a.data[0].target.package_name, 'com.aklatak.app');
  assert.deepEqual(a.data[0].target.sha256_cert_fingerprints, ['AA:BB:CC']);
  const i = await call('GET', '/.well-known/apple-app-site-association');
  assert.equal(i.status, 200);
  assert.deepEqual(i.data.applinks.details[0].appIDs, ['TEAM123.com.aklatak.app']);
  assert.deepEqual(i.data.applinks.details[0].components[0], { '/': '/admin/*', exclude: true });
});

test('admin sets the app download links (https only); visitors get them', async () => {
  assert.equal((await call('PUT', '/api/admin/settings', { appLinks: { android: 'http://insecure.example/app.apk' } })).status, 422);
  assert.equal((await call('PUT', '/api/admin/settings', { appLinks: { android: 'javascript:alert(1)' } })).status, 422);
  assert.equal((await call('PUT', '/api/admin/settings', { appLinks: { android: 'https://github.com/x/y/releases/download/v1/aklatak.apk', ios: '' } })).status, 200);
  const cfg = (await call('GET', '/api/config', null, null)).data;
  assert.equal(cfg.site.appLinks.android, 'https://github.com/x/y/releases/download/v1/aklatak.apk');
  assert.equal((await fetch(base + '/app')).status, 200);
});
