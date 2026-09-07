/**
 * Just enough DER to build a certificate request by hand.
 *
 * ZATCA wants a PKCS#10 CSR carrying extensions that no Node API emits: a
 * certificate-template name and a subjectAltName whose directoryName holds the
 * EGS unit's serial, the VAT number and the invoice-type flags. There is no
 * ASN.1 dependency in this project, and adding one to write four structures is
 * a poor trade — so the encoder lives here, small and tested.
 *
 * Every function returns bytes, never a string. DER is a byte format, and the
 * one reliable way to get it wrong is to pass it through a string somewhere.
 */

/** DER length: short form under 128, long form above. */
function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(value.length), value]);
}

export const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
export const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));

export const integer = (n: number): Buffer => {
  if (n === 0) return tlv(0x02, Buffer.from([0]));
  const bytes: number[] = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
  // A leading bit of 1 would read as negative, so pad.
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
};

export const utf8String = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'));
export const printableString = (s: string): Buffer => tlv(0x13, Buffer.from(s, 'ascii'));
export const ia5String = (s: string): Buffer => tlv(0x16, Buffer.from(s, 'ascii'));
export const octetString = (b: Buffer): Buffer => tlv(0x04, b);
export const boolean = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));

/** A BIT STRING's first content byte counts the unused trailing bits. */
export const bitString = (b: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));

/** Context-specific constructed tag, e.g. [0] on CSR attributes. */
export const context = (n: number, value: Buffer): Buffer => tlv(0xa0 | n, value);

/**
 * OID: first two arcs pack into one byte, the rest are base-128 with the
 * continuation bit set on every byte but the last.
 */
export function oid(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number);
  const bytes: number[] = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const chunk: number[] = [arc & 0x7f];
    let v = arc >> 7;
    while (v > 0) { chunk.unshift((v & 0x7f) | 0x80); v >>= 7; }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** One RDN: SET { SEQUENCE { type, value } } — the shape a Name is built from. */
export function rdn(typeOid: string, value: Buffer): Buffer {
  return set(sequence(oid(typeOid), value));
}
