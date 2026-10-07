import {
  isDestinationCountry,
  shippingAdminFailureReasonSchema,
  shippingRateBoundsValid,
  toMinor,
  type AdminShippingRate,
  type AdminShippingZoneDetail,
  type ShippingAdminFailureReason,
  type ShippingStrategy,
  SHIPPING_RATE_CURRENCY,
} from "@akai/contracts";

import {
  formatMinorAsInput,
  parseMajorUnitInput,
  parseScaledDecimal,
  type ScaledDecimalError,
} from "./money-input";
import type {
  CreateShippingRateInput,
  CreateShippingZoneInput,
} from "./shipping-api";

/**
 * The shipping editor's pure half: form values ⇄ request bodies, the
 * free-shipping warning and the country-conflict finder. No React, no intl —
 * every failure is a member of a CLOSED union the component maps onto
 * `admin.shipping.fieldErrors.*`, so this file is testable on its own and a new
 * failure mode cannot ship without copy.
 *
 * MONEY GOES THROUGH `money-input.ts` ONLY — the same string-arithmetic parser
 * the product and discount forms use, in whole pesos for COP ("15000" or
 * "15.000"). Grams and days go through `parseScaledDecimal` at exponent 0, so
 * "1.000" (a thousands separator) is refused rather than read as one gram.
 */

/** The store sells, and charges shipping, in Colombian pesos only. */
export const SHIPPING_CURRENCY = SHIPPING_RATE_CURRENCY;

export type RateFormError =
  | ScaledDecimalError
  | "REQUIRED"
  | "TOO_LONG"
  | "BOUNDS_ORDER"
  | "NOT_POSITIVE"
  | "TRANSIT_ORDER";

export type RateField =
  | "name"
  | "minValue"
  | "maxValue"
  | "priceGross"
  | "freeOverSubtotal"
  | "transitDaysMin"
  | "transitDaysMax";

export type RateFieldErrors = Partial<Readonly<Record<RateField, RateFormError>>>;

/** Everything an input holds is a string. Converted on submit. */
export interface RateFormValues {
  readonly name: string;
  readonly strategy: ShippingStrategy;
  /** WEIGHT: whole grams. PRICE: whole pesos ("300000" / "300.000"). Ignored for FLAT. */
  readonly minValue: string;
  readonly maxValue: string;
  readonly priceGross: string;
  /** "" disables the threshold. */
  readonly freeOverSubtotal: string;
  readonly isActive: boolean;
  readonly transitDaysMin: string;
  readonly transitDaysMax: string;
}

export type RateBuildResult =
  | { readonly ok: true; readonly value: CreateShippingRateInput }
  | { readonly ok: false; readonly errors: RateFieldErrors };

const NAME_MAX = 120;
const WEIGHT_MAX_GRAMS = 1_000_000;
const TRANSIT_MAX_DAYS = 60;

export function emptyRateValues(): RateFormValues {
  return {
    name: "",
    strategy: "FLAT",
    minValue: "",
    maxValue: "",
    priceGross: "",
    freeOverSubtotal: "",
    isActive: true,
    transitDaysMin: "",
    transitDaysMax: "",
  };
}

function boundAsInput(value: number | null, strategy: ShippingStrategy): string {
  if (value === null) return "";
  // PRICE bounds are minor units like any amount; WEIGHT bounds are grams.
  return strategy === "PRICE" ? formatMinorAsInput(toMinor(value), SHIPPING_CURRENCY) : String(value);
}

export function rateToValues(rate: AdminShippingRate): RateFormValues {
  return {
    name: rate.name,
    strategy: rate.strategy,
    minValue: boundAsInput(rate.minValue, rate.strategy),
    maxValue: boundAsInput(rate.maxValue, rate.strategy),
    priceGross: formatMinorAsInput(rate.priceGross, SHIPPING_CURRENCY),
    freeOverSubtotal:
      rate.freeOverSubtotal === null
        ? ""
        : formatMinorAsInput(rate.freeOverSubtotal, SHIPPING_CURRENCY),
    isActive: rate.isActive,
    transitDaysMin: rate.transitDaysMin === null ? "" : String(rate.transitDaysMin),
    transitDaysMax: rate.transitDaysMax === null ? "" : String(rate.transitDaysMax),
  };
}

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RateFormError };

function optionalWhole(raw: string, max: number): Parsed<number | null> {
  if (raw.trim() === "") return { ok: true, value: null };
  const parsed = parseScaledDecimal(raw, { exponent: 0, max });
  return parsed.ok ? parsed : { ok: false, error: parsed.error };
}

function optionalMoney(raw: string): Parsed<number | null> {
  if (raw.trim() === "") return { ok: true, value: null };
  const parsed = parseMajorUnitInput(raw, SHIPPING_CURRENCY);
  return parsed.ok ? parsed : { ok: false, error: parsed.error };
}

function bound(raw: string, strategy: ShippingStrategy): Parsed<number | null> {
  if (strategy === "FLAT") return { ok: true, value: null };
  return strategy === "PRICE" ? optionalMoney(raw) : optionalWhole(raw, WEIGHT_MAX_GRAMS);
}

/**
 * Form values → the create body (also sent whole as the PATCH body on edit:
 * the editor always shows every field, so it always sends every field and the
 * API's merged-row check sees exactly what the operator sees).
 *
 * The same rules the API's schema and service apply, checked here first as a
 * courtesy so the operator is told beside the field; the server remains the
 * authority.
 */
export function buildRatePayload(values: RateFormValues): RateBuildResult {
  const errors: Partial<Record<RateField, RateFormError>> = {};

  const name = values.name.trim();
  if (name === "") errors.name = "REQUIRED";
  else if (name.length > NAME_MAX) errors.name = "TOO_LONG";

  const price = parseMajorUnitInput(values.priceGross, SHIPPING_CURRENCY);
  if (!price.ok) errors.priceGross = price.error;

  const freeOver = optionalMoney(values.freeOverSubtotal);
  if (!freeOver.ok) errors.freeOverSubtotal = freeOver.error;
  else if (freeOver.value === 0) errors.freeOverSubtotal = "NOT_POSITIVE";

  const min = bound(values.minValue, values.strategy);
  const max = bound(values.maxValue, values.strategy);
  if (!min.ok) errors.minValue = min.error;
  if (!max.ok) errors.maxValue = max.error;
  if (
    min.ok &&
    max.ok &&
    !shippingRateBoundsValid({ strategy: values.strategy, minValue: min.value, maxValue: max.value })
  ) {
    errors.maxValue = "BOUNDS_ORDER";
  }

  const transitMin = optionalWhole(values.transitDaysMin, TRANSIT_MAX_DAYS);
  const transitMax = optionalWhole(values.transitDaysMax, TRANSIT_MAX_DAYS);
  if (!transitMin.ok) errors.transitDaysMin = transitMin.error;
  if (!transitMax.ok) errors.transitDaysMax = transitMax.error;
  if (
    transitMin.ok &&
    transitMax.ok &&
    transitMin.value !== null &&
    transitMax.value !== null &&
    transitMin.value > transitMax.value
  ) {
    errors.transitDaysMax = "TRANSIT_ORDER";
  }

  if (
    Object.keys(errors).length > 0 ||
    !price.ok ||
    !freeOver.ok ||
    !min.ok ||
    !max.ok ||
    !transitMin.ok ||
    !transitMax.ok
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      name,
      strategy: values.strategy,
      minValue: min.value,
      maxValue: max.value,
      priceGross: price.value,
      currency: SHIPPING_CURRENCY,
      freeOverSubtotal: freeOver.value,
      isActive: values.isActive,
      transitDaysMin: transitMin.value,
      transitDaysMax: transitMax.value,
    },
  };
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

export type ZoneFormError = "REQUIRED" | "TOO_LONG" | "NOT_A_WHOLE_NUMBER" | "COUNTRY_TAKEN";

export interface ZoneFormValues {
  readonly name: string;
  readonly countryCodes: readonly string[];
  readonly sortOrder: string;
}

export type ZoneBuildResult =
  | { readonly ok: true; readonly value: CreateShippingZoneInput & { sortOrder: number } }
  | {
      readonly ok: false;
      readonly errors: Partial<Readonly<Record<"name" | "countryCodes" | "sortOrder", ZoneFormError>>>;
    };

/** A country another live zone already holds — what the zone editor warns about. */
export interface CountryConflict {
  readonly countryCode: string;
  readonly zoneId: string;
  readonly zoneName: string;
}

/**
 * Which of `codes` another zone already claims. Computed from the list the
 * page already holds, so the editor can say "FR ya está en «Unión Europea»"
 * BEFORE the round trip — and, after a 409 COUNTRY_IN_OTHER_ZONE, name the zone
 * without reading the API's English message.
 */
export function findCountryConflicts(
  zones: readonly Pick<AdminShippingZoneDetail, "id" | "name" | "countryCodes">[],
  editingZoneId: string | null,
  codes: readonly string[],
): CountryConflict[] {
  const conflicts: CountryConflict[] = [];
  for (const code of codes) {
    const owner = zones.find((zone) => zone.id !== editingZoneId && zone.countryCodes.includes(code));
    if (owner !== undefined) {
      conflicts.push({ countryCode: code, zoneId: owner.id, zoneName: owner.name });
    }
  }
  return conflicts;
}

export function buildZonePayload(
  values: ZoneFormValues,
  conflicts: readonly CountryConflict[],
): ZoneBuildResult {
  const errors: Partial<Record<"name" | "countryCodes" | "sortOrder", ZoneFormError>> = {};
  const name = values.name.trim();
  if (name === "") errors.name = "REQUIRED";
  else if (name.length > NAME_MAX) errors.name = "TOO_LONG";

  if (conflicts.length > 0) errors.countryCodes = "COUNTRY_TAKEN";

  const sort = parseScaledDecimal(values.sortOrder.trim() === "" ? "0" : values.sortOrder, {
    exponent: 0,
    max: 10_000,
  });
  if (!sort.ok) errors.sortOrder = "NOT_A_WHOLE_NUMBER";

  if (Object.keys(errors).length > 0 || !sort.ok) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      name,
      // Only the served list — the picker offers nothing else, this is the
      // belt to its braces against a stale form.
      countryCodes: values.countryCodes.filter((code) => isDestinationCountry(code)),
      sortOrder: sort.value,
    },
  };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** A rate's display name, trimmed — "" for a row with no usable name. */
export function rateDisplayName(rate: Pick<AdminShippingRate, "name">): string {
  return rate.name.trim();
}

/** An ACTIVE rate whose free-shipping threshold is not what the storefront advertises. */
export interface ThresholdMismatch {
  readonly zoneName: string;
  readonly rateId: string;
  readonly rate: Pick<AdminShippingRate, "name">;
  /** Null when the rate has no free-shipping threshold at all. */
  readonly freeOverSubtotal: number | null;
}

/**
 * Once the threshold is editable, the marquee's "$ 300.000" is a PROMISE
 * the rates may stop keeping. Informational only — nothing is blocked; a store
 * running a different threshold on purpose just gets told the copy disagrees.
 */
export function freeShippingMismatches(
  zones: readonly AdminShippingZoneDetail[],
  advertisedMinor: number,
): ThresholdMismatch[] {
  return zones.flatMap((zone) =>
    zone.rates
      .filter((rate) => rate.isActive && rate.freeOverSubtotal !== advertisedMinor)
      .map((rate) => ({
        zoneName: zone.name,
        rateId: rate.id,
        rate,
        freeOverSubtotal: rate.freeOverSubtotal,
      })),
  );
}

/** The envelope reason, narrowed against the closed enum — never rendered raw. */
export function shippingFailureReason(reason: string | null): ShippingAdminFailureReason | null {
  if (reason === null) return null;
  const parsed = shippingAdminFailureReasonSchema.safeParse(reason);
  return parsed.success ? parsed.data : null;
}
