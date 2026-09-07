import { afterAll, describe, expect, it } from 'vitest';
import {
  auth, closeApp, getApp, getBranchId, getModifierOption, getProductId,
  loginEmployee, stockOf,
} from './helpers.js';
import { computeConsumption, projectUsage } from '../src/modules/inventory/recipe.service.js';

afterAll(closeApp);

/**
 * The specification's worked examples, verified end to end: modifier choices
 * must change what actually leaves the store, not merely what is written on
 * the ticket.
 */
describe('recipe engine', () => {
  it('شاي + سكر + نعناع مغربي consumes tea, sugar, Moroccan mint, water and a cup', async () => {
    const teaId = await getProductId('شاي');
    const sugar = await getModifierOption('سكر');
    const moroccan = await getModifierOption('نعناع مغربي');
    const branchId = await getBranchId();
    const { one } = await import('../src/core/db.js');
    const bar = await one<{ id: string }>(
      "SELECT id FROM inventory_locations WHERE code = 'BAR' AND branch_id = $1", [branchId],
    );

    const lines = await computeConsumption(teaId, null, [sugar, moroccan], 1, bar!.id);
    const byName = new Map(lines.map((l) => [l.itemName, l.quantity]));

    expect(byName.get('فتلة شاي')).toBe(1);
    expect(byName.get('سكر')).toBe(10);           // 10 g
    expect(byName.get('نعناع مغربي')).toBe(5);     // 5 g
    expect(byName.get('ماء')).toBe(200);
    expect(byName.get('كوب')).toBe(1);
    // Hassawi mint was not chosen, so it must not appear at all.
    expect(byName.has('نعناع حساوي')).toBe(false);
  });

  it('شاي بدون سكر + مكس نعناع consumes zero sugar and 2.5 g of each mint', async () => {
    const teaId = await getProductId('شاي');
    const noSugar = await getModifierOption('بدون سكر');
    const mintMix = await getModifierOption('مكس نعناع');
    const branchId = await getBranchId();
    const { one } = await import('../src/core/db.js');
    const bar = await one<{ id: string }>(
      "SELECT id FROM inventory_locations WHERE code = 'BAR' AND branch_id = $1", [branchId],
    );

    const lines = await computeConsumption(teaId, null, [noSugar, mintMix], 1, bar!.id);
    const byName = new Map(lines.map((l) => [l.itemName, l.quantity]));

    expect(byName.get('فتلة شاي')).toBe(1);
    // "بدون سكر" fires no line at all — sugar consumption is genuinely zero.
    expect(byName.get('سكر')).toBeUndefined();
    expect(byName.get('نعناع مغربي')).toBe(2.5);
    expect(byName.get('نعناع حساوي')).toBe(2.5);
    expect(byName.get('كوب')).toBe(1);
  });

  it('scales with quantity', async () => {
    const teaId = await getProductId('شاي');
    const sugar = await getModifierOption('سكر');
    const branchId = await getBranchId();
    const { one } = await import('../src/core/db.js');
    const bar = await one<{ id: string }>(
      "SELECT id FROM inventory_locations WHERE code = 'BAR' AND branch_id = $1", [branchId],
    );

    const lines = await computeConsumption(teaId, null, [sugar], 3, bar!.id);
    const byName = new Map(lines.map((l) => [l.itemName, l.quantity]));
    expect(byName.get('فتلة شاي')).toBe(3);
    expect(byName.get('سكر')).toBe(30);
    expect(byName.get('ماء')).toBe(600);
  });

  it('projects 100 flat whites as 1.8 kg of beans and 18 L of milk', async () => {
    const flatWhite = await getProductId('فلات وايت');
    const usage = await projectUsage(flatWhite, null, [], 100);
    const byName = new Map(usage.map((u) => [u.itemName, u]));

    // 18 g × 100 = 1800 g = 1.8 KG
    expect(byName.get('حبوب قهوة')!.quantity).toBe(1800);
    expect(byName.get('حبوب قهوة')!.unit).toBe('g');
    // 180 ml × 100 = 18000 ml = 18 L
    expect(byName.get('حليب')!.quantity).toBe(18000);
    expect(byName.get('كوب')!.quantity).toBe(100);
    expect(byName.get('غطاء كوب')!.quantity).toBe(100);
  });

  it('projects shisha tobacco and charcoal per head', async () => {
    const shisha = await getProductId('معسل تفاحتين');
    const usage = await projectUsage(shisha, null, [], 10);
    const byName = new Map(usage.map((u) => [u.itemName, u.quantity]));
    expect(byName.get('معسل تفاحتين')).toBe(200);   // 20 g × 10
    expect(byName.get('فحم')).toBe(70);             // 7 pieces × 10
  });
});

describe('recipe consumption actually moves stock', () => {
  it('selling tea with sugar draws down the exact ingredients', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const teaId = await getProductId('شاي');
    const sugar = await getModifierOption('سكر');
    const moroccan = await getModifierOption('نعناع مغربي');

    const before = {
      tea: await stockOf('ING-TEA'),
      sugar: await stockOf('ING-SUGAR'),
      moroccan: await stockOf('ING-MINT-MA'),
      hassawi: await stockOf('ING-MINT-HA'),
      cup: await stockOf('ING-CUP'),
    };

    const res = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth(cashier),
      payload: {
        lines: [{ productId: teaId, quantity: 2, modifierOptionIds: [sugar, moroccan] }],
        idempotencyKey: `recipe-test-${Date.now()}`,
      },
    });
    expect(res.statusCode).toBe(200);

    const after = {
      tea: await stockOf('ING-TEA'),
      sugar: await stockOf('ING-SUGAR'),
      moroccan: await stockOf('ING-MINT-MA'),
      hassawi: await stockOf('ING-MINT-HA'),
      cup: await stockOf('ING-CUP'),
    };

    expect(before.tea - after.tea).toBe(2);
    expect(before.sugar - after.sugar).toBe(20);        // 10 g × 2
    expect(before.moroccan - after.moroccan).toBe(10);  // 5 g × 2
    expect(before.cup - after.cup).toBe(2);
    // The mint that was NOT chosen is untouched.
    expect(after.hassawi).toBe(before.hassawi);
  });

  it('selling tea without sugar consumes no sugar at all', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const teaId = await getProductId('شاي');
    const noSugar = await getModifierOption('بدون سكر');
    const mintMix = await getModifierOption('مكس نعناع');

    const beforeSugar = await stockOf('ING-SUGAR');
    const beforeMa = await stockOf('ING-MINT-MA');
    const beforeHa = await stockOf('ING-MINT-HA');

    const res = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth(cashier),
      payload: {
        lines: [{ productId: teaId, quantity: 2, modifierOptionIds: [noSugar, mintMix] }],
        idempotencyKey: `recipe-nosugar-${Date.now()}`,
      },
    });
    expect(res.statusCode).toBe(200);

    expect(await stockOf('ING-SUGAR')).toBe(beforeSugar);        // unchanged
    expect(beforeMa - await stockOf('ING-MINT-MA')).toBe(5);     // 2.5 × 2
    expect(beforeHa - await stockOf('ING-MINT-HA')).toBe(5);     // 2.5 × 2
  });

  it('writes one ledger row per ingredient and never double-posts', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const flatWhite = await getProductId('فلات وايت');
    const { one, many } = await import('../src/core/db.js');

    const res = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth(cashier),
      payload: {
        lines: [{ productId: flatWhite, quantity: 1 }],
        idempotencyKey: `ledger-test-${Date.now()}`,
      },
    });
    const { orderId } = res.json();

    const rows = await many<{ item_name: string; quantity_delta: number }>(
      `SELECT ii.name_ar AS item_name, t.quantity_delta
         FROM inventory_transactions t JOIN inventory_items ii ON ii.id = t.item_id
        WHERE t.order_id = $1 AND t.txn_type = 'recipe_consumption'`,
      [orderId],
    );
    expect(rows).toHaveLength(4);   // beans, milk, cup, lid
    expect(rows.every((r) => r.quantity_delta < 0)).toBe(true);

    // The order item is stamped, so a retry cannot consume twice.
    const stamped = await one<{ consumption_posted_at: Date | null }>(
      'SELECT consumption_posted_at FROM order_items WHERE order_id = $1', [orderId],
    );
    expect(stamped!.consumption_posted_at).not.toBeNull();
  });
});
