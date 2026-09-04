-- =============================================================================
-- 011 delivery aggregators
--
-- Twenty-odd platforms send orders into a Saudi restaurant, and the usual
-- arrangement is a tablet per platform on the counter with a human retyping
-- each order into the POS. That is where the errors come from, and where the
-- sales data stops being reconcilable.
--
-- The design here is deliberately narrow: every platform lands in the SAME
-- orders table through the same pricing and printing path. What differs per
-- platform is only the shape of the payload and how a status is pushed back —
-- so that lives in an adapter, and nothing downstream knows which platform an
-- order came from except when it needs to.
--
-- Two properties matter more than features:
--   * Idempotency. Aggregators retry aggressively and duplicate deliveries are
--     normal, not exceptional. A repeated webhook must never produce a second
--     order or a second ticket.
--   * Never lose an order. A payload we cannot map is stored and raised to a
--     human, not dropped — a rejected order is a customer who paid and got
--     nothing.
-- =============================================================================

CREATE TABLE delivery_partners (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      UUID NOT NULL REFERENCES branches(id),
  -- Stable machine name: jahez, hungerstation, keeta, ninja, toyou, careem,
  -- chefz, marsool, talabat. Drives which adapter handles the payload.
  code           TEXT NOT NULL,
  name_ar        TEXT NOT NULL,
  is_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  -- Whether the platform has already taken the customer's money. Almost always
  -- true, and it decides whether the order is settled on arrival or owes a
  -- payment — getting this wrong makes a day's takings irreconcilable.
  prepaid        BOOLEAN NOT NULL DEFAULT TRUE,
  -- Commission in basis points (1500 = 15%). Reporting needs it to show what
  -- the branch actually keeps, which is the number an owner cares about.
  commission_bps INT NOT NULL DEFAULT 0 CHECK (commission_bps BETWEEN 0 AND 10000),
  -- Shared secret for verifying inbound webhook signatures, and the outbound
  -- credentials for pushing status back. Both encrypted at rest.
  webhook_secret_enc TEXT,
  api_credentials_enc TEXT,
  api_base_url   TEXT,
  -- Auto-accept skips the human confirmation step. Off by default: a kitchen
  -- that is out of an item must be able to reject before the customer waits.
  auto_accept    BOOLEAN NOT NULL DEFAULT FALSE,
  /** Minutes quoted to the platform when an order is accepted. */
  prep_minutes   INT NOT NULL DEFAULT 20 CHECK (prep_minutes BETWEEN 1 AND 240),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID REFERENCES users(id),
  deleted_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX delivery_partners_branch_code_uniq
  ON delivery_partners (branch_id, code) WHERE deleted_at IS NULL;

COMMENT ON COLUMN delivery_partners.prepaid IS
  'The platform already charged the customer. Decides whether the order arrives settled or owing.';

-- Which of our products a platform's item id refers to.
--
-- Without this the integration is a guessing game against item names, and a
-- near-match sends the wrong food. An unmapped item is what makes an order
-- land as needs_mapping rather than silently becoming something else.
CREATE TABLE delivery_menu_map (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id     UUID NOT NULL REFERENCES delivery_partners(id),
  external_id    TEXT NOT NULL,
  external_name  TEXT,
  product_id     UUID REFERENCES products(id),
  -- A modifier option, when the platform sends options as separate line items.
  modifier_option_id UUID REFERENCES modifier_options(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID REFERENCES users(id),
  CHECK (product_id IS NOT NULL OR modifier_option_id IS NOT NULL)
);

CREATE UNIQUE INDEX delivery_menu_map_uniq ON delivery_menu_map (partner_id, external_id);

-- Every inbound payload, exactly as received.
--
-- Stored before anything is parsed, so a payload that crashes the adapter is
-- still on disk to be replayed after the adapter is fixed. This is the table
-- that turns "we lost an order" into "we reprocessed it".
CREATE TABLE delivery_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id     UUID NOT NULL REFERENCES delivery_partners(id),
  branch_id      UUID NOT NULL REFERENCES branches(id),
  -- The platform's own id for this delivery. The idempotency key: a repeat is
  -- recognised here and answered with the original outcome.
  external_event_id TEXT,
  external_order_id TEXT,
  kind           TEXT NOT NULL,          -- order.created, order.cancelled, …
  payload        JSONB NOT NULL,
  signature_ok   BOOLEAN NOT NULL DEFAULT FALSE,
  status         TEXT NOT NULL DEFAULT 'received'
                   CHECK (status IN ('received','processed','needs_mapping','rejected','duplicate')),
  order_id       UUID REFERENCES orders(id),
  error          TEXT,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ
);

CREATE UNIQUE INDEX delivery_events_dedupe
  ON delivery_events (partner_id, external_event_id)
  WHERE external_event_id IS NOT NULL;
CREATE INDEX delivery_events_pending_idx ON delivery_events (branch_id, received_at DESC)
  WHERE status IN ('received','needs_mapping');
CREATE INDEX delivery_events_order_idx ON delivery_events (external_order_id);

COMMENT ON TABLE delivery_events IS
  'Raw inbound payloads, stored before parsing so a failed order can be replayed rather than lost.';

-- The delivery side of an order: who is bringing it, and what the platform has
-- been told so far.
CREATE TABLE delivery_orders (
  order_id       UUID PRIMARY KEY REFERENCES orders(id),
  partner_id     UUID NOT NULL REFERENCES delivery_partners(id),
  branch_id      UUID NOT NULL REFERENCES branches(id),
  external_order_id TEXT NOT NULL,
  -- What the platform shows the customer. Printed on the ticket, because the
  -- rider asks for it by that number and not by ours.
  external_reference TEXT,
  customer_name  TEXT,
  customer_phone TEXT,
  customer_note  TEXT,
  address        TEXT,
  -- Money as halalas, like everywhere else. What the platform says it charged,
  -- kept so a mismatch against our own total is visible rather than assumed.
  platform_total BIGINT,
  delivery_fee   BIGINT NOT NULL DEFAULT 0,
  commission     BIGINT NOT NULL DEFAULT 0,
  is_prepaid     BOOLEAN NOT NULL DEFAULT TRUE,
  -- Our side of the lifecycle. 'pending' means a human has not accepted yet.
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','accepted','preparing','ready',
                                     'picked_up','delivered','rejected','cancelled')),
  rejected_reason TEXT,
  accepted_at    TIMESTAMPTZ,
  ready_at       TIMESTAMPTZ,
  picked_up_at   TIMESTAMPTZ,
  -- What we last managed to tell the platform, and whether it stuck.
  last_pushed_status TEXT,
  push_attempts  INT NOT NULL DEFAULT 0,
  last_push_error TEXT,
  rider_name     TEXT,
  rider_phone    TEXT,
  scheduled_for  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX delivery_orders_partner_external_uniq
  ON delivery_orders (partner_id, external_order_id);
CREATE INDEX delivery_orders_open_idx ON delivery_orders (branch_id, status)
  WHERE status IN ('pending','accepted','preparing','ready');
-- The queue the status pusher drains.
CREATE INDEX delivery_orders_push_idx ON delivery_orders (branch_id)
  WHERE last_push_error IS NOT NULL;

-- Orders can now arrive from a platform, and be for delivery.
ALTER TABLE orders DROP CONSTRAINT orders_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_source_check
  CHECK (source IN ('pos','customer_qr','waiter','delivery'));
ALTER TABLE orders DROP CONSTRAINT orders_order_type_check;
ALTER TABLE orders ADD CONSTRAINT orders_order_type_check
  CHECK (order_type IN ('dine_in','takeaway','delivery'));

-- A delivery order waits for someone to accept it before it reaches a printer,
-- for the same reason a customer's QR order does: the kitchen may be out of an
-- item, and a rider should not be dispatched for food nobody can cook.
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN
  ('draft','pending_waiter_approval','pending_delivery_acceptance','confirmed',
   'printed','partially_updated','ready_for_billing','bill_requested',
   'paid','cancelled'));
