// Full data export / restore — the owner's data never stays locked at one provider.
// Export: every table → <dir>/<table>.json (+ manifest.json with counts, order, storage info).
// Import: into a NEW, empty, migrated database (Postgres or SQLite), keeping ids and relations, then repairs sequences.
// Images stored in the database (data URLs) are inside the rows; images on object storage are listed in the manifest.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Parents before children (foreign keys). Temporary/derived tables are not exported:
// sessions (users log in again), rate limits, job leases.
export const EXPORT_ORDER = [
  'app_meta', 'admin_users', 'service_types', 'service_areas', 'geo_cells',
  'cooks', 'cook_service_types', 'cook_service_areas', 'subscriptions',
  'requests', 'request_impressions', 'request_contact_events', 'reviews',
  'feedback', 'cook_warnings', 'cook_likes', 'cook_page_views', 'cook_photos',
  'menu_items', 'support_messages', 'banners', 'admin_actions', 'admin_passkeys', 'admin_backup_codes', 'admin_logins', 'daily_visits', 'site_assets', 'site_messages', 'referrers', 'referral_earnings',
  // v7 delivery: customers, drivers (with their private papers), orders, balances, withdrawals, complaints, warnings, appointments, errands, chats
  'customers', 'customer_addresses', 'customer_favorites', 'drivers', 'driver_documents',
  'orders', 'order_items', 'order_offers', 'wallet_ledger', 'topups', 'payouts', 'withdrawals', 'complaints', 'warnings',
  'appointments', 'visit_requests', 'errands', 'errand_offers', 'errand_messages', 'broadcasts', 'push_subscriptions', 'push_targets', 'renewals', 'payments',
];
export const SKIPPED = ['admin_sessions', 'cook_sessions', 'customer_sessions', 'driver_sessions', 'otp_codes', 'rate_limits', 'job_runs', 'admin_auth_challenges'];

async function existingTables(db) {
  const rows = db.kind === 'pg'
    ? await db.query(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public'`)
    : await db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
  return new Set(rows.map((r) => r.name));
}

const toJsonValue = (v) => (v instanceof Date ? v.toISOString() : v);

export async function exportAll(db, dir, { appVersion = '', storageKind = 'db' } = {}) {
  await mkdir(dir, { recursive: true });
  const have = await existingTables(db);
  const tables = [...EXPORT_ORDER.filter((t) => have.has(t)), ...[...have].filter((t) => !EXPORT_ORDER.includes(t) && !SKIPPED.includes(t)).sort()];
  const counts = {};
  const storageUrls = [];
  for (const t of tables) {
    const rows = (await db.query(`SELECT * FROM ${t}`)).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toJsonValue(v)])));
    counts[t] = rows.length;
    for (const r of rows) for (const k of ['photo_url', 'url', 'image_url']) if (typeof r[k] === 'string' && /^https?:/.test(r[k])) storageUrls.push(r[k]);
    await writeFile(join(dir, `${t}.json`), JSON.stringify(rows));
  }
  const manifest = {
    format: 'aklatak-export/1', exportedAt: new Date().toISOString(), appVersion, database: db.kind,
    tables, counts, skipped: SKIPPED, storage: { kind: storageKind, externalFiles: storageUrls.length, urls: storageUrls },
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Restore an export into an empty database that has just been migrated (seeded rows are replaced by the export). */
export async function importAll(db, dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const have = await existingTables(db);
  const tables = manifest.tables.filter((t) => have.has(t));
  // Clear in reverse order (children first), then insert parents first.
  for (const t of [...tables].reverse()) await db.query(`DELETE FROM ${t}`);
  const inserted = {};
  for (const t of tables) {
    const rows = JSON.parse(await readFile(join(dir, `${t}.json`), 'utf8'));
    const cols = db.kind === 'pg'
      ? new Set((await db.query(`SELECT column_name AS name FROM information_schema.columns WHERE table_name = $1`, [t])).map((r) => r.name))
      : new Set((await db.query(`PRAGMA table_info(${t})`)).map((r) => r.name));
    for (const r of rows) {
      const keys = Object.keys(r).filter((k) => cols.has(k));
      await db.query(`INSERT INTO ${t} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, keys.map((k) => r[k]));
    }
    inserted[t] = rows.length;
    if (db.kind === 'pg' && cols.has('id')) {
      await db.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${t}), 1))`).catch(() => {});
    }
  }
  return { tables, inserted, expected: manifest.counts };
}

/* ---------- in-memory variants (one-tap backup/restore from the admin panel) ---------- */

/** → { files: [{ name, data }], manifest } with every exported table as JSON. */
export async function exportToFiles(db, { appVersion = '', storageKind = 'db', fingerprint = '' } = {}) {
  const have = await existingTables(db);
  const tables = [...EXPORT_ORDER.filter((t) => have.has(t)), ...[...have].filter((t) => !EXPORT_ORDER.includes(t) && !SKIPPED.includes(t)).sort()];
  const files = []; const counts = {}; const storageUrls = [];
  for (const t of tables) {
    const rows = (await db.query(`SELECT * FROM ${t}`)).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toJsonValue(v)])));
    counts[t] = rows.length;
    for (const r of rows) for (const k of ['photo_url', 'url', 'image_url']) if (typeof r[k] === 'string' && /^https?:/.test(r[k])) storageUrls.push(r[k]);
    files.push({ name: `data/${t}.json`, data: JSON.stringify(rows) });
  }
  const manifest = {
    format: 'aklatak-export/1', exportedAt: new Date().toISOString(), appVersion, fingerprint, database: db.kind,
    tables, counts, skipped: SKIPPED, storage: { kind: storageKind, externalFiles: storageUrls.length, urls: storageUrls },
  };
  files.push({ name: 'data/manifest.json', data: JSON.stringify(manifest, null, 2) });
  return { files, manifest };
}

/** Restore from a Map(name → Buffer) produced by exportToFiles (inside a backup zip). */
export async function importFromFiles(db, entries) {
  const get = (n) => { const b = entries.get(n); if (!b) throw new Error(`missing ${n}`); return JSON.parse(b.toString('utf8')); };
  const manifest = get('data/manifest.json');
  if (manifest.format !== 'aklatak-export/1') throw new Error('not an Aklatak backup');
  const have = await existingTables(db);
  const tables = manifest.tables.filter((t) => have.has(t));
  for (const t of [...tables].reverse()) await db.query(`DELETE FROM ${t}`);
  const inserted = {};
  for (const t of tables) {
    const rows = get(`data/${t}.json`);
    const cols = db.kind === 'pg'
      ? new Set((await db.query(`SELECT column_name AS name FROM information_schema.columns WHERE table_name = $1`, [t])).map((r) => r.name))
      : new Set((await db.query(`PRAGMA table_info(${t})`)).map((r) => r.name));
    for (const r of rows) {
      const keys = Object.keys(r).filter((k) => cols.has(k));
      await db.query(`INSERT INTO ${t} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, keys.map((k) => r[k]));
    }
    inserted[t] = rows.length;
    if (db.kind === 'pg' && cols.has('id')) {
      await db.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${t}), 1))`).catch(() => {});
    }
  }
  return { tables, inserted, expected: manifest.counts, manifest };
}
