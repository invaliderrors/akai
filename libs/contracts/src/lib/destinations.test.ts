import { describe, expect, it } from "vitest";

import { countryCodeSchema } from "./common";
import {
  ADVERTISED_FREE_SHIPPING_THRESHOLD_MINOR,
  DESTINATION_COUNTRY_CODES,
  STORE_COUNTRY_CODE,
  isDestinationCountry,
} from "./destinations";

describe("DESTINATION_COUNTRY_CODES", () => {
  it("holds each country once, as a valid ISO code", () => {
    expect(new Set(DESTINATION_COUNTRY_CODES).size).toBe(DESTINATION_COUNTRY_CODES.length);
    for (const code of DESTINATION_COUNTRY_CODES) {
      expect(countryCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it("is Colombia and nothing else", () => {
    expect(DESTINATION_COUNTRY_CODES).toEqual(["CO"]);
    expect(STORE_COUNTRY_CODE).toBe("CO");
    expect(isDestinationCountry("CO")).toBe(true);
    expect(isDestinationCountry("ES")).toBe(false);
    expect(isDestinationCountry("US")).toBe(false);
  });

  it("advertises free shipping at $300.000 COP, in minor units (centavos)", () => {
    expect(ADVERTISED_FREE_SHIPPING_THRESHOLD_MINOR).toBe(30_000_000);
  });
});
