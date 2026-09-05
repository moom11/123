import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, requirePermission } from '../../core/http.js';
import { requirePrincipal, resolveBranch } from '../../core/principal.js';
import {
  listPromotions, previewPromotion, promotionReport, retirePromotion, savePromotion,
} from './promotions.service.js';

const promotionSchema = z.object({
  branchId: z.string().uuid().optional(),
  nameAr: z.string().min(2, 'اسم العرض مطلوب').max(120),
  descriptionAr: z.string().max(500).nullish(),
  kind: z.enum(['percent', 'amount', 'item_price', 'buy_x_get_y', 'combo']),
  // Basis points for percent, halalas otherwise — one field, because a
  // promotion has exactly one magnitude.
  value: z.number().int().min(0),
  buyQuantity: z.number().int().min(1).max(99).nullish(),
  getQuantity: z.number().int().min(1).max(99).nullish(),
  startsAt: z.string().nullish(),
  endsAt: z.string().nullish(),
  daysOfWeek: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  dailyStartMinute: z.number().int().min(0).max(1439).nullish(),
  dailyEndMinute: z.number().int().min(0).max(1439).nullish(),
  appliesToOrderTypes: z.array(z.enum(['dine_in', 'takeaway', 'delivery'])).optional(),
  appliesToSources: z.array(z.enum(['pos', 'customer_qr', 'waiter', 'delivery'])).optional(),
  minBasket: z.number().int().min(0).optional(),
  maxDiscount: z.number().int().min(0).optional(),
  usageLimit: z.number().int().min(1).nullish(),
  usagePerCustomer: z.number().int().min(1).nullish(),
  priority: z.number().int().min(0).max(1000).optional(),
  isStackable: z.boolean().optional(),
  isActive: z.boolean().optional(),
  code: z.string().max(40).nullish(),
  productIds: z.array(z.string().uuid()).max(200).optional(),
  categoryIds: z.array(z.string().uuid()).max(50).optional(),
  comboQuantities: z.record(z.number().int().min(1).max(99)).optional(),
});

export async function promotionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/promotions', { preHandler: requirePermission('promotions.read') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
      return { promotions: await listPromotions(p, resolveBranch(p, q.branchId)) };
    });

  app.post('/promotions', { preHandler: requirePermission('promotions.manage') },
    async (req) => {
      const p = requirePrincipal(req);
      const body = parse(promotionSchema, req.body);
      return savePromotion(p, resolveBranch(p, body.branchId), body);
    });

  app.put('/promotions/:id', { preHandler: requirePermission('promotions.manage') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const body = parse(promotionSchema, req.body);
      return savePromotion(p, resolveBranch(p, body.branchId), body, id);
    });

  app.post('/promotions/:id/retire',
    { preHandler: requirePermission('promotions.manage') }, async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      await retirePromotion(p, id);
      return { ok: true };
    });

  /** What each campaign has actually cost — the number that decides its fate. */
  app.get('/reports/promotions',
    { preHandler: requirePermission('promotions.read') }, async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({
        branchId: z.string().uuid().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      }), req.query);
      return { promotions: await promotionReport(p, resolveBranch(p, q.branchId), q) };
    });

  /** Which promotions an order actually got, and for how much. */
  app.get('/orders/:id/promotions',
    { preHandler: requirePermission('orders.read') }, async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      return previewPromotion(p, id);
    });
}
