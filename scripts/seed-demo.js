// Adds demo cooks around Zahle (3 active + 1 expired) — for local testing only.
import { loadConfig } from '../src/config.js';
import { openDb, migrate } from '../src/db/index.js';
import { setCookServices, setServedAreas, activateSubscription, addMonths } from '../src/services/cooks.js';
import { hashPassword } from '../src/lib/security.js';

const cfg = loadConfig();
if (cfg.isProd && !process.argv.includes('--force')) { console.error('Refusing to seed demo data in production (use --force).'); process.exit(1); }
const db = await openDb(cfg);
await migrate(db);
const id = async (slug) => (await db.one('SELECT id, name_ar, lat, lng FROM service_areas WHERE slug = $1', [slug]));
const demo = [
  { name: 'أم علي', phone: '96170000001', home: 'zahle', served: ['zahle', 'saadnayel', 'taalabaya', 'chtaura', 'ferzol'], s: ['home_cooking', 'pastries', 'sweets'], bio: 'كبة، ورق عنب ومعجنات على الطريقة البقاعية.' },
  { name: 'رنا', phone: '96170000002', home: 'saadnayel', served: ['saadnayel', 'zahle', 'taalabaya', 'qab-elias'], s: ['home_cooking', 'mouneh'], bio: 'طبخ بيتي يومي ومونة موسمية.' },
  { name: 'سعاد', phone: '96170000003', home: 'chtaura', served: ['chtaura', 'zahle', 'bar-elias', 'jdita'], s: ['home_cooking', 'sweets'], bio: 'حلويات عربية وطبخات للعزايم.' },
  { name: 'نهى (اشتراك منتهي)', phone: '96170000004', home: 'zahle', served: ['zahle'], s: ['home_cooking'], bio: '', expired: true },
];
for (const d of demo) {
  if (await db.one('SELECT id FROM cooks WHERE whatsapp = $1', [d.phone])) continue;
  const home = await id(d.home);
  const row = await db.one(
    `INSERT INTO cooks (full_name, whatsapp, area_id, area_label, lat, lng, service_radius_km, bio, status, password_hash)
     VALUES ($1,$2,$3,$4,$5,$6,0,$7,'approved',$8) RETURNING id`,
    [d.name, d.phone, home.id, home.name_ar, home.lat, home.lng, d.bio, await hashPassword('teta1234')]);
  await setCookServices(db, row.id, d.s);
  await setServedAreas(db, row.id, await Promise.all(d.served.map(async (s) => (await id(s)).id)));
  const start = d.expired ? addMonths(new Date(), -2) : new Date(Date.now() - 60_000);
  await activateSubscription(db, row.id, { plan: 'monthly', startDate: start, paymentStatus: 'paid' });
}
await db.query(`UPDATE subscriptions SET status='expired' WHERE expiry_date <= $1 AND status='active'`, [new Date().toISOString()]);
console.log('Demo cooks ready (password for all: teta1234).');
await db.close();
