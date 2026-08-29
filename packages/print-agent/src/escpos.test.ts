/**
 * Renderer checks. Run with `npm test` — no printer or network required.
 */
import { strict as assert } from 'node:assert';
import { encodeCp864, renderTicket, shapeArabic, CMD } from './escpos.js';

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

console.log(`\n${passed} renderer checks passed`);
