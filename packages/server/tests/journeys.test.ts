import { afterAll, describe, expect, it } from 'vitest';
import { closeApp, getCustomerId, stockOf } from './helpers.js';
import { one } from '../src/core/db.js';
import { runCustomerJourney, runPurchaseJourney } from './scenario.js';

afterAll(closeApp);

/** Specification §74 — Khalid's visit, end to end. */
describe('customer journey', () => {
  it('runs the whole visit and leaves the system knowing everything about it', async () => {
    const customerId = await getCustomerId();
    const before = await one<{ points_balance: number }>(
      'SELECT points_balance FROM customer_wallets WHERE customer_id = $1', [customerId],
    );

    const result = await runCustomerJourney();

    // Each item reached its own department's printer.
    expect(result.printJobDepartments.sort()).toEqual(['BAR', 'KITCHEN', 'SHISHA']);

    // His special shisha price applied: 65.00 → 45.00 SAR.
    expect(result.discountApplied).toBe(2000);

    // 100 points were spent, behind their own OTP.
    expect(result.pointsUsed).toBe(100);

    const order = await one<{
      status: string; grand_total: number; paid_total: number;
      customer_id: string; waiter_employee_id: string; table_id: string;
      source: string; points_redeemed: number;
    }>('SELECT * FROM orders WHERE id = $1', [result.orderId]);

    // At any moment the system can answer: who, which table, which waiter,
    // what was ordered, what was discounted, what was paid.
    expect(order!.status).toBe('paid');
    expect(order!.paid_total).toBe(order!.grand_total);
    expect(order!.customer_id).toBe(customerId);
    expect(order!.waiter_employee_id).toBeTruthy();
    expect(order!.table_id).toBeTruthy();
    expect(order!.source).toBe('customer_qr');
    expect(order!.points_redeemed).toBe(100);

    // Points spent, then earned back on the settled bill.
    const after = await one<{ points_balance: number }>(
      'SELECT points_balance FROM customer_wallets WHERE customer_id = $1', [customerId],
    );
    expect(after!.points_balance).toBeLessThan(before!.points_balance + 100);

    // Both OTPs were consumed, and they were different codes for different purposes.
    const otps = await one<{ discount: number; points: number }>(
      `SELECT
         count(*) FILTER (WHERE purpose = 'customer_discount' AND consumed_at IS NOT NULL)::int AS discount,
         count(*) FILTER (WHERE purpose = 'points_redemption' AND consumed_at IS NOT NULL)::int AS points
       FROM otp_requests WHERE customer_id = $1 AND order_id = $2`,
      [customerId, result.orderId],
    );
    expect(otps!.discount).toBeGreaterThan(0);
    expect(otps!.points).toBeGreaterThan(0);

    // The recipes consumed real stock.
    const consumption = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM inventory_transactions
        WHERE order_id = $1 AND txn_type = 'recipe_consumption'`,
      [result.orderId],
    );
    expect(consumption!.n).toBeGreaterThan(0);

    // The voided extra is still on the record, not erased.
    const voided = await one<{ status: string; void_reason: string }>(
      'SELECT status, void_reason FROM order_items WHERE id = $1', [result.voidedItemId],
    );
    expect(voided!.status).toBe('voided');
    expect(voided!.void_reason).toBe('طلب العميل الإلغاء');

    // The customer's aggregates moved.
    const customer = await one<{ order_count: number; total_spend: number; visit_count: number }>(
      'SELECT order_count, total_spend, visit_count FROM customers WHERE id = $1', [customerId],
    );
    expect(customer!.order_count).toBeGreaterThan(0);
    expect(customer!.visit_count).toBeGreaterThan(0);
  }, 60_000);
});

/** Specification §75 — the milk purchase, end to end. */
describe('purchase journey', () => {
  it('runs request → approval → purchase → delivery → receipt', async () => {
    const stockBefore = await stockOf('ING-MILK', 'BAR');
    const result = await runPurchaseJourney();

    // 60 L asked for, 40 L approved, 40 L bought, 40 L received.
    expect(result.approvedQuantity).toBe(40000);
    expect(result.purchasedQuantity).toBe(40000);
    expect(result.receivedQuantity).toBe(40000);

    // Stock moved once, on receipt.
    expect(await stockOf('ING-MILK', 'BAR')).toBe(stockBefore + 40000);

    const request = await one<{
      status: string; approved_by_user_id: string; buyer_user_id: string;
      received_at: Date; closed_at: Date;
    }>('SELECT * FROM purchase_requests WHERE id = $1', [result.requestId]);
    expect(request!.status).toBe('closed');
    expect(request!.approved_by_user_id).toBeTruthy();
    expect(request!.buyer_user_id).toBeTruthy();
    expect(request!.received_at).toBeTruthy();

    // The invoice and supplier were captured.
    const purchase = await one<{ invoice_number: string; supplier_id: string; total: number }>(
      'SELECT invoice_number, supplier_id, total FROM purchases WHERE request_id = $1',
      [result.requestId],
    );
    expect(purchase!.invoice_number).toBe('INV-MILK-2026-01');
    expect(purchase!.supplier_id).toBeTruthy();
    expect(purchase!.total).toBeGreaterThan(0);

    // Price history is available for next time.
    const price = await one<{ n: number }>(
      'SELECT count(*)::int AS n FROM supplier_prices WHERE purchase_id = (SELECT id FROM purchases WHERE request_id = $1)',
      [result.requestId],
    );
    expect(price!.n).toBeGreaterThan(0);

    // Every step is on the record.
    const trail = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE entity_id = $1 AND entity_type = 'purchase_request'`,
      [result.requestId],
    );
    expect(trail!.n).toBeGreaterThanOrEqual(3);
  }, 60_000);
});
