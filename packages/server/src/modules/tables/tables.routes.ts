import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, requirePermission } from '../../core/http.js';
import { requirePrincipal, resolveBranch } from '../../core/principal.js';
import {
  assignWaiter, createTable, listOpenServiceRequests, listTables, menuUrlForTable,
  mergeTables, moveTable, resolveServiceRequest, rotateQr,
} from './tables.service.js';
import { one } from '../../core/db.js';

export async function tableRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tables', { preHandler: requirePermission('tables.read') }, async (req) => {
    const p = requirePrincipal(req);
    const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
    return { tables: await listTables(resolveBranch(p, q.branchId), p) };
  });

  app.post('/tables', { preHandler: requirePermission('tables.manage') }, async (req) => {
    const p = requirePrincipal(req);
    const body = parse(z.object({
      branchId: z.string().uuid().optional(),
      tableNumber: z.string().min(1).max(20),
      displayName: z.string().nullish(),
      area: z.string().nullish(),
      seats: z.number().int().min(1).max(50).nullish(),
    }), req.body);
    return createTable(p, { ...body, branchId: resolveBranch(p, body.branchId) });
  });

  /** The QR payload and menu URL for printing a table sticker. */
  app.get('/tables/:id/qr', { preHandler: requirePermission('tables.manage') }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const t = await one<{ qr_token: string; table_number: string }>(
      'SELECT qr_token, table_number FROM restaurant_tables WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    if (!t) return { error: 'not_found' };
    return { tableNumber: t.table_number, menuUrl: menuUrlForTable(t.qr_token) };
  });

  app.post('/tables/:id/rotate-qr', { preHandler: requirePermission('tables.manage') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      return rotateQr(p, id);
    });

  app.post('/tables/:id/waiter', { preHandler: requirePermission('tables.assign_waiter') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const { employeeId } = parse(
        z.object({ employeeId: z.string().uuid().nullable() }), req.body);
      await assignWaiter(p, id, employeeId);
      return { ok: true };
    });

  app.post('/tables/move', { preHandler: requirePermission('tables.move') }, async (req) => {
    const p = requirePrincipal(req);
    const body = parse(z.object({
      fromTableId: z.string().uuid(), toTableId: z.string().uuid(),
    }), req.body);
    await moveTable(p, body.fromTableId, body.toTableId);
    return { ok: true };
  });

  app.post('/tables/merge', { preHandler: requirePermission('tables.merge') }, async (req) => {
    const p = requirePrincipal(req);
    const body = parse(z.object({
      sourceTableId: z.string().uuid(), targetTableId: z.string().uuid(),
    }), req.body);
    await mergeTables(p, body.sourceTableId, body.targetTableId);
    return { ok: true };
  });

  app.get('/service-requests', { preHandler: requirePermission('service.requests.read') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
      return { requests: await listOpenServiceRequests(resolveBranch(p, q.branchId), p) };
    });

  app.post('/service-requests/:id/resolve', {
    preHandler: requirePermission('service.requests.resolve'),
  }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    await resolveServiceRequest(p, id);
    return { ok: true };
  });
}
