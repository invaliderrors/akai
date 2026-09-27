import { describe, expect, it } from "vitest";

import { alternatePath, href } from "./routing";

describe("href", () => {
  it("leaves the default locale unprefixed and prefixes English", () => {
    expect(href("es", "/products")).toBe("/products");
    expect(href("en", "/products")).toBe("/en/products");
  });
});

describe("alternatePath", () => {
  it("maps a Spanish page to its English twin and back", () => {
    expect(alternatePath("/products/tee", "es", "en")).toBe("/en/products/tee");
    expect(alternatePath("/en/products/tee", "en", "es")).toBe("/products/tee");
  });

  it("maps the English home to the Spanish root", () => {
    expect(alternatePath("/en", "en", "es")).toBe("/");
  });

  it("does not strip a segment that merely starts with the locale", () => {
    expect(alternatePath("/enamel", "es", "en")).toBe("/en/enamel");
  });
});
