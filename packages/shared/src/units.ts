/**
 * Unit handling for inventory and recipes.
 *
 * Every item is stored in a canonical base unit (g, ml, or piece). Purchase,
 * receiving and recipe quantities may be expressed in any unit of the same
 * dimension and are normalised on the way in, so 1 KG of coffee and 18 g per
 * cup are directly comparable without any per-call-site arithmetic.
 */

export const UNITS = [
  'kg', 'g', 'l', 'ml', 'piece', 'box', 'carton', 'pack',
] as const;
export type Unit = (typeof UNITS)[number];

export type Dimension = 'mass' | 'volume' | 'count';

export const UNIT_DIMENSION: Record<Unit, Dimension> = {
  kg: 'mass', g: 'mass',
  l: 'volume', ml: 'volume',
  piece: 'count', box: 'count', carton: 'count', pack: 'count',
};

export const BASE_UNIT: Record<Dimension, Unit> = {
  mass: 'g',
  volume: 'ml',
  count: 'piece',
};

/** How many base units one of this unit contains. */
const FIXED_FACTORS: Partial<Record<Unit, number>> = {
  kg: 1000, g: 1,
  l: 1000, ml: 1,
  piece: 1,
};

export const UNIT_LABELS_AR: Record<Unit, string> = {
  kg: 'كجم', g: 'جرام', l: 'لتر', ml: 'مل',
  piece: 'حبة', box: 'صندوق', carton: 'كرتون', pack: 'باكيت',
};

export class UnitConversionError extends Error {}

/**
 * Convert `qty` of `unit` into the item's base unit.
 *
 * `packSize` is required for the aggregate count units (box/carton/pack) and
 * is the number of base pieces per pack, taken from the inventory item.
 */
export function toBaseUnit(qty: number, unit: Unit, packSize?: number | null): number {
  const fixed = FIXED_FACTORS[unit];
  if (fixed !== undefined) return qty * fixed;

  // box / carton / pack — needs the item's declared pack size.
  if (!packSize || packSize <= 0) {
    throw new UnitConversionError(
      `Unit "${unit}" requires a positive pack_size on the inventory item`,
    );
  }
  return qty * packSize;
}

/** Convert a quantity expressed in base units back into `unit`. */
export function fromBaseUnit(baseQty: number, unit: Unit, packSize?: number | null): number {
  const fixed = FIXED_FACTORS[unit];
  if (fixed !== undefined) return baseQty / fixed;
  if (!packSize || packSize <= 0) {
    throw new UnitConversionError(
      `Unit "${unit}" requires a positive pack_size on the inventory item`,
    );
  }
  return baseQty / packSize;
}

/** True when two units measure the same physical dimension. */
export function isCompatible(a: Unit, b: Unit): boolean {
  return UNIT_DIMENSION[a] === UNIT_DIMENSION[b];
}

export function assertCompatible(a: Unit, b: Unit): void {
  if (!isCompatible(a, b)) {
    throw new UnitConversionError(
      `Cannot convert between "${a}" (${UNIT_DIMENSION[a]}) and "${b}" (${UNIT_DIMENSION[b]})`,
    );
  }
}

export function isUnit(value: string): value is Unit {
  return (UNITS as readonly string[]).includes(value);
}
