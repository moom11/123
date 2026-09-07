import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one } from '../../core/db.js';
import { parse, requirePermission } from '../../core/http.js';
import { requirePrincipal, resolveBranch } from '../../core/principal.js';

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The audit log is readable but never writable or erasable through the API —
   * there is deliberately no POST, PATCH or DELETE route here.
   */
  app.get('/audit', { preHandler: requirePermission('audit.read') }, async (req) => {
    const p = requirePrincipal(req);
    const q = parse(z.object({
      branchId: z.string().uuid().optional(),
      action: z.string().optional(),
      actionPrefix: z.string().optional(),
      entityType: z.string().optional(),
      entityId: z.string().optional(),
      actorUserId: z.string().uuid().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
    }), req.query);

    const entries = await many(
      `SELECT a.id, a.occurred_at, a.action, a.actor_label, a.actor_kind,
              a.entity_type, a.entity_id, a.old_value, a.new_value, a.metadata,
              host(a.ip) AS ip, a.user_agent,
              u.full_name AS user_name, e.full_name AS employee_name,
              e.employee_code, b.name_ar AS branch_name
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_user_id
         LEFT JOIN employees e ON e.id = a.actor_employee_id
         LEFT JOIN branches b ON b.id = a.branch_id
        WHERE ($1::uuid IS NULL OR a.branch_id = $1)
          AND ($2::text IS NULL OR a.action = $2)
          AND ($3::text IS NULL OR a.action LIKE $3 || '%')
          AND ($4::text IS NULL OR a.entity_type = $4)
          AND ($5::text IS NULL OR a.entity_id = $5)
          AND ($6::uuid IS NULL OR a.actor_user_id = $6)
          AND ($7::timestamptz IS NULL OR a.occurred_at >= $7)
          AND ($8::timestamptz IS NULL OR a.occurred_at <= $8)
        ORDER BY a.occurred_at DESC
        LIMIT $9 OFFSET $10`,
      [
        resolveBranch(p, q.branchId), q.action ?? null, q.actionPrefix ?? null,
        q.entityType ?? null, q.entityId ?? null, q.actorUserId ?? null,
        q.from ?? null, q.to ?? null, q.limit, q.offset,
      ],
    );

    const total = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs a
        WHERE ($1::uuid IS NULL OR a.branch_id = $1)
          AND ($2::text IS NULL OR a.action = $2)
          AND ($3::text IS NULL OR a.action LIKE $3 || '%')`,
      [resolveBranch(p, q.branchId), q.action ?? null, q.actionPrefix ?? null],
    );

    return { entries, total: total?.n ?? 0, limit: q.limit, offset: q.offset };
  });

  /** Everything that ever happened to one entity, in order. */
  app.get('/audit/entity/:type/:id', { preHandler: requirePermission('audit.read') },
    async (req) => {
      const params = parse(z.object({
        type: z.string().min(2).max(50), id: z.string().min(1).max(100),
      }), req.params);
      return {
        entries: await many(
          `SELECT a.occurred_at, a.action, a.actor_label, a.actor_kind,
                  a.old_value, a.new_value, a.metadata
             FROM audit_logs a
            WHERE a.entity_type = $1 AND a.entity_id = $2
            ORDER BY a.occurred_at`,
          [params.type, params.id],
        ),
      };
    });

  /** Rolled-up activity by action, for the risk panel. */
  app.get('/audit/summary', { preHandler: requirePermission('audit.read') }, async (req) => {
    const p = requirePrincipal(req);
    const q = parse(z.object({
      branchId: z.string().uuid().optional(),
      days: z.coerce.number().int().min(1).max(90).default(7),
    }), req.query);
    return {
      summary: await many(
        `SELECT action, count(*)::int AS count, max(occurred_at) AS last_at
           FROM audit_logs
          WHERE branch_id = $1 AND occurred_at > now() - ($2 || ' days')::interval
          GROUP BY action ORDER BY count DESC`,
        [resolveBranch(p, q.branchId), String(q.days)],
      ),
    };
  });
}
