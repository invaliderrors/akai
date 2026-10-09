import { describe, expect, it } from "vitest";

import {
  publicProductSchema,
  toMinor,
  type MediaAsset,
  type PublicProduct,
  type PublicProductVariant,
} from "@akai/contracts";

import {
  categoryLabel,
  cheapestPrice,
  colorSwatches,
  displayPrice,
  mediaAlt,
  productBadge,
  sizeOptions,
  variantLabel,
  type BadgeRules,
} from "./view";

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

let seq = 0;
function variant(options: Record<string, string>, available: number, extra: Partial<PublicProductVariant> = {}) {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  return { ...VARIANT, id, sku: `SKU-${String(seq)}`, name: null, options, inventory: { variantId: id, available, allowBackorder: false }, ...extra };
}

const CREATED = "2026-09-01T00:00:00.000Z";

function product(variants: PublicProductVariant[], categories: PublicProduct["categories"] = [], createdAt = CREATED) {
  return publicProductSchema.parse({
    id: "22222222-2222-4222-8222-222222222222",
    slug: "camiseta",
    status: "ACTIVE",
    taxClass: "STANDARD",
    name: "Camiseta",
    shortDescription: "",
    description: "",
    variants,
    media: [],
    categories,
    restrictedCountries: [],
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  });
}

const EXCLUSIVE = { id: "55555555-5555-4555-8555-555555555555", slug: "exclusive", name: "Exclusivo", sortOrder: 0 };
const DAY = 24 * 60 * 60 * 1000;
const RULES: BadgeRules = {
  lowStockThreshold: 5,
  limitedCategorySlug: "exclusive",
  newForMs: 14 * DAY,
  now: Date.parse(CREATED) + 30 * DAY,
};

describe("sizeOptions", () => {
  it("lists each size once, in variant order, picking the first sellable variant", () => {
    const blackM = variant({ size: "M", color: "Negro" }, 0);
    const whiteM = variant({ size: "M", color: "Blanco" }, 4);
    const blackL = variant({ size: "L", color: "Negro" }, 2);
    expect(sizeOptions(product([blackM, whiteM, blackL]))).toEqual([
      { label: "M", variantId: whiteM.id },
      { label: "L", variantId: blackL.id },
    ]);
  });

  it("keeps a sold-out size with no variant to add", () => {
    expect(sizeOptions(product([variant({ size: "S" }, 0)]))).toEqual([{ label: "S", variantId: null }]);
  });

  it("skips inactive variants", () => {
    expect(sizeOptions(product([variant({ size: "XL" }, 9, { isActive: false })]))).toEqual([]);
  });
});

describe("colorSwatches", () => {
  it("maps Spanish colour words to swatches, once each, ignoring case and accents", () => {
    const p = product([
      variant({ size: "M", color: "Negro" }, 1),
      variant({ size: "L", color: "negro" }, 1),
      variant({ size: "M", color: "Café" }, 1),
    ]);
    expect(colorSwatches(p)).toEqual(["var(--color-ink)", "sienna"]);
  });

  it("leaves out colours it has no swatch for", () => {
    expect(colorSwatches(product([variant({ color: "red;background:url(x)" }, 1), variant({ color: "Fucsia" }, 1)]))).toEqual([]);
  });
});

describe("productBadge", () => {
  it("is SOLD OUT when nothing is sellable", () => {
    expect(productBadge(product([variant({ size: "M" }, 0)]), RULES)).toBe("soldOut");
  });

  it("is LOW at or under the threshold, counting every sellable variant", () => {
    expect(productBadge(product([variant({ size: "M" }, 3), variant({ size: "L" }, 2)]), RULES)).toBe("low");
    expect(productBadge(product([variant({ size: "M" }, 6)]), RULES)).toBeNull();
  });

  it("is never LOW when backorder is allowed", () => {
    const base = variant({ size: "M" }, 1);
    const backorder = { ...base, inventory: { ...base.inventory, allowBackorder: true } };
    expect(productBadge(product([backorder]), RULES)).toBeNull();
  });

  it("is LIMITED in the exclusive category", () => {
    expect(productBadge(product([variant({ size: "M" }, 50)], [EXCLUSIVE]), RULES)).toBe("limited");
  });

  it("is NEW within the window after creation", () => {
    const recent = new Date(RULES.now - 3 * DAY).toISOString();
    expect(productBadge(product([variant({ size: "M" }, 50)], [], recent), RULES)).toBe("new");
  });
});

describe("cheapestPrice", () => {
  it("returns the cheapest active variant's price", () => {
    const cheap = variant({ size: "M" }, 1, { price: { ...VARIANT.price, gross: toMinor(5_900_000) } });
    expect(cheapestPrice(product([variant({ size: "L" }, 1), cheap]))?.gross).toBe(5_900_000);
  });
});

describe("categoryLabel", () => {
  it("uses the first category by sort order", () => {
    const p = product(
      [variant({ size: "M" }, 1)],
      [
        { id: "33333333-3333-4333-8333-333333333333", slug: "b", name: "Sudaderas", sortOrder: 2 },
        { id: "44444444-4444-4444-8444-444444444444", slug: "a", name: "Camisetas", sortOrder: 1 },
      ],
    );
    expect(categoryLabel(p)).toBe("Camisetas");
  });
});
