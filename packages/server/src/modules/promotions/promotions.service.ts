/**
 * Applying promotions to an order.
 *
 * The engine next door does the arithmetic and knows nothing about the
 * database; this loads the rules, decides which are live, and writes the
 * result as ordinary discount rows so that every existing report, receipt and
 * tax invoice sees them without changing.
 *
 * Re-computed from scratch on every change to the order. A promotion is a
 * function of the basket, so adding an item must be able to earn one and
 * voiding an item must be able to lose one — carrying a stale discount forward
 * is how a bill ends up cheaper than any rule allows.
 */
import type { PoolClient } from 'pg';
import { many, one, pool } from '../../core/db.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { AUDIT, audit } from '../../core/audit.js';
import type { Principal } from '../../core/principal.js';
import { assertBranchAccess } from '../../core/principal.js';
import { evaluate, isLive } from './engine.js';
import type { BasketLine, PromotionRule } from './engine.js';

interface PromotionRow {
  id: string; name_ar: string; kind: PromotionRule['kind']; value: string;
  buy_quantity: number | null; get_quantity: number | null;
  starts_at: Date | null; ends_at: Date | null; days_of_week: number[];
  daily_start_minute: number | null; daily_end_minute: number | null;
  applies_to_order_types: string[]; applies_to_sources: string[];
  min_basket: string; max_discount: string;
  usage_limit: number | null; usage_per_customer: number | null; usage_count: number;
  priority: number; is_stackable: boolean; code: string | null;
}

/**
 * Recompute this order's automatic promotions.
 *
 * Called from recalculateOrder, so it runs on every mutation. Deliberately
 * does NOT throw on a rule it cannot apply: a malformed promotion must not
 * make an order unsellable, so it is skipped and the sale continues.
 */
export async function applyPromotions(
  orderId: string, client: PoolClient, at: Date = new Date(),
): Promise<{ applied: number; total: number }> {
  const order = await one<{
    branch_id: string; customer_id: string | null; order_type: string;
    source: string; status: string;
  }>(
    `SELECT branch_id, customer_id, order_type, source, status
       FROM orders WHERE id = $1`,
    [orderId], client,
  );
  if (!order) return { applied: 0, total: 0 };

  // A settled order is a financial record. Re-pricing one because a promotion
  // started an hour later would rewrite what the customer actually paid.
  if (['paid', 'cancelled'].includes(order.status)) return { applied: 0, total: 0 };

  const branch = await one<{ timezone: string }>(
    'SELECT timezone FROM branches WHERE id = $1', [order.branch_id], client,
  );
  const timeZone = branch?.timezone ?? 'Asia/Riyadh';

  const rows = await many<PromotionRow>(
    `SELECT * FROM promotions
      WHERE branch_id = $1 AND is_active AND deleted_at IS NULL
        -- Coded promotions are claimed explicitly, never applied automatically.
        AND code IS NULL
      ORDER BY priority, id`,
    [order.branch_id], client,
  );

  // Undo the previous run BEFORE reading the basket. Loading first would let
  // last run's discount count as value already given away, so each
  // recalculation would shrink the promotion against its own output — a bill
  // that quietly drifts every time an item is added.
  await clearPromotionDiscounts(orderId, client);

  const lines = await loadBasket(orderId, client);
  if (lines.length === 0) return { applied: 0, total: 0 };

  const eligible: PromotionRow[] = [];
  for (const row of rows) {
    if (!isLive({
      startsAt: row.starts_at, endsAt: row.ends_at,
      daysOfWeek: row.days_of_week ?? [],
      dailyStartMinute: row.daily_start_minute,
      dailyEndMinute: row.daily_end_minute,
    }, at, timeZone)) continue;

    if (row.applies_to_order_types.length > 0
        && !row.applies_to_order_types.includes(order.order_type)) continue;
    if (row.applies_to_sources.length > 0
        && !row.applies_to_sources.includes(order.source)) continue;

    // A campaign that has run out is over, and a limit that is checked only at
    // the end is a limit that gets exceeded on the busiest night.
    if (row.usage_limit !== null && row.usage_count >= row.usage_limit) continue;
    if (row.usage_per_customer !== null && order.customer_id) {
      const used = await one<{ n: string }>(
        `SELECT count(*)::text AS n FROM promotion_redemptions
          WHERE promotion_id = $1 AND customer_id = $2 AND order_id <> $3`,
        [row.id, order.customer_id, orderId], client,
      );
      if (Number(used!.n) >= row.usage_per_customer) continue;
    }

    eligible.push(row);
  }

  const rules = await Promise.all(eligible.map((row) => toRule(row, client)));
  const awards = evaluate(lines, rules);

  let total = 0;
  for (const award of awards) {
    total += award.amount;
    for (const part of award.perLine) {
      const line = lines.find((l) => l.id === part.lineId)!;
      await client.query(
        `INSERT INTO discounts
           (branch_id, order_id, order_item_id, customer_id, kind, promotion_id,
            original_price, discounted_price, discount_amount, reason)
         VALUES ($1,$2,$3,$4,'promotion',$5,$6,$7,$8,$9)`,
        [
          order.branch_id, orderId, part.lineId, order.customer_id, award.promotionId,
          line.unitPrice * line.quantity,
          line.unitPrice * line.quantity - part.amount,
          part.amount, award.nameAr,
        ],
      );
      // The line carries its own share, so every existing query that reads
      // order_items.discount_amount keeps working untouched.
      await client.query(
        'UPDATE order_items SET discount_amount = discount_amount + $2 WHERE id = $1',
        [part.lineId, part.amount],
      );
    }

    await client.query(
      `INSERT INTO promotion_redemptions
         (promotion_id, order_id, branch_id, customer_id, discount_amount, qualifying_total)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (promotion_id, order_id) DO UPDATE SET
         discount_amount = EXCLUDED.discount_amount,
         qualifying_total = EXCLUDED.qualifying_total`,
      [award.promotionId, orderId, order.branch_id, order.customer_id,
       award.amount, award.qualifyingTotal],
    );
  }

  return { applied: awards.length, total };
}

/**
 * Undo the previous run.
 *
 * The line's discount_amount is decremented by exactly what the promotion rows
 * put there, rather than zeroed: a customer's special price lives in the same
 * column and must survive.
 */
async function clearPromotionDiscounts(orderId: string, client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE order_items oi
        SET discount_amount = GREATEST(0, oi.discount_amount - COALESCE(p.amount, 0))
       FROM (SELECT order_item_id, SUM(discount_amount) AS amount
               FROM discounts
              WHERE order_id = $1 AND kind = 'promotion' AND reversed_at IS NULL
                AND order_item_id IS NOT NULL
              GROUP BY order_item_id) p
      WHERE oi.id = p.order_item_id`,
    [orderId],
  );
  // Financial rows are never deleted, so the superseded ones are marked
  // reversed and stay readable.
  await client.query(
    `UPDATE discounts SET reversed_at = now(), reversed_reason = 'إعادة احتساب العروض'
      WHERE order_id = $1 AND kind = 'promotion' AND reversed_at IS NULL`,
    [orderId],
  );
  await client.query(
    'DELETE FROM promotion_redemptions WHERE order_id = $1', [orderId],
  );
}

async function loadBasket(orderId: string, client: PoolClient): Promise<BasketLine[]> {
  const rows = await many<{
    id: string; product_id: string; category_id: string | null;
    quantity: string; unit_price: string; modifiers_total: string;
    discount_amount: string;
  }>(
    `SELECT oi.id, oi.product_id, p.category_id, oi.quantity,
            oi.effective_unit_price AS unit_price, oi.modifiers_total,
            COALESCE(oi.discount_amount, 0) AS discount_amount
       FROM order_items oi JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1 AND oi.status <> 'voided'
      ORDER BY oi.created_at`,
    [orderId], client,
  );

  return rows.map((r) => ({
    id: r.id,
    productId: r.product_id,
    categoryId: r.category_id,
    quantity: Number(r.quantity),
    unitPrice: Number(r.unit_price) + Number(r.modifiers_total),
    // What a special price or an OTP discount already took. The engine works
    // on what is left, so the two can never discount the same halala twice.
    existingDiscount: Number(r.discount_amount),
  }));
}

async function toRule(row: PromotionRow, client: PoolClient): Promise<PromotionRule> {
  const products = await many<{ product_id: string; quantity: number }>(
    'SELECT product_id, quantity FROM promotion_products WHERE promotion_id = $1',
    [row.id], client,
  );
  const categories = await many<{ category_id: string }>(
    'SELECT category_id FROM promotion_categories WHERE promotion_id = $1',
    [row.id], client,
  );

  return {
    id: row.id,
    nameAr: row.name_ar,
    kind: row.kind,
    value: Number(row.value),
    buyQuantity: row.buy_quantity,
    getQuantity: row.get_quantity,
    productIds: products.map((p) => p.product_id),
    categoryIds: categories.map((c) => c.category_id),
    comboQuantities: new Map(products.map((p) => [p.product_id, p.quantity])),
    minBasket: Number(row.min_basket),
    maxDiscount: Number(row.max_discount),
    priority: row.priority,
    isStackable: row.is_stackable,
  };
}

/**
 * Bump the campaign counters once an order is settled.
 *
 * Counted at settlement rather than at application, because an order that is
 * abandoned never cost the campaign anything — counting it would exhaust a
 * limited offer on baskets nobody paid for.
 */
export async function commitRedemptions(
  orderId: string, client: PoolClient,
): Promise<void> {
  await client.query(
    `UPDATE promotions SET usage_count = usage_count + 1
      WHERE id IN (SELECT promotion_id FROM promotion_redemptions WHERE order_id = $1)`,
    [orderId],
  );
}

// --- Management --------------------------------------------------------------

export async function listPromotions(principal: Principal, branchId: string) {
  assertBranchAccess(principal, branchId);
  return many(
    `SELECT p.*,
            (SELECT count(*) FROM promotion_redemptions r WHERE r.promotion_id = p.id)
              AS redemption_count,
            (SELECT COALESCE(SUM(r.discount_amount), 0) FROM promotion_redemptions r
              WHERE r.promotion_id = p.id) AS total_given,
            (SELECT COALESCE(json_agg(pp.product_id), '[]'::json)
               FROM promotion_products pp WHERE pp.promotion_id = p.id) AS product_ids,
            (SELECT COALESCE(json_agg(pc.category_id), '[]'::json)
               FROM promotion_categories pc WHERE pc.promotion_id = p.id) AS category_ids
       FROM promotions p
      WHERE p.branch_id = $1 AND p.deleted_at IS NULL
      ORDER BY p.is_active DESC, p.priority, p.name_ar`,
    [branchId],
  );
}

export interface PromotionInput {
  nameAr: string;
  descriptionAr?: string | null;
  kind: PromotionRule['kind'];
  value: number;
  buyQuantity?: number | null;
  getQuantity?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  daysOfWeek?: number[];
  dailyStartMinute?: number | null;
  dailyEndMinute?: number | null;
  appliesToOrderTypes?: string[];
  appliesToSources?: string[];
  minBasket?: number;
  maxDiscount?: number;
  usageLimit?: number | null;
  usagePerCustomer?: number | null;
  priority?: number;
  isStackable?: boolean;
  isActive?: boolean;
  code?: string | null;
  productIds?: string[];
  categoryIds?: string[];
  comboQuantities?: Record<string, number>;
}

export async function savePromotion(
  principal: Principal, branchId: string, input: PromotionInput,
  promotionId?: string,
): Promise<{ id: string }> {
  assertBranchAccess(principal, branchId);

  if (input.kind === 'percent' && (input.value < 0 || input.value > 10_000)) {
    throw badRequest('النسبة بين 0 و100% (تُحفظ بنقاط أساس: 1500 = 15%)');
  }
  if (input.kind === 'buy_x_get_y' && (!input.buyQuantity || !input.getQuantity)) {
    throw badRequest('حدّد «اشترِ كم» و«خذ كم»');
  }
  if (input.kind === 'combo' && (input.productIds ?? []).length < 2) {
    throw badRequest('الوجبة المركّبة تحتاج صنفين على الأقل');
  }
  // A window with only one end is almost always a mistake, and the mistake is
  // silent: the promotion simply never fires, or never stops.
  const hasStart = input.dailyStartMinute !== null && input.dailyStartMinute !== undefined;
  const hasEnd = input.dailyEndMinute !== null && input.dailyEndMinute !== undefined;
  if (hasStart !== hasEnd) {
    throw badRequest('حدّد بداية ونهاية الفترة اليومية معاً، أو اتركهما فارغتين');
  }

  const row = promotionId
    ? await one<{ id: string }>(
      `UPDATE promotions SET
         name_ar = $3, description_ar = $4, kind = $5, value = $6,
         buy_quantity = $7, get_quantity = $8, starts_at = $9, ends_at = $10,
         days_of_week = $11, daily_start_minute = $12, daily_end_minute = $13,
         applies_to_order_types = $14, applies_to_sources = $15,
         min_basket = $16, max_discount = $17, usage_limit = $18,
         usage_per_customer = $19, priority = $20, is_stackable = $21,
         is_active = $22, code = $23, updated_at = now()
       WHERE id = $1 AND branch_id = $2 AND deleted_at IS NULL
       RETURNING id`,
      params(promotionId, branchId, input),
    )
    : await one<{ id: string }>(
      `INSERT INTO promotions
         (id, branch_id, name_ar, description_ar, kind, value, buy_quantity,
          get_quantity, starts_at, ends_at, days_of_week, daily_start_minute,
          daily_end_minute, applies_to_order_types, applies_to_sources,
          min_basket, max_discount, usage_limit, usage_per_customer, priority,
          is_stackable, is_active, code, created_by)
       VALUES (COALESCE($1, gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
               $12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       RETURNING id`,
      [...params(null, branchId, input), principal.userId],
    ).catch((err: { code?: string }) => {
      if (err.code === '23505') throw conflict('رمز العرض مستخدم بالفعل في هذا الفرع');
      throw err;
    });

  if (!row) throw notFound('العرض غير موجود');

  await pool.query('DELETE FROM promotion_products WHERE promotion_id = $1', [row.id]);
  await pool.query('DELETE FROM promotion_categories WHERE promotion_id = $1', [row.id]);
  for (const productId of input.productIds ?? []) {
    await pool.query(
      `INSERT INTO promotion_products (promotion_id, product_id, quantity)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [row.id, productId, input.comboQuantities?.[productId] ?? 1],
    );
  }
  for (const categoryId of input.categoryIds ?? []) {
    await pool.query(
      `INSERT INTO promotion_categories (promotion_id, category_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [row.id, categoryId],
    );
  }

  await audit({
    action: promotionId ? AUDIT.PROMOTION_UPDATED : AUDIT.PROMOTION_CREATED,
    actorUserId: principal.userId, actorEmployeeId: principal.employeeId,
    actorLabel: principal.displayName, branchId,
    entityType: 'promotion', entityId: row.id,
    newValue: {
      name: input.nameAr, kind: input.kind, value: input.value,
      active: input.isActive ?? true, stackable: input.isStackable ?? false,
    },
  });

  return { id: row.id };
}

function params(id: string | null, branchId: string, input: PromotionInput): unknown[] {
  return [
    id, branchId, input.nameAr, input.descriptionAr ?? null, input.kind, input.value,
    input.buyQuantity ?? null, input.getQuantity ?? null,
    input.startsAt ?? null, input.endsAt ?? null,
    input.daysOfWeek ?? [], input.dailyStartMinute ?? null, input.dailyEndMinute ?? null,
    input.appliesToOrderTypes ?? [], input.appliesToSources ?? [],
    input.minBasket ?? 0, input.maxDiscount ?? 0,
    input.usageLimit ?? null, input.usagePerCustomer ?? null,
    input.priority ?? 100, input.isStackable ?? false, input.isActive ?? true,
    input.code?.trim() || null,
  ];
}

/** Retire a promotion. Never deleted: its redemptions reference it. */
export async function retirePromotion(
  principal: Principal, promotionId: string,
): Promise<void> {
  const promo = await one<{ branch_id: string; name_ar: string }>(
    'SELECT branch_id, name_ar FROM promotions WHERE id = $1 AND deleted_at IS NULL',
    [promotionId],
  );
  if (!promo) throw notFound('العرض غير موجود');
  assertBranchAccess(principal, promo.branch_id);

  await pool.query(
    'UPDATE promotions SET is_active = FALSE, deleted_at = now() WHERE id = $1',
    [promotionId],
  );
  await audit({
    action: AUDIT.PROMOTION_RETIRED, actorUserId: principal.userId,
    actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
    branchId: promo.branch_id, entityType: 'promotion', entityId: promotionId,
    oldValue: { name: promo.name_ar },
  });
}

/**
 * What a campaign has actually cost.
 *
 * The question that decides whether it continues, and the reason redemptions
 * are a table rather than a running total.
 */
export async function promotionReport(
  principal: Principal, branchId: string,
  range: { from?: string; to?: string },
) {
  assertBranchAccess(principal, branchId);
  return many(
    `SELECT p.id, p.name_ar, p.kind, p.is_active,
            count(r.id)::int AS redemptions,
            COALESCE(SUM(r.discount_amount), 0) AS given_away,
            COALESCE(SUM(r.qualifying_total), 0) AS qualifying_total,
            count(DISTINCT r.customer_id)::int AS customers
       FROM promotions p
       LEFT JOIN promotion_redemptions r ON r.promotion_id = p.id
        AND ($2::timestamptz IS NULL OR r.created_at >= $2)
        AND ($3::timestamptz IS NULL OR r.created_at < $3)
      WHERE p.branch_id = $1 AND p.deleted_at IS NULL
      GROUP BY p.id
      ORDER BY given_away DESC`,
    [branchId, range.from ?? null, range.to ?? null],
  );
}

/**
 * Preview what a promotion would do to a basket, before anyone turns it on.
 *
 * A 20% offer that turns out to stack into 60% is the kind of thing an owner
 * should find out here rather than on a Friday night.
 */
export async function previewPromotion(
  principal: Principal, orderId: string,
): Promise<{ promotions: Array<{ name: string; amount: number }>; total: number }> {
  const order = await one<{ branch_id: string }>(
    'SELECT branch_id FROM orders WHERE id = $1', [orderId],
  );
  if (!order) throw notFound('الطلب غير موجود');
  assertBranchAccess(principal, order.branch_id);

  const rows = await many<{
    promotion_id: string; name_ar: string; amount: string;
  }>(
    `SELECT r.promotion_id, p.name_ar, r.discount_amount AS amount
       FROM promotion_redemptions r JOIN promotions p ON p.id = r.promotion_id
      WHERE r.order_id = $1`,
    [orderId],
  );
  return {
    promotions: rows.map((r) => ({ name: r.name_ar, amount: Number(r.amount) })),
    total: rows.reduce((sum, r) => sum + Number(r.amount), 0),
  };
}
