import { describe, expect, it } from "vitest";

import {
  DEFAULT_STOREFRONT_LOCALE,
  STOREFRONT_LOCALES,
  STOREFRONT_LOCALE_PREFIX,
  isStorefrontLocale,
  localePathname,
  storefrontUrl,
} from "./locale-routing";

describe("storefront locale routing constants", () => {
  it("serves exactly the locales the contract vocabulary declares", () => {
    expect([...STOREFRONT_LOCALES]).toEqual(["es", "en"]);
  });

  it("keeps the default locale inside the served set", () => {
    // Guards the one way these two constants can be edited into nonsense: a
    // default that is not actually served would make every unprefixed URL a 404.
    expect(STOREFRONT_LOCALES).toContain(DEFAULT_STOREFRONT_LOCALE);
  });

  it("is 'as-needed', which is what makes the default locale unprefixed", () => {
    expect(STOREFRONT_LOCALE_PREFIX).toBe("as-needed");
  });
});

describe("isStorefrontLocale", () => {
  it("accepts served locales", () => {
    expect(isStorefrontLocale("es")).toBe(true);
    expect(isStorefrontLocale("en")).toBe(true);
  });

  it("rejects anything else, including near-misses", () => {
    expect(isStorefrontLocale("ES")).toBe(false);
    expect(isStorefrontLocale("es-ES")).toBe(false);
    expect(isStorefrontLocale("fr")).toBe(false);
    expect(isStorefrontLocale("")).toBe(false);
  });
});

describe("localePathname", () => {
  it("leaves the DEFAULT locale unprefixed", () => {
    // The whole point of `as-needed`. `/es/...` would merely redirect, but a
    // redirect on the post-payment return URL is a hop we do not need to take.
    expect(localePathname("es", "/checkout/processing")).toBe(
      "/checkout/processing",
    );
  });

  it("prefixes every non-default locale", () => {
    expect(localePathname("en", "/checkout/processing")).toBe(
      "/en/checkout/processing",
    );
  });

  it("normalises a missing leading slash rather than emitting a relative path", () => {
    expect(localePathname("es", "checkout/processing")).toBe(
      "/checkout/processing",
    );
    expect(localePathname("en", "checkout/processing")).toBe(
      "/en/checkout/processing",
    );
  });

  it("maps the site root for both locales", () => {
    expect(localePathname("es", "/")).toBe("/");
    expect(localePathname("en", "/")).toBe("/en/");
  });
});

describe("storefrontUrl", () => {
  it("builds an absolute, locale-correct URL", () => {
    expect(
      storefrontUrl("https://shop.test", "en", "/checkout/processing", {
        order: "AK-2026-000123",
      }),
    ).toBe("https://shop.test/en/checkout/processing?order=AK-2026-000123");
  });

  it("omits the locale segment for the default locale", () => {
    expect(
      storefrontUrl("https://shop.test", "es", "/checkout/processing", {
        order: "AK-2026-000123",
      }),
    ).toBe("https://shop.test/checkout/processing?order=AK-2026-000123");
  });

  it("collapses a trailing slash on the configured origin", () => {
    expect(storefrontUrl("https://shop.test/", "es", "/checkout/processing")).toBe(
      "https://shop.test/checkout/processing",
    );
  });

  it("preserves a base path on the origin", () => {
    expect(storefrontUrl("https://shop.test/shop", "en", "/cart")).toBe(
      "https://shop.test/shop/en/cart",
    );
  });

  it("encodes query values instead of interpolating them raw", () => {
    // A template literal would let a value carrying `&` or `#` invent a second
    // parameter or truncate the URL.
    expect(
      storefrontUrl("https://shop.test", "es", "/checkout/processing", {
        order: "NX &#?=/1",
      }),
    ).toBe(
      "https://shop.test/checkout/processing?order=NX+%26%23%3F%3D%2F1",
    );
  });

  it("emits no query string at all when there is nothing to pass", () => {
    expect(storefrontUrl("https://shop.test", "es", "/cart")).toBe(
      "https://shop.test/cart",
    );
  });
});
