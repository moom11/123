import { pool } from '../core/db.js';
import { config } from '../core/config.js';
import { notify } from '../core/notify.js';
import { EVENTS, publish } from '../core/realtime.js';
import { purgeExpiredOtps } from '../modules/customers/otp.service.js';

/**
 * Periodic housekeeping. Deliberately small and idempotent — each tick does
 * work that is safe to repeat, so a restart mid-cycle costs nothing.
 */

type Logger = { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };

let timers: NodeJS.Timeout[] = [];

export function startBackgroundJobs(log: Logger): void {
  stopBackgroundJobs();

  // Reclaim print jobs whose agent died holding the lease.
  timers.push(setInterval(() => {
    void reclaimStalePrintJobs(log);
  }, 30_000));

  // Flag print agents that have gone quiet, and queues that are backing up.
  timers.push(setInterval(() => {
    void checkPrintHealth(log);
  }, 60_000));

  // Expired OTP rows are useless; clear them out daily.
  timers.push(setInterval(() => {
    void purgeExpiredOtps(30).catch((err) => log.error({ err }, 'otp purge failed'));
  }, 24 * 60 * 60_000));

  // Close sessions that have aged out.
  timers.push(setInterval(() => {
    void pool.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'expired'
        WHERE revoked_at IS NULL AND expires_at < now()`,
    ).catch((err) => log.error({ err }, 'session sweep failed'));
  }, 15 * 60_000));

  log.info({ jobs: timers.length }, 'background jobs started');
}

export function stopBackgroundJobs(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
}

async function reclaimStalePrintJobs(log: Logger): Promise<void> {
  try {
    const res = await pool.query(
      `UPDATE print_jobs
          SET status = 'queued', claimed_by_agent_id = NULL, claimed_at = NULL,
              lease_expires_at = NULL
        WHERE status = 'claimed' AND lease_expires_at < now()`,
    );
    if ((res.rowCount ?? 0) > 0) {
      log.info({ reclaimed: res.rowCount }, 'reclaimed stale print jobs');
    }
  } catch (err) {
    log.error({ err }, 'print job reclaim failed');
  }
}

async function checkPrintHealth(log: Logger): Promise<void> {
  try {
    // An agent that has stopped calling home means the branch is printing
    // nothing at all — that is a critical, not an informational, condition.
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

    // A queue that is not draining.
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
  } catch (err) {
    log.error({ err }, 'print health check failed');
  }
}
