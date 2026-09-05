import { many, one, pool, withTransaction } from '../../core/db.js';
import { AUDIT, audit } from '../../core/audit.js';
import { badRequest, notFound } from '../../core/errors.js';
import type { Principal } from '../../core/principal.js';

/**
 * Menu & catalogue.
 *
 * The customer-facing menu and the POS menu are the same data, filtered
 * differently: the guest sees only what is flagged for public display, the POS
 * sees everything sellable.
 */

export async function getMenu(
  branchId: string,
  opts: { publicOnly?: boolean; customerId?: string | null } = {},
) {
  const categories = await many(
    `SELECT id, name_ar AS name, name_en, description_ar AS description,
            image_url, sort_order
       FROM categories
      WHERE (branch_id = $1 OR branch_id IS NULL)
        AND is_active AND deleted_at IS NULL
        AND (NOT $2::boolean OR show_in_menu)
      ORDER BY sort_order, name_ar`,
    [branchId, Boolean(opts.publicOnly)],
  );

  const products = await many<any>(
    `SELECT p.id, p.category_id, p.name_ar AS name, p.name_en,
            p.description_ar AS description, p.image_url, p.price,
            p.production_department, p.is_available, p.show_in_menu, p.sort_order, p.tags,
            EXISTS (SELECT 1 FROM product_modifiers pm WHERE pm.product_id = p.id) AS has_modifiers,
            EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.is_active) AS has_variants
       FROM products p
      WHERE (p.branch_id = $1 OR p.branch_id IS NULL)
        AND p.is_active AND p.deleted_at IS NULL
        AND (NOT $2::boolean OR p.show_in_menu)
      ORDER BY p.sort_order, p.name_ar`,
    [branchId, Boolean(opts.publicOnly)],
  );

  // A customer's standing special prices are shown on their own menu so the
  // price they see is the price they pay.
  let specialPrices: Record<string, number> = {};
  if (opts.customerId) {
    const rows = await many<{ product_id: string | null; category_id: string | null; price: number | null; discount_percent: number | null }>(
      `SELECT product_id, category_id, price, discount_percent
         FROM customer_special_prices
        WHERE customer_id = $1 AND is_active
          AND (branch_id IS NULL OR branch_id = $2)
          AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`,
      [opts.customerId, branchId],
    );
    for (const p of products) {
      const match = rows.find((r) => r.product_id === p.id)
        ?? rows.find((r) => r.category_id === p.category_id);
      if (!match) continue;
      const price = match.price ?? Math.round(p.price * (1 - Number(match.discount_percent ?? 0) / 100));
      if (price < p.price) specialPrices[p.id] = price;
    }
  }

  return {
    categories,
    products: products.map((p) => ({
      ...p,
      specialPrice: specialPrices[p.id] ?? null,
    })),
  };
}

/** Modifier groups and options for one product, for the ordering screen. */
export async function getProductOptions(productId: string) {
  const product = await one(
    `SELECT id, name_ar AS name, description_ar AS description, price, image_url,
            production_department, is_available
       FROM products WHERE id = $1 AND deleted_at IS NULL AND is_active`,
    [productId],
  );
  if (!product) throw notFound('المنتج غير موجود');

  const variants = await many(
    `SELECT id, name_ar AS name, price_delta, price_override, is_default
       FROM product_variants WHERE product_id = $1 AND is_active ORDER BY sort_order`,
    [productId],
  );

  const modifiers = await many<any>(
    `SELECT m.id, m.name_ar AS name, m.selection,
            COALESCE(pm.is_required_override, m.is_required) AS is_required,
            m.min_select, m.max_select, pm.sort_order
       FROM product_modifiers pm JOIN modifiers m ON m.id = pm.modifier_id
      WHERE pm.product_id = $1 AND m.is_active
      ORDER BY pm.sort_order, m.name_ar`,
    [productId],
  );

  for (const m of modifiers) {
    m.options = await many(
      `SELECT id, name_ar AS name, price_delta, is_default
         FROM modifier_options WHERE modifier_id = $1 AND is_active ORDER BY sort_order`,
      [m.id],
    );
  }

  return { product, variants, modifiers };
}

export async function setAvailability(
  principal: Principal, productId: string, available: boolean,
): Promise<void> {
  const before = await one<{ is_available: boolean; name_ar: string; branch_id: string | null }>(
    'SELECT is_available, name_ar, branch_id FROM products WHERE id = $1', [productId],
  );
  if (!before) throw notFound('المنتج غير موجود');

  await pool.query('UPDATE products SET is_available = $2 WHERE id = $1', [productId, available]);
  await audit({
    action: AUDIT.PRODUCT_AVAILABILITY, actorUserId: principal.userId,
    actorEmployeeId: principal.employeeId, actorLabel: principal.displayName,
    branchId: before.branch_id ?? principal.branchId,
    entityType: 'product', entityId: productId,
    oldValue: { isAvailable: before.is_available },
    newValue: { isAvailable: available, product: before.name_ar },
  });
}

/**
 * Change a menu price. Separately permissioned from general menu editing and
 * always audited with the before/after — no operational role holds this.
 */
export async function updatePrice(
  principal: Principal, productId: string, newPrice: number, reason?: string,
): Promise<void> {
  if (!Number.isInteger(newPrice) || newPrice < 0) throw badRequest('السعر غير صالح');

  const before = await one<{ price: number; name_ar: string; branch_id: string | null }>(
    'SELECT price, name_ar, branch_id FROM products WHERE id = $1', [productId],
  );
  if (!before) throw notFound('المنتج غير موجود');
  if (before.price === newPrice) return;

  await pool.query('UPDATE products SET price = $2 WHERE id = $1', [productId, newPrice]);
  await audit({
    action: AUDIT.PRODUCT_PRICE_CHANGED, actorUserId: principal.userId,
    actorLabel: principal.displayName,
    branchId: before.branch_id ?? principal.branchId,
    entityType: 'product', entityId: productId,
    oldValue: { price: before.price },
    newValue: { price: newPrice, product: before.name_ar, reason },
  });
}

export async function upsertProduct(
  principal: Principal,
  input: {
    id?: string | null; branchId: string; categoryId: string; nameAr: string;
    nameEn?: string | null; descriptionAr?: string | null; price: number;
    productionDepartment: 'BAR' | 'KITCHEN' | 'SHISHA' | 'OTHER';
    imageUrl?: string | null; showInMenu?: boolean; sortOrder?: number;
    modifierIds?: string[];
  },
): Promise<{ id: string }> {
  return withTransaction(async (client) => {
    let productId = input.id ?? null;

    if (productId) {
      const before = await one<any>(
        'SELECT * FROM products WHERE id = $1', [productId], client,
      );
      if (!before) throw notFound('المنتج غير موجود');

      await client.query(
        `UPDATE products SET category_id = $2, name_ar = $3, name_en = $4,
                description_ar = $5, price = $6, production_department = $7,
                image_url = $8, show_in_menu = $9, sort_order = $10
          WHERE id = $1`,
        [
          productId, input.categoryId, input.nameAr, input.nameEn ?? null,
          input.descriptionAr ?? null, input.price, input.productionDepartment,
          input.imageUrl ?? null, input.showInMenu ?? true, input.sortOrder ?? 0,
        ],
      );

      if (before.price !== input.price) {
        await audit({
          action: AUDIT.PRODUCT_PRICE_CHANGED, actorUserId: principal.userId,
          actorLabel: principal.displayName, branchId: input.branchId,
          entityType: 'product', entityId: productId,
          oldValue: { price: before.price }, newValue: { price: input.price },
        }, client);
      }
      await audit({
        action: AUDIT.PRODUCT_UPDATED, actorUserId: principal.userId,
        actorLabel: principal.displayName, branchId: input.branchId,
        entityType: 'product', entityId: productId,
        oldValue: {
          name: before.name_ar, department: before.production_department,
          categoryId: before.category_id,
        },
        newValue: { name: input.nameAr, department: input.productionDepartment },
      }, client);
    } else {
      const created = await one<{ id: string }>(
        `INSERT INTO products (
           branch_id, category_id, name_ar, name_en, description_ar, price,
           production_department, image_url, show_in_menu, sort_order, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          input.branchId, input.categoryId, input.nameAr, input.nameEn ?? null,
          input.descriptionAr ?? null, input.price, input.productionDepartment,
          input.imageUrl ?? null, input.showInMenu ?? true, input.sortOrder ?? 0,
          principal.userId,
        ],
        client,
      );
      productId = created!.id;
      await audit({
        action: AUDIT.PRODUCT_CREATED, actorUserId: principal.userId,
        actorLabel: principal.displayName, branchId: input.branchId,
        entityType: 'product', entityId: productId,
        newValue: {
          name: input.nameAr, price: input.price,
          department: input.productionDepartment,
        },
      }, client);
    }

    if (input.modifierIds) {
      await client.query('DELETE FROM product_modifiers WHERE product_id = $1', [productId]);
      let order = 0;
      for (const modifierId of input.modifierIds) {
        await client.query(
          'INSERT INTO product_modifiers (product_id, modifier_id, sort_order) VALUES ($1,$2,$3)',
          [productId, modifierId, order],
        );
        order += 1;
      }
    }

    return { id: productId! };
  });
}

export async function searchProducts(branchId: string, term: string, limit = 30) {
  return many(
    `SELECT p.id, p.name_ar AS name, p.price, p.production_department, p.is_available,
            c.name_ar AS category_name
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE (p.branch_id = $1 OR p.branch_id IS NULL)
        AND p.is_active AND p.deleted_at IS NULL
        AND (p.name_ar ILIKE '%' || $2 || '%' OR p.name_en ILIKE '%' || $2 || '%'
             OR p.sku ILIKE $2 || '%')
      ORDER BY p.name_ar LIMIT $3`,
    [branchId, term, limit],
  );
}

/**
 * Categories.
 *
 * A category is never hard-deleted: products point at it and past orders were
 * priced under it, so retiring one sets deleted_at and leaves the history
 * readable.
 */
export async function upsertCategory(
  principal: Principal,
  input: {
    id?: string | null; branchId: string; nameAr: string; nameEn?: string | null;
    sortOrder?: number; showInMenu?: boolean; isActive?: boolean;
  },
): Promise<{ id: string }> {
  return withTransaction(async (client) => {
    let id = input.id ?? null;

    if (id) {
      const before = await one<any>(
        'SELECT * FROM categories WHERE id = $1 AND deleted_at IS NULL', [id], client,
      );
      if (!before) throw notFound('التصنيف غير موجود');
      await client.query(
        `UPDATE categories SET name_ar = $2, name_en = $3, sort_order = $4,
                show_in_menu = $5, is_active = $6
           WHERE id = $1`,
        [
          id, input.nameAr, input.nameEn ?? null, input.sortOrder ?? before.sort_order,
          input.showInMenu ?? before.show_in_menu, input.isActive ?? before.is_active,
        ],
      );
    } else {
      const row = await one<{ id: string }>(
        `INSERT INTO categories (branch_id, name_ar, name_en, sort_order,
                                 show_in_menu, is_active, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          input.branchId, input.nameAr, input.nameEn ?? null, input.sortOrder ?? 0,
          input.showInMenu ?? true, input.isActive ?? true, principal.userId,
        ],
        client,
      );
      id = row!.id;
    }

    await audit({
      action: AUDIT.CATEGORY_SAVED, actorUserId: principal.userId,
      actorLabel: principal.displayName, branchId: input.branchId,
      entityType: 'category', entityId: id!,
      newValue: { name: input.nameAr, sortOrder: input.sortOrder },
    }, client);

    return { id: id! };
  });
}

export async function retireCategory(principal: Principal, id: string, branchId: string) {
  return withTransaction(async (client) => {
    const inUse = await one<{ n: string }>(
      `SELECT count(*)::text AS n FROM products
        WHERE category_id = $1 AND is_active AND deleted_at IS NULL`,
      [id], client,
    );
    if (Number(inUse!.n) > 0) {
      throw badRequest(`لا يمكن حذف تصنيف يحتوي ${inUse!.n} صنفاً — انقلها أولاً`);
    }
    await client.query(
      'UPDATE categories SET deleted_at = now(), is_active = FALSE WHERE id = $1', [id],
    );
    await audit({
      action: AUDIT.CATEGORY_SAVED, actorUserId: principal.userId,
      actorLabel: principal.displayName, branchId,
      entityType: 'category', entityId: id, newValue: { retired: true },
    }, client);
    return { ok: true };
  });
}

/**
 * Retire a product. Also never hard-deleted — order_items reference it, and a
 * financial record must stay reconstructable.
 */
export async function retireProduct(principal: Principal, id: string, branchId: string) {
  return withTransaction(async (client) => {
    const before = await one<any>(
      'SELECT name_ar FROM products WHERE id = $1 AND deleted_at IS NULL', [id], client,
    );
    if (!before) throw notFound('المنتج غير موجود');
    await client.query(
      `UPDATE products SET is_active = FALSE, is_available = FALSE,
              show_in_menu = FALSE, deleted_at = now()
         WHERE id = $1`,
      [id],
    );
    await audit({
      action: AUDIT.PRODUCT_RETIRED, actorUserId: principal.userId,
      actorLabel: principal.displayName, branchId,
      entityType: 'product', entityId: id, oldValue: { name: before.name_ar },
    }, client);
    return { ok: true };
  });
}

/**
 * A modifier group and its options, saved together.
 *
 * Options are matched by id: one that is present is updated, one that has gone
 * is deactivated rather than deleted, because past order lines record which
 * option was chosen.
 */
export async function upsertModifier(
  principal: Principal,
  input: {
    id?: string | null; branchId: string; nameAr: string;
    selection: 'single' | 'multi'; isRequired: boolean;
    minSelect?: number; maxSelect?: number | null; sortOrder?: number;
    options: Array<{
      id?: string | null; nameAr: string; priceDelta: number;
      isDefault?: boolean; sortOrder?: number;
    }>;
  },
): Promise<{ id: string }> {
  if (input.options.length === 0) {
    throw badRequest('المجموعة تحتاج خياراً واحداً على الأقل');
  }
  if (input.isRequired && (input.minSelect ?? 1) < 1) {
    throw badRequest('المجموعة الإلزامية تحتاج حداً أدنى لا يقل عن واحد');
  }

  return withTransaction(async (client) => {
    let id = input.id ?? null;
    const minSelect = input.minSelect ?? (input.isRequired ? 1 : 0);
    const maxSelect = input.selection === 'single' ? 1 : input.maxSelect ?? null;

    if (id) {
      const before = await one<any>('SELECT id FROM modifiers WHERE id = $1', [id], client);
      if (!before) throw notFound('المجموعة غير موجودة');
      await client.query(
        `UPDATE modifiers SET name_ar = $2, selection = $3, is_required = $4,
                min_select = $5, max_select = $6, sort_order = $7
           WHERE id = $1`,
        [id, input.nameAr, input.selection, input.isRequired, minSelect, maxSelect,
         input.sortOrder ?? 0],
      );
    } else {
      const row = await one<{ id: string }>(
        `INSERT INTO modifiers (branch_id, name_ar, selection, is_required,
                                min_select, max_select, sort_order, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [input.branchId, input.nameAr, input.selection, input.isRequired,
         minSelect, maxSelect, input.sortOrder ?? 0, principal.userId],
        client,
      );
      id = row!.id;
    }

    const keptIds: string[] = [];
    for (const [index, option] of input.options.entries()) {
      if (option.id) {
        await client.query(
          `UPDATE modifier_options SET name_ar = $2, price_delta = $3,
                  is_default = $4, sort_order = $5, is_active = TRUE
             WHERE id = $1 AND modifier_id = $6`,
          [option.id, option.nameAr, option.priceDelta, option.isDefault ?? false,
           option.sortOrder ?? index, id],
        );
        keptIds.push(option.id);
      } else {
        const row = await one<{ id: string }>(
          `INSERT INTO modifier_options (modifier_id, name_ar, price_delta,
                                         is_default, sort_order)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [id, option.nameAr, option.priceDelta, option.isDefault ?? false,
           option.sortOrder ?? index],
          client,
        );
        keptIds.push(row!.id);
      }
    }

    // Anything the caller dropped is deactivated, not removed: an old order
    // line still names it.
    await client.query(
      `UPDATE modifier_options SET is_active = FALSE
        WHERE modifier_id = $1 AND NOT (id = ANY($2::uuid[]))`,
      [id, keptIds],
    );

    await audit({
      action: AUDIT.MODIFIER_SAVED, actorUserId: principal.userId,
      actorLabel: principal.displayName, branchId: input.branchId,
      entityType: 'modifier', entityId: id!,
      newValue: { name: input.nameAr, options: input.options.length },
    }, client);

    return { id: id! };
  });
}
