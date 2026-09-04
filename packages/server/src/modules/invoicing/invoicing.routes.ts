import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, requirePermission } from '../../core/http.js';
import { requirePrincipal, resolveBranch } from '../../core/principal.js';
import {
  getInvoice, listInvoices, provisionCredentials, reportPending, storeCertificate,
  verifyChain,
} from './invoicing.service.js';
import { issueCreditNote } from './credit-note.service.js';

export async function invoicingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/invoices', { preHandler: requirePermission('invoices.read') }, async (req) => {
    const p = requirePrincipal(req);
    const q = parse(z.object({
      branchId: z.string().uuid().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      status: z.enum(['pending', 'reported', 'warning', 'failed']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }), req.query);
    return { invoices: await listInvoices(p, resolveBranch(p, q.branchId), q) };
  });

  /**
   * The full document, XML included. This is what an auditor asks for, so it
   * returns exactly what was reported rather than regenerating anything.
   */
  app.get('/invoices/:id', { preHandler: requirePermission('invoices.read') }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const invoice = await getInvoice(p, id);
    return { invoice };
  });

  /**
   * Prove the chain has no gaps. Cheap enough to run on demand and the fastest
   * way to catch a database restored from a stale backup.
   */
  app.get('/invoices/chain/verify', { preHandler: requirePermission('invoices.read') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
      return verifyChain(p, resolveBranch(p, q.branchId));
    });

  /** Flush the reporting queue now instead of waiting for the cron. */
  app.post('/invoices/report', { preHandler: requirePermission('invoices.report') },
    async (req) => {
      const p = requirePrincipal(req);
      const body = parse(z.object({
        branchId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }), req.body ?? {});
      return reportPending(resolveBranch(p, body.branchId), body.limit);
    });

  /**
   * Correct a settled invoice. Never an edit: a credit note that references the
   * original, which is the only correction ZATCA accepts and the only one that
   * leaves the original readable.
   */
  app.post('/invoices/:id/credit-note',
    { preHandler: requirePermission('invoices.credit_note') }, async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const body = parse(z.object({
        reason: z.string().min(3, 'اذكر سبب الإشعار الدائن').max(500),
      }), req.body);
      return issueCreditNote(p, id, body.reason);
    });

  // --- Credentials ----------------------------------------------------------

  app.get('/invoices/credentials',
    { preHandler: requirePermission('invoices.manage_credentials') }, async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
      const branchId = resolveBranch(p, q.branchId);
      const { one } = await import('../../core/db.js');
      // Deliberately never selects private_key_enc. There is no endpoint that
      // returns the stamping key, by design.
      const row = await one(
        `SELECT branch_id, environment, public_key_der, certificate IS NOT NULL AS has_certificate,
                certificate_serial, is_production, onboarded_at, expires_at
           FROM zatca_credentials WHERE branch_id = $1`,
        [branchId],
      );
      return { credentials: row ?? null };
    });

  app.post('/invoices/credentials',
    { preHandler: requirePermission('invoices.manage_credentials') }, async (req) => {
      const p = requirePrincipal(req);
      const body = parse(z.object({
        branchId: z.string().uuid().optional(),
        environment: z.enum(['sandbox', 'simulation', 'production']).default('sandbox'),
      }), req.body ?? {});
      return provisionCredentials(p, resolveBranch(p, body.branchId), body);
    });

  app.post('/invoices/credentials/certificate',
    { preHandler: requirePermission('invoices.manage_credentials') }, async (req) => {
      const p = requirePrincipal(req);
      const body = parse(z.object({
        branchId: z.string().uuid().optional(),
        certificate: z.string().min(20, 'الصق شهادة CSID كما أعادتها الهيئة'),
        secret: z.string().min(1).optional(),
        isProduction: z.boolean().default(false),
      }), req.body);
      await storeCertificate(p, resolveBranch(p, body.branchId), body);
      return { ok: true };
    });
}
