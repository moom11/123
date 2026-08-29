import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many } from '../../core/db.js';
import { parse, requireAuth, requirePermission } from '../../core/http.js';
import { requirePrincipal, resolveBranch } from '../../core/principal.js';
import { getMenu, getProductOptions, searchProducts, setAvailability, updatePrice, upsertProduct } from './menu.service.js';
import { getRecipeDetail, projectUsage } from '../inventory/recipe.service.js';

export async function menuRoutes(app: FastifyInstance): Promise<void> {
  app.get('/menu', { preHandler: requirePermission('menu.read') }, async (req) => {
    const p = requirePrincipal(req);
    const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
    return getMenu(resolveBranch(p, q.branchId));
  });

  app.get('/menu/products/:id/options', { preHandler: requirePermission('menu.read') },
    async (req) => {
      const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
      return getProductOptions(id);
    });

  app.get('/menu/search', { preHandler: requirePermission('menu.read') }, async (req) => {
    const p = requirePrincipal(req);
    const q = parse(z.object({
      term: z.string().min(1), branchId: z.string().uuid().optional(),
    }), req.query);
    return { products: await searchProducts(resolveBranch(p, q.branchId), q.term) };
  });

  app.get('/menu/categories', { preHandler: requirePermission('menu.read') }, async (req) => {
    const p = requirePrincipal(req);
    const q = parse(z.object({ branchId: z.string().uuid().optional() }), req.query);
    const branchId = resolveBranch(p, q.branchId);
    return {
      categories: await many(
        `SELECT id, name_ar AS name, sort_order, is_active, show_in_menu
           FROM categories WHERE (branch_id = $1 OR branch_id IS NULL) AND deleted_at IS NULL
          ORDER BY sort_order, name_ar`, [branchId]),
    };
  });

  app.post('/menu/products/:id/availability', {
    preHandler: requirePermission('menu.availability.update'),
  }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const { available } = parse(z.object({ available: z.boolean() }), req.body);
    await setAvailability(p, id, available);
    return { ok: true };
  });

  app.post('/menu/products/:id/price', {
    preHandler: requirePermission('menu.price.update'),
  }, async (req) => {
    const p = requirePrincipal(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({
      price: z.number().int().min(0), reason: z.string().optional(),
    }), req.body);
    await updatePrice(p, id, body.price, body.reason);
    return { ok: true };
  });

  app.post('/menu/products', { preHandler: requirePermission('menu.manage') }, async (req) => {
    const p = requirePrincipal(req);
    const body = parse(z.object({
      id: z.string().uuid().nullish(),
      branchId: z.string().uuid().optional(),
      categoryId: z.string().uuid(),
      nameAr: z.string().min(1),
      nameEn: z.string().nullish(),
      descriptionAr: z.string().nullish(),
      price: z.number().int().min(0),
      productionDepartment: z.enum(['BAR', 'KITCHEN', 'SHISHA', 'OTHER']),
      imageUrl: z.string().nullish(),
      showInMenu: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
      modifierIds: z.array(z.string().uuid()).optional(),
    }), req.body);
    return upsertProduct(p, { ...body, branchId: resolveBranch(p, body.branchId) });
  });

  app.get('/menu/modifiers', { preHandler: requirePermission('menu.read') }, async (req) => {
    const p = requirePrincipal(req);
    const branchId = resolveBranch(p, null);
    const modifiers = await many<any>(
      `SELECT id, name_ar AS name, selection, is_required, min_select, max_select
         FROM modifiers WHERE (branch_id = $1 OR branch_id IS NULL) AND is_active
        ORDER BY sort_order, name_ar`, [branchId]);
    for (const m of modifiers) {
      m.options = await many(
        `SELECT id, name_ar AS name, price_delta, is_default FROM modifier_options
          WHERE modifier_id = $1 AND is_active ORDER BY sort_order`, [m.id]);
    }
    return { modifiers };
  });

  // --- Recipes ------------------------------------------------------------
  app.get('/recipes/:productId', { preHandler: requirePermission('recipes.read') },
    async (req) => {
      const { productId } = parse(z.object({ productId: z.string().uuid() }), req.params);
      const q = parse(z.object({ variantId: z.string().uuid().nullish() }), req.query);
      return { recipe: await getRecipeDetail(productId, q.variantId ?? null) };
    });

  /** "If we sell 100 of these, what does it burn?" */
  app.post('/recipes/:productId/project', { preHandler: requirePermission('recipes.read') },
    async (req) => {
      const { productId } = parse(z.object({ productId: z.string().uuid() }), req.params);
      const body = parse(z.object({
        variantId: z.string().uuid().nullish(),
        modifierOptionIds: z.array(z.string().uuid()).default([]),
        units: z.number().int().min(1).max(100000),
      }), req.body);
      return {
        usage: await projectUsage(productId, body.variantId ?? null,
          body.modifierOptionIds, body.units),
      };
    });
}
