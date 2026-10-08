// After moving images to another storage provider/domain: rewrite the stored image links.
//   node scripts/rewrite-storage-urls.js https://old-images.example.com https://img.newdomain.com --yes
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';

const [from, to] = process.argv.slice(2);
if (!from || !to || !process.argv.includes('--yes')) { console.error('Usage: node scripts/rewrite-storage-urls.js <old-base> <new-base> --yes'); process.exit(1); }
const db = await openDb(loadConfig());
let n = 0;
for (const [table, col] of [['cooks', 'photo_url'], ['cook_photos', 'url'], ['banners', 'image_url']]) {
  const rows = await db.query(`SELECT id, ${col} AS u FROM ${table} WHERE ${col} LIKE $1`, [`${from}%`]);
  for (const r of rows) { await db.query(`UPDATE ${table} SET ${col} = $1 WHERE id = $2`, [to + r.u.slice(from.length), r.id]); n++; }
}
console.log(`Rewrote ${n} image links.`);
await db.close();
