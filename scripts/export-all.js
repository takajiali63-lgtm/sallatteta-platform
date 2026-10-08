// Full export of the platform's data (all users, cooks, restaurants, subscriptions, orders, photos stored in the DB…)
//   node scripts/export-all.js ./backups/2026-10-01
// Keep the folder somewhere safe (it contains personal data). No secrets are exported.
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { exportAll } from '../src/lib/portability.js';
import { readFileSync } from 'node:fs';

const dir = process.argv[2] || `./backups/export-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
const cfg = loadConfig();
const db = await openDb(cfg);
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const m = await exportAll(db, dir, { appVersion: version, storageKind: cfg.s3?.endpoint ? 's3' : 'db' });
console.log(`Exported ${Object.values(m.counts).reduce((a, b) => a + b, 0)} rows from ${m.tables.length} tables to ${dir}`);
if (m.storage.externalFiles) console.log(`${m.storage.externalFiles} images are on object storage: copy the bucket too (see docs/MIGRATION.md).`);
await db.close();
