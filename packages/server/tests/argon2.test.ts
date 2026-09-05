import { describe, expect, it } from 'vitest';
import { formatPhc, hashArgon2id, parsePhc, verifyArgon2id } from '../src/core/argon2.js';
import { hashSecret, verifySecret } from '../src/core/crypto.js';

/**
 * The implementation changed from a native addon to pure JavaScript so it can
 * run on Cloudflare Workers. These tests exist to prove that nothing already
 * stored was invalidated by that change.
 */
describe('argon2id', () => {
  it('verifies the hashes already stored in the database', async () => {
    // These were written by the native @node-rs/argon2 build during seeding,
    // before the implementation changed. If this fails, every existing password
    // and PIN has been invalidated — which is the whole risk of the swap.
    const { many } = await import('../src/core/db.js');
    const rows = await many<{ pin_hash: string; employee_code: string }>(
      "SELECT employee_code, pin_hash FROM employees WHERE employee_code IN ('1042','2001')",
    );
    expect(rows.length).toBeGreaterThan(0);

    const pins: Record<string, string> = { '1042': '2580', '2001': '4826' };
    for (const row of rows) {
      expect(row.pin_hash.startsWith('$argon2id$')).toBe(true);
      expect(
        await verifySecret(row.pin_hash, pins[row.employee_code]),
        `stored PIN for ${row.employee_code} no longer verifies`,
      ).toBe(true);
      expect(await verifySecret(row.pin_hash, '0000')).toBe(false);
    }
  });

  it('round-trips its own hashes', async () => {
    const hash = await hashSecret('Str0ng&Unique#Pass');
    expect(hash.startsWith('$argon2id$v=19$m=65536,t=3,p=1$')).toBe(true);
    expect(await verifySecret(hash, 'Str0ng&Unique#Pass')).toBe(true);
    expect(await verifySecret(hash, 'Str0ng&Unique#Pas')).toBe(false);
  });

  it('salts every hash separately', async () => {
    const a = await hashSecret('same-password');
    const b = await hashSecret('same-password');
    expect(a).not.toBe(b);
    expect(await verifySecret(a, 'same-password')).toBe(true);
    expect(await verifySecret(b, 'same-password')).toBe(true);
  });

  it('reads cost parameters from the stored hash, not the defaults', () => {
    // A cheaper hash must still verify after the defaults are raised.
    const salt = new Uint8Array(16).fill(3);
    const cheap = hashArgon2id('pw', salt, {
      memoryKiB: 8192, iterations: 1, parallelism: 1, hashLength: 32,
    });
    expect(cheap).toContain('m=8192,t=1,p=1');
    expect(verifyArgon2id(cheap, 'pw')).toBe(true);
    expect(verifyArgon2id(cheap, 'nope')).toBe(false);
  });

  it('refuses a malformed or non-argon2id hash rather than silently failing', async () => {
    expect(() => parsePhc('not-a-hash')).toThrow();
    expect(() => parsePhc('$argon2i$v=19$m=65536,t=3,p=1$YWJj$ZGVm')).toThrow(/variant/);
    expect(() => parsePhc('$argon2id$v=16$m=65536,t=3,p=1$YWJj$ZGVm')).toThrow(/version/);
    // verifySecret swallows the throw, so a corrupt row denies access rather
    // than returning a 500.
    expect(await verifySecret('garbage', 'pw')).toBe(false);
  });

  it('encodes PHC exactly as the reference implementations do', () => {
    const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const hash = new Uint8Array(32).fill(9);
    const encoded = formatPhc(salt, hash, {
      memoryKiB: 65536, iterations: 3, parallelism: 1,
    });
    expect(encoded).toBe(
      '$argon2id$v=19$m=65536,t=3,p=1$AQIDBAUGBwgJCgsMDQ4PEA$'
      + 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk',
    );
    // The base64 segments are unpadded, as PHC requires. (The parameter
    // segment legitimately contains '=' in m=..,t=..,p=..)
    const [, , , , saltSegment, hashSegment] = encoded.split('$');
    expect(saltSegment).not.toContain('=');
    expect(hashSegment).not.toContain('=');
    const parsed = parsePhc(encoded);
    expect([...parsed.salt]).toEqual([...salt]);
  });
});
