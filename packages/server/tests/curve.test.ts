import { describe, expect, test } from 'vitest';
import {
  createHash, createPublicKey, createSign, createVerify, generateKeyPairSync,
} from 'node:crypto';
import {
  encodePkcs8, encodeSpki, fromPem, pointFromSpki, scalarFromPkcs8,
} from '../src/core/zatca/keys.js';
import {
  generateStampKeyPair, invoiceHash, publicKeyDerFromPrivate, stamp, verifyStamp,
} from '../src/core/zatca/sign.js';

/**
 * The stamp moved off node:crypto so it can run on Cloudflare Workers, where
 * neither node:crypto nor a secp256k1 WebCrypto exists.
 *
 * That move is only safe if it changed nothing observable. A key stored by an
 * earlier deployment must still open, the CSID ZATCA issued against it must
 * still match, and every signature already on an invoice must still verify.
 * These tests hold the new implementation against the old one it replaced.
 */

const XML = '<Invoice><cbc:ID>ORD-2026-000041</cbc:ID></Invoice>';

describe('key encoding matches what node:crypto produced', () => {
  test('PKCS#8 and SPKI are byte-identical, across many keys', () => {
    // Many, not one: the PKCS#8 length crosses the 128-byte DER boundary, so
    // the header is two bytes for some keys and three for others. One sample
    // would pass while a fraction of real keys silently encoded wrong.
    for (let i = 0; i < 40; i += 1) {
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
      const nodePkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
      const nodeSpki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;

      const scalar = scalarFromPkcs8(nodePkcs8);
      expect(encodePkcs8(scalar).equals(nodePkcs8)).toBe(true);
      expect(encodeSpki(scalar).equals(nodeSpki)).toBe(true);
    }
  });

  test('the scalar is found by walking, not by a fixed offset', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const scalar = scalarFromPkcs8(privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer);
    expect(scalar.length).toBe(32);
  });

  test('the public point round-trips through SPKI', () => {
    const pair = generateStampKeyPair();
    const point = pointFromSpki(Buffer.from(pair.publicKeyDer, 'base64'));
    expect(point.length).toBe(65);
    expect(point[0]).toBe(0x04);          // uncompressed
  });

  test('malformed input is refused rather than mis-read', () => {
    expect(() => scalarFromPkcs8(Buffer.from([0x02, 0x01, 0x00]))).toThrow();
    expect(() => pointFromSpki(Buffer.alloc(4))).toThrow();
  });
});

describe('signatures interoperate with node:crypto in both directions', () => {
  test('a key an old deployment stored still signs, and Node verifies it', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const legacyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const signature = stamp(legacyPem, XML);
    const verifier = createVerify('sha256');
    verifier.update(XML, 'utf8');
    verifier.end();
    expect(verifier.verify(publicKey, signature)).toBe(true);
  });

  test('the public key derived from a stored key is unchanged', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const legacyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(publicKeyDerFromPrivate(legacyPem)
      .equals(publicKey.export({ type: 'spki', format: 'der' }) as Buffer)).toBe(true);
  });

  test('a signature written by node:crypto still verifies — high S included', () => {
    // Roughly half of node:crypto's signatures carry high S, which the curve
    // library rejects by default. Such a signature is perfectly valid and the
    // authority accepts it; rejecting it would fail the chain audit on
    // invoices that are not wrong. Forty rounds, so it cannot pass by luck.
    const pair = generateStampKeyPair();
    const key = { key: fromPem(pair.privateKeyPem), format: 'der' as const, type: 'pkcs8' as const };

    for (let i = 0; i < 40; i += 1) {
      const signer = createSign('sha256');
      signer.update(XML, 'utf8');
      signer.end();
      const legacySignature = signer.sign(key);
      expect(verifyStamp(Buffer.from(pair.publicKeyDer, 'base64'), XML, legacySignature))
        .toBe(true);
    }
  });

  test('a new signature verifies under Node', () => {
    const pair = generateStampKeyPair();
    const signature = stamp(pair.privateKeyPem, XML);
    const publicKey = createPublicKey({
      key: Buffer.from(pair.publicKeyDer, 'base64'), format: 'der', type: 'spki',
    });
    const verifier = createVerify('sha256');
    verifier.update(XML, 'utf8');
    verifier.end();
    expect(verifier.verify(publicKey, signature)).toBe(true);
  });
});

describe('what must not change', () => {
  test('the invoice hash is the same value', () => {
    // Stored on every invoice already issued and chained into the next one.
    // A different value here would break every chain at once.
    expect(invoiceHash(XML))
      .toBe(createHash('sha256').update(XML, 'utf8').digest('base64'));
  });

  test('a tampered document does not verify', () => {
    const pair = generateStampKeyPair();
    const signature = stamp(pair.privateKeyPem, XML);
    expect(verifyStamp(Buffer.from(pair.publicKeyDer, 'base64'),
      XML.replace('000041', '000042'), signature)).toBe(false);
  });

  test('another branch key does not verify this stamp', () => {
    const mine = generateStampKeyPair();
    const theirs = generateStampKeyPair();
    const signature = stamp(mine.privateKeyPem, XML);
    expect(verifyStamp(Buffer.from(theirs.publicKeyDer, 'base64'), XML, signature))
      .toBe(false);
  });

  test('rubbish is rejected rather than throwing at the till', () => {
    expect(verifyStamp(Buffer.alloc(10), XML, Buffer.alloc(10))).toBe(false);
  });
});

describe('no runtime-specific API is reached for', () => {
  test('signing uses neither node:crypto nor SubtleCrypto', async () => {
    // The point of the rewrite: this module must load and work where neither
    // exists. Asserted against the source, because an accidental import would
    // pass every test here and fail only on deployment.
    const { readFile } = await import('node:fs/promises');
    for (const file of ['sign.ts', 'keys.ts', 'csr.ts']) {
      const source = await readFile(
        new URL(`../src/core/zatca/${file}`, import.meta.url), 'utf8');
      expect(source, `${file} imports node:crypto`).not.toMatch(/from 'node:crypto'/);
      expect(source, `${file} uses SubtleCrypto`).not.toMatch(/crypto\.subtle/);
    }
  });
});
