import { PERMISSIONS, type Permission } from './permissions.js';

/**
 * The twelve principals in the MARA operating model.
 *
 * `customer` is deliberately present but holds no staff permission at all —
 * customer-facing endpoints authenticate against a customer session, never a
 * staff session.
 */
export const ROLES = [
  'owner',
  'super_admin',
  'executive',        // الإدارة العليا
  'branch_manager',
  'accountant',
  'cashier',
  'waiter',
  'bar_staff',
  'kitchen_staff',
  'shisha_staff',
  'floor_staff',
  'buyer',            // مندوب المشتريات
  'customer',
] as const;

export type Role = (typeof ROLES)[number];

/** Roles that must authenticate with Email + Password + MFA. Never PIN. */
export const ADMIN_ROLES: readonly Role[] = [
  'owner',
  'super_admin',
  'executive',
  'branch_manager',
  'accountant',
] as const;

/** Roles that authenticate with Employee ID + PIN on a shared shop device. */
export const OPERATIONAL_ROLES: readonly Role[] = [
  'cashier',
  'waiter',
  'bar_staff',
  'kitchen_staff',
  'shisha_staff',
  'floor_staff',
  'buyer',
] as const;

export function isAdminRole(role: string): boolean {
  return (ADMIN_ROLES as readonly string[]).includes(role);
}

export function isOperationalRole(role: string): boolean {
  return (OPERATIONAL_ROLES as readonly string[]).includes(role);
}

/** Roles allowed to hand out or change role assignments. */
export const ROLE_ADMIN_ROLES: readonly Role[] = ['owner', 'super_admin'] as const;

const ALL: Permission[] = [...PERMISSIONS];

const EXECUTIVE: Permission[] = [
  'admin.users.read', 'admin.roles.read', 'admin.branches.read', 'admin.sessions.read',
  'admin.settings.read',
  'employees.read',
  'menu.read', 'menu.manage', 'menu.price.update', 'menu.availability.update',
  'recipes.read', 'recipes.manage',
  'tables.read',
  'orders.read', 'orders.read.all', 'orders.discount.manual',
  'service.requests.read',
  'customers.read', 'customers.read.full_phone', 'customers.update',
  'customers.wallet.read', 'customers.wallet.adjust',
  'customers.special_prices.read', 'customers.special_prices.manage',
  'loyalty.rules.read', 'loyalty.rules.manage',
  'printers.read', 'print_jobs.read',
  'inventory.read', 'inventory.items.manage', 'waste.read', 'waste.approve',
  'stock_counts.read', 'stock_counts.approve',
  'purchase_requests.read.all', 'purchase_requests.approve',
  'purchases.read', 'suppliers.read', 'suppliers.manage',
  'reports.sales', 'reports.products', 'reports.employees', 'reports.customers',
  'reports.inventory', 'reports.purchasing', 'reports.financial', 'reports.all_branches',
  'promotions.read', 'promotions.manage',
  'delivery.read', 'delivery.accept', 'delivery.manage',
  'devices.read', 'devices.manage',
  'invoices.read', 'invoices.report', 'invoices.credit_note',
  'invoices.manage_credentials',
  'audit.read', 'notifications.read',
];

const BRANCH_MANAGER: Permission[] = [
  // Note: no admin.roles.assign / admin.permissions.grant — a branch manager
  // can never escalate their own or anyone else's privileges.
  'admin.users.read', 'admin.branches.read', 'admin.sessions.read', 'admin.settings.read',
  'employees.read', 'employees.create', 'employees.update', 'employees.pin.reset',
  'employees.disable',
  'menu.read', 'menu.availability.update',
  'recipes.read',
  'tables.read', 'tables.manage', 'tables.assign_waiter', 'tables.open_session',
  'tables.move', 'tables.merge',
  'pos.use',
  'orders.read', 'orders.read.all', 'orders.create', 'orders.add_items',
  'orders.approve_customer_order', 'orders.edit_before_send', 'orders.void_item',
  'orders.cancel', 'orders.reprint', 'orders.discount.apply', 'orders.discount.manual',
  'payments.take', 'payments.split', 'payments.refund',
  'service.requests.read', 'service.requests.resolve',
  'customers.read', 'customers.read.full_phone', 'customers.create', 'customers.update',
  'customers.wallet.read', 'customers.points.redeem', 'customers.special_prices.read',
  'loyalty.rules.read',
  'printers.read', 'printers.manage', 'print_jobs.read', 'print_jobs.retry',
  'inventory.read', 'inventory.items.manage', 'inventory.locations.manage',
  'inventory.receive', 'inventory.transfer.create', 'inventory.transfer.approve',
  'inventory.transfer.receive', 'inventory.adjust',
  'waste.create', 'waste.read', 'waste.approve',
  'stock_counts.create', 'stock_counts.read', 'stock_counts.submit', 'stock_counts.approve',
  'purchase_requests.create', 'purchase_requests.read.branch', 'purchase_requests.approve',
  'purchase_requests.cancel',
  'purchases.read', 'purchases.receive', 'suppliers.read', 'suppliers.manage',
  'reports.sales', 'reports.products', 'reports.employees', 'reports.customers',
  'reports.inventory', 'reports.purchasing',
  'promotions.read', 'promotions.manage',
  'delivery.read', 'delivery.accept', 'delivery.manage',
  // Registering a till is day-to-day work; obtaining its certificate is not.
  'devices.read', 'devices.manage',
  // Not invoices.manage_credentials: the stamping key is the branch's legal
  // identity, and a branch manager may not mint one for themselves.
  'invoices.read', 'invoices.report', 'invoices.credit_note',
  'audit.read', 'notifications.read',
];

const ACCOUNTANT: Permission[] = [
  'admin.branches.read',
  'employees.read',
  'menu.read', 'recipes.read',
  'tables.read',
  'orders.read', 'orders.read.all',
  'customers.read', 'customers.read.full_phone', 'customers.wallet.read',
  'customers.special_prices.read',
  'loyalty.rules.read',
  'print_jobs.read', 'printers.read',
  'inventory.read', 'waste.read', 'stock_counts.read',
  'purchase_requests.read.branch', 'purchases.read', 'suppliers.read',
  'reports.sales', 'reports.products', 'reports.employees', 'reports.customers',
  'reports.inventory', 'reports.purchasing', 'reports.financial',
  'promotions.read',
  'delivery.read',
  'devices.read',
  'invoices.read', 'invoices.report',
  'audit.read', 'notifications.read',
];

const CASHIER: Permission[] = [
  'menu.read', 'menu.availability.update',
  'tables.read', 'tables.open_session', 'tables.move', 'tables.merge',
  'pos.use',
  'orders.read', 'orders.read.all', 'orders.create', 'orders.add_items',
  'orders.approve_customer_order', 'orders.edit_before_send', 'orders.reprint',
  'orders.discount.apply',
  'payments.take', 'payments.split',
  'service.requests.read', 'service.requests.resolve',
  'customers.read', 'customers.create', 'customers.wallet.read',
  'customers.points.redeem', 'customers.special_prices.read',
  'print_jobs.read', 'print_jobs.retry', 'printers.read',
  // The cashier is who decides, mid-shift, that the kitchen can cook a
  // platform order — but never who holds the platform's keys.
  'promotions.read',
  'delivery.read', 'delivery.accept',
  // A cashier reprints receipts, and a reprint must carry the same QR.
  'invoices.read',
  'notifications.read',
];

const WAITER: Permission[] = [
  'menu.read',
  'tables.read', 'tables.open_session',
  'pos.use',
  'orders.read', 'orders.create', 'orders.add_items',
  'orders.approve_customer_order', 'orders.edit_before_send',
  'orders.discount.apply',
  'service.requests.read', 'service.requests.resolve',
  'customers.read', 'customers.create', 'customers.wallet.read',
  'customers.points.redeem', 'customers.special_prices.read',
  'notifications.read',
];

/** Department staff: no POS, no customers, no reports. Stock duties only. */
const DEPARTMENT_STAFF: Permission[] = [
  'menu.read', 'menu.availability.update',
  'recipes.read',
  'inventory.read', 'inventory.receive', 'inventory.transfer.create',
  'inventory.transfer.receive',
  'waste.create', 'waste.read',
  'stock_counts.create', 'stock_counts.read', 'stock_counts.submit',
  'purchase_requests.create', 'purchase_requests.read.own_department',
  'purchases.receive',
  'suppliers.read',
  'notifications.read',
];

/**
 * The purchasing rep. Deliberately narrow: no POS, no customers, no financial
 * reports, and — enforced again in the query layer — no sight of any purchase
 * request that a branch manager has not yet approved.
 */
const BUYER: Permission[] = [
  'purchasing.buyer',
  'purchase_requests.read.all',
  'purchases.read',
  'suppliers.read',
  'inventory.read',
  'notifications.read',
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ALL,
  super_admin: ALL,
  executive: EXECUTIVE,
  branch_manager: BRANCH_MANAGER,
  accountant: ACCOUNTANT,
  cashier: CASHIER,
  waiter: WAITER,
  bar_staff: DEPARTMENT_STAFF,
  kitchen_staff: DEPARTMENT_STAFF,
  shisha_staff: DEPARTMENT_STAFF,
  floor_staff: DEPARTMENT_STAFF,
  buyer: BUYER,
  customer: [],
};

export const ROLE_LABELS_AR: Record<Role, string> = {
  owner: 'المالك',
  super_admin: 'مدير النظام',
  executive: 'الإدارة العليا',
  branch_manager: 'مدير الفرع',
  accountant: 'المحاسب',
  cashier: 'الكاشير',
  waiter: 'ويتر',
  bar_staff: 'موظف البار',
  kitchen_staff: 'موظف المطبخ',
  shisha_staff: 'موظف المعسل',
  floor_staff: 'موظف الصالة',
  buyer: 'مندوب المشتريات',
  customer: 'عميل',
};
