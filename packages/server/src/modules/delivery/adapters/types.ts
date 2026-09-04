/**
 * What every delivery platform must be reduced to.
 *
 * The adapters exist so that exactly one thing varies per platform — the shape
 * of the JSON and how a status is pushed back — and nothing else in the system
 * knows which platform an order came from. Everything downstream sees an order
 * like any other: same pricing, same printing, same invoice.
 *
 * Adding a platform means writing one file that implements this, and nothing
 * else. If a change to support a platform needs an edit outside its adapter,
 * that is a sign the abstraction is wrong, not that the platform is special.
 */

/** Money in halalas throughout, as everywhere else. Never a float. */
export interface NormalisedLine {
  /** The platform's id for the item — looked up in delivery_menu_map. */
  externalId: string;
  /** What the platform calls it, for the mapping screen and the error message. */
  name: string;
  quantity: number;
  /** The platform's unit price, for comparison — NOT what we charge. */
  externalUnitPrice?: number;
  notes?: string | null;
  /** Options sent as their own ids, resolved to our modifier options. */
  modifierExternalIds?: string[];
}

export interface NormalisedOrder {
  /** The platform's order id. The idempotency key for the whole order. */
  externalOrderId: string;
  /** The short code the rider and customer quote. Printed on the ticket. */
  externalReference?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerNote?: string | null;
  address?: string | null;
  lines: NormalisedLine[];
  /** What the platform says it charged, in halalas. */
  platformTotal?: number | null;
  deliveryFee?: number;
  isPrepaid: boolean;
  /** A future order, when the platform supports scheduling. */
  scheduledFor?: Date | null;
}

export type DeliveryEventKind =
  | { kind: 'order.created'; order: NormalisedOrder }
  | { kind: 'order.cancelled'; externalOrderId: string; reason?: string | null }
  | { kind: 'order.picked_up'; externalOrderId: string; riderName?: string | null;
      riderPhone?: string | null }
  | { kind: 'order.delivered'; externalOrderId: string }
  /** Anything the adapter recognises but we do not act on. */
  | { kind: 'ignored'; reason: string };

/** Statuses we can tell a platform about. */
export type OutboundStatus =
  | 'accepted' | 'rejected' | 'preparing' | 'ready' | 'picked_up' | 'cancelled';

export interface PushContext {
  apiBaseUrl: string | null;
  credentials: Record<string, string>;
  externalOrderId: string;
  prepMinutes: number;
  reason?: string | null;
}

export interface DeliveryAdapter {
  readonly code: string;
  readonly nameAr: string;

  /**
   * Verify the payload really came from the platform.
   *
   * Returning false must mean "reject", never "process anyway": this endpoint
   * is public, and an unverified order creates food and dispatches a rider.
   * An adapter with no signature scheme says so explicitly rather than
   * silently returning true.
   */
  verify(raw: string, headers: Record<string, string | undefined>, secret: string | null):
    boolean;

  /** The platform's id for this delivery, for deduplicating retries. */
  eventId(payload: unknown, headers: Record<string, string | undefined>): string | null;

  /** Reduce the platform's payload to something the rest of the system knows. */
  parse(payload: unknown): DeliveryEventKind;

  /**
   * Tell the platform what happened. Throwing is correct on failure — the
   * caller records it and retries, rather than the adapter swallowing it and
   * leaving the platform with a stale status.
   */
  push(status: OutboundStatus, ctx: PushContext): Promise<void>;
}
