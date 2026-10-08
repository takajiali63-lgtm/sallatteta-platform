// Creates/updates tables and reference data. Also runs automatically on server start.
import { loadConfig } from '../src/config.js';
import { openDb, migrate } from '../src/db/index.js';

const db = await openDb(loadConfig());
await migrate(db);
console.log(`Database ready (${db.kind}).`);
await db.close();
