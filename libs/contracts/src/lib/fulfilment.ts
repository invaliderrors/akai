import { z } from "zod";
import { countryCodeSchema, idSchema, isoDateTimeSchema } from "./common";
import { shippingDeliveryTypeSchema } from "./enums";
import { isDestinationCountry } from "./destinations";
import { MINOR_MAX, currencyCodeSchema, nonNegativeMinorSchema } from "./money";

/**
 * Staff-side fulfilment and shipping configuration — Sendcloud spec
 * `docs/superpowers/specs/2026-09-24-sendcloud-shipping.md` §3.6, §5, §7a.
 *
 * Request schemas are `.strict()` like every other request in this lib. Nothing
 * here accepts an amount the CUSTOMER pays except the rate's own `priceGross`,
 * which is staff configuration, not a checkout input.
 */

// ---------------------------------------------------------------------------
// Labels — `POST /v1/admin/fulfilment/labels` and `.../labels/print`
// ---------------------------------------------------------------------------

/** No id twice: a duplicated id in a bulk request is a client bug, not a request for two labels. */
function uniqueIds(max: number) {
  return z
    .array(idSchema)
    .min(1)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "orderIds must not contain duplicates",
    });
}

/**
 * Generate labels for up to 100 orders (one is the single-order case). The
 * endpoint enqueues one outbox job per accepted order and answers immediately;
 * it is idempotent under an `Idempotency-Key`.
 */
export const bulkLabelRequestSchema = z
  .object({
    orderIds: uniqueIds(100),
  })
  .strict();

export type BulkLabelRequest = z.infer<typeof bulkLabelRequestSchema>;

/**
 * Why an order in a bulk request was NOT enqueued. Each needs a different staff
 * action, which is why they are distinct:
 *  - NOT_PAID          — not PAID (or FULFILLING with no active shipment).
 *  - ALREADY_LABELLED  — it already has an active Sendcloud shipment.
 *  - RATE_NOT_MAPPED   — its method has no Sendcloud option: ship it by hand.
 *  - NOT_FOUND         — no such order.
 *  - WEIGHT_MISSING    — no parcel weight was frozen at checkout (an order from
 *                        before the snapshot, or lines with no weight): the
 *                        carrier cannot price a label without one.
 */
export const bulkLabelSkipReasonSchema = z.enum([
  "NOT_PAID",
  "ALREADY_LABELLED",
  "RATE_NOT_MAPPED",
  "NOT_FOUND",
  "WEIGHT_MISSING",
]);
export type BulkLabelSkipReason = z.infer<typeof bulkLabelSkipReasonSchema>;

/**
 * The split. `accepted` holds ORDER NUMBERS (what staff read in the toast).
 * A skipped entry also carries the request's `orderId`, because a NOT_FOUND
 * order has no number to report — `orderNumber` is null exactly then.
 */
export const bulkLabelResultSchema = z
  .object({
    accepted: z.array(z.string()),
    skipped: z.array(
      z
        .object({
          orderId: idSchema,
          orderNumber: z.string().nullable(),
          reason: bulkLabelSkipReasonSchema,
        })
        .strict(),
    ),
  })
  .strict();

export type BulkLabelResult = z.infer<typeof bulkLabelResultSchema>;

/**
 * One merged PDF of the orders' STORED labels, in request order. Up to 200 —
 * the merge is local (no vendor call), so the cap is about response size only.
 */
export const printLabelsRequestSchema = z
  .object({
    orderIds: uniqueIds(200),
  })
  .strict();

export type PrintLabelsRequest = z.infer<typeof printLabelsRequestSchema>;

// ---------------------------------------------------------------------------
// Shipping zones and rates admin — `/v1/admin/shipping/*` (spec §7a)
// ---------------------------------------------------------------------------

export const shippingStrategySchema = z.enum(["FLAT", "WEIGHT", "PRICE"]);
export type ShippingStrategy = z.infer<typeof shippingStrategySchema>;

/**
 * A rate's per-locale name as staff WRITE it: Spanish required, English
 * optional.
 *
 * Spanish is the store's default locale and the fallback every reader of this
 * name already applies (`localized-text.ts` on the order snapshot, the
 * storefront's `view.ts`), so a rate with only Spanish copy still renders
 * everywhere — in Spanish — rather than disappearing. English is optional so a
 * new method can go live before its translation is written; an empty English
 * name is refused rather than stored, because `""` would satisfy "has a name"
 * and render as a blank method line.
 */
export const shippingRateNameSchema = z
  .object({
    es: z.string().trim().min(1).max(120),
    en: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export type ShippingRateName = z.infer<typeof shippingRateNameSchema>;

/**
 * A rate's name as it is READ back. Both locales optional: the column is Json
 * and rows written before this editor existed (or by hand) are narrowed, not
 * trusted — a row missing Spanish must still be listable so staff can fix it.
 */
export const storedShippingRateNameSchema = z
  .object({
    es: z.string().max(120).optional(),
    en: z.string().max(120).optional(),
  })
  .strict();

const carrierCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/, "Carrier code must be a Sendcloud carrier code, e.g. inpost_es");

const sendcloudOptionCodeSchema = z.string().trim().min(1).max(128);

const transitDaysSchema = z.number().int().min(0).max(60);

/**
 * Why a zones/rates admin write was refused — the error envelope's `reason`
 * (the `fulfilmentFailureReasonSchema` precedent: no new `ErrorCode`). The
 * dashboard branches on these against its own message catalogue; the API's
 * English message is for logs.
 *
 *  - COUNTRY_IN_OTHER_ZONE     — a country is already in another live zone. (CONFLICT)
 *  - TAX_RATE_MISSING          — a country has no current STANDARD tax_rate row, so
 *                                the shipping tax resolver would refuse every quote
 *                                there. (CONFLICT — fix the tax table, then retry)
 *  - INVALID_BOUNDS            — min ≥ max, or bounds on a FLAT rate. (VALIDATION_FAILED)
 *  - INVALID_TRANSIT_DAYS      — min > max. (VALIDATION_FAILED)
 *  - SERVICE_POINT_NEEDS_CARRIER — a SERVICE_POINT rate with no carrier: checkout
 *                                could not search its pickup points. (VALIDATION_FAILED)
 *
 * The last three are also refused by the request schemas below; they exist as
 * reasons because a PATCH can only be checked against the MERGED row, which only
 * the service can see.
 */
export const shippingAdminFailureReasonSchema = z.enum([
  "COUNTRY_IN_OTHER_ZONE",
  "TAX_RATE_MISSING",
  "INVALID_BOUNDS",
  "INVALID_TRANSIT_DAYS",
  "SERVICE_POINT_NEEDS_CARRIER",
]);

export type ShippingAdminFailureReason = z.infer<typeof shippingAdminFailureReasonSchema>;

export const shippingZoneSchema = z
  .object({
    id: idSchema,
    name: z.string().max(120),
    countryCodes: z.array(countryCodeSchema),
    sortOrder: z.number().int(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type ShippingZone = z.infer<typeof shippingZoneSchema>;

/** A rate as staff see it — INCLUDING the internal Sendcloud option code. */
export const adminShippingRateSchema = z
  .object({
    id: idSchema,
    zoneId: idSchema,
    name: storedShippingRateNameSchema,
    strategy: shippingStrategySchema,
    /** WEIGHT: grams. PRICE: minor units. Inclusive lower / exclusive upper. */
    minValue: z.number().int().min(0).nullable(),
    maxValue: z.number().int().min(0).nullable(),
    /** VAT-inclusive, integer minor units — what the customer pays. */
    priceGross: nonNegativeMinorSchema,
    currency: currencyCodeSchema,
    freeOverSubtotal: nonNegativeMinorSchema.nullable(),
    isActive: z.boolean(),
    deliveryType: shippingDeliveryTypeSchema,
    carrierCode: z.string().max(64).nullable(),
    sendcloudOptionCode: z.string().max(128).nullable(),
    transitDaysMin: transitDaysSchema.nullable(),
    transitDaysMax: transitDaysSchema.nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type AdminShippingRate = z.infer<typeof adminShippingRateSchema>;

export const adminShippingRateListSchema = z
  .object({
    rates: z.array(adminShippingRateSchema),
  })
  .strict();

export type AdminShippingRateList = z.infer<typeof adminShippingRateListSchema>;

export const adminShippingZoneDetailSchema = shippingZoneSchema
  .extend({
    rates: z.array(adminShippingRateSchema),
  })
  .strict();

export type AdminShippingZoneDetail = z.infer<typeof adminShippingZoneDetailSchema>;

export const adminShippingZoneListSchema = z
  .object({
    zones: z.array(adminShippingZoneDetailSchema),
  })
  .strict();

export type AdminShippingZoneList = z.infer<typeof adminShippingZoneListSchema>;

const zoneFields = {
  name: z.string().trim().min(1).max(120),
  /**
   * The countries this zone serves — each one from `DESTINATION_COUNTRY_CODES`,
   * the list the checkout's own country selector offers. A country may belong
   * to ONE live zone only — that is a cross-row rule, enforced by the service,
   * not here.
   */
  countryCodes: z
    .array(countryCodeSchema)
    .max(60)
    .refine((codes) => new Set(codes).size === codes.length, {
      message: "countryCodes must not contain duplicates",
    })
    .refine((codes) => codes.every((code) => isDestinationCountry(code)), {
      message: "countryCodes may only contain countries the storefront offers as destinations",
    }),
  sortOrder: z.number().int().min(0).max(10_000),
};

export const createShippingZoneSchema = z
  .object({
    ...zoneFields,
    sortOrder: zoneFields.sortOrder.default(0),
  })
  .strict();

export type CreateShippingZone = z.infer<typeof createShippingZoneSchema>;

export const updateShippingZoneSchema = z.object(zoneFields).partial().strict();

export type UpdateShippingZone = z.infer<typeof updateShippingZoneSchema>;

/**
 * Free over this subtotal — POSITIVE when set. Zero would mean "always free",
 * which is a price of 0, not a threshold; staff who mean that set the price.
 */
const freeOverSubtotalSchema = nonNegativeMinorSchema.refine((value) => value > 0, {
  message: "freeOverSubtotal must be greater than zero, or null to disable it",
});

const rateFields = {
  name: shippingRateNameSchema,
  strategy: shippingStrategySchema,
  minValue: z.number().int().min(0).max(MINOR_MAX).nullable(),
  maxValue: z.number().int().min(0).max(MINOR_MAX).nullable(),
  priceGross: nonNegativeMinorSchema,
  /** The store charges shipping in euros only; the selector drops any other currency. */
  currency: z.literal("EUR"),
  freeOverSubtotal: freeOverSubtotalSchema.nullable(),
  isActive: z.boolean(),
  deliveryType: shippingDeliveryTypeSchema,
  carrierCode: carrierCodeSchema.nullable(),
  sendcloudOptionCode: sendcloudOptionCodeSchema.nullable(),
  transitDaysMin: transitDaysSchema.nullable(),
  transitDaysMax: transitDaysSchema.nullable(),
};

type RateFieldsInput = {
  readonly strategy?: ShippingStrategy | undefined;
  readonly minValue?: number | null | undefined;
  readonly maxValue?: number | null | undefined;
  readonly transitDaysMin?: number | null | undefined;
  readonly transitDaysMax?: number | null | undefined;
  readonly deliveryType?: "HOME" | "SERVICE_POINT" | undefined;
  readonly carrierCode?: string | null | undefined;
};

/**
 * Whether a rate's bracket is coherent. Shared by the request schemas (one
 * body) and the API service (the MERGED row of a PATCH), so the rule is written
 * once.
 *
 * FLAT carries no bounds: the selector ignores them for FLAT, so a stored bound
 * would be a number staff believe does something and which does nothing.
 */
export function shippingRateBoundsValid(rate: {
  readonly strategy: ShippingStrategy;
  readonly minValue: number | null;
  readonly maxValue: number | null;
}): boolean {
  if (rate.strategy === "FLAT") {
    return rate.minValue === null && rate.maxValue === null;
  }
  return rate.minValue === null || rate.maxValue === null || rate.minValue < rate.maxValue;
}

/**
 * Rules that hold WITHIN one request body. On a PATCH they check only what the
 * body itself carries; the service re-checks the merged row, since a PATCH of
 * `maxValue` alone can still invert the stored `minValue`.
 */
function refineRate(rate: RateFieldsInput, ctx: z.RefinementCtx): void {
  const min = rate.minValue ?? null;
  const max = rate.maxValue ?? null;
  // Without a strategy in the body (a PATCH of bounds alone) only the ordering
  // can be judged here; the FLAT rule needs the merged row.
  const boundsValid =
    rate.strategy === undefined
      ? min === null || max === null || min < max
      : shippingRateBoundsValid({ strategy: rate.strategy, minValue: min, maxValue: max });
  if (!boundsValid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["maxValue"],
      message:
        rate.strategy === "FLAT"
          ? "A FLAT rate takes no minValue/maxValue"
          : "maxValue must be greater than minValue",
    });
  }
  if (
    typeof rate.transitDaysMin === "number" &&
    typeof rate.transitDaysMax === "number" &&
    rate.transitDaysMin > rate.transitDaysMax
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["transitDaysMax"],
      message: "transitDaysMax must not be less than transitDaysMin",
    });
  }
  // A pickup-point method with no carrier cannot search points — the checkout
  // would offer a method nobody can complete.
  if (rate.deliveryType === "SERVICE_POINT" && rate.carrierCode === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["carrierCode"],
      message: "A SERVICE_POINT rate needs a carrierCode to search pickup points",
    });
  }
}

export const createShippingRateSchema = z
  .object({
    ...rateFields,
    minValue: rateFields.minValue.default(null),
    maxValue: rateFields.maxValue.default(null),
    currency: rateFields.currency.default("EUR"),
    freeOverSubtotal: rateFields.freeOverSubtotal.default(null),
    isActive: rateFields.isActive.default(true),
    deliveryType: rateFields.deliveryType.default("HOME"),
    carrierCode: rateFields.carrierCode.default(null),
    sendcloudOptionCode: rateFields.sendcloudOptionCode.default(null),
    transitDaysMin: rateFields.transitDaysMin.default(null),
    transitDaysMax: rateFields.transitDaysMax.default(null),
  })
  .strict()
  .superRefine(refineRate);

export type CreateShippingRate = z.infer<typeof createShippingRateSchema>;

export const updateShippingRateSchema = z
  .object(rateFields)
  .partial()
  .strict()
  .superRefine(refineRate);

export type UpdateShippingRate = z.infer<typeof updateShippingRateSchema>;

// ---------------------------------------------------------------------------
// `GET /v1/admin/shipping/sendcloud-options?country=` — the rate editor's
// option picker, proxied from Sendcloud's `POST /shipping-options`.
// ---------------------------------------------------------------------------

export const sendcloudOptionsQuerySchema = z
  .object({
    country: countryCodeSchema,
  })
  .strict();

export type SendcloudOptionsQuery = z.infer<typeof sendcloudOptionsQuerySchema>;

export const sendcloudShippingOptionSchema = z
  .object({
    /** What goes into `sendcloudOptionCode`. */
    code: z.string().max(128),
    name: z.string().max(200),
    carrierCode: z.string().max(64),
    carrierName: z.string().max(120),
    /** Sendcloud's `functionalities.last_mile` (`service_point`, `home_delivery`, …). */
    lastMile: z.string().max(64).nullable(),
    /**
     * The rate `deliveryType` this option implies — SERVICE_POINT when the
     * last mile is a point/locker or the option demands one, HOME otherwise.
     * Pre-fills the editor; staff may still override it.
     */
    deliveryType: shippingDeliveryTypeSchema,
    requiresServicePoint: z.boolean(),
    /** Address fields the carrier demands (`to_email`, `to_telephone`, …). */
    requiredFields: z.array(z.string().max(64)),
    /**
     * The MERCHANT'S cost for a 500 g parcel, integer minor units — never what
     * the customer pays (spec §3.1). Null when Sendcloud quotes nothing.
     */
    merchantCost: nonNegativeMinorSchema.nullable(),
    currency: currencyCodeSchema.nullable(),
  })
  .strict();

export type SendcloudShippingOption = z.infer<typeof sendcloudShippingOptionSchema>;

export const sendcloudOptionsResponseSchema = z
  .object({
    country: countryCodeSchema,
    options: z.array(sendcloudShippingOptionSchema),
  })
  .strict();

export type SendcloudOptionsResponse = z.infer<typeof sendcloudOptionsResponseSchema>;
