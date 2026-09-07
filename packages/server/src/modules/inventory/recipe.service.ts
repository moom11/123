import type { PoolClient } from 'pg';
import { many, one } from '../../core/db.js';
import { notFound } from '../../core/errors.js';

/**
 * The recipe engine.
 *
 * Its whole job is to answer one question honestly: given that this product was
 * sold with these modifier choices, exactly how much of which inventory item
 * leaves which location?
 *
 * Worked example from the specification — "شاي بدون سكر + مكس نعناع":
 *   base lines           → 1 tea bag, 1 cup, 200 ml water
 *   option "بدون سكر"     → no sugar line fires, so sugar = 0
 *   option "مكس نعناع"    → 2.5 g Moroccan mint + 2.5 g Hassawi mint
 * and "شاي + سكر + نعناع مغربي" instead fires 10 g sugar and 5 g Moroccan mint.
 * The choice changes the stock movement, not just the wording on the ticket.
 */

export interface RecipeLine {
  inventoryItemId: string;
  itemName: string;
  locationId: string | null;
  /** Base units (g / ml / piece). */
  quantity: number;
  lineKind: 'base' | 'option' | 'subtractive';
  sourceOptionId: string | null;
}

export interface ConsumptionLine {
  inventoryItemId: string;
  itemName: string;
  locationId: string;
  quantity: number;
}

interface RecipeItemRow {
  inventory_item_id: string;
  item_name: string;
  line_kind: 'base' | 'option' | 'subtractive';
  modifier_option_id: string | null;
  quantity: number;
  location_id: string | null;
  default_location_id: string | null;
  is_optional: boolean;
}

/**
 * Resolve the ingredient lines for one sold unit of a product.
 *
 * `selectedOptionIds` are the modifier options the guest actually chose.
 *   - base lines always apply
 *   - option lines apply only when their option was chosen
 *   - subtractive lines apply only when their option was NOT chosen
 */
export async function resolveRecipeLines(
  productId: string,
  variantId: string | null,
  selectedOptionIds: readonly string[],
  client?: PoolClient,
): Promise<RecipeLine[]> {
  const recipe = await one<{ id: string; waste_factor_percent: number; yield_qty: number }>(
    `SELECT id, waste_factor_percent, yield_qty
       FROM recipes
      WHERE product_id = $1 AND is_active
        AND (variant_id = $2 OR ($2::uuid IS NULL AND variant_id IS NULL))
      ORDER BY (variant_id IS NOT NULL) DESC
      LIMIT 1`,
    [productId, variantId], client,
  );

  // A product with no recipe (a bought-in bottle, say) simply consumes nothing.
  if (!recipe) return [];

  const rows = await many<RecipeItemRow>(
    `SELECT ri.inventory_item_id, ri.line_kind, ri.modifier_option_id, ri.quantity,
            ri.location_id, ri.is_optional,
            ii.name_ar AS item_name, ii.default_location_id
       FROM recipe_items ri
       JOIN inventory_items ii ON ii.id = ri.inventory_item_id
      WHERE ri.recipe_id = $1
      ORDER BY ri.sort_order, ri.id`,
    [recipe.id], client,
  );

  const chosen = new Set(selectedOptionIds);
  const lines: RecipeLine[] = [];

  for (const row of rows) {
    let applies: boolean;
    switch (row.line_kind) {
      case 'base':
        applies = true;
        break;
      case 'option':
        applies = row.modifier_option_id !== null && chosen.has(row.modifier_option_id);
        break;
      case 'subtractive':
        applies = row.modifier_option_id !== null && !chosen.has(row.modifier_option_id);
        break;
      default:
        applies = false;
    }
    if (!applies || row.quantity <= 0) continue;

    // Expected preparation loss is part of true consumption, so it is applied
    // here rather than being discovered later as an unexplained variance.
    const withWaste = row.quantity * (1 + Number(recipe.waste_factor_percent) / 100);
    const perPortion = recipe.yield_qty > 0 ? withWaste / Number(recipe.yield_qty) : withWaste;

    lines.push({
      inventoryItemId: row.inventory_item_id,
      itemName: row.item_name,
      locationId: row.location_id ?? row.default_location_id,
      quantity: perPortion,
      lineKind: row.line_kind,
      sourceOptionId: row.modifier_option_id,
    });
  }

  return lines;
}

/**
 * Expand a whole order line (quantity N with its chosen modifiers) into the
 * consumption it implies, merging repeated ingredients so "mint mix" lands as
 * one row per item rather than several.
 */
export async function computeConsumption(
  productId: string,
  variantId: string | null,
  selectedOptionIds: readonly string[],
  quantity: number,
  fallbackLocationId: string,
  client?: PoolClient,
): Promise<ConsumptionLine[]> {
  const lines = await resolveRecipeLines(productId, variantId, selectedOptionIds, client);

  const merged = new Map<string, ConsumptionLine>();
  for (const line of lines) {
    const locationId = line.locationId ?? fallbackLocationId;
    const key = `${line.inventoryItemId}:${locationId}`;
    const existing = merged.get(key);
    const amount = line.quantity * quantity;
    if (existing) {
      existing.quantity += amount;
    } else {
      merged.set(key, {
        inventoryItemId: line.inventoryItemId,
        itemName: line.itemName,
        locationId,
        quantity: amount,
      });
    }
  }

  // Round to the stored scale so repeated tiny fractions cannot accumulate
  // into a phantom variance over thousands of cups.
  return [...merged.values()].map((l) => ({
    ...l, quantity: Math.round(l.quantity * 10_000) / 10_000,
  }));
}

/** The full recipe of a product, for the management UI and costing reports. */
export async function getRecipeDetail(productId: string, variantId: string | null = null) {
  const recipe = await one<any>(
    `SELECT r.*, p.name_ar AS product_name
       FROM recipes r JOIN products p ON p.id = r.product_id
      WHERE r.product_id = $1
        AND (r.variant_id = $2 OR ($2::uuid IS NULL AND r.variant_id IS NULL))
        AND r.is_active
      LIMIT 1`,
    [productId, variantId],
  );
  if (!recipe) return null;

  const items = await many(
    `SELECT ri.id, ri.inventory_item_id, ri.line_kind, ri.modifier_option_id,
            ri.quantity, ri.unit, ri.location_id, ri.is_optional, ri.notes,
            ii.name_ar AS item_name, ii.sku, ii.base_unit, ii.average_cost,
            mo.name_ar AS option_name, m.name_ar AS modifier_name,
            (ri.quantity * ii.average_cost)::bigint AS line_cost
       FROM recipe_items ri
       JOIN inventory_items ii ON ii.id = ri.inventory_item_id
       LEFT JOIN modifier_options mo ON mo.id = ri.modifier_option_id
       LEFT JOIN modifiers m ON m.id = mo.modifier_id
      WHERE ri.recipe_id = $1
      ORDER BY ri.line_kind, ri.sort_order, ri.id`,
    [recipe.id],
  );

  const baseCost = items
    .filter((i: any) => i.line_kind === 'base')
    .reduce((sum: number, i: any) => sum + Number(i.line_cost ?? 0), 0);

  return { ...recipe, items, baseCost };
}

/**
 * Theoretical usage for a hypothetical sales volume — the "if we sell 100 flat
 * whites we should burn 1.8 kg of beans and 18 L of milk" projection.
 */
export async function projectUsage(
  productId: string,
  variantId: string | null,
  selectedOptionIds: readonly string[],
  units: number,
): Promise<Array<ConsumptionLine & { unit: string; estimatedCost: number }>> {
  const lines = await resolveRecipeLines(productId, variantId, selectedOptionIds);
  const merged = new Map<string, ConsumptionLine>();
  for (const line of lines) {
    const key = line.inventoryItemId;
    const existing = merged.get(key);
    const amount = line.quantity * units;
    if (existing) existing.quantity += amount;
    else merged.set(key, { ...line, locationId: line.locationId ?? '', quantity: amount });
  }

  const ids = [...merged.keys()];
  if (ids.length === 0) return [];

  const meta = await many<{ id: string; base_unit: string; average_cost: number }>(
    'SELECT id, base_unit, average_cost FROM inventory_items WHERE id = ANY($1::uuid[])',
    [ids],
  );
  const byId = new Map(meta.map((m) => [m.id, m]));

  return [...merged.values()].map((l) => {
    const m = byId.get(l.inventoryItemId);
    return {
      ...l,
      quantity: Math.round(l.quantity * 10_000) / 10_000,
      unit: m?.base_unit ?? 'g',
      estimatedCost: Math.round(l.quantity * Number(m?.average_cost ?? 0)),
    };
  });
}

export async function assertRecipeExists(productId: string): Promise<void> {
  const r = await one('SELECT 1 FROM recipes WHERE product_id = $1 AND is_active', [productId]);
  if (!r) throw notFound('لا توجد وصفة لهذا المنتج');
}
