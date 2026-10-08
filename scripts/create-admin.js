// Usage: npm run create-admin -- <username>
// Password is read from ADMIN_PASSWORD env var, or asked interactively (hidden).
// Running it again for an existing username resets that password and logs out its sessions.
import { createInterface } from 'node:readline';
import { loadConfig } from '../src/config.js';
import { openDb, migrate } from '../src/db/index.js';
import { createAdminUser } from '../src/routes/admin.js';

const username = process.argv[2];
if (!username) { console.error('Usage: npm run create-admin -- <username>'); process.exit(1); }

async function askHidden(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); };
  return new Promise((r) => rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); r(a); }));
}

const password = process.env.ADMIN_PASSWORD || (await askHidden('Password (min 10 chars): '));
const db = await openDb(loadConfig());
await migrate(db);
try {
  const r = await createAdminUser(db, username, password);
  console.log(r.updated ? `Password updated for "${username}".` : `Admin "${username}" created.`);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
