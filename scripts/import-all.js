// Restore an export into a NEW, empty database (e.g. after moving to another provider).
//   DATABASE_URL=postgres://… node scripts/import-all.js ./backups/2026-10-01 --yes
// Refuses to run on a database that already has cooks, unless --force.
import { loadConfig } from '../src/config.js';
import { openDb, migrate } from '../src/db/index.js';
import { importAll } from '../src/lib/portability.js';

const dir = process.argv[2];
if (!dir || !process.argv.includes('--yes')) { console.error('Usage: node scripts/import-all.js <export-folder> --yes'); process.exit(1); }
const cfg = loadConfig();
const db = await openDb(cfg);
await migrate(db);
const existing = await db.one('SELECT COUNT(*) AS n FROM cooks');
if (Number(existing.n) > 0 && !process.argv.includes('--force')) { console.error('Target database is not empty. Use a new database (or --force).'); process.exit(1); }
const r = await importAll(db, dir);
const bad = Object.entries(r.expected).filter(([t, n]) => r.inserted[t] !== undefined && r.inserted[t] !== n);
console.log(bad.length ? `Mismatch: ${JSON.stringify(bad)}` : `Restored ${r.tables.length} tables — row counts match the export.`);
await db.close();
