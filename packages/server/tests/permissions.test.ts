import { afterAll, describe, expect, it } from 'vitest';
import { auth, closeApp, getApp, loginAdmin, loginEmployee } from './helpers.js';
import { one, pool } from '../src/core/db.js';

afterAll(closeApp);

/**
 * Authorisation must live in the backend. These tests call the API directly,
 * bypassing any UI, to prove that hiding a button is not what protects an
 * endpoint.
 */
describe('role based access control', () => {
  it('a waiter cannot read financial reports', async () => {
    const app = await getApp();
    const waiter = await loginEmployee('1042', '2580');
    const res = await app.inject({
      method: 'GET', url: '/api/reports/sales', headers: auth(waiter),
    });
    expect(res.statusCode).toBe(403);
  });

  it('a waiter cannot change a product price', async () => {
    const app = await getApp();
    const waiter = await loginEmployee('1042', '2580');
    const product = await one<{ id: string; price: number }>(
      "SELECT id, price FROM products WHERE name_ar = 'شاي'",
    );
    const res = await app.inject({
      method: 'POST', url: `/api/menu/products/${product!.id}/price`,
      headers: auth(waiter), payload: { price: 100 },
    });
    expect(res.statusCode).toBe(403);

    // And the price is genuinely untouched.
    const after = await one<{ price: number }>(
      'SELECT price FROM products WHERE id = $1', [product!.id],
    );
    expect(after!.price).toBe(product!.price);
  });

  it('a waiter cannot apply a manual discount', async () => {
    const app = await getApp();
    const waiter = await loginEmployee('1042', '2580');
    const res = await app.inject({
      method: 'POST', url: '/api/orders/00000000-0000-0000-0000-000000000001/discount/manual',
      headers: auth(waiter), payload: { amount: 5000, reason: 'trying it on' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a bar employee cannot use the POS or read customers', async () => {
    const app = await getApp();
    const bar = await loginEmployee('3001', '7192');

    const pos = await app.inject({
      method: 'POST', url: '/api/orders', headers: auth(bar),
      payload: { lines: [{ productId: '00000000-0000-0000-0000-000000000001', quantity: 1 }] },
    });
    expect(pos.statusCode).toBe(403);

    const customers = await app.inject({
      method: 'GET', url: '/api/customers/search?term=khalid', headers: auth(bar),
    });
    expect(customers.statusCode).toBe(403);
  });

  it('a branch manager cannot escalate their own privileges', async () => {
    const app = await getApp();
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const managerUser = await one<{ id: string }>(
      "SELECT id FROM users WHERE lower(email) = 'manager@maralounge.sa'",
    );

    // Try to make themselves an owner.
    const promote = await app.inject({
      method: 'POST', url: `/api/admin/users/${managerUser!.id}/role`,
      headers: auth(manager), payload: { roleCode: 'owner' },
    });
    expect(promote.statusCode).toBe(403);

    // Try to grant themselves a permission directly.
    const grant = await app.inject({
      method: 'POST', url: `/api/admin/users/${managerUser!.id}/permissions`,
      headers: auth(manager),
      payload: { permission: 'reports.all_branches', granted: true },
    });
    expect(grant.statusCode).toBe(403);

    // The role really is unchanged.
    const role = await one<{ code: string }>(
      `SELECT r.code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
      [managerUser!.id],
    );
    expect(role!.code).toBe('branch_manager');
  });

  it('a branch manager cannot promote another user to an admin role', async () => {
    const app = await getApp();
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const waiterUser = await one<{ user_id: string }>(
      "SELECT user_id FROM employees WHERE employee_code = '1042'",
    );
    const res = await app.inject({
      method: 'POST', url: `/api/admin/users/${waiterUser!.user_id}/role`,
      headers: auth(manager), payload: { roleCode: 'super_admin' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('an owner CAN assign roles', async () => {
    const app = await getApp();
    const owner = await loginAdmin('owner@maralounge.sa', 'MaraOwner#2026Xy');
    const target = await one<{ user_id: string }>(
      "SELECT user_id FROM employees WHERE employee_code = '3004'",
    );
    const res = await app.inject({
      method: 'POST', url: `/api/admin/users/${target!.user_id}/role`,
      headers: auth(owner), payload: { roleCode: 'floor_staff' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('an owner cannot change their own role either', async () => {
    const app = await getApp();
    const owner = await loginAdmin('owner@maralounge.sa', 'MaraOwner#2026Xy');
    const ownerUser = await one<{ id: string }>(
      "SELECT id FROM users WHERE lower(email) = 'owner@maralounge.sa'",
    );
    const res = await app.inject({
      method: 'POST', url: `/api/admin/users/${ownerUser!.id}/role`,
      headers: auth(owner), payload: { roleCode: 'cashier' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('the buyer cannot reach the POS, customers or financial reports', async () => {
    const app = await getApp();
    const buyer = await loginEmployee('4001', '3648');

    for (const [method, url] of [
      ['GET', '/api/customers/search?term=khalid'],
      ['GET', '/api/reports/sales'],
      ['GET', '/api/reports/financial'],
      ['GET', '/api/tables'],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth(buyer) });
      expect([403, 404]).toContain(res.statusCode);
    }
  });

  it('effective permissions honour a per-user deny override', async () => {
    const { loadPermissions } = await import('../src/modules/auth/auth.service.js');
    const cashier = await one<{ user_id: string }>(
      "SELECT user_id FROM employees WHERE employee_code = '2001'",
    );
    const before = await loadPermissions(cashier!.user_id);
    expect(before.has('payments.take')).toBe(true);

    await pool.query(
      `INSERT INTO user_permission_overrides (user_id, permission_code, granted)
       VALUES ($1,'payments.take',FALSE)
       ON CONFLICT (user_id, permission_code) DO UPDATE SET granted = FALSE`,
      [cashier!.user_id],
    );
    const after = await loadPermissions(cashier!.user_id);
    expect(after.has('payments.take')).toBe(false);

    await pool.query(
      'DELETE FROM user_permission_overrides WHERE user_id = $1', [cashier!.user_id],
    );
  });

  it('confines a principal to their own branch', async () => {
    const app = await getApp();
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const otherBranch = await one<{ id: string }>(
      `INSERT INTO branches (code, name, name_ar) VALUES ('OTHER-01','Other','فرع آخر')
       ON CONFLICT (code) DO UPDATE SET name_ar = EXCLUDED.name_ar RETURNING id`,
    );
    const res = await app.inject({
      method: 'GET', url: `/api/tables?branchId=${otherBranch!.id}`, headers: auth(manager),
    });
    expect(res.statusCode).toBe(403);
  });
});
