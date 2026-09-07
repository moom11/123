import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP with RFC 4648 base32 secrets — the scheme Google Authenticator,
 * Authy and 1Password all implement. Administrative accounts cannot log in
 * without one.
 */

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit TOTP secret, base32-encoded for the authenticator app. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export interface TotpOptions {
  digits?: number;
  periodSeconds?: number;
  algorithm?: 'sha1' | 'sha256' | 'sha512';
}

export function generateTotp(
  secretBase32: string,
  atMs: number = Date.now(),
  opts: TotpOptions = {},
): string {
  const { digits = 6, periodSeconds = 30, algorithm = 'sha1' } = opts;
  const counter = Math.floor(atMs / 1000 / periodSeconds);

  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  const hmac = createHmac(algorithm, base32Decode(secretBase32)).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Verify a submitted code, tolerating `window` steps of clock drift either way
 * (default ±1 step = ±30s). Comparison is constant-time.
 */
export function verifyTotp(
  secretBase32: string,
  token: string,
  opts: TotpOptions & { window?: number } = {},
): boolean {
  const { window = 1, periodSeconds = 30 } = opts;
  const candidate = token.replace(/\s/g, '');
  if (!/^\d{6,8}$/.test(candidate)) return false;

  const now = Date.now();
  for (let drift = -window; drift <= window; drift += 1) {
    const expected = generateTotp(secretBase32, now + drift * periodSeconds * 1000, opts);
    if (expected.length === candidate.length) {
      if (timingSafeEqual(Buffer.from(expected), Buffer.from(candidate))) return true;
    }
  }
  return false;
}

/** otpauth:// URI for the QR code shown during MFA enrolment. */
export function totpUri(secretBase32: string, accountName: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Ten single-use recovery codes, shown once at enrolment. */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
}
