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
import { createHash, randomUUID } from 'node:crypto';
import { many, one, pool, withTransaction } from '../../core/db.js';
import { decryptSecret, encryptSecret } from '../../core/crypto.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { AUDIT, audit } from '../../core/audit.js';
import type { Principal } from '../../core/principal.js';
import { assertBranchAccess } from '../../core/principal.js';
import type { Device } from '../devices/devices.service.js';
import { canonicalInvoiceXml, signedInvoiceXml } from '../../core/zatca/xml.js';
import type { InvoiceInput, InvoiceLineInput } from '../../core/zatca/xml.js';
import {
  certificateSignature, generateStampKeyPair, invoiceHash, publicKeyDerFromPrivate, stamp,
} from '../../core/zatca/sign.js';
import { buildCsr, egsSerial, pemBody, type EgsUnit } from '../../core/zatca/csr.js';
import {
  certificateExpiry, requestComplianceCsid, requestProductionCsid,
  type ZatcaEnvironment,
} from '../../core/zatca/onboarding.js';
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
  device: Device, client: PoolClient,
): Promise<{ icv: number; pih: string }> {
  await client.query(
    `INSERT INTO invoice_counters (device_id, branch_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [device.id, device.branchId],
  );
  const counter = await one<{ last_icv: string; last_hash: string }>(
    'SELECT last_icv, last_hash FROM invoice_counters WHERE device_id = $1 FOR UPDATE',
    [device.id], client,
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
async function credentials(device: Device, client: PoolClient): Promise<CredentialRow> {
  const row = await one<CredentialRow>(
    `SELECT private_key_enc, certificate, is_production
       FROM zatca_credentials WHERE device_id = $1`,
    [device.id], client,
  );
  if (!row) {
    throw badRequest(
      `«${device.label}» غير مهيّأ للفوترة الإلكترونية — `
      + 'ابدأ تسجيل الجهاز لدى الهيئة من شاشة الأجهزة قبل الافتتاح.',
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
  orderId: string, device: Device, client: PoolClient,
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

  const { icv, pih } = await allocateChainLink(device, client);
  const creds = await credentials(device, client);
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
       branch_id, device_id, order_id, invoice_uuid, invoice_number, icv, pih,
       invoice_hash, document_type, subtotal, discount_total, vat_amount,
       grand_total, vat_percent, xml, qr_tlv, signature, issued_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'invoice',$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [
      order.branch_id, device.id, orderId, uuid, order.order_number, icv, pih, hash,
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
    'UPDATE invoice_counters SET last_icv = $2, last_hash = $3, updated_at = now() WHERE device_id = $1',
    [device.id, icv, hash],
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
 * Step 0 of onboarding: give the device a key and a certificate request.
 *
 * The key is generated here and never leaves — what travels is a CSR, which is
 * a public description of the device signed by the key it describes. Whoever
 * holds the private key can stamp invoices in this branch's name, so there is
 * no endpoint that returns it, by design.
 */
export async function provisionCredentials(
  principal: Principal, deviceId: string,
  input: { environment: 'sandbox' | 'simulation' | 'production' },
): Promise<{ csr: string; egsSerial: string; environment: string }> {
  const device = await one<{
    branch_id: string; kind: string; label: string; serial_number: string;
  }>(
    'SELECT branch_id, kind, label, serial_number FROM devices WHERE id = $1 AND deleted_at IS NULL',
    [deviceId],
  );
  if (!device) throw notFound('الجهاز غير موجود');
  assertBranchAccess(principal, device.branch_id);

  // Only a device that issues invoices is an EGS unit. Registering a waiter's
  // tablet with ZATCA would be registering a machine that never invoices.
  if (device.kind !== 'cashier') {
    throw badRequest(
      `«${device.label}» ليس جهاز كاشير — الهيئة تُصدر شهادة لأجهزة إصدار الفواتير فقط.`,
    );
  }

  const branch = await one<{
    name: string; name_ar: string; vat_number: string | null; address: string | null;
  }>(
    'SELECT name, name_ar, vat_number, address FROM branches WHERE id = $1',
    [device.branch_id],
  );
  if (!branch?.vat_number) {
    throw badRequest('الفرع بلا رقم ضريبي — أضفه قبل تسجيل الجهاز لدى الهيئة.');
  }

  const existing = await one<{ id: string; private_key_enc: string; onboarding_step: string }>(
    'SELECT id, private_key_enc, onboarding_step FROM zatca_credentials WHERE device_id = $1',
    [deviceId],
  );
  // Re-issuing a CSR before onboarding finishes is normal (a mistyped OTP, an
  // expired one). Re-keying a device that already has a production CSID is not:
  // it would orphan every invoice already stamped with the old key.
  if (existing && existing.onboarding_step === 'production') {
    throw conflict(
      'هذا الجهاز يحمل شهادة إنتاجية — التجديد يتم بـ renew لا بإنشاء مفتاح جديد.',
    );
  }

  const pair = existing
    ? { privateKeyPem: decryptSecret(existing.private_key_enc),
        publicKeyDer: publicKeyDerFromPrivate(decryptSecret(existing.private_key_enc)).toString('base64') }
    : generateStampKeyPair();

  const unit: EgsUnit = {
    environment: input.environment,
    commonName: `${branch.name}-${device.serial_number}`,
    vatNumber: branch.vat_number,
    organizationName: branch.name,
    branchName: branch.name_ar,
    registeredAddress: branch.address ?? 'Riyadh',
    businessCategory: 'Restaurant',
    serialNumber: device.serial_number,
  };
  const csr = buildCsr(pair.privateKeyPem, unit);
  const serial = egsSerial(unit);

  if (existing) {
    await pool.query(
      `UPDATE zatca_credentials
          SET environment = $2, csr = $3, egs_serial = $4, onboarding_step = 'csr',
              updated_at = now()
        WHERE device_id = $1`,
      [deviceId, input.environment, csr, serial],
    );
  } else {
    await pool.query(
      `INSERT INTO zatca_credentials
         (branch_id, device_id, environment, private_key_enc, public_key_der,
          csr, egs_serial, onboarding_step, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'csr',$8)`,
      [device.branch_id, deviceId, input.environment,
       encryptSecret(pair.privateKeyPem), pair.publicKeyDer, csr, serial,
       principal.userId],
    );
  }

  await audit({
    action: AUDIT.ZATCA_PROVISIONED, actorUserId: principal.userId,
    actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
    branchId: device.branch_id, entityType: 'device', entityId: deviceId,
    newValue: { environment: input.environment, egsSerial: serial },
  });

  return { csr, egsSerial: serial, environment: input.environment };
}

/**
 * Steps 1 and 3, driven end to end.
 *
 * The OTP comes from the taxpayer's Fatoora portal and lives for minutes — it
 * is the human's proof that this device is theirs to register, so it is passed
 * straight through and never stored.
 */
export async function onboardDevice(
  principal: Principal, deviceId: string, otp: string,
): Promise<{ step: string; isProduction: boolean; expiresAt: Date | null }> {
  const row = await one<{
    branch_id: string; label: string; environment: ZatcaEnvironment; csr: string | null;
  }>(
    `SELECT d.branch_id, d.label, z.environment, z.csr
       FROM devices d JOIN zatca_credentials z ON z.device_id = d.id
      WHERE d.id = $1`,
    [deviceId],
  );
  if (!row) throw notFound('لم يُنشأ طلب شهادة لهذا الجهاز بعد');
  assertBranchAccess(principal, row.branch_id);
  if (!row.csr) throw badRequest('لا يوجد CSR — أنشئه أولاً');

  const compliance = await requestComplianceCsid(row.environment, pemBody(row.csr), otp);
  await pool.query(
    `UPDATE zatca_credentials
        SET compliance_certificate = $2, compliance_secret = $3,
            compliance_request_id = $4, onboarding_step = 'compliance',
            updated_at = now()
      WHERE device_id = $1`,
    [deviceId, compliance.certificate, compliance.secret, compliance.requestId],
  );

  // The production CSID is only issued for a request whose compliance checks
  // passed, so a failure here is ZATCA saying the device is not ready — not a
  // transport problem to retry blindly.
  const production = await requestProductionCsid(
    row.environment,
    { certificate: compliance.certificate, secret: compliance.secret },
    compliance.requestId,
  );

  const expiresAt = certificateExpiry(production.certificate);
  await pool.query(
    `UPDATE zatca_credentials
        SET certificate = $2, secret = $3, is_production = TRUE,
            onboarding_step = 'production', onboarded_at = now(),
            expires_at = $4, updated_at = now()
      WHERE device_id = $1`,
    [deviceId, production.certificate, production.secret, expiresAt],
  );

  await audit({
    action: AUDIT.ZATCA_CERTIFICATE_STORED, actorUserId: principal.userId,
    actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
    branchId: row.branch_id, entityType: 'device', entityId: deviceId,
    newValue: {
      device: row.label, environment: row.environment,
      expiresAt: expiresAt?.toISOString() ?? null,
    },
  });

  return { step: 'production', isProduction: true, expiresAt };
}

/**
 * Store a CSID obtained by hand.
 *
 * Kept for the case the automated flow cannot cover — a portal that issued the
 * certificate out of band, or an environment this server cannot reach.
 */
export async function storeCertificate(
  principal: Principal, deviceId: string,
  input: { certificate: string; secret?: string | null; isProduction: boolean },
): Promise<void> {
  const device = await one<{ branch_id: string }>(
    'SELECT branch_id FROM devices WHERE id = $1', [deviceId],
  );
  if (!device) throw notFound('الجهاز غير موجود');
  assertBranchAccess(principal, device.branch_id);

  const updated = await one<{ id: string }>(
    `UPDATE zatca_credentials
        SET certificate = $2, secret = $3, is_production = $4,
            onboarding_step = CASE WHEN $4 THEN 'production' ELSE 'compliance' END,
            expires_at = $5, onboarded_at = now(), updated_at = now()
      WHERE device_id = $1 RETURNING id`,
    [deviceId, input.certificate, input.secret ?? null, input.isProduction,
     certificateExpiry(input.certificate)],
  );
  if (!updated) throw notFound('لا توجد بيانات اعتماد لهذا الجهاز');

  await audit({
    action: AUDIT.ZATCA_CERTIFICATE_STORED, actorUserId: principal.userId,
    actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
    branchId: device.branch_id, entityType: 'device', entityId: deviceId,
    newValue: { isProduction: input.isProduction, manual: true },
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
): Promise<{
  checked: number;
  breaks: Array<{ icv: number; device: string; problem: string }>;
  devices: Array<{ device: string; invoices: number; lastIcv: number }>;
}> {
  assertBranchAccess(principal, branchId);

  // Per device, because each EGS unit keeps its own counter. Two tills in one
  // branch legitimately produce 1,1,2,2 — reading that as a branch-wide
  // sequence would report breaks that are not there.
  const rows = await many<{
    device_id: string; device_label: string; icv: string; pih: string;
    invoice_hash: string; invoice_number: string;
  }>(
    `SELECT i.device_id, d.label AS device_label, i.icv, i.pih,
            i.invoice_hash, i.invoice_number
       FROM invoices i JOIN devices d ON d.id = i.device_id
      WHERE i.branch_id = $1
      ORDER BY i.device_id, i.icv`,
    [branchId],
  );

  const breaks: Array<{ icv: number; device: string; problem: string }> = [];
  const perDevice = new Map<string, { device: string; invoices: number; lastIcv: number }>();

  let currentDevice: string | null = null;
  let expectedIcv = 1;
  let expectedPih = GENESIS_PIH;

  for (const row of rows) {
    if (row.device_id !== currentDevice) {
      currentDevice = row.device_id;
      expectedIcv = 1;
      expectedPih = GENESIS_PIH;
    }
    const icv = Number(row.icv);
    if (icv !== expectedIcv) {
      breaks.push({
        icv, device: row.device_label,
        problem: `العدّاد قفز — المتوقع ${expectedIcv}`,
      });
    }
    if (row.pih !== expectedPih) {
      breaks.push({
        icv, device: row.device_label,
        problem: `الفاتورة ${row.invoice_number} لا تتسلسل مع سابقتها`,
      });
    }
    expectedIcv = icv + 1;
    expectedPih = row.invoice_hash;

    const entry = perDevice.get(row.device_id)
      ?? { device: row.device_label, invoices: 0, lastIcv: 0 };
    entry.invoices += 1;
    entry.lastIcv = Math.max(entry.lastIcv, icv);
    perDevice.set(row.device_id, entry);
  }

  return { checked: rows.length, breaks, devices: [...perDevice.values()] };
}

/**
 * ZATCA's mandated first PIH. Derived rather than pasted: it is base64 of the
 * SHA-256 HEX STRING of "0" — not of the raw digest, which is the mistake that
 * produces a chain every invoice validates against and the authority rejects.
 */
export const GENESIS_PIH = Buffer.from(
  createHash('sha256').update('0').digest('hex'), 'utf8',
).toString('base64');

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
  const pending = await many<{
    id: string; xml: string; invoice_hash: string; invoice_uuid: string; device_id: string;
  }>(
    `SELECT id, xml, invoice_hash, invoice_uuid, device_id FROM invoices
      WHERE branch_id = $1 AND report_status IN ('pending','failed')
        AND report_attempts < 10
      ORDER BY device_id, icv LIMIT $2`,
    [branchId, limit],
  );

  // Per device: credentials belong to the EGS unit, and one till whose CSID has
  // lapsed must not stall the other till's queue.
  const credentialRows = await many<{
    device_id: string; certificate: string | null; secret: string | null;
    environment: string; is_production: boolean; label: string;
  }>(
    `SELECT z.device_id, z.certificate, z.secret, z.environment, z.is_production,
            d.label
       FROM zatca_credentials z JOIN devices d ON d.id = z.device_id
      WHERE d.branch_id = $1`,
    [branchId],
  );
  const byDevice = new Map(credentialRows.map((c) => [c.device_id, c]));

  let reported = 0;
  let failed = 0;

  for (const invoice of pending) {
    try {
      const creds = byDevice.get(invoice.device_id);
      // Without a CSID there is nobody to report to, and pretending otherwise
      // would mark invoices as reported when they are not — the one outcome an
      // auditor cannot recover from.
      if (!creds?.certificate || !creds.secret) {
        throw new Error(
          `لم تُستكمل تهيئة ZATCA للجهاز ${creds?.label ?? ''} — لا شهادة CSID`,
        );
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
