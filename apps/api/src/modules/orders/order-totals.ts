import { type Minor } from "@akai/contracts";
import {
  ZERO,
  add,
  applyBasisPoints,
  multiply,
  splitGross,
  subtract,
  sum,
  toMinor,
} from "@akai/money";

/**
 * Order line snapshotting and total computation. PURE — no Prisma, no Nest, no
 * clock. Every number in and out is integer minor units.
 *
 * WHY THIS IS ITS OWN FILE: these are the numbers that end up on a filed
 * invoice. They need to be testable exhaustively without a database, and they
 * need to be re-derivable years later from the same inputs when someone disputes
 * a line. Burying them inside a service method makes both impossible.
 *
 * THE TOTALS MODEL (stated once, since every consumer depends on it):
 *
 *   grandTotal = subtotal - discountTotal + shippingTotal + taxTotal
 *
 * with `subtotal`, `discountTotal` and `shippingTotal` all NET of tax and
 * `taxTotal` the tax on everything. That identity is exact, never approximate,
 * and `assertTotalsBalance` enforces it before anything is written.
 *
 * The subtlety that makes it exact: catalogue prices are VAT-INCLUSIVE (gross),
 * because that is what an EU consumer must be shown. So the line is computed in
 * gross, discounted in gross, and only then split into net + tax. The net
 * discount is derived as `netBeforeDiscount - netAfterDiscount` rather than
 * computed independently, which is what guarantees no ±1 cent drift: two
 * independent roundings of the same money disagree roughly a third of the time.
 */

/** A cart line, already re-priced from the LIVE variant by the caller. */
export interface PricedLine {
  readonly variantId: string;
  readonly productName: string;
  readonly variantName: string | null;
  readonly sku: string;
  readonly imageUrl: string | null;
  readonly quantity: number;
  /** VAT-inclusive unit price from the live variant. */
  readonly unitPriceGross: Minor;
  readonly taxRateBps: number;
  /** Gross discount applied to this whole line (not per unit). */
  readonly lineDiscount: Minor;
  /**
   * Set together, or both null. Pure passthrough — never read by any
   * computation in this file. Carried
   * from `CartItem` through to `OrderItem` purely so a pack purchase's lines
   * stay grouped for display after checkout.
   */
  readonly packProductId: string | null;
  readonly packInstanceId: string | null;
}

/** An immutable order line, ready to persist. Mirrors the OrderItem columns. */
export interface OrderLineSnapshot {
  readonly variantId: string;
  readonly productName: string;
  readonly variantName: string | null;
  readonly sku: string;
  readonly imageUrl: string | null;
  readonly quantity: number;
  readonly unitPriceNet: Minor;
  readonly unitPriceGross: Minor;
  readonly lineDiscount: Minor;
  readonly taxRateBps: number;
  readonly taxAmount: Minor;
  readonly lineTotalNet: Minor;
  readonly lineTotalGross: Minor;
  readonly packProductId: string | null;
  readonly packInstanceId: string | null;
}

/** Per-line intermediates the order-level totals need but the line row does not store. */
interface LineComputation {
  readonly snapshot: OrderLineSnapshot;
  /** Net value of the line BEFORE its discount — feeds `subtotal`. */
  readonly netBeforeDiscount: Minor;
  /** Net value of the discount — feeds `discountTotal`. */
  readonly netDiscount: Minor;
}

export interface ShippingCharge {
  /** Net shipping cost, resolved server-side from a ShippingRate. Never client-supplied. */
  readonly net: Minor;
  readonly taxRateBps: number;
}

export interface OrderTotals {
  readonly subtotal: Minor;
  readonly discountTotal: Minor;
  readonly shippingTotal: Minor;
  readonly taxTotal: Minor;
  readonly grandTotal: Minor;
}

export interface PricedOrder {
  readonly lines: readonly OrderLineSnapshot[];
  readonly totals: OrderTotals;
}

/** A line whose inputs are internally inconsistent. Never reaches the database. */
export class OrderPricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderPricingError";
  }
}

function computeLine(line: PricedLine): LineComputation {
  if (!Number.isInteger(line.quantity) || line.quantity < 1) {
    throw new OrderPricingError(
      `Line ${line.sku} has a non-positive quantity (${line.quantity}).`,
    );
  }
  if (!Number.isInteger(line.taxRateBps) || line.taxRateBps < 0) {
    throw new OrderPricingError(
      `Line ${line.sku} has an invalid tax rate (${line.taxRateBps} bps).`,
    );
  }

  const grossBeforeDiscount = multiply(line.unitPriceGross, line.quantity);

  // A discount larger than the line is not a clamp-and-continue situation: it
  // means the discount engine produced garbage, and clamping would quietly ship
  // a free order. Refuse to price it.
  if (line.lineDiscount > grossBeforeDiscount) {
    throw new OrderPricingError(
      `Line ${line.sku} has a discount (${line.lineDiscount}) larger than the ` +
        `line total (${grossBeforeDiscount}). Refusing to price a negative line.`,
    );
  }

  const grossAfterDiscount = subtract(grossBeforeDiscount, line.lineDiscount);

  const before = splitGross(grossBeforeDiscount, line.taxRateBps);
  const after = splitGross(grossAfterDiscount, line.taxRateBps);

  // Display-only: the unit net is shown on the invoice, but the LINE total is
  // never rebuilt from it. Rounding per line then summing (the documented rule)
  // and rounding per unit then multiplying give different answers, and only the
  // former makes the invoice foot.
  const unitPriceNet = splitGross(line.unitPriceGross, line.taxRateBps).net;

  return {
    snapshot: {
      variantId: line.variantId,
      productName: line.productName,
      variantName: line.variantName,
      sku: line.sku,
      imageUrl: line.imageUrl,
      quantity: line.quantity,
      unitPriceNet,
      unitPriceGross: line.unitPriceGross,
      lineDiscount: line.lineDiscount,
      taxRateBps: line.taxRateBps,
      taxAmount: after.tax,
      lineTotalNet: after.net,
      lineTotalGross: grossAfterDiscount,
      packProductId: line.packProductId,
      packInstanceId: line.packInstanceId,
    },
    netBeforeDiscount: before.net,
    netDiscount: subtract(before.net, after.net),
  };
}

/**
 * Price a whole order: snapshot every line, then total them.
 *
 * The result is what gets written. Nothing downstream recomputes it, and
 * nothing downstream is allowed to accept a total from a client (spec §13) —
 * this function and the live variant rows are the only inputs.
 */
export function priceOrder(
  lines: readonly PricedLine[],
  shipping: ShippingCharge,
): PricedOrder {
  if (lines.length === 0) {
    throw new OrderPricingError("An order must have at least one line.");
  }
  if (!Number.isInteger(shipping.taxRateBps) || shipping.taxRateBps < 0) {
    throw new OrderPricingError(
      `Shipping has an invalid tax rate (${shipping.taxRateBps} bps).`,
    );
  }

  const computed = lines.map(computeLine);

  const subtotal = sum(computed.map((line) => line.netBeforeDiscount));
  const discountTotal = sum(computed.map((line) => line.netDiscount));
  const shippingTax = applyBasisPoints(shipping.net, shipping.taxRateBps);
  const taxTotal = add(
    sum(computed.map((line) => line.snapshot.taxAmount)),
    shippingTax,
  );

  const grandTotal = add(
    add(subtract(subtotal, discountTotal), shipping.net),
    taxTotal,
  );

  const totals: OrderTotals = {
    subtotal,
    discountTotal,
    shippingTotal: shipping.net,
    taxTotal,
    grandTotal,
  };

  const snapshots = computed.map((line) => line.snapshot);
  assertTotalsBalance(snapshots, totals, shipping);

  return { lines: snapshots, totals };
}

/**
 * The invariant, checked before persistence rather than asserted in a test only.
 *
 * A test proves the function is right for the cases someone thought of. This
 * proves it for the order actually being written, including the case nobody
 * thought of. An order whose lines do not sum to its grand total is an invoice
 * that does not foot, and it is far cheaper to fail the request than to discover
 * it during a VAT audit.
 */
export function assertTotalsBalance(
  lines: readonly OrderLineSnapshot[],
  totals: OrderTotals,
  shipping: ShippingCharge,
): void {
  const additive = add(
    add(subtract(totals.subtotal, totals.discountTotal), totals.shippingTotal),
    totals.taxTotal,
  );

  if (additive !== totals.grandTotal) {
    throw new OrderPricingError(
      `Order totals do not balance: subtotal(${totals.subtotal}) ` +
        `- discount(${totals.discountTotal}) + shipping(${totals.shippingTotal}) ` +
        `+ tax(${totals.taxTotal}) = ${additive}, but grandTotal is ${totals.grandTotal}.`,
    );
  }

  // Cross-check against the gross side. The additive identity above can be
  // satisfied by two compensating errors; this cannot be satisfied by anything
  // except correct line arithmetic.
  const grossFromLines = sum(lines.map((line) => line.lineTotalGross));
  const shippingGross = add(
    shipping.net,
    applyBasisPoints(shipping.net, shipping.taxRateBps),
  );
  const grossTotal = add(grossFromLines, shippingGross);

  if (grossTotal !== totals.grandTotal) {
    throw new OrderPricingError(
      `Order gross lines (${grossFromLines}) plus shipping gross ` +
        `(${shippingGross}) = ${grossTotal}, which contradicts ` +
        `grandTotal ${totals.grandTotal}.`,
    );
  }

  for (const line of lines) {
    if (add(line.lineTotalNet, line.taxAmount) !== line.lineTotalGross) {
      throw new OrderPricingError(
        `Line ${line.sku}: net(${line.lineTotalNet}) + tax(${line.taxAmount}) ` +
          `!= gross(${line.lineTotalGross}).`,
      );
    }
  }
}

/**
 * How much of an order may still be refunded.
 *
 * Pending refunds count against the balance. If they did not, two operators
 * clicking "refund" in the same minute would each pass an independent check and
 * together refund more than the customer ever paid — the classic double-spend,
 * on our side of the ledger.
 */
export function refundableRemaining(
  grandTotal: Minor,
  refundedTotal: Minor,
  pendingRefundTotal: Minor,
): Minor {
  const remaining = grandTotal - refundedTotal - pendingRefundTotal;
  return remaining <= 0 ? ZERO : toMinor(remaining);
}
