import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, requirePermission } from '../../core/http.js';
import { requirePrincipal, resolveBranch } from '../../core/principal.js';
import { DETECTORS } from './detectors.js';
import {
  anomalySummary, listAnomalies, reviewAnomaly, sweepBranch,
} from './anomalies.service.js';

export async function anomalyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/anomalies', { preHandler: requirePermission('anomalies.read') }, async (req) => {
    const principal = requirePrincipal(req);
    const q = parse(z.object({
      branchId: z.string().uuid().optional(),
      status: z.enum(['open', 'acknowledged', 'dismissed']).optional(),
      code: z.string().max(60).optional(),
      severity: z.enum(['warning', 'critical']).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }), req.query);

    return listAnomalies(principal, {
      branchId: resolveBranch(principal, q.branchId),
      status: q.status, code: q.code, severity: q.severity, limit: q.limit,
    });
  });

  app.get('/anomalies/summary', { preHandler: requirePermission('anomalies.read') },
    async (req) => {
      const principal = requirePrincipal(req);
      return anomalySummary(principal, resolveBranch(principal));
    });

  /** What the detectors look for, so the screen can explain itself. */
  app.get('/anomalies/detectors', { preHandler: requirePermission('anomalies.read') },
    async () => ({
      detectors: DETECTORS.map((d) => ({
        code: d.code, label: d.label, lookbackDays: d.lookbackDays,
      })),
    }));

  /**
   * Run the sweep now. The scheduler runs it hourly anyway; this exists
   * because a manager who has just heard something wants to look today, not
   * at the top of the next hour.
   */
  app.post('/anomalies/sweep', { preHandler: requirePermission('anomalies.review') },
    async (req) => {
      const principal = requirePrincipal(req);
      return sweepBranch(resolveBranch(principal));
    });

  app.post('/anomalies/:id/review', { preHandler: requirePermission('anomalies.review') },
    async (req) => {
      const principal = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const body = parse(z.object({
        status: z.enum(['acknowledged', 'dismissed']),
        // A dismissal without a reason is the thing this screen exists to
        // prevent, so the schema refuses one rather than the handler.
        note: z.string().max(1000).optional(),
      }).refine((b) => b.status !== 'dismissed' || (b.note ?? '').trim().length >= 3, {
        message: 'اكتب سبب الاستبعاد', path: ['note'],
      }), req.body);

      return reviewAnomaly(principal, id, body.status, (body.note ?? '').trim());
    });
}
