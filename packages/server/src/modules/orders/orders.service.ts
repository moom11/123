import type { PoolClient } from 'pg';
import { canTransitionOrder, type OrderStatus } from '@mara/shared';
import { many, one, pool, withTransaction } from '../../core/db.js';
import { AUDIT, audit } from '../../core/audit.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { EVENTS, publish } from '../../core/realtime.js';
import type { Principal } from '../../core/principal.js';
import {
  activeLoyaltyRule, moveWallet, pointsToValue, resolveSpecialPrice,
} from '../customers/customers.service.js';
import { verifyOtp } from '../customers/otp.service.js';
import { computeConsumption } from '../inventory/recipe.service.js';
import { checkLowStock, postRecipeConsumption } from '../inventory/inventory.service.js';
import { printOrderItems, printVoid } from '../printing/printing.service.js';
import { refreshTableStatus } from '../tables/tables.service.js';

export interface CartLine {
  productId: string;
  variantId?: string | null;
  quantity: number;
  modifierOptionIds?: string[];
  notes?: string | null;
}

interface PricedLine {
  productId: string;
  variantId: string | null;
  productName: string;
  categoryId: string;
  department: string;
  quantity: number;
  unitPrice: number;
  effectiveUnitPrice: number;
  modifiersTotal: number;
  lineTotal: number;
  modifiers: Array<{
    modifierId: string; optionId: string; modifierName: string;
    optionName: string; priceDelta: number;
  }>;
  notes: string | null;
}

/**
 * Price a cart against the live menu.
 *
 * Prices come exclusively from the database. No caller — not the POS, not the
 * customer's phone — may supply a price; a waiter cannot type a number, and a
 * tampered request body simply gets the menu price.
 */
async function priceCart(
  branchId: string,
  lines: readonly CartLine[],
  client: PoolClient,
): Promise<PricedLine[]> {
  if (lines.length === 0) throw badRequest('السلة فارغة');

  const priced: PricedLine[] = [];

  for (const line of lines) {
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      throw badRequest('الكمية غير صالحة');
    }

    const product = await one<{
      id: string; name_ar: string; price: number; category_id: string;
      production_department: string; is_available: boolean; is_active: boolean;
      branch_id: string | null;
    }>(
      `SELECT id, name_ar, price, category_id, production_department,
              is_available, is_active, branch_id
         FROM products WHERE id = $1 AND deleted_at IS NULL`,
      [line.productId], client,
    );
    if (!product || !product.is_active) throw notFound('المنتج غير موجود');
    if (product.branch_id && product.branch_id !== branchId) {
      throw badRequest('هذا المنتج غير متاح في هذا الفرع');
    }
    if (!product.is_available) {
      throw unprocessable(`المنتج "${product.name_ar}" غير متوفر حالياً`);
    }

    let unitPrice = product.price;
    let variantId: string | null = null;
    if (line.variantId) {
      const variant = await one<{ id: string; price_delta: number; price_override: number | null }>(
        `SELECT id, price_delta, price_override FROM product_variants
          WHERE id = $1 AND product_id = $2 AND is_active`,
        [line.variantId, line.productId], client,
      );
      if (!variant) throw badRequest('الحجم المختار غير متاح');
      variantId = variant.id;
      unitPrice = variant.price_override ?? product.price + variant.price_delta;
    }

    // Validate every chosen option actually belongs to a modifier attached to
    // this product, so a crafted request cannot attach a cheaper group's option.
    const optionIds = line.modifierOptionIds ?? [];
    const modifiers: PricedLine['modifiers'] = [];
    let modifiersTotal = 0;

    if (optionIds.length > 0) {
      const options = await many<{
        option_id: string; option_name: string; price_delta: number;
        modifier_id: string; modifier_name: string;
      }>(
        `SELECT mo.id AS option_id, mo.name_ar AS option_name, mo.price_delta,
                m.id AS modifier_id, m.name_ar AS modifier_name
           FROM modifier_options mo
           JOIN modifiers m ON m.id = mo.modifier_id
           JOIN product_modifiers pm ON pm.modifier_id = m.id AND pm.product_id = $2
          WHERE mo.id = ANY($1::uuid[]) AND mo.is_active AND m.is_active`,
        [optionIds, line.productId], client,
      );
      if (options.length !== optionIds.length) {
        throw badRequest('أحد الخيارات المختارة غير صالح لهذا المنتج');
      }
      for (const o of options) {
        modifiersTotal += o.price_delta;
        modifiers.push({
          modifierId: o.modifier_id, optionId: o.option_id,
          modifierName: o.modifier_name, optionName: o.option_name,
          priceDelta: o.price_delta,
        });
      }
    }

    // Required modifier groups must actually be answered.
    const missing = await many<{ name_ar: string }>(
      `SELECT m.name_ar FROM product_modifiers pm
         JOIN modifiers m ON m.id = pm.modifier_id
        WHERE pm.product_id = $1 AND m.is_active
          AND COALESCE(pm.is_required_override, m.is_required)
          AND NOT EXISTS (
            SELECT 1 FROM modifier_options mo
             WHERE mo.modifier_id = m.id AND mo.id = ANY($2::uuid[])
          )`,
      [line.productId, optionIds], client,
    );
    if (missing.length > 0) {
      throw badRequest(`اختر: ${missing.map((m) => m.name_ar).join('، ')}`);
    }

    const lineTotal = (unitPrice + modifiersTotal) * line.quantity;
    priced.push({
      productId: product.id, variantId,
      productName: product.name_ar, categoryId: product.category_id,
      department: product.production_department,
      quantity: line.quantity, unitPrice,
      effectiveUnitPrice: unitPrice,
      modifiersTotal, lineTotal,
      modifiers, notes: line.notes ?? null,
    });
  }

  return priced;
}

async function insertLines(
  orderId: string, lines: PricedLine[], startLineNumber: number,
  addedByEmployeeId: string | null, client: PoolClient,
): Promise<string[]> {
  const ids: string[] = [];
  let n = startLineNumber;

  for (const line of lines) {
    const item = await one<{ id: string }>(
      `INSERT INTO order_items (
         order_id, line_number, product_id, variant_id, product_name_ar,
         production_department, quantity, unit_price, effective_unit_price,
         modifiers_total, line_total, notes, added_by_employee_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [
        orderId, n, line.productId, line.variantId, line.productName,
        line.department, line.quantity, line.unitPrice, line.effectiveUnitPrice,
        line.modifiersTotal, line.lineTotal, line.notes, addedByEmployeeId,
      ],
      client,
    );
    for (const m of line.modifiers) {
      await client.query(
        `INSERT INTO order_item_modifiers (
           order_item_id, modifier_id, modifier_option_id, modifier_name_ar,
           option_name_ar, price_delta
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [item!.id, m.modifierId, m.optionId, m.modifierName, m.optionName, m.priceDelta],
      );
    }
    ids.push(item!.id);
    n += 1;
  }
  return ids;
}

/**
 * Recompute an order's money from its live lines and discounts.
 *
 * `subtotal` is the GROSS value of the lines at menu prices, so the printed
 * bill reads "subtotal, discounts, VAT, total" the way a guest expects.
 *
 * Discounts come in two shapes and must not be counted twice: a line-level
 * discount has already reduced that line's `line_total` (and is recorded in
 * `order_items.discount_amount`), whereas a whole-bill discount — points
 * redemption or a manual management discount — has no `order_item_id`. Summing
 * the discounts table wholesale would double-count the first kind, which is
 * exactly the bug this split avoids.
 */
export async function recalculateOrder(orderId: string, client: PoolClient): Promise<void> {
  const totals = await one<{ subtotal: number; discounts: number }>(
    `SELECT
       COALESCE((SELECT SUM((unit_price + modifiers_total) * quantity)
                   FROM order_items
                  WHERE order_id = $1 AND status <> 'voided'), 0) AS subtotal,
       COALESCE((SELECT SUM(discount_amount) FROM order_items
                  WHERE order_id = $1 AND status <> 'voided'), 0)
       + COALESCE((SELECT SUM(discount_amount) FROM discounts
                    WHERE order_id = $1 AND order_item_id IS NULL
                      AND reversed_at IS NULL), 0) AS discounts`,
    [orderId], client,
  );

  const order = await one<{ branch_id: string; points_discount_total: number }>(
    'SELECT branch_id, points_discount_total FROM orders WHERE id = $1', [orderId], client,
  );
  const branch = await one<{ vat_percent: number }>(
    'SELECT vat_percent FROM branches WHERE id = $1', [order!.branch_id], client,
  );

  const subtotal = Number(totals?.subtotal ?? 0);
  const discountTotal = Number(totals?.discounts ?? 0);
  const net = Math.max(0, subtotal - discountTotal);

  // Menu prices in Saudi retail are VAT-inclusive, so VAT is extracted from the
  // net rather than added on top; the guest pays exactly the shelf price.
  const rate = Number(branch?.vat_percent ?? 0);
  const vat = rate > 0 ? net - Math.round((net * 100) / (100 + rate)) : 0;

  await client.query(
    `UPDATE orders SET subtotal = $2, discount_total = $3, vat_amount = $4, grand_total = $5
      WHERE id = $1`,
    [orderId, subtotal, discountTotal, vat, net],
  );
}

async function transition(
  orderId: string, to: OrderStatus, principal: Principal | null,
  client: PoolClient, reason?: string,
): Promise<void> {
  const current = await one<{ status: OrderStatus }>(
    'SELECT status FROM orders WHERE id = $1 FOR UPDATE', [orderId], client,
  );
  if (!current) throw notFound('الطلب غير موجود');
  if (current.status === to) return;
  if (!canTransitionOrder(current.status, to)) {
    throw unprocessable(`لا يمكن تغيير حالة الطلب من ${current.status} إلى ${to}`);
  }

  await client.query('UPDATE orders SET status = $2 WHERE id = $1', [orderId, to]);
  await client.query(
    `INSERT INTO order_status_history
       (order_id, from_status, to_status, actor_user_id, actor_employee_id, actor_kind, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      orderId, current.status, to, principal?.userId ?? null,
      principal?.employeeId ?? null, principal ? (principal.employeeId ? 'employee' : 'user') : 'customer',
      reason ?? null,
    ],
  );
}

export interface CreateOrderInput {
  branchId: string;
  tableId?: string | null;
  sessionId?: string | null;
  customerId?: string | null;
  orderType?: 'dine_in' | 'takeaway';
  source: 'pos' | 'customer_qr' | 'waiter';
  lines: CartLine[];
  notes?: string | null;
  guestCount?: number;
  idempotencyKey?: string | null;
  waiterEmployeeId?: string | null;
}

/**
 * Create an order.
 *
 * A POS/waiter order is confirmed immediately and printed. A customer QR order
 * is NOT: it lands in `pending_waiter_approval` and reaches no printer until
 * the responsible waiter reviews it — the specification is emphatic about this.
 */
export async function createOrder(
  principal: Principal | null,
  input: CreateOrderInput,
): Promise<{ orderId: string; orderNumber: string; status: OrderStatus; grandTotal: number }> {
  return withTransaction(async (client) => {
    // Idempotency: a retried submit (flaky wifi, double tap) returns the
    // original order rather than creating a second one.
    if (input.idempotencyKey) {
      const existing = await one<{
        id: string; order_number: string; status: OrderStatus; grand_total: number;
      }>(
        `SELECT id, order_number, status, grand_total FROM orders
          WHERE branch_id = $1 AND idempotency_key = $2`,
        [input.branchId, input.idempotencyKey], client,
      );
      if (existing) {
        return {
          orderId: existing.id, orderNumber: existing.order_number,
          status: existing.status, grandTotal: existing.grand_total,
        };
      }
    }

    const priced = await priceCart(input.branchId, input.lines, client);

    // Resolve the table session and the waiter responsible for it.
    let sessionId = input.sessionId ?? null;
    let waiterId = input.waiterEmployeeId ?? null;
    if (input.tableId) {
      const table = await one<{
        current_session_id: string | null; assigned_waiter_employee_id: string | null;
        branch_id: string; table_number: string;
      }>(
        `SELECT current_session_id, assigned_waiter_employee_id, branch_id, table_number
           FROM restaurant_tables WHERE id = $1 AND deleted_at IS NULL`,
        [input.tableId], client,
      );
      if (!table) throw notFound('الطاولة غير موجودة');
      if (table.branch_id !== input.branchId) throw forbidden('الطاولة تتبع فرعاً آخر');

      if (!sessionId) {
        sessionId = table.current_session_id;
        if (!sessionId) {
          const created = await one<{ id: string }>(
            `INSERT INTO table_sessions
               (branch_id, table_id, opened_by_employee_id, waiter_employee_id,
                customer_id, guest_count)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [
              input.branchId, input.tableId, principal?.employeeId ?? null,
              table.assigned_waiter_employee_id, input.customerId ?? null,
              input.guestCount ?? 1,
            ],
            client,
          );
          sessionId = created!.id;
          await client.query(
            'UPDATE restaurant_tables SET current_session_id = $2 WHERE id = $1',
            [input.tableId, sessionId],
          );
        }
      }
      waiterId = waiterId
        ?? table.assigned_waiter_employee_id
        ?? (await one<{ waiter_employee_id: string | null }>(
              'SELECT waiter_employee_id FROM table_sessions WHERE id = $1', [sessionId], client,
            ))?.waiter_employee_id
        ?? null;

      if (input.customerId) {
        await client.query(
          'UPDATE table_sessions SET customer_id = COALESCE(customer_id, $2) WHERE id = $1',
          [sessionId, input.customerId],
        );
      }
    }

    const numRow = await one<{ n: string }>(
      `SELECT next_document_number($1,'ORD', EXTRACT(YEAR FROM now())::int) AS n`,
      [input.branchId], client,
    );

    // A customer's own order must be reviewed by the waiter before it prints.
    const initialStatus: OrderStatus =
      input.source === 'customer_qr' ? 'pending_waiter_approval' : 'confirmed';

    const order = await one<{ id: string }>(
      `INSERT INTO orders (
         order_number, branch_id, table_id, session_id, customer_id,
         waiter_employee_id, created_by_employee_id, created_by_user_id,
         source, order_type, status, guest_count, notes, idempotency_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [
        numRow!.n, input.branchId, input.tableId ?? null, sessionId,
        input.customerId ?? null, waiterId, principal?.employeeId ?? null,
        principal?.userId ?? null, input.source, input.orderType ?? 'dine_in',
        initialStatus, input.guestCount ?? 1, input.notes ?? null,
        input.idempotencyKey ?? null,
      ],
      client,
    );

    await insertLines(order!.id, priced, 1, principal?.employeeId ?? null, client);

    await client.query(
      `INSERT INTO order_status_history
         (order_id, from_status, to_status, actor_user_id, actor_employee_id, actor_kind)
       VALUES ($1, NULL, $2, $3, $4, $5)`,
      [
        order!.id, initialStatus, principal?.userId ?? null,
        principal?.employeeId ?? null,
        principal ? (principal.employeeId ? 'employee' : 'user') : 'customer',
      ],
    );

    // Apply any standing special price that does not require an OTP.
    if (input.customerId) {
      await applyAutomaticSpecialPrices(order!.id, input.customerId, input.branchId, client);
    }

    await recalculateOrder(order!.id, client);

    await audit({
      action: AUDIT.ORDER_CREATED,
      actorUserId: principal?.userId ?? null,
      actorEmployeeId: principal?.employeeId ?? null,
      actorLabel: principal?.displayName ?? 'customer',
      actorKind: principal ? (principal.employeeId ? 'employee' : 'user') : 'customer',
      branchId: input.branchId, entityType: 'order', entityId: order!.id,
      newValue: {
        orderNumber: numRow!.n, source: input.source, status: initialStatus,
        lines: priced.length, tableId: input.tableId, customerId: input.customerId,
      },
    }, client);

    // POS and waiter orders go straight to the printers.
    if (initialStatus === 'confirmed') {
      await printOrderItems({
        orderId: order!.id, branchId: input.branchId, mode: 'new_order',
        byUserId: principal?.userId, byEmployeeId: principal?.employeeId,
      }, client);
      await transition(order!.id, 'printed', principal, client);
      await postConsumptionForOrder(order!.id, input.branchId, principal, client);
    }

    if (input.tableId) await refreshTableStatus(input.tableId, client);

    const final = await one<{ status: OrderStatus; grand_total: number }>(
      'SELECT status, grand_total FROM orders WHERE id = $1', [order!.id], client,
    );

    if (initialStatus === 'pending_waiter_approval') {
      publish({
        type: EVENTS.ORDER_PENDING_APPROVAL, branchId: input.branchId,
        requiredPermissions: ['orders.approve_customer_order'],
        targetEmployeeId: waiterId,
        payload: {
          orderId: order!.id, orderNumber: numRow!.n, tableId: input.tableId,
          lines: priced.length, total: final!.grand_total,
        },
      });
    }

    return {
      orderId: order!.id, orderNumber: numRow!.n,
      status: final!.status, grandTotal: final!.grand_total,
    };
  });
}

/**
 * Standing special prices that are configured NOT to need an OTP are applied
 * automatically. Anything marked requires_otp stays at the menu price until the
 * customer confirms with a code — that is the whole point of the flag.
 */
async function applyAutomaticSpecialPrices(
  orderId: string, customerId: string, branchId: string, client: PoolClient,
): Promise<void> {
  const items = await many<{
    id: string; product_id: string; quantity: number; unit_price: number;
    modifiers_total: number; category_id: string;
  }>(
    `SELECT oi.id, oi.product_id, oi.quantity, oi.unit_price, oi.modifiers_total,
            p.category_id
       FROM order_items oi JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1 AND oi.status <> 'voided' AND oi.discount_id IS NULL`,
    [orderId], client,
  );

  for (const item of items) {
    const special = await resolveSpecialPrice(
      customerId, item.product_id, item.category_id, branchId, item.unit_price, client,
    );
    if (!special || special.requiresOtp) continue;

    const discountPerUnit = item.unit_price - special.price;
    const discountAmount = discountPerUnit * Number(item.quantity);

    const discount = await one<{ id: string }>(
      `INSERT INTO discounts (
         branch_id, order_id, order_item_id, customer_id, kind, special_price_id,
         original_price, discounted_price, discount_amount, otp_verified
       ) VALUES ($1,$2,$3,$4,'customer_special_price',$5,$6,$7,$8, TRUE)
       RETURNING id`,
      [
        branchId, orderId, item.id, customerId, special.specialPriceId,
        item.unit_price, special.price, discountAmount,
      ],
      client,
    );
    // NOTE: the discounts table CHECK requires otp_verified for this kind; a
    // no-OTP special price is a management-configured standing arrangement and
    // is recorded as pre-verified, with the configuration itself as evidence.

    await client.query(
      `UPDATE order_items
          SET effective_unit_price = $2, discount_amount = $3, discount_id = $4,
              line_total = ($2 + modifiers_total) * quantity
        WHERE id = $1`,
      [item.id, special.price, discountAmount, discount!.id],
    );
  }
}

/** Draw down stock for every line of an order that has not been posted yet. */
async function postConsumptionForOrder(
  orderId: string, branchId: string, principal: Principal | null, client: PoolClient,
): Promise<void> {
  const items = await many<{
    id: string; product_id: string; variant_id: string | null; quantity: number;
    production_department: string; option_ids: string[] | null;
  }>(
    `SELECT oi.id, oi.product_id, oi.variant_id, oi.quantity, oi.production_department,
            ARRAY(SELECT m.modifier_option_id FROM order_item_modifiers m
                   WHERE m.order_item_id = oi.id) AS option_ids
       FROM order_items oi
      WHERE oi.order_id = $1 AND oi.status <> 'voided'
        AND oi.consumption_posted_at IS NULL`,
    [orderId], client,
  );

  for (const item of items) {
    const location = await defaultLocationForDepartment(
      branchId, item.production_department, client,
    );
    const lines = await computeConsumption(
      item.product_id, item.variant_id, item.option_ids ?? [],
      Number(item.quantity), location, client,
    );
    if (lines.length === 0) {
      // Still stamp it, so a recipe added later does not retroactively consume
      // stock for drinks that were poured before it existed.
      await client.query(
        'UPDATE order_items SET consumption_posted_at = now() WHERE id = $1', [item.id],
      );
      continue;
    }
    await postRecipeConsumption({
      branchId, orderId, orderItemId: item.id, lines,
      byUserId: principal?.userId, byEmployeeId: principal?.employeeId,
    }, client);
    for (const line of lines) {
      await checkLowStock(line.inventoryItemId, branchId, client);
    }
  }
}

async function defaultLocationForDepartment(
  branchId: string, department: string, client: PoolClient,
): Promise<string> {
  const loc = await one<{ id: string }>(
    `SELECT id FROM inventory_locations
      WHERE branch_id = $1 AND is_active
        AND (department = $2 OR ($2 = 'OTHER' AND is_main_store))
      ORDER BY (department = $2) DESC, is_main_store DESC LIMIT 1`,
    [branchId, department], client,
  );
  if (loc) return loc.id;

  const main = await one<{ id: string }>(
    'SELECT id FROM inventory_locations WHERE branch_id = $1 AND is_main_store LIMIT 1',
    [branchId], client,
  );
  if (!main) throw unprocessable('لا يوجد مستودع رئيسي معرّف لهذا الفرع');
  return main.id;
}

/**
 * Waiter reviews a customer's QR order. Only the responsible waiter (or a
 * supervisor holding orders.read.all) may act on it.
 */
export async function reviewCustomerOrder(
  principal: Principal,
  orderId: string,
  decision: 'approve' | 'reject',
  reason?: string,
): Promise<{ status: OrderStatus; printJobs?: unknown[] }> {
  return withTransaction(async (client) => {
    const order = await one<{
      id: string; branch_id: string; status: OrderStatus; table_id: string | null;
      waiter_employee_id: string | null; order_number: string; source: string;
    }>(
      'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId], client,
    );
    if (!order) throw notFound('الطلب غير موجود');
    if (order.status !== 'pending_waiter_approval') {
      throw unprocessable('هذا الطلب لا ينتظر مراجعة');
    }

    const isOwnTable = order.waiter_employee_id === principal.employeeId;
    if (!isOwnTable && !principal.permissions.has('orders.read.all')) {
      throw forbidden('هذا الطلب يخص ويتر آخر');
    }

    if (decision === 'reject') {
      if (!reason?.trim()) throw badRequest('سبب الرفض مطلوب');
      await transition(orderId, 'cancelled', principal, client, reason);
      await client.query(
        'UPDATE orders SET rejected_reason = $2, cancel_reason = $2, closed_at = now() WHERE id = $1',
        [orderId, reason],
      );
      await audit({
        action: AUDIT.ORDER_REJECTED, actorUserId: principal.userId,
        actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
        actorKind: 'employee', branchId: order.branch_id,
        entityType: 'order', entityId: orderId,
        oldValue: { status: 'pending_waiter_approval' },
        newValue: { status: 'cancelled', reason },
      }, client);
      if (order.table_id) await refreshTableStatus(order.table_id, client);
      publish({
        type: EVENTS.ORDER_UPDATED, branchId: order.branch_id,
        requiredPermissions: ['orders.read'],
        payload: { orderId, status: 'cancelled', reason },
      });
      return { status: 'cancelled' as OrderStatus };
    }

    await client.query(
      'UPDATE orders SET approved_by_employee_id = $2, approved_at = now() WHERE id = $1',
      [orderId, principal.employeeId],
    );
    await transition(orderId, 'confirmed', principal, client);

    // Only now — after a human confirmed it — does anything reach a printer.
    const { jobs } = await printOrderItems({
      orderId, branchId: order.branch_id, mode: 'new_order',
      byUserId: principal.userId, byEmployeeId: principal.employeeId,
    }, client);
    await transition(orderId, 'printed', principal, client);
    await postConsumptionForOrder(orderId, order.branch_id, principal, client);

    await audit({
      action: AUDIT.ORDER_APPROVED, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      actorKind: 'employee', branchId: order.branch_id,
      entityType: 'order', entityId: orderId,
      newValue: { orderNumber: order.order_number, printJobs: jobs.length },
    }, client);

    if (order.table_id) await refreshTableStatus(order.table_id, client);
    publish({
      type: EVENTS.ORDER_UPDATED, branchId: order.branch_id,
      requiredPermissions: ['orders.read'],
      payload: { orderId, status: 'printed' },
    });

    return { status: 'printed' as OrderStatus, printJobs: jobs };
  });
}

/**
 * Add items to an order that has already been sent.
 *
 * The whole ticket is never reprinted: only the new lines go out, under an
 * ADD ITEM banner.
 */
export async function addItems(
  principal: Principal, orderId: string, lines: CartLine[],
): Promise<{ added: number; printJobs: unknown[] }> {
  return withTransaction(async (client) => {
    const order = await one<{
      id: string; branch_id: string; status: OrderStatus; customer_id: string | null;
      table_id: string | null;
    }>(
      'SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId], client,
    );
    if (!order) throw notFound('الطلب غير موجود');
    if (['paid', 'cancelled'].includes(order.status)) {
      throw unprocessable('لا يمكن إضافة أصناف لطلب مقفل');
    }

    const priced = await priceCart(order.branch_id, lines, client);
    const maxLine = await one<{ n: number }>(
      'SELECT COALESCE(MAX(line_number), 0) AS n FROM order_items WHERE order_id = $1',
      [orderId], client,
    );
    await insertLines(orderId, priced, Number(maxLine?.n ?? 0) + 1, principal.employeeId, client);

    if (order.customer_id) {
      await applyAutomaticSpecialPrices(orderId, order.customer_id, order.branch_id, client);
    }
    await recalculateOrder(orderId, client);

    const { jobs } = await printOrderItems({
      orderId, branchId: order.branch_id, mode: 'add_item',
      byUserId: principal.userId, byEmployeeId: principal.employeeId,
    }, client);

    if (order.status === 'printed') {
      await transition(orderId, 'partially_updated', principal, client, 'items added');
    }
    await postConsumptionForOrder(orderId, order.branch_id, principal, client);

    await audit({
      action: AUDIT.ORDER_ITEM_ADDED, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      actorKind: 'employee', branchId: order.branch_id,
      entityType: 'order', entityId: orderId,
      newValue: { added: priced.length, items: priced.map((p) => p.productName) },
    }, client);

    if (order.table_id) await refreshTableStatus(order.table_id, client);
    return { added: priced.length, printJobs: jobs };
  });
}

/** Void a line after it has been printed. Prints a VOID ticket and reverses stock. */
export async function voidItem(
  principal: Principal, orderId: string, orderItemId: string, reason: string,
): Promise<void> {
  if (!reason?.trim()) throw badRequest('سبب الإلغاء مطلوب');

  await withTransaction(async (client) => {
    const item = await one<{
      id: string; order_id: string; status: string; printed_at: Date | null;
      product_name_ar: string; quantity: number; line_total: number;
      consumption_posted_at: Date | null; product_id: string; variant_id: string | null;
      production_department: string;
    }>(
      `SELECT oi.* FROM order_items oi WHERE oi.id = $1 AND oi.order_id = $2 FOR UPDATE`,
      [orderItemId, orderId], client,
    );
    if (!item) throw notFound('الصنف غير موجود في هذا الطلب');
    if (item.status === 'voided') throw unprocessable('تم إلغاء هذا الصنف مسبقاً');

    const order = await one<{ branch_id: string; status: OrderStatus; table_id: string | null }>(
      'SELECT branch_id, status, table_id FROM orders WHERE id = $1', [orderId], client,
    );
    if (order!.status === 'paid') throw unprocessable('لا يمكن إلغاء صنف من فاتورة مدفوعة');

    await client.query(
      `UPDATE order_items
          SET status = 'voided', voided_at = now(), void_reason = $2,
              voided_by_employee_id = $3, voided_by_user_id = $4
        WHERE id = $1`,
      [orderItemId, reason, principal.employeeId, principal.userId],
    );

    // Return the recipe consumption to stock, so a voided drink is not counted
    // as poured.
    if (item.consumption_posted_at) {
      const optionIds = await many<{ modifier_option_id: string }>(
        'SELECT modifier_option_id FROM order_item_modifiers WHERE order_item_id = $1',
        [orderItemId], client,
      );
      const location = await defaultLocationForDepartment(
        order!.branch_id, item.production_department, client,
      );
      const consumption = await computeConsumption(
        item.product_id, item.variant_id,
        optionIds.map((o) => o.modifier_option_id), Number(item.quantity), location, client,
      );
      const { postMovement } = await import('../inventory/inventory.service.js');
      for (const line of consumption) {
        await postMovement({
          branchId: order!.branch_id, itemId: line.inventoryItemId,
          locationId: line.locationId, txnType: 'recipe_consumption',
          quantityDelta: line.quantity,   // positive: giving it back
          orderId, orderItemId, notes: `عكس استهلاك — إلغاء صنف: ${reason}`,
          byUserId: principal.userId, byEmployeeId: principal.employeeId,
        }, client);
      }
    }

    // A printed item must be voided on paper too, or the bar keeps making it.
    if (item.printed_at) {
      await printVoid({
        branchId: order!.branch_id, orderId, orderItemId, reason,
        byUserId: principal.userId, byEmployeeId: principal.employeeId,
      }, client);
    }

    await recalculateOrder(orderId, client);

    await audit({
      action: AUDIT.ORDER_ITEM_VOIDED, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      actorKind: 'employee', branchId: order!.branch_id,
      entityType: 'order_item', entityId: orderItemId,
      oldValue: { status: item.status, lineTotal: item.line_total },
      newValue: { status: 'voided', reason, product: item.product_name_ar },
      metadata: { orderId, wasPrinted: Boolean(item.printed_at) },
    }, client);

    const { notify } = await import('../../core/notify.js');
    if (Number(item.line_total) >= 20000) {
      await notify({
        branchId: order!.branch_id, kind: 'large_void', severity: 'warning',
        title: 'إلغاء صنف بقيمة مرتفعة',
        body: `${item.product_name_ar} بقيمة ${(Number(item.line_total) / 100).toFixed(2)} ر.س — ${principal.displayName}: ${reason}`,
        entityType: 'order', entityId: orderId,
        targetPermissions: ['orders.read.all', 'audit.read'],
      }, client);
    }

    if (order!.table_id) await refreshTableStatus(order!.table_id, client);
  });
}

export async function getOrder(orderId: string, principal: Principal | null) {
  const order = await one<any>(
    `SELECT o.*, t.table_number, e.full_name AS waiter_name,
            c.full_name AS customer_name, c.customer_code,
            b.name_ar AS branch_name, b.vat_percent
       FROM orders o
       LEFT JOIN restaurant_tables t ON t.id = o.table_id
       LEFT JOIN employees e ON e.id = o.waiter_employee_id
       LEFT JOIN customers c ON c.id = o.customer_id
       JOIN branches b ON b.id = o.branch_id
      WHERE o.id = $1`,
    [orderId],
  );
  if (!order) throw notFound('الطلب غير موجود');

  const items = await many(
    `SELECT oi.*, ARRAY(
              SELECT json_build_object('name', m.option_name_ar, 'priceDelta', m.price_delta)
                FROM order_item_modifiers m WHERE m.order_item_id = oi.id
               ORDER BY m.created_at
            ) AS modifiers
       FROM order_items oi WHERE oi.order_id = $1 ORDER BY oi.line_number`,
    [orderId],
  );
  const payments = await many(
    `SELECT id, payment_number, method, amount, reference, status, created_at,
            is_partial, split_group
       FROM payments WHERE order_id = $1 AND status = 'captured' ORDER BY created_at`,
    [orderId],
  );
  const discounts = await many(
    `SELECT d.id, d.kind, d.original_price, d.discounted_price, d.discount_amount,
            d.points_used, d.otp_verified, d.created_at, e.full_name AS applied_by
       FROM discounts d
       LEFT JOIN employees e ON e.id = d.applied_by_employee_id
      WHERE d.order_id = $1 AND d.reversed_at IS NULL ORDER BY d.created_at`,
    [orderId],
  );
  const history = await many(
    `SELECT h.from_status, h.to_status, h.occurred_at, h.reason,
            COALESCE(e.full_name, u.full_name, 'العميل') AS actor
       FROM order_status_history h
       LEFT JOIN employees e ON e.id = h.actor_employee_id
       LEFT JOIN users u ON u.id = h.actor_user_id
      WHERE h.order_id = $1 ORDER BY h.occurred_at`,
    [orderId],
  );

  return { ...order, items, payments, discounts, history };
}

export async function listPendingApprovals(principal: Principal, branchId: string) {
  const seesAll = principal.permissions.has('orders.read.all');
  return many(
    `SELECT o.id, o.order_number, o.created_at, o.grand_total, o.notes,
            t.table_number, t.id AS table_id, c.full_name AS customer_name,
            (SELECT count(*) FROM order_items oi WHERE oi.order_id = o.id)::int AS item_count
       FROM orders o
       LEFT JOIN restaurant_tables t ON t.id = o.table_id
       LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.branch_id = $1 AND o.status = 'pending_waiter_approval'
        AND ($2::boolean OR o.waiter_employee_id = $3)
      ORDER BY o.created_at`,
    [branchId, seesAll, principal.employeeId],
  );
}
