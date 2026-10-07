import type { ShippingQuoteResponse } from "@akai/contracts";
import { toMinor } from "@akai/money";

import type { CartShippingBasis } from "../cart/cart.service";
import type { ShippingOption } from "./shipping-rate.selector";

/**
 * Internal selection result → the wire shape.
 *
 * A mapper rather than returning `ShippingOption[]` straight from the handler,
 * for the same reason `product.mapper.ts` exists: the two shapes are not the
 * same and must not become the same by accident. `ShippingOption` is the
 * selector's own vocabulary and is free to grow internal fields (a zone id, a
 * bracket bound) that have no business on a public response.
 *
 * Pure and exported so the flattening rules — an unserved destination, an empty
 * bracket set, the echoed inputs — are assertable without a Nest context or a
 * database.
 */
export function toShippingQuote(
  countryCode: string,
  basis: CartShippingBasis,
  options: readonly ShippingOption[],
  destinationServed: boolean,
): ShippingQuoteResponse {
  return {
    countryCode,
    currency: basis.currency,
    destinationServed,
    // The inputs the server actually used, echoed back. A quote a customer later
    // disputes is then re-derivable from the response alone, without having to
    // reconstruct what was in their basket at the time.
    subtotalGross: basis.subtotalGross,
    weightGrams: basis.weightGrams,
    options: options.map((option) => ({
      rateId: option.rateId,
      name: option.name,
      currency: option.currency,
      // Through toMinor() rather than a cast: a non-integer price that somehow
      // reached a rate row throws here instead of propagating a float into a
      // shipping total the customer is then charged.
      priceGross: toMinor(option.priceGross),
      isFree: option.isFree,
      transitDaysMin: option.transitDaysMin,
      transitDaysMax: option.transitDaysMax,
    })),
  };
}
