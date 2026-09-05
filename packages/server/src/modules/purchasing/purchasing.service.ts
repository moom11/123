import { BUYER_VISIBLE_PR_STATUSES, canTransitionPR, type PurchaseRequestStatus } from '@mara/shared';
import { many, one, pool, withTransaction } from '../../core/db.js';
import { AUDIT, audit } from '../../core/audit.js';
import { badRequest, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { notify } from '../../core/notify.js';
import { EVENTS, publish } from '../../core/realtime.js';
import { assertBranchAccess, type Principal } from '../../core/principal.js';
import { toBaseForItem } from '../inventory/inventory.service.js';

/**
 * Purchasing.
 *
 * Two rules govern this module and are enforced in the data layer rather than
 * the UI:
 *
 *   1. The purchasing rep never sees a request that a branch manager has not
 *      approved — not as a hidden row, not as a count, not at all.
 *   2. The rep only ever sees, and can only ever buy against, the quantity the
 *      manager approved. Buying more requires going back for a decision.
 */

export interface CreatePurchaseRequestInput {
  branchId: string;
  department: 'BAR' | 'KITCHEN' | 'SHISHA' | 'FLOOR' | 'OTHER';
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  reason?: string | null;
  notes?: string | null;
  neededBy?: string | null;
  submit?: boolean;
  items: Array<{
    itemId: string; quantity: number; unit: string;
    reason?: string | null; notes?: string | null; supplierId?: string | null;
  }>;
}

export async function createPurchaseRequest(
  principal: Principal, input: CreatePurchaseRequestInput,
): Promise<{ id: string; requestNumber: string; status: PurchaseRequestStatus }> {
  if (input.items.length === 0) throw badRequest('أضف صنفاً واحداً على الأقل');

  return withTransaction(async (client) => {
    const numRow = await one<{ n: string }>(
      `SELECT next_document_number($1,'PR', EXTRACT(YEAR FROM now())::int) AS n`,
      [input.branchId], client,
    );

    const status: PurchaseRequestStatus = input.submit ? 'pending_branch_manager' : 'draft';

    const pr = await one<{ id: string }>(
      `INSERT INTO purchase_requests (
         request_number, branch_id, department, status, priority, reason, notes,
         needed_by, requested_by_employee_id, requested_by_user_id, submitted_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CASE WHEN $11 THEN now() ELSE NULL END)
       RETURNING id`,
      [
        numRow!.n, input.branchId, input.department, status,
        input.priority ?? 'normal', input.reason ?? null, input.notes ?? null,
        input.neededBy ?? null, principal.employeeId, principal.userId,
        Boolean(input.submit),
      ],
      client,
    );

    let estimatedTotal = 0;
    for (const line of input.items) {
      if (line.quantity <= 0) throw badRequest('الكمية يجب أن تكون أكبر من صفر');
      const baseQty = await toBaseForItem(line.itemId, line.quantity, line.unit, client);

      // Snapshot the stock position so the manager can see why this was raised.
      const stock = await one<{ total_quantity: number; min_level: number; average_cost: number; name_ar: string }>(
        `SELECT total_quantity, min_level, average_cost, name_ar
           FROM inventory_item_totals WHERE item_id = $1`,
        [line.itemId], client,
      );
      const unitCost = Number(stock?.average_cost ?? 0);
      estimatedTotal += Math.round(baseQty * unitCost);

      await client.query(
        `INSERT INTO purchase_request_items (
           request_id, item_id, requested_quantity, entered_quantity, entered_unit,
           current_stock, min_stock, estimated_unit_cost, supplier_id, reason, notes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          pr!.id, line.itemId, baseQty, line.quantity, line.unit,
          stock?.total_quantity ?? 0, stock?.min_level ?? 0, unitCost,
          line.supplierId ?? null, line.reason ?? null, line.notes ?? null,
        ],
      );
    }

    await client.query(
      'UPDATE purchase_requests SET estimated_total = $2 WHERE id = $1',
      [pr!.id, estimatedTotal],
    );

    await audit({
      action: input.submit ? AUDIT.PR_SUBMITTED : AUDIT.PR_CREATED,
      actorUserId: principal.userId, actorEmployeeId: principal.employeeId,
      actorLabel: principal.displayName, actorKind: 'employee',
      branchId: input.branchId, entityType: 'purchase_request', entityId: pr!.id,
      newValue: {
        requestNumber: numRow!.n, department: input.department, status,
        items: input.items.length, estimatedTotal,
      },
    }, client);

    if (input.submit) {
      await notifyManagerPending(pr!.id, numRow!.n, input.branchId, input.department,
        principal.displayName, client);
    }

    return { id: pr!.id, requestNumber: numRow!.n, status };
  });
}

async function notifyManagerPending(
  requestId: string, requestNumber: string, branchId: string,
  department: string, requester: string, client?: import('pg').PoolClient,
): Promise<void> {
  await notify({
    branchId, kind: 'purchase_request_pending', severity: 'warning',
    title: 'طلب شراء بانتظار الاعتماد',
    body: `${requestNumber} — قسم ${department} بواسطة ${requester}`,
    entityType: 'purchase_request', entityId: requestId,
    targetPermissions: ['purchase_requests.approve'],
  }, client);

  publish({
    type: EVENTS.PR_PENDING_APPROVAL, branchId,
    requiredPermissions: ['purchase_requests.approve'],
    payload: { id: requestId, requestNumber, department, requester },
  });
}

export async function submitPurchaseRequest(
  principal: Principal, requestId: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const pr = await one<any>(
      'SELECT * FROM purchase_requests WHERE id = $1 FOR UPDATE', [requestId], client,
    );
    if (!pr) throw notFound('طلب الشراء غير موجود');
    assertBranchAccess(principal, pr.branch_id);
    if (pr.status !== 'draft' && pr.status !== 'submitted') {
      throw unprocessable('لا يمكن إرسال هذا الطلب في حالته الحالية');
    }
    if (pr.requested_by_employee_id !== principal.employeeId
        && !principal.permissions.has('purchase_requests.read.branch')) {
      throw forbidden('لا يمكنك إرسال طلب أنشأه موظف آخر');
    }

    await client.query(
      `UPDATE purchase_requests SET status = 'pending_branch_manager', submitted_at = now()
        WHERE id = $1`,
      [requestId],
    );
    await audit({
      action: AUDIT.PR_SUBMITTED, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      branchId: pr.branch_id, entityType: 'purchase_request', entityId: requestId,
      oldValue: { status: pr.status }, newValue: { status: 'pending_branch_manager' },
    }, client);
    await notifyManagerPending(requestId, pr.request_number, pr.branch_id,
      pr.department, principal.displayName, client);
  });
}

export interface ApprovalDecision {
  decision: 'approve' | 'reject';
  comment?: string | null;
  /** The manager may cut quantities: 60 L requested, 40 L approved. */
  itemQuantities?: Array<{ itemId: string; approvedQuantity: number; unit?: string; note?: string }>;
}

/**
 * Branch-manager approval. This is the gate that makes a request visible to the
 * purchasing rep, and it is where the approved quantity is fixed.
 */
export async function decidePurchaseRequest(
  principal: Principal, requestId: string, decision: ApprovalDecision,
): Promise<{ status: PurchaseRequestStatus }> {
  return withTransaction(async (client) => {
    const pr = await one<any>(
      'SELECT * FROM purchase_requests WHERE id = $1 FOR UPDATE', [requestId], client,
    );
    if (!pr) throw notFound('طلب الشراء غير موجود');
    assertBranchAccess(principal, pr.branch_id);

    const approvable = ['pending_branch_manager', 'submitted'];
    const isChangeReview = ['purchasing', 'approved', 'sent_to_buyer', 'purchased']
      .includes(pr.status);
    if (!approvable.includes(pr.status) && !isChangeReview) {
      throw unprocessable('هذا الطلب ليس بانتظار قرار');
    }

    if (decision.decision === 'reject') {
      if (!decision.comment?.trim()) throw badRequest('سبب الرفض مطلوب');
      await client.query(
        `UPDATE purchase_requests
            SET status = 'rejected', reject_reason = $2, manager_comment = $2,
                approved_by_user_id = $3, approved_at = now()
          WHERE id = $1`,
        [requestId, decision.comment, principal.userId],
      );
      await client.query(
        `INSERT INTO purchase_approvals (request_id, decision, approver_user_id, approver_role, comment)
         VALUES ($1,'rejected',$2,$3,$4)`,
        [requestId, principal.userId, principal.roleCode, decision.comment],
      );
      await audit({
        action: AUDIT.PR_REJECTED, actorUserId: principal.userId,
        actorLabel: principal.displayName, branchId: pr.branch_id,
        entityType: 'purchase_request', entityId: requestId,
        oldValue: { status: pr.status },
        newValue: { status: 'rejected', reason: decision.comment },
      }, client);
      return { status: 'rejected' as PurchaseRequestStatus };
    }

    // Approve — recording every quantity the manager changed.
    const changes: Array<{ itemId: string; requested: number; approved: number }> = [];
    const items = await many<{
      id: string; item_id: string; requested_quantity: number;
      approved_quantity: number | null; entered_unit: string;
    }>(
      'SELECT id, item_id, requested_quantity, approved_quantity, entered_unit FROM purchase_request_items WHERE request_id = $1',
      [requestId], client,
    );

    const overrides = new Map(
      (decision.itemQuantities ?? []).map((q) => [q.itemId, q]),
    );

    for (const item of items) {
      const override = overrides.get(item.item_id);
      let approvedBase: number;

      if (override) {
        if (override.approvedQuantity < 0) throw badRequest('الكمية المعتمدة غير صالحة');
        approvedBase = await toBaseForItem(
          item.item_id, override.approvedQuantity, override.unit ?? item.entered_unit, client,
        );
      } else {
        // No explicit decision: approve exactly what was requested.
        approvedBase = Number(item.requested_quantity);
      }

      await client.query(
        `UPDATE purchase_request_items
            SET approved_quantity = $2, manager_note = COALESCE($3, manager_note),
                change_request_status = CASE
                  WHEN change_request_status = 'pending' THEN 'approved'
                  ELSE change_request_status END
          WHERE id = $1`,
        [item.id, approvedBase, override?.note ?? null],
      );

      if (approvedBase !== Number(item.requested_quantity)) {
        changes.push({
          itemId: item.item_id,
          requested: Number(item.requested_quantity),
          approved: approvedBase,
        });
      }
    }

    const nextStatus: PurchaseRequestStatus = isChangeReview ? pr.status : 'approved';

    await client.query(
      `UPDATE purchase_requests
          SET status = $2, approved_by_user_id = $3, approved_at = now(),
              manager_comment = COALESCE($4, manager_comment), reject_reason = NULL
        WHERE id = $1`,
      [requestId, nextStatus, principal.userId, decision.comment ?? null],
    );

    await client.query(
      `INSERT INTO purchase_approvals
         (request_id, decision, approver_user_id, approver_role, comment, quantity_changes)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        requestId, isChangeReview ? 'change_approved' : 'approved',
        principal.userId, principal.roleCode, decision.comment ?? null,
        JSON.stringify(changes),
      ],
    );

    await audit({
      action: AUDIT.PR_APPROVED, actorUserId: principal.userId,
      actorLabel: principal.displayName, branchId: pr.branch_id,
      entityType: 'purchase_request', entityId: requestId,
      oldValue: { status: pr.status },
      newValue: { status: nextStatus, quantityChanges: changes, comment: decision.comment },
    }, client);

    if (changes.length > 0) {
      await audit({
        action: AUDIT.PR_QUANTITY_CHANGED, actorUserId: principal.userId,
        actorLabel: principal.displayName, branchId: pr.branch_id,
        entityType: 'purchase_request', entityId: requestId,
        newValue: { changes },
      }, client);
    }

    await notify({
      branchId: pr.branch_id, kind: 'purchase_request_approved', severity: 'info',
      title: 'تم اعتماد طلب شراء',
      body: `${pr.request_number} — جاهز للمندوب`,
      entityType: 'purchase_request', entityId: requestId,
      targetPermissions: ['purchasing.buyer'],
    }, client);

    publish({
      type: EVENTS.PR_STATUS, branchId: pr.branch_id,
      requiredPermissions: ['purchasing.buyer', 'purchase_requests.read.branch'],
      payload: { id: requestId, status: nextStatus, requestNumber: pr.request_number },
    });

    return { status: nextStatus };
  });
}

/**
 * The purchasing rep's queue.
 *
 * Reads the buyer_* views, which contain only approved-and-beyond requests and
 * expose the approved quantity rather than the requested one. Even a bug in a
 * caller cannot leak a draft through this path.
 */
export async function listBuyerRequests(
  principal: Principal,
  filters: { branchId?: string | null; status?: string | null } = {},
) {
  if (!principal.permissions.has('purchasing.buyer')) {
    throw forbidden('هذه الشاشة مخصصة لمندوب المشتريات');
  }

  const statuses = filters.status
    ? [filters.status].filter((s) => (BUYER_VISIBLE_PR_STATUSES as readonly string[]).includes(s))
    : [...BUYER_VISIBLE_PR_STATUSES];
  if (statuses.length === 0) throw badRequest('حالة غير مسموح بها');

  const requests = await many<any>(
    `SELECT r.*, b.name_ar AS branch_name,
            (SELECT count(*)::int FROM buyer_purchase_request_items i WHERE i.request_id = r.id) AS item_count
       FROM buyer_purchase_requests r
       JOIN branches b ON b.id = r.branch_id
      WHERE ($1::uuid IS NULL OR r.branch_id = $1)
        AND r.status = ANY($2::text[])
      ORDER BY
        CASE r.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        r.approved_at NULLS LAST`,
    [filters.branchId ?? null, statuses],
  );

  for (const r of requests) {
    r.items = await many(
      `SELECT i.*, ii.name_ar, ii.sku, ii.base_unit, ii.stock_unit, ii.pack_size,
              s.name AS supplier_name
         FROM buyer_purchase_request_items i
         JOIN inventory_items ii ON ii.id = i.item_id
         LEFT JOIN suppliers s ON s.id = i.supplier_id
        WHERE i.request_id = $1
        ORDER BY ii.name_ar`,
      [r.id],
    );
  }
  return requests;
}

/** Aggregated shopping list: same item across departments, totalled but itemised. */
export async function buyerShoppingList(principal: Principal, branchId?: string | null) {
  if (!principal.permissions.has('purchasing.buyer')) {
    throw forbidden('هذه الشاشة مخصصة لمندوب المشتريات');
  }

  const rows = await many<any>(
    `SELECT ii.id AS item_id, ii.name_ar, ii.sku, ii.base_unit, ii.stock_unit,
            SUM(i.approved_quantity) AS total_quantity,
            json_agg(json_build_object(
              'requestId', r.id,
              'requestNumber', r.request_number,
              'department', r.department,
              'quantity', i.approved_quantity,
              'priority', r.priority,
              'status', r.status
            ) ORDER BY r.department) AS breakdown,
            (SELECT sp.unit_price FROM supplier_prices sp
              WHERE sp.item_id = ii.id ORDER BY sp.effective_at DESC LIMIT 1) AS last_price,
            (SELECT AVG(sp.unit_price) FROM supplier_prices sp
              WHERE sp.item_id = ii.id
                AND sp.effective_at > now() - interval '90 days') AS average_price,
            (SELECT MIN(sp.unit_price) FROM supplier_prices sp
              WHERE sp.item_id = ii.id
                AND sp.effective_at > now() - interval '90 days') AS lowest_recent_price
       FROM buyer_purchase_requests r
       JOIN buyer_purchase_request_items i ON i.request_id = r.id
       JOIN inventory_items ii ON ii.id = i.item_id
      WHERE r.status IN ('approved','sent_to_buyer','purchasing')
        AND ($1::uuid IS NULL OR r.branch_id = $1)
        AND i.approved_quantity > 0
      GROUP BY ii.id
      ORDER BY ii.name_ar`,
    [branchId ?? null],
  );
  return rows;
}

/** Status moves the buyer app is allowed to make. */
export async function buyerAdvanceStatus(
  principal: Principal, requestId: string, to: PurchaseRequestStatus,
): Promise<{ status: PurchaseRequestStatus }> {
  if (!principal.permissions.has('purchasing.buyer')) {
    throw forbidden('هذه العملية مخصصة لمندوب المشتريات');
  }

  const allowed: PurchaseRequestStatus[] = ['purchasing', 'purchased', 'in_transit', 'delivered'];
  if (!allowed.includes(to)) throw forbidden('لا يمكن للمندوب تعيين هذه الحالة');

  return withTransaction(async (client) => {
    const pr = await one<any>(
      'SELECT * FROM purchase_requests WHERE id = $1 FOR UPDATE', [requestId], client,
    );
    if (!pr) throw notFound('طلب الشراء غير موجود');
    // A buyer must not even learn that an unapproved request exists.
    if (!(BUYER_VISIBLE_PR_STATUSES as readonly string[]).includes(pr.status)) {
      throw notFound('طلب الشراء غير موجود');
    }
    if (!canTransitionPR(pr.status, to)) {
      throw unprocessable(`لا يمكن الانتقال من ${pr.status} إلى ${to}`);
    }

    const stamps: Record<string, string> = {
      purchasing: 'buyer_started_at', purchased: 'purchased_at',
      in_transit: 'in_transit_at', delivered: 'delivered_at',
    };
    await client.query(
      `UPDATE purchase_requests
          SET status = $2, buyer_user_id = COALESCE(buyer_user_id, $3), ${stamps[to]} = now()
        WHERE id = $1`,
      [requestId, to, principal.userId],
    );

    await audit({
      action: AUDIT.PR_STATUS_CHANGED, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      branchId: pr.branch_id, entityType: 'purchase_request', entityId: requestId,
      oldValue: { status: pr.status }, newValue: { status: to },
    }, client);

    if (to === 'delivered') {
      await notify({
        branchId: pr.branch_id, kind: 'purchase_delivered', severity: 'info',
        title: 'وصلت البضاعة',
        body: `${pr.request_number} — بانتظار تأكيد الاستلام من ${pr.department}`,
        entityType: 'purchase_request', entityId: requestId,
        targetPermissions: ['purchases.receive'],
      }, client);
    }

    publish({
      type: EVENTS.PR_STATUS, branchId: pr.branch_id,
      requiredPermissions: ['purchase_requests.read.branch', 'purchasing.buyer'],
      payload: { id: requestId, status: to, requestNumber: pr.request_number },
    });

    return { status: to };
  });
}

/**
 * The buyer asks to change an approved quantity. They cannot simply type a
 * bigger number — this parks the line and sends it back to the branch manager.
 */
export async function requestQuantityChange(
  principal: Principal,
  requestId: string,
  changes: Array<{ itemId: string; requestedQuantity: number; unit?: string; reason: string }>,
): Promise<void> {
  if (!principal.permissions.has('purchasing.buyer')) {
    throw forbidden('هذه العملية مخصصة لمندوب المشتريات');
  }
  if (changes.length === 0) throw badRequest('حدد صنفاً واحداً على الأقل');

  await withTransaction(async (client) => {
    const pr = await one<any>(
      'SELECT * FROM purchase_requests WHERE id = $1 FOR UPDATE', [requestId], client,
    );
    if (!pr || !(BUYER_VISIBLE_PR_STATUSES as readonly string[]).includes(pr.status)) {
      throw notFound('طلب الشراء غير موجود');
    }
    assertBranchAccess(principal, pr.branch_id);

    for (const change of changes) {
      if (!change.reason?.trim()) throw badRequest('سبب التعديل مطلوب');
      const item = await one<{ id: string; entered_unit: string }>(
        'SELECT id, entered_unit FROM purchase_request_items WHERE request_id = $1 AND item_id = $2',
        [requestId, change.itemId], client,
      );
      if (!item) throw notFound('الصنف غير موجود في هذا الطلب');

      const baseQty = await toBaseForItem(
        change.itemId, change.requestedQuantity, change.unit ?? item.entered_unit, client,
      );
      await client.query(
        `UPDATE purchase_request_items
            SET change_requested_quantity = $2, change_request_reason = $3,
                change_request_status = 'pending'
          WHERE id = $1`,
        [item.id, baseQty, change.reason],
      );
    }

    // Back to the manager for a decision.
    await client.query(
      `UPDATE purchase_requests SET status = 'pending_branch_manager' WHERE id = $1`,
      [requestId],
    );

    await client.query(
      `INSERT INTO purchase_approvals (request_id, decision, approver_user_id, approver_role, comment)
       VALUES ($1,'returned_for_change',$2,$3,$4)`,
      [requestId, principal.userId, principal.roleCode,
       changes.map((c) => c.reason).join(' | ')],
    );

    await audit({
      action: AUDIT.PR_CHANGE_REQUESTED, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      branchId: pr.branch_id, entityType: 'purchase_request', entityId: requestId,
      newValue: { changes, previousStatus: pr.status },
    }, client);

    await notify({
      branchId: pr.branch_id, kind: 'purchase_change_requested', severity: 'warning',
      title: 'المندوب يطلب تعديل كمية',
      body: `${pr.request_number} — ${changes.length} صنف بانتظار قرارك`,
      entityType: 'purchase_request', entityId: requestId,
      targetPermissions: ['purchase_requests.approve'],
    }, client);
  });
}

export interface RecordPurchaseInput {
  requestId: string;
  supplierId?: string | null;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  notes?: string | null;
  clientRef?: string | null;   // offline de-duplication key from the buyer app
  items: Array<{
    itemId: string; quantity: number; unit: string;
    unitPrice: number;          // halalas per entered unit
    supplierId?: string | null;
  }>;
}

/**
 * Record what the rep actually bought.
 *
 * The quantity is capped at what the manager approved. Exceeding it is refused
 * with a pointer to Request Change — the rep can never quietly buy 60 L against
 * a 40 L approval.
 */
export async function recordPurchase(
  principal: Principal, input: RecordPurchaseInput,
): Promise<{ purchaseId: string; purchaseNumber: string; total: number }> {
  if (!principal.permissions.has('purchasing.buyer')) {
    throw forbidden('هذه العملية مخصصة لمندوب المشتريات');
  }
  if (input.items.length === 0) throw badRequest('أضف صنفاً واحداً على الأقل');

  return withTransaction(async (client) => {
    // Offline sync arrives more than once; the same client_ref is the same
    // purchase, not a second one.
    if (input.clientRef) {
      const existing = await one<{ id: string; purchase_number: string; total: number }>(
        `SELECT p.id, p.purchase_number, p.total FROM purchases p
          WHERE p.client_ref = $1
            AND p.branch_id = (SELECT branch_id FROM purchase_requests WHERE id = $2)`,
        [input.clientRef, input.requestId], client,
      );
      if (existing) {
        return {
          purchaseId: existing.id, purchaseNumber: existing.purchase_number,
          total: existing.total,
        };
      }
    }

    const pr = await one<any>(
      'SELECT * FROM purchase_requests WHERE id = $1 FOR UPDATE', [input.requestId], client,
    );
    if (!pr || !(BUYER_VISIBLE_PR_STATUSES as readonly string[]).includes(pr.status)) {
      throw notFound('طلب الشراء غير موجود');
    }
    assertBranchAccess(principal, pr.branch_id);

    const numRow = await one<{ n: string }>(
      `SELECT next_document_number($1,'PO', EXTRACT(YEAR FROM now())::int) AS n`,
      [pr.branch_id], client,
    );

    const purchase = await one<{ id: string }>(
      `INSERT INTO purchases (
         purchase_number, branch_id, request_id, supplier_id, buyer_user_id,
         buyer_employee_id, invoice_number, invoice_date, notes, client_ref
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        numRow!.n, pr.branch_id, input.requestId, input.supplierId ?? null,
        principal.userId, principal.employeeId, input.invoiceNumber ?? null,
        input.invoiceDate ?? null, input.notes ?? null, input.clientRef ?? null,
      ],
      client,
    );

    let subtotal = 0;
    const branch = await one<{ vat_percent: number }>(
      'SELECT vat_percent FROM branches WHERE id = $1', [pr.branch_id], client,
    );
    const vatRate = Number(branch?.vat_percent ?? 0);

    for (const line of input.items) {
      if (line.quantity <= 0) throw badRequest('الكمية غير صالحة');

      const requestItem = await one<{
        id: string; approved_quantity: number | null; item_name: string;
        purchased_quantity: number | null; entered_unit: string;
      }>(
        `SELECT pri.id, pri.approved_quantity, pri.purchased_quantity, pri.entered_unit,
                ii.name_ar AS item_name
           FROM purchase_request_items pri
           JOIN inventory_items ii ON ii.id = pri.item_id
          WHERE pri.request_id = $1 AND pri.item_id = $2 FOR UPDATE`,
        [input.requestId, line.itemId], client,
      );
      if (!requestItem) throw badRequest('صنف غير مدرج في هذا الطلب المعتمد');

      const baseQty = await toBaseForItem(line.itemId, line.quantity, line.unit, client);
      const approved = Number(requestItem.approved_quantity ?? 0);
      const alreadyBought = Number(requestItem.purchased_quantity ?? 0);

      // The hard cap.
      if (approved <= 0) {
        throw unprocessable(`الصنف "${requestItem.item_name}" غير معتمد للشراء`);
      }
      if (alreadyBought + baseQty > approved + 0.0001) {
        throw unprocessable(
          `الكمية المشتراة من "${requestItem.item_name}" تتجاوز المعتمد `
          + `(${approved}). استخدم "طلب تعديل" للحصول على موافقة المدير.`,
        );
      }

      const unitPriceBase = baseQty > 0 ? (line.unitPrice * line.quantity) / baseQty : 0;
      const lineSubtotal = Math.round(line.unitPrice * line.quantity);
      const lineVat = Math.round(lineSubtotal * vatRate / 100);
      subtotal += lineSubtotal;

      await client.query(
        `INSERT INTO purchase_items (
           purchase_id, request_item_id, item_id, quantity, entered_quantity,
           entered_unit, unit_price, line_subtotal, vat_amount, line_total, supplier_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          purchase!.id, requestItem.id, line.itemId, baseQty, line.quantity,
          line.unit, unitPriceBase, lineSubtotal, lineVat, lineSubtotal + lineVat,
          line.supplierId ?? input.supplierId ?? null,
        ],
      );

      await client.query(
        `UPDATE purchase_request_items
            SET purchased_quantity = COALESCE(purchased_quantity, 0) + $2,
                actual_unit_cost = $3
          WHERE id = $1`,
        [requestItem.id, baseQty, unitPriceBase],
      );

      // Price history — informational for the buyer and the manager. The system
      // never picks a supplier on its own.
      const supplierId = line.supplierId ?? input.supplierId;
      if (supplierId && unitPriceBase > 0) {
        await client.query(
          `INSERT INTO supplier_prices (
             supplier_id, item_id, unit_price, entered_price, entered_unit,
             purchase_id, source, recorded_by_user_id
           ) VALUES ($1,$2,$3,$4,$5,$6,'purchase',$7)`,
          [
            supplierId, line.itemId, unitPriceBase, line.unitPrice, line.unit,
            purchase!.id, principal.userId,
          ],
        );
      }
    }

    const vat = Math.round(subtotal * vatRate / 100);
    await client.query(
      'UPDATE purchases SET subtotal = $2, vat_amount = $3, total = $4 WHERE id = $1',
      [purchase!.id, subtotal, vat, subtotal + vat],
    );
    await client.query(
      `UPDATE purchase_requests
          SET actual_total = actual_total + $2,
              status = CASE WHEN status IN ('approved','sent_to_buyer') THEN 'purchasing' ELSE status END
        WHERE id = $1`,
      [input.requestId, subtotal + vat],
    );

    await audit({
      action: AUDIT.PURCHASE_RECORDED, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      branchId: pr.branch_id, entityType: 'purchase', entityId: purchase!.id,
      newValue: {
        purchaseNumber: numRow!.n, requestId: input.requestId,
        supplierId: input.supplierId, invoiceNumber: input.invoiceNumber,
        lines: input.items.length, total: subtotal + vat,
      },
    }, client);

    return {
      purchaseId: purchase!.id, purchaseNumber: numRow!.n, total: subtotal + vat,
    };
  });
}

/**
 * The department confirms what physically arrived.
 *
 * Stock only moves here — never on the buyer's say-so — and the four quantities
 * (approved / purchased / delivered / received) are compared so any discrepancy
 * is visible rather than absorbed.
 */
export async function receiveDelivery(
  principal: Principal,
  input: {
    requestId: string;
    locationId: string;
    items: Array<{ itemId: string; receivedQuantity: number; unit: string; notes?: string }>;
    notes?: string | null;
  },
): Promise<{ receiptId: string; discrepancies: unknown[] }> {
  return withTransaction(async (client) => {
    const pr = await one<any>(
      'SELECT * FROM purchase_requests WHERE id = $1 FOR UPDATE', [input.requestId], client,
    );
    if (!pr) throw notFound('طلب الشراء غير موجود');
    assertBranchAccess(principal, pr.branch_id);
    if (!['delivered', 'purchased', 'in_transit', 'received'].includes(pr.status)) {
      throw unprocessable('لا يمكن الاستلام قبل تسليم البضاعة');
    }

    const { receiveGoods } = await import('../inventory/inventory.service.js');
    const purchase = await one<{ id: string; supplier_id: string | null; invoice_number: string | null }>(
      `SELECT id, supplier_id, invoice_number FROM purchases
        WHERE request_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [input.requestId], client,
    );

    const discrepancies: unknown[] = [];
    const receiptLines: Array<{ itemId: string; quantity: number; unit: string; unitCost?: number }> = [];

    for (const line of input.items) {
      const baseQty = await toBaseForItem(line.itemId, line.receivedQuantity, line.unit, client);
      const requestItem = await one<{
        id: string; approved_quantity: number | null; purchased_quantity: number | null;
        actual_unit_cost: number | null; item_name: string;
      }>(
        `SELECT pri.id, pri.approved_quantity, pri.purchased_quantity, pri.actual_unit_cost,
                ii.name_ar AS item_name
           FROM purchase_request_items pri JOIN inventory_items ii ON ii.id = pri.item_id
          WHERE pri.request_id = $1 AND pri.item_id = $2 FOR UPDATE`,
        [input.requestId, line.itemId], client,
      );
      if (!requestItem) throw badRequest('صنف غير مدرج في هذا الطلب');

      await client.query(
        `UPDATE purchase_request_items
            SET received_quantity = COALESCE(received_quantity, 0) + $2,
                delivered_quantity = COALESCE(delivered_quantity, purchased_quantity),
                notes = COALESCE($3, notes)
          WHERE id = $1`,
        [requestItem.id, baseQty, line.notes ?? null],
      );

      const purchased = Number(requestItem.purchased_quantity ?? 0);
      if (Math.abs(purchased - baseQty) > 0.0001) {
        discrepancies.push({
          itemId: line.itemId, itemName: requestItem.item_name,
          approved: Number(requestItem.approved_quantity ?? 0),
          purchased, received: baseQty, difference: baseQty - purchased,
        });
      }

      receiptLines.push({
        itemId: line.itemId, quantity: line.receivedQuantity, unit: line.unit,
        unitCost: requestItem.actual_unit_cost != null
          ? Number(requestItem.actual_unit_cost) * (baseQty / Math.max(line.receivedQuantity, 1e-9))
          : undefined,
      });
    }

    await client.query(
      `UPDATE purchase_requests SET status = 'received', received_at = now() WHERE id = $1`,
      [input.requestId],
    );

    await audit({
      action: AUDIT.PURCHASE_RECEIVED, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      actorKind: 'employee', branchId: pr.branch_id,
      entityType: 'purchase_request', entityId: input.requestId,
      newValue: {
        receivedBy: principal.displayName, lines: input.items.length,
        discrepancies,
      },
    }, client);

    if (discrepancies.length > 0) {
      await notify({
        branchId: pr.branch_id, kind: 'purchase_discrepancy', severity: 'warning',
        title: 'فروقات في الاستلام',
        body: `${pr.request_number}: ${discrepancies.length} صنف بكمية مختلفة عن المشترى.`,
        entityType: 'purchase_request', entityId: input.requestId,
        targetPermissions: ['purchase_requests.approve', 'reports.purchasing'],
        metadata: { discrepancies },
      }, client);
    }

    // Stock in — this is the only point at which purchased goods become stock.
    const receipt = await receiveGoods(principal, {
      branchId: pr.branch_id, locationId: input.locationId,
      supplierId: purchase?.supplier_id ?? null,
      purchaseId: purchase?.id ?? null,
      invoiceNumber: purchase?.invoice_number ?? null,
      notes: input.notes ?? `استلام طلب شراء ${pr.request_number}`,
      items: receiptLines,
      // Joins THIS transaction rather than opening its own on a second pooled
      // connection, which would deadlock against the locks taken above.
    }, client);

    await client.query(
      `UPDATE purchase_requests SET status = 'closed', closed_at = now() WHERE id = $1`,
      [input.requestId],
    );

    return { receiptId: receipt.receiptId, discrepancies };
  });
}

/** Full detail for managers — shows requested AND approved, unlike the buyer view. */
export async function getPurchaseRequest(principal: Principal, requestId: string) {
  const isBuyer = principal.permissions.has('purchasing.buyer')
    && !principal.permissions.has('purchase_requests.approve');

  const pr = await one<any>(
    isBuyer
      ? `SELECT r.*, b.name_ar AS branch_name FROM buyer_purchase_requests r
           JOIN branches b ON b.id = r.branch_id WHERE r.id = $1`
      : `SELECT r.*, b.name_ar AS branch_name,
                e.full_name AS requested_by_name, u.full_name AS approved_by_name
           FROM purchase_requests r
           JOIN branches b ON b.id = r.branch_id
           LEFT JOIN employees e ON e.id = r.requested_by_employee_id
           LEFT JOIN users u ON u.id = r.approved_by_user_id
          WHERE r.id = $1`,
    [requestId],
  );
  if (!pr) throw notFound('طلب الشراء غير موجود');
  assertBranchAccess(principal, pr.branch_id);

  pr.items = await many(
    isBuyer
      ? `SELECT i.*, ii.name_ar, ii.sku, ii.base_unit, ii.stock_unit
           FROM buyer_purchase_request_items i JOIN inventory_items ii ON ii.id = i.item_id
          WHERE i.request_id = $1 ORDER BY ii.name_ar`
      : `SELECT i.*, ii.name_ar, ii.sku, ii.base_unit, ii.stock_unit, s.name AS supplier_name
           FROM purchase_request_items i
           JOIN inventory_items ii ON ii.id = i.item_id
           LEFT JOIN suppliers s ON s.id = i.supplier_id
          WHERE i.request_id = $1 ORDER BY ii.name_ar`,
    [requestId],
  );

  if (!isBuyer) {
    pr.approvals = await many(
      `SELECT a.*, u.full_name AS approver_name FROM purchase_approvals a
         LEFT JOIN users u ON u.id = a.approver_user_id
        WHERE a.request_id = $1 ORDER BY a.decided_at`,
      [requestId],
    );
    pr.purchases = await many(
      `SELECT p.*, s.name AS supplier_name FROM purchases p
         LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.request_id = $1 ORDER BY p.purchased_at`,
      [requestId],
    );
  }
  return pr;
}

export async function listPurchaseRequests(
  principal: Principal,
  filters: { branchId: string; status?: string | null; department?: string | null },
) {
  // Department staff see only their own department's requests.
  const restrictToDepartment =
    principal.permissions.has('purchase_requests.read.own_department')
    && !principal.permissions.has('purchase_requests.read.branch')
    && !principal.permissions.has('purchase_requests.read.all');

  return many(
    `SELECT r.id, r.request_number, r.department, r.status, r.priority,
            r.created_at, r.submitted_at, r.approved_at, r.estimated_total,
            r.actual_total, r.needed_by,
            e.full_name AS requested_by_name, u.full_name AS approved_by_name,
            (SELECT count(*)::int FROM purchase_request_items i WHERE i.request_id = r.id) AS item_count
       FROM purchase_requests r
       LEFT JOIN employees e ON e.id = r.requested_by_employee_id
       LEFT JOIN users u ON u.id = r.approved_by_user_id
      WHERE r.branch_id = $1
        AND ($2::text IS NULL OR r.status = $2)
        AND ($3::text IS NULL OR r.department = $3)
        AND (NOT $4::boolean OR r.requested_by_employee_id = $5)
      ORDER BY r.created_at DESC
      LIMIT 200`,
    [
      filters.branchId, filters.status ?? null, filters.department ?? null,
      restrictToDepartment, principal.employeeId,
    ],
  );
}
