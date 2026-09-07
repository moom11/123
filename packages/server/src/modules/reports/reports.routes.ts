import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, requirePermission } from '../../core/http.js';
import { requirePrincipal, resolveBranch } from '../../core/principal.js';
import {
  branchDashboard, customerReport, employeeReport, inventoryReport,
  ownerDashboard, productReport, purchasingReport, salesReport,
} from './reports.service.js';

const rangeSchema = z.object({
  branchId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dashboard/branch', { preHandler: requirePermission('reports.sales') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
      return branchDashboard(resolveBranch(p, q.branchId));
    });

  /** Cross-branch view. Gated on its own permission, which only owners hold. */
  app.get('/dashboard/owner', { preHandler: requirePermission('reports.all_branches') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(rangeSchema, req.query);
      return ownerDashboard({
        from: q.from, to: q.to,
        // A user restricted to certain branches still only sees those.
        branchIds: p.allowedBranchIds.length > 0 ? p.allowedBranchIds : undefined,
      });
    });

  app.get('/reports/sales', { preHandler: requirePermission('reports.sales') }, async (req) => {
    const p = requirePrincipal(req);
    const q = parse(rangeSchema, req.query);
    return salesReport(resolveBranch(p, q.branchId), q);
  });

  app.get('/reports/products', { preHandler: requirePermission('reports.products') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(rangeSchema, req.query);
      return productReport(resolveBranch(p, q.branchId), q);
    });

  app.get('/reports/employees', { preHandler: requirePermission('reports.employees') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(rangeSchema, req.query);
      return { employees: await employeeReport(resolveBranch(p, q.branchId), q) };
    });

  app.get('/reports/customers', { preHandler: requirePermission('reports.customers') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(rangeSchema, req.query);
      return customerReport(resolveBranch(p, q.branchId), q);
    });

  app.get('/reports/inventory', { preHandler: requirePermission('reports.inventory') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(rangeSchema, req.query);
      return inventoryReport(resolveBranch(p, q.branchId), q);
    });

  app.get('/reports/purchasing', { preHandler: requirePermission('reports.purchasing') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(rangeSchema, req.query);
      return purchasingReport(resolveBranch(p, q.branchId), q);
    });
}
