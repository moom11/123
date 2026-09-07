import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, pool } from '../../core/db.js';
import { parse, requirePermission } from '../../core/http.js';
import { requirePrincipal, resolveBranch } from '../../core/principal.js';

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The Notification Centre. A notification reaches a user only if they hold
   * one of its target permissions, so filtering happens in SQL rather than by
   * hiding rows in the client.
   */
  app.get('/notifications', { preHandler: requirePermission('notifications.read') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({
        branchId: z.string().uuid().optional(),
        unreadOnly: z.coerce.boolean().default(false),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }), req.query);

      const permissions = [...p.permissions];
      return {
        notifications: await many(
          `SELECT n.id, n.kind, n.severity, n.title_ar AS title, n.body_ar AS body,
                  n.entity_type, n.entity_id, n.created_at, n.metadata,
                  (nr.read_at IS NOT NULL) AS is_read
             FROM notifications n
             LEFT JOIN notification_reads nr ON nr.notification_id = n.id AND nr.user_id = $2
            WHERE (n.branch_id = $1 OR n.branch_id IS NULL)
              AND ( n.target_user_id = $2
                 OR cardinality(n.target_permissions) = 0
                 OR n.target_permissions && $3::text[] )
              AND (NOT $4::boolean OR nr.read_at IS NULL)
            ORDER BY n.created_at DESC LIMIT $5`,
          [resolveBranch(p, q.branchId), p.userId, permissions, q.unreadOnly, q.limit],
        ),
      };
    });

  app.post('/notifications/:id/read', { preHandler: requirePermission('notifications.read') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      await pool.query(
        `INSERT INTO notification_reads (notification_id, user_id) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`,
        [id, p.userId],
      );
      return { ok: true };
    });

  app.post('/notifications/read-all', { preHandler: requirePermission('notifications.read') },
    async (req) => {
      const p = requirePrincipal(req);
      const permissions = [...p.permissions];
      const res = await pool.query(
        `INSERT INTO notification_reads (notification_id, user_id)
         SELECT n.id, $1 FROM notifications n
          WHERE (n.branch_id = $2 OR n.branch_id IS NULL)
            AND ( n.target_user_id = $1 OR cardinality(n.target_permissions) = 0
               OR n.target_permissions && $3::text[] )
         ON CONFLICT DO NOTHING`,
        [p.userId, p.branchId, permissions],
      );
      return { marked: res.rowCount ?? 0 };
    });
}
