import { z } from "zod";
import {
  countryCodeSchema,
  createVariantSchema,
  idSchema,
  localeSchema,
  nonNegativeMinorSchema,
  priceTierSchema,
  productAddOnInputSchema,
  productKindSchema,
  productListQuerySchema,
  productStatusSchema,
  slugSchema,
} from "@akai/contracts";

/**
 * Request shapes the catalog needs that @akai/contracts does not yet declare.
 *
 * DEFINED LOCALLY ON PURPOSE. Other agents are editing libs/contracts right now,
 * so adding to it would collide. Every schema here is a candidate for promotion
 * into libs/contracts once the ts-rest routers are assembled — they are written
 * to be moved verbatim (no imports from this module, no Nest types). Listed in
 * followUps.
 *
 * All of them are `.strict()`: under the spec that IS forbidNonWhitelisted, and
 * it is what stops an unknown key riding a request body into a Prisma `data:`
 * spread.
 */

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

/**
 * Variant update.
 *
 * `version` is REQUIRED, not optional. Making it optional would let a client
 * omit it and silently opt out of optimistic concurrency, which defeats the
 * point of the column: two admins editing the same variant would last-write-win
 * and one price change would vanish with no error. An absent version is a
 * validation failure, not a permissive default.
 *
 * `priceGross` is the only price input accepted. Net and tax are DERIVED
 * server-side via @akai/money's splitGross — a client cannot supply them, so
 * the `net + tax = gross` CHECK constraint cannot be violated by a bad caller.
 */
export const updateVariantSchema = z
  .object({
    version: z.number().int().min(0),
    sku: z.string().min(1).max(64).optional(),
    name: z.record(localeSchema, z.string().max(120)).nullable().optional(),
    options: z.record(z.string().max(40), z.string().max(80)).optional(),
    priceGross: nonNegativeMinorSchema.optional(),
    compareAtGross: nonNegativeMinorSchema.nullable().optional(),
    taxRateBps: z.number().int().min(0).max(10_000).optional(),
    weightGrams: z.number().int().positive().nullable().optional(),
    /**
     * FULL REPLACEMENT when present, absent leaves them alone — the same shape
     * `setCategories` uses, because ordering and membership are one value.
     */
    priceTiers: z.array(priceTierSchema).max(10).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type UpdateVariant = z.infer<typeof updateVariantSchema>;

/** Adding a variant to an existing product reuses the contract's create shape. */
export const addVariantSchema = createVariantSchema;
export type AddVariant = z.infer<typeof addVariantSchema>;

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/**
 * Manual stock adjustment.
 *
 * `delta` is SIGNED and `reason` is MANDATORY. The schema requires a reason
 * because the inventory ledger is append-only and permanent: an adjustment
 * without a reason is an unexplainable row that nobody can audit six months
 * later when the count does not reconcile. Automated movements (sale, return)
 * do not use this path and legitimately carry no reason.
 *
 * A delta of 0 is rejected: it writes a ledger row that asserts nothing.
 *
 * `expectedOnHand` is the on-hand count the caller computed its delta FROM. When
 * present, the guarded UPDATE also requires the stored count to still equal it,
 * so an order that moved stock between page render and submit turns into a
 * coded STOCK_CHANGED refusal instead of silently landing on a count nobody
 * typed. Optional so a caller that genuinely means "add N, whatever is there"
 * (a delivery) still can.
 */
export const adjustInventorySchema = z
  .object({
    delta: z
      .number()
      .int()
      .refine((value) => value !== 0, "Adjustment delta must not be zero"),
    reason: z.string().min(3).max(500),
    expectedOnHand: z.number().int().min(0).optional(),
  })
  .strict();

export type AdjustInventory = z.infer<typeof adjustInventorySchema>;

export const setInventoryPolicySchema = z
  .object({
    lowStockThreshold: z.number().int().min(0).optional(),
    allowBackorder: z.boolean().optional(),
  })
  .strict();

export type SetInventoryPolicy = z.infer<typeof setInventoryPolicySchema>;

/**
 * Stock reservation for an in-flight checkout.
 *
 * `ttlSeconds` is bounded on BOTH ends. An unbounded upper limit lets a caller
 * park the entire catalog's stock indefinitely with a single request — a denial
 * of inventory that needs no privileges and looks like normal traffic. Thirty
 * minutes is longer than any honest checkout and short enough that an abandoned
 * one returns the stock while the customer is still on the site.
 */
export const reserveStockSchema = z
  .object({
    variantId: idSchema,
    quantity: z.number().int().min(1).max(10_000),
    cartId: idSchema.nullable().default(null),
    ttlSeconds: z.number().int().min(60).max(1_800).default(900),
  })
  .strict();

export type ReserveStock = z.infer<typeof reserveStockSchema>;

// ---------------------------------------------------------------------------
// Media & categories
// ---------------------------------------------------------------------------

/**
 * A URL that a browser may safely be told to load.
 *
 * `z.string().url()` is NOT sufficient and this is not a theoretical concern:
 * it delegates to the WHATWG URL parser, which happily accepts
 * `javascript:alert(1)`, `data:text/html,…` and `vbscript:…` as valid URLs.
 * Stored in `media_asset.url` and rendered into an `<img src>` or an `<a href>`,
 * that is stored XSS with an admin-authenticated write as the only prerequisite
 * — and the admin surface is exactly where a compromised staff account starts.
 *
 * The protocol allowlist is the fix; a denylist of known-bad schemes is not,
 * because the scheme space is open-ended. `http` stays permitted alongside
 * `https` so local development against a non-TLS asset host still works.
 */
const httpUrlSchema = z
  .string()
  .url()
  .max(1024)
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "https:" || protocol === "http:";
    } catch {
      return false;
    }
  }, "URL must use http or https");

/**
 * Attach an already-uploaded asset.
 *
 * Takes an S3 `objectKey`, not a file. Binaries are uploaded direct-to-S3 via a
 * signed URL and never streamed through the API, so this endpoint only records
 * the reference. Dimensions are required: without them every product grid
 * reflows as images load, and Next's Image component cannot reserve space.
 */
export const addMediaSchema = z
  .object({
    objectKey: z.string().min(1).max(512),
    url: httpUrlSchema,
    alt: z.record(localeSchema, z.string().max(300)).default({}),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sortOrder: z.number().int().min(0).default(0),
    /**
     * Attach the asset to ONE variant instead of the product gallery.
     *
     * Optional rather than nullable-with-a-default: an absent key means
     * "gallery image", which is exactly what every caller sends today and what
     * the column's NULL already spells — so no existing request body changes
     * meaning, and `.strict()` still rejects anything else.
     *
     * A uuid that PARSES is not a uuid the caller may touch. The schema cannot
     * know which variants belong to the product in the path, so ownership is
     * checked in the service; this only guarantees the shape.
     */
    variantId: idSchema.optional(),
  })
  .strict();

export type AddMedia = z.infer<typeof addMediaSchema>;

/** Full replacement, not a patch — ordering is part of the value being set. */
export const setCategoriesSchema = z
  .object({
    categoryIds: z.array(idSchema).max(50),
  })
  .strict();

export type SetCategories = z.infer<typeof setCategoriesSchema>;

/**
 * Both locale names, required, for a category admin CRUD write.
 *
 * STRICTER than `categorySchema.name` (a `z.record` in @akai/contracts, which
 * tolerates a partial or malformed blob on READ so one bad row degrades rather
 * than takes the whole nav down). A WRITE has no such excuse: the two locales
 * this store serves are a closed set, and an admin creating or renaming a
 * category with only one filled in would ship a storefront that switches
 * languages mid-navigation.
 */
export const categoryNameSchema = z
  .object({
    es: z.string().min(1).max(120),
    en: z.string().min(1).max(120),
  })
  .strict();

export type CategoryName = z.infer<typeof categoryNameSchema>;

/**
 * Create a category. Appended to the end of the manual order — see
 * `ProductsService.createCategory`.
 */
export const createCategorySchema = z
  .object({
    slug: slugSchema,
    name: categoryNameSchema,
  })
  .strict();

export type CreateCategory = z.infer<typeof createCategorySchema>;

/**
 * Rename a category. `slug` and `sortOrder` are deliberately absent —
 * `admin-categories.controller.ts` has why.
 */
export const updateCategorySchema = z
  .object({
    name: categoryNameSchema,
  })
  .strict();

export type UpdateCategory = z.infer<typeof updateCategorySchema>;

/**
 * The category list's manual display order — same "selection order is the
 * value" shape as `reorderProductsSchema` below, scoped to categories instead.
 * 200 is the same sanity ceiling, not a real expected size — a store's
 * category tree is tens of rows.
 */
export const reorderCategoriesSchema = z
  .object({
    categoryIds: z.array(idSchema).min(1).max(200),
  })
  .strict();

export type ReorderCategories = z.infer<typeof reorderCategoriesSchema>;

/**
 * The catalogue's manual display order — the WHOLE of it, not a patch.
 *
 * Every non-deleted product id, in the order they should render; the service
 * assigns `Product.sortOrder` from each one's array position, the same
 * "selection order is the value" shape `setCategoriesSchema` and
 * `setAddOnsSchema` already use for THEIR ordered lists. 200 is comfortably
 * above the catalogue sizes this store actually runs — see
 * `docs/superpowers/specs/2026-09-15-storefront-admin-expansion.md` §8 — and
 * exists only as the same kind of sanity ceiling those two schemas already
 * carry, not a real expected size.
 */
export const reorderProductsSchema = z
  .object({
    productIds: z.array(idSchema).min(1).max(200),
  })
  .strict();

export type ReorderProducts = z.infer<typeof reorderProductsSchema>;

/**
 * Which products a product page offers as add-ons. Full replacement, not a
 * patch — ordering is part of the value being set, exactly as it is for
 * categories.
 *
 * CAPPED AT 20, not the 50 categories allow: the storefront strip renders four,
 * and twenty leaves room to rotate without letting one save attach the
 * catalogue to a page.
 *
 * THE UNIQUENESS REFINE IS DELIBERATE and is a small improvement on the
 * categories precedent, which would meet a duplicate as an opaque constraint
 * violation from `createMany`. Named here, it is a 400 an operator can read.
 */
export const setAddOnsSchema = z
  .object({
    /**
     * DEPRECATED, AND ACCEPTED FOR EXACTLY ONE RELEASE.
     *
     * Defaulted rather than required so a caller may send `addOns` alone. It
     * stays only because request schemas are `.strict()` and the dashboard is
     * deployed AFTER the API: an API that accepted just `addOns` would reject
     * every save from the dashboard still running the previous build. Delete it
     * once that deploy has landed.
     */
    addOnIds: z
      .array(idSchema)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, "An add-on may appear only once")
      .default([]),
    /**
     * The same choice, plus which variant each host page pre-selects.
     *
     * `.optional()` rather than `.default([])`: a default is applied at parse
     * time and therefore makes the field REQUIRED in the inferred output type,
     * so every direct caller — the service's own tests included — would have to
     * pass an empty array to mean "nothing". Optional reads identically over
     * HTTP and keeps `SetAddOns` usable from TypeScript.
     */
    addOns: z
      .array(productAddOnInputSchema)
      .max(20)
      .refine(
        (rows) => new Set(rows.map((row) => row.id)).size === rows.length,
        "An add-on may appear only once",
      )
      .optional(),
  })
  .strict();

export type SetAddOns = z.infer<typeof setAddOnsSchema>;

// ---------------------------------------------------------------------------
// Admin listing
// ---------------------------------------------------------------------------

/**
 * The admin catalog list.
 *
 * Differs from the public query in exactly two ways, both of which are
 * privileges rather than conveniences: it can filter by `status` (so drafts are
 * reachable) and it can `includeDeleted` (so a soft-deleted product can be found
 * and restored). Both are absent from the public shape by construction rather
 * than by a runtime check — the public endpoint parses a schema that has no such
 * fields, so a crafted query string cannot reach them.
 */
/**
 * The public listing query plus the display locale.
 *
 * `productListQuerySchema` is `.strict()`, so a request carrying `?locale=en`
 * would be REJECTED by it — the locale has to be a declared member rather than a
 * second, separately-parsed query parameter. Extending preserves strictness, so
 * the privileged filters (`status`, `includeDeleted`) remain absent and
 * therefore unreachable from a public URL.
 *
 * The locale drives name sorting and translation fallback only; it never affects
 * WHICH products are visible.
 */
export const publicProductListQuerySchema = productListQuerySchema
  .extend({ locale: localeSchema.default("es") })
  .strict();

export type PublicProductListQuery = z.infer<typeof publicProductListQuerySchema>;

/**
 * The public ADD-ON listing query.
 *
 * DELIBERATELY NOT `publicProductListQuerySchema` PLUS A FLAG. The add-on
 * audience is chosen by WHICH ROUTE was called, never by a value in the query
 * string: `productListQuerySchema` is `.strict()` and has no member that
 * reaches the visibility filter, and that property is worth more than the code
 * this schema duplicates. A `?listed=false` parameter would hand the customer
 * the axis — and the day "unlisted" comes to mean more than "add-on" (a staged
 * product, a wholesale-only SKU, a retired bundle kept alive for old links),
 * the parameter widens along with it silently, with no code change and no
 * review. A dedicated schema behind a dedicated route pins the meaning on the
 * server, where changing it is an edit somebody has to make on purpose.
 *
 * NARROW ON PURPOSE: `category`, `search` and `sort` are all absent. Add-ons
 * are a short strip rendered on a product page, not a browsable catalogue, so
 * every merchandising knob here would be a filter nobody calls and one more
 * thing a crafted request can probe. Ordering is fixed server-side.
 *
 * `cursor` and `limit` ARE kept, so the response is the same `Paginated` shape
 * the main listing returns. One entity with two differently-shaped list
 * responses is how a client grows two parsers for one thing.
 */
export const publicAddOnListQuerySchema = z
  .object({
    locale: localeSchema.default("es"),
    cursor: idSchema.optional(),
    // A lower ceiling than the main listing's 100: this feeds a strip, and an
    // add-on page of a hundred products is not a request any honest client makes.
    limit: z.coerce.number().int().min(1).max(24).default(12),
  })
  .strict();

export type PublicAddOnListQuery = z.infer<typeof publicAddOnListQuerySchema>;

export const adminProductListQuerySchema = z
  .object({
    status: productStatusSchema.optional(),
    /** Absent means "every kind" — the ordinary product list. `PACK` is how the dedicated packs screen scopes itself to the same underlying list. */
    kind: productKindSchema.optional(),
    category: slugSchema.optional(),
    search: z.string().max(120).optional(),
    sort: z.enum(["newest", "price_asc", "price_desc", "name", "manual"]).default("newest"),
    includeDeleted: z.coerce.boolean().default(false),
    locale: localeSchema.default("es"),
    cursor: idSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(24),
  })
  .strict();

export type AdminProductListQuery = z.infer<typeof adminProductListQuerySchema>;

export const productSlugParamSchema = z.object({ slug: slugSchema }).strict();
export const productIdParamSchema = z.object({ id: idSchema }).strict();
export const variantIdParamSchema = z.object({ variantId: idSchema }).strict();

/**
 * Restrictions are replaced wholesale rather than patched, so "remove the last
 * restricted country" is expressible. A patch-only API makes clearing a list
 * impossible to distinguish from omitting it.
 */
export const setRestrictionsSchema = z
  .object({
    restrictedCountries: z.array(countryCodeSchema).max(250),
  })
  .strict();

export type SetRestrictions = z.infer<typeof setRestrictionsSchema>;
