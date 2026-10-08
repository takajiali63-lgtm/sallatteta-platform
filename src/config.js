import { getCountry } from './lib/countries.js';
// Central configuration — every secret/setting comes from environment variables.
export function loadConfig(env = process.env) {
  const isProd = env.NODE_ENV === 'production';
  const cfg = {
    isProd,
    port: Number(env.PORT || 3000),
    databaseUrl: env.DATABASE_URL || 'sqlite:./data/dev.sqlite',
    databaseSsl: String(env.DATABASE_SSL).toLowerCase() === 'true',
    adminWhatsapp: (env.ADMIN_WHATSAPP_NUMBER || '').replace(/\D/g, ''),
    // Default country (ISO code). DEFAULT_COUNTRY_CODE (e.g. 961) is still accepted for older setups.
    defaultCountry: (env.DEFAULT_COUNTRY || getCountry(env.DEFAULT_COUNTRY_CODE || 'LB')?.code || 'LB').toUpperCase(),
    get defaultCountryCode() { return getCountry(this.defaultCountry)?.dial || '961'; },
    // Brand: rename the whole platform by setting BRAND_NAME (and BRAND_NAME_EN) — no code change.
    brand: { name: env.BRAND_NAME || 'Aklatak', nameEn: env.BRAND_NAME_EN || env.BRAND_NAME || 'Aklatak' },
    contactChannel: env.CONTACT_CHANNEL || 'wa.me',
    sessionSecret: env.SESSION_SECRET || '',
    adminPath: normalizeAdminPath(env.ADMIN_PATH || '/admin'),
    // Number of trusted proxies in front of the app (Render = 1, Cloudflare + Render = 2). "true" = 1.
    trustProxy: String(env.TRUST_PROXY).toLowerCase() === 'true' ? 1 : Math.max(0, Number(env.TRUST_PROXY) || 0),
    redisUrl: env.REDIS_URL || '',
    metricsToken: env.METRICS_TOKEN || '',
    slowRequestMs: Number(env.SLOW_REQUEST_MS) || 1500,
    runJobs: String(env.RUN_JOBS ?? 'true').toLowerCase() !== 'false',
    rateLimitStore: env.RATE_LIMIT_STORE || '',
    // Staging/load tests only: multiply every rate limit (e.g. 1000). Keep 1 in production.
    rateLimitScale: Math.max(1, Number(env.RATE_LIMIT_SCALE) || 1), // memory | postgres | redis (auto when empty)
    defaultLocale: 'ar',
    locales: ['ar', 'en', 'fr'],
    bootstrapAdmin: {
      username: (env.ADMIN_BOOTSTRAP_USERNAME || '').trim(),
      password: env.ADMIN_BOOTSTRAP_PASSWORD || '',
    },
    // Emergency only (forgot the admin password / lost the passkey phone): set in Render, deploy, sign in, then DELETE it.
    adminReset: {
      username: (env.ADMIN_RESET_USERNAME || env.ADMIN_BOOTSTRAP_USERNAME || '').trim(),
      password: env.ADMIN_RESET_PASSWORD || '',
    },
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    geoapifyKey: env.GEOAPIFY_API_KEY || '',
    // Optional: automatic translation of texts edited in the admin panel (DeepL; free keys end with ':fx').
    deeplKey: env.DEEPL_API_KEY || '',
    // Mobile apps (optional): links to the site open the installed app (Android App Links / iOS Universal Links).
    androidPackage: env.ANDROID_PACKAGE_NAME || '',
    androidCertSha256: (env.ANDROID_SHA256_CERT_FINGERPRINTS || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean),
    iosAppId: env.IOS_APP_ID || '',   // "TEAMID.bundle.id"

    maxRestoreBytes: Number(env.MAX_RESTORE_MB || 300) * 1024 * 1024,  // professional places/geocoding provider (optional)
    dbPoolMax: Number(env.DB_POOL_MAX) || 10,
    // S3-compatible image storage (Cloudflare R2 / AWS S3). Empty = images stay in the database.
    s3: {
      endpoint: env.S3_ENDPOINT || '',
      bucket: env.S3_BUCKET || '',
      accessKeyId: env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
      publicUrl: env.S3_PUBLIC_URL || '',
      region: env.S3_REGION || 'auto',
    },
    maxServiceRadiusKm: 50,
    searchResultLimit: 30,
  };
  if (isProd && cfg.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be set (at least 32 characters) in production');
  }
  if (!cfg.sessionSecret) cfg.sessionSecret = 'dev-only-secret-not-for-production-use-0000';
  return cfg;
}

function normalizeAdminPath(p) {
  const path = '/' + String(p).trim().replace(/^\/+|\/+$/g, '');
  const reserved = ['/api', '/assets', '/locales', '/media', '/join', '/healthz'];
  if (!/^\/[A-Za-z0-9_\-/]{2,64}$/.test(path) || reserved.some((r) => path === r || path.startsWith(r + '/'))) {
    throw new Error('ADMIN_PATH is invalid (use letters, digits, - _ /; not a reserved path)');
  }
  return path;
}
