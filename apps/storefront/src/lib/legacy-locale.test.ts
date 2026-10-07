import { describe, expect, it } from "vitest";

import { legacyLocaleRedirect } from "./legacy-locale";

describe("legacyLocaleRedirect", () => {
  it("sends an old English URL to the same page, keeping the query", () => {
    expect(legacyLocaleRedirect("/en/products", "")).toBe("/products");
    expect(legacyLocaleRedirect("/en/products/tee", "?ref=mail")).toBe("/products/tee?ref=mail");
    expect(legacyLocaleRedirect("/en/checkout/processing", "?order=AK-2026-000123")).toBe(
      "/checkout/processing?order=AK-2026-000123",
    );
  });

  it("sends the old English home to the root", () => {
    expect(legacyLocaleRedirect("/en", "")).toBe("/");
    expect(legacyLocaleRedirect("/en/", "")).toBe("/");
  });

  it("also strips the old explicit Spanish prefix", () => {
    expect(legacyLocaleRedirect("/es/cart", "")).toBe("/cart");
  });

  it("leaves every other path alone, including one that merely starts with the letters", () => {
    expect(legacyLocaleRedirect("/products", "")).toBeNull();
    expect(legacyLocaleRedirect("/enamel", "")).toBeNull();
    expect(legacyLocaleRedirect("/", "")).toBeNull();
  });
});
