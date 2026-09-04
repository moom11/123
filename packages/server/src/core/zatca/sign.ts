/**
 * The cryptographic stamp.
 *
 * ZATCA specifies ECDSA over secp256k1 with SHA-256 — the Bitcoin curve, not
 * the P-256 that WebCrypto offers. That choice has a consequence worth stating
 * plainly: this module runs on Node, and NOT on Cloudflare Workers, whose
 * WebCrypto has no secp256k1. Invoicing therefore pins the deployment target
 * to a Node host until a pure-JS curve implementation is added here.
 *
 * Keys are generated on the server and never leave it. The private key is
 * stored AES-256-GCM encrypted; whoever holds it can stamp invoices in this
 * branch's name, which is the whole security boundary of e-invoicing.
 */
import { createHash, createPrivateKey, createPublicKey, createSign, generateKeyPairSync } from 'node:crypto';

export interface StampKeyPair {
  /** PKCS#8 PEM — encrypt before storing. */
  privateKeyPem: string;
  /** SubjectPublicKeyInfo DER, base64. Goes into QR tag 8. */
  publicKeyDer: string;
}

export function generateStampKeyPair(): StampKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyDer: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

/** base64 of the raw SHA-256 digest — what ZATCA calls the invoice hash. */
export function invoiceHash(canonicalXml: string): string {
  return createHash('sha256').update(canonicalXml, 'utf8').digest('base64');
}

/**
 * Sign the hash, not the document: ZATCA stamps the digest, so a signature
 * verifies against the same value the QR publishes in tag 6.
 */
export function stamp(privateKeyPem: string, canonicalXml: string): Buffer {
  const key = createPrivateKey(privateKeyPem);
  const signer = createSign('sha256');
  signer.update(canonicalXml, 'utf8');
  signer.end();
  return signer.sign(key);
}

export function publicKeyDerFromPrivate(privateKeyPem: string): Buffer {
  const pub = createPublicKey(createPrivateKey(privateKeyPem));
  return pub.export({ type: 'spki', format: 'der' }) as Buffer;
}

/**
 * The certificate signature for QR tag 9. A real one comes from the CSID ZATCA
 * issues; before onboarding there is none, and this returns undefined so the
 * tag is omitted rather than filled with something untrue.
 */
export function certificateSignature(certificateBase64: string | null): Buffer | undefined {
  if (!certificateBase64) return undefined;
  const der = Buffer.from(certificateBase64.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  // The signature is the final BIT STRING of the X.509 structure. Reading it
  // positionally is fragile, so this parses the outer SEQUENCE properly.
  const sig = extractSignatureBits(der);
  return sig ?? undefined;
}

/** Minimal DER walk: Certificate ::= SEQUENCE { tbs, algid, signature BIT STRING } */
function extractSignatureBits(der: Buffer): Buffer | null {
  let i = 0;
  const readLength = (): number => {
    const first = der[i++]!;
    if (first < 0x80) return first;
    const count = first & 0x7f;
    let len = 0;
    for (let n = 0; n < count; n++) len = (len << 8) | der[i++]!;
    return len;
  };
  if (der[i++] !== 0x30) return null;          // Certificate SEQUENCE
  readLength();
  for (let field = 0; field < 3; field++) {
    const tag = der[i++]!;
    const len = readLength();
    if (field === 2) {
      if (tag !== 0x03) return null;           // BIT STRING
      // First content byte is the count of unused bits; skip it.
      return der.subarray(i + 1, i + len);
    }
    i += len;
  }
  return null;
}
