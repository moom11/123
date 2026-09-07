/**
 * Renderer checks. Run with `npm test` — no printer or network required.
 */
import { strict as assert } from 'node:assert';
import { encodeCp864, qrCode, renderReceipt, renderTicket, shapeArabic, CMD } from './escpos.js';

let passed = 0;
const test = (name: string, fn: () => void) => {
  try { fn(); passed += 1; console.log(`PASS  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}: ${(err as Error).message}`); process.exitCode = 1; }
};

test('shapes an isolated letter', () => {
  // A lone "ب" takes its isolated form.
  assert.equal(shapeArabic('ب'), 'ﺏ');
});

test('joins letters contextually', () => {
  // "بت": ب takes its initial form and ت its final form. The run is then
  // emitted in reverse so a left-to-right printer lays it out right-to-left.
  assert.equal(shapeArabic('بت'), 'ﺖﺑ');
});

test('does not join after a right-joining letter', () => {
  // "اب": ا never joins forwards, so ب stays isolated.
  const out = [...shapeArabic('اب')];
  assert.ok(out.includes('ﺏ'), 'ba should be isolated after alef');
});

test('leaves latin and digits in their own order', () => {
  assert.equal(shapeArabic('TABLE 12'), 'TABLE 12');
});

test('keeps digits upright inside Arabic text', () => {
  const out = shapeArabic('طاولة 12');
  assert.ok(out.includes('12'), 'the table number must not be reversed');
});

test('encodes shaped Arabic into CP864 bytes', () => {
  const bytes = encodeCp864(shapeArabic('شاي'));
  assert.ok(bytes.length >= 3);
  // Every byte must be a real CP864 codepoint, never a stray replacement.
  assert.ok(bytes.every((b) => b !== 0x3f));
});

test('renders a new-order ticket with the table number tripled', () => {
  const buf = renderTicket({
    header: 'MARA LOUNGE', kind: 'new_order', tableNumber: '12',
    orderNumber: 'ORD-2026-000001', waiterName: 'خالد', department: 'BAR',
    time: new Date().toISOString(),
    items: [{ name: 'شاي', quantity: 2, modifiers: ['سكر', 'نعناع مغربي'] }],
  });
  const text = buf.toString('latin1');
  assert.ok(text.includes('MARA LOUNGE'));
  assert.ok(text.includes('TABLE'));
  assert.ok(text.includes('12'));
  assert.ok(text.includes('ORD-2026-000001'));
  assert.ok(buf.includes(CMD.SIZE_TRIPLE), 'table number must use triple size');
  assert.ok(buf.includes(CMD.CUT), 'ticket must end with a cut');
  assert.ok(buf.includes(CMD.CODEPAGE_CP864), 'must select the Arabic code page');
});

test('ADD ITEM tickets carry the banner and a + quantity', () => {
  const buf = renderTicket({
    header: 'MARA LOUNGE', kind: 'add_item', banner: 'ADD ITEM', tableNumber: '12',
    time: new Date().toISOString(),
    items: [{ name: 'فلات وايت', quantity: 1, modifiers: [] }],
  });
  const text = buf.toString('latin1');
  assert.ok(text.includes('*** ADD ITEM ***'));
  assert.ok(text.includes('+1 x'), 'added quantities are prefixed with +');
});

test('VOID tickets carry the banner and the reason', () => {
  const buf = renderTicket({
    header: 'MARA LOUNGE', kind: 'void', banner: 'VOID', tableNumber: '5',
    time: new Date().toISOString(), reason: 'العميل غيّر رأيه',
    items: [{ name: 'شاي', quantity: 1, modifiers: [] }],
  });
  const text = buf.toString('latin1');
  assert.ok(text.includes('*** VOID ***'));
  assert.ok(text.includes('REASON:'));
});

test('REPRINT tickets are unmistakably marked', () => {
  const buf = renderTicket({
    header: 'MARA LOUNGE', kind: 'reprint', banner: 'REPRINT', tableNumber: '7',
    time: new Date().toISOString(), items: [],
  });
  assert.ok(buf.toString('latin1').includes('*** REPRINT ***'));
});

// --- The customer's copy, and the tax QR on it -------------------------------

const GS = 0x1d;

/** A realistic settled bill, in halalas throughout. */
const sampleReceipt = {
  header: 'MARA LOUNGE',
  branchNameAr: 'مارا لاونج',
  vatNumber: '300000000000003',
  address: 'الرياض',
  invoiceNumber: 'ORD-2026-000041',
  orderNumber: 'ORD-2026-000041',
  tableNumber: '12',
  cashierName: 'سارة',
  time: '2026-09-04T12:30:00.000Z',
  items: [
    { name: 'فلات وايت', quantity: 2, unitPrice: 1800, lineTotal: 3600 },
    { name: 'معسل تفاحتين', quantity: 1, unitPrice: 6500, lineTotal: 6500 },
  ],
  subtotal: 10100,
  discountTotal: 0,
  vatAmount: 1515,
  vatPercent: 15,
  grandTotal: 11615,
  paidBy: 'mada',
  changeGiven: 0,
  qr: 'AQphYmMCDzMwMDAwMDAwMDAwMDAwMw==',
};

test('the QR command emits every block a printer needs', () => {
  const bytes = qrCode('hello');
  const blocks = [...bytes].reduce<number[]>((acc, b, i) => {
    if (b === GS && bytes[i + 1] === 0x28 && bytes[i + 2] === 0x6b) acc.push(i);
    return acc;
  }, []);
  // Model, module size, error correction, store, print.
  assert.equal(blocks.length, 5);
  assert.ok(bytes.includes(Buffer.from('hello', 'ascii')));
});

test('the QR store length is two little-endian bytes', () => {
  // 300 bytes crosses the single-byte boundary, which is exactly where a naive
  // implementation truncates the code and prints something unscannable.
  const bytes = qrCode('x'.repeat(300));
  const storeLen = 303;
  assert.ok(bytes.includes(Buffer.from(
    [GS, 0x28, 0x6b, storeLen & 0xff, (storeLen >> 8) & 0xff, 0x31, 0x50, 0x30],
  )));
});

test('the receipt prints the totals actually charged', () => {
  const text = renderReceipt(sampleReceipt).toString('binary');
  assert.ok(text.includes('101.00'), 'subtotal');
  assert.ok(text.includes('15.15'), 'VAT');
  assert.ok(text.includes('116.15'), 'total');
  assert.ok(text.includes('PAID BY: MADA'));
  assert.ok(text.includes('VAT NO: 300000000000003'));
});

test('the receipt carries the QR payload verbatim', () => {
  const bytes = renderReceipt(sampleReceipt);
  assert.ok(bytes.includes(Buffer.from(sampleReceipt.qr, 'ascii')));
});

test('a discount shows as its own negative line', () => {
  const text = renderReceipt({ ...sampleReceipt, discountTotal: 1000 }).toString('binary');
  // The subtotal stays what was rung up; the discount is visible beneath it,
  // rather than being quietly folded into a smaller number.
  assert.ok(text.includes('101.00'));
  assert.ok(text.includes('-10.00'));
});

test('a credit note does not render as a sale', () => {
  const sale = renderReceipt(sampleReceipt);
  const note = renderReceipt({
    ...sampleReceipt, isCreditNote: true,
    subtotal: -10100, vatAmount: -1515, grandTotal: -11615,
  });
  assert.ok(note.toString('binary').includes('-116.15'));
  assert.ok(!note.equals(sale));
});

console.log(`\n${passed} renderer checks passed`);
