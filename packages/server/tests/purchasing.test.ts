import { afterAll, describe, expect, it } from 'vitest';
import {
  auth, closeApp, getApp, getBranchId, getItemId, loginAdmin, loginEmployee, stockOf,
} from './helpers.js';
import { many, one, pool } from '../src/core/db.js';

afterAll(closeApp);

async function locationId(code: string): Promise<string> {
  const l = await one<{ id: string }>(
    'SELECT id FROM inventory_locations WHERE code = $1 AND branch_id = $2',
    [code, await getBranchId()],
  );
  return l!.id;
}

/**
 * The purchasing cycle from the specification: the bar sees milk running low,
 * raises a request for 60 L, the branch manager approves only 40 L, and the
 * purchasing rep sees 40 L — and never saw the request before approval.
 */
describe('purchase request lifecycle', () => {
  it('the buyer CANNOT see a request before the manager approves it', async () => {
    const app = await getApp();
    const bar = await loginEmployee('3001', '7192');
    const buyer = await loginEmployee('4001', '3648');
    const milk = await getItemId('ING-MILK');

    const created = await app.inject({
      method: 'POST', url: '/api/purchase-requests', headers: auth(bar),
      payload: {
        department: 'BAR', reason: 'Low Stock', submit: true,
        items: [{ itemId: milk, quantity: 60, unit: 'l' }],
      },
    });
    expect(created.statusCode).toBe(200);
    const { id: requestId, requestNumber, status } = created.json();
    expect(status).toBe('pending_branch_manager');

    // The buyer's queue does not contain it.
    const queue = await app.inject({
      method: 'GET', url: '/api/buyer/requests', headers: auth(buyer),
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().requests.some((r: any) => r.id === requestId)).toBe(false);

    // Nor can the buyer fetch it directly by id.
    const direct = await app.inject({
      method: 'GET', url: `/api/purchase-requests/${requestId}`, headers: auth(buyer),
    });
    expect(direct.statusCode).toBe(404);

    // Nor does it appear in the aggregated shopping list.
    const list = await app.inject({
      method: 'GET', url: '/api/buyer/shopping-list', headers: auth(buyer),
    });
    const milkRow = list.json().items.find((i: any) => i.sku === 'ING-MILK');
    const inList = milkRow?.breakdown?.some((b: any) => b.requestNumber === requestNumber);
    expect(inList ?? false).toBe(false);

    // Nor is it counted in the buyer's summary.
    const summary = await app.inject({
      method: 'GET', url: '/api/buyer/summary', headers: auth(buyer),
    });
    expect(summary.json().to_start).toBe(0);
  });

  it('the manager cuts 60 L to 40 L and the buyer sees only 40 L', async () => {
    const app = await getApp();
    const bar = await loginEmployee('3001', '7192');
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const buyer = await loginEmployee('4001', '3648');
    const milk = await getItemId('ING-MILK');

    const created = await app.inject({
      method: 'POST', url: '/api/purchase-requests', headers: auth(bar),
      payload: {
        department: 'BAR', reason: 'Low Stock', submit: true,
        items: [{ itemId: milk, quantity: 60, unit: 'l' }],
      },
    });
    const requestId = created.json().id;

    const decided = await app.inject({
      method: 'POST', url: `/api/purchase-requests/${requestId}/decide`,
      headers: auth(manager),
      payload: {
        decision: 'approve',
        comment: 'الكمية المطلوبة كبيرة، 40 لتر تكفي',
        itemQuantities: [{ itemId: milk, approvedQuantity: 40, unit: 'l' }],
      },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe('approved');

    // Now — and only now — the buyer can see it.
    const queue = await app.inject({
      method: 'GET', url: '/api/buyer/requests', headers: auth(buyer),
    });
    const visible = queue.json().requests.find((r: any) => r.id === requestId);
    expect(visible).toBeTruthy();

    // And the quantity shown is the APPROVED 40 L (40 000 ml in base units),
    // never the 60 L that was asked for.
    expect(Number(visible.items[0].approved_quantity)).toBe(40000);
    expect(visible.items[0].requested_quantity).toBeUndefined();

    // The manager's view keeps both figures for the audit trail.
    const managerView = await app.inject({
      method: 'GET', url: `/api/purchase-requests/${requestId}`, headers: auth(manager),
    });
    const item = managerView.json().request.items[0];
    expect(Number(item.requested_quantity)).toBe(60000);
    expect(Number(item.approved_quantity)).toBe(40000);

    // The change is recorded as an approval decision.
    const approval = await one<{ quantity_changes: any }>(
      "SELECT quantity_changes FROM purchase_approvals WHERE request_id = $1 AND decision = 'approved'",
      [requestId],
    );
    expect(approval!.quantity_changes[0].requested).toBe(60000);
    expect(approval!.quantity_changes[0].approved).toBe(40000);
  });

  it('the buyer CANNOT purchase more than was approved', async () => {
    const app = await getApp();
    const bar = await loginEmployee('3001', '7192');
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const buyer = await loginEmployee('4001', '3648');
    const milk = await getItemId('ING-MILK');

    const created = await app.inject({
      method: 'POST', url: '/api/purchase-requests', headers: auth(bar),
      payload: {
        department: 'BAR', submit: true,
        items: [{ itemId: milk, quantity: 60, unit: 'l' }],
      },
    });
    const requestId = created.json().id;
    await app.inject({
      method: 'POST', url: `/api/purchase-requests/${requestId}/decide`,
      headers: auth(manager),
      payload: {
        decision: 'approve',
        itemQuantities: [{ itemId: milk, approvedQuantity: 40, unit: 'l' }],
      },
    });

    // Attempt to buy the original 60 L against a 40 L approval.
    const over = await app.inject({
      method: 'POST', url: `/api/buyer/requests/${requestId}/purchase`,
      headers: auth(buyer),
      payload: { items: [{ itemId: milk, quantity: 60, unit: 'l', unitPrice: 600 }] },
    });
    expect(over.statusCode).toBe(422);
    expect(over.json().error.message).toContain('تتجاوز المعتمد');

    // Nothing was recorded.
    const purchases = await many('SELECT id FROM purchases WHERE request_id = $1', [requestId]);
    expect(purchases).toHaveLength(0);

    // Buying exactly the approved amount succeeds.
    const ok = await app.inject({
      method: 'POST', url: `/api/buyer/requests/${requestId}/purchase`,
      headers: auth(buyer),
      payload: {
        invoiceNumber: 'INV-9911',
        items: [{ itemId: milk, quantity: 40, unit: 'l', unitPrice: 600 }],
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().purchaseNumber).toMatch(/^PO-\d{4}-\d{6}$/);
  });

  it('a buyer asking for more sends the request back to the manager', async () => {
    const app = await getApp();
    const bar = await loginEmployee('3001', '7192');
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const buyer = await loginEmployee('4001', '3648');
    const milk = await getItemId('ING-MILK');

    const created = await app.inject({
      method: 'POST', url: '/api/purchase-requests', headers: auth(bar),
      payload: {
        department: 'BAR', submit: true,
        items: [{ itemId: milk, quantity: 40, unit: 'l' }],
      },
    });
    const requestId = created.json().id;
    await app.inject({
      method: 'POST', url: `/api/purchase-requests/${requestId}/decide`,
      headers: auth(manager),
      payload: {
        decision: 'approve',
        itemQuantities: [{ itemId: milk, approvedQuantity: 40, unit: 'l' }],
      },
    });

    const change = await app.inject({
      method: 'POST', url: `/api/buyer/requests/${requestId}/request-change`,
      headers: auth(buyer),
      payload: {
        changes: [{
          itemId: milk, requestedQuantity: 60, unit: 'l',
          reason: 'العرض على 60 لتر أرخص للتر',
        }],
      },
    });
    expect(change.statusCode).toBe(200);

    // Back with the manager, and out of the buyer's queue again.
    const status = await one<{ status: string }>(
      'SELECT status FROM purchase_requests WHERE id = $1', [requestId],
    );
    expect(status!.status).toBe('pending_branch_manager');

    const queue = await app.inject({
      method: 'GET', url: '/api/buyer/requests', headers: auth(buyer),
    });
    expect(queue.json().requests.some((r: any) => r.id === requestId)).toBe(false);

    // The manager grants the increase, and only then may the buyer buy 60 L.
    await app.inject({
      method: 'POST', url: `/api/purchase-requests/${requestId}/decide`,
      headers: auth(manager),
      payload: {
        decision: 'approve',
        itemQuantities: [{ itemId: milk, approvedQuantity: 60, unit: 'l' }],
      },
    });
    const ok = await app.inject({
      method: 'POST', url: `/api/buyer/requests/${requestId}/purchase`,
      headers: auth(buyer),
      payload: { items: [{ itemId: milk, quantity: 60, unit: 'l', unitPrice: 580 }] },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('a rejected request never becomes visible to the buyer', async () => {
    const app = await getApp();
    const bar = await loginEmployee('3001', '7192');
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const buyer = await loginEmployee('4001', '3648');
    const milk = await getItemId('ING-MILK');

    const created = await app.inject({
      method: 'POST', url: '/api/purchase-requests', headers: auth(bar),
      payload: {
        department: 'BAR', submit: true,
        items: [{ itemId: milk, quantity: 100, unit: 'l' }],
      },
    });
    const requestId = created.json().id;

    const rejected = await app.inject({
      method: 'POST', url: `/api/purchase-requests/${requestId}/decide`,
      headers: auth(manager),
      payload: { decision: 'reject', comment: 'الكمية غير مبررة' },
    });
    expect(rejected.json().status).toBe('rejected');

    const queue = await app.inject({
      method: 'GET', url: '/api/buyer/requests', headers: auth(buyer),
    });
    expect(queue.json().requests.some((r: any) => r.id === requestId)).toBe(false);

    const direct = await app.inject({
      method: 'GET', url: `/api/purchase-requests/${requestId}`, headers: auth(buyer),
    });
    expect(direct.statusCode).toBe(404);
  });

  it('a rejection requires a reason', async () => {
    const app = await getApp();
    const bar = await loginEmployee('3001', '7192');
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const milk = await getItemId('ING-MILK');
    const created = await app.inject({
      method: 'POST', url: '/api/purchase-requests', headers: auth(bar),
      payload: {
        department: 'BAR', submit: true,
        items: [{ itemId: milk, quantity: 10, unit: 'l' }],
      },
    });
    const res = await app.inject({
      method: 'POST', url: `/api/purchase-requests/${created.json().id}/decide`,
      headers: auth(manager), payload: { decision: 'reject' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('the buyer cannot approve their own requests', async () => {
    const app = await getApp();
    const buyer = await loginEmployee('4001', '3648');
    const request = await one<{ id: string }>(
      "SELECT id FROM purchase_requests WHERE status = 'pending_branch_manager' LIMIT 1",
    );
    if (!request) return;
    const res = await app.inject({
      method: 'POST', url: `/api/purchase-requests/${request.id}/decide`,
      headers: auth(buyer), payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('aggregates the same item across departments while keeping the split', async () => {
    const app = await getApp();
    const bar = await loginEmployee('3001', '7192');
    const kitchen = await loginEmployee('3002', '6473');
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const buyer = await loginEmployee('4001', '3648');
    const milk = await getItemId('ING-MILK');

    // Clear prior state so the aggregate is unambiguous.
    await pool.query(
      `UPDATE purchase_requests SET status = 'closed'
        WHERE status IN ('approved','sent_to_buyer','purchasing')`,
    );

    for (const [session, dept, qty] of [
      [bar, 'BAR', 20], [kitchen, 'KITCHEN', 10],
    ] as const) {
      const created = await app.inject({
        method: 'POST', url: '/api/purchase-requests', headers: auth(session),
        payload: {
          department: dept, submit: true,
          items: [{ itemId: milk, quantity: qty, unit: 'l' }],
        },
      });
      await app.inject({
        method: 'POST', url: `/api/purchase-requests/${created.json().id}/decide`,
        headers: auth(manager),
        payload: {
          decision: 'approve',
          itemQuantities: [{ itemId: milk, approvedQuantity: qty, unit: 'l' }],
        },
      });
    }

    const list = await app.inject({
      method: 'GET', url: '/api/buyer/shopping-list', headers: auth(buyer),
    });
    const milkRow = list.json().items.find((i: any) => i.sku === 'ING-MILK');
    expect(milkRow).toBeTruthy();
    // 20 L + 10 L = 30 L total, with the per-department split preserved.
    expect(Number(milkRow.total_quantity)).toBe(30000);
    const byDept = new Map(
      milkRow.breakdown.map((b: any) => [b.department, Number(b.quantity)]),
    );
    expect(byDept.get('BAR')).toBe(20000);
    expect(byDept.get('KITCHEN')).toBe(10000);
  });

  it('stock only moves when the department confirms receipt', async () => {
    const app = await getApp();
    const bar = await loginEmployee('3001', '7192');
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const buyer = await loginEmployee('4001', '3648');
    const milk = await getItemId('ING-MILK');

    const created = await app.inject({
      method: 'POST', url: '/api/purchase-requests', headers: auth(bar),
      payload: {
        department: 'BAR', submit: true,
        items: [{ itemId: milk, quantity: 40, unit: 'l' }],
      },
    });
    const requestId = created.json().id;
    await app.inject({
      method: 'POST', url: `/api/purchase-requests/${requestId}/decide`,
      headers: auth(manager),
      payload: {
        decision: 'approve',
        itemQuantities: [{ itemId: milk, approvedQuantity: 40, unit: 'l' }],
      },
    });

    const stockBefore = await stockOf('ING-MILK', 'BAR');

    // The buyer walks the whole status flow...
    await app.inject({
      method: 'POST', url: `/api/buyer/requests/${requestId}/purchase`,
      headers: auth(buyer),
      payload: {
        invoiceNumber: 'INV-7788',
        items: [{ itemId: milk, quantity: 40, unit: 'l', unitPrice: 620 }],
      },
    });
    for (const status of ['purchased', 'in_transit', 'delivered'] as const) {
      const res = await app.inject({
        method: 'POST', url: `/api/buyer/requests/${requestId}/status`,
        headers: auth(buyer), payload: { status },
      });
      expect(res.statusCode).toBe(200);
    }

    // ...and still, on the buyer's word alone, no stock has moved.
    expect(await stockOf('ING-MILK', 'BAR')).toBe(stockBefore);

    // The department confirms, and only now does stock increase.
    const received = await app.inject({
      method: 'POST', url: `/api/purchase-requests/${requestId}/receive`,
      headers: auth(bar),
      payload: {
        locationId: await locationId('BAR'),
        items: [{ itemId: milk, receivedQuantity: 40, unit: 'l' }],
      },
    });
    expect(received.statusCode).toBe(200);
    expect(await stockOf('ING-MILK', 'BAR')).toBe(stockBefore + 40000);
    expect(received.json().discrepancies).toHaveLength(0);
  });

  it('surfaces a discrepancy when less arrives than was bought', async () => {
    const app = await getApp();
    const bar = await loginEmployee('3001', '7192');
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const buyer = await loginEmployee('4001', '3648');
    const milk = await getItemId('ING-MILK');

    const created = await app.inject({
      method: 'POST', url: '/api/purchase-requests', headers: auth(bar),
      payload: {
        department: 'BAR', submit: true,
        items: [{ itemId: milk, quantity: 20, unit: 'l' }],
      },
    });
    const requestId = created.json().id;
    await app.inject({
      method: 'POST', url: `/api/purchase-requests/${requestId}/decide`,
      headers: auth(manager),
      payload: {
        decision: 'approve',
        itemQuantities: [{ itemId: milk, approvedQuantity: 20, unit: 'l' }],
      },
    });
    await app.inject({
      method: 'POST', url: `/api/buyer/requests/${requestId}/purchase`,
      headers: auth(buyer),
      payload: { items: [{ itemId: milk, quantity: 20, unit: 'l', unitPrice: 600 }] },
    });
    for (const status of ['purchased', 'in_transit', 'delivered'] as const) {
      await app.inject({
        method: 'POST', url: `/api/buyer/requests/${requestId}/status`,
        headers: auth(buyer), payload: { status },
      });
    }

    // Only 18 L actually turns up.
    const received = await app.inject({
      method: 'POST', url: `/api/purchase-requests/${requestId}/receive`,
      headers: auth(bar),
      payload: {
        locationId: await locationId('BAR'),
        items: [{ itemId: milk, receivedQuantity: 18, unit: 'l' }],
      },
    });
    expect(received.statusCode).toBe(200);
    const [discrepancy] = received.json().discrepancies;
    expect(discrepancy.purchased).toBe(20000);
    expect(discrepancy.received).toBe(18000);
    expect(discrepancy.difference).toBe(-2000);

    // ...and it is raised for a human to look at.
    const alert = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications
        WHERE kind = 'purchase_discrepancy' AND entity_id = $1`,
      [requestId],
    );
    expect(alert!.n).toBe(1);
  });

  it('records supplier price history for the buyer to consult', async () => {
    const app = await getApp();
    const buyer = await loginEmployee('4001', '3648');
    const milk = await getItemId('ING-MILK');

    const res = await app.inject({
      method: 'GET', url: `/api/suppliers/prices/${milk}`, headers: auth(buyer),
    });
    expect(res.statusCode).toBe(200);
    // History accumulates from real purchases, and last/average/lowest are
    // offered as information — the system never picks a supplier by itself.
    expect(res.json().summary).toHaveProperty('last_price');
    expect(res.json().summary).toHaveProperty('average_price');
    expect(res.json().summary).toHaveProperty('lowest_price');
  });

  it('writes every step of the cycle to the audit log', async () => {
    const actions = await many<{ action: string }>(
      `SELECT DISTINCT action FROM audit_logs WHERE action LIKE 'purchase%'`,
    );
    const names = actions.map((a) => a.action);
    expect(names).toContain('purchase_request.submitted');
    expect(names).toContain('purchase_request.approved');
    expect(names).toContain('purchase_request.rejected');
    expect(names).toContain('purchase_request.quantity_changed');
    expect(names).toContain('purchase_request.change_requested');
    expect(names).toContain('purchase.recorded');
    expect(names).toContain('purchase.received');
  });
});
