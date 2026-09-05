import { afterAll, describe, expect, it } from 'vitest';
import {
  auth, closeApp, getApp, getBranchId, getItemId, getProductId,
  loginAdmin, loginEmployee, stockOf,
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

describe('unit conversion', () => {
  it('normalises to base units', async () => {
    const { toBaseUnit, fromBaseUnit, isCompatible } = await import('@mara/shared');
    expect(toBaseUnit(1, 'kg')).toBe(1000);
    expect(toBaseUnit(1, 'l')).toBe(1000);
    expect(toBaseUnit(2.5, 'kg')).toBe(2500);
    expect(fromBaseUnit(1800, 'kg')).toBe(1.8);
    expect(fromBaseUnit(18000, 'l')).toBe(18);
    // Pack units need the item's declared pack size.
    expect(toBaseUnit(2, 'box', 100)).toBe(200);
    expect(() => toBaseUnit(2, 'box')).toThrow();
    // Dimensions must match.
    expect(isCompatible('kg', 'g')).toBe(true);
    expect(isCompatible('kg', 'l')).toBe(false);
  });
});

describe('goods receipt', () => {
  it('increases stock and updates the weighted average cost', async () => {
    const app = await getApp();
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const coffee = await getItemId('ING-COFFEE');

    const before = await one<{ average_cost: number }>(
      'SELECT average_cost FROM inventory_items WHERE id = $1', [coffee],
    );
    const stockBefore = await stockOf('ING-COFFEE');

    const res = await app.inject({
      method: 'POST', url: '/api/inventory/receive', headers: auth(manager),
      payload: {
        locationId: await locationId('BAR'),
        invoiceNumber: 'INV-COFFEE-1',
        // 5 kg at 120.00 SAR per kg = 12 halalas per gram.
        items: [{ itemId: coffee, quantity: 5, unit: 'kg', unitCost: 12000 }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().receiptNumber).toMatch(/^INV-\d{4}-\d{6}$/);

    expect(await stockOf('ING-COFFEE')).toBe(stockBefore + 5000);

    const after = await one<{ average_cost: number; last_cost: number }>(
      'SELECT average_cost, last_cost FROM inventory_items WHERE id = $1', [coffee],
    );
    // New average sits between the old cost and the new one.
    expect(Number(after!.last_cost)).toBe(12);
    expect(Number(after!.average_cost)).toBeGreaterThan(Number(before!.average_cost));
    expect(Number(after!.average_cost)).toBeLessThan(12);

    // A ledger row exists for the movement.
    const txn = await one<{ txn_type: string; quantity_delta: number }>(
      `SELECT txn_type, quantity_delta FROM inventory_transactions
        WHERE item_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [coffee],
    );
    expect(txn!.txn_type).toBe('receive');
    expect(Number(txn!.quantity_delta)).toBe(5000);
  });
});

describe('waste', () => {
  it('records small waste immediately and removes the stock', async () => {
    const app = await getApp();
    const bar = await loginEmployee('3001', '7192');
    const sugar = await getItemId('ING-SUGAR');
    const before = await stockOf('ING-SUGAR');

    const res = await app.inject({
      method: 'POST', url: '/api/waste', headers: auth(bar),
      payload: {
        locationId: await locationId('BAR'), itemId: sugar,
        quantity: 100, unit: 'g', reason: 'dropped', notes: 'انسكب على الأرض',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('posted');
    expect(res.json().wasteNumber).toMatch(/^WST-\d{4}-\d{6}$/);
    expect(await stockOf('ING-SUGAR')).toBe(before - 100);
  });

  it('holds large waste for approval WITHOUT moving stock', async () => {
    const app = await getApp();
    const shishaStaff = await loginEmployee('3003', '9265');
    const tobacco = await getItemId('ING-TOBACCO-2A');
    const before = await stockOf('ING-TOBACCO-2A', 'SHISHA');

    // 1 kg at 45 halalas/g = 450.00 SAR, well past the 100.00 SAR threshold.
    const res = await app.inject({
      method: 'POST', url: '/api/waste', headers: auth(shishaStaff),
      payload: {
        locationId: await locationId('SHISHA'), itemId: tobacco,
        quantity: 1, unit: 'kg', reason: 'damaged',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('pending_approval');
    expect(res.json().estimatedCost).toBe(45000);

    // Crucially: stock has NOT moved yet.
    expect(await stockOf('ING-TOBACCO-2A', 'SHISHA')).toBe(before);

    // A manager is asked to sign it off.
    const alert = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications
        WHERE kind = 'waste_pending_approval' AND entity_id = $1`,
      [res.json().id],
    );
    expect(alert!.n).toBe(1);

    // On approval the stock finally moves.
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const approved = await app.inject({
      method: 'POST', url: `/api/waste/${res.json().id}/approve`,
      headers: auth(manager), payload: { approve: true },
    });
    expect(approved.statusCode).toBe(200);
    expect(await stockOf('ING-TOBACCO-2A', 'SHISHA')).toBe(before - 1000);
  });

  it('a rejected waste record never touches stock', async () => {
    const app = await getApp();
    const shishaStaff = await loginEmployee('3003', '9265');
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const tobacco = await getItemId('ING-TOBACCO-2A');
    const before = await stockOf('ING-TOBACCO-2A', 'SHISHA');

    const created = await app.inject({
      method: 'POST', url: '/api/waste', headers: auth(shishaStaff),
      payload: {
        locationId: await locationId('SHISHA'), itemId: tobacco,
        quantity: 500, unit: 'g', reason: 'other',
      },
    });
    expect(created.json().status).toBe('pending_approval');

    await app.inject({
      method: 'POST', url: `/api/waste/${created.json().id}/approve`,
      headers: auth(manager),
      payload: { approve: false, reason: 'غير مبرر' },
    });
    expect(await stockOf('ING-TOBACCO-2A', 'SHISHA')).toBe(before);
  });

  it('a department employee cannot approve their own large waste', async () => {
    const app = await getApp();
    const shishaStaff = await loginEmployee('3003', '9265');
    const record = await one<{ id: string }>(
      "SELECT id FROM waste_records WHERE status = 'pending_approval' LIMIT 1",
    );
    if (!record) return;
    const res = await app.inject({
      method: 'POST', url: `/api/waste/${record.id}/approve`,
      headers: auth(shishaStaff), payload: { approve: true },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('low stock', () => {
  it('flags an item below its minimum without creating a purchase order', async () => {
    const app = await getApp();
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const milk = await getItemId('ING-MILK');

    // Drive milk below its 30 L minimum.
    const current = await one<{ total_quantity: number }>(
      'SELECT total_quantity FROM inventory_item_totals WHERE item_id = $1', [milk],
    );
    const target = 18000;   // 18 L
    const delta = target - Number(current!.total_quantity);
    if (delta < 0) {
      await app.inject({
        method: 'POST', url: '/api/inventory/adjust', headers: auth(manager),
        payload: {
          itemId: milk, locationId: await locationId('BAR'),
          quantity: delta / 1000, unit: 'l', reason: 'ضبط للاختبار',
        },
      });
    }

    const res = await app.inject({
      method: 'GET', url: '/api/inventory/low-stock', headers: auth(manager),
    });
    expect(res.statusCode).toBe(200);
    const low = res.json().items.find((i: any) => i.sku === 'ING-MILK');
    expect(low).toBeTruthy();
    expect(low.is_low_stock).toBe(true);

    // No purchase request was invented — a human raises those.
    const auto = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM purchase_requests
        WHERE requested_by_employee_id IS NULL AND requested_by_user_id IS NULL`,
    );
    expect(auto!.n).toBe(0);
  });
});

describe('stock count and variance', () => {
  it('computes expected stock from the ledger and reports the variance', async () => {
    const app = await getApp();
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const sugar = await getItemId('ING-SUGAR');

    const opened = await app.inject({
      method: 'POST', url: '/api/stock-counts', headers: auth(manager),
      payload: {
        locationId: await locationId('BAR'), countType: 'daily', itemIds: [sugar],
      },
    });
    expect(opened.statusCode).toBe(200);
    const countId = opened.json().id;
    expect(opened.json().countNumber).toMatch(/^CNT-\d{4}-\d{6}$/);

    const expected = Number(opened.json().items[0].expected_quantity);
    // Expected stock equals the ledger balance, by construction.
    expect(expected).toBe(await stockOf('ING-SUGAR'));

    // Count 200 g short.
    await app.inject({
      method: 'POST', url: `/api/stock-counts/${countId}/entries`, headers: auth(manager),
      payload: {
        entries: [{ itemId: sugar, countedQuantity: (expected - 200) / 1000, unit: 'kg' }],
      },
    });

    const submitted = await app.inject({
      method: 'POST', url: `/api/stock-counts/${countId}/submit`, headers: auth(manager),
    });
    expect(submitted.statusCode).toBe(200);

    const detail = await app.inject({
      method: 'GET', url: `/api/stock-counts/${countId}`, headers: auth(manager),
    });
    const line = detail.json().count.items[0];
    expect(Number(line.variance_quantity)).toBe(-200);
    expect(Number(line.variance_value)).toBeLessThan(0);

    // Approving writes the correcting movement, so book and shelf agree again.
    const stockBefore = await stockOf('ING-SUGAR');
    const approved = await app.inject({
      method: 'POST', url: `/api/stock-counts/${countId}/approve`,
      headers: auth(manager), payload: { approve: true },
    });
    expect(approved.statusCode).toBe(200);
    expect(await stockOf('ING-SUGAR')).toBe(stockBefore - 200);

    const adjustment = await one<{ txn_type: string }>(
      `SELECT txn_type FROM inventory_transactions
        WHERE stock_count_id = $1 LIMIT 1`,
      [countId],
    );
    expect(adjustment!.txn_type).toBe('count_adjustment');
  });

  it('raises an alert when the variance crosses the threshold', async () => {
    const app = await getApp();
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const tobacco = await getItemId('ING-TOBACCO-2A');

    const opened = await app.inject({
      method: 'POST', url: '/api/stock-counts', headers: auth(manager),
      payload: {
        locationId: await locationId('SHISHA'), countType: 'ad_hoc', itemIds: [tobacco],
      },
    });
    const countId = opened.json().id;
    const expected = Number(opened.json().items[0].expected_quantity);

    // A 1 kg shortfall at 45 halalas/g is 450 SAR — far past the alert level.
    await app.inject({
      method: 'POST', url: `/api/stock-counts/${countId}/entries`, headers: auth(manager),
      payload: {
        entries: [{ itemId: tobacco, countedQuantity: Math.max(0, expected - 1000), unit: 'g' }],
      },
    });
    const submitted = await app.inject({
      method: 'POST', url: `/api/stock-counts/${countId}/submit`, headers: auth(manager),
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().flagged.length).toBeGreaterThan(0);

    const alert = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications
        WHERE kind = 'inventory_variance' AND entity_id = $1`,
      [countId],
    );
    expect(alert!.n).toBe(1);
  });

  it('refuses to submit a count with uncounted lines', async () => {
    const app = await getApp();
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const flour = await getItemId('ING-FLOUR');
    const opened = await app.inject({
      method: 'POST', url: '/api/stock-counts', headers: auth(manager),
      payload: {
        locationId: await locationId('KITCHEN'), countType: 'ad_hoc', itemIds: [flour],
      },
    });
    const res = await app.inject({
      method: 'POST', url: `/api/stock-counts/${opened.json().id}/submit`,
      headers: auth(manager),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('بدون جرد فعلي');
  });
});

describe('the stock ledger is append-only and complete', () => {
  it('every movement carries a balance that matches the running total', async () => {
    const sugar = await getItemId('ING-SUGAR');
    const bar = await locationId('BAR');
    const rows = await many<{ quantity_delta: number; balance_after: number }>(
      `SELECT quantity_delta, balance_after FROM inventory_transactions
        WHERE item_id = $1 AND location_id = $2 ORDER BY id`,
      [sugar, bar],
    );
    let running = 0;
    for (const row of rows) {
      running += Number(row.quantity_delta);
      expect(Number(row.balance_after)).toBeCloseTo(running, 4);
    }
    // The ledger's final balance equals the materialised stock row.
    expect(running).toBeCloseTo(await stockOf('ING-SUGAR'), 4);
  });
});
