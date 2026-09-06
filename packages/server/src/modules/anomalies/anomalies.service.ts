/**
 * Running the detectors, and what happens to what they find.
 *
 * The sweep is idempotent by construction: every detector re-derives its claim
 * from the underlying rows each time, and a claim about the same subject in the
 * same period updates one row instead of raising a second alarm. This is the
 * difference between a screen a manager reads and a screen a manager mutes.
 *
 * Nothing here blocks, reverses, or accuses. A finding is a question with the
 * evidence attached; the answer is a person's, and it is recorded with their
 * name on it.
 */
import { many, one, pool } from '../../core/db.js';
import { notFound } from '../../core/errors.js';
import { AUDIT, audit } from '../../core/audit.js';
import { notify } from '../../core/notify.js';
import type { Principal } from '../../core/principal.js';
import { assertBranchAccess } from '../../core/principal.js';
import { DETECTORS, type Detector, type Finding, type Thresholds } from './detectors.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Thresholds for a branch: its own overrides on top of the defaults that ship
 * with the migration. A value that is not a number is ignored rather than
 * coerced — a detector reading NaN would silently stop detecting.
 */
export async function thresholdsFor(branchId: string): Promise<Thresholds> {
  const rows = await many<{ key: string; value: unknown; branch_id: string | null }>(
    `SELECT key, value, branch_id FROM settings
      WHERE branch_id IS NULL OR branch_id = $1
      -- Branch-specific last, so it overwrites the global default below.
      ORDER BY branch_id NULLS FIRST`,
    [branchId],
  );
  const out: Record<string, number> = {};
  for (const row of rows) {
    const n = Number(row.value);
    if (Number.isFinite(n)) out[row.key] = n;
  }
  return out;
}

export interface SweepResult {
  branchId: string;
  findings: number;
  opened: number;
  byCode: Record<string, number>;
}

/** Run every detector against one branch and record what they find. */
export async function sweepBranch(branchId: string, now = new Date()): Promise<SweepResult> {
  const branch = await one<{ timezone: string | null; name_ar: string }>(
    'SELECT timezone, name_ar FROM branches WHERE id = $1', [branchId],
  );
  if (!branch) throw notFound('الفرع غير موجود');
  const timeZone = branch.timezone ?? 'Asia/Riyadh';
  const thresholds = await thresholdsFor(branchId);

  const result: SweepResult = { branchId, findings: 0, opened: 0, byCode: {} };

  for (const detector of DETECTORS as readonly Detector[]) {
    const since = new Date(now.getTime() - detector.lookbackDays * DAY_MS);
    let findings: Finding[];
    try {
      // Not every detector groups by local day, and Postgres rejects a bind
      // with more parameters than the statement uses. Derived from the query
      // itself rather than declared beside it, so the two cannot drift.
      const params: unknown[] = detector.sql.includes('$3')
        ? [branchId, since, timeZone]
        : [branchId, since];
      const rows = await many<Record<string, unknown>>(detector.sql, params);
      findings = detector.judge(rows as never[], thresholds);
    } catch (err) {
      // One broken detector must not stop the other seven. A sweep that
      // half-runs and says so beats a sweep that throws and leaves the branch
      // with no findings at all.
      await audit({
        action: AUDIT.ANOMALY_SWEEP, branchId,
        metadata: { detector: detector.code, error: (err as Error).message },
      });
      continue;
    }

    for (const finding of findings) {
      const opened = await record(branchId, finding);
      result.findings += 1;
      if (opened) result.opened += 1;
      result.byCode[finding.code] = (result.byCode[finding.code] ?? 0) + 1;
    }
  }

  await audit({
    action: AUDIT.ANOMALY_SWEEP, branchId,
    metadata: { findings: result.findings, opened: result.opened, byCode: result.byCode },
  });
  return result;
}

/** Every active branch. Used by the scheduler. */
export async function sweepAllBranches(now = new Date()): Promise<SweepResult[]> {
  const branches = await many<{ id: string }>(
    'SELECT id FROM branches WHERE is_active AND deleted_at IS NULL',
  );
  const results: SweepResult[] = [];
  for (const branch of branches) results.push(await sweepBranch(branch.id, now));
  return results;
}

/**
 * Store one finding.
 *
 * Returns true only when the finding is new, which is also the only time
 * anyone is notified. A finding already on the screen with a rising detection
 * count does not need to interrupt anybody again — that is how an alert
 * channel becomes noise, and a muted channel catches nothing.
 *
 * A dismissed finding stays dismissed even as its evidence grows. The manager
 * answered the question; the count beside it is what tells them the answer may
 * have been wrong.
 */
async function record(branchId: string, f: Finding): Promise<boolean> {
  const row = await one<{ id: string; inserted: boolean }>(
    `INSERT INTO anomalies
       (branch_id, code, severity, subject_type, subject_id, subject_label,
        period_key, title_ar, detail_ar, metric, threshold, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (branch_id, code, period_key,
                  COALESCE(subject_id, '00000000-0000-0000-0000-000000000000'::uuid))
     DO UPDATE SET
       last_detected_at = now(),
       detections       = anomalies.detections + 1,
       severity         = EXCLUDED.severity,
       subject_label    = EXCLUDED.subject_label,
       title_ar         = EXCLUDED.title_ar,
       detail_ar        = EXCLUDED.detail_ar,
       metric           = EXCLUDED.metric,
       threshold        = EXCLUDED.threshold,
       evidence         = EXCLUDED.evidence
     RETURNING id, (xmax = 0) AS inserted`,
    [
      branchId, f.code, f.severity, f.subjectType, f.subjectId, f.subjectLabel,
      f.periodKey, f.title, f.detail, f.metric, f.threshold,
      JSON.stringify(f.evidence),
    ],
  );
  if (!row?.inserted) return false;

  await notify({
    branchId,
    kind: `anomaly_${f.code}`,
    severity: f.severity,
    title: f.title,
    body: f.detail,
    entityType: 'anomaly',
    entityId: row.id,
    // Deliberately not notifications.read: this is a screen for whoever is
    // accountable for the money, not for everyone holding a terminal.
    targetPermissions: ['anomalies.read'],
    metadata: { code: f.code, metric: f.metric, threshold: f.threshold },
  });
  return true;
}

// --- Reading and answering ---------------------------------------------------

export interface AnomalyFilters {
  branchId: string;
  status?: 'open' | 'acknowledged' | 'dismissed';
  code?: string;
  severity?: 'warning' | 'critical';
  limit?: number;
}

export async function listAnomalies(principal: Principal, filters: AnomalyFilters) {
  assertBranchAccess(principal, filters.branchId);
  const rows = await many(
    `SELECT a.id, a.code, a.severity, a.subject_type, a.subject_id, a.subject_label,
            a.period_key, a.title_ar, a.detail_ar, a.metric, a.threshold, a.evidence,
            a.status, a.detections, a.first_detected_at, a.last_detected_at,
            a.reviewed_at, a.review_note, u.full_name AS reviewed_by
       FROM anomalies a
       LEFT JOIN users u ON u.id = a.reviewed_by_user_id
      WHERE a.branch_id = $1
        AND ($2::text IS NULL OR a.status = $2)
        AND ($3::text IS NULL OR a.code = $3)
        AND ($4::text IS NULL OR a.severity = $4)
      ORDER BY (a.status = 'open') DESC,
               (a.severity = 'critical') DESC,
               a.last_detected_at DESC
      LIMIT $5`,
    [
      filters.branchId, filters.status ?? null, filters.code ?? null,
      filters.severity ?? null, Math.min(filters.limit ?? 100, 500),
    ],
  );
  return { anomalies: rows };
}

/** Counts for the dashboard badge, cheap enough to poll. */
export async function anomalySummary(principal: Principal, branchId: string) {
  assertBranchAccess(principal, branchId);
  const row = await one<{ open: string; critical: string; today: string }>(
    `SELECT count(*) FILTER (WHERE status = 'open')                    AS open,
            count(*) FILTER (WHERE status = 'open'
                             AND severity = 'critical')                AS critical,
            count(*) FILTER (WHERE first_detected_at > now() - interval '24 hours')
                                                                       AS today
       FROM anomalies WHERE branch_id = $1`,
    [branchId],
  );
  return {
    open: Number(row?.open ?? 0),
    critical: Number(row?.critical ?? 0),
    today: Number(row?.today ?? 0),
  };
}

/**
 * A manager's answer to a finding.
 *
 * Dismissal requires a reason, and the reason is kept with the name of whoever
 * gave it. That is the whole value of the screen: not that it finds things,
 * but that "we looked at this and it was fine" is a statement someone made
 * rather than a thing that quietly happened.
 */
export async function reviewAnomaly(
  principal: Principal,
  id: string,
  status: 'acknowledged' | 'dismissed',
  note: string,
) {
  const existing = await one<{
    id: string; branch_id: string; code: string; status: string; subject_label: string;
  }>('SELECT id, branch_id, code, status, subject_label FROM anomalies WHERE id = $1', [id]);
  if (!existing) throw notFound('الملاحظة غير موجودة');
  assertBranchAccess(principal, existing.branch_id);

  await pool.query(
    `UPDATE anomalies
        SET status = $2, review_note = $3, reviewed_at = now(), reviewed_by_user_id = $4
      WHERE id = $1`,
    [id, status, note, principal.userId ?? null],
  );

  await audit({
    action: status === 'dismissed' ? AUDIT.ANOMALY_DISMISSED : AUDIT.ANOMALY_ACKNOWLEDGED,
    actorUserId: principal.userId ?? null,
    actorEmployeeId: principal.employeeId ?? null,
    actorLabel: principal.displayName,
    branchId: existing.branch_id,
    entityType: 'anomaly',
    entityId: id,
    oldValue: { status: existing.status },
    newValue: { status, note },
    metadata: { code: existing.code, subject: existing.subject_label },
  });

  return { ok: true, status };
}
