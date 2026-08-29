import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../core/config.js';
import { one, pool } from '../../core/db.js';
import { generateToken, hashToken, signJwt } from '../../core/crypto.js';
import { meta, parse, requireCustomerAuth } from '../../core/http.js';
import { badRequest, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { requireCustomer } from '../../core/principal.js';
import { getMenu, getProductOptions } from '../menu/menu.service.js';
import { createServiceRequest, resolveQrToken } from '../tables/tables.service.js';
import { createOrder } from '../orders/orders.service.js';
import { findOrCreateByPhone, markPhoneVerified, recordConsent, activeLoyaltyRule, pointsToValue } from './customers.service.js';
import { issueOtp, verifyOtp } from './otp.service.js';
import { normalisePhone } from './whatsapp.provider.js';

/**
 * The guest-facing surface. No staff session, no staff permissions.
 *
 * Everything is anchored to a scanned QR token: the guest never states which
 * table they are at, and cannot choose a different one.
 */
export async function publicRoutes(app: FastifyInstance): Promise<void> {
  /** Resolve a scanned QR into a table + its menu. */
  app.get('/menu/:qrValue', {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req) => {
    const { qrValue } = parse(z.object({ qrValue: z.string().min(10).max(200) }), req.params);
    const table = await resolveQrToken(qrValue);

    const customerId = req.customer?.customerId ?? null;
    const menu = await getMenu(table.branch_id, { publicOnly: true, customerId });

    return {
      table: {
        id: table.id,
        number: table.table_number,
        area: table.area,
        branchName: table.branch_name,
      },
      menu,
      customer: req.customer ? { id: req.customer.customerId, verified: true } : null,
    };
  });

  app.get('/products/:id/options', async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    return getProductOptions(id);
  });

  /** Step one of guest verification: send a WhatsApp code. */
  app.post('/auth/request-otp', {
    config: { rateLimit: { max: 8, timeWindow: '10 minutes' } },
  }, async (req) => {
    const body = parse(z.object({
      phone: z.string().min(8).max(20),
      qrValue: z.string().min(10).max(200),
    }), req.body);

    const table = await resolveQrToken(body.qrValue);
    let phone: string;
    try {
      phone = normalisePhone(body.phone);
    } catch {
      throw badRequest('رقم جوال غير صالح');
    }

    const customer = await findOrCreateByPhone(phone, { branchId: table.branch_id });
    const otp = await issueOtp({
      purpose: 'customer_login',
      phone,
      customerId: customer.id,
      branchId: table.branch_id,
      tableId: table.id,
      operationRef: `login:${customer.id}:${table.id}`,
      ip: req.ip,
    });

    return {
      otpRequestId: otp.otpRequestId,
      expiresAt: otp.expiresAt,
      delivered: otp.delivered,
      // Present only under the development provider; never in production.
      devCode: otp.devCode,
      phoneHint: `${phone.slice(0, 5)}****${phone.slice(-2)}`,
    };
  });

  /** Step two: verify and receive a customer session. */
  app.post('/auth/verify-otp', {
    config: { rateLimit: { max: 15, timeWindow: '10 minutes' } },
  }, async (req) => {
    const body = parse(z.object({
      otpRequestId: z.string().uuid(),
      code: z.string().min(4).max(10),
      qrValue: z.string().min(10).max(200),
      name: z.string().max(100).nullish(),
      marketingConsent: z.boolean().optional(),
    }), req.body);

    const table = await resolveQrToken(body.qrValue);
    const verified = await verifyOtp({
      otpRequestId: body.otpRequestId,
      code: body.code,
      purpose: 'customer_login',
    });
    if (!verified.customerId) throw badRequest('تعذّر التحقق');

    await markPhoneVerified(verified.customerId);
    if (body.name) {
      await pool.query(
        'UPDATE customers SET full_name = COALESCE(full_name, $2) WHERE id = $1',
        [verified.customerId, body.name],
      );
    }
    // Verifying a phone is never itself marketing consent — it is recorded
    // separately and only when the guest actually ticks the box.
    if (body.marketingConsent !== undefined) {
      await recordConsent(verified.customerId, body.marketingConsent, 'qr_menu', {
        ip: req.ip, userAgent: req.headers['user-agent'] ?? null,
      });
    }

    const refreshToken = generateToken(32);
    const session = await one<{ id: string }>(
      `INSERT INTO customer_sessions (customer_id, refresh_token_hash, table_id, ip, user_agent, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval) RETURNING id`,
      [
        verified.customerId, hashToken(refreshToken), table.id, req.ip,
        req.headers['user-agent'] ?? null, String(config.auth.customerRefreshTtlSeconds),
      ],
    );

    const accessToken = signJwt(
      { sub: verified.customerId, sid: session!.id, cid: verified.customerId },
      config.auth.accessSecret,
      config.auth.customerRefreshTtlSeconds,
    );

    const customer = await one<any>(
      `SELECT c.id, c.full_name, c.customer_code, w.points_balance
         FROM customers c LEFT JOIN customer_wallets w ON w.customer_id = c.id
        WHERE c.id = $1`,
      [verified.customerId],
    );
    const rule = await activeLoyaltyRule(table.branch_id);

    return {
      accessToken,
      refreshToken,
      customer: {
        id: customer.id,
        name: customer.full_name,
        code: customer.customer_code,
        points: customer.points_balance ?? 0,
        pointsValue: rule ? pointsToValue(customer.points_balance ?? 0, rule) : 0,
      },
    };
  });

  /** The guest's own wallet. Reachable only with their own session. */
  app.get('/me/wallet', { preHandler: requireCustomerAuth }, async (req) => {
    const c = requireCustomer(req);
    const wallet = await one<any>(
      `SELECT w.points_balance, w.credit_balance, w.lifetime_points_earned,
              w.lifetime_points_redeemed, cu.home_branch_id
         FROM customer_wallets w JOIN customers cu ON cu.id = w.customer_id
        WHERE w.customer_id = $1`,
      [c.customerId],
    );
    const rule = await activeLoyaltyRule(wallet?.home_branch_id ?? null);
    const { many } = await import('../../core/db.js');
    const transactions = await many(
      `SELECT kind, points_delta, credit_delta, points_balance_after, reason, created_at
         FROM wallet_transactions WHERE customer_id = $1
        ORDER BY created_at DESC LIMIT 20`,
      [c.customerId],
    );
    return {
      points: wallet?.points_balance ?? 0,
      pointsValue: rule ? pointsToValue(wallet?.points_balance ?? 0, rule) : 0,
      credit: wallet?.credit_balance ?? 0,
      conversion: rule
        ? { points: rule.points_per_block, value: rule.block_value }
        : null,
      transactions,
    };
  });

  app.get('/me/orders', { preHandler: requireCustomerAuth }, async (req) => {
    const c = requireCustomer(req);
    const { many } = await import('../../core/db.js');
    return {
      orders: await many(
        `SELECT o.id, o.order_number, o.status, o.grand_total, o.created_at, o.paid_at,
                t.table_number
           FROM orders o LEFT JOIN restaurant_tables t ON t.id = o.table_id
          WHERE o.customer_id = $1 ORDER BY o.created_at DESC LIMIT 20`,
        [c.customerId],
      ),
    };
  });

  /**
   * Place an order from the guest's phone.
   *
   * It lands in pending_waiter_approval and reaches no printer until the
   * responsible waiter confirms it.
   */
  app.post('/orders', {
    preHandler: requireCustomerAuth,
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
  }, async (req) => {
    const c = requireCustomer(req);
    const body = parse(z.object({
      qrValue: z.string().min(10).max(200),
      lines: z.array(z.object({
        productId: z.string().uuid(),
        variantId: z.string().uuid().nullish(),
        quantity: z.number().positive().max(50),
        modifierOptionIds: z.array(z.string().uuid()).optional(),
        notes: z.string().max(300).nullish(),
      })).min(1).max(50),
      notes: z.string().max(500).nullish(),
      idempotencyKey: z.string().max(100).nullish(),
    }), req.body);

    const table = await resolveQrToken(body.qrValue);

    const result = await createOrder(null, {
      branchId: table.branch_id,
      tableId: table.id,
      customerId: c.customerId,
      source: 'customer_qr',       // forces waiter approval
      lines: body.lines,
      notes: body.notes ?? null,
      idempotencyKey: body.idempotencyKey ?? null,
    });

    return {
      ...result,
      message: 'تم إرسال طلبك للويتر للمراجعة والتأكيد',
    };
  });

  /** طلب ويتر / طلب فحم / طلب الحساب */
  app.post('/service-request', {
    config: { rateLimit: { max: 15, timeWindow: '10 minutes' } },
  }, async (req) => {
    const body = parse(z.object({
      qrValue: z.string().min(10).max(200),
      kind: z.enum(['waiter', 'charcoal', 'bill']),
      note: z.string().max(300).nullish(),
    }), req.body);

    const table = await resolveQrToken(body.qrValue);
    const result = await createServiceRequest({
      tableId: table.id,
      kind: body.kind,
      customerId: req.customer?.customerId ?? null,
      note: body.note ?? null,
    });

    const messages = {
      waiter: 'تم إبلاغ الويتر، سيصلك خلال لحظات',
      charcoal: 'تم إرسال طلب الفحم لقسم المعسل',
      bill: 'تم إبلاغ الكاشير بطلب الحساب',
    };
    return {
      ok: true,
      requestId: result.id,
      deduplicated: result.deduplicated,
      message: messages[body.kind],
    };
  });
}
