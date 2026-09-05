import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, pool } from '../../core/db.js';
import { hashSecret, generateToken, hashToken, verifySecret } from '../../core/crypto.js';
import { parse, requirePermission } from '../../core/http.js';
import { requirePrincipal, resolveBranch } from '../../core/principal.js';
import { unauthorized } from '../../core/errors.js';
import { audit, AUDIT } from '../../core/audit.js';
import {
  agentHeartbeat, claimJobs, queueHealth, reportJobResult, reprintJob, retryJob,
} from './printing.service.js';

/**
 * Print agent authentication.
 *
 * Agents present a bearer token. Tokens are stored as a SHA-256 lookup hash
 * plus an Argon2id verifier, so the lookup is a single indexed query and the
 * stored material is useless if the database leaks.
 */
async function authenticateAgent(req: { headers: Record<string, unknown> }): Promise<{
  id: string; branch_id: string;
}> {
  const header = req.headers.authorization as string | undefined;
  if (!header?.startsWith('Bearer ')) throw unauthorized('print agent token required');
  const token = header.slice(7).trim();

  const agent = await one<{ id: string; branch_id: string; token_hash: string; is_enabled: boolean }>(
    'SELECT id, branch_id, token_hash, is_enabled FROM print_agents WHERE token_hash = $1',
    [hashToken(token)],
  );
  if (!agent || !agent.is_enabled) throw unauthorized('print agent not recognised');
  return agent;
}

export async function printingRoutes(app: FastifyInstance): Promise<void> {
  // --- Management -----------------------------------------------------------
  app.get('/printers', { preHandler: requirePermission('printers.read') }, async (req) => {
    const p = requirePrincipal(req);
    const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
    return queueHealth(resolveBranch(p, q.branchId));
  });

  app.post('/printers', { preHandler: requirePermission('printers.manage') }, async (req) => {
    const p = requirePrincipal(req);
    const body = parse(z.object({
      id: z.string().uuid().nullish(),
      branchId: z.string().uuid().optional(),
      name: z.string().min(1).max(100),
      department: z.enum(['BAR', 'KITCHEN', 'SHISHA', 'OTHER', 'CASHIER']),
      ipAddress: z.string().ip(),
      port: z.number().int().min(1).max(65535).default(9100),
      codepage: z.string().default('cp864'),
      charsPerLine: z.number().int().min(24).max(96).default(42),
      isEnabled: z.boolean().default(true),
      fallbackPrinterId: z.string().uuid().nullish(),
    }), req.body);
    const branchId = resolveBranch(p, body.branchId);

    if (body.id) {
      await pool.query(
        `UPDATE printers SET name = $2, department = $3, ip_address = $4, port = $5,
                codepage = $6, chars_per_line = $7, is_enabled = $8, fallback_printer_id = $9
          WHERE id = $1`,
        [
          body.id, body.name, body.department, body.ipAddress, body.port,
          body.codepage, body.charsPerLine, body.isEnabled, body.fallbackPrinterId ?? null,
        ],
      );
      await audit({
        action: 'printer.updated', actorUserId: p.userId, actorLabel: p.displayName,
        branchId, entityType: 'printer', entityId: body.id, newValue: body,
      });
      return { id: body.id };
    }

    const created = await one<{ id: string }>(
      `INSERT INTO printers (branch_id, name, department, ip_address, port, codepage,
         chars_per_line, is_enabled, fallback_printer_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        branchId, body.name, body.department, body.ipAddress, body.port,
        body.codepage, body.charsPerLine, body.isEnabled,
        body.fallbackPrinterId ?? null, p.userId,
      ],
    );
    await audit({
      action: 'printer.created', actorUserId: p.userId, actorLabel: p.displayName,
      branchId, entityType: 'printer', entityId: created!.id, newValue: body,
    });
    return { id: created!.id };
  });

  /** Mint a print-agent token. Shown once — it is never recoverable. */
  app.post('/print-agents', { preHandler: requirePermission('printers.manage') },
    async (req) => {
      const p = requirePrincipal(req);
      const body = parse(z.object({
        branchId: z.string().uuid().optional(),
        name: z.string().min(1).max(100),
      }), req.body);
      const branchId = resolveBranch(p, body.branchId);
      const token = generateToken(32);

      const agent = await one<{ id: string }>(
        'INSERT INTO print_agents (branch_id, name, token_hash, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
        [branchId, body.name, hashToken(token), p.userId],
      );
      await audit({
        action: 'print_agent.created', actorUserId: p.userId, actorLabel: p.displayName,
        branchId, entityType: 'print_agent', entityId: agent!.id,
        newValue: { name: body.name },
      });
      return { id: agent!.id, token, note: 'احفظ هذا الرمز الآن — لن يظهر مرة أخرى' };
    });

  app.get('/print-jobs', { preHandler: requirePermission('print_jobs.read') }, async (req) => {
    const p = requirePrincipal(req);
    const q = parse(z.object({
      branchId: z.string().uuid().optional(),
      status: z.string().optional(),
      orderId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }), req.query);
    return {
      jobs: await many(
        `SELECT pj.id, pj.kind, pj.status, pj.attempt_count, pj.last_error,
                pj.created_at, pj.printed_at, pj.is_reprint, pj.reprint_reason,
                pr.name AS printer_name, pr.department, o.order_number,
                COALESCE(e.full_name, u.full_name) AS requested_by
           FROM print_jobs pj
           JOIN printers pr ON pr.id = pj.printer_id
           LEFT JOIN orders o ON o.id = pj.order_id
           LEFT JOIN employees e ON e.id = pj.requested_by_employee_id
           LEFT JOIN users u ON u.id = pj.requested_by_user_id
          WHERE pj.branch_id = $1
            AND ($2::text IS NULL OR pj.status = $2)
            AND ($3::uuid IS NULL OR pj.order_id = $3)
          ORDER BY pj.created_at DESC LIMIT $4`,
        [resolveBranch(p, q.branchId), q.status ?? null, q.orderId ?? null, q.limit],
      ),
    };
  });

  app.post('/print-jobs/:id/reprint', { preHandler: requirePermission('orders.reprint') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const { reason } = parse(z.object({ reason: z.string().min(1).max(300) }), req.body);
      return reprintJob(p, id, reason);
    });

  app.post('/print-jobs/:id/retry', { preHandler: requirePermission('print_jobs.retry') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      await retryJob(p, id);
      return { ok: true };
    });

  // --- Agent protocol (token auth, no staff session) ------------------------
  app.post('/print-agent/claim', {
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
  }, async (req) => {
    const agent = await authenticateAgent(req as never);
    const { limit } = parse(
      z.object({ limit: z.number().int().min(1).max(25).default(10) }),
      req.body ?? {},
    );
    return { jobs: await claimJobs(agent.id, agent.branch_id, limit) };
  });

  app.post('/print-agent/result', async (req) => {
    const agent = await authenticateAgent(req as never);
    const body = parse(z.object({
      jobId: z.string().uuid(),
      success: z.boolean(),
      error: z.string().max(500).optional(),
    }), req.body);
    await reportJobResult(agent.id, body.jobId, body.success, body.error);
    return { ok: true };
  });

  app.post('/print-agent/heartbeat', {
    config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
  }, async (req) => {
    const agent = await authenticateAgent(req as never);
    const body = parse(z.object({
      version: z.string().max(30).optional(),
      ip: z.string().optional(),
      printers: z.array(z.object({
        id: z.string().uuid(),
        reachable: z.boolean(),
        message: z.string().max(300).optional(),
      })).optional(),
    }), req.body ?? {});
    await agentHeartbeat(agent.id, body);

    const printers = await many(
      `SELECT id, name, department, host(ip_address) AS ip, port, protocol,
              codepage, chars_per_line
         FROM printers WHERE branch_id = $1 AND is_enabled AND deleted_at IS NULL`,
      [agent.branch_id],
    );
    return { ok: true, printers };
  });
}
