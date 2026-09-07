/**
 * The chart of accounts.
 *
 * These are the codes the export writes into the journal. They are defaults,
 * not law: every accountant's ledger numbers its accounts differently, and an
 * export whose codes cannot be changed is one that gets re-keyed by hand every
 * month — which is exactly the work this is meant to remove.
 *
 * Override any of them with an `accounting_accounts` setting, globally or per
 * branch:
 *
 *   {"cash": "1001", "revenue": "40100"}
 *
 * Unknown keys are ignored rather than rejected: a ledger with an account this
 * system does not use is normal, and refusing the whole map over one extra key
 * would be unhelpful.
 */

export interface AccountMap {
  /** Notes and coin in the drawer. */
  cash: string;
  /** Card takings, still with the acquirer until they settle. */
  cardClearing: string;
  /** Points spent as payment: a liability we owed the customer, now discharged. */
  loyaltyLiability: string;
  /** Output VAT: collected on the state's behalf, owed to it. */
  vatPayable: string;
  /** Input VAT on purchases, reclaimable. */
  vatReceivable: string;
  /** Gross sales, before discounts. */
  revenue: string;
  /** Discounts, as contra-revenue — a debit, never a smaller sale. */
  discounts: string;
  /** Stock on hand. */
  inventory: string;
  /** What we owe suppliers. */
  accountsPayable: string;
  /** Stock written off. */
  wasteExpense: string;
  /**
   * Where a settled bill and its payments disagree.
   *
   * This account must always be zero. It exists so that a discrepancy shows up
   * as a number in the ledger instead of being quietly absorbed into cash,
   * which is the one thing an accounting export must never do.
   */
  suspense: string;
}

export const DEFAULT_ACCOUNTS: AccountMap = {
  cash: '1010',
  cardClearing: '1020',
  loyaltyLiability: '2030',
  vatPayable: '2010',
  vatReceivable: '1180',
  revenue: '4010',
  discounts: '4090',
  inventory: '1310',
  accountsPayable: '2110',
  wasteExpense: '5090',
  suspense: '9999',
};

/** Arabic names, so the exported file reads as a ledger and not as a key dump. */
export const ACCOUNT_NAMES_AR: Record<keyof AccountMap, string> = {
  cash: 'الصندوق',
  cardClearing: 'مدى وبطاقات تحت التحصيل',
  loyaltyLiability: 'نقاط العملاء المستحقة',
  vatPayable: 'ضريبة القيمة المضافة المستحقة',
  vatReceivable: 'ضريبة القيمة المضافة على المشتريات',
  revenue: 'المبيعات',
  discounts: 'الخصومات',
  inventory: 'المخزون',
  accountsPayable: 'الموردون',
  wasteExpense: 'الهدر والتلف',
  suspense: 'حساب فروق مؤقت',
};

/** Which account a payment method lands in. */
export function accountForPaymentMethod(
  method: string, accounts: AccountMap,
): keyof AccountMap {
  if (method === 'cash') return 'cash';
  // Points are not money coming in. They are a liability we already carried
  // being settled, so treating them as cash would inflate the day's takings.
  if (method === 'wallet_points') return 'loyaltyLiability';
  return 'cardClearing';
}

/**
 * Merge an operator's overrides over the defaults.
 *
 * Only string values for keys we know are taken; anything else is left as the
 * default rather than allowed to write an empty account code into a journal.
 */
export function resolveAccounts(override: unknown): AccountMap {
  const out = { ...DEFAULT_ACCOUNTS };
  if (!override || typeof override !== 'object') return out;
  for (const key of Object.keys(DEFAULT_ACCOUNTS) as Array<keyof AccountMap>) {
    const value = (override as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return out;
}
