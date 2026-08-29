import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, pool } from '../../core/db.js';
import { parse, requirePermission } from '../../core/http.js';
import { requirePrincipal, resolveBranch } from '../../core/principal.js';
import {
  buyerAdvanceStatus, buyerShoppingList, createPurchaseRequest, decidePurchaseRequest,
  getPurchaseRequest, listBuyerRequests, listPurchaseRequests, receiveDelivery,
  recordPurchase, requestQuantityChange, submitPurchaseRequest,
} from './purchasing.service.js';
import { itemPriceHistory, listSuppliers, upsertSupplier } from './suppliers.service.js';
import { config } from '../../core/config.js';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const unitEnum = z.enum(['kg', 'g', 'l', 'ml', 'piece', 'box', 'carton', 'pack']);

export async function purchasingRoutes(app: FastifyInstance): Promise<void> {
  // --- Requests (departments + managers) -----------------------------------
  app.post('/purchase-requests', {
    preHandler: requirePermission('purchase_requests.create'),
  }, async (req) => {
    const p = requirePrincipal(req);
    const body = parse(z.object({
      branchId: z.string().uuid().optional(),
      department: z.enum(['BAR', 'KITCHEN', 'SHISHA', 'FLOOR', 'OTHER']),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      reason: z.string().max(500).nullish(),
      notes: z.string().max(1000).nullish(),
      neededBy: z.string().nullish(),
      submit: z.boolean().default(true),
      items: z.array(z.object({
        itemId: z.string().uuid(),
        quantity: z.number().positive(),
        unit: unitEnum,
        reason: z.string().max(300).nullish(),
        notes: z.string().max(300).nullish(),
        supplierId: z.string().uuid().nullish(),
      })).min(1),
    }), req.body);
    return createPurchaseRequest(p, { ...body, branchId: resolveBranch(p, body.branchId) });
  });

  app.get('/purchase-requests', {
    preHandler: requirePermission(
      'purchase_requests.read.own_department',
      'purchase_requests.read.branch',
      'purchase_requests.read.all',
    ),
  }, async (req) => {
    const p = requirePrincipal(req);
    const q = parse(z.object({
      branchId: z.string().uuid().optional(),
      status: z.string().optional(),
      department: z.string().optional(),
    }), req.query);
    return {
      requests: await listPurchaseRequests(p, {
        branchId: resolveBranch(p, q.branchId),
        status: q.status, department: q.department,
      }),
    };
  });

  app.get('/purchase-requests/:id', {
    preHandler: requirePermission(
      'purchase_requests.read.own_department',
      'purchase_requests.read.branch',
      'purchase_requests.read.all',
      'purchasing.buyer',
    ),
  }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    return { request: await getPurchaseRequest(p, id) };
  });

  app.post('/purchase-requests/:id/submit', {
    preHandler: requirePermission('purchase_requests.create'),
  }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    await submitPurchaseRequest(p, id);
    return { ok: true };
  });

  /** Branch-manager decision. The gate that reveals a request to the buyer. */
  app.post('/purchase-requests/:id/decide', {
    preHandler: requirePermission('purchase_requests.approve'),
  }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({
      decision: z.enum(['approve', 'reject']),
      comment: z.string().max(1000).nullish(),
      itemQuantities: z.array(z.object({
        itemId: z.string().uuid(),
        approvedQuantity: z.number().min(0),
        unit: unitEnum.optional(),
        note: z.string().max(300).optional(),
      })).optional(),
    }), req.body);
    return decidePurchaseRequest(p, id, body);
  });

  // --- Buyer surface (MARA Buyer Android app) ------------------------------
  /** Only approved-and-beyond requests are reachable through these routes. */
  app.get('/buyer/requests', { preHandler: requirePermission('purchasing.buyer') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({
        branchId: z.string().uuid().optional(),
        status: z.string().optional(),
      }), req.query);
      return {
        requests: await listBuyerRequests(p, {
          branchId: q.branchId ?? p.branchId, status: q.status,
        }),
      };
    });

  app.get('/buyer/shopping-list', { preHandler: requirePermission('purchasing.buyer') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
      return { items: await buyerShoppingList(p, q.branchId ?? p.branchId) };
    });

  /** The buyer home screen counters. */
  app.get('/buyer/summary', { preHandler: requirePermission('purchasing.buyer') },
    async (req) => {
      const p = requirePrincipal(req);
      const branchId = p.branchId;
      const summary = await pool.query(
        `SELECT
           count(*) FILTER (WHERE status IN ('approved','sent_to_buyer'))::int AS to_start,
           count(*) FILTER (WHERE status = 'purchasing')::int AS in_progress,
           count(*) FILTER (WHERE status = 'purchased')::int AS purchased,
           count(*) FILTER (WHERE status = 'in_transit')::int AS in_transit,
           count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
           count(*) FILTER (WHERE priority = 'urgent'
             AND status IN ('approved','sent_to_buyer','purchasing'))::int AS urgent,
           count(*) FILTER (WHERE approved_at::date = now()::date)::int AS approved_today
         FROM buyer_purchase_requests
         WHERE ($1::uuid IS NULL OR branch_id = $1)`,
        [branchId],
      );
      const itemCount = await pool.query(
        `SELECT count(*)::int AS items FROM buyer_purchase_request_items i
           JOIN buyer_purchase_requests r ON r.id = i.request_id
          WHERE r.status IN ('approved','sent_to_buyer','purchasing')
            AND ($1::uuid IS NULL OR r.branch_id = $1)`,
        [branchId],
      );
      return { ...summary.rows[0], itemCount: itemCount.rows[0].items };
    });

  app.post('/buyer/requests/:id/status', { preHandler: requirePermission('purchasing.buyer') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const { status } = parse(z.object({
        status: z.enum(['purchasing', 'purchased', 'in_transit', 'delivered']),
      }), req.body);
      return buyerAdvanceStatus(p, id, status);
    });

  app.post('/buyer/requests/:id/purchase', { preHandler: requirePermission('purchasing.buyer') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const body = parse(z.object({
        supplierId: z.string().uuid().nullish(),
        invoiceNumber: z.string().max(60).nullish(),
        invoiceDate: z.string().nullish(),
        notes: z.string().max(500).nullish(),
        clientRef: z.string().max(100).nullish(),
        items: z.array(z.object({
          itemId: z.string().uuid(),
          quantity: z.number().positive(),
          unit: unitEnum,
          unitPrice: z.number().int().min(0),
          supplierId: z.string().uuid().nullish(),
        })).min(1),
      }), req.body);
      return recordPurchase(p, { requestId: id, ...body });
    });

  /** The buyer cannot raise a quantity — this asks the manager to. */
  app.post('/buyer/requests/:id/request-change', {
    preHandler: requirePermission('purchasing.buyer'),
  }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({
      changes: z.array(z.object({
        itemId: z.string().uuid(),
        requestedQuantity: z.number().positive(),
        unit: unitEnum.optional(),
        reason: z.string().min(1).max(500),
      })).min(1),
    }), req.body);
    await requestQuantityChange(p, id, body.changes);
    return { ok: true };
  });

  /** Invoice photograph upload. Stored with a checksum; OCR-ready. */
  app.post('/buyer/purchases/:id/invoice', {
    preHandler: requirePermission('purchasing.buyer'),
  }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const file = await req.file();
    if (!file) return { error: 'no file' };

    const buffer = await file.toBuffer();
    const checksum = createHash('sha256').update(buffer).digest('hex');
    const dir = join(config.uploads.dir, 'invoices');
    await mkdir(dir, { recursive: true });
    const storageKey = `invoices/${checksum}-${Date.now()}`;
    await writeFile(join(config.uploads.dir, storageKey), buffer);

    const row = await pool.query(
      `INSERT INTO attachments (branch_id, entity_type, entity_id, file_name,
         content_type, byte_size, storage_key, checksum_sha256, ocr_status,
         uploaded_by_user_id, uploaded_by_employee_id)
       VALUES ($1,'purchase',$2,$3,$4,$5,$6,$7,'not_requested',$8,$9) RETURNING id`,
      [
        p.branchId, id, file.filename, file.mimetype, buffer.length,
        storageKey, checksum, p.userId, p.employeeId,
      ],
    );
    return { attachmentId: row.rows[0].id, checksum, size: buffer.length };
  });

  /** Department confirms physical receipt — the only path that moves stock. */
  app.post('/purchase-requests/:id/receive', {
    preHandler: requirePermission('purchases.receive'),
  }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({
      locationId: z.string().uuid(),
      notes: z.string().max(500).nullish(),
      items: z.array(z.object({
        itemId: z.string().uuid(),
        receivedQuantity: z.number().min(0),
        unit: unitEnum,
        notes: z.string().max(300).optional(),
      })).min(1),
    }), req.body);
    return receiveDelivery(p, { requestId: id, ...body });
  });

  // --- Suppliers ------------------------------------------------------------
  app.get('/suppliers', { preHandler: requirePermission('suppliers.read') }, async (req) => {
    const p = requirePrincipal(req);
    const q = parse(z.object({
      branchId: z.string().uuid().optional(),
      includeInactive: z.coerce.boolean().default(false),
    }), req.query);
    return { suppliers: await listSuppliers(resolveBranch(p, q.branchId), q.includeInactive) };
  });

  app.post('/suppliers', { preHandler: requirePermission('suppliers.manage') }, async (req) => {
    const p = requirePrincipal(req);
    const body = parse(z.object({
      id: z.string().uuid().nullish(),
      branchId: z.string().uuid().optional(),
      name: z.string().min(1).max(200),
      phone: z.string().max(30).nullish(),
      email: z.string().email().nullish().or(z.literal('')),
      vatNumber: z.string().max(30).nullish(),
      contactPerson: z.string().max(100).nullish(),
      address: z.string().max(500).nullish(),
      notes: z.string().max(1000).nullish(),
      isActive: z.boolean().optional(),
    }), req.body);
    return upsertSupplier(p, { ...body, branchId: resolveBranch(p, body.branchId) });
  });

  app.get('/suppliers/prices/:itemId', { preHandler: requirePermission('suppliers.read') },
    async (req) => {
      const { itemId } = parse(z.object({ itemId: z.string().uuid() }), req.params);
      const q = parse(z.object({ days: z.coerce.number().int().min(1).max(730).default(180) }),
        req.query);
      return itemPriceHistory(itemId, q.days);
    });

  app.get('/purchases', { preHandler: requirePermission('purchases.read') }, async (req) => {
    const p = requirePrincipal(req);
    const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
    return {
      purchases: await many(
        `SELECT p.id, p.purchase_number, p.invoice_number, p.total, p.vat_amount,
                p.status, p.purchased_at, s.name AS supplier_name,
                pr.request_number, u.full_name AS buyer_name
           FROM purchases p
           LEFT JOIN suppliers s ON s.id = p.supplier_id
           LEFT JOIN purchase_requests pr ON pr.id = p.request_id
           LEFT JOIN users u ON u.id = p.buyer_user_id
          WHERE p.branch_id = $1 ORDER BY p.purchased_at DESC LIMIT 200`,
        [resolveBranch(p, q.branchId)],
      ),
    };
  });
}
