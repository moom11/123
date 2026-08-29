-- =============================================================================
-- 004 operations — tables, sessions, orders, payments, discounts, printing
-- =============================================================================

CREATE TABLE restaurant_tables (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       UUID NOT NULL REFERENCES branches(id),
  table_number    TEXT NOT NULL,             -- '12', 'A3', ...
  display_name    TEXT,
  area            TEXT,                      -- section / floor
  seats           INT,
  -- The QR encodes this opaque token, never the table number, so a guest
  -- cannot retarget another table by editing the URL. Rotating the token
  -- invalidates every printed sticker for that table on purpose.
  qr_token        TEXT NOT NULL,
  qr_rotated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  status          TEXT NOT NULL DEFAULT 'available' CHECK (status IN
                    ('available','occupied','new_order','waiter_requested',
                     'charcoal_requested','bill_requested')),
  assigned_waiter_employee_id UUID REFERENCES employees(id),
  current_session_id UUID,                   -- FK added after table_sessions
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID REFERENCES users(id),
  deleted_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX tables_branch_number ON restaurant_tables (branch_id, table_number)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX tables_qr_token ON restaurant_tables (qr_token);
CREATE TRIGGER tables_touch BEFORE UPDATE ON restaurant_tables
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- One seating. Everything a party does — orders, service requests, the bill —
-- hangs off the session, which is what makes merge and move well-defined.
CREATE TABLE table_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       UUID NOT NULL REFERENCES branches(id),
  table_id        UUID NOT NULL REFERENCES restaurant_tables(id),
  opened_by_employee_id UUID REFERENCES employees(id),
  waiter_employee_id    UUID REFERENCES employees(id),
  customer_id     UUID REFERENCES customers(id),
  guest_count     INT NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','billing','closed','merged')),
  -- Set when this session was folded into another by a merge.
  merged_into_session_id UUID REFERENCES table_sessions(id),
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX table_sessions_table_idx ON table_sessions (table_id, status);
CREATE INDEX table_sessions_open_idx ON table_sessions (branch_id, status)
  WHERE status IN ('open','billing');
ALTER TABLE restaurant_tables
  ADD CONSTRAINT tables_current_session_fk
  FOREIGN KEY (current_session_id) REFERENCES table_sessions(id);
CREATE TRIGGER table_sessions_touch BEFORE UPDATE ON table_sessions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- --- Orders -----------------------------------------------------------------
CREATE TABLE orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number      TEXT NOT NULL,           -- ORD-2026-000001
  branch_id         UUID NOT NULL REFERENCES branches(id),
  table_id          UUID REFERENCES restaurant_tables(id),
  session_id        UUID REFERENCES table_sessions(id),
  customer_id       UUID REFERENCES customers(id),
  waiter_employee_id UUID REFERENCES employees(id),
  created_by_employee_id UUID REFERENCES employees(id),
  created_by_user_id     UUID REFERENCES users(id),
  source            TEXT NOT NULL DEFAULT 'pos'
                      CHECK (source IN ('pos','customer_qr','waiter')),
  order_type        TEXT NOT NULL DEFAULT 'dine_in'
                      CHECK (order_type IN ('dine_in','takeaway')),
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                      ('draft','pending_waiter_approval','confirmed','printed',
                       'partially_updated','ready_for_billing','bill_requested',
                       'paid','cancelled')),
  -- Money, all halalas. subtotal is the sum of line totals before discounts.
  subtotal          BIGINT NOT NULL DEFAULT 0,
  discount_total    BIGINT NOT NULL DEFAULT 0,
  points_redeemed         INT NOT NULL DEFAULT 0,
  points_discount_total   BIGINT NOT NULL DEFAULT 0,
  service_charge    BIGINT NOT NULL DEFAULT 0,
  vat_amount        BIGINT NOT NULL DEFAULT 0,
  grand_total       BIGINT NOT NULL DEFAULT 0,
  paid_total        BIGINT NOT NULL DEFAULT 0,
  guest_count       INT NOT NULL DEFAULT 1,
  notes             TEXT,
  cancel_reason     TEXT,
  -- Idempotency key supplied by the POS / customer app. A retried submit with
  -- the same key returns the original order instead of creating a duplicate.
  idempotency_key   TEXT,
  approved_by_employee_id UUID REFERENCES employees(id),
  approved_at       TIMESTAMPTZ,
  rejected_reason   TEXT,
  first_printed_at  TIMESTAMPTZ,
  paid_at           TIMESTAMPTZ,
  closed_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX orders_number_idx ON orders (order_number);
CREATE UNIQUE INDEX orders_idempotency_idx ON orders (branch_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX orders_session_idx ON orders (session_id);
CREATE INDEX orders_table_idx ON orders (table_id, status);
CREATE INDEX orders_customer_idx ON orders (customer_id, created_at DESC);
CREATE INDEX orders_branch_created_idx ON orders (branch_id, created_at DESC);
CREATE INDEX orders_waiter_idx ON orders (waiter_employee_id, created_at DESC);
CREATE INDEX orders_pending_approval_idx ON orders (branch_id, waiter_employee_id)
  WHERE status = 'pending_waiter_approval';
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE order_status_history (
  id          BIGSERIAL PRIMARY KEY,
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_user_id     UUID REFERENCES users(id),
  actor_employee_id UUID REFERENCES employees(id),
  actor_kind  TEXT NOT NULL DEFAULT 'employee',
  reason      TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_status_history_order_idx ON order_status_history (order_id, occurred_at);

CREATE TABLE order_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_number     INT NOT NULL,
  product_id      UUID NOT NULL REFERENCES products(id),
  variant_id      UUID REFERENCES product_variants(id),
  -- Snapshot of the name/department at the time of sale: renaming a product or
  -- moving it to another printer later must not rewrite history.
  product_name_ar TEXT NOT NULL,
  production_department TEXT NOT NULL,
  quantity        NUMERIC(10,3) NOT NULL CHECK (quantity > 0),
  unit_price      BIGINT NOT NULL,          -- menu price at time of sale
  effective_unit_price BIGINT NOT NULL,     -- after special price / discount
  modifiers_total BIGINT NOT NULL DEFAULT 0,
  line_total      BIGINT NOT NULL,
  discount_amount BIGINT NOT NULL DEFAULT 0,
  discount_id     UUID,                     -- FK added below
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                    ('pending','confirmed','printed','voided')),
  -- Printing bookkeeping: an item printed once is never reprinted wholesale;
  -- later additions produce an ADD ITEM ticket instead.
  printed_at      TIMESTAMPTZ,
  print_batch     INT NOT NULL DEFAULT 0,   -- 0 = not yet printed, 1 = first ticket
  voided_at       TIMESTAMPTZ,
  voided_by_employee_id UUID REFERENCES employees(id),
  voided_by_user_id     UUID REFERENCES users(id),
  void_reason     TEXT,
  -- Set once the recipe has been drawn down, so stock is never double-counted.
  consumption_posted_at TIMESTAMPTZ,
  added_by_employee_id UUID REFERENCES employees(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX order_items_line_idx ON order_items (order_id, line_number);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX order_items_product_idx ON order_items (product_id);
CREATE INDEX order_items_unprinted_idx ON order_items (order_id)
  WHERE printed_at IS NULL AND status <> 'voided';
CREATE TRIGGER order_items_touch BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE order_item_modifiers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id      UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  modifier_id        UUID REFERENCES modifiers(id),
  modifier_option_id UUID NOT NULL REFERENCES modifier_options(id),
  modifier_name_ar   TEXT NOT NULL,
  option_name_ar     TEXT NOT NULL,
  price_delta        BIGINT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX oim_item_idx ON order_item_modifiers (order_item_id);

-- --- Discounts --------------------------------------------------------------
-- Every discount application is a durable record carrying the full evidence
-- trail the spec demands: who, which customer, which invoice, which table,
-- the price before and after, and the OTP verification that authorised it.
CREATE TABLE discounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id         UUID NOT NULL REFERENCES branches(id),
  order_id          UUID REFERENCES orders(id),
  order_item_id     UUID REFERENCES order_items(id),
  table_id          UUID REFERENCES restaurant_tables(id),
  customer_id       UUID REFERENCES customers(id),
  kind              TEXT NOT NULL CHECK (kind IN
                      ('customer_special_price','points_redemption','coupon','manual')),
  special_price_id  UUID REFERENCES customer_special_prices(id),
  coupon_id         UUID REFERENCES coupons(id),
  original_price    BIGINT NOT NULL,
  discounted_price  BIGINT NOT NULL,
  discount_amount   BIGINT NOT NULL,
  points_used       INT NOT NULL DEFAULT 0,
  -- The OTP row that authorised this. NOT NULL is enforced in the application
  -- for the two kinds that require it; kept nullable here so that manual
  -- management discounts (which are audited differently) remain representable.
  otp_request_id    UUID REFERENCES otp_requests(id),
  otp_verified      BOOLEAN NOT NULL DEFAULT FALSE,
  otp_verified_at   TIMESTAMPTZ,
  applied_by_employee_id UUID REFERENCES employees(id),
  applied_by_user_id     UUID REFERENCES users(id),
  reason            TEXT,
  reversed_at       TIMESTAMPTZ,
  reversed_reason   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT discount_otp_required CHECK (
    kind NOT IN ('customer_special_price','points_redemption')
    OR (otp_request_id IS NOT NULL AND otp_verified = TRUE)
  )
);
CREATE INDEX discounts_order_idx ON discounts (order_id);
CREATE INDEX discounts_customer_idx ON discounts (customer_id, created_at DESC);
ALTER TABLE order_items
  ADD CONSTRAINT order_items_discount_fk FOREIGN KEY (discount_id) REFERENCES discounts(id);

-- --- Payments ---------------------------------------------------------------
CREATE TABLE payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_number   TEXT NOT NULL,
  branch_id        UUID NOT NULL REFERENCES branches(id),
  order_id         UUID NOT NULL REFERENCES orders(id),
  method           TEXT NOT NULL CHECK (method IN
                     ('cash','mada','visa','mastercard','apple_pay','wallet_points')),
  amount           BIGINT NOT NULL CHECK (amount > 0),
  tendered         BIGINT,                  -- cash given
  change_given     BIGINT NOT NULL DEFAULT 0,
  reference        TEXT,                    -- terminal / approval code
  -- Split-bill bookkeeping. `split_group` groups the parts of one split; when
  -- splitting by items, split_item_ids records which lines this part covers.
  split_group      UUID,
  split_item_ids   UUID[],
  is_partial       BOOLEAN NOT NULL DEFAULT FALSE,
  status           TEXT NOT NULL DEFAULT 'captured'
                     CHECK (status IN ('captured','voided','refunded')),
  voided_at        TIMESTAMPTZ,
  void_reason      TEXT,
  refunded_amount  BIGINT NOT NULL DEFAULT 0,
  idempotency_key  TEXT,
  taken_by_employee_id UUID REFERENCES employees(id),
  taken_by_user_id     UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_number_idx ON payments (payment_number);
-- The duplicate-invoice guard: a retried payment submit is a no-op.
CREATE UNIQUE INDEX payments_idempotency_idx ON payments (branch_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX payments_order_idx ON payments (order_id);
CREATE INDEX payments_branch_created_idx ON payments (branch_id, created_at DESC);

ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_txn_order_fk FOREIGN KEY (order_id) REFERENCES orders(id);
ALTER TABLE otp_requests
  ADD CONSTRAINT otp_order_fk FOREIGN KEY (order_id) REFERENCES orders(id),
  ADD CONSTRAINT otp_table_fk FOREIGN KEY (table_id) REFERENCES restaurant_tables(id);
ALTER TABLE customer_sessions
  ADD CONSTRAINT customer_sessions_table_fk FOREIGN KEY (table_id) REFERENCES restaurant_tables(id);

-- --- Service requests -------------------------------------------------------
-- "طلب ويتر" / "طلب فحم" / "طلب الحساب" from the guest's phone.
CREATE TABLE service_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id    UUID NOT NULL REFERENCES branches(id),
  table_id     UUID NOT NULL REFERENCES restaurant_tables(id),
  session_id   UUID REFERENCES table_sessions(id),
  customer_id  UUID REFERENCES customers(id),
  kind         TEXT NOT NULL CHECK (kind IN ('waiter','charcoal','bill')),
  status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','acknowledged','resolved','cancelled')),
  assigned_waiter_employee_id UUID REFERENCES employees(id),
  note         TEXT,
  print_job_id UUID,                      -- charcoal requests print a ticket
  resolved_by_employee_id UUID REFERENCES employees(id),
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX service_requests_open_idx ON service_requests (branch_id, status, created_at DESC);
CREATE INDEX service_requests_table_idx ON service_requests (table_id, kind, created_at DESC);

-- --- Printing ---------------------------------------------------------------
CREATE TABLE printers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      UUID NOT NULL REFERENCES branches(id),
  name           TEXT NOT NULL,
  department     TEXT NOT NULL CHECK (department IN ('BAR','KITCHEN','SHISHA','OTHER','CASHIER')),
  ip_address     INET NOT NULL,
  port           INT NOT NULL DEFAULT 9100,
  protocol       TEXT NOT NULL DEFAULT 'escpos_tcp'
                   CHECK (protocol IN ('escpos_tcp','escpos_usb')),
  codepage       TEXT NOT NULL DEFAULT 'cp864',   -- Arabic-capable code page
  chars_per_line INT NOT NULL DEFAULT 42,
  is_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  status         TEXT NOT NULL DEFAULT 'unknown'
                   CHECK (status IN ('unknown','online','offline','error')),
  status_message TEXT,
  last_seen_at   TIMESTAMPTZ,
  -- If this printer is down, its jobs are re-routed here rather than lost.
  fallback_printer_id UUID REFERENCES printers(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID REFERENCES users(id),
  deleted_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX printers_branch_name ON printers (branch_id, name) WHERE deleted_at IS NULL;
CREATE INDEX printers_department_idx ON printers (branch_id, department) WHERE is_enabled;
CREATE TRIGGER printers_touch BEFORE UPDATE ON printers
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Local agents that poll the cloud queue and drive the IP printers. The iPad
-- never talks to a printer directly.
CREATE TABLE print_agents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     UUID NOT NULL REFERENCES branches(id),
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL,             -- Argon2id of the agent's bearer token
  is_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at  TIMESTAMPTZ,
  agent_version TEXT,
  ip            INET,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID REFERENCES users(id)
);
CREATE UNIQUE INDEX print_agents_token_idx ON print_agents (token_hash);

-- The durable queue. A job is never lost: it is claimed with a lease, and an
-- expired lease returns it to 'queued' for another attempt.
CREATE TABLE print_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       UUID NOT NULL REFERENCES branches(id),
  printer_id      UUID NOT NULL REFERENCES printers(id),
  order_id        UUID REFERENCES orders(id),
  service_request_id UUID REFERENCES service_requests(id),
  kind            TEXT NOT NULL CHECK (kind IN
                    ('new_order','add_item','void','reprint','charcoal_request','bill')),
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','claimed','printed','failed','cancelled')),
  -- The rendered ticket, as structured data. The agent turns it into ESC/POS
  -- so ticket layout can change without redeploying every branch.
  payload         JSONB NOT NULL,
  copies          INT NOT NULL DEFAULT 1,
  attempt_count   INT NOT NULL DEFAULT 0,
  max_attempts    INT NOT NULL DEFAULT 5,
  last_error      TEXT,
  claimed_by_agent_id UUID REFERENCES print_agents(id),
  claimed_at      TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  printed_at      TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_reprint      BOOLEAN NOT NULL DEFAULT FALSE,
  reprint_of_job_id UUID REFERENCES print_jobs(id),
  reprint_reason  TEXT,
  requested_by_employee_id UUID REFERENCES employees(id),
  requested_by_user_id     UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX print_jobs_dispatch_idx ON print_jobs (branch_id, status, next_attempt_at)
  WHERE status IN ('queued','claimed');
CREATE INDEX print_jobs_order_idx ON print_jobs (order_id, created_at DESC);
CREATE INDEX print_jobs_printer_idx ON print_jobs (printer_id, created_at DESC);
CREATE TRIGGER print_jobs_touch BEFORE UPDATE ON print_jobs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE service_requests
  ADD CONSTRAINT service_requests_print_job_fk FOREIGN KEY (print_job_id) REFERENCES print_jobs(id);
