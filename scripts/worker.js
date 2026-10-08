// Background worker: runs the scheduled jobs without serving web traffic.
// Render: a "Background Worker" service with start command `npm run worker`, and RUN_JOBS=false on the web service.
// Safe to run next to web instances that also run jobs: leases prevent duplicates.
import { loadConfig } from '../src/config.js';
import { openDb, migrate } from '../src/db/index.js';
import { createJobRunner } from '../src/lib/jobs.js';
import { defineJobs } from '../src/jobs.js';
import { log } from '../src/lib/log.js';

const cfg = loadConfig();
const db = await openDb(cfg);
await migrate(db);
const runner = createJobRunner({ db, jobs: defineJobs({ db }), log });
await runner.start();
log.info(`[worker] started as ${runner.instanceId}`);
const stop = async () => { log.info('[worker] stopping'); await runner.stop(); await db.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
