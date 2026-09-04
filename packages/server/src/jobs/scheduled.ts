import { pool } from '../core/db.js';
import { config } from '../core/config.js';
import { notify } from '../core/notify.js';
import { EVENTS, publish } from '../core/realtime.js';
import { purgeExpiredOtps } from '../modules/customers/otp.service.js';

/**
 * The same housekeeping as jobs/index.ts, shaped for cron triggers.
 *
 * A Worker has no process to hold a `setInterval`, so instead each cron
 * expression selects which work to do. Every task is idempotent, so a missed or
 * repeated firing costs nothing.
 */
export async function runScheduledMaintenance(cron: string): Promise<void> {
  // Every minute: the two things whose staleness the floor notices.
  await reclaimStalePrintJobs();
  await checkPrintHealth();

  // Quarter past the hour: sweep expired sessions.
  if (cron.startsWith('15 ') || cron === '*/15 * * * *') {
    await sweepExpiredSessions();
  }

  // Daily: expired one-time codes are useless.
  if (cron.startsWith('0 3 ')) {
    await purgeExpiredOtps(30);
  }

  // Every quarter hour: push invoices to ZATCA. The deadline is 24 hours, so
  // this is deliberately unhurried — but it must run often enough that a
  // transient outage does not eat the whole window before anyone notices.
  if (cron.startsWith('15 ') || cron === '*/15 * * * *' || cron.startsWith('0 ')) {
    await reportInvoices();
  }
}

/**
 * Drain each branch's reporting queue.
 *
 * Per branch rather than globally: credentials are per branch, and one branch
 * whose CSID has expired must not stop another branch's invoices from being
 * reported.
 */
async function reportInvoices(): Promise<void> {
  const { many } = await import('../core/db.js');
  const { reportPending } = await import('../modules/invoicing/invoicing.service.js');

  const branches = await many<{ branch_id: string }>(
    `SELECT DISTINCT branch_id FROM invoices
      WHERE report_status IN ('pending','failed') AND report_attempts < 10`,
  );

  for (const { branch_id: branchId } of branches) {
    try {
      const result = await reportPending(branchId, 100);
      if (result.failed > 0) {
        console.warn(`[zatca] branch ${branchId}: ${result.reported} reported, ${result.failed} failed`);
      }
    } catch (err) {
      console.error(`[zatca] branch ${branchId} reporting run failed`, err);
    }
  }

  // Past the deadline is no longer a queue, it is a compliance breach, and it
  // needs a human rather than another retry.
  const { one } = await import('../core/db.js');
  const overdue = await one<{ n: string; branch_id: string }>(
    `SELECT count(*)::text AS n, min(branch_id::text) AS branch_id FROM invoices
      WHERE report_status IN ('pending','failed')
        AND issued_at < now() - interval '20 hours'`,
  );
  if (Number(overdue?.n ?? 0) > 0) {
    const { notify } = await import('../core/notify.js');
    await notify({
      branchId: overdue!.branch_id, kind: 'invoices_unreported', severity: 'critical',
      title: 'فواتير لم تُبلَّغ للهيئة',
      body: `${overdue!.n} فاتورة مضى عليها أكثر من 20 ساعة دون إبلاغ — المهلة 24 ساعة.`,
      targetPermissions: ['invoices.report'],
    });
  }
}

async function reclaimStalePrintJobs(): Promise<void> {
  // A job whose agent died holding the lease returns to the queue rather than
  // being stranded in 'claimed' forever.
  await pool.query(
    `UPDATE print_jobs
        SET status = 'queued', claimed_by_agent_id = NULL, claimed_at = NULL,
            lease_expires_at = NULL
      WHERE status = 'claimed' AND lease_expires_at < now()`,
  );
}

async function sweepExpiredSessions(): Promise<void> {
  await pool.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = 'expired'
      WHERE revoked_at IS NULL AND expires_at < now()`,
  );
}

async function checkPrintHealth(): Promise<void> {
  const offline = await pool.query<{ id: string; name: string; branch_id: string }>(
    `SELECT id, name, branch_id FROM print_agents
      WHERE is_enabled
        AND (last_seen_at IS NULL OR last_seen_at < now() - ($1 || ' seconds')::interval)`,
    [String(config.printing.agentOfflineSeconds)],
  );

  for (const agent of offline.rows) {
    const recent = await pool.query(
      `SELECT 1 FROM notifications
        WHERE kind = 'print_agent_offline' AND entity_id = $1
          AND created_at > now() - interval '30 minutes' LIMIT 1`,
      [agent.id],
    );
    if (recent.rowCount) continue;

    await notify({
      branchId: agent.branch_id, kind: 'print_agent_offline', severity: 'critical',
      title: 'وكيل الطباعة غير متصل',
      body: `${agent.name} لم يتصل بالنظام منذ فترة — قد تتوقف الطباعة.`,
      entityType: 'print_agent', entityId: agent.id,
      targetPermissions: ['printers.manage', 'print_jobs.read', 'pos.use'],
    });
  }

  const stuck = await pool.query<{ branch_id: string; n: number; oldest: Date }>(
    `SELECT branch_id, count(*)::int AS n, MIN(created_at) AS oldest
       FROM print_jobs
      WHERE status IN ('queued', 'claimed') AND created_at < now() - interval '5 minutes'
      GROUP BY branch_id`,
  );

  for (const row of stuck.rows) {
    publish({
      type: EVENTS.PRINT_QUEUE_STUCK, branchId: row.branch_id,
      requiredPermissions: ['print_jobs.read', 'pos.use'],
      payload: { pending: row.n, oldest: row.oldest },
    });

    const recent = await pool.query(
      `SELECT 1 FROM notifications
        WHERE kind = 'print_queue_stuck' AND branch_id = $1
          AND created_at > now() - interval '15 minutes' LIMIT 1`,
      [row.branch_id],
    );
    if (recent.rowCount) continue;

    await notify({
      branchId: row.branch_id, kind: 'print_queue_stuck', severity: 'critical',
      title: 'طابور الطباعة متوقف',
      body: `${row.n} أمر طباعة معلّق منذ أكثر من 5 دقائق.`,
      targetPermissions: ['print_jobs.read', 'printers.manage', 'pos.use'],
    });
  }
}
