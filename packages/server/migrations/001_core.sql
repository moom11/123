-- =============================================================================
-- MARA Lounge Management System — 001 core
-- Identity, RBAC, branches, sessions, audit, notifications, document numbering.
--
-- Conventions used across every migration:
--   * Primary keys are UUIDs (gen_random_uuid) unless a natural short code is
--     the actual business identifier (e.g. permissions.code).
--   * Money is stored as BIGINT in halalas (minor units). Never FLOAT — the
--     till, the wallet ledger and the printed bill must agree exactly.
--   * Quantities are NUMERIC(18,4) expressed in the item's canonical base unit
--     (g / ml / piece).
--   * Financial and stock history is append-only. Nothing important is ever
--     hard-deleted; rows carry status/deleted_at instead.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- --- Branches ---------------------------------------------------------------
CREATE TABLE branches (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  name_ar        TEXT NOT NULL,
  address        TEXT,
  phone          TEXT,
  vat_number     TEXT,
  timezone       TEXT NOT NULL DEFAULT 'Asia/Riyadh',
  currency       TEXT NOT NULL DEFAULT 'SAR',
  vat_percent    NUMERIC(5,2) NOT NULL DEFAULT 15.00,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID
);

-- --- Roles & permissions ----------------------------------------------------
CREATE TABLE permissions (
  code        TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL UNIQUE,
  name_ar     TEXT NOT NULL,
  is_admin    BOOLEAN NOT NULL DEFAULT FALSE,   -- must use email+password+MFA
  is_system   BOOLEAN NOT NULL DEFAULT TRUE,    -- system roles cannot be deleted
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_id         UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

-- --- Users ------------------------------------------------------------------
-- One row per human. Administrative users authenticate with email + password +
-- MFA; operational staff authenticate through the employees table with a PIN.
CREATE TABLE users (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                TEXT,
  password_hash        TEXT,                 -- Argon2id. NULL for PIN-only staff.
  full_name            TEXT NOT NULL,
  phone                TEXT,
  role_id              UUID NOT NULL REFERENCES roles(id),
  branch_id            UUID REFERENCES branches(id),   -- NULL = all branches (owner)
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_secret           TEXT,                 -- encrypted at rest by the app layer
  mfa_confirmed_at     TIMESTAMPTZ,
  mfa_recovery_codes   JSONB NOT NULL DEFAULT '[]'::jsonb,  -- Argon2id hashes
  failed_login_count   INT NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  password_changed_at  TIMESTAMPTZ,
  last_login_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by           UUID REFERENCES users(id),
  deleted_at           TIMESTAMPTZ
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX users_branch_idx ON users (branch_id);
CREATE INDEX users_role_idx ON users (role_id);

-- Per-user permission overrides on top of the role. Only Owner/Super Admin may
-- write these (checked in the API, and never self-granted by a branch manager).
CREATE TABLE user_permission_overrides (
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  granted         BOOLEAN NOT NULL,          -- TRUE = grant, FALSE = explicit deny
  granted_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission_code)
);

-- Branch access for multi-branch users (owner/executive can span branches).
CREATE TABLE user_branches (
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, branch_id)
);

-- --- Employees (operational staff, Employee ID + PIN) -----------------------
CREATE TABLE employees (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_code  TEXT NOT NULL,              -- the "Employee ID" typed at login, e.g. 1042
  user_id        UUID REFERENCES users(id),  -- links the employee to their principal
  full_name      TEXT NOT NULL,
  job_title      TEXT NOT NULL,
  department     TEXT NOT NULL DEFAULT 'OTHER'
                   CHECK (department IN ('BAR','KITCHEN','SHISHA','FLOOR','ADMIN','OTHER')),
  branch_id      UUID NOT NULL REFERENCES branches(id),
  role_id        UUID NOT NULL REFERENCES roles(id),
  pin_hash       TEXT NOT NULL,              -- Argon2id. Never plaintext.
  pin_changed_at TIMESTAMPTZ,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  failed_pin_count INT NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  last_login_at  TIMESTAMPTZ,
  hired_at       DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID REFERENCES users(id),
  deleted_at     TIMESTAMPTZ
);
-- Employee codes are unique per branch, so branch 2 may reuse code 1042.
CREATE UNIQUE INDEX employees_code_branch_unique
  ON employees (branch_id, employee_code) WHERE deleted_at IS NULL;
CREATE INDEX employees_user_idx ON employees (user_id);

-- --- Sessions ---------------------------------------------------------------
-- Refresh tokens are stored hashed. Rotation replaces the row and records the
-- successor so that replay of a used token can be detected and the whole family
-- revoked.
CREATE TABLE sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_id        UUID REFERENCES employees(id),
  family_id          UUID NOT NULL,
  refresh_token_hash TEXT NOT NULL,
  principal_kind     TEXT NOT NULL CHECK (principal_kind IN ('admin','employee')),
  branch_id          UUID REFERENCES branches(id),
  device_label       TEXT,
  ip                 INET,
  user_agent         TEXT,
  mfa_satisfied      BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at         TIMESTAMPTZ NOT NULL,
  rotated_to         UUID REFERENCES sessions(id),
  revoked_at         TIMESTAMPTZ,
  revoked_reason     TEXT,
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sessions_refresh_hash_idx ON sessions (refresh_token_hash);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_family_idx ON sessions (family_id);

-- --- Audit log --------------------------------------------------------------
-- Append-only. The application role is granted INSERT and SELECT only; there is
-- no UPDATE or DELETE path exposed anywhere in the API.
CREATE TABLE audit_logs (
  id             BIGSERIAL PRIMARY KEY,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  branch_id      UUID REFERENCES branches(id),
  actor_user_id  UUID REFERENCES users(id),
  actor_employee_id UUID REFERENCES employees(id),
  actor_label    TEXT,                     -- denormalised name, survives renames
  actor_kind     TEXT NOT NULL DEFAULT 'user'
                   CHECK (actor_kind IN ('user','employee','customer','system','print_agent')),
  action         TEXT NOT NULL,            -- e.g. 'order.discount.applied'
  entity_type    TEXT,
  entity_id      TEXT,
  old_value      JSONB,
  new_value      JSONB,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip             INET,
  user_agent     TEXT,
  request_id     TEXT
);
CREATE INDEX audit_logs_occurred_idx ON audit_logs (occurred_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, occurred_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, occurred_at DESC);
CREATE INDEX audit_logs_branch_idx ON audit_logs (branch_id, occurred_at DESC);

-- --- Notifications ----------------------------------------------------------
CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id   UUID REFERENCES branches(id),
  kind        TEXT NOT NULL,               -- 'low_stock', 'print_failed', ...
  severity    TEXT NOT NULL DEFAULT 'info'
                CHECK (severity IN ('info','warning','critical')),
  title_ar    TEXT NOT NULL,
  body_ar     TEXT NOT NULL DEFAULT '',
  entity_type TEXT,
  entity_id   TEXT,
  -- Targeting: any principal holding one of these permissions, in this branch.
  target_permissions TEXT[] NOT NULL DEFAULT '{}',
  target_user_id     UUID REFERENCES users(id),
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_branch_idx ON notifications (branch_id, created_at DESC);

CREATE TABLE notification_reads (
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);

-- --- Settings ---------------------------------------------------------------
-- Branch-scoped key/value configuration (points conversion rate, variance
-- thresholds, waste approval limits, OTP TTL, ...). NULL branch = global.
CREATE TABLE settings (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id  UUID REFERENCES branches(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users(id)
);
CREATE UNIQUE INDEX settings_scope_key_idx
  ON settings (COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), key);

-- --- Document numbering -----------------------------------------------------
-- ORD-2026-000001 etc., counted independently per branch, per document kind,
-- per year. next_document_number() below is transaction-safe under concurrency.
CREATE TABLE document_sequences (
  branch_id  UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  doc_kind   TEXT NOT NULL,      -- 'ORD','PR','PO','INV','WST','TRF','CNT'
  year       INT  NOT NULL,
  last_value BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, doc_kind, year)
);

CREATE OR REPLACE FUNCTION next_document_number(p_branch UUID, p_kind TEXT, p_year INT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_next BIGINT;
BEGIN
  INSERT INTO document_sequences (branch_id, doc_kind, year, last_value)
  VALUES (p_branch, p_kind, p_year, 1)
  ON CONFLICT (branch_id, doc_kind, year)
  DO UPDATE SET last_value = document_sequences.last_value + 1
  RETURNING last_value INTO v_next;

  RETURN p_kind || '-' || p_year::TEXT || '-' || lpad(v_next::TEXT, 6, '0');
END;
$$;

-- Keeps updated_at honest without every writer having to remember.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER branches_touch  BEFORE UPDATE ON branches
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER users_touch     BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER employees_touch BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
