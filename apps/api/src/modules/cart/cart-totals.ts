import type { CurrencyCode, Minor } from "@akai/contracts";
import { ZERO, add, allocate, multiply, splitGross, subtract, sum } from "@akai/money";

/**
 * Cart totals — a PURE function over live line data.
 *
 * Kept free of Nest, Prisma and I/O for one reason: this is the code that
 * decides how much money to charge, so it must be exhaustively testable without
 * a database. Every number entering it has already been re-read from the live
 * variant by CartService; nothing here is client-supplied.
 *
 * THE VAT-INCLUSIVE RULE (spec §13): displayed prices are GROSS, i.e. tax is
 * already inside `unitPriceGross`. Therefore
 *
 *     grandTotal = subtotal - discount + shipping
 *
 * and `taxTotal` is a BREAKDOWN of money already counted in the subtotal, never
 * an addition to it. Adding taxTotal into grandTotal is the classic
 * double-charge bug on an EU store; `calculateTotals` has a dedicated test
 * asserting it does not happen.
 */

export interface TotalsLine {
  readonly quantity: number;
  /** LIVE price from the variant, never the add-time snapshot. */
  readonly unitPriceGross: Minor;
  readonly taxRateBps: number;
  /**
   * False for lines that cannot legally be charged (product withdrawn, out of
   * stock, currency mismatch). Such lines still render in the cart so the
   * customer can see what happened, but they contribute nothing to the money.
   */
  readonly countsTowardTotals: boolean;
}

export interface TotalsInput {
  readonly currency: CurrencyCode;
  readonly lines: readonly TotalsLine[];
  /** Resolved by the discounts module. Zero until that module is wired. */
  readonly discountTotal: Minor;
  /** Gross shipping. Zero in the cart stage — no destination is known yet. */
  readonly shippingTotal: Minor;
}

export interface CalculatedTotals {
  readonly currency: CurrencyCode;
  readonly subtotal: Minor;
  readonly discountTotal: Minor;
  readonly shippingTotal: Minor;
  readonly taxTotal: Minor;
  readonly grandTotal: Minor;
}

export function calculateTotals(input: TotalsInput): CalculatedTotals {
  const chargeable = input.lines.filter((line) => line.countsTowardTotals);
  const lineGrossAmounts = chargeable.map((line) =>
    multiply(line.unitPriceGross, line.quantity),
  );

  const subtotal = sum(lineGrossAmounts);

  // Clamp before anything else. An unclamped discount larger than the basket
  // produces a negative grand total, which downstream becomes either a refund
  // the gateway will not process or — worse — a successful zero-amount charge.
  const discountTotal = input.discountTotal > subtotal ? subtotal : input.discountTotal;

  const taxTotal = calculateTaxTotal(chargeable, lineGrossAmounts, discountTotal);

  const grandTotal = add(subtract(subtotal, discountTotal), input.shippingTotal);

  return {
    currency: input.currency,
    subtotal,
    discountTotal,
    shippingTotal: input.shippingTotal,
    taxTotal,
    grandTotal,
  };
}

/**
 * Tax is derived per line from the DISCOUNTED gross, then summed — the
 * "round half-up per line, then sum" rule stated once in @akai/money.
 *
 * The order-level discount is pushed down onto lines with the remainder-
 * distributing allocator rather than by naive proportional rounding, so the
 * per-line discounts sum EXACTLY to the order discount. Without that, a €10.00
 * discount routinely removes €9.99 and the invoice does not foot.
 *
 * Lines can carry different tax rates (a supplement at the reduced rate beside
 * a standard-rated accessory), which is why tax cannot be computed once over
 * the subtotal.
 */
function calculateTaxTotal(
  lines: readonly TotalsLine[],
  lineGrossAmounts: readonly Minor[],
  discountTotal: Minor,
): Minor {
  if (lineGrossAmounts.length === 0) {
    return ZERO;
  }

  // `allocate` rejects ratios summing to zero. That case is reachable — a cart
  // holding only free samples — and must not throw.
  const discountShares =
    discountTotal > 0
      ? allocate(discountTotal, [...lineGrossAmounts])
      : lineGrossAmounts.map(() => ZERO);

  let taxTotal = ZERO;

  for (const [index, line] of lines.entries()) {
    const lineGross = lineGrossAmounts[index];
    const discountShare = discountShares[index];

    // noUncheckedIndexedAccess: both arrays are built from `lines` and are
    // therefore the same length, but that is proven to the compiler rather than
    // asserted away with `!` — which the engineering rules ban precisely
    // because it hides the case this branch makes explicit.
    if (lineGross === undefined || discountShare === undefined) {
      continue;
    }

    const discountedGross = subtract(lineGross, discountShare);
    taxTotal = add(taxTotal, splitGross(discountedGross, line.taxRateBps).tax);
  }

  return taxTotal;
}
