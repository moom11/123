/**
 * secp256k1 keys, encoded and parsed without node:crypto.
 *
 * ZATCA specifies secp256k1, and WebCrypto does not offer it — so a Worker
 * cannot use SubtleCrypto to sign an invoice, and node:crypto does not exist
 * there either. This module is what lets one implementation serve both
 * runtimes: pure arithmetic from @noble/curves, and DER assembled by hand.
 *
 * The encodings are byte-identical to what Node's own exporter produces, which
 * is not a nicety: keys already stored by a Node deployment must keep working
 * after a move to Workers, and a certificate ZATCA issued for a key must still
 * match that key. The structures below were read off Node's output rather than
 * written from the RFC and hoped for.
 *
 *   PKCS#8   SEQUENCE { INTEGER 0, AlgorithmIdentifier, OCTET STRING { SEC1 } }
 *   SEC1     SEQUENCE { INTEGER 1, OCTET STRING scalar, [1] BIT STRING point }
 *   SPKI     SEQUENCE { AlgorithmIdentifier, BIT STRING point }
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bitString, context, integer, octetString, oid, sequence } from './der.js';

const ID_EC_PUBLIC_KEY = '1.2.840.10045.2.1';
const SECP256K1 = '1.3.132.0.10';

const algorithmIdentifier = (): Buffer =>
  sequence(oid(ID_EC_PUBLIC_KEY), oid(SECP256K1));

/** Uncompressed point: 0x04 || X || Y, 65 bytes. */
export function publicPoint(scalar: Buffer): Buffer {
  return Buffer.from(secp256k1.getPublicKey(scalar, false));
}

export function encodeSpki(scalar: Buffer): Buffer {
  return sequence(algorithmIdentifier(), bitString(publicPoint(scalar)));
}

export function encodePkcs8(scalar: Buffer): Buffer {
  const sec1 = sequence(
    integer(1),
    octetString(scalar),
    context(1, bitString(publicPoint(scalar))),
  );
  return sequence(integer(0), algorithmIdentifier(), octetString(sec1));
}

// --- Parsing -----------------------------------------------------------------

/** Walk one TLV, returning its contents and the offset just past it. */
function readTlv(der: Buffer, at: number): { tag: number; value: Buffer; next: number } {
  const tag = der[at]!;
  let i = at + 1;
  const first = der[i++]!;
  let length = first;
  if (first >= 0x80) {
    const count = first & 0x7f;
    length = 0;
    for (let n = 0; n < count; n += 1) length = (length << 8) | der[i++]!;
  }
  return { tag, value: der.subarray(i, i + length), next: i + length };
}

/**
 * The 32-byte scalar out of a PKCS#8 key.
 *
 * Walks the structure rather than slicing at a fixed offset: the length of the
 * outer SEQUENCE crosses the 128-byte boundary, so its header is two bytes for
 * some keys and three for others, and a hardcoded offset silently reads the
 * wrong 32 bytes for a fraction of generated keys.
 */
export function scalarFromPkcs8(der: Buffer): Buffer {
  const outer = readTlv(der, 0);
  if (outer.tag !== 0x30) throw new Error('PKCS#8 غير صالح');

  let at = 0;
  const version = readTlv(outer.value, at); at = version.next;
  const algorithm = readTlv(outer.value, at); at = algorithm.next;
  const wrapped = readTlv(outer.value, at);
  if (wrapped.tag !== 0x04) throw new Error('PKCS#8: لا يحتوي مفتاحاً خاصاً');

  const sec1 = readTlv(wrapped.value, 0);
  if (sec1.tag !== 0x30) throw new Error('SEC1 غير صالح');
  let inner = 0;
  const sec1Version = readTlv(sec1.value, inner); inner = sec1Version.next;
  const key = readTlv(sec1.value, inner);
  if (key.tag !== 0x04 || key.value.length !== 32) {
    throw new Error('SEC1: المفتاح الخاص ليس 32 بايت');
  }
  return Buffer.from(key.value);
}

/** The uncompressed point out of an SPKI structure. */
export function pointFromSpki(der: Buffer): Buffer {
  const outer = readTlv(der, 0);
  let at = 0;
  const algorithm = readTlv(outer.value, at); at = algorithm.next;
  const bits = readTlv(outer.value, at);
  if (bits.tag !== 0x03) throw new Error('SPKI: لا يحتوي مفتاحاً عاماً');
  // First content byte counts unused bits and is always zero here.
  return Buffer.from(bits.value.subarray(1));
}

// --- PEM ---------------------------------------------------------------------

export function toPem(der: Buffer, label: string): string {
  const body = der.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

export function fromPem(pem: string): Buffer {
  return Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
}
