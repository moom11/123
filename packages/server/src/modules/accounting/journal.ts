/**
 * Turning a day of trading into journal entries.
 *
 * Pure: rows in, balanced double-entry out. No database, no clock, no
 * rounding — every figure is already an integer number of halalas, and the
 * arithmetic here only adds and subtracts them, so a journal either balances
 * exactly or there is a bug. There is no "close enough" in a ledger.
 *
 * The shape of a sales entry:
 *
 *   Dr  Cash / cards / points        what was actually collected
 *   Dr  Discounts                    what was given away
 *     Cr  Revenue                    the sale, less the VAT inside it
 *     Cr  VAT payable                the state's share
 *
 * Discounts are a debit to contra-revenue rather than a smaller credit to
 * revenue, because "we sold 10,000 and gave away 1,500" is a fact an owner
 * needs and "we sold 8,500" hides.
 *
 * **Menu prices in Saudi Arabia include VAT**, and this system stores them
 * that way: an invoice's `subtotal` is what the guest was quoted, `grand_total`
 * is that less any discount, and `vat_amount` is the tax contained within the
 * total rather than added on top (`net - round(net * 100 / (100 + rate))`).
 * So revenue is credited with `subtotal - vat_amount` and the discount is
 * debited at the value printed on the bill.
 *
 * That pairing is chosen because it balances with the integers as stored, and
 * because their difference — the net taxable base — comes out exactly right:
 * the VAT contained in the discount appears in both lines and cancels. The
 * tidier-looking alternative, splitting the discount into net and tax, needs a
 * division this module does not have the figures to do exactly, and a ledger
 * that is out by a halala because of a rounding choice is worse than one whose
 * discount line is quoted the way the guest saw it.
 *
 * A credit note is the same entry with every sign reversed, never a deletion:
 * the original sale stays in the ledger it was reported in.
 */
import { accountForPaymentMethod, type AccountMap } from './accounts.js';

export interface JournalLine {
  /** ISO date, in the branch's own timezone: a ledger day is a trading day. */
  date: string;
  account: string;
  accountName: string;
  description: string;
  debit: number;
  credit: number;
  reference: string;
}

export interface InvoiceTotals {
  date: string;
  documentType: 'invoice' | 'credit_note' | 'debit_note';
  invoiceNumber: string;
  subtotal: number;
  discountTotal: number;
  vatAmount: number;
  grandTotal: number;
}

export interface PaymentTotals {
  date: string;
  method: string;
  amount: number;
}

export interface PurchaseTotals {
  date: string;
  purchaseNumber: string;
  supplier: string;
  subtotal: number;
  vatAmount: number;
  total: number;
}

export interface WasteTotals {
  date: string;
  department: string;
  cost: number;
}

export interface JournalInput {
  invoices: InvoiceTotals[];
  payments: PaymentTotals[];
  purchases: PurchaseTotals[];
  waste: WasteTotals[];
  accounts: AccountMap;
  accountNames: Record<string, string>;
}

/**
 * One journal per day, not per invoice.
 *
 * A month of trading is tens of thousands of tickets, and no accountant wants
 * them one by one. The invoice register (exported separately) is where an
 * individual sale is looked up; the journal is where the month is posted.
 */
export function buildJournal(input: JournalInput): JournalLine[] {
  const { accounts, accountNames } = input;
  const name = (key: keyof AccountMap): string => accountNames[key] ?? key;
  const lines: JournalLine[] = [];

  const days = new Set<string>([
    ...input.invoices.map((i) => i.date),
    ...input.payments.map((p) => p.date),
    ...input.purchases.map((p) => p.date),
    ...input.waste.map((w) => w.date),
  ]);

  for (const date of [...days].sort()) {
    // --- Sales -------------------------------------------------------------
    // A credit note is the same entry backwards, so its figures are simply
    // negated and summed with the day's invoices.
    const sign = (t: InvoiceTotals) => (t.documentType === 'credit_note' ? -1 : 1);
    const dayInvoices = input.invoices.filter((i) => i.date === date);
    const gross = sum(dayInvoices.map((i) => sign(i) * i.subtotal));
    const discount = sum(dayInvoices.map((i) => sign(i) * i.discountTotal));
    const vat = sum(dayInvoices.map((i) => sign(i) * i.vatAmount));
    const billed = sum(dayInvoices.map((i) => sign(i) * i.grandTotal));

    const collectedByAccount = new Map<keyof AccountMap, number>();
    for (const payment of input.payments.filter((p) => p.date === date)) {
      const key = accountForPaymentMethod(payment.method, accounts);
      collectedByAccount.set(key, (collectedByAccount.get(key) ?? 0) + payment.amount);
    }
    const collected = sum([...collectedByAccount.values()]);

    if (gross !== 0 || discount !== 0 || vat !== 0 || collected !== 0) {
      for (const [key, amount] of collectedByAccount) {
        if (amount === 0) continue;
        lines.push(entry(date, accounts[key], name(key),
          'متحصلات المبيعات', amount, 0, `SALES-${date}`));
      }
      if (discount !== 0) {
        lines.push(entry(date, accounts.discounts, name('discounts'),
          'خصومات على المبيعات', discount, 0, `SALES-${date}`));
      }
      // Gross less the VAT inside it: what the business actually earned.
      const revenue = gross - vat;
      if (revenue !== 0) {
        lines.push(entry(date, accounts.revenue, name('revenue'),
          'مبيعات اليوم (بدون الضريبة)', 0, revenue, `SALES-${date}`));
      }
      if (vat !== 0) {
        lines.push(entry(date, accounts.vatPayable, name('vatPayable'),
          'ضريبة القيمة المضافة على المبيعات', 0, vat, `SALES-${date}`));
      }

      // What was billed and what was taken must agree. When they do not — an
      // unpaid bill left open at close, a payment recorded on the wrong day —
      // the gap goes to a named account that is supposed to be empty, so it
      // reaches the accountant as a question instead of disappearing.
      const gap = billed - collected;
      if (gap !== 0) {
        lines.push(gap > 0
          ? entry(date, accounts.suspense, name('suspense'),
              'فرق بين الفواتير والمقبوضات', gap, 0, `SALES-${date}`)
          : entry(date, accounts.suspense, name('suspense'),
              'فرق بين الفواتير والمقبوضات', 0, -gap, `SALES-${date}`));
      }
    }

    // --- Purchases ---------------------------------------------------------
    // Recorded against the supplier rather than against cash: what was bought
    // and when it was paid for are two different events, and a buyer's receipt
    // only evidences the first.
    for (const purchase of input.purchases.filter((p) => p.date === date)) {
      if (purchase.subtotal !== 0) {
        lines.push(entry(date, accounts.inventory, name('inventory'),
          `مشتريات — ${purchase.supplier}`, purchase.subtotal, 0, purchase.purchaseNumber));
      }
      if (purchase.vatAmount !== 0) {
        lines.push(entry(date, accounts.vatReceivable, name('vatReceivable'),
          `ضريبة مشتريات — ${purchase.supplier}`, purchase.vatAmount, 0,
          purchase.purchaseNumber));
      }
      if (purchase.total !== 0) {
        lines.push(entry(date, accounts.accountsPayable, name('accountsPayable'),
          `مستحق للمورد ${purchase.supplier}`, 0, purchase.total, purchase.purchaseNumber));
      }
    }

    // --- Waste -------------------------------------------------------------
    for (const waste of input.waste.filter((w) => w.date === date)) {
      if (waste.cost === 0) continue;
      lines.push(entry(date, accounts.wasteExpense, name('wasteExpense'),
        `هدر — ${waste.department}`, waste.cost, 0, `WASTE-${date}`));
      lines.push(entry(date, accounts.inventory, name('inventory'),
        `هدر — ${waste.department}`, 0, waste.cost, `WASTE-${date}`));
    }
  }

  return lines;
}

/** Debits minus credits. Zero, or the journal is wrong. */
export function imbalance(lines: JournalLine[]): number {
  return sum(lines.map((l) => l.debit)) - sum(lines.map((l) => l.credit));
}

export function journalTotals(lines: JournalLine[]) {
  return {
    lines: lines.length,
    debit: sum(lines.map((l) => l.debit)),
    credit: sum(lines.map((l) => l.credit)),
    imbalance: imbalance(lines),
  };
}

function entry(
  date: string, account: string, accountName: string,
  description: string, debit: number, credit: number, reference: string,
): JournalLine {
  // A negative debit is a credit written the wrong way round; normalising here
  // keeps every consumer of these lines from having to think about signs.
  if (debit < 0) return entry(date, account, accountName, description, 0, -debit, reference);
  if (credit < 0) return entry(date, account, accountName, description, -credit, 0, reference);
  return { date, account, accountName, description, debit, credit, reference };
}

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
