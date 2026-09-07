/**
 * Evaluating promotions against a basket.
 *
 * Kept pure and free of the database so it can be reasoned about and tested
 * directly: given lines, a set of rules and an instant, it returns what comes
 * off and why. No I/O, no clock of its own, no randomness — the same inputs
 * always produce the same answer, which is what lets a discount be re-derived
 * during an audit months later.
 *
 * Two properties the arithmetic must hold:
 *
 *   * A line is discounted at most once. Two promotions that both match the
 *     same coffee must not each take 20% off it; the second sees what the
 *     first already consumed.
 *   * The parts sum to the whole. Percentages are applied to halalas and
 *     rounded once, at the line, so a bill's discounts always add up to the
 *     figure printed on it.
 */

export interface BasketLine {
  id: string;
  productId: string;
  categoryId: string | null;
  quantity: number;
  /** Halalas, unit price including modifiers, before any promotion. */
  unitPrice: number;
  /** Halalas already taken off this line by something else (a special price). */
  existingDiscount: number;
}

export interface PromotionRule {
  id: string;
  nameAr: string;
  kind: 'percent' | 'amount' | 'item_price' | 'buy_x_get_y' | 'combo';
  /** Basis points for percent; halalas otherwise. */
  value: number;
  buyQuantity: number | null;
  getQuantity: number | null;
  productIds: string[];
  categoryIds: string[];
  comboQuantities: Map<string, number>;
  minBasket: number;
  maxDiscount: number;
  priority: number;
  isStackable: boolean;
}

export interface PromotionAward {
  promotionId: string;
  nameAr: string;
  /** Halalas off, spread across the lines it applied to. */
  amount: number;
  perLine: Array<{ lineId: string; amount: number }>;
  qualifyingTotal: number;
}

/** Empty targeting means the whole menu — a branch-wide happy hour. */
function targets(rule: PromotionRule, line: BasketLine): boolean {
  if (rule.productIds.length === 0 && rule.categoryIds.length === 0) return true;
  if (rule.productIds.includes(line.productId)) return true;
  return line.categoryId !== null && rule.categoryIds.includes(line.categoryId);
}

/**
 * Distribute a total across lines in proportion to their value.
 *
 * The remainder goes to the largest line rather than being dropped, so the
 * per-line amounts always sum to exactly the promotion's total. A bill whose
 * discounts do not add up is a bill an accountant has to reconcile by hand.
 */
function spread(
  total: number, lines: Array<{ lineId: string; weight: number }>,
): Array<{ lineId: string; amount: number }> {
  const weightSum = lines.reduce((sum, l) => sum + l.weight, 0);
  if (weightSum <= 0 || total <= 0) return [];

  const out = lines.map((l) => ({
    lineId: l.lineId,
    amount: Math.floor((total * l.weight) / weightSum),
  }));
  const assigned = out.reduce((sum, l) => sum + l.amount, 0);
  let remainder = total - assigned;

  // Largest first, so the rounding crumbs land where they are least visible.
  const order = [...out].sort((a, b) => b.amount - a.amount);
  let i = 0;
  while (remainder > 0 && order.length > 0) {
    order[i % order.length]!.amount += 1;
    remainder -= 1;
    i += 1;
  }
  return out.filter((l) => l.amount > 0);
}

/**
 * Apply the rules to the basket.
 *
 * `remaining` tracks what each line still has to give, so a line can never be
 * discounted below zero nor twice for the same value. Rules run in priority
 * order and a non-stackable one that fires ends the chain — which is what
 * makes "20% off everything" and "buy one get one" not compose into free food.
 */
export function evaluate(
  lines: BasketLine[], rules: PromotionRule[],
): PromotionAward[] {
  const remaining = new Map<string, number>();
  for (const line of lines) {
    remaining.set(line.id, Math.max(0, line.unitPrice * line.quantity - line.existingDiscount));
  }

  const basketTotal = [...remaining.values()].reduce((a, b) => a + b, 0);
  const awards: PromotionAward[] = [];

  // Deterministic order: priority, then id. Without the tiebreak, two rules at
  // the same priority could apply in whichever order the database returned
  // them, and the same basket would price differently on different days.
  const ordered = [...rules].sort(
    (a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
  );

  for (const rule of ordered) {
    const eligible = lines
      .filter((line) => targets(rule, line))
      .map((line) => ({ line, left: remaining.get(line.id) ?? 0 }))
      .filter((e) => e.left > 0);

    if (eligible.length === 0) continue;

    const qualifyingTotal = eligible.reduce((sum, e) => sum + e.left, 0);
    if (basketTotal < rule.minBasket) continue;

    let amount = 0;
    switch (rule.kind) {
      case 'percent':
        amount = Math.round((qualifyingTotal * rule.value) / 10_000);
        break;

      case 'amount':
        // Never more than the lines are worth: a 50 riyal voucher on a 30
        // riyal basket takes 30, not 50 and a negative bill.
        amount = Math.min(rule.value, qualifyingTotal);
        break;

      case 'item_price': {
        // Sell the qualifying units at a set price. Lines already cheaper are
        // left alone rather than marked up.
        amount = eligible.reduce((sum, e) => {
          const target = rule.value * e.line.quantity;
          const current = e.left;
          return sum + Math.max(0, current - target);
        }, 0);
        break;
      }

      case 'buy_x_get_y': {
        const buy = rule.buyQuantity ?? 1;
        const get = rule.getQuantity ?? 1;
        // Units across every eligible line, cheapest first: the customer gets
        // the cheapest ones free, which is the convention and the safer read
        // of an ambiguous offer.
        const units: number[] = [];
        for (const e of eligible) {
          const perUnit = Math.floor(e.left / Math.max(1, e.line.quantity));
          for (let n = 0; n < e.line.quantity; n += 1) units.push(perUnit);
        }
        units.sort((a, b) => a - b);
        const sets = Math.floor(units.length / (buy + get));
        amount = units.slice(0, sets * get).reduce((a, b) => a + b, 0);
        break;
      }

      case 'combo': {
        // Every product in the set must be present in at least the required
        // quantity, otherwise it is not the combo the customer was offered.
        const have = new Map<string, number>();
        for (const e of eligible) {
          have.set(e.line.productId, (have.get(e.line.productId) ?? 0) + e.line.quantity);
        }
        let sets = Infinity;
        for (const [productId, needed] of rule.comboQuantities) {
          sets = Math.min(sets, Math.floor((have.get(productId) ?? 0) / needed));
        }
        if (!Number.isFinite(sets) || sets <= 0) continue;

        // The set price replaces what those items would have cost.
        const setCost = [...rule.comboQuantities.entries()].reduce((sum, [productId, needed]) => {
          const line = eligible.find((e) => e.line.productId === productId);
          if (!line) return sum;
          const perUnit = Math.floor(line.left / Math.max(1, line.line.quantity));
          return sum + perUnit * needed;
        }, 0);
        amount = Math.max(0, (setCost - rule.value) * sets);
        break;
      }
    }

    if (rule.maxDiscount > 0) amount = Math.min(amount, rule.maxDiscount);
    amount = Math.min(amount, qualifyingTotal);
    if (amount <= 0) continue;

    const perLine = spread(amount, eligible.map((e) => ({
      lineId: e.line.id, weight: e.left,
    })));

    // Consume what was given, so the next rule cannot give it again.
    for (const part of perLine) {
      remaining.set(part.lineId, (remaining.get(part.lineId) ?? 0) - part.amount);
    }

    awards.push({
      promotionId: rule.id, nameAr: rule.nameAr, amount, perLine, qualifyingTotal,
    });

    // A non-stackable promotion is the only one this basket gets.
    if (!rule.isStackable) break;
  }

  return awards;
}

/**
 * Is the rule live at this instant, in the branch's own timezone?
 *
 * Local time is the whole point of a happy hour, and the branch's timezone is
 * the one the guest is sitting in — not the server's.
 */
export function isLive(
  window: {
    startsAt: Date | null; endsAt: Date | null;
    daysOfWeek: number[];
    dailyStartMinute: number | null; dailyEndMinute: number | null;
  },
  at: Date, timeZone: string,
): boolean {
  if (window.startsAt && at < window.startsAt) return false;
  if (window.endsAt && at > window.endsAt) return false;

  const local = localParts(at, timeZone);

  if (window.daysOfWeek.length > 0 && !window.daysOfWeek.includes(local.isoWeekday)) {
    return false;
  }

  const { dailyStartMinute: start, dailyEndMinute: end } = window;
  if (start === null || end === null) return true;

  // start > end is a window crossing midnight — 10pm to 2am is one shift, not
  // an empty set.
  return start <= end
    ? local.minutes >= start && local.minutes < end
    : local.minutes >= start || local.minutes < end;
}

/** Weekday and minutes-past-midnight, in the given zone. */
export function localParts(at: Date, timeZone: string): {
  isoWeekday: number; minutes: number;
} {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const WEEKDAYS: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };
  // 24:00 is midnight at the start of the day, which Intl emits and Number
  // reads as 24 — leaving a window that starts at 00:00 unmatched.
  const hour = Number(get('hour')) % 24;
  return {
    isoWeekday: WEEKDAYS[get('weekday')] ?? 1,
    minutes: hour * 60 + Number(get('minute')),
  };
}
