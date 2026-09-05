/** Production department a product is routed to for printing. */
export const DEPARTMENTS = ['BAR', 'KITCHEN', 'SHISHA', 'OTHER'] as const;
export type Department = (typeof DEPARTMENTS)[number];

export const DEPARTMENT_LABELS_AR: Record<Department, string> = {
  BAR: 'البار',
  KITCHEN: 'المطبخ',
  SHISHA: 'المعسل',
  OTHER: 'أخرى',
};

/** Live state of a table, driven by sessions, orders and service requests. */
export const TABLE_STATUSES = [
  'available',
  'occupied',
  'new_order',
  'waiter_requested',
  'charcoal_requested',
  'bill_requested',
] as const;
export type TableStatus = (typeof TABLE_STATUSES)[number];

export const TABLE_STATUS_LABELS_AR: Record<TableStatus, string> = {
  available: 'متاحة',
  occupied: 'مشغولة',
  new_order: 'طلب جديد',
  waiter_requested: 'طلب ويتر',
  charcoal_requested: 'طلب فحم',
  bill_requested: 'طلب الحساب',
};

export const ORDER_STATUSES = [
  'draft',
  'pending_waiter_approval',
  // A platform order nobody at the branch has agreed to cook yet. It reaches
  // no printer until someone accepts it — the kitchen may be out of an item,
  // and a rider should not be dispatched for food nobody can make.
  'pending_delivery_acceptance',
  'confirmed',
  'printed',
  'partially_updated',
  'ready_for_billing',
  'bill_requested',
  'paid',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABELS_AR: Record<OrderStatus, string> = {
  draft: 'مسودة',
  pending_waiter_approval: 'بانتظار موافقة الويتر',
  pending_delivery_acceptance: 'بانتظار قبول التوصيل',
  confirmed: 'مؤكد',
  printed: 'مطبوع',
  partially_updated: 'محدّث جزئياً',
  ready_for_billing: 'جاهز للفوترة',
  bill_requested: 'طلب الحساب',
  paid: 'مدفوع',
  cancelled: 'ملغي',
};

/**
 * Order status transitions. Enforced server-side; every transition is stamped
 * into order_status_history with actor and timestamp.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  draft: ['pending_waiter_approval', 'pending_delivery_acceptance', 'confirmed', 'cancelled'],
  pending_waiter_approval: ['confirmed', 'cancelled'],
  pending_delivery_acceptance: ['confirmed', 'cancelled'],
  confirmed: ['printed', 'cancelled'],
  printed: ['partially_updated', 'ready_for_billing', 'bill_requested', 'paid', 'cancelled'],
  partially_updated: ['printed', 'ready_for_billing', 'bill_requested', 'paid', 'cancelled'],
  ready_for_billing: ['bill_requested', 'paid', 'cancelled'],
  bill_requested: ['paid', 'ready_for_billing', 'cancelled'],
  paid: [],
  cancelled: [],
};

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Where an order came from. Anything not placed by someone standing in the
 * restaurant has to be accepted before it prints.
 */
export const ORDER_SOURCES = ['pos', 'customer_qr', 'waiter', 'delivery'] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

export const ORDER_TYPES = ['dine_in', 'takeaway', 'delivery'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const PAYMENT_METHODS = [
  'cash', 'mada', 'visa', 'mastercard', 'apple_pay', 'wallet_points',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS_AR: Record<PaymentMethod, string> = {
  cash: 'نقدي',
  mada: 'مدى',
  visa: 'فيزا',
  mastercard: 'ماستركارد',
  apple_pay: 'Apple Pay',
  wallet_points: 'نقاط المحفظة',
};

/** Purchase request lifecycle, exactly as specified. */
export const PURCHASE_REQUEST_STATUSES = [
  'draft',
  'submitted',
  'pending_branch_manager',
  'approved',
  'rejected',
  'sent_to_buyer',
  'purchasing',
  'purchased',
  'in_transit',
  'delivered',
  'received',
  'closed',
  'cancelled',
] as const;
export type PurchaseRequestStatus = (typeof PURCHASE_REQUEST_STATUSES)[number];

export const PR_STATUS_LABELS_AR: Record<PurchaseRequestStatus, string> = {
  draft: 'مسودة',
  submitted: 'مُرسل',
  pending_branch_manager: 'بانتظار مدير الفرع',
  approved: 'معتمد',
  rejected: 'مرفوض',
  sent_to_buyer: 'أُرسل للمندوب',
  purchasing: 'جاري الشراء',
  purchased: 'تم الشراء',
  in_transit: 'في الطريق',
  delivered: 'تم التسليم',
  received: 'تم الاستلام',
  closed: 'مغلق',
  cancelled: 'ملغي',
};

/**
 * The ONLY statuses the purchasing rep may ever see. Enforced in SQL, not in
 * the UI — a buyer must never learn that an unapproved request exists.
 */
export const BUYER_VISIBLE_PR_STATUSES: readonly PurchaseRequestStatus[] = [
  'approved', 'sent_to_buyer', 'purchasing', 'purchased',
  'in_transit', 'delivered', 'received', 'closed',
] as const;

/** Statuses the buyer app itself is allowed to move a request through. */
export const BUYER_STATUS_FLOW: Record<string, PurchaseRequestStatus[]> = {
  approved: ['purchasing'],
  sent_to_buyer: ['purchasing'],
  purchasing: ['purchased'],
  purchased: ['in_transit'],
  in_transit: ['delivered'],
  delivered: [],
};

export const PR_TRANSITIONS: Record<PurchaseRequestStatus, PurchaseRequestStatus[]> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['pending_branch_manager', 'cancelled'],
  pending_branch_manager: ['approved', 'rejected', 'cancelled'],
  approved: ['sent_to_buyer', 'purchasing', 'cancelled', 'pending_branch_manager'],
  rejected: ['pending_branch_manager', 'cancelled'],
  sent_to_buyer: ['purchasing', 'cancelled', 'pending_branch_manager'],
  purchasing: ['purchased', 'pending_branch_manager', 'cancelled'],
  purchased: ['in_transit', 'pending_branch_manager'],
  in_transit: ['delivered'],
  delivered: ['received'],
  received: ['closed'],
  closed: [],
  cancelled: [],
};

export function canTransitionPR(
  from: PurchaseRequestStatus,
  to: PurchaseRequestStatus,
): boolean {
  return PR_TRANSITIONS[from]?.includes(to) ?? false;
}

export const PR_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type PurchaseRequestPriority = (typeof PR_PRIORITIES)[number];

export const WASTE_REASONS = [
  'expired', 'damaged', 'preparation_error', 'dropped', 'customer_return',
  'trial', 'staff_consumption', 'overuse', 'other',
] as const;
export type WasteReason = (typeof WASTE_REASONS)[number];

export const WASTE_REASON_LABELS_AR: Record<WasteReason, string> = {
  expired: 'منتهي الصلاحية',
  damaged: 'تالف',
  preparation_error: 'خطأ تحضير',
  dropped: 'سقوط',
  customer_return: 'إرجاع عميل',
  trial: 'تجربة',
  staff_consumption: 'استهلاك موظفين',
  overuse: 'استخدام زائد',
  other: 'أخرى',
};

export const OTP_PURPOSES = [
  'customer_login',
  'order_verification',
  'customer_discount',
  'points_redemption',
] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export const SERVICE_REQUEST_TYPES = ['waiter', 'charcoal', 'bill'] as const;
export type ServiceRequestType = (typeof SERVICE_REQUEST_TYPES)[number];

export const PRINT_JOB_KINDS = [
  'new_order', 'add_item', 'void', 'reprint', 'charcoal_request', 'bill',
] as const;
export type PrintJobKind = (typeof PRINT_JOB_KINDS)[number];

export const PRINT_JOB_STATUSES = [
  'queued', 'claimed', 'printed', 'failed', 'cancelled',
] as const;
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number];

export const STOCK_COUNT_TYPES = ['daily', 'weekly', 'monthly', 'ad_hoc'] as const;
export type StockCountType = (typeof STOCK_COUNT_TYPES)[number];

/** Every movement that can touch stock. Ledger is append-only. */
export const INVENTORY_TXN_TYPES = [
  'receive', 'transfer_out', 'transfer_in', 'recipe_consumption',
  'waste', 'count_adjustment', 'manual_adjustment', 'return_to_supplier',
] as const;
export type InventoryTxnType = (typeof INVENTORY_TXN_TYPES)[number];

export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];
