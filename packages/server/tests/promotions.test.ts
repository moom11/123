import { afterAll, describe, expect, test } from 'vitest';
import {
  auth, authAtTill, closeApp, getApp, getBranchId, loginAdmin, loginEmployee,
} from './helpers.js';
import { many, one, pool } from '../src/core/db.js';
import { evaluate, isLive, localParts } from '../src/modules/promotions/engine.js';
import type { BasketLine, PromotionRule } from '../src/modules/promotions/engine.js';

const OWNER = { email: 'owner@maralounge.sa', password: 'MaraOwner#2026Xy' };

afterAll(async () => { await closeApp(); });

async function ownerHeaders(): Promise<Record<string, string>> {
  const session = await loginAdmin(OWNER.email, OWNER.password);
  return { ...auth(session), 'x-branch-id': await getBranchId() };
}

/** A rule with sensible defaults, so each test states only what it is about. */
function rule(over: Partial<PromotionRule> = {}): PromotionRule {
  return {
    id: over.id ?? 'p1', nameAr: 'عرض', kind: 'percent', value: 1000,
    buyQuantity: null, getQuantity: null,
    productIds: [], categoryIds: [], comboQuantities: new Map(),
    minBasket: 0, maxDiscount: 0, priority: 100, isStackable: false,
    ...over,
  };
}

function line(over: Partial<BasketLine> = {}): BasketLine {
  return {
    id: over.id ?? 'l1', productId: over.productId ?? 'prod-a',
    categoryId: over.categoryId ?? 'cat-a',
    quantity: 1, unitPrice: 10_000, existingDiscount: 0,
    ...over,
  };
}

describe('the arithmetic', () => {
  test('a percentage comes off the qualifying lines', () => {
    const [award] = evaluate([line({ unitPrice: 10_000, quantity: 2 })],
      [rule({ kind: 'percent', value: 1500 })]);
    // 200.00 riyals at 15% = 30.00.
    expect(award!.amount).toBe(3_000);
  });

  test('a fixed amount never exceeds what the basket is worth', () => {
    // A 50 riyal voucher on a 30 riyal basket takes 30, not 50 and a
    // negative bill.
    const [award] = evaluate([line({ unitPrice: 3_000 })],
      [rule({ kind: 'amount', value: 5_000 })]);
    expect(award!.amount).toBe(3_000);
  });

  test('the per-line parts sum to exactly the promotion total', () => {
    // Three lines that do not divide evenly — the case where a naive split
    // loses a halala and the bill stops adding up.
    const lines = [
      line({ id: 'a', unitPrice: 3_333 }),
      line({ id: 'b', unitPrice: 3_333 }),
      line({ id: 'c', unitPrice: 3_334 }),
    ];
    const [award] = evaluate(lines, [rule({ kind: 'percent', value: 3_333 })]);
    const summed = award!.perLine.reduce((s, p) => s + p.amount, 0);
    expect(summed).toBe(award!.amount);
  });

  test('a line is never discounted twice by two stacked promotions', () => {
    const awards = evaluate([line({ unitPrice: 10_000 })], [
      rule({ id: 'a', kind: 'percent', value: 5_000, isStackable: true, priority: 1 }),
      rule({ id: 'b', kind: 'percent', value: 5_000, isStackable: true, priority: 2 }),
    ]);
    // 50% of 100 is 50; the second sees 50 left and takes 25. Total 75, not
    // 100 — the line cannot go below zero, and cannot be discounted on value
    // already given away.
    expect(awards[0]!.amount).toBe(5_000);
    expect(awards[1]!.amount).toBe(2_500);
    expect(awards.reduce((s, a) => s + a.amount, 0)).toBeLessThan(10_000);
  });

  test('a non-stackable promotion ends the chain', () => {
    const awards = evaluate([line()], [
      rule({ id: 'a', priority: 1, isStackable: false }),
      rule({ id: 'b', priority: 2, isStackable: true }),
    ]);
    expect(awards.length).toBe(1);
    expect(awards[0]!.promotionId).toBe('a');
  });

  test('an existing discount is respected, not discounted again', () => {
    // A special price already took 40 off a 100 line. 50% applies to the 60
    // that is left, not to the original 100.
    const [award] = evaluate(
      [line({ unitPrice: 10_000, existingDiscount: 4_000 })],
      [rule({ kind: 'percent', value: 5_000 })],
    );
    expect(award!.amount).toBe(3_000);
  });

  test('buy one get one frees the CHEAPEST units', () => {
    const lines = [
      line({ id: 'cheap', unitPrice: 2_000, quantity: 2 }),
      line({ id: 'dear', unitPrice: 8_000, quantity: 2 }),
    ];
    const [award] = evaluate(lines,
      [rule({ kind: 'buy_x_get_y', buyQuantity: 1, getQuantity: 1 })]);
    // Four units, two sets of (buy 1 get 1) — the two cheapest are free.
    expect(award!.amount).toBe(4_000);
  });

  test('a set price does not mark up a line that is already cheaper', () => {
    const lines = [
      line({ id: 'dear', unitPrice: 3_000 }),
      line({ id: 'cheap', unitPrice: 1_000 }),
    ];
    const [award] = evaluate(lines, [rule({ kind: 'item_price', value: 2_000 })]);
    // Only the 30 riyal line drops to 20. The 10 riyal one is untouched.
    expect(award!.amount).toBe(1_000);
  });

  test('a combo needs every product present', () => {
    const combo = rule({
      kind: 'combo', value: 5_000,
      productIds: ['burger', 'fries'],
      comboQuantities: new Map([['burger', 1], ['fries', 1]]),
    });
    const incomplete = evaluate(
      [line({ id: 'b', productId: 'burger', unitPrice: 4_000 })], [combo],
    );
    expect(incomplete).toEqual([]);

    const complete = evaluate([
      line({ id: 'b', productId: 'burger', unitPrice: 4_000 }),
      line({ id: 'f', productId: 'fries', unitPrice: 2_000 }),
    ], [combo]);
    // 60 riyals of food for 50.
    expect(complete[0]!.amount).toBe(1_000);
  });

  test('a ceiling caps what one promotion can give away', () => {
    const [award] = evaluate([line({ unitPrice: 100_000 })],
      [rule({ kind: 'percent', value: 5_000, maxDiscount: 2_000 })]);
    expect(award!.amount).toBe(2_000);
  });

  test('a minimum basket is checked against the whole basket', () => {
    const small = evaluate([line({ unitPrice: 5_000 })],
      [rule({ minBasket: 10_000 })]);
    expect(small).toEqual([]);

    const big = evaluate([line({ unitPrice: 15_000 })],
      [rule({ minBasket: 10_000 })]);
    expect(big.length).toBe(1);
  });

  test('targeting a category leaves everything else alone', () => {
    const lines = [
      line({ id: 'hot', categoryId: 'drinks', unitPrice: 10_000 }),
      line({ id: 'food', categoryId: 'mains', unitPrice: 10_000 }),
    ];
    const [award] = evaluate(lines,
      [rule({ kind: 'percent', value: 1_000, categoryIds: ['drinks'] })]);
    expect(award!.amount).toBe(1_000);
    expect(award!.perLine).toEqual([{ lineId: 'hot', amount: 1_000 }]);
  });

  test('the same basket always prices the same', () => {
    // Two rules at equal priority: without a deterministic tiebreak the
    // database's row order would decide, and the same basket would price
    // differently on different days.
    const lines = [line({ unitPrice: 10_000 })];
    const rules = [
      rule({ id: 'zzz', kind: 'amount', value: 1_000, priority: 50 }),
      rule({ id: 'aaa', kind: 'amount', value: 2_000, priority: 50 }),
    ];
    const first = evaluate(lines, rules);
    const reversed = evaluate(lines, [...rules].reverse());
    expect(first[0]!.promotionId).toBe(reversed[0]!.promotionId);
    expect(first[0]!.amount).toBe(reversed[0]!.amount);
  });
});

describe('when a promotion is live', () => {
  const window = {
    startsAt: null, endsAt: null, daysOfWeek: [] as number[],
    dailyStartMinute: null as number | null, dailyEndMinute: null as number | null,
  };

  test('happy hour is local time in the branch, not UTC', () => {
    // 16:00-19:00 in Riyadh is 13:00-16:00 UTC. An instant inside the local
    // window must be live even though UTC says otherwise.
    const w = { ...window, dailyStartMinute: 16 * 60, dailyEndMinute: 19 * 60 };
    const inside = new Date('2026-09-07T14:00:00Z');   // 17:00 Riyadh
    const outside = new Date('2026-09-07T17:00:00Z');  // 20:00 Riyadh
    expect(isLive(w, inside, 'Asia/Riyadh')).toBe(true);
    expect(isLive(w, outside, 'Asia/Riyadh')).toBe(false);
  });

  test('a window that crosses midnight is one shift, not an empty set', () => {
    // 22:00 to 02:00 — the late shift a lounge actually runs.
    const w = { ...window, dailyStartMinute: 22 * 60, dailyEndMinute: 2 * 60 };
    expect(isLive(w, new Date('2026-09-07T20:00:00Z'), 'Asia/Riyadh')).toBe(true);  // 23:00
    expect(isLive(w, new Date('2026-09-07T22:30:00Z'), 'Asia/Riyadh')).toBe(true);  // 01:30
    expect(isLive(w, new Date('2026-09-07T12:00:00Z'), 'Asia/Riyadh')).toBe(false); // 15:00
  });

  test('midnight is inside a window that starts at 00:00', () => {
    // Intl emits hour 24 for midnight, which reads as 1440 minutes and falls
    // outside every window unless it is wrapped.
    const parts = localParts(new Date('2026-09-07T21:00:00Z'), 'Asia/Riyadh');
    expect(parts.minutes).toBe(0);
    const w = { ...window, dailyStartMinute: 0, dailyEndMinute: 6 * 60 };
    expect(isLive(w, new Date('2026-09-07T21:00:00Z'), 'Asia/Riyadh')).toBe(true);
  });

  test('the Saudi weekend is Friday and Saturday', () => {
    const w = { ...window, daysOfWeek: [5, 6] };
    // 2026-09-04 is a Friday, 2026-09-07 a Monday.
    expect(isLive(w, new Date('2026-09-04T12:00:00Z'), 'Asia/Riyadh')).toBe(true);
    expect(isLive(w, new Date('2026-09-07T12:00:00Z'), 'Asia/Riyadh')).toBe(false);
  });

  test('a campaign outside its dates is not live', () => {
    const w = {
      ...window,
      startsAt: new Date('2026-10-01T00:00:00Z'),
      endsAt: new Date('2026-10-31T00:00:00Z'),
    };
    expect(isLive(w, new Date('2026-09-15T12:00:00Z'), 'Asia/Riyadh')).toBe(false);
    expect(isLive(w, new Date('2026-10-15T12:00:00Z'), 'Asia/Riyadh')).toBe(true);
  });
});

describe('on a real order', () => {
  /** A product with no required option group. */
  async function sellable(): Promise<{ id: string; price: number; category_id: string }> {
    const row = await one<{ id: string; price: string; category_id: string }>(
      `SELECT p.id, p.price, p.category_id FROM products p
        WHERE p.is_active AND p.is_available AND p.deleted_at IS NULL AND p.price > 0
          AND NOT EXISTS (
            SELECT 1 FROM product_modifiers pm JOIN modifiers m ON m.id = pm.modifier_id
             WHERE pm.product_id = p.id
               AND COALESCE(pm.is_required_override, m.is_required))
        ORDER BY p.price DESC LIMIT 1`,
    );
    return { id: row!.id, price: Number(row!.price), category_id: row!.category_id };
  }

  async function freeTable(): Promise<string> {
    const row = await one<{ id: string }>(
      `SELECT t.id FROM restaurant_tables t
        WHERE t.is_active AND t.current_session_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.table_id = t.id
                            AND o.status NOT IN ('paid','cancelled'))
        ORDER BY random() LIMIT 1`,
    );
    return row!.id;
  }

  test('an active promotion comes off the bill automatically', async () => {
    const app = await getApp();
    const headers = await ownerHeaders();
    const product = await sellable();

    const created = await app.inject({
      method: 'POST', url: '/api/promotions', headers,
      payload: {
        nameAr: 'خصم اختبار 20%', kind: 'percent', value: 2_000,
        productIds: [product.id], isActive: true, priority: 10,
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const promotionId = created.json().id;

    try {
      const cashier = await loginEmployee('2001', '4826');
      const order = await app.inject({
        method: 'POST', url: '/api/orders', headers: auth(cashier),
        payload: {
          tableId: await freeTable(),
          lines: [{ productId: product.id, quantity: 2 }],
        },
      });
      expect(order.statusCode, order.body).toBe(200);
      const orderId = order.json().orderId;

      const row = await one<{ subtotal: string; discount_total: string; grand_total: string }>(
        'SELECT subtotal, discount_total, grand_total FROM orders WHERE id = $1',
        [orderId],
      );
      const expected = Math.round((product.price * 2 * 2_000) / 10_000);
      expect(Number(row!.discount_total)).toBe(expected);
      expect(Number(row!.grand_total)).toBe(product.price * 2 - expected);

      // And the reason is on the record: "خصم اختبار 20%", not "manual".
      const discount = await one<{ kind: string; reason: string; promotion_id: string }>(
        `SELECT kind, reason, promotion_id FROM discounts
          WHERE order_id = $1 AND reversed_at IS NULL`,
        [orderId],
      );
      expect(discount!.kind).toBe('promotion');
      expect(discount!.reason).toBe('خصم اختبار 20%');
      expect(discount!.promotion_id).toBe(promotionId);
    } finally {
      await pool.query('UPDATE promotions SET is_active = FALSE WHERE id = $1',
        [promotionId]);
    }
  });

  test('adding an item re-earns the promotion on the new total', async () => {
    const app = await getApp();
    const headers = await ownerHeaders();
    const product = await sellable();

    const created = await app.inject({
      method: 'POST', url: '/api/promotions', headers,
      payload: {
        nameAr: 'خصم 10% للإضافة', kind: 'percent', value: 1_000,
        isActive: true, priority: 20,
      },
    });
    const promotionId = created.json().id;

    try {
      const cashier = await loginEmployee('2001', '4826');
      const order = await app.inject({
        method: 'POST', url: '/api/orders', headers: auth(cashier),
        payload: { tableId: await freeTable(), lines: [{ productId: product.id, quantity: 1 }] },
      });
      const orderId = order.json().orderId;

      const before = await one<{ discount_total: string }>(
        'SELECT discount_total FROM orders WHERE id = $1', [orderId]);

      await app.inject({
        method: 'POST', url: `/api/orders/${orderId}/items`, headers: auth(cashier),
        payload: { lines: [{ productId: product.id, quantity: 1 }] },
      });

      const after = await one<{ discount_total: string; subtotal: string }>(
        'SELECT discount_total, subtotal FROM orders WHERE id = $1', [orderId]);

      // Recomputed against the bigger basket, not carried forward.
      expect(Number(after!.discount_total)).toBeGreaterThan(Number(before!.discount_total));
      expect(Number(after!.discount_total))
        .toBe(Math.round((Number(after!.subtotal) * 1_000) / 10_000));

      // One row per LINE is correct — each line carries its own share so that
      // order_items.discount_amount stays truthful. What must not happen is
      // rows accumulating across recalculations, so: one promotion, and the
      // live rows summing to exactly the order's discount total.
      const live = await many<{ promotion_id: string; discount_amount: string }>(
        `SELECT promotion_id, discount_amount FROM discounts
          WHERE order_id = $1 AND kind = 'promotion' AND reversed_at IS NULL`,
        [orderId]);
      expect(new Set(live.map((d) => d.promotion_id)).size).toBe(1);
      expect(live.reduce((sum, d) => sum + Number(d.discount_amount), 0))
        .toBe(Number(after!.discount_total));
    } finally {
      await pool.query('UPDATE promotions SET is_active = FALSE WHERE id = $1',
        [promotionId]);
    }
  });

  test('a promotion needs no OTP, because no human chose the amount', async () => {
    // The OTP rule names only the two kinds a person can direct at one
    // customer. An automatic rule is a different thing and must not be
    // blocked by a constraint written for those.
    const app = await getApp();
    const headers = await ownerHeaders();
    const product = await sellable();
    const created = await app.inject({
      method: 'POST', url: '/api/promotions', headers,
      payload: { nameAr: 'بلا رمز', kind: 'amount', value: 100, isActive: true },
    });
    const promotionId = created.json().id;
    try {
      const cashier = await loginEmployee('2001', '4826');
      const order = await app.inject({
        method: 'POST', url: '/api/orders', headers: auth(cashier),
        payload: { tableId: await freeTable(), lines: [{ productId: product.id, quantity: 1 }] },
      });
      expect(order.statusCode, order.body).toBe(200);
      const discount = await one<{ otp_verified: boolean }>(
        `SELECT otp_verified FROM discounts WHERE order_id = $1 AND kind = 'promotion'`,
        [order.json().orderId],
      );
      expect(discount!.otp_verified).toBe(false);
    } finally {
      await pool.query('UPDATE promotions SET is_active = FALSE WHERE id = $1',
        [promotionId]);
    }
  });

  test('usage is counted at settlement, not at application', async () => {
    const app = await getApp();
    const headers = await ownerHeaders();
    const product = await sellable();
    const created = await app.inject({
      method: 'POST', url: '/api/promotions', headers,
      payload: { nameAr: 'عدّ عند الدفع', kind: 'amount', value: 100, isActive: true },
    });
    const promotionId = created.json().id;

    try {
      const cashier = await loginEmployee('2001', '4826');
      const order = await app.inject({
        method: 'POST', url: '/api/orders', headers: auth(cashier),
        payload: { tableId: await freeTable(), lines: [{ productId: product.id, quantity: 1 }] },
      });
      const orderId = order.json().orderId;

      // Applied but unpaid: an abandoned basket costs the campaign nothing.
      const before = await one<{ usage_count: number }>(
        'SELECT usage_count FROM promotions WHERE id = $1', [promotionId]);
      expect(before!.usage_count).toBe(0);

      const total = await one<{ grand_total: string }>(
        'SELECT grand_total FROM orders WHERE id = $1', [orderId]);
      const paid = await app.inject({
        method: 'POST', url: `/api/orders/${orderId}/pay`,
        headers: await authAtTill(cashier),
        payload: { parts: [{ method: 'cash', amount: Number(total!.grand_total) }] },
      });
      expect(paid.statusCode, paid.body).toBe(200);

      const after = await one<{ usage_count: number }>(
        'SELECT usage_count FROM promotions WHERE id = $1', [promotionId]);
      expect(after!.usage_count).toBe(1);
    } finally {
      await pool.query('UPDATE promotions SET is_active = FALSE WHERE id = $1',
        [promotionId]);
    }
  });

  test('a settled order is never re-priced by a later promotion', async () => {
    const app = await getApp();
    const headers = await ownerHeaders();
    const product = await sellable();
    const cashier = await loginEmployee('2001', '4826');

    const order = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth(cashier),
      payload: { tableId: await freeTable(), lines: [{ productId: product.id, quantity: 1 }] },
    });
    const orderId = order.json().orderId;
    const total = await one<{ grand_total: string }>(
      'SELECT grand_total FROM orders WHERE id = $1', [orderId]);
    await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/pay`,
      headers: await authAtTill(cashier),
      payload: { parts: [{ method: 'cash', amount: Number(total!.grand_total) }] },
    });

    // A promotion created AFTER the sale must not rewrite what was paid.
    const created = await app.inject({
      method: 'POST', url: '/api/promotions', headers,
      payload: { nameAr: 'متأخر', kind: 'percent', value: 5_000, isActive: true },
    });
    const promotionId = created.json().id;
    try {
      const { applyPromotions } = await import('../src/modules/promotions/promotions.service.js');
      const client = await pool.connect();
      try {
        const result = await applyPromotions(orderId, client as never);
        expect(result.applied).toBe(0);
      } finally { client.release(); }

      const after = await one<{ grand_total: string }>(
        'SELECT grand_total FROM orders WHERE id = $1', [orderId]);
      expect(after!.grand_total).toBe(total!.grand_total);
    } finally {
      await pool.query('UPDATE promotions SET is_active = FALSE WHERE id = $1',
        [promotionId]);
    }
  });
});

describe('who may run a campaign', () => {
  test('a cashier cannot create one', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const res = await app.inject({
      method: 'POST', url: '/api/promotions', headers: auth(cashier),
      payload: { nameAr: 'خصم', kind: 'percent', value: 5_000 },
    });
    expect(res.statusCode).toBe(403);
  });

  test('a half-specified daily window is refused, not silently inert', async () => {
    const app = await getApp();
    const headers = await ownerHeaders();
    const res = await app.inject({
      method: 'POST', url: '/api/promotions', headers,
      payload: {
        nameAr: 'نصف نافذة', kind: 'percent', value: 1_000,
        dailyStartMinute: 960,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  test('buy_x_get_y without quantities is refused', async () => {
    const app = await getApp();
    const headers = await ownerHeaders();
    const res = await app.inject({
      method: 'POST', url: '/api/promotions', headers,
      payload: { nameAr: 'اشترِ', kind: 'buy_x_get_y', value: 0 },
    });
    expect(res.statusCode).toBe(400);
  });

  test('a retired promotion keeps its redemptions readable', async () => {
    const app = await getApp();
    const headers = await ownerHeaders();
    const created = await app.inject({
      method: 'POST', url: '/api/promotions', headers,
      payload: { nameAr: 'للتقاعد', kind: 'amount', value: 500 },
    });
    const id = created.json().id;
    const retired = await app.inject({
      method: 'POST', url: `/api/promotions/${id}/retire`, headers,
    });
    expect(retired.statusCode).toBe(200);

    // Soft-deleted, never removed: its redemptions reference it.
    const row = await one<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM promotions WHERE id = $1', [id]);
    expect(row!.deleted_at).toBeTruthy();
  });

  test('the report says what each campaign cost', async () => {
    const app = await getApp();
    const headers = await ownerHeaders();
    const res = await app.inject({
      method: 'GET', url: '/api/reports/promotions', headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json().promotions;
    expect(Array.isArray(rows)).toBe(true);
    if (rows.length > 0) {
      expect(rows[0]).toHaveProperty('given_away');
      expect(rows[0]).toHaveProperty('redemptions');
    }
  });
});
