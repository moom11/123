import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, requirePermission } from '../../core/http.js';
import { requirePrincipal, resolveBranch } from '../../core/principal.js';
import { ACCOUNT_NAMES_AR, DEFAULT_ACCOUNTS } from './accounts.js';
import {
  invoicesCsv, journal, journalCsv, purchasesCsv, summary,
} from './accounting.service.js';

const periodSchema = z.object({
  branchId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'صيغة التاريخ YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'صيغة التاريخ YYYY-MM-DD'),
});

export async function accountingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounting/summary', { preHandler: requirePermission('accounting.export') },
    async (req) => {
      const principal = requirePrincipal(req);
      const q = parse(periodSchema, req.query);
      return summary(principal, resolveBranch(principal, q.branchId), q);
    });

  app.get('/accounting/journal', { preHandler: requirePermission('accounting.export') },
    async (req) => {
      const principal = requirePrincipal(req);
      const q = parse(periodSchema, req.query);
      return journal(principal, resolveBranch(principal, q.branchId), q);
    });

  /** The chart of accounts in force, so the screen can show what it will write. */
  app.get('/accounting/accounts', { preHandler: requirePermission('accounting.export') },
    async () => ({ defaults: DEFAULT_ACCOUNTS, names: ACCOUNT_NAMES_AR }));

  for (const [path, build, file] of [
    ['journal', journalCsv, 'journal'],
    ['invoices', invoicesCsv, 'invoices'],
    ['purchases', purchasesCsv, 'purchases'],
  ] as const) {
    app.get(`/accounting/${path}.csv`,
      { preHandler: requirePermission('accounting.export') },
      async (req, reply) => {
        const principal = requirePrincipal(req);
        const q = parse(periodSchema, req.query);
        const branchId = resolveBranch(principal, q.branchId);
        const csv = await build(principal, branchId, q);

        // A filename carrying the period, because the first thing that happens
        // to this file is that it joins eleven others in a folder.
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition',
            `attachment; filename="mara-${file}-${q.from}_${q.to}.csv"`)
          .send(csv);
      });
  }
}
