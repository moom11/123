/**
 * CSV, for a file that will be opened in Excel and imported into a ledger.
 *
 * Two details that are not optional in Arabic accounting work:
 *
 * A **byte order mark**. Without it Excel on Windows reads a UTF-8 file in the
 * system codepage and every Arabic name arrives as mojibake. The file is not
 * corrupt and the accountant cannot tell that; they just see nonsense and go
 * back to typing it by hand.
 *
 * An **injection guard**. A cell whose text begins with = + - or @ is treated
 * by every spreadsheet as a formula. Supplier and product names are typed by
 * people, and a name beginning with '=' would execute on open — which is a
 * real attack when the file is emailed to a finance department. Such a cell is
 * prefixed with an apostrophe, which spreadsheets strip on display.
 */

export type CsvValue = string | number | null | undefined;

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines = [headers.map(cell).join(',')];
  for (const row of rows) lines.push(row.map(cell).join(','));
  // CRLF: the line ending every spreadsheet on every platform reads correctly.
  return `﻿${lines.join('\r\n')}\r\n`;
}

function cell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Halalas as a decimal string.
 *
 * Written by hand rather than with toFixed, because a ledger amount must be an
 * exact decimation of an integer and floating point does not promise that:
 * 1_000_005 / 100 is 10000.049999999999 on the way to being printed.
 */
export function amount(halalas: number): string {
  const sign = halalas < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(halalas));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
