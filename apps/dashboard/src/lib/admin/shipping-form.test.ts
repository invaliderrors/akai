import { describe, expect, it } from "vitest";
import {
  adminShippingRateSchema,
  createShippingRateSchema,
  type AdminShippingRate,
  type AdminShippingZoneDetail,
} from "@akai/contracts";

import {
  buildRatePayload,
  buildZonePayload,
  emptyRateValues,
  findCountryConflicts,
  freeShippingMismatches,
  rateDisplayName,
  rateToValues,
  shippingFailureReason,
  type RateFormValues,
} from "./shipping-form";

const ZONE_ES = "11111111-1111-4111-8111-111111111111";
const ZONE_EU = "22222222-2222-4222-8222-222222222222";

const STORED: AdminShippingRate = adminShippingRateSchema.parse({
  id: "33333333-3333-4333-8333-333333333333",
  zoneId: ZONE_ES,
  name: { es: "Envío en punto de recogida INPOST", en: "InPost pickup point" },
  strategy: "PRICE",
  minValue: 5_000,
  maxValue: 25_000,
  priceGross: 899,
  currency: "EUR",
  freeOverSubtotal: 25_000,
  isActive: true,
  deliveryType: "SERVICE_POINT",
  carrierCode: "inpost_es",
  sendcloudOptionCode: "inpost_es:service_point,national_c2c",
  transitDaysMin: 1,
  transitDaysMax: 2,
  createdAt: "2026-09-24T10:00:00.000Z",
  updatedAt: "2026-09-24T10:00:00.000Z",
});

function values(overrides: Partial<RateFormValues> = {}): RateFormValues {
  return {
    ...emptyRateValues(),
    nameEs: "UPS Access Point",
    priceGross: "14,10",
    carrierCode: "ups",
    sendcloudOptionCode: "ups:standard/service_point",
    ...overrides,
  };
}

describe("buildRatePayload", () => {
  it("converts euros through the string parser and omits a blank English name", () => {
    const built = buildRatePayload(values({ freeOverSubtotal: "250", transitDaysMin: "2", transitDaysMax: "4" }));

    expect(built).toEqual({
      ok: true,
      value: {
        name: { es: "UPS Access Point" },
        strategy: "FLAT",
        minValue: null,
        maxValue: null,
        priceGross: 1_410,
        currency: "EUR",
        freeOverSubtotal: 25_000,
        isActive: true,
        deliveryType: "SERVICE_POINT",
        carrierCode: "ups",
        sendcloudOptionCode: "ups:standard/service_point",
        transitDaysMin: 2,
        transitDaysMax: 4,
      },
    });
    // What it builds is exactly what the API's own schema accepts.
    if (built.ok) expect(createShippingRateSchema.safeParse(built.value).success).toBe(true);
  });

  it("reads WEIGHT bounds as whole grams and PRICE bounds as euros", () => {
    const weight = buildRatePayload(values({ strategy: "WEIGHT", minValue: "0", maxValue: "2000" }));
    const price = buildRatePayload(values({ strategy: "PRICE", minValue: "50", maxValue: "99,99" }));

    expect(weight.ok && [weight.value.minValue, weight.value.maxValue]).toEqual([0, 2_000]);
    expect(price.ok && [price.value.minValue, price.value.maxValue]).toEqual([5_000, 9_999]);
  });

  it("refuses a Spanish thousands separator in grams rather than reading one gram", () => {
    const built = buildRatePayload(values({ strategy: "WEIGHT", maxValue: "1.000" }));
    expect(built).toEqual({ ok: false, errors: { maxValue: "TOO_MANY_DECIMALS" } });
  });

  it("names each broken field with a closed code", () => {
    const built = buildRatePayload(
      values({
        nameEs: " ",
        priceGross: "",
        freeOverSubtotal: "0",
        strategy: "WEIGHT",
        minValue: "500",
        maxValue: "100",
        transitDaysMin: "5",
        transitDaysMax: "2",
        carrierCode: "",
      }),
    );
    expect(built).toEqual({
      ok: false,
      errors: {
        nameEs: "REQUIRED",
        priceGross: "EMPTY",
        freeOverSubtotal: "NOT_POSITIVE",
        maxValue: "BOUNDS_ORDER",
        transitDaysMax: "TRANSIT_ORDER",
        carrierCode: "CARRIER_REQUIRED",
      },
    });
  });

  it("lets a HOME rate go without a carrier, and refuses a malformed one", () => {
    expect(buildRatePayload(values({ deliveryType: "HOME", carrierCode: "" })).ok).toBe(true);
    expect(buildRatePayload(values({ carrierCode: "InPost ES" }))).toEqual({
      ok: false,
      errors: { carrierCode: "INVALID_CARRIER" },
    });
  });

  it("round-trips a stored rate through the form unchanged", () => {
    const built = buildRatePayload(rateToValues(STORED));
    expect(built.ok && built.value).toMatchObject({
      name: STORED.name,
      strategy: "PRICE",
      minValue: 5_000,
      maxValue: 25_000,
      priceGross: 899,
      freeOverSubtotal: 25_000,
      carrierCode: "inpost_es",
      transitDaysMin: 1,
      transitDaysMax: 2,
    });
  });
});

function zone(id: string, name: string, countryCodes: string[], rates: AdminShippingRate[] = []): AdminShippingZoneDetail {
  return {
    id,
    name,
    countryCodes,
    sortOrder: 0,
    createdAt: "2026-09-24T10:00:00.000Z",
    updatedAt: "2026-09-24T10:00:00.000Z",
    rates,
  };
}

describe("zones", () => {
  const zones = [zone(ZONE_ES, "España", ["ES"]), zone(ZONE_EU, "Unión Europea", ["PT", "FR"])];

  it("finds a country another zone holds — but never the zone being edited", () => {
    expect(findCountryConflicts(zones, null, ["IE", "FR"])).toEqual([
      { countryCode: "FR", zoneId: ZONE_EU, zoneName: "Unión Europea" },
    ]);
    expect(findCountryConflicts(zones, ZONE_EU, ["PT", "FR"])).toEqual([]);
  });

  it("refuses a zone payload with a conflict, a blank name or a bad sort order", () => {
    const conflicts = findCountryConflicts(zones, null, ["FR"]);
    expect(buildZonePayload({ name: " ", countryCodes: ["FR"], sortOrder: "x" }, conflicts)).toEqual({
      ok: false,
      errors: { name: "REQUIRED", countryCodes: "COUNTRY_TAKEN", sortOrder: "NOT_A_WHOLE_NUMBER" },
    });
    expect(buildZonePayload({ name: "Irlanda", countryCodes: ["IE"], sortOrder: "" }, [])).toEqual({
      ok: true,
      value: { name: "Irlanda", countryCodes: ["IE"], sortOrder: 0 },
    });
  });
});

describe("freeShippingMismatches", () => {
  it("flags only ACTIVE rates whose threshold differs from the advertised one", () => {
    const differs = { ...STORED, id: "44444444-4444-4444-8444-444444444444", freeOverSubtotal: null };
    const inactive = { ...differs, id: "55555555-5555-4555-8555-555555555555", isActive: false };
    const zones = [zone(ZONE_ES, "España", ["ES"], [STORED, differs, inactive])];

    expect(freeShippingMismatches(zones, 25_000).map((row) => row.rateId)).toEqual([differs.id]);
    expect(freeShippingMismatches(zones, 30_000)).toHaveLength(2);
  });
});

describe("display helpers", () => {
  it("falls back to the Spanish name", () => {
    expect(rateDisplayName({ name: { es: "Punto" } }, "en")).toBe("Punto");
    expect(rateDisplayName(STORED, "en")).toBe("InPost pickup point");
  });

  it("narrows only known reasons", () => {
    expect(shippingFailureReason("COUNTRY_IN_OTHER_ZONE")).toBe("COUNTRY_IN_OTHER_ZONE");
    expect(shippingFailureReason("SOMETHING_ELSE")).toBeNull();
    expect(shippingFailureReason(null)).toBeNull();
  });
});
