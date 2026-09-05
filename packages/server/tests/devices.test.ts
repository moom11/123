import { afterAll, describe, expect, test } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  auth, authAtTill, closeApp, getApp, getBranchId, loginAdmin,
  loginEmployee, till, waiterDevice,
} from './helpers.js';
import { many, one } from '../src/core/db.js';
import { generateStampKeyPair } from '../src/core/zatca/sign.js';
import { buildCsr, egsSerial, pemBody } from '../src/core/zatca/csr.js';
import { certificateExpiry } from '../src/core/zatca/onboarding.js';
import { oid, sequence, integer } from '../src/core/zatca/der.js';

const OWNER = { email: 'owner@maralounge.sa', password: 'MaraOwner#2026Xy' };

afterAll(async () => { await closeApp(); });

async function ownerHeaders(): Promise<Record<string, string>> {
  const session = await loginAdmin(OWNER.email, OWNER.password);
  return { ...auth(session), 'x-branch-id': await getBranchId() };
}

/**
 * A table with nothing open on it. Data-driven rather than a hardcoded number:
 * how many tables the seed creates is not this test's business.
 */
async function freeTable(): Promise<string> {
  const row = await one<{ id: string }>(
    `SELECT t.id FROM restaurant_tables t
      WHERE t.is_active AND t.current_session_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM orders o
           WHERE o.table_id = t.id AND o.status NOT IN ('paid','cancelled'))
      ORDER BY random() LIMIT 1`,
  );
  if (!row) throw new Error('no free table');
  return row.id;
}

/** Ring up a bill without settling it. */
async function openBill(): Promise<{ orderId: string; total: number }> {
  const app = await getApp();
  const cashier = await loginEmployee('2001', '4826');
  const product = await one<{ id: string }>(
    `SELECT p.id FROM products p
      WHERE p.is_active AND p.is_available AND p.deleted_at IS NULL AND p.price > 0
        AND NOT EXISTS (
          SELECT 1 FROM product_modifiers pm JOIN modifiers m ON m.id = pm.modifier_id
           WHERE pm.product_id = p.id
             AND COALESCE(pm.is_required_override, m.is_required))
      ORDER BY p.price DESC LIMIT 1`,
  );
  const created = await app.inject({
    method: 'POST', url: '/api/orders', headers: auth(cashier),
    payload: { tableId: await freeTable(), lines: [{ productId: product!.id, quantity: 1 }] },
  });
  expect(created.statusCode, created.body).toBe(200);
  const orderId = created.json().orderId;
  const order = await one<{ grand_total: string }>(
    'SELECT grand_total FROM orders WHERE id = $1', [orderId],
  );
  return { orderId, total: Number(order!.grand_total) };
}

describe('only a till closes a bill', () => {
  test('a waiter tablet is refused, and the message says where to go', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const { orderId, total } = await openBill();

    const res = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/pay`,
      headers: { ...auth(cashier), ...(await waiterDevice()) },
      payload: { parts: [{ method: 'cash', amount: total }] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('الكاشير');

    // And nothing moved: no payment, no invoice, no counter burned.
    const payments = await many('SELECT id FROM payments WHERE order_id = $1', [orderId]);
    expect(payments).toEqual([]);
    const invoices = await many('SELECT id FROM invoices WHERE order_id = $1', [orderId]);
    expect(invoices).toEqual([]);
  });

  test('an unregistered terminal is refused rather than defaulted', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const { orderId, total } = await openBill();

    // No device header at all — the case a browser on someone's laptop hits.
    const res = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/pay`, headers: auth(cashier),
      payload: { parts: [{ method: 'cash', amount: total }] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('غير مسجَّل');
  });

  test('the till settles, and the payment records which terminal took it', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const { orderId, total } = await openBill();

    const res = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/pay`,
      headers: await authAtTill(cashier),
      payload: { parts: [{ method: 'cash', amount: total }] },
    });
    expect(res.statusCode, res.body).toBe(200);

    const payment = await one<{ device_id: string }>(
      'SELECT device_id FROM payments WHERE order_id = $1', [orderId],
    );
    const invoice = await one<{ device_id: string }>(
      'SELECT device_id FROM invoices WHERE order_id = $1', [orderId],
    );
    expect(payment!.device_id).toBeTruthy();
    // The invoice belongs to the unit that issued it — that is what ZATCA
    // validates the counter against.
    expect(invoice!.device_id).toBe(payment!.device_id);
  });

  test('a waiter tablet can still take an order', async () => {
    const app = await getApp();
    const waiter = await loginEmployee('1042', '2580');
    const product = await one<{ id: string }>(
      `SELECT p.id FROM products p
        WHERE p.is_active AND p.is_available AND p.deleted_at IS NULL AND p.price > 0
          AND NOT EXISTS (
            SELECT 1 FROM product_modifiers pm JOIN modifiers m ON m.id = pm.modifier_id
             WHERE pm.product_id = p.id
               AND COALESCE(pm.is_required_override, m.is_required))
        LIMIT 1`,
    );
    const res = await app.inject({
      method: 'POST', url: '/api/orders',
      headers: { ...auth(waiter), ...(await waiterDevice()) },
      payload: {
        tableId: await freeTable(),
        lines: [{ productId: product!.id, quantity: 1 }],
      },
    });
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('device registry', () => {
  test('a terminal reports what it is, before anyone logs in', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'GET', url: '/api/devices/me', headers: await till(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().device.kind).toBe('cashier');
    expect(res.json().device.canSettle).toBe(true);
  });

  test('an unknown token is simply not registered', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'GET', url: '/api/devices/me',
      headers: { 'x-device-token': 'not-a-real-token' },
    });
    expect(res.json()).toEqual({ registered: false });
  });

  test('registering returns the token exactly once', async () => {
    const app = await getApp();
    const headers = await ownerHeaders();
    const serial = `TILL-TEST-${Date.now()}`;

    const created = await app.inject({
      method: 'POST', url: '/api/devices', headers,
      payload: { kind: 'cashier', label: 'كاشير تجريبي', serialNumber: serial },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().token).toBeTruthy();

    // The listing never carries it back.
    const list = await app.inject({ method: 'GET', url: '/api/devices', headers });
    expect(list.body).not.toContain(created.json().token);

    // Stored hashed, so the raw token is nowhere in the row.
    const row = await one<{ token_hash: string }>(
      'SELECT token_hash FROM devices WHERE serial_number = $1', [serial],
    );
    expect(row!.token_hash).not.toBe(created.json().token);
  });

  test('a duplicate serial in the same branch is refused', async () => {
    const app = await getApp();
    const headers = await ownerHeaders();
    const serial = `DUP-${Date.now()}`;
    const payload = { kind: 'waiter', label: 'جهاز', serialNumber: serial };

    expect((await app.inject({ method: 'POST', url: '/api/devices', headers, payload }))
      .statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/devices', headers, payload }))
      .statusCode).toBe(409);
  });

  test('the last till in a branch cannot be retired', async () => {
    const app = await getApp();
    const headers = await ownerHeaders();
    const branchId = await getBranchId();

    // Retire every till but one, then try the last.
    const tills = await many<{ id: string }>(
      `SELECT id FROM devices WHERE branch_id = $1 AND kind = 'cashier'
         AND is_active AND deleted_at IS NULL ORDER BY registered_at`,
      [branchId],
    );
    for (const extra of tills.slice(1)) {
      await app.inject({
        method: 'POST', url: `/api/devices/${extra.id}/retire`, headers,
        payload: { reason: 'تنظيف بيانات الاختبار' },
      });
    }
    const res = await app.inject({
      method: 'POST', url: `/api/devices/${tills[0]!.id}/retire`, headers,
      payload: { reason: 'محاولة إيقاف آخر كاشير' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('آخر جهاز كاشير');
  });

  test('a cashier cannot register a device', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const res = await app.inject({
      method: 'POST', url: '/api/devices', headers: auth(cashier),
      payload: { kind: 'cashier', label: 'x', serialNumber: 'X-1' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('the certificate request ZATCA is given', () => {
  const pair = generateStampKeyPair();
  const unit = {
    environment: 'sandbox' as const,
    commonName: 'MARA-TILL-01',
    vatNumber: '300000000000003',
    organizationName: 'MARA Lounge',
    branchName: 'مارا لاونج',
    registeredAddress: 'Riyadh, King Fahd Rd',
    businessCategory: 'Restaurant',
    serialNumber: 'TILL-01',
  };
  const csr = buildCsr(pair.privateKeyPem, unit);

  /** openssl is the honest judge: either it parses and verifies, or it does not. */
  const inspect = (): string => {
    const path = `/tmp/mara-csr-${process.pid}.pem`;
    writeFileSync(path, csr);
    return execSync(`openssl req -in ${path} -noout -text -verify 2>&1`).toString();
  };

  test('openssl verifies the signature', () => {
    expect(inspect()).toContain('verify OK');
  });

  test('the key is secp256k1, as ZATCA requires', () => {
    expect(inspect()).toContain('secp256k1');
  });

  test('carries the certificate template for its environment', () => {
    // The single most common onboarding failure: a perfect CSR built for the
    // wrong environment, refused with a message that does not say so.
    expect(inspect()).toContain('TSTZATCACA-Code-Signing');
    const production = buildCsr(pair.privateKeyPem, { ...unit, environment: 'production' });
    expect(production).not.toBe(csr);
  });

  test('the subjectAltName carries the EGS identity', () => {
    const text = inspect();
    expect(text).toContain('Subject Alternative Name');
    expect(text).toContain('1-MARA|2-POS|3-TILL-01');   // EGS serial
    expect(text).toContain('300000000000003');           // VAT, as UID
    expect(text).toContain('title=0100');                // simplified only
    expect(text).toContain('businessCategory=Restaurant');
  });

  test('the EGS serial is the composite ZATCA specifies', () => {
    expect(egsSerial(unit)).toBe('1-MARA|2-POS|3-TILL-01');
  });

  test('pemBody strips the armour, which is what the API field carries', () => {
    const body = pemBody(csr);
    expect(body).not.toContain('-----');
    expect(body).not.toContain('\n');
    expect(Buffer.from(body, 'base64').length).toBeGreaterThan(100);
  });
});

describe('DER encoding', () => {
  test('lengths cross the 128-byte boundary correctly', () => {
    // Short form up to 127, long form above — the classic off-by-one that
    // produces bytes which parse as something else entirely.
    expect([...sequence(Buffer.alloc(127))].slice(0, 2)).toEqual([0x30, 0x7f]);
    expect([...sequence(Buffer.alloc(128))].slice(0, 3)).toEqual([0x30, 0x81, 0x80]);
    expect([...sequence(Buffer.alloc(256))].slice(0, 4)).toEqual([0x30, 0x82, 0x01, 0x00]);
  });

  test('OID arcs pack the first two and base-128 the rest', () => {
    // 1.2.840.113549.1.9.14 — extensionRequest, a known value to check against.
    expect([...oid('1.2.840.113549.1.9.14')])
      .toEqual([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x0e]);
  });

  test('an integer whose top bit is set is padded, not read as negative', () => {
    expect([...integer(0x80)]).toEqual([0x02, 0x02, 0x00, 0x80]);
    expect([...integer(0x7f)]).toEqual([0x02, 0x01, 0x7f]);
    expect([...integer(0)]).toEqual([0x02, 0x01, 0x00]);
  });
});

describe('certificate expiry', () => {
  test('is read from the certificate, not assumed', () => {
    // A real self-signed certificate, so the parser is tested against bytes
    // openssl produced rather than bytes we invented.
    const path = `/tmp/mara-cert-${process.pid}`;
    execSync(
      `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:secp256k1 `
      + `-keyout ${path}.key -out ${path}.crt -days 365 -nodes -subj "/CN=test" 2>/dev/null`,
    );
    const pem = execSync(`cat ${path}.crt`).toString();
    const expiry = certificateExpiry(pem);
    expect(expiry).toBeInstanceOf(Date);
    const days = (expiry!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(360);
    expect(days).toBeLessThan(370);
  });

  test('returns null rather than throwing on rubbish', () => {
    expect(certificateExpiry('not a certificate')).toBeNull();
  });
});

describe('a retried settlement', () => {
  test('returns the same invoice rather than nothing to print', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const { orderId, total } = await openBill();
    const key = `retry-${Date.now()}`;
    const headers = await authAtTill(cashier);

    const first = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/pay`, headers,
      payload: { parts: [{ method: 'cash', amount: total }], idempotencyKey: key },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().invoice.number).toBeTruthy();

    // The same submit again — a tap that double-fired, or a reply that never
    // arrived. The till still needs the number and QR to print.
    const again = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/pay`, headers,
      payload: { parts: [{ method: 'cash', amount: total }], idempotencyKey: key },
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().invoice.number).toBe(first.json().invoice.number);
    expect(again.json().invoice.qr).toBe(first.json().invoice.qr);

    // And exactly one invoice exists, with one counter value spent.
    const rows = await many('SELECT id FROM invoices WHERE order_id = $1', [orderId]);
    expect(rows.length).toBe(1);
  });
});
