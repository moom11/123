import { splitEvenly } from '@mara/shared';
import { many, one, withTransaction } from '../../core/db.js';
import { AUDIT, audit } from '../../core/audit.js';
import { issueInvoiceForOrder } from '../invoicing/invoicing.service.js';
import { queueReceipt } from '../invoicing/receipt.service.js';
import { requireCashierDevice, type Device } from '../devices/devices.service.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { EVENTS, publish } from '../../core/realtime.js';
import { assertBranchAccess, type Principal } from '../../core/principal.js';
import { activeLoyaltyRule, moveWallet } from '../customers/customers.service.js';
import { refreshTableStatus } from '../tables/tables.service.js';

export interface PaymentPart {
  method: 'cash' | 'mada' | 'visa' | 'mastercard' | 'apple_pay' | 'wallet_points';
  amount: number;          // halalas
  tendered?: number | null;
  reference?: string | null;
  itemIds?: string[];      // for split-by-items
}

/**
 * Take payment.
 *
 * Duplicate-invoice prevention is the central concern: the till may be on a
 * flaky connection, so the client sends an idempotency key. A repeat of the
 * same key returns the original result instead of charging twice — the unique
 * index on (branch_id, idempotency_key) makes that guarantee at the database
 * level, not merely in application logic.
 */
export async function takePayment(
  principal: Principal,
  input: {
    orderId: string;
    parts: PaymentPart[];
    /** The terminal the request came from. Must be a till. */
    device?: Device | null;
    idempotencyKey?: string | null;
    closeOrder?: boolean;
  },
): Promise<{
  paid: number; outstanding: number; status: string; payments: unknown[];
  changeGiven: number; pointsEarned: number;
  invoice?: { id: string; number: string; icv: number; qr: string } | null;
}> {
  if (input.parts.length === 0) throw badRequest('حدد طريقة دفع واحدة على الأقل');

  // Work that must happen only once the payment is durably committed. A
  // printer is slow and sometimes offline; a database transaction is neither
  // the place to wait for one nor to be undone by one.
  const afterCommit: Array<() => Promise<unknown>> = [];

  // The kind check needs nothing but the device, so it runs before any path
  // that could return early — including the idempotent replay below.
  if (input.device && input.device.kind !== 'cashier') {
    requireCashierDevice(input.device, input.device.branchId);
  }

  const result = await withTransaction(async (client) => {
    if (input.idempotencyKey) {
      const existing = await many<{ id: string }>(
        'SELECT id FROM payments WHERE branch_id = (SELECT branch_id FROM orders WHERE id = $1) AND idempotency_key = $2',
        [input.orderId, input.idempotencyKey], client,
      );
      if (existing.length > 0) {
        return summarisePayment(input.orderId, client);
      }
    }

    const order = await one<{
      id: string; branch_id: string; status: string; grand_total: number;
      paid_total: number; customer_id: string | null; table_id: string | null;
      session_id: string | null; order_number: string;
    }>(
      'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [input.orderId], client,
    );
    if (!order) throw notFound('الطلب غير موجود');
    assertBranchAccess(principal, order.branch_id);

    // Checked after the order is loaded so the message can name the branch
    // mismatch, and before any money moves.
    const till = requireCashierDevice(input.device ?? null, order.branch_id);
    if (order.status === 'cancelled') throw unprocessable('الطلب ملغي');
    if (order.status === 'paid') {
      // Already settled — return the existing state rather than double-charging.
      return summarisePayment(input.orderId, client);
    }

    const alreadyPaid = await one<{ total: number }>(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM payments
        WHERE order_id = $1 AND status = 'captured'`,
      [input.orderId], client,
    );
    const paidBefore = Number(alreadyPaid?.total ?? 0);
    const outstandingBefore = order.grand_total - paidBefore;

    const requested = input.parts.reduce((s, p) => s + p.amount, 0);
    if (requested <= 0) throw badRequest('قيمة الدفع غير صالحة');
    if (requested > outstandingBefore) {
      throw badRequest(
        `المبلغ المدخل (${(requested / 100).toFixed(2)}) أكبر من المتبقي (${(outstandingBefore / 100).toFixed(2)})`,
      );
    }

    const splitGroup = input.parts.length > 1 ? crypto.randomUUID() : null;
    let changeGiven = 0;
    const created: string[] = [];

    for (const part of input.parts) {
      if (part.amount <= 0) throw badRequest('قيمة الدفع غير صالحة');

      let change = 0;
      if (part.method === 'cash' && part.tendered != null) {
        if (part.tendered < part.amount) throw badRequest('المبلغ المستلم أقل من المطلوب');
        change = part.tendered - part.amount;
        changeGiven += change;
      }

      const numRow = await one<{ n: string }>(
        `SELECT next_document_number($1,'PAY', EXTRACT(YEAR FROM now())::int) AS n`,
        [order.branch_id], client,
      );

      const payment = await one<{ id: string }>(
        `INSERT INTO payments (
           payment_number, branch_id, order_id, method, amount, tendered,
           change_given, reference, split_group, split_item_ids, is_partial,
           idempotency_key, taken_by_employee_id, taken_by_user_id, device_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [
          numRow!.n, order.branch_id, input.orderId, part.method, part.amount,
          part.tendered ?? null, change, part.reference ?? null, splitGroup,
          part.itemIds ?? null, requested < outstandingBefore,
          // Only the first part carries the idempotency key; the unique index
          // is what actually blocks a duplicate submission of the whole batch.
          created.length === 0 ? input.idempotencyKey ?? null : null,
          principal.employeeId, principal.userId, till.id,
        ],
        client,
      ).catch((err: { code?: string }) => {
        if (err.code === '23505') throw conflict('تم تسجيل هذه الدفعة مسبقاً');
        throw err;
      });
      created.push(payment!.id);
    }

    const paidAfter = paidBefore + requested;
    await client.query(
      'UPDATE orders SET paid_total = $2 WHERE id = $1', [input.orderId, paidAfter],
    );

    let pointsEarned = 0;
    let issuedInvoice: Awaited<ReturnType<typeof issueInvoiceForOrder>> | null = null;
    const fullySettled = paidAfter >= order.grand_total;

    if (fullySettled) {
      await client.query(
        `UPDATE orders SET status = 'paid', paid_at = now(), closed_at = now() WHERE id = $1`,
        [input.orderId],
      );
      await client.query(
        `INSERT INTO order_status_history
           (order_id, from_status, to_status, actor_user_id, actor_employee_id, actor_kind)
         VALUES ($1,$2,'paid',$3,$4,'employee')`,
        [input.orderId, order.status, principal.userId, principal.employeeId],
      );

      if (order.customer_id) {
        pointsEarned = await awardLoyalty(
          order.customer_id, order.branch_id, input.orderId, order.grand_total,
          principal, client,
        );
        await updateCustomerAggregates(order.customer_id, order.grand_total, client);
      }

      // Close the seating when nothing else on this table is still open.
      if (order.session_id) {
        const openOrders = await one<{ n: number }>(
          `SELECT count(*)::int AS n FROM orders
            WHERE session_id = $1 AND status NOT IN ('paid','cancelled')`,
          [order.session_id], client,
        );
        if ((openOrders?.n ?? 0) === 0) {
          await client.query(
            `UPDATE table_sessions SET status = 'closed', closed_at = now() WHERE id = $1`,
            [order.session_id],
          );
          await client.query(
            'UPDATE restaurant_tables SET current_session_id = NULL WHERE current_session_id = $1',
            [order.session_id],
          );
        }
      }

      // The tax invoice is issued in the same transaction as the settlement:
      // an order cannot be paid without one, and an invoice cannot exist for an
      // unpaid order. If stamping fails the payment rolls back — which is the
      // correct outcome, because handing a customer an unstamped receipt is a
      // compliance breach, not an inconvenience.
      const invoice = await issueInvoiceForOrder(input.orderId, till, client);
      issuedInvoice = invoice;

      await audit({
        action: AUDIT.INVOICE_ISSUED, actorUserId: principal.userId,
        actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
        actorKind: 'employee', branchId: order.branch_id,
        entityType: 'invoice', entityId: invoice.id,
        newValue: {
          invoiceNumber: invoice.invoiceNumber, icv: invoice.icv,
          grandTotal: invoice.grandTotal, vatAmount: invoice.vatAmount,
        },
      }, client);

      await audit({
        action: AUDIT.ORDER_PAID, actorUserId: principal.userId,
        actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
        actorKind: 'employee', branchId: order.branch_id,
        entityType: 'order', entityId: input.orderId,
        newValue: {
          orderNumber: order.order_number, grandTotal: order.grand_total,
          methods: input.parts.map((p) => ({ method: p.method, amount: p.amount })),
          pointsEarned,
        },
      }, client);

      publish({
        type: EVENTS.ORDER_PAID, branchId: order.branch_id,
        requiredPermissions: ['orders.read'],
        payload: { orderId: input.orderId, total: order.grand_total },
      });
    }

    if (order.table_id) await refreshTableStatus(order.table_id, client);

    // Outside the transaction's critical path: an offline printer must never
    // roll back a payment the customer has already made.
    if (issuedInvoice) {
      const invoiceId = issuedInvoice.id;
      afterCommit.push(() => queueReceipt(invoiceId, {
        userId: principal.userId, employeeId: principal.employeeId,
        cashierName: principal.displayName,
      }));
    }

    const summary = await summarisePayment(input.orderId, client);
    return {
      ...summary, changeGiven, pointsEarned,
      // The POS prints this: the invoice number and the QR the customer's copy
      // must carry.
      invoice: issuedInvoice && {
        id: issuedInvoice.id, number: issuedInvoice.invoiceNumber,
        icv: issuedInvoice.icv, qr: issuedInvoice.qr,
      },
    };
  });

  // The customer has paid and the invoice exists; a failure here costs a piece
  // of paper that can be reprinted, so it is logged rather than thrown.
  for (const task of afterCommit) {
    await task().catch((err: unknown) => {
      console.error('receipt print could not be queued:',
        err instanceof Error ? err.message : err);
    });
  }

  return result;
}

async function summarisePayment(orderId: string, client: import('pg').PoolClient) {
  const order = await one<{ grand_total: number; paid_total: number; status: string }>(
    'SELECT grand_total, paid_total, status FROM orders WHERE id = $1', [orderId], client,
  );
  // Include the invoice on every path, not only a first settlement: a retried
  // submit is exactly when the till most needs the number and QR to reprint.
  const invoice = await one<{ id: string; invoice_number: string; icv: string; qr_tlv: string }>(
    `SELECT id, invoice_number, icv, qr_tlv FROM invoices
      WHERE order_id = $1 AND document_type = 'invoice'`,
    [orderId], client,
  );
  const payments = await many(
    `SELECT id, payment_number, method, amount, tendered, change_given, reference,
            split_group, created_at
       FROM payments WHERE order_id = $1 AND status = 'captured' ORDER BY created_at`,
    [orderId], client,
  );
  return {
    paid: Number(order?.paid_total ?? 0),
    outstanding: Math.max(0, Number(order?.grand_total ?? 0) - Number(order?.paid_total ?? 0)),
    status: order?.status ?? 'unknown',
    payments,
    changeGiven: 0,
    pointsEarned: 0,
    invoice: invoice && {
      id: invoice.id, number: invoice.invoice_number,
      icv: Number(invoice.icv), qr: invoice.qr_tlv,
    },
  };
}

/** Award loyalty points on settlement, under the branch's active rule. */
async function awardLoyalty(
  customerId: string, branchId: string, orderId: string, eligibleSpend: number,
  principal: Principal, client: import('pg').PoolClient,
): Promise<number> {
  const rule = await activeLoyaltyRule(branchId, client);
  if (!rule || eligibleSpend <= 0) return 0;

  const points = Math.floor(eligibleSpend / Number(rule.spend_per_point));
  if (points <= 0) return 0;

  await moveWallet({
    customerId, branchId, kind: 'earn', pointsDelta: points, orderId,
    reason: 'نقاط على المشتريات',
    byUserId: principal.userId, byEmployeeId: principal.employeeId,
  }, client);

  return points;
}

async function updateCustomerAggregates(
  customerId: string, spend: number, client: import('pg').PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE customers
        SET order_count = order_count + 1,
            total_spend = total_spend + $2,
            last_visit_at = now(),
            first_visit_at = COALESCE(first_visit_at, now()),
            -- A visit is one calendar day, so three rounds on one night count once.
            visit_count = visit_count + CASE
              WHEN last_visit_at IS NULL OR last_visit_at::date < now()::date THEN 1 ELSE 0
            END
      WHERE id = $1`,
    [customerId, spend],
  );
}

/**
 * Split an outstanding bill evenly N ways, returning the amounts to charge.
 * The halala remainder is distributed rather than dropped, so the parts always
 * sum to exactly the total.
 */
export async function splitEvenlyPreview(
  orderId: string, ways: number,
): Promise<{ total: number; outstanding: number; parts: number[] }> {
  if (ways < 2 || ways > 20) throw badRequest('عدد التقسيمات يجب أن يكون بين 2 و 20');
  const order = await one<{ grand_total: number; paid_total: number }>(
    'SELECT grand_total, paid_total FROM orders WHERE id = $1', [orderId],
  );
  if (!order) throw notFound('الطلب غير موجود');
  const outstanding = order.grand_total - order.paid_total;
  return { total: order.grand_total, outstanding, parts: splitEvenly(outstanding, ways) };
}

/** Split by items: what does this subset of lines cost? */
export async function splitByItemsPreview(
  orderId: string, itemIds: string[],
): Promise<{ subtotal: number; itemCount: number; lines: unknown[] }> {
  if (itemIds.length === 0) throw badRequest('اختر أصنافاً للتقسيم');
  const lines = await many<{ id: string; product_name_ar: string; line_total: number; quantity: number }>(
    `SELECT id, product_name_ar, line_total, quantity FROM order_items
      WHERE order_id = $1 AND id = ANY($2::uuid[]) AND status <> 'voided'`,
    [orderId, itemIds],
  );
  const subtotal = lines.reduce((s, l) => s + Number(l.line_total), 0);
  return { subtotal, itemCount: lines.length, lines };
}

export async function voidPayment(
  principal: Principal, paymentId: string, reason: string,
): Promise<void> {
  if (!reason?.trim()) throw badRequest('سبب الإلغاء مطلوب');
  await withTransaction(async (client) => {
    const payment = await one<{ id: string; order_id: string; amount: number; status: string; branch_id: string }>(
      'SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId], client,
    );
    if (!payment) throw notFound('الدفعة غير موجودة');
    assertBranchAccess(principal, payment.branch_id);
    if (payment.status !== 'captured') throw unprocessable('لا يمكن إلغاء هذه الدفعة');

    // Financial rows are never deleted — the payment is marked voided and the
    // order's paid total is corrected, leaving the original row in place.
    await client.query(
      `UPDATE payments SET status = 'voided', voided_at = now(), void_reason = $2 WHERE id = $1`,
      [paymentId, reason],
    );
    await client.query(
      `UPDATE orders SET paid_total = GREATEST(0, paid_total - $2),
              status = CASE WHEN status = 'paid' THEN 'ready_for_billing' ELSE status END,
              paid_at = CASE WHEN status = 'paid' THEN NULL ELSE paid_at END
        WHERE id = $1`,
      [payment.order_id, payment.amount],
    );

    await audit({
      action: 'payment.voided', actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      branchId: payment.branch_id, entityType: 'payment', entityId: paymentId,
      oldValue: { status: 'captured', amount: payment.amount },
      newValue: { status: 'voided', reason },
    }, client);
  });
}
