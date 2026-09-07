-- =============================================================================
-- 010 devices, and the invoice chain that belongs to each one
--
-- The floor has two kinds of terminal and they are not interchangeable: the
-- till closes bills, the waiter's tablet does not. That is an operating rule
-- first — a waiter should not be handling money — and a ZATCA requirement
-- second: the authority issues a CSID per EGS unit, meaning per device that
-- issues invoices, and each unit keeps its OWN counter and hash chain.
--
-- So the chain moves from the branch to the device. With one till per branch
-- these are the same set of rows today; they stop being the same the day a
-- second till is added, and discovering that then would mean a broken chain.
-- =============================================================================

CREATE TABLE devices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id      UUID NOT NULL REFERENCES branches(id),
  -- cashier: closes bills, issues invoices, holds a CSID.
  -- waiter:  takes orders, never settles.
  -- kiosk / display: customer-facing, no money, no invoices.
  kind           TEXT NOT NULL CHECK (kind IN ('cashier','waiter','kiosk','display')),
  label          TEXT NOT NULL,
  -- The unit's own serial. Goes verbatim into the CSR, so it must be stable for
  -- the life of the device: changing it invalidates the certificate.
  serial_number  TEXT NOT NULL,
  -- Looked up by hash, like every other bearer token here, so a database leak
  -- does not hand over working credentials.
  token_hash     TEXT NOT NULL UNIQUE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at   TIMESTAMPTZ,
  last_ip        INET,
  registered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  registered_by  UUID REFERENCES users(id),
  deleted_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX devices_branch_serial_uniq ON devices (branch_id, serial_number)
  WHERE deleted_at IS NULL;
CREATE INDEX devices_branch_kind_idx ON devices (branch_id, kind) WHERE is_active;

COMMENT ON TABLE devices IS
  'Terminals on the floor. A cashier device is a ZATCA EGS unit: its own CSID, its own invoice chain.';
COMMENT ON COLUMN devices.serial_number IS
  'Goes into the CSR verbatim. Changing it invalidates the certificate issued for this unit.';

-- Every existing branch gets the till it has implicitly been using all along,
-- so nothing that works today stops working.
INSERT INTO devices (branch_id, kind, label, serial_number, token_hash)
SELECT b.id, 'cashier', 'الكاشير الرئيسي', 'TILL-' || b.code,
       encode(sha256(gen_random_uuid()::text::bytea), 'hex')
  FROM branches b;

-- --- The chain moves to the device ------------------------------------------

ALTER TABLE zatca_credentials ADD COLUMN device_id UUID REFERENCES devices(id);
UPDATE zatca_credentials c
   SET device_id = (SELECT d.id FROM devices d
                     WHERE d.branch_id = c.branch_id AND d.kind = 'cashier'
                     ORDER BY d.registered_at LIMIT 1);
ALTER TABLE zatca_credentials ALTER COLUMN device_id SET NOT NULL;
ALTER TABLE zatca_credentials DROP CONSTRAINT zatca_credentials_branch_id_key;
CREATE UNIQUE INDEX zatca_credentials_device_uniq ON zatca_credentials (device_id);

-- What the CSR said about this unit, kept so a re-issue describes the same
-- device rather than whatever the settings screen happens to hold later.
ALTER TABLE zatca_credentials ADD COLUMN egs_serial TEXT;
ALTER TABLE zatca_credentials ADD COLUMN compliance_certificate TEXT;
ALTER TABLE zatca_credentials ADD COLUMN compliance_secret TEXT;
ALTER TABLE zatca_credentials ADD COLUMN compliance_request_id TEXT;
ALTER TABLE zatca_credentials ADD COLUMN onboarding_step TEXT NOT NULL DEFAULT 'keys'
  CHECK (onboarding_step IN ('keys','csr','compliance','checks_passed','production'));

COMMENT ON COLUMN zatca_credentials.onboarding_step IS
  'How far ZATCA onboarding has actually got. Only production may issue live invoices.';

ALTER TABLE invoices ADD COLUMN device_id UUID REFERENCES devices(id);
UPDATE invoices i
   SET device_id = (SELECT d.id FROM devices d
                     WHERE d.branch_id = i.branch_id AND d.kind = 'cashier'
                     ORDER BY d.registered_at LIMIT 1);
ALTER TABLE invoices ALTER COLUMN device_id SET NOT NULL;

-- The counter is per EGS unit, which is what the authority validates against.
DROP INDEX IF EXISTS invoices_branch_icv_uniq;
CREATE UNIQUE INDEX invoices_device_icv_uniq ON invoices (device_id, icv);

ALTER TABLE invoice_counters ADD COLUMN device_id UUID REFERENCES devices(id);
UPDATE invoice_counters c
   SET device_id = (SELECT d.id FROM devices d
                     WHERE d.branch_id = c.branch_id AND d.kind = 'cashier'
                     ORDER BY d.registered_at LIMIT 1);
DELETE FROM invoice_counters WHERE device_id IS NULL;
ALTER TABLE invoice_counters DROP CONSTRAINT invoice_counters_pkey;
ALTER TABLE invoice_counters ALTER COLUMN device_id SET NOT NULL;
ALTER TABLE invoice_counters ADD PRIMARY KEY (device_id);

-- The audit trail should say which terminal took the money, not just who did.
ALTER TABLE payments ADD COLUMN device_id UUID REFERENCES devices(id);
ALTER TABLE orders   ADD COLUMN device_id UUID REFERENCES devices(id);
