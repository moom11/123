import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auth, closeApp, getApp, getBranchId, getProductId, loginAdmin, loginEmployee,
} from './helpers.js';
import { many, one, pool } from '../src/core/db.js';
import { hashToken, generateToken } from '../src/core/crypto.js';
import { runCustomerJourney, runPurchaseJourney } from './scenario.js';

afterAll(closeApp);

/**
 * The audit assertions below describe a system that has actually been used, so
 * this file drives the two journeys from the specification itself rather than
 * depending on whatever another test file happened to leave behind.
 */
beforeAll(async () => {
  await runCustomerJourney();
  await runPurchaseJourney();
  await runFailureAndStockActions();
}, 120_000);

/**
 * The happy paths above never fail a login or touch stock control, yet those
 * are precisely the events the specification requires to be auditable. Exercise
 * them explicitly so the catalogue assertion is meaningful.
 */
async function runFailureAndStockActions(): Promise<void> {
  const app = await getApp();
  const branchId = await getBranchId();

  // A failed admin login and a failed PIN entry.
  await app.inject({
    method: 'POST', url: '/api/auth/login',
    payload: { email: 'owner@maralounge.sa', password: 'wrong-password-here' },
  });
  await app.inject({
    method: 'POST', url: '/api/auth/employee/login',
    payload: { branchId, employeeCode: '3002', pin: '0000' },
  });

  // A failed OTP verification.
  const { getQrValue } = await import('./helpers.js');
  const qrValue = await getQrValue('9');
  const otpReq = await app.inject({
    method: 'POST', url: '/api/public/auth/request-otp',
    payload: { phone: '0557654321', qrValue },
  });
  await app.inject({
    method: 'POST', url: '/api/public/auth/verify-otp',
    payload: { otpRequestId: otpReq.json().otpRequestId, code: '000000', qrValue },
  });

  // Waste, a stock count, and a reprint.
  const bar = await loginEmployee('3001', '7192');
  const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
  const location = await one<{ id: string }>(
    "SELECT id FROM inventory_locations WHERE code = 'BAR' AND branch_id = $1", [branchId],
  );
  const sugar = await one<{ id: string }>("SELECT id FROM inventory_items WHERE sku = 'ING-SUGAR'");

  await app.inject({
    method: 'POST', url: '/api/waste', headers: auth(bar),
    payload: {
      locationId: location!.id, itemId: sugar!.id,
      quantity: 50, unit: 'g', reason: 'preparation_error',
    },
  });

  const count = await app.inject({
    method: 'POST', url: '/api/stock-counts', headers: auth(manager),
    payload: { locationId: location!.id, countType: 'daily', itemIds: [sugar!.id] },
  });
  const expected = Number(count.json().items[0].expected_quantity);
  await app.inject({
    method: 'POST', url: `/api/stock-counts/${count.json().id}/entries`,
    headers: auth(manager),
    payload: { entries: [{ itemId: sugar!.id, countedQuantity: expected, unit: 'g' }] },
  });
  await app.inject({
    method: 'POST', url: `/api/stock-counts/${count.json().id}/submit`,
    headers: auth(manager),
  });

  // A rejected purchase request, so the rejection path is audited too.
  const milk = await one<{ id: string }>("SELECT id FROM inventory_items WHERE sku = 'ING-MILK'");
  const toReject = await app.inject({
    method: 'POST', url: '/api/purchase-requests', headers: auth(bar),
    payload: {
      department: 'BAR', submit: true,
      items: [{ itemId: milk!.id, quantity: 500, unit: 'l' }],
    },
  });
  await app.inject({
    method: 'POST', url: `/api/purchase-requests/${toReject.json().id}/decide`,
    headers: auth(manager),
    payload: { decision: 'reject', comment: 'الكمية غير مبررة' },
  });

  const job = await one<{ id: string }>('SELECT id FROM print_jobs LIMIT 1');
  await app.inject({
    method: 'POST', url: `/api/print-jobs/${job!.id}/reprint`, headers: auth(manager),
    payload: { reason: 'انقطاع الورق' },
  });
}

describe('audit log', () => {
  it('records every sensitive action listed in the specification', async () => {
    const actions = await many<{ action: string }>('SELECT DISTINCT action FROM audit_logs');
    const names = new Set(actions.map((a) => a.action));

    for (const required of [
      'auth.login.success',
      'auth.login.failed',
      'auth.pin_login.success',
      'auth.pin_login.failed',
      'order.created',
      'order.item.added',
      'order.item.voided',
      'order.paid',
      'order.discount.applied',
      'wallet.points.redeemed',
      'otp.issued',
      'otp.verified',
      'otp.failed',
      'print.reprint',
      'print.queued',
      'inventory.received',
      'inventory.waste.recorded',
      'inventory.count.submitted',
      'purchase_request.submitted',
      'purchase_request.approved',
      'purchase_request.rejected',
      'purchase.recorded',
      'purchase.received',
    ]) {
      expect(names, `missing audit action: ${required}`).toContain(required);
    }
  });

  it('captures actor, entity, before/after and request context', async () => {
    const entry = await one<{
      actor_label: string; entity_type: string; entity_id: string;
      old_value: unknown; new_value: unknown; occurred_at: Date;
    }>(
      `SELECT actor_label, entity_type, entity_id, old_value, new_value, occurred_at
         FROM audit_logs WHERE action = 'order.item.voided' LIMIT 1`,
    );
    expect(entry).toBeTruthy();
    expect(entry!.actor_label).toBeTruthy();
    expect(entry!.entity_type).toBe('order_item');
    expect(entry!.old_value).toBeTruthy();
    expect(entry!.new_value).toBeTruthy();
    expect(entry!.occurred_at).toBeInstanceOf(Date);
  });

  it('is readable through the API but has no write route', async () => {
    const app = await getApp();
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');

    const read = await app.inject({
      method: 'GET', url: '/api/audit?limit=5', headers: auth(manager),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().entries.length).toBeGreaterThan(0);

    // There is deliberately no create/update/delete surface for the audit log.
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/api/audit', headers: auth(manager) });
      expect(res.statusCode).toBe(404);
    }
  });

  it('is not readable without the audit permission', async () => {
    const app = await getApp();
    const waiter = await loginEmployee('1042', '2580');
    const res = await app.inject({ method: 'GET', url: '/api/audit', headers: auth(waiter) });
    expect(res.statusCode).toBe(403);
  });

  it('can reconstruct the whole history of one order', async () => {
    const app = await getApp();
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const order = await one<{ id: string }>(
      "SELECT id FROM orders WHERE status = 'paid' ORDER BY created_at DESC LIMIT 1",
    );
    const res = await app.inject({
      method: 'GET', url: `/api/audit/entity/order/${order!.id}`, headers: auth(manager),
    });
    expect(res.statusCode).toBe(200);
    const actions = res.json().entries.map((e: any) => e.action);
    expect(actions).toContain('order.created');
    expect(actions).toContain('order.paid');
  });
});

describe('print queue and agent protocol', () => {
  async function makeAgent(): Promise<string> {
    const token = generateToken(32);
    await pool.query(
      `INSERT INTO print_agents (branch_id, name, token_hash) VALUES ($1,$2,$3)`,
      [await getBranchId(), `test-agent-${Date.now()}`, hashToken(token)],
    );
    return token;
  }

  it('an agent claims queued jobs and reports success', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const token = await makeAgent();
    const flatWhite = await getProductId('فلات وايت');

    const order = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth(cashier),
      payload: {
        lines: [{ productId: flatWhite, quantity: 1 }],
        idempotencyKey: `agent-${Date.now()}`,
      },
    });
    const { orderId } = order.json();

    const claimed = await app.inject({
      method: 'POST', url: '/api/print-agent/claim',
      headers: { authorization: `Bearer ${token}` }, payload: { limit: 10 },
    });
    expect(claimed.statusCode).toBe(200);
    const job = claimed.json().jobs.find((j: any) => j.printer_name === 'Bar Printer');
    expect(job).toBeTruthy();
    // The agent receives everything it needs to drive the printer itself.
    expect(job.ip_address).toBe('192.168.10.102');
    expect(job.port).toBe(9100);
    expect(job.payload.header).toBe('MARA LOUNGE');

    const reported = await app.inject({
      method: 'POST', url: '/api/print-agent/result',
      headers: { authorization: `Bearer ${token}` },
      payload: { jobId: job.id, success: true },
    });
    expect(reported.statusCode).toBe(200);

    const status = await one<{ status: string; printed_at: Date }>(
      'SELECT status, printed_at FROM print_jobs WHERE id = $1', [job.id],
    );
    expect(status!.status).toBe('printed');
    expect(status!.printed_at).toBeTruthy();
  });

  it('rejects an unknown agent token', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST', url: '/api/print-agent/claim',
      headers: { authorization: 'Bearer not-a-real-token' }, payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('retries a failed job rather than losing the order', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const token = await makeAgent();
    const flatWhite = await getProductId('فلات وايت');

    // Drain the queue first so the claim below is guaranteed to pick up the
    // job this test creates, rather than an arbitrary batch of earlier ones.
    await pool.query("UPDATE print_jobs SET status = 'printed' WHERE status IN ('queued','claimed')");

    const order = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth(cashier),
      payload: {
        lines: [{ productId: flatWhite, quantity: 1 }],
        idempotencyKey: `retry-${Date.now()}`,
      },
    });
    const jobRow = await one<{ id: string }>(
      'SELECT id FROM print_jobs WHERE order_id = $1', [order.json().orderId],
    );

    await app.inject({
      method: 'POST', url: '/api/print-agent/claim',
      headers: { authorization: `Bearer ${token}` }, payload: { limit: 25 },
    });
    await app.inject({
      method: 'POST', url: '/api/print-agent/result',
      headers: { authorization: `Bearer ${token}` },
      payload: { jobId: jobRow!.id, success: false, error: 'printer offline' },
    });

    // The job returns to the queue for another attempt — it is never dropped.
    const after = await one<{ status: string; attempt_count: number; last_error: string }>(
      'SELECT status, attempt_count, last_error FROM print_jobs WHERE id = $1', [jobRow!.id],
    );
    expect(after!.status).toBe('queued');
    expect(after!.attempt_count).toBe(1);
    expect(after!.last_error).toBe('printer offline');

    // The printer is marked as unhealthy.
    const printer = await one<{ status: string }>(
      `SELECT p.status FROM printers p JOIN print_jobs j ON j.printer_id = p.id
        WHERE j.id = $1`, [jobRow!.id],
    );
    expect(printer!.status).toBe('error');
  });

  it('alerts the till once retries are exhausted', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const token = await makeAgent();
    const flatWhite = await getProductId('فلات وايت');

    const order = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth(cashier),
      payload: {
        lines: [{ productId: flatWhite, quantity: 1 }],
        idempotencyKey: `exhaust-${Date.now()}`,
      },
    });
    const jobRow = await one<{ id: string }>(
      'SELECT id FROM print_jobs WHERE order_id = $1', [order.json().orderId],
    );

    // Drive the attempt count to its maximum.
    await pool.query(
      'UPDATE print_jobs SET attempt_count = max_attempts WHERE id = $1', [jobRow!.id],
    );
    await app.inject({
      method: 'POST', url: '/api/print-agent/result',
      headers: { authorization: `Bearer ${token}` },
      payload: { jobId: jobRow!.id, success: false, error: 'no paper' },
    });

    const after = await one<{ status: string }>(
      'SELECT status FROM print_jobs WHERE id = $1', [jobRow!.id],
    );
    expect(after!.status).toBe('failed');

    const alert = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications
        WHERE kind = 'print_failed' AND entity_id = $1`, [jobRow!.id],
    );
    expect(alert!.n).toBe(1);

    // A supervisor can put it back in the queue.
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const retried = await app.inject({
      method: 'POST', url: `/api/print-jobs/${jobRow!.id}/retry`, headers: auth(manager),
    });
    expect(retried.statusCode).toBe(200);
    const requeued = await one<{ status: string; attempt_count: number }>(
      'SELECT status, attempt_count FROM print_jobs WHERE id = $1', [jobRow!.id],
    );
    expect(requeued!.status).toBe('queued');
    expect(requeued!.attempt_count).toBe(0);
  });

  it('two agents never receive the same job', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const tokenA = await makeAgent();
    const tokenB = await makeAgent();
    const flatWhite = await getProductId('فلات وايت');

    // Clear the queue, then add a known job.
    await pool.query("UPDATE print_jobs SET status = 'printed' WHERE status = 'queued'");
    await app.inject({
      method: 'POST', url: '/api/orders', headers: auth(cashier),
      payload: {
        lines: [{ productId: flatWhite, quantity: 1 }],
        idempotencyKey: `race-${Date.now()}`,
      },
    });

    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST', url: '/api/print-agent/claim',
        headers: { authorization: `Bearer ${tokenA}` }, payload: { limit: 25 },
      }),
      app.inject({
        method: 'POST', url: '/api/print-agent/claim',
        headers: { authorization: `Bearer ${tokenB}` }, payload: { limit: 25 },
      }),
    ]);

    const idsA = a.json().jobs.map((j: any) => j.id);
    const idsB = b.json().jobs.map((j: any) => j.id);
    const overlap = idsA.filter((id: string) => idsB.includes(id));
    expect(overlap).toHaveLength(0);
  });

  it('a heartbeat records printer health and returns the printer list', async () => {
    const app = await getApp();
    const token = await makeAgent();
    const printer = await one<{ id: string }>(
      "SELECT id FROM printers WHERE name = 'Bar Printer'",
    );

    const res = await app.inject({
      method: 'POST', url: '/api/print-agent/heartbeat',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        version: '1.0.0',
        printers: [{ id: printer!.id, reachable: true }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().printers.length).toBeGreaterThan(0);

    const status = await one<{ status: string; last_seen_at: Date }>(
      'SELECT status, last_seen_at FROM printers WHERE id = $1', [printer!.id],
    );
    expect(status!.status).toBe('online');
    expect(status!.last_seen_at).toBeTruthy();
  });
});

describe('financial records are never hard-deleted', () => {
  it('a voided payment survives as a record', async () => {
    const payment = await one<{ id: string }>('SELECT id FROM payments LIMIT 1');
    expect(payment).toBeTruthy();
    // The schema offers status transitions, not deletion, and the API exposes
    // no DELETE route for payments, orders, purchases or wallet transactions.
    const columns = await many<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'payments' AND column_name IN ('status','voided_at')`,
    );
    expect(columns).toHaveLength(2);
  });

  it('voided order items remain on the order', async () => {
    const voided = await one<{ n: number }>(
      "SELECT count(*)::int AS n FROM order_items WHERE status = 'voided'",
    );
    expect(voided!.n).toBeGreaterThan(0);
  });
});
