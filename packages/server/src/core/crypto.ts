import { ARGON2_DEFAULTS, hashArgon2id, verifyArgon2id } from './argon2.js';
import {
  createHash, createHmac, randomBytes, randomInt, timingSafeEqual,
  createCipheriv, createDecipheriv, scryptSync,
} from 'node:crypto';
import { config } from './config.js';

/**
 * Hash a password or a PIN. Neither is ever stored in any other form.
 *
 * 64 MiB over 3 passes, which is OWASP's recommended Argon2id profile and the
 * same cost the native implementation used, so nothing already stored has to be
 * re-hashed. See core/argon2.ts for why the implementation is pure JavaScript.
 */
export async function hashSecret(plain: string): Promise<string> {
  return hashArgon2id(plain, new Uint8Array(randomBytes(16)), ARGON2_DEFAULTS);
}

/**
 * Verify against an Argon2id hash. Returns false rather than throwing on a
 * malformed stored hash, so a corrupt row denies access instead of 500-ing.
 *
 * The cost parameters are read from the stored hash itself, which is what lets
 * the defaults above be raised later without invalidating anything already
 * written.
 */
export async function verifySecret(hash: string, plain: string): Promise<boolean> {
  try {
    return verifyArgon2id(hash, plain);
  } catch {
    return false;
  }
}

/**
 * Opaque high-entropy token (refresh tokens, print-agent tokens, QR tokens).
 * URL-safe so it can be dropped straight into a QR payload.
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Refresh tokens and agent tokens are looked up by hash, so a database leak
 * does not yield usable credentials. SHA-256 (not Argon2) is correct here:
 * the token already has 256 bits of entropy, so there is nothing to brute
 * force, and lookups must be a single indexed query.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Numeric OTP code, uniformly distributed (randomInt, never Math.random). */
export function generateNumericCode(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String(randomInt(0, 10));
  return out;
}

// --- MFA secret encryption at rest ------------------------------------------
// TOTP secrets must be recoverable (unlike passwords), so they are encrypted
// with AES-256-GCM under a key derived from MFA_SECRET_KEY rather than hashed.

const MFA_KEY = scryptSync(config.auth.mfaSecretKey, 'mara-mfa-secret-v1', 32);

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', MFA_KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${enc.toString('base64url')}.${tag.toString('base64url')}`;
}

export function decryptSecret(packed: string): string {
  const [version, ivB64, dataB64, tagB64] = packed.split('.');
  if (version !== 'v1' || !ivB64 || !dataB64 || !tagB64) {
    throw new Error('Malformed encrypted secret');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm', MFA_KEY, Buffer.from(ivB64, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

// --- Minimal JWT (HS256) -----------------------------------------------------
// Access tokens are short-lived and symmetric; a dedicated JWT library would
// add a dependency for what is thirty lines of well-understood code.

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export interface JwtPayload {
  sub: string;
  [key: string]: unknown;
}

export function signJwt(payload: JwtPayload, secret: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify(body));
  const data = `${header}.${claims}`;
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export class JwtError extends Error {}

export function verifyJwt<T extends JwtPayload = JwtPayload>(
  token: string,
  secret: string,
): T {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('Malformed token');
  const [header, claims, sig] = parts;

  const expected = createHmac('sha256', secret).update(`${header}.${claims}`).digest('base64url');
  if (!constantTimeEqual(sig, expected)) throw new JwtError('Bad signature');

  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('Malformed payload');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < now) throw new JwtError('Token expired');
  return payload;
}

/** Mask a phone number for display to staff without the full-phone permission. */
export function maskPhone(phone: string): string {
  if (phone.length <= 4) return '****';
  return `${phone.slice(0, 4)}${'*'.repeat(Math.max(0, phone.length - 7))}${phone.slice(-3)}`;
}
