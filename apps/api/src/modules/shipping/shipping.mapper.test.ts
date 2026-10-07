import { describe, expect, it } from "vitest";
import { shippingQuoteResponseSchema } from "@akai/contracts";
import { toMinor } from "@akai/money";

import { toShippingQuote } from "./shipping.mapper";
import { type ShippingOption } from "./shipping-rate.selector";

const BASIS = {
  cartId: "cart-1",
  currency: "COP",
  subtotalGross: toMinor(8_900_000),
  weightGrams: 280,
};

const NATIONAL: ShippingOption = {
  rateId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: { es: "Envío nacional", en: "National shipping" },
  currency: "COP",
  priceGross: toMinor(1_500_000),
  isFree: false,
  transitDaysMin: 2,
  transitDaysMax: 5,
};

describe("toShippingQuote", () => {
  it("describes the method: per-locale name, price and transit days", () => {
    const quote = toShippingQuote("CO", BASIS, [NATIONAL], true);

    expect(shippingQuoteResponseSchema.parse(quote)).toEqual(quote);
    expect(quote.options[0]).toEqual({
      rateId: NATIONAL.rateId,
      name: { es: "Envío nacional", en: "National shipping" },
      currency: "COP",
      priceGross: 1_500_000,
      isFree: false,
      transitDaysMin: 2,
      transitDaysMax: 5,
    });
  });

  it("echoes the inputs the server used", () => {
    const quote = toShippingQuote("CO", BASIS, [NATIONAL], true);
    expect(quote).toMatchObject({
      countryCode: "CO",
      currency: "COP",
      subtotalGross: 8_900_000,
      weightGrams: 280,
      destinationServed: true,
    });
  });

  it("renders a rate with no transit days as null, not as zero", () => {
    const quote = toShippingQuote(
      "CO",
      BASIS,
      [{ ...NATIONAL, transitDaysMin: null, transitDaysMax: null }],
      true,
    );
    expect(quote.options[0]).toMatchObject({ transitDaysMin: null, transitDaysMax: null });
  });

  it("carries no Sendcloud-era fields", () => {
    const wire = JSON.stringify(toShippingQuote("CO", BASIS, [NATIONAL], true));
    expect(wire).not.toContain("deliveryType");
    expect(wire).not.toContain("carrierName");
  });
});
