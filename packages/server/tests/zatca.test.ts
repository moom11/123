import { afterAll, describe, expect, test } from 'vitest';
import { createVerify, createPublicKey } from 'node:crypto';
import {
  auth, closeApp, getApp, getBranchId, getCustomerId, getTableId, loginAdmin,
  loginEmployee,
} from './helpers.js';
import { many, one } from '../src/core/db.js';
import { decodeQr, encodeQr, halalasToRiyalString } from '../src/core/zatca/tlv.js';
import { invoiceHash } from '../src/core/zatca/sign.js';

const OWNER = { email: 'owner@maralounge.sa', password: 'MaraOwner#2026Xy' };

/**
 * The owner belongs to every branch and therefore to none by default, so the
 * server cannot guess which branch a request is about. The POS sends
 * X-Branch-Id for exactly this reason; these tests do the same.
 */
async function ownerAuth(): Promise<Record<string, string>> {
  const session = await loginAdmin(OWNER.email, OWNER.password);
  return { ...auth(session), 'x-branch-id': await getBranchId() };
}

/** ZATCA's mandated first PIH: base64 of the SHA-256 hex of "0". */
const GENESIS = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';

afterAll(async () => { await closeApp(); });

/** Ring up a bill and settle it, which is what mints an invoice. */
async function sellableProductId(): Promise<string> {
  const row = await one<{ id: string }>(
    `SELECT p.id FROM products p
      WHERE p.is_active AND p.is_available AND p.deleted_at IS NULL AND p.price > 0
        AND NOT EXISTS (
          SELECT 1 FROM product_modifiers pm
            JOIN modifiers m ON m.id = pm.modifier_id
           WHERE pm.product_id = p.id
             AND COALESCE(pm.is_required_override, m.is_required)
        )
      ORDER BY p.price DESC LIMIT 1`,
  );
  if (!row) throw new Error('no product without a required modifier group');
  return row.id;
}

async function sellAndSettle(tableNumber: string): Promise<{
  orderId: string; invoice: { id: string; number: string; icv: number; qr: string };
}> {
  const app = await getApp();
  const cashier = await loginEmployee('2001', '4826');
  // Data-driven rather than a named item: several products require an option
  // to be chosen (sugar, mint), and a test that hardcodes one breaks the day
  // someone edits the menu. Any sellable product with no required group does.
  const productId = await sellableProductId();
  const tableId = await getTableId(tableNumber);

  const created = await app.inject({
    method: 'POST', url: '/api/orders', headers: auth(cashier),
    payload: {
      tableId, orderType: 'dine_in',
      lines: [{ productId, quantity: 2 }],
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const orderId = created.json().orderId;

  const order = await one<{ grand_total: string }>(
    'SELECT grand_total FROM orders WHERE id = $1', [orderId],
  );

  const paid = await app.inject({
    method: 'POST', url: `/api/orders/${orderId}/pay`, headers: auth(cashier),
    payload: {
      parts: [{ method: 'cash', amount: Number(order!.grand_total),
                tendered: Number(order!.grand_total) }],
    },
  });
  expect(paid.statusCode, paid.body).toBe(200);
  return { orderId, invoice: paid.json().invoice };
}

describe('TLV encoding', () => {
  test('round-trips every tag the spec requires', () => {
    const signature = Buffer.from('signature-bytes');
    const publicKey = Buffer.from('public-key-bytes');
    const encoded = encodeQr({
      sellerName: 'مارا لاونج',
      vatNumber: '300000000000003',
      timestamp: '2026-09-04T12:30:00Z',
      totalWithVat: '115.00',
      vatTotal: '15.00',
      invoiceHash: 'aGFzaA==',
      signature,
      publicKey,
    });

    const tags = new Map(decodeQr(encoded).map((t) => [t.tag, t.value]));
    expect(tags.get(1)!.toString('utf8')).toBe('مارا لاونج');
    expect(tags.get(2)!.toString('utf8')).toBe('300000000000003');
    expect(tags.get(4)!.toString('utf8')).toBe('115.00');
    expect(tags.get(5)!.toString('utf8')).toBe('15.00');
    // 7 and 8 must be raw bytes, not base64 text — a scanner parses them, and
    // text here validates locally then fails at the authority.
    expect(tags.get(7)).toEqual(signature);
    expect(tags.get(8)).toEqual(publicKey);
    // Tag 9 is omitted rather than faked when there is no certificate.
    expect(tags.has(9)).toBe(false);
  });

  test('refuses a value longer than one length byte can describe', () => {
    expect(() => encodeQr({
      sellerName: 'x'.repeat(256),
      vatNumber: '3', timestamp: 't', totalWithVat: '1.00', vatTotal: '0.00',
      invoiceHash: 'h', signature: Buffer.alloc(1), publicKey: Buffer.alloc(1),
    })).toThrow(/255/);
  });

  test('formats halalas without ever touching a float', () => {
    expect(halalasToRiyalString(0)).toBe('0.00');
    expect(halalasToRiyalString(5)).toBe('0.05');
    expect(halalasToRiyalString(1840)).toBe('18.40');
    expect(halalasToRiyalString(-1840)).toBe('-18.40');
    // The case that breaks naive float formatting: 0.1 + 0.2 arithmetic.
    expect(halalasToRiyalString(30)).toBe('0.30');
  });
});

describe('invoice chain', () => {
  test('the first invoice of a branch chains onto the genesis hash', async () => {
    const branchId = await getBranchId();
    const first = await one<{ pih: string; icv: string }>(
      'SELECT pih, icv FROM invoices WHERE branch_id = $1 ORDER BY icv LIMIT 1',
      [branchId],
    );
    if (!first) return;                       // nothing sold yet in this run
    expect(Number(first.icv)).toBe(1);
    expect(first.pih).toBe(GENESIS);
  });

  test('each invoice carries the hash of the one before it', async () => {
    await sellAndSettle('5');
    await sellAndSettle('6');

    const branchId = await getBranchId();
    const rows = await many<{ icv: string; pih: string; invoice_hash: string }>(
      'SELECT icv, pih, invoice_hash FROM invoices WHERE branch_id = $1 ORDER BY icv',
      [branchId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);

    for (let i = 1; i < rows.length; i += 1) {
      expect(Number(rows[i]!.icv)).toBe(Number(rows[i - 1]!.icv) + 1);
      expect(rows[i]!.pih).toBe(rows[i - 1]!.invoice_hash);
    }
  });

  test('the chain verifies with no breaks', async () => {
    const app = await getApp();
    const headers = await ownerAuth();
    const res = await app.inject({
      method: 'GET', url: '/api/invoices/chain/verify', headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.checked).toBeGreaterThan(0);
    expect(body.breaks).toEqual([]);
  });
});

describe('stamping', () => {
  test('the signature verifies against the branch public key', async () => {
    const { invoice } = await sellAndSettle('7');
    const row = await one<{ xml: string; signature: string; branch_id: string; invoice_hash: string }>(
      'SELECT xml, signature, branch_id, invoice_hash FROM invoices WHERE id = $1',
      [invoice.id],
    );
    const creds = await one<{ public_key_der: string }>(
      'SELECT public_key_der FROM zatca_credentials WHERE branch_id = $1', [row!.branch_id],
    );

    // Recover the canonical document by removing the signature extension that
    // was inserted after hashing — this is the same reconstruction an auditor
    // performs, so if it does not verify, nothing downstream can be trusted.
    const canonical = row!.xml
      .replace('<?xml version="1.0" encoding="UTF-8"?>', '')
      .replace(/<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>/, '');

    expect(invoiceHash(canonical)).toBe(row!.invoice_hash);

    const publicKey = createPublicKey({
      key: Buffer.from(creds!.public_key_der, 'base64'),
      format: 'der', type: 'spki',
    });
    const verifier = createVerify('sha256');
    verifier.update(canonical, 'utf8');
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(row!.signature, 'base64'))).toBe(true);
  });

  test('the QR carries the totals actually charged', async () => {
    const { orderId, invoice } = await sellAndSettle('8');
    const order = await one<{ grand_total: string; vat_amount: string }>(
      'SELECT grand_total, vat_amount FROM orders WHERE id = $1', [orderId],
    );
    const tags = new Map(decodeQr(invoice.qr).map((t) => [t.tag, t.value.toString('utf8')]));
    expect(tags.get(4)).toBe(halalasToRiyalString(Number(order!.grand_total)));
    expect(tags.get(5)).toBe(halalasToRiyalString(Number(order!.vat_amount)));
    expect(tags.get(2)).toBeTruthy();
  });

  test('line VAT sums to exactly the invoice VAT', async () => {
    const { invoice } = await sellAndSettle('9');
    const row = await one<{ xml: string; vat_amount: string }>(
      'SELECT xml, vat_amount FROM invoices WHERE id = $1', [invoice.id],
    );
    const lineVats = [...row!.xml.matchAll(
      /<cac:TaxTotal><cbc:TaxAmount currencyID="SAR">([-\d.]+)<\/cbc:TaxAmount><cbc:RoundingAmount/g,
    )].map((m) => Math.round(Number(m[1]) * 100));
    expect(lineVats.length).toBeGreaterThan(0);
    expect(lineVats.reduce((a, b) => a + b, 0)).toBe(Number(row!.vat_amount));
  });
});

describe('one invoice per sale', () => {
  test('settling an already-settled order does not mint a second invoice', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const { orderId } = await sellAndSettle('10');

    const before = await one<{ n: string }>(
      'SELECT count(*)::text AS n FROM invoices WHERE order_id = $1', [orderId],
    );
    // A second settlement attempt on a paid order.
    await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/pay`, headers: auth(cashier),
      payload: { parts: [{ method: 'cash', amount: 100 }] },
    });
    const after = await one<{ n: string }>(
      'SELECT count(*)::text AS n FROM invoices WHERE order_id = $1', [orderId],
    );
    expect(after!.n).toBe(before!.n);
    expect(Number(before!.n)).toBe(1);
  });
});

describe('credit notes', () => {
  test('reverses the original, references it, and takes the next counter', async () => {
    const app = await getApp();
    const headers = await ownerAuth();
    const { invoice } = await sellAndSettle('11');

    const original = await one<{ grand_total: string; vat_amount: string; icv: string }>(
      'SELECT grand_total, vat_amount, icv FROM invoices WHERE id = $1', [invoice.id],
    );

    const res = await app.inject({
      method: 'POST', url: `/api/invoices/${invoice.id}/credit-note`, headers,
      payload: { reason: 'إلغاء بعد الدفع' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const note = res.json();

    const noteRow = await one<{
      grand_total: string; vat_amount: string; icv: string;
      reversed_invoice_id: string; document_type: string; pih: string;
    }>('SELECT * FROM invoices WHERE id = $1', [note.id]);

    expect(noteRow!.document_type).toBe('credit_note');
    expect(noteRow!.reversed_invoice_id).toBe(invoice.id);
    // The pair must sum to zero — that is what makes a reversal reconcilable.
    expect(Number(noteRow!.grand_total)).toBe(-Number(original!.grand_total));
    expect(Number(noteRow!.vat_amount)).toBe(-Number(original!.vat_amount));
    expect(Number(noteRow!.icv)).toBeGreaterThan(Number(original!.icv));
  });

  test('refuses a second credit note for the same invoice', async () => {
    const app = await getApp();
    const headers = await ownerAuth();
    const { invoice } = await sellAndSettle('14');

    const first = await app.inject({
      method: 'POST', url: `/api/invoices/${invoice.id}/credit-note`, headers,
      payload: { reason: 'خطأ في الطلب' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST', url: `/api/invoices/${invoice.id}/credit-note`, headers,
      payload: { reason: 'مرة أخرى' },
    });
    expect(second.statusCode).toBe(409);
  });
});

describe('who may touch the stamping identity', () => {
  test('a cashier cannot provision credentials', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const res = await app.inject({
      method: 'POST', url: '/api/invoices/credentials', headers: auth(cashier),
      payload: { environment: 'sandbox' },
    });
    expect(res.statusCode).toBe(403);
  });

  test('the private key is never returned by any endpoint', async () => {
    const app = await getApp();
    const headers = await ownerAuth();
    const res = await app.inject({
      method: 'GET', url: '/api/invoices/credentials', headers,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain('PRIVATE KEY');
    expect(res.body).not.toContain('private_key');
  });

  test('a cashier can still read invoices, because reprinting is their job', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const res = await app.inject({
      method: 'GET', url: '/api/invoices?limit=5', headers: auth(cashier),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(Array.isArray(res.json().invoices)).toBe(true);
  });
});

describe('reporting queue', () => {
  test('an invoice starts pending and is never marked reported without a CSID', async () => {
    const app = await getApp();
    const headers = await ownerAuth();
    const { invoice } = await sellAndSettle('15');

    const before = await one<{ report_status: string }>(
      'SELECT report_status FROM invoices WHERE id = $1', [invoice.id],
    );
    expect(before!.report_status).toBe('pending');

    // The seed has no certificate, so flushing must fail loudly rather than
    // marking anything reported. Claiming an unreported invoice was reported is
    // the one error an auditor cannot recover from.
    // The queue drains oldest-first, so the limit has to cover the whole
    // backlog for this invoice to be among the ones attempted.
    const res = await app.inject({
      method: 'POST', url: '/api/invoices/report', headers,
      payload: { limit: 200 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().reported).toBe(0);

    const after = await one<{ report_status: string; last_error: string }>(
      'SELECT report_status, last_error FROM invoices WHERE id = $1', [invoice.id],
    );
    expect(after!.report_status).toBe('failed');
    expect(after!.last_error).toMatch(/CSID/);
  });
});

describe('an order with a named customer', () => {
  /**
   * Regression: the buyer block reads the customer's name, and the column is
   * full_name. Every test above sells to a walk-in, so this path — the one a
   * loyalty member takes — was the one nobody exercised.
   */
  test('names the buyer on the invoice and still settles', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const customerId = await getCustomerId();
    const productId = await sellableProductId();

    const created = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth(cashier),
      payload: {
        tableId: await getTableId('16'), customerId,
        lines: [{ productId, quantity: 1 }],
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const orderId = created.json().orderId;

    const order = await one<{ grand_total: string }>(
      'SELECT grand_total FROM orders WHERE id = $1', [orderId],
    );
    const paid = await app.inject({
      method: 'POST', url: `/api/orders/${orderId}/pay`, headers: auth(cashier),
      payload: { parts: [{ method: 'cash', amount: Number(order!.grand_total) }] },
    });
    expect(paid.statusCode, paid.body).toBe(200);

    const invoice = await one<{ xml: string }>(
      'SELECT xml FROM invoices WHERE order_id = $1', [orderId],
    );
    const customer = await one<{ full_name: string }>(
      'SELECT full_name FROM customers WHERE id = $1', [customerId],
    );
    expect(invoice!.xml).toContain('<cac:AccountingCustomerParty>');
    expect(invoice!.xml).toContain(customer!.full_name);
  });
});
