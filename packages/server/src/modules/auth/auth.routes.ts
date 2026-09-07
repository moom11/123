import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ROLE_LABELS_AR } from '@mara/shared';
import { many, one, pool } from '../../core/db.js';
import { meta, parse, requireAuth, requirePermission } from '../../core/http.js';
import { requirePrincipal } from '../../core/principal.js';
import { AUDIT, audit } from '../../core/audit.js';
import { badRequest, notFound } from '../../core/errors.js';
import {
  adminLogin, changePassword, completeMfa, employeeLogin, refreshSession,
  revokeOtherSessions, revokeSession, setupMfa,
} from './auth.service.js';

const loginSchema = z.object({
  email: z.string().email('بريد إلكتروني غير صالح'),
  password: z.string().min(1, 'كلمة المرور مطلوبة'),
});

const mfaSchema = z.object({
  mfaToken: z.string().min(10),
  code: z.string().min(6).max(12),
});

const pinLoginSchema = z.object({
  branchId: z.string().uuid(),
  employeeCode: z.string().min(1).max(20),
  pin: z.string().min(4).max(6).regex(/^\d+$/, 'الرمز السري أرقام فقط'),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** Branch list for the login screen. Public: it exposes only names. */
  app.get('/auth/branches', async () => {
    const branches = await many(
      `SELECT id, code, name_ar AS name FROM branches WHERE is_active ORDER BY name_ar`,
    );
    return { branches };
  });

  app.post('/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  }, async (req) => {
    const body = parse(loginSchema, req.body);
    return adminLogin(body.email, body.password, meta(req));
  });

  app.post('/auth/mfa/verify', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  }, async (req) => {
    const body = parse(mfaSchema, req.body);
    const tokens = await completeMfa(body.mfaToken, body.code, meta(req));
    return { status: 'ok', tokens };
  });

  app.post('/auth/employee/login', {
    config: { rateLimit: { max: 20, timeWindow: '5 minutes' } },
  }, async (req) => {
    const body = parse(pinLoginSchema, req.body);
    return employeeLogin(body.branchId, body.employeeCode, body.pin, meta(req));
  });

  app.post('/auth/refresh', async (req) => {
    const { refreshToken } = parse(
      z.object({ refreshToken: z.string().min(10) }), req.body,
    );
    const tokens = await refreshSession(refreshToken, meta(req));
    return { tokens };
  });

  app.post('/auth/logout', { preHandler: requireAuth }, async (req) => {
    const p = requirePrincipal(req);
    await revokeSession(p.sessionId, 'logout');
    await audit({
      action: AUDIT.LOGOUT, actorUserId: p.userId, actorEmployeeId: p.employeeId,
      actorLabel: p.displayName, branchId: p.branchId, ...meta(req),
    });
    return { ok: true };
  });

  /** Who am I — the frontend renders its navigation from exactly this. */
  app.get('/auth/me', { preHandler: requireAuth }, async (req) => {
    const p = requirePrincipal(req);
    const branch = p.branchId
      ? await one('SELECT id, code, name_ar AS name, vat_percent FROM branches WHERE id = $1',
          [p.branchId])
      : null;
    return {
      user: {
        id: p.userId,
        name: p.displayName,
        role: p.roleCode,
        roleLabel: ROLE_LABELS_AR[p.roleCode as keyof typeof ROLE_LABELS_AR] ?? p.roleCode,
        isAdmin: p.isAdminRole,
        employeeId: p.employeeId,
        employeeCode: p.employeeCode,
        department: p.department,
        branchId: p.branchId,
        allowedBranchIds: p.allowedBranchIds,
        mfaSatisfied: p.mfaSatisfied,
      },
      branch,
      permissions: [...p.permissions].sort(),
    };
  });

  app.post('/auth/password', { preHandler: requireAuth }, async (req) => {
    const p = requirePrincipal(req);
    const body = parse(z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(12),
      logoutOtherDevices: z.boolean().default(true),
    }), req.body);
    return changePassword(
      p, body.currentPassword, body.newPassword, body.logoutOtherDevices, meta(req),
    );
  });

  /** Active sessions for the current user, so devices can be reviewed. */
  app.get('/auth/sessions', { preHandler: requireAuth }, async (req) => {
    const p = requirePrincipal(req);
    const sessions = await many(
      `SELECT id, principal_kind, device_label, ip, user_agent, mfa_satisfied,
              created_at, last_seen_at, expires_at,
              (id = $2) AS is_current
         FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY last_seen_at DESC`,
      [p.userId, p.sessionId],
    );
    return { sessions };
  });

  app.post('/auth/sessions/revoke-others', { preHandler: requireAuth }, async (req) => {
    const p = requirePrincipal(req);
    const revoked = await revokeOtherSessions(p.userId, p.sessionId, 'user_requested');
    await audit({
      action: AUDIT.SESSION_REVOKED, actorUserId: p.userId, actorLabel: p.displayName,
      branchId: p.branchId, metadata: { revoked, scope: 'others' }, ...meta(req),
    });
    return { revoked };
  });

  /** Administrators may force-close another user's sessions. */
  app.post('/auth/sessions/:userId/revoke-all', {
    preHandler: requirePermission('admin.sessions.revoke'),
  }, async (req) => {
    const p = requirePrincipal(req);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), req.params);
    const target = await one<{ full_name: string }>(
      'SELECT full_name FROM users WHERE id = $1', [userId],
    );
    if (!target) throw notFound('المستخدم غير موجود');
    const revoked = await revokeOtherSessions(userId, null, 'admin_revoked');
    await audit({
      action: AUDIT.SESSION_REVOKED, actorUserId: p.userId, actorLabel: p.displayName,
      branchId: p.branchId, entityType: 'user', entityId: userId,
      metadata: { revoked, target: target.full_name }, ...meta(req),
    });
    return { revoked };
  });

  // --- MFA management -------------------------------------------------------
  app.post('/auth/mfa/setup', { preHandler: requireAuth }, async (req) => {
    const p = requirePrincipal(req);
    const user = await one<{ email: string | null }>(
      'SELECT email FROM users WHERE id = $1', [p.userId],
    );
    if (!user?.email) throw badRequest('التحقق الثنائي متاح للحسابات الإدارية فقط');
    return setupMfa(p.userId, user.email);
  });

  /** Confirm enrolment with a live code from the authenticator. */
  app.post('/auth/mfa/confirm', { preHandler: requireAuth }, async (req) => {
    const p = requirePrincipal(req);
    const { code } = parse(z.object({ code: z.string().min(6).max(8) }), req.body);
    const { decryptSecret } = await import('../../core/crypto.js');
    const { verifyTotp } = await import('../../core/totp.js');
    const row = await one<{ mfa_secret: string | null }>(
      'SELECT mfa_secret FROM users WHERE id = $1', [p.userId],
    );
    if (!row?.mfa_secret) throw badRequest('ابدأ إعداد التحقق الثنائي أولاً');
    if (!verifyTotp(decryptSecret(row.mfa_secret), code)) {
      throw badRequest('رمز التحقق غير صحيح');
    }
    await pool.query(
      'UPDATE users SET mfa_enabled = TRUE, mfa_confirmed_at = now() WHERE id = $1',
      [p.userId],
    );
    await audit({
      action: AUDIT.MFA_ENROLLED, actorUserId: p.userId, actorLabel: p.displayName,
      branchId: p.branchId, ...meta(req),
    });
    return { ok: true, mfaEnabled: true };
  });
}
