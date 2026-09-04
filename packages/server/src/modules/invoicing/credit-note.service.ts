/**
 * Credit notes.
 *
 * A settled invoice is never edited and never deleted — the same rule that
 * governs every other financial record here, and additionally what ZATCA
 * requires. A refund, a void after payment, or a corrected total is issued as
 * a credit note that references the original and takes its own place in the
 * chain.
 *
 * The note reverses the whole invoice. A partial correction is a full reversal
 * followed by a new invoice, which is what the tax authority expects and what
 * keeps the arithmetic reconcilable.
 */
import { randomUUID } from 'node:crypto';
import { one, withTransaction } from '../../core/db.js';
import { decryptSecret } from '../../core/crypto.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { AUDIT, audit } from '../../core/audit.js';
import type { Principal } from '../../core/principal.js';
import { assertBranchAccess } from '../../core/principal.js';
import { canonicalInvoiceXml, signedInvoiceXml } from '../../core/zatca/xml.js';
import {
  certificateSignature, invoiceHash, publicKeyDerFromPrivate, stamp,
} from '../../core/zatca/sign.js';
import { encodeQr, halalasToRiyalString } from '../../core/zatca/tlv.js';

export async function issueCreditNote(
  principal: Principal, invoiceId: string, reason: string,
): Promise<{ id: string; invoiceNumber: string; icv: number; qr: string }> {
  return withTransaction(async (client) => {
    const original = await one<{
      id: string; branch_id: string; order_id: string; invoice_number: string;
      subtotal: string; discount_total: string; vat_amount: string;
      grand_total: string; vat_percent: string;
    }>(
      `SELECT * FROM invoices WHERE id = $1 AND document_type = 'invoice'`,
      [invoiceId], client,
    );
    if (!original) throw notFound('الفاتورة غير موجودة');
    assertBranchAccess(principal, original.branch_id);

    const already = await one<{ id: string }>(
      `SELECT id FROM invoices WHERE reversed_invoice_id = $1 AND document_type = 'credit_note'`,
      [invoiceId], client,
    );
    if (already) throw conflict('صدر إشعار دائن لهذه الفاتورة بالفعل');

    const branch = await one<{ name_ar: string; vat_number: string | null; address: string | null }>(
      'SELECT name_ar, vat_number, address FROM branches WHERE id = $1',
      [original.branch_id], client,
    );
    if (!branch?.vat_number) throw badRequest('الفرع بلا رقم ضريبي');

    const creds = await one<{ private_key_enc: string; certificate: string | null }>(
      'SELECT private_key_enc, certificate FROM zatca_credentials WHERE branch_id = $1',
      [original.branch_id], client,
    );
    if (!creds) throw badRequest('لم تُهيَّأ الفوترة الإلكترونية لهذا الفرع');

    // The note takes the next link in the same chain — it is a document like
    // any other, not an annotation on an existing one.
    await client.query(
      'INSERT INTO invoice_counters (branch_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [original.branch_id],
    );
    const counter = await one<{ last_icv: string; last_hash: string }>(
      'SELECT last_icv, last_hash FROM invoice_counters WHERE branch_id = $1 FOR UPDATE',
      [original.branch_id], client,
    );
    const icv = Number(counter!.last_icv) + 1;
    const pih = counter!.last_hash;

    const issuedAt = new Date();
    const uuid = randomUUID();
    const noteNumber = `CN-${original.invoice_number}`;

    // Every amount is negated: the note is the arithmetic inverse of what it
    // reverses, so the pair sums to zero in any report that adds them up.
    const negate = (v: string) => -Number(v);
    const input = {
      invoiceNumber: noteNumber,
      uuid,
      issuedAt,
      documentType: 'credit_note' as const,
      reversedInvoiceNumber: original.invoice_number,
      reversalReason: reason,
      icv,
      pih,
      vatPercent: Number(original.vat_percent),
      seller: {
        nameAr: branch.name_ar, vatNumber: branch.vat_number, address: branch.address,
      },
      buyer: null,
      subtotal: negate(original.subtotal),
      discountTotal: negate(original.discount_total),
      vatAmount: negate(original.vat_amount),
      grandTotal: negate(original.grand_total),
      paymentMeansCode: '10',
      lines: [{
        index: 1,
        nameAr: `عكس الفاتورة ${original.invoice_number} — ${reason}`,
        quantity: 1,
        unitPrice: negate(original.subtotal),
        lineTotal: negate(original.subtotal) - negate(original.discount_total),
        vatAmount: negate(original.vat_amount),
        discount: 0,
      }],
    };

    const privateKeyPem = decryptSecret(creds.private_key_enc);
    const canonical = canonicalInvoiceXml(input);
    const hash = invoiceHash(canonical);
    const signature = stamp(privateKeyPem, canonical);
    const publicKey = publicKeyDerFromPrivate(privateKeyPem);

    const qr = encodeQr({
      sellerName: branch.name_ar,
      vatNumber: branch.vat_number,
      timestamp: issuedAt.toISOString().replace(/\.\d{3}/, ''),
      totalWithVat: halalasToRiyalString(negate(original.grand_total)),
      vatTotal: halalasToRiyalString(negate(original.vat_amount)),
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
         document_type, reversed_invoice_id, subtotal, discount_total, vat_amount,
         grand_total, vat_percent, xml, qr_tlv, signature, issued_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'credit_note',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id`,
      [
        original.branch_id, original.order_id, uuid, noteNumber, icv, pih, hash,
        original.id, input.subtotal, input.discountTotal, input.vatAmount,
        input.grandTotal, Number(original.vat_percent), xml, qr,
        signature.toString('base64'), issuedAt,
      ],
      client,
    );

    await client.query(
      'UPDATE invoice_counters SET last_icv = $2, last_hash = $3, updated_at = now() WHERE branch_id = $1',
      [original.branch_id, icv, hash],
    );

    await audit({
      action: AUDIT.INVOICE_CREDIT_NOTE, actorUserId: principal.userId,
      actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
      branchId: original.branch_id, entityType: 'invoice', entityId: row!.id,
      newValue: {
        reverses: original.invoice_number, noteNumber, icv,
        amount: input.grandTotal, reason,
      },
    }, client);

    return { id: row!.id, invoiceNumber: noteNumber, icv, qr };
  });
}
