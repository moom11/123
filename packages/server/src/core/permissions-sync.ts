/**
 * Push the role/permission matrix from the shared package into the database.
 *
 * This has to run on every deploy, not only on a fresh install. The matrix
 * lives in code — that is deliberate, because a permission is part of the
 * program's meaning and not a row someone edits at 2am — but the database is
 * what `requirePermission` actually reads. An upgrade that adds a permission
 * and does not run this ships a screen nobody can open, with no error to
 * explain why: the code grants it, the database has never heard of it.
 *
 * Idempotent, and safe on a live branch: it re-syncs role grants only.
 * Per-user overrides live in `user_permission_overrides` and are not touched,
 * so an individual grant somebody was given by hand survives a deploy.
 */
import { ROLE_LABELS_AR, ROLE_PERMISSIONS, ROLES, PERMISSIONS, isAdminRole } from '@mara/shared';
import { one, pool } from './db.js';

export async function syncRolesAndPermissions(
  log: (m: string) => void = () => {},
): Promise<Map<string, string>> {
  for (const code of PERMISSIONS) {
    await pool.query(
      'INSERT INTO permissions (code) VALUES ($1) ON CONFLICT (code) DO NOTHING',
      [code],
    );
  }

  const roleIds = new Map<string, string>();
  for (const code of ROLES) {
    const row = await one<{ id: string }>(
      `INSERT INTO roles (code, name_ar, is_admin)
       VALUES ($1,$2,$3)
       ON CONFLICT (code) DO UPDATE SET name_ar = EXCLUDED.name_ar, is_admin = EXCLUDED.is_admin
       RETURNING id`,
      [code, ROLE_LABELS_AR[code], isAdminRole(code)],
    );
    roleIds.set(code, row!.id);

    // Re-sync the role's grants so a code change to the matrix takes effect.
    await pool.query('DELETE FROM role_permissions WHERE role_id = $1', [row!.id]);
    for (const perm of ROLE_PERMISSIONS[code]) {
      await pool.query(
        'INSERT INTO role_permissions (role_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [row!.id, perm],
      );
    }
  }
  log(`roles: ${roleIds.size}, permissions: ${PERMISSIONS.length}`);
  return roleIds;
}

/** `npm run sync-permissions` — run after every migration, on every deploy. */
if (process.argv[1]?.endsWith('permissions-sync.ts')
    || process.argv[1]?.endsWith('permissions-sync.js')) {
  const { closePool } = await import('./db.js');
  await syncRolesAndPermissions((m) => console.log(`  ${m}`));
  await closePool();
}
