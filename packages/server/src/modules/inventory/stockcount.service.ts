import { many, one, withTransaction } from '../../core/db.js';
import { AUDIT, audit } from '../../core/audit.js';
import { badRequest, notFound, unprocessable } from '../../core/errors.js';
import { notify } from '../../core/notify.js';
import { config } from '../../core/config.js';
import type { Principal } from '../../core/principal.js';
import { postMovement, toBaseForItem } from './inventory.service.js';

/**
 * Stock counting and variance.
 *
 * Expected stock is derived from the ledger over the counting period:
 *
 *   opening + received + transfers_in
 *           - transfers_out - recipe_consumption - waste ± adjustments
 *   = expected
 *
 * Because every one of those movements is a row in inventory_transactions,
 * "expected" is simply the opening balance plus the sum of the period's deltas,
 * broken out by type so a manager can see *where* the stock went, not just that
 * it is missing.
 */

export interface OpenCountInput {
  branchId: string;
  locationId: string;
  countType: 'daily' | 'weekly' | 'monthly' | 'ad_hoc';
  periodStart?: string | null;
  itemIds?: string[];
  notes?: string | null;
}

export async function openStockCount(
  principal: Principal, input: OpenCountInput,
): Promise<{ id: string; countNumber: string; items: unknown[] }> {
  return withTransaction(async (client) => {
    const existing = await one(
      `SELECT id FROM stock_counts
        WHERE location_id = $1 AND status = 'open' LIMIT 1`,
      [input.locationId], client,
    );
    if (existing) throw unprocessable('يوجد جرد مفتوح لهذا الموقع بالفعل');

    const numRow = await one<{ n: string }>(
      `SELECT next_document_number($1,'CNT', EXTRACT(YEAR FROM now())::int) AS n`,
      [input.branchId], client,
    );

    // Default period: since the last approved count at this location.
    const lastCount = await one<{ approved_at: Date }>(
      `SELECT approved_at FROM stock_counts
        WHERE location_id = $1 AND status = 'approved'
        ORDER BY approved_at DESC LIMIT 1`,
      [input.locationId], client,
    );
    const periodStart = input.periodStart
      ?? lastCount?.approved_at?.toISOString()
      ?? new Date(Date.now() - 30 * 86_400_000).toISOString();

    const count = await one<{ id: string }>(
      `INSERT INTO stock_counts (
         count_number, branch_id, location_id, count_type, period_start, period_end,
         notes, opened_by_employee_id, opened_by_user_id
       ) VALUES ($1,$2,$3,$4,$5, now(), $6,$7,$8) RETURNING id`,
      [
        numRow!.n, input.branchId, input.locationId, input.countType, periodStart,
        input.notes ?? null, principal.employeeId, principal.userId,
      ],
      client,
    );

    // Break the period down by movement type so the count sheet explains itself.
    const breakdown = await many<{
      item_id: string; name_ar: string; base_unit: string; average_cost: number;
      current_qty: number; received: number; transfer_in: number; transfer_out: number;
      consumption: number; waste: number; adjustments: number;
    }>(
      `WITH scope AS (
         SELECT i.id, i.name_ar, i.base_unit, i.average_cost
           FROM inventory_items i
          WHERE i.branch_id = $1 AND i.is_active AND i.deleted_at IS NULL
            AND ($4::uuid[] IS NULL OR i.id = ANY($4::uuid[]))
       ),
       movements AS (
         SELECT t.item_id,
                SUM(CASE WHEN t.txn_type = 'receive'            THEN t.quantity_delta ELSE 0 END) AS received,
                SUM(CASE WHEN t.txn_type = 'transfer_in'        THEN t.quantity_delta ELSE 0 END) AS transfer_in,
                SUM(CASE WHEN t.txn_type = 'transfer_out'       THEN -t.quantity_delta ELSE 0 END) AS transfer_out,
                SUM(CASE WHEN t.txn_type = 'recipe_consumption' THEN -t.quantity_delta ELSE 0 END) AS consumption,
                SUM(CASE WHEN t.txn_type = 'waste'              THEN -t.quantity_delta ELSE 0 END) AS waste,
                SUM(CASE WHEN t.txn_type IN ('manual_adjustment','count_adjustment')
                                                                THEN t.quantity_delta ELSE 0 END) AS adjustments
           FROM inventory_transactions t
          WHERE t.location_id = $2 AND t.occurred_at >= $3
          GROUP BY t.item_id
       )
       SELECT s.id AS item_id, s.name_ar, s.base_unit, s.average_cost,
              COALESCE(st.quantity, 0) AS current_qty,
              COALESCE(m.received, 0) AS received,
              COALESCE(m.transfer_in, 0) AS transfer_in,
              COALESCE(m.transfer_out, 0) AS transfer_out,
              COALESCE(m.consumption, 0) AS consumption,
              COALESCE(m.waste, 0) AS waste,
              COALESCE(m.adjustments, 0) AS adjustments
         FROM scope s
         LEFT JOIN inventory_stock st ON st.item_id = s.id AND st.location_id = $2
         LEFT JOIN movements m ON m.item_id = s.id
        ORDER BY s.name_ar`,
      [input.branchId, input.locationId, periodStart, input.itemIds ?? null],
      client,
    );

    for (const row of breakdown) {
      // The ledger balance IS the expected quantity — the movement breakdown
      // below it is the explanation, and the two agree by construction.
      const expected = Number(row.current_qty);
      const opening = expected
        - Number(row.received) - Number(row.transfer_in)
        + Number(row.transfer_out) + Number(row.consumption) + Number(row.waste)
        - Number(row.adjustments);

      await client.query(
        `INSERT INTO stock_count_items (
           stock_count_id, item_id, opening_quantity, received_quantity,
           transfer_in_quantity, transfer_out_quantity, recipe_consumption,
           waste_quantity, adjustment_quantity, expected_quantity, unit_cost
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          count!.id, row.item_id, opening, row.received, row.transfer_in,
          row.transfer_out, row.consumption, row.waste, row.adjustments,
          expected, row.average_cost,
        ],
      );
    }

    await audit({
      action: AUDIT.STOCK_COUNT_OPENED, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      branchId: input.branchId, entityType: 'stock_count', entityId: count!.id,
      newValue: { countNumber: numRow!.n, items: breakdown.length, periodStart },
    }, client);

    const items = await many(
      `SELECT sci.*, ii.name_ar, ii.sku, ii.base_unit, ii.stock_unit
         FROM stock_count_items sci JOIN inventory_items ii ON ii.id = sci.item_id
        WHERE sci.stock_count_id = $1 ORDER BY ii.name_ar`,
      [count!.id], client,
    );

    return { id: count!.id, countNumber: numRow!.n, items };
  });
}

export async function enterCounts(
  principal: Principal,
  countId: string,
  entries: Array<{ itemId: string; countedQuantity: number; unit: string; notes?: string }>,
): Promise<void> {
  await withTransaction(async (client) => {
    const count = await one<{ status: string; branch_id: string }>(
      'SELECT status, branch_id FROM stock_counts WHERE id = $1', [countId], client,
    );
    if (!count) throw notFound('الجرد غير موجود');
    if (count.status !== 'open') throw unprocessable('لا يمكن التعديل بعد إقفال الجرد');

    for (const entry of entries) {
      const baseQty = await toBaseForItem(entry.itemId, entry.countedQuantity, entry.unit, client);
      await client.query(
        `UPDATE stock_count_items
            SET counted_quantity = $3,
                entered_quantity = $4,
                entered_unit = $5,
                variance_quantity = $3 - expected_quantity,
                variance_value = ROUND(($3 - expected_quantity) * unit_cost)::bigint,
                variance_percent = CASE
                  WHEN expected_quantity = 0 THEN NULL
                  ELSE ROUND((($3 - expected_quantity) / expected_quantity) * 100, 3)
                END,
                notes = COALESCE($6, notes),
                counted_at = now()
          WHERE stock_count_id = $1 AND item_id = $2`,
        [countId, entry.itemId, baseQty, entry.countedQuantity, entry.unit, entry.notes ?? null],
      );
    }
  });
}

export async function submitCount(
  principal: Principal, countId: string,
): Promise<{ totalVarianceValue: number; variancePercent: number | null; flagged: unknown[] }> {
  return withTransaction(async (client) => {
    const count = await one<any>(
      'SELECT * FROM stock_counts WHERE id = $1 FOR UPDATE', [countId], client,
    );
    if (!count) throw notFound('الجرد غير موجود');
    if (count.status !== 'open') throw unprocessable('تم إرسال هذا الجرد مسبقاً');

    const uncounted = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM stock_count_items
        WHERE stock_count_id = $1 AND counted_quantity IS NULL`,
      [countId], client,
    );
    if ((uncounted?.n ?? 0) > 0) {
      throw badRequest(`تبقى ${uncounted!.n} صنفاً بدون جرد فعلي`);
    }

    const totals = await one<{ variance_value: number; expected_value: number }>(
      `SELECT COALESCE(SUM(variance_value), 0) AS variance_value,
              COALESCE(SUM(ROUND(expected_quantity * unit_cost)), 0) AS expected_value
         FROM stock_count_items WHERE stock_count_id = $1`,
      [countId], client,
    );

    const varianceValue = Number(totals?.variance_value ?? 0);
    const expectedValue = Number(totals?.expected_value ?? 0);
    const variancePercent = expectedValue > 0
      ? Math.round((Math.abs(varianceValue) / expectedValue) * 100 * 1000) / 1000
      : null;

    await client.query(
      `UPDATE stock_counts
          SET status = 'submitted', submitted_at = now(),
              submitted_by_employee_id = $2,
              total_variance_value = $3, variance_percent = $4
        WHERE id = $1`,
      [countId, principal.employeeId, varianceValue, variancePercent],
    );

    const flagged = await many(
      `SELECT sci.item_id, ii.name_ar, sci.expected_quantity, sci.counted_quantity,
              sci.variance_quantity, sci.variance_value, sci.variance_percent
         FROM stock_count_items sci JOIN inventory_items ii ON ii.id = sci.item_id
        WHERE sci.stock_count_id = $1
          AND (ABS(COALESCE(sci.variance_percent, 0)) >= $2
            OR ABS(COALESCE(sci.variance_value, 0)) >= $3)
        ORDER BY ABS(sci.variance_value) DESC`,
      [countId, config.inventory.varianceAlertPercent, config.inventory.varianceAlertValue],
      client,
    );

    await audit({
      action: AUDIT.STOCK_COUNT_SUBMITTED, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      branchId: count.branch_id, entityType: 'stock_count', entityId: countId,
      newValue: { varianceValue, variancePercent, flaggedItems: flagged.length },
    }, client);

    // Alert when the count as a whole, or any single item, breaches a threshold.
    const breaches = (variancePercent ?? 0) >= config.inventory.varianceAlertPercent
      || Math.abs(varianceValue) >= config.inventory.varianceAlertValue
      || flagged.length > 0;

    if (breaches) {
      await notify({
        branchId: count.branch_id, kind: 'inventory_variance', severity: 'critical',
        title: 'فروقات جرد تتجاوز الحد المسموح',
        body: `جرد ${count.count_number}: فرق ${(varianceValue / 100).toFixed(2)} ر.س`
          + (variancePercent != null ? ` (${variancePercent}%)` : '')
          + `، ${flagged.length} صنفاً خارج الحد.`,
        entityType: 'stock_count', entityId: countId,
        targetPermissions: ['stock_counts.approve', 'reports.inventory'],
        metadata: { varianceValue, variancePercent, flagged: flagged.length },
      }, client);
    }

    return { totalVarianceValue: varianceValue, variancePercent, flagged };
  });
}

/**
 * Approve a count and write the correcting movements, so the ledger and the
 * shelf agree again. The adjustment is itself a ledger row — nothing is
 * silently rewritten.
 */
export async function approveCount(
  principal: Principal, countId: string, approve: boolean, reason?: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const count = await one<any>(
      'SELECT * FROM stock_counts WHERE id = $1 FOR UPDATE', [countId], client,
    );
    if (!count) throw notFound('الجرد غير موجود');
    if (count.status !== 'submitted') throw unprocessable('الجرد ليس بانتظار الاعتماد');

    if (!approve) {
      await client.query(
        `UPDATE stock_counts SET status = 'rejected', approved_by_user_id = $2,
                approved_at = now(), reject_reason = $3 WHERE id = $1`,
        [countId, principal.userId, reason ?? null],
      );
      return;
    }

    const items = await many<{
      item_id: string; variance_quantity: number; unit_cost: number;
    }>(
      `SELECT item_id, variance_quantity, unit_cost FROM stock_count_items
        WHERE stock_count_id = $1 AND variance_quantity IS NOT NULL
          AND variance_quantity <> 0`,
      [countId], client,
    );

    for (const item of items) {
      await postMovement({
        branchId: count.branch_id, itemId: item.item_id, locationId: count.location_id,
        txnType: 'count_adjustment', quantityDelta: Number(item.variance_quantity),
        unitCost: Number(item.unit_cost), stockCountId: countId,
        reference: count.count_number, notes: 'تسوية جرد',
        byUserId: principal.userId,
      }, client);
    }

    await client.query(
      `UPDATE stock_counts SET status = 'approved', approved_by_user_id = $2, approved_at = now()
        WHERE id = $1`,
      [countId, principal.userId],
    );

    await audit({
      action: AUDIT.STOCK_COUNT_APPROVED, actorUserId: principal.userId,
      actorLabel: principal.displayName, branchId: count.branch_id,
      entityType: 'stock_count', entityId: countId,
      newValue: { adjustedItems: items.length, varianceValue: count.total_variance_value },
    }, client);
  });
}

export async function getCount(countId: string) {
  const count = await one<any>(
    `SELECT sc.*, l.name_ar AS location_name, b.name_ar AS branch_name
       FROM stock_counts sc
       JOIN inventory_locations l ON l.id = sc.location_id
       JOIN branches b ON b.id = sc.branch_id
      WHERE sc.id = $1`,
    [countId],
  );
  if (!count) throw notFound('الجرد غير موجود');

  const items = await many(
    `SELECT sci.*, ii.name_ar, ii.sku, ii.base_unit, ii.stock_unit
       FROM stock_count_items sci JOIN inventory_items ii ON ii.id = sci.item_id
      WHERE sci.stock_count_id = $1
      ORDER BY ABS(COALESCE(sci.variance_value, 0)) DESC, ii.name_ar`,
    [countId],
  );
  return { ...count, items };
}
