/**
 * The QR code printed on every simplified tax invoice.
 *
 * ZATCA does not want a link or a JSON blob — it wants TLV: a flat sequence of
 * (tag, length, value) triples, base64 encoded. A phase-two simplified invoice
 * carries nine tags, and an inspector's app reads them straight off the paper
 * without contacting anyone. That is the point: the receipt in the customer's
 * hand is self-verifying.
 *
 * Tags 1-5 are text. Tags 6-9 are the cryptographic evidence, and 7-9 are raw
 * bytes rather than base64 text — encoding them as strings produces a QR that
 * scans, parses, and fails validation, which is the worst possible outcome
 * because nothing looks wrong until ZATCA rejects the batch.
 */

/** Length is a single byte, so no field may exceed 255 bytes. */
const MAX_VALUE_BYTES = 255;

export interface QrFields {
  sellerName: string;
  vatNumber: string;
  /** ISO 8601 in UTC, e.g. 2026-09-04T12:30:00Z */
  timestamp: string;
  /** Riyals with two decimals, as a string — never a float. */
  totalWithVat: string;
  vatTotal: string;
  /** base64 SHA-256 of the canonical XML */
  invoiceHash: string;
  /** raw ECDSA signature bytes */
  signature: Buffer;
  /** raw public key bytes (SubjectPublicKeyInfo) */
  publicKey: Buffer;
  /**
   * The certificate's own signature. Absent before a CSID has been issued,
   * which is the normal state in sandbox — the tag is then omitted rather than
   * padded with zeros, because a wrong value is worse than a missing one.
   */
  certificateSignature?: Buffer;
}

function field(tag: number, value: Buffer): Buffer {
  if (value.length > MAX_VALUE_BYTES) {
    throw new Error(`قيمة الوسم ${tag} أطول من ${MAX_VALUE_BYTES} بايت (${value.length})`);
  }
  return Buffer.concat([Buffer.from([tag, value.length]), value]);
}

const text = (tag: number, value: string): Buffer =>
  field(tag, Buffer.from(value, 'utf8'));

/** The base64 payload that goes into the QR module of the receipt. */
export function encodeQr(fields: QrFields): string {
  const parts = [
    text(1, fields.sellerName),
    text(2, fields.vatNumber),
    text(3, fields.timestamp),
    text(4, fields.totalWithVat),
    text(5, fields.vatTotal),
    text(6, fields.invoiceHash),
    field(7, fields.signature),
    field(8, fields.publicKey),
  ];
  if (fields.certificateSignature) {
    parts.push(field(9, fields.certificateSignature));
  }
  return Buffer.concat(parts).toString('base64');
}

export interface DecodedTag { tag: number; value: Buffer }

/**
 * Read a TLV payload back. Used by the tests to prove what was encoded, and by
 * the admin screen to show an operator what an inspector's scanner will see.
 */
export function decodeQr(base64: string): DecodedTag[] {
  const buf = Buffer.from(base64, 'base64');
  const out: DecodedTag[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 2 > buf.length) throw new Error('حمولة TLV مبتورة');
    const tag = buf[i]!;
    const length = buf[i + 1]!;
    const start = i + 2;
    if (start + length > buf.length) throw new Error(`الوسم ${tag} يتجاوز نهاية الحمولة`);
    out.push({ tag, value: buf.subarray(start, start + length) });
    i = start + length;
  }
  return out;
}

/** Halalas to the two-decimal riyal string ZATCA expects. Never a float. */
export function halalasToRiyalString(halalas: number): string {
  const sign = halalas < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(halalas));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
