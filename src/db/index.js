// Tiny database adapter: PostgreSQL in production, SQLite (node:sqlite) for local dev/tests.
// All SQL in the app is written once, PostgreSQL-style ($1, $2 …), and kept portable.
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export async function openDb(cfg) {
  const url = cfg.databaseUrl;
  if (url.startsWith('sqlite:')) return openSqlite(url.slice('sqlite:'.length));
  if (/^postgres(ql)?:\/\//.test(url)) return openPg(url, cfg.databaseSsl, cfg.dbPoolMax);
  throw new Error('DATABASE_URL must start with postgres:// or sqlite:');
}

async function openPg(url, ssl, poolMax = 10) {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(701, (v) => parseFloat(v)); // DOUBLE PRECISION → number
  const pool = new pg.Pool({
    connectionString: url,
    // Verify the database's TLS certificate (Neon/AWS/… use public CAs). DATABASE_SSL_INSECURE=true only for a provider without one.
    ssl: ssl ? { rejectUnauthorized: process.env.DATABASE_SSL_INSECURE !== 'true' } : undefined,
    max: poolMax || 10,
    // A stuck query frees its connection after 20 s instead of blocking the pool (DB_QUERY_TIMEOUT_MS).
    query_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS) || 20_000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  const poolStats = () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount });
  const wrap = (client) => {
    const query = async (sql, params = []) => (await client.query(sql, params)).rows;
    return { query, one: async (sql, params) => (await query(sql, params))[0] || null };
  };
  return {
    kind: 'pg',
    stats: poolStats,
    ...wrap(pool),
    async exec(sqlText) { await pool.query(sqlText); },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async close() { await pool.end(); },
  };
}

async function openSqlite(file) {
  const { DatabaseSync } = await import('node:sqlite');
  if (file !== ':memory:') await mkdir(dirname(resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  const cache = new Map();
  const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v instanceof Date ? v.toISOString() : v);
  const query = async (sql, params = []) => {
    let st = cache.get(sql);
    if (!st) { st = db.prepare(sql.replace(/\$(\d+)/g, '?$1')); cache.set(sql, st); }
    return st.all(...params.map(norm)).map((r) => ({ ...r }));
  };
  const one = async (sql, params) => (await query(sql, params))[0] || null;
  let txQueue = Promise.resolve();
  return {
    kind: 'sqlite',
    query,
    one,
    async exec(sqlText) { db.exec(sqlitify(sqlText)); },
    // One transaction at a time (a single connection): concurrent requests wait their turn instead of failing.
    async tx(fn) {
      const run = async () => {
        db.exec('BEGIN');
        try { const out = await fn({ query, one }); db.exec('COMMIT'); return out; }
        catch (e) { db.exec('ROLLBACK'); throw e; }
      };
      const p = txQueue.then(run, run);
      txQueue = p.catch(() => {});
      return p;
    },
    async close() { db.close(); },
  };
}

function sqlitify(sql) {
  return sql
    .replace(/SERIAL PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT')
    .replace(/TIMESTAMPTZ/g, 'TEXT')
    .replace(/DOUBLE PRECISION/g, 'REAL')
    .replace(/DEFAULT now\(\)/g, "DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
}

async function addColumn(db, table, column, type) {
  try {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (e) {
    if (!/duplicate column|already exists/i.test(e.message)) throw e;
  }
}

// Idempotent: safe to run on every boot.
export async function migrate(db) {
  const schema = await readFile(resolve(here, 'schema.sql'), 'utf8');
  await db.exec(schema);
  // v7: delivery system (customers, drivers, orders, wallet, complaints, warnings)
  await db.exec(await readFile(resolve(here, 'delivery.sql'), 'utf8'));
  await addColumn(db, 'cooks', 'delivery_mode', "TEXT NOT NULL DEFAULT 'none'");
  await addColumn(db, 'cooks', 'suspended', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(db, 'cooks', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(db, 'cooks', 'accepting_orders', 'INTEGER NOT NULL DEFAULT 1');
  await addColumn(db, 'orders', 'self_delivery', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(db, 'drivers', 'jobs_until', 'TEXT');          // v7.2: "customer requests" subscription end
  await addColumn(db, 'complaints', 'errand_id', 'INTEGER');
  await addColumn(db, 'errands', 'country', 'TEXT');
  await addColumn(db, 'orders', 'country', 'TEXT');
  // v7.5
  await addColumn(db, 'orders', 'fee_state', 'TEXT');
  await addColumn(db, 'orders', 'confirmed_at', 'TEXT');
  await addColumn(db, 'orders', 'store_paid', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(db, 'orders', 'store_paid_at', 'TEXT');
  await addColumn(db, 'orders', 'customer_hidden', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(db, 'orders', 'driver_hidden', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(db, 'orders', 'store_hidden', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(db, 'orders', 'claim_until', 'TEXT');
  await addColumn(db, 'orders', 'reassigns', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(db, 'orders', 'cancel_note', 'TEXT');
  await addColumn(db, 'order_offers', 'claimed_at', 'TEXT');
  await addColumn(db, 'order_offers', 'claim_m', 'INTEGER');
  await addColumn(db, 'order_offers', 'lost_at', 'TEXT');
  await addColumn(db, 'order_offers', 'addon', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(db, 'errands', 'customer_hidden', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(db, 'errands', 'driver_hidden', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(db, 'errands', 'claim_until', 'TEXT');
  await addColumn(db, 'errand_offers', 'claimed_at', 'TEXT');
  await addColumn(db, 'errand_offers', 'claim_m', 'INTEGER');
  await addColumn(db, 'errand_offers', 'lost_at', 'TEXT');
  await addColumn(db, 'drivers', 'birth_date', 'TEXT');
  await addColumn(db, 'drivers', 'jobs_request_months', 'INTEGER');
  await addColumn(db, 'cooks', 'parent_id', 'INTEGER');
  await addColumn(db, 'cooks', 'accent_color', 'TEXT');
  await addColumn(db, 'cooks', 'record_limit', 'INTEGER NOT NULL DEFAULT 1000');
  await addColumn(db, 'cooks', 'plan_delivery', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(db, 'cooks', 'payout_number', 'TEXT');
  // v7.6
  await addColumn(db, 'cooks', 'wa_orders', 'INTEGER NOT NULL DEFAULT 1');
  await addColumn(db, 'appointments', 'store_reply', 'TEXT');
  await addColumn(db, 'appointments', 'cancelled_by', 'TEXT');
  await addColumn(db, 'appointments', 'customer_hidden', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(db, 'appointments', 'store_hidden', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(db, 'withdrawals', 'auto_ref', 'TEXT');
  // v7.6 money model: the customer pays food + delivery fee (cash to the driver, or card)
  await addColumn(db, 'orders', 'customer_total', 'DOUBLE PRECISION');          // NULL = an order from before v7.6
  await addColumn(db, 'orders', 'payment_method', "TEXT NOT NULL DEFAULT 'cash'");
  await addColumn(db, 'orders', 'payment_status', "TEXT NOT NULL DEFAULT 'cash_on_delivery'");
  await addColumn(db, 'orders', 'financial_status', "TEXT NOT NULL DEFAULT 'open'");
  await addColumn(db, 'orders', 'bonus_fee', 'DOUBLE PRECISION NOT NULL DEFAULT 0');
  await addColumn(db, 'cooks', 'delivery_fee', 'DOUBLE PRECISION NOT NULL DEFAULT 2');
  await addColumn(db, 'cooks', 'pay_methods', "TEXT NOT NULL DEFAULT 'cash'");
  await addColumn(db, 'cooks', 'delivery_radius_km', 'DOUBLE PRECISION NOT NULL DEFAULT 0');
  // orders finished under the old rules keep them (never turned into cash payables)
  await db.exec(`UPDATE orders SET financial_status = 'legacy' WHERE customer_total IS NULL AND financial_status = 'open' AND status IN ('delivered','cancelled','rejected')`);
  // v7.6 products in sections, with an optional photo
  await addColumn(db, 'renewals', 'branch_id', 'INTEGER');
  await addColumn(db, 'settlements', 'sender_number', 'TEXT');   // the Whish/OMT number the money was sent FROM (may not be the driver's)   // a renewal row can also pay for one extra branch
  // v7.7: settlements paid online (Whish / OMT / card link with a fixed amount, confirmed automatically) + per-country ways
  await addColumn(db, 'settlements', 'gateway', 'TEXT');          // whish | omt | card when paid online
  await addColumn(db, 'settlements', 'pay_token', 'TEXT');
  await addColumn(db, 'settlements', 'expires_at', 'TEXT');
  await addColumn(db, 'settlements', 'paid_amount', 'DOUBLE PRECISION');
  await addColumn(db, 'settlements', 'provider_ref', 'TEXT');
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS settlements_token_idx ON settlements (pay_token) WHERE pay_token IS NOT NULL');
  await addColumn(db, 'withdrawals', 'settlement_id', 'INTEGER');  // a restaurant's share sent automatically after a settlement
  await addColumn(db, 'withdrawals', 'last_error', 'TEXT');
  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_settlement_idx ON withdrawals (settlement_id, account_type, account_id) WHERE settlement_id IS NOT NULL`);
  await addColumn(db, 'cooks', 'payout_provider', 'TEXT');
  await addColumn(db, 'order_payments', 'refund_tries', 'INTEGER NOT NULL DEFAULT 0');   // automatic refund attempts
  await addColumn(db, 'order_payments', 'refund_error', 'TEXT');         // whish | omt — where the restaurant receives its money
  if (db.kind === 'pg') {
    // the old checks allowed only whish/omt and four statuses; the new ones are kept in code + this check
    await db.exec(`DO $$ BEGIN
      ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_method_check;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settlements_status_v77') THEN
        ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_status_check;
        ALTER TABLE settlements ADD CONSTRAINT settlements_status_v77 CHECK (status IN ('awaiting_payment','pending','verified','rejected','correction','expired'));
      END IF; END $$;`);
  }
  await addColumn(db, 'orders', 'rating', 'INTEGER');          // the customer's stars (1–5) and note on a finished order
  await addColumn(db, 'orders', 'rating_note', 'TEXT');
  await addColumn(db, 'menu_items', 'section', 'TEXT');
  await addColumn(db, 'cooks', 'menu_sections', 'TEXT');   // the store's own product sections, in its order (JSON)
  await addColumn(db, 'menu_items', 'photo_mime', 'TEXT');
  await addColumn(db, 'menu_items', 'photo', 'TEXT');
  // phones subscribed before v7.6 move to the new table (which allows the same phone for several accounts)
  await db.exec(`INSERT INTO push_targets (owner_type, owner_id, endpoint, p256dh, auth) SELECT owner_type, owner_id, endpoint, p256dh, auth FROM push_subscriptions`);
  await db.exec('DELETE FROM push_subscriptions');
  await db.exec(`CREATE INDEX IF NOT EXISTS cooks_parent_idx ON cooks (parent_id)`);
  // v2 columns on existing tables
  await addColumn(db, 'service_areas', 'district', 'TEXT');
  await addColumn(db, 'cooks', 'password_hash', 'TEXT');
  await addColumn(db, 'request_contact_events', 'review_token', 'TEXT');
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS contact_review_token_idx ON request_contact_events (review_token)');
  // v2.4 (scale): images on object storage, normalised names for search, indexes for hot queries
  await addColumn(db, 'cooks', 'photo_url', 'TEXT');
  await addColumn(db, 'cooks', 'name_norm', 'TEXT');
  await addColumn(db, 'cook_photos', 'url', 'TEXT');
  await addColumn(db, 'cook_photos', 'thumb_url', 'TEXT');
  await addColumn(db, 'cooks', 'country', 'TEXT');
  // v3.1: admin can hide an account from the whole public site (reversible)
  await addColumn(db, 'cooks', 'is_hidden', 'INTEGER NOT NULL DEFAULT 0');
  // v3.2 (global): country & region for every cook and place; subscription currency & amount
  await addColumn(db, 'cooks', 'region_key', 'TEXT');
  await addColumn(db, 'cooks', 'region_name', 'TEXT');
  await addColumn(db, 'cooks', 'region_name_ar', 'TEXT');
  await addColumn(db, 'cooks', 'region_name_en', 'TEXT');
  await addColumn(db, 'service_areas', 'country', 'TEXT');
  await addColumn(db, 'subscriptions', 'currency', 'TEXT');
  await addColumn(db, 'subscriptions', 'amount', 'DOUBLE PRECISION');
  await db.exec(`
    CREATE INDEX IF NOT EXISTS cooks_country_region_idx ON cooks (country, region_key);
    CREATE INDEX IF NOT EXISTS service_areas_country_idx ON service_areas (country);
  `);
  // v4.0: restaurants share the cooks table (same GPS, towns, subscriptions, admin tools), with a kind + specialty
  await addColumn(db, 'cooks', 'kind', "TEXT NOT NULL DEFAULT 'cook'");
  await addColumn(db, 'cooks', 'specialty', 'TEXT');
  // v4.1: proof that the subscriber accepted the terms (date + version)
  await addColumn(db, 'cooks', 'terms_accepted_at', 'TEXT');
  // v4.2: admin can require a passkey (or a backup code) at sign-in
  await addColumn(db, 'admin_users', 'mfa_required', 'INTEGER NOT NULL DEFAULT 0');
  // v4.2: the subscriber's language (messages from the team are sent in it)
  await addColumn(db, 'cooks', 'locale', 'TEXT');
  // v4.4 (location system): finer place names per cell; the subscriber's GPS quality and structured address (internal only);
  // exact distance (metres) of each search result.
  for (const c of ['city', 'district', 'locality']) await addColumn(db, 'geo_cells', c, 'TEXT');
  await addColumn(db, 'cooks', 'location_accuracy_m', 'INTEGER');
  await addColumn(db, 'cooks', 'location_at', 'TEXT');
  for (const c of ['addr_city', 'addr_district', 'addr_locality']) await addColumn(db, 'cooks', c, 'TEXT');
  await addColumn(db, 'request_impressions', 'distance_m', 'INTEGER');
  // v4.5: ads can end automatically
  await addColumn(db, 'banners', 'expires_at', 'TEXT');
  // v4.6: ads sent by businesses ("Advertise"): waiting for the owner's approval (and, later, payment)
  await addColumn(db, 'banners', 'status', "TEXT NOT NULL DEFAULT 'active'");
  for (const c of ['advertiser_name', 'advertiser_whatsapp', 'note', 'currency']) await addColumn(db, 'banners', c, 'TEXT');
  await addColumn(db, 'banners', 'duration_days', 'INTEGER');
  await addColumn(db, 'banners', 'amount', 'REAL');
  // v5.1: shops imported from the map + "directions" button
  await addColumn(db, 'cooks', 'call_phone', 'TEXT');              // landline (call only, no WhatsApp)
  await addColumn(db, 'cooks', 'ext_ref', 'TEXT');                 // map reference (no duplicates on re-import)
  await addColumn(db, 'cooks', 'source', 'TEXT');                  // 'map' for imported shops
  await addColumn(db, 'cooks', 'allow_directions', 'INTEGER NOT NULL DEFAULT 1');
  await db.query('CREATE INDEX IF NOT EXISTS cooks_ext_ref_idx ON cooks (ext_ref)');
  // v5.2: country agents (limited admin accounts, one country each)
  await addColumn(db, 'admin_users', 'role', "TEXT NOT NULL DEFAULT 'owner'");
  await addColumn(db, 'admin_users', 'country', 'TEXT');
  await addColumn(db, 'cooks', 'referrer_id', 'INTEGER');
  await addColumn(db, 'cooks', 'verified', 'INTEGER NOT NULL DEFAULT 0');
  await addColumn(db, 'cooks', 'hours', 'TEXT');
  await addColumn(db, 'cooks', 'booking', 'INTEGER NOT NULL DEFAULT 0');   // v6.0: optional pre-booking add-on
  await db.query('CREATE TABLE IF NOT EXISTS booking_events (cook_id INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)');   // v5.9: opening hours {"open":"09:00","close":"22:00","closed":[5]}   // v5.8: ✓ verified (paying) subscriber   // v5.5: subscriber brought by a referral link
  await addColumn(db, 'admin_users', 'disabled', 'INTEGER NOT NULL DEFAULT 0');   // a suspended agent can't sign in
  // v5.2: a subscriber's country follows the town it is in (fixes shops added before countries were separated)
  await db.query(`UPDATE cooks SET country = (SELECT sa.country FROM service_areas sa WHERE sa.id = cooks.area_id)
    WHERE area_id IS NOT NULL AND EXISTS (SELECT 1 FROM service_areas sa WHERE sa.id = cooks.area_id
      AND sa.country IS NOT NULL AND sa.country <> '' AND sa.country <> COALESCE(cooks.country, ''))`);
  if (db.kind === 'pg') {
    // Coordinates must be on Earth (Postgres can add checks to existing tables; SQLite validates in code only).
    for (const [table, name] of [['cooks', 'cooks_latlng_chk'], ['service_areas', 'service_areas_latlng_chk']]) {
      await db.exec(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
          ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180) NOT VALID;
        END IF; END $$;`);
    }
  }
  await addColumn(db, 'cooks', 'terms_version', 'TEXT');
  await addColumn(db, 'subscriptions', 'is_trial', 'INTEGER NOT NULL DEFAULT 0');
  await db.exec('CREATE INDEX IF NOT EXISTS cooks_kind_idx ON cooks (kind, status)');
  await backfillLebanon(db);
  await db.exec('CREATE INDEX IF NOT EXISTS cooks_hidden_idx ON cooks (is_hidden)');
  await db.exec(`
    CREATE INDEX IF NOT EXISTS cooks_status_idx ON cooks (status);
    CREATE INDEX IF NOT EXISTS cooks_name_norm_idx ON cooks (name_norm);
    CREATE INDEX IF NOT EXISTS cooks_created_idx ON cooks (created_at);
    CREATE INDEX IF NOT EXISTS subscriptions_cook_status_idx ON subscriptions (cook_id, status, expiry_date);
    CREATE INDEX IF NOT EXISTS subscriptions_status_expiry_idx ON subscriptions (status, expiry_date);
    CREATE INDEX IF NOT EXISTS impressions_cook_idx ON request_impressions (cook_id, created_at);
    CREATE INDEX IF NOT EXISTS contacts_cook_idx ON request_contact_events (cook_id, created_at);
    CREATE INDEX IF NOT EXISTS requests_created_idx ON requests (created_at);
    CREATE INDEX IF NOT EXISTS feedback_cook_idx ON feedback (cook_id, status);
    CREATE INDEX IF NOT EXISTS warnings_cook_idx ON cook_warnings (cook_id);
    CREATE INDEX IF NOT EXISTS service_areas_latlng_idx ON service_areas (lat, lng);
    CREATE INDEX IF NOT EXISTS admin_sessions_exp_idx ON admin_sessions (expires_at);
    CREATE INDEX IF NOT EXISTS cook_sessions_exp_idx ON cook_sessions (expires_at);
  `);
  const { normalizeName } = await import('../../public/assets/normalize.js');
  for (const c of await db.query('SELECT id, full_name FROM cooks WHERE name_norm IS NULL')) {
    await db.query('UPDATE cooks SET name_norm = $1 WHERE id = $2', [normalizeName(c.full_name), c.id]);
  }

  const { SERVICE_TYPES, AREAS, SEED_VERSION } = await import('./seed-data.js');
  const meta = await db.one(`SELECT value FROM app_meta WHERE key = 'seed_version'`);
  if (meta?.value !== SEED_VERSION) {
    for (const [i, key] of SERVICE_TYPES.entries()) {
      await db.query('INSERT INTO service_types (key, sort_order) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, i]);
    }
    for (const [i, a] of AREAS.entries()) {
      await db.query(
        `INSERT INTO service_areas (slug, name_ar, name_en, name_fr, region, district, lat, lng, sort_order)
         VALUES ($1,$2,$3,$3,$4,$4,$5,$6,$7)
         ON CONFLICT (slug) DO UPDATE SET district = EXCLUDED.district`,
        [a.slug, a.ar, a.en, a.district, a.lat, a.lng, i],
      );
    }
    if (meta) await db.query(`UPDATE app_meta SET value = $1 WHERE key = 'seed_version'`, [SEED_VERSION]);
    else await db.query(`INSERT INTO app_meta (key, value) VALUES ('seed_version', $1)`, [SEED_VERSION]);
  }
  await backfillServedAreas(db);
}

// v1 cooks had a km radius; give them the villages inside that radius (only if they have none yet).
async function backfillServedAreas(db) {
  const cooks = await db.query(
    `SELECT c.id, c.lat, c.lng, c.service_radius_km FROM cooks c
     WHERE c.service_radius_km > 0 AND NOT EXISTS (SELECT 1 FROM cook_service_areas s WHERE s.cook_id = c.id)`);
  if (!cooks.length) return;
  const { haversineKm } = await import('../lib/geo.js');
  const areas = await db.query('SELECT id, lat, lng FROM service_areas');
  for (const c of cooks) {
    for (const a of areas) {
      if (haversineKm(c.lat, c.lng, a.lat, a.lng) <= c.service_radius_km) {
        await db.query('INSERT INTO cook_service_areas (cook_id, area_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [c.id, a.id]);
      }
    }
  }
}

// Everything that existed before v3.2 is in Lebanon: mark places & cooks with country LB and their governorate.
async function backfillLebanon(db) {
  const { GOVERNORATES } = await import('./seed-data.js');
  const lbDistricts = GOVERNORATES.LB.flatMap((g) => g.districts);
  const ph = lbDistricts.map((_, i) => `$${i + 1}`).join(',');
  await db.query(`UPDATE service_areas SET country = 'LB' WHERE country IS NULL AND district IN (${ph})`, lbDistricts);
  await db.query(`UPDATE cooks SET country = 'LB' WHERE country IS NULL`);
  for (const g of GOVERNORATES.LB) {
    const dph = g.districts.map((_, i) => `$${i + 5}`).join(',');
    await db.query(
      `UPDATE cooks SET region_key = $1, region_name = $2, region_name_ar = $3, region_name_en = $4
       WHERE region_key IS NULL AND country = 'LB' AND area_id IN (SELECT id FROM service_areas WHERE district IN (${dph}))`,
      [`LB-${g.key}`, g.ar, g.ar, g.en, ...g.districts]);
  }
}
