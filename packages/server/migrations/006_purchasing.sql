-- =============================================================================
-- 006 purchasing — requests, branch-manager approval, buyer execution, receipt
--
-- The central invariant of this module: the purchasing rep sees a request only
-- once a branch manager has approved it, and only ever the quantity the manager
-- approved. Both facts are enforced in SQL (the buyer view below), not in the
-- client.
-- =============================================================================

CREATE TABLE purchase_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number TEXT NOT NULL,           -- PR-2026-000001
  branch_id      UUID NOT NULL REFERENCES branches(id),
  department     TEXT NOT NULL CHECK (department IN ('BAR','KITCHEN','SHISHA','FLOOR','OTHER')),
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                   ('draft','submitted','pending_branch_manager','approved','rejected',
                    'sent_to_buyer','purchasing','purchased','in_transit','delivered',
                    'received','closed','cancelled')),
  priority       TEXT NOT NULL DEFAULT 'normal'
                   CHECK (priority IN ('low','normal','high','urgent')),
  reason         TEXT,
  notes          TEXT,
  needed_by      DATE,
  requested_by_employee_id UUID REFERENCES employees(id),
  requested_by_user_id     UUID REFERENCES users(id),
  submitted_at   TIMESTAMPTZ,
  -- Approval
  approved_by_user_id UUID REFERENCES users(id),
  approved_at    TIMESTAMPTZ,
  reject_reason  TEXT,
  manager_comment TEXT,
  -- Buyer execution
  buyer_user_id  UUID REFERENCES users(id),
  buyer_started_at TIMESTAMPTZ,
  purchased_at   TIMESTAMPTZ,
  in_transit_at  TIMESTAMPTZ,
  delivered_at   TIMESTAMPTZ,
  received_at    TIMESTAMPTZ,
  closed_at      TIMESTAMPTZ,
  estimated_total BIGINT NOT NULL DEFAULT 0,
  actual_total    BIGINT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pr_number_idx ON purchase_requests (request_number);
CREATE INDEX pr_branch_status_idx ON purchase_requests (branch_id, status, created_at DESC);
CREATE INDEX pr_department_idx ON purchase_requests (branch_id, department, created_at DESC);
CREATE INDEX pr_requester_idx ON purchase_requests (requested_by_employee_id, created_at DESC);
-- Supports the buyer's "my work queue" without ever touching unapproved rows.
CREATE INDEX pr_buyer_queue_idx ON purchase_requests (branch_id, status)
  WHERE status IN ('approved','sent_to_buyer','purchasing','purchased','in_transit','delivered');
CREATE TRIGGER pr_touch BEFORE UPDATE ON purchase_requests
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE purchase_request_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id        UUID NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  item_id           UUID NOT NULL REFERENCES inventory_items(id),
  -- All quantities are in base units; entered_* preserves what the human typed.
  requested_quantity NUMERIC(18,4) NOT NULL CHECK (requested_quantity > 0),
  entered_quantity  NUMERIC(18,4) NOT NULL,
  entered_unit      TEXT NOT NULL,
  -- Set by the branch manager. This — never requested_quantity — is what the
  -- buyer is shown and what bounds what the buyer may purchase.
  approved_quantity NUMERIC(18,4),
  purchased_quantity NUMERIC(18,4),
  delivered_quantity NUMERIC(18,4),
  received_quantity  NUMERIC(18,4),
  -- Snapshot at request time, so the manager sees why it was raised.
  current_stock     NUMERIC(18,4) NOT NULL DEFAULT 0,
  min_stock         NUMERIC(18,4) NOT NULL DEFAULT 0,
  estimated_unit_cost NUMERIC(18,6) NOT NULL DEFAULT 0,
  actual_unit_cost    NUMERIC(18,6),
  supplier_id       UUID REFERENCES suppliers(id),
  reason            TEXT,
  notes             TEXT,
  manager_note      TEXT,
  -- A buyer asking to exceed the approved quantity parks here until a manager
  -- decides; the buyer can never simply type a bigger number.
  change_requested_quantity NUMERIC(18,4),
  change_request_reason     TEXT,
  change_request_status     TEXT CHECK (change_request_status IN ('pending','approved','rejected')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pri_request_idx ON purchase_request_items (request_id);
CREATE INDEX pri_item_idx ON purchase_request_items (item_id);
CREATE TRIGGER pri_touch BEFORE UPDATE ON purchase_request_items
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Every approval decision, kept as history rather than overwritten.
CREATE TABLE purchase_approvals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    UUID NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  decision      TEXT NOT NULL CHECK (decision IN
                  ('approved','rejected','returned_for_change','change_approved','change_rejected')),
  approver_user_id UUID NOT NULL REFERENCES users(id),
  approver_role  TEXT,
  comment       TEXT,
  -- [{ item_id, requested, approved }] — the paper trail for "60L became 40L".
  quantity_changes JSONB NOT NULL DEFAULT '[]'::jsonb,
  decided_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pa_request_idx ON purchase_approvals (request_id, decided_at DESC);

-- --- Purchases (what the buyer actually bought) -----------------------------
CREATE TABLE purchases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_number TEXT NOT NULL,          -- PO-2026-000001
  branch_id       UUID NOT NULL REFERENCES branches(id),
  request_id      UUID REFERENCES purchase_requests(id),
  supplier_id     UUID REFERENCES suppliers(id),
  buyer_user_id   UUID REFERENCES users(id),
  buyer_employee_id UUID REFERENCES employees(id),
  invoice_number  TEXT,
  invoice_date    DATE,
  subtotal        BIGINT NOT NULL DEFAULT 0,
  vat_amount      BIGINT NOT NULL DEFAULT 0,
  total           BIGINT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'recorded'
                    CHECK (status IN ('recorded','in_transit','delivered','received','cancelled')),
  notes           TEXT,
  -- The buyer app works offline; this is the de-duplication key on sync.
  client_ref      TEXT,
  purchased_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX purchases_number_idx ON purchases (purchase_number);
CREATE UNIQUE INDEX purchases_client_ref_idx ON purchases (branch_id, client_ref)
  WHERE client_ref IS NOT NULL;
CREATE INDEX purchases_request_idx ON purchases (request_id);
CREATE INDEX purchases_supplier_idx ON purchases (supplier_id, purchased_at DESC);
CREATE TRIGGER purchases_touch BEFORE UPDATE ON purchases
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE purchase_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id       UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  request_item_id   UUID REFERENCES purchase_request_items(id),
  item_id           UUID NOT NULL REFERENCES inventory_items(id),
  quantity          NUMERIC(18,4) NOT NULL CHECK (quantity > 0),   -- base units
  entered_quantity  NUMERIC(18,4) NOT NULL,
  entered_unit      TEXT NOT NULL,
  unit_price        NUMERIC(18,6) NOT NULL DEFAULT 0,   -- halalas per base unit
  line_subtotal     BIGINT NOT NULL DEFAULT 0,
  vat_amount        BIGINT NOT NULL DEFAULT 0,
  line_total        BIGINT NOT NULL DEFAULT 0,
  supplier_id       UUID REFERENCES suppliers(id),
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX purchase_items_purchase_idx ON purchase_items (purchase_id);
CREATE INDEX purchase_items_item_idx ON purchase_items (item_id);
ALTER TABLE inventory_transactions
  ADD CONSTRAINT inv_txn_purchase_fk FOREIGN KEY (purchase_id) REFERENCES purchases(id);
ALTER TABLE goods_receipts
  ADD CONSTRAINT goods_receipts_purchase_fk FOREIGN KEY (purchase_id) REFERENCES purchases(id);

-- --- Supplier price history -------------------------------------------------
-- Append-only. Feeds "last price / average price / lowest recent price" for the
-- buyer and the manager — as information, never as an automatic supplier pick.
CREATE TABLE supplier_prices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id   UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  item_id       UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  unit_price    NUMERIC(18,6) NOT NULL,   -- halalas per base unit
  entered_price NUMERIC(18,6) NOT NULL,
  entered_unit  TEXT NOT NULL,
  purchase_id   UUID REFERENCES purchases(id),
  source        TEXT NOT NULL DEFAULT 'purchase'
                  CHECK (source IN ('purchase','quote','manual')),
  effective_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by_user_id UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX supplier_prices_item_idx ON supplier_prices (item_id, effective_at DESC);
CREATE INDEX supplier_prices_supplier_item_idx ON supplier_prices (supplier_id, item_id, effective_at DESC);

-- --- Attachments ------------------------------------------------------------
-- Invoice photographs and any other uploaded evidence. `ocr_text`/`ocr_status`
-- are present from day one so OCR can be added later without a migration.
CREATE TABLE attachments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      UUID REFERENCES branches(id),
  entity_type    TEXT NOT NULL,           -- 'purchase', 'goods_receipt', ...
  entity_id      UUID NOT NULL,
  file_name      TEXT NOT NULL,
  content_type   TEXT NOT NULL,
  byte_size      BIGINT NOT NULL,
  storage_key    TEXT NOT NULL,
  checksum_sha256 TEXT,
  ocr_status     TEXT NOT NULL DEFAULT 'not_requested'
                   CHECK (ocr_status IN ('not_requested','pending','done','failed')),
  ocr_text       TEXT,
  uploaded_by_user_id     UUID REFERENCES users(id),
  uploaded_by_employee_id UUID REFERENCES employees(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX attachments_entity_idx ON attachments (entity_type, entity_id);

-- --- The buyer's window onto purchasing -------------------------------------
-- The purchasing rep queries THIS, never purchase_requests. Unapproved requests
-- are not merely hidden: they are not in the result set at all, and the column
-- list exposes the approved quantity rather than the requested one.
CREATE VIEW buyer_purchase_requests AS
SELECT
  pr.id,
  pr.request_number,
  pr.branch_id,
  pr.department,
  pr.status,
  pr.priority,
  pr.needed_by,
  pr.notes,
  pr.approved_at,
  pr.buyer_user_id,
  pr.purchased_at,
  pr.in_transit_at,
  pr.delivered_at,
  pr.received_at,
  pr.created_at,
  pr.updated_at
FROM purchase_requests pr
WHERE pr.status IN ('approved','sent_to_buyer','purchasing','purchased',
                    'in_transit','delivered','received','closed');

CREATE VIEW buyer_purchase_request_items AS
SELECT
  pri.id,
  pri.request_id,
  pri.item_id,
  -- Deliberately NOT requested_quantity: the buyer sees the approved figure.
  pri.approved_quantity,
  pri.purchased_quantity,
  pri.delivered_quantity,
  pri.received_quantity,
  pri.entered_unit,
  pri.estimated_unit_cost,
  pri.actual_unit_cost,
  pri.supplier_id,
  pri.notes,
  pri.manager_note,
  pri.change_requested_quantity,
  pri.change_request_reason,
  pri.change_request_status
FROM purchase_request_items pri
JOIN purchase_requests pr ON pr.id = pri.request_id
WHERE pr.status IN ('approved','sent_to_buyer','purchasing','purchased',
                    'in_transit','delivered','received','closed');
