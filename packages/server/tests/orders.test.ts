import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auth, closeApp, getApp, getCustomerId, getModifierOption, getProductId,
  getQrValue, getTableId, loginEmployee, otpCapture, stockOf,
} from './helpers.js';
import { many, one, pool } from '../src/core/db.js';

afterAll(closeApp);

describe('POS ordering and printer routing', () => {
  it('routes each item to its department printer and splits a mixed order', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const flatWhite = await getProductId('فلات وايت');   // BAR
    const dessert = await getProductId('كيك الشوكولاتة');  // KITCHEN
    const shisha = await getProductId('معسل تفاحتين');      // SHISHA

    const res = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth(cashier),
      payload: {
        tableId: await getTableId('3'),
        lines: [
          { productId: flatWhite, quantity: 1 },
          { productId: dessert, quantity: 1 },
          { productId: shisha, quantity: 1 },
        ],
        idempotencyKey: `routing-${Date.now()}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const { orderId } = res.json();

    const jobs = await many<{ department: string; kind: string; printer_name: string }>(
      `SELECT p.department, pj.kind, p.name AS printer_name
         FROM print_jobs pj JOIN printers p ON p.id = pj.printer_id
        WHERE pj.order_id = $1 ORDER BY p.department`,
      [orderId],
    );
    // One ticket per department — three departments, three tickets.
    expect(jobs).toHaveLength(3);
    expect(jobs.map((j) => j.department).sort()).toEqual(['BAR', 'KITCHEN', 'SHISHA']);
    expect(jobs.every((j) => j.kind === 'new_order')).toBe(true);
  });

  it('prices from the database and ignores any price sent by the client', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const tea = await getProductId('شاي');
    const sugar = await getModifierOption('سكر');
    const mintMoroccan = await getModifierOption('نعناع مغربي');

    const res = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth(cashier),
      payload: {
        lines: [{
          productId: tea, quantity: 1,
          modifierOptionIds: [sugar, mintMoroccan],
          // A hostile client trying to set its own price:
          price: 1, unitPrice: 1, lineTotal: 1,
        }],
        idempotencyKey: `pricing-${Date.now()}`,
      },
    });
    expect(res.statusCode).toBe(200);
    // Tea 800 + Moroccan mint 300 = 1100 halalas, from the menu, not the client.
    expect(res.json().grandTotal).toBe(1100);
  });

  it('rejects an order for an unavailable product', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const tea = await getProductId('شاي');
    await pool.query('UPDATE products SET is_available = FALSE WHERE id = $1', [tea]);

    const res = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth(cashier),
      payload: { lines: [{ productId: tea, quantity: 1 }] },
    });
    expect(res.statusCode).toBe(422);
    await pool.query('UPDATE products SET is_available = TRUE WHERE id = $1', [tea]);
  });

  it('requires a required modifier group to be answered', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const tea = await getProductId('شاي');
    const res = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth(cashier),
      payload: { lines: [{ productId: tea, quantity: 1, modifierOptionIds: [] }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('prevents a duplicate order from a retried submit', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const flatWhite = await getProductId('فلات وايت');
    const key = `dedupe-${Date.now()}`;
    const payload = {
      lines: [{ productId: flatWhite, quantity: 1 }], idempotencyKey: key,
    };

    const first = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth(cashier), payload,
    });
    const second = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth(cashier), payload,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // The same order comes back, rather than a second one being created.
    expect(second.json().orderId).toBe(first.json().orderId);

    const count = await one<{ n: number }>(
      'SELECT count(*)::int AS n FROM orders WHERE idempotency_key = $1', [key],
    );
    expect(count!.n).toBe(1);
  });

  it('prints ADD ITEM for later additions, not the whole ticket again', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const flatWhite = await getProductId('فلات وايت');

    const created = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth(cashier),
      payload: {
        tableId: await getTableId('4'),
        lines: [{ productId: flatWhite, quantity: 1 }],
        idempotencyKey: `additem-${Date.now()}`,
      },
    });
    const { orderId } = created.json();

    const added = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/items`, headers: auth(cashier),
      payload: { lines: [{ productId: flatWhite, quantity: 1 }] },
    });
    expect(added.statusCode).toBe(200);

    const jobs = await many<{ kind: string; payload: any }>(
      'SELECT kind, payload FROM print_jobs WHERE order_id = $1 ORDER BY created_at',
      [orderId],
    );
    expect(jobs).toHaveLength(2);
    expect(jobs[0].kind).toBe('new_order');
    expect(jobs[1].kind).toBe('add_item');
    expect(jobs[1].payload.banner).toBe('ADD ITEM');
    // The ADD ITEM ticket carries only the new line.
    expect(jobs[1].payload.items).toHaveLength(1);
  });

  it('prints VOID and returns stock when an item is cancelled after printing', async () => {
    const app = await getApp();
    const manager = await loginEmployee('2001', '4826');
    const { loginAdmin } = await import('./helpers.js');
    const admin = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const flatWhite = await getProductId('فلات وايت');

    const beforeCoffee = await stockOf('ING-COFFEE');
    const created = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth(manager),
      payload: {
        lines: [{ productId: flatWhite, quantity: 1 }],
        idempotencyKey: `void-${Date.now()}`,
      },
    });
    const { orderId } = created.json();
    expect(beforeCoffee - await stockOf('ING-COFFEE')).toBe(18);

    const item = await one<{ id: string }>(
      'SELECT id FROM order_items WHERE order_id = $1', [orderId],
    );
    const voided = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/items/${item!.id}/void`,
      headers: auth(admin), payload: { reason: 'العميل غيّر رأيه' },
    });
    expect(voided.statusCode).toBe(200);

    // Consumption is reversed — the coffee goes back.
    expect(await stockOf('ING-COFFEE')).toBe(beforeCoffee);

    const voidJob = await one<{ payload: any }>(
      "SELECT payload FROM print_jobs WHERE order_id = $1 AND kind = 'void'", [orderId],
    );
    expect(voidJob!.payload.banner).toBe('VOID');
    expect(voidJob!.payload.reason).toBe('العميل غيّر رأيه');

    // The order total drops to zero, and the line survives as a voided record.
    const order = await one<{ grand_total: number }>(
      'SELECT grand_total FROM orders WHERE id = $1', [orderId],
    );
    expect(order!.grand_total).toBe(0);
  });

  it('stamps REPRINT and records who asked and why', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const flatWhite = await getProductId('فلات وايت');

    const created = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth(cashier),
      payload: {
        lines: [{ productId: flatWhite, quantity: 1 }],
        idempotencyKey: `reprint-${Date.now()}`,
      },
    });
    const { orderId } = created.json();
    const job = await one<{ id: string }>(
      'SELECT id FROM print_jobs WHERE order_id = $1', [orderId],
    );

    const res = await app.inject({
      method: 'POST', url: `/api/print-jobs/${job!.id}/reprint`, headers: auth(cashier),
      payload: { reason: 'الورق انقطع' },
    });
    expect(res.statusCode).toBe(200);

    const reprint = await one<{ payload: any; is_reprint: boolean; reprint_reason: string }>(
      'SELECT payload, is_reprint, reprint_reason FROM print_jobs WHERE id = $1',
      [res.json().jobId],
    );
    expect(reprint!.is_reprint).toBe(true);
    expect(reprint!.payload.banner).toBe('REPRINT');
    expect(reprint!.reprint_reason).toBe('الورق انقطع');

    const audited = await one<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'print.reprint' AND entity_id = $1",
      [res.json().jobId],
    );
    expect(audited!.n).toBe(1);
  });

  it('requires a reason to reprint', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const job = await one<{ id: string }>('SELECT id FROM print_jobs LIMIT 1');
    const res = await app.inject({
      method: 'POST', url: `/api/print-jobs/${job!.id}/reprint`, headers: auth(cashier),
      payload: { reason: '' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('customer QR ordering with waiter approval', () => {
  let customerToken: string;
  let qrValue: string;

  beforeAll(async () => {
    const app = await getApp();
    qrValue = await getQrValue('12');
    otpCapture.clear();

    const request = await app.inject({
      method: 'POST', url: '/api/public/auth/request-otp',
      payload: { phone: '0551234567', qrValue },
    });
    expect(request.statusCode).toBe(200);

    const verify = await app.inject({
      method: 'POST', url: '/api/public/auth/verify-otp',
      payload: {
        otpRequestId: request.json().otpRequestId,
        code: otpCapture.lastCode(),
        qrValue,
        marketingConsent: false,
      },
    });
    expect(verify.statusCode).toBe(200);
    customerToken = verify.json().accessToken;
  });

  it('resolves the table from the QR without the guest naming it', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: `/api/public/menu/${qrValue}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().table.number).toBe('12');
    expect(res.json().menu.products.length).toBeGreaterThan(0);
  });

  it('rejects a tampered QR value', async () => {
    const app = await getApp();
    const tampered = `${qrValue.slice(0, -4)}0000`;
    const res = await app.inject({ method: 'GET', url: `/api/public/menu/${tampered}` });
    expect(res.statusCode).toBe(404);

    // A realistic-length but invented token is rejected by the signature check.
    const guessed = await app.inject({
      method: 'GET',
      url: '/api/public/menu/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb',
    });
    expect(guessed.statusCode).toBe(404);
  });

  it('rejects a wrong OTP and does not create a session', async () => {
    const app = await getApp();
    otpCapture.clear();
    const request = await app.inject({
      method: 'POST', url: '/api/public/auth/request-otp',
      payload: { phone: '0559999999', qrValue },
    });
    const res = await app.inject({
      method: 'POST', url: '/api/public/auth/verify-otp',
      payload: { otpRequestId: request.json().otpRequestId, code: '000000', qrValue },
    });
    expect(res.statusCode).toBe(400);
  });

  it('an OTP cannot be used twice', async () => {
    const app = await getApp();
    otpCapture.clear();
    const request = await app.inject({
      method: 'POST', url: '/api/public/auth/request-otp',
      payload: { phone: '0558888888', qrValue },
    });
    const payload = {
      otpRequestId: request.json().otpRequestId,
      code: otpCapture.lastCode(),
      qrValue,
    };
    const first = await app.inject({
      method: 'POST', url: '/api/public/auth/verify-otp', payload,
    });
    const second = await app.inject({
      method: 'POST', url: '/api/public/auth/verify-otp', payload,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(400);
    expect(second.json().error.message).toContain('مسبقاً');
  });

  it('a customer order waits for the waiter and reaches NO printer', async () => {
    const app = await getApp();
    const flatWhite = await getProductId('فلات وايت');

    const res = await app.inject({
      method: 'POST', url: '/api/public/orders',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        qrValue,
        lines: [{ productId: flatWhite, quantity: 1 }],
        idempotencyKey: `qr-${Date.now()}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const { orderId, status } = res.json();
    expect(status).toBe('pending_waiter_approval');

    // The critical assertion: nothing was queued for any printer.
    const jobs = await one<{ n: number }>(
      'SELECT count(*)::int AS n FROM print_jobs WHERE order_id = $1', [orderId],
    );
    expect(jobs!.n).toBe(0);

    // The table shows the pending order.
    const table = await one<{ status: string }>(
      'SELECT status FROM restaurant_tables WHERE table_number = $1', ['12'],
    );
    expect(table!.status).toBe('new_order');
  });

  it('the waiter approves and only then does it print', async () => {
    const app = await getApp();
    const flatWhite = await getProductId('فلات وايت');

    const created = await app.inject({
      method: 'POST', url: '/api/public/orders',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        qrValue, lines: [{ productId: flatWhite, quantity: 1 }],
        idempotencyKey: `qr-approve-${Date.now()}`,
      },
    });
    const { orderId } = created.json();

    // Table 12 belongs to waiter 1043 (tables 11-20).
    const waiter = await loginEmployee('1043', '1379');
    const inbox = await app.inject({
      method: 'GET', url: '/api/orders/pending-approval', headers: auth(waiter),
    });
    expect(inbox.json().orders.some((o: any) => o.id === orderId)).toBe(true);

    const approved = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/review`, headers: auth(waiter),
      payload: { decision: 'approve' },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe('printed');

    const jobs = await one<{ n: number }>(
      'SELECT count(*)::int AS n FROM print_jobs WHERE order_id = $1', [orderId],
    );
    expect(jobs!.n).toBe(1);
  });

  it('the waiter can reject with a reason and nothing prints', async () => {
    const app = await getApp();
    const flatWhite = await getProductId('فلات وايت');
    const created = await app.inject({
      method: 'POST', url: '/api/public/orders',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        qrValue, lines: [{ productId: flatWhite, quantity: 1 }],
        idempotencyKey: `qr-reject-${Date.now()}`,
      },
    });
    const { orderId } = created.json();

    const waiter = await loginEmployee('1043', '1379');
    const rejected = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/review`, headers: auth(waiter),
      payload: { decision: 'reject', reason: 'الصنف غير متوفر حالياً' },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().status).toBe('cancelled');

    const jobs = await one<{ n: number }>(
      'SELECT count(*)::int AS n FROM print_jobs WHERE order_id = $1', [orderId],
    );
    expect(jobs!.n).toBe(0);
  });

  it('a rejection requires a reason', async () => {
    const app = await getApp();
    const flatWhite = await getProductId('فلات وايت');
    const created = await app.inject({
      method: 'POST', url: '/api/public/orders',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        qrValue, lines: [{ productId: flatWhite, quantity: 1 }],
        idempotencyKey: `qr-noreason-${Date.now()}`,
      },
    });
    const waiter = await loginEmployee('1043', '1379');
    const res = await app.inject({
      method: 'POST', url: `/api/orders/${created.json().orderId}/review`,
      headers: auth(waiter), payload: { decision: 'reject' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('another waiter cannot approve a table that is not theirs', async () => {
    const app = await getApp();
    const flatWhite = await getProductId('فلات وايت');
    const created = await app.inject({
      method: 'POST', url: '/api/public/orders',
      headers: { authorization: `Bearer ${customerToken}` },
      payload: {
        qrValue, lines: [{ productId: flatWhite, quantity: 1 }],
        idempotencyKey: `qr-other-${Date.now()}`,
      },
    });
    // Table 12 is waiter 1043's; 1042 owns tables 1-10.
    const other = await loginEmployee('1042', '2580');
    const table12Waiter = await one<{ employee_code: string }>(
      `SELECT e.employee_code FROM restaurant_tables t
         JOIN employees e ON e.id = t.assigned_waiter_employee_id
        WHERE t.table_number = '12'`,
    );
    // Table 12 is assigned to 1043, so 1042 must be refused.
    expect(table12Waiter!.employee_code).toBe('1043');
    const res = await app.inject({
      method: 'POST', url: `/api/orders/${created.json().orderId}/review`,
      headers: auth(other), payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('service requests reach the right place and charcoal prints', async () => {
    const app = await getApp();

    const charcoal = await app.inject({
      method: 'POST', url: '/api/public/service-request',
      payload: { qrValue, kind: 'charcoal' },
    });
    expect(charcoal.statusCode).toBe(200);
    expect(charcoal.json().deduplicated).toBe(false);

    const job = await one<{ payload: any; department: string }>(
      `SELECT pj.payload, p.department FROM print_jobs pj
         JOIN printers p ON p.id = pj.printer_id
        WHERE pj.service_request_id = $1`,
      [charcoal.json().requestId],
    );
    expect(job!.department).toBe('SHISHA');
    expect(job!.payload.banner).toBe('CHARCOAL REQUEST');
    expect(job!.payload.tableNumber).toBe('12');

    // Rapid repeat taps collapse into the one request.
    const again = await app.inject({
      method: 'POST', url: '/api/public/service-request',
      payload: { qrValue, kind: 'charcoal' },
    });
    expect(again.json().deduplicated).toBe(true);
    expect(again.json().requestId).toBe(charcoal.json().requestId);
  });

  it('a bill request shows on the table', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST', url: '/api/public/service-request',
      payload: { qrValue: await getQrValue('7'), kind: 'bill' },
    });
    expect(res.statusCode).toBe(200);
    const table = await one<{ status: string }>(
      "SELECT status FROM restaurant_tables WHERE table_number = '7'",
    );
    expect(table!.status).toBe('bill_requested');
  });

  it('records marketing consent separately from phone verification', async () => {
    const consents = await many<{ granted: boolean; channel: string }>(
      `SELECT granted, channel FROM customer_consents WHERE customer_id = $1`,
      [await getCustomerId()],
    );
    // The guest verified their phone but declined marketing — the two are
    // recorded independently, exactly as the specification requires.
    expect(consents.length).toBeGreaterThan(0);
    expect(consents.every((c) => c.granted === false)).toBe(true);

    const customer = await one<{ phone_verified: boolean }>(
      'SELECT phone_verified FROM customers WHERE id = $1', [await getCustomerId()],
    );
    expect(customer!.phone_verified).toBe(true);
  });
});
