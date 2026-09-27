import { z } from "zod";
import { countryCodeSchema, idSchema, localeSchema } from "./common";
import { shippingDeliveryTypeSchema } from "./enums";
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
 * €500 basket; a client that could post `weightGrams` could ship a 20 kg parcel
 * at the 500 g bracket. Neither field is expressible here, so neither attack has
 * a shape to take.
 */

/**
 * One method the customer may choose, priced for THIS cart.
 *
 * `isFree` is carried explicitly rather than left to be inferred from
 * `priceGross === 0`. A free-over-threshold rate and a genuinely zero-priced
 * rate look identical in the number and read very differently in the UI ("Free
 * shipping — you saved €4.95" vs. "Collection"), and the distinction is only
 * knowable server-side, where the threshold lives.
 *
 * `name` IS PER-LOCALE, exactly like `categorySchema.name`, `mediaAssetSchema.alt`
 * and `productVariantSchema.name`. It was a single monolingual string, and the
 * consequence was that a Spanish shopper picked a delivery method labelled
 * "Standard (2-3 days)" on the last page before payment — the one screen where an
 * untranslated string is most expensive. A record makes the untranslated case
 * unrepresentable rather than merely discouraged: there is no single string left
 * for a caller to render verbatim.
 */
export const shippingOptionSchema = z
  .object({
    rateId: idSchema,
    name: z.record(localeSchema, z.string().min(1).max(120)),
    currency: currencyCodeSchema,
    /** VAT-inclusive, integer minor units, computed for this cart. */
    priceGross: nonNegativeMinorSchema,
    isFree: z.boolean(),
    /**
     * SERVICE_POINT = the customer must pick a pickup point (see
     * `servicePointSearchRequestSchema`) before checkout will accept this rate.
     *
     * The four fields below are DEFAULTED, and that is load-bearing, not
     * convenience: this schema is `.strict()` and the storefront parses every
     * quote through it, and the rollout deploys the CLIENTS FIRST. A new
     * storefront reading an API that does not send these yet must still parse
     * — as HOME with no carrier line, which is exactly today's behaviour.
     *
     * The rate's Sendcloud option code is deliberately NOT here: it is an
     * internal routing detail, never public (`shipping.mapper.test.ts`).
     */
    deliveryType: shippingDeliveryTypeSchema.default("HOME"),
    /** Display name of the carrier ("InPost", "UPS"), or null when unmapped. */
    carrierName: z.string().min(1).max(64).nullable().default(null),
    /** The "1–2 días" sub-line. Null = not shown. */
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

// ---------------------------------------------------------------------------
// Pickup points — `POST /v1/shipping/service-points` (spec §3.2)
// ---------------------------------------------------------------------------

/**
 * Search for pickup points for ONE shipping rate near a destination.
 *
 * The request names the RATE, not a carrier: the server resolves the rate's own
 * carrier, so a client can never ask for (and a customer can never be offered)
 * another carrier's points under this method. Like the quote, it carries no
 * amount and needs no cart.
 */
export const servicePointSearchRequestSchema = z
  .object({
    rateId: idSchema,
    countryCode: countryCodeSchema,
    postalCode: z.string().trim().min(1).max(16),
    /** Narrows an ambiguous postcode. Optional; null = postcode only. */
    city: z.string().trim().min(1).max(120).nullable().default(null),
  })
  .strict();

export type ServicePointSearchRequest = z.infer<typeof servicePointSearchRequestSchema>;

/**
 * What kind of place a point is. Sendcloud's `general_shop_type`; anything it
 * adds later is mapped to `other` server-side rather than failing the parse.
 */
export const servicePointShopTypeSchema = z.enum([
  "servicepoint",
  "locker",
  "post_office",
  "other",
]);
export type ServicePointShopType = z.infer<typeof servicePointShopTypeSchema>;

/** "HH:MM", 24-hour. */
const clockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Time must be HH:MM");

/** One opening shift. A day can have several (08:00–14:00, 17:00–20:30). */
export const openingShiftSchema = z
  .object({
    from: clockTimeSchema,
    to: clockTimeSchema,
  })
  .strict();

export type OpeningShift = z.infer<typeof openingShiftSchema>;

/** `null` = closed that day. Hours are the CURRENT week's, per Sendcloud. */
const openingDaySchema = z.array(openingShiftSchema).nullable();

export const openingHoursSchema = z
  .object({
    monday: openingDaySchema,
    tuesday: openingDaySchema,
    wednesday: openingDaySchema,
    thursday: openingDaySchema,
    friday: openingDaySchema,
    saturday: openingDaySchema,
    sunday: openingDaySchema,
  })
  .strict();

export type OpeningHours = z.infer<typeof openingHoursSchema>;

/**
 * One pickup point, as the storefront renders it.
 *
 * `id` is Sendcloud's point id as a STRING — the search API returns an
 * integer, the shipment API takes a string, and checkout sends this value back
 * verbatim as `servicePointId`. `houseNumber` may be `""` (Sendcloud often
 * leaves it empty and folds it into `street`).
 */
export const servicePointSchema = z
  .object({
    id: z.string().min(1).max(32),
    name: z.string().min(1).max(120),
    shopType: servicePointShopTypeSchema,
    street: z.string().max(200),
    houseNumber: z.string().max(32),
    postalCode: z.string().max(20),
    city: z.string().max(120),
    countryCode: countryCodeSchema,
    /** Metres from the searched address; null when Sendcloud gives none. */
    distanceMeters: z.number().int().min(0).nullable(),
    openingHours: openingHoursSchema,
  })
  .strict();

export type ServicePoint = z.infer<typeof servicePointSchema>;

/**
 * The search outcome. A 200 in every case — each status is an ordinary answer
 * the checkout renders, not a client fault:
 *  - OK                — `points` is non-empty.
 *  - ADDRESS_NOT_FOUND — Sendcloud could not geocode the postcode ("revisa el
 *                        código postal").
 *  - NONE_NEARBY       — geocoded, but no point of this carrier within range.
 *  - UNAVAILABLE       — Sendcloud is down (its geocoder 503s) or fulfilment is
 *                        not configured. Rendered with a retry, NEVER as a
 *                        silent empty list.
 * `points` is empty for every status but OK.
 */
export const servicePointSearchStatusSchema = z.enum([
  "OK",
  "ADDRESS_NOT_FOUND",
  "NONE_NEARBY",
  "UNAVAILABLE",
]);
export type ServicePointSearchStatus = z.infer<typeof servicePointSearchStatusSchema>;

export const servicePointSearchResponseSchema = z
  .object({
    status: servicePointSearchStatusSchema,
    points: z.array(servicePointSchema).max(50),
  })
  .strict();

export type ServicePointSearchResponse = z.infer<typeof servicePointSearchResponseSchema>;
