import { describe, expect, it } from "vitest";

import {
  TEST_MODE_SHIPPING_OPTION_CODE,
  effectiveShippingOptionCode,
  servicePointIdForMode,
} from "./test-mode";

describe("test mode", () => {
  it("buys an unstamped sendcloud:letter instead of the mapped carrier in TEST", () => {
    expect(TEST_MODE_SHIPPING_OPTION_CODE).toBe("sendcloud:letter");
    expect(effectiveShippingOptionCode("test", "inpost_es:service_point,national_c2c")).toBe(
      "sendcloud:letter",
    );
  });

  it("buys the mapped carrier only in LIVE", () => {
    expect(effectiveShippingOptionCode("live", "inpost_es:service_point,national_c2c")).toBe(
      "inpost_es:service_point,national_c2c",
    );
  });

  it("sends no pickup point with a test letter, the chosen one in live", () => {
    expect(servicePointIdForMode("test", "12188365")).toBeNull();
    expect(servicePointIdForMode("live", "12188365")).toBe("12188365");
    expect(servicePointIdForMode("live", null)).toBeNull();
  });
});
