import { describe, expect, it } from "vitest";
import {
  addMediaSchema,
  adjustInventorySchema,
  adminProductListQuerySchema,
  createCategorySchema,
  publicAddOnListQuerySchema,
  publicProductListQuerySchema,
  reorderCategoriesSchema,
  reserveStockSchema,
  setCategoriesSchema,
  updateCategorySchema,
  updateVariantSchema,
} from "./catalog.dto";

const VARIANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("publicProductListQuerySchema", () => {
  it("applies the documented defaults", () => {
    const parsed = publicProductListQuerySchema.parse({});

    expect(parsed.sort).toBe("newest");
    expect(parsed.limit).toBe(24);
    expect(parsed.locale).toBe("es");
  });

  /**
   * THE PRIVILEGE BOUNDARY.
   *
   * The public listing must not be able to reach draft or soft-deleted rows.
   * That is enforced by ABSENCE — the schema has no such members and is
   * `.strict()` — rather than by a runtime check the service must remember to
   * perform. A crafted query string is a 400, not a leak.
   */
  it("rejects a crafted status filter", () => {
    expect(publicProductListQuerySchema.safeParse({ status: "DRAFT" }).success).toBe(false);
  });

  it("rejects a crafted includeDeleted filter", () => {
    expect(publicProductListQuerySchema.safeParse({ includeDeleted: "true" }).success)
      .toBe(false);
  });

  it("rejects any unknown key at all", () => {
    expect(publicProductListQuerySchema.safeParse({ orderBy: "id" }).success).toBe(false);
  });

  it("caps the page size so one request cannot pull the whole catalog", () => {
    expect(publicProductListQuerySchema.safeParse({ limit: 1000 }).success).toBe(false);
    expect(publicProductListQuerySchema.parse({ limit: "50" }).limit).toBe(50);
  });

  it("rejects a cursor that is not a uuid", () => {
    expect(publicProductListQuerySchema.safeParse({ cursor: "1; DROP TABLE" }).success)
      .toBe(false);
  });

  it("rejects an unsupported sort key", () => {
    expect(publicProductListQuerySchema.safeParse({ sort: "random" }).success).toBe(false);
  });
});

describe("adminProductListQuerySchema", () => {
  it("does allow the privileged filters", () => {
    const parsed = adminProductListQuerySchema.parse({
      status: "DRAFT",
      includeDeleted: "true",
    });

    expect(parsed.status).toBe("DRAFT");
    expect(parsed.includeDeleted).toBe(true);
  });

  it("still rejects unknown keys", () => {
    expect(adminProductListQuerySchema.safeParse({ sneaky: 1 }).success).toBe(false);
  });
});

describe("updateVariantSchema", () => {
  /**
   * `version` is required, not optional.
   *
   * An optional version would let any client silently opt out of optimistic
   * concurrency, and two admins editing one variant would last-write-wins with
   * no error — one of them watching their price change simply vanish.
   */
  it("requires a version, so a caller cannot opt out of concurrency control", () => {
    expect(updateVariantSchema.safeParse({ priceGross: 1000 }).success).toBe(false);
    expect(updateVariantSchema.safeParse({ version: 3, priceGross: 1000 }).success)
      .toBe(true);
  });

  /**
   * Net and tax are DERIVED server-side. Accepting them would let a caller
   * submit an inconsistent triple and either violate the database CHECK
   * constraint or, worse, satisfy it with the wrong tax split.
   */
  it("refuses client-supplied net and tax components", () => {
    expect(updateVariantSchema.safeParse({ version: 1, priceNet: 100 }).success)
      .toBe(false);
    expect(updateVariantSchema.safeParse({ version: 1, priceTax: 21 }).success)
      .toBe(false);
  });

  it("rejects a fractional price — money is integer minor units", () => {
    expect(updateVariantSchema.safeParse({ version: 1, priceGross: 49.99 }).success)
      .toBe(false);
  });

  it("rejects a negative price", () => {
    expect(updateVariantSchema.safeParse({ version: 1, priceGross: -1 }).success)
      .toBe(false);
  });

  it("rejects a tax rate above 100%", () => {
    expect(updateVariantSchema.safeParse({ version: 1, taxRateBps: 10_001 }).success)
      .toBe(false);
  });

  it("distinguishes clearing a name from omitting it", () => {
    // null means "single-variant product, no label"; omitted means "leave as is".
    expect(updateVariantSchema.parse({ version: 1, name: null }).name).toBeNull();
    expect(updateVariantSchema.parse({ version: 1 }).name).toBeUndefined();
  });
});

describe("adjustInventorySchema", () => {
  /**
   * The ledger is append-only and permanent. An adjustment with no reason is a
   * row nobody can explain months later when the count fails to reconcile.
   */
  it("requires a reason", () => {
    expect(adjustInventorySchema.safeParse({ delta: 10 }).success).toBe(false);
    expect(adjustInventorySchema.safeParse({ delta: 10, reason: "no" }).success)
      .toBe(false);
    expect(adjustInventorySchema.safeParse({ delta: 10, reason: "Restock" }).success)
      .toBe(true);
  });

  it("rejects a zero delta, which would assert nothing", () => {
    expect(adjustInventorySchema.safeParse({ delta: 0, reason: "Nothing" }).success)
      .toBe(false);
  });

  it("accepts a negative delta for shrinkage", () => {
    expect(adjustInventorySchema.parse({ delta: -3, reason: "Damaged in transit" }).delta)
      .toBe(-3);
  });

  it("rejects a fractional delta — stock is whole units", () => {
    expect(adjustInventorySchema.safeParse({ delta: 1.5, reason: "Half a tub" }).success)
      .toBe(false);
  });

  /**
   * `expectedOnHand` is the on-hand count the operator was LOOKING AT when they
   * typed the target. It is optional so an older client keeps working, and the
   * delta is still what gets applied — the expectation only guards it.
   */
  it("accepts an optional expectedOnHand and leaves it absent when not sent", () => {
    const withIt = adjustInventorySchema.parse({
      delta: 8,
      reason: "STOCK_COUNT",
      expectedOnHand: 29,
    });
    expect(withIt.expectedOnHand).toBe(29);

    const without = adjustInventorySchema.parse({ delta: 8, reason: "STOCK_COUNT" });
    expect(without).not.toHaveProperty("expectedOnHand");
  });

  it("accepts an expectedOnHand of zero — an untracked variant shows zero on hand", () => {
    expect(
      adjustInventorySchema.safeParse({ delta: 5, reason: "Restock", expectedOnHand: 0 })
        .success,
    ).toBe(true);
  });

  it("rejects a negative or fractional expectedOnHand", () => {
    expect(
      adjustInventorySchema.safeParse({ delta: 5, reason: "Restock", expectedOnHand: -1 })
        .success,
    ).toBe(false);
    expect(
      adjustInventorySchema.safeParse({ delta: 5, reason: "Restock", expectedOnHand: 2.5 })
        .success,
    ).toBe(false);
  });
});

describe("reserveStockSchema", () => {
  it("defaults to a fifteen minute hold", () => {
    expect(reserveStockSchema.parse({ variantId: VARIANT_ID, quantity: 1 }).ttlSeconds)
      .toBe(900);
  });

  /**
   * The TTL upper bound is a denial-of-inventory control, not a tidiness rule.
   * Unbounded, one unprivileged request can park the entire catalog's stock
   * indefinitely and the traffic looks completely ordinary.
   */
  it("caps the reservation TTL", () => {
    expect(
      reserveStockSchema.safeParse({
        variantId: VARIANT_ID,
        quantity: 1,
        ttlSeconds: 86_400,
      }).success,
    ).toBe(false);
  });

  it("requires a positive whole quantity", () => {
    for (const quantity of [0, -1, 2.5]) {
      expect(reserveStockSchema.safeParse({ variantId: VARIANT_ID, quantity }).success)
        .toBe(false);
    }
  });

  it("rejects a non-uuid variant id", () => {
    expect(reserveStockSchema.safeParse({ variantId: "abc", quantity: 1 }).success)
      .toBe(false);
  });
});

describe("addMediaSchema", () => {
  it("requires dimensions so the grid can reserve space before load", () => {
    expect(
      addMediaSchema.safeParse({
        objectKey: "products/a.jpg",
        url: "https://cdn.example.com/a.jpg",
      }).success,
    ).toBe(false);
  });

  /**
   * Regression test for a real hole found while writing these tests.
   *
   * `z.string().url()` alone ACCEPTS every one of these — it only asks whether
   * the WHATWG parser can parse the string, not whether a browser should be
   * told to navigate to it. Stored in `media_asset.url` and rendered into an
   * `<img src>` or `<a href>`, each is stored XSS.
   */
  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
  ])("rejects the non-http url %s", (url) => {
    expect(
      addMediaSchema.safeParse({
        objectKey: "products/a.jpg",
        url,
        width: 10,
        height: 10,
      }).success,
    ).toBe(false);
  });

  it("accepts ordinary http and https urls", () => {
    for (const url of ["https://cdn.example.com/a.jpg", "http://localhost:9000/a.jpg"]) {
      expect(
        addMediaSchema.safeParse({
          objectKey: "products/a.jpg",
          url,
          width: 10,
          height: 10,
        }).success,
      ).toBe(true);
    }
  });

  /**
   * An omitted variantId is the gallery case, and it stays omitted rather than
   * becoming `null`: every caller that existed before variant images kept
   * sending exactly this body, and its meaning must not have changed under it.
   */
  it("leaves variantId absent for a product-gallery image", () => {
    const parsed = addMediaSchema.parse({
      objectKey: "products/a.jpg",
      url: "https://cdn.example.com/a.jpg",
      width: 10,
      height: 10,
    });

    expect(parsed.variantId).toBeUndefined();
  });

  it("accepts a uuid variantId for a variant image", () => {
    const parsed = addMediaSchema.parse({
      objectKey: "products/a.jpg",
      url: "https://cdn.example.com/a.jpg",
      width: 10,
      height: 10,
      variantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });

    expect(parsed.variantId).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  /**
   * Shape only. That the uuid names a variant OF THIS PRODUCT is an ownership
   * question the schema cannot answer — `products.service.addMedia` checks it
   * against the product in the path and answers NOT_FOUND when it does not.
   */
  it("rejects a non-uuid variantId", () => {
    expect(
      addMediaSchema.safeParse({
        objectKey: "products/a.jpg",
        url: "https://cdn.example.com/a.jpg",
        width: 10,
        height: 10,
        variantId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  it("still rejects an unknown key, so strictness survived the new field", () => {
    expect(
      addMediaSchema.safeParse({
        objectKey: "products/a.jpg",
        url: "https://cdn.example.com/a.jpg",
        width: 10,
        height: 10,
        productId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }).success,
    ).toBe(false);
  });
});

describe("setCategoriesSchema", () => {
  it("accepts an empty list, so all categories can be cleared", () => {
    expect(setCategoriesSchema.parse({ categoryIds: [] }).categoryIds).toEqual([]);
  });

  it("rejects non-uuid ids", () => {
    expect(setCategoriesSchema.safeParse({ categoryIds: ["../../etc/passwd"] }).success)
      .toBe(false);
  });
});

describe("createCategorySchema", () => {
  it("accepts a slug and both locale names", () => {
    const parsed = createCategorySchema.parse({
      slug: "peptidos",
      name: { es: "Péptidos", en: "Peptides" },
    });

    expect(parsed).toEqual({ slug: "peptidos", name: { es: "Péptidos", en: "Peptides" } });
  });

  it("rejects a name missing either locale — no half-bilingual category", () => {
    expect(
      createCategorySchema.safeParse({ slug: "peptidos", name: { es: "Péptidos" } }).success,
    ).toBe(false);
    expect(
      createCategorySchema.safeParse({ slug: "peptidos", name: { en: "Peptides" } }).success,
    ).toBe(false);
  });

  it("rejects an empty name in either locale", () => {
    expect(
      createCategorySchema.safeParse({ slug: "peptidos", name: { es: "", en: "Peptides" } })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown field — no sortOrder, no id, at create", () => {
    expect(
      createCategorySchema.safeParse({
        slug: "peptidos",
        name: { es: "Péptidos", en: "Peptides" },
        sortOrder: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects an invalid slug", () => {
    expect(
      createCategorySchema.safeParse({
        slug: "../../etc/passwd",
        name: { es: "Péptidos", en: "Peptides" },
      }).success,
    ).toBe(false);
  });
});

describe("updateCategorySchema", () => {
  it("accepts both locale names, and nothing else — slug and sortOrder are absent", () => {
    const parsed = updateCategorySchema.parse({ name: { es: "Recuperación", en: "Recovery" } });
    expect(parsed).toEqual({ name: { es: "Recuperación", en: "Recovery" } });
  });

  it("rejects a slug or a sortOrder on the request — rename has its own reasons not to accept either", () => {
    expect(
      updateCategorySchema.safeParse({
        name: { es: "Recuperación", en: "Recovery" },
        slug: "recovery",
      }).success,
    ).toBe(false);
    expect(
      updateCategorySchema.safeParse({
        name: { es: "Recuperación", en: "Recovery" },
        sortOrder: 2,
      }).success,
    ).toBe(false);
  });

  it("rejects a partial name", () => {
    expect(updateCategorySchema.safeParse({ name: { es: "Recuperación" } }).success).toBe(false);
  });
});

describe("reorderCategoriesSchema", () => {
  it("accepts an ordered id list", () => {
    const ids = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ];
    expect(reorderCategoriesSchema.parse({ categoryIds: ids }).categoryIds).toEqual(ids);
  });

  it("rejects an empty list — unlike setCategoriesSchema, reordering nothing is not a valid request", () => {
    expect(reorderCategoriesSchema.safeParse({ categoryIds: [] }).success).toBe(false);
  });

  it("rejects non-uuid ids", () => {
    expect(reorderCategoriesSchema.safeParse({ categoryIds: ["../../etc/passwd"] }).success)
      .toBe(false);
  });
});

describe("publicAddOnListQuerySchema", () => {
  it("applies the documented defaults", () => {
    const parsed = publicAddOnListQuerySchema.parse({});

    expect(parsed.locale).toBe("es");
    expect(parsed.limit).toBe(12);
    expect(parsed.cursor).toBeUndefined();
  });

  /**
   * THE VISIBILITY BOUNDARY, and the reason this is a route rather than a flag.
   *
   * Which audience a listing serves is decided by WHICH ENDPOINT was called,
   * never by a value in the query string. If `listed` were accepted here — or
   * on the catalogue listing above — the endpoint's meaning would be the
   * caller's to set, and the day `listed = false` covers more than add-ons the
   * customer-facing surface would widen with it, silently.
   */
  it("has no member that lets a caller choose the audience", () => {
    expect(publicAddOnListQuerySchema.safeParse({ listed: false }).success).toBe(false);
    expect(publicAddOnListQuerySchema.safeParse({ listed: "false" }).success).toBe(false);
    expect(publicProductListQuerySchema.safeParse({ listed: false }).success).toBe(false);
  });

  it("rejects the merchandising filters an add-on strip has no use for", () => {
    expect(publicAddOnListQuerySchema.safeParse({ search: "creatina" }).success).toBe(false);
    expect(publicAddOnListQuerySchema.safeParse({ category: "recuperacion" }).success)
      .toBe(false);
    // Ordering is fixed server-side so the strip does not reshuffle between loads.
    expect(publicAddOnListQuerySchema.safeParse({ sort: "price_asc" }).success).toBe(false);
  });

  it("caps the page below the catalogue's ceiling", () => {
    expect(publicAddOnListQuerySchema.parse({ limit: "24" }).limit).toBe(24);
    expect(publicAddOnListQuerySchema.safeParse({ limit: 25 }).success).toBe(false);
  });
});
