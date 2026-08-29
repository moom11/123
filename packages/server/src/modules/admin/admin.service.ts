import { ROLE_ADMIN_ROLES, isAdminRole, isPermission } from '@mara/shared';
import { many, one, pool, withTransaction } from '../../core/db.js';
import { hashSecret } from '../../core/crypto.js';
import { AUDIT, audit } from '../../core/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/errors.js';
import type { Principal } from '../../core/principal.js';
import { assertPasswordPolicy, assertPinPolicy, revokeOtherSessions } from '../auth/auth.service.js';

/**
 * User and employee administration.
 *
 * Two invariants are enforced here and nowhere else can bypass them:
 *   * only Owner / Super Admin may create administrative accounts, assign roles,
 *     or grant permission overrides;
 *   * nobody may raise their own privileges, and a branch manager may not
 *     create or elevate anyone into an administrative role.
 */

function assertRoleAdmin(principal: Principal): void {
  if (!(ROLE_ADMIN_ROLES as readonly string[]).includes(principal.roleCode)) {
    throw forbidden('إنشاء الحسابات الإدارية وتغيير الصلاحيات مقصور على المالك ومدير النظام');
  }
}

export async function createUser(
  principal: Principal,
  input: {
    email?: string | null; password?: string | null; fullName: string;
    phone?: string | null; roleCode: string; branchId?: string | null;
    employeeCode?: string | null; pin?: string | null; jobTitle?: string | null;
    department?: string | null;
  },
): Promise<{ userId: string; employeeId: string | null }> {
  const role = await one<{ id: string; code: string; is_admin: boolean }>(
    'SELECT id, code, is_admin FROM roles WHERE code = $1', [input.roleCode],
  );
  if (!role) throw badRequest('الدور غير معروف');

  // Creating an administrative account, or any account at all, is restricted.
  if (isAdminRole(role.code)) {
    assertRoleAdmin(principal);
    if (!input.email) throw badRequest('البريد الإلكتروني مطلوب للحسابات الإدارية');
    if (!input.password) throw badRequest('كلمة المرور مطلوبة للحسابات الإدارية');
    assertPasswordPolicy(input.password);
  } else if (!principal.permissions.has('employees.create')) {
    throw forbidden('لا تملك صلاحية إنشاء الموظفين');
  }

  // A branch manager may only create staff inside their own branch.
  const branchId = input.branchId ?? principal.branchId;
  if (!branchId && !isAdminRole(role.code)) throw badRequest('الفرع مطلوب');
  if (branchId && principal.allowedBranchIds.length > 0
      && !principal.allowedBranchIds.includes(branchId)) {
    throw forbidden('لا تملك صلاحية على هذا الفرع');
  }

  return withTransaction(async (client) => {
    if (input.email) {
      const dup = await one(
        'SELECT 1 FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL',
        [input.email], client,
      );
      if (dup) throw conflict('البريد الإلكتروني مستخدم بالفعل');
    }

    const user = await one<{ id: string }>(
      `INSERT INTO users (
         email, password_hash, full_name, phone, role_id, branch_id,
         must_change_password, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        input.email ?? null,
        input.password ? await hashSecret(input.password) : null,
        input.fullName, input.phone ?? null, role.id, branchId,
        Boolean(input.password), principal.userId,
      ],
      client,
    );

    if (branchId) {
      await client.query(
        'INSERT INTO user_branches (user_id, branch_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [user!.id, branchId],
      );
    }

    let employeeId: string | null = null;
    // Operational staff also need an employee record to log in with a PIN.
    if (input.employeeCode && input.pin) {
      if (isAdminRole(role.code)) {
        throw badRequest('لا يجوز إعطاء رمز PIN لحساب إداري');
      }
      assertPinPolicy(input.pin);
      const dup = await one(
        'SELECT 1 FROM employees WHERE branch_id = $1 AND employee_code = $2 AND deleted_at IS NULL',
        [branchId, input.employeeCode], client,
      );
      if (dup) throw conflict('رقم الموظف مستخدم بالفعل في هذا الفرع');

      const emp = await one<{ id: string }>(
        `INSERT INTO employees (
           employee_code, user_id, full_name, job_title, department, branch_id,
           role_id, pin_hash, pin_changed_at, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), $9) RETURNING id`,
        [
          input.employeeCode, user!.id, input.fullName,
          input.jobTitle ?? role.code, input.department ?? 'OTHER', branchId,
          role.id, await hashSecret(input.pin), principal.userId,
        ],
        client,
      );
      employeeId = emp!.id;
    }

    await audit({
      action: AUDIT.USER_CREATED, actorUserId: principal.userId,
      actorLabel: principal.displayName, branchId,
      entityType: 'user', entityId: user!.id,
      newValue: {
        fullName: input.fullName, role: role.code, branchId,
        employeeCode: input.employeeCode, hasPassword: Boolean(input.password),
      },
    }, client);

    return { userId: user!.id, employeeId };
  });
}

/** Change someone's role. Owner / Super Admin only, never on yourself. */
export async function assignRole(
  principal: Principal, userId: string, roleCode: string,
): Promise<void> {
  assertRoleAdmin(principal);
  if (userId === principal.userId) {
    throw forbidden('لا يمكنك تغيير دورك بنفسك');
  }

  const role = await one<{ id: string; code: string }>(
    'SELECT id, code FROM roles WHERE code = $1', [roleCode],
  );
  if (!role) throw badRequest('الدور غير معروف');

  const target = await one<{ full_name: string; branch_id: string | null; role_code: string }>(
    `SELECT u.full_name, u.branch_id, r.code AS role_code
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
    [userId],
  );
  if (!target) throw notFound('المستخدم غير موجود');

  await withTransaction(async (client) => {
    await client.query('UPDATE users SET role_id = $2 WHERE id = $1', [userId, role.id]);
    await client.query('UPDATE employees SET role_id = $2 WHERE user_id = $1', [userId, role.id]);

    // A role change alters what every live session may do, so end them.
    await client.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'role_changed'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );

    await audit({
      action: AUDIT.ROLE_ASSIGNED, actorUserId: principal.userId,
      actorLabel: principal.displayName, branchId: target.branch_id,
      entityType: 'user', entityId: userId,
      oldValue: { role: target.role_code },
      newValue: { role: role.code, targetName: target.full_name },
    }, client);
  });
}

/** Grant or deny a single permission on top of the role. */
export async function setPermissionOverride(
  principal: Principal, userId: string, permissionCode: string, granted: boolean | null,
): Promise<void> {
  assertRoleAdmin(principal);
  if (userId === principal.userId) {
    throw forbidden('لا يمكنك تعديل صلاحياتك بنفسك');
  }
  if (!isPermission(permissionCode)) throw badRequest('صلاحية غير معروفة');

  const target = await one<{ full_name: string; branch_id: string | null }>(
    'SELECT full_name, branch_id FROM users WHERE id = $1', [userId],
  );
  if (!target) throw notFound('المستخدم غير موجود');

  if (granted === null) {
    await pool.query(
      'DELETE FROM user_permission_overrides WHERE user_id = $1 AND permission_code = $2',
      [userId, permissionCode],
    );
  } else {
    await pool.query(
      `INSERT INTO user_permission_overrides (user_id, permission_code, granted, granted_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, permission_code)
       DO UPDATE SET granted = EXCLUDED.granted, granted_by = EXCLUDED.granted_by,
                     created_at = now()`,
      [userId, permissionCode, granted, principal.userId],
    );
  }

  await audit({
    action: granted ? AUDIT.PERMISSION_GRANTED : AUDIT.PERMISSION_REVOKED,
    actorUserId: principal.userId, actorLabel: principal.displayName,
    branchId: target.branch_id, entityType: 'user', entityId: userId,
    newValue: { permission: permissionCode, granted, targetName: target.full_name },
  });
}

export async function resetPin(
  principal: Principal, employeeId: string, newPin: string,
): Promise<void> {
  assertPinPolicy(newPin);
  const emp = await one<{ full_name: string; branch_id: string; employee_code: string; role_code: string }>(
    `SELECT e.full_name, e.branch_id, e.employee_code, r.code AS role_code
       FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = $1`,
    [employeeId],
  );
  if (!emp) throw notFound('الموظف غير موجود');
  if (isAdminRole(emp.role_code)) throw badRequest('الحسابات الإدارية لا تستخدم PIN');
  if (principal.allowedBranchIds.length > 0
      && !principal.allowedBranchIds.includes(emp.branch_id)) {
    throw forbidden('لا تملك صلاحية على هذا الفرع');
  }

  await pool.query(
    `UPDATE employees SET pin_hash = $2, pin_changed_at = now(),
            failed_pin_count = 0, locked_until = NULL
      WHERE id = $1`,
    [employeeId, await hashSecret(newPin)],
  );

  await audit({
    action: AUDIT.EMPLOYEE_PIN_RESET, actorUserId: principal.userId,
    actorLabel: principal.displayName, branchId: emp.branch_id,
    entityType: 'employee', entityId: employeeId,
    metadata: { employeeCode: emp.employee_code, employeeName: emp.full_name },
  });
}

export async function setUserActive(
  principal: Principal, userId: string, active: boolean,
): Promise<void> {
  if (userId === principal.userId) throw forbidden('لا يمكنك تعطيل حسابك');

  const target = await one<{ full_name: string; branch_id: string | null; role_code: string }>(
    `SELECT u.full_name, u.branch_id, r.code AS role_code
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
    [userId],
  );
  if (!target) throw notFound('المستخدم غير موجود');
  if (isAdminRole(target.role_code)) assertRoleAdmin(principal);
  else if (!principal.permissions.has('employees.disable')) {
    throw forbidden('لا تملك صلاحية تعطيل الموظفين');
  }

  await pool.query('UPDATE users SET is_active = $2 WHERE id = $1', [userId, active]);
  await pool.query('UPDATE employees SET is_active = $2 WHERE user_id = $1', [userId, active]);
  if (!active) await revokeOtherSessions(userId, null, 'account_disabled');

  await audit({
    action: active ? AUDIT.USER_UPDATED : AUDIT.USER_DISABLED,
    actorUserId: principal.userId, actorLabel: principal.displayName,
    branchId: target.branch_id, entityType: 'user', entityId: userId,
    newValue: { isActive: active, targetName: target.full_name },
  });
}

export async function listUsers(principal: Principal, branchId?: string | null) {
  return many(
    `SELECT u.id, u.email, u.full_name, u.phone, u.is_active, u.mfa_enabled,
            u.last_login_at, u.created_at, r.code AS role, r.name_ar AS role_name,
            b.name_ar AS branch_name, u.branch_id,
            e.id AS employee_id, e.employee_code, e.department, e.job_title,
            (SELECT count(*)::int FROM sessions s
              WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN branches b ON b.id = u.branch_id
       LEFT JOIN employees e ON e.user_id = u.id AND e.deleted_at IS NULL
      WHERE u.deleted_at IS NULL
        AND ($1::uuid IS NULL OR u.branch_id = $1)
        AND ($2::uuid[] IS NULL OR u.branch_id = ANY($2::uuid[]) OR u.branch_id IS NULL)
      ORDER BY r.code, u.full_name`,
    [
      branchId ?? null,
      principal.allowedBranchIds.length > 0 ? principal.allowedBranchIds : null,
    ],
  );
}

export async function listEmployees(branchId: string, includeInactive = false) {
  return many(
    `SELECT e.id, e.employee_code, e.full_name, e.job_title, e.department,
            e.is_active, e.last_login_at, e.hired_at, e.locked_until,
            r.code AS role, r.name_ar AS role_name, e.branch_id
       FROM employees e JOIN roles r ON r.id = e.role_id
      WHERE e.branch_id = $1 AND e.deleted_at IS NULL AND ($2::boolean OR e.is_active)
      ORDER BY e.employee_code`,
    [branchId, includeInactive],
  );
}

export async function getSetting<T = unknown>(
  branchId: string | null, key: string, fallback: T,
): Promise<T> {
  const row = await one<{ value: T }>(
    `SELECT value FROM settings WHERE key = $1 AND (branch_id = $2 OR branch_id IS NULL)
      ORDER BY branch_id NULLS LAST LIMIT 1`,
    [key, branchId],
  );
  return (row?.value ?? fallback) as T;
}

export async function setSetting(
  principal: Principal, branchId: string | null, key: string, value: unknown,
): Promise<void> {
  const before = await one<{ value: unknown }>(
    `SELECT value FROM settings
      WHERE key = $1 AND COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
    [key, branchId],
  );

  await pool.query(
    `INSERT INTO settings (branch_id, key, value, updated_by)
     VALUES ($1,$2,$3::jsonb,$4)
     ON CONFLICT (COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
     DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [branchId, key, JSON.stringify(value), principal.userId],
  );

  await audit({
    action: AUDIT.SETTING_UPDATED, actorUserId: principal.userId,
    actorLabel: principal.displayName, branchId,
    entityType: 'setting', entityId: key,
    oldValue: before?.value ?? null, newValue: value,
  });
}
