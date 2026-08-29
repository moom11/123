/**
 * ESC/POS ticket rendering.
 *
 * Arabic on thermal printers is the awkward part: most 80 mm units expose
 * Arabic through code page 22 (CP864) and expect the text already reordered
 * right-to-left with the correct contextual letter forms, because they do no
 * shaping of their own. `shapeArabic` below does that work, so the paper reads
 * the way a person expects rather than as disconnected letters in reverse.
 */

const ESC = 0x1b;
const GS = 0x1d;

export const CMD = {
  INIT: Buffer.from([ESC, 0x40]),
  ALIGN_LEFT: Buffer.from([ESC, 0x61, 0]),
  ALIGN_CENTER: Buffer.from([ESC, 0x61, 1]),
  ALIGN_RIGHT: Buffer.from([ESC, 0x61, 2]),
  BOLD_ON: Buffer.from([ESC, 0x45, 1]),
  BOLD_OFF: Buffer.from([ESC, 0x45, 0]),
  // Width/height multipliers: 0x11 is double both ways, used for the table number.
  SIZE_NORMAL: Buffer.from([GS, 0x21, 0x00]),
  SIZE_DOUBLE: Buffer.from([GS, 0x21, 0x11]),
  SIZE_DOUBLE_H: Buffer.from([GS, 0x21, 0x01]),
  SIZE_TRIPLE: Buffer.from([GS, 0x21, 0x22]),
  FEED: Buffer.from([0x0a]),
  CUT: Buffer.from([GS, 0x56, 0x42, 0x00]),
  CODEPAGE_CP864: Buffer.from([ESC, 0x74, 22]),
  CODEPAGE_PC437: Buffer.from([ESC, 0x74, 0]),
  DRAWER_KICK: Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]),
};

/**
 * Letters that join only to their right: they connect to the preceding letter
 * but never to the following one, so the letter after them always starts a new
 * shape.
 */
const RIGHT_JOINING = new Set(['ا', 'د', 'ذ', 'ر', 'ز', 'و', 'آ', 'أ', 'إ', 'ؤ', 'ة', 'ى']);

/** isolated, final, initial, medial */
const FORMS: Record<string, [number, number, number, number]> = {
  'ا': [0xfe8d, 0xfe8e, 0xfe8d, 0xfe8e],
  'ب': [0xfe8f, 0xfe90, 0xfe91, 0xfe92],
  'ت': [0xfe95, 0xfe96, 0xfe97, 0xfe98],
  'ث': [0xfe99, 0xfe9a, 0xfe9b, 0xfe9c],
  'ج': [0xfe9d, 0xfe9e, 0xfe9f, 0xfea0],
  'ح': [0xfea1, 0xfea2, 0xfea3, 0xfea4],
  'خ': [0xfea5, 0xfea6, 0xfea7, 0xfea8],
  'د': [0xfea9, 0xfeaa, 0xfea9, 0xfeaa],
  'ذ': [0xfeab, 0xfeac, 0xfeab, 0xfeac],
  'ر': [0xfead, 0xfeae, 0xfead, 0xfeae],
  'ز': [0xfeaf, 0xfeb0, 0xfeaf, 0xfeb0],
  'س': [0xfeb1, 0xfeb2, 0xfeb3, 0xfeb4],
  'ش': [0xfeb5, 0xfeb6, 0xfeb7, 0xfeb8],
  'ص': [0xfeb9, 0xfeba, 0xfebb, 0xfebc],
  'ض': [0xfebd, 0xfebe, 0xfebf, 0xfec0],
  'ط': [0xfec1, 0xfec2, 0xfec3, 0xfec4],
  'ظ': [0xfec5, 0xfec6, 0xfec7, 0xfec8],
  'ع': [0xfec9, 0xfeca, 0xfecb, 0xfecc],
  'غ': [0xfecd, 0xfece, 0xfecf, 0xfed0],
  'ف': [0xfed1, 0xfed2, 0xfed3, 0xfed4],
  'ق': [0xfed5, 0xfed6, 0xfed7, 0xfed8],
  'ك': [0xfed9, 0xfeda, 0xfedb, 0xfedc],
  'ل': [0xfedd, 0xfede, 0xfedf, 0xfee0],
  'م': [0xfee1, 0xfee2, 0xfee3, 0xfee4],
  'ن': [0xfee5, 0xfee6, 0xfee7, 0xfee8],
  'ه': [0xfee9, 0xfeea, 0xfeeb, 0xfeec],
  'و': [0xfeed, 0xfeee, 0xfeed, 0xfeee],
  'ي': [0xfef1, 0xfef2, 0xfef3, 0xfef4],
  'ى': [0xfeef, 0xfef0, 0xfeef, 0xfef0],
  'ة': [0xfe93, 0xfe94, 0xfe93, 0xfe94],
  'أ': [0xfe83, 0xfe84, 0xfe83, 0xfe84],
  'إ': [0xfe87, 0xfe88, 0xfe87, 0xfe88],
  'آ': [0xfe81, 0xfe82, 0xfe81, 0xfe82],
  'ؤ': [0xfe85, 0xfe86, 0xfe85, 0xfe86],
  'ئ': [0xfe89, 0xfe8a, 0xfe8b, 0xfe8c],
  'ء': [0xfe80, 0xfe80, 0xfe80, 0xfe80],
};

const isArabicLetter = (ch: string): boolean => Object.hasOwn(FORMS, ch);
const isArabicChar = (ch: string): boolean => {
  const c = ch.codePointAt(0) ?? 0;
  return (c >= 0x0600 && c <= 0x06ff) || (c >= 0xfb50 && c <= 0xfeff);
};

/**
 * Apply contextual forms and reverse Arabic runs so the printer, which lays
 * glyphs out strictly left to right, produces readable Arabic. Latin and digit
 * runs keep their own order — a table number must not come out backwards.
 */
export function shapeArabic(input: string): string {
  const chars = [...input];
  const shaped: string[] = [];

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (!isArabicLetter(ch)) { shaped.push(ch); continue; }

    const prev = chars[i - 1];
    const next = chars[i + 1];
    // A letter connects backwards only if the previous letter may join forwards.
    const joinsPrev = Boolean(prev) && isArabicLetter(prev) && !RIGHT_JOINING.has(prev);
    const joinsNext = Boolean(next) && isArabicLetter(next) && !RIGHT_JOINING.has(ch);

    const [isolated, final, initial, medial] = FORMS[ch];
    let form: number;
    if (joinsPrev && joinsNext) form = medial;
    else if (joinsPrev) form = final;
    else if (joinsNext) form = initial;
    else form = isolated;

    shaped.push(String.fromCodePoint(form));
  }

  // A line with no Arabic at all is left exactly as written — an order number
  // or a table number must never come out backwards.
  if (!shaped.some(isArabicChar)) return shaped.join('');

  // Otherwise the base direction is right-to-left. Split into runs, emit the
  // runs in reverse order, and reverse the characters only inside Arabic runs:
  // Latin words and digits keep their own left-to-right order, which is what
  // makes "طاولة 12" print with the 12 intact.
  const runs: Array<{ arabic: boolean; chars: string[] }> = [];
  for (const ch of shaped) {
    const arabic = isArabicChar(ch);
    const last = runs.at(-1);
    if (last && last.arabic === arabic) last.chars.push(ch);
    else runs.push({ arabic, chars: [ch] });
  }

  return runs
    .reverse()
    .map((run) => (run.arabic ? [...run.chars].reverse() : run.chars).join(''))
    .join('');
}

/**
 * Encode text for CP864 (Arabic). Characters the code page cannot express fall
 * back to a space rather than printing noise.
 */
export function encodeCp864(text: string): Buffer {
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 32;
    if (code < 0x80) { bytes.push(code); continue; }
    const mapped = CP864_MAP.get(code);
    bytes.push(mapped ?? 0x20);
  }
  return Buffer.from(bytes);
}

/**
 * Presentation-form to CP864 byte mapping for the glyphs used by Arabic menus.
 * Built from the IBM CP864 table; only the forms this system can emit are
 * included, which keeps it auditable.
 */
const CP864_MAP = new Map<number, number>([
  [0x0660, 0x30], [0x0661, 0x31], [0x0662, 0x32], [0x0663, 0x33], [0x0664, 0x34],
  [0x0665, 0x35], [0x0666, 0x36], [0x0667, 0x37], [0x0668, 0x38], [0x0669, 0x39],
  [0x060c, 0xac], [0x061b, 0xbb], [0x061f, 0xbf],
  [0xfe80, 0xc0], [0xfe81, 0xc1], [0xfe82, 0xc1], [0xfe83, 0xc2], [0xfe84, 0xc2],
  [0xfe85, 0xc3], [0xfe86, 0xc3], [0xfe87, 0xc4], [0xfe88, 0xc4], [0xfe89, 0xc5],
  [0xfe8a, 0xc5], [0xfe8b, 0xc6], [0xfe8c, 0xc6], [0xfe8d, 0xc7], [0xfe8e, 0xc7],
  [0xfe8f, 0xc8], [0xfe90, 0xc8], [0xfe91, 0xeb], [0xfe92, 0xeb],
  [0xfe93, 0xc9], [0xfe94, 0xc9],
  [0xfe95, 0xca], [0xfe96, 0xca], [0xfe97, 0xec], [0xfe98, 0xec],
  [0xfe99, 0xcb], [0xfe9a, 0xcb], [0xfe9b, 0xed], [0xfe9c, 0xed],
  [0xfe9d, 0xcc], [0xfe9e, 0xcc], [0xfe9f, 0xee], [0xfea0, 0xee],
  [0xfea1, 0xcd], [0xfea2, 0xcd], [0xfea3, 0xef], [0xfea4, 0xef],
  [0xfea5, 0xce], [0xfea6, 0xce], [0xfea7, 0xf0], [0xfea8, 0xf0],
  [0xfea9, 0xcf], [0xfeaa, 0xcf],
  [0xfeab, 0xd0], [0xfeac, 0xd0], [0xfead, 0xd1], [0xfeae, 0xd1],
  [0xfeaf, 0xd2], [0xfeb0, 0xd2],
  [0xfeb1, 0xd3], [0xfeb2, 0xd3], [0xfeb3, 0xf1], [0xfeb4, 0xf1],
  [0xfeb5, 0xd4], [0xfeb6, 0xd4], [0xfeb7, 0xf2], [0xfeb8, 0xf2],
  [0xfeb9, 0xd5], [0xfeba, 0xd5], [0xfebb, 0xf3], [0xfebc, 0xf3],
  [0xfebd, 0xd6], [0xfebe, 0xd6], [0xfebf, 0xf4], [0xfec0, 0xf4],
  [0xfec1, 0xd7], [0xfec2, 0xd7], [0xfec3, 0xd7], [0xfec4, 0xd7],
  [0xfec5, 0xd8], [0xfec6, 0xd8], [0xfec7, 0xd8], [0xfec8, 0xd8],
  [0xfec9, 0xd9], [0xfeca, 0xf5], [0xfecb, 0xf6], [0xfecc, 0xf6],
  [0xfecd, 0xda], [0xfece, 0xf7], [0xfecf, 0xf8], [0xfed0, 0xf8],
  [0xfed1, 0xdb], [0xfed2, 0xdb], [0xfed3, 0xf9], [0xfed4, 0xf9],
  [0xfed5, 0xdc], [0xfed6, 0xdc], [0xfed7, 0xfa], [0xfed8, 0xfa],
  [0xfed9, 0xdd], [0xfeda, 0xdd], [0xfedb, 0xfb], [0xfedc, 0xfb],
  [0xfedd, 0xde], [0xfede, 0xde], [0xfedf, 0xfc], [0xfee0, 0xfc],
  [0xfee1, 0xdf], [0xfee2, 0xdf], [0xfee3, 0xfd], [0xfee4, 0xfd],
  [0xfee5, 0xe0], [0xfee6, 0xe0], [0xfee7, 0xfe], [0xfee8, 0xfe],
  [0xfee9, 0xe1], [0xfeea, 0xe1], [0xfeeb, 0xe1], [0xfeec, 0xe1],
  [0xfeed, 0xe2], [0xfeee, 0xe2],
  [0xfeef, 0xe3], [0xfef0, 0xe3],
  [0xfef1, 0xe4], [0xfef2, 0xe4], [0xfef3, 0xe5], [0xfef4, 0xe5],
]);

export interface TicketItem {
  name: string;
  quantity: number;
  modifiers: string[];
  notes?: string | null;
}

export interface TicketPayload {
  header: string;
  kind: string;
  banner?: string | null;
  orderNumber?: string | null;
  tableNumber?: string | null;
  waiterName?: string | null;
  department?: string | null;
  orderType?: string | null;
  customerName?: string | null;
  time: string;
  items: TicketItem[];
  notes?: string | null;
  reason?: string | null;
}

/**
 * Render a ticket to ESC/POS bytes.
 *
 * The table number is printed at triple size because it is the single piece of
 * information the kitchen and the runner need to read across a busy pass.
 */
export function renderTicket(payload: TicketPayload, charsPerLine = 42): Buffer {
  const parts: Buffer[] = [CMD.INIT, CMD.CODEPAGE_CP864];

  const arabic = (text: string): Buffer => encodeCp864(shapeArabic(text));
  const latin = (text: string): Buffer => Buffer.from(text, 'ascii');
  const line = (buf: Buffer) => { parts.push(buf, CMD.FEED); };
  const rule = () => line(latin('-'.repeat(charsPerLine)));

  // Header
  parts.push(CMD.ALIGN_CENTER, CMD.SIZE_DOUBLE_H, CMD.BOLD_ON);
  line(latin(payload.header));
  parts.push(CMD.SIZE_NORMAL, CMD.BOLD_OFF);

  // The banner is the first thing a station must notice: ADD ITEM, VOID,
  // REPRINT or CHARCOAL REQUEST.
  if (payload.banner) {
    parts.push(CMD.SIZE_DOUBLE, CMD.BOLD_ON);
    line(latin(`*** ${payload.banner} ***`));
    parts.push(CMD.SIZE_NORMAL, CMD.BOLD_OFF);
  }

  if (payload.department) line(latin(payload.department));
  rule();

  // Table number — deliberately the largest thing on the paper.
  if (payload.tableNumber) {
    parts.push(CMD.ALIGN_CENTER, CMD.BOLD_ON);
    line(latin('TABLE'));
    parts.push(CMD.SIZE_TRIPLE);
    line(latin(payload.tableNumber));
    parts.push(CMD.SIZE_NORMAL, CMD.BOLD_OFF);
  }

  parts.push(CMD.ALIGN_LEFT);
  if (payload.orderNumber) line(latin(`ORDER: ${payload.orderNumber}`));
  if (payload.waiterName) {
    parts.push(latin('WAITER: '));
    line(arabic(payload.waiterName));
  }
  if (payload.customerName) {
    parts.push(latin('CUSTOMER: '));
    line(arabic(payload.customerName));
  }
  if (payload.orderType) line(latin(`TYPE: ${payload.orderType.toUpperCase()}`));
  line(latin(`TIME: ${formatTime(payload.time)}`));
  rule();

  // Items
  for (const item of payload.items) {
    parts.push(CMD.BOLD_ON, CMD.SIZE_DOUBLE_H);
    const qty = payload.banner === 'ADD ITEM' ? `+${trimNumber(item.quantity)}` : trimNumber(item.quantity);
    parts.push(latin(`${qty} x `));
    line(arabic(item.name));
    parts.push(CMD.SIZE_NORMAL, CMD.BOLD_OFF);

    for (const modifier of item.modifiers) {
      parts.push(latin('   - '));
      line(arabic(modifier));
    }
    if (item.notes) {
      parts.push(latin('   ! '));
      line(arabic(item.notes));
    }
    parts.push(CMD.FEED);
  }

  if (payload.notes) {
    rule();
    parts.push(latin('NOTE: '));
    line(arabic(payload.notes));
  }
  if (payload.reason) {
    rule();
    parts.push(CMD.BOLD_ON, latin('REASON: '));
    line(arabic(payload.reason));
    parts.push(CMD.BOLD_OFF);
  }

  rule();
  parts.push(CMD.ALIGN_CENTER);
  line(latin(payload.kind.toUpperCase()));
  parts.push(CMD.FEED, CMD.FEED, CMD.FEED, CMD.CUT);

  return Buffer.concat(parts);
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}
