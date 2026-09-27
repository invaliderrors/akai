import { describe, expect, it } from "vitest";
import { toMinor } from "./money";

import {
  categoryListQuerySchema,
  categoryListResponseSchema,
  computeStackDiscountTiers,
  createProductSchema,
  productListQuerySchema,
  productSchema,
  productSortSchema,
  publicInventorySchema,
  publicProductSchema,
  resolveUnitPrice,
  STACK_DISCOUNT_BEST_PRICE_QUANTITY,
} from "./catalog";

const VARIANT = {
  id: "11111111-1111-4111-8111-111111111111",
  productId: "22222222-2222-4222-8222-222222222222",
  sku: "AK-CRE-300",
  name: { es: "300 g", en: "300 g" },
  options: { size: "300 g" },
  price: {
    currency: "EUR",
    net: 1645,
    tax: 345,
    gross: 1990,
    compareAtGross: null,
    taxRateBps: 2100,
  },
  weightGrams: 360,
  inventory: {
    variantId: "11111111-1111-4111-8111-111111111111",
    available: 210,
    allowBackorder: false,
  },
  image: null,
  isActive: true,
  version: 0,
};

const PRODUCT = {
  id: "22222222-2222-4222-8222-222222222222",
  slug: "oversized-tee",
  status: "ACTIVE",
  taxClass: "STANDARD",
  translations: [
    { locale: "es", name: "Camiseta", shortDescription: "", description: "" },
  ],
  variants: [VARIANT],
  media: [],
  categories: [],
  restrictedCountries: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

describe("publicInventorySchema", () => {
  it("accepts the customer-safe projection", () => {
    const parsed = publicInventorySchema.parse(VARIANT.inventory);

    expect(parsed).toEqual(VARIANT.inventory);
  });

  it.each(["onHand", "reserved", "lowStockThreshold"])(
    "refuses to serialise the internal stock figure %s",
    (field) => {
      const result = publicInventorySchema.safeParse({
        ...VARIANT.inventory,
        [field]: 500,
      });

      expect(result.success).toBe(false);
    },
  );
});

describe("publicProductSchema", () => {
  it("accepts a product whose variants carry only public stock", () => {
    expect(publicProductSchema.parse(PRODUCT).variants).toHaveLength(1);
  });

  it("rejects a product whose variant leaks onHand through the nested inventory", () => {
    const leaky = {
      ...PRODUCT,
      variants: [
        {
          ...VARIANT,
          inventory: { ...VARIANT.inventory, onHand: 400, reserved: 190 },
        },
      ],
    };

    expect(publicProductSchema.safeParse(leaky).success).toBe(false);
  });

  it("still requires at least one variant — the sellable unit", () => {
    expect(publicProductSchema.safeParse({ ...PRODUCT, variants: [] }).success).toBe(
      false,
    );
  });
});

describe("productSortSchema", () => {
  it("offers best_selling so a 'Best sellers' section has a backing query", () => {
    expect(productSortSchema.parse("best_selling")).toBe("best_selling");
  });

  it("remains a closed set — an arbitrary sort cannot reach the SQL builder", () => {
    expect(productSortSchema.safeParse("id; DROP TABLE product").success).toBe(false);
    expect(productSortSchema.safeParse("popularity").success).toBe(false);
  });

  it("defaults the list query to newest", () => {
    expect(productListQuerySchema.parse({}).sort).toBe("newest");
  });
});

describe("categoryListQuerySchema", () => {
  it("defaults to the Spanish locale", () => {
    expect(categoryListQuerySchema.parse({}).locale).toEqual("es");
  });

  it("is strict — no privileged filter can be smuggled in", () => {
    expect(
      categoryListQuerySchema.safeParse({ locale: "en", includeDeleted: true }).success,
    ).toBe(false);
  });
});

describe("categoryListResponseSchema", () => {
  it("carries a shopper-visible product count per category", () => {
    const parsed = categoryListResponseSchema.parse({
      items: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          slug: "recovery",
          name: { es: "Recuperación", en: "Recovery" },
          sortOrder: 0,
          productCount: 2,
        },
      ],
    });

    expect(parsed.items[0]?.productCount).toBe(2);
  });

  it("rejects a negative count", () => {
    const result = categoryListResponseSchema.safeParse({
      items: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          slug: "recovery",
          name: { es: "Recuperación" },
          sortOrder: 0,
          productCount: -1,
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});

describe("publicProductSchema.listed", () => {
  it("defaults to LISTED when the field is absent", () => {
    // THE ROLLOUT PROPERTY, PINNED. `PRODUCT` above deliberately carries no
    // `listed` key — it is the response an API that predates this column sends.
    // Migrations do not run in the app container and the two apps deploy
    // separately, so a new storefront WILL parse an old server's payload. If
    // this ever became a required field, every product on the site would fail
    // `.strict()` parsing for the length of a deploy.
    const parsed = publicProductSchema.parse(PRODUCT);

    expect(parsed.listed).toBe(true);
  });

  it("carries an explicit false through as an add-on", () => {
    const parsed = publicProductSchema.parse({ ...PRODUCT, listed: false });

    expect(parsed.listed).toBe(false);
  });

  it("rejects a non-boolean rather than coercing it", () => {
    // "false" is the shape a query string or a spreadsheet import produces, and
    // it is truthy. Coercing it would silently list every add-on.
    expect(publicProductSchema.safeParse({ ...PRODUCT, listed: "false" }).success).toBe(
      false,
    );
  });
});

describe("a product whose variants have all been deleted", () => {
  it("PARSES on the admin shape — an operator must be able to see it", () => {
    // THE ADMIN LIST BUG. `productInclude` filters variants to `deletedAt: null`,
    // so every soft-deleted product serialises as `variants: []`. With `.min(1)`
    // on this schema the dashboard's `parseOrThrow` threw the moment the list
    // contained one — which is precisely what "Include deleted" asks for — and
    // `AdminErrorState` renders any non-ApiError throw as a bare "Server error",
    // so the cause was invisible.
    const parsed = productSchema.parse({ ...PRODUCT, variants: [] });

    expect(parsed.variants).toEqual([]);
  });

  it("is still REFUSED on the public shape — the shop may never meet one", () => {
    // The guarantee did not move, it moved LAYER. A product with nothing
    // sellable has no price and no add-to-cart target; the storefront must not
    // be handed one.
    const result = publicProductSchema.safeParse({ ...PRODUCT, variants: [] });

    expect(result.success).toBe(false);
  });
});

describe("publicProductSchema.offerOnNewProducts", () => {
  it("defaults to NOT offering on new products when the field is absent", () => {
    // THE ROLLOUT PROPERTY, for the fourth field to need it. `PRODUCT` carries
    // no such key, which is the response an API that predates the column sends.
    // Defaulting to FALSE matters beyond parsing: true would make every add-on
    // in the catalogue silently attach itself to every product created next.
    const parsed = publicProductSchema.parse(PRODUCT);

    expect(parsed.offerOnNewProducts).toBe(false);
    expect(parsed.newProductDefaultVariantId).toBeNull();
  });

  it("carries the flag and its pre-selected variant when the API sends them", () => {
    const parsed = publicProductSchema.parse({
      ...PRODUCT,
      offerOnNewProducts: true,
      newProductDefaultVariantId: "11111111-1111-4111-8111-111111111111",
    });

    expect(parsed.offerOnNewProducts).toBe(true);
    expect(parsed.newProductDefaultVariantId).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("refuses a default that is not an id", () => {
    const result = publicProductSchema.safeParse({
      ...PRODUCT,
      newProductDefaultVariantId: "the-free-one",
    });

    expect(result.success).toBe(false);
  });
});

describe("publicProductSchema.stackDiscountEnabled", () => {
  it("defaults to false when the field is absent — the same rollout property as offerOnNewProducts", () => {
    const parsed = publicProductSchema.parse(PRODUCT);

    expect(parsed.stackDiscountEnabled).toBe(false);
  });

  it("carries the flag when the API sends it, and reaches the storefront unchanged", () => {
    // `publicProductSchema` is `productSchema.extend({...})`, not a `.pick()` —
    // this is the direct proof a field added to `productSchema` reaches the
    // storefront-facing shape with no separate edit.
    const parsed = publicProductSchema.parse({ ...PRODUCT, stackDiscountEnabled: true });

    expect(parsed.stackDiscountEnabled).toBe(true);
  });
});

describe("publicProductSchema variant image", () => {
  it("defaults to NO IMAGE when the field is absent", () => {
    // THE SAME ROLLOUT PROPERTY AS `listed` ABOVE, AND IT WAS MISSED ONCE.
    // `VARIANT` sets `image` explicitly, so every other test in this file
    // describes a payload only the NEW api can send. An api that predates the
    // variant-image column omits the key, and `.nullable()` alone rejects an
    // ABSENT key — it accepts null, not undefined. That is the difference
    // between a deploy and an outage, so it is pinned here.
    const withoutImage: Record<string, unknown> = { ...VARIANT };
    delete withoutImage["image"];

    const parsed = publicProductSchema.parse({ ...PRODUCT, variants: [withoutImage] });

    expect(parsed.variants[0]?.image).toBeNull();
  });

  it("carries an explicit asset through unchanged", () => {
    const image = {
      id: "44444444-4444-4444-8444-444444444444",
      url: "https://cdn.example.com/tee-black.jpg",
      alt: { es: "Camiseta negra doblada" },
      width: 1200,
      height: 1200,
      sortOrder: 0,
    };

    const parsed = publicProductSchema.parse({
      ...PRODUCT,
      variants: [{ ...VARIANT, image }],
    });

    expect(parsed.variants[0]?.image).toEqual(image);
  });

  it("rejects a malformed asset rather than quietly dropping it to null", () => {
    // The default exists for an ABSENT key, not for a present-but-broken one.
    const result = publicProductSchema.safeParse({
      ...PRODUCT,
      variants: [{ ...VARIANT, image: { id: "not-a-uuid" } }],
    });

    expect(result.success).toBe(false);
  });
});

describe("publicProductSchema.addOns", () => {
  it("defaults to NO ADD-ONS when the field is absent", () => {
    // THE ROLLOUT PROPERTY, PINNED — the same one `listed` and the variant image
    // document above. `PRODUCT` carries no `addOns` key, which is exactly the
    // response an API that predates the product_add_on table sends. If this ever
    // became required, every product on the site would fail `.strict()` parsing
    // for the length of a deploy.
    const parsed = publicProductSchema.parse(PRODUCT);

    expect(parsed.addOns).toEqual([]);
  });

  it("carries the operator's order through", () => {
    const parsed = publicProductSchema.parse({
      ...PRODUCT,
      addOns: [
        { id: "55555555-5555-4555-8555-555555555555", slug: "canvas-tote", sortOrder: 0 },
        { id: "66666666-6666-4666-8666-666666666666", slug: "sticker-pack", sortOrder: 1 },
      ],
    });

    expect(parsed.addOns.map((ref) => ref.slug)).toEqual([
      "canvas-tote",
      "sticker-pack",
    ]);
  });

  it("defaults a reference to PRE-SELECTING NOTHING", () => {
    // THE SAME ROLLOUT PROPERTY AGAIN, one level down. These refs carry no
    // `defaultVariantId`, which is the response an API that predates that
    // column sends — and `.strict()` would reject the whole product if the
    // field were merely `.nullable()` rather than defaulted.
    const parsed = publicProductSchema.parse({
      ...PRODUCT,
      addOns: [
        { id: "55555555-5555-4555-8555-555555555555", slug: "canvas-tote", sortOrder: 0 },
      ],
    });

    expect(parsed.addOns[0]?.defaultVariantId).toBeNull();
  });

  it("carries a pre-selected variant when the edge names one", () => {
    const parsed = publicProductSchema.parse({
      ...PRODUCT,
      addOns: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          slug: "canvas-tote",
          sortOrder: 0,
          defaultVariantId: "77777777-7777-4777-8777-777777777777",
        },
      ],
    });

    expect(parsed.addOns[0]?.defaultVariantId).toBe("77777777-7777-4777-8777-777777777777");
  });

  it("refuses a default that is not an id", () => {
    // The default exists for an ABSENT key, not for a present-but-broken one.
    const result = publicProductSchema.safeParse({
      ...PRODUCT,
      addOns: [
        { id: "55555555-5555-4555-8555-555555555555", slug: "a", sortOrder: 0, defaultVariantId: "nope" },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("refuses a nested product where a reference belongs", () => {
    // The shape is deliberately an edge, not an entity: a product embedding
    // products is a tree, and `.strict()` is what stops one growing here.
    const result = publicProductSchema.safeParse({
      ...PRODUCT,
      addOns: [{ ...PRODUCT, sortOrder: 0 }],
    });

    expect(result.success).toBe(false);
  });
});

describe("publicProductSchema variant priceTiers", () => {
  it("defaults to NO TIERS when the field is absent", () => {
    // THE ROLLOUT PROPERTY, PINNED LATE. `priceTiers` was given `.default([])`
    // for exactly the reason `listed`, `image` and `addOns` document — an API
    // that predates the tier table omits the key — but unlike those three it
    // shipped with nothing here asserting it. `VARIANT` carries no `priceTiers`
    // key, so this is that response.
    const parsed = publicProductSchema.parse(PRODUCT);

    expect(parsed.variants[0]?.priceTiers).toEqual([]);
  });

  it("carries tiers through when the API sends them", () => {
    const parsed = publicProductSchema.parse({
      ...PRODUCT,
      variants: [{ ...VARIANT, priceTiers: [{ minQuantity: 3, unitPriceGross: 1790 }] }],
    });

    expect(parsed.variants[0]?.priceTiers).toEqual([
      { minQuantity: 3, unitPriceGross: 1790 },
    ]);
  });

  it("refuses a tier at quantity 1, which is the variant's own price", () => {
    const result = publicProductSchema.safeParse({
      ...PRODUCT,
      variants: [{ ...VARIANT, priceTiers: [{ minQuantity: 1, unitPriceGross: 1790 }] }],
    });

    expect(result.success).toBe(false);
  });
});

describe("resolveUnitPrice", () => {
  const TIERS = [
    { minQuantity: 2, unitPriceGross: toMinor(4949) },
    { minQuantity: 5, unitPriceGross: toMinor(3849) },
    { minQuantity: 10, unitPriceGross: toMinor(3299) },
  ];
  const BASE = toMinor(5499);

  it("charges the base price below the first threshold", () => {
    // Quantity one is the variant's own price — the tiers do not claim it.
    expect(resolveUnitPrice(BASE, TIERS, 1)).toBe(5499);
  });

  it("takes the highest threshold the quantity reaches", () => {
    expect(resolveUnitPrice(BASE, TIERS, 2)).toBe(4949);
    expect(resolveUnitPrice(BASE, TIERS, 4)).toBe(4949);
    expect(resolveUnitPrice(BASE, TIERS, 5)).toBe(3849);
    expect(resolveUnitPrice(BASE, TIERS, 9)).toBe(3849);
    expect(resolveUnitPrice(BASE, TIERS, 10)).toBe(3299);
    expect(resolveUnitPrice(BASE, TIERS, 99)).toBe(3299);
  });

  it("does not depend on the order the tiers arrive in", () => {
    // A resolver that quietly required sorted input would be wrong only for
    // whoever forgot to sort — which is the worst kind of wrong for money.
    const shuffled = [TIERS[2], TIERS[0], TIERS[1]].filter(
      (tier): tier is (typeof TIERS)[number] => tier !== undefined,
    );

    expect(resolveUnitPrice(BASE, shuffled, 6)).toBe(3849);
  });

  it("returns the base price when there are no tiers at all", () => {
    // Every variant that exists today, and the reason the column is additive.
    expect(resolveUnitPrice(BASE, [], 7)).toBe(5499);
  });

  it("honours a tier that is DEARER than the base price", () => {
    // Strange pricing is a merchant's decision, not an impossible state — the
    // resolver applies what is stored rather than second-guessing it.
    expect(resolveUnitPrice(BASE, [{ minQuantity: 2, unitPriceGross: toMinor(9999) }], 3)).toBe(
      9999,
    );
  });
});

describe("computeStackDiscountTiers", () => {
  it("computes the exact fixed schedule off the variant's own price", () => {
    // 10/15/30/40% off €54.99 (5499 minor units).
    expect(computeStackDiscountTiers(toMinor(5499))).toEqual([
      { minQuantity: 2, unitPriceGross: 4949 },
      { minQuantity: 3, unitPriceGross: 4674 },
      { minQuantity: 5, unitPriceGross: 3849 },
      { minQuantity: 10, unitPriceGross: 3299 },
    ]);
  });

  it("pins the best-price quantity to 5, matching the schedule's own 30% tier", () => {
    // Not "whichever tier is cheapest per unit" — 10 units is objectively
    // cheaper than 5, and the badge goes on 5 anyway. This constant is the one
    // place that choice lives; it must name a real tier in the schedule above.
    expect(STACK_DISCOUNT_BEST_PRICE_QUANTITY).toBe(5);
    expect(
      computeStackDiscountTiers(toMinor(5499)).some(
        (tier) => tier.minQuantity === STACK_DISCOUNT_BEST_PRICE_QUANTITY,
      ),
    ).toBe(true);
  });

  it("stays money-safe at a very low base price — documented, not asserted impossible", () => {
    // At a few cents, rounding can make two adjacent tiers land on the same
    // integer price, or even invert. This is a real, cosmetic edge case far
    // below anything this store sells at — pinned here so a future reader
    // finds a test, not a surprise.
    const tiers = computeStackDiscountTiers(toMinor(10));
    for (const tier of tiers) {
      expect(Number.isInteger(tier.unitPriceGross)).toBe(true);
      expect(tier.unitPriceGross).toBeGreaterThanOrEqual(0);
    }
  });

  it("feeds resolveUnitPrice exactly like a manually-entered schedule would", () => {
    // The point of the whole design: one function computes, the other charges,
    // and neither knows the tiers came from a fixed schedule rather than an
    // admin's own typing.
    const base = toMinor(5499);
    const tiers = computeStackDiscountTiers(base);

    expect(resolveUnitPrice(base, tiers, 1)).toBe(5499);
    expect(resolveUnitPrice(base, tiers, 5)).toBe(3849);
    expect(resolveUnitPrice(base, tiers, 10)).toBe(3299);
  });
});

describe("fields from the previous catalogue are gone", () => {
  const base = {
    slug: "x",
    translations: PRODUCT.translations,
    variants: [{ sku: "X-1", priceGross: 100, currency: "EUR" }],
  };

  it("the public product rejects form, certificate and lot fields (strict)", () => {
    expect(publicProductSchema.safeParse({ ...PRODUCT, form: "OTHER" }).success).toBe(false);
    expect(publicProductSchema.safeParse({ ...PRODUCT, hasCoa: true }).success).toBe(false);
    expect(
      publicProductSchema.safeParse({ ...PRODUCT, variants: [{ ...VARIANT, batch: null }] })
        .success,
    ).toBe(false);
  });

  it("the admin product and the create DTO reject them too", () => {
    const adminVariant = {
      ...VARIANT,
      inventory: { ...VARIANT.inventory, onHand: 210, reserved: 0, lowStockThreshold: 5 },
    };
    expect(productSchema.safeParse({ ...PRODUCT, variants: [adminVariant] }).success).toBe(true);
    expect(
      productSchema.safeParse({ ...PRODUCT, showCoa: true, variants: [adminVariant] }).success,
    ).toBe(false);
    expect(createProductSchema.safeParse({ ...base, form: "OTHER" }).success).toBe(false);
    expect(createProductSchema.safeParse({ ...base, showCoa: true }).success).toBe(false);
  });
});
