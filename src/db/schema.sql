-- Written for PostgreSQL. The SQLite dev adapter translates the few type differences automatically.

CREATE TABLE IF NOT EXISTS admin_users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Reserved for optional customer accounts in a later phase (registration is not required in v1).
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  display_name TEXT,
  phone TEXT UNIQUE,
  locale TEXT NOT NULL DEFAULT 'ar',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Towns / regions customers and cooks pick from (approximate centre coordinates).
CREATE TABLE IF NOT EXISTS service_areas (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT,
  name_fr TEXT,
  region TEXT,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Kinds of requests a cook can take (labels live in /locales/*.json under "services").
CREATE TABLE IF NOT EXISTS service_types (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cooks (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  area_id INTEGER REFERENCES service_areas(id) ON DELETE SET NULL,
  area_label TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  service_radius_km DOUBLE PRECISION NOT NULL,
  bio TEXT,
  photo TEXT,
  requested_plan TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  admin_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cooks_geo_idx ON cooks (lat, lng);
CREATE INDEX IF NOT EXISTS cooks_status_idx ON cooks (status);

CREATE TABLE IF NOT EXISTS cook_service_types (
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  service_type_id INTEGER NOT NULL REFERENCES service_types(id) ON DELETE CASCADE,
  PRIMARY KEY (cook_id, service_type_id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','expired','suspended')),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','waived')),
  start_date TIMESTAMPTZ,
  expiry_date TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_cook_idx ON subscriptions (cook_id, status, expiry_date);

-- One row per customer search. Stores only the request text and a rounded (~1 km) location.
CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  area_label TEXT,
  approx_lat DOUBLE PRECISION,
  approx_lng DOUBLE PRECISION,
  location_source TEXT,
  service_type_key TEXT,
  results_count INTEGER NOT NULL DEFAULT 0,
  locale TEXT NOT NULL DEFAULT 'ar',
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS requests_created_idx ON requests (created_at);

-- Which cooks were shown for a request (analytics; only shown cooks can be contacted).
CREATE TABLE IF NOT EXISTS request_impressions (
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  distance_km DOUBLE PRECISION NOT NULL,
  position INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, cook_id)
);
CREATE INDEX IF NOT EXISTS impressions_cook_idx ON request_impressions (cook_id);

CREATE TABLE IF NOT EXISTS request_contact_events (
  id SERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contact_events_cook_idx ON request_contact_events (cook_id, created_at);

CREATE TABLE IF NOT EXISTS admin_actions (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  cook_id INTEGER REFERENCES cooks(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ v2 ============

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Villages a cook delivers to (chosen by the cook).
CREATE TABLE IF NOT EXISTS cook_service_areas (
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  area_id INTEGER NOT NULL REFERENCES service_areas(id) ON DELETE CASCADE,
  PRIMARY KEY (cook_id, area_id)
);
CREATE INDEX IF NOT EXISTS cook_service_areas_area_idx ON cook_service_areas (area_id);

CREATE TABLE IF NOT EXISTS cook_sessions (
  id SERIAL PRIMARY KEY,
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Dish photos the cook uploads to her public page.
CREATE TABLE IF NOT EXISTS cook_photos (
  id SERIAL PRIMARY KEY,
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  caption TEXT,
  is_hidden INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cook_photos_cook_idx ON cook_photos (cook_id, created_at);

-- Star ratings (public aggregate). One per WhatsApp contact, so only real customers can rate.
CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  contact_event_id INTEGER NOT NULL UNIQUE REFERENCES request_contact_events(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  is_hidden INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reviews_cook_idx ON reviews (cook_id);

-- Complaints & notes: visible to the admin ONLY (never to the cook or on her page).
CREATE TABLE IF NOT EXISTS feedback (
  id SERIAL PRIMARY KEY,
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('complaint','note')),
  message TEXT NOT NULL,
  customer_name TEXT,
  customer_phone TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','resolved')),
  admin_note TEXT,
  ip_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_status_idx ON feedback (status, created_at);

CREATE TABLE IF NOT EXISTS cook_warnings (
  id SERIAL PRIMARY KEY,
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  admin_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  feedback_id INTEGER REFERENCES feedback(id) ON DELETE SET NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cook_likes (
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  viewer_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cook_id, viewer_hash)
);

CREATE TABLE IF NOT EXISTS cook_page_views (
  id SERIAL PRIMARY KEY,
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  viewer_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cook_page_views_idx ON cook_page_views (cook_id, viewer_hash, created_at);

-- ============ v3 (production) ============
-- Shared rate-limit counters (used when RATE_LIMIT_STORE=postgres).
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limits_reset_idx ON rate_limits (reset_at);

-- Background jobs: one lease row per job, so only ONE instance runs a job at a time.
CREATE TABLE IF NOT EXISTS job_runs (
  name TEXT PRIMARY KEY,
  locked_until BIGINT NOT NULL DEFAULT 0,
  locked_by TEXT,
  last_started_at BIGINT,
  last_finished_at BIGINT,
  last_status TEXT,
  last_error TEXT,
  last_result TEXT,
  runs INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0
);

-- ============ v3.2 (global) ============
-- Country + region of each ~1 km cell, learnt once from OpenStreetMap (works for any country).
CREATE TABLE IF NOT EXISTS geo_cells (
  cell TEXT PRIMARY KEY,
  country TEXT NOT NULL,
  region_key TEXT,
  region_name TEXT,
  region_name_ar TEXT,
  region_name_en TEXT,
  fetched_at BIGINT NOT NULL
);

-- ============ v4.0 (restaurants, support, banners) ============
-- Restaurant menus (items with prices shown on the restaurant page; customers can order from them).
CREATE TABLE IF NOT EXISTS menu_items (
  id SERIAL PRIMARY KEY,
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price DOUBLE PRECISION,
  currency TEXT,
  is_available INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS menu_items_cook_idx ON menu_items (cook_id, sort_order);

-- Support conversation between a cook/restaurant and the admin (inside the admin panel, not WhatsApp).
CREATE TABLE IF NOT EXISTS support_messages (
  id SERIAL PRIMARY KEY,
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  from_admin INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  read_by_admin INTEGER NOT NULL DEFAULT 0,
  read_by_cook INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_cook_idx ON support_messages (cook_id, created_at);
CREATE INDEX IF NOT EXISTS support_unread_idx ON support_messages (read_by_admin, from_admin);

-- Ads / logos uploaded by the admin, shown in chosen places of the site.
CREATE TABLE IF NOT EXISTS banners (
  id SERIAL PRIMARY KEY,
  image_data TEXT,
  image_url TEXT,
  link_url TEXT,
  title TEXT,
  placement TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS banners_place_idx ON banners (placement, is_active, sort_order);

-- ============ v4.2 (admin passkeys, backup codes, login history) ============
CREATE TABLE IF NOT EXISTS admin_passkeys (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  alg INTEGER NOT NULL,
  sign_count BIGINT NOT NULL DEFAULT 0,
  name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);
-- One-time challenges for passkey registration/login (shared by all server instances).
CREATE TABLE IF NOT EXISTS admin_auth_challenges (
  id SERIAL PRIMARY KEY,
  token_hash TEXT UNIQUE,
  admin_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_auth_challenges_admin_idx ON admin_auth_challenges (admin_id, kind, expires_at);
-- Backup codes (each usable once), stored hashed.
CREATE TABLE IF NOT EXISTS admin_backup_codes (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ
);
-- Every admin sign-in attempt (who, when, from which device, how).
CREATE TABLE IF NOT EXISTS admin_logins (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  username TEXT,
  ok INTEGER NOT NULL,
  method TEXT NOT NULL,
  ip_hash TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_logins_created_idx ON admin_logins (created_at);

-- ============ v4.5 ============
-- One row per device per day (home page visit) for the public "visitors today" counter.
CREATE TABLE IF NOT EXISTS daily_visits (
  day TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  PRIMARY KEY (day, visitor_hash)
);

-- Logos and backgrounds uploaded by the owner (admin panel → Design).
CREATE TABLE IF NOT EXISTS site_assets (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Messages from visitors ("Contact the team" at the bottom of every page)
CREATE TABLE IF NOT EXISTS site_messages (
  id SERIAL PRIMARY KEY,
  name TEXT,
  contact TEXT,
  body TEXT NOT NULL,
  locale TEXT,
  ip_hash TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Referral links: people who bring subscribers earn a commission on every paid activation / renewal
CREATE TABLE IF NOT EXISTS referrers (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contact TEXT,
  country TEXT,
  commission REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS referral_earnings (
  id SERIAL PRIMARY KEY,
  referrer_id INTEGER NOT NULL REFERENCES referrers(id) ON DELETE CASCADE,
  cook_id INTEGER,
  cook_name TEXT,
  reason TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referral_earnings_ref_idx ON referral_earnings (referrer_id, paid_at);
