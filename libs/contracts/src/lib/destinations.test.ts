import { describe, expect, it } from "vitest";

import { countryCodeSchema } from "./common";
import {
  ADVERTISED_FREE_SHIPPING_THRESHOLD_MINOR,
  DESTINATION_COUNTRY_CODES,
  isDestinationCountry,
} from "./destinations";

describe("DESTINATION_COUNTRY_CODES", () => {
  it("holds each country once, as a valid ISO code", () => {
    expect(new Set(DESTINATION_COUNTRY_CODES).size).toBe(DESTINATION_COUNTRY_CODES.length);
    for (const code of DESTINATION_COUNTRY_CODES) {
      expect(countryCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  it("starts with the served zones' countries and excludes the rest of the world", () => {
    expect(DESTINATION_COUNTRY_CODES.slice(0, 8)).toEqual(["ES", "PT", "FR", "DE", "IT", "NL", "BE", "IE"]);
    expect(isDestinationCountry("ES")).toBe(true);
    expect(isDestinationCountry("US")).toBe(false);
  });

  it("advertises free shipping at €250.00, in minor units", () => {
    expect(ADVERTISED_FREE_SHIPPING_THRESHOLD_MINOR).toBe(25_000);
  });
});
