import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS, ROLE_LABELS_AR } from '@mara/shared';
import { many, one } from '../../core/db.js';
import { parse, requirePermission } from '../../core/http.js';
import { requirePrincipal, resolveBranch } from '../../core/principal.js';
import {
  assignRole, createUser, listEmployees, listUsers, resetPin,
  setPermissionOverride, setSetting, setUserActive,
} from './admin.service.js';

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/users', { preHandler: requirePermission('admin.users.read') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
      return { users: await listUsers(p, q.branchId ?? null) };
    });

  app.post('/admin/users', { preHandler: requirePermission('admin.users.create', 'employees.create') },
    async (req) => {
      const p = requirePrincipal(req);
      const body = parse(z.object({
        email: z.string().email().nullish(),
        password: z.string().min(12).nullish(),
        fullName: z.string().min(2).max(120),
        phone: z.string().max(30).nullish(),
        roleCode: z.string().min(2),
        branchId: z.string().uuid().nullish(),
        employeeCode: z.string().max(20).nullish(),
        pin: z.string().regex(/^\d{4,6}$/).nullish(),
        jobTitle: z.string().max(100).nullish(),
        department: z.enum(['BAR', 'KITCHEN', 'SHISHA', 'FLOOR', 'ADMIN', 'OTHER']).nullish(),
      }), req.body);
      return createUser(p, body);
    });

  /** Owner / Super Admin only — enforced again inside the service. */
  app.post('/admin/users/:id/role', { preHandler: requirePermission('admin.roles.assign') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const { roleCode } = parse(z.object({ roleCode: z.string().min(2) }), req.body);
      await assignRole(p, id, roleCode);
      return { ok: true };
    });

  app.post('/admin/users/:id/permissions', {
    preHandler: requirePermission('admin.permissions.grant'),
  }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({
      permission: z.string().min(3),
      granted: z.boolean().nullable(),
    }), req.body);
    await setPermissionOverride(p, id, body.permission, body.granted);
    return { ok: true };
  });

  app.post('/admin/users/:id/active', { preHandler: requirePermission('admin.users.disable', 'employees.disable') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const { active } = parse(z.object({ active: z.boolean() }), req.body);
      await setUserActive(p, id, active);
      return { ok: true };
    });

  app.get('/admin/roles', { preHandler: requirePermission('admin.roles.read') }, async () => {
    const roles = await many<any>(
      `SELECT r.id, r.code, r.name_ar AS name, r.is_admin,
              (SELECT count(*)::int FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_count,
              (SELECT count(*)::int FROM users u WHERE u.role_id = r.id AND u.deleted_at IS NULL) AS user_count
         FROM roles r ORDER BY r.is_admin DESC, r.code`,
    );
    return { roles, labels: ROLE_LABELS_AR };
  });

  app.get('/admin/permissions', { preHandler: requirePermission('admin.roles.read') },
    async () => ({ permissions: PERMISSIONS }));

  app.get('/admin/employees', { preHandler: requirePermission('employees.read') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({
        branchId: z.string().uuid().optional(),
        includeInactive: z.coerce.boolean().default(false),
      }), req.query);
      return {
        employees: await listEmployees(resolveBranch(p, q.branchId), q.includeInactive),
      };
    });

  app.post('/admin/employees/:id/pin', { preHandler: requirePermission('employees.pin.reset') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const { pin } = parse(z.object({ pin: z.string().regex(/^\d{4,6}$/) }), req.body);
      await resetPin(p, id, pin);
      return { ok: true };
    });

  app.get('/admin/branches', { preHandler: requirePermission('admin.branches.read') },
    async (req) => {
      const p = requirePrincipal(req);
      return {
        branches: await many(
          `SELECT id, code, name_ar AS name, address, phone, vat_number, vat_percent,
                  timezone, currency, is_active
             FROM branches
            WHERE ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
            ORDER BY name_ar`,
          [p.allowedBranchIds.length > 0 ? p.allowedBranchIds : null],
        ),
      };
    });

  app.get('/admin/settings', { preHandler: requirePermission('admin.settings.read') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
      return {
        settings: await many(
          `SELECT key, value, updated_at FROM settings
            WHERE branch_id = $1 OR branch_id IS NULL ORDER BY key`,
          [q.branchId ?? p.branchId],
        ),
      };
    });

  app.post('/admin/settings', { preHandler: requirePermission('admin.settings.update') },
    async (req) => {
      const p = requirePrincipal(req);
      const body = parse(z.object({
        branchId: z.string().uuid().nullish(),
        key: z.string().min(2).max(100),
        value: z.unknown(),
      }), req.body);
      await setSetting(p, body.branchId ?? p.branchId, body.key, body.value);
      return { ok: true };
    });
}
