/**
 * The platforms MARA speaks to.
 *
 * Each aggregator publishes its own webhook shape, and the differences are
 * mundane: where the order id lives, whether options are nested or flat,
 * whether money arrives in riyals or halalas. None of that is interesting
 * enough to leak past this directory.
 *
 * The signature schemes ARE worth care. Most use HMAC-SHA256 over the raw
 * body; the header name differs. Verification compares in constant time and
 * against the RAW bytes, not a re-serialised object — re-serialising changes
 * key order and whitespace, and the signature then never matches.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  DeliveryAdapter, DeliveryEventKind, NormalisedLine, NormalisedOrder,
  OutboundStatus, PushContext,
} from './types.js';

/** Riyals as sent by a platform → halalas. Rounded, never floated onward. */
function toHalalas(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

function hmacMatches(raw: string, secret: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const expected = createHmac('sha256', secret).update(raw, 'utf8').digest();
  // Platforms differ on hex vs base64; accept either, compare in constant time.
  const candidates = [
    Buffer.from(provided, 'hex'),
    Buffer.from(provided, 'base64'),
  ].filter((b) => b.length === expected.length);
  return candidates.some((b) => timingSafeEqual(b, expected));
}

/**
 * The common case, which most of these platforms are: HMAC-SHA256 over the raw
 * body in a named header, an order id at a known path, and flat line items.
 */
function standardAdapter(spec: {
  code: string;
  nameAr: string;
  signatureHeader: string;
  eventIdHeader?: string;
  /** Paths into the payload, in the platform's own vocabulary. */
  paths: {
    orderId: string[];
    reference?: string[];
    items: string[];
    itemId: string[];
    itemName: string[];
    itemQty: string[];
    itemPrice?: string[];
    itemModifiers?: string[];
    customerName?: string[];
    customerPhone?: string[];
    note?: string[];
    address?: string[];
    total?: string[];
    deliveryFee?: string[];
    event?: string[];
  };
  /** How this platform names the event we care about. */
  createdEvents: string[];
  cancelledEvents?: string[];
  pickedUpEvents?: string[];
  deliveredEvents?: string[];
  /** Money already in halalas rather than riyals. */
  minorUnits?: boolean;
  /** Where a status push goes, relative to the partner's base URL. */
  statusPath?: (ctx: PushContext, status: OutboundStatus) => string;
  statusBody?: (ctx: PushContext, status: OutboundStatus) => unknown;
}): DeliveryAdapter {
  const dig = (obj: unknown, path: string[] | undefined): unknown => {
    if (!path) return undefined;
    let cur: any = obj;
    for (const key of path) {
      if (cur == null) return undefined;
      cur = cur[key];
    }
    return cur;
  };

  const money = (v: unknown): number =>
    spec.minorUnits ? Math.round(Number(v) || 0) : toHalalas(v);

  return {
    code: spec.code,
    nameAr: spec.nameAr,

    verify(raw, headers, secret) {
      // No secret configured means the branch has not finished setup. Refusing
      // is the only safe answer: this endpoint is public and an accepted order
      // cooks food and dispatches a rider.
      if (!secret) return false;
      return hmacMatches(raw, secret, headers[spec.signatureHeader.toLowerCase()]);
    },

    eventId(payload, headers) {
      const fromHeader = spec.eventIdHeader
        ? headers[spec.eventIdHeader.toLowerCase()] : undefined;
      if (fromHeader) return fromHeader;
      // Falling back to the order id means a status change for the same order
      // would look like a duplicate, so it is combined with the event name.
      const orderId = str(dig(payload, spec.paths.orderId));
      const event = str(dig(payload, spec.paths.event)) ?? 'event';
      return orderId ? `${orderId}:${event}` : null;
    },

    parse(payload): DeliveryEventKind {
      const event = (str(dig(payload, spec.paths.event)) ?? 'order.created').toLowerCase();
      const externalOrderId = str(dig(payload, spec.paths.orderId));
      if (!externalOrderId) return { kind: 'ignored', reason: 'لا يوجد رقم طلب في الحمولة' };

      const matches = (list: string[] | undefined) =>
        (list ?? []).some((e) => event === e.toLowerCase());

      if (matches(spec.cancelledEvents)) {
        return {
          kind: 'order.cancelled', externalOrderId,
          reason: str(dig(payload, ['reason'])) ?? str(dig(payload, ['cancellation_reason'])),
        };
      }
      if (matches(spec.pickedUpEvents)) {
        return {
          kind: 'order.picked_up', externalOrderId,
          riderName: str(dig(payload, ['driver', 'name']))
            ?? str(dig(payload, ['courier', 'name'])),
          riderPhone: str(dig(payload, ['driver', 'phone']))
            ?? str(dig(payload, ['courier', 'phone'])),
        };
      }
      if (matches(spec.deliveredEvents)) {
        return { kind: 'order.delivered', externalOrderId };
      }
      if (spec.createdEvents.length > 0 && !matches(spec.createdEvents)) {
        return { kind: 'ignored', reason: `حدث غير متابَع: ${event}` };
      }

      const rawItems = dig(payload, spec.paths.items);
      if (!Array.isArray(rawItems) || rawItems.length === 0) {
        return { kind: 'ignored', reason: 'الطلب بلا أصناف' };
      }

      const lines: NormalisedLine[] = rawItems.map((item) => {
        const modifiers = dig(item, spec.paths.itemModifiers);
        return {
          externalId: String(dig(item, spec.paths.itemId) ?? ''),
          name: String(dig(item, spec.paths.itemName) ?? ''),
          quantity: Number(dig(item, spec.paths.itemQty) ?? 1),
          externalUnitPrice: spec.paths.itemPrice
            ? money(dig(item, spec.paths.itemPrice)) : undefined,
          notes: str((item as any)?.notes) ?? str((item as any)?.note),
          modifierExternalIds: Array.isArray(modifiers)
            ? modifiers.map((m: any) => String(m?.id ?? m?.item_id ?? m)).filter(Boolean)
            : undefined,
        };
      });

      const order: NormalisedOrder = {
        externalOrderId,
        externalReference: str(dig(payload, spec.paths.reference)) ?? externalOrderId,
        customerName: str(dig(payload, spec.paths.customerName)),
        customerPhone: str(dig(payload, spec.paths.customerPhone)),
        customerNote: str(dig(payload, spec.paths.note)),
        address: str(dig(payload, spec.paths.address)),
        lines,
        platformTotal: spec.paths.total ? money(dig(payload, spec.paths.total)) : null,
        deliveryFee: spec.paths.deliveryFee ? money(dig(payload, spec.paths.deliveryFee)) : 0,
        // Every one of these platforms charges the customer itself. A partner
        // configured otherwise overrides this when the order is stored.
        isPrepaid: true,
        scheduledFor: (() => {
          const raw = str(dig(payload, ['scheduled_for'])) ?? str(dig(payload, ['delivery_time']));
          if (!raw) return null;
          const date = new Date(raw);
          return Number.isNaN(date.getTime()) ? null : date;
        })(),
      };

      return { kind: 'order.created', order };
    },

    async push(status, ctx) {
      if (!ctx.apiBaseUrl) {
        throw new Error(`لم يُضبط عنوان API لمنصة ${spec.code}`);
      }
      const path = spec.statusPath
        ? spec.statusPath(ctx, status)
        : `/orders/${encodeURIComponent(ctx.externalOrderId)}/status`;
      const body = spec.statusBody
        ? spec.statusBody(ctx, status)
        : { status, preparation_time_minutes: ctx.prepMinutes, reason: ctx.reason ?? undefined };

      const res = await fetch(`${ctx.apiBaseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ctx.credentials.token ? { Authorization: `Bearer ${ctx.credentials.token}` } : {}),
          ...(ctx.credentials.apiKey ? { 'X-API-Key': ctx.credentials.apiKey } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${spec.code} ${res.status}: ${text.slice(0, 200)}`);
      }
    },
  };
}

const ADAPTERS: DeliveryAdapter[] = [
  standardAdapter({
    code: 'jahez', nameAr: 'جاهز',
    signatureHeader: 'x-jahez-signature', eventIdHeader: 'x-jahez-event-id',
    createdEvents: ['order.created', 'new_order', 'created'],
    cancelledEvents: ['order.cancelled', 'cancelled'],
    pickedUpEvents: ['order.picked_up', 'picked_up'],
    deliveredEvents: ['order.delivered', 'delivered'],
    paths: {
      orderId: ['jahez_id'], reference: ['order_number'], event: ['event'],
      items: ['products'], itemId: ['product_id'], itemName: ['name'],
      itemQty: ['quantity'], itemPrice: ['price'], itemModifiers: ['modifiers'],
      customerName: ['customer', 'name'], customerPhone: ['customer', 'phone'],
      note: ['notes'], address: ['customer', 'address'],
      total: ['final_price'], deliveryFee: ['delivery_fee'],
    },
  }),
  standardAdapter({
    code: 'hungerstation', nameAr: 'هنقرستيشن',
    signatureHeader: 'x-hs-signature', eventIdHeader: 'x-hs-event-id',
    createdEvents: ['order_placed', 'order.created'],
    cancelledEvents: ['order_cancelled'],
    pickedUpEvents: ['order_picked_up'],
    deliveredEvents: ['order_delivered'],
    paths: {
      orderId: ['order', 'id'], reference: ['order', 'reference'], event: ['event_type'],
      items: ['order', 'items'], itemId: ['sku'], itemName: ['title'],
      itemQty: ['quantity'], itemPrice: ['unit_price'], itemModifiers: ['options'],
      customerName: ['order', 'customer', 'name'],
      customerPhone: ['order', 'customer', 'mobile'],
      note: ['order', 'special_instructions'], address: ['order', 'address', 'text'],
      total: ['order', 'total'], deliveryFee: ['order', 'delivery_fee'],
    },
  }),
  standardAdapter({
    code: 'keeta', nameAr: 'كيتا',
    signatureHeader: 'x-keeta-sign', eventIdHeader: 'x-keeta-request-id',
    createdEvents: ['ORDER_CREATE', 'order.create'],
    cancelledEvents: ['ORDER_CANCEL'],
    pickedUpEvents: ['ORDER_PICKUP'],
    deliveredEvents: ['ORDER_COMPLETE'],
    minorUnits: true,
    paths: {
      orderId: ['orderId'], reference: ['orderViewId'], event: ['eventType'],
      items: ['items'], itemId: ['skuId'], itemName: ['skuName'],
      itemQty: ['quantity'], itemPrice: ['price'], itemModifiers: ['attributes'],
      customerName: ['recipient', 'name'], customerPhone: ['recipient', 'phone'],
      note: ['caution'], address: ['recipient', 'address'],
      total: ['totalAmount'], deliveryFee: ['shippingFee'],
    },
  }),
  standardAdapter({
    code: 'ninja', nameAr: 'نينجا',
    signatureHeader: 'x-ninja-signature',
    createdEvents: ['order.created'],
    cancelledEvents: ['order.cancelled'],
    pickedUpEvents: ['order.picked_up'],
    deliveredEvents: ['order.delivered'],
    paths: {
      orderId: ['id'], reference: ['code'], event: ['event'],
      items: ['items'], itemId: ['external_id'], itemName: ['name'],
      itemQty: ['qty'], itemPrice: ['price'], itemModifiers: ['options'],
      customerName: ['customer', 'name'], customerPhone: ['customer', 'phone'],
      note: ['note'], address: ['address'],
      total: ['total'], deliveryFee: ['delivery_fee'],
    },
  }),
  standardAdapter({
    code: 'toyou', nameAr: 'تويو',
    signatureHeader: 'x-toyou-signature',
    createdEvents: ['order.created', 'new'],
    cancelledEvents: ['order.cancelled'],
    pickedUpEvents: ['order.picked'],
    deliveredEvents: ['order.delivered'],
    paths: {
      orderId: ['order_id'], reference: ['order_ref'], event: ['type'],
      items: ['items'], itemId: ['id'], itemName: ['name'],
      itemQty: ['quantity'], itemPrice: ['price'], itemModifiers: ['extras'],
      customerName: ['customer_name'], customerPhone: ['customer_phone'],
      note: ['comment'], address: ['address'],
      total: ['total'], deliveryFee: ['delivery'],
    },
  }),
  standardAdapter({
    code: 'careem', nameAr: 'كريم',
    signatureHeader: 'x-careem-signature', eventIdHeader: 'x-careem-event-id',
    createdEvents: ['order.created', 'CREATED'],
    cancelledEvents: ['order.cancelled', 'CANCELLED'],
    pickedUpEvents: ['order.captain_picked_up'],
    deliveredEvents: ['order.delivered'],
    paths: {
      orderId: ['order', 'id'], reference: ['order', 'display_code'], event: ['event'],
      items: ['order', 'items'], itemId: ['item_id'], itemName: ['item_name'],
      itemQty: ['quantity'], itemPrice: ['unit_price'], itemModifiers: ['modifiers'],
      customerName: ['order', 'customer', 'name'],
      customerPhone: ['order', 'customer', 'phone_number'],
      note: ['order', 'instructions'], address: ['order', 'dropoff', 'address'],
      total: ['order', 'total_amount'], deliveryFee: ['order', 'delivery_fee'],
    },
  }),
  standardAdapter({
    code: 'chefz', nameAr: 'ذا شيفز',
    signatureHeader: 'x-chefz-signature',
    createdEvents: ['order.created'],
    cancelledEvents: ['order.cancelled'],
    pickedUpEvents: ['order.picked_up'],
    deliveredEvents: ['order.delivered'],
    paths: {
      orderId: ['order_id'], reference: ['reference'], event: ['event'],
      items: ['items'], itemId: ['product_id'], itemName: ['product_name'],
      itemQty: ['quantity'], itemPrice: ['price'], itemModifiers: ['addons'],
      customerName: ['customer', 'name'], customerPhone: ['customer', 'mobile'],
      note: ['notes'], address: ['delivery_address'],
      total: ['grand_total'], deliveryFee: ['delivery_cost'],
    },
  }),
  standardAdapter({
    code: 'marsool', nameAr: 'مرسول',
    signatureHeader: 'x-marsool-signature',
    createdEvents: ['order.created', 'new_order'],
    cancelledEvents: ['order.cancelled'],
    pickedUpEvents: ['order.picked_up'],
    deliveredEvents: ['order.delivered'],
    paths: {
      orderId: ['id'], reference: ['number'], event: ['event'],
      items: ['items'], itemId: ['sku'], itemName: ['name'],
      itemQty: ['quantity'], itemPrice: ['price'], itemModifiers: ['options'],
      customerName: ['customer', 'name'], customerPhone: ['customer', 'phone'],
      note: ['note'], address: ['address'],
      total: ['total'], deliveryFee: ['delivery_fee'],
    },
  }),
  standardAdapter({
    code: 'talabat', nameAr: 'طلبات',
    signatureHeader: 'x-talabat-signature', eventIdHeader: 'x-talabat-event-id',
    createdEvents: ['order.created', 'OrderCreated'],
    cancelledEvents: ['order.cancelled', 'OrderCancelled'],
    pickedUpEvents: ['order.picked_up'],
    deliveredEvents: ['order.delivered'],
    paths: {
      orderId: ['token'], reference: ['shortCode'], event: ['eventType'],
      items: ['products'], itemId: ['remoteCode'], itemName: ['name'],
      itemQty: ['quantity'], itemPrice: ['unitPrice'], itemModifiers: ['selectedToppings'],
      customerName: ['customer', 'firstName'], customerPhone: ['customer', 'mobile'],
      note: ['comments', 'customerComment'], address: ['delivery', 'address', 'formattedAddress'],
      total: ['price', 'grandTotal'], deliveryFee: ['price', 'deliveryFees'],
    },
  }),
];

const BY_CODE = new Map(ADAPTERS.map((a) => [a.code, a]));

export function getAdapter(code: string): DeliveryAdapter | null {
  return BY_CODE.get(code) ?? null;
}

export function knownPartners(): Array<{ code: string; nameAr: string }> {
  return ADAPTERS.map((a) => ({ code: a.code, nameAr: a.nameAr }));
}

export { hmacMatches };
