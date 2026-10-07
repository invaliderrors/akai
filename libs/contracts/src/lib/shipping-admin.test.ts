import { describe, expect, it } from "vitest";

import {
  createShippingRateSchema,
  createShippingZoneSchema,
  updateShippingRateSchema,
} from "./shipping-admin";

const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

describe("shipping admin", () => {
  const rate = {
    name: "Envío nacional",
    strategy: "FLAT",
    priceGross: 1_500_000,
  } as const;

  it("defaults a new rate to an active rate in Colombian pesos", () => {
    expect(createShippingRateSchema.parse(rate)).toEqual({
      ...rate,
      minValue: null,
      maxValue: null,
      currency: "COP",
      isActive: true,
      freeOverSubtotal: null,
      transitDaysMin: null,
      transitDaysMax: null,
    });
  });

  it("has no Sendcloud mapping any more", () => {
    for (const extra of [
      { deliveryType: "HOME" },
      { carrierCode: "inpost_es" },
      { sendcloudOptionCode: "inpost_es:service_point" },
    ]) {
      expect(createShippingRateSchema.safeParse({ ...rate, ...extra }).success).toBe(false);
    }
  });

  it("refuses inverted bounds and transit days, and a float price", () => {
    expect(
      createShippingRateSchema.safeParse({ ...rate, strategy: "WEIGHT", minValue: 10, maxValue: 5 })
        .success,
    ).toBe(false);
    expect(
      createShippingRateSchema.safeParse({ ...rate, transitDaysMin: 5, transitDaysMax: 2 }).success,
    ).toBe(false);
    expect(createShippingRateSchema.safeParse({ ...rate, priceGross: 15_000.5 }).success).toBe(false);
  });

  it("trims the name and refuses a blank one or a per-language record", () => {
    expect(createShippingRateSchema.parse({ ...rate, name: "  Envío  " }).name).toBe("Envío");
    // A blank name would satisfy "has a name" and render as an empty method line.
    expect(createShippingRateSchema.safeParse({ ...rate, name: "  " }).success).toBe(false);
    expect(createShippingRateSchema.safeParse({ ...rate, name: { es: "Envío" } }).success).toBe(
      false,
    );
  });

  it("refuses bounds on a FLAT rate, a zero free-over threshold and a non-peso price", () => {
    expect(createShippingRateSchema.safeParse({ ...rate, minValue: 0, maxValue: 500 }).success).toBe(
      false,
    );
    expect(
      createShippingRateSchema.safeParse({ ...rate, strategy: "WEIGHT", minValue: 0, maxValue: 500 })
        .success,
    ).toBe(true);
    expect(createShippingRateSchema.safeParse({ ...rate, freeOverSubtotal: 0 }).success).toBe(false);
    expect(
      createShippingRateSchema.safeParse({ ...rate, freeOverSubtotal: 30_000_000 }).success,
    ).toBe(true);
    expect(createShippingRateSchema.safeParse({ ...rate, currency: "EUR" }).success).toBe(false);
  });

  it("judges only the ordering of a bounds-only PATCH (the service checks the merged row)", () => {
    expect(updateShippingRateSchema.safeParse({ maxValue: 500 }).success).toBe(true);
    expect(updateShippingRateSchema.safeParse({ minValue: 9, maxValue: 5 }).success).toBe(false);
  });

  it("accepts a partial rate update and still rejects unknown keys", () => {
    expect(updateShippingRateSchema.safeParse({ isActive: false }).success).toBe(true);
    expect(updateShippingRateSchema.safeParse({ zoneId: UUID }).success).toBe(false);
  });

  it("lets a zone claim only Colombia, once", () => {
    expect(createShippingZoneSchema.parse({ name: "Colombia", countryCodes: ["CO"] })).toEqual({
      name: "Colombia",
      countryCodes: ["CO"],
      sortOrder: 0,
    });
    expect(
      createShippingZoneSchema.safeParse({ name: "Colombia", countryCodes: ["CO", "CO"] }).success,
    ).toBe(false);
    expect(createShippingZoneSchema.safeParse({ name: "Colombia", countryCodes: ["co"] }).success).toBe(
      false,
    );
    // A valid ISO code the store does not ship to.
    expect(createShippingZoneSchema.safeParse({ name: "España", countryCodes: ["ES"] }).success).toBe(
      false,
    );
  });
});
