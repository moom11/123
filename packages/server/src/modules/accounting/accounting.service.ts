/**
 * The accounting export.
 *
 * A restaurant's books are not made in the restaurant. Once a month someone
 * outside it needs the same period expressed the way a ledger expresses it,
 * and the alternative to this module is a person re-keying a POS report into
 * accounting software — which is slow, and which is where the numbers stop
 * agreeing with the tax return.
 *
 * Three things are exported, and they answer three different questions:
 *
 *   the journal    — how the month posts, as balanced double entry
 *   the invoices   — what was sold, ticket by ticket, with its ZATCA identity
 *   the purchases  — what was bought, with the supplier's own invoice number
 *
 * Everything is read-only. Nothing here writes to a financial record, and the
 * export never marks anything as "exported" — a period that can only be pulled
 * once is a period that gets lost the first time an email fails to send.
 */
import { many, one } from '../../core/db.js';
import { badRequest } from '../../core/errors.js';
import { AUDIT, audit } from '../../core/audit.js';
import type { Principal } from '../../core/principal.js';
import { assertBranchAccess } from '../../core/principal.js';
import {
  ACCOUNT_NAMES_AR, resolveAccounts, type AccountMap,
} from './accounts.js';
import {
  buildJournal, journalTotals, type JournalLine,
} from './journal.js';
import { amount, toCsv } from './csv.js';

export interface Period { from: string; to: string }

/**
 * A period is a pair of calendar dates in the branch's own timezone.
 *
 * Not timestamps: an accountant asks for September, and September in Riyadh is
 * not September in UTC. Every query below converts at the database rather than
 * hoping the caller sent the right instant.
 */
function checkPeriod(period: Period): Period {
  const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isDate(period.from) || !isDate(period.to)) {
    throw badRequest('التاريخ يجب أن يكون بصيغة YYYY-MM-DD');
  }
  if (period.from > period.to) throw badRequest('تاريخ البداية بعد تاريخ النهاية');
  return period;
}

async function branchContext(branchId: string): Promise<{
  timeZone: string; accounts: AccountMap; branchName: string; vatNumber: string | null;
}> {
  const branch = await one<{ timezone: string | null; name_ar: string; vat_number: string | null }>(
    'SELECT timezone, name_ar, vat_number FROM branches WHERE id = $1', [branchId],
  );
  const setting = await one<{ value: unknown }>(
    `SELECT value FROM settings WHERE key = 'accounting_accounts'
       AND (branch_id = $1 OR branch_id IS NULL)
      ORDER BY branch_id NULLS LAST LIMIT 1`,
    [branchId],
  );
  return {
    timeZone: branch?.timezone ?? 'Asia/Riyadh',
    accounts: resolveAccounts(setting?.value),
    branchName: branch?.name_ar ?? '',
    vatNumber: branch?.vat_number ?? null,
  };
}

/** The four row sets the journal is built from. */
async function gather(branchId: string, period: Period, timeZone: string) {
  const args = [branchId, period.from, period.to, timeZone];

  const invoices = await many<{
    date: string; document_type: string; invoice_number: string;
    subtotal: string; discount_total: string; vat_amount: string; grand_total: string;
  }>(
    `SELECT to_char(i.issued_at AT TIME ZONE $4, 'YYYY-MM-DD') AS date,
            i.document_type, i.invoice_number,
            i.subtotal::text, i.discount_total::text,
            i.vat_amount::text, i.grand_total::text
       FROM invoices i
      WHERE i.branch_id = $1
        AND (i.issued_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
      ORDER BY i.issued_at, i.icv`,
    args,
  );

  const payments = await many<{
    date: string; method: string; amount: string; refunded: string;
  }>(
    `SELECT to_char(p.created_at AT TIME ZONE $4, 'YYYY-MM-DD') AS date,
            p.method,
            -- What was actually kept. A refund is money that left the drawer,
            -- so posting the gross would overstate the day's takings.
            sum(p.amount - COALESCE(p.refunded_amount, 0))::text AS amount,
            COALESCE(sum(p.refunded_amount), 0)::text AS refunded
       FROM payments p
      WHERE p.branch_id = $1
        AND (p.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
        -- A voided payment never happened as far as the ledger is concerned;
        -- the sale it belonged to is corrected by a credit note, not by a
        -- silently different cash figure.
        AND p.voided_at IS NULL
        AND p.status <> 'voided'
      GROUP BY 1, 2`,
    args,
  );

  const purchases = await many<{
    date: string; purchase_number: string; supplier: string;
    subtotal: string; vat_amount: string; total: string; invoice_number: string | null;
  }>(
    `SELECT to_char(pu.purchased_at AT TIME ZONE $4, 'YYYY-MM-DD') AS date,
            pu.purchase_number, COALESCE(s.name, 'مورد') AS supplier,
            pu.subtotal::text, pu.vat_amount::text, pu.total::text, pu.invoice_number
       FROM purchases pu
       LEFT JOIN suppliers s ON s.id = pu.supplier_id
      WHERE pu.branch_id = $1
        AND (pu.purchased_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
        AND pu.status <> 'cancelled'
      ORDER BY pu.purchased_at`,
    args,
  );

  const waste = await many<{ date: string; department: string; cost: string }>(
    `SELECT to_char(w.occurred_at AT TIME ZONE $4, 'YYYY-MM-DD') AS date,
            COALESCE(w.department, 'غير محدد') AS department,
            COALESCE(sum(w.estimated_cost), 0)::text AS cost
       FROM waste_records w
      WHERE w.branch_id = $1
        AND (w.occurred_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
        -- Only stock actually written off. A pending record is a request.
        AND w.status = 'posted'
      GROUP BY 1, 2`,
    args,
  );

  return { invoices, payments, purchases, waste };
}

const n = (v: unknown): number => Number(v ?? 0);

export async function journal(
  principal: Principal, branchId: string, period: Period,
): Promise<{ lines: JournalLine[]; totals: ReturnType<typeof journalTotals> }> {
  assertBranchAccess(principal, branchId);
  checkPeriod(period);
  const { timeZone, accounts } = await branchContext(branchId);
  const rows = await gather(branchId, period, timeZone);

  const lines = buildJournal({
    accounts,
    accountNames: ACCOUNT_NAMES_AR,
    invoices: rows.invoices.map((i) => ({
      date: i.date,
      documentType: i.document_type as 'invoice' | 'credit_note' | 'debit_note',
      invoiceNumber: i.invoice_number,
      subtotal: n(i.subtotal), discountTotal: n(i.discount_total),
      vatAmount: n(i.vat_amount), grandTotal: n(i.grand_total),
    })),
    payments: rows.payments.map((p) => ({
      date: p.date, method: p.method, amount: n(p.amount),
    })),
    purchases: rows.purchases.map((p) => ({
      date: p.date, purchaseNumber: p.purchase_number, supplier: p.supplier,
      subtotal: n(p.subtotal), vatAmount: n(p.vat_amount), total: n(p.total),
    })),
    waste: rows.waste.map((w) => ({
      date: w.date, department: w.department, cost: n(w.cost),
    })),
  });

  return { lines, totals: journalTotals(lines) };
}

/**
 * The period in the shape a VAT return asks for.
 *
 * Deliberately the same numbers the journal posts, read off the same rows:
 * a summary that is computed separately is a summary that will eventually
 * disagree with the ledger it is supposed to describe.
 */
export async function summary(principal: Principal, branchId: string, period: Period) {
  assertBranchAccess(principal, branchId);
  checkPeriod(period);
  const { timeZone, accounts, branchName, vatNumber } = await branchContext(branchId);
  const rows = await gather(branchId, period, timeZone);

  const sign = (t: string) => (t === 'credit_note' ? -1 : 1);
  const sales = rows.invoices.reduce((acc, i) => {
    const s = sign(i.document_type);
    acc.gross += s * n(i.subtotal);
    acc.discounts += s * n(i.discount_total);
    acc.vat += s * n(i.vat_amount);
    acc.billed += s * n(i.grand_total);
    acc.count += 1;
    if (i.document_type === 'credit_note') acc.creditNotes += 1;
    return acc;
  }, { gross: 0, discounts: 0, vat: 0, billed: 0, count: 0, creditNotes: 0 });

  const byMethod = rows.payments.reduce<Record<string, number>>((acc, p) => {
    acc[p.method] = (acc[p.method] ?? 0) + n(p.amount);
    return acc;
  }, {});
  const collected = Object.values(byMethod).reduce((a, b) => a + b, 0);
  // Shown rather than only netted: a refund is recorded against the payment it
  // reverses, so it posts on the day of the sale even when it was given back a
  // week later. That is a real limitation of the underlying record, and an
  // accountant reconciling a bank statement needs to be told, not protected
  // from it.
  const refunded = rows.payments.reduce((a, p) => a + n(p.refunded), 0);

  const purchases = rows.purchases.reduce((acc, p) => {
    acc.net += n(p.subtotal); acc.vat += n(p.vat_amount); acc.total += n(p.total);
    acc.count += 1;
    return acc;
  }, { net: 0, vat: 0, total: 0, count: 0 });

  const wasteCost = rows.waste.reduce((a, w) => a + n(w.cost), 0);
  const built = await journal(principal, branchId, period);

  return {
    branch: { id: branchId, name: branchName, vatNumber },
    period, timeZone, accounts,
    // gross    — the menu value of what was sold, VAT included, as quoted
    // billed    — that less discounts: what the guests were actually charged
    // net       — the taxable base, billed less the VAT contained in it
    sales: { ...sales, net: sales.billed - sales.vat },
    payments: { byMethod, collected, refunded },
    // Billed and collected must agree. When they do not, this is the number an
    // accountant needs before anything else in the period is believable.
    unreconciled: sales.billed - collected,
    purchases,
    waste: { cost: wasteCost },
    // Output VAT less input VAT: what the period owes, before adjustments.
    vat: { output: sales.vat, input: purchases.vat, net: sales.vat - purchases.vat },
    journal: built.totals,
  };
}

// --- The files ---------------------------------------------------------------

export async function journalCsv(
  principal: Principal, branchId: string, period: Period,
): Promise<string> {
  const { lines } = await journal(principal, branchId, period);
  await record(principal, branchId, period, 'journal', lines.length);
  return toCsv(
    ['التاريخ', 'الحساب', 'اسم الحساب', 'البيان', 'مدين', 'دائن', 'المرجع'],
    lines.map((l) => [
      l.date, l.account, l.accountName, l.description,
      amount(l.debit), amount(l.credit), l.reference,
    ]),
  );
}

/**
 * The invoice register.
 *
 * Carries the ZATCA identity of every document — the counter, the hash it
 * chained onto, and whether the Authority acknowledged it. An auditor asking
 * "is this the complete sequence" can answer it from this file alone, which is
 * the whole reason the counter is in it.
 */
export async function invoicesCsv(
  principal: Principal, branchId: string, period: Period,
): Promise<string> {
  assertBranchAccess(principal, branchId);
  checkPeriod(period);
  const { timeZone } = await branchContext(branchId);

  const rows = await many<Record<string, string | null>>(
    `SELECT to_char(i.issued_at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI') AS issued,
            i.invoice_number, i.document_type, i.icv::text,
            o.order_number, COALESCE(c.full_name, '') AS customer,
            i.subtotal::text, i.discount_total::text, i.vat_amount::text,
            i.grand_total::text, i.report_status, i.zatca_status,
            COALESCE(to_char(i.reported_at AT TIME ZONE $4, 'YYYY-MM-DD HH24:MI'), '') AS reported
       FROM invoices i
       LEFT JOIN orders o ON o.id = i.order_id
       LEFT JOIN customers c ON c.id = o.customer_id
      WHERE i.branch_id = $1
        AND (i.issued_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
      ORDER BY i.icv`,
    [branchId, period.from, period.to, timeZone],
  );
  await record(principal, branchId, period, 'invoices', rows.length);

  return toCsv(
    ['التاريخ', 'رقم الفاتورة', 'النوع', 'العداد', 'رقم الطلب', 'العميل',
     'قبل الضريبة', 'الخصم', 'الضريبة', 'الإجمالي', 'حالة الإبلاغ',
     'رد الهيئة', 'وقت الإبلاغ'],
    rows.map((r) => [
      r.issued, r.invoice_number,
      r.document_type === 'credit_note' ? 'إشعار دائن' : 'فاتورة',
      r.icv, r.order_number, r.customer,
      amount(n(r.subtotal)), amount(n(r.discount_total)),
      amount(n(r.vat_amount)), amount(n(r.grand_total)),
      r.report_status, r.zatca_status ?? '', r.reported,
    ]),
  );
}

export async function purchasesCsv(
  principal: Principal, branchId: string, period: Period,
): Promise<string> {
  assertBranchAccess(principal, branchId);
  checkPeriod(period);
  const { timeZone } = await branchContext(branchId);

  const rows = await many<Record<string, string | null>>(
    `SELECT to_char(pu.purchased_at AT TIME ZONE $4, 'YYYY-MM-DD') AS purchased,
            pu.purchase_number, COALESCE(s.name, '') AS supplier,
            COALESCE(s.vat_number, '') AS supplier_vat,
            COALESCE(pu.invoice_number, '') AS invoice_number,
            pu.subtotal::text, pu.vat_amount::text, pu.total::text, pu.status
       FROM purchases pu
       LEFT JOIN suppliers s ON s.id = pu.supplier_id
      WHERE pu.branch_id = $1
        AND (pu.purchased_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
        AND pu.status <> 'cancelled'
      ORDER BY pu.purchased_at`,
    [branchId, period.from, period.to, timeZone],
  );
  await record(principal, branchId, period, 'purchases', rows.length);

  return toCsv(
    ['التاريخ', 'رقم أمر الشراء', 'المورد', 'الرقم الضريبي للمورد',
     'رقم فاتورة المورد', 'قبل الضريبة', 'الضريبة', 'الإجمالي', 'الحالة'],
    rows.map((r) => [
      r.purchased, r.purchase_number, r.supplier, r.supplier_vat, r.invoice_number,
      amount(n(r.subtotal)), amount(n(r.vat_amount)), amount(n(r.total)), r.status,
    ]),
  );
}

/**
 * Every export is audited.
 *
 * This file leaves the building: it carries customer names, the full sales
 * history of a period, and the branch's tax position. Who pulled it and for
 * which period is a thing the owner is entitled to know.
 */
async function record(
  principal: Principal, branchId: string, period: Period, kind: string, rows: number,
): Promise<void> {
  await audit({
    action: AUDIT.ACCOUNTING_EXPORTED,
    actorUserId: principal.userId ?? null,
    actorEmployeeId: principal.employeeId ?? null,
    actorLabel: principal.displayName,
    branchId,
    entityType: 'accounting_export',
    metadata: { kind, from: period.from, to: period.to, rows },
  });
}
