import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sendcloudOptionsResponseSchema } from "@akai/contracts";

import { SendcloudClient } from "../../fulfilment/sendcloud/sendcloud.client";
import { deliveryTypeFor, toSendcloudOptionDtos } from "./sendcloud-options.mapper";

/**
 * The picker mapping against the `POST /shipping-options` bodies captured from
 * the REAL account (spec §11a G1), narrowed by the real `SendcloudClient` — so
 * this proves the whole path from Sendcloud's JSON to our contract.
 */

const FIXTURES = path.resolve(__dirname, "../../fulfilment/__fixtures__");

async function optionsFrom(fixture: string, to: string) {
  const body = readFileSync(path.join(FIXTURES, fixture), "utf8");
  const client = new SendcloudClient(
    { publicKey: "pub", secretKey: "sec", baseUrl: "https://panel.sendcloud.sc/api/v3" },
    {
      fetch: () =>
        Promise.resolve(
          new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
        ),
    },
  );
  const options = await client.listShippingOptions({
    fromCountryCode: "ES",
    toCountryCode: to,
    weightGrams: 500,
  });
  return toSendcloudOptionDtos(options);
}

describe("toSendcloudOptionDtos — real fixtures", () => {
  it("ES → ES: InPost national and UPS Access Point, both pickup, letter dropped", async () => {
    const options = await optionsFrom("shipping-options.es-es.json", "ES");

    expect(options.map((option) => option.code)).toEqual([
      "inpost_es:service_point,national_c2c",
      "ups:standard/service_point",
    ]);
    expect(options[0]).toEqual({
      code: "inpost_es:service_point,national_c2c",
      name: "InPost Punto de Servicio Nacional C2C",
      carrierCode: "inpost_es",
      carrierName: "InPost Spain",
      lastMile: "service_point",
      deliveryType: "SERVICE_POINT",
      requiresServicePoint: true,
      requiredFields: ["to_email"],
      // Sendcloud quoted nothing for InPost national on this account.
      merchantCost: null,
      currency: null,
    });
    // The whole response parses against the strict wire contract.
    expect(sendcloudOptionsResponseSchema.safeParse({ country: "ES", options }).success).toBe(true);
  });

  it("ES → FR: the INTERNATIONAL InPost code, and the merchant cost in minor units", async () => {
    const options = await optionsFrom("shipping-options.es-fr.json", "FR");

    const inpost = options.find((option) => option.carrierCode === "inpost_es");
    expect(inpost?.code).toBe("inpost_es:service_point,international_c2c");
    expect(inpost?.merchantCost).toEqual(expect.any(Number));
    expect(Number.isInteger(inpost?.merchantCost)).toBe(true);

    const ups = options.find((option) => option.carrierCode === "ups");
    expect(ups?.requiredFields).toEqual(["to_telephone", "to_email"]);
    expect(ups?.currency).toBe("EUR");
  });

  it("ES → IE: UPS only — InPost cannot ship there", async () => {
    const options = await optionsFrom("shipping-options.es-ie.json", "IE");

    expect(options.map((option) => option.carrierCode)).toEqual(["ups"]);
    expect(options[0]?.deliveryType).toBe("SERVICE_POINT");
  });
});

describe("deliveryTypeFor", () => {
  it("is SERVICE_POINT for a point/locker last mile or a required point, HOME otherwise", () => {
    expect(deliveryTypeFor({ lastMile: "locker", requiresServicePoint: false })).toBe("SERVICE_POINT");
    expect(deliveryTypeFor({ lastMile: "home_delivery", requiresServicePoint: true })).toBe(
      "SERVICE_POINT",
    );
    expect(deliveryTypeFor({ lastMile: "home_delivery", requiresServicePoint: false })).toBe("HOME");
    expect(deliveryTypeFor({ lastMile: null, requiresServicePoint: false })).toBe("HOME");
  });

  it("drops an unreadable quote rather than guessing a cost", () => {
    const [option] = toSendcloudOptionDtos([
      {
        code: "ups:standard",
        name: "UPS Standard",
        carrierCode: "ups",
        carrierName: "UPS",
        lastMile: "home_delivery",
        requiresServicePoint: false,
        requiredFields: [],
        quoteTotal: { value: "6.005", currency: "EUR" },
      },
    ]);
    expect(option).toMatchObject({ deliveryType: "HOME", merchantCost: null, currency: null });
  });
});
