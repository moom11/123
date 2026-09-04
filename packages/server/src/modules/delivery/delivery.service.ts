/**
 * Delivery orders, from webhook to kitchen ticket.
 *
 * The whole point is that an order from Jahez is an order. It goes through the
 * same pricing, the same printing, the same invoice as one rung up at the till
 * — so nobody retypes anything, and the day's sales reconcile.
 *
 * Three rules shape the code:
 *
 *   1. Never lose an order. The raw payload is stored BEFORE it is parsed, so
 *      an adapter that throws leaves something to replay. A customer who paid
 *      and got nothing is the worst outcome here, worse than a wrong ticket.
 *   2. Never duplicate one. Aggregators retry hard; a repeated webhook returns
 *      the original outcome instead of cooking the food twice.
 *   3. Our prices, not theirs. What the platform says it charged is recorded
 *      for comparison and never used to price a line — otherwise a stale menu
 *      on their side silently rewrites ours.
 */
import type { PoolClient } from 'pg';
import { many, one, pool, withTransaction } from '../../core/db.js';
import { decryptSecret, encryptSecret } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import { AUDIT, audit } from '../../core/audit.js';
import { EVENTS, publish } from '../../core/realtime.js';
import { notify } from '../../core/notify.js';
import type { Principal } from '../../core/principal.js';
import { assertBranchAccess } from '../../core/principal.js';
import { createOrder } from '../orders/orders.service.js';
import { printOrderItems } from '../printing/printing.service.js';
import { getAdapter } from './adapters/index.js';
import type { NormalisedOrder, OutboundStatus } from './adapters/types.js';

interface PartnerRow {
  id: string; branch_id: string; code: string; name_ar: string;
  is_enabled: boolean; prepaid: boolean; commission_bps: number;
  webhook_secret_enc: string | null; api_credentials_enc: string | null;
  api_base_url: string | null; auto_accept: boolean; prep_minutes: number;
}

export interface WebhookResult {
  status: 'processed' | 'duplicate' | 'needs_mapping' | 'rejected' | 'ignored';
  orderId?: string;
  orderNumber?: string;
  message?: string;
}

/**
 * Handle one inbound webhook.
 *
 * Deliberately returns a result rather than throwing for business problems:
 * an aggregator that receives a 500 retries forever, so an unmappable order
 * must be answered with "received, a human is looking at it" and raised
 * internally — not bounced back at the platform.
 */
export async function handleWebhook(
  partnerCode: string, branchCode: string | null,
  raw: string, headers: Record<string, string | undefined>,
): Promise<WebhookResult> {
  const adapter = getAdapter(partnerCode);
  if (!adapter) return { status: 'rejected', message: 'منصة غير معروفة' };

  const partner = await one<PartnerRow>(
    `SELECT p.* FROM delivery_partners p
       JOIN branches b ON b.id = p.branch_id
      WHERE p.code = $1 AND p.deleted_at IS NULL
        AND ($2::text IS NULL OR b.code = $2)
      ORDER BY p.created_at LIMIT 1`,
    [partnerCode, branchCode],
  );
  if (!partner) return { status: 'rejected', message: 'المنصة غير مفعّلة لهذا الفرع' };
  if (!partner.is_enabled) return { status: 'rejected', message: 'المنصة موقوفة' };

  const secret = partner.webhook_secret_enc
    ? decryptSecret(partner.webhook_secret_enc) : null;
  const signatureOk = adapter.verify(raw, headers, secret);

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { status: 'rejected', message: 'حمولة غير صالحة' };
  }

  // Stored before anything is interpreted. If the adapter throws on the next
  // line, this row is what lets the order be replayed rather than lost.
  const eventId = adapter.eventId(payload, headers);
  const event = await one<{ id: string; status: string; order_id: string | null }>(
    `INSERT INTO delivery_events
       (partner_id, branch_id, external_event_id, kind, payload, signature_ok)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (partner_id, external_event_id) WHERE external_event_id IS NOT NULL
     DO NOTHING
     RETURNING id, status, order_id`,
    [partner.id, partner.branch_id, eventId, 'inbound', raw, signatureOk],
  );

  // The insert did nothing, so this exact delivery has been seen. Answer with
  // what happened the first time rather than doing it again.
  if (!event) {
    const original = await one<{ status: string; order_id: string | null }>(
      `SELECT status, order_id FROM delivery_events
        WHERE partner_id = $1 AND external_event_id = $2`,
      [partner.id, eventId],
    );
    return {
      status: 'duplicate',
      orderId: original?.order_id ?? undefined,
      message: 'حدث مكرر — لم يُعالَج مرة أخرى',
    };
  }

  // Signature checked after storing, so a forged payload is still on record.
  if (!signatureOk) {
    await markEvent(event.id, 'rejected', null, 'توقيع غير صالح');
    await notify({
      branchId: partner.branch_id, kind: 'delivery_bad_signature', severity: 'warning',
      title: `توقيع غير صالح من ${partner.name_ar}`,
      body: 'وصل طلب بتوقيع لا يطابق المفتاح المحفوظ. تحقق من مفتاح المنصة.',
      targetPermissions: ['delivery.manage'],
    });
    return { status: 'rejected', message: 'توقيع غير صالح' };
  }

  let parsed;
  try {
    parsed = adapter.parse(payload);
  } catch (err) {
    await markEvent(event.id, 'rejected', null,
      err instanceof Error ? err.message : String(err));
    await raiseForHuman(partner, 'تعذّر قراءة طلب وارد', String(err));
    return { status: 'rejected', message: 'تعذّرت قراءة الحمولة' };
  }

  try {
    switch (parsed.kind) {
      case 'order.created':
        return await acceptIncoming(partner, event.id, parsed.order);
      case 'order.cancelled':
        await applyExternalCancellation(partner, parsed.externalOrderId, parsed.reason ?? null);
        await markEvent(event.id, 'processed', null, null);
        return { status: 'processed', message: 'أُلغي الطلب' };
      case 'order.picked_up':
        await recordPickup(partner, parsed.externalOrderId, parsed.riderName ?? null,
          parsed.riderPhone ?? null);
        await markEvent(event.id, 'processed', null, null);
        return { status: 'processed', message: 'استلمه المندوب' };
      case 'order.delivered':
        await setDeliveryStatus(partner, parsed.externalOrderId, 'delivered');
        await markEvent(event.id, 'processed', null, null);
        return { status: 'processed', message: 'سُلّم الطلب' };
      default:
        await markEvent(event.id, 'processed', null, parsed.reason);
        return { status: 'ignored', message: parsed.reason };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markEvent(event.id, 'rejected', null, message);
    await raiseForHuman(partner, 'فشل استقبال طلب توصيل', message);
    return { status: 'rejected', message };
  }
}

async function markEvent(
  id: string, status: string, orderId: string | null, error: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE delivery_events
        SET status = $2, order_id = $3, error = $4, processed_at = now()
      WHERE id = $1`,
    [id, status, orderId, error],
  );
}

async function raiseForHuman(
  partner: PartnerRow, title: string, body: string,
): Promise<void> {
  await notify({
    branchId: partner.branch_id, kind: 'delivery_failed', severity: 'critical',
    title: `${title} — ${partner.name_ar}`,
    body: `${body.slice(0, 300)}. الطلب محفوظ ويمكن إعادة معالجته من شاشة التوصيل.`,
    targetPermissions: ['delivery.read'],
  });
}

/**
 * Turn a normalised platform order into one of ours.
 *
 * An item we cannot map stops the whole order rather than dropping a line:
 * delivering three of four items is worse than telling the branch to fix the
 * mapping, because the customer has already paid for four.
 */
async function acceptIncoming(
  partner: PartnerRow, eventId: string, incoming: NormalisedOrder,
): Promise<WebhookResult> {
  const existing = await one<{ order_id: string }>(
    'SELECT order_id FROM delivery_orders WHERE partner_id = $1 AND external_order_id = $2',
    [partner.id, incoming.externalOrderId],
  );
  if (existing) {
    await markEvent(eventId, 'duplicate', existing.order_id, null);
    return { status: 'duplicate', orderId: existing.order_id };
  }

  const mapped = await mapLines(partner.id, incoming);
  if (mapped.unmapped.length > 0) {
    await markEvent(eventId, 'needs_mapping', null,
      `أصناف غير مربوطة: ${mapped.unmapped.map((u) => u.name).join('، ')}`);
    await notify({
      branchId: partner.branch_id, kind: 'delivery_needs_mapping', severity: 'critical',
      title: `طلب ${partner.name_ar} يحتاج ربط أصناف`,
      body: `${mapped.unmapped.map((u) => `${u.name} (${u.externalId})`).join('، ')} — `
          + 'اربطها من شاشة التوصيل ثم أعد المعالجة.',
      targetPermissions: ['delivery.manage'],
    });
    publish({
      type: EVENTS.NOTIFICATION, branchId: partner.branch_id,
      requiredPermissions: ['delivery.read'],
      payload: { kind: 'delivery_needs_mapping', partner: partner.code },
    });
    return {
      status: 'needs_mapping',
      message: `${mapped.unmapped.length} صنف غير مربوط`,
    };
  }

  const created = await createOrder(null, {
    branchId: partner.branch_id,
    lines: mapped.lines,
    source: 'delivery',
    orderType: 'delivery',
    notes: incoming.customerNote ?? null,
    // The platform's own id, so a retry that slips past the event dedupe still
    // cannot create a second order.
    idempotencyKey: `${partner.code}:${incoming.externalOrderId}`,
  });

  const isPrepaid = partner.prepaid && incoming.isPrepaid;
  const commission = Math.round(
    ((incoming.platformTotal ?? created.grandTotal) * partner.commission_bps) / 10_000,
  );

  // ON CONFLICT rather than a prior SELECT: two deliveries of the same webhook
  // can be in flight at once, and the check-then-insert between them is exactly
  // the race an aggregator's retry storm produces. The index decides.
  const stored = await one<{ order_id: string }>(
    `INSERT INTO delivery_orders (
       order_id, partner_id, branch_id, external_order_id, external_reference,
       customer_name, customer_phone, customer_note, address,
       platform_total, delivery_fee, commission, is_prepaid, status, scheduled_for
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',$14)
     ON CONFLICT (partner_id, external_order_id) DO NOTHING
     RETURNING order_id`,
    [
      created.orderId, partner.id, partner.branch_id, incoming.externalOrderId,
      incoming.externalReference ?? null, incoming.customerName ?? null,
      incoming.customerPhone ?? null, incoming.customerNote ?? null,
      incoming.address ?? null, incoming.platformTotal ?? null,
      incoming.deliveryFee ?? 0, commission, isPrepaid,
      incoming.scheduledFor ?? null,
    ],
  );

  // The other delivery won. createOrder's own idempotency key means no second
  // order was created either, so there is nothing to undo — just report it.
  if (!stored) {
    const winner = await one<{ order_id: string }>(
      'SELECT order_id FROM delivery_orders WHERE partner_id = $1 AND external_order_id = $2',
      [partner.id, incoming.externalOrderId],
    );
    await markEvent(eventId, 'duplicate', winner?.order_id ?? null, null);
    return { status: 'duplicate', orderId: winner?.order_id };
  }

  // The order exists but has NOT printed: it waits for a human, for the same
  // reason a customer's QR order does — the kitchen may be out of an item, and
  // a rider should not be sent for food nobody can cook.
  await pool.query(
    `UPDATE orders SET status = 'pending_delivery_acceptance' WHERE id = $1`,
    [created.orderId],
  );

  await markEvent(eventId, 'processed', created.orderId, null);

  await audit({
    action: AUDIT.DELIVERY_RECEIVED, actorKind: 'system', actorLabel: partner.name_ar,
    branchId: partner.branch_id, entityType: 'order', entityId: created.orderId,
    newValue: {
      partner: partner.code, externalOrderId: incoming.externalOrderId,
      orderNumber: created.orderNumber, total: created.grandTotal,
      platformTotal: incoming.platformTotal, lines: mapped.lines.length,
    },
  });

  publish({
    type: EVENTS.DELIVERY_ORDER_RECEIVED, branchId: partner.branch_id,
    requiredPermissions: ['delivery.read'],
    payload: {
      orderId: created.orderId, orderNumber: created.orderNumber,
      partner: partner.code, partnerName: partner.name_ar,
      reference: incoming.externalReference, total: created.grandTotal,
    },
  });

  // Auto-accept is off by default, and exists for a branch that has decided it
  // would rather never keep a rider waiting.
  if (partner.auto_accept) {
    await acceptDeliveryOrder(null, created.orderId);
  }

  return {
    status: 'processed', orderId: created.orderId, orderNumber: created.orderNumber,
  };
}

/** Resolve the platform's item ids to ours. All or nothing. */
async function mapLines(partnerId: string, incoming: NormalisedOrder): Promise<{
  lines: Array<{ productId: string; quantity: number; modifierOptionIds?: string[];
                 notes?: string | null }>;
  unmapped: Array<{ externalId: string; name: string }>;
}> {
  const ids = [
    ...incoming.lines.map((l) => l.externalId),
    ...incoming.lines.flatMap((l) => l.modifierExternalIds ?? []),
  ].filter(Boolean);

  const rows = ids.length === 0 ? [] : await many<{
    external_id: string; product_id: string | null; modifier_option_id: string | null;
  }>(
    `SELECT external_id, product_id, modifier_option_id FROM delivery_menu_map
      WHERE partner_id = $1 AND external_id = ANY($2::text[])`,
    [partnerId, ids],
  );
  const map = new Map(rows.map((r) => [r.external_id, r]));

  const lines: Array<{ productId: string; quantity: number;
                       modifierOptionIds?: string[]; notes?: string | null }> = [];
  const unmapped: Array<{ externalId: string; name: string }> = [];

  for (const line of incoming.lines) {
    const hit = map.get(line.externalId);
    if (!hit?.product_id) {
      unmapped.push({ externalId: line.externalId, name: line.name });
      continue;
    }
    const modifiers = (line.modifierExternalIds ?? [])
      .map((id) => {
        const m = map.get(id);
        if (!m?.modifier_option_id) {
          unmapped.push({ externalId: id, name: `${line.name} — إضافة` });
          return null;
        }
        return m.modifier_option_id;
      })
      .filter((v): v is string => Boolean(v));

    lines.push({
      productId: hit.product_id,
      quantity: line.quantity,
      modifierOptionIds: modifiers.length > 0 ? modifiers : undefined,
      notes: line.notes ?? null,
    });
  }

  return { lines, unmapped };
}

/**
 * A human (or auto-accept) confirms the branch will cook this. Only now does
 * it print, and only now is the platform told a time.
 */
export async function acceptDeliveryOrder(
  principal: Principal | null, orderId: string,
): Promise<{ status: string }> {
  const row = await withTransaction(async (client) => {
    const delivery = await one<{
      order_id: string; branch_id: string; partner_id: string; status: string;
      external_order_id: string; is_prepaid: boolean;
    }>(
      'SELECT * FROM delivery_orders WHERE order_id = $1 FOR UPDATE', [orderId], client,
    );
    if (!delivery) throw notFound('ليس طلب توصيل');
    if (principal) assertBranchAccess(principal, delivery.branch_id);
    if (delivery.status !== 'pending') {
      throw conflict(`الطلب ${STATUS_AR[delivery.status] ?? delivery.status} بالفعل`);
    }

    await client.query(
      `UPDATE delivery_orders SET status = 'accepted', accepted_at = now(),
              updated_at = now() WHERE order_id = $1`,
      [orderId],
    );
    await client.query(
      `UPDATE orders SET status = 'confirmed' WHERE id = $1`, [orderId],
    );
    await client.query(
      `INSERT INTO order_status_history
         (order_id, from_status, to_status, actor_user_id, actor_employee_id, actor_kind)
       VALUES ($1,'pending_delivery_acceptance','confirmed',$2,$3,$4)`,
      [orderId, principal?.userId ?? null, principal?.employeeId ?? null,
       principal ? 'employee' : 'system'],
    );

    // Now it reaches the kitchen — after a human said yes, not before.
    await printOrderItems({
      orderId, branchId: delivery.branch_id, mode: 'new_order',
      byUserId: principal?.userId, byEmployeeId: principal?.employeeId,
    }, client);
    await client.query(`UPDATE orders SET status = 'printed' WHERE id = $1`, [orderId]);

    await audit({
      action: AUDIT.DELIVERY_ACCEPTED, actorUserId: principal?.userId ?? null,
      actorEmployeeId: principal?.employeeId ?? null,
      actorLabel: principal?.displayName ?? 'auto-accept',
      actorKind: principal ? 'employee' : 'system',
      branchId: delivery.branch_id, entityType: 'order', entityId: orderId,
      newValue: { externalOrderId: delivery.external_order_id },
    }, client);

    return delivery;
  });

  await pushStatus(row.partner_id, row.external_order_id, 'accepted', null);
  return { status: 'accepted' };
}

export async function rejectDeliveryOrder(
  principal: Principal, orderId: string, reason: string,
): Promise<{ status: string }> {
  const row = await withTransaction(async (client) => {
    const delivery = await one<{
      branch_id: string; partner_id: string; status: string; external_order_id: string;
    }>('SELECT * FROM delivery_orders WHERE order_id = $1 FOR UPDATE', [orderId], client);
    if (!delivery) throw notFound('ليس طلب توصيل');
    assertBranchAccess(principal, delivery.branch_id);
    if (!['pending', 'accepted'].includes(delivery.status)) {
      throw conflict('لا يمكن رفض الطلب في حالته الحالية');
    }

    await client.query(
      `UPDATE delivery_orders SET status = 'rejected', rejected_reason = $2,
              updated_at = now() WHERE order_id = $1`,
      [orderId, reason],
    );
    // The order is cancelled, never deleted — it is a financial record even
    // when nothing was cooked.
    await client.query(
      `UPDATE orders SET status = 'cancelled', cancel_reason = $2, closed_at = now()
        WHERE id = $1`,
      [orderId, `رفض توصيل: ${reason}`],
    );

    await audit({
      action: AUDIT.DELIVERY_REJECTED, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      branchId: delivery.branch_id, entityType: 'order', entityId: orderId,
      newValue: { reason, externalOrderId: delivery.external_order_id },
    }, client);

    return delivery;
  });

  await pushStatus(row.partner_id, row.external_order_id, 'rejected', reason);
  return { status: 'rejected' };
}

const STATUS_AR: Record<string, string> = {
  pending: 'بانتظار القبول', accepted: 'مقبول', preparing: 'قيد التحضير',
  ready: 'جاهز', picked_up: 'مع المندوب', delivered: 'مُسلَّم',
  rejected: 'مرفوض', cancelled: 'ملغى',
};

/** Mark the food ready, which is what summons the rider. */
export async function markReady(
  principal: Principal, orderId: string,
): Promise<{ status: string }> {
  const row = await one<{
    branch_id: string; partner_id: string; status: string; external_order_id: string;
  }>('SELECT * FROM delivery_orders WHERE order_id = $1', [orderId]);
  if (!row) throw notFound('ليس طلب توصيل');
  assertBranchAccess(principal, row.branch_id);
  if (!['accepted', 'preparing'].includes(row.status)) {
    throw conflict(`الطلب ${STATUS_AR[row.status] ?? row.status}`);
  }

  await pool.query(
    `UPDATE delivery_orders SET status = 'ready', ready_at = now(), updated_at = now()
      WHERE order_id = $1`,
    [orderId],
  );
  await pushStatus(row.partner_id, row.external_order_id, 'ready', null);
  return { status: 'ready' };
}

async function recordPickup(
  partner: PartnerRow, externalOrderId: string,
  riderName: string | null, riderPhone: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE delivery_orders
        SET status = 'picked_up', picked_up_at = now(), rider_name = $3,
            rider_phone = $4, updated_at = now()
      WHERE partner_id = $1 AND external_order_id = $2`,
    [partner.id, externalOrderId, riderName, riderPhone],
  );
}

async function setDeliveryStatus(
  partner: PartnerRow, externalOrderId: string, status: string,
): Promise<void> {
  await pool.query(
    `UPDATE delivery_orders SET status = $3, updated_at = now()
      WHERE partner_id = $1 AND external_order_id = $2`,
    [partner.id, externalOrderId, status],
  );
}

/**
 * The platform cancelled. Food may already be cooking, so this does not undo
 * anything quietly — it cancels the order and tells the floor.
 */
async function applyExternalCancellation(
  partner: PartnerRow, externalOrderId: string, reason: string | null,
): Promise<void> {
  const row = await one<{ order_id: string; status: string }>(
    'SELECT order_id, status FROM delivery_orders WHERE partner_id = $1 AND external_order_id = $2',
    [partner.id, externalOrderId],
  );
  if (!row) return;

  await pool.query(
    `UPDATE delivery_orders SET status = 'cancelled', rejected_reason = $2,
            updated_at = now() WHERE order_id = $1`,
    [row.order_id, reason],
  );
  await pool.query(
    `UPDATE orders SET status = 'cancelled', cancel_reason = $2, closed_at = now()
      WHERE id = $1 AND status <> 'paid'`,
    [row.order_id, `ألغته ${partner.name_ar}: ${reason ?? 'بلا سبب'}`],
  );

  await notify({
    branchId: partner.branch_id, kind: 'delivery_cancelled', severity: 'warning',
    title: `${partner.name_ar} ألغت طلباً`,
    body: `${reason ?? 'بلا سبب معلن'} — أوقف التحضير إن كان قد بدأ.`,
    targetPermissions: ['delivery.read'],
  });
  publish({
    type: EVENTS.DELIVERY_ORDER_CANCELLED, branchId: partner.branch_id,
    requiredPermissions: ['delivery.read'],
    payload: { orderId: row.order_id, partner: partner.code, reason },
  });
}

/**
 * Tell the platform where the order is.
 *
 * A failure is recorded and left for the retry job rather than thrown at the
 * cashier: the food is cooking either way, and a stale status on the platform
 * is a problem to fix in the background, not a reason to fail the accept.
 */
export async function pushStatus(
  partnerId: string, externalOrderId: string, status: OutboundStatus,
  reason: string | null,
): Promise<void> {
  const partner = await one<PartnerRow>(
    'SELECT * FROM delivery_partners WHERE id = $1', [partnerId],
  );
  if (!partner) return;
  const adapter = getAdapter(partner.code);
  if (!adapter) return;

  try {
    await adapter.push(status, {
      apiBaseUrl: partner.api_base_url,
      credentials: partner.api_credentials_enc
        ? JSON.parse(decryptSecret(partner.api_credentials_enc)) : {},
      externalOrderId,
      prepMinutes: partner.prep_minutes,
      reason,
    });
    await pool.query(
      `UPDATE delivery_orders
          SET last_pushed_status = $3, last_push_error = NULL, push_attempts = 0,
              updated_at = now()
        WHERE partner_id = $1 AND external_order_id = $2`,
      [partnerId, externalOrderId, status],
    );
  } catch (err) {
    await pool.query(
      `UPDATE delivery_orders
          SET last_push_error = $3, push_attempts = push_attempts + 1, updated_at = now()
        WHERE partner_id = $1 AND external_order_id = $2`,
      [partnerId, externalOrderId, err instanceof Error ? err.message : String(err)],
    );
  }
}

/** Drain the failed-push queue. Called by the scheduled job. */
export async function retryFailedPushes(branchId: string, limit = 50): Promise<{
  attempted: number; recovered: number;
}> {
  const stuck = await many<{
    partner_id: string; external_order_id: string; status: string;
  }>(
    `SELECT partner_id, external_order_id, status FROM delivery_orders
      WHERE branch_id = $1 AND last_push_error IS NOT NULL AND push_attempts < 8
      ORDER BY updated_at LIMIT $2`,
    [branchId, limit],
  );

  let recovered = 0;
  for (const row of stuck) {
    const before = row.status;
    await pushStatus(row.partner_id, row.external_order_id,
      before as OutboundStatus, null);
    const after = await one<{ last_push_error: string | null }>(
      `SELECT last_push_error FROM delivery_orders
        WHERE partner_id = $1 AND external_order_id = $2`,
      [row.partner_id, row.external_order_id],
    );
    if (!after?.last_push_error) recovered += 1;
  }
  return { attempted: stuck.length, recovered };
}

// --- Configuration -----------------------------------------------------------

export async function listPartners(principal: Principal, branchId: string) {
  assertBranchAccess(principal, branchId);
  return many(
    `SELECT p.id, p.code, p.name_ar, p.is_enabled, p.prepaid, p.commission_bps,
            p.auto_accept, p.prep_minutes, p.api_base_url,
            p.webhook_secret_enc IS NOT NULL AS has_secret,
            p.api_credentials_enc IS NOT NULL AS has_credentials,
            (SELECT count(*) FROM delivery_menu_map m WHERE m.partner_id = p.id) AS mapped_items,
            (SELECT count(*) FROM delivery_orders d
              WHERE d.partner_id = p.id AND d.status IN ('pending','accepted','preparing','ready'))
              AS open_orders
       FROM delivery_partners p
      WHERE p.branch_id = $1 AND p.deleted_at IS NULL
      ORDER BY p.name_ar`,
    [branchId],
  );
}

export async function savePartner(
  principal: Principal, branchId: string,
  input: {
    code: string; nameAr?: string; isEnabled?: boolean; prepaid?: boolean;
    commissionBps?: number; autoAccept?: boolean; prepMinutes?: number;
    apiBaseUrl?: string | null; webhookSecret?: string | null;
    apiCredentials?: Record<string, string> | null;
  },
): Promise<{ id: string }> {
  assertBranchAccess(principal, branchId);
  const adapter = getAdapter(input.code);
  if (!adapter) throw badRequest(`لا يوجد محوّل لمنصة «${input.code}»`);

  const row = await one<{ id: string }>(
    `INSERT INTO delivery_partners
       (branch_id, code, name_ar, is_enabled, prepaid, commission_bps, auto_accept,
        prep_minutes, api_base_url, webhook_secret_enc, api_credentials_enc, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (branch_id, code) WHERE deleted_at IS NULL DO UPDATE SET
       name_ar = EXCLUDED.name_ar,
       is_enabled = EXCLUDED.is_enabled,
       prepaid = EXCLUDED.prepaid,
       commission_bps = EXCLUDED.commission_bps,
       auto_accept = EXCLUDED.auto_accept,
       prep_minutes = EXCLUDED.prep_minutes,
       api_base_url = EXCLUDED.api_base_url,
       -- A secret is only replaced when a new one was actually supplied, so
       -- saving the form without retyping it does not wipe it.
       webhook_secret_enc = COALESCE(EXCLUDED.webhook_secret_enc,
                                     delivery_partners.webhook_secret_enc),
       api_credentials_enc = COALESCE(EXCLUDED.api_credentials_enc,
                                      delivery_partners.api_credentials_enc),
       updated_at = now()
     RETURNING id`,
    [
      branchId, input.code, input.nameAr ?? adapter.nameAr, input.isEnabled ?? true,
      input.prepaid ?? true, input.commissionBps ?? 0, input.autoAccept ?? false,
      input.prepMinutes ?? 20, input.apiBaseUrl ?? null,
      input.webhookSecret ? encryptSecret(input.webhookSecret) : null,
      input.apiCredentials ? encryptSecret(JSON.stringify(input.apiCredentials)) : null,
      principal.userId,
    ],
  );

  await audit({
    action: AUDIT.DELIVERY_PARTNER_SAVED, actorUserId: principal.userId,
    actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
    branchId, entityType: 'delivery_partner', entityId: row!.id,
    newValue: {
      code: input.code, enabled: input.isEnabled ?? true,
      autoAccept: input.autoAccept ?? false, commissionBps: input.commissionBps ?? 0,
    },
  });
  return { id: row!.id };
}

export async function mapMenuItem(
  principal: Principal, partnerId: string,
  input: { externalId: string; externalName?: string | null;
           productId?: string | null; modifierOptionId?: string | null },
): Promise<void> {
  const partner = await one<{ branch_id: string }>(
    'SELECT branch_id FROM delivery_partners WHERE id = $1', [partnerId],
  );
  if (!partner) throw notFound('المنصة غير موجودة');
  assertBranchAccess(principal, partner.branch_id);
  if (!input.productId && !input.modifierOptionId) {
    throw badRequest('اختر صنفاً أو خياراً لربطه');
  }

  await pool.query(
    `INSERT INTO delivery_menu_map
       (partner_id, external_id, external_name, product_id, modifier_option_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (partner_id, external_id) DO UPDATE SET
       external_name = EXCLUDED.external_name,
       product_id = EXCLUDED.product_id,
       modifier_option_id = EXCLUDED.modifier_option_id`,
    [partnerId, input.externalId, input.externalName ?? null,
     input.productId ?? null, input.modifierOptionId ?? null, principal.userId],
  );
}

export async function listOpenDeliveries(principal: Principal, branchId: string) {
  assertBranchAccess(principal, branchId);
  // The lines come with the board, not behind a click. Accepting means saying
  // the kitchen can cook THIS, and that judgement cannot be made from a total.
  return many(
    `SELECT d.order_id, d.external_reference, d.customer_name, d.customer_phone,
            d.address, d.customer_note, d.status, d.is_prepaid, d.platform_total,
            d.commission, d.rider_name, d.scheduled_for, d.created_at,
            d.last_push_error,
            p.code AS partner_code, p.name_ar AS partner_name,
            o.order_number, o.grand_total, o.status AS order_status,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'name', pr.name_ar,
                       'quantity', oi.quantity::float,
                       'notes', oi.notes,
                       'available', pr.is_available
                     ) ORDER BY oi.created_at)
                FROM order_items oi JOIN products pr ON pr.id = oi.product_id
               WHERE oi.order_id = o.id AND oi.status <> 'voided'
            ), '[]'::json) AS items
       FROM delivery_orders d
       JOIN delivery_partners p ON p.id = d.partner_id
       JOIN orders o ON o.id = d.order_id
      WHERE d.branch_id = $1
        AND d.status IN ('pending','accepted','preparing','ready')
      ORDER BY d.created_at`,
    [branchId],
  );
}

/** Events that could not be turned into orders, and why. */
export async function listFailedEvents(principal: Principal, branchId: string) {
  assertBranchAccess(principal, branchId);
  return many(
    `SELECT e.id, e.kind, e.status, e.error, e.received_at, e.external_order_id,
            p.code AS partner_code, p.name_ar AS partner_name
       FROM delivery_events e JOIN delivery_partners p ON p.id = e.partner_id
      WHERE e.branch_id = $1 AND e.status IN ('needs_mapping','rejected')
      ORDER BY e.received_at DESC LIMIT 100`,
    [branchId],
  );
}

/**
 * Try a stored payload again, after the mapping was fixed.
 *
 * This is why the raw body is kept: a branch that maps the missing item can
 * recover the order rather than telephoning the customer.
 */
export async function replayEvent(
  principal: Principal, eventId: string,
): Promise<WebhookResult> {
  const event = await one<{
    id: string; partner_id: string; branch_id: string; payload: unknown; status: string;
  }>('SELECT * FROM delivery_events WHERE id = $1', [eventId]);
  if (!event) throw notFound('الحدث غير موجود');
  assertBranchAccess(principal, event.branch_id);
  if (event.status === 'processed') throw conflict('عولج هذا الحدث بالفعل');

  const partner = await one<PartnerRow>(
    'SELECT * FROM delivery_partners WHERE id = $1', [event.partner_id],
  );
  if (!partner) throw notFound('المنصة غير موجودة');
  const adapter = getAdapter(partner.code);
  if (!adapter) throw badRequest('لا يوجد محوّل لهذه المنصة');

  const parsed = adapter.parse(event.payload);
  if (parsed.kind !== 'order.created') {
    throw badRequest('هذا الحدث ليس طلباً جديداً');
  }

  await audit({
    action: AUDIT.DELIVERY_REPLAYED, actorUserId: principal.userId,
    actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
    branchId: event.branch_id, entityType: 'delivery_event', entityId: eventId,
  });

  return acceptIncoming(partner, event.id, parsed.order);
}
