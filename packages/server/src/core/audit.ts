import type { Queryable } from './db.js';
import { pool } from './db.js';

/**
 * The audit log is append-only and deliberately has no update or delete path
 * anywhere in this codebase. Every sensitive action writes exactly one row.
 */
export interface AuditEntry {
  action: string;                 // 'order.discount.applied'
  branchId?: string | null;
  actorUserId?: string | null;
  actorEmployeeId?: string | null;
  actorLabel?: string | null;
  actorKind?: 'user' | 'employee' | 'customer' | 'system' | 'print_agent';
  entityType?: string | null;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * Write an audit row. When a client is supplied the write joins the caller's
 * transaction, so an action and its audit trail commit or roll back together —
 * there is never a logged action that did not happen, or an action with no log.
 */
export async function audit(entry: AuditEntry, client?: Queryable): Promise<void> {
  const runner = client ?? pool;
  await runner.query(
    `INSERT INTO audit_logs (
       branch_id, actor_user_id, actor_employee_id, actor_label, actor_kind,
       action, entity_type, entity_id, old_value, new_value, metadata,
       ip, user_agent, request_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      entry.branchId ?? null,
      entry.actorUserId ?? null,
      entry.actorEmployeeId ?? null,
      entry.actorLabel ?? null,
      entry.actorKind ?? 'user',
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.oldValue === undefined ? null : JSON.stringify(entry.oldValue),
      entry.newValue === undefined ? null : JSON.stringify(entry.newValue),
      JSON.stringify(entry.metadata ?? {}),
      entry.ip ?? null,
      entry.userAgent ?? null,
      entry.requestId ?? null,
    ],
  );
}

/** Canonical action names. Using constants keeps report filters honest. */
export const AUDIT = {
  LOGIN_SUCCESS: 'auth.login.success',
  LOGIN_FAILED: 'auth.login.failed',
  LOGIN_MFA_REQUIRED: 'auth.login.mfa_required',
  LOGIN_MFA_FAILED: 'auth.login.mfa_failed',
  PIN_LOGIN_SUCCESS: 'auth.pin_login.success',
  PIN_LOGIN_FAILED: 'auth.pin_login.failed',
  LOGOUT: 'auth.logout',
  SESSION_REVOKED: 'auth.session.revoked',
  SESSION_REUSE_DETECTED: 'auth.session.reuse_detected',
  PASSWORD_CHANGED: 'auth.password.changed',
  MFA_ENROLLED: 'auth.mfa.enrolled',
  MFA_DISABLED: 'auth.mfa.disabled',

  USER_CREATED: 'admin.user.created',
  USER_UPDATED: 'admin.user.updated',
  USER_DISABLED: 'admin.user.disabled',
  ROLE_ASSIGNED: 'admin.role.assigned',
  PERMISSION_GRANTED: 'admin.permission.granted',
  PERMISSION_REVOKED: 'admin.permission.revoked',
  SETTING_UPDATED: 'admin.setting.updated',

  EMPLOYEE_CREATED: 'employee.created',
  EMPLOYEE_UPDATED: 'employee.updated',
  EMPLOYEE_PIN_RESET: 'employee.pin.reset',
  EMPLOYEE_DISABLED: 'employee.disabled',

  PRODUCT_PRICE_CHANGED: 'menu.product.price_changed',
  PRODUCT_CREATED: 'menu.product.created',
  PRODUCT_UPDATED: 'menu.product.updated',
  PRODUCT_AVAILABILITY: 'menu.product.availability_changed',
  PRODUCT_RETIRED: 'menu.product.retired',
  CATEGORY_SAVED: 'menu.category.saved',
  MODIFIER_SAVED: 'menu.modifier.saved',

  ORDER_CREATED: 'order.created',
  ORDER_SUBMITTED: 'order.submitted',
  ORDER_APPROVED: 'order.approved',
  ORDER_REJECTED: 'order.rejected',
  ORDER_ITEM_ADDED: 'order.item.added',
  ORDER_ITEM_VOIDED: 'order.item.voided',
  ORDER_EDITED: 'order.edited',
  ORDER_CANCELLED: 'order.cancelled',
  ORDER_PAID: 'order.paid',
  ORDER_MOVED: 'order.moved_table',
  TABLES_MERGED: 'table.merged',

  DISCOUNT_APPLIED: 'order.discount.applied',
  DISCOUNT_REJECTED: 'order.discount.rejected',
  POINTS_REDEEMED: 'wallet.points.redeemed',
  WALLET_ADJUSTED: 'wallet.adjusted',
  SPECIAL_PRICE_CREATED: 'customer.special_price.created',
  SPECIAL_PRICE_UPDATED: 'customer.special_price.updated',

  OTP_ISSUED: 'otp.issued',
  OTP_VERIFIED: 'otp.verified',
  OTP_FAILED: 'otp.failed',

  DELIVERY_RECEIVED: 'delivery.received',
  DELIVERY_ACCEPTED: 'delivery.accepted',
  DELIVERY_REJECTED: 'delivery.rejected',
  DELIVERY_REPLAYED: 'delivery.replayed',
  DELIVERY_PARTNER_SAVED: 'delivery.partner.saved',

  DEVICE_REGISTERED: 'device.registered',
  DEVICE_RETIRED: 'device.retired',
  DEVICE_TOKEN_ROTATED: 'device.token_rotated',

  INVOICE_ISSUED: 'invoice.issued',
  INVOICE_REPORTED: 'invoice.reported',
  INVOICE_REPORT_FAILED: 'invoice.report_failed',
  INVOICE_CREDIT_NOTE: 'invoice.credit_note',
  ZATCA_PROVISIONED: 'invoice.zatca.provisioned',
  ZATCA_CERTIFICATE_STORED: 'invoice.zatca.certificate_stored',

  PRINT_QUEUED: 'print.queued',
  PRINT_SUCCEEDED: 'print.succeeded',
  PRINT_FAILED: 'print.failed',
  REPRINT: 'print.reprint',

  INVENTORY_RECEIVED: 'inventory.received',
  INVENTORY_ADJUSTED: 'inventory.adjusted',
  INVENTORY_TRANSFERRED: 'inventory.transferred',
  RECIPE_CONSUMED: 'inventory.recipe_consumed',
  WASTE_RECORDED: 'inventory.waste.recorded',
  WASTE_APPROVED: 'inventory.waste.approved',
  STOCK_COUNT_OPENED: 'inventory.count.opened',
  STOCK_COUNT_SUBMITTED: 'inventory.count.submitted',
  STOCK_COUNT_APPROVED: 'inventory.count.approved',

  PR_CREATED: 'purchase_request.created',
  PR_SUBMITTED: 'purchase_request.submitted',
  PR_APPROVED: 'purchase_request.approved',
  PR_REJECTED: 'purchase_request.rejected',
  PR_QUANTITY_CHANGED: 'purchase_request.quantity_changed',
  PR_CHANGE_REQUESTED: 'purchase_request.change_requested',
  PR_STATUS_CHANGED: 'purchase_request.status_changed',
  PURCHASE_RECORDED: 'purchase.recorded',
  PURCHASE_RECEIVED: 'purchase.received',
  SUPPLIER_CREATED: 'supplier.created',
  SUPPLIER_UPDATED: 'supplier.updated',
} as const;
