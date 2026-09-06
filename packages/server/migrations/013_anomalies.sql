-- =============================================================================
-- 013 anomalies
--
-- The system already shouts when one thing is big: a discount over the limit,
-- a large void, a waste record awaiting approval. Those catch the careless.
-- They do not catch the patient, because nobody who is stealing takes one
-- large discount. They take fifty small ones, each below the threshold, each
-- individually explainable, over three months.
--
-- What separates the two is not the size of any single event but the SHAPE of
-- many: the same waiter voiding printed food twice a shift, the same cashier
-- and the same customer meeting for a discount every Tuesday, a department
-- whose waste triples the week before a stock count. No single row is
-- evidence. The pattern is.
--
-- So this table holds a FINDING, not an event: a claim about a subject over a
-- period, the number that tripped it, the threshold it passed, and the rows
-- behind it. It is deliberately dull about consequences — nothing here
-- accuses, blocks, or reverses anything. It puts a question in front of a
-- manager with the evidence attached, and records what they decided.
--
-- Dismissing one is a decision with a name on it, kept forever. "Reviewed and
-- explained" is an answer; silence is not.
-- =============================================================================

CREATE TABLE anomalies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id     UUID NOT NULL REFERENCES branches(id),

  -- Which detector found it. Stored rather than derived so a finding survives
  -- a detector being retired or rewritten — the manager's decision from last
  -- March must still read as what it was.
  code          TEXT NOT NULL,
  severity      TEXT NOT NULL CHECK (severity IN ('warning','critical')),

  -- Who or what the finding is about. A finding with no subject (a branch-wide
  -- one) is legal, which is why subject_id is nullable and the uniqueness
  -- index below coalesces it.
  subject_type  TEXT NOT NULL CHECK (subject_type IN
                  ('employee','user','customer','order','invoice','product',
                   'department','item','branch')),
  subject_id    UUID,
  -- The name as it read when the finding was made. An employee who leaves,
  -- or a product that is renamed, must not make last month's finding
  -- unreadable.
  subject_label TEXT NOT NULL,

  -- The window the claim is about: '2026-09-06' for a daily detector,
  -- '2026-W36' for a weekly one, or a row id where the finding is about one
  -- specific record. Part of the identity of a finding: the same waiter
  -- voiding printed food on two different days is two findings, and the same
  -- day re-swept is one.
  period_key    TEXT NOT NULL,

  title_ar      TEXT NOT NULL,
  detail_ar     TEXT NOT NULL,

  -- The number that tripped it and the number it had to pass. Kept apart so a
  -- manager can see how far over the line something is, and so a threshold
  -- change does not silently rewrite history.
  metric        NUMERIC(18,4) NOT NULL,
  threshold     NUMERIC(18,4) NOT NULL,

  -- The rows behind the claim: order numbers, amounts, timestamps. This is
  -- what makes the finding answerable instead of an accusation.
  evidence      JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- open        : nobody has looked
  -- acknowledged: a manager has seen it and is acting on it
  -- dismissed   : explained, with a reason and a name
  status        TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','acknowledged','dismissed')),

  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_detected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- How many sweeps have seen it. A finding still present a week after it was
  -- dismissed is worth a second look.
  detections    INT NOT NULL DEFAULT 1,

  reviewed_by_user_id UUID REFERENCES users(id),
  reviewed_at   TIMESTAMPTZ,
  review_note   TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One finding per subject per period per detector. The sweep runs hourly and
-- re-derives the same claim every time; this is what turns that into an update
-- of one row rather than a fresh alarm every hour, which is how alerting
-- systems get ignored.
CREATE UNIQUE INDEX anomalies_identity_uk ON anomalies
  (branch_id, code, period_key, COALESCE(subject_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX anomalies_open_idx ON anomalies (branch_id, status, last_detected_at DESC);
CREATE INDEX anomalies_subject_idx ON anomalies (subject_type, subject_id, last_detected_at DESC);
CREATE INDEX anomalies_code_idx ON anomalies (code, last_detected_at DESC);

-- Thresholds live in settings so a branch can tune them without a deploy, and
-- so the number a finding was judged against is a thing someone chose rather
-- than a constant buried in code. Branch-null means every branch.
INSERT INTO settings (branch_id, key, value) VALUES
  -- Cooked food removed from a bill by the same person, in one day.
  (NULL, 'anomaly_void_after_print_count', '3'::jsonb),
  -- How many times the branch's own average void rate an employee may reach.
  (NULL, 'anomaly_void_rate_ratio', '3'::jsonb),
  -- Below this many orders an employee's rate is noise, not a pattern.
  (NULL, 'anomaly_void_rate_min_orders', '20'::jsonb),
  -- Discounts applied by one person in one day.
  (NULL, 'anomaly_discount_count_per_day', '8'::jsonb),
  -- The same employee discounting for the same customer, in one week.
  (NULL, 'anomaly_discount_pair_per_week', '4'::jsonb),
  -- A day's waste against what the department normally throws away.
  (NULL, 'anomaly_waste_spike_ratio', '3'::jsonb),
  -- Reprints of one invoice in one day.
  (NULL, 'anomaly_reprint_count', '4'::jsonb)
ON CONFLICT DO NOTHING;
