// Moves images stored inside the database to S3-compatible storage (Cloudflare R2 / AWS S3).
// Same as the admin panel button "Move photos to R2" (Backup & storage). Safe to re-run.
//   node scripts/move-photos-to-storage.js
import { loadConfig } from '../src/config.js';
import { openDb, migrate } from '../src/db/index.js';
import { createStorage } from '../src/services/storage.js';
import { migratePhotos } from '../src/services/photoMigration.js';

const cfg = loadConfig();
const storage = createStorage(cfg);
if (!storage.enabled) { console.error('S3_* variables are not set — nothing to do.'); process.exit(1); }
const db = await openDb(cfg);
await migrate(db);
const r = await migratePhotos({ db, storage, onProgress: (p) => console.log(`moved ${p.moved} dish photos, ${p.avatars} profile photos…`) });
console.log(`Done: ${r.moved} dish photos and ${r.avatars} profile photos now served from storage; ${r.kept} kept in the database (retry later).`);
await db.close();
