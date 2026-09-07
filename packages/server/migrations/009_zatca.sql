-- =============================================================================
-- 009 ZATCA phase-two e-invoicing (فاتورة)
--
-- A simplified tax invoice is not a receipt with a QR drawn on it. ZATCA
-- requires each one to be a link in a chain: every invoice carries the SHA-256
-- hash of the one before it (PIH) and a counter (ICV) that never repeats and
-- never skips, so a removed or back-dated invoice breaks the chain visibly.
--
-- That is why this lives in the database with its own locked counter rather
-- than being computed at print time: the chain is the audit evidence, and two
-- tills closing bills in the same second must not both claim counter 41.
--
-- Restaurants issue SIMPLIFIED invoices (B2C), which are reported to ZATCA
-- within 24 hours rather than cleared before printing — so a network outage
-- must never stop a customer paying. Issue locally, queue, report after.
-- =============================================================================

-- The cryptographic identity ZATCA issues per device/solution (CSID).
-- One row per branch: the private key is generated here, the CSR is sent to
-- ZATCA, and the certificate it returns is stored back.
CREATE TABLE zatca_credentials (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id          UUID NOT NULL UNIQUE REFERENCES branches(id),
  environment        TEXT NOT NULL DEFAULT 'sandbox'
                       CHECK (environment IN ('sandbox','simulation','production')),
  -- secp256k1 private key, AES-256-GCM encrypted with MFA_SECRET_KEY.
  -- Never returned by any endpoint, never logged, never printed.
  private_key_enc    TEXT NOT NULL,
  public_key_der     TEXT NOT NULL,          -- base64 SubjectPublicKeyInfo
  csr                TEXT,                   -- what was sent to ZATCA
  certificate        TEXT,                   -- base64 CSID returned by ZATCA
  certificate_serial TEXT,
  secret             TEXT,                   -- CSID secret, for the reporting API
  -- ZATCA issues a compliance CSID first; production credentials come after
  -- the compliance checks pass. Reporting with the wrong one is rejected.
  is_production      BOOLEAN NOT NULL DEFAULT FALSE,
  onboarded_at       TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         UUID REFERENCES users(id)
);

COMMENT ON COLUMN zatca_credentials.private_key_enc IS
  'secp256k1 private key, encrypted at rest. Exposure means anyone can stamp invoices as this branch.';

-- One invoice per order. Immutable once signed: a correction is a credit note
-- that references it, never an edit — the same no-hard-delete rule that governs
-- every other financial record here.
CREATE TABLE invoices (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id          UUID NOT NULL REFERENCES branches(id),
  order_id           UUID NOT NULL REFERENCES orders(id),
  -- ZATCA's own identifiers.
  invoice_uuid       UUID NOT NULL,                 -- UBL cbc:UUID
  invoice_number     TEXT NOT NULL,                 -- human-facing, = order number
  icv                BIGINT NOT NULL,               -- invoice counter value
  pih                TEXT NOT NULL,                 -- previous invoice hash, base64
  invoice_hash       TEXT NOT NULL,                 -- this invoice's hash, base64
  -- 'invoice' is a sale; 'credit_note' reverses one (refund/void after payment).
  document_type      TEXT NOT NULL DEFAULT 'invoice'
                       CHECK (document_type IN ('invoice','credit_note','debit_note')),
  reversed_invoice_id UUID REFERENCES invoices(id),
  -- Money as halalas, mirroring orders. Stored rather than joined so a
  -- reprinted invoice always shows what was actually reported.
  subtotal           BIGINT NOT NULL,
  discount_total     BIGINT NOT NULL DEFAULT 0,
  vat_amount         BIGINT NOT NULL,
  grand_total        BIGINT NOT NULL,
  vat_percent        NUMERIC(5,2) NOT NULL,
  -- The artefacts themselves.
  xml                TEXT NOT NULL,                 -- signed UBL 2.1
  qr_tlv             TEXT NOT NULL,                 -- base64 TLV for the printed QR
  signature          TEXT NOT NULL,                 -- base64 ECDSA over the hash
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Reporting lifecycle. 'pending' is normal and safe: the customer has their
  -- invoice, ZATCA has 24 hours to receive it.
  report_status      TEXT NOT NULL DEFAULT 'pending'
                       CHECK (report_status IN ('pending','reported','warning','failed')),
  report_attempts    INT NOT NULL DEFAULT 0,
  reported_at        TIMESTAMPTZ,
  zatca_status       TEXT,                          -- REPORTED / NOT_REPORTED
  zatca_response     JSONB,
  last_error         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The chain's integrity constraints. A duplicate counter or a second invoice
-- for the same order is a reporting rejection later; catch it at write time.
CREATE UNIQUE INDEX invoices_branch_icv_uniq ON invoices (branch_id, icv);
CREATE UNIQUE INDEX invoices_uuid_uniq       ON invoices (invoice_uuid);
CREATE UNIQUE INDEX invoices_order_uniq      ON invoices (order_id)
  WHERE document_type = 'invoice';
CREATE INDEX invoices_branch_issued_idx ON invoices (branch_id, issued_at DESC);
-- The queue the reporting job drains; partial so it stays small as the table grows.
CREATE INDEX invoices_pending_idx ON invoices (branch_id, issued_at)
  WHERE report_status IN ('pending','failed');

COMMENT ON TABLE invoices IS
  'ZATCA simplified tax invoices. Append-only: never updated except for reporting status, never deleted.';
COMMENT ON COLUMN invoices.icv IS
  'Invoice counter value. Monotonic per branch, allocated under a row lock — a gap or a repeat invalidates the chain.';
COMMENT ON COLUMN invoices.pih IS
  'Hash of the previous invoice in this branch. The first invoice uses the ZATCA-specified zero hash.';

-- Per-branch counter, locked with SELECT ... FOR UPDATE when allocating.
-- Kept apart from invoices so the lock is one narrow row, not the whole table.
CREATE TABLE invoice_counters (
  branch_id    UUID PRIMARY KEY REFERENCES branches(id),
  last_icv     BIGINT NOT NULL DEFAULT 0,
  last_hash    TEXT NOT NULL DEFAULT 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON COLUMN invoice_counters.last_hash IS
  'PIH for the next invoice. The default is ZATCA''s mandated genesis value: base64 of the SHA-256 hex of "0".';

-- The receipt is a new kind of print job: it carries money and the tax QR,
-- which no station ticket does, and the agent renders it with a different
-- layout entirely.
ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_kind_check;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_kind_check CHECK (kind IN
  ('new_order','add_item','void','reprint','charcoal_request','bill',
   'receipt','credit_note'));
