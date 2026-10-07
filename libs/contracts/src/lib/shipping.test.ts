import { describe, expect, it } from "vitest";

import {
  freeShippingThresholdResponseSchema,
  shippingOptionSchema,
  shippingQuoteRequestSchema,
  shippingQuoteResponseSchema,
} from "./shipping";

/**
 * These tests are about what the shipping contract REFUSES.
 *
 * The whole security value of the quote endpoint is that a client cannot state
 * the inputs that determine the price. A test asserting the happy path would
 * pass just as well against a schema that accepted `subtotalGross` — so the
 * rejection cases are the ones worth writing.
 */
describe("shippingQuoteRequestSchema", () => {
  it("accepts a destination and defaults the postal code to null", () => {
    const parsed = shippingQuoteRequestSchema.parse({ countryCode: "CO" });

    expect(parsed).toEqual({ countryCode: "CO", postalCode: null });
  });

  it("rejects a client-supplied subtotal — the price input must be server-derived", () => {
    const result = shippingQuoteRequestSchema.safeParse({
      countryCode: "CO",
      subtotalGross: 50_000,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a client-supplied parcel weight", () => {
    const result = shippingQuoteRequestSchema.safeParse({
      countryCode: "CO",
      weightGrams: 1,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a cart id — ownership comes from the actor, never from the body", () => {
    const result = shippingQuoteRequestSchema.safeParse({
      countryCode: "CO",
      cartId: "6f1b9e2c-2a1e-4a4e-9a53-2f9a4a7c1b11",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a lowercase or three-letter country code", () => {
    expect(shippingQuoteRequestSchema.safeParse({ countryCode: "es" }).success).toBe(
      false,
    );
    expect(shippingQuoteRequestSchema.safeParse({ countryCode: "ESP" }).success).toBe(
      false,
    );
  });
});

describe("shippingOptionSchema", () => {
  const option = {
    rateId: "0a5b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
    name: "Estándar (2-3 días)",
    currency: "COP",
    priceGross: 1_500_000,
    isFree: false,
    transitDaysMin: 2,
    transitDaysMax: 3,
  };

  it("accepts a well-formed option", () => {
    expect(shippingOptionSchema.parse(option)).toEqual(option);
  });

  it("rejects an empty name and a per-language record — the name is one Spanish string", () => {
    expect(shippingOptionSchema.safeParse({ ...option, name: "" }).success).toBe(false);
    expect(
      shippingOptionSchema.safeParse({ ...option, name: { es: "Estándar" } }).success,
    ).toBe(false);
  });

  it("rejects a fractional price — money is integer minor units", () => {
    expect(shippingOptionSchema.safeParse({ ...option, priceGross: 4.95 }).success).toBe(
      false,
    );
  });

  it("rejects a negative price", () => {
    expect(shippingOptionSchema.safeParse({ ...option, priceGross: -1 }).success).toBe(
      false,
    );
  });

  it("keeps isFree distinct from a zero price", () => {
    const free = shippingOptionSchema.parse({ ...option, priceGross: 0, isFree: true });
    const zeroRated = shippingOptionSchema.parse({
      ...option,
      priceGross: 0,
      isFree: false,
    });

    expect(free.isFree).toBe(true);
    expect(zeroRated.isFree).toBe(false);
  });
});

describe("shippingQuoteResponseSchema", () => {
  it("models an unserved destination as a valid, empty quote", () => {
    const parsed = shippingQuoteResponseSchema.parse({
      countryCode: "US",
      currency: "COP",
      destinationServed: false,
      subtotalGross: 3980,
      weightGrams: 540,
      options: [],
    });

    expect(parsed.destinationServed).toBe(false);
    expect(parsed.options).toEqual([]);
  });

  it("distinguishes 'served but no bracket fits' from 'not served'", () => {
    const parsed = shippingQuoteResponseSchema.parse({
      countryCode: "CO",
      currency: "COP",
      destinationServed: true,
      subtotalGross: 3980,
      weightGrams: 99_000,
      options: [],
    });

    expect(parsed.destinationServed).toBe(true);
    expect(parsed.options).toHaveLength(0);
  });
});

describe("freeShippingThresholdResponseSchema", () => {
  it("accepts a threshold in minor units with its currency", () => {
    const body = { threshold: { amount: 30_000_000, currency: "COP" } };
    expect(freeShippingThresholdResponseSchema.parse(body)).toEqual(body);
  });

  it("accepts null — no single destination-independent threshold exists", () => {
    expect(freeShippingThresholdResponseSchema.parse({ threshold: null })).toEqual({
      threshold: null,
    });
  });

  it("rejects a float amount — money is integer minor units", () => {
    expect(
      freeShippingThresholdResponseSchema.safeParse({
        threshold: { amount: 250.5, currency: "COP" },
      }).success,
    ).toBe(false);
  });

  it("rejects an extra key", () => {
    expect(
      freeShippingThresholdResponseSchema.safeParse({ threshold: null, remaining: 10 }).success,
    ).toBe(false);
  });
});
