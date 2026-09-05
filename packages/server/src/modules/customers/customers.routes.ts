import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, pool } from '../../core/db.js';
import { parse, requirePermission } from '../../core/http.js';
import { requirePrincipal, resolveBranch } from '../../core/principal.js';
import { AUDIT, audit } from '../../core/audit.js';
import { badRequest } from '../../core/errors.js';
import {
  findOrCreateByPhone, getCustomerProfile, moveWallet, searchCustomers, setSpecialPrice,
} from './customers.service.js';
import { withTransaction } from '../../core/db.js';
import { listCustomerOtpHistory } from './otp.service.js';

export async function customerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/customers/search', { preHandler: requirePermission('customers.read') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({ term: z.string().min(2).max(50) }), req.query);
      return { customers: await searchCustomers(q.term, p) };
    });

  app.get('/customers/:id', { preHandler: requirePermission('customers.read') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      return { customer: await getCustomerProfile(id, p) };
    });

  app.post('/customers', { preHandler: requirePermission('customers.create') },
    async (req) => {
      const p = requirePrincipal(req);
      const body = parse(z.object({
        phone: z.string().min(8).max(20),
        name: z.string().max(100).nullish(),
        branchId: z.string().uuid().optional(),
      }), req.body);
      const result = await findOrCreateByPhone(body.phone, {
        branchId: resolveBranch(p, body.branchId),
        createdBy: p.userId,
        name: body.name,
      });
      return result;
    });

  app.patch('/customers/:id', { preHandler: requirePermission('customers.update') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const body = parse(z.object({
        name: z.string().max(100).nullish(),
        notes: z.string().max(1000).nullish(),
      }), req.body);
      await pool.query(
        `UPDATE customers SET full_name = COALESCE($2, full_name),
                notes = COALESCE($3, notes) WHERE id = $1`,
        [id, body.name ?? null, body.notes ?? null],
      );
      await audit({
        action: 'customer.updated', actorUserId: p.userId, actorLabel: p.displayName,
        branchId: p.branchId, entityType: 'customer', entityId: id, newValue: body,
      });
      return { ok: true };
    });

  app.get('/customers/:id/wallet', { preHandler: requirePermission('customers.wallet.read') },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      return {
        transactions: await many(
          `SELECT wt.id, wt.kind, wt.points_delta, wt.credit_delta,
                  wt.points_balance_after, wt.credit_balance_after, wt.reason,
                  wt.created_at, o.order_number,
                  COALESCE(e.full_name, u.full_name) AS performed_by
             FROM wallet_transactions wt
             LEFT JOIN orders o ON o.id = wt.order_id
             LEFT JOIN employees e ON e.id = wt.performed_by_employee_id
             LEFT JOIN users u ON u.id = wt.performed_by_user_id
            WHERE wt.customer_id = $1 ORDER BY wt.created_at DESC LIMIT 100`,
          [id],
        ),
      };
    });

  /** Manual wallet adjustment — management only, always with a reason. */
  app.post('/customers/:id/wallet/adjust', {
    preHandler: requirePermission('customers.wallet.adjust'),
  }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({
      points: z.number().int().default(0),
      credit: z.number().int().default(0),
      reason: z.string().min(1).max(500),
    }), req.body);
    if (body.points === 0 && body.credit === 0) throw badRequest('حدد قيمة للتعديل');

    const result = await withTransaction(async (client) => {
      const moved = await moveWallet({
        customerId: id, branchId: p.branchId,
        kind: body.points >= 0 && body.credit >= 0 ? 'manual_credit' : 'manual_debit',
        pointsDelta: body.points, creditDelta: body.credit,
        reason: body.reason, byUserId: p.userId, byEmployeeId: p.employeeId,
      }, client);
      await audit({
        action: AUDIT.WALLET_ADJUSTED, actorUserId: p.userId, actorLabel: p.displayName,
        branchId: p.branchId, entityType: 'customer', entityId: id,
        newValue: { points: body.points, credit: body.credit, reason: body.reason,
          balanceAfter: moved.pointsBalance },
      }, client);
      return moved;
    });
    return result;
  });

  app.get('/customers/:id/otp-history', { preHandler: requirePermission('audit.read') },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      return { history: await listCustomerOtpHistory(id) };
    });

  // --- Special prices -------------------------------------------------------
  app.post('/customers/:id/special-prices', {
    preHandler: requirePermission('customers.special_prices.manage'),
  }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({
      productId: z.string().uuid().nullish(),
      categoryId: z.string().uuid().nullish(),
      branchId: z.string().uuid().optional(),
      price: z.number().int().min(0).nullish(),
      discountPercent: z.number().min(0).max(90).nullish(),
      requiresOtp: z.boolean().default(true),
      validTo: z.string().nullish(),
      notes: z.string().max(500).nullish(),
    }), req.body);
    return setSpecialPrice(p, {
      customerId: id, ...body, branchId: resolveBranch(p, body.branchId),
    });
  });

  app.delete('/customers/special-prices/:id', {
    preHandler: requirePermission('customers.special_prices.manage'),
  }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    // Soft-disable: the rule stays as evidence for past discounts.
    await pool.query('UPDATE customer_special_prices SET is_active = FALSE WHERE id = $1', [id]);
    await audit({
      action: AUDIT.SPECIAL_PRICE_UPDATED, actorUserId: p.userId,
      actorLabel: p.displayName, branchId: p.branchId,
      entityType: 'customer_special_price', entityId: id,
      newValue: { isActive: false },
    });
    return { ok: true };
  });

  app.get('/loyalty/rules', { preHandler: requirePermission('loyalty.rules.read') },
    async (req) => {
      const p = requirePrincipal(req);
      return {
        rules: await many(
          `SELECT * FROM loyalty_rules
            WHERE (branch_id = $1 OR branch_id IS NULL) ORDER BY effective_from DESC`,
          [p.branchId],
        ),
      };
    });

  app.post('/loyalty/rules', { preHandler: requirePermission('loyalty.rules.manage') },
    async (req) => {
      const p = requirePrincipal(req);
      const body = parse(z.object({
        name: z.string().min(1),
        branchId: z.string().uuid().nullish(),
        spendPerPoint: z.number().int().positive(),
        pointsPerBlock: z.number().int().positive(),
        blockValue: z.number().int().positive(),
        minRedeemPoints: z.number().int().min(0).default(100),
        maxRedeemPercent: z.number().min(1).max(100).default(100),
      }), req.body);

      const branchId = body.branchId ?? p.branchId;
      // Only one rule is live at a time; superseding closes the previous one.
      await pool.query(
        `UPDATE loyalty_rules SET is_active = FALSE, effective_to = now()
          WHERE is_active AND (branch_id = $1 OR ($1::uuid IS NULL AND branch_id IS NULL))`,
        [branchId],
      );
      const created = await pool.query(
        `INSERT INTO loyalty_rules (branch_id, name, spend_per_point, points_per_block,
           block_value, min_redeem_points, max_redeem_percent, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          branchId, body.name, body.spendPerPoint, body.pointsPerBlock,
          body.blockValue, body.minRedeemPoints, body.maxRedeemPercent, p.userId,
        ],
      );
      await audit({
        action: 'loyalty.rule.created', actorUserId: p.userId, actorLabel: p.displayName,
        branchId, entityType: 'loyalty_rule', entityId: created.rows[0].id, newValue: body,
      });
      return { id: created.rows[0].id };
    });
}
