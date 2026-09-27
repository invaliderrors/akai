import type { CartTotals, Minor, Money } from "@akai/contracts";
import { ZERO, money, subtract, toMinor } from "@akai/money";

/**
 * Free shipping over a threshold — the ONE owner of the basis it is measured
 * against.
 *
 * WHY THIS FILE EXISTS: the quote endpoint and checkout used to compute the
 * subtotal a rate's `freeOverSubtotal` is compared with in two different ways —
 * the quote after discount, checkout before discount and including lines the
 * cart had excluded from its totals. A discounted €260 basket could therefore be
 * quoted paid shipping and charged free shipping, or the reverse. Both paths now
 * call `qualifyingSubtotal`, so one cart yields one number
 * (docs/superpowers/specs/2026-09-24-client-feedback-changes.md §3, D3a).
 *
 * Pure: no Nest, no Prisma, so the cart module can import it without taking a
 * dependency on ShippingModule (which already depends on CartModule).
 */

/**
 * The subtotal a free-shipping threshold is compared with: the cart's GROSS
 * subtotal over COUNTED lines only (a withdrawn or out-of-stock line is already
 * excluded from `totals.subtotal` by `calculateTotals`), MINUS the discount.
 *
 * After discount (D3a) because that is what the customer pays, and because a
 * pre-discount basis would let a coupon keep a €240 order inside a €250
 * free-shipping bracket. Shipping itself is deliberately not part of it: the
 * basis must not depend on the charge it decides.
 */
export function qualifyingSubtotal(
  totals: Pick<CartTotals, "subtotal" | "discountTotal">,
): Minor {
  // `calculateTotals` already clamps the discount to the subtotal; clamping
  // again here keeps this function total over any input rather than trusting
  // every caller to have come through that path.
  if (totals.discountTotal >= totals.subtotal) {
    return ZERO;
  }
  return subtract(totals.subtotal, totals.discountTotal);
}

/**
 * The free-shipping threshold that holds regardless of destination — or null
 * when there is no such single number.
 *
 * The cart page and drawer know no destination, so they can only promise a
 * threshold that EVERY active rate in EVERY zone shares. If any rate has none,
 * or two rates disagree, there is no truthful destination-independent answer
 * and the storefront shows no hint rather than a wrong one.
 */
export function sharedFreeShippingThreshold(
  rates: readonly { readonly freeOverSubtotal: number | null; readonly currency: string }[],
): Money | null {
  const [first, ...rest] = rates;
  if (first === undefined || first.freeOverSubtotal === null) {
    return null;
  }
  const threshold = first.freeOverSubtotal;
  const currency = first.currency;
  const uniform = rest.every(
    (rate) => rate.freeOverSubtotal === threshold && rate.currency === currency,
  );
  return uniform ? money(toMinor(threshold), currency) : null;
}
