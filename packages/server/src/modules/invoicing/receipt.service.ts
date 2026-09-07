/**
 * Printing the customer's copy.
 *
 * Queued after the payment transaction commits, never inside it: a printer
 * that is offline, out of paper, or simply slow must not roll back a
 * settlement the customer has already paid. The invoice is the legal record;
 * the paper is a copy of it, and a copy can be reprinted.
 */
import { one } from '../../core/db.js';
import { queueJob, resolvePrinter } from '../printing/printing.service.js';

interface ReceiptRow {
  id: string; branch_id: string; order_id: string; invoice_number: string;
  qr_tlv: string; subtotal: string; discount_total: string; vat_amount: string;
  vat_percent: string; grand_total: string; document_type: string; issued_at: Date;
}

export async function queueReceipt(
  invoiceId: string,
  by: { userId?: string | null; employeeId?: string | null; cashierName?: string | null },
): Promise<{ jobId: string } | null> {
  const invoice = await one<ReceiptRow>('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
  if (!invoice) return null;

  const branch = await one<{ name_ar: string; vat_number: string | null; address: string | null }>(
    'SELECT name_ar, vat_number, address FROM branches WHERE id = $1', [invoice.branch_id],
  );
  if (!branch?.vat_number) return null;

  const order = await one<{
    order_number: string; table_number: string | null; customer_name: string | null;
  }>(
    `SELECT o.order_number, t.table_number, c.full_name AS customer_name
       FROM orders o
       LEFT JOIN restaurant_tables t ON t.id = o.table_id
       LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.id = $1`,
    [invoice.order_id],
  );

  const items = await one<{ rows: unknown }>(
    `SELECT COALESCE(json_agg(json_build_object(
              'name', p.name_ar,
              'quantity', oi.quantity::float,
              'unitPrice', oi.effective_unit_price,
              'lineTotal', oi.line_total - COALESCE(oi.discount_amount, 0)
            ) ORDER BY oi.created_at), '[]'::json) AS rows
       FROM order_items oi JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1 AND oi.status <> 'voided'`,
    [invoice.order_id],
  );

  const payment = await one<{ method: string; change_given: string }>(
    `SELECT method, change_given FROM payments
      WHERE order_id = $1 AND status = 'captured' ORDER BY created_at LIMIT 1`,
    [invoice.order_id],
  );

  // The receipt goes to the till, which is where the customer is standing.
  const printer = await resolvePrinter(invoice.branch_id, 'CASHIER');
  if (!printer) return null;

  const isCreditNote = invoice.document_type === 'credit_note';
  const job = await queueJob({
    branchId: invoice.branch_id,
    printerId: printer.id,
    orderId: invoice.order_id,
    kind: isCreditNote ? 'credit_note' : 'receipt',
    byUserId: by.userId ?? null,
    byEmployeeId: by.employeeId ?? null,
    payload: {
      header: 'MARA LOUNGE',
      kind: isCreditNote ? 'credit_note' : 'receipt',
      branchNameAr: branch.name_ar,
      vatNumber: branch.vat_number,
      address: branch.address,
      invoiceNumber: invoice.invoice_number,
      orderNumber: order?.order_number ?? null,
      tableNumber: order?.table_number ?? null,
      cashierName: by.cashierName ?? null,
      customerName: order?.customer_name ?? null,
      time: invoice.issued_at.toISOString(),
      isCreditNote,
      items: items?.rows as never,
      subtotal: Number(invoice.subtotal),
      discountTotal: Number(invoice.discount_total),
      vatAmount: Number(invoice.vat_amount),
      vatPercent: Number(invoice.vat_percent),
      grandTotal: Number(invoice.grand_total),
      paidBy: payment?.method ?? null,
      changeGiven: Number(payment?.change_given ?? 0),
      qr: invoice.qr_tlv,
      footer: 'شكراً لزيارتكم',
    } as never,
  });

  return { jobId: job.id };
}
