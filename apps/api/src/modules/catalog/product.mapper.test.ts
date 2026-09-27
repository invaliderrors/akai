import { describe, expect, it } from "vitest";
import { productSchema, productVariantSchema, publicProductSchema } from "@akai/contracts";
import {
  derivePackAvailability,
  mapProduct,
  mapVariant,
  toPublicProduct,
  type HydratedProduct,
} from "./product.mapper";

const PRODUCT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VARIANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREATED = new Date("2026-03-01T10:00:00.000Z");

type HydratedVariant = HydratedProduct["variants"][number];

function variantFixture(overrides: Partial<HydratedVariant> = {}): HydratedVariant {
  const base: HydratedVariant = {
    id: VARIANT_ID,
    productId: PRODUCT_ID,
    sku: "AK-CREA-500",
    name: { es: "500 g", en: "500 g" },
    options: { size: "500g" },
    currency: "EUR",
    // 49.99 EUR gross at 21% VAT.
    priceNet: 4131,
    priceTax: 868,
    priceGross: 4999,
    compareAtGross: 5999,
    taxRateBps: 2100,
    saleStartsAt: null,
    saleEndsAt: null,
    weightGrams: 500,
    lengthMm: null,
    widthMm: null,
    heightMm: null,
    priceTiers: [],
    isActive: true,
    version: 3,
    createdAt: CREATED,
    updatedAt: CREATED,
    deletedAt: null,
    // Non-null by default so the leak test below exercises a variant image's
    // objectKey too; the "no image" case passes `image: null` explicitly.
    image: {
      id: "99999999-9999-4999-8999-999999999999",
      productId: PRODUCT_ID,
      variantId: VARIANT_ID,
      objectKey: "variants/secret-variant-key.jpg",
      url: "https://cdn.example.com/camiseta-negra.jpg",
      alt: { es: "Bote de 500 g" },
      width: 900,
      height: 900,
      sortOrder: 0,
      createdAt: CREATED,
    },
    inventory: {
      variantId: VARIANT_ID,
      onHand: 40,
      reserved: 12,
      lowStockThreshold: 5,
      allowBackorder: false,
      version: 1,
      updatedAt: CREATED,
    },
  };

  return { ...base, ...overrides };
}

function productFixture(overrides: Partial<HydratedProduct> = {}): HydratedProduct {
  const base: HydratedProduct = {
    id: PRODUCT_ID,
    slug: "camiseta-oversize",
    status: "ACTIVE",
    taxClass: "STANDARD",
    restrictedCountries: ["US"],
    hygieneExempt: true,
    listed: true,
    // RAW COLUMNS, not contract fields: this fixture is a HydratedProduct, the
    // Prisma row the mapper takes as INPUT. Regenerating the client widened
    // `Prisma.ProductGetPayload`, so the row now carries both.
    offerOnNewProducts: false,
    newProductDefaultVariantId: null,
    stackDiscountEnabled: false,
    sortOrder: 0,
    kind: "SIMPLE",
    addOns: [],
    packComponents: [],
    createdAt: CREATED,
    updatedAt: CREATED,
    deletedAt: null,
    translations: [
      {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        productId: PRODUCT_ID,
        locale: "es",
        name: "Camiseta Oversize",
        shortDescription: "Algodón orgánico",
        description: "Descripcion larga",
      },
    ],
    media: [
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        productId: PRODUCT_ID,
        variantId: null,
        objectKey: "products/secret-key.jpg",
        url: "https://cdn.example.com/camiseta.jpg",
        alt: { es: "Camiseta doblada" },
        width: 1200,
        height: 1200,
        sortOrder: 0,
        createdAt: CREATED,
      },
    ],
    categories: [
      {
        productId: PRODUCT_ID,
        categoryId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        sortOrder: 2,
        category: {
          id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          slug: "recuperacion",
          name: { es: "Recuperación", en: "Recovery" },
          sortOrder: 1,
          createdAt: CREATED,
          deletedAt: null,
        },
      },
    ],
    variants: [variantFixture()],
  };

  return { ...base, ...overrides };
}

describe("mapProduct", () => {
  it("produces a value the shared contract accepts", () => {
    const mapped = mapProduct(productFixture(), { activeVariantsOnly: true });
    const parsed = productSchema.safeParse(mapped);

    // Parsing against the real contract is the assertion that matters: it
    // catches a missing field, an extra field (the schema is .strict()) and a
    // Date that was never serialised, all at once.
    expect(parsed.success).toBe(true);
  });

  /**
   * The leak test.
   *
   * Every one of these is a real column on the hydrated row that must never
   * reach a client. Asserting on the SERIALISED string rather than on object
   * keys catches a value nested anywhere in the tree, including a field added
   * to a relation later.
   */
  it("never serialises payment-provider ids or S3 object keys", () => {
    const serialised = JSON.stringify(
      mapProduct(productFixture(), { activeVariantsOnly: false }),
    );

    expect(serialised).not.toContain("prod_live_SECRET");
    expect(serialised).not.toContain("price_live_SECRET");
    expect(serialised).not.toContain("products/secret-key.jpg");
    expect(serialised).not.toContain("variants/secret-variant-key.jpg");
    expect(serialised).not.toContain("providerProductId");
    expect(serialised).not.toContain("objectKey");
  });

  it("serialises timestamps as ISO strings, not Date instances", () => {
    const mapped = mapProduct(productFixture(), { activeVariantsOnly: true });

    expect(mapped.createdAt).toBe("2026-03-01T10:00:00.000Z");
    expect(mapped.deletedAt).toBeNull();
  });

  it("maps the soft-delete timestamp when present", () => {
    const deletedAt = new Date("2026-04-02T08:30:00.000Z");
    const mapped = mapProduct(productFixture({ deletedAt }), {
      activeVariantsOnly: false,
    });

    expect(mapped.deletedAt).toBe("2026-04-02T08:30:00.000Z");
  });

  it("hides inactive variants from a public mapping but keeps them for admin", () => {
    const product = productFixture({
      variants: [variantFixture(), variantFixture({ id: PRODUCT_ID, isActive: false })],
    });

    expect(mapProduct(product, { activeVariantsOnly: true }).variants).toHaveLength(1);
    expect(mapProduct(product, { activeVariantsOnly: false }).variants).toHaveLength(2);
  });

  it("carries the join-table sort order onto the category, not the category's own", () => {
    const [category] = mapProduct(productFixture(), { activeVariantsOnly: true }).categories;

    // 2 is the per-product ordering; 1 is the category's global ordering. Using
    // the wrong one makes an admin's drag-to-reorder silently do nothing.
    expect(category?.sortOrder).toBe(2);
  });

  it("carries stackDiscountEnabled through to both the admin and public mappings", () => {
    const product = productFixture({ stackDiscountEnabled: true });

    expect(mapProduct(product, { activeVariantsOnly: true }).stackDiscountEnabled).toBe(true);
    expect(mapProduct(product, { activeVariantsOnly: false }).stackDiscountEnabled).toBe(true);
  });
});

describe("mapVariant", () => {
  it("produces a value the shared contract accepts", () => {
    expect(productVariantSchema.safeParse(mapVariant(variantFixture())).success).toBe(true);
  });

  /**
   * `available` is the only stock figure a buying surface may read.
   *
   * 40 on hand with 12 reserved is 28 available. Publishing 40 would advertise
   * units already inside other customers' checkouts.
   */
  it("derives available as onHand minus reserved", () => {
    expect(mapVariant(variantFixture()).inventory.available).toBe(28);
  });

  it("floors available at zero rather than reporting negative stock", () => {
    const variant = variantFixture({
      inventory: {
        variantId: VARIANT_ID,
        onHand: 2,
        reserved: 5,
        lowStockThreshold: 5,
        allowBackorder: false,
        version: 1,
        updatedAt: CREATED,
      },
    });

    expect(mapVariant(variant).inventory.available).toBe(0);
  });

  /**
   * A variant with no inventory row means "never stocked", not "unlimited".
   * Defaulting the missing row to purchasable is how an unfulfillable order
   * gets taken.
   */
  it("treats a missing inventory row as zero stock, not unlimited", () => {
    const mapped = mapVariant(variantFixture({ inventory: null }));

    expect(mapped.inventory.available).toBe(0);
    expect(mapped.inventory.onHand).toBe(0);
    expect(mapped.inventory.allowBackorder).toBe(false);
  });

  it("keeps money as integer minor units through the mapping", () => {
    const price = mapVariant(variantFixture()).price;

    expect(price.gross).toBe(4999);
    expect(price.net + price.tax).toBe(price.gross);
    expect(Number.isInteger(price.gross)).toBe(true);
  });

  it("maps a null compareAtGross rather than dropping the key", () => {
    expect(mapVariant(variantFixture({ compareAtGross: null })).price.compareAtGross)
      .toBeNull();
  });

  // -- The variant's own image ----------------------------------------------

  it("maps the variant's own image through the same mapper as a gallery image", () => {
    const image = mapVariant(variantFixture()).image;

    // Same wire shape as `product.media[n]`, so the storefront's fallback can be
    // a plain `variant.image ?? primaryMedia(product)` with no adapter between.
    expect(image?.url).toBe("https://cdn.example.com/camiseta-negra.jpg");
    expect(image?.alt).toEqual({ es: "Bote de 500 g" });
    // objectKey is dropped here exactly as it is for a gallery image.
    expect(Object.keys(image ?? {})).not.toContain("objectKey");
  });

  it("maps a variant with no image of its own to null so the caller can fall back", () => {
    expect(mapVariant(variantFixture({ image: null })).image).toBeNull();
  });

  it("does not put the variant's image into the product gallery, or the reverse", () => {
    const mapped = mapProduct(productFixture(), { activeVariantsOnly: true });
    const [variant] = mapped.variants;

    // The two sets are partitioned by `productInclude`'s `where: { variantId: null }`,
    // not by a filter here — this asserts the partition survives the mapping. A
    // variant image showing up in the gallery would duplicate it on the hero
    // rail and in the admin gallery list.
    expect(mapped.media.map((asset) => asset.url)).toEqual([
      "https://cdn.example.com/camiseta.jpg",
    ]);
    expect(variant?.image?.url).toBe("https://cdn.example.com/camiseta-negra.jpg");
  });

  // -- Json column narrowing ------------------------------------------------

  it("narrows well-formed json columns", () => {
    const mapped = mapVariant(variantFixture());

    expect(mapped.name).toEqual({ es: "500 g", en: "500 g" });
    expect(mapped.options).toEqual({ size: "500g" });
  });

  /**
   * A malformed Json column degrades to empty rather than throwing.
   *
   * This asymmetry with the request boundary is deliberate: a bad request must
   * 400, but one corrupt row must not 500 the entire catalog listing for every
   * visitor — including the admin trying to reach the row and fix it.
   */
  it("degrades a malformed options column to empty instead of throwing", () => {
    const variant = variantFixture({ options: ["not", "an", "object"] });

    expect(() => mapVariant(variant)).not.toThrow();
    expect(mapVariant(variant).options).toEqual({});
  });

  it("degrades a json column of the wrong value type to empty", () => {
    const variant = variantFixture({ name: { es: 42 } });

    expect(mapVariant(variant).name).toEqual({});
  });

  it("keeps an explicitly null variant name as null, not an empty object", () => {
    // null means "single-variant product, no size label" — semantically
    // different from "a label exists but is empty".
    expect(mapVariant(variantFixture({ name: null })).name).toBeNull();
  });
});

describe("mapProduct — add-ons", () => {
  it("maps the edge to a reference, in the operator's order", () => {
    // EXERCISED WITH DATA, not just with []. Every other fixture in this file
    // carries an empty list, so without this the mapping branch would never run
    // and a wrong field name would pass the whole suite — the same shape of gap
    // that let the storefront's add-on strip ship returning nothing.
    const product = productFixture({
      addOns: [
        {
          productId: PRODUCT_ID,
          addOnId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          sortOrder: 0,
          // Null is the ordinary case: most edges pre-select nothing. A
          // populated one is exercised in its own test below.
          defaultVariantId: null,
          addOn: {
            id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            slug: "canvas-tote",
          },
        },
      ],
    });

    const mapped = mapProduct(product, { activeVariantsOnly: false });

    expect(mapped.addOns).toEqual([
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        slug: "canvas-tote",
        sortOrder: 0,
        // Asserted in FULL, not with objectContaining: the storefront parses
        // this against a `.strict()` schema, so a field the mapper stops
        // emitting is a parse failure in production, not a smaller object.
        defaultVariantId: null,
      },
    ]);
  });

  it("reports no add-ons as an empty list, never as undefined", () => {
    // The contract defaults the field, so a product with no add-ons must still
    // arrive as [] — a storefront that received undefined would fail `.strict()`.
    const mapped = mapProduct(productFixture(), { activeVariantsOnly: false });

    expect(mapped.addOns).toEqual([]);
  });
});

describe("derivePackAvailability — a pack's stock is its components' stock", () => {
  type PackEdge = HydratedProduct["packComponents"][number];

  function edge(
    index: number,
    options: {
      readonly quantity?: number;
      readonly onHand?: number;
      readonly reserved?: number;
      readonly allowBackorder?: boolean;
      readonly noInventory?: boolean;
      readonly variantActive?: boolean;
      readonly status?: "ACTIVE" | "DRAFT" | "ARCHIVED";
    } = {},
  ): PackEdge {
    const componentId = `1000000${String(index)}-0000-4000-8000-000000000000`;
    const variantId = `2000000${String(index)}-0000-4000-8000-000000000000`;
    return {
      packProductId: PRODUCT_ID,
      componentProductId: componentId,
      componentVariantId: variantId,
      sortOrder: index,
      quantity: options.quantity ?? 1,
      component: { id: componentId, slug: `component-${String(index)}`, status: options.status ?? "ACTIVE" },
      componentVariant: {
        isActive: options.variantActive ?? true,
        deletedAt: null,
        inventory:
          options.noInventory === true
            ? null
            : {
                onHand: options.onHand ?? 100,
                reserved: options.reserved ?? 0,
                allowBackorder: options.allowBackorder ?? false,
              },
      },
    };
  }

  function pack(edges: readonly PackEdge[]): HydratedProduct {
    // The pack's OWN variant claims plenty of stock — the number the
    // storefront used to read, and the one the cart never checks.
    return productFixture({ kind: "PACK", packComponents: [...edges] });
  }

  it("is null for a SIMPLE product", () => {
    expect(derivePackAvailability(productFixture())).toBeNull();
  });

  it("is the minimum over components of floor(available / quantity per pack)", () => {
    const availability = derivePackAvailability(
      pack([
        edge(1, { onHand: 20, reserved: 2 }),
        // 5 per pack, 13 available -> 2 packs: the binding component.
        edge(2, { quantity: 5, onHand: 15, reserved: 2 }),
      ]),
    );
    expect(availability).toEqual({ available: 2, allowBackorder: false });
  });

  it("treats a component with no inventory row as zero, exactly like the cart", () => {
    expect(derivePackAvailability(pack([edge(1), edge(2, { noInventory: true })]))).toEqual({
      available: 0,
      allowBackorder: false,
    });
  });

  it("is zero when a component is no longer sellable", () => {
    expect(derivePackAvailability(pack([edge(1), edge(2, { variantActive: false })]))).toEqual({
      available: 0,
      allowBackorder: false,
    });
    expect(derivePackAvailability(pack([edge(1), edge(2, { status: "ARCHIVED" })]))).toEqual({
      available: 0,
      allowBackorder: false,
    });
  });

  it("ignores a backorderable component, and backorders only when every component does", () => {
    expect(
      derivePackAvailability(pack([edge(1, { onHand: 0, allowBackorder: true }), edge(2, { onHand: 4 })])),
    ).toEqual({ available: 4, allowBackorder: false });
    expect(
      derivePackAvailability(
        pack([edge(1, { onHand: 0, allowBackorder: true }), edge(2, { onHand: 0, allowBackorder: true })]),
      ),
    ).toEqual({ available: 0, allowBackorder: true });
  });

  it("toPublicProduct publishes the derived figure on the pack's variant, not the pack's own row", () => {
    const row = pack([edge(1, { onHand: 0 }), edge(2)]);
    const published = toPublicProduct(
      mapProduct(row, { activeVariantsOnly: true }),
      derivePackAvailability(row),
    );

    expect(published.variants[0]?.inventory).toEqual({
      variantId: VARIANT_ID,
      available: 0,
      allowBackorder: false,
    });
    expect(() => publicProductSchema.parse(published)).not.toThrow();
  });
});
