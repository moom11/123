import type { PoolClient } from 'pg';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { many, one, pool, withTransaction } from '../../core/db.js';
import { config } from '../../core/config.js';
import { generateToken } from '../../core/crypto.js';
import { AUDIT, audit } from '../../core/audit.js';
import { badRequest, forbidden, notFound, tooManyRequests, unprocessable } from '../../core/errors.js';
import { notify } from '../../core/notify.js';
import { EVENTS, publish } from '../../core/realtime.js';
import { assertBranchAccess, type Principal } from '../../core/principal.js';
import { queueJob, resolvePrinter } from '../printing/printing.service.js';

/**
 * Tables and QR codes.
 *
 * The QR encodes an opaque, high-entropy token plus a short signature, never
 * the table number. Editing "/menu/T12" into "/menu/T13" achieves nothing
 * because there is no table number in the URL to edit, and a guessed token is
 * rejected by the signature check.
 */

function signToken(token: string): string {
  return createHmac('sha256', config.security.cookieSecret)
    .update(`table:${token}`)
    .digest('base64url')
    .slice(0, 16);
}

/** The value printed into the QR image: <token>.<signature>. */
export function buildQrValue(token: string): string {
  return `${token}.${signToken(token)}`;
}

export function menuUrlForTable(token: string): string {
  return `${config.publicMenuBaseUrl}/menu/${buildQrValue(token)}`;
}

/**
 * Resolve a scanned QR value back to a table.
 *
 * The signature is checked before any database work, so an attacker cannot use
 * response timing to enumerate valid tokens.
 */
export async function resolveQrToken(qrValue: string) {
  const lastDot = qrValue.lastIndexOf('.');
  if (lastDot < 1) throw notFound('رمز الطاولة غير صالح');

  const token = qrValue.slice(0, lastDot);
  const signature = qrValue.slice(lastDot + 1);
  const expected = signToken(token);

  if (signature.length !== expected.length
      || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw notFound('رمز الطاولة غير صالح');
  }

  const table = await one<{
    id: string; table_number: string; branch_id: string; area: string | null;
    status: string; current_session_id: string | null; is_active: boolean;
    branch_name: string; assigned_waiter_employee_id: string | null;
  }>(
    `SELECT t.id, t.table_number, t.branch_id, t.area, t.status, t.current_session_id,
            t.is_active, t.assigned_waiter_employee_id, b.name_ar AS branch_name
       FROM restaurant_tables t JOIN branches b ON b.id = t.branch_id
      WHERE t.qr_token = $1 AND t.deleted_at IS NULL`,
    [token],
  );
  if (!table || !table.is_active) throw notFound('الطاولة غير متاحة');
  return table;
}

export async function createTable(
  principal: Principal,
  input: {
    branchId: string; tableNumber: string; area?: string | null;
    seats?: number | null; displayName?: string | null;
  },
) {
  const token = generateToken(24);
  const table = await one<{ id: string; qr_token: string }>(
    `INSERT INTO restaurant_tables
       (branch_id, table_number, display_name, area, seats, qr_token, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, qr_token`,
    [
      input.branchId, input.tableNumber, input.displayName ?? null,
      input.area ?? null, input.seats ?? null, token, principal.userId,
    ],
  ).catch((err: { code?: string }) => {
    if (err.code === '23505') throw badRequest('رقم الطاولة مستخدم بالفعل في هذا الفرع');
    throw err;
  });

  await audit({
    action: 'table.created', actorUserId: principal.userId, actorLabel: principal.displayName,
    branchId: input.branchId, entityType: 'table', entityId: table!.id,
    newValue: { tableNumber: input.tableNumber, area: input.area },
  });

  return {
    id: table!.id,
    qrValue: buildQrValue(table!.qr_token),
    menuUrl: menuUrlForTable(table!.qr_token),
  };
}

/** Rotate a table's QR token, invalidating every sticker already printed. */
export async function rotateQr(principal: Principal, tableId: string) {
  const token = generateToken(24);
  const row = await one<{ branch_id: string; table_number: string }>(
    `UPDATE restaurant_tables SET qr_token = $2, qr_rotated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING branch_id, table_number`,
    [tableId, token],
  );
  if (!row) throw notFound('الطاولة غير موجودة');

  await audit({
    action: 'table.qr_rotated', actorUserId: principal.userId,
    actorLabel: principal.displayName, branchId: row.branch_id,
    entityType: 'table', entityId: tableId,
    metadata: { tableNumber: row.table_number },
  });
  return { qrValue: buildQrValue(token), menuUrl: menuUrlForTable(token) };
}

/**
 * Recompute a table's status from the facts: open service requests first
 * (they need a human now), then unapproved orders, then simple occupancy.
 */
export async function refreshTableStatus(
  tableId: string, client?: PoolClient,
): Promise<string> {
  const runner = client ?? pool;

  const { rows } = await runner.query<{
    branch_id: string; current_session_id: string | null; old_status: string;
    has_bill_request: boolean; has_charcoal_request: boolean;
    has_waiter_request: boolean; has_pending_order: boolean; has_open_order: boolean;
  }>(
    `SELECT t.branch_id, t.current_session_id, t.status AS old_status,
       EXISTS (SELECT 1 FROM service_requests s
                WHERE s.table_id = t.id AND s.kind = 'bill' AND s.status = 'open') AS has_bill_request,
       EXISTS (SELECT 1 FROM service_requests s
                WHERE s.table_id = t.id AND s.kind = 'charcoal' AND s.status = 'open') AS has_charcoal_request,
       EXISTS (SELECT 1 FROM service_requests s
                WHERE s.table_id = t.id AND s.kind = 'waiter' AND s.status = 'open') AS has_waiter_request,
       EXISTS (SELECT 1 FROM orders o
                WHERE o.table_id = t.id AND o.status = 'pending_waiter_approval') AS has_pending_order,
       EXISTS (SELECT 1 FROM orders o
                WHERE o.table_id = t.id AND o.status NOT IN ('paid','cancelled')) AS has_open_order
     FROM restaurant_tables t WHERE t.id = $1`,
    [tableId],
  );
  const t = rows[0];
  if (!t) throw notFound('الطاولة غير موجودة');

  let status: string;
  if (t.has_pending_order) status = 'new_order';
  else if (t.has_bill_request) status = 'bill_requested';
  else if (t.has_charcoal_request) status = 'charcoal_requested';
  else if (t.has_waiter_request) status = 'waiter_requested';
  else if (t.current_session_id || t.has_open_order) status = 'occupied';
  else status = 'available';

  if (status !== t.old_status) {
    await runner.query('UPDATE restaurant_tables SET status = $2 WHERE id = $1', [tableId, status]);
    publish({
      type: EVENTS.TABLE_STATUS, branchId: t.branch_id,
      requiredPermissions: ['tables.read'],
      payload: { tableId, status, previous: t.old_status },
    });
  }
  return status;
}

/** The floor board: every table with its live state and running total. */
export async function listTables(branchId: string, principal: Principal) {
  return many(
    `SELECT t.id, t.table_number, t.display_name, t.area, t.seats, t.status,
            t.current_session_id, t.assigned_waiter_employee_id,
            e.full_name AS waiter_name,
            ts.opened_at, ts.guest_count,
            c.full_name AS customer_name,
            COALESCE((
              SELECT SUM(o.grand_total) FROM orders o
               WHERE o.session_id = t.current_session_id
                 AND o.status NOT IN ('cancelled')
            ), 0) AS session_total,
            (SELECT count(*)::int FROM orders o
              WHERE o.table_id = t.id AND o.status = 'pending_waiter_approval') AS pending_orders,
            (SELECT count(*)::int FROM service_requests s
              WHERE s.table_id = t.id AND s.status = 'open') AS open_requests,
            (t.assigned_waiter_employee_id = $2 OR $3::boolean) AS is_mine
       FROM restaurant_tables t
       LEFT JOIN employees e ON e.id = t.assigned_waiter_employee_id
       LEFT JOIN table_sessions ts ON ts.id = t.current_session_id
       LEFT JOIN customers c ON c.id = ts.customer_id
      WHERE t.branch_id = $1 AND t.deleted_at IS NULL AND t.is_active
      ORDER BY t.area NULLS FIRST, t.sort_order,
               NULLIF(regexp_replace(t.table_number, '\\D', '', 'g'), '')::int NULLS LAST,
               t.table_number`,
    [branchId, principal.employeeId, principal.permissions.has('orders.read.all')],
  );
}

export async function assignWaiter(
  principal: Principal, tableId: string, employeeId: string | null,
): Promise<void> {
  const table = await one<{ branch_id: string; table_number: string }>(
    'SELECT branch_id, table_number FROM restaurant_tables WHERE id = $1', [tableId],
  );
  if (!table) throw notFound('الطاولة غير موجودة');

  if (employeeId) {
    const emp = await one<{ branch_id: string }>(
      'SELECT branch_id FROM employees WHERE id = $1 AND is_active AND deleted_at IS NULL',
      [employeeId],
    );
    if (!emp) throw notFound('الموظف غير موجود');
    if (emp.branch_id !== table.branch_id) throw forbidden('الموظف يتبع فرعاً آخر');
  }

  await pool.query(
    'UPDATE restaurant_tables SET assigned_waiter_employee_id = $2 WHERE id = $1',
    [tableId, employeeId],
  );
  await pool.query(
    `UPDATE table_sessions SET waiter_employee_id = $2
      WHERE table_id = $1 AND status = 'open'`,
    [tableId, employeeId],
  );

  await audit({
    action: 'table.waiter_assigned', actorUserId: principal.userId,
    actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
    branchId: table.branch_id, entityType: 'table', entityId: tableId,
    newValue: { employeeId, tableNumber: table.table_number },
  });
}

/** Move a whole seating (and its open orders) to another table. */
export async function moveTable(
  principal: Principal, fromTableId: string, toTableId: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const from = await one<{ branch_id: string; current_session_id: string | null; table_number: string }>(
      'SELECT branch_id, current_session_id, table_number FROM restaurant_tables WHERE id = $1 FOR UPDATE',
      [fromTableId], client,
    );
    const to = await one<{ branch_id: string; current_session_id: string | null; table_number: string }>(
      'SELECT branch_id, current_session_id, table_number FROM restaurant_tables WHERE id = $1 FOR UPDATE',
      [toTableId], client,
    );
    if (!from || !to) throw notFound('الطاولة غير موجودة');
    if (from.branch_id !== to.branch_id) throw forbidden('لا يمكن النقل بين فرعين');
    if (!from.current_session_id) throw unprocessable('لا توجد جلسة مفتوحة على الطاولة المصدر');
    if (to.current_session_id) throw unprocessable('الطاولة الهدف مشغولة');

    await client.query(
      'UPDATE table_sessions SET table_id = $2 WHERE id = $1',
      [from.current_session_id, toTableId],
    );
    await client.query(
      `UPDATE orders SET table_id = $2 WHERE session_id = $1 AND status NOT IN ('paid','cancelled')`,
      [from.current_session_id, toTableId],
    );
    await client.query(
      'UPDATE restaurant_tables SET current_session_id = $2 WHERE id = $1',
      [toTableId, from.current_session_id],
    );
    await client.query(
      'UPDATE restaurant_tables SET current_session_id = NULL WHERE id = $1', [fromTableId],
    );

    await audit({
      action: AUDIT.ORDER_MOVED, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      branchId: from.branch_id, entityType: 'table_session',
      entityId: from.current_session_id,
      oldValue: { table: from.table_number }, newValue: { table: to.table_number },
    }, client);

    await refreshTableStatus(fromTableId, client);
    await refreshTableStatus(toTableId, client);
  });
}

/** Merge one seating into another so a single bill covers both. */
export async function mergeTables(
  principal: Principal, sourceTableId: string, targetTableId: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const source = await one<{ branch_id: string; current_session_id: string | null; table_number: string }>(
      'SELECT branch_id, current_session_id, table_number FROM restaurant_tables WHERE id = $1 FOR UPDATE',
      [sourceTableId], client,
    );
    const target = await one<{ branch_id: string; current_session_id: string | null; table_number: string }>(
      'SELECT branch_id, current_session_id, table_number FROM restaurant_tables WHERE id = $1 FOR UPDATE',
      [targetTableId], client,
    );
    if (!source?.current_session_id || !target?.current_session_id) {
      throw unprocessable('كلتا الطاولتين يجب أن تكون بها جلسة مفتوحة');
    }
    if (source.branch_id !== target.branch_id) throw forbidden('لا يمكن الدمج بين فرعين');
    if (sourceTableId === targetTableId) throw badRequest('لا يمكن دمج الطاولة مع نفسها');

    await client.query(
      `UPDATE orders SET session_id = $2, table_id = $3
        WHERE session_id = $1 AND status NOT IN ('paid','cancelled')`,
      [source.current_session_id, target.current_session_id, targetTableId],
    );
    await client.query(
      `UPDATE table_sessions
          SET status = 'merged', merged_into_session_id = $2, closed_at = now()
        WHERE id = $1`,
      [source.current_session_id, target.current_session_id],
    );
    await client.query(
      'UPDATE restaurant_tables SET current_session_id = NULL WHERE id = $1', [sourceTableId],
    );
    await client.query(
      `UPDATE table_sessions SET guest_count = guest_count + COALESCE(
         (SELECT guest_count FROM table_sessions WHERE id = $2), 0)
        WHERE id = $1`,
      [target.current_session_id, source.current_session_id],
    );

    await audit({
      action: AUDIT.TABLES_MERGED, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      branchId: source.branch_id, entityType: 'table_session',
      entityId: target.current_session_id,
      metadata: { from: source.table_number, into: target.table_number },
    }, client);

    await refreshTableStatus(sourceTableId, client);
    await refreshTableStatus(targetTableId, client);
  });
}

// --- Guest service requests ---------------------------------------------------

/**
 * "طلب ويتر" / "طلب فحم" / "طلب الحساب" from the guest's own phone.
 *
 * Debounced per table and kind: a guest tapping the charcoal button five times
 * produces one request and one ticket, not five.
 */
export async function createServiceRequest(
  input: {
    tableId: string; kind: 'waiter' | 'charcoal' | 'bill';
    customerId?: string | null; note?: string | null;
  },
): Promise<{ id: string; deduplicated: boolean; printJobId?: string | null }> {
  return withTransaction(async (client) => {
    const table = await one<{
      branch_id: string; table_number: string; current_session_id: string | null;
      assigned_waiter_employee_id: string | null;
    }>(
      `SELECT branch_id, table_number, current_session_id, assigned_waiter_employee_id
         FROM restaurant_tables WHERE id = $1 AND deleted_at IS NULL`,
      [input.tableId], client,
    );
    if (!table) throw notFound('الطاولة غير موجودة');

    const recent = await one<{ id: string }>(
      `SELECT id FROM service_requests
        WHERE table_id = $1 AND kind = $2 AND status = 'open'
          AND created_at > now() - interval '3 minutes'
        ORDER BY created_at DESC LIMIT 1`,
      [input.tableId, input.kind], client,
    );
    if (recent) return { id: recent.id, deduplicated: true };

    const request = await one<{ id: string }>(
      `INSERT INTO service_requests
         (branch_id, table_id, session_id, customer_id, kind, note,
          assigned_waiter_employee_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        table.branch_id, input.tableId, table.current_session_id,
        input.customerId ?? null, input.kind, input.note ?? null,
        table.assigned_waiter_employee_id,
      ],
      client,
    );

    let printJobId: string | null = null;

    // A charcoal request is a physical job for the shisha station, and that
    // station has no screen — so it must print.
    if (input.kind === 'charcoal') {
      const printer = await resolvePrinter(table.branch_id, 'SHISHA', client);
      if (printer) {
        const job = await queueJob({
          branchId: table.branch_id, printerId: printer.id, kind: 'charcoal_request',
          serviceRequestId: request!.id,
          payload: {
            header: 'MARA LOUNGE', kind: 'charcoal_request',
            banner: 'CHARCOAL REQUEST',
            tableNumber: table.table_number,
            time: new Date().toISOString(),
            items: [], notes: input.note ?? null,
          },
        }, client);
        printJobId = job.id;
        await client.query(
          'UPDATE service_requests SET print_job_id = $2 WHERE id = $1',
          [request!.id, job.id],
        );
      }
    }

    await refreshTableStatus(input.tableId, client);

    const labels = { waiter: 'طلب ويتر', charcoal: 'طلب فحم', bill: 'طلب الحساب' };
    publish({
      type: EVENTS.SERVICE_REQUEST, branchId: table.branch_id,
      requiredPermissions: ['service.requests.read'],
      targetEmployeeId: table.assigned_waiter_employee_id,
      payload: {
        id: request!.id, kind: input.kind, tableId: input.tableId,
        tableNumber: table.table_number, label: labels[input.kind],
        at: new Date().toISOString(),
      },
    });

    await notify({
      branchId: table.branch_id, kind: `service_${input.kind}`, severity: 'info',
      title: labels[input.kind],
      body: `طاولة ${table.table_number}`,
      entityType: 'service_request', entityId: request!.id,
      targetPermissions: ['service.requests.read'],
    }, client);

    return { id: request!.id, deduplicated: false, printJobId };
  });
}

export async function resolveServiceRequest(
  principal: Principal, requestId: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const req = await one<{ table_id: string; branch_id: string; kind: string; status: string }>(
      'SELECT table_id, branch_id, kind, status FROM service_requests WHERE id = $1 FOR UPDATE',
      [requestId], client,
    );
    if (!req) throw notFound('الطلب غير موجود');
    assertBranchAccess(principal, req.branch_id);
    if (req.status !== 'open') throw unprocessable('تمت معالجة هذا الطلب مسبقاً');

    await client.query(
      `UPDATE service_requests
          SET status = 'resolved', resolved_at = now(), resolved_by_employee_id = $2
        WHERE id = $1`,
      [requestId, principal.employeeId],
    );
    await refreshTableStatus(req.table_id, client);

    publish({
      type: EVENTS.SERVICE_RESOLVED, branchId: req.branch_id,
      requiredPermissions: ['service.requests.read'],
      payload: { id: requestId, tableId: req.table_id, by: principal.displayName },
    });
  });
}

export async function listOpenServiceRequests(branchId: string, principal: Principal) {
  const seesAll = principal.permissions.has('orders.read.all')
    || principal.permissions.has('service.requests.resolve');
  return many(
    `SELECT s.id, s.kind, s.status, s.note, s.created_at,
            t.id AS table_id, t.table_number, c.full_name AS customer_name,
            e.full_name AS waiter_name
       FROM service_requests s
       JOIN restaurant_tables t ON t.id = s.table_id
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN employees e ON e.id = s.assigned_waiter_employee_id
      WHERE s.branch_id = $1 AND s.status = 'open'
        AND ($2::boolean OR s.assigned_waiter_employee_id = $3)
      ORDER BY s.created_at`,
    [branchId, seesAll, principal.employeeId],
  );
}
