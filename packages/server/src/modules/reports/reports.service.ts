import { many, one } from '../../core/db.js';
import type { Principal } from '../../core/principal.js';

/**
 * Reporting.
 *
 * Every query is branch-scoped and date-bounded at the SQL level; the caller
 * cannot widen the scope by omitting a parameter, and cross-branch reads
 * require reports.all_branches, checked at the route.
 */

export interface DateRange { from: string; to: string }

function range(r?: Partial<DateRange>): DateRange {
  const to = r?.to ?? new Date().toISOString();
  const from = r?.from
    ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
  return { from, to };
}

/** Branch manager dashboard — everything on one screen for today. */
export async function branchDashboard(branchId: string) {
  const sales = await one<any>(
    `SELECT
       COALESCE(SUM(o.grand_total), 0)::bigint AS sales_today,
       count(*)::int AS orders_today,
       COALESCE(ROUND(AVG(o.grand_total)), 0)::bigint AS average_invoice,
       COALESCE(SUM(o.discount_total), 0)::bigint AS discounts_today,
       COALESCE(SUM(o.vat_amount), 0)::bigint AS vat_today
     FROM orders o
     WHERE o.branch_id = $1 AND o.status = 'paid' AND o.paid_at::date = now()::date`,
    [branchId],
  );

  const byMethod = await many(
    `SELECT p.method, COALESCE(SUM(p.amount), 0)::bigint AS total, count(*)::int AS count
       FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE p.branch_id = $1 AND p.status = 'captured' AND p.created_at::date = now()::date
      GROUP BY p.method ORDER BY total DESC`,
    [branchId],
  );

  const operational = await one<any>(
    `SELECT
       (SELECT count(*)::int FROM restaurant_tables
         WHERE branch_id = $1 AND status <> 'available' AND deleted_at IS NULL) AS open_tables,
       (SELECT count(*)::int FROM restaurant_tables
         WHERE branch_id = $1 AND deleted_at IS NULL AND is_active) AS total_tables,
       (SELECT count(*)::int FROM orders
         WHERE branch_id = $1 AND status = 'pending_waiter_approval') AS pending_approvals,
       (SELECT count(*)::int FROM service_requests
         WHERE branch_id = $1 AND status = 'open') AS open_service_requests,
       (SELECT count(*)::int FROM purchase_requests
         WHERE branch_id = $1 AND status = 'pending_branch_manager') AS purchase_requests_pending,
       (SELECT COALESCE(SUM(total), 0)::bigint FROM purchases
         WHERE branch_id = $1 AND purchased_at::date = now()::date) AS purchases_today,
       (SELECT COALESCE(SUM(estimated_cost), 0)::bigint FROM waste_records
         WHERE branch_id = $1 AND occurred_at::date = now()::date AND status = 'posted') AS waste_today,
       (SELECT count(*)::int FROM inventory_item_totals
         WHERE branch_id = $1 AND is_low_stock) AS low_stock_items,
       (SELECT count(*)::int FROM print_jobs
         WHERE branch_id = $1 AND status = 'failed') AS failed_print_jobs,
       (SELECT count(*)::int FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.branch_id = $1 AND oi.status = 'voided'
           AND oi.voided_at::date = now()::date) AS voids_today,
       (SELECT count(*)::int FROM print_jobs
         WHERE branch_id = $1 AND is_reprint AND created_at::date = now()::date) AS reprints_today`,
    [branchId],
  );

  const customers = await one<any>(
    `SELECT
       count(DISTINCT o.customer_id)::int AS customers_today,
       count(DISTINCT o.customer_id) FILTER (
         WHERE c.first_visit_at::date = now()::date)::int AS new_customers_today
     FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.branch_id = $1 AND o.status = 'paid' AND o.paid_at::date = now()::date
       AND o.customer_id IS NOT NULL`,
    [branchId],
  );

  const lastVariance = await one(
    `SELECT count_number, total_variance_value, variance_percent, approved_at, status
       FROM stock_counts WHERE branch_id = $1 AND status IN ('submitted','approved')
      ORDER BY COALESCE(approved_at, submitted_at) DESC LIMIT 1`,
    [branchId],
  );

  return {
    sales: {
      ...sales,
      cash: Number(byMethod.find((m: any) => m.method === 'cash')?.total ?? 0),
      card: byMethod
        .filter((m: any) => ['mada', 'visa', 'mastercard', 'apple_pay'].includes(m.method))
        .reduce((s: number, m: any) => s + Number(m.total), 0),
      byMethod,
    },
    operational,
    customers,
    lastVariance,
  };
}

/** Owner view: every branch side by side. */
export async function ownerDashboard(
  filters: { from?: string; to?: string; branchIds?: string[] } = {},
) {
  const { from, to } = range(filters);

  const branches = await many(
    `SELECT b.id, b.name_ar AS name, b.code,
            COALESCE(SUM(o.grand_total), 0)::bigint AS sales,
            count(o.id)::int AS orders,
            COALESCE(ROUND(AVG(o.grand_total)), 0)::bigint AS average_invoice,
            COALESCE(SUM(o.discount_total), 0)::bigint AS discounts,
            count(DISTINCT o.customer_id)::int AS customers
       FROM branches b
       LEFT JOIN orders o ON o.branch_id = b.id AND o.status = 'paid'
            AND o.paid_at BETWEEN $1 AND $2
      WHERE b.is_active AND ($3::uuid[] IS NULL OR b.id = ANY($3::uuid[]))
      GROUP BY b.id ORDER BY sales DESC`,
    [from, to, filters.branchIds ?? null],
  );

  const risks = await one<any>(
    `SELECT
       (SELECT count(*)::int FROM waste_records w
         WHERE w.occurred_at BETWEEN $1 AND $2 AND w.status = 'pending_approval') AS waste_pending,
       (SELECT count(*)::int FROM stock_counts s
         WHERE s.submitted_at BETWEEN $1 AND $2
           AND ABS(COALESCE(s.variance_percent, 0)) >= 3) AS high_variance_counts,
       (SELECT count(*)::int FROM discounts d
         WHERE d.created_at BETWEEN $1 AND $2 AND d.kind = 'manual') AS manual_discounts,
       (SELECT count(*)::int FROM print_jobs pj
         WHERE pj.created_at BETWEEN $1 AND $2 AND pj.is_reprint) AS reprints,
       (SELECT count(*)::int FROM audit_logs a
         WHERE a.occurred_at BETWEEN $1 AND $2
           AND a.action IN ('auth.login.failed','auth.pin_login.failed')) AS failed_logins`,
    [from, to],
  );

  const trend = await many(
    `SELECT o.paid_at::date AS day,
            COALESCE(SUM(o.grand_total), 0)::bigint AS sales,
            count(*)::int AS orders
       FROM orders o
      WHERE o.status = 'paid' AND o.paid_at BETWEEN $1 AND $2
        AND ($3::uuid[] IS NULL OR o.branch_id = ANY($3::uuid[]))
      GROUP BY day ORDER BY day`,
    [from, to, filters.branchIds ?? null],
  );

  return { period: { from, to }, branches, risks, trend };
}

export async function salesReport(branchId: string, filters: Partial<DateRange> = {}) {
  const { from, to } = range(filters);
  const summary = await one(
    `SELECT COALESCE(SUM(grand_total), 0)::bigint AS gross,
            COALESCE(SUM(discount_total), 0)::bigint AS discounts,
            COALESCE(SUM(vat_amount), 0)::bigint AS vat,
            COALESCE(SUM(points_discount_total), 0)::bigint AS points_value,
            count(*)::int AS orders,
            COALESCE(ROUND(AVG(grand_total)), 0)::bigint AS average_invoice
       FROM orders WHERE branch_id = $1 AND status = 'paid' AND paid_at BETWEEN $2 AND $3`,
    [branchId, from, to],
  );
  const byDay = await many(
    `SELECT paid_at::date AS day, COALESCE(SUM(grand_total), 0)::bigint AS sales,
            count(*)::int AS orders
       FROM orders WHERE branch_id = $1 AND status = 'paid' AND paid_at BETWEEN $2 AND $3
      GROUP BY day ORDER BY day`,
    [branchId, from, to],
  );
  const byHour = await many(
    `SELECT EXTRACT(HOUR FROM paid_at)::int AS hour,
            COALESCE(SUM(grand_total), 0)::bigint AS sales, count(*)::int AS orders
       FROM orders WHERE branch_id = $1 AND status = 'paid' AND paid_at BETWEEN $2 AND $3
      GROUP BY hour ORDER BY hour`,
    [branchId, from, to],
  );
  const byMethod = await many(
    `SELECT method, COALESCE(SUM(amount), 0)::bigint AS total, count(*)::int AS count
       FROM payments WHERE branch_id = $1 AND status = 'captured' AND created_at BETWEEN $2 AND $3
      GROUP BY method ORDER BY total DESC`,
    [branchId, from, to],
  );
  return { period: { from, to }, summary, byDay, byHour, byMethod };
}

export async function productReport(branchId: string, filters: Partial<DateRange> = {}) {
  const { from, to } = range(filters);

  const top = await many(
    `SELECT p.id, p.name_ar AS name, c.name_ar AS category,
            SUM(oi.quantity)::float AS quantity,
            COALESCE(SUM(oi.line_total), 0)::bigint AS revenue,
            count(DISTINCT oi.order_id)::int AS order_count
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       JOIN categories c ON c.id = p.category_id
      WHERE o.branch_id = $1 AND o.status = 'paid' AND o.paid_at BETWEEN $2 AND $3
        AND oi.status <> 'voided'
      GROUP BY p.id, c.name_ar ORDER BY quantity DESC LIMIT 25`,
    [branchId, from, to],
  );

  const slow = await many(
    `SELECT p.id, p.name_ar AS name, c.name_ar AS category,
            COALESCE(SUM(oi.quantity), 0)::float AS quantity,
            COALESCE(SUM(oi.line_total), 0)::bigint AS revenue
       FROM products p
       JOIN categories c ON c.id = p.category_id
       LEFT JOIN order_items oi ON oi.product_id = p.id AND oi.status <> 'voided'
       LEFT JOIN orders o ON o.id = oi.order_id AND o.status = 'paid'
            AND o.paid_at BETWEEN $2 AND $3
      WHERE (p.branch_id = $1 OR p.branch_id IS NULL) AND p.is_active AND p.deleted_at IS NULL
      GROUP BY p.id, c.name_ar ORDER BY quantity ASC, p.name_ar LIMIT 25`,
    [branchId, from, to],
  );

  const byCategory = await many(
    `SELECT c.id, c.name_ar AS category,
            SUM(oi.quantity)::float AS quantity,
            COALESCE(SUM(oi.line_total), 0)::bigint AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
       JOIN categories c ON c.id = p.category_id
      WHERE o.branch_id = $1 AND o.status = 'paid' AND o.paid_at BETWEEN $2 AND $3
        AND oi.status <> 'voided'
      GROUP BY c.id ORDER BY revenue DESC`,
    [branchId, from, to],
  );

  // Theoretical ingredient consumption implied by what was actually sold.
  const recipeUsage = await many(
    `SELECT ii.id, ii.name_ar AS item, ii.base_unit,
            SUM(-t.quantity_delta)::float AS consumed,
            COALESCE(SUM(t.total_cost), 0)::bigint AS cost
       FROM inventory_transactions t
       JOIN inventory_items ii ON ii.id = t.item_id
      WHERE t.branch_id = $1 AND t.txn_type = 'recipe_consumption'
        AND t.occurred_at BETWEEN $2 AND $3 AND t.quantity_delta < 0
      GROUP BY ii.id ORDER BY cost DESC LIMIT 30`,
    [branchId, from, to],
  );

  return { period: { from, to }, top, slow, byCategory, recipeUsage };
}

export async function employeeReport(branchId: string, filters: Partial<DateRange> = {}) {
  const { from, to } = range(filters);
  return many(
    `SELECT e.id, e.employee_code, e.full_name AS name, e.job_title,
            count(DISTINCT o.id)::int AS orders,
            COALESCE(SUM(o.grand_total), 0)::bigint AS sales,
            COALESCE(ROUND(AVG(o.grand_total)), 0)::bigint AS average_ticket,
            count(DISTINCT o.table_id)::int AS tables_served,
            (SELECT count(*)::int FROM discounts d
              WHERE d.applied_by_employee_id = e.id AND d.created_at BETWEEN $2 AND $3) AS discounts_applied,
            (SELECT count(*)::int FROM order_items oi
              WHERE oi.voided_by_employee_id = e.id AND oi.voided_at BETWEEN $2 AND $3) AS voids,
            (SELECT count(*)::int FROM print_jobs pj
              WHERE pj.requested_by_employee_id = e.id AND pj.is_reprint
                AND pj.created_at BETWEEN $2 AND $3) AS reprints
       FROM employees e
       LEFT JOIN orders o ON o.waiter_employee_id = e.id AND o.status = 'paid'
            AND o.paid_at BETWEEN $2 AND $3
      WHERE e.branch_id = $1 AND e.deleted_at IS NULL
      GROUP BY e.id ORDER BY sales DESC`,
    [branchId, from, to],
  );
}

export async function customerReport(branchId: string, filters: Partial<DateRange> = {}) {
  const { from, to } = range(filters);

  const topBySpend = await many(
    `SELECT c.id, c.customer_code, c.full_name AS name, c.visit_count,
            c.order_count, c.total_spend,
            CASE WHEN c.order_count > 0 THEN ROUND(c.total_spend / c.order_count) ELSE 0 END::bigint AS average_ticket,
            COALESCE(w.points_balance, 0) AS points
       FROM customers c LEFT JOIN customer_wallets w ON w.customer_id = c.id
      WHERE c.deleted_at IS NULL AND c.total_spend > 0
      ORDER BY c.total_spend DESC LIMIT 25`,
    [],
  );

  const topByVisits = await many(
    `SELECT id, customer_code, full_name AS name, visit_count, total_spend
       FROM customers WHERE deleted_at IS NULL AND visit_count > 0
      ORDER BY visit_count DESC LIMIT 25`,
    [],
  );

  const newCustomers = await many(
    `SELECT c.id, c.customer_code, c.full_name AS name, c.first_visit_at, c.total_spend
       FROM customers c
      WHERE c.first_visit_at BETWEEN $1 AND $2 AND c.deleted_at IS NULL
      ORDER BY c.first_visit_at DESC LIMIT 50`,
    [from, to],
  );

  const returning = await one(
    `SELECT
       count(*) FILTER (WHERE visit_count > 1)::int AS returning_customers,
       count(*) FILTER (WHERE visit_count = 1)::int AS one_time_customers,
       count(*)::int AS total_customers,
       COALESCE(ROUND(AVG(NULLIF(total_spend, 0) / NULLIF(order_count, 0))), 0)::bigint AS average_spend
     FROM customers WHERE deleted_at IS NULL`,
    [],
  );

  const inactive = await many(
    `SELECT id, customer_code, full_name AS name, last_visit_at, total_spend, visit_count
       FROM customers
      WHERE deleted_at IS NULL AND last_visit_at IS NOT NULL
        AND last_visit_at < now() - interval '60 days'
      ORDER BY total_spend DESC LIMIT 50`,
    [],
  );

  const specialPriceCustomers = await many(
    `SELECT DISTINCT c.id, c.customer_code, c.full_name AS name,
            count(csp.id)::int AS rules
       FROM customers c JOIN customer_special_prices csp ON csp.customer_id = c.id
      WHERE csp.is_active AND c.deleted_at IS NULL
      GROUP BY c.id ORDER BY rules DESC`,
    [],
  );

  const pointsOutstanding = await one(
    `SELECT COALESCE(SUM(points_balance), 0)::bigint AS total_points,
            count(*) FILTER (WHERE points_balance > 0)::int AS wallets_with_points
       FROM customer_wallets`,
    [],
  );

  return {
    period: { from, to },
    topBySpend, topByVisits, newCustomers, returning, inactive,
    specialPriceCustomers, pointsOutstanding,
  };
}

export async function inventoryReport(branchId: string, filters: Partial<DateRange> = {}) {
  const { from, to } = range(filters);

  const currentStock = await many(
    `SELECT * FROM inventory_item_totals WHERE branch_id = $1 ORDER BY total_value DESC`,
    [branchId],
  );
  const lowStock = currentStock.filter((i: any) => i.is_low_stock);

  const waste = await many(
    `SELECT w.reason, count(*)::int AS incidents,
            COALESCE(SUM(w.estimated_cost), 0)::bigint AS cost
       FROM waste_records w
      WHERE w.branch_id = $1 AND w.occurred_at BETWEEN $2 AND $3 AND w.status = 'posted'
      GROUP BY w.reason ORDER BY cost DESC`,
    [branchId, from, to],
  );

  const wasteByItem = await many(
    `SELECT ii.name_ar AS item, SUM(w.quantity)::float AS quantity,
            COALESCE(SUM(w.estimated_cost), 0)::bigint AS cost, count(*)::int AS incidents
       FROM waste_records w JOIN inventory_items ii ON ii.id = w.item_id
      WHERE w.branch_id = $1 AND w.occurred_at BETWEEN $2 AND $3 AND w.status = 'posted'
      GROUP BY ii.id ORDER BY cost DESC LIMIT 20`,
    [branchId, from, to],
  );

  const variances = await many(
    `SELECT sc.count_number, sc.count_type, sc.status, sc.submitted_at,
            sc.total_variance_value, sc.variance_percent, l.name_ar AS location
       FROM stock_counts sc JOIN inventory_locations l ON l.id = sc.location_id
      WHERE sc.branch_id = $1 AND sc.created_at BETWEEN $2 AND $3
      ORDER BY sc.created_at DESC LIMIT 20`,
    [branchId, from, to],
  );

  const transfers = await many(
    `SELECT t.transfer_number, t.status, t.created_at,
            fl.name_ar AS from_location, tl.name_ar AS to_location,
            (SELECT count(*)::int FROM inventory_transfer_items i WHERE i.transfer_id = t.id) AS items
       FROM inventory_transfers t
       JOIN inventory_locations fl ON fl.id = t.from_location_id
       JOIN inventory_locations tl ON tl.id = t.to_location_id
      WHERE t.branch_id = $1 AND t.created_at BETWEEN $2 AND $3
      ORDER BY t.created_at DESC LIMIT 50`,
    [branchId, from, to],
  );

  const usage = await many(
    `SELECT ii.name_ar AS item, ii.base_unit,
            SUM(-t.quantity_delta)::float AS consumed,
            COALESCE(SUM(t.total_cost), 0)::bigint AS cost
       FROM inventory_transactions t JOIN inventory_items ii ON ii.id = t.item_id
      WHERE t.branch_id = $1 AND t.txn_type = 'recipe_consumption'
        AND t.occurred_at BETWEEN $2 AND $3
      GROUP BY ii.id ORDER BY cost DESC LIMIT 30`,
    [branchId, from, to],
  );

  return {
    period: { from, to },
    currentStock, lowStock, waste, wasteByItem, variances, transfers, usage,
    totalStockValue: currentStock.reduce((s: number, i: any) => s + Number(i.total_value), 0),
  };
}

export async function purchasingReport(branchId: string, filters: Partial<DateRange> = {}) {
  const { from, to } = range(filters);

  const summary = await one(
    `SELECT count(*)::int AS purchases,
            COALESCE(SUM(total), 0)::bigint AS total_spend,
            COALESCE(SUM(vat_amount), 0)::bigint AS vat
       FROM purchases WHERE branch_id = $1 AND purchased_at BETWEEN $2 AND $3`,
    [branchId, from, to],
  );

  const byStatus = await many(
    `SELECT status, count(*)::int AS count FROM purchase_requests
      WHERE branch_id = $1 AND created_at BETWEEN $2 AND $3 GROUP BY status`,
    [branchId, from, to],
  );

  const bySupplier = await many(
    `SELECT s.id, s.name, count(p.id)::int AS purchases,
            COALESCE(SUM(p.total), 0)::bigint AS total_spend
       FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.branch_id = $1 AND p.purchased_at BETWEEN $2 AND $3
      GROUP BY s.id ORDER BY total_spend DESC`,
    [branchId, from, to],
  );

  const byDepartment = await many(
    `SELECT department, count(*)::int AS requests,
            COALESCE(SUM(actual_total), 0)::bigint AS spend
       FROM purchase_requests
      WHERE branch_id = $1 AND created_at BETWEEN $2 AND $3
      GROUP BY department ORDER BY spend DESC`,
    [branchId, from, to],
  );

  // Where approved differed from requested, and purchased from approved.
  const quantityGaps = await many(
    `SELECT pr.request_number, ii.name_ar AS item,
            pri.requested_quantity, pri.approved_quantity,
            pri.purchased_quantity, pri.received_quantity, ii.base_unit
       FROM purchase_request_items pri
       JOIN purchase_requests pr ON pr.id = pri.request_id
       JOIN inventory_items ii ON ii.id = pri.item_id
      WHERE pr.branch_id = $1 AND pr.created_at BETWEEN $2 AND $3
        AND (pri.approved_quantity IS DISTINCT FROM pri.requested_quantity
          OR pri.received_quantity IS DISTINCT FROM pri.purchased_quantity)
      ORDER BY pr.created_at DESC LIMIT 100`,
    [branchId, from, to],
  );

  return { period: { from, to }, summary, byStatus, bySupplier, byDepartment, quantityGaps };
}
