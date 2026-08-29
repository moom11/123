-- =============================================================================
-- 005 inventory — append-only stock ledger, receipts, transfers, waste, counts
-- =============================================================================

-- Every movement of stock, ever. inventory_stock.quantity is derived from this
-- and is only ever changed in the same transaction as a row here.
CREATE TABLE inventory_transactions (
  id             BIGSERIAL PRIMARY KEY,
  branch_id      UUID NOT NULL REFERENCES branches(id),
  item_id        UUID NOT NULL REFERENCES inventory_items(id),
  location_id    UUID NOT NULL REFERENCES inventory_locations(id),
  txn_type       TEXT NOT NULL CHECK (txn_type IN
                   ('receive','transfer_out','transfer_in','recipe_consumption',
                    'waste','count_adjustment','manual_adjustment','return_to_supplier')),
  -- Signed, in base units: negative removes stock.
  quantity_delta NUMERIC(18,4) NOT NULL,
  balance_after  NUMERIC(18,4) NOT NULL,
  unit_cost      NUMERIC(18,6),          -- halalas per base unit
  total_cost     BIGINT,                 -- halalas
  -- What caused this movement. Exactly one of these is normally set.
  order_id       UUID REFERENCES orders(id),
  order_item_id  UUID REFERENCES order_items(id),
  goods_receipt_id  UUID,
  transfer_id    UUID,
  waste_record_id UUID,
  stock_count_id UUID,
  purchase_id    UUID,
  reference      TEXT,
  notes          TEXT,
  performed_by_employee_id UUID REFERENCES employees(id),
  performed_by_user_id     UUID REFERENCES users(id),
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inv_txn_item_time_idx ON inventory_transactions (item_id, location_id, occurred_at DESC);
CREATE INDEX inv_txn_branch_time_idx ON inventory_transactions (branch_id, occurred_at DESC);
CREATE INDEX inv_txn_type_idx ON inventory_transactions (txn_type, occurred_at DESC);
CREATE INDEX inv_txn_order_idx ON inventory_transactions (order_id);

-- --- Goods receipts ---------------------------------------------------------
CREATE TABLE goods_receipts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number TEXT NOT NULL,
  branch_id      UUID NOT NULL REFERENCES branches(id),
  supplier_id    UUID REFERENCES suppliers(id),
  location_id    UUID NOT NULL REFERENCES inventory_locations(id),
  purchase_id    UUID,                    -- FK added in 006
  invoice_number TEXT,
  invoice_date   DATE,
  arrived_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  subtotal       BIGINT NOT NULL DEFAULT 0,
  vat_amount     BIGINT NOT NULL DEFAULT 0,
  total          BIGINT NOT NULL DEFAULT 0,
  notes          TEXT,
  received_by_employee_id UUID REFERENCES employees(id),
  received_by_user_id     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX goods_receipts_number ON goods_receipts (receipt_number);

CREATE TABLE goods_receipt_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id     UUID NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  item_id        UUID NOT NULL REFERENCES inventory_items(id),
  quantity       NUMERIC(18,4) NOT NULL CHECK (quantity > 0),   -- base units
  entered_quantity NUMERIC(18,4) NOT NULL,
  entered_unit   TEXT NOT NULL,
  unit_cost      NUMERIC(18,6) NOT NULL DEFAULT 0,
  line_total     BIGINT NOT NULL DEFAULT 0,
  expiry_date    DATE,
  batch_number   TEXT,
  notes          TEXT
);
ALTER TABLE inventory_transactions
  ADD CONSTRAINT inv_txn_receipt_fk FOREIGN KEY (goods_receipt_id) REFERENCES goods_receipts(id);

-- --- Transfers --------------------------------------------------------------
CREATE TABLE inventory_transfers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_number TEXT NOT NULL,           -- TRF-2026-000001
  branch_id       UUID NOT NULL REFERENCES branches(id),
  from_location_id UUID NOT NULL REFERENCES inventory_locations(id),
  to_location_id   UUID NOT NULL REFERENCES inventory_locations(id),
  status          TEXT NOT NULL DEFAULT 'requested' CHECK (status IN
                    ('requested','approved','rejected','in_transit','received','cancelled')),
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  requested_by_employee_id UUID REFERENCES employees(id),
  requested_by_user_id     UUID REFERENCES users(id),
  approved_by_user_id      UUID REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  received_by_employee_id  UUID REFERENCES employees(id),
  received_by_user_id      UUID REFERENCES users(id),
  received_at     TIMESTAMPTZ,
  reject_reason   TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT transfer_distinct_locations CHECK (from_location_id <> to_location_id)
);
CREATE UNIQUE INDEX transfers_number ON inventory_transfers (transfer_number);
CREATE INDEX transfers_branch_status ON inventory_transfers (branch_id, status, created_at DESC);
CREATE TRIGGER transfers_touch BEFORE UPDATE ON inventory_transfers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE inventory_transfer_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id       UUID NOT NULL REFERENCES inventory_transfers(id) ON DELETE CASCADE,
  item_id           UUID NOT NULL REFERENCES inventory_items(id),
  requested_quantity NUMERIC(18,4) NOT NULL CHECK (requested_quantity > 0),
  approved_quantity  NUMERIC(18,4),
  sent_quantity      NUMERIC(18,4),
  received_quantity  NUMERIC(18,4),
  entered_unit      TEXT NOT NULL DEFAULT 'g',
  notes             TEXT
);
ALTER TABLE inventory_transactions
  ADD CONSTRAINT inv_txn_transfer_fk FOREIGN KEY (transfer_id) REFERENCES inventory_transfers(id);

-- --- Waste ------------------------------------------------------------------
CREATE TABLE waste_records (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  waste_number  TEXT NOT NULL,             -- WST-2026-000001
  branch_id     UUID NOT NULL REFERENCES branches(id),
  location_id   UUID NOT NULL REFERENCES inventory_locations(id),
  item_id       UUID NOT NULL REFERENCES inventory_items(id),
  quantity      NUMERIC(18,4) NOT NULL CHECK (quantity > 0),   -- base units
  entered_quantity NUMERIC(18,4) NOT NULL,
  entered_unit  TEXT NOT NULL,
  department    TEXT,
  reason        TEXT NOT NULL CHECK (reason IN
                  ('expired','damaged','preparation_error','dropped','customer_return',
                   'trial','staff_consumption','overuse','other')),
  notes         TEXT,
  estimated_cost BIGINT NOT NULL DEFAULT 0,
  -- Waste above the branch threshold parks in 'pending_approval' and does NOT
  -- move stock until a manager signs it off.
  status        TEXT NOT NULL DEFAULT 'posted'
                  CHECK (status IN ('pending_approval','posted','rejected')),
  approved_by_user_id UUID REFERENCES users(id),
  approved_at   TIMESTAMPTZ,
  reject_reason TEXT,
  recorded_by_employee_id UUID REFERENCES employees(id),
  recorded_by_user_id     UUID REFERENCES users(id),
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX waste_number_idx ON waste_records (waste_number);
CREATE INDEX waste_branch_time_idx ON waste_records (branch_id, occurred_at DESC);
CREATE INDEX waste_item_idx ON waste_records (item_id, occurred_at DESC);
ALTER TABLE inventory_transactions
  ADD CONSTRAINT inv_txn_waste_fk FOREIGN KEY (waste_record_id) REFERENCES waste_records(id);

-- --- Stock counts -----------------------------------------------------------
-- The variance engine. expected_quantity is computed from the ledger at the
-- moment the count is opened, so the arithmetic in the spec —
--   opening + received + transfers_in - transfers_out - recipe_consumption
--   - waste = expected
-- is exactly the sum of the ledger deltas over the period, by construction.
CREATE TABLE stock_counts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  count_number   TEXT NOT NULL,            -- CNT-2026-000001
  branch_id      UUID NOT NULL REFERENCES branches(id),
  location_id    UUID NOT NULL REFERENCES inventory_locations(id),
  count_type     TEXT NOT NULL CHECK (count_type IN ('daily','weekly','monthly','ad_hoc')),
  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','submitted','approved','rejected','cancelled')),
  period_start   TIMESTAMPTZ,
  period_end     TIMESTAMPTZ,
  total_variance_value BIGINT NOT NULL DEFAULT 0,
  variance_percent NUMERIC(8,3),
  notes          TEXT,
  opened_by_employee_id UUID REFERENCES employees(id),
  opened_by_user_id     UUID REFERENCES users(id),
  submitted_at   TIMESTAMPTZ,
  submitted_by_employee_id UUID REFERENCES employees(id),
  approved_by_user_id UUID REFERENCES users(id),
  approved_at    TIMESTAMPTZ,
  reject_reason  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX stock_counts_number ON stock_counts (count_number);
CREATE INDEX stock_counts_branch_idx ON stock_counts (branch_id, created_at DESC);
CREATE TRIGGER stock_counts_touch BEFORE UPDATE ON stock_counts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE stock_count_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_count_id    UUID NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  item_id           UUID NOT NULL REFERENCES inventory_items(id),
  opening_quantity  NUMERIC(18,4) NOT NULL DEFAULT 0,
  received_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  transfer_in_quantity  NUMERIC(18,4) NOT NULL DEFAULT 0,
  transfer_out_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  recipe_consumption    NUMERIC(18,4) NOT NULL DEFAULT 0,
  waste_quantity        NUMERIC(18,4) NOT NULL DEFAULT 0,
  adjustment_quantity   NUMERIC(18,4) NOT NULL DEFAULT 0,
  expected_quantity NUMERIC(18,4) NOT NULL DEFAULT 0,
  counted_quantity  NUMERIC(18,4),
  entered_quantity  NUMERIC(18,4),
  entered_unit      TEXT,
  variance_quantity NUMERIC(18,4),
  variance_value    BIGINT,
  variance_percent  NUMERIC(8,3),
  unit_cost         NUMERIC(18,6) NOT NULL DEFAULT 0,
  notes             TEXT,
  counted_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX stock_count_items_unique ON stock_count_items (stock_count_id, item_id);
ALTER TABLE inventory_transactions
  ADD CONSTRAINT inv_txn_count_fk FOREIGN KEY (stock_count_id) REFERENCES stock_counts(id);
