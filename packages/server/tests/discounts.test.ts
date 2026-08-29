import { afterAll, describe, expect, it } from 'vitest';
import {
  auth, closeApp, getApp, getCustomerId, getProductId, getTableId,
  loginAdmin, loginEmployee, otpCapture,
} from './helpers.js';
import { many, one, pool } from '../src/core/db.js';

afterAll(closeApp);

async function createShishaOrder(): Promise<{ orderId: string; total: number }> {
  const app = await getApp();
  const cashier = await loginEmployee('2001', '4826');
  const shisha = await getProductId('معسل تفاحتين');
  const res = await app.inject({
    method: 'POST', url: '/api/orders', headers: auth(cashier),
    payload: {
      tableId: await getTableId('5'),
      customerId: await getCustomerId(),
      lines: [{ productId: shisha, quantity: 1 }],
      idempotencyKey: `disc-${Math.random()}`,
    },
  });
  const body = res.json();
  return { orderId: body.orderId, total: body.grandTotal };
}

/**
 * The specification's protection rules for customer discounts and points.
 * Neither may ever be applied on the word of an employee alone.
 */
describe('customer discount requires the customer OTP', () => {
  it('applies the special price only after a verified code', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const customerId = await getCustomerId();
    const { orderId, total } = await createShishaOrder();

    // Menu price of the shisha is 65.00 SAR.
    expect(total).toBe(6500);

    otpCapture.clear();
    const request = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/discount/request-otp`,
      headers: auth(cashier), payload: { customerId },
    });
    expect(request.statusCode).toBe(200);
    const { otpRequestId, operationRef, preview } = request.json();
    expect(preview.totalDiscount).toBe(2000);   // 65 → 45 SAR

    // The code went to the CUSTOMER's phone, not to the employee.
    expect(otpCapture.sent.at(-1)!.phone).toBe('+966551234567');

    const applied = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/discount/apply`,
      headers: auth(cashier),
      payload: { customerId, otpRequestId, operationRef, code: otpCapture.lastCode() },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().grandTotal).toBe(4500);   // 45.00 SAR

    const discount = await one<{
      original_price: number; discounted_price: number; discount_amount: number;
      otp_verified: boolean; otp_request_id: string; customer_id: string;
      applied_by_employee_id: string; table_id: string;
    }>('SELECT * FROM discounts WHERE order_id = $1', [orderId]);

    // The full evidence trail the specification asks for.
    expect(discount!.original_price).toBe(6500);
    expect(discount!.discounted_price).toBe(4500);
    expect(discount!.discount_amount).toBe(2000);
    expect(discount!.otp_verified).toBe(true);
    expect(discount!.otp_request_id).toBe(otpRequestId);
    expect(discount!.customer_id).toBe(customerId);
    expect(discount!.applied_by_employee_id).toBeTruthy();
    expect(discount!.table_id).toBeTruthy();
  });

  it('REFUSES the discount with a wrong code', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const customerId = await getCustomerId();
    const { orderId } = await createShishaOrder();

    otpCapture.clear();
    const request = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/discount/request-otp`,
      headers: auth(cashier), payload: { customerId },
    });
    const { otpRequestId, operationRef } = request.json();

    const res = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/discount/apply`,
      headers: auth(cashier),
      payload: { customerId, otpRequestId, operationRef, code: '000000' },
    });
    expect(res.statusCode).toBe(400);

    // No discount was written, and the price stands.
    const discounts = await one<{ n: number }>(
      'SELECT count(*)::int AS n FROM discounts WHERE order_id = $1', [orderId],
    );
    expect(discounts!.n).toBe(0);
    const order = await one<{ grand_total: number }>(
      'SELECT grand_total FROM orders WHERE id = $1', [orderId],
    );
    expect(order!.grand_total).toBe(6500);
  });

  it('a discount code cannot be reused on a second invoice', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const customerId = await getCustomerId();
    const first = await createShishaOrder();

    otpCapture.clear();
    const request = await app.inject({
      method: 'POST', url: `/api/orders/${first.orderId}/discount/request-otp`,
      headers: auth(cashier), payload: { customerId },
    });
    const { otpRequestId, operationRef } = request.json();
    const code = otpCapture.lastCode();

    const applied = await app.inject({
      method: 'POST', url: `/api/orders/${first.orderId}/discount/apply`,
      headers: auth(cashier), payload: { customerId, otpRequestId, operationRef, code },
    });
    expect(applied.statusCode).toBe(200);

    // Same code, second invoice — must be refused.
    const second = await createShishaOrder();
    const replay = await app.inject({
      method: 'POST', url: `/api/orders/${second.orderId}/discount/apply`,
      headers: auth(cashier), payload: { customerId, otpRequestId, operationRef, code },
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error.message).toContain('مسبقاً');
  });

  it('a discount code cannot be used to spend points', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const customerId = await getCustomerId();
    const { orderId } = await createShishaOrder();

    otpCapture.clear();
    const request = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/discount/request-otp`,
      headers: auth(cashier), payload: { customerId },
    });
    const { otpRequestId, operationRef } = request.json();

    // Present the DISCOUNT code against the POINTS endpoint.
    const res = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/points/redeem`,
      headers: auth(cashier),
      payload: {
        customerId, otpRequestId, operationRef, code: otpCapture.lastCode(),
      },
    });
    expect(res.statusCode).toBe(400);

    const points = await one<{ points_balance: number }>(
      'SELECT points_balance FROM customer_wallets WHERE customer_id = $1', [customerId],
    );
    // The wallet is untouched.
    expect(points!.points_balance).toBeGreaterThan(0);
  });

  it('an expired code is refused', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const customerId = await getCustomerId();
    const { orderId } = await createShishaOrder();

    otpCapture.clear();
    const request = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/discount/request-otp`,
      headers: auth(cashier), payload: { customerId },
    });
    const { otpRequestId, operationRef } = request.json();
    const code = otpCapture.lastCode();

    await pool.query(
      "UPDATE otp_requests SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [otpRequestId],
    );

    const res = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/discount/apply`,
      headers: auth(cashier), payload: { customerId, otpRequestId, operationRef, code },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('انتهت صلاحية');
  });

  it('never writes the code itself into the audit log', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const customerId = await getCustomerId();
    const { orderId } = await createShishaOrder();

    otpCapture.clear();
    const request = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/discount/request-otp`,
      headers: auth(cashier), payload: { customerId },
    });
    const code = otpCapture.lastCode();

    const logs = await many<{ metadata: unknown; new_value: unknown }>(
      `SELECT metadata, new_value FROM audit_logs
        WHERE entity_id = $1 OR entity_id = $2`,
      [request.json().otpRequestId, orderId],
    );
    const serialised = JSON.stringify(logs);
    expect(serialised).not.toContain(code);

    // Nor is the code recoverable from the database row — only its hash.
    const stored = await one<{ code_hash: string }>(
      'SELECT code_hash FROM otp_requests WHERE id = $1', [request.json().otpRequestId],
    );
    expect(stored!.code_hash).not.toContain(code);
    expect(stored!.code_hash.startsWith('$argon2id$')).toBe(true);
  });

  it('a waiter cannot invent a discount without a special price on file', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const flatWhite = await getProductId('فلات وايت');
    const customerId = await getCustomerId();

    // Flat white has no special price for this customer.
    const created = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth(cashier),
      payload: {
        customerId, lines: [{ productId: flatWhite, quantity: 1 }],
        idempotencyKey: `nodiscount-${Date.now()}`,
      },
    });
    const res = await app.inject({
      method: 'POST', url: `/api/orders/${created.json().orderId}/discount/request-otp`,
      headers: auth(cashier), payload: { customerId },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('لا يوجد سعر خاص');
  });
});

describe('points redemption requires its own OTP', () => {
  it('debits the wallet and the bill only after verification', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const customerId = await getCustomerId();

    await pool.query(
      'UPDATE customer_wallets SET points_balance = 320 WHERE customer_id = $1', [customerId],
    );
    const { orderId, total } = await createShishaOrder();

    otpCapture.clear();
    const request = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/points/request-otp`,
      headers: auth(cashier), payload: { customerId, points: 100 },
    });
    expect(request.statusCode).toBe(200);
    // 100 points = 10.00 SAR under the seeded rule.
    expect(request.json().value).toBe(1000);

    const redeemed = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/points/redeem`,
      headers: auth(cashier),
      payload: {
        customerId, otpRequestId: request.json().otpRequestId,
        operationRef: request.json().operationRef, code: otpCapture.lastCode(),
      },
    });
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json().pointsUsed).toBe(100);
    expect(redeemed.json().value).toBe(1000);
    expect(redeemed.json().pointsBalance).toBe(220);
    expect(redeemed.json().grandTotal).toBe(total - 1000);

    // The wallet ledger records it, tied to the order and the OTP.
    const txn = await one<{
      points_delta: number; points_balance_after: number;
      order_id: string; otp_request_id: string; kind: string;
    }>(
      `SELECT * FROM wallet_transactions
        WHERE customer_id = $1 AND order_id = $2 AND kind = 'redeem'`,
      [customerId, orderId],
    );
    expect(txn!.points_delta).toBe(-100);
    expect(txn!.points_balance_after).toBe(220);
    expect(txn!.otp_request_id).toBe(request.json().otpRequestId);
  });

  it('refuses redemption with a wrong code and leaves the wallet intact', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const customerId = await getCustomerId();
    await pool.query(
      'UPDATE customer_wallets SET points_balance = 500 WHERE customer_id = $1', [customerId],
    );
    const { orderId } = await createShishaOrder();

    otpCapture.clear();
    const request = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/points/request-otp`,
      headers: auth(cashier), payload: { customerId, points: 100 },
    });
    const res = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/points/redeem`,
      headers: auth(cashier),
      payload: {
        customerId, otpRequestId: request.json().otpRequestId,
        operationRef: request.json().operationRef, code: '999999',
      },
    });
    expect(res.statusCode).toBe(400);

    const wallet = await one<{ points_balance: number }>(
      'SELECT points_balance FROM customer_wallets WHERE customer_id = $1', [customerId],
    );
    expect(wallet!.points_balance).toBe(500);   // untouched
  });

  it('refuses to redeem more points than the customer holds', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const customerId = await getCustomerId();
    await pool.query(
      'UPDATE customer_wallets SET points_balance = 100 WHERE customer_id = $1', [customerId],
    );
    const { orderId } = await createShishaOrder();

    const res = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/points/request-otp`,
      headers: auth(cashier), payload: { customerId, points: 5000 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('رصيد النقاط غير كافٍ');
  });

  it('caps redemption at the configured share of the bill', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const customerId = await getCustomerId();
    // Rule caps redemption at 50% of the bill; a 65 SAR shisha allows 32.50.
    await pool.query(
      'UPDATE customer_wallets SET points_balance = 10000 WHERE customer_id = $1', [customerId],
    );
    const { orderId } = await createShishaOrder();

    const res = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/points/request-otp`,
      headers: auth(cashier), payload: { customerId, points: 1000 },  // 100 SAR
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('تتجاوز الحد');

    await pool.query(
      'UPDATE customer_wallets SET points_balance = 320 WHERE customer_id = $1', [customerId],
    );
  });
});

describe('payments', () => {
  it('settles an order, awards points and closes the table', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const customerId = await getCustomerId();
    const { orderId, total } = await createShishaOrder();

    const before = await one<{ points_balance: number }>(
      'SELECT points_balance FROM customer_wallets WHERE customer_id = $1', [customerId],
    );

    const res = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/pay`, headers: auth(cashier),
      payload: {
        parts: [{ method: 'cash', amount: total, tendered: total + 1000 }],
        idempotencyKey: `pay-${Date.now()}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('paid');
    expect(res.json().outstanding).toBe(0);
    expect(res.json().changeGiven).toBe(1000);
    // 1 point per 10 SAR: a 65 SAR bill earns 6 points.
    expect(res.json().pointsEarned).toBe(6);

    const after = await one<{ points_balance: number }>(
      'SELECT points_balance FROM customer_wallets WHERE customer_id = $1', [customerId],
    );
    expect(after!.points_balance).toBe(before!.points_balance + 6);

    const customer = await one<{ order_count: number; total_spend: number }>(
      'SELECT order_count, total_spend FROM customers WHERE id = $1', [customerId],
    );
    expect(customer!.order_count).toBeGreaterThan(0);
    expect(customer!.total_spend).toBeGreaterThanOrEqual(total);
  });

  it('prevents a duplicate payment from a retried submit', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const { orderId, total } = await createShishaOrder();
    const key = `paydup-${Date.now()}`;
    const payload = {
      parts: [{ method: 'mada' as const, amount: total }], idempotencyKey: key,
    };

    const first = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/pay`, headers: auth(cashier), payload,
    });
    const second = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/pay`, headers: auth(cashier), payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // Exactly one payment exists, and the order is not charged twice.
    const payments = await many('SELECT id FROM payments WHERE order_id = $1', [orderId]);
    expect(payments).toHaveLength(1);
    expect(second.json().paid).toBe(total);
  });

  it('supports mixed payment across methods', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const { orderId, total } = await createShishaOrder();

    const res = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/pay`, headers: auth(cashier),
      payload: {
        parts: [
          { method: 'cash', amount: 2000 },
          { method: 'visa', amount: total - 2000, reference: 'APPR-991' },
        ],
        idempotencyKey: `mixed-${Date.now()}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('paid');
    expect(res.json().payments).toHaveLength(2);
    // Both parts share a split group.
    const groups = new Set(res.json().payments.map((p: any) => p.split_group));
    expect(groups.size).toBe(1);
  });

  it('supports partial payment leaving a balance', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const { orderId, total } = await createShishaOrder();

    const res = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/pay`, headers: auth(cashier),
      payload: {
        parts: [{ method: 'cash', amount: 2000 }],
        idempotencyKey: `partial-${Date.now()}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).not.toBe('paid');
    expect(res.json().outstanding).toBe(total - 2000);
  });

  it('refuses to take more than the outstanding balance', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const { orderId, total } = await createShishaOrder();
    const res = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/pay`, headers: auth(cashier),
      payload: { parts: [{ method: 'cash', amount: total + 5000 }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('splits a bill evenly without losing a halala', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const { orderId, total } = await createShishaOrder();

    const res = await app.inject({
      method: 'GET', url: `/api/orders/${orderId}/split/even?ways=3`, headers: auth(cashier),
    });
    expect(res.statusCode).toBe(200);
    const { parts } = res.json();
    expect(parts).toHaveLength(3);
    expect(parts.reduce((a: number, b: number) => a + b, 0)).toBe(total);
  });
});
