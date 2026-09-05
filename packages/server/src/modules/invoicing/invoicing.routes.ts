import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, requirePermission } from '../../core/http.js';
import { requirePrincipal, resolveBranch } from '../../core/principal.js';
import {
  getInvoice, listInvoices, onboardDevice, provisionCredentials, reportPending,
  storeCertificate, verifyChain,
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

  // --- ZATCA onboarding, per device ----------------------------------------
  //
  // The order is fixed and each step gates the next: CSR, then the compliance
  // and production CSIDs. A device that stops halfway can sign and print, and
  // every one of those invoices is worthless — so the step reached is stored
  // and preflight refuses to open on anything below production.

  app.get('/invoices/credentials',
    { preHandler: requirePermission('invoices.manage_credentials') }, async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
      const branchId = resolveBranch(p, q.branchId);
      const { many } = await import('../../core/db.js');
      // Deliberately never selects private_key_enc. There is no endpoint that
      // returns the stamping key, by design.
      const rows = await many(
        `SELECT z.device_id, d.label AS device_label, d.serial_number,
                z.environment, z.onboarding_step, z.egs_serial, z.is_production,
                z.certificate IS NOT NULL AS has_certificate,
                z.csr IS NOT NULL AS has_csr,
                z.onboarded_at, z.expires_at
           FROM zatca_credentials z JOIN devices d ON d.id = z.device_id
          WHERE z.branch_id = $1 AND d.deleted_at IS NULL
          ORDER BY d.label`,
        [branchId],
      );
      return { credentials: rows };
    });

  /** Step 0: generate the key (once) and build the certificate request. */
  app.post('/devices/:id/zatca/csr',
    { preHandler: requirePermission('invoices.manage_credentials') }, async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const body = parse(z.object({
        environment: z.enum(['sandbox', 'simulation', 'production']).default('sandbox'),
      }), req.body ?? {});
      return provisionCredentials(p, id, body);
    });

  /**
   * Steps 1-3: exchange the CSR for a compliance CSID and then a production
   * one. The OTP comes from the taxpayer's Fatoora portal, lives for minutes,
   * and is never stored.
   */
  app.post('/devices/:id/zatca/onboard',
    { preHandler: requirePermission('invoices.manage_credentials') }, async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const { otp } = parse(z.object({
        otp: z.string().min(4, 'أدخل رمز التحقق من بوابة فاتورة').max(20),
      }), req.body);
      return onboardDevice(p, id, otp);
    });

  /** Escape hatch: a CSID obtained out of band. */
  app.post('/devices/:id/zatca/certificate',
    { preHandler: requirePermission('invoices.manage_credentials') }, async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const body = parse(z.object({
        certificate: z.string().min(20, 'الصق شهادة CSID كما أعادتها الهيئة'),
        secret: z.string().min(1).optional(),
        isProduction: z.boolean().default(false),
      }), req.body);
      await storeCertificate(p, id, body);
      return { ok: true };
    });
}
