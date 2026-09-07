import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one } from '../../core/db.js';
import { parse, requirePermission } from '../../core/http.js';
import { requirePrincipal, resolveBranch } from '../../core/principal.js';
import {
  adjustStock, approveWaste, listStock, lowStockItems, receiveGoods, recordWaste,
} from './inventory.service.js';
import {
  approveCount, enterCounts, getCount, openStockCount, submitCount,
} from './stockcount.service.js';

const unitEnum = z.enum(['kg', 'g', 'l', 'ml', 'piece', 'box', 'carton', 'pack']);

export async function inventoryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/inventory/stock', { preHandler: requirePermission('inventory.read') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({
        branchId: z.string().uuid().optional(),
        locationId: z.string().uuid().optional(),
      }), req.query);
      return { stock: await listStock(resolveBranch(p, q.branchId), q.locationId) };
    });

  app.get('/inventory/low-stock', { preHandler: requirePermission('inventory.read') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
      return { items: await lowStockItems(resolveBranch(p, q.branchId)) };
    });

  app.get('/inventory/items', { preHandler: requirePermission('inventory.read') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({
        branchId: z.string().uuid().optional(),
        term: z.string().optional(),
      }), req.query);
      return {
        items: await many(
          `SELECT i.id, i.sku, i.name_ar AS name, i.category, i.base_unit, i.stock_unit,
                  i.pack_size, i.min_level, i.max_level, i.average_cost, i.last_cost,
                  t.total_quantity, t.is_low_stock
             FROM inventory_items i
             LEFT JOIN inventory_item_totals t ON t.item_id = i.id
            WHERE i.branch_id = $1 AND i.deleted_at IS NULL AND i.is_active
              AND ($2::text IS NULL OR i.name_ar ILIKE '%' || $2 || '%' OR i.sku ILIKE $2 || '%')
            ORDER BY i.name_ar`,
          [resolveBranch(p, q.branchId), q.term ?? null],
        ),
      };
    });

  app.get('/inventory/locations', { preHandler: requirePermission('inventory.read') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
      return {
        locations: await many(
          `SELECT id, code, name_ar AS name, department, is_main_store
             FROM inventory_locations WHERE branch_id = $1 AND is_active ORDER BY is_main_store DESC, name_ar`,
          [resolveBranch(p, q.branchId)],
        ),
      };
    });

  app.get('/inventory/transactions', { preHandler: requirePermission('inventory.read') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({
        branchId: z.string().uuid().optional(),
        itemId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }), req.query);
      return {
        transactions: await many(
          `SELECT t.id, t.txn_type, t.quantity_delta, t.balance_after, t.unit_cost,
                  t.total_cost, t.notes, t.occurred_at,
                  ii.name_ar AS item_name, l.name_ar AS location_name,
                  COALESCE(e.full_name, u.full_name) AS performed_by
             FROM inventory_transactions t
             JOIN inventory_items ii ON ii.id = t.item_id
             JOIN inventory_locations l ON l.id = t.location_id
             LEFT JOIN employees e ON e.id = t.performed_by_employee_id
             LEFT JOIN users u ON u.id = t.performed_by_user_id
            WHERE t.branch_id = $1 AND ($2::uuid IS NULL OR t.item_id = $2)
            ORDER BY t.occurred_at DESC LIMIT $3`,
          [resolveBranch(p, q.branchId), q.itemId ?? null, q.limit],
        ),
      };
    });

  app.post('/inventory/receive', { preHandler: requirePermission('inventory.receive') },
    async (req) => {
      const p = requirePrincipal(req);
      const body = parse(z.object({
        branchId: z.string().uuid().optional(),
        locationId: z.string().uuid(),
        supplierId: z.string().uuid().nullish(),
        invoiceNumber: z.string().max(60).nullish(),
        invoiceDate: z.string().nullish(),
        notes: z.string().max(500).nullish(),
        items: z.array(z.object({
          itemId: z.string().uuid(),
          quantity: z.number().positive(),
          unit: unitEnum,
          unitCost: z.number().int().min(0).optional(),
          expiryDate: z.string().nullish(),
          batchNumber: z.string().max(60).nullish(),
        })).min(1),
      }), req.body);
      return receiveGoods(p, { ...body, branchId: resolveBranch(p, body.branchId) });
    });

  app.post('/inventory/adjust', { preHandler: requirePermission('inventory.adjust') },
    async (req) => {
      const p = requirePrincipal(req);
      const body = parse(z.object({
        branchId: z.string().uuid().optional(),
        itemId: z.string().uuid(),
        locationId: z.string().uuid(),
        quantity: z.number(),
        unit: unitEnum,
        reason: z.string().min(1).max(500),
      }), req.body);
      return adjustStock(p, { ...body, branchId: resolveBranch(p, body.branchId) });
    });

  // --- Waste ----------------------------------------------------------------
  app.post('/waste', { preHandler: requirePermission('waste.create') }, async (req) => {
    const p = requirePrincipal(req);
    const body = parse(z.object({
      branchId: z.string().uuid().optional(),
      locationId: z.string().uuid(),
      itemId: z.string().uuid(),
      quantity: z.number().positive(),
      unit: unitEnum,
      reason: z.enum(['expired', 'damaged', 'preparation_error', 'dropped',
        'customer_return', 'trial', 'staff_consumption', 'overuse', 'other']),
      department: z.string().nullish(),
      notes: z.string().max(500).nullish(),
    }), req.body);
    return recordWaste(p, { ...body, branchId: resolveBranch(p, body.branchId) });
  });

  app.get('/waste', { preHandler: requirePermission('waste.read') }, async (req) => {
    const p = requirePrincipal(req);
    const q = parse(z.object({
      branchId: z.string().uuid().optional(),
      status: z.string().optional(),
    }), req.query);
    return {
      records: await many(
        `SELECT w.id, w.waste_number, w.quantity, w.entered_quantity, w.entered_unit,
                w.reason, w.notes, w.estimated_cost, w.status, w.occurred_at, w.department,
                ii.name_ar AS item_name, l.name_ar AS location_name,
                COALESCE(e.full_name, u.full_name) AS recorded_by
           FROM waste_records w
           JOIN inventory_items ii ON ii.id = w.item_id
           JOIN inventory_locations l ON l.id = w.location_id
           LEFT JOIN employees e ON e.id = w.recorded_by_employee_id
           LEFT JOIN users u ON u.id = w.recorded_by_user_id
          WHERE w.branch_id = $1 AND ($2::text IS NULL OR w.status = $2)
          ORDER BY w.occurred_at DESC LIMIT 200`,
        [resolveBranch(p, q.branchId), q.status ?? null],
      ),
    };
  });

  app.post('/waste/:id/approve', { preHandler: requirePermission('waste.approve') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const body = parse(z.object({
        approve: z.boolean(), reason: z.string().max(500).optional(),
      }), req.body);
      await approveWaste(p, id, body.approve, body.reason);
      return { ok: true };
    });

  // --- Stock counts ---------------------------------------------------------
  app.post('/stock-counts', { preHandler: requirePermission('stock_counts.create') },
    async (req) => {
      const p = requirePrincipal(req);
      const body = parse(z.object({
        branchId: z.string().uuid().optional(),
        locationId: z.string().uuid(),
        countType: z.enum(['daily', 'weekly', 'monthly', 'ad_hoc']),
        periodStart: z.string().nullish(),
        itemIds: z.array(z.string().uuid()).optional(),
        notes: z.string().max(500).nullish(),
      }), req.body);
      return openStockCount(p, { ...body, branchId: resolveBranch(p, body.branchId) });
    });

  app.get('/stock-counts', { preHandler: requirePermission('stock_counts.read') },
    async (req) => {
      const p = requirePrincipal(req);
      const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
      return {
        counts: await many(
          `SELECT sc.id, sc.count_number, sc.count_type, sc.status, sc.created_at,
                  sc.submitted_at, sc.approved_at, sc.total_variance_value,
                  sc.variance_percent, l.name_ar AS location_name
             FROM stock_counts sc JOIN inventory_locations l ON l.id = sc.location_id
            WHERE sc.branch_id = $1 ORDER BY sc.created_at DESC LIMIT 100`,
          [resolveBranch(p, q.branchId)],
        ),
      };
    });

  app.get('/stock-counts/:id', { preHandler: requirePermission('stock_counts.read') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      return { count: await getCount(id, p) };
    });

  app.post('/stock-counts/:id/entries', { preHandler: requirePermission('stock_counts.create') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const body = parse(z.object({
        entries: z.array(z.object({
          itemId: z.string().uuid(),
          countedQuantity: z.number().min(0),
          unit: unitEnum,
          notes: z.string().max(300).optional(),
        })).min(1),
      }), req.body);
      await enterCounts(p, id, body.entries);
      return { ok: true };
    });

  app.post('/stock-counts/:id/submit', { preHandler: requirePermission('stock_counts.submit') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      return submitCount(p, id);
    });

  app.post('/stock-counts/:id/approve', { preHandler: requirePermission('stock_counts.approve') },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      const body = parse(z.object({
        approve: z.boolean(), reason: z.string().max(500).optional(),
      }), req.body);
      await approveCount(p, id, body.approve, body.reason);
      return { ok: true };
    });
}
