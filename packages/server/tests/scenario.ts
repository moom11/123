import type { FastifyInstance } from 'fastify';
import {
  auth, getApp, getBranchId, getCustomerId, getItemId, getProductId,
  getQrValue, getTableId, loginAdmin, loginEmployee, otpCapture,
} from './helpers.js';
import { one, pool } from '../src/core/db.js';

/**
 * The two journeys the specification spells out, executed end to end.
 * Used directly as a test, and as setup for the audit assertions.
 */

export interface CustomerJourneyResult {
  orderId: string;
  orderNumber: string;
  discountApplied: number;
  pointsUsed: number;
  finalTotal: number;
  printJobDepartments: string[];
  voidedItemId: string | null;
}

/**
 * Khalid sits at table 12, scans the QR, verifies his phone, orders a shisha,
 * a flat white and a dessert; the waiter approves; each item routes to its own
 * printer; his special shisha price and his points are applied, each behind its
 * own OTP; he pays.
 */
export async function runCustomerJourney(): Promise<CustomerJourneyResult> {
  const app = await getApp();
  const qrValue = await getQrValue('12');
  const customerId = await getCustomerId();

  // --- Khalid verifies his phone over WhatsApp -------------------------------
  otpCapture.clear();
  const otpRequest = await app.inject({
    method: 'POST', url: '/api/public/auth/request-otp',
    payload: { phone: '0551234567', qrValue },
  });
  const verified = await app.inject({
    method: 'POST', url: '/api/public/auth/verify-otp',
    payload: {
      otpRequestId: otpRequest.json().otpRequestId,
      code: otpCapture.lastCode(),
      qrValue, name: 'خالد', marketingConsent: true,
    },
  });
  const customerToken = verified.json().accessToken;

  // --- He orders from his phone ---------------------------------------------
  const shisha = await getProductId('معسل تفاحتين');
  const flatWhite = await getProductId('فلات وايت');
  const dessert = await getProductId('كيك الشوكولاتة');

  const placed = await app.inject({
    method: 'POST', url: '/api/public/orders',
    headers: { authorization: `Bearer ${customerToken}` },
    payload: {
      qrValue,
      lines: [
        { productId: shisha, quantity: 1 },
        { productId: flatWhite, quantity: 1 },
        { productId: dessert, quantity: 1 },
      ],
      idempotencyKey: `journey-${Date.now()}`,
    },
  });
  const { orderId, orderNumber } = placed.json();

  // --- The waiter for table 12 reviews and confirms --------------------------
  const waiter = await loginEmployee('1043', '1379');
  await app.inject({
    method: 'POST', url: `/api/orders/${orderId}/review`,
    headers: auth(waiter), payload: { decision: 'approve' },
  });

  const jobs = await pool.query<{ department: string }>(
    `SELECT p.department FROM print_jobs pj JOIN printers p ON p.id = pj.printer_id
      WHERE pj.order_id = $1 ORDER BY p.department`,
    [orderId],
  );

  // --- His special shisha price, behind his own OTP --------------------------
  const cashier = await loginEmployee('2001', '4826');
  otpCapture.clear();
  const discountOtp = await app.inject({
    method: 'POST', url: `/api/orders/${orderId}/discount/request-otp`,
    headers: auth(cashier), payload: { customerId },
  });
  const discountApplied = await app.inject({
    method: 'POST', url: `/api/orders/${orderId}/discount/apply`,
    headers: auth(cashier),
    payload: {
      customerId,
      otpRequestId: discountOtp.json().otpRequestId,
      operationRef: discountOtp.json().operationRef,
      code: otpCapture.lastCode(),
    },
  });

  // --- His points, behind a DIFFERENT OTP -----------------------------------
  await pool.query(
    'UPDATE customer_wallets SET points_balance = GREATEST(points_balance, 320) WHERE customer_id = $1',
    [customerId],
  );
  otpCapture.clear();
  const pointsOtp = await app.inject({
    method: 'POST', url: `/api/orders/${orderId}/points/request-otp`,
    headers: auth(cashier), payload: { customerId, points: 100 },
  });
  const redeemed = await app.inject({
    method: 'POST', url: `/api/orders/${orderId}/points/redeem`,
    headers: auth(cashier),
    payload: {
      customerId,
      otpRequestId: pointsOtp.json().otpRequestId,
      operationRef: pointsOtp.json().operationRef,
      code: otpCapture.lastCode(),
    },
  });

  // --- An item is added after printing, then voided --------------------------
  await app.inject({
    method: 'POST', url: `/api/orders/${orderId}/items`, headers: auth(cashier),
    payload: { lines: [{ productId: flatWhite, quantity: 1 }] },
  });
  const extra = await one<{ id: string }>(
    `SELECT id FROM order_items WHERE order_id = $1 ORDER BY line_number DESC LIMIT 1`,
    [orderId],
  );
  const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
  await app.inject({
    method: 'POST', url: `/api/orders/${orderId}/items/${extra!.id}/void`,
    headers: auth(manager), payload: { reason: 'طلب العميل الإلغاء' },
  });

  // --- Payment ---------------------------------------------------------------
  const current = await one<{ grand_total: number }>(
    'SELECT grand_total FROM orders WHERE id = $1', [orderId],
  );
  await app.inject({
    method: 'POST', url: `/api/orders/${orderId}/pay`, headers: auth(cashier),
    payload: {
      parts: [{ method: 'mada', amount: Number(current!.grand_total), reference: 'APPR-1' }],
      idempotencyKey: `journey-pay-${Date.now()}`,
    },
  });

  return {
    orderId, orderNumber,
    discountApplied: discountApplied.json().totalDiscount ?? 0,
    pointsUsed: redeemed.json().pointsUsed ?? 0,
    finalTotal: Number(current!.grand_total),
    printJobDepartments: jobs.rows.map((r) => r.department),
    voidedItemId: extra!.id,
  };
}

export interface PurchaseJourneyResult {
  requestId: string;
  requestNumber: string;
  approvedQuantity: number;
  purchasedQuantity: number;
  receivedQuantity: number;
}

/**
 * The bar sees milk running low, asks for 60 L, the manager approves 40 L, the
 * rep buys 40 L and records the invoice, walks the delivery statuses, and the
 * bar confirms receipt — which is the only step that moves stock.
 */
export async function runPurchaseJourney(): Promise<PurchaseJourneyResult> {
  const app = await getApp();
  const bar = await loginEmployee('3001', '7192');
  const manager = await loginAdmin('manager@maralounge.sa', 'MaraManager#2026Xy');
  const buyer = await loginEmployee('4001', '3648');
  const milk = await getItemId('ING-MILK');
  const branchId = await getBranchId();

  const created = await app.inject({
    method: 'POST', url: '/api/purchase-requests', headers: auth(bar),
    payload: {
      department: 'BAR', reason: 'Low Stock', priority: 'high', submit: true,
      items: [{ itemId: milk, quantity: 60, unit: 'l', reason: 'الحليب على وشك النفاد' }],
    },
  });
  const requestId = created.json().id;

  await app.inject({
    method: 'POST', url: `/api/purchase-requests/${requestId}/decide`,
    headers: auth(manager),
    payload: {
      decision: 'approve', comment: '40 لتر تكفي',
      itemQuantities: [{ itemId: milk, approvedQuantity: 40, unit: 'l' }],
    },
  });

  const supplier = await one<{ id: string }>(
    "SELECT id FROM suppliers WHERE name = 'مؤسسة الإمداد للأغذية'",
  );

  await app.inject({
    method: 'POST', url: `/api/buyer/requests/${requestId}/status`,
    headers: auth(buyer), payload: { status: 'purchasing' },
  });
  await app.inject({
    method: 'POST', url: `/api/buyer/requests/${requestId}/purchase`,
    headers: auth(buyer),
    payload: {
      supplierId: supplier!.id, invoiceNumber: 'INV-MILK-2026-01',
      items: [{ itemId: milk, quantity: 40, unit: 'l', unitPrice: 620 }],
    },
  });
  for (const status of ['purchased', 'in_transit', 'delivered'] as const) {
    await app.inject({
      method: 'POST', url: `/api/buyer/requests/${requestId}/status`,
      headers: auth(buyer), payload: { status },
    });
  }

  const barLocation = await one<{ id: string }>(
    "SELECT id FROM inventory_locations WHERE code = 'BAR' AND branch_id = $1", [branchId],
  );
  await app.inject({
    method: 'POST', url: `/api/purchase-requests/${requestId}/receive`,
    headers: auth(bar),
    payload: {
      locationId: barLocation!.id,
      items: [{ itemId: milk, receivedQuantity: 40, unit: 'l' }],
    },
  });

  const item = await one<{
    approved_quantity: number; purchased_quantity: number; received_quantity: number;
  }>(
    'SELECT approved_quantity, purchased_quantity, received_quantity FROM purchase_request_items WHERE request_id = $1',
    [requestId],
  );

  return {
    requestId,
    requestNumber: created.json().requestNumber,
    approvedQuantity: Number(item!.approved_quantity),
    purchasedQuantity: Number(item!.purchased_quantity),
    receivedQuantity: Number(item!.received_quantity),
  };
}
