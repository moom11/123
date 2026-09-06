import { afterAll, describe, expect, test } from 'vitest';
import {
  auth, authAtTill, closeApp, getApp, getBranchId, getTableId, loginAdmin, loginEmployee,
} from './helpers.js';
import { one, pool } from '../src/core/db.js';
import { DEFAULT_ACCOUNTS, ACCOUNT_NAMES_AR, resolveAccounts } from '../src/modules/accounting/accounts.js';
import { buildJournal, imbalance } from '../src/modules/accounting/journal.js';
import { amount, toCsv } from '../src/modules/accounting/csv.js';

const OWNER = { email: 'owner@maralounge.sa', password: 'MaraOwner#2026Xy' };

afterAll(async () => { await closeApp(); });

async function ownerHeaders(): Promise<Record<string, string>> {
  const session = await loginAdmin(OWNER.email, OWNER.password);
  return { ...auth(session), 'x-branch-id': await getBranchId() };
}

const base = {
  accounts: DEFAULT_ACCOUNTS, accountNames: ACCOUNT_NAMES_AR,
  invoices: [], payments: [], purchases: [], waste: [],
};

/**
 * Menu prices include VAT, which is how this system stores them: `subtotal` is
 * the quoted value, `grandTotal` is that less the discount, and `vatAmount` is
 * the tax contained within — not added on top. 115.00 quoted at 15% is 100.00
 * of revenue and 15.00 of tax.
 */
const invoice = (over: Partial<Parameters<typeof buildJournal>[0]['invoices'][0]> = {}) => ({
  date: '2026-09-01', documentType: 'invoice' as const, invoiceNumber: 'INV-1',
  subtotal: 11_500, discountTotal: 0, vatAmount: 1_500, grandTotal: 11_500,
  ...over,
});

describe('the journal', () => {
  test('a plain cash sale balances to the halala', () => {
    const lines = buildJournal({
      ...base,
      invoices: [invoice()],
      payments: [{ date: '2026-09-01', method: 'cash', amount: 11_500 }],
    });
    expect(imbalance(lines)).toBe(0);
    const cash = lines.find((l) => l.account === DEFAULT_ACCOUNTS.cash);
    expect(cash?.debit).toBe(11_500);
    expect(lines.find((l) => l.account === DEFAULT_ACCOUNTS.revenue)?.credit).toBe(10_000);
    expect(lines.find((l) => l.account === DEFAULT_ACCOUNTS.vatPayable)?.credit).toBe(1_500);
    // 115.00 taken at the till is 100.00 earned and 15.00 owed to the state.
    expect(cash!.debit).toBe(10_000 + 1_500);
  });

  test('a discount is a debit to contra-revenue, not a smaller sale', () => {
    // "We sold 100 and gave away 15" is a fact the owner needs; "we sold 85"
    // hides it.
    const lines = buildJournal({
      ...base,
      // 115.00 quoted, 15.00 off, 100.00 charged, of which 13.04 is tax.
      invoices: [invoice({ subtotal: 11_500, discountTotal: 1_500,
                           vatAmount: 1_304, grandTotal: 10_000 })],
      payments: [{ date: '2026-09-01', method: 'mada', amount: 10_000 }],
    });
    expect(imbalance(lines)).toBe(0);
    expect(lines.find((l) => l.account === DEFAULT_ACCOUNTS.revenue)?.credit)
      .toBe(11_500 - 1_304);
    expect(lines.find((l) => l.account === DEFAULT_ACCOUNTS.discounts)?.debit).toBe(1_500);
    // What was actually earned: 100.00 charged less 13.04 of tax.
    const revenue = lines.find((l) => l.account === DEFAULT_ACCOUNTS.revenue)!.credit
      - lines.find((l) => l.account === DEFAULT_ACCOUNTS.discounts)!.debit;
    expect(revenue).toBe(10_000 - 1_304);
  });

  test('a credit note reverses the entry rather than deleting the sale', () => {
    const lines = buildJournal({
      ...base,
      invoices: [
        invoice(),
        invoice({ documentType: 'credit_note', invoiceNumber: 'CN-1' }),
      ],
      payments: [],
    });
    // The two cancel out exactly, and the journal still balances.
    expect(imbalance(lines)).toBe(0);
    expect(lines.filter((l) => l.account === DEFAULT_ACCOUNTS.revenue)).toEqual([]);
  });

  test('a credit note on its own posts as a debit to revenue', () => {
    const lines = buildJournal({
      ...base,
      invoices: [invoice({ documentType: 'credit_note', date: '2026-09-02' })],
      payments: [{ date: '2026-09-02', method: 'cash', amount: -11_500 }],
    });
    expect(imbalance(lines)).toBe(0);
    const reversed = lines.find((l) => l.account === DEFAULT_ACCOUNTS.revenue);
    expect(reversed?.debit).toBe(10_000);
    expect(reversed?.credit).toBe(0);
  });

  test('points spent are a liability discharged, never cash taken', () => {
    const lines = buildJournal({
      ...base,
      invoices: [invoice({ grandTotal: 11_500 })],
      payments: [
        { date: '2026-09-01', method: 'cash', amount: 6_500 },
        { date: '2026-09-01', method: 'wallet_points', amount: 5_000 },
      ],
    });
    expect(imbalance(lines)).toBe(0);
    expect(lines.find((l) => l.account === DEFAULT_ACCOUNTS.cash)?.debit).toBe(6_500);
    // Counting these as cash would tell the owner the drawer holds 115 riyals
    // when it holds 65.
    expect(lines.find((l) => l.account === DEFAULT_ACCOUNTS.loyaltyLiability)?.debit)
      .toBe(5_000);
  });

  test('a gap between what was billed and what was taken is named, not absorbed',
    () => {
      const lines = buildJournal({
        ...base,
        invoices: [invoice({ grandTotal: 11_500 })],
        payments: [{ date: '2026-09-01', method: 'cash', amount: 10_000 }],
      });
      expect(imbalance(lines)).toBe(0);
      const suspense = lines.find((l) => l.account === DEFAULT_ACCOUNTS.suspense);
      expect(suspense?.debit).toBe(1_500);
      // The whole point: it is visible as its own account, not folded into cash.
      expect(lines.find((l) => l.account === DEFAULT_ACCOUNTS.cash)?.debit).toBe(10_000);
    });

  test('purchases post against the supplier, not against cash', () => {
    const lines = buildJournal({
      ...base,
      purchases: [{ date: '2026-09-03', purchaseNumber: 'PO-1', supplier: 'مؤسسة',
                    subtotal: 20_000, vatAmount: 3_000, total: 23_000 }],
    });
    expect(imbalance(lines)).toBe(0);
    expect(lines.find((l) => l.account === DEFAULT_ACCOUNTS.accountsPayable)?.credit)
      .toBe(23_000);
    expect(lines.find((l) => l.account === DEFAULT_ACCOUNTS.cash)).toBeUndefined();
  });

  test('waste moves value out of stock and into an expense', () => {
    const lines = buildJournal({
      ...base,
      waste: [{ date: '2026-09-04', department: 'kitchen', cost: 4_200 }],
    });
    expect(imbalance(lines)).toBe(0);
    expect(lines.find((l) => l.account === DEFAULT_ACCOUNTS.wasteExpense)?.debit).toBe(4_200);
    expect(lines.find((l) => l.account === DEFAULT_ACCOUNTS.inventory)?.credit).toBe(4_200);
  });

  test('a mixed month of everything still balances exactly', () => {
    const lines = buildJournal({
      ...base,
      invoices: [
        invoice({ date: '2026-09-01', subtotal: 87_650, discountTotal: 3_310,
                  vatAmount: 11_002, grandTotal: 84_340 }),
        invoice({ date: '2026-09-02', documentType: 'credit_note',
                  subtotal: 4_500, discountTotal: 0, vatAmount: 587, grandTotal: 4_500 }),
        invoice({ date: '2026-09-02', subtotal: 31_337, discountTotal: 999,
                  vatAmount: 3_961, grandTotal: 30_338 }),
      ],
      payments: [
        { date: '2026-09-01', method: 'cash', amount: 40_000 },
        { date: '2026-09-01', method: 'mada', amount: 44_340 },
        { date: '2026-09-02', method: 'visa', amount: 25_838 },
      ],
      purchases: [{ date: '2026-09-02', purchaseNumber: 'PO-9', supplier: 'س',
                    subtotal: 7_777, vatAmount: 1_166, total: 8_943 }],
      waste: [{ date: '2026-09-01', department: 'bar', cost: 313 }],
    });
    expect(imbalance(lines)).toBe(0);
  });

  test('the account codes are an operator setting, not a constant', () => {
    const accounts = resolveAccounts({ cash: '1001', revenue: '40100', nonsense: 'x' });
    expect(accounts.cash).toBe('1001');
    expect(accounts.revenue).toBe('40100');
    // An unknown key is ignored, and everything else keeps its default.
    expect(accounts.vatPayable).toBe(DEFAULT_ACCOUNTS.vatPayable);
  });

  test('an empty or malformed override does not blank an account code', () => {
    expect(resolveAccounts({ cash: '' }).cash).toBe(DEFAULT_ACCOUNTS.cash);
    expect(resolveAccounts({ cash: 1010 }).cash).toBe(DEFAULT_ACCOUNTS.cash);
    expect(resolveAccounts(null)).toEqual(DEFAULT_ACCOUNTS);
  });
});

describe('the file itself', () => {
  test('it starts with a byte order mark, or Excel mangles every Arabic name', () => {
    expect(toCsv(['اسم'], [['الصندوق']]).charCodeAt(0)).toBe(0xfeff);
  });

  test('a cell that looks like a formula is defused', () => {
    // A supplier named "=cmd|..." would otherwise execute when the finance
    // department opens the file.
    const csv = toCsv(['a'], [['=SUM(A1:A9)'], ['+1'], ['-x'], ['@x']]);
    for (const line of csv.split('\r\n').slice(1, 5)) {
      expect(line.startsWith("'")).toBe(true);
    }
  });

  test('quotes and commas survive a round trip', () => {
    const csv = toCsv(['a', 'b'], [['يحتوي, فاصلة', 'يحتوي "اقتباس"']]);
    expect(csv).toContain('"يحتوي, فاصلة"');
    expect(csv).toContain('"يحتوي ""اقتباس"""');
  });

  test('amounts decimate exactly, where floating point would not', () => {
    // 1_000_005 / 100 is 10000.049999999999 in binary floating point.
    expect(amount(1_000_005)).toBe('10000.05');
    expect(amount(-1_500)).toBe('-15.00');
    expect(amount(7)).toBe('0.07');
    expect(amount(0)).toBe('0.00');
  });
});

/**
 * Ring up a real bill and settle it, so the assertions below are made against
 * an actual invoice and actual payments. An export tested over an empty period
 * balances trivially and proves nothing.
 */
async function sellAndSettle(): Promise<number> {
  const app = await getApp();
  const cashier = await loginEmployee('2001', '4826');
  const product = await one<{ id: string }>(
    `SELECT p.id FROM products p
      WHERE p.is_active AND p.is_available AND p.deleted_at IS NULL AND p.price > 0
        AND NOT EXISTS (
          SELECT 1 FROM product_modifiers pm JOIN modifiers m ON m.id = pm.modifier_id
           WHERE pm.product_id = p.id
             AND COALESCE(pm.is_required_override, m.is_required))
      ORDER BY p.price DESC LIMIT 1`,
  );
  const created = await app.inject({
    method: 'POST', url: '/api/orders', headers: auth(cashier),
    payload: {
      tableId: await getTableId('8'), orderType: 'dine_in',
      lines: [{ productId: product!.id, quantity: 2 }],
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const orderId = created.json().orderId;
  const order = await one<{ grand_total: string }>(
    'SELECT grand_total FROM orders WHERE id = $1', [orderId],
  );
  const total = Number(order!.grand_total);
  const paid = await app.inject({
    method: 'POST', url: `/api/orders/${orderId}/pay`,
    headers: await authAtTill(cashier),
    payload: { parts: [{ method: 'cash', amount: total, tendered: total }] },
  });
  expect(paid.statusCode, paid.body).toBe(200);
  return total;
}

describe('the export against the real database', () => {
  const period = { from: '2020-01-01', to: '2035-12-31' };

  test('a real period balances, and the summary agrees with the journal',
    async () => {
      const app = await getApp();
      const headers = await ownerHeaders();

      const total = await sellAndSettle();

      const res = await app.inject({
        method: 'GET',
        url: `/api/accounting/summary?from=${period.from}&to=${period.to}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      // Not an empty period: a journal over no trading balances trivially.
      expect(body.sales.count).toBeGreaterThan(0);
      expect(body.sales.billed).toBeGreaterThanOrEqual(total);
      expect(body.payments.collected).toBeGreaterThanOrEqual(total);
      expect(body.journal.debit).toBeGreaterThan(0);

      // The invariant that makes the whole export worth trusting.
      expect(body.journal.imbalance).toBe(0);
      expect(body.journal.debit).toBe(body.journal.credit);
      // Menu prices include VAT, so the taxable base is what was charged
      // less the tax inside it — not the gross less the discount.
      expect(body.sales.net).toBe(body.sales.billed - body.sales.vat);
      expect(body.vat.net).toBe(body.vat.output - body.vat.input);
    });

  test('every settled invoice in the period appears in the register exactly once',
    async () => {
      const app = await getApp();
      const headers = await ownerHeaders();
      const branchId = await getBranchId();

      const res = await app.inject({
        method: 'GET',
        url: `/api/accounting/invoices.csv?from=${period.from}&to=${period.to}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('mara-invoices-');

      const rows = res.body.trimEnd().split('\r\n').slice(1);
      const stored = await one<{ n: string }>(
        'SELECT count(*)::text AS n FROM invoices WHERE branch_id = $1', [branchId],
      );
      expect(Number(stored!.n)).toBeGreaterThan(0);
      expect(rows.length).toBe(Number(stored!.n));
      // Dropping a document from the register is the one failure an auditor
      // reading it would never catch, so the count is asserted rather than
      // eyeballed.
      expect(new Set(rows.map((r) => r.split(',')[1])).size).toBe(rows.length);
    });

  test('the journal CSV carries the same totals as the JSON it came from',
    async () => {
      const app = await getApp();
      const headers = await ownerHeaders();
      const url = `from=${period.from}&to=${period.to}`;

      const json = (await app.inject({
        method: 'GET', url: `/api/accounting/journal?${url}`, headers,
      })).json();
      const csv = (await app.inject({
        method: 'GET', url: `/api/accounting/journal.csv?${url}`, headers,
      })).body;

      const rows = csv.trimEnd().split('\r\n').slice(1);
      expect(json.lines.length).toBeGreaterThan(0);
      expect(rows.length).toBe(json.lines.length);

      const debits = rows.reduce((total: number, row: string) => {
        const cells = row.split(',');
        return total + Math.round(Number(cells[4]) * 100);
      }, 0);
      expect(debits).toBe(json.totals.debit);
    });

  test('a bad period is refused rather than guessed at', async () => {
    const app = await getApp();
    const headers = await ownerHeaders();
    for (const q of ['from=2026-13-01&to=2026-12-31', 'from=2026-09-30&to=2026-09-01']) {
      const res = await app.inject({
        method: 'GET', url: `/api/accounting/summary?${q}`, headers,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  test('a cashier cannot export the books', async () => {
    const app = await getApp();
    const cashier = await loginEmployee('2001', '4826');
    const res = await app.inject({
      method: 'GET',
      url: `/api/accounting/journal.csv?from=${period.from}&to=${period.to}`,
      headers: auth(cashier),
    });
    expect(res.statusCode).toBe(403);
  });

  test('pulling the books is written to the audit log', async () => {
    const app = await getApp();
    const headers = await ownerHeaders();
    const before = await one<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_logs WHERE action = 'accounting.exported'",
    );
    await app.inject({
      method: 'GET',
      url: `/api/accounting/purchases.csv?from=${period.from}&to=${period.to}`,
      headers,
    });
    const after = await one<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_logs WHERE action = 'accounting.exported'",
    );
    expect(Number(after!.n)).toBe(Number(before!.n) + 1);
  });
});
