import { z } from "zod";
import { countryCodeSchema, idSchema } from "./common";
import { currencyCodeSchema, moneySchema, nonNegativeMinorSchema } from "./money";

/**
 * Shipping quotes — the public half of ShippingModule.
 *
 * WHY THIS EXISTS: `createCheckoutSessionSchema` REQUIRES a `shippingMethodId`,
 * and that id is a `shipping_rate` row id. Until this contract existed there was
 * no public route that produced one, so a storefront could assemble a complete,
 * valid checkout body for every field except the one that decides the price —
 * which made checkout unreachable by construction rather than by a bug.
 *
 * THE INVARIANT, and it is the same one that governs the cart: THE REQUEST
 * CARRIES NO AMOUNT AND NO WEIGHT. A quote is a function of (destination, the
 * caller's own cart), and the cart is resolved server-side from the cart actor.
 * A client that could post `subtotalGross` could buy free shipping by claiming a
 * $5.000.000 basket; a client that could post `weightGrams` could ship a 20 kg parcel
 * at the 500 g bracket. Neither field is expressible here, so neither attack has
 * a shape to take.
 */

/**
 * One method the customer may choose, priced for THIS cart.
 *
 * `isFree` is carried explicitly rather than left to be inferred from
 * `priceGross === 0`. A free-over-threshold rate and a genuinely zero-priced
 * rate look identical in the number and read very differently in the UI ("Free
 * shipping — you saved $ 15.000" vs. "Collection"), and the distinction is only
 * knowable server-side, where the threshold lives.
 *
 * `name` is the rate's Spanish display name ("Envío nacional"), rendered as is.
 */
export const shippingOptionSchema = z
  .object({
    rateId: idSchema,
    name: z.string().min(1).max(120),
    currency: currencyCodeSchema,
    /** VAT-inclusive, integer minor units, computed for this cart. */
    priceGross: nonNegativeMinorSchema,
    isFree: z.boolean(),
    /**
     * The "2–5 días" sub-line. Null = not shown. DEFAULTED: this schema is
     * `.strict()`, the storefront parses every quote through it, and a client
     * deployed first must still parse an API that does not send them yet.
     */
    transitDaysMin: z.number().int().min(0).max(60).nullable().default(null),
    transitDaysMax: z.number().int().min(0).max(60).nullable().default(null),
  })
  .strict();

export type ShippingOptionDto = z.infer<typeof shippingOptionSchema>;

/**
 * A quote request. Destination only.
 *
 * `postalCode` is accepted and currently unused by rate selection (zones are
 * country-granular today). It is declared because the storefront address form
 * already collects it and a postcode-granular zone is the obvious next rate
 * strategy — accepting it now means adding that strategy does not become a
 * breaking change to every client at the same time.
 */
export const shippingQuoteRequestSchema = z
  .object({
    countryCode: countryCodeSchema,
    postalCode: z.string().trim().min(1).max(16).nullable().default(null),
  })
  .strict();

export type ShippingQuoteRequest = z.infer<typeof shippingQuoteRequestSchema>;

/**
 * The quote.
 *
 * `destinationServed: false` with an empty `options` is a 200, NOT an error.
 * "We do not ship to your country" is a normal answer to a normal question — a
 * shopper changing the country dropdown is not a client fault — and modelling it
 * as a 400 forces every caller to parse an error envelope to render a perfectly
 * ordinary piece of UI. An empty `options` WITH `destinationServed: true` is the
 * genuinely distinct second case: we ship there, but this parcel fits no bracket.
 *
 * `subtotalGross` and `weightGrams` are echoed back because they are the inputs
 * the server actually used. A quote a customer disputes is then re-derivable from
 * the response alone, without reconstructing their cart at the time.
 */
export const shippingQuoteResponseSchema = z
  .object({
    countryCode: countryCodeSchema,
    currency: currencyCodeSchema,
    destinationServed: z.boolean(),
    subtotalGross: nonNegativeMinorSchema,
    weightGrams: z.number().int().min(0),
    options: z.array(shippingOptionSchema),
  })
  .strict();

export type ShippingQuoteResponse = z.infer<typeof shippingQuoteResponseSchema>;

/**
 * The free-shipping threshold that holds REGARDLESS OF DESTINATION —
 * `GET /v1/shipping/free-shipping`.
 *
 * The cart page and drawer know no destination, so they may only promise a
 * threshold that every active rate in every served zone shares (same
 * `freeOverSubtotal`, same currency). When no such single figure exists — a rate
 * with no threshold, two rates that disagree, no rates at all — `threshold` is
 * null and the storefront shows no hint rather than a wrong one.
 *
 * The figure it is measured against is the cart's subtotal AFTER discount,
 * over counted lines (`totals.subtotal - totals.discountTotal`), the same basis
 * the quote endpoint and checkout use server-side.
 *
 * The threshold is exposed rather than hard-coded in the storefront so the
 * number the cart promises is the number the rate rows actually apply.
 */
export const freeShippingThresholdResponseSchema = z
  .object({
    threshold: moneySchema.nullable(),
  })
  .strict();

export type FreeShippingThresholdResponse = z.infer<typeof freeShippingThresholdResponseSchema>;
