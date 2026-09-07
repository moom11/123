import { afterAll, describe, expect, it } from 'vitest';
import { auth, closeApp, getApp, getBranchId, loginAdmin, loginEmployee } from './helpers.js';
import { one, pool } from '../src/core/db.js';

afterAll(closeApp);

describe('authentication', () => {
  it('admin logs in with email and password', async () => {
    const session = await loginAdmin('owner@maralounge.sa', 'MaraOwner#2026Xy');
    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).toBeTruthy();
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    const app = await getApp();
    const wrongPassword = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'owner@maralounge.sa', password: 'definitely-wrong' },
    });
    const unknownEmail = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'nobody@maralounge.sa', password: 'definitely-wrong' },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    // Identical responses: an attacker learns nothing about which emails exist.
    expect(wrongPassword.json().error.message).toBe(unknownEmail.json().error.message);
  });

  it('employee logs in with employee id and PIN', async () => {
    const app = await getApp();
    const branchId = await getBranchId();
    const res = await app.inject({
      method: 'POST', url: '/api/auth/employee/login',
      payload: { branchId, employeeCode: '1042', pin: '2580' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.employee.name).toBe('خالد الويتر');
    expect(body.employee.role).toBe('waiter');
  });

  it('rejects a wrong PIN', async () => {
    const app = await getApp();
    const branchId = await getBranchId();
    const res = await app.inject({
      method: 'POST', url: '/api/auth/employee/login',
      payload: { branchId, employeeCode: '1042', pin: '9999' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('REFUSES a PIN login for an administrative account', async () => {
    // The specification is explicit: management may never enter with a PIN.
    const app = await getApp();
    const branchId = await getBranchId();
    const manager = await one<{ id: string; role_id: string }>(
      "SELECT id, role_id FROM users WHERE lower(email) = 'manager@maralounge.sa'",
    );
    // Give the manager an employee record with a PIN — the worst case.
    const { hashSecret } = await import('../src/core/crypto.js');
    await pool.query(
      `INSERT INTO employees (employee_code, user_id, full_name, job_title, department,
         branch_id, role_id, pin_hash)
       VALUES ('9001',$1,'مدير الفرع','مدير','ADMIN',$2,$3,$4)
       ON CONFLICT DO NOTHING`,
      [manager!.id, branchId, manager!.role_id, await hashSecret('1234')],
    );

    const res = await app.inject({
      method: 'POST', url: '/api/auth/employee/login',
      payload: { branchId, employeeCode: '9001', pin: '1234' },
    });
    // Correct PIN, correct employee row — and still refused, because the role
    // is administrative.
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('التحقق الثنائي');
  });

  it('locks an employee out after repeated bad PINs', async () => {
    const app = await getApp();
    const branchId = await getBranchId();
    for (let i = 0; i < 5; i += 1) {
      await app.inject({
        method: 'POST', url: '/api/auth/employee/login',
        payload: { branchId, employeeCode: '3004', pin: '0000' },
      });
    }
    const res = await app.inject({
      method: 'POST', url: '/api/auth/employee/login',
      payload: { branchId, employeeCode: '3004', pin: '5817' },  // the CORRECT pin
    });
    expect(res.statusCode).toBe(429);
    await pool.query(
      "UPDATE employees SET locked_until = NULL, failed_pin_count = 0 WHERE employee_code = '3004'",
    );
  });

  it('rotates refresh tokens and revokes the family on replay', async () => {
    const app = await getApp();
    // A dedicated login: this test consumes the refresh token, so it must not
    // share the cached session other tests rely on.
    const branchId = await getBranchId();
    const fresh = await app.inject({
      method: 'POST', url: '/api/auth/employee/login',
      payload: { branchId, employeeCode: '3002', pin: '6473' },
    });
    const session = fresh.json().tokens;

    const first = await app.inject({
      method: 'POST', url: '/api/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(first.statusCode).toBe(200);
    const rotated = first.json().tokens;
    expect(rotated.refreshToken).not.toBe(session.refreshToken);

    // Replaying the consumed token is treated as theft.
    const replay = await app.inject({
      method: 'POST', url: '/api/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(replay.statusCode).toBe(401);

    // ...and the successor is revoked too, ending the whole family.
    const afterReplay = await app.inject({
      method: 'POST', url: '/api/auth/refresh',
      payload: { refreshToken: rotated.refreshToken },
    });
    expect(afterReplay.statusCode).toBe(401);

    const audited = await one<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'auth.session.reuse_detected'",
    );
    expect(audited!.n).toBeGreaterThan(0);
  });

  it('requires a session for protected endpoints', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/api/tables' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a forged access token', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'GET', url: '/api/tables',
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.forged' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('logs failed logins to the audit trail', async () => {
    const before = await one<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'auth.login.failed'",
    );
    const app = await getApp();
    await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'owner@maralounge.sa', password: 'nope-nope-nope' },
    });
    const after = await one<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'auth.login.failed'",
    );
    expect(after!.n).toBeGreaterThan(before!.n);
  });
});

describe('MFA', () => {
  it('verifies TOTP codes and rejects wrong ones', async () => {
    const { generateTotpSecret, generateTotp, verifyTotp } = await import('../src/core/totp.js');
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, generateTotp(secret))).toBe(true);
    expect(verifyTotp(secret, '000000')).toBe(false);
    // A code from well outside the drift window must not be accepted.
    expect(verifyTotp(secret, generateTotp(secret, Date.now() - 600_000))).toBe(false);
  });

  it('encrypts MFA secrets at rest and round-trips them', async () => {
    const { encryptSecret, decryptSecret } = await import('../src/core/crypto.js');
    const secret = 'JBSWY3DPEHPK3PXP';
    const packed = encryptSecret(secret);
    expect(packed).not.toContain(secret);
    expect(decryptSecret(packed)).toBe(secret);
  });
});

describe('password and PIN policy', () => {
  it('rejects weak passwords', async () => {
    const { assertPasswordPolicy } = await import('../src/modules/auth/auth.service.js');
    expect(() => assertPasswordPolicy('short')).toThrow();
    expect(() => assertPasswordPolicy('alllowercase123!')).toThrow();
    expect(() => assertPasswordPolicy('Password123!@#')).toThrow();  // common word
    expect(() => assertPasswordPolicy('Str0ng&Unique#Pass')).not.toThrow();
  });

  it('rejects weak PINs', async () => {
    const { assertPinPolicy } = await import('../src/modules/auth/auth.service.js');
    expect(() => assertPinPolicy('1111')).toThrow();
    expect(() => assertPinPolicy('1234')).toThrow();
    expect(() => assertPinPolicy('abc')).toThrow();
    expect(() => assertPinPolicy('2580')).not.toThrow();
  });

  it('never stores a PIN or password in plaintext', async () => {
    const rows = await pool.query(
      "SELECT pin_hash FROM employees WHERE employee_code = '1042'",
    );
    expect(rows.rows[0].pin_hash).not.toContain('2580');
    expect(rows.rows[0].pin_hash.startsWith('$argon2id$')).toBe(true);

    const user = await pool.query(
      "SELECT password_hash FROM users WHERE lower(email) = 'owner@maralounge.sa'",
    );
    expect(user.rows[0].password_hash.startsWith('$argon2id$')).toBe(true);
  });
});
