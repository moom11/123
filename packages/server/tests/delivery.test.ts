import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  auth, closeApp, getApp, getBranchId, loginAdmin,
} from './helpers.js';
import { many, one, pool } from '../src/core/db.js';
import { getAdapter, knownPartners } from '../src/modules/delivery/adapters/index.js';

const OWNER = { email: 'owner@maralounge.sa', password: 'MaraOwner#2026Xy' };
const SECRET = 'test-jahez-webhook-secret-value';

afterAll(async () => { await closeApp(); });

async function ownerHeaders(): Promise<Record<string, string>> {
  const session = await loginAdmin(OWNER.email, OWNER.password);
  return { ...auth(session), 'x-branch-id': await getBranchId() };
}

/** A product with no required option group, so a delivery line can stand alone. */
async function sellableProduct(): Promise<{ id: string; name_ar: string }> {
  const row = await one<{ id: string; name_ar: string }>(
    `SELECT p.id, p.name_ar FROM products p
      WHERE p.is_active AND p.is_available AND p.deleted_at IS NULL AND p.price > 0
        AND NOT EXISTS (
          SELECT 1 FROM product_modifiers pm JOIN modifiers m ON m.id = pm.modifier_id
           WHERE pm.product_id = p.id
             AND COALESCE(pm.is_required_override, m.is_required))
      ORDER BY p.price DESC LIMIT 1`,
  );
  if (!row) throw new Error('no unconstrained product');
  return row;
}

function jahezPayload(orderId: string, externalItemId: string, qty = 2) {
  return {
    event: 'order.created',
    jahez_id: orderId,
    order_number: `J-${orderId.slice(-4)}`,
    final_price: 120.5,
    delivery_fee: 10,
    customer: { name: 'أبو محمد', phone: '+966500000111', address: 'حي النرجس' },
    notes: 'بدون بصل',
    products: [{ product_id: externalItemId, name: 'صنف', quantity: qty, price: 55 }],
  };
}

/** Sign exactly the bytes that will be sent, as a platform does. */
function post(payload: unknown, secret = SECRET, eventId?: string) {
  const raw = JSON.stringify(payload);
  return {
    raw,
    headers: {
      'content-type': 'application/json',
      'x-jahez-signature': createHmac('sha256', secret).update(raw, 'utf8').digest('hex'),
      ...(eventId ? { 'x-jahez-event-id': eventId } : {}),
    },
  };
}

let partnerId: string;
let externalItemId: string;

beforeAll(async () => {
  const app = await getApp();
  const headers = await ownerHeaders();

  const saved = await app.inject({
    method: 'POST', url: '/api/delivery/partners', headers,
    payload: {
      code: 'jahez', commissionBps: 1500, prepMinutes: 25,
      webhookSecret: SECRET, apiBaseUrl: 'https://example.invalid/jahez',
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  partnerId = saved.json().id;

  const product = await sellableProduct();
  externalItemId = 'JZ-ITEM-1';
  const mapped = await app.inject({
    method: 'POST', url: `/api/delivery/partners/${partnerId}/menu-map`, headers,
    payload: {
      externalId: externalItemId, externalName: 'صنف جاهز', productId: product.id,
    },
  });
  expect(mapped.statusCode, mapped.body).toBe(200);
});

describe('inbound webhook', () => {
  test('an order becomes a real order, priced from OUR menu', async () => {
    const app = await getApp();
    const orderId = `JZ-${Date.now()}-a`;
    const { raw, headers } = post(jahezPayload(orderId, externalItemId, 2));

    const res = await app.inject({
      method: 'POST', url: '/api/delivery/webhook/jahez', headers, payload: raw,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('processed');

    const delivery = await one<{ order_id: string; commission: string; is_prepaid: boolean }>(
      'SELECT * FROM delivery_orders WHERE external_order_id = $1', [orderId],
    );
    expect(delivery).toBeTruthy();

    const order = await one<{ source: string; order_type: string; status: string; grand_total: string }>(
      'SELECT source, order_type, status, grand_total FROM orders WHERE id = $1',
      [delivery!.order_id],
    );
    expect(order!.source).toBe('delivery');
    expect(order!.order_type).toBe('delivery');

    // Priced from our own menu, not from what the platform said.
    const product = await sellableProduct();
    const expected = await one<{ price: string }>(
      'SELECT price FROM products WHERE id = $1', [product.id],
    );
    const items = await many<{ unit_price: string; quantity: string }>(
      'SELECT unit_price, quantity FROM order_items WHERE order_id = $1',
      [delivery!.order_id],
    );
    expect(items.length).toBe(1);
    expect(Number(items[0]!.unit_price)).toBe(Number(expected!.price));
    expect(Number(items[0]!.quantity)).toBe(2);
  });

  test('it does NOT print until a human accepts it', async () => {
    const app = await getApp();
    const orderId = `JZ-${Date.now()}-b`;
    const { raw, headers } = post(jahezPayload(orderId, externalItemId));
    await app.inject({
      method: 'POST', url: '/api/delivery/webhook/jahez', headers, payload: raw,
    });

    const delivery = await one<{ order_id: string; status: string }>(
      'SELECT order_id, status FROM delivery_orders WHERE external_order_id = $1',
      [orderId],
    );
    const order = await one<{ status: string }>(
      'SELECT status FROM orders WHERE id = $1', [delivery!.order_id],
    );
    expect(order!.status).toBe('pending_delivery_acceptance');
    expect(delivery!.status).toBe('pending');

    // The rule the whole flow exists to protect: no ticket before a human
    // agreed the kitchen can cook it.
    const jobs = await many('SELECT id FROM print_jobs WHERE order_id = $1',
      [delivery!.order_id]);
    expect(jobs).toEqual([]);
  });

  test('accepting prints the ticket', async () => {
    const app = await getApp();
    const headers = await ownerHeaders();
    const orderId = `JZ-${Date.now()}-c`;
    const { raw, headers: hookHeaders } = post(jahezPayload(orderId, externalItemId));
    await app.inject({
      method: 'POST', url: '/api/delivery/webhook/jahez',
      headers: hookHeaders, payload: raw,
    });
    const delivery = await one<{ order_id: string }>(
      'SELECT order_id FROM delivery_orders WHERE external_order_id = $1', [orderId],
    );

    const accepted = await app.inject({
      method: 'POST', url: `/api/delivery/orders/${delivery!.order_id}/accept`, headers,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);

    const jobs = await many('SELECT id FROM print_jobs WHERE order_id = $1',
      [delivery!.order_id]);
    expect(jobs.length).toBeGreaterThan(0);
  });
});

describe('the two properties that matter', () => {
  test('a repeated webhook does not cook the food twice', async () => {
    const app = await getApp();
    const orderId = `JZ-${Date.now()}-dup`;
    const eventId = `evt-${orderId}`;
    const { raw, headers } = post(jahezPayload(orderId, externalItemId), SECRET, eventId);

    const first = await app.inject({
      method: 'POST', url: '/api/delivery/webhook/jahez', headers, payload: raw,
    });
    expect(first.json().status).toBe('processed');

    // Aggregators retry hard. Three more identical deliveries.
    for (let i = 0; i < 3; i += 1) {
      const again = await app.inject({
        method: 'POST', url: '/api/delivery/webhook/jahez', headers, payload: raw,
      });
      expect(again.statusCode).toBe(200);
      expect(again.json().status).toBe('duplicate');
    }

    const orders = await many('SELECT order_id FROM delivery_orders WHERE external_order_id = $1',
      [orderId]);
    expect(orders.length).toBe(1);
  });

  test('a retry with no event id still cannot create a second order', async () => {
    const app = await getApp();
    const orderId = `JZ-${Date.now()}-noevt`;
    // Same order, different event id — the platform re-sending under a new id.
    const a = post(jahezPayload(orderId, externalItemId), SECRET, `e1-${orderId}`);
    const b = post(jahezPayload(orderId, externalItemId), SECRET, `e2-${orderId}`);

    await app.inject({ method: 'POST', url: '/api/delivery/webhook/jahez',
      headers: a.headers, payload: a.raw });
    const second = await app.inject({ method: 'POST', url: '/api/delivery/webhook/jahez',
      headers: b.headers, payload: b.raw });

    expect(second.json().status).toBe('duplicate');
    const orders = await many('SELECT order_id FROM delivery_orders WHERE external_order_id = $1',
      [orderId]);
    expect(orders.length).toBe(1);
  });

  test('an unmappable item is kept and raised, never dropped', async () => {
    const app = await getApp();
    const orderId = `JZ-${Date.now()}-unmapped`;
    const { raw, headers } = post(jahezPayload(orderId, 'JZ-ITEM-UNKNOWN'));

    const res = await app.inject({
      method: 'POST', url: '/api/delivery/webhook/jahez', headers, payload: raw,
    });
    // Acknowledged, not 5xx: a platform that gets an error retries forever and
    // retrying would not fix a missing mapping.
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('needs_mapping');

    // No half-order was created…
    const orders = await many('SELECT order_id FROM delivery_orders WHERE external_order_id = $1',
      [orderId]);
    expect(orders).toEqual([]);

    // …but the payload is on disk, and a human has been told.
    const event = await one<{ status: string; error: string; payload: any }>(
      `SELECT status, error, payload FROM delivery_events
        WHERE payload->>'jahez_id' = $1`, [orderId],
    );
    expect(event!.status).toBe('needs_mapping');
    expect(event!.error).toContain('صنف');

    const alerts = await many(
      `SELECT id FROM notifications WHERE kind = 'delivery_needs_mapping'`);
    expect(alerts.length).toBeGreaterThan(0);
  });

  test('mapping the item then replaying recovers the order', async () => {
    const app = await getApp();
    const headers = await ownerHeaders();
    const orderId = `JZ-${Date.now()}-replay`;
    const { raw, headers: hookHeaders } = post(jahezPayload(orderId, 'JZ-LATE-MAP'));

    await app.inject({
      method: 'POST', url: '/api/delivery/webhook/jahez',
      headers: hookHeaders, payload: raw,
    });
    const event = await one<{ id: string }>(
      `SELECT id FROM delivery_events WHERE payload->>'jahez_id' = $1`, [orderId],
    );

    const product = await sellableProduct();
    await app.inject({
      method: 'POST', url: `/api/delivery/partners/${partnerId}/menu-map`, headers,
      payload: { externalId: 'JZ-LATE-MAP', productId: product.id },
    });

    const replayed = await app.inject({
      method: 'POST', url: `/api/delivery/failed/${event!.id}/replay`, headers,
    });
    expect(replayed.statusCode, replayed.body).toBe(200);
    expect(replayed.json().status).toBe('processed');

    const orders = await many('SELECT order_id FROM delivery_orders WHERE external_order_id = $1',
      [orderId]);
    expect(orders.length).toBe(1);
  });
});

describe('signature', () => {
  test('a wrong signature is refused and no order is created', async () => {
    const app = await getApp();
    const orderId = `JZ-${Date.now()}-forged`;
    const { raw, headers } = post(jahezPayload(orderId, externalItemId), 'wrong-secret');

    const res = await app.inject({
      method: 'POST', url: '/api/delivery/webhook/jahez', headers, payload: raw,
    });
    expect(res.statusCode).toBe(401);

    const orders = await many('SELECT order_id FROM delivery_orders WHERE external_order_id = $1',
      [orderId]);
    expect(orders).toEqual([]);
  });

  test('a tampered body fails even with a signature for the original', async () => {
    const app = await getApp();
    const orderId = `JZ-${Date.now()}-tamper`;
    const original = jahezPayload(orderId, externalItemId, 1);
    const { headers } = post(original);

    // Signed for quantity 1, sent with quantity 99 — the attack the signature
    // exists to stop.
    const tampered = JSON.stringify({
      ...original,
      products: [{ ...original.products[0], quantity: 99 }],
    });
    const res = await app.inject({
      method: 'POST', url: '/api/delivery/webhook/jahez', headers, payload: tampered,
    });
    expect(res.statusCode).toBe(401);
  });

  test('a partner with no secret configured refuses everything', () => {
    const adapter = getAdapter('jahez')!;
    // Not "allow because unconfigured": this endpoint cooks food.
    expect(adapter.verify('{}', {}, null)).toBe(false);
  });
});

describe('adapters', () => {
  test('every listed platform has an adapter', () => {
    const codes = knownPartners().map((p) => p.code);
    expect(codes).toContain('jahez');
    expect(codes).toContain('hungerstation');
    expect(codes).toContain('keeta');
    expect(codes.length).toBeGreaterThanOrEqual(9);
    for (const code of codes) expect(getAdapter(code)).toBeTruthy();
  });

  test('platforms sending minor units are not multiplied by a hundred', () => {
    // Keeta sends halalas already; Jahez sends riyals. Getting this backwards
    // makes a 55 riyal item cost 5,500 or 0.55, and both look plausible.
    const keeta = getAdapter('keeta')!;
    const parsed = keeta.parse({
      eventType: 'ORDER_CREATE', orderId: 'K1', orderViewId: 'K-1',
      totalAmount: 12050,
      items: [{ skuId: 'S1', skuName: 'x', quantity: 1, price: 5500 }],
      recipient: { name: 'x', phone: '+9665', address: 'y' },
    });
    expect(parsed.kind).toBe('order.created');
    if (parsed.kind === 'order.created') {
      expect(parsed.order.platformTotal).toBe(12050);
      expect(parsed.order.lines[0]!.externalUnitPrice).toBe(5500);
    }

    const jahez = getAdapter('jahez')!;
    const jz = jahez.parse(jahezPayload('J1', 'X'));
    if (jz.kind === 'order.created') {
      expect(jz.order.platformTotal).toBe(12050);   // 120.50 riyals
    }
  });

  test('an unrecognised event is ignored rather than guessed at', () => {
    const adapter = getAdapter('jahez')!;
    const parsed = adapter.parse({ event: 'driver.location', jahez_id: 'J9' });
    expect(parsed.kind).toBe('ignored');
  });

  test('a cancellation is recognised as one', () => {
    const adapter = getAdapter('jahez')!;
    const parsed = adapter.parse({
      event: 'order.cancelled', jahez_id: 'J9', reason: 'العميل ألغى',
    });
    expect(parsed.kind).toBe('order.cancelled');
  });
});

describe('who may do what', () => {
  test('platform keys are never returned to the client', async () => {
    const app = await getApp();
    const headers = await ownerHeaders();
    const res = await app.inject({
      method: 'GET', url: '/api/delivery/partners', headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).toContain('has_secret');
  });

  test('saving without retyping the secret does not wipe it', async () => {
    const app = await getApp();
    const headers = await ownerHeaders();
    const before = await one<{ webhook_secret_enc: string }>(
      'SELECT webhook_secret_enc FROM delivery_partners WHERE id = $1', [partnerId],
    );

    await app.inject({
      method: 'POST', url: '/api/delivery/partners', headers,
      payload: { code: 'jahez', prepMinutes: 30 },
    });

    const after = await one<{ webhook_secret_enc: string; prep_minutes: number }>(
      'SELECT webhook_secret_enc, prep_minutes FROM delivery_partners WHERE id = $1',
      [partnerId],
    );
    expect(after!.webhook_secret_enc).toBe(before!.webhook_secret_enc);
    expect(after!.prep_minutes).toBe(30);
  });

  test('rejecting requires a reason, because it reaches the customer', async () => {
    const app = await getApp();
    const headers = await ownerHeaders();
    const orderId = `JZ-${Date.now()}-rej`;
    const { raw, headers: hookHeaders } = post(jahezPayload(orderId, externalItemId));
    await app.inject({
      method: 'POST', url: '/api/delivery/webhook/jahez',
      headers: hookHeaders, payload: raw,
    });
    const delivery = await one<{ order_id: string }>(
      'SELECT order_id FROM delivery_orders WHERE external_order_id = $1', [orderId],
    );

    const noReason = await app.inject({
      method: 'POST', url: `/api/delivery/orders/${delivery!.order_id}/reject`,
      headers, payload: {},
    });
    expect(noReason.statusCode).toBe(400);

    const rejected = await app.inject({
      method: 'POST', url: `/api/delivery/orders/${delivery!.order_id}/reject`,
      headers, payload: { reason: 'الصنف غير متوفر الآن' },
    });
    expect(rejected.statusCode, rejected.body).toBe(200);

    // Cancelled, never deleted — it is a financial record even uncooked.
    const order = await one<{ status: string; cancel_reason: string }>(
      'SELECT status, cancel_reason FROM orders WHERE id = $1', [delivery!.order_id],
    );
    expect(order!.status).toBe('cancelled');
    expect(order!.cancel_reason).toContain('غير متوفر');
  });
});

describe('the kitchen ticket', () => {
  test('shows the platform reference where a table number would be', async () => {
    const app = await getApp();
    const headers = await ownerHeaders();
    const orderId = `JZ-${Date.now()}-ticket`;
    const { raw, headers: hookHeaders } = post(jahezPayload(orderId, externalItemId));
    await app.inject({
      method: 'POST', url: '/api/delivery/webhook/jahez',
      headers: hookHeaders, payload: raw,
    });
    const delivery = await one<{ order_id: string; external_reference: string }>(
      'SELECT order_id, external_reference FROM delivery_orders WHERE external_order_id = $1',
      [orderId],
    );
    await app.inject({
      method: 'POST', url: `/api/delivery/orders/${delivery!.order_id}/accept`, headers,
    });

    const job = await one<{ payload: any }>(
      'SELECT payload FROM print_jobs WHERE order_id = $1 LIMIT 1', [delivery!.order_id],
    );
    expect(job).toBeTruthy();
    // The rider asks for the platform's number, not ours — printing ours in the
    // large slot has them reading past each other at the counter.
    expect(job!.payload.tableNumber).toBe(delivery!.external_reference);
    expect(job!.payload.banner).toBe('DELIVERY');
    expect(job!.payload.orderType).toContain('جاهز');
  });
});

describe('the accept decision', () => {
  test('the board carries the lines, not just a total', async () => {
    const app = await getApp();
    const headers = await ownerHeaders();
    const orderId = `JZ-${Date.now()}-lines`;
    const { raw, headers: hookHeaders } = post(jahezPayload(orderId, externalItemId, 3));
    await app.inject({
      method: 'POST', url: '/api/delivery/webhook/jahez',
      headers: hookHeaders, payload: raw,
    });

    const res = await app.inject({
      method: 'GET', url: '/api/delivery/orders', headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const board = res.json().orders.find(
      (o: any) => o.external_reference?.includes(orderId.slice(-4)));
    expect(board).toBeTruthy();
    // Judging whether the kitchen can cook it needs the items themselves.
    expect(Array.isArray(board.items)).toBe(true);
    expect(board.items.length).toBe(1);
    expect(board.items[0].quantity).toBe(3);
    expect(board.items[0].name).toBeTruthy();
    expect(board.items[0]).toHaveProperty('available');
  });
});

describe('concurrency', () => {
  test('two simultaneous deliveries of one webhook make one order', async () => {
    const app = await getApp();
    const orderId = `JZ-${Date.now()}-race`;
    // Different event ids, so the event-level dedupe cannot help: this tests
    // the order-level index, which is what a real retry storm hits.
    const a = post(jahezPayload(orderId, externalItemId), SECRET, `r1-${orderId}`);
    const b = post(jahezPayload(orderId, externalItemId), SECRET, `r2-${orderId}`);
    const c = post(jahezPayload(orderId, externalItemId), SECRET, `r3-${orderId}`);

    const results = await Promise.all([a, b, c].map((p) => app.inject({
      method: 'POST', url: '/api/delivery/webhook/jahez',
      headers: p.headers, payload: p.raw,
    })));

    for (const res of results) expect(res.statusCode).toBe(200);
    const statuses = results.map((r) => r.json().status);
    expect(statuses.filter((s) => s === 'processed').length).toBe(1);
    expect(statuses.filter((s) => s === 'duplicate').length).toBe(2);

    const rows = await many(
      'SELECT order_id FROM delivery_orders WHERE external_order_id = $1', [orderId]);
    expect(rows.length).toBe(1);

    // And exactly one order, not one plus two orphans.
    const orders = await many(
      `SELECT id FROM orders WHERE idempotency_key = $1`, [`jahez:${orderId}`]);
    expect(orders.length).toBe(1);
  });
});
