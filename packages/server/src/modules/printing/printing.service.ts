import type { PoolClient } from 'pg';
import { many, one, pool, withTransaction } from '../../core/db.js';
import { AUDIT, audit } from '../../core/audit.js';
import { badRequest, notFound, unprocessable } from '../../core/errors.js';
import { notify } from '../../core/notify.js';
import { config } from '../../core/config.js';
import { EVENTS, publish } from '../../core/realtime.js';
import { assertBranchAccess, type Principal } from '../../core/principal.js';

/**
 * Printing.
 *
 * There are no kitchen, bar or shisha screens in this system by design: those
 * departments work from paper. That makes the print queue a first-class,
 * durable object rather than a convenience — if a ticket does not come out,
 * the order does not happen, so nothing may be lost silently.
 *
 * Path:  cloud queue  →  local print agent (inside the branch LAN)  →  IP printer
 * The iPad never talks to a printer directly.
 */

export interface TicketItem {
  name: string;
  quantity: number;
  modifiers: string[];
  notes?: string | null;
}

export interface TicketPayload {
  header: string;               // 'MARA LOUNGE'
  kind: 'new_order' | 'add_item' | 'void' | 'reprint' | 'charcoal_request' | 'bill'
      | 'receipt' | 'credit_note';
  /** Banner printed large at the top: 'ADD ITEM', 'VOID', 'REPRINT'. */
  banner?: string | null;
  orderNumber?: string | null;
  tableNumber?: string | null;  // printed very large
  waiterName?: string | null;
  department?: string | null;
  orderType?: string | null;
  customerName?: string | null;
  time: string;
  items: TicketItem[];
  notes?: string | null;
  reason?: string | null;
  totals?: { subtotal: number; discount: number; vat: number; grandTotal: number } | null;
  footer?: string | null;
}

/** Find the printer for a department, honouring an explicit fallback chain. */
export async function resolvePrinter(
  branchId: string, department: string, client?: PoolClient,
): Promise<{ id: string; name: string; status: string } | null> {
  const direct = await one<{ id: string; name: string; status: string; fallback_printer_id: string | null }>(
    `SELECT id, name, status, fallback_printer_id FROM printers
      WHERE branch_id = $1 AND department = $2 AND is_enabled AND deleted_at IS NULL
      ORDER BY created_at LIMIT 1`,
    [branchId, department], client,
  );
  if (direct) return direct;

  // Nothing configured for this department — fall back to OTHER, then CASHIER,
  // so a ticket still reaches a human rather than vanishing.
  const fallback = await one<{ id: string; name: string; status: string }>(
    `SELECT id, name, status FROM printers
      WHERE branch_id = $1 AND department IN ('OTHER','CASHIER')
        AND is_enabled AND deleted_at IS NULL
      ORDER BY CASE department WHEN 'OTHER' THEN 0 ELSE 1 END, created_at
      LIMIT 1`,
    [branchId], client,
  );
  return fallback;
}

export interface QueueJobInput {
  branchId: string;
  printerId: string;
  kind: TicketPayload['kind'];
  payload: TicketPayload;
  orderId?: string | null;
  serviceRequestId?: string | null;
  copies?: number;
  isReprint?: boolean;
  reprintOfJobId?: string | null;
  reprintReason?: string | null;
  byUserId?: string | null;
  byEmployeeId?: string | null;
}

export async function queueJob(
  input: QueueJobInput, client?: PoolClient,
): Promise<{ id: string }> {
  const runner = client ?? pool;
  const { rows } = await runner.query<{ id: string }>(
    `INSERT INTO print_jobs (
       branch_id, printer_id, order_id, service_request_id, kind, payload, copies,
       is_reprint, reprint_of_job_id, reprint_reason, max_attempts,
       requested_by_user_id, requested_by_employee_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      input.branchId, input.printerId, input.orderId ?? null,
      input.serviceRequestId ?? null, input.kind, JSON.stringify(input.payload),
      input.copies ?? 1, input.isReprint ?? false, input.reprintOfJobId ?? null,
      input.reprintReason ?? null, config.printing.maxAttempts,
      input.byUserId ?? null, input.byEmployeeId ?? null,
    ],
  );
  return { id: rows[0].id };
}

/**
 * Split an order's unprinted items by production department and queue one
 * ticket per department. This is the routing rule from the specification:
 * BAR items to the bar printer, KITCHEN to the kitchen, SHISHA to the shisha
 * printer, and a mixed order is split automatically.
 *
 * `mode` decides the banner: a first print is a plain ticket, later additions
 * print an ADD ITEM ticket carrying only the new lines.
 */
export async function printOrderItems(
  args: {
    orderId: string;
    branchId: string;
    mode: 'new_order' | 'add_item';
    byUserId?: string | null;
    byEmployeeId?: string | null;
  },
  client: PoolClient,
): Promise<{ jobs: Array<{ department: string; jobId: string; printer: string }> }> {
  const order = await one<{
    order_number: string; table_number: string | null; order_type: string;
    waiter_name: string | null; customer_name: string | null; notes: string | null;
    delivery_partner: string | null; delivery_reference: string | null;
    delivery_customer: string | null;
  }>(
    `SELECT o.order_number, o.order_type, o.notes,
            t.table_number, e.full_name AS waiter_name, c.full_name AS customer_name,
            dp.name_ar AS delivery_partner, d.external_reference AS delivery_reference,
            d.customer_name AS delivery_customer
       FROM orders o
       LEFT JOIN restaurant_tables t ON t.id = o.table_id
       LEFT JOIN employees e ON e.id = o.waiter_employee_id
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN delivery_orders d ON d.order_id = o.id
       LEFT JOIN delivery_partners dp ON dp.id = d.partner_id
      WHERE o.id = $1`,
    [args.orderId], client,
  );
  if (!order) throw notFound('الطلب غير موجود');

  // Only items that have never been printed. Re-running this is therefore
  // safe: it will find nothing to do rather than double-firing the kitchen.
  const items = await many<{
    id: string; product_name_ar: string; quantity: number;
    production_department: string; notes: string | null; modifiers: string[] | null;
  }>(
    `SELECT oi.id, oi.product_name_ar, oi.quantity, oi.production_department, oi.notes,
            ARRAY(
              SELECT m.option_name_ar FROM order_item_modifiers m
               WHERE m.order_item_id = oi.id ORDER BY m.created_at
            ) AS modifiers
       FROM order_items oi
      WHERE oi.order_id = $1 AND oi.printed_at IS NULL AND oi.status <> 'voided'
      ORDER BY oi.line_number`,
    [args.orderId], client,
  );
  if (items.length === 0) return { jobs: [] };

  const batchRow = await one<{ next_batch: number }>(
    `SELECT COALESCE(MAX(print_batch), 0) + 1 AS next_batch
       FROM order_items WHERE order_id = $1`,
    [args.orderId], client,
  );
  const batch = batchRow?.next_batch ?? 1;

  const byDepartment = new Map<string, typeof items>();
  for (const item of items) {
    const list = byDepartment.get(item.production_department) ?? [];
    list.push(item);
    byDepartment.set(item.production_department, list);
  }

  const jobs: Array<{ department: string; jobId: string; printer: string }> = [];

  for (const [department, deptItems] of byDepartment) {
    const printer = await resolvePrinter(args.branchId, department, client);
    if (!printer) {
      // No printer at all for this department: raise it loudly instead of
      // dropping the ticket on the floor.
      await notify({
        branchId: args.branchId, kind: 'printer_missing', severity: 'critical',
        title: 'لا توجد طابعة معرّفة',
        body: `الطلب ${order.order_number}: لا توجد طابعة لقسم ${department}.`,
        entityType: 'order', entityId: args.orderId,
        targetPermissions: ['printers.manage', 'print_jobs.read'],
      }, client);
      continue;
    }

    const payload: TicketPayload = {
      header: 'MARA LOUNGE',
      kind: args.mode,
      // The kitchen has to see at a glance that this one leaves the building.
      banner: args.mode === 'add_item' ? 'ADD ITEM'
        : order.delivery_partner ? 'DELIVERY' : null,
      orderNumber: order.order_number,
      // A delivery ticket has no table. What the pass needs in its place is the
      // platform's own reference, because that is the number the rider quotes
      // — printing our order number there would have them reading past each
      // other at the counter.
      tableNumber: order.delivery_reference ?? order.table_number,
      waiterName: order.waiter_name,
      department,
      orderType: order.delivery_partner
        ? `delivery / ${order.delivery_partner}` : order.order_type,
      customerName: order.delivery_customer ?? order.customer_name,
      time: new Date().toISOString(),
      items: deptItems.map((i) => ({
        name: i.product_name_ar,
        quantity: Number(i.quantity),
        // ADD ITEM tickets show a leading '+' on the quantity, per the spec.
        modifiers: i.modifiers ?? [],
        notes: i.notes,
      })),
      notes: order.notes,
    };

    const job = await queueJob({
      branchId: args.branchId, printerId: printer.id, kind: args.mode,
      payload, orderId: args.orderId,
      byUserId: args.byUserId, byEmployeeId: args.byEmployeeId,
    }, client);

    await client.query(
      `UPDATE order_items
          SET printed_at = now(), print_batch = $3,
              status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END
        WHERE id = ANY($1::uuid[]) AND order_id = $2`,
      [deptItems.map((i) => i.id), args.orderId, batch],
    );

    jobs.push({ department, jobId: job.id, printer: printer.name });
  }

  await audit({
    action: AUDIT.PRINT_QUEUED, actorUserId: args.byUserId ?? null,
    actorEmployeeId: args.byEmployeeId ?? null,
    actorKind: args.byEmployeeId ? 'employee' : 'user',
    branchId: args.branchId, entityType: 'order', entityId: args.orderId,
    metadata: { mode: args.mode, jobs: jobs.length, departments: [...byDepartment.keys()] },
  }, client);

  return { jobs };
}

/** VOID ticket for an item cancelled after it was already sent. */
export async function printVoid(
  args: {
    branchId: string; orderId: string; orderItemId: string; reason: string;
    byUserId?: string | null; byEmployeeId?: string | null;
  },
  client: PoolClient,
): Promise<{ jobId: string | null }> {
  const item = await one<{
    product_name_ar: string; quantity: number; production_department: string;
    order_number: string; table_number: string | null; waiter_name: string | null;
  }>(
    `SELECT oi.product_name_ar, oi.quantity, oi.production_department,
            o.order_number, t.table_number, e.full_name AS waiter_name
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN restaurant_tables t ON t.id = o.table_id
       LEFT JOIN employees e ON e.id = o.waiter_employee_id
      WHERE oi.id = $1`,
    [args.orderItemId], client,
  );
  if (!item) throw notFound('الصنف غير موجود');

  const printer = await resolvePrinter(args.branchId, item.production_department, client);
  if (!printer) return { jobId: null };

  const job = await queueJob({
    branchId: args.branchId, printerId: printer.id, kind: 'void',
    orderId: args.orderId,
    payload: {
      header: 'MARA LOUNGE', kind: 'void', banner: 'VOID',
      orderNumber: item.order_number, tableNumber: item.table_number,
      waiterName: item.waiter_name, department: item.production_department,
      time: new Date().toISOString(),
      items: [{
        name: item.product_name_ar, quantity: Number(item.quantity), modifiers: [],
      }],
      reason: args.reason,
    },
    byUserId: args.byUserId, byEmployeeId: args.byEmployeeId,
  }, client);

  return { jobId: job.id };
}

/**
 * Reprint an earlier ticket. Every reprint is stamped REPRINT in large type and
 * recorded with who asked, when, which order, which printer and why — reprints
 * are a classic shrinkage vector, so they are never anonymous.
 */
export async function reprintJob(
  principal: Principal, jobId: string, reason: string,
): Promise<{ jobId: string }> {
  if (!reason?.trim()) throw badRequest('سبب إعادة الطباعة مطلوب');

  return withTransaction(async (client) => {
    const original = await one<any>(
      'SELECT * FROM print_jobs WHERE id = $1', [jobId], client,
    );
    if (!original) throw notFound('أمر الطباعة غير موجود');
    assertBranchAccess(principal, original.branch_id);

    const payload: TicketPayload = {
      ...(original.payload as TicketPayload),
      kind: 'reprint',
      banner: 'REPRINT',
    };

    const job = await queueJob({
      branchId: original.branch_id, printerId: original.printer_id, kind: 'reprint',
      payload, orderId: original.order_id, isReprint: true,
      reprintOfJobId: jobId, reprintReason: reason,
      byUserId: principal.userId, byEmployeeId: principal.employeeId,
    }, client);

    await audit({
      action: AUDIT.REPRINT, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      actorKind: principal.employeeId ? 'employee' : 'user',
      branchId: original.branch_id, entityType: 'print_job', entityId: job.id,
      metadata: {
        originalJobId: jobId, orderId: original.order_id,
        printerId: original.printer_id, reason,
      },
    }, client);

    // Repeated reprints on one order are worth a human look.
    const count = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM print_jobs
        WHERE order_id = $1 AND is_reprint AND created_at > now() - interval '1 hour'`,
      [original.order_id], client,
    );
    if ((count?.n ?? 0) >= 3) {
      await notify({
        branchId: original.branch_id, kind: 'unusual_reprints', severity: 'warning',
        title: 'إعادة طباعة متكررة',
        body: `تمت إعادة الطباعة ${count!.n} مرات لنفس الطلب خلال ساعة بواسطة ${principal.displayName}.`,
        entityType: 'order', entityId: original.order_id,
        targetPermissions: ['audit.read', 'orders.read.all'],
      }, client);
    }

    return { jobId: job.id };
  });
}

// --- Print agent protocol ----------------------------------------------------

/**
 * An agent claims a batch of jobs with a short lease. If the agent dies, the
 * lease expires and the job returns to the queue rather than being stranded in
 * 'claimed' forever.
 *
 * FOR UPDATE SKIP LOCKED lets two agents in the same branch work the queue
 * concurrently without ever handing both the same ticket.
 */
export async function claimJobs(
  agentId: string, branchId: string, limit = 10,
): Promise<unknown[]> {
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE print_jobs
          SET status = 'queued', claimed_by_agent_id = NULL, claimed_at = NULL,
              lease_expires_at = NULL
        WHERE status = 'claimed' AND lease_expires_at < now()`,
    );

    const jobs = await many<any>(
      `SELECT pj.id FROM print_jobs pj
        WHERE pj.branch_id = $1 AND pj.status = 'queued'
          AND pj.next_attempt_at <= now()
          AND pj.attempt_count < pj.max_attempts
        ORDER BY pj.created_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [branchId, limit], client,
    );
    if (jobs.length === 0) return [];

    const ids = jobs.map((j) => j.id);
    await client.query(
      `UPDATE print_jobs
          SET status = 'claimed', claimed_by_agent_id = $2, claimed_at = now(),
              lease_expires_at = now() + ($3 || ' seconds')::interval,
              attempt_count = attempt_count + 1
        WHERE id = ANY($1::uuid[])`,
      [ids, agentId, String(config.printing.leaseSeconds)],
    );
    await client.query(
      'UPDATE print_agents SET last_seen_at = now() WHERE id = $1', [agentId],
    );

    return many(
      // order_id travels with the job so the agent can name the order in a
      // failure report — "ticket for ORD-2026-000041 did not print" is
      // actionable at the pass; a job UUID is not.
      `SELECT pj.id, pj.kind, pj.payload, pj.copies, pj.attempt_count, pj.order_id,
              p.ip_address, p.port, p.protocol, p.codepage, p.chars_per_line,
              p.name AS printer_name, p.id AS printer_id
         FROM print_jobs pj JOIN printers p ON p.id = pj.printer_id
        WHERE pj.id = ANY($1::uuid[])
        ORDER BY pj.created_at`,
      [ids], client,
    );
  });
}

export async function reportJobResult(
  agentId: string,
  jobId: string,
  success: boolean,
  errorMessage?: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const job = await one<any>(
      'SELECT * FROM print_jobs WHERE id = $1 FOR UPDATE', [jobId], client,
    );
    if (!job) throw notFound('أمر الطباعة غير موجود');

    if (success) {
      await client.query(
        `UPDATE print_jobs SET status = 'printed', printed_at = now(), last_error = NULL
          WHERE id = $1`,
        [jobId],
      );
      await client.query(
        `UPDATE printers SET status = 'online', last_seen_at = now(), status_message = NULL
          WHERE id = $1`,
        [job.printer_id],
      );
      return;
    }

    const exhausted = job.attempt_count >= job.max_attempts;
    await client.query(
      `UPDATE print_jobs
          SET status = $2, last_error = $3,
              next_attempt_at = now() + ($4 || ' seconds')::interval,
              claimed_by_agent_id = NULL, lease_expires_at = NULL
        WHERE id = $1`,
      [
        jobId, exhausted ? 'failed' : 'queued', errorMessage ?? 'unknown error',
        // Exponential backoff, so a printer that is merely out of paper is not
        // hammered every second.
        String(config.printing.retryBackoffSeconds * 2 ** Math.min(job.attempt_count, 4)),
      ],
    );
    await client.query(
      `UPDATE printers SET status = 'error', status_message = $2 WHERE id = $1`,
      [job.printer_id, errorMessage ?? null],
    );

    await audit({
      action: AUDIT.PRINT_FAILED, actorKind: 'print_agent', branchId: job.branch_id,
      entityType: 'print_job', entityId: jobId,
      metadata: {
        attempt: job.attempt_count, exhausted, error: errorMessage,
        printerId: job.printer_id, orderId: job.order_id,
      },
    }, client);

    // Only shout once the retries are spent — a transient blip is not news.
    if (exhausted) {
      const printer = await one<{ name: string }>(
        'SELECT name FROM printers WHERE id = $1', [job.printer_id], client,
      );
      await notify({
        branchId: job.branch_id, kind: 'print_failed', severity: 'critical',
        title: 'فشل الطباعة',
        body: `تعذّرت الطباعة على ${printer?.name ?? 'طابعة'} بعد ${job.attempt_count} محاولات: ${errorMessage ?? ''}`,
        entityType: 'print_job', entityId: jobId,
        targetPermissions: ['print_jobs.read', 'printers.manage', 'pos.use'],
      }, client);

      publish({
        type: EVENTS.PRINT_FAILED, branchId: job.branch_id,
        requiredPermissions: ['print_jobs.read', 'pos.use'],
        payload: { jobId, orderId: job.order_id, printerId: job.printer_id, error: errorMessage },
      });
    }
  });
}

export async function retryJob(principal: Principal, jobId: string): Promise<void> {
  const job = await one<{ branch_id: string }>(
    'SELECT branch_id FROM print_jobs WHERE id = $1', [jobId],
  );
  if (!job) throw notFound('أمر الطباعة غير موجود');
  assertBranchAccess(principal, job.branch_id);

  const res = await pool.query(
    `UPDATE print_jobs
        SET status = 'queued', attempt_count = 0, next_attempt_at = now(), last_error = NULL
      WHERE id = $1 AND status IN ('failed','queued')`,
    [jobId],
  );
  if (res.rowCount === 0) throw unprocessable('لا يمكن إعادة محاولة هذا الأمر');
  await audit({
    action: 'print.retry', actorUserId: principal.userId,
    actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
    branchId: principal.branchId, entityType: 'print_job', entityId: jobId,
  });
}

export async function agentHeartbeat(
  agentId: string,
  payload: { version?: string; ip?: string; printers?: Array<{ id: string; reachable: boolean; message?: string }> },
): Promise<void> {
  await pool.query(
    'UPDATE print_agents SET last_seen_at = now(), agent_version = $2, ip = $3 WHERE id = $1',
    [agentId, payload.version ?? null, payload.ip ?? null],
  );
  for (const p of payload.printers ?? []) {
    await pool.query(
      `UPDATE printers SET status = $2, status_message = $3, last_seen_at = now() WHERE id = $1`,
      [p.id, p.reachable ? 'online' : 'offline', p.message ?? null],
    );
    publish({
      type: EVENTS.PRINTER_STATUS, branchId: null,
      requiredPermissions: ['printers.read'],
      payload: { printerId: p.id, status: p.reachable ? 'online' : 'offline' },
    });
  }
}

export async function queueHealth(branchId: string) {
  const stats = await one<any>(
    `SELECT
       count(*) FILTER (WHERE status = 'queued')::int  AS queued,
       count(*) FILTER (WHERE status = 'claimed')::int AS claimed,
       count(*) FILTER (WHERE status = 'failed')::int  AS failed,
       count(*) FILTER (WHERE status = 'printed' AND printed_at > now() - interval '1 hour')::int AS printed_last_hour,
       MIN(created_at) FILTER (WHERE status IN ('queued','claimed')) AS oldest_pending
     FROM print_jobs WHERE branch_id = $1`,
    [branchId],
  );
  const printers = await many(
    `SELECT id, name, department, host(ip_address) AS ip, port, status, status_message,
            last_seen_at, is_enabled
       FROM printers WHERE branch_id = $1 AND deleted_at IS NULL ORDER BY department, name`,
    [branchId],
  );
  const agents = await many(
    `SELECT id, name, last_seen_at, agent_version, is_enabled,
            (last_seen_at IS NOT NULL AND last_seen_at > now() - ($2 || ' seconds')::interval) AS online
       FROM print_agents WHERE branch_id = $1`,
    [branchId, String(config.printing.agentOfflineSeconds)],
  );
  return { stats, printers, agents };
}
