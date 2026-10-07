import { z } from "zod";
import { countryCodeSchema, idSchema, isoDateTimeSchema } from "./common";
import { isDestinationCountry } from "./destinations";
import { MINOR_MAX, currencyCodeSchema, nonNegativeMinorSchema } from "./money";

/**
 * Staff-side shipping configuration — the zones/rates admin
 * (`/v1/admin/shipping/*`).
 *
 * Request schemas are `.strict()` like every other request in this lib. Nothing
 * here accepts an amount the CUSTOMER pays except the rate's own `priceGross`,
 * which is staff configuration, not a checkout input.
 */

/** The currency every rate is priced in: the store sells in Colombian pesos only. */
export const SHIPPING_RATE_CURRENCY = "COP";

export const shippingStrategySchema = z.enum(["FLAT", "WEIGHT", "PRICE"]);
export type ShippingStrategy = z.infer<typeof shippingStrategySchema>;

/**
 * A rate's name as staff WRITE it. Trimmed and non-blank: `""` would render as
 * a blank method line at checkout.
 */
export const shippingRateNameSchema = z.string().trim().min(1).max(120);

export type ShippingRateName = z.infer<typeof shippingRateNameSchema>;

const transitDaysSchema = z.number().int().min(0).max(60);

/**
 * Why a zones/rates admin write was refused — the error envelope's `reason`
 * (a sub-code, not a new `ErrorCode`). The
 * dashboard branches on these against its own message catalogue; the API's
 * English message is for logs.
 *
 *  - COUNTRY_IN_OTHER_ZONE     — a country is already in another live zone. (CONFLICT)
 *  - TAX_RATE_MISSING          — a country has no current STANDARD tax_rate row, so
 *                                the shipping tax resolver would refuse every quote
 *                                there. (CONFLICT — fix the tax table, then retry)
 *  - INVALID_BOUNDS            — min ≥ max, or bounds on a FLAT rate. (VALIDATION_FAILED)
 *  - INVALID_TRANSIT_DAYS      — min > max. (VALIDATION_FAILED)
 *
 * The last two are also refused by the request schemas below; they exist as
 * reasons because a PATCH can only be checked against the MERGED row, which only
 * the service can see.
 */
export const shippingAdminFailureReasonSchema = z.enum([
  "COUNTRY_IN_OTHER_ZONE",
  "TAX_RATE_MISSING",
  "INVALID_BOUNDS",
  "INVALID_TRANSIT_DAYS",
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

/** A rate as staff see it. */
export const adminShippingRateSchema = z
  .object({
    id: idSchema,
    zoneId: idSchema,
    name: z.string().max(120),
    strategy: shippingStrategySchema,
    /** WEIGHT: grams. PRICE: minor units. Inclusive lower / exclusive upper. */
    minValue: z.number().int().min(0).nullable(),
    maxValue: z.number().int().min(0).nullable(),
    /** VAT-inclusive, integer minor units — what the customer pays. */
    priceGross: nonNegativeMinorSchema,
    currency: currencyCodeSchema,
    freeOverSubtotal: nonNegativeMinorSchema.nullable(),
    isActive: z.boolean(),
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
    .refine((codes): boolean => codes.every((code) => isDestinationCountry(code)), {
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
  /** The store charges shipping in Colombian pesos only; the selector drops any other currency. */
  currency: z.literal(SHIPPING_RATE_CURRENCY),
  freeOverSubtotal: freeOverSubtotalSchema.nullable(),
  isActive: z.boolean(),
  transitDaysMin: transitDaysSchema.nullable(),
  transitDaysMax: transitDaysSchema.nullable(),
};

type RateFieldsInput = {
  readonly strategy?: ShippingStrategy | undefined;
  readonly minValue?: number | null | undefined;
  readonly maxValue?: number | null | undefined;
  readonly transitDaysMin?: number | null | undefined;
  readonly transitDaysMax?: number | null | undefined;
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
}

export const createShippingRateSchema = z
  .object({
    ...rateFields,
    minValue: rateFields.minValue.default(null),
    maxValue: rateFields.maxValue.default(null),
    currency: rateFields.currency.default(SHIPPING_RATE_CURRENCY),
    freeOverSubtotal: rateFields.freeOverSubtotal.default(null),
    isActive: rateFields.isActive.default(true),
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
