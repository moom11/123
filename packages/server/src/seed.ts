/**
 * Seed a working MARA branch.
 *
 * This is real operating data, not placeholder rows: a branch with its stock
 * locations and printers, the full role/permission matrix, staff accounts, a
 * menu whose recipes are the worked examples from the specification (tea with
 * its sugar and mint options, flat white, two-apple shisha), inventory with
 * opening stock, suppliers and loyalty rules.
 *
 * Idempotent — running it twice does not duplicate anything.
 */
import { ROLE_LABELS_AR, ROLE_PERMISSIONS, ROLES, PERMISSIONS, isAdminRole } from '@mara/shared';
import { closePool, one, pool, withTransaction } from './core/db.js';
import { hashSecret, generateToken, hashToken } from './core/crypto.js';
import { runMigrations } from './core/migrate.js';
import { buildQrValue } from './modules/tables/tables.service.js';

const log = (m: string) => console.log(`  ${m}`);

async function seedRolesAndPermissions(): Promise<Map<string, string>> {
  for (const code of PERMISSIONS) {
    await pool.query(
      'INSERT INTO permissions (code) VALUES ($1) ON CONFLICT (code) DO NOTHING',
      [code],
    );
  }

  const roleIds = new Map<string, string>();
  for (const code of ROLES) {
    const row = await one<{ id: string }>(
      `INSERT INTO roles (code, name_ar, is_admin)
       VALUES ($1,$2,$3)
       ON CONFLICT (code) DO UPDATE SET name_ar = EXCLUDED.name_ar, is_admin = EXCLUDED.is_admin
       RETURNING id`,
      [code, ROLE_LABELS_AR[code], isAdminRole(code)],
    );
    roleIds.set(code, row!.id);

    // Re-sync the role's grants so a code change to the matrix takes effect.
    await pool.query('DELETE FROM role_permissions WHERE role_id = $1', [row!.id]);
    for (const perm of ROLE_PERMISSIONS[code]) {
      await pool.query(
        'INSERT INTO role_permissions (role_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [row!.id, perm],
      );
    }
  }
  log(`roles: ${roleIds.size}, permissions: ${PERMISSIONS.length}`);
  return roleIds;
}

async function main(): Promise<void> {
  console.log('MARA seed');
  await runMigrations(log);

  const roleIds = await seedRolesAndPermissions();

  // --- Branch ---------------------------------------------------------------
  const branch = await one<{ id: string }>(
    `INSERT INTO branches (code, name, name_ar, address, phone, vat_number, vat_percent)
     VALUES ('MARA-01','MARA Lounge','مارا لاونج','الرياض','+966500000000','300000000000003',15.00)
     ON CONFLICT (code) DO UPDATE SET name_ar = EXCLUDED.name_ar
     RETURNING id`,
  );
  const branchId = branch!.id;
  log(`branch: ${branchId}`);

  // --- Inventory locations --------------------------------------------------
  const locations = new Map<string, string>();
  for (const [code, name, department, isMain] of [
    ['MAIN', 'المستودع الرئيسي', null, true],
    ['BAR', 'البار', 'BAR', false],
    ['KITCHEN', 'المطبخ', 'KITCHEN', false],
    ['SHISHA', 'المعسل', 'SHISHA', false],
    ['FLOOR', 'الصالة', 'FLOOR', false],
  ] as const) {
    const row = await one<{ id: string }>(
      `INSERT INTO inventory_locations (branch_id, code, name_ar, department, is_main_store)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (branch_id, code) DO UPDATE SET name_ar = EXCLUDED.name_ar
       RETURNING id`,
      [branchId, code, name, department, isMain],
    );
    locations.set(code, row!.id);
  }
  log(`locations: ${locations.size}`);

  // --- Users & employees ----------------------------------------------------
  // Uniqueness on email is a partial index over lower(email), so ON CONFLICT
  // cannot target it directly — select first, then insert.
  const ownerPassword = process.env.SEED_OWNER_PASSWORD ?? 'MaraOwner#2026Xy';
  let owner = await one<{ id: string }>(
    'SELECT id FROM users WHERE lower(email) = $1 AND deleted_at IS NULL',
    ['owner@maralounge.sa'],
  );
  if (!owner) {
    owner = await one<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role_id, branch_id, mfa_enabled)
       VALUES ($1,$2,$3,$4,NULL,FALSE) RETURNING id`,
      ['owner@maralounge.sa', await hashSecret(ownerPassword), 'مالك مارا', roleIds.get('owner')],
    );
  }
  log('owner: owner@maralounge.sa');

  const managerPassword = process.env.SEED_MANAGER_PASSWORD ?? 'MaraManager#2026Xy';
  let manager = await one<{ id: string }>(
    'SELECT id FROM users WHERE lower(email) = $1', ['manager@maralounge.sa'],
  );
  if (!manager) {
    manager = await one<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role_id, branch_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        'manager@maralounge.sa', await hashSecret(managerPassword), 'مدير الفرع',
        roleIds.get('branch_manager'), branchId, owner!.id,
      ],
    );
    await pool.query(
      'INSERT INTO user_branches (user_id, branch_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [manager!.id, branchId],
    );
  }
  log('branch manager: manager@maralounge.sa');

  /** Operational staff: a user row plus an employee row carrying the PIN. */
  const staff: Array<[string, string, string, string, string, string]> = [
    // code, name, role, department, jobTitle, pin
    ['1042', 'خالد الويتر', 'waiter', 'FLOOR', 'ويتر', '2580'],
    ['1043', 'سعد الويتر', 'waiter', 'FLOOR', 'ويتر', '1379'],
    ['2001', 'نورة الكاشير', 'cashier', 'FLOOR', 'كاشير', '4826'],
    ['3001', 'عبدالله البار', 'bar_staff', 'BAR', 'موظف بار', '7192'],
    ['3002', 'ماجد المطبخ', 'kitchen_staff', 'KITCHEN', 'موظف مطبخ', '6473'],
    ['3003', 'فهد المعسل', 'shisha_staff', 'SHISHA', 'موظف معسل', '9265'],
    ['3004', 'تركي الصالة', 'floor_staff', 'FLOOR', 'موظف صالة', '5817'],
    ['4001', 'مندوب المشتريات', 'buyer', 'OTHER', 'مندوب مشتريات', '3648'],
  ];

  const employeeIds = new Map<string, string>();
  for (const [code, name, role, department, jobTitle, pin] of staff) {
    let emp = await one<{ id: string; user_id: string }>(
      'SELECT id, user_id FROM employees WHERE branch_id = $1 AND employee_code = $2',
      [branchId, code],
    );
    if (!emp) {
      const u = await one<{ id: string }>(
        `INSERT INTO users (full_name, role_id, branch_id, created_by)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [name, roleIds.get(role), branchId, owner!.id],
      );
      await pool.query(
        'INSERT INTO user_branches (user_id, branch_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [u!.id, branchId],
      );
      emp = await one<{ id: string; user_id: string }>(
        `INSERT INTO employees (employee_code, user_id, full_name, job_title, department,
           branch_id, role_id, pin_hash, pin_changed_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), $9)
         RETURNING id, user_id`,
        [
          code, u!.id, name, jobTitle, department, branchId,
          roleIds.get(role), await hashSecret(pin), owner!.id,
        ],
      );
    }
    employeeIds.set(code, emp!.id);
  }
  log(`employees: ${employeeIds.size}`);

  // --- Tables ---------------------------------------------------------------
  const tableIds = new Map<string, string>();
  for (let n = 1; n <= 20; n += 1) {
    const number = String(n);
    const area = n <= 10 ? 'الصالة الداخلية' : 'التراس';
    let t = await one<{ id: string; qr_token: string }>(
      'SELECT id, qr_token FROM restaurant_tables WHERE branch_id = $1 AND table_number = $2',
      [branchId, number],
    );
    if (!t) {
      t = await one<{ id: string; qr_token: string }>(
        `INSERT INTO restaurant_tables (branch_id, table_number, area, seats, qr_token,
           assigned_waiter_employee_id, sort_order, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, qr_token`,
        [
          branchId, number, area, n <= 10 ? 4 : 6, generateToken(24),
          n <= 10 ? employeeIds.get('1042') : employeeIds.get('1043'), n, owner!.id,
        ],
      );
    }
    tableIds.set(number, t!.id);
  }
  log(`tables: ${tableIds.size}`);

  // --- Printers & print agent ----------------------------------------------
  for (const [name, department, ip] of [
    ['Kitchen Printer', 'KITCHEN', '192.168.10.101'],
    ['Bar Printer', 'BAR', '192.168.10.102'],
    ['Shisha Printer', 'SHISHA', '192.168.10.103'],
    ['Cashier Printer', 'CASHIER', '192.168.10.104'],
  ] as const) {
    await pool.query(
      `INSERT INTO printers (branch_id, name, department, ip_address, port, created_by)
       SELECT $1,$2,$3,$4,9100,$5
        WHERE NOT EXISTS (
          SELECT 1 FROM printers
           WHERE branch_id = $1 AND name = $2 AND deleted_at IS NULL
        )`,
      [branchId, name, department, ip, owner!.id],
    );
  }

  const existingAgent = await one('SELECT id FROM print_agents WHERE branch_id = $1', [branchId]);
  let agentToken: string | null = null;
  if (!existingAgent) {
    agentToken = generateToken(32);
    await pool.query(
      'INSERT INTO print_agents (branch_id, name, token_hash, created_by) VALUES ($1,$2,$3,$4)',
      [branchId, 'MARA Branch Agent', hashToken(agentToken), owner!.id],
    );
  }
  log('printers: 4');

  // --- Suppliers ------------------------------------------------------------
  const suppliers = new Map<string, string>();
  for (const [name, phone] of [
    ['مؤسسة الإمداد للأغذية', '+966511111111'],
    ['شركة البن الذهبي', '+966522222222'],
    ['موردو المعسل والفحم', '+966533333333'],
  ] as const) {
    let s = await one<{ id: string }>(
      'SELECT id FROM suppliers WHERE branch_id = $1 AND name = $2', [branchId, name],
    );
    if (!s) {
      s = await one<{ id: string }>(
        'INSERT INTO suppliers (branch_id, name, phone, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
        [branchId, name, phone, owner!.id],
      );
    }
    suppliers.set(name, s!.id);
  }

  // --- Inventory items ------------------------------------------------------
  // [sku, name, category, base_unit, stock_unit, packSize, minLevel, cost/base, openingQty, location]
  const items: Array<[string, string, string, string, string, number | null, number, number, number, string]> = [
    ['ING-TEA', 'فتلة شاي', 'مشروبات', 'piece', 'box', 100, 200, 15, 1000, 'BAR'],
    ['ING-SUGAR', 'سكر', 'مشروبات', 'g', 'kg', null, 5000, 0.8, 25000, 'BAR'],
    ['ING-MINT-MA', 'نعناع مغربي', 'مشروبات', 'g', 'kg', null, 500, 6, 3000, 'BAR'],
    ['ING-MINT-HA', 'نعناع حساوي', 'مشروبات', 'g', 'kg', null, 500, 7, 3000, 'BAR'],
    ['ING-WATER', 'ماء', 'مشروبات', 'ml', 'l', null, 20000, 0.02, 200000, 'BAR'],
    ['ING-CUP', 'كوب', 'مستهلكات', 'piece', 'piece', null, 300, 35, 2000, 'BAR'],
    ['ING-LID', 'غطاء كوب', 'مستهلكات', 'piece', 'piece', null, 300, 20, 2000, 'BAR'],
    ['ING-COFFEE', 'حبوب قهوة', 'مشروبات', 'g', 'kg', null, 3000, 9, 12000, 'BAR'],
    ['ING-MILK', 'حليب', 'مشروبات', 'ml', 'l', null, 30000, 0.6, 40000, 'BAR'],
    ['ING-TOBACCO-2A', 'معسل تفاحتين', 'معسل', 'g', 'kg', null, 1000, 45, 5000, 'SHISHA'],
    ['ING-CHARCOAL', 'فحم', 'معسل', 'piece', 'box', 100, 500, 12, 3000, 'SHISHA'],
    ['ING-FLOUR', 'دقيق', 'مطبخ', 'g', 'kg', null, 5000, 0.5, 20000, 'KITCHEN'],
    ['ING-CHOC', 'شوكولاتة', 'مطبخ', 'g', 'kg', null, 2000, 8, 6000, 'KITCHEN'],
    ['ING-EGG', 'بيض', 'مطبخ', 'piece', 'carton', 30, 60, 90, 300, 'KITCHEN'],
    ['ING-BUTTER', 'زبدة', 'مطبخ', 'g', 'kg', null, 2000, 4, 8000, 'KITCHEN'],
  ];

  const itemIds = new Map<string, string>();
  for (const [sku, name, category, baseUnit, stockUnit, packSize, minLevel, cost, opening, loc] of items) {
    let item = await one<{ id: string }>(
      'SELECT id FROM inventory_items WHERE branch_id = $1 AND sku = $2', [branchId, sku],
    );
    if (!item) {
      item = await one<{ id: string }>(
        `INSERT INTO inventory_items (branch_id, sku, name_ar, category, base_unit, stock_unit,
           pack_size, min_level, average_cost, last_cost, default_location_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11) RETURNING id`,
        [
          branchId, sku, name, category, baseUnit, stockUnit, packSize, minLevel,
          cost, locations.get(loc), owner!.id,
        ],
      );
      // Opening stock, posted through the ledger like any other movement.
      await withTransaction(async (client) => {
        const { postMovement } = await import('./modules/inventory/inventory.service.js');
        await postMovement({
          branchId, itemId: item!.id, locationId: locations.get(loc)!,
          txnType: 'receive', quantityDelta: opening, unitCost: cost,
          notes: 'رصيد افتتاحي', byUserId: owner!.id,
        }, client);
      });
    }
    itemIds.set(sku, item!.id);
  }
  log(`inventory items: ${itemIds.size}`);

  // --- Menu -----------------------------------------------------------------
  const categories = new Map<string, string>();
  for (const [name, order] of [
    ['مشروبات ساخنة', 1], ['مشروبات باردة', 2], ['معسل', 3], ['حلويات', 4],
  ] as const) {
    let c = await one<{ id: string }>(
      'SELECT id FROM categories WHERE branch_id = $1 AND name_ar = $2', [branchId, name],
    );
    if (!c) {
      c = await one<{ id: string }>(
        'INSERT INTO categories (branch_id, name_ar, sort_order, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
        [branchId, name, order, owner!.id],
      );
    }
    categories.set(name, c!.id);
  }

  /** Modifier groups. The sugar and mint groups drive real stock movement. */
  async function upsertModifier(
    name: string, selection: 'single' | 'multi', required: boolean,
    options: Array<[string, number]>,
  ): Promise<{ id: string; options: Map<string, string> }> {
    let m = await one<{ id: string }>(
      'SELECT id FROM modifiers WHERE branch_id = $1 AND name_ar = $2', [branchId, name],
    );
    if (!m) {
      m = await one<{ id: string }>(
        `INSERT INTO modifiers (branch_id, name_ar, selection, is_required, min_select, max_select, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [branchId, name, selection, required, required ? 1 : 0, selection === 'single' ? 1 : 5, owner!.id],
      );
    }
    const optionIds = new Map<string, string>();
    let sort = 0;
    for (const [optName, delta] of options) {
      let o = await one<{ id: string }>(
        'SELECT id FROM modifier_options WHERE modifier_id = $1 AND name_ar = $2', [m!.id, optName],
      );
      if (!o) {
        o = await one<{ id: string }>(
          `INSERT INTO modifier_options (modifier_id, name_ar, price_delta, sort_order)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [m!.id, optName, delta, sort],
        );
      }
      optionIds.set(optName, o!.id);
      sort += 1;
    }
    return { id: m!.id, options: optionIds };
  }

  const sugarMod = await upsertModifier('اختيار السكر', 'single', true,
    [['سكر', 0], ['بدون سكر', 0]]);
  const mintMod = await upsertModifier('النعناع', 'single', true,
    [['بدون نعناع', 0], ['نعناع مغربي', 300], ['نعناع حساوي', 300], ['مكس نعناع', 400]]);

  async function upsertProduct(
    name: string, category: string, price: number,
    department: 'BAR' | 'KITCHEN' | 'SHISHA' | 'OTHER',
    modifierIds: string[] = [],
  ): Promise<string> {
    let p = await one<{ id: string }>(
      'SELECT id FROM products WHERE branch_id = $1 AND name_ar = $2', [branchId, name],
    );
    if (!p) {
      p = await one<{ id: string }>(
        `INSERT INTO products (branch_id, category_id, name_ar, price, production_department, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [branchId, categories.get(category), name, price, department, owner!.id],
      );
    }
    for (const mid of modifierIds) {
      await pool.query(
        'INSERT INTO product_modifiers (product_id, modifier_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [p!.id, mid],
      );
    }
    return p!.id;
  }

  const teaId = await upsertProduct('شاي', 'مشروبات ساخنة', 800, 'BAR',
    [sugarMod.id, mintMod.id]);
  const flatWhiteId = await upsertProduct('فلات وايت', 'مشروبات ساخنة', 1800, 'BAR');
  const shishaId = await upsertProduct('معسل تفاحتين', 'معسل', 6500, 'SHISHA');
  const dessertId = await upsertProduct('كيك الشوكولاتة', 'حلويات', 2800, 'KITCHEN');

  // --- Recipes --------------------------------------------------------------
  async function upsertRecipe(
    productId: string,
    lines: Array<{
      sku: string; qty: number; unit: string;
      kind?: 'base' | 'option' | 'subtractive'; optionId?: string; location?: string;
    }>,
  ): Promise<void> {
    let r = await one<{ id: string }>(
      'SELECT id FROM recipes WHERE product_id = $1 AND variant_id IS NULL AND is_active',
      [productId],
    );
    if (!r) {
      r = await one<{ id: string }>(
        'INSERT INTO recipes (product_id, created_by) VALUES ($1,$2) RETURNING id',
        [productId, owner!.id],
      );
    }
    await pool.query('DELETE FROM recipe_items WHERE recipe_id = $1', [r!.id]);
    let sort = 0;
    for (const line of lines) {
      await pool.query(
        `INSERT INTO recipe_items (recipe_id, inventory_item_id, line_kind,
           modifier_option_id, quantity, unit, location_id, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          r!.id, itemIds.get(line.sku), line.kind ?? 'base', line.optionId ?? null,
          line.qty, line.unit, line.location ? locations.get(line.location) : null, sort,
        ],
      );
      sort += 1;
    }
  }

  // شاي — the specification's worked example.
  //   base: 1 tea bag + 200 ml water + 1 cup
  //   "سكر"          → 10 g sugar    | "بدون سكر" → nothing fires, so sugar = 0
  //   "نعناع مغربي"  → 5 g Moroccan  | "نعناع حساوي" → 5 g Hassawi
  //   "مكس نعناع"    → 2.5 g of each
  await upsertRecipe(teaId, [
    { sku: 'ING-TEA', qty: 1, unit: 'piece', location: 'BAR' },
    { sku: 'ING-WATER', qty: 200, unit: 'ml', location: 'BAR' },
    { sku: 'ING-CUP', qty: 1, unit: 'piece', location: 'BAR' },
    { sku: 'ING-SUGAR', qty: 10, unit: 'g', kind: 'option',
      optionId: sugarMod.options.get('سكر'), location: 'BAR' },
    { sku: 'ING-MINT-MA', qty: 5, unit: 'g', kind: 'option',
      optionId: mintMod.options.get('نعناع مغربي'), location: 'BAR' },
    { sku: 'ING-MINT-HA', qty: 5, unit: 'g', kind: 'option',
      optionId: mintMod.options.get('نعناع حساوي'), location: 'BAR' },
    { sku: 'ING-MINT-MA', qty: 2.5, unit: 'g', kind: 'option',
      optionId: mintMod.options.get('مكس نعناع'), location: 'BAR' },
    { sku: 'ING-MINT-HA', qty: 2.5, unit: 'g', kind: 'option',
      optionId: mintMod.options.get('مكس نعناع'), location: 'BAR' },
  ]);

  // Flat White — 18 g beans, 180 ml milk, cup, lid. 100 sold = 1.8 kg + 18 L.
  await upsertRecipe(flatWhiteId, [
    { sku: 'ING-COFFEE', qty: 18, unit: 'g', location: 'BAR' },
    { sku: 'ING-MILK', qty: 180, unit: 'ml', location: 'BAR' },
    { sku: 'ING-CUP', qty: 1, unit: 'piece', location: 'BAR' },
    { sku: 'ING-LID', qty: 1, unit: 'piece', location: 'BAR' },
  ]);

  // معسل تفاحتين — 20 g tobacco, 4 charcoal at start + 3 expected replacements.
  await upsertRecipe(shishaId, [
    { sku: 'ING-TOBACCO-2A', qty: 20, unit: 'g', location: 'SHISHA' },
    { sku: 'ING-CHARCOAL', qty: 7, unit: 'piece', location: 'SHISHA' },
  ]);

  await upsertRecipe(dessertId, [
    { sku: 'ING-FLOUR', qty: 60, unit: 'g', location: 'KITCHEN' },
    { sku: 'ING-CHOC', qty: 40, unit: 'g', location: 'KITCHEN' },
    { sku: 'ING-EGG', qty: 1, unit: 'piece', location: 'KITCHEN' },
    { sku: 'ING-BUTTER', qty: 30, unit: 'g', location: 'KITCHEN' },
  ]);
  log('recipes: 4 (tea with option-driven consumption, flat white, shisha, dessert)');

  // --- Loyalty: 100 points = 10 SAR, 1 point per 10 SAR spent ---------------
  const existingRule = await one('SELECT id FROM loyalty_rules WHERE branch_id = $1 AND is_active',
    [branchId]);
  if (!existingRule) {
    await pool.query(
      `INSERT INTO loyalty_rules (branch_id, name, spend_per_point, points_per_block,
         block_value, min_redeem_points, max_redeem_percent, created_by)
       VALUES ($1,'قواعد نقاط مارا',1000,100,1000,100,50.00,$2)`,
      [branchId, owner!.id],
    );
  }

  // --- Settings -------------------------------------------------------------
  for (const [key, value] of [
    ['waste_approval_threshold', 10000],
    ['variance_alert_percent', 3],
    ['variance_alert_value', 20000],
    ['large_discount_alert', 10000],
  ] as const) {
    await pool.query(
      `INSERT INTO settings (branch_id, key, value, updated_by) VALUES ($1,$2,$3::jsonb,$4)
       ON CONFLICT (COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
       DO NOTHING`,
      [branchId, key, JSON.stringify(value), owner!.id],
    );
  }

  // --- A demo customer with the spec's special price ------------------------
  const { findOrCreateByPhone } = await import('./modules/customers/customers.service.js');
  const khalid = await findOrCreateByPhone('+966551234567', {
    branchId, createdBy: owner!.id, name: 'خالد',
  });
  await pool.query(
    `UPDATE customers SET phone_verified = TRUE, phone_verified_at = now(),
            first_visit_at = COALESCE(first_visit_at, now()) WHERE id = $1`,
    [khalid.id],
  );
  // 320 points, matching the specification's illustration.
  await pool.query(
    `UPDATE customer_wallets SET points_balance = 320, lifetime_points_earned = 320
      WHERE customer_id = $1 AND points_balance = 0`,
    [khalid.id],
  );
  const hasSpecial = await one(
    'SELECT 1 FROM customer_special_prices WHERE customer_id = $1 AND product_id = $2',
    [khalid.id, shishaId],
  );
  if (!hasSpecial) {
    // 65 SAR → 45 SAR, and it requires the customer's own OTP to apply.
    await pool.query(
      `INSERT INTO customer_special_prices (customer_id, product_id, branch_id, price,
         requires_otp, created_by, notes)
       VALUES ($1,$2,$3,4500,TRUE,$4,'سعر خاص متفق عليه')`,
      [khalid.id, shishaId, branchId, owner!.id],
    );
  }

  // --- Terminals, and their stamping identities -----------------------------
  // The floor has one till and several waiter tablets. Only the till closes
  // bills, and only the till is an EGS unit with a ZATCA certificate.
  const tills = [
    { kind: 'cashier' as const, label: 'الكاشير الرئيسي', serial: 'TILL-01' },
    { kind: 'waiter' as const, label: 'جهاز نادل 1', serial: 'WAITER-01' },
    { kind: 'waiter' as const, label: 'جهاز نادل 2', serial: 'WAITER-02' },
  ];
  const deviceTokens: Array<{ label: string; token: string }> = [];
  for (const spec of tills) {
    const existing = await one<{ id: string }>(
      'SELECT id FROM devices WHERE branch_id = $1 AND serial_number = $2',
      [branchId, spec.serial],
    );
    if (existing) continue;
    const token = generateToken(32);
    await pool.query(
      `INSERT INTO devices (branch_id, kind, label, serial_number, token_hash, registered_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [branchId, spec.kind, spec.label, spec.serial, hashToken(token), owner!.id],
    );
    deviceTokens.push({ label: `${spec.label} (${spec.serial})`, token });
  }

  // A stamping key so a fresh install can take payment on the spot. SANDBOX,
  // with no CSID — which is exactly what preflight refuses to open with. This
  // is a working key, not a legal one, and the difference is enforced.
  const till = await one<{ id: string }>(
    `SELECT id FROM devices WHERE branch_id = $1 AND kind = 'cashier'
      ORDER BY registered_at LIMIT 1`,
    [branchId],
  );
  const hasZatca = await one('SELECT 1 FROM zatca_credentials WHERE device_id = $1',
    [till!.id]);
  if (!hasZatca) {
    const { generateStampKeyPair } = await import('./core/zatca/sign.js');
    const { encryptSecret } = await import('./core/crypto.js');
    const pair = generateStampKeyPair();
    await pool.query(
      `INSERT INTO zatca_credentials
         (branch_id, device_id, environment, private_key_enc, public_key_der,
          onboarding_step, created_by)
       VALUES ($1,$2,'sandbox',$3,$4,'keys',$5)`,
      [branchId, till!.id, encryptSecret(pair.privateKeyPem), pair.publicKeyDer,
       owner!.id],
    );
    log('ZATCA sandbox stamping key generated (no CSID — not valid for live sales)');
  }

  const qrSample = await one<{ qr_token: string }>(
    'SELECT qr_token FROM restaurant_tables WHERE branch_id = $1 AND table_number = $2',
    [branchId, '12'],
  );

  console.log('\n=== MARA seed complete ===');
  console.log(`Branch ID     : ${branchId}`);
  console.log(`Owner login   : owner@maralounge.sa / ${ownerPassword}`);
  console.log(`Manager login : manager@maralounge.sa / ${managerPassword}`);
  console.log('Staff PINs    : 1042/2580 (waiter) 2001/4826 (cashier) 4001/3648 (buyer)');
  console.log('                3001/7192 (bar) 3002/6473 (kitchen) 3003/9265 (shisha)');
  if (agentToken) console.log(`Print agent token: ${agentToken}`);
  for (const d of deviceTokens) {
    console.log(`Device token  : ${d.label} — ${d.token}`);
  }
  if (deviceTokens.length > 0) {
    console.log('                (stored hashed — this is the only time they are shown)');
  }
  if (qrSample) console.log(`Table 12 QR   : /menu/${buildQrValue(qrSample.qr_token)}`);
  console.log('Demo customer : خالد +966551234567 — 320 points, shisha 65 → 45 SAR (OTP required)');
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Seed failed:', err);
    await closePool().catch(() => {});
    process.exit(1);
  });
