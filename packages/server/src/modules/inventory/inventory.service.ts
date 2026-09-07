import type { PoolClient } from 'pg';
import { toBaseUnit, type Unit } from '@mara/shared';
import { many, one, pool, withTransaction } from '../../core/db.js';
import { AUDIT, audit } from '../../core/audit.js';
import { badRequest, notFound, unprocessable } from '../../core/errors.js';
import { notify } from '../../core/notify.js';
import { config } from '../../core/config.js';
import { assertBranchAccess, type Principal } from '../../core/principal.js';
import { EVENTS, publish } from '../../core/realtime.js';

export type TxnType =
  | 'receive' | 'transfer_out' | 'transfer_in' | 'recipe_consumption'
  | 'waste' | 'count_adjustment' | 'manual_adjustment' | 'return_to_supplier';

export interface StockMovement {
  branchId: string;
  itemId: string;
  locationId: string;
  txnType: TxnType;
  /** Signed, in base units. Negative removes stock. */
  quantityDelta: number;
  unitCost?: number | null;
  orderId?: string | null;
  orderItemId?: string | null;
  goodsReceiptId?: string | null;
  transferId?: string | null;
  wasteRecordId?: string | null;
  stockCountId?: string | null;
  purchaseId?: string | null;
  reference?: string | null;
  notes?: string | null;
  byUserId?: string | null;
  byEmployeeId?: string | null;
}

/**
 * The single writer for stock. Every receipt, transfer, sale, waste record and
 * count adjustment funnels through here, so the ledger is complete by
 * construction and `inventory_stock` can never drift from its history.
 *
 * The stock row is locked before the balance is read, which serialises two
 * concurrent movements of the same item at the same location.
 */
export async function postMovement(
  m: StockMovement,
  client: PoolClient,
): Promise<{ balance: number; transactionId: number }> {
  await client.query(
    `INSERT INTO inventory_stock (item_id, location_id, quantity)
     VALUES ($1, $2, 0) ON CONFLICT (item_id, location_id) DO NOTHING`,
    [m.itemId, m.locationId],
  );

  const stock = await one<{ quantity: number }>(
    'SELECT quantity FROM inventory_stock WHERE item_id = $1 AND location_id = $2 FOR UPDATE',
    [m.itemId, m.locationId], client,
  );

  const balanceAfter = Number(stock!.quantity) + m.quantityDelta;

  const totalCost = m.unitCost != null
    ? Math.round(Math.abs(m.quantityDelta) * m.unitCost)
    : null;

  const txn = await one<{ id: number }>(
    `INSERT INTO inventory_transactions (
       branch_id, item_id, location_id, txn_type, quantity_delta, balance_after,
       unit_cost, total_cost, order_id, order_item_id, goods_receipt_id, transfer_id,
       waste_record_id, stock_count_id, purchase_id, reference, notes,
       performed_by_employee_id, performed_by_user_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING id`,
    [
      m.branchId, m.itemId, m.locationId, m.txnType, m.quantityDelta, balanceAfter,
      m.unitCost ?? null, totalCost, m.orderId ?? null, m.orderItemId ?? null,
      m.goodsReceiptId ?? null, m.transferId ?? null, m.wasteRecordId ?? null,
      m.stockCountId ?? null, m.purchaseId ?? null, m.reference ?? null, m.notes ?? null,
      m.byEmployeeId ?? null, m.byUserId ?? null,
    ],
    client,
  );

  await client.query(
    'UPDATE inventory_stock SET quantity = $3, updated_at = now() WHERE item_id = $1 AND location_id = $2',
    [m.itemId, m.locationId, balanceAfter],
  );

  return { balance: balanceAfter, transactionId: txn!.id };
}

/**
 * Weighted-average costing. Called on receipt, before the stock movement, so
 * the new average reflects the quantity actually on hand at the old cost.
 */
export async function updateAverageCost(
  itemId: string,
  receivedQty: number,
  receivedUnitCost: number,
  client: PoolClient,
): Promise<void> {
  const item = await one<{ average_cost: number }>(
    'SELECT average_cost FROM inventory_items WHERE id = $1 FOR UPDATE',
    [itemId], client,
  );
  if (!item) throw notFound('صنف المخزون غير موجود');

  const onHand = await one<{ total: number }>(
    'SELECT COALESCE(SUM(quantity), 0) AS total FROM inventory_stock WHERE item_id = $1',
    [itemId], client,
  );

  const existingQty = Math.max(0, Number(onHand?.total ?? 0));
  const existingValue = existingQty * Number(item.average_cost);
  const incomingValue = receivedQty * receivedUnitCost;
  const newQty = existingQty + receivedQty;
  const newAverage = newQty > 0 ? (existingValue + incomingValue) / newQty : receivedUnitCost;

  await client.query(
    'UPDATE inventory_items SET average_cost = $2, last_cost = $3 WHERE id = $1',
    [itemId, newAverage, receivedUnitCost],
  );
}

/** Convert a human-entered quantity into base units for a specific item. */
export async function toBaseForItem(
  itemId: string,
  quantity: number,
  unit: string,
  client?: PoolClient,
): Promise<number> {
  const item = await one<{ base_unit: string; pack_size: number | null }>(
    'SELECT base_unit, pack_size FROM inventory_items WHERE id = $1',
    [itemId], client,
  );
  if (!item) throw notFound('صنف المخزون غير موجود');

  try {
    return toBaseUnit(quantity, unit as Unit, item.pack_size);
  } catch (err) {
    throw badRequest((err as Error).message);
  }
}

export interface ReceiveInput {
  branchId: string;
  locationId: string;
  supplierId?: string | null;
  purchaseId?: string | null;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  notes?: string | null;
  items: Array<{
    itemId: string;
    quantity: number;
    unit: string;
    unitCost?: number;      // halalas per entered unit
    expiryDate?: string | null;
    batchNumber?: string | null;
  }>;
}

/**
 * Record a goods receipt: stock in, average cost updated, ledger written.
 *
 * Pass `client` when this is part of a larger unit of work (receiving against
 * a purchase request, say). Opening a second transaction from inside an open
 * one takes a different pooled connection and deadlocks against the locks the
 * caller already holds, so the caller's client must be reused.
 */
export async function receiveGoods(
  principal: Principal,
  input: ReceiveInput,
  client?: PoolClient,
): Promise<{ receiptId: string; receiptNumber: string }> {
  if (input.items.length === 0) throw badRequest('أضف صنفاً واحداً على الأقل');

  if (client) return receiveGoodsWithin(principal, input, client);
  return withTransaction((c) => receiveGoodsWithin(principal, input, c));
}

async function receiveGoodsWithin(
  principal: Principal,
  input: ReceiveInput,
  client: PoolClient,
): Promise<{ receiptId: string; receiptNumber: string }> {
  {
    const numRow = await one<{ n: string }>(
      `SELECT next_document_number($1,'INV', EXTRACT(YEAR FROM now())::int) AS n`,
      [input.branchId], client,
    );

    const receipt = await one<{ id: string }>(
      `INSERT INTO goods_receipts (
         receipt_number, branch_id, supplier_id, location_id, purchase_id,
         invoice_number, invoice_date, notes,
         received_by_employee_id, received_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        numRow!.n, input.branchId, input.supplierId ?? null, input.locationId,
        input.purchaseId ?? null, input.invoiceNumber ?? null,
        input.invoiceDate ?? null, input.notes ?? null,
        principal.employeeId, principal.userId,
      ],
      client,
    );

    let subtotal = 0;
    for (const line of input.items) {
      if (line.quantity <= 0) throw badRequest('الكمية يجب أن تكون أكبر من صفر');
      const baseQty = await toBaseForItem(line.itemId, line.quantity, line.unit, client);
      // Cost is quoted per entered unit; normalise it to per base unit.
      const unitCostBase = line.unitCost != null && baseQty > 0
        ? (line.unitCost * line.quantity) / baseQty
        : 0;
      const lineTotal = Math.round((line.unitCost ?? 0) * line.quantity);
      subtotal += lineTotal;

      await client.query(
        `INSERT INTO goods_receipt_items (
           receipt_id, item_id, quantity, entered_quantity, entered_unit,
           unit_cost, line_total, expiry_date, batch_number
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          receipt!.id, line.itemId, baseQty, line.quantity, line.unit,
          unitCostBase, lineTotal, line.expiryDate ?? null, line.batchNumber ?? null,
        ],
      );

      if (unitCostBase > 0) {
        await updateAverageCost(line.itemId, baseQty, unitCostBase, client);
      }

      await postMovement({
        branchId: input.branchId, itemId: line.itemId, locationId: input.locationId,
        txnType: 'receive', quantityDelta: baseQty, unitCost: unitCostBase,
        goodsReceiptId: receipt!.id, purchaseId: input.purchaseId ?? null,
        reference: numRow!.n, byUserId: principal.userId, byEmployeeId: principal.employeeId,
      }, client);
    }

    const vatRow = await one<{ vat_percent: number }>(
      'SELECT vat_percent FROM branches WHERE id = $1', [input.branchId], client,
    );
    const vat = Math.round(subtotal * Number(vatRow?.vat_percent ?? 0) / 100);
    await client.query(
      'UPDATE goods_receipts SET subtotal = $2, vat_amount = $3, total = $4 WHERE id = $1',
      [receipt!.id, subtotal, vat, subtotal + vat],
    );

    await audit({
      action: AUDIT.INVENTORY_RECEIVED, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      branchId: input.branchId, entityType: 'goods_receipt', entityId: receipt!.id,
      newValue: { receiptNumber: numRow!.n, lines: input.items.length, subtotal },
    }, client);

    return { receiptId: receipt!.id, receiptNumber: numRow!.n };
  }
}

/**
 * Post the recipe consumption for a sold order item.
 *
 * Guarded by `consumption_posted_at`: an order item can only ever draw down
 * stock once, however many times the caller is retried.
 */
export async function postRecipeConsumption(
  args: {
    branchId: string; orderId: string; orderItemId: string;
    lines: Array<{ inventoryItemId: string; locationId: string; quantity: number }>;
    byUserId?: string | null; byEmployeeId?: string | null;
  },
  client: PoolClient,
): Promise<void> {
  const guard = await client.query(
    `UPDATE order_items SET consumption_posted_at = now()
      WHERE id = $1 AND consumption_posted_at IS NULL`,
    [args.orderItemId],
  );
  if (guard.rowCount === 0) return;  // already posted

  for (const line of args.lines) {
    if (line.quantity <= 0) continue;
    const cost = await one<{ average_cost: number }>(
      'SELECT average_cost FROM inventory_items WHERE id = $1',
      [line.inventoryItemId], client,
    );
    await postMovement({
      branchId: args.branchId, itemId: line.inventoryItemId, locationId: line.locationId,
      txnType: 'recipe_consumption', quantityDelta: -line.quantity,
      unitCost: Number(cost?.average_cost ?? 0),
      orderId: args.orderId, orderItemId: args.orderItemId,
      byUserId: args.byUserId, byEmployeeId: args.byEmployeeId,
    }, client);
  }
}

export interface WasteInput {
  branchId: string;
  locationId: string;
  itemId: string;
  quantity: number;
  unit: string;
  reason: string;
  department?: string | null;
  notes?: string | null;
}

/**
 * Record waste. Above the branch threshold the record parks in
 * `pending_approval` and does NOT move stock until a manager signs it off —
 * so a large "breakage" cannot quietly erase a shortage.
 */
export async function recordWaste(
  principal: Principal,
  input: WasteInput,
): Promise<{ id: string; wasteNumber: string; status: string; estimatedCost: number }> {
  if (input.quantity <= 0) throw badRequest('الكمية يجب أن تكون أكبر من صفر');

  return withTransaction(async (client) => {
    const baseQty = await toBaseForItem(input.itemId, input.quantity, input.unit, client);
    const item = await one<{ average_cost: number; name_ar: string }>(
      'SELECT average_cost, name_ar FROM inventory_items WHERE id = $1',
      [input.itemId], client,
    );
    if (!item) throw notFound('صنف المخزون غير موجود');

    const estimatedCost = Math.round(baseQty * Number(item.average_cost));
    const threshold = await wasteThreshold(input.branchId, client);
    const needsApproval = estimatedCost > threshold
      && !principal.permissions.has('waste.approve');

    const numRow = await one<{ n: string }>(
      `SELECT next_document_number($1,'WST', EXTRACT(YEAR FROM now())::int) AS n`,
      [input.branchId], client,
    );

    const record = await one<{ id: string }>(
      `INSERT INTO waste_records (
         waste_number, branch_id, location_id, item_id, quantity, entered_quantity,
         entered_unit, department, reason, notes, estimated_cost, status,
         recorded_by_employee_id, recorded_by_user_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [
        numRow!.n, input.branchId, input.locationId, input.itemId, baseQty,
        input.quantity, input.unit, input.department ?? principal.department,
        input.reason, input.notes ?? null, estimatedCost,
        needsApproval ? 'pending_approval' : 'posted',
        principal.employeeId, principal.userId,
      ],
      client,
    );

    if (!needsApproval) {
      await postMovement({
        branchId: input.branchId, itemId: input.itemId, locationId: input.locationId,
        txnType: 'waste', quantityDelta: -baseQty, unitCost: Number(item.average_cost),
        wasteRecordId: record!.id, reference: numRow!.n, notes: input.reason,
        byUserId: principal.userId, byEmployeeId: principal.employeeId,
      }, client);
    }

    await audit({
      action: AUDIT.WASTE_RECORDED, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      actorKind: principal.employeeId ? 'employee' : 'user',
      branchId: input.branchId, entityType: 'waste_record', entityId: record!.id,
      newValue: {
        wasteNumber: numRow!.n, item: item.name_ar, quantity: baseQty,
        reason: input.reason, estimatedCost, needsApproval,
      },
    }, client);

    if (needsApproval) {
      await notify({
        branchId: input.branchId, kind: 'waste_pending_approval', severity: 'warning',
        title: 'هدر بانتظار الموافقة',
        body: `${item.name_ar} — ${input.quantity} ${input.unit} بقيمة تقديرية ${(estimatedCost / 100).toFixed(2)} ر.س`,
        entityType: 'waste_record', entityId: record!.id,
        targetPermissions: ['waste.approve'],
      }, client);
    } else if (estimatedCost > threshold) {
      await notify({
        branchId: input.branchId, kind: 'high_waste', severity: 'warning',
        title: 'هدر مرتفع',
        body: `${item.name_ar} — قيمة ${(estimatedCost / 100).toFixed(2)} ر.س بواسطة ${principal.displayName}`,
        entityType: 'waste_record', entityId: record!.id,
        targetPermissions: ['waste.read'],
      }, client);
    }

    await checkLowStock(input.itemId, input.branchId, client);

    return {
      id: record!.id, wasteNumber: numRow!.n,
      status: needsApproval ? 'pending_approval' : 'posted', estimatedCost,
    };
  });
}

export async function approveWaste(
  principal: Principal, wasteId: string, approve: boolean, reason?: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const w = await one<any>(
      'SELECT * FROM waste_records WHERE id = $1 FOR UPDATE', [wasteId], client,
    );
    if (!w) throw notFound('سجل الهدر غير موجود');
    assertBranchAccess(principal, w.branch_id);
    if (w.status !== 'pending_approval') throw unprocessable('هذا السجل لا ينتظر موافقة');

    if (approve) {
      const item = await one<{ average_cost: number }>(
        'SELECT average_cost FROM inventory_items WHERE id = $1', [w.item_id], client,
      );
      await postMovement({
        branchId: w.branch_id, itemId: w.item_id, locationId: w.location_id,
        txnType: 'waste', quantityDelta: -Number(w.quantity),
        unitCost: Number(item?.average_cost ?? 0), wasteRecordId: w.id,
        reference: w.waste_number, byUserId: principal.userId,
      }, client);
      await client.query(
        `UPDATE waste_records SET status = 'posted', approved_by_user_id = $2, approved_at = now()
          WHERE id = $1`,
        [wasteId, principal.userId],
      );
    } else {
      await client.query(
        `UPDATE waste_records SET status = 'rejected', approved_by_user_id = $2,
                approved_at = now(), reject_reason = $3
          WHERE id = $1`,
        [wasteId, principal.userId, reason ?? null],
      );
    }

    await audit({
      action: AUDIT.WASTE_APPROVED, actorUserId: principal.userId,
      actorLabel: principal.displayName, branchId: w.branch_id,
      entityType: 'waste_record', entityId: wasteId,
      oldValue: { status: 'pending_approval' },
      newValue: { status: approve ? 'posted' : 'rejected', reason },
    }, client);
  });
}

async function wasteThreshold(branchId: string, client?: PoolClient): Promise<number> {
  const row = await one<{ value: unknown }>(
    `SELECT value FROM settings
      WHERE key = 'waste_approval_threshold' AND (branch_id = $1 OR branch_id IS NULL)
      ORDER BY branch_id NULLS LAST LIMIT 1`,
    [branchId], client,
  );
  const parsed = Number(row?.value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : config.inventory.wasteApprovalThreshold;
}

/**
 * Raise a low-stock alert when an item crosses its minimum. Deliberately does
 * NOT create a purchase request: the specification is explicit that a human in
 * the department decides what to buy.
 */
export async function checkLowStock(
  itemId: string, branchId: string, client?: PoolClient,
): Promise<void> {
  const row = await one<{
    name_ar: string; total_quantity: number; min_level: number;
    base_unit: string; is_low_stock: boolean;
  }>(
    `SELECT name_ar, total_quantity, min_level, base_unit, is_low_stock
       FROM inventory_item_totals WHERE item_id = $1`,
    [itemId], client,
  );
  if (!row?.is_low_stock) return;

  // One alert per item per 12 hours, so a busy service does not bury the rest
  // of the Notification Centre.
  const recent = await one(
    `SELECT 1 FROM notifications
      WHERE kind = 'low_stock' AND entity_id = $1 AND created_at > now() - interval '12 hours'
      LIMIT 1`,
    [itemId], client,
  );
  if (recent) return;

  await notify({
    branchId, kind: 'low_stock', severity: 'warning',
    title: 'مخزون منخفض',
    body: `${row.name_ar}: المتوفر ${row.total_quantity} ${row.base_unit} — الحد الأدنى ${row.min_level}`,
    entityType: 'inventory_item', entityId: itemId,
    targetPermissions: ['inventory.read'],
  }, client);

  publish({
    type: EVENTS.LOW_STOCK, branchId,
    requiredPermissions: ['inventory.read'],
    payload: {
      itemId, name: row.name_ar, quantity: row.total_quantity,
      minLevel: row.min_level, unit: row.base_unit,
    },
  });
}

export async function listStock(branchId: string, locationId?: string | null) {
  if (locationId) {
    return many(
      `SELECT * FROM inventory_stock_levels
        WHERE branch_id = $1 AND location_id = $2
        ORDER BY is_low_stock DESC, name_ar`,
      [branchId, locationId],
    );
  }
  return many(
    `SELECT * FROM inventory_item_totals WHERE branch_id = $1
      ORDER BY is_low_stock DESC, name_ar`,
    [branchId],
  );
}

export async function lowStockItems(branchId: string) {
  return many(
    `SELECT * FROM inventory_item_totals
      WHERE branch_id = $1 AND is_low_stock ORDER BY name_ar`,
    [branchId],
  );
}

/** Manual correction. Always leaves a ledger row and an audit entry. */
export async function adjustStock(
  principal: Principal,
  input: {
    branchId: string; itemId: string; locationId: string;
    quantity: number; unit: string; reason: string;
  },
): Promise<{ balance: number }> {
  return withTransaction(async (client) => {
    const baseQty = await toBaseForItem(input.itemId, Math.abs(input.quantity), input.unit, client);
    const signed = input.quantity < 0 ? -baseQty : baseQty;
    const item = await one<{ average_cost: number; name_ar: string }>(
      'SELECT average_cost, name_ar FROM inventory_items WHERE id = $1', [input.itemId], client,
    );

    const { balance } = await postMovement({
      branchId: input.branchId, itemId: input.itemId, locationId: input.locationId,
      txnType: 'manual_adjustment', quantityDelta: signed,
      unitCost: Number(item?.average_cost ?? 0), notes: input.reason,
      byUserId: principal.userId, byEmployeeId: principal.employeeId,
    }, client);

    await audit({
      action: AUDIT.INVENTORY_ADJUSTED, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      branchId: input.branchId, entityType: 'inventory_item', entityId: input.itemId,
      newValue: { delta: signed, reason: input.reason, balance, item: item?.name_ar },
    }, client);

    await checkLowStock(input.itemId, input.branchId, client);
    return { balance };
  });
}
