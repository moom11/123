-- =============================================================================
-- 003 catalog — inventory items, menu, modifiers, recipes
--
-- Inventory items come first because a recipe ingredient IS an inventory item;
-- there is no parallel "ingredient" concept that could drift out of sync with
-- what the store actually holds.
-- =============================================================================

CREATE TABLE inventory_locations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   UUID NOT NULL REFERENCES branches(id),
  code        TEXT NOT NULL,               -- MAIN, BAR, KITCHEN, SHISHA, FLOOR
  name_ar     TEXT NOT NULL,
  department  TEXT CHECK (department IN ('BAR','KITCHEN','SHISHA','FLOOR','OTHER')),
  is_main_store BOOLEAN NOT NULL DEFAULT FALSE,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX inv_locations_branch_code ON inventory_locations (branch_id, code);

CREATE TABLE suppliers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     UUID REFERENCES branches(id),
  name          TEXT NOT NULL,
  phone         TEXT,
  email         TEXT,
  vat_number    TEXT,
  contact_person TEXT,
  address       TEXT,
  notes         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID REFERENCES users(id),
  deleted_at    TIMESTAMPTZ
);
CREATE TRIGGER suppliers_touch BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- The master item. `base_unit` is the canonical unit everything is normalised
-- to (g / ml / piece); `stock_unit` is what humans prefer to see and count in.
CREATE TABLE inventory_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id        UUID NOT NULL REFERENCES branches(id),
  sku              TEXT NOT NULL,
  name_ar          TEXT NOT NULL,
  name_en          TEXT,
  category         TEXT,
  base_unit        TEXT NOT NULL CHECK (base_unit IN ('g','ml','piece')),
  stock_unit       TEXT NOT NULL CHECK (stock_unit IN
                     ('kg','g','l','ml','piece','box','carton','pack')),
  pack_size        NUMERIC(18,4),          -- base units per box/carton/pack
  min_level        NUMERIC(18,4) NOT NULL DEFAULT 0,   -- in base units
  max_level        NUMERIC(18,4),
  -- Weighted average cost per base unit, in halalas, updated on every receipt.
  average_cost     NUMERIC(18,6) NOT NULL DEFAULT 0,
  last_cost        NUMERIC(18,6) NOT NULL DEFAULT 0,
  default_supplier_id UUID REFERENCES suppliers(id),
  default_location_id UUID REFERENCES inventory_locations(id),
  track_expiry     BOOLEAN NOT NULL DEFAULT FALSE,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       UUID REFERENCES users(id),
  deleted_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX inv_items_branch_sku ON inventory_items (branch_id, sku) WHERE deleted_at IS NULL;
CREATE INDEX inv_items_name_trgm ON inventory_items USING gin (name_ar gin_trgm_ops);
CREATE TRIGGER inv_items_touch BEFORE UPDATE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Current quantity per item per location. Mutated only alongside an
-- inventory_transactions row, inside one transaction.
CREATE TABLE inventory_stock (
  item_id      UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  location_id  UUID NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  quantity     NUMERIC(18,4) NOT NULL DEFAULT 0,      -- base units
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, location_id)
);

-- --- Menu -------------------------------------------------------------------
CREATE TABLE categories (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id    UUID REFERENCES branches(id),
  name_ar      TEXT NOT NULL,
  name_en      TEXT,
  description_ar TEXT,
  image_url    TEXT,
  sort_order   INT NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  show_in_menu BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID REFERENCES users(id),
  deleted_at   TIMESTAMPTZ
);
CREATE TRIGGER categories_touch BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE products (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      UUID REFERENCES branches(id),
  category_id    UUID NOT NULL REFERENCES categories(id),
  sku            TEXT,
  name_ar        TEXT NOT NULL,
  name_en        TEXT,
  description_ar TEXT,
  image_url      TEXT,
  price          BIGINT NOT NULL CHECK (price >= 0),      -- halalas, menu price
  -- Which printer group this item's ticket goes to. The single most important
  -- routing field in the system.
  production_department TEXT NOT NULL DEFAULT 'OTHER'
                   CHECK (production_department IN ('BAR','KITCHEN','SHISHA','OTHER')),
  is_available   BOOLEAN NOT NULL DEFAULT TRUE,   -- 86'd / out of stock
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  show_in_menu   BOOLEAN NOT NULL DEFAULT TRUE,   -- visible on the customer QR menu
  sort_order     INT NOT NULL DEFAULT 0,
  prep_minutes   INT,
  tags           TEXT[] NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID REFERENCES users(id),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX products_category_idx ON products (category_id) WHERE deleted_at IS NULL;
CREATE INDEX products_branch_idx ON products (branch_id) WHERE deleted_at IS NULL;
CREATE INDEX products_name_trgm ON products USING gin (name_ar gin_trgm_ops);
CREATE TRIGGER products_touch BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Sizes / variants. A variant may override price and carry its own recipe.
CREATE TABLE product_variants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name_ar       TEXT NOT NULL,                  -- 'صغير' / 'وسط' / 'كبير'
  price_delta   BIGINT NOT NULL DEFAULT 0,
  price_override BIGINT,
  sort_order    INT NOT NULL DEFAULT 0,
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A modifier group, e.g. "اختيار السكر" or "النعناع".
CREATE TABLE modifiers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     UUID REFERENCES branches(id),
  name_ar       TEXT NOT NULL,
  name_en       TEXT,
  selection     TEXT NOT NULL DEFAULT 'single' CHECK (selection IN ('single','multi')),
  is_required   BOOLEAN NOT NULL DEFAULT FALSE,
  min_select    INT NOT NULL DEFAULT 0,
  max_select    INT,
  sort_order    INT NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID REFERENCES users(id)
);

CREATE TABLE modifier_options (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  modifier_id   UUID NOT NULL REFERENCES modifiers(id) ON DELETE CASCADE,
  name_ar       TEXT NOT NULL,
  name_en       TEXT,
  price_delta   BIGINT NOT NULL DEFAULT 0,
  sort_order    INT NOT NULL DEFAULT 0,
  is_default    BOOLEAN NOT NULL DEFAULT FALSE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX modifier_options_modifier_idx ON modifier_options (modifier_id);

CREATE TABLE product_modifiers (
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  modifier_id UUID NOT NULL REFERENCES modifiers(id) ON DELETE CASCADE,
  sort_order  INT NOT NULL DEFAULT 0,
  is_required_override BOOLEAN,
  PRIMARY KEY (product_id, modifier_id)
);

-- --- Recipes ----------------------------------------------------------------
-- A recipe belongs to a product, optionally narrowed to one variant. Its lines
-- are of three kinds:
--   base        — always consumed
--   option      — consumed only when a specific modifier_option is chosen
--   subtractive — consumed only when an option is NOT chosen (rare, kept for
--                 completeness, e.g. a default garnish removed by a "بدون" option)
-- This is what makes "شاي بدون سكر + مكس نعناع" actually move different grams
-- of stock rather than just printing a different line on the ticket.
CREATE TABLE recipes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id    UUID REFERENCES product_variants(id) ON DELETE CASCADE,
  name          TEXT,
  yield_qty     NUMERIC(18,4) NOT NULL DEFAULT 1,  -- portions produced
  waste_factor_percent NUMERIC(6,3) NOT NULL DEFAULT 0,  -- expected prep loss
  notes         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID REFERENCES users(id)
);
CREATE UNIQUE INDEX recipes_product_variant_idx
  ON recipes (product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE is_active;
CREATE TRIGGER recipes_touch BEFORE UPDATE ON recipes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE recipe_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id          UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  inventory_item_id  UUID NOT NULL REFERENCES inventory_items(id),
  line_kind          TEXT NOT NULL DEFAULT 'base'
                       CHECK (line_kind IN ('base','option','subtractive')),
  -- For 'option'/'subtractive' lines: which choice drives this line.
  modifier_option_id UUID REFERENCES modifier_options(id) ON DELETE CASCADE,
  quantity           NUMERIC(18,4) NOT NULL CHECK (quantity >= 0), -- base units
  unit               TEXT NOT NULL,          -- unit as authored, for display
  -- Where the stock is drawn from; falls back to the item's default location.
  location_id        UUID REFERENCES inventory_locations(id),
  is_optional        BOOLEAN NOT NULL DEFAULT FALSE,
  notes              TEXT,
  sort_order         INT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recipe_option_line_needs_option
    CHECK (line_kind = 'base' OR modifier_option_id IS NOT NULL)
);
CREATE INDEX recipe_items_recipe_idx ON recipe_items (recipe_id);
CREATE INDEX recipe_items_item_idx ON recipe_items (inventory_item_id);
CREATE INDEX recipe_items_option_idx ON recipe_items (modifier_option_id);

-- Deferred FKs from 002 now that products/categories exist.
ALTER TABLE customer_special_prices
  ADD CONSTRAINT csp_product_fk  FOREIGN KEY (product_id)  REFERENCES products(id) ON DELETE CASCADE,
  ADD CONSTRAINT csp_category_fk FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE;
