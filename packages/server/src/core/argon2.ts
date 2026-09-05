import { argon2id } from '@noble/hashes/argon2.js';

/**
 * Argon2id in pure JavaScript, with PHC string encoding.
 *
 * Why not a WASM build, which would be five times faster: Cloudflare Workers
 * forbids runtime WebAssembly compilation ("Wasm code generation disallowed by
 * embedder"), and every published argon2 WASM package embeds its module as
 * base64 and compiles it on first use. A pure-JS implementation is the only
 * one that runs unmodified on both Node and Workers.
 *
 * The digests are byte-identical to the native and WASM implementations for
 * the same inputs, and the string format below is the standard PHC encoding, so
 * hashes written by any of them verify under this one. Nothing in the database
 * needs re-hashing.
 */

/** OWASP's second recommended Argon2id profile, unchanged from the native build. */
export const ARGON2_DEFAULTS = {
  memoryKiB: 65536,
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
} as const;

interface ParsedPhc {
  version: number;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // PHC uses unpadded standard base64.
  return btoa(binary).replace(/=+$/, '');
}

function fromBase64(value: string): Uint8Array {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Parse `$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>`.
 *
 * Throws on anything that is not a well-formed argon2id hash, including the
 * other argon2 variants: verifying a password against an argon2i hash with
 * argon2id would silently always fail, and a loud error is better.
 */
export function parsePhc(encoded: string): ParsedPhc {
  const parts = encoded.split('$');
  // ['', 'argon2id', 'v=19', 'm=..,t=..,p=..', salt, hash]
  if (parts.length !== 6 || parts[0] !== '') throw new Error('malformed argon2 hash');
  if (parts[1] !== 'argon2id') throw new Error(`unsupported argon2 variant: ${parts[1]}`);

  const version = Number(parts[2].replace('v=', ''));
  if (version !== 19) throw new Error(`unsupported argon2 version: ${version}`);

  const params: Record<string, number> = {};
  for (const pair of parts[3].split(',')) {
    const [key, value] = pair.split('=');
    params[key] = Number(value);
  }
  if (!params.m || !params.t || !params.p) throw new Error('missing argon2 parameters');

  return {
    version,
    memoryKiB: params.m,
    iterations: params.t,
    parallelism: params.p,
    salt: fromBase64(parts[4]),
    hash: fromBase64(parts[5]),
  };
}

export function formatPhc(
  salt: Uint8Array, hash: Uint8Array,
  params: { memoryKiB: number; iterations: number; parallelism: number },
): string {
  return `$argon2id$v=19$m=${params.memoryKiB},t=${params.iterations},p=${params.parallelism}`
    + `$${toBase64(salt)}$${toBase64(hash)}`;
}

export function hashArgon2id(
  password: string,
  salt: Uint8Array,
  params = ARGON2_DEFAULTS,
): string {
  const digest = argon2id(password, salt, {
    t: params.iterations,
    m: params.memoryKiB,
    p: params.parallelism,
    dkLen: params.hashLength,
  });
  return formatPhc(salt, digest, params);
}

/**
 * Verify a password against a PHC hash.
 *
 * The cost parameters come from the stored hash, not from the defaults, which
 * is what allows the defaults to be raised later without invalidating anything
 * already stored.
 */
export function verifyArgon2id(encoded: string, password: string): boolean {
  const parsed = parsePhc(encoded);
  const computed = argon2id(password, parsed.salt, {
    t: parsed.iterations,
    m: parsed.memoryKiB,
    p: parsed.parallelism,
    dkLen: parsed.hash.length,
  });

  // Constant-time comparison: a length check leaks nothing useful, but the
  // byte comparison must not short-circuit on the first difference.
  if (computed.length !== parsed.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i += 1) diff |= computed[i] ^ parsed.hash[i];
  return diff === 0;
}
