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

const ZONE_CO = "11111111-1111-4111-8111-111111111111";
const ZONE_OTHER = "22222222-2222-4222-8222-222222222222";

const STORED: AdminShippingRate = adminShippingRateSchema.parse({
  id: "33333333-3333-4333-8333-333333333333",
  zoneId: ZONE_CO,
  name: "Envío nacional",
  strategy: "PRICE",
  minValue: 5_000_000,
  maxValue: 30_000_000,
  priceGross: 1_500_000,
  currency: "COP",
  freeOverSubtotal: 30_000_000,
  isActive: true,
  transitDaysMin: 2,
  transitDaysMax: 5,
  createdAt: "2026-09-24T10:00:00.000Z",
  updatedAt: "2026-09-24T10:00:00.000Z",
});

function values(overrides: Partial<RateFormValues> = {}): RateFormValues {
  return {
    ...emptyRateValues(),
    name: "Envío nacional",
    priceGross: "15.000",
    ...overrides,
  };
}

describe("buildRatePayload", () => {
  it("converts whole pesos through the string parser and sends the name as is", () => {
    const built = buildRatePayload(
      values({ freeOverSubtotal: "300000", transitDaysMin: "2", transitDaysMax: "5" }),
    );

    expect(built).toEqual({
      ok: true,
      value: {
        name: "Envío nacional",
        strategy: "FLAT",
        minValue: null,
        maxValue: null,
        priceGross: 1_500_000,
        currency: "COP",
        freeOverSubtotal: 30_000_000,
        isActive: true,
        transitDaysMin: 2,
        transitDaysMax: 5,
      },
    });
    // What it builds is exactly what the API's own schema accepts.
    if (built.ok) expect(createShippingRateSchema.safeParse(built.value).success).toBe(true);
  });

  it("reads WEIGHT bounds as whole grams and PRICE bounds as whole pesos", () => {
    const weight = buildRatePayload(values({ strategy: "WEIGHT", minValue: "0", maxValue: "2000" }));
    const price = buildRatePayload(values({ strategy: "PRICE", minValue: "50.000", maxValue: "99999" }));

    expect(weight.ok && [weight.value.minValue, weight.value.maxValue]).toEqual([0, 2_000]);
    expect(price.ok && [price.value.minValue, price.value.maxValue]).toEqual([5_000_000, 9_999_900]);
  });

  it("refuses centavos on a peso price", () => {
    expect(buildRatePayload(values({ priceGross: "15000,50" }))).toEqual({
      ok: false,
      errors: { priceGross: "TOO_MANY_DECIMALS" },
    });
  });

  it("refuses a thousands separator in grams rather than reading one gram", () => {
    const built = buildRatePayload(values({ strategy: "WEIGHT", maxValue: "1.000" }));
    expect(built).toEqual({ ok: false, errors: { maxValue: "TOO_MANY_DECIMALS" } });
  });

  it("names each broken field with a closed code", () => {
    const built = buildRatePayload(
      values({
        name: " ",
        priceGross: "",
        freeOverSubtotal: "0",
        strategy: "WEIGHT",
        minValue: "500",
        maxValue: "100",
        transitDaysMin: "5",
        transitDaysMax: "2",
      }),
    );
    expect(built).toEqual({
      ok: false,
      errors: {
        name: "REQUIRED",
        priceGross: "EMPTY",
        freeOverSubtotal: "NOT_POSITIVE",
        maxValue: "BOUNDS_ORDER",
        transitDaysMax: "TRANSIT_ORDER",
      },
    });
  });

  it("carries no Sendcloud mapping", () => {
    const built = buildRatePayload(values());
    expect(built.ok && Object.keys(built.value)).not.toContain("carrierCode");
    expect(built.ok && Object.keys(built.value)).not.toContain("deliveryType");
  });

  it("round-trips a stored rate through the form unchanged", () => {
    const formValues = rateToValues(STORED);
    expect(formValues.priceGross).toBe("15000");
    const built = buildRatePayload(formValues);
    expect(built.ok && built.value).toMatchObject({
      name: STORED.name,
      strategy: "PRICE",
      minValue: 5_000_000,
      maxValue: 30_000_000,
      priceGross: 1_500_000,
      freeOverSubtotal: 30_000_000,
      transitDaysMin: 2,
      transitDaysMax: 5,
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
  const zones = [zone(ZONE_CO, "Colombia", ["CO"]), zone(ZONE_OTHER, "Otra", [])];

  it("finds a country another zone holds — but never the zone being edited", () => {
    expect(findCountryConflicts(zones, ZONE_OTHER, ["CO"])).toEqual([
      { countryCode: "CO", zoneId: ZONE_CO, zoneName: "Colombia" },
    ]);
    expect(findCountryConflicts(zones, ZONE_CO, ["CO"])).toEqual([]);
  });

  it("refuses a zone payload with a conflict, a blank name or a bad sort order", () => {
    const conflicts = findCountryConflicts(zones, null, ["CO"]);
    expect(buildZonePayload({ name: " ", countryCodes: ["CO"], sortOrder: "x" }, conflicts)).toEqual({
      ok: false,
      errors: { name: "REQUIRED", countryCodes: "COUNTRY_TAKEN", sortOrder: "NOT_A_WHOLE_NUMBER" },
    });
    expect(buildZonePayload({ name: "Colombia", countryCodes: ["CO"], sortOrder: "" }, [])).toEqual({
      ok: true,
      value: { name: "Colombia", countryCodes: ["CO"], sortOrder: 0 },
    });
  });

  it("drops a country the store does not ship to", () => {
    expect(buildZonePayload({ name: "España", countryCodes: ["ES"], sortOrder: "" }, [])).toEqual({
      ok: true,
      value: { name: "España", countryCodes: [], sortOrder: 0 },
    });
  });
});

describe("freeShippingMismatches", () => {
  it("flags only ACTIVE rates whose threshold differs from the advertised one", () => {
    const differs = { ...STORED, id: "44444444-4444-4444-8444-444444444444", freeOverSubtotal: null };
    const inactive = { ...differs, id: "55555555-5555-4555-8555-555555555555", isActive: false };
    const zones = [zone(ZONE_CO, "Colombia", ["CO"], [STORED, differs, inactive])];

    expect(freeShippingMismatches(zones, 30_000_000).map((row) => row.rateId)).toEqual([differs.id]);
    expect(freeShippingMismatches(zones, 40_000_000)).toHaveLength(2);
  });
});

describe("display helpers", () => {
  it("shows the rate name, trimmed", () => {
    expect(rateDisplayName({ name: " Punto " })).toBe("Punto");
    expect(rateDisplayName(STORED)).toBe("Envío nacional");
  });

  it("narrows only known reasons", () => {
    expect(shippingFailureReason("COUNTRY_IN_OTHER_ZONE")).toBe("COUNTRY_IN_OTHER_ZONE");
    expect(shippingFailureReason("SOMETHING_ELSE")).toBeNull();
    expect(shippingFailureReason(null)).toBeNull();
  });
});
