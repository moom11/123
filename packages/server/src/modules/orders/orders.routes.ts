import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many } from '../../core/db.js';
import { parse, requireAuth, requirePermission } from '../../core/http.js';
import { requirePrincipal, resolveBranch } from '../../core/principal.js';
import {
  addItems, createOrder, getOrder, listPendingApprovals, reviewCustomerOrder, voidItem,
} from './orders.service.js';
import {
  applyCustomerDiscount, applyManualDiscount, redeemPoints, requestDiscountOtp, requestPointsOtp,
} from './discounts.service.js';
import {
  splitByItemsPreview, splitEvenlyPreview, takePayment, voidPayment,
} from './payments.service.js';

const cartLineSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().nullish(),
  quantity: z.number().positive().max(999),
  modifierOptionIds: z.array(z.string().uuid()).optional(),
  notes: z.string().max(500).nullish(),
});

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  app.post('/orders', { preHandler: requirePermission('orders.create') }, async (req) => {
    const p = requirePrincipal(req);
    const body = parse(z.object({
      branchId: z.string().uuid().optional(),
      tableId: z.string().uuid().nullish(),
      sessionId: z.string().uuid().nullish(),
      customerId: z.string().uuid().nullish(),
      orderType: z.enum(['dine_in', 'takeaway']).optional(),
      lines: z.array(cartLineSchema).min(1),
      notes: z.string().max(1000).nullish(),
      guestCount: z.number().int().min(1).max(50).optional(),
      idempotencyKey: z.string().max(100).nullish(),
    }), req.body);

    return createOrder(p, {
      ...body,
      branchId: resolveBranch(p, body.branchId),
      source: 'pos',
      waiterEmployeeId: p.employeeId,
      idempotencyKey: body.idempotencyKey
        ?? (req.headers['x-idempotency-key'] as string | undefined) ?? null,
    });
  });

  app.get('/orders/:id', { preHandler: requirePermission('orders.read') }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    return { order: await getOrder(id, p) };
  });

  app.get('/orders', { preHandler: requirePermission('orders.read') }, async (req) => {
    const p = requirePrincipal(req);
    const q = parse(z.object({
      branchId: z.string().uuid().optional(),
      status: z.string().optional(),
      tableId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }), req.query);
    const branchId = resolveBranch(p, q.branchId);

    // Without orders.read.all a waiter sees only their own orders.
    const seesAll = p.permissions.has('orders.read.all');
    return {
      orders: await many(
        `SELECT o.id, o.order_number, o.status, o.source, o.grand_total, o.paid_total,
                o.created_at, o.paid_at, t.table_number, c.full_name AS customer_name,
                e.full_name AS waiter_name,
                (SELECT count(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS item_count
           FROM orders o
           LEFT JOIN restaurant_tables t ON t.id = o.table_id
           LEFT JOIN customers c ON c.id = o.customer_id
           LEFT JOIN employees e ON e.id = o.waiter_employee_id
          WHERE o.branch_id = $1
            AND ($2::text IS NULL OR o.status = $2)
            AND ($3::uuid IS NULL OR o.table_id = $3)
            AND ($4::boolean OR o.waiter_employee_id = $5 OR o.created_by_employee_id = $5)
          ORDER BY o.created_at DESC LIMIT $6`,
        [branchId, q.status ?? null, q.tableId ?? null, seesAll, p.employeeId, q.limit],
      ),
    };
  });

  /** The waiter's approval inbox for customer QR orders. */
  app.get('/orders/pending-approval', {
    preHandler: requirePermission('orders.approve_customer_order'),
  }, async (req) => {
    const p = requirePrincipal(req);
    const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
    return { orders: await listPendingApprovals(p, resolveBranch(p, q.branchId)) };
  });

  app.post('/orders/:id/review', {
    preHandler: requirePermission('orders.approve_customer_order'),
  }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({
      decision: z.enum(['approve', 'reject']),
      reason: z.string().max(500).optional(),
    }), req.body);
    return reviewCustomerOrder(p, id, body.decision, body.reason);
  });

  app.post('/orders/:id/items', { preHandler: requirePermission('orders.add_items') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const body = parse(z.object({ lines: z.array(cartLineSchema).min(1) }), req.body);
      return addItems(p, id, body.lines);
    });

  app.post('/orders/:id/items/:itemId/void', {
    preHandler: requirePermission('orders.void_item'),
  }, async (req) => {
    const p = requirePrincipal(req);
    const params = parse(z.object({
      id: z.string().uuid(), itemId: z.string().uuid(),
    }), req.params);
    const { reason } = parse(z.object({ reason: z.string().min(1).max(500) }), req.body);
    await voidItem(p, params.id, params.itemId, reason);
    return { ok: true };
  });

  // --- Discounts: OTP-gated -------------------------------------------------
  app.post('/orders/:id/discount/request-otp', {
    preHandler: requirePermission('orders.discount.apply'),
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
  }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({
      customerId: z.string().uuid(),
      orderItemIds: z.array(z.string().uuid()).optional(),
    }), req.body);
    return requestDiscountOtp(p, { orderId: id, ...body });
  });

  app.post('/orders/:id/discount/apply', {
    preHandler: requirePermission('orders.discount.apply'),
    config: { rateLimit: { max: 30, timeWindow: '10 minutes' } },
  }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({
      customerId: z.string().uuid(),
      otpRequestId: z.string().uuid(),
      code: z.string().min(4).max(10),
      operationRef: z.string().min(10),
    }), req.body);
    return applyCustomerDiscount(p, { orderId: id, ...body });
  });

  app.post('/orders/:id/points/request-otp', {
    preHandler: requirePermission('customers.points.redeem'),
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
  }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({
      customerId: z.string().uuid(),
      points: z.number().int().positive(),
    }), req.body);
    return requestPointsOtp(p, { orderId: id, ...body });
  });

  app.post('/orders/:id/points/redeem', {
    preHandler: requirePermission('customers.points.redeem'),
    config: { rateLimit: { max: 30, timeWindow: '10 minutes' } },
  }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({
      customerId: z.string().uuid(),
      otpRequestId: z.string().uuid(),
      code: z.string().min(4).max(10),
      operationRef: z.string().min(10),
    }), req.body);
    return redeemPoints(p, { orderId: id, ...body });
  });

  app.post('/orders/:id/discount/manual', {
    preHandler: requirePermission('orders.discount.manual'),
  }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({
      amount: z.number().int().positive(), reason: z.string().min(1).max(500),
    }), req.body);
    return applyManualDiscount(p, { orderId: id, ...body });
  });

  // --- Payments -------------------------------------------------------------
  app.post('/orders/:id/pay', { preHandler: requirePermission('payments.take') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const body = parse(z.object({
        parts: z.array(z.object({
          method: z.enum(['cash', 'mada', 'visa', 'mastercard', 'apple_pay', 'wallet_points']),
          amount: z.number().int().positive(),
          tendered: z.number().int().positive().nullish(),
          reference: z.string().max(100).nullish(),
          itemIds: z.array(z.string().uuid()).optional(),
        })).min(1),
        idempotencyKey: z.string().max(100).nullish(),
      }), req.body);
      return takePayment(p, {
        orderId: id, parts: body.parts,
        idempotencyKey: body.idempotencyKey
          ?? (req.headers['x-idempotency-key'] as string | undefined) ?? null,
      });
    });

  app.get('/orders/:id/split/even', { preHandler: requirePermission('payments.split') },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const { ways } = parse(z.object({ ways: z.coerce.number().int() }), req.query);
      return splitEvenlyPreview(id, ways);
    });

  app.post('/orders/:id/split/items', { preHandler: requirePermission('payments.split') },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const { itemIds } = parse(
        z.object({ itemIds: z.array(z.string().uuid()).min(1) }), req.body);
      return splitByItemsPreview(id, itemIds);
    });

  app.post('/payments/:id/void', { preHandler: requirePermission('payments.refund') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const { reason } = parse(z.object({ reason: z.string().min(1).max(500) }), req.body);
      await voidPayment(p, id, reason);
      return { ok: true };
    });
}
