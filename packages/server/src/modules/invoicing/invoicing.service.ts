/**
 * ZATCA simplified tax invoices.
 *
 * Issued inside the payment transaction, so an order can never be settled
 * without an invoice and an invoice can never exist for an unsettled order —
 * they commit or fail together.
 *
 * Reporting is deliberately NOT part of that transaction. A restaurant cannot
 * stop serving because a government API is slow, and ZATCA allows 24 hours for
 * a simplified invoice. So the invoice is issued, stamped and printed locally,
 * and a background job drains the queue afterwards.
 */
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { many, one, withTransaction } from '../../core/db.js';
import { decryptSecret, encryptSecret } from '../../core/crypto.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { AUDIT, audit } from '../../core/audit.js';
import type { Principal } from '../../core/principal.js';
import { assertBranchAccess } from '../../core/principal.js';
import { canonicalInvoiceXml, signedInvoiceXml } from '../../core/zatca/xml.js';
import type { InvoiceInput, InvoiceLineInput } from '../../core/zatca/xml.js';
import {
  certificateSignature, generateStampKeyPair, invoiceHash, publicKeyDerFromPrivate, stamp,
} from '../../core/zatca/sign.js';
import { encodeQr, halalasToRiyalString } from '../../core/zatca/tlv.js';

/** UN/ECE 4461 payment means. Card and cash are all a restaurant issues. */
const PAYMENT_MEANS: Record<string, string> = {
  cash: '10', mada: '48', visa: '48', mastercard: '48',
  apple_pay: '48', wallet_points: '68',
};

export interface IssuedInvoice {
  id: string;
  invoiceNumber: string;
  uuid: string;
  icv: number;
  invoiceHash: string;
  qr: string;
  grandTotal: number;
  vatAmount: number;
  issuedAt: Date;
}

/**
 * Allocate the next link in this branch's chain.
 *
 * The row lock is the whole point: two tills closing bills in the same
 * millisecond must not both take counter 41, and must not both chain onto the
 * same predecessor. Serialising here costs microseconds and is the difference
 * between a valid chain and a rejected month.
 */
async function allocateChainLink(
  branchId: string, client: PoolClient,
): Promise<{ icv: number; pih: string }> {
  await client.query(
    `INSERT INTO invoice_counters (branch_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [branchId],
  );
  const counter = await one<{ last_icv: string; last_hash: string }>(
    'SELECT last_icv, last_hash FROM invoice_counters WHERE branch_id = $1 FOR UPDATE',
    [branchId], client,
  );
  return { icv: Number(counter!.last_icv) + 1, pih: counter!.last_hash };
}

interface CredentialRow {
  private_key_enc: string; certificate: string | null; is_production: boolean;
}

/**
 * The branch's stamping identity. Absent means invoicing has not been set up,
 * which must fail loudly at payment time rather than silently printing a
 * receipt with no QR — an unstamped sale is a compliance breach, not a warning.
 */
async function credentials(branchId: string, client: PoolClient): Promise<CredentialRow> {
  const row = await one<CredentialRow>(
    'SELECT private_key_enc, certificate, is_production FROM zatca_credentials WHERE branch_id = $1',
    [branchId], client,
  );
  if (!row) {
    throw badRequest(
      'لم تُهيَّأ الفوترة الإلكترونية لهذا الفرع — أنشئ بيانات الاعتماد من شاشة الإعدادات قبل الافتتاح.',
    );
  }
  return row;
}

/**
 * Issue the invoice for a settled order. Call inside the payment transaction.
 * Idempotent per order: a retried settlement returns the invoice already
 * issued rather than minting a second one and burning a counter value.
 */
export async function issueInvoiceForOrder(
  orderId: string, client: PoolClient,
): Promise<IssuedInvoice> {
  const existing = await one<{ id: string }>(
    `SELECT id FROM invoices WHERE order_id = $1 AND document_type = 'invoice'`,
    [orderId], client,
  );
  if (existing) return loadInvoice(existing.id, client);

  const order = await one<{
    id: string; order_number: string; branch_id: string; customer_id: string | null;
    subtotal: string; discount_total: string; points_discount_total: string;
    vat_amount: string; grand_total: string;
  }>(
    `SELECT id, order_number, branch_id, customer_id, subtotal, discount_total,
            points_discount_total, vat_amount, grand_total
       FROM orders WHERE id = $1`,
    [orderId], client,
  );
  if (!order) throw notFound('الطلب غير موجود');

  const branch = await one<{
    name_ar: string; vat_number: string | null; address: string | null; vat_percent: string;
  }>(
    'SELECT name_ar, vat_number, address, vat_percent FROM branches WHERE id = $1',
    [order.branch_id], client,
  );
  if (!branch?.vat_number) {
    throw badRequest('الفرع بلا رقم ضريبي — لا يمكن إصدار فاتورة ضريبية مبسطة بدونه.');
  }

  const items = await many<{
    name_ar: string; quantity: string; unit_price: string;
    line_total: string; discount_amount: string;
  }>(
    `SELECT p.name_ar, oi.quantity, oi.unit_price, oi.line_total,
            COALESCE(oi.discount_amount, 0) AS discount_amount
       FROM order_items oi JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1 AND oi.status <> 'voided'
      ORDER BY oi.created_at`,
    [orderId], client,
  );
  if (items.length === 0) throw badRequest('لا أصناف في الطلب — لا شيء لفوترته.');

  const vatPercent = Number(branch.vat_percent);
  const vatAmount = Number(order.vat_amount);
  const subtotal = Number(order.subtotal);
  const discountTotal = Number(order.discount_total) + Number(order.points_discount_total);

  // Spread the invoice-level VAT across lines so the parts sum to the whole.
  // Rounding each line independently drifts by a halala or two on a long bill,
  // and ZATCA rejects an invoice whose lines do not add up to its total.
  const lineNet = items.map((i) => Number(i.line_total) - Number(i.discount_amount));
  const netTotal = lineNet.reduce((a, b) => a + b, 0);
  let vatAssigned = 0;
  const lines: InvoiceLineInput[] = items.map((item, index) => {
    const net = lineNet[index]!;
    const isLast = index === items.length - 1;
    const share = isLast
      ? vatAmount - vatAssigned
      : netTotal > 0 ? Math.round((vatAmount * net) / netTotal) : 0;
    vatAssigned += share;
    return {
      index: index + 1,
      nameAr: item.name_ar,
      quantity: Number(item.quantity),
      unitPrice: Number(item.unit_price),
      lineTotal: net,
      vatAmount: share,
      discount: Number(item.discount_amount),
    };
  });

  const method = await one<{ method: string }>(
    `SELECT method FROM payments WHERE order_id = $1 AND status = 'captured'
      ORDER BY created_at LIMIT 1`,
    [orderId], client,
  );

  const customer = order.customer_id
    ? await one<{ full_name: string | null }>(
      'SELECT full_name FROM customers WHERE id = $1', [order.customer_id], client)
    : null;

  const { icv, pih } = await allocateChainLink(order.branch_id, client);
  const creds = await credentials(order.branch_id, client);
  const privateKeyPem = decryptSecret(creds.private_key_enc);

  const issuedAt = new Date();
  const uuid = randomUUID();

  const input: InvoiceInput = {
    invoiceNumber: order.order_number,
    uuid,
    issuedAt,
    documentType: 'invoice',
    icv,
    pih,
    vatPercent,
    seller: {
      nameAr: branch.name_ar, vatNumber: branch.vat_number, address: branch.address,
    },
    buyer: customer?.full_name ? { name: customer.full_name } : null,
    subtotal,
    discountTotal,
    vatAmount,
    grandTotal: Number(order.grand_total),
    paymentMeansCode: PAYMENT_MEANS[method?.method ?? 'cash'] ?? '10',
    lines,
  };

  const canonical = canonicalInvoiceXml(input);
  const hash = invoiceHash(canonical);
  const signature = stamp(privateKeyPem, canonical);
  const publicKey = publicKeyDerFromPrivate(privateKeyPem);

  const qr = encodeQr({
    sellerName: branch.name_ar,
    vatNumber: branch.vat_number,
    timestamp: issuedAt.toISOString().replace(/\.\d{3}/, ''),
    totalWithVat: halalasToRiyalString(Number(order.grand_total)),
    vatTotal: halalasToRiyalString(vatAmount),
    invoiceHash: hash,
    signature,
    publicKey,
    certificateSignature: certificateSignature(creds.certificate),
  });

  const xml = signedInvoiceXml(canonical, {
    invoiceHash: hash,
    signature: signature.toString('base64'),
    publicKeyDer: publicKey.toString('base64'),
    certificate: creds.certificate,
    signedAt: issuedAt,
  });

  const row = await one<{ id: string }>(
    `INSERT INTO invoices (
       branch_id, order_id, invoice_uuid, invoice_number, icv, pih, invoice_hash,
       document_type, subtotal, discount_total, vat_amount, grand_total, vat_percent,
       xml, qr_tlv, signature, issued_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'invoice',$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING id`,
    [
      order.branch_id, orderId, uuid, order.order_number, icv, pih, hash,
      subtotal, discountTotal, vatAmount, Number(order.grand_total), vatPercent,
      xml, qr, signature.toString('base64'), issuedAt,
    ],
    client,
  ).catch((err: { code?: string }) => {
    // Two tills raced to invoice the same order. The other one won; its
    // invoice is the valid one.
    if (err.code === '23505') throw conflict('صدرت فاتورة لهذا الطلب بالفعل');
    throw err;
  });

  // Advance the chain only after the invoice is safely written, so a failure
  // above cannot leave a counter pointing at an invoice that does not exist.
  await client.query(
    'UPDATE invoice_counters SET last_icv = $2, last_hash = $3, updated_at = now() WHERE branch_id = $1',
    [order.branch_id, icv, hash],
  );

  return {
    id: row!.id, invoiceNumber: order.order_number, uuid, icv,
    invoiceHash: hash, qr, grandTotal: Number(order.grand_total),
    vatAmount, issuedAt,
  };
}

async function loadInvoice(id: string, client: PoolClient): Promise<IssuedInvoice> {
  const row = await one<{
    id: string; invoice_number: string; invoice_uuid: string; icv: string;
    invoice_hash: string; qr_tlv: string; grand_total: string; vat_amount: string;
    issued_at: Date;
  }>('SELECT * FROM invoices WHERE id = $1', [id], client);
  return {
    id: row!.id, invoiceNumber: row!.invoice_number, uuid: row!.invoice_uuid,
    icv: Number(row!.icv), invoiceHash: row!.invoice_hash, qr: row!.qr_tlv,
    grandTotal: Number(row!.grand_total), vatAmount: Number(row!.vat_amount),
    issuedAt: row!.issued_at,
  };
}

/**
 * Set up a branch's stamping identity. Generates the key pair here so the
 * private key never travels; returns the CSR to submit to ZATCA.
 */
export async function provisionCredentials(
  principal: Principal, branchId: string,
  input: { environment: 'sandbox' | 'simulation' | 'production' },
): Promise<{ publicKeyDer: string; environment: string }> {
  assertBranchAccess(principal, branchId);

  const existing = await one<{ id: string }>(
    'SELECT id FROM zatca_credentials WHERE branch_id = $1', [branchId],
  );
  if (existing) {
    throw conflict('بيانات الاعتماد مهيّأة لهذا الفرع — لا تُستبدل إلا بتدوير مقصود.');
  }

  const pair = generateStampKeyPair();
  await one(
    `INSERT INTO zatca_credentials
       (branch_id, environment, private_key_enc, public_key_der, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [branchId, input.environment, encryptSecret(pair.privateKeyPem), pair.publicKeyDer,
     principal.userId],
  );

  await audit({
    action: AUDIT.ZATCA_PROVISIONED, actorUserId: principal.userId,
    actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
    branchId, entityType: 'zatca_credentials', entityId: branchId,
    newValue: { environment: input.environment },
  });

  return { publicKeyDer: pair.publicKeyDer, environment: input.environment };
}

/** Store the certificate ZATCA returns for the submitted CSR. */
export async function storeCertificate(
  principal: Principal, branchId: string,
  input: { certificate: string; secret?: string | null; isProduction: boolean },
): Promise<void> {
  assertBranchAccess(principal, branchId);
  const updated = await one<{ id: string }>(
    `UPDATE zatca_credentials
        SET certificate = $2, secret = $3, is_production = $4,
            onboarded_at = now(), updated_at = now()
      WHERE branch_id = $1 RETURNING id`,
    [branchId, input.certificate, input.secret ?? null, input.isProduction],
  );
  if (!updated) throw notFound('لا توجد بيانات اعتماد لهذا الفرع');

  await audit({
    action: AUDIT.ZATCA_CERTIFICATE_STORED, actorUserId: principal.userId,
    actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
    branchId, entityType: 'zatca_credentials', entityId: branchId,
    newValue: { isProduction: input.isProduction },
  });
}

export async function listInvoices(
  principal: Principal, branchId: string,
  filters: { from?: string; to?: string; status?: string; limit: number },
) {
  assertBranchAccess(principal, branchId);
  return many(
    `SELECT id, invoice_number, invoice_uuid, icv, document_type, grand_total,
            vat_amount, issued_at, report_status, reported_at, report_attempts,
            last_error
       FROM invoices
      WHERE branch_id = $1
        AND ($2::timestamptz IS NULL OR issued_at >= $2)
        AND ($3::timestamptz IS NULL OR issued_at < $3)
        AND ($4::text IS NULL OR report_status = $4)
      ORDER BY icv DESC
      LIMIT $5`,
    [branchId, filters.from ?? null, filters.to ?? null, filters.status ?? null, filters.limit],
  );
}

export async function getInvoice(principal: Principal, id: string) {
  const row = await one<any>('SELECT * FROM invoices WHERE id = $1', [id]);
  if (!row) throw notFound('الفاتورة غير موجودة');
  assertBranchAccess(principal, row.branch_id);
  return row;
}

/**
 * Walk the chain and prove it is intact: every invoice's PIH must equal the
 * hash of the one before it, and the counter must step by exactly one. This is
 * what an auditor asks for, and what catches a restore from a stale backup.
 */
export async function verifyChain(
  principal: Principal, branchId: string,
): Promise<{ checked: number; breaks: Array<{ icv: number; problem: string }> }> {
  assertBranchAccess(principal, branchId);
  const rows = await many<{ icv: string; pih: string; invoice_hash: string; invoice_number: string }>(
    'SELECT icv, pih, invoice_hash, invoice_number FROM invoices WHERE branch_id = $1 ORDER BY icv',
    [branchId],
  );

  const GENESIS = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';
  const breaks: Array<{ icv: number; problem: string }> = [];
  let expectedIcv = 1;
  let expectedPih = GENESIS;

  for (const row of rows) {
    const icv = Number(row.icv);
    if (icv !== expectedIcv) {
      breaks.push({ icv, problem: `العدّاد قفز — المتوقع ${expectedIcv}` });
    }
    if (row.pih !== expectedPih) {
      breaks.push({ icv, problem: `الفاتورة ${row.invoice_number} لا تتسلسل مع سابقتها` });
    }
    expectedIcv = icv + 1;
    expectedPih = row.invoice_hash;
  }

  return { checked: rows.length, breaks };
}

/**
 * Report queued invoices to ZATCA. Called by the cron job, and by an operator
 * from the invoices screen when they want to flush the queue now.
 *
 * Failures are recorded and retried rather than thrown: one rejected invoice
 * must not stop the rest of the day's batch from being reported.
 */
export async function reportPending(
  branchId: string, limit = 50,
): Promise<{ attempted: number; reported: number; failed: number }> {
  const pending = await many<{ id: string; xml: string; invoice_hash: string; invoice_uuid: string }>(
    `SELECT id, xml, invoice_hash, invoice_uuid FROM invoices
      WHERE branch_id = $1 AND report_status IN ('pending','failed')
        AND report_attempts < 10
      ORDER BY icv LIMIT $2`,
    [branchId, limit],
  );

  const creds = await one<{ certificate: string | null; secret: string | null; environment: string; is_production: boolean }>(
    'SELECT certificate, secret, environment, is_production FROM zatca_credentials WHERE branch_id = $1',
    [branchId],
  );

  let reported = 0;
  let failed = 0;

  for (const invoice of pending) {
    try {
      // Without a CSID there is nobody to report to, and pretending otherwise
      // would mark invoices as reported when they are not — the one outcome an
      // auditor cannot recover from.
      if (!creds?.certificate || !creds.secret) {
        throw new Error('لم تُستكمل تهيئة ZATCA — لا شهادة CSID لهذا الفرع');
      }
      const result = await submitToZatca(creds, invoice);
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE invoices
              SET report_status = $2, zatca_status = $3, zatca_response = $4,
                  reported_at = now(), report_attempts = report_attempts + 1,
                  last_error = NULL
            WHERE id = $1`,
          [invoice.id, result.warning ? 'warning' : 'reported',
           result.status, JSON.stringify(result.body)],
        );
      });
      reported += 1;
    } catch (err) {
      failed += 1;
      await one(
        `UPDATE invoices
            SET report_status = 'failed', report_attempts = report_attempts + 1,
                last_error = $2
          WHERE id = $1 RETURNING id`,
        [invoice.id, err instanceof Error ? err.message : String(err)],
      );
    }
  }

  return { attempted: pending.length, reported, failed };
}

const ZATCA_HOSTS: Record<string, string> = {
  sandbox: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
  simulation: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
  production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core',
};

async function submitToZatca(
  creds: { certificate: string | null; secret: string | null; environment: string },
  invoice: { xml: string; invoice_hash: string; invoice_uuid: string },
): Promise<{ status: string; warning: boolean; body: unknown }> {
  const base = ZATCA_HOSTS[creds.environment] ?? ZATCA_HOSTS.sandbox!;
  const auth = Buffer.from(`${creds.certificate}:${creds.secret}`).toString('base64');

  const res = await fetch(`${base}/invoices/reporting/single`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Version': 'V2',
      'Accept-Language': 'en',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      invoiceHash: invoice.invoice_hash,
      uuid: invoice.invoice_uuid,
      invoice: Buffer.from(invoice.xml, 'utf8').toString('base64'),
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`ZATCA ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  const status = (body as { reportingStatus?: string }).reportingStatus ?? 'REPORTED';
  return { status, warning: status !== 'REPORTED', body };
}
