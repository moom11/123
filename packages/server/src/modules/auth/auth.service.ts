import type { PoolClient } from 'pg';
import { isAdminRole } from '@mara/shared';
import { config } from '../../core/config.js';
import { many, one, pool, withTransaction } from '../../core/db.js';
import {
  generateToken, hashSecret, hashToken, signJwt, verifySecret, verifyJwt,
  encryptSecret, decryptSecret,
} from '../../core/crypto.js';
import { AUDIT, audit } from '../../core/audit.js';
import { forbidden, tooManyRequests, unauthorized, badRequest } from '../../core/errors.js';
import type { Principal } from '../../core/principal.js';
import { generateRecoveryCodes, generateTotpSecret, totpUri, verifyTotp } from '../../core/totp.js';

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  deviceLabel?: string | null;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
}

/**
 * Effective permissions = role permissions + per-user grants - per-user denies.
 * Computed in one query so a permission change takes effect on the very next
 * request rather than whenever a cache happens to expire.
 */
export async function loadPermissions(userId: string): Promise<Set<string>> {
  const rows = await many<{ permission_code: string; granted: boolean | null }>(
    `SELECT rp.permission_code, NULL::boolean AS granted
       FROM users u
       JOIN role_permissions rp ON rp.role_id = u.role_id
      WHERE u.id = $1
      UNION ALL
     SELECT o.permission_code, o.granted
       FROM user_permission_overrides o
      WHERE o.user_id = $1`,
    [userId],
  );

  const granted = new Set<string>();
  const denied = new Set<string>();
  for (const r of rows) {
    if (r.granted === false) denied.add(r.permission_code);
    else granted.add(r.permission_code);
  }
  for (const d of denied) granted.delete(d);
  return granted;
}

interface SessionRow {
  session_id: string;
  user_id: string;
  employee_id: string | null;
  principal_kind: 'admin' | 'employee';
  branch_id: string | null;
  mfa_satisfied: boolean;
  full_name: string;
  role_code: string;
  user_branch_id: string | null;
  is_active: boolean;
  employee_code: string | null;
  department: string | null;
}

/** Rebuild the principal for an access token. */
export async function loadPrincipal(sessionId: string): Promise<Principal | null> {
  const row = await one<SessionRow>(
    `SELECT s.id AS session_id, s.user_id, s.employee_id, s.principal_kind,
            s.branch_id, s.mfa_satisfied,
            u.full_name, u.is_active, u.branch_id AS user_branch_id,
            r.code AS role_code,
            e.employee_code, e.department
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN employees e ON e.id = s.employee_id
      WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sessionId],
  );
  if (!row || !row.is_active) return null;

  const permissions = await loadPermissions(row.user_id);

  // An owner/executive with no home branch may act across every branch; anyone
  // else is confined to their own branch plus explicit grants.
  const extraBranches = await many<{ branch_id: string }>(
    'SELECT branch_id FROM user_branches WHERE user_id = $1',
    [row.user_id],
  );
  const allowed = new Set<string>();
  if (row.user_branch_id) allowed.add(row.user_branch_id);
  for (const b of extraBranches) allowed.add(b.branch_id);

  return {
    kind: row.principal_kind,
    userId: row.user_id,
    employeeId: row.employee_id,
    employeeCode: row.employee_code,
    sessionId: row.session_id,
    displayName: row.full_name,
    roleCode: row.role_code,
    isAdminRole: isAdminRole(row.role_code),
    branchId: row.branch_id ?? row.user_branch_id,
    // Empty list = unrestricted. Only ever produced for a user with no home
    // branch, which is reserved for owner/super_admin/executive.
    allowedBranchIds: row.user_branch_id ? [...allowed] : [],
    permissions,
    mfaSatisfied: row.mfa_satisfied,
    department: row.department,
  };
}

async function issueSession(
  client: PoolClient,
  args: {
    userId: string;
    employeeId?: string | null;
    principalKind: 'admin' | 'employee';
    branchId: string | null;
    mfaSatisfied: boolean;
    meta: RequestMeta;
    familyId?: string;
  },
): Promise<TokenPair> {
  const refreshToken = generateToken(48);
  const ttl = args.principalKind === 'admin'
    ? config.auth.adminRefreshTtlSeconds
    : config.auth.employeeRefreshTtlSeconds;

  const row = await one<{ id: string; family_id: string }>(
    `INSERT INTO sessions (
       user_id, employee_id, family_id, refresh_token_hash, principal_kind,
       branch_id, device_label, ip, user_agent, mfa_satisfied, expires_at
     ) VALUES ($1,$2,COALESCE($3, gen_random_uuid()),$4,$5,$6,$7,$8,$9,$10, now() + ($11 || ' seconds')::interval)
     RETURNING id, family_id`,
    [
      args.userId, args.employeeId ?? null, args.familyId ?? null,
      hashToken(refreshToken), args.principalKind, args.branchId,
      args.meta.deviceLabel ?? null, args.meta.ip ?? null,
      args.meta.userAgent ?? null, args.mfaSatisfied, String(ttl),
    ],
    client,
  );
  if (!row) throw new Error('Failed to create session');

  const accessToken = signJwt(
    { sub: args.userId, sid: row.id, kind: args.principalKind },
    config.auth.accessSecret,
    config.auth.accessTtlSeconds,
  );

  return {
    accessToken,
    refreshToken,
    expiresIn: config.auth.accessTtlSeconds,
    sessionId: row.id,
  };
}

export interface AdminLoginResult {
  status: 'ok' | 'mfa_required' | 'mfa_enrollment_required';
  tokens?: TokenPair;
  mfaToken?: string;
  enrollment?: { secret: string; uri: string };
  user?: { id: string; name: string; role: string; branchId: string | null };
}

/**
 * Administrative login: email + password, then MFA. A PIN can never satisfy
 * this path — the two flows do not share code.
 */
export async function adminLogin(
  email: string,
  password: string,
  meta: RequestMeta,
): Promise<AdminLoginResult> {
  const user = await one<{
    id: string; email: string; password_hash: string | null; full_name: string;
    role_code: string; branch_id: string | null; is_active: boolean;
    mfa_enabled: boolean; mfa_secret: string | null;
    failed_login_count: number; locked_until: Date | null;
  }>(
    `SELECT u.id, u.email, u.password_hash, u.full_name, u.branch_id, u.is_active,
            u.mfa_enabled, u.mfa_secret, u.failed_login_count, u.locked_until,
            r.code AS role_code
       FROM users u JOIN roles r ON r.id = u.role_id
      WHERE lower(u.email) = lower($1) AND u.deleted_at IS NULL`,
    [email],
  );

  // Uniform failure: never reveal whether the address exists.
  const genericFailure = async (reason: string) => {
    await audit({
      action: AUDIT.LOGIN_FAILED, actorKind: 'system',
      actorUserId: user?.id ?? null, actorLabel: email,
      metadata: { reason, email }, ip: meta.ip, userAgent: meta.userAgent,
      requestId: meta.requestId,
    });
    throw unauthorized('بيانات الدخول غير صحيحة');
  };

  if (!user) {
    // Spend comparable time so timing does not disclose account existence.
    await verifySecret('$argon2id$v=19$m=65536,t=3,p=1$YWJjZGVmZ2hpamts$0000000000000000000000000000000000000000000', password);
    return genericFailure('unknown_email');
  }
  if (!user.is_active) return genericFailure('inactive');
  if (user.locked_until && user.locked_until > new Date()) {
    throw tooManyRequests('الحساب مقفل مؤقتاً بسبب محاولات دخول فاشلة');
  }
  if (!isAdminRole(user.role_code)) {
    return genericFailure('not_admin_role');
  }
  if (!user.password_hash) return genericFailure('no_password');

  const ok = await verifySecret(user.password_hash, password);
  if (!ok) {
    // Brute-force protection: count up, then lock the account for a cool-off.
    const attempts = user.failed_login_count + 1;
    const shouldLock = attempts >= config.auth.maxFailedLogins;
    await pool.query(
      `UPDATE users SET failed_login_count = $2,
              locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END
        WHERE id = $1`,
      [user.id, shouldLock ? 0 : attempts, shouldLock, String(config.auth.lockoutMinutes)],
    );
    if (shouldLock) {
      await createSecurityNotification(user.branch_id, 'suspicious_login',
        'محاولات دخول فاشلة متكررة',
        `تم قفل حساب ${user.full_name} بعد ${attempts} محاولات فاشلة.`);
    }
    return genericFailure('bad_password');
  }

  await pool.query(
    'UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1',
    [user.id],
  );

  // MFA is mandatory for every administrative role.
  if (!user.mfa_enabled || !user.mfa_secret) {
    if (config.auth.requireAdminMfa) {
      const secret = generateTotpSecret();
      await pool.query('UPDATE users SET mfa_secret = $2 WHERE id = $1',
        [user.id, encryptSecret(secret)]);
      await audit({
        action: AUDIT.LOGIN_MFA_REQUIRED, actorUserId: user.id,
        actorLabel: user.full_name, branchId: user.branch_id,
        metadata: { stage: 'enrollment' }, ip: meta.ip, requestId: meta.requestId,
      });
      return {
        status: 'mfa_enrollment_required',
        mfaToken: signJwt({ sub: user.id, stage: 'mfa_enroll' }, config.auth.accessSecret, 600),
        enrollment: { secret, uri: totpUri(secret, user.email, config.auth.mfaIssuer) },
        user: { id: user.id, name: user.full_name, role: user.role_code, branchId: user.branch_id },
      };
    }
    // Development only — production always takes the branch above.
    const tokens = await withTransaction((c) => issueSession(c, {
      userId: user.id, principalKind: 'admin', branchId: user.branch_id,
      mfaSatisfied: false, meta,
    }));
    await recordLoginSuccess(user.id, user.full_name, user.branch_id, meta, false);
    return { status: 'ok', tokens,
      user: { id: user.id, name: user.full_name, role: user.role_code, branchId: user.branch_id } };
  }

  await audit({
    action: AUDIT.LOGIN_MFA_REQUIRED, actorUserId: user.id, actorLabel: user.full_name,
    branchId: user.branch_id, ip: meta.ip, requestId: meta.requestId,
  });
  return {
    status: 'mfa_required',
    // Short-lived, single-purpose: this token can do nothing but complete MFA.
    mfaToken: signJwt({ sub: user.id, stage: 'mfa' }, config.auth.accessSecret, 300),
    user: { id: user.id, name: user.full_name, role: user.role_code, branchId: user.branch_id },
  };
}

/** Second factor. Accepts a TOTP code or a single-use recovery code. */
export async function completeMfa(
  mfaToken: string,
  code: string,
  meta: RequestMeta,
): Promise<TokenPair> {
  let payload: { sub: string; stage?: string };
  try {
    payload = verifyJwt(mfaToken, config.auth.accessSecret);
  } catch {
    throw unauthorized('انتهت صلاحية جلسة التحقق، سجّل الدخول مرة أخرى');
  }
  if (payload.stage !== 'mfa' && payload.stage !== 'mfa_enroll') {
    throw unauthorized('رمز تحقق غير صالح');
  }

  const user = await one<{
    id: string; full_name: string; branch_id: string | null; email: string;
    mfa_secret: string | null; mfa_enabled: boolean; mfa_recovery_codes: string[];
    role_code: string;
  }>(
    `SELECT u.id, u.full_name, u.branch_id, u.email, u.mfa_secret, u.mfa_enabled,
            u.mfa_recovery_codes, r.code AS role_code
       FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.id = $1 AND u.is_active AND u.deleted_at IS NULL`,
    [payload.sub],
  );
  if (!user?.mfa_secret) throw unauthorized('تعذّر التحقق');

  const secret = decryptSecret(user.mfa_secret);
  let verified = verifyTotp(secret, code);
  let usedRecovery = false;

  if (!verified && user.mfa_enabled) {
    // Recovery codes are stored as Argon2id hashes and consumed on use.
    for (const hashed of user.mfa_recovery_codes ?? []) {
      if (await verifySecret(hashed, code.trim().toUpperCase())) {
        verified = true;
        usedRecovery = true;
        await pool.query(
          `UPDATE users SET mfa_recovery_codes =
             (SELECT COALESCE(jsonb_agg(v), '[]'::jsonb) FROM jsonb_array_elements_text(mfa_recovery_codes) v
               WHERE v <> $2)
            WHERE id = $1`,
          [user.id, hashed],
        );
        break;
      }
    }
  }

  if (!verified) {
    await audit({
      action: AUDIT.LOGIN_MFA_FAILED, actorUserId: user.id, actorLabel: user.full_name,
      branchId: user.branch_id, ip: meta.ip, userAgent: meta.userAgent,
      requestId: meta.requestId,
    });
    throw unauthorized('رمز التحقق غير صحيح');
  }

  if (payload.stage === 'mfa_enroll' && !user.mfa_enabled) {
    await pool.query(
      'UPDATE users SET mfa_enabled = TRUE, mfa_confirmed_at = now() WHERE id = $1',
      [user.id],
    );
    await audit({
      action: AUDIT.MFA_ENROLLED, actorUserId: user.id, actorLabel: user.full_name,
      branchId: user.branch_id, ip: meta.ip, requestId: meta.requestId,
    });
  }

  const tokens = await withTransaction((c) => issueSession(c, {
    userId: user.id, principalKind: 'admin', branchId: user.branch_id,
    mfaSatisfied: true, meta,
  }));
  await recordLoginSuccess(user.id, user.full_name, user.branch_id, meta, true, usedRecovery);
  return tokens;
}

/**
 * Operational login: Employee ID + PIN, scoped to a branch. Administrative
 * roles are rejected here even if someone attaches a PIN to such an account.
 */
export async function employeeLogin(
  branchId: string,
  employeeCode: string,
  pin: string,
  meta: RequestMeta,
): Promise<{ tokens: TokenPair; employee: Record<string, unknown> }> {
  const emp = await one<{
    id: string; user_id: string | null; full_name: string; employee_code: string;
    pin_hash: string; is_active: boolean; branch_id: string; department: string;
    job_title: string; role_code: string; failed_pin_count: number;
    locked_until: Date | null;
  }>(
    `SELECT e.id, e.user_id, e.full_name, e.employee_code, e.pin_hash, e.is_active,
            e.branch_id, e.department, e.job_title, e.failed_pin_count, e.locked_until,
            r.code AS role_code
       FROM employees e JOIN roles r ON r.id = e.role_id
      WHERE e.branch_id = $1 AND e.employee_code = $2 AND e.deleted_at IS NULL`,
    [branchId, employeeCode],
  );

  const fail = async (reason: string) => {
    await audit({
      action: AUDIT.PIN_LOGIN_FAILED, actorKind: 'system', branchId,
      actorEmployeeId: emp?.id ?? null, actorLabel: employeeCode,
      metadata: { reason, employeeCode }, ip: meta.ip, userAgent: meta.userAgent,
      requestId: meta.requestId,
    });
    throw unauthorized('رقم الموظف أو الرمز السري غير صحيح');
  };

  if (!emp) {
    await verifySecret('$argon2id$v=19$m=65536,t=3,p=1$YWJjZGVmZ2hpamts$0000000000000000000000000000000000000000000', pin);
    return fail('unknown_employee') as never;
  }
  if (!emp.is_active) return fail('inactive') as never;
  if (emp.locked_until && emp.locked_until > new Date()) {
    throw tooManyRequests('تم قفل الحساب مؤقتاً، راجع مدير الفرع');
  }
  // An administrative role must never be reachable with a PIN.
  if (isAdminRole(emp.role_code)) {
    await audit({
      action: AUDIT.PIN_LOGIN_FAILED, branchId, actorEmployeeId: emp.id,
      actorLabel: emp.full_name, metadata: { reason: 'admin_role_pin_denied' },
      ip: meta.ip, requestId: meta.requestId,
    });
    throw forbidden('الحسابات الإدارية تدخل بالبريد وكلمة المرور والتحقق الثنائي فقط');
  }
  if (!emp.user_id) return fail('no_user_link') as never;

  const ok = await verifySecret(emp.pin_hash, pin);
  if (!ok) {
    const attempts = emp.failed_pin_count + 1;
    const shouldLock = attempts >= config.auth.maxFailedPins;
    await pool.query(
      `UPDATE employees SET failed_pin_count = $2,
              locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END
        WHERE id = $1`,
      [emp.id, shouldLock ? 0 : attempts, shouldLock, String(config.auth.pinLockoutMinutes)],
    );
    if (shouldLock) {
      await createSecurityNotification(branchId, 'repeated_failed_pin',
        'محاولات PIN فاشلة متكررة',
        `الموظف ${emp.full_name} (${emp.employee_code}) تجاوز عدد المحاولات المسموح.`);
    }
    return fail('bad_pin') as never;
  }

  await pool.query(
    'UPDATE employees SET failed_pin_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1',
    [emp.id],
  );

  const tokens = await withTransaction((c) => issueSession(c, {
    userId: emp.user_id!, employeeId: emp.id, principalKind: 'employee',
    branchId: emp.branch_id, mfaSatisfied: false, meta,
  }));

  await audit({
    action: AUDIT.PIN_LOGIN_SUCCESS, branchId, actorEmployeeId: emp.id,
    actorUserId: emp.user_id, actorKind: 'employee', actorLabel: emp.full_name,
    ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
  });

  return {
    tokens,
    employee: {
      id: emp.id, employeeCode: emp.employee_code, name: emp.full_name,
      role: emp.role_code, department: emp.department, jobTitle: emp.job_title,
      branchId: emp.branch_id,
    },
  };
}

/**
 * Refresh with rotation. Presenting a token that has already been rotated is
 * treated as theft: the entire session family is revoked immediately.
 */
export async function refreshSession(
  refreshToken: string,
  meta: RequestMeta,
): Promise<TokenPair> {
  // Set when a replayed token is spotted; acted on after the rollback below.
  // Held in a container because the assignment happens inside the transaction
  // callback, which TypeScript's flow analysis does not track through.
  const reuse: {
    detected?: { familyId: string; userId: string; branchId: string | null };
  } = {};

  try {
    return await withTransaction(async (client) => {
    const hash = hashToken(refreshToken);
    const session = await one<{
      id: string; user_id: string; employee_id: string | null; family_id: string;
      principal_kind: 'admin' | 'employee'; branch_id: string | null;
      mfa_satisfied: boolean; revoked_at: Date | null; rotated_to: string | null;
      expires_at: Date; last_seen_at: Date;
    }>(
      'SELECT * FROM sessions WHERE refresh_token_hash = $1 FOR UPDATE',
      [hash], client,
    );

    if (!session) throw unauthorized('جلسة غير صالحة');

    if (session.revoked_at || session.rotated_to) {
      // Replay of a consumed token: the family is compromised.
      //
      // The revocation deliberately runs on the pool rather than on `client`.
      // This path ends by throwing, which rolls the transaction back — doing
      // the revocation inside it would undo the very lockout it just performed
      // and leave the stolen token family alive.
      reuse.detected = {
        familyId: session.family_id,
        userId: session.user_id,
        branchId: session.branch_id,
      };
      throw unauthorized('تم إنهاء الجلسة لأسباب أمنية، سجّل الدخول مرة أخرى');
    }

    if (session.expires_at <= new Date()) throw unauthorized('انتهت صلاحية الجلسة');

    // Administrative sessions also expire on idleness, not just on age.
    if (session.principal_kind === 'admin') {
      const idleMs = Date.now() - new Date(session.last_seen_at).getTime();
      if (idleMs > config.auth.adminIdleTimeoutSeconds * 1000) {
        await client.query(
          `UPDATE sessions SET revoked_at = now(), revoked_reason = 'idle_timeout' WHERE id = $1`,
          [session.id],
        );
        throw unauthorized('انتهت الجلسة لعدم النشاط');
      }
    }

    const next = await issueSession(client, {
      userId: session.user_id, employeeId: session.employee_id,
      principalKind: session.principal_kind, branchId: session.branch_id,
      mfaSatisfied: session.mfa_satisfied, meta, familyId: session.family_id,
    });

    await client.query(
      `UPDATE sessions SET rotated_to = $2, revoked_at = now(),
              revoked_reason = 'rotated', last_seen_at = now()
        WHERE id = $1`,
      [session.id, next.sessionId],
    );

      return next;
    });
  } catch (err) {
    const reuseDetected = reuse.detected;
    if (reuseDetected) {
      // Outside the rolled-back transaction, so these writes actually persist.
      await pool.query(
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'token_reuse_detected'
          WHERE family_id = $1 AND revoked_at IS NULL`,
        [reuseDetected.familyId],
      );
      await pool.query(
        `UPDATE sessions SET revoked_reason = 'token_reuse_detected'
          WHERE family_id = $1 AND revoked_reason = 'rotated'`,
        [reuseDetected.familyId],
      );
      await audit({
        action: AUDIT.SESSION_REUSE_DETECTED, actorUserId: reuseDetected.userId,
        branchId: reuseDetected.branchId, metadata: { familyId: reuseDetected.familyId },
        ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
      });
      await createSecurityNotification(reuseDetected.branchId, 'suspicious_login',
        'إعادة استخدام رمز جلسة',
        'تم رصد إعادة استخدام رمز تحديث وتم إنهاء جميع الجلسات المرتبطة.');
    }
    throw err;
  }
}

export async function revokeSession(sessionId: string, reason = 'logout'): Promise<void> {
  await pool.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
      WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, reason],
  );
}

/** Log out every other device — used on password change and on demand. */
export async function revokeOtherSessions(
  userId: string,
  keepSessionId: string | null,
  reason: string,
): Promise<number> {
  const res = await pool.query(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $3
      WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`,
    [userId, keepSessionId, reason],
  );
  return res.rowCount ?? 0;
}

export async function changePassword(
  principal: Principal,
  currentPassword: string,
  newPassword: string,
  logoutOthers: boolean,
  meta: RequestMeta,
): Promise<{ revokedSessions: number }> {
  const user = await one<{ password_hash: string | null; full_name: string }>(
    'SELECT password_hash, full_name FROM users WHERE id = $1',
    [principal.userId],
  );
  if (!user?.password_hash) throw badRequest('لا توجد كلمة مرور لهذا الحساب');
  if (!(await verifySecret(user.password_hash, currentPassword))) {
    throw unauthorized('كلمة المرور الحالية غير صحيحة');
  }
  assertPasswordPolicy(newPassword);

  await pool.query(
    `UPDATE users SET password_hash = $2, password_changed_at = now(),
            must_change_password = FALSE
      WHERE id = $1`,
    [principal.userId, await hashSecret(newPassword)],
  );

  const revoked = logoutOthers
    ? await revokeOtherSessions(principal.userId, principal.sessionId, 'password_changed')
    : 0;

  await audit({
    action: AUDIT.PASSWORD_CHANGED, actorUserId: principal.userId,
    actorLabel: user.full_name, branchId: principal.branchId,
    metadata: { logoutOthers, revoked }, ip: meta.ip, userAgent: meta.userAgent,
    requestId: meta.requestId,
  });
  return { revokedSessions: revoked };
}

/** Password policy. Deliberately blunt and enforced server-side. */
export function assertPasswordPolicy(password: string): void {
  const problems: string[] = [];
  if (password.length < 12) problems.push('12 حرفاً على الأقل');
  if (!/[a-z]/.test(password)) problems.push('حرف صغير');
  if (!/[A-Z]/.test(password)) problems.push('حرف كبير');
  if (!/[0-9]/.test(password)) problems.push('رقم');
  if (!/[^A-Za-z0-9]/.test(password)) problems.push('رمز خاص');
  const common = ['password', '12345678', 'qwerty', 'admin', 'mara', 'welcome'];
  if (common.some((c) => password.toLowerCase().includes(c))) {
    problems.push('لا تستخدم كلمات شائعة');
  }
  if (problems.length) {
    throw badRequest(`كلمة المرور ضعيفة، يجب أن تحتوي على: ${problems.join('، ')}`);
  }
}

export function assertPinPolicy(pin: string): void {
  if (!/^\d{4,6}$/.test(pin)) throw badRequest('الرمز السري يجب أن يكون من 4 إلى 6 أرقام');
  if (/^(\d)\1+$/.test(pin)) throw badRequest('الرمز السري ضعيف جداً');
  const sequences = ['0123', '1234', '2345', '3456', '4567', '5678', '6789', '9876', '4321'];
  if (sequences.some((s) => pin.includes(s))) throw badRequest('الرمز السري ضعيف جداً');
}

export async function setupMfa(userId: string, email: string): Promise<{
  secret: string; uri: string; recoveryCodes: string[];
}> {
  const secret = generateTotpSecret();
  const recoveryCodes = generateRecoveryCodes();
  const hashed = await Promise.all(recoveryCodes.map((c) => hashSecret(c)));
  await pool.query(
    `UPDATE users SET mfa_secret = $2, mfa_recovery_codes = $3::jsonb, mfa_enabled = FALSE
      WHERE id = $1`,
    [userId, encryptSecret(secret), JSON.stringify(hashed)],
  );
  return { secret, uri: totpUri(secret, email, config.auth.mfaIssuer), recoveryCodes };
}

async function recordLoginSuccess(
  userId: string, name: string, branchId: string | null,
  meta: RequestMeta, mfa: boolean, recovery = false,
): Promise<void> {
  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  await audit({
    action: AUDIT.LOGIN_SUCCESS, actorUserId: userId, actorLabel: name,
    branchId, metadata: { mfa, recoveryCodeUsed: recovery },
    ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId,
  });
}

async function createSecurityNotification(
  branchId: string | null, kind: string, title: string, body: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO notifications (branch_id, kind, severity, title_ar, body_ar, target_permissions)
     VALUES ($1,$2,'critical',$3,$4, ARRAY['audit.read'])`,
    [branchId, kind, title, body],
  );
}
