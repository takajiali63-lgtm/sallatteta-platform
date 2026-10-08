-- v7 delivery system: customers, drivers, orders, store wallet, driver payouts, complaints and warnings.
-- Times we compare are stored as ISO text (portable between PostgreSQL and SQLite).

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  country TEXT,
  locale TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  terms_accepted_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_sessions (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_addresses (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_addresses_idx ON customer_addresses (customer_id);

CREATE TABLE IF NOT EXISTS customer_favorites (
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, cook_id)
);

-- One-time SMS codes (only used once an SMS provider key is set).
CREATE TABLE IF NOT EXISTS otp_codes (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_codes_phone_idx ON otp_codes (phone);

CREATE TABLE IF NOT EXISTS drivers (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  vehicle TEXT NOT NULL CHECK (vehicle IN ('moto','car')),
  plate TEXT,
  wallet_provider TEXT CHECK (wallet_provider IN ('whish','omt')),
  wallet_number TEXT,
  country TEXT,
  locale TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','rejected')),
  available INTEGER NOT NULL DEFAULT 0,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  loc_at TEXT,
  terms_accepted_at TEXT,
  admin_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS drivers_avail_idx ON drivers (status, available, country);

CREATE TABLE IF NOT EXISTS driver_sessions (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Identity papers are PRIVATE: kept in the database (never on the public photo storage), shown to the admin only.
CREATE TABLE IF NOT EXISTS driver_documents (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS driver_documents_idx ON driver_documents (driver_id);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','rejected','preparing','searching','assigned','picked_up','delivered','cancelled')),
  total DOUBLE PRECISION NOT NULL,
  currency TEXT,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  address_details TEXT,
  note TEXT,
  scheduled_at TEXT,
  delivery_fee DOUBLE PRECISION,
  distance_m INTEGER,
  location_sent INTEGER NOT NULL DEFAULT 0,
  search_started_at TEXT,
  accepted_at TEXT,
  assigned_at TEXT,
  picked_at TEXT,
  delivered_at TEXT,
  closed_at TEXT,
  close_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_cook_idx ON orders (cook_id, status);
CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders (customer_id);
CREATE INDEX IF NOT EXISTS orders_driver_idx ON orders (driver_id, status);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id INTEGER,
  name TEXT NOT NULL,
  price DOUBLE PRECISION NOT NULL,
  qty INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS order_items_idx ON order_items (order_id);

CREATE TABLE IF NOT EXISTS order_offers (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  fee DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','declined','won','lost')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_offers_driver_idx ON order_offers (driver_id, status);
CREATE INDEX IF NOT EXISTS order_offers_order_idx ON order_offers (order_id);

-- Money ledger: a balance is the sum of its lines. Stores: topup (+), hold (-), release (+).
-- Drivers: earning (+), payout (-).
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id SERIAL PRIMARY KEY,
  account_type TEXT NOT NULL CHECK (account_type IN ('store','driver')),
  account_id INTEGER NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('topup','hold','release','earning','payout','adjust')),
  order_id INTEGER,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_ledger_acct_idx ON wallet_ledger (account_type, account_id);

CREATE TABLE IF NOT EXISTS topups (
  id SERIAL PRIMARY KEY,
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  amount DOUBLE PRECISION NOT NULL,
  method TEXT NOT NULL,
  reference TEXT,
  receipt_mime TEXT,
  receipt TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payouts (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  amount DOUBLE PRECISION NOT NULL,
  provider TEXT,
  number TEXT,
  status TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due','paid')),
  paid_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS complaints (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  from_type TEXT NOT NULL CHECK (from_type IN ('store','driver','customer')),
  from_id INTEGER NOT NULL,
  against_type TEXT NOT NULL CHECK (against_type IN ('store','driver','customer')),
  against_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','warned','dismissed')),
  decided_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS warnings (
  id SERIAL PRIMARY KEY,
  account_type TEXT NOT NULL CHECK (account_type IN ('store','driver','customer')),
  account_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  complaint_id INTEGER,
  expires_at TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS warnings_acct_idx ON warnings (account_type, account_id);

-- v7: appointments (clinics, salons …) — only for subscribers with the booking option on.
CREATE TABLE IF NOT EXISTS appointments (
  id SERIAL PRIMARY KEY,
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','declined','cancelled','done')),
  decided_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS appointments_cook_idx ON appointments (cook_id, starts_at);
CREATE INDEX IF NOT EXISTS appointments_customer_idx ON appointments (customer_id);

-- v7: "come to me" requests to craftspeople. The customer's location is shared only once the craftsperson accepts.
CREATE TABLE IF NOT EXISTS visit_requests (
  id SERIAL PRIMARY KEY,
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  details TEXT,
  distance_m INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','cancelled','done')),
  decided_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS visit_requests_cook_idx ON visit_requests (cook_id, status);
CREATE INDEX IF NOT EXISTS visit_requests_customer_idx ON visit_requests (customer_id);

-- v7.1: withdrawals asked by drivers and stores (to any Whish/OMT number, confirmed with the account password).
-- The amount leaves the balance when asked; a refused withdrawal gives it back.
CREATE TABLE IF NOT EXISTS withdrawals (
  id SERIAL PRIMARY KEY,
  account_type TEXT NOT NULL CHECK (account_type IN ('store','driver')),
  account_id INTEGER NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('whish','omt')),
  number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','rejected')),
  ip_hash TEXT,
  decided_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS withdrawals_acct_idx ON withdrawals (account_type, account_id);
CREATE INDEX IF NOT EXISTS withdrawals_status_idx ON withdrawals (status);

-- v7.2: the customer asks a driver directly ("errands"): deliver something, bring something from a shop, or a service.
-- Payment is between the customer and the driver (the platform holds no money). Drivers need the "customer requests" subscription.
CREATE TABLE IF NOT EXISTS errands (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('deliver','buy','service')),
  description TEXT NOT NULL,
  from_lat DOUBLE PRECISION NOT NULL,
  from_lng DOUBLE PRECISION NOT NULL,
  from_details TEXT,
  to_lat DOUBLE PRECISION NOT NULL,
  to_lng DOUBLE PRECISION NOT NULL,
  to_details TEXT,
  price DOUBLE PRECISION NOT NULL,
  purchase_value DOUBLE PRECISION,
  distance_m INTEGER,
  status TEXT NOT NULL DEFAULT 'searching' CHECK (status IN ('searching','assigned','picked_up','delivered','cancelled')),
  search_started_at TEXT,
  assigned_at TEXT,
  picked_at TEXT,
  delivered_at TEXT,
  closed_at TEXT,
  close_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS errands_customer_idx ON errands (customer_id);
CREATE INDEX IF NOT EXISTS errands_driver_idx ON errands (driver_id, status);

CREATE TABLE IF NOT EXISTS errand_offers (
  id SERIAL PRIMARY KEY,
  errand_id INTEGER NOT NULL REFERENCES errands(id) ON DELETE CASCADE,
  driver_id INTEGER NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','declined','won','lost')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS errand_offers_driver_idx ON errand_offers (driver_id, status);
CREATE INDEX IF NOT EXISTS errand_offers_errand_idx ON errand_offers (errand_id);

-- Chat between the customer and the driver of an errand. Private: the owner sees it only when a complaint is filed.
CREATE TABLE IF NOT EXISTS errand_messages (
  id SERIAL PRIMARY KEY,
  errand_id INTEGER NOT NULL REFERENCES errands(id) ON DELETE CASCADE,
  from_type TEXT NOT NULL CHECK (from_type IN ('customer','driver')),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS errand_messages_idx ON errand_messages (errand_id, id);

-- v7.5: messages from the owner to all drivers or all stores (with an end date), and phone notifications.
CREATE TABLE IF NOT EXISTS broadcasts (
  id SERIAL PRIMARY KEY,
  audience TEXT NOT NULL CHECK (audience IN ('drivers','stores')),
  country TEXT,
  body TEXT NOT NULL,
  expires_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('customer','driver','store')),
  owner_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_owner_idx ON push_subscriptions (owner_type, owner_id);

-- v7.6: a store renews its subscription from its own page (choose duration, pay to the platform, receipt → the owner approves).
CREATE TABLE IF NOT EXISTS renewals (
  id SERIAL PRIMARY KEY,
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('delivery','basic')),
  months INTEGER NOT NULL,
  branches INTEGER NOT NULL DEFAULT 1,
  amount DOUBLE PRECISION NOT NULL,
  method TEXT NOT NULL,
  reference TEXT,
  receipt_mime TEXT,
  receipt TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS renewals_status_idx ON renewals (status);

-- v7.6: online payments through a payment gateway (top-ups and renewals) — used only when PAY_* keys are set.
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  cook_id INTEGER NOT NULL REFERENCES cooks(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('topup','renewal')),
  amount DOUBLE PRECISION NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  details TEXT,
  token TEXT NOT NULL UNIQUE,
  provider_ref TEXT,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed')),
  paid_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- v7.6: phone notifications per account (one phone can be customer, store, driver and admin at once).
CREATE TABLE IF NOT EXISTS push_targets (
  id SERIAL PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_id, endpoint)
);
CREATE INDEX IF NOT EXISTS push_targets_owner_idx ON push_targets (owner_type, owner_id);

-- ===================== v7.6 money model: customer pays food + delivery fee (cash or card) =====================
-- Restaurant food money a driver collected in CASH (one row per completed cash order). Not the driver's money.
CREATE TABLE IF NOT EXISTS driver_cash_entries (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE,
  driver_id INTEGER NOT NULL,
  store_id INTEGER NOT NULL,
  amount DOUBLE PRECISION NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_settlement','settled','reversed')),
  settlement_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS driver_cash_entries_driver_idx ON driver_cash_entries (driver_id, status);
CREATE INDEX IF NOT EXISTS driver_cash_entries_store_idx ON driver_cash_entries (store_id, status);

-- What each driver earned per order (delivery fee + any bonus from the store), cash in hand or paid electronically.
CREATE TABLE IF NOT EXISTS driver_earnings (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE,
  driver_id INTEGER NOT NULL,
  store_id INTEGER NOT NULL,
  fee DOUBLE PRECISION NOT NULL DEFAULT 0,
  bonus DOUBLE PRECISION NOT NULL DEFAULT 0,
  method TEXT NOT NULL CHECK (method IN ('cash','card')),
  reversed INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS driver_earnings_driver_idx ON driver_earnings (driver_id);

-- A driver hands the restaurants' cash to the platform (Whish / OMT); the owner verifies.
CREATE TABLE IF NOT EXISTS settlements (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL,
  amount DOUBLE PRECISION NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  method TEXT NOT NULL,                -- whish | omt | card | a payment way the owner added for a country (bank, local wallet…)
  reference TEXT NOT NULL,
  receipt_mime TEXT,
  receipt TEXT,
  -- awaiting_payment: an online payment link was made (amount fixed), not paid yet; expired: link not paid in time
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('awaiting_payment','pending','verified','rejected','correction','expired')),
  note TEXT,
  decided_by INTEGER,
  decided_at TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS settlements_status_idx ON settlements (status);
CREATE INDEX IF NOT EXISTS settlements_driver_idx ON settlements (driver_id);
-- The automatic breakdown: which orders / restaurants a settlement pays. An order can be in ONE live settlement only.
CREATE TABLE IF NOT EXISTS settlement_allocations (
  id SERIAL PRIMARY KEY,
  settlement_id INTEGER NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  entry_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  store_id INTEGER NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS settlement_alloc_live_idx ON settlement_allocations (entry_id) WHERE active = 1;
CREATE INDEX IF NOT EXISTS settlement_alloc_settlement_idx ON settlement_allocations (settlement_id);

-- Card payments of customers' orders (through the payment provider) and every callback received (no double counting).
CREATE TABLE IF NOT EXISTS order_payments (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  amount DOUBLE PRECISION NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed','refund_pending','refunded')),
  provider_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS order_payments_order_idx ON order_payments (order_id);
CREATE TABLE IF NOT EXISTS payment_events (
  id SERIAL PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  reference TEXT,
  status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only financial journal: every money event, with its references (audit trail; never updated or deleted).
CREATE TABLE IF NOT EXISTS financial_ledger (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  order_id INTEGER,
  store_id INTEGER,
  driver_id INTEGER,
  payment_id INTEGER,
  settlement_id INTEGER,
  amount DOUBLE PRECISION NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  payment_method TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS financial_ledger_order_idx ON financial_ledger (order_id);

-- v7.7: suspicious money events the owner must see (wrong amounts, reused transfer numbers, forged callbacks, failed payouts…)
CREATE TABLE IF NOT EXISTS security_events (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warn',
  driver_id INTEGER,
  store_id INTEGER,
  settlement_id INTEGER,
  amount DOUBLE PRECISION,
  expected DOUBLE PRECISION,
  detail TEXT,
  ip_hash TEXT,
  seen INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_events_seen_idx ON security_events (seen, id);
CREATE INDEX IF NOT EXISTS security_events_driver_idx ON security_events (driver_id);
