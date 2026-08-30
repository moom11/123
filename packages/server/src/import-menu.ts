/**
 * Load a whole menu from a JSON file.
 *
 * Typing a hundred items through the UI one at a time is not a reasonable way
 * to open a restaurant, and re-typing them after a price revision is worse.
 * This reads a plain file, and is safe to run again: an item is matched by
 * name within its category, so a second run updates prices rather than
 * creating duplicates.
 *
 *   npm --workspace @mara/server run import-menu -- menu.json
 *   npm --workspace @mara/server run import-menu -- menu.json --dry-run
 *
 * File shape (prices in riyals, as they appear on the printed menu):
 *
 * {
 *   "categories": [
 *     {
 *       "name": "مشروبات ساخنة",
 *       "showInMenu": true,
 *       "items": [
 *         { "name": "قهوة تركية", "price": 14, "department": "BAR" },
 *         { "name": "كرك", "price": 10, "department": "BAR",
 *           "description": "شاي بالحليب والهيل" }
 *       ]
 *     }
 *   ]
 * }
 *
 * department is BAR | KITCHEN | SHISHA | OTHER and decides which printer gets
 * the ticket. It defaults per category name where that is unambiguous, and the
 * importer refuses to guess when it is not.
 */
import { readFile } from 'node:fs/promises';
import { closePool, many, one, pool, withTransaction } from './core/db.js';

type Department = 'BAR' | 'KITCHEN' | 'SHISHA' | 'OTHER';

interface ImportItem {
  name: string;
  price: number;
  department?: Department;
  description?: string;
  showInMenu?: boolean;
}
interface ImportCategory {
  name: string;
  showInMenu?: boolean;
  department?: Department;
  items: ImportItem[];
}
interface ImportFile { categories: ImportCategory[] }

/**
 * A category name is usually enough to know which station prepares it. Where
 * it is not, the file has to say — a drink printed in the kitchen is a real
 * operational failure, not a cosmetic one.
 */
const DEPARTMENT_HINTS: Array<[RegExp, Department]> = [
  [/معسل|شيشة|أرجيلة|شيش|tobacco|shisha/i, 'SHISHA'],
  [/مشروب|قهوة|شاي|عصير|كوكتيل|سموذي|موكا|لاتيه|بارد|ساخن|ماء|صودا|drink|coffee|tea|juice/i, 'BAR'],
  [/فطور|غداء|عشاء|مقبلات|سلطة|ساندوي|برجر|باستا|بيتزا|شوربة|أطباق|حلى|حلويات|كيك|dessert|food|main|breakfast/i, 'KITCHEN'],
];

function guessDepartment(categoryName: string): Department | null {
  for (const [pattern, department] of DEPARTMENT_HINTS) {
    if (pattern.test(categoryName)) return department;
  }
  return null;
}

/** Riyals on the menu, halalas in the database. Never a float. */
function toHalalas(riyals: number): number {
  if (!Number.isFinite(riyals) || riyals < 0) {
    throw new Error(`سعر غير صالح: ${riyals}`);
  }
  return Math.round(riyals * 100);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const path = args.find((a) => !a.startsWith('--'));
  if (!path) {
    console.error('usage: import-menu <file.json> [--dry-run]');
    process.exitCode = 1;
    return;
  }

  const parsed = JSON.parse(await readFile(path, 'utf8')) as ImportFile;
  if (!Array.isArray(parsed.categories) || parsed.categories.length === 0) {
    throw new Error('الملف لا يحتوي على تصنيفات');
  }

  const branch = await one<{ id: string; name_ar: string }>(
    'SELECT id, name_ar FROM branches WHERE is_active ORDER BY created_at LIMIT 1',
  );
  if (!branch) throw new Error('لا يوجد فرع — شغّل التهيئة أولاً');

  // Resolve every department up front so the run either fully applies or tells
  // you what is missing before it writes anything.
  const problems: string[] = [];
  for (const category of parsed.categories) {
    for (const item of category.items ?? []) {
      const department = item.department ?? category.department ?? guessDepartment(category.name);
      if (!department) {
        problems.push(`«${category.name}» → «${item.name}»: لم أستطع تحديد القسم`);
      }
    }
  }
  if (problems.length > 0) {
    console.error('\nأضف "department" لهذه الأصناف (BAR أو KITCHEN أو SHISHA أو OTHER):\n');
    for (const p of problems) console.error(`  • ${p}`);
    process.exitCode = 1;
    return;
  }

  let created = 0;
  let updated = 0;
  let categoriesTouched = 0;

  for (const [index, category] of parsed.categories.entries()) {
    const existingCategory = await one<{ id: string }>(
      `SELECT id FROM categories
        WHERE branch_id = $1 AND name_ar = $2 AND deleted_at IS NULL`,
      [branch.id, category.name],
    );

    let categoryId: string;
    if (existingCategory) {
      categoryId = existingCategory.id;
      if (!dryRun) {
        await pool.query(
          'UPDATE categories SET sort_order = $2, show_in_menu = $3 WHERE id = $1',
          [categoryId, index, category.showInMenu ?? true],
        );
      }
    } else {
      categoriesTouched += 1;
      if (dryRun) {
        categoryId = '(new)';
      } else {
        const row = await one<{ id: string }>(
          `INSERT INTO categories (branch_id, name_ar, sort_order, show_in_menu)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [branch.id, category.name, index, category.showInMenu ?? true],
        );
        categoryId = row!.id;
      }
    }

    console.log(`\n${category.name}${existingCategory ? '' : '  (تصنيف جديد)'}`);

    for (const [order, item] of (category.items ?? []).entries()) {
      const department = item.department ?? category.department
        ?? guessDepartment(category.name)!;
      const price = toHalalas(item.price);

      const existing = dryRun && categoryId === '(new)' ? null : await one<{
        id: string; price: string;
      }>(
        `SELECT id, price::text FROM products
          WHERE category_id = $1 AND name_ar = $2 AND deleted_at IS NULL`,
        [categoryId, item.name],
      );

      if (existing) {
        const before = Number(existing.price);
        updated += 1;
        const change = before === price
          ? ''
          : `  ${(before / 100).toFixed(2)} ← ${(price / 100).toFixed(2)} ر.س`;
        console.log(`  ~ ${item.name}${change}`);
        if (!dryRun) {
          await pool.query(
            `UPDATE products SET price = $2, production_department = $3,
                    description_ar = $4, show_in_menu = $5, sort_order = $6,
                    is_active = TRUE
               WHERE id = $1`,
            [existing.id, price, department, item.description ?? null,
             item.showInMenu ?? true, order],
          );
        }
      } else {
        created += 1;
        console.log(`  + ${item.name}  ${(price / 100).toFixed(2)} ر.س  [${department}]`);
        if (!dryRun) {
          await pool.query(
            `INSERT INTO products (branch_id, category_id, name_ar, description_ar,
                                   price, production_department, show_in_menu,
                                   sort_order, is_active, is_available)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, TRUE)`,
            [branch.id, categoryId, item.name, item.description ?? null, price,
             department, item.showInMenu ?? true, order],
          );
        }
      }
    }
  }

  const total = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM products
      WHERE branch_id = $1 AND is_active AND deleted_at IS NULL`,
    [branch.id],
  );

  console.log(`\n${dryRun ? 'تجربة — لم يُكتب شيء' : 'تم'}`);
  console.log(`  الفرع        : ${branch.name_ar}`);
  console.log(`  تصنيفات جديدة: ${categoriesTouched}`);
  console.log(`  أصناف جديدة  : ${created}`);
  console.log(`  أصناف محدَّثة : ${updated}`);
  if (!dryRun) console.log(`  إجمالي المنيو: ${total!.n} صنف`);
  console.log(
    '\nملاحظة: هذا لا يحذف شيئاً. الصنف الذي لم يعد في الملف يبقى في المنيو —\n'
    + 'أخرجه من شاشة المنيو إن لم تعد تبيعه.',
  );
}

main()
  .catch((err) => {
    console.error(`\nفشل الاستيراد: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => { void closePool(); });
