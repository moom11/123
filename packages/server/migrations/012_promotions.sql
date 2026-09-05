-- =============================================================================
-- 012 promotions
--
-- The specification says staff must not change prices by hand. That rule only
-- holds if there is a legitimate way to sell something cheaper — otherwise the
-- pressure to discount finds another outlet, usually a manager's override used
-- ten times a night.
--
-- So a promotion is a RULE the server evaluates, not a number a person types.
-- Given the same basket at the same instant it produces the same discount, and
-- the reason is recorded on the order: "happy hour 4-7pm", not "manual 20%".
--
-- Everything here is deterministic and re-computable. Nothing is decided at
-- the till.
-- =============================================================================

CREATE TABLE promotions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      UUID NOT NULL REFERENCES branches(id),
  name_ar        TEXT NOT NULL,
  description_ar TEXT,

  -- percent      : a share off the qualifying lines
  -- amount       : a fixed sum off the qualifying lines
  -- item_price   : those lines are sold at a set price
  -- buy_x_get_y  : the cheapest Y of every X+Y qualifying units are free
  -- combo        : a named set of products for one price
  kind           TEXT NOT NULL CHECK (kind IN
                   ('percent','amount','item_price','buy_x_get_y','combo')),

  -- percent: basis points (1500 = 15%). Everything else: halalas.
  -- One column because a promotion has exactly one magnitude, and two nullable
  -- ones invite the pair being set inconsistently.
  value          BIGINT NOT NULL CHECK (value >= 0),
  buy_quantity   INT CHECK (buy_quantity > 0),
  get_quantity   INT CHECK (get_quantity > 0),

  -- --- When it applies ------------------------------------------------------
  starts_at      TIMESTAMPTZ,
  ends_at        TIMESTAMPTZ,
  -- ISO weekdays, 1 = Monday .. 7 = Sunday. Empty means every day.
  -- Saudi weekends are Friday and Saturday, so a "weekend" promotion is {5,6}.
  days_of_week   SMALLINT[] NOT NULL DEFAULT '{}',
  -- Local minutes past midnight in the BRANCH's timezone, which is the whole
  -- point: happy hour is 4pm where the guest is sitting, not in UTC.
  -- start > end is a window that crosses midnight, and is handled.
  daily_start_minute INT CHECK (daily_start_minute BETWEEN 0 AND 1439),
  daily_end_minute   INT CHECK (daily_end_minute BETWEEN 0 AND 1439),

  -- --- What it applies to ---------------------------------------------------
  -- Empty targeting means the whole menu. Products and categories are additive.
  applies_to_order_types TEXT[] NOT NULL DEFAULT '{}',
  applies_to_sources     TEXT[] NOT NULL DEFAULT '{}',

  -- --- Limits --------------------------------------------------------------
  min_basket     BIGINT NOT NULL DEFAULT 0,
  -- A ceiling on what one promotion can take off a single order. Zero means
  -- none, which is a deliberate choice an operator makes rather than a default.
  max_discount   BIGINT NOT NULL DEFAULT 0,
  -- Total redemptions across the whole campaign, and per customer.
  usage_limit        INT,
  usage_per_customer INT,
  usage_count        INT NOT NULL DEFAULT 0,

  -- Lower runs first. Two promotions that both qualify are applied in priority
  -- order, and a non-stackable one ends the chain.
  priority       INT NOT NULL DEFAULT 100,
  is_stackable   BOOLEAN NOT NULL DEFAULT FALSE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,

  -- Requires a code the guest presents, rather than applying to everyone.
  code           TEXT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID REFERENCES users(id),
  deleted_at     TIMESTAMPTZ,

  -- buy_x_get_y without its quantities is not a promotion, it is a null
  -- pointer waiting for a busy Friday.
  CONSTRAINT bxgy_needs_quantities CHECK (
    kind <> 'buy_x_get_y' OR (buy_quantity IS NOT NULL AND get_quantity IS NOT NULL)
  ),
  CONSTRAINT percent_within_range CHECK (kind <> 'percent' OR value <= 10000)
);

CREATE INDEX promotions_branch_active_idx ON promotions (branch_id)
  WHERE is_active AND deleted_at IS NULL;
CREATE UNIQUE INDEX promotions_code_uniq ON promotions (branch_id, upper(code))
  WHERE code IS NOT NULL AND deleted_at IS NULL;

COMMENT ON TABLE promotions IS
  'Rules the server evaluates. Never a price typed at the till — that is what this exists to prevent.';
COMMENT ON COLUMN promotions.daily_start_minute IS
  'Local minutes in the branch timezone. Happy hour is 4pm where the guest sits, not in UTC.';

-- Targeting. Separate tables rather than arrays of ids because these are
-- foreign keys: a retired product must not leave a promotion pointing at
-- nothing, and the database should say so.
CREATE TABLE promotion_products (
  promotion_id UUID NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  product_id   UUID NOT NULL REFERENCES products(id),
  -- For a combo: how many of this product the set contains.
  quantity     INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
  PRIMARY KEY (promotion_id, product_id)
);

CREATE TABLE promotion_categories (
  promotion_id UUID NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  category_id  UUID NOT NULL REFERENCES categories(id),
  PRIMARY KEY (promotion_id, category_id)
);

-- What was actually given away, and to whom.
--
-- Append-only, like every other financial record here. It is what answers "how
-- much did happy hour cost us in March", which is the question that decides
-- whether happy hour continues.
CREATE TABLE promotion_redemptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id   UUID NOT NULL REFERENCES promotions(id),
  order_id       UUID NOT NULL REFERENCES orders(id),
  branch_id      UUID NOT NULL REFERENCES branches(id),
  customer_id    UUID REFERENCES customers(id),
  discount_amount BIGINT NOT NULL CHECK (discount_amount >= 0),
  -- The basket it was computed against, so the figure can be re-derived during
  -- an audit rather than taken on trust.
  qualifying_total BIGINT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One promotion applies to an order once. Re-pricing an order replaces the
-- row rather than adding a second.
CREATE UNIQUE INDEX promotion_redemptions_uniq
  ON promotion_redemptions (promotion_id, order_id);
CREATE INDEX promotion_redemptions_customer_idx
  ON promotion_redemptions (promotion_id, customer_id)
  WHERE customer_id IS NOT NULL;
CREATE INDEX promotion_redemptions_reporting_idx
  ON promotion_redemptions (branch_id, created_at DESC);

-- An automatic promotion is a fourth kind of discount, alongside the two that
-- need an OTP and the manual one that needs a manager.
ALTER TABLE discounts DROP CONSTRAINT discounts_kind_check;
ALTER TABLE discounts ADD CONSTRAINT discounts_kind_check CHECK (kind IN
  ('customer_special_price','points_redemption','coupon','manual','promotion'));
ALTER TABLE discounts ADD COLUMN promotion_id UUID REFERENCES promotions(id);

-- The OTP rule is unchanged and still names only the two kinds that need one.
-- A promotion needs no OTP precisely because no human chose its amount.
