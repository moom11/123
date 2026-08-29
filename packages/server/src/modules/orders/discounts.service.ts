import { randomUUID } from 'node:crypto';
import { many, one, withTransaction } from '../../core/db.js';
import { AUDIT, audit } from '../../core/audit.js';
import { badRequest, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { notify } from '../../core/notify.js';
import type { Principal } from '../../core/principal.js';
import {
  activeLoyaltyRule, moveWallet, pointsToValue, resolveSpecialPrice,
} from '../customers/customers.service.js';
import { issueOtp, verifyOtp } from '../customers/otp.service.js';
import { recalculateOrder } from './orders.service.js';

/**
 * Customer discounts and points redemption.
 *
 * Both are two-step and both require the customer's own WhatsApp code:
 *   1. staff requests a code → it goes to the customer's phone
 *   2. the customer reads the code out → staff enters it → the system verifies
 *
 * The two flows never share a code. A discount code carries purpose
 * 'customer_discount', a redemption code carries 'points_redemption', and each
 * is additionally bound to one operation id, so a code obtained for one cannot
 * authorise the other — nor can the same code be replayed on a second invoice.
 */

export interface RequestDiscountOtpInput {
  orderId: string;
  customerId: string;
  orderItemIds?: string[];
}

export async function requestDiscountOtp(
  principal: Principal, input: RequestDiscountOtpInput,
) {
  const order = await one<{
    id: string; branch_id: string; table_id: string | null; status: string;
    customer_id: string | null;
  }>(
    'SELECT id, branch_id, table_id, status, customer_id FROM orders WHERE id = $1',
    [input.orderId],
  );
  if (!order) throw notFound('الطلب غير موجود');
  if (['paid', 'cancelled'].includes(order.status)) {
    throw unprocessable('لا يمكن تعديل فاتورة مقفلة');
  }

  const customer = await one<{ id: string; phone: string; full_name: string | null }>(
    'SELECT id, phone, full_name FROM customers WHERE id = $1 AND deleted_at IS NULL',
    [input.customerId],
  );
  if (!customer) throw notFound('العميل غير موجود');

  // Establish there is actually something to discount before bothering the
  // customer's phone.
  const preview = await previewSpecialPrices(input.orderId, input.customerId, order.branch_id,
    input.orderItemIds);
  if (preview.lines.length === 0) {
    throw unprocessable('لا يوجد سعر خاص مطبق لهذا العميل على أصناف هذه الفاتورة');
  }

  // The operation reference pins the code to this order, this customer and this
  // exact set of lines.
  const operationRef = `discount:${input.orderId}:${input.customerId}:${randomUUID()}`;

  const otp = await issueOtp({
    purpose: 'customer_discount',
    phone: customer.phone,
    customerId: customer.id,
    branchId: order.branch_id,
    orderId: order.id,
    tableId: order.table_id,
    operationRef,
    payload: {
      orderId: input.orderId,
      lines: preview.lines.map((l) => ({
        orderItemId: l.orderItemId, specialPriceId: l.specialPriceId,
        originalPrice: l.originalPrice, discountedPrice: l.discountedPrice,
      })),
      totalDiscount: preview.totalDiscount,
    },
    requestedByUserId: principal.userId,
    requestedByEmployeeId: principal.employeeId,
  });

  return {
    otpRequestId: otp.otpRequestId,
    operationRef,
    expiresAt: otp.expiresAt,
    delivered: otp.delivered,
    devCode: otp.devCode,
    preview,
  };
}

async function previewSpecialPrices(
  orderId: string, customerId: string, branchId: string, onlyItemIds?: string[],
) {
  const items = await many<{
    id: string; product_id: string; category_id: string; quantity: number;
    unit_price: number; effective_unit_price: number; product_name_ar: string;
    discount_id: string | null;
  }>(
    `SELECT oi.id, oi.product_id, oi.quantity, oi.unit_price, oi.effective_unit_price,
            oi.product_name_ar, oi.discount_id, p.category_id
       FROM order_items oi JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1 AND oi.status <> 'voided'
        AND ($2::uuid[] IS NULL OR oi.id = ANY($2::uuid[]))`,
    [orderId, onlyItemIds ?? null],
  );

  const lines: Array<{
    orderItemId: string; productName: string; specialPriceId: string;
    originalPrice: number; discountedPrice: number; quantity: number;
    discountAmount: number;
  }> = [];
  let totalDiscount = 0;

  for (const item of items) {
    if (item.discount_id) continue;   // already discounted
    const special = await resolveSpecialPrice(
      customerId, item.product_id, item.category_id, branchId, item.unit_price,
    );
    if (!special) continue;

    const discountAmount = (item.unit_price - special.price) * Number(item.quantity);
    if (discountAmount <= 0) continue;

    totalDiscount += discountAmount;
    lines.push({
      orderItemId: item.id, productName: item.product_name_ar,
      specialPriceId: special.specialPriceId, originalPrice: item.unit_price,
      discountedPrice: special.price, quantity: Number(item.quantity), discountAmount,
    });
  }

  return { lines, totalDiscount };
}

/**
 * Apply the discount, but only against a valid, unused, purpose-and-operation
 * matched code. Verification and application share one transaction: if writing
 * the discount fails, the code is not burned.
 */
export async function applyCustomerDiscount(
  principal: Principal,
  input: { orderId: string; customerId: string; otpRequestId: string; code: string; operationRef: string },
): Promise<{ applied: number; totalDiscount: number; grandTotal: number }> {
  return withTransaction(async (client) => {
    const order = await one<{
      id: string; branch_id: string; table_id: string | null; status: string;
    }>(
      'SELECT id, branch_id, table_id, status FROM orders WHERE id = $1 FOR UPDATE',
      [input.orderId], client,
    );
    if (!order) throw notFound('الطلب غير موجود');
    if (['paid', 'cancelled'].includes(order.status)) {
      throw unprocessable('لا يمكن تعديل فاتورة مقفلة');
    }

    // The gate. Everything below only runs on a verified code.
    const verified = await verifyOtp({
      otpRequestId: input.otpRequestId,
      code: input.code,
      purpose: 'customer_discount',
      operationRef: input.operationRef,
      customerId: input.customerId,
      consumedByUserId: principal.userId,
      consumedByEmployeeId: principal.employeeId,
    }, client);

    const payload = verified.payload as {
      orderId?: string;
      lines?: Array<{ orderItemId: string; specialPriceId: string; originalPrice: number; discountedPrice: number }>;
    };
    if (payload.orderId !== input.orderId) {
      throw badRequest('رمز التحقق لا يخص هذه الفاتورة');
    }

    let applied = 0;
    let totalDiscount = 0;

    for (const line of payload.lines ?? []) {
      const item = await one<{
        id: string; quantity: number; unit_price: number; modifiers_total: number;
        discount_id: string | null; status: string;
      }>(
        'SELECT id, quantity, unit_price, modifiers_total, discount_id, status FROM order_items WHERE id = $1 AND order_id = $2 FOR UPDATE',
        [line.orderItemId, input.orderId], client,
      );
      // The line may have been voided between issuing and entering the code.
      if (!item || item.status === 'voided' || item.discount_id) continue;

      const discountAmount = (line.originalPrice - line.discountedPrice) * Number(item.quantity);
      if (discountAmount <= 0) continue;

      const discount = await one<{ id: string }>(
        `INSERT INTO discounts (
           branch_id, order_id, order_item_id, table_id, customer_id, kind,
           special_price_id, original_price, discounted_price, discount_amount,
           otp_request_id, otp_verified, otp_verified_at,
           applied_by_employee_id, applied_by_user_id
         ) VALUES ($1,$2,$3,$4,$5,'customer_special_price',$6,$7,$8,$9,$10,TRUE,now(),$11,$12)
         RETURNING id`,
        [
          order.branch_id, input.orderId, line.orderItemId, order.table_id,
          input.customerId, line.specialPriceId, line.originalPrice,
          line.discountedPrice, discountAmount, verified.id,
          principal.employeeId, principal.userId,
        ],
        client,
      );

      await client.query(
        `UPDATE order_items
            SET effective_unit_price = $2, discount_amount = $3, discount_id = $4,
                line_total = ($2 + modifiers_total) * quantity
          WHERE id = $1`,
        [line.orderItemId, line.discountedPrice, discountAmount, discount!.id],
      );

      applied += 1;
      totalDiscount += discountAmount;
    }

    if (applied === 0) throw unprocessable('لم يعد هناك أصناف قابلة للخصم في هذه الفاتورة');

    await recalculateOrder(input.orderId, client);
    const totals = await one<{ grand_total: number }>(
      'SELECT grand_total FROM orders WHERE id = $1', [input.orderId], client,
    );

    // The full evidence trail the specification asks for.
    await audit({
      action: AUDIT.DISCOUNT_APPLIED, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      actorKind: 'employee', branchId: order.branch_id,
      entityType: 'order', entityId: input.orderId,
      newValue: {
        customerId: input.customerId, tableId: order.table_id,
        linesDiscounted: applied, totalDiscount,
        otpRequestId: verified.id, otpVerified: true,
        grandTotal: totals?.grand_total,
      },
      metadata: { employeeId: principal.employeeId, employeeName: principal.displayName },
    }, client);

    if (totalDiscount >= 10000) {
      await notify({
        branchId: order.branch_id, kind: 'large_discount', severity: 'warning',
        title: 'خصم بقيمة مرتفعة',
        body: `خصم ${(totalDiscount / 100).toFixed(2)} ر.س بواسطة ${principal.displayName}`,
        entityType: 'order', entityId: input.orderId,
        targetPermissions: ['orders.read.all', 'audit.read'],
      }, client);
    }

    return { applied, totalDiscount, grandTotal: totals?.grand_total ?? 0 };
  });
}

/** Step one of redemption: a code specifically for spending points. */
export async function requestPointsOtp(
  principal: Principal,
  input: { orderId: string; customerId: string; points: number },
) {
  if (!Number.isInteger(input.points) || input.points <= 0) {
    throw badRequest('عدد النقاط غير صالح');
  }

  const order = await one<{ id: string; branch_id: string; table_id: string | null; status: string; grand_total: number }>(
    'SELECT id, branch_id, table_id, status, grand_total FROM orders WHERE id = $1',
    [input.orderId],
  );
  if (!order) throw notFound('الطلب غير موجود');
  if (['paid', 'cancelled'].includes(order.status)) {
    throw unprocessable('لا يمكن تعديل فاتورة مقفلة');
  }

  const customer = await one<{ phone: string; full_name: string | null }>(
    'SELECT phone, full_name FROM customers WHERE id = $1', [input.customerId],
  );
  if (!customer) throw notFound('العميل غير موجود');

  const wallet = await one<{ points_balance: number }>(
    'SELECT points_balance FROM customer_wallets WHERE customer_id = $1', [input.customerId],
  );
  if (!wallet || wallet.points_balance < input.points) {
    throw unprocessable('رصيد النقاط غير كافٍ');
  }

  const rule = await activeLoyaltyRule(order.branch_id);
  if (!rule) throw unprocessable('لا توجد قواعد نقاط مفعّلة');
  if (input.points < rule.min_redeem_points) {
    throw unprocessable(`الحد الأدنى للاستبدال ${rule.min_redeem_points} نقطة`);
  }
  if (input.points % rule.points_per_block !== 0) {
    throw badRequest(`النقاط يجب أن تكون من مضاعفات ${rule.points_per_block}`);
  }

  const value = pointsToValue(input.points, rule);
  const maxValue = Math.floor(order.grand_total * Number(rule.max_redeem_percent) / 100);
  if (value > maxValue) {
    throw unprocessable('قيمة النقاط تتجاوز الحد المسموح لهذه الفاتورة');
  }

  const operationRef = `points:${input.orderId}:${input.customerId}:${randomUUID()}`;
  const otp = await issueOtp({
    purpose: 'points_redemption',       // deliberately NOT the discount purpose
    phone: customer.phone,
    customerId: input.customerId,
    branchId: order.branch_id,
    orderId: order.id,
    tableId: order.table_id,
    operationRef,
    payload: { orderId: input.orderId, points: input.points, value, ruleId: rule.id },
    requestedByUserId: principal.userId,
    requestedByEmployeeId: principal.employeeId,
  });

  return {
    otpRequestId: otp.otpRequestId, operationRef, expiresAt: otp.expiresAt,
    delivered: otp.delivered, devCode: otp.devCode,
    points: input.points, value,
  };
}

/** Step two: verify, debit the wallet, discount the bill — all atomically. */
export async function redeemPoints(
  principal: Principal,
  input: { orderId: string; customerId: string; otpRequestId: string; code: string; operationRef: string },
): Promise<{ pointsUsed: number; value: number; grandTotal: number; pointsBalance: number }> {
  return withTransaction(async (client) => {
    const order = await one<{
      id: string; branch_id: string; table_id: string | null; status: string;
      grand_total: number; points_redeemed: number; points_discount_total: number;
    }>(
      'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [input.orderId], client,
    );
    if (!order) throw notFound('الطلب غير موجود');
    if (['paid', 'cancelled'].includes(order.status)) {
      throw unprocessable('لا يمكن تعديل فاتورة مقفلة');
    }

    const verified = await verifyOtp({
      otpRequestId: input.otpRequestId,
      code: input.code,
      purpose: 'points_redemption',
      operationRef: input.operationRef,
      customerId: input.customerId,
      consumedByUserId: principal.userId,
      consumedByEmployeeId: principal.employeeId,
    }, client);

    const payload = verified.payload as { orderId?: string; points?: number; value?: number };
    if (payload.orderId !== input.orderId) throw badRequest('رمز التحقق لا يخص هذه الفاتورة');

    const points = Number(payload.points ?? 0);
    const value = Number(payload.value ?? 0);
    if (points <= 0 || value <= 0) throw badRequest('بيانات الاستبدال غير صالحة');

    // Debit the wallet (locks the wallet row, enforces a non-negative balance).
    const wallet = await moveWallet({
      customerId: input.customerId, branchId: order.branch_id, kind: 'redeem',
      pointsDelta: -points, orderId: input.orderId, otpRequestId: verified.id,
      reason: `استبدال نقاط على الفاتورة`,
      byUserId: principal.userId, byEmployeeId: principal.employeeId,
    }, client);

    await one(
      `INSERT INTO discounts (
         branch_id, order_id, table_id, customer_id, kind, original_price,
         discounted_price, discount_amount, points_used, otp_request_id,
         otp_verified, otp_verified_at, applied_by_employee_id, applied_by_user_id
       ) VALUES ($1,$2,$3,$4,'points_redemption',$5,$6,$7,$8,$9,TRUE,now(),$10,$11)
       RETURNING id`,
      [
        order.branch_id, input.orderId, order.table_id, input.customerId,
        order.grand_total, Math.max(0, order.grand_total - value), value, points,
        verified.id, principal.employeeId, principal.userId,
      ],
      client,
    );

    await client.query(
      `UPDATE orders SET points_redeemed = points_redeemed + $2,
              points_discount_total = points_discount_total + $3
        WHERE id = $1`,
      [input.orderId, points, value],
    );
    await recalculateOrder(input.orderId, client);

    const totals = await one<{ grand_total: number }>(
      'SELECT grand_total FROM orders WHERE id = $1', [input.orderId], client,
    );

    await audit({
      action: AUDIT.POINTS_REDEEMED, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      actorKind: 'employee', branchId: order.branch_id,
      entityType: 'order', entityId: input.orderId,
      newValue: {
        customerId: input.customerId, points, value,
        otpRequestId: verified.id, otpVerified: true,
        pointsBalanceAfter: wallet.pointsBalance, grandTotal: totals?.grand_total,
      },
    }, client);

    return {
      pointsUsed: points, value,
      grandTotal: totals?.grand_total ?? 0,
      pointsBalance: wallet.pointsBalance,
    };
  });
}

/**
 * Manual management discount. Requires a distinct permission that no waiter or
 * cashier holds, and is always audited with a reason.
 */
export async function applyManualDiscount(
  principal: Principal,
  input: { orderId: string; amount: number; reason: string },
): Promise<{ grandTotal: number }> {
  if (!principal.permissions.has('orders.discount.manual')) {
    throw forbidden('لا تملك صلاحية الخصم اليدوي');
  }
  if (!input.reason?.trim()) throw badRequest('سبب الخصم مطلوب');
  if (input.amount <= 0) throw badRequest('قيمة الخصم غير صالحة');

  return withTransaction(async (client) => {
    const order = await one<{ branch_id: string; grand_total: number; status: string; table_id: string | null }>(
      'SELECT branch_id, grand_total, status, table_id FROM orders WHERE id = $1 FOR UPDATE',
      [input.orderId], client,
    );
    if (!order) throw notFound('الطلب غير موجود');
    if (['paid', 'cancelled'].includes(order.status)) {
      throw unprocessable('لا يمكن تعديل فاتورة مقفلة');
    }
    if (input.amount > order.grand_total) throw badRequest('الخصم أكبر من قيمة الفاتورة');

    await client.query(
      `INSERT INTO discounts (
         branch_id, order_id, table_id, kind, original_price, discounted_price,
         discount_amount, reason, applied_by_user_id, applied_by_employee_id
       ) VALUES ($1,$2,$3,'manual',$4,$5,$6,$7,$8,$9)`,
      [
        order.branch_id, input.orderId, order.table_id, order.grand_total,
        order.grand_total - input.amount, input.amount, input.reason,
        principal.userId, principal.employeeId,
      ],
    );
    await recalculateOrder(input.orderId, client);
    const totals = await one<{ grand_total: number }>(
      'SELECT grand_total FROM orders WHERE id = $1', [input.orderId], client,
    );

    await audit({
      action: AUDIT.DISCOUNT_APPLIED, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      branchId: order.branch_id, entityType: 'order', entityId: input.orderId,
      newValue: { kind: 'manual', amount: input.amount, reason: input.reason },
    }, client);

    await notify({
      branchId: order.branch_id, kind: 'large_discount', severity: 'warning',
      title: 'خصم يدوي',
      body: `${(input.amount / 100).toFixed(2)} ر.س بواسطة ${principal.displayName}: ${input.reason}`,
      entityType: 'order', entityId: input.orderId,
      targetPermissions: ['audit.read', 'reports.financial'],
    }, client);

    return { grandTotal: totals?.grand_total ?? 0 };
  });
}
