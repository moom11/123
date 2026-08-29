-- =============================================================================
-- 007 sequences & default configuration
--
-- Customer codes are a global, monotonic, human-quotable identifier (C000001).
-- A sequence rather than a count(*) so two tills registering guests at the same
-- moment can never mint the same code.
-- =============================================================================

CREATE SEQUENCE IF NOT EXISTS customer_code_seq START 1;

-- Convenience view: current stock joined to its item, with the low-stock flag
-- computed once here rather than repeated in every report and dashboard query.
CREATE VIEW inventory_stock_levels AS
SELECT
  i.id                AS item_id,
  i.branch_id,
  i.sku,
  i.name_ar,
  i.base_unit,
  i.stock_unit,
  i.pack_size,
  i.min_level,
  i.max_level,
  i.average_cost,
  i.last_cost,
  l.id                AS location_id,
  l.code              AS location_code,
  l.name_ar           AS location_name,
  COALESCE(s.quantity, 0) AS quantity,
  (COALESCE(s.quantity, 0) * i.average_cost)::bigint AS stock_value,
  (COALESCE(s.quantity, 0) <= i.min_level AND i.min_level > 0) AS is_low_stock
FROM inventory_items i
CROSS JOIN LATERAL (
  SELECT * FROM inventory_locations loc
   WHERE loc.branch_id = i.branch_id AND loc.is_active
) l
LEFT JOIN inventory_stock s ON s.item_id = i.id AND s.location_id = l.id
WHERE i.deleted_at IS NULL AND i.is_active;

-- Aggregate stock per item across every location in the branch, which is what
-- the low-stock alert and the purchase-request screen actually reason about.
CREATE VIEW inventory_item_totals AS
SELECT
  i.id AS item_id,
  i.branch_id,
  i.sku,
  i.name_ar,
  i.base_unit,
  i.stock_unit,
  i.pack_size,
  i.min_level,
  i.max_level,
  i.average_cost,
  COALESCE(SUM(s.quantity), 0) AS total_quantity,
  (COALESCE(SUM(s.quantity), 0) * i.average_cost)::bigint AS total_value,
  (COALESCE(SUM(s.quantity), 0) <= i.min_level AND i.min_level > 0) AS is_low_stock
FROM inventory_items i
LEFT JOIN inventory_stock s ON s.item_id = i.id
WHERE i.deleted_at IS NULL AND i.is_active
GROUP BY i.id;
