import type { CurrencyCode, Minor } from "@akai/contracts";
import { ZERO, toMinor } from "@akai/money";


/**
 * Shipping rate SELECTION — a PURE function over live rate rows.
 *
 * Kept free of Nest, Prisma and I/O for the same reason the totals functions
 * are: this decides how much shipping to charge, so it must be exhaustively
 * testable without a database, and re-derivable from the same inputs when a
 * customer disputes a delivery charge.
 *
 * THREE STRATEGIES, one selection rule each:
 *
 *  * FLAT   — a fixed price. Always offered (its bounds are ignored).
 *  * WEIGHT — offered only when the parcel weight falls inside [minValue,
 *             maxValue) grams. This is how "up to 1 kg = $ 12.000, 1–2 kg = $ 18.000"
 *             brackets are expressed.
 *  * PRICE  — offered only when the GROSS subtotal falls inside [minValue,
 *             maxValue) minor units.
 *
 * Bounds are HALF-OPEN [min, max): min inclusive, max exclusive. That is what
 * lets adjacent brackets tile the range (…, 1000] and [1000, …) without a gram
 * or a cent belonging to two brackets at once — a double-charge waiting to
 * happen if the boundaries overlapped. `null` min means "from zero", `null` max
 * means "no upper bound".
 *
 * FREE-OVER-THRESHOLD is applied AFTER selection and to any strategy: a rate
 * whose `freeOverSubtotal` is met is still offered, but at price zero. It is not
 * removed, because the customer must still pick a method — "free standard
 * shipping" is a method, not the absence of one.
 *
 * A rate with an unrecognised `strategy` string is EXCLUDED, never offered. A
 * mis-seeded strategy is an operator error, and failing closed (the broken rate
 * simply cannot be chosen) is safer than either charging its price under a
 * guessed rule or crashing a customer's checkout because one row is malformed.
 *
 * A rate with a BLANK NAME is excluded for the same reason (the database
 * refuses one with a CHECK, but the database is not the only writer): an option
 * the customer cannot read is an option they cannot meaningfully choose. Excluding it here is what
 * lets every downstream consumer — the wire schema, the order's stamped
 * `shippingMethodName`, the invoice — treat a name as present.
 */

export type ShippingStrategy = "FLAT" | "WEIGHT" | "PRICE";

/** A raw shipping_rate row, as read from the database. */
export interface ShippingRateRow {
  readonly id: string;
  /** The method's display name. */
  readonly name: string;
  /** Free text in the DB; narrowed to ShippingStrategy here, or excluded. */
  readonly strategy: string;
  /** VAT-inclusive price, minor units. */
  readonly priceGross: number;
  readonly currency: string;
  /** WEIGHT: grams. PRICE: minor units. Inclusive lower bound; null = 0. */
  readonly minValue: number | null;
  /** Exclusive upper bound; null = unbounded. */
  readonly maxValue: number | null;
  /** Free at or above this GROSS subtotal. Null disables the threshold. */
  readonly freeOverSubtotal: number | null;
  readonly isActive: boolean;
  /** The "2–5 días" sub-line. Carried through to the quote; never priced. */
  readonly transitDaysMin: number | null;
  readonly transitDaysMax: number | null;
}

export interface ShippingSelectionContext {
  readonly currency: CurrencyCode;
  /** Cart GROSS subtotal (VAT-inclusive, what the customer sees). */
  readonly subtotalGross: Minor;
  /** Total parcel weight in grams, summed across cart lines. */
  readonly weightGrams: number;
}

/** A shipping method the customer may choose, with its computed price. */
export interface ShippingOption {
  readonly rateId: string;
  /** The method's display name. */
  readonly name: string;
  readonly currency: CurrencyCode;
  /** VAT-inclusive price for THIS cart. Zero when the free-over threshold is met. */
  readonly priceGross: Minor;
  readonly isFree: boolean;
  readonly transitDaysMin: number | null;
  readonly transitDaysMax: number | null;
}

function parseStrategy(value: string): ShippingStrategy | null {
  return value === "FLAT" || value === "WEIGHT" || value === "PRICE" ? value : null;
}

/** Half-open bound check: (min ?? -inf) <= value < (max ?? +inf). */
function withinBounds(value: number, min: number | null, max: number | null): boolean {
  if (min !== null && value < min) {
    return false;
  }
  if (max !== null && value >= max) {
    return false;
  }
  return true;
}

function isOffered(rate: ShippingRateRow, context: ShippingSelectionContext): boolean {
  if (!rate.isActive) {
    return false;
  }
  // A rate priced in another currency cannot be charged against this cart; a
  // silent currency mismatch is exactly how a €5 rate becomes a $5 charge.
  if (rate.currency !== context.currency) {
    return false;
  }

  const strategy = parseStrategy(rate.strategy);
  if (strategy === null) {
    return false;
  }

  // Fail closed on an unnameable rate, exactly as on an unrecognised strategy.
  if (rate.name.trim().length === 0) {
    return false;
  }

  switch (strategy) {
    case "FLAT":
      return true;
    case "WEIGHT":
      return withinBounds(context.weightGrams, rate.minValue, rate.maxValue);
    case "PRICE":
      return withinBounds(context.subtotalGross, rate.minValue, rate.maxValue);
  }
}

function toOption(rate: ShippingRateRow, context: ShippingSelectionContext): ShippingOption {
  const isFree =
    rate.freeOverSubtotal !== null && context.subtotalGross >= rate.freeOverSubtotal;

  return {
    rateId: rate.id,
    name: rate.name,
    currency: context.currency,
    priceGross: isFree ? ZERO : toMinor(rate.priceGross),
    isFree,
    transitDaysMin: rate.transitDaysMin,
    transitDaysMax: rate.transitDaysMax,
  };
}

/**
 * Reduce the zone's rate rows to the methods actually offered for this cart,
 * cheapest first.
 *
 * Deterministic ordering (price, then rate id as a tiebreak) matters twice: the
 * UI shows a stable list, and a test can assert an exact sequence rather than a
 * set.
 */
export function selectShippingOptions(
  rates: readonly ShippingRateRow[],
  context: ShippingSelectionContext,
): ShippingOption[] {
  return rates
    .filter((rate) => isOffered(rate, context))
    .map((rate) => toOption(rate, context))
    .sort((a, b) => a.priceGross - b.priceGross || a.rateId.localeCompare(b.rateId));
}
