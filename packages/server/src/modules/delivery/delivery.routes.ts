import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, requirePermission } from '../../core/http.js';
import { requirePrincipal, resolveBranch } from '../../core/principal.js';
import { knownPartners } from './adapters/index.js';
import {
  acceptDeliveryOrder, handleWebhook, listFailedEvents, listOpenDeliveries,
  listPartners, mapMenuItem, markReady, rejectDeliveryOrder, replayEvent,
  savePartner,
} from './delivery.service.js';

/**
 * The inbound half is public and unauthenticated by necessity — an aggregator
 * cannot hold a staff session. Its security is the HMAC signature, and the
 * handler treats every payload as hostile until that verifies.
 */
export async function deliveryWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/:partner/:branchCode?', {
    config: {
      // Generous: a busy Friday sends real bursts, and throttling a platform
      // means losing orders. The dedupe, not the limiter, is what protects us.
      rateLimit: { max: 600, timeWindow: '1 minute' },
      // The raw body is what the signature covers. Re-serialising a parsed
      // object changes key order and whitespace, and nothing verifies again.
      rawBody: true,
    },
  }, async (req, reply) => {
    const params = parse(z.object({
      partner: z.string().min(2).max(40),
      branchCode: z.string().max(40).optional(),
    }), req.params);

    const raw = typeof (req as { rawBody?: string }).rawBody === 'string'
      ? (req as { rawBody?: string }).rawBody!
      : JSON.stringify(req.body ?? {});

    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }

    const result = await handleWebhook(
      params.partner, params.branchCode ?? null, raw, headers,
    );

    // A platform that receives a 5xx retries forever, so an order we cannot
    // map is still acknowledged: it is stored, a human has been alerted, and
    // retrying would not change the outcome. Only a bad signature is refused.
    if (result.status === 'rejected' && result.message === 'توقيع غير صالح') {
      return reply.status(401).send({ error: { code: 'bad_signature' } });
    }
    return reply.status(200).send({
      received: true, status: result.status,
      orderNumber: result.orderNumber, message: result.message,
    });
  });
}

export async function deliveryRoutes(app: FastifyInstance): Promise<void> {
  /** The platforms an adapter exists for, for the setup screen. */
  app.get('/delivery/platforms',
    { preHandler: requirePermission('delivery.read') },
    async () => ({ platforms: knownPartners() }));

  app.get('/delivery/partners',
    { preHandler: requirePermission('delivery.read') }, async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
      return { partners: await listPartners(p, resolveBranch(p, q.branchId)) };
    });

  app.post('/delivery/partners',
    { preHandler: requirePermission('delivery.manage') }, async (req) => {
      const p = requirePrincipal(req);
      const body = parse(z.object({
        branchId: z.string().uuid().optional(),
        code: z.string().min(2).max(40),
        nameAr: z.string().max(80).optional(),
        isEnabled: z.boolean().optional(),
        prepaid: z.boolean().optional(),
        commissionBps: z.number().int().min(0).max(10_000).optional(),
        autoAccept: z.boolean().optional(),
        prepMinutes: z.number().int().min(1).max(240).optional(),
        apiBaseUrl: z.string().url().nullish(),
        // Absent means "leave what is stored" — saving the form without
        // retyping a secret must not wipe it.
        webhookSecret: z.string().min(8).nullish(),
        apiCredentials: z.record(z.string()).nullish(),
      }), req.body);
      return savePartner(p, resolveBranch(p, body.branchId), body);
    });

  app.post('/delivery/partners/:id/menu-map',
    { preHandler: requirePermission('delivery.manage') }, async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const body = parse(z.object({
        externalId: z.string().min(1).max(120),
        externalName: z.string().max(200).nullish(),
        productId: z.string().uuid().nullish(),
        modifierOptionId: z.string().uuid().nullish(),
      }), req.body);
      await mapMenuItem(p, id, body);
      return { ok: true };
    });

  /** The live board: what is waiting, cooking and ready. */
  app.get('/delivery/orders',
    { preHandler: requirePermission('delivery.read') }, async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
      return { orders: await listOpenDeliveries(p, resolveBranch(p, q.branchId)) };
    });

  app.post('/delivery/orders/:orderId/accept',
    { preHandler: requirePermission('delivery.accept') }, async (req) => {
      const p = requirePrincipal(req);
      const { orderId } = parse(z.object({ orderId: z.string().uuid() }), req.params);
      return acceptDeliveryOrder(p, orderId);
    });

  app.post('/delivery/orders/:orderId/reject',
    { preHandler: requirePermission('delivery.accept') }, async (req) => {
      const p = requirePrincipal(req);
      const { orderId } = parse(z.object({ orderId: z.string().uuid() }), req.params);
      const { reason } = parse(z.object({
        reason: z.string().min(3, 'اذكر سبب الرفض — يصل للمنصة وللعميل').max(300),
      }), req.body);
      return rejectDeliveryOrder(p, orderId, reason);
    });

  app.post('/delivery/orders/:orderId/ready',
    { preHandler: requirePermission('delivery.accept') }, async (req) => {
      const p = requirePrincipal(req);
      const { orderId } = parse(z.object({ orderId: z.string().uuid() }), req.params);
      return markReady(p, orderId);
    });

  /** Orders that arrived but could not be turned into orders, and why. */
  app.get('/delivery/failed',
    { preHandler: requirePermission('delivery.read') }, async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
      return { events: await listFailedEvents(p, resolveBranch(p, q.branchId)) };
    });

  app.post('/delivery/failed/:id/replay',
    { preHandler: requirePermission('delivery.manage') }, async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      return replayEvent(p, id);
    });
}
