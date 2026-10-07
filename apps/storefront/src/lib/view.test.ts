import { describe, expect, it } from "vitest";

import {
  publicProductSchema,
  toMinor,
  type MediaAsset,
  type PublicProduct,
  type PublicProductVariant,
} from "@akai/contracts";

import { displayPrice, mediaAlt, variantLabel } from "./view";

const VARIANT: PublicProductVariant = {
  id: "11111111-1111-4111-8111-111111111111",
  productId: "22222222-2222-4222-8222-222222222222",
  sku: "AK-HOO-M",
  name: "M / Negro",
  options: { size: "M", color: "Negro" },
  price: {
    currency: "COP",
    net: toMinor(7_478_992),
    tax: toMinor(1_421_008),
    gross: toMinor(8_900_000),
    compareAtGross: null,
    taxRateBps: 1900,
  },
  weightGrams: 600,
  inventory: { variantId: "11111111-1111-4111-8111-111111111111", available: 3, allowBackorder: false },
  image: null,
  isActive: true,
  version: 0,
  priceTiers: [],
};

const normalise = (value: string | null): string | null => value?.replace(/[  ]/g, " ") ?? null;

describe("variantLabel", () => {
  it("uses the variant's name", () => {
    expect(variantLabel(VARIANT)).toBe("M / Negro");
  });

  it("falls back to the options, then the SKU", () => {
    expect(variantLabel({ ...VARIANT, name: null })).toBe("M · Negro");
    expect(variantLabel({ ...VARIANT, name: "  " })).toBe("M · Negro");
    expect(variantLabel({ ...VARIANT, name: null, options: {} })).toBe("AK-HOO-M");
  });
});

describe("mediaAlt", () => {
  const media: MediaAsset = {
    id: "33333333-3333-4333-8333-333333333333",
    url: "https://cdn.test/a.webp",
    alt: "Hoodie negro doblado",
    width: 800,
    height: 1000,
    sortOrder: 0,
  };

  it("uses the written alt text, else the product name", () => {
    expect(mediaAlt(media, "Hoodie Kumo")).toBe("Hoodie negro doblado");
    expect(mediaAlt({ ...media, alt: "" }, "Hoodie Kumo")).toBe("Hoodie Kumo");
  });
});

describe("displayPrice", () => {
  it("formats the cheapest active variant in Colombian pesos", () => {
    const cheaper: PublicProductVariant = {
      ...VARIANT,
      id: "44444444-4444-4444-8444-444444444444",
      price: { ...VARIANT.price, gross: toMinor(7_900_000) },
    };
    const product: PublicProduct = publicProductSchema.parse({
      id: "22222222-2222-4222-8222-222222222222",
      slug: "hoodie-kumo",
      status: "ACTIVE",
      taxClass: "STANDARD",
      name: "Hoodie Kumo",
      shortDescription: "",
      description: "",
      variants: [VARIANT, cheaper],
      media: [],
      categories: [],
      restrictedCountries: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    });

    expect(normalise(displayPrice(product))).toBe("$ 79.000");
  });
});
