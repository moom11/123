/**
 * MARA Lounge — Permission catalogue.
 *
 * Permissions are the ONLY authority for what a principal may do. The backend
 * checks them on every endpoint; the frontend merely uses them to decide what
 * to render. Hiding a button is never a security control.
 */

export const PERMISSIONS = [
  // --- Platform / administration -------------------------------------------
  'admin.users.read',
  'admin.users.create',
  'admin.users.update',
  'admin.users.disable',
  'admin.roles.read',
  'admin.roles.assign',        // change which role a user holds (Owner/Super Admin only)
  'admin.permissions.grant',   // grant/revoke individual permission overrides
  'admin.branches.read',
  'admin.branches.manage',
  'admin.sessions.read',
  'admin.sessions.revoke',
  'admin.settings.read',
  'admin.settings.update',

  // --- Employees ------------------------------------------------------------
  'employees.read',
  'employees.create',
  'employees.update',
  'employees.pin.reset',
  'employees.disable',

  // --- Menu / catalogue -----------------------------------------------------
  'menu.read',
  'menu.manage',               // categories, products, modifiers
  'menu.price.update',         // change the public price of a product
  'menu.availability.update',  // mark items in/out of stock

  // --- Recipes --------------------------------------------------------------
  'recipes.read',
  'recipes.manage',

  // --- Tables ---------------------------------------------------------------
  'tables.read',
  'tables.manage',             // create/edit tables, regenerate QR
  'tables.assign_waiter',
  'tables.open_session',
  'tables.move',
  'tables.merge',

  // --- Orders / POS ---------------------------------------------------------
  'pos.use',
  'orders.read',
  'orders.read.all',           // beyond own orders / own tables
  'orders.create',
  'orders.add_items',
  'orders.approve_customer_order',  // waiter reviewing a QR order
  'orders.edit_before_send',
  'orders.void_item',          // cancel an item after it was printed
  'orders.cancel',
  'orders.reprint',
  'orders.discount.apply',     // apply a customer special price / discount
  'orders.discount.manual',    // apply an ad-hoc discount (management only)
  'payments.take',
  'payments.split',
  'payments.refund',

  // --- Service requests -----------------------------------------------------
  'service.requests.read',
  'service.requests.resolve',

  // --- Customers ------------------------------------------------------------
  'customers.read',
  'customers.read.full_phone', // see the unmasked phone number
  'customers.create',
  'customers.update',
  'customers.wallet.read',
  'customers.wallet.adjust',   // manual wallet credit/debit (management only)
  'customers.points.redeem',   // drive a points redemption (requires customer OTP)
  'customers.special_prices.read',
  'customers.special_prices.manage',

  // --- Loyalty --------------------------------------------------------------
  'loyalty.rules.read',
  'loyalty.rules.manage',

  // --- Printing -------------------------------------------------------------
  'printers.read',
  'printers.manage',
  'print_jobs.read',
  'print_jobs.retry',

  // --- Inventory ------------------------------------------------------------
  'inventory.read',
  'inventory.items.manage',
  'inventory.locations.manage',
  'inventory.receive',
  'inventory.transfer.create',
  'inventory.transfer.approve',
  'inventory.transfer.receive',
  'inventory.adjust',
  'waste.create',
  'waste.read',
  'waste.approve',
  'stock_counts.create',
  'stock_counts.read',
  'stock_counts.submit',
  'stock_counts.approve',

  // --- Purchasing -----------------------------------------------------------
  'purchase_requests.create',
  'purchase_requests.read.own_department',
  'purchase_requests.read.branch',
  'purchase_requests.read.all',
  'purchase_requests.approve',   // branch manager: approve / reject / edit qty
  'purchase_requests.cancel',
  'purchasing.buyer',            // the purchasing rep: sees ONLY approved requests
  'purchases.read',
  'purchases.receive',           // department confirms goods received
  'suppliers.read',
  'suppliers.manage',

  // --- Reporting ------------------------------------------------------------
  'reports.sales',
  'reports.products',
  'reports.employees',
  'reports.customers',
  'reports.inventory',
  'reports.purchasing',
  'reports.financial',
  'reports.all_branches',

  // --- Devices ---------------------------------------------------------------
  // Which terminal is which is an operating decision (the till closes bills,
  // the tablet does not) and a compliance one (a till is a ZATCA EGS unit).
  'devices.read',
  'devices.manage',

  // --- E-invoicing (ZATCA) ---------------------------------------------------
  // Reading an invoice is an everyday cashier need (reprint a receipt).
  // Managing credentials is not: whoever holds them can stamp invoices in the
  // branch's name, so it sits with the owner alongside the other keys.
  'invoices.read',
  'invoices.report',             // flush the reporting queue by hand
  'invoices.credit_note',        // issue a correction against a settled invoice
  'invoices.manage_credentials',

  // --- Audit / notifications -------------------------------------------------
  'audit.read',
  'notifications.read',
  'notifications.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_SET: ReadonlySet<string> = new Set<string>(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}
