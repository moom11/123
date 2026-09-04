import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, requirePermission } from '../../core/http.js';
import { requirePrincipal, resolveBranch } from '../../core/principal.js';
import {
  listDevices, registerDevice, retireDevice, rotateDeviceToken,
} from './devices.service.js';

export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/devices', { preHandler: requirePermission('devices.read') }, async (req) => {
    const p = requirePrincipal(req);
    const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
    return { devices: await listDevices(p, resolveBranch(p, q.branchId)) };
  });

  /**
   * The token is in this response and nowhere else, ever. It is stored hashed,
   * so it cannot be shown again — losing it means rotating, not recovering.
   */
  app.post('/devices', { preHandler: requirePermission('devices.manage') }, async (req) => {
    const p = requirePrincipal(req);
    const body = parse(z.object({
      branchId: z.string().uuid().optional(),
      kind: z.enum(['cashier', 'waiter', 'kiosk', 'display']),
      label: z.string().min(2, 'اسم الجهاز مطلوب').max(80),
      serialNumber: z.string().min(2).max(40),
    }), req.body);
    return registerDevice(p, resolveBranch(p, body.branchId), body);
  });

  app.post('/devices/:id/rotate-token',
    { preHandler: requirePermission('devices.manage') }, async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      return rotateDeviceToken(p, id);
    });

  app.post('/devices/:id/retire',
    { preHandler: requirePermission('devices.manage') }, async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const { reason } = parse(
        z.object({ reason: z.string().min(3, 'اذكر سبب الإيقاف').max(300) }), req.body,
      );
      await retireDevice(p, id, reason);
      return { ok: true };
    });

  /**
   * What a terminal asks about itself on startup: am I registered, and as what?
   * Answered from the device token alone — no staff session needed, because the
   * POS asks before anyone has logged in.
   */
  app.get('/devices/me', async (req) => {
    if (!req.device) return { registered: false };
    return {
      registered: true,
      device: {
        id: req.device.id, kind: req.device.kind, label: req.device.label,
        branchId: req.device.branchId, canSettle: req.device.kind === 'cashier',
      },
    };
  });
}
