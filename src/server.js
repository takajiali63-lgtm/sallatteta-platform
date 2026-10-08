import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb, migrate } from './db/index.js';
import { HttpError, sendJson, serveFile } from './lib/http.js';
import { RateLimiter, pickStore } from './lib/ratelimit.js';
import { createRedis } from './lib/redis.js';
import { publicRoutes } from './routes/public.js';
import { adminRoutes, createAdminUser } from './routes/admin.js';
import { expireSubscriptions } from './services/cooks.js';
import { AreaIndex } from './services/areas.js';
import { cookRoutes } from './routes/cook.js';
import { deliveryRoutes } from './routes/delivery.js';
import { createSms } from './services/sms.js';
import { createPush } from './services/push.js';
import { createRoads } from './services/roads.js';
import { createPayments } from './services/payments.js';
import { deliverySettings } from './services/delivery.js';
import { createStorage } from './services/storage.js';
import { imageStore } from './services/images.js';
import { MemoryCache, RedisCache } from './lib/cache.js';
import { enablePostgis } from './db/postgis.js';
import { createJobRunner } from './lib/jobs.js';
import { defineJobs } from './jobs.js';
import { log as defaultLog, silent } from './lib/log.js';
import { Metrics } from './lib/metrics.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { t as tr, pickLocale, setBrand, availableLocales } from './lib/i18n.js';
import { createChannel } from './services/messaging.js';
import { createSettings } from './services/settings.js';
import { createGeoResolver } from './services/geoResolve.js';
import { localeJson } from './lib/i18n.js';
import { hashPassword } from './lib/security.js';
import { computeFingerprint } from './lib/fingerprint.js';
import { readFileSync as readFileSyncFp } from 'node:fs';
const BUILD = (() => {
  let version = '';
  try { version = JSON.parse(readFileSyncFp(new URL('../package.json', import.meta.url))).version; } catch { /* ignore */ }
  try { return { version, ...computeFingerprint() }; } catch { return { version, fingerprint: 'unknown' }; }
})();
import { sendText } from './lib/http.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = resolve(root, 'public');
const ADMIN_DIR = resolve(root, 'admin-ui');
const LOCALES_DIR = resolve(root, 'locales');

function securityHeaders(cfg) {
  // Photos on Cloudflare R2 / S3 are served from their own address: allow exactly that origin (nothing else).
  let storageOrigin = '';
  try { if (cfg.s3?.publicUrl) storageOrigin = ` ${new URL(cfg.s3.publicUrl).origin}`; } catch { /* invalid URL: ignored */ }
  const h = {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      `img-src 'self' data: blob:${storageOrigin} https://tile.openstreetmap.org`,   // + map tiles for "choose on the map"
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
  if (cfg.isProd) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}

export async function createApp(overrides = {}) {
  const cfg = { ...loadConfig(), ...overrides };
  if (overrides.brand) cfg.brand = { ...loadConfig().brand, ...overrides.brand };
  setBrand(cfg.brand);
  cfg.locales = [...new Set([...(cfg.locales || []), ...availableLocales()])];
  const db = await openDb(cfg);
  await migrate(db);
  await enablePostgis(db, { log: cfg.quiet ? {} : console });   // optional: never blocks start-up

  // First admin from env (only if no admin exists yet) — useful on Render free plan (no shell).
  const adminCount = await db.one('SELECT CAST(COUNT(*) AS INTEGER) AS n FROM admin_users');
  if (adminCount.n === 0 && cfg.bootstrapAdmin.username && cfg.bootstrapAdmin.password) {
    await createAdminUser(db, cfg.bootstrapAdmin.username, cfg.bootstrapAdmin.password);
    defaultLog.info(`[setup] created first admin user "${cfg.bootstrapAdmin.username}"`);
  }

  // Emergency admin password reset from Render (no shell on the free plan). Also turns off the passkey
  // requirement (the phone may be lost) and signs out every admin session. Remove the variables afterwards.
  const reset = cfg.adminReset || {};
  if (reset.password) {
    if (reset.password.length < 10 || !reset.username) {
      defaultLog.warn('[security] ADMIN_RESET_PASSWORD ignored: needs ADMIN_RESET_USERNAME (or ADMIN_BOOTSTRAP_USERNAME) and at least 10 characters');
    } else {
      const u = await db.one('SELECT id FROM admin_users WHERE LOWER(username) = $1', [reset.username.toLowerCase()]);
      if (u) {
        await db.query('UPDATE admin_users SET password_hash = $1, mfa_required = 0 WHERE id = $2', [await hashPassword(reset.password), u.id]);
        await db.query('DELETE FROM admin_sessions WHERE admin_id = $1', [u.id]);
        defaultLog.warn(`[security] admin "${reset.username}" password was reset from ADMIN_RESET_PASSWORD — delete this variable in Render now`);
      } else {
        await createAdminUser(db, reset.username, reset.password);
        defaultLog.warn(`[security] admin "${reset.username}" created from ADMIN_RESET_PASSWORD — delete this variable in Render now`);
      }
    }
  }

  const redis = cfg.redisUrl ? createRedis(cfg.redisUrl, { log: cfg.quiet ? {} : console }) : null;
  const store = overrides.rateLimitStoreImpl || pickStore({ cfg, db, redis });
  const L = (name, windowMs, max) => new RateLimiter({ name, windowMs, max: max * (cfg.rateLimitScale || 1), store, log: cfg.quiet ? {} : console });
  const limiters = {
    search: L('search', 10 * 60_000, overrides.searchLimit ?? 30),
    contact: L('contact', 10 * 60_000, 40),
    apply: L('apply', 60 * 60_000, overrides.applyLimit ?? 5),
    login: L('login', 15 * 60_000, overrides.loginLimit ?? 10),
    lookup: L('lookup', 60_000, overrides.lookupLimit ?? 120),
    feedback: L('feedback', 60 * 60_000, overrides.feedbackLimit ?? 5),
    places: L('places', 10 * 60_000, overrides.placesLimit ?? 30),
    upload: L('upload', 60 * 60_000, overrides.uploadLimit ?? 60),
    admin: L('admin', 60_000, overrides.adminLimit ?? 300),
  };
  const areas = await new AreaIndex(db).load();
  const storage = createStorage(cfg, overrides.storageFetch ? { fetchImpl: overrides.storageFetch } : {});
  const images = imageStore(storage);
  // Shared cache across instances when Redis is configured (REDIS_CACHE=off keeps it per instance).
  const cache = redis && process.env.REDIS_CACHE !== 'off' ? new RedisCache(redis, { log: cfg.quiet ? {} : console }) : new MemoryCache();
  const channel = createChannel(cfg.contactChannel);
  const settings = createSettings(db, cfg, { log: cfg.quiet ? {} : console });
  await settings.load();
  settings.start();
  const geo = createGeoResolver({ db, areas, cfg, ...(overrides.geoFetcher ? { fetcher: overrides.geoFetcher } : {}), log: cfg.quiet ? {} : console });
  const sms = overrides.sms || createSms();
  const push = overrides.push || createPush({ db, log: cfg.quiet ? {} : console });
  const dset = deliverySettings(db);
  const roads = overrides.roads || createRoads({ key: cfg.geoapifyKey, dailyMax: async () => (await dset.get()).routeDailyMax, log: cfg.quiet ? {} : console });
  const payments = overrides.payments || createPayments({ log: cfg.quiet ? {} : console });
  const ctx = { db, cfg, limiters, areas, images, cache, channel, settings, geo, storage, sms, push, roads, payments };
  const routes = [...deliveryRoutes(ctx), ...publicRoutes(ctx), ...cookRoutes(ctx), ...adminRoutes(ctx)];
  const headers = securityHeaders(cfg);

  const log = cfg.quiet ? silent : defaultLog;
  const metrics = new Metrics();
  const SLOW_MS = Number(cfg.slowRequestMs) || 1500;
  const routeLabel = (path) => {
    for (const [, pattern] of routes) if (pattern.test(path)) return pattern.source.replace(/\\\//g, '/').replace(/[\^$]/g, '').slice(0, 60);
    if (path.startsWith('/assets/')) return 'static';
    return path.startsWith('/api/') ? 'api-unknown' : 'page';
  };

  // Readiness: can this instance serve traffic right now?
  async function readiness() {
    const checks = {};
    const withTimeout = (p, ms = 2000) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
    try { await withTimeout(db.one('SELECT 1 AS ok')); checks.database = 'ok'; } catch (e) { checks.database = `down: ${e.message}`; }
    if (redis) { try { checks.redis = (await withTimeout(redis.ping())) ? 'ok' : 'down'; } catch (e) { checks.redis = `down: ${e.message}`; } }
    checks.rateLimitStore = store.kind;
    checks.images = storage.kind;
    try {
      const jobsStatus = await jobs.status();
      checks.jobs = Object.fromEntries(jobsStatus.map((j) => [j.name, {
        status: j.last_status || 'never', lastFinished: j.last_finished_at ? new Date(Number(j.last_finished_at)).toISOString() : null, failures: j.failures,
      }]));
    } catch { checks.jobs = 'unknown'; }
    // Only the database is critical: Redis failures fail open, jobs are reported for monitoring.
    return { ok: checks.database === 'ok', checks };
  }

  const tokenOk = (req) => {
    if (!cfg.metricsToken) return false;
    const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(cfg.metricsToken);
    return got.length === want.length && timingSafeEqual(got, want);
  };

  async function handle(req, res) {
    const started = process.hrtime.bigint();
    const incoming = String(req.headers['x-request-id'] || '');
    const requestId = /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    req.id = requestId;
    res.setHeader('X-Request-Id', requestId);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://localhost');
    // API versioning: /api/v1/... is the stable, documented API for web & mobile apps (same handlers as /api/...).
    let path = url.pathname;
    if (path === '/api/v1' || path.startsWith('/api/v1/')) path = '/api' + path.slice('/api/v1'.length);
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      metrics.observe({ method: req.method, route: routeLabel(path), status: res.statusCode, seconds });
      if (seconds * 1000 > SLOW_MS) {
        metrics.slow++;
        log.warn(`[slow] ${req.method} ${path} ${Math.round(seconds * 1000)}ms`, { requestId, status: res.statusCode });
      }
    });
    try {
      // Domain verification files so links to the site open the installed Android / iPhone app.
      if (path === '/.well-known/assetlinks.json') {
        if (!cfg.androidPackage || !cfg.androidCertSha256.length) throw new HttpError(404, 'not_found');
        return sendJson(res, 200, [{
          relation: ['delegate_permission/common.handle_all_urls'],
          target: { namespace: 'android_app', package_name: cfg.androidPackage, sha256_cert_fingerprints: cfg.androidCertSha256 },
        }], { 'Cache-Control': 'public, max-age=3600' });
      }
      if (path === '/.well-known/apple-app-site-association') {
        if (!cfg.iosAppId) throw new HttpError(404, 'not_found');
        return sendJson(res, 200, { applinks: { details: [{ appIDs: [cfg.iosAppId], components: [{ '/': '/admin/*', exclude: true }, { '/': '/*' }] }] } },
          { 'Cache-Control': 'public, max-age=3600' });
      }
      if (path === '/readyz') {
        const r = await readiness();
        return sendJson(res, r.ok ? 200 : 503, { ...r, version: BUILD.version, fingerprint: BUILD.fingerprint });
      }
      if (path === '/metrics') {
        if (!tokenOk(req)) throw new HttpError(404, 'not_found');
        const pool = db.stats?.() || {};
        const body = metrics.prometheus({
          db_pool_total: pool.total, db_pool_idle: pool.idle, db_pool_waiting: pool.waiting,
          http_p50_seconds: metrics.percentile(0.5), http_p95_seconds: metrics.percentile(0.95), http_p99_seconds: metrics.percentile(0.99),
        });
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', 'Cache-Control': 'no-store' });
        return res.end(body);
      }
      for (const [method, pattern, handler] of routes) {
        const m = pattern.exec(path);
        if (m) {
          if (req.method !== method) continue;
          return await handler(req, res, m);
        }
      }
      if (path.startsWith('/api/')) throw new HttpError(404, 'not_found');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');

      // Admin UI (path configurable via ADMIN_PATH, never indexed)
      if (path === cfg.adminPath) {
        res.writeHead(301, { Location: cfg.adminPath + '/' });
        return res.end();
      }
      if (path.startsWith(cfg.adminPath + '/')) {
        const rel = path.slice(cfg.adminPath.length).replace(/^\/+/, '') || 'index.html';
        if (await serveFile(res, ADMIN_DIR, rel, { extraHeaders: { 'X-Robots-Tag': 'noindex, nofollow' }, brand: cfg.brand })) return;
        throw new HttpError(404, 'not_found');
      }
      if (path.startsWith('/locales/')) {
        const lm = /^\/locales\/([a-z]{2})\.json$/.exec(path);
        if (lm && cfg.locales.includes(lm[1])) {
          sendText(req, res, localeJson(lm[1]), 'application/json; charset=utf-8');
          return;
        }
        if (await serveFile(res, LOCALES_DIR, path.slice('/locales/'.length), { cache: 'no-cache', brand: cfg.brand })) return;
        throw new HttpError(404, 'not_found');
      }
      // v7: the new app replaces the old customer pages; old addresses (/c/12, /terms…) open the same thing in the new app.
      const pages = {
        '/': 'app.html', '/nearby': 'app.html', '/regions': 'app.html', '/dishes': 'app.html', '/terms': 'app.html', '/privacy': 'app.html', '/about': 'app.html', '/delete-account': 'app.html',
        '/store': 'store.html', '/account': 'store.html', '/driver': 'driver.html',
        '/join': 'join.html', '/app': 'page.html', '/advertise': 'page.html', '/contact': 'page.html',
      };
      const rel = pages[path] || (/^\/c\/\d+\/?$/.test(path) ? 'app.html' : path);
      const cache = rel.startsWith('/assets/') && /\.(svg|png|jpg|woff2?)$/.test(rel) ? 'public, max-age=86400' : 'no-cache';
      if (await serveFile(res, PUBLIC_DIR, rel, { cache, brand: cfg.brand })) return;
      throw new HttpError(404, 'not_found');
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      if (err instanceof HttpError) {
        const extra = err.status === 429 ? { 'Retry-After': String(err.extra.retryAfterSec || 60) } : {};
        if (!path.startsWith('/api/') && err.status === 404) {
          const lang = pickLocale(req, cfg.locales);
          const dir = ['ar', 'fa', 'he', 'ur'].includes(lang) ? 'rtl' : 'ltr';
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>404</title><p dir="${dir}" style="font-family:sans-serif;padding:2rem">${tr(lang, 'errors.page_not_found')} <a href="/">${tr(lang, 'join.backHome')}</a></p>`);
        }
        return sendJson(res, err.status, { error: err.code, ...err.extra, requestId }, extra);
      }
      log.error(`[error] ${req.method} ${path}`, err, { requestId });
      return sendJson(res, 500, { error: 'server_error', requestId });
    }
  }

  const server = createServer((req, res) => { handle(req, res); });
  // Behind a load balancer: keep connections a bit longer than the balancer's idle timeout, and cap slow requests.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;
  // Background jobs. With many instances only one runs each job (leases in job_runs).
  // RUN_JOBS=false on web instances when a separate worker service runs them (see scripts/worker.js).
  const jobs = createJobRunner({ db, jobs: defineJobs({ db, storage, push, payments }), log: cfg.quiet ? {} : console });
  if (cfg.runJobs !== false) await jobs.start();
  const sweep = () => jobs.runNow('expire-subscriptions');

  return {
    server, db, cfg, sweep, jobs, areas, storage, redis, rateLimitStore: store, metrics, readiness, settings, cache,
    async close() {
      await jobs.stop();
      settings.stop();
      await redis?.close();
      await new Promise((r) => server.close(r));
      await db.close();
    },
  };
}

// Run directly: `node src/server.js`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createApp();
  app.server.listen(app.cfg.port, () => {
    defaultLog.info(`${app.cfg.brand.name} running on http://localhost:${app.cfg.port}`, { admin: app.cfg.adminPath, db: app.db.kind, images: app.storage.kind, rateLimits: app.rateLimitStore.kind, jobs: app.cfg.runJobs });
    if (!app.cfg.adminWhatsapp) defaultLog.warn('[warn] ADMIN_WHATSAPP_NUMBER is not set — cook applications cannot be forwarded to WhatsApp');
  });
  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return; stopping = true;
    defaultLog.info(`[shutdown] ${sig}: finishing in-flight requests`);
    setTimeout(() => process.exit(1), 25_000).unref(); // hard limit
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('unhandledRejection', (e) => defaultLog.error('[unhandledRejection]', e instanceof Error ? e : new Error(String(e))));
}
