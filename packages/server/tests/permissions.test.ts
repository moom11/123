import { afterAll, describe, expect, it } from 'vitest';
import { auth, closeApp, getApp, getBranchId, loginAdmin, loginEmployee } from './helpers.js';
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

  /**
   * List endpoints scope by branch, but an id-addressed endpoint must scope too
   * — otherwise knowing (or guessing) an id from another branch is enough to
   * read it. This was a real gap before the containment checks were added.
   */
  it('refuses to read another branch\'s order by id', async () => {
    const app = await getApp();
    const waiter = await loginEmployee('1042', '2580');

    const other = await one<{ id: string }>(
      `INSERT INTO branches (code, name, name_ar) VALUES ('XBR','Other','فرع آخر')
       ON CONFLICT (code) DO UPDATE SET name_ar = EXCLUDED.name_ar RETURNING id`,
    );
    const foreignOrder = await one<{ id: string }>(
      `INSERT INTO orders (order_number, branch_id, status, grand_total)
       VALUES ('ORD-8888-000001', $1, 'paid', 50000) RETURNING id`,
      [other!.id],
    );

    const read = await app.inject({
      method: 'GET', url: `/api/orders/${foreignOrder!.id}`, headers: auth(waiter),
    });
    expect(read.statusCode).toBe(403);

    // Writes are refused too, not merely reads.
    const pay = await app.inject({
      method: 'POST', url: `/api/orders/${foreignOrder!.id}/pay`,
      headers: auth(waiter), payload: { parts: [{ method: 'cash', amount: 100 }] },
    });
    expect([403, 404]).toContain(pay.statusCode);
  });

  it('refuses to reach another branch\'s purchase request by id', async () => {
    const app = await getApp();
    const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
    const other = await one<{ id: string }>(
      "SELECT id FROM branches WHERE code = 'XBR'",
    );
    const foreignRequest = await one<{ id: string }>(
      `INSERT INTO purchase_requests (request_number, branch_id, department, status)
       VALUES ('PR-8888-000001', $1, 'BAR', 'pending_branch_manager') RETURNING id`,
      [other!.id],
    );
    const res = await app.inject({
      method: 'GET', url: `/api/purchase-requests/${foreignRequest!.id}`,
      headers: auth(manager),
    });
    expect(res.statusCode).toBe(403);

    // And the manager cannot approve it either.
    const decide = await app.inject({
      method: 'POST', url: `/api/purchase-requests/${foreignRequest!.id}/decide`,
      headers: auth(manager), payload: { decision: 'approve' },
    });
    expect(decide.statusCode).toBe(403);
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

  /**
   * The X-Branch-Id header exists so an owner, who has no home branch, can say
   * which branch a request is about. It must only ever select among branches
   * the caller already has, never add one.
   */
  describe('the branch header selects, it does not grant', () => {
    it('lets an owner work once they name a branch, and not before', async () => {
      const app = await getApp();
      const owner = await loginAdmin('owner@maralounge.sa', 'MaraOwner#2026Xy');
      const branchId = await getBranchId();

      const without = await app.inject({
        method: 'GET', url: '/api/tables', headers: auth(owner),
      });
      expect(without.statusCode).toBe(403);

      const withBranch = await app.inject({
        method: 'GET', url: '/api/tables',
        headers: { ...auth(owner), 'x-branch-id': branchId },
      });
      expect(withBranch.statusCode).toBe(200);
    });

    it('refuses a manager who names a branch that is not theirs', async () => {
      const app = await getApp();
      const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
      const otherBranch = await one<{ id: string }>(
        `INSERT INTO branches (code, name, name_ar) VALUES ('OTHER-02','Other','فرع ثالث')
         ON CONFLICT (code) DO UPDATE SET name_ar = EXCLUDED.name_ar RETURNING id`,
      );

      const res = await app.inject({
        method: 'GET', url: '/api/tables',
        headers: { ...auth(manager), 'x-branch-id': otherBranch!.id },
      });
      expect(res.statusCode).toBe(403);
    });

    it('ignores a malformed header rather than acting on it', async () => {
      const app = await getApp();
      const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
      const res = await app.inject({
        method: 'GET', url: '/api/tables',
        headers: { ...auth(manager), 'x-branch-id': "' OR 1=1 --" },
      });
      // Falls back to the manager's own branch instead of failing or leaking.
      expect(res.statusCode).toBe(200);
    });
  });
});
