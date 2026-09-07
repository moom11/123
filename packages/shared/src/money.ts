/**
 * Money is stored in the database as NUMERIC(14,2) and moved around the API as
 * a number of halalas (integer minor units) so that no rounding drift can
 * appear between the till, the wallet ledger and the printed bill.
 */

export const CURRENCY = 'SAR';
export const MINOR_UNITS_PER_MAJOR = 100;

export function toMinor(major: number): number {
  return Math.round(major * MINOR_UNITS_PER_MAJOR);
}

export function toMajor(minor: number): number {
  return minor / MINOR_UNITS_PER_MAJOR;
}

/** Format for display, e.g. 4500 -> "45.00 ر.س". */
export function formatMinor(minor: number, currency = 'ر.س'): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const major = Math.floor(abs / MINOR_UNITS_PER_MAJOR);
  const frac = String(abs % MINOR_UNITS_PER_MAJOR).padStart(2, '0');
  return `${sign}${major.toLocaleString('en-US')}.${frac} ${currency}`;
}

/** Split `total` across `parts` ways without losing or inventing a halala. */
export function splitEvenly(total: number, parts: number): number[] {
  if (parts <= 0) throw new Error('parts must be positive');
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** VAT-inclusive breakdown: returns the net and tax components of a gross total. */
export function vatBreakdown(gross: number, ratePercent: number): { net: number; vat: number } {
  const net = Math.round((gross * 100) / (100 + ratePercent));
  return { net, vat: gross - net };
}
