import type { PoolClient } from 'pg';
import { many, one, pool, withTransaction } from '../../core/db.js';
import { maskPhone } from '../../core/crypto.js';
import { AUDIT, audit } from '../../core/audit.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import type { Principal } from '../../core/principal.js';
import { normalisePhone } from './whatsapp.provider.js';

export interface CustomerSummary {
  id: string;
  customerCode: string;
  fullName: string | null;
  phone: string;
  phoneMasked: string;
  phoneVerified: boolean;
  visitCount: number;
  orderCount: number;
  totalSpend: number;
  averageTicket: number;
  points: number;
  pointsValue: number;
  lastVisitAt: string | null;
}

/**
 * Find an existing customer by phone or create one.
 *
 * The phone number is the identity: it is normalised to E.164 first and carries
 * a unique index, so the same person scanning a QR from two different phones
 * still resolves to one account and one wallet.
 */
export async function findOrCreateByPhone(
  rawPhone: string,
  opts: { branchId?: string | null; createdBy?: string | null; name?: string | null } = {},
  client?: PoolClient,
): Promise<{ id: string; phone: string; isNew: boolean; fullName: string | null }> {
  const phone = normalisePhone(rawPhone);
  const runner = client ?? pool;

  const existing = await one<{ id: string; phone: string; full_name: string | null; is_blocked: boolean }>(
    'SELECT id, phone, full_name, is_blocked FROM customers WHERE phone = $1',
    [phone], runner,
  );
  if (existing) {
    if (existing.is_blocked) throw unprocessable('هذا الحساب موقوف، راجع الإدارة');
    return { id: existing.id, phone: existing.phone, isNew: false, fullName: existing.full_name };
  }

  const { rows } = await runner.query<{ id: string; phone: string; full_name: string | null }>(
    `INSERT INTO customers (customer_code, phone, full_name, home_branch_id, created_by)
     VALUES ('C' || lpad((nextval('customer_code_seq'))::text, 6, '0'), $1, $2, $3, $4)
     ON CONFLICT (phone) DO UPDATE SET updated_at = now()
     RETURNING id, phone, full_name`,
    [phone, opts.name ?? null, opts.branchId ?? null, opts.createdBy ?? null],
  );
  const created = rows[0];

  // Every customer has exactly one wallet, created with them.
  await runner.query(
    `INSERT INTO customer_wallets (customer_id) VALUES ($1)
     ON CONFLICT (customer_id) DO NOTHING`,
    [created.id],
  );

  return { id: created.id, phone: created.phone, isNew: true, fullName: created.full_name };
}

export async function markPhoneVerified(customerId: string, client?: PoolClient): Promise<void> {
  const runner = client ?? pool;
  await runner.query(
    `UPDATE customers
        SET phone_verified = TRUE,
            phone_verified_at = COALESCE(phone_verified_at, now()),
            first_visit_at = COALESCE(first_visit_at, now())
      WHERE id = $1`,
    [customerId],
  );
}

/** The active loyalty rule for a branch. Falls back to the global rule. */
export async function activeLoyaltyRule(branchId: string | null, client?: PoolClient) {
  const runner = client ?? pool;
  return one<{
    id: string; spend_per_point: number; points_per_block: number;
    block_value: number; min_redeem_points: number; max_redeem_percent: number;
  }>(
    `SELECT id, spend_per_point, points_per_block, block_value,
            min_redeem_points, max_redeem_percent
       FROM loyalty_rules
      WHERE is_active
        AND (branch_id = $1 OR branch_id IS NULL)
        AND effective_from <= now()
        AND (effective_to IS NULL OR effective_to > now())
      ORDER BY branch_id NULLS LAST, effective_from DESC
      LIMIT 1`,
    [branchId], runner,
  );
}

/** Halala value of a points balance under the current rule. */
export function pointsToValue(
  points: number,
  rule: { points_per_block: number; block_value: number },
): number {
  if (points <= 0) return 0;
  // Only whole blocks convert: 150 points at 100/10 SAR is worth 10 SAR.
  const blocks = Math.floor(points / rule.points_per_block);
  return blocks * rule.block_value;
}

/** Points needed to fund a given halala amount. */
export function valueToPoints(
  value: number,
  rule: { points_per_block: number; block_value: number },
): number {
  if (value <= 0) return 0;
  return Math.ceil(value / rule.block_value) * rule.points_per_block;
}

export interface WalletMovement {
  customerId: string;
  branchId?: string | null;
  kind: 'earn' | 'redeem' | 'manual_credit' | 'manual_debit' | 'expiry' | 'reversal';
  pointsDelta?: number;
  creditDelta?: number;
  orderId?: string | null;
  otpRequestId?: string | null;
  reason?: string | null;
  byUserId?: string | null;
  byEmployeeId?: string | null;
}

/**
 * Move a wallet balance and write the matching ledger row, atomically.
 *
 * The wallet row is locked FOR UPDATE, so two tills redeeming the same
 * customer's points at once serialise rather than both succeeding against a
 * stale balance. The CHECK constraint on points_balance is the last line of
 * defence against a negative balance.
 */
export async function moveWallet(
  m: WalletMovement,
  client: PoolClient,
): Promise<{ pointsBalance: number; creditBalance: number; transactionId: string }> {
  const wallet = await one<{ id: string; points_balance: number; credit_balance: number }>(
    'SELECT id, points_balance, credit_balance FROM customer_wallets WHERE customer_id = $1 FOR UPDATE',
    [m.customerId], client,
  );
  if (!wallet) throw notFound('محفظة العميل غير موجودة');

  const pointsDelta = m.pointsDelta ?? 0;
  const creditDelta = m.creditDelta ?? 0;
  const nextPoints = wallet.points_balance + pointsDelta;
  const nextCredit = wallet.credit_balance + creditDelta;

  if (nextPoints < 0) throw unprocessable('رصيد النقاط غير كافٍ');
  if (nextCredit < 0) throw unprocessable('رصيد المحفظة غير كافٍ');

  await client.query(
    `UPDATE customer_wallets
        SET points_balance = $2, credit_balance = $3,
            lifetime_points_earned = lifetime_points_earned + GREATEST($4, 0),
            lifetime_points_redeemed = lifetime_points_redeemed + GREATEST(-$4, 0)
      WHERE id = $1`,
    [wallet.id, nextPoints, nextCredit, pointsDelta],
  );

  const txn = await one<{ id: string }>(
    `INSERT INTO wallet_transactions (
       wallet_id, customer_id, branch_id, kind, points_delta, credit_delta,
       points_balance_after, credit_balance_after, order_id, otp_request_id,
       reason, performed_by_user_id, performed_by_employee_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      wallet.id, m.customerId, m.branchId ?? null, m.kind, pointsDelta, creditDelta,
      nextPoints, nextCredit, m.orderId ?? null, m.otpRequestId ?? null,
      m.reason ?? null, m.byUserId ?? null, m.byEmployeeId ?? null,
    ],
    client,
  );

  return { pointsBalance: nextPoints, creditBalance: nextCredit, transactionId: txn!.id };
}

/**
 * The effective price of a product for a customer.
 *
 * Product-specific rules beat category-wide rules; an absolute price beats a
 * percentage. Returns null when the customer has no special arrangement, which
 * is the overwhelmingly common case.
 */
export async function resolveSpecialPrice(
  customerId: string,
  productId: string,
  categoryId: string,
  branchId: string,
  menuPrice: number,
  client?: PoolClient,
): Promise<{ specialPriceId: string; price: number; requiresOtp: boolean } | null> {
  const rule = await one<{
    id: string; price: number | null; discount_percent: number | null; requires_otp: boolean;
  }>(
    `SELECT id, price, discount_percent, requires_otp
       FROM customer_special_prices
      WHERE customer_id = $1
        AND is_active
        AND (branch_id IS NULL OR branch_id = $4)
        AND valid_from <= now()
        AND (valid_to IS NULL OR valid_to > now())
        AND (product_id = $2 OR (product_id IS NULL AND category_id = $3))
      ORDER BY (product_id IS NOT NULL) DESC, created_at DESC
      LIMIT 1`,
    [customerId, productId, categoryId, branchId], client,
  );
  if (!rule) return null;

  const price = rule.price !== null
    ? rule.price
    : Math.round(menuPrice * (1 - Number(rule.discount_percent ?? 0) / 100));

  // A "special price" above the menu price is a data error, not a discount.
  if (price >= menuPrice) return null;

  return { specialPriceId: rule.id, price, requiresOtp: rule.requires_otp };
}

export async function getCustomerProfile(
  customerId: string,
  principal: Principal | null,
): Promise<Record<string, unknown>> {
  const c = await one<any>(
    `SELECT c.*, w.points_balance, w.credit_balance,
            w.lifetime_points_earned, w.lifetime_points_redeemed
       FROM customers c
       LEFT JOIN customer_wallets w ON w.customer_id = c.id
      WHERE c.id = $1 AND c.deleted_at IS NULL`,
    [customerId],
  );
  if (!c) throw notFound('العميل غير موجود');

  const canSeeFullPhone = principal?.permissions.has('customers.read.full_phone') ?? false;
  const rule = await activeLoyaltyRule(c.home_branch_id);

  const favourites = await many(
    `SELECT p.id, p.name_ar AS name, sum(oi.quantity)::float AS quantity,
            count(*)::int AS times_ordered
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       JOIN products p ON p.id = oi.product_id
      WHERE o.customer_id = $1 AND o.status = 'paid' AND oi.status <> 'voided'
      GROUP BY p.id, p.name_ar
      ORDER BY quantity DESC LIMIT 5`,
    [customerId],
  );

  const consent = await one<{ granted: boolean; granted_at: Date }>(
    `SELECT granted, granted_at FROM customer_consents
      WHERE customer_id = $1 AND channel = 'whatsapp'
      ORDER BY granted_at DESC LIMIT 1`,
    [customerId],
  );

  const specialPrices = await many(
    `SELECT csp.id, csp.price, csp.discount_percent, csp.requires_otp, csp.is_active,
            csp.valid_to, p.name_ar AS product_name, cat.name_ar AS category_name
       FROM customer_special_prices csp
       LEFT JOIN products p ON p.id = csp.product_id
       LEFT JOIN categories cat ON cat.id = csp.category_id
      WHERE csp.customer_id = $1 AND csp.is_active
      ORDER BY csp.created_at DESC`,
    [customerId],
  );

  return {
    id: c.id,
    customerCode: c.customer_code,
    fullName: c.full_name,
    phone: canSeeFullPhone ? c.phone : maskPhone(c.phone),
    phoneMasked: maskPhone(c.phone),
    phoneVerified: c.phone_verified,
    email: canSeeFullPhone ? c.email : null,
    firstVisitAt: c.first_visit_at,
    lastVisitAt: c.last_visit_at,
    visitCount: c.visit_count,
    orderCount: c.order_count,
    totalSpend: c.total_spend,
    averageTicket: c.order_count > 0 ? Math.round(c.total_spend / c.order_count) : 0,
    points: c.points_balance ?? 0,
    pointsValue: rule ? pointsToValue(c.points_balance ?? 0, rule) : 0,
    creditBalance: c.credit_balance ?? 0,
    lifetimePointsEarned: c.lifetime_points_earned ?? 0,
    lifetimePointsRedeemed: c.lifetime_points_redeemed ?? 0,
    favouriteProducts: favourites,
    specialPrices,
    marketingConsent: consent
      ? { granted: consent.granted, at: consent.granted_at, channel: 'whatsapp' }
      : { granted: false, at: null, channel: 'whatsapp' },
    isBlocked: c.is_blocked,
    notes: c.notes,
  };
}

export async function searchCustomers(
  term: string, principal: Principal, limit = 20,
): Promise<CustomerSummary[]> {
  const canSeeFullPhone = principal.permissions.has('customers.read.full_phone');
  // Phone search is exact-suffix rather than fuzzy, so staff cannot enumerate
  // the customer base by typing a couple of digits.
  const rows = await many<any>(
    `SELECT c.id, c.customer_code, c.full_name, c.phone, c.phone_verified,
            c.visit_count, c.order_count, c.total_spend, c.last_visit_at,
            COALESCE(w.points_balance, 0) AS points_balance, c.home_branch_id
       FROM customers c
       LEFT JOIN customer_wallets w ON w.customer_id = c.id
      WHERE c.deleted_at IS NULL
        AND ( c.full_name ILIKE '%' || $1 || '%'
           OR c.customer_code ILIKE $1 || '%'
           OR ($1 ~ '^[0-9+]{4,}$' AND c.phone LIKE '%' || regexp_replace($1, '\\D', '', 'g')) )
      ORDER BY c.last_visit_at DESC NULLS LAST
      LIMIT $2`,
    [term, limit],
  );

  const rule = await activeLoyaltyRule(principal.branchId);
  return rows.map((c) => ({
    id: c.id,
    customerCode: c.customer_code,
    fullName: c.full_name,
    phone: canSeeFullPhone ? c.phone : maskPhone(c.phone),
    phoneMasked: maskPhone(c.phone),
    phoneVerified: c.phone_verified,
    visitCount: c.visit_count,
    orderCount: c.order_count,
    totalSpend: c.total_spend,
    averageTicket: c.order_count > 0 ? Math.round(c.total_spend / c.order_count) : 0,
    points: c.points_balance,
    pointsValue: rule ? pointsToValue(c.points_balance, rule) : 0,
    lastVisitAt: c.last_visit_at,
  }));
}

export async function recordConsent(
  customerId: string,
  granted: boolean,
  source: string,
  meta: { ip?: string | null; userAgent?: string | null },
): Promise<void> {
  await pool.query(
    `INSERT INTO customer_consents (customer_id, channel, granted, source, ip, user_agent)
     VALUES ($1,'whatsapp',$2,$3,$4,$5)`,
    [customerId, granted, source, meta.ip ?? null, meta.userAgent ?? null],
  );
}

export async function setSpecialPrice(
  principal: Principal,
  input: {
    customerId: string; productId?: string | null; categoryId?: string | null;
    branchId: string; price?: number | null; discountPercent?: number | null;
    requiresOtp?: boolean; validTo?: string | null; notes?: string | null;
  },
): Promise<{ id: string }> {
  if (!input.productId && !input.categoryId) {
    throw badRequest('حدد منتجاً أو تصنيفاً للسعر الخاص');
  }
  if (input.price == null && input.discountPercent == null) {
    throw badRequest('حدد سعراً خاصاً أو نسبة خصم');
  }
  if (input.price != null && input.price < 0) throw badRequest('السعر غير صالح');
  if (input.discountPercent != null &&
      (input.discountPercent <= 0 || input.discountPercent > 90)) {
    throw badRequest('نسبة الخصم يجب أن تكون بين 1 و 90');
  }

  const row = await withTransaction(async (client) => {
    const created = await one<{ id: string }>(
      `INSERT INTO customer_special_prices (
         customer_id, product_id, category_id, branch_id, price, discount_percent,
         requires_otp, valid_to, notes, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        input.customerId, input.productId ?? null, input.categoryId ?? null,
        input.branchId, input.price ?? null, input.discountPercent ?? null,
        input.requiresOtp ?? true, input.validTo ?? null, input.notes ?? null,
        principal.userId,
      ],
      client,
    );
    await audit({
      action: AUDIT.SPECIAL_PRICE_CREATED, actorUserId: principal.userId,
      actorLabel: principal.displayName, branchId: input.branchId,
      entityType: 'customer_special_price', entityId: created!.id,
      newValue: input,
    }, client);
    return created!;
  });
  return row;
}
