import { describe, expect, it } from "vitest";

import { storefrontUrl } from "./storefront-url";

describe("storefrontUrl", () => {
  it("builds an absolute URL at the bare path — the storefront has no locale prefix", () => {
    expect(
      storefrontUrl("https://shop.test", "/checkout/processing", { order: "AK-2026-000123" }),
    ).toBe("https://shop.test/checkout/processing?order=AK-2026-000123");
  });

  it("adds a missing leading slash", () => {
    expect(storefrontUrl("https://shop.test", "cart")).toBe("https://shop.test/cart");
  });

  it("collapses a trailing slash on the configured origin", () => {
    expect(storefrontUrl("https://shop.test/", "/checkout/processing")).toBe(
      "https://shop.test/checkout/processing",
    );
  });

  it("preserves a base path on the origin", () => {
    expect(storefrontUrl("https://shop.test/shop", "/cart")).toBe("https://shop.test/shop/cart");
  });

  it("encodes query values instead of interpolating them raw", () => {
    // A template literal would let a value carrying `&` or `#` invent a second
    // parameter or truncate the URL.
    expect(
      storefrontUrl("https://shop.test", "/checkout/processing", { order: "NX &#?=/1" }),
    ).toBe("https://shop.test/checkout/processing?order=NX+%26%23%3F%3D%2F1");
  });

  it("emits no query string at all when there is nothing to pass", () => {
    expect(storefrontUrl("https://shop.test", "/cart")).toBe("https://shop.test/cart");
  });
});
