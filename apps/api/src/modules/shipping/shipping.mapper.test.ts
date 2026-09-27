import { describe, expect, it } from "vitest";
import { shippingQuoteResponseSchema } from "@akai/contracts";
import { toMinor } from "@akai/money";

import { toShippingQuote } from "./shipping.mapper";
import { type ShippingOption, UNMAPPED_FULFILMENT } from "./shipping-rate.selector";

const BASIS = {
  cartId: "cart-1",
  currency: "EUR",
  subtotalGross: toMinor(3000),
  weightGrams: 250,
};

const INPOST: ShippingOption = {
  rateId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: { es: "InPost punto de recogida", en: "InPost pickup point" },
  currency: "EUR",
  priceGross: toMinor(899),
  isFree: false,
  fulfilment: {
    deliveryType: "SERVICE_POINT",
    carrierCode: "inpost_es",
    sendcloudOptionCode: "inpost_es:service_point,national_c2c",
    transitDaysMin: 1,
    transitDaysMax: 2,
  },
};

describe("toShippingQuote", () => {
  it("describes the method: delivery type, carrier display name, transit days", () => {
    const quote = toShippingQuote("ES", BASIS, [INPOST], true);

    expect(shippingQuoteResponseSchema.parse(quote)).toEqual(quote);
    expect(quote.options[0]).toMatchObject({
      deliveryType: "SERVICE_POINT",
      carrierName: "InPost",
      transitDaysMin: 1,
      transitDaysMax: 2,
    });
  });

  it("NEVER publishes the Sendcloud option code or the carrier code", () => {
    const quote = toShippingQuote("ES", BASIS, [INPOST], true);
    const wire = JSON.stringify(quote);

    expect(wire).not.toContain("sendcloudOptionCode");
    expect(wire).not.toContain("national_c2c");
    expect(wire).not.toContain("inpost_es");
  });

  it("renders an unmapped rate as HOME with no carrier line", () => {
    const quote = toShippingQuote(
      "ES",
      BASIS,
      [{ ...INPOST, fulfilment: UNMAPPED_FULFILMENT }],
      true,
    );
    expect(quote.options[0]).toMatchObject({
      deliveryType: "HOME",
      carrierName: null,
      transitDaysMin: null,
      transitDaysMax: null,
    });
  });

  it("shows no carrier line for a carrier code it does not know", () => {
    const quote = toShippingQuote(
      "ES",
      BASIS,
      [{ ...INPOST, fulfilment: { ...INPOST.fulfilment, carrierCode: "acme_post" } }],
      true,
    );
    expect(quote.options[0]?.carrierName).toBeNull();
  });
});
