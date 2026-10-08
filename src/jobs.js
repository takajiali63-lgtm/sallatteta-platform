// The list of background jobs. All of them are idempotent and safe with any number of instances (leases in job_runs).
import { expireSubscriptions } from './services/cooks.js';
import { PgStore } from './lib/ratelimit.js';
import { migratePhotos } from './services/photoMigration.js';
import { cookStats } from './services/cooks.js';
import { waCloudConfigured, sendReportTemplate } from './services/waCloud.js';
import { getCountry } from './lib/countries.js';
import { exportToFiles } from './lib/portability.js';
import { createZip } from './lib/zip.js';
import { signV4 } from './services/storage.js';
import { deliverySettings, settleDue } from './services/delivery.js';
import { expireLinks, autoRefunds } from './services/finance.js';

const DAY = 86_400_000;
const days = (name, def) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : def; };

/** Daily copy of ALL data to a PRIVATE bucket (never the public photo bucket): BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET,
 *  BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY (+ BACKUP_S3_REGION, default "auto"). Off when not set. */
export function backupTarget(env = process.env) {
  const t = { endpoint: env.BACKUP_S3_ENDPOINT, bucket: env.BACKUP_S3_BUCKET, accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID, secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY, region: env.BACKUP_S3_REGION || 'auto' };
  return t.endpoint && t.bucket && t.accessKeyId && t.secretAccessKey ? t : null;
}
export async function runOffsiteBackup({ db, target, fetchImpl = fetch, now = new Date() }) {
  const { files, manifest } = await exportToFiles(db, { appVersion: 'auto-backup' });
  const zip = createZip(files);
  const key = `backups/aklatak-data-${now.toISOString().slice(0, 10)}.zip`;
  const url = `${target.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(target.bucket)}/${key}`;
  const headers = signV4({ method: 'PUT', url, headers: { 'content-type': 'application/zip' }, body: zip, accessKeyId: target.accessKeyId, secretAccessKey: target.secretAccessKey, region: target.region });
  const r = await fetchImpl(url, { method: 'PUT', headers, body: zip });
  if (!r.ok) throw new Error(`backup upload failed: ${r.status}`);
  return { key, bytes: zip.length, rows: Object.values(manifest.counts).reduce((a, b) => a + b, 0) };
}

export function defineJobs({ db, storage = null, push = null, payments = null, log = console }) {
  const target = backupTarget();
  const S = deliverySettings(db);
  return [
    {
      // Deliveries the customer didn't confirm: confirmed automatically after the set time, the fee goes to the driver.
      name: 'settle-deliveries', everyMs: 60_000,
      run: async () => {
        const done = await settleDue(db, await S.get());
        for (const o of done) push?.notify('driver', o.driver_id, { title: 'Aklatak', body: `💵 أُضيفت أجرة الطلب AKL${o.id}`, url: '/driver' });
        return { settled: done.length };
      },
    },
    {
      // Online settlement links not paid in time: closed, their orders can be settled again.
      name: 'expire-settlement-links', everyMs: 60_000,
      run: async () => ({ expired: await expireLinks(db) }),
    },
    {
      // Card payments of refused / cancelled orders: refunded through the gateway automatically (when PAY_REFUND_URL is set).
      name: 'auto-refunds', everyMs: 60_000,
      run: async () => {
        const done = await autoRefunds(db, payments);
        for (const r of done) {
          if (r.failed) push?.notifyAdmins?.({ title: 'Aklatak — الإدارة', body: `↩️ تعذّر الاسترداد التلقائي للطلب AKL${r.orderId} — أعِده يدوياً`, url: '/admin/#dx-finance' });
          else push?.notify('customer', r.customerId, { title: 'Aklatak', body: `↩️ أُعيد إليك ${r.amount}$ للطلب AKL${r.orderId}`, url: `/#/o/${r.orderId}` });
        }
        return { refunded: done.filter((r) => !r.failed).length };
      },
    },
    ...(target ? [{
      name: 'offsite-backup', everyMs: 24 * 60 * 60_000, retryMs: 60 * 60_000,
      run: async () => runOffsiteBackup({ db, target }),
    }] : []),
    {
      // Hide cooks whose subscription ended (search also checks dates live, so this is bookkeeping).
      name: 'expire-subscriptions', everyMs: 5 * 60_000,
      run: async () => ({ expired: await expireSubscriptions(db) }),
    },
    {
      name: 'cleanup', everyMs: 60 * 60_000,
      run: async () => {
        const now = new Date().toISOString();
        const a = (await db.query('DELETE FROM admin_sessions WHERE expires_at <= $1 RETURNING id', [now])).length;
        const c = (await db.query('DELETE FROM cook_sessions WHERE expires_at <= $1 RETURNING id', [now])).length;
        for (const t of ['customer_sessions', 'driver_sessions', 'otp_codes']) await db.query(`DELETE FROM ${t} WHERE expires_at <= $1`, [now]).catch(() => {});
        const r = await new PgStore(db).cleanup();
        return { adminSessions: a, cookSessions: c, rateLimits: r };
      },
    },
    {
      // Retention for high-volume event data, in small batches (never one huge DELETE).
      // Search impressions (up to 30 rows per search) are the biggest table; subscribers' stats use the last 30 days.
      name: 'retention', everyMs: 6 * 60 * 60_000,
      run: async () => {
        const out = { impressions: 0, visits: 0, pageViews: 0, adminLogins: 0 };
        const cutoff = new Date(Date.now() - days('RETENTION_IMPRESSIONS_DAYS', 180) * DAY).toISOString();
        const max = Number((await db.one('SELECT MAX(id) AS m FROM requests WHERE created_at < $1', [cutoff]))?.m) || 0;
        for (let from = 0; from < max; from += 2000) {
          out.impressions += (await db.query('DELETE FROM request_impressions WHERE request_id > $1 AND request_id <= $2 RETURNING request_id',
            [from, Math.min(from + 2000, max)])).length;
        }
        const dayCut = new Date(Date.now() - days('RETENTION_VISITS_DAYS', 120) * DAY).toISOString().slice(0, 10);
        out.visits = (await db.query('DELETE FROM daily_visits WHERE day < $1 RETURNING day', [dayCut])).length;
        const viewsCut = new Date(Date.now() - days('RETENTION_PAGEVIEWS_DAYS', 400) * DAY).toISOString();
        out.pageViews = (await db.query('DELETE FROM cook_page_views WHERE created_at < $1 RETURNING cook_id', [viewsCut]).catch(() => [])).length;
        const loginCut = new Date(Date.now() - days('RETENTION_ADMIN_LOGINS_DAYS', 365) * DAY).toISOString();
        out.adminLogins = (await db.query('DELETE FROM admin_logins WHERE created_at < $1 RETURNING id', [loginCut]).catch(() => [])).length;
        return out;
      },
    },
    {
      // Photos still inside the database are moved to object storage (R2/S3) automatically once it is configured.
      // Verified one by one; a photo stays in the database if storage can't serve it. STORAGE_AUTO_MIGRATE=false turns it off.
      name: 'photo-storage', everyMs: 6 * 60 * 60_000, retryMs: 30 * 60_000,
      run: async () => {
        if (!storage?.enabled || process.env.STORAGE_AUTO_MIGRATE === 'false') return { skipped: 1 };
        return migratePhotos({ db, storage });
      },
    },
    {
      // 📊 monthly report, by itself, on the 1st of each month (Beirut time) — ACTIVE subscribers only
      // (never imported places, never expired/pending ones). Does nothing until WhatsApp Cloud API keys are set.
      name: 'monthly-report', everyMs: 60 * 60_000,
      run: async ({ now = new Date(), fetchImpl } = {}) => {
        if (!waCloudConfigured()) return { skipped: 'not_configured' };
        const local = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Beirut' }));
        const month = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}`;
        if (local.getDate() !== 1) return { skipped: 'not_the_1st' };
        if (await db.one('SELECT value FROM app_meta WHERE key = $1', [`report:${month}`])) return { skipped: 'already_sent' };
        await db.query('INSERT INTO app_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [`report:${month}`, now.toISOString()]);
        const iso = now.toISOString();
        const subs = await db.query(`SELECT c.id, c.full_name, c.whatsapp, c.country FROM cooks c
          WHERE c.status = 'approved' AND c.whatsapp <> '' AND COALESCE(c.source, '') <> 'map' AND COALESCE(c.is_hidden, 0) = 0
            AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.cook_id = c.id AND s.status = 'active' AND s.start_date <= $1 AND s.expiry_date > $1)`, [iso]);
        let sent = 0, failed = 0;
        for (const c of subs) {
          const st = await cookStats(db, c.id);
          try { await sendReportTemplate(c.whatsapp, getCountry(c.country)?.lang || 'ar', [c.full_name, st.views_30d ?? 0, st.impressions_30d ?? 0, st.whatsapp_30d ?? 0, st.likes ?? 0], fetchImpl ? { fetchImpl } : {}); sent++; }
          catch { failed++; }
        }
        return { month, sent, failed };
      },
    },
  ];
}
