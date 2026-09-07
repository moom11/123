-- =============================================================================
-- 002 customers — profiles, wallet, loyalty, special prices, OTP, consent
-- =============================================================================

CREATE TABLE customers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_code      TEXT NOT NULL UNIQUE,
  full_name          TEXT,
  -- E.164, e.g. +9665xxxxxxxx. Globally unique: one account per phone, ever.
  phone              TEXT NOT NULL,
  phone_verified     BOOLEAN NOT NULL DEFAULT FALSE,
  phone_verified_at  TIMESTAMPTZ,
  email              TEXT,
  birthdate          DATE,
  notes              TEXT,
  home_branch_id     UUID REFERENCES branches(id),
  -- Aggregates maintained on payment so dashboards never scan the order table.
  first_visit_at     TIMESTAMPTZ,
  last_visit_at      TIMESTAMPTZ,
  visit_count        INT NOT NULL DEFAULT 0,
  order_count        INT NOT NULL DEFAULT 0,
  total_spend        BIGINT NOT NULL DEFAULT 0,   -- halalas
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  is_blocked         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         UUID REFERENCES users(id),
  deleted_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX customers_phone_unique ON customers (phone);
CREATE INDEX customers_name_trgm ON customers USING gin (full_name gin_trgm_ops);
CREATE TRIGGER customers_touch BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE customer_addresses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label       TEXT,
  city        TEXT,
  district    TEXT,
  street      TEXT,
  details     TEXT,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Marketing consent is deliberately separate from phone verification: verifying
-- a number to place an order is NOT permission to market to that number.
CREATE TABLE customer_consents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL CHECK (channel IN ('whatsapp','sms','email')),
  granted     BOOLEAN NOT NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  source      TEXT,                       -- 'qr_menu', 'pos', 'admin'
  ip          INET,
  user_agent  TEXT
);
CREATE INDEX customer_consents_customer_idx ON customer_consents (customer_id, channel, granted_at DESC);

-- --- Wallet -----------------------------------------------------------------
CREATE TABLE customer_wallets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
  points_balance INT NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
  credit_balance BIGINT NOT NULL DEFAULT 0 CHECK (credit_balance >= 0), -- halalas
  lifetime_points_earned   INT NOT NULL DEFAULT 0,
  lifetime_points_redeemed INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER wallets_touch BEFORE UPDATE ON customer_wallets
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Append-only ledger. Balance on customer_wallets is a materialised running
-- total; every change to it writes exactly one row here in the same transaction.
CREATE TABLE wallet_transactions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id      UUID NOT NULL REFERENCES customer_wallets(id),
  customer_id    UUID NOT NULL REFERENCES customers(id),
  branch_id      UUID REFERENCES branches(id),
  kind           TEXT NOT NULL CHECK (kind IN
                   ('earn','redeem','manual_credit','manual_debit','expiry','reversal')),
  points_delta   INT NOT NULL DEFAULT 0,
  credit_delta   BIGINT NOT NULL DEFAULT 0,
  points_balance_after INT NOT NULL,
  credit_balance_after BIGINT NOT NULL,
  order_id       UUID,                     -- FK added in 004 once orders exists
  otp_request_id UUID,                     -- the verification that authorised it
  reason         TEXT,
  performed_by_user_id     UUID REFERENCES users(id),
  performed_by_employee_id UUID REFERENCES employees(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX wallet_txn_customer_idx ON wallet_transactions (customer_id, created_at DESC);
CREATE INDEX wallet_txn_order_idx ON wallet_transactions (order_id);

-- --- Loyalty rules ----------------------------------------------------------
-- Fully management-editable: how many halalas earn a point, and what a point is
-- worth on redemption. Historic rules are kept (effective_from/to) so an old
-- redemption can always be explained.
CREATE TABLE loyalty_rules (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id             UUID REFERENCES branches(id),
  name                  TEXT NOT NULL,
  -- Earning: 1 point per `spend_per_point` halalas of eligible spend.
  spend_per_point       BIGINT NOT NULL DEFAULT 1000 CHECK (spend_per_point > 0),
  -- Redemption: `points_per_block` points convert to `block_value` halalas.
  -- Default expresses the spec example: 100 points = 10 SAR.
  points_per_block      INT NOT NULL DEFAULT 100 CHECK (points_per_block > 0),
  block_value           BIGINT NOT NULL DEFAULT 1000 CHECK (block_value > 0),
  min_redeem_points     INT NOT NULL DEFAULT 100,
  max_redeem_percent    NUMERIC(5,2) NOT NULL DEFAULT 100.00,
  points_expire_days    INT,
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from        TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            UUID REFERENCES users(id)
);
CREATE INDEX loyalty_rules_active_idx ON loyalty_rules (branch_id, is_active, effective_from DESC);

-- --- Customer special prices ------------------------------------------------
-- "Khalid pays 45 for a 65 SAR shisha." Only a principal holding
-- customers.special_prices.manage may write here; a waiter can never type a
-- price, only invoke a stored one (and only after the customer's OTP).
CREATE TABLE customer_special_prices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id     UUID,                      -- FK added in 003
  category_id    UUID,                      -- category-wide price rule
  branch_id      UUID REFERENCES branches(id),
  price          BIGINT,                    -- absolute price in halalas
  discount_percent NUMERIC(5,2),            -- or a percentage off the menu price
  requires_otp   BOOLEAN NOT NULL DEFAULT TRUE,
  valid_from     TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to       TIMESTAMPTZ,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID REFERENCES users(id),
  CONSTRAINT special_price_target CHECK (product_id IS NOT NULL OR category_id IS NOT NULL),
  CONSTRAINT special_price_value  CHECK (price IS NOT NULL OR discount_percent IS NOT NULL)
);
CREATE INDEX csp_customer_idx ON customer_special_prices (customer_id, is_active);
CREATE INDEX csp_product_idx  ON customer_special_prices (product_id);

-- --- Coupons & rewards ------------------------------------------------------
CREATE TABLE coupons (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT NOT NULL UNIQUE,
  branch_id      UUID REFERENCES branches(id),
  customer_id    UUID REFERENCES customers(id),   -- NULL = public coupon
  description    TEXT,
  discount_percent NUMERIC(5,2),
  discount_amount  BIGINT,
  min_order_total  BIGINT NOT NULL DEFAULT 0,
  max_redemptions  INT,
  redemption_count INT NOT NULL DEFAULT 0,
  valid_from     TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to       TIMESTAMPTZ,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID REFERENCES users(id)
);

-- --- OTP requests -----------------------------------------------------------
-- One row per issued code. The code itself is stored only as an Argon2id hash.
-- A row is single-use (consumed_at), short-lived (expires_at), bound to one
-- customer AND one purpose AND — for discounts/redemptions — one specific
-- operation (order/product), so a code minted for a discount can never be
-- replayed to spend points.
CREATE TABLE otp_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID REFERENCES customers(id) ON DELETE CASCADE,
  phone             TEXT NOT NULL,
  purpose           TEXT NOT NULL CHECK (purpose IN
                      ('customer_login','order_verification','customer_discount','points_redemption')),
  code_hash         TEXT NOT NULL,
  -- Binds the code to a single operation. Two different discount attempts get
  -- two different rows; neither can satisfy the other.
  operation_ref     TEXT,
  branch_id         UUID REFERENCES branches(id),
  order_id          UUID,
  table_id          UUID,
  requested_by_user_id     UUID REFERENCES users(id),
  requested_by_employee_id UUID REFERENCES employees(id),
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,  -- what the code authorises
  channel           TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp','sms')),
  delivery_status   TEXT NOT NULL DEFAULT 'pending'
                      CHECK (delivery_status IN ('pending','sent','failed')),
  delivery_ref      TEXT,
  delivery_error    TEXT,
  attempt_count     INT NOT NULL DEFAULT 0,
  max_attempts      INT NOT NULL DEFAULT 5,
  expires_at        TIMESTAMPTZ NOT NULL,
  consumed_at       TIMESTAMPTZ,
  consumed_by_employee_id UUID REFERENCES employees(id),
  consumed_by_user_id     UUID REFERENCES users(id),
  invalidated_at    TIMESTAMPTZ,
  ip                INET,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX otp_customer_purpose_idx ON otp_requests (customer_id, purpose, created_at DESC);
CREATE INDEX otp_operation_idx ON otp_requests (operation_ref) WHERE consumed_at IS NULL;
CREATE INDEX otp_phone_idx ON otp_requests (phone, created_at DESC);

-- Customer-facing sessions (QR menu). Separate from staff sessions entirely.
CREATE TABLE customer_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  table_id           UUID,
  ip                 INET,
  user_agent         TEXT,
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX customer_sessions_customer_idx ON customer_sessions (customer_id) WHERE revoked_at IS NULL;
