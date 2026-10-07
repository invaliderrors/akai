import { z } from "zod";
import {
  productKindSchema,
  productStatusSchema,
  taxClassSchema,
} from "./enums";
import {
  countryCodeSchema,
  idSchema,
  isoDateTimeSchema,
  slugSchema,
} from "./common";
import { currencyCodeSchema, nonNegativeMinorSchema, toMinor, type Minor } from "./money";

/**
 * Catalog: products, variants, prices, media, categories, inventory.
 *
 * The central modelling decision: the VARIANT is the sellable unit. It carries
 * the SKU, the price, the weight and the stock. A single-variant product still
 * gets exactly one variant row — special-casing "simple products" now means
 * rewriting every order, cart and inventory query the day a second size ships.
 */

/**
 * A product's copy. The shop is Spanish only, so these are plain fields on the
 * product — spread into `productSchema` and `createProductSchema` below.
 */
export const productCopyShape = {
  name: z.string().min(1).max(200),
  shortDescription: z.string().max(500),
  description: z.string().max(20_000),
};

export const productCopySchema = z.object(productCopyShape).strict();

export type ProductCopy = z.infer<typeof productCopySchema>;

export const mediaAssetSchema = z
  .object({
    id: idSchema,
    url: z.string().url(),
    /** Alt text: user-facing copy like any other. "" when none was written. */
    alt: z.string().max(300),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sortOrder: z.number().int().min(0),
  })
  .strict();

export type MediaAsset = z.infer<typeof mediaAssetSchema>;

export const categorySchema = z
  .object({
    id: idSchema,
    slug: slugSchema,
    name: z.string().min(1).max(120),
    sortOrder: z.number().int().min(0),
  })
  .strict();

export type Category = z.infer<typeof categorySchema>;

/**
 * Public category navigation.
 *
 * `productCount` is the number of products a shopper would actually see under
 * the category — active, non-deleted, with at least one purchasable variant. It
 * is on the LIST shape rather than on `categorySchema` because the count is a
 * property of a query, not of the entity: the same category embedded in a
 * product payload has no meaningful count, and putting one there would invite a
 * per-product aggregate query on every catalog read.
 *
 * A category with a count of zero is still returned. Hiding empty categories
 * makes navigation flicker as stock moves, and the storefront can decide to
 * filter them out with information it already has.
 */
export const categoryListItemSchema = categorySchema
  .extend({
    productCount: z.number().int().min(0),
  })
  .strict();

export type CategoryListItem = z.infer<typeof categoryListItemSchema>;

/**
 * Not paginated, deliberately.
 *
 * A store's category tree is tens of rows, is rendered in full in a nav, and is
 * cached. Cursor-paginating it would force every consumer to loop to build the
 * one thing they always need whole.
 */
export const categoryListResponseSchema = z
  .object({
    items: z.array(categoryListItemSchema),
  })
  .strict();

export type CategoryListResponse = z.infer<typeof categoryListResponseSchema>;

/**
 * A price as the storefront consumes it.
 *
 * EU consumer prices are displayed VAT-INCLUSIVE (Price Indication Directive),
 * so `gross` is the headline figure and `net`/`tax` are carried alongside for
 * the cart breakdown and the invoice. Storing all three avoids recomputing tax
 * at display time, which is how a rendered total drifts from the charged one.
 */
export const priceSchema = z
  .object({
    currency: currencyCodeSchema,
    net: nonNegativeMinorSchema,
    tax: nonNegativeMinorSchema,
    gross: nonNegativeMinorSchema,
    /** Pre-discount reference price. Null when not on sale. */
    compareAtGross: nonNegativeMinorSchema.nullable(),
    taxRateBps: z.number().int().min(0).max(10_000),
  })
  .strict();

export type Price = z.infer<typeof priceSchema>;

/**
 * Stock for one variant.
 *
 * `available` is derived (`onHand - reserved`) and is the ONLY number a
 * customer-facing surface should read: showing `onHand` sells stock that is
 * already inside someone else's in-flight checkout.
 */
export const inventoryItemSchema = z
  .object({
    variantId: idSchema,
    onHand: z.number().int().min(0),
    reserved: z.number().int().min(0),
    available: z.number().int().min(0),
    lowStockThreshold: z.number().int().min(0),
    allowBackorder: z.boolean(),
  })
  .strict();

export type InventoryItem = z.infer<typeof inventoryItemSchema>;

/**
 * A volume price: the unit price once a line reaches `minQuantity`.
 *
 * MIN 2, because quantity one is the variant's own `priceGross` — one place
 * claims the price at qty 1, so the two cannot disagree.
 *
 * THE UNIT PRICE ONLY. A line total and a "−15 %" badge are both derived from
 * this and the base price at render time; storing them would let a rounding
 * change drift the badge away from the money actually charged.
 */
export const priceTierSchema = z
  .object({
    minQuantity: z.number().int().min(2),
    unitPriceGross: nonNegativeMinorSchema,
  })
  .strict();

export type PriceTier = z.infer<typeof priceTierSchema>;

/**
 * The unit price for a given quantity: the highest tier whose threshold the
 * quantity reaches, or the variant's own price when it reaches none.
 *
 * IT LIVES HERE, IN CONTRACTS, AND THAT IS THE POINT. The cart CHARGES from
 * this and the product page QUOTES from it. Two implementations of "which tier
 * applies" is exactly how a page advertises 49,49 € and a checkout takes
 * 54,99 € — so there is one, on the boundary both sides already import, with no
 * dependency beyond zod.
 *
 * Tiers need not arrive sorted: the caller's ordering is a convenience, never a
 * correctness assumption, because a resolver that silently depended on it would
 * be wrong only for whoever forgot.
 */
export function resolveUnitPrice(
  basePriceGross: Minor,
  tiers: readonly PriceTier[],
  quantity: number,
): Minor {
  let price = basePriceGross;
  let threshold = 1;

  for (const tier of tiers) {
    if (tier.minQuantity <= quantity && tier.minQuantity > threshold) {
      price = tier.unitPriceGross;
      threshold = tier.minQuantity;
    }
  }

  return price;
}

/**
 * The one fixed, non-configurable volume-discount schedule "stack discount"
 * ever means. Not a default an admin edits — the whole feature is that
 * nobody types a percentage or a price; see `computeStackDiscountTiers`.
 */
export const STACK_DISCOUNT_SCHEDULE: readonly {
  readonly minQuantity: number;
  readonly percentOff: number;
}[] = [
  { minQuantity: 2, percentOff: 10 },
  { minQuantity: 3, percentOff: 15 },
  { minQuantity: 5, percentOff: 30 },
  { minQuantity: 10, percentOff: 40 },
];

/**
 * Which tile "Mejor precio" pins to when stack discount is enabled.
 *
 * DELIBERATELY NOT "whichever tier is objectively cheapest per unit" — 10
 * units at 40% off is a cheaper unit price than 5 at 30% off, and the badge
 * goes on 5 anyway. That is a merchandising choice the client made explicitly,
 * not a computation this constant tries to reproduce.
 */
export const STACK_DISCOUNT_BEST_PRICE_QUANTITY = 5;

/**
 * The stack-discount schedule, priced against one variant's own gross.
 *
 * THE ONLY PLACE THIS MATH HAPPENS. The API calls this and persists the
 * result, ignoring whatever a client sent — the same trust boundary
 * `updateVariant` already applies to net/tax (always re-derived from gross,
 * never accepted). The dashboard calls the SAME function to preview the
 * schedule before saving, so the preview and the charged price cannot drift —
 * exactly the reasoning `resolveUnitPrice`'s own comment gives for living here.
 */
export function computeStackDiscountTiers(basePriceGross: Minor): PriceTier[] {
  return STACK_DISCOUNT_SCHEDULE.map(({ minQuantity, percentOff }) => ({
    minQuantity,
    unitPriceGross: toMinor(Math.round(basePriceGross * (1 - percentOff / 100))),
  }));
}

export const productVariantSchema = z
  .object({
    id: idSchema,
    productId: idSchema,
    sku: z.string().min(1).max(64),
    /** e.g. "M / Negro". Null for single-variant products. */
    name: z.string().max(120).nullable(),
    /** Option values keyed by option name, e.g. { size: "M", color: "black" }. */
    options: z.record(z.string().max(40), z.string().max(80)),
    price: priceSchema,
    /** Grams. Non-null on physical goods — weight-based shipping depends on it. */
    weightGrams: z.number().int().positive().nullable(),
    inventory: inventoryItemSchema,
    /**
     * The image for THIS variant. Null when the variant has none, which is the
     * normal case for a single-variant product that relies on the gallery.
     *
     * A SINGLE NULLABLE ASSET, not an array. One image per variant is the
     * requirement, and an array would force every reader into an indexed read
     * that `noUncheckedIndexedAccess` types `MediaAsset | undefined` anyway —
     * the same nullability, spelled less honestly, plus a tie to break when a
     * bug puts two rows there.
     *
     * It reuses `mediaAssetSchema` rather than declaring a narrower shape so
     * the storefront fallback is a plain `variant.image ?? primaryMedia(product)`:
     * both operands are already the type every image surface here accepts.
     *
     * THE ALTERNATIVE — `variantId` on `mediaAssetSchema` — WAS REJECTED. That
     * schema is `.strict()` and shared by every media consumer, so it would add
     * a variant-only field, null on the overwhelming majority of rows, to the
     * product gallery; and it would leave "which image belongs to this variant?"
     * as a filter over `product.media` repeated at each call site, which is the
     * join this field exists to remove. Hanging it off the variant also means
     * `publicProductVariantSchema` inherits it, so it reaches the storefront
     * with no second declaration to keep in step.
     *
     * DEFAULTED, NOT MERELY NULLABLE — the same rollout property `listed`
     * documents below, for the same reason, and it was missed here once.
     * `.nullable()` accepts an explicit null; it does NOT accept an ABSENT
     * key. This is a response schema, and the storefront deploys separately
     * from the API, so an API that predates this column omits the key and
     * plain `.nullable()` fails EVERY product against `.strict()` for the
     * length of a deploy — including inside `next build`, which fetches the
     * live API to pre-render, so the deploy does not degrade, it fails.
     */
    image: mediaAssetSchema.nullable().default(null),
    /**
     * Volume pricing, ascending by `minQuantity`. Empty means one price at every
     * quantity, which is every variant that exists today.
     *
     * DEFAULTED FOR THE ROLLOUT REASON `listed`, `image` and `addOns` all state:
     * this is a response schema, the apps deploy separately from the API, and
     * absent must mean what it meant before the table existed.
     */
    priceTiers: z.array(priceTierSchema).default([]),
    isActive: z.boolean(),
    /** Optimistic concurrency token; a stale write is rejected, not merged. */
    version: z.number().int().min(0),
  })
  .strict();

export type ProductVariant = z.infer<typeof productVariantSchema>;

/**
 * A product as returned to the DASHBOARD and the admin surface.
 *
 * This is the WIDE projection and the only product shape in the platform. See
 * `publicProductSchema` below for the narrower variant the customer-facing
 * routes serve — the split exists because this one carries inventory figures
 * that must never reach a browser bundle.
 */
/**
 * An add-on a product's page offers, as an EDGE rather than an entity.
 *
 * IT NAMES A PRODUCT; IT IS NOT ONE. That is what keeps `productSchema`
 * non-recursive. Embedding the add-on's full shape would need `z.lazy` plus a
 * hand-written type annotation — breaking the rule that the type is `z.infer` of
 * the schema — and would let an add-on that has its own add-ons expand a single
 * product payload into a tree. `GET /v1/products` returns up to 100 products, so
 * that tree would be paid for on every catalogue read.
 *
 * `slug` rather than a name because a slug is unique, stable across renames,
 * and enough for an operator to recognise a row.
 */
export const productAddOnRefSchema = z
  .object({
    id: idSchema,
    slug: slugSchema,
    sortOrder: z.number().int().min(0),
    /**
     * The add-on VARIANT this page arrives with already selected, or null.
     *
     * ON THE EDGE, NOT ON THE ADD-ON. "A free tote with this
     * hoodie" is a fact about the PAIR: the same tote may be free beside one
     * product, an upsell beside another, and absent from a third. This table is
     * an explicit join precisely because the edge carries data — `sortOrder`
     * lives here for the same reason.
     *
     * A VARIANT ID, NOT A BOOLEAN. An add-on sold in two sizes has no single
     * thing to pre-select, and "the free one" is not something a flag can name.
     *
     * IT IS A SUGGESTION THE SHOPPER MAY DECLINE. Nothing downstream treats a
     * default as compulsory: the storefront ticks it, and unticking it is an
     * ordinary interaction. A line the customer cannot remove would need the
     * cart to enforce it server-side, which is a different feature.
     *
     * DEFAULTED FOR THE ROLLOUT REASON `listed`, `image`, `addOns` and
     * `priceTiers` all state: this is a response schema, the apps deploy
     * separately from the API, and absent must mean what it meant before the
     * column existed — no default.
     */
    defaultVariantId: idSchema.nullable().default(null),
  })
  .strict();

export type ProductAddOnRef = z.infer<typeof productAddOnRefSchema>;

/**
 * One product this PACK product is made of, as an EDGE — same "names a
 * product, is not one" shape `productAddOnRefSchema` uses, for the same
 * non-recursive reason.
 *
 * UNLIKE `productAddOnRefSchema.defaultVariantId`, `variantId` here is NOT
 * nullable. An add-on's default is a suggestion the shopper may decline; a
 * pack's pinned variant is the sale itself — the admin pins it when building
 * the pack, and the shopper never chooses (recorded decision, spec §1).
 */
export const productPackComponentRefSchema = z
  .object({
    id: idSchema,
    slug: slugSchema,
    sortOrder: z.number().int().min(0),
    variantId: idSchema,
    /**
     * How many of THIS component one pack contains — "3x Tee Black M" as one
     * slot, not three identical slots.
     *
     * DEFAULTED for the same rollout reason `listed`/`offerOnNewProducts`
     * give on `productSchema` below: a response schema field, and the
     * storefront/dashboard deploy separately from the API.
     */
    quantity: z.number().int().min(1).default(1),
  })
  .strict();

export type ProductPackComponentRef = z.infer<typeof productPackComponentRefSchema>;

export const productSchema = z
  .object({
    id: idSchema,
    slug: slugSchema,
    status: productStatusSchema,
    taxClass: taxClassSchema,
    ...productCopyShape,
    /**
     * NO `.min(1)` HERE, DELIBERATELY — and `publicProductSchema` below adds it
     * back for the customer-facing shape.
     *
     * `productInclude` filters variants to `deletedAt: null`, so a product whose
     * variants have all been soft-deleted serialises as `variants: []`. Every
     * soft-deleted product is in exactly that state. Requiring one here made the
     * ADMIN list unparseable the moment it contained such a row — which is what
     * "Include deleted" is FOR — and the dashboard rendered it as a bare "Server
     * error", because `AdminErrorState` maps any non-`AdminApiError` throw to
     * INTERNAL_ERROR.
     *
     * A product with no sellable variant is a real state an operator has to be
     * able to SEE in order to fix. It is only the SHOP that must never meet one,
     * and `publicProductSchema` is where that rule belongs.
     */
    variants: z.array(productVariantSchema),
    media: z.array(mediaAssetSchema),
    categories: z.array(categorySchema),
    /**
     * The add-ons THIS product's page offers, in the operator's order.
     *
     * REFERENCES, NOT PRODUCTS — see `productAddOnRefSchema`. The storefront
     * resolves them in one call to `GET /v1/products/:slug/add-ons`; the
     * presence of the list is what tells it whether to make that call at all,
     * so the overwhelming majority of products that offer none cost no request.
     *
     * DEFAULTED FOR THE ROLLOUT REASON `listed` GIVES BELOW, and the argument is
     * identical: this is a response schema, the apps deploy separately from the
     * API, and migrations run outside the app container. Absent must mean what
     * it meant before the table existed — no add-ons — or every product fails
     * `.strict()` parsing for the length of a deploy.
     */
    addOns: z.array(productAddOnRefSchema).default([]),
    /** ISO country codes this product may NOT ship to. Enforced in cart validation. */
    restrictedCountries: z.array(countryCodeSchema),
    /**
     * Does this product appear in the /products catalogue listing?
     *
     * `false` makes it an ADD-ON: absent from the grid, but still reachable at
     * its own slug and still addable to the cart from another product's page.
     * It is NOT a visibility control and NOT an access control — `status` is
     * what decides whether a product is sellable at all. Read it as "is this
     * merchandised on its own?", nothing more.
     *
     * DEFAULTED, NOT REQUIRED, AND THAT IS THE POINT. This is a response schema,
     * so a default normally masks an API that forgot a field — here it is what
     * makes the rollout ORDER-INDEPENDENT. The column ships in a migration that
     * runs outside the app container, and the storefront and the API deploy
     * separately, so there is a window in which a new client parses an old
     * server's response. Absent must mean what it meant before the field
     * existed: listed. The alternative is every product on the site failing
     * `.strict()` parsing for the length of a deploy.
     */
    listed: z.boolean().default(true),
    /**
     * Does every NEWLY CREATED product offer this one as an add-on?
     *
     * The sticky companion to `POST :id/offer-everywhere`, which only ever
     * attaches to products that already exist. This flag makes the API write a
     * real edge whenever a product is created — so the join table remains the
     * single source of truth and removing the add-on from one product is still
     * just deleting that edge, with no "except these" mechanism to invent.
     *
     * DEFAULTED for the same rollout reason as `listed` above.
     */
    offerOnNewProducts: z.boolean().default(false),
    /** Which of this product's variants those automatic edges pre-select. */
    newProductDefaultVariantId: idSchema.nullable().default(null),
    /**
     * Every variant of this product uses the fixed stack-discount schedule
     * (`computeStackDiscountTiers`) instead of manually-entered `priceTiers`.
     *
     * DEFAULTED for the same rollout reason as `listed`/`offerOnNewProducts`
     * above — a response schema field with no default fails `.strict()`
     * parsing for every product for the length of a deploy.
     */
    stackDiscountEnabled: z.boolean().default(false),
    /**
     * SIMPLE (default) is directly sellable. PACK means this product's own
     * variant carries a display price only — it is never added to a cart or
     * order. See `packComponents` immediately below.
     *
     * DEFAULTED for the same rollout reason as `listed`/`offerOnNewProducts`
     * above.
     */
    kind: productKindSchema.default("SIMPLE"),
    /**
     * The 2-6 products THIS pack is made of, in the admin's chosen order.
     * Empty unless `kind === "PACK"`.
     *
     * REFERENCES, NOT PRODUCTS — see `productPackComponentRefSchema`. The
     * storefront resolves them in one call to
     * `GET /v1/products/:slug/pack-components`, mirroring exactly how
     * `addOns` above is resolved via `:slug/add-ons` — same non-recursive,
     * pay-only-if-you-use-it reasoning.
     *
     * DEFAULTED for the same rollout reason as `addOns` above.
     */
    packComponents: z.array(productPackComponentRefSchema).default([]),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    /** Soft delete. A non-null value hides the product everywhere but preserves order history. */
    deletedAt: isoDateTimeSchema.nullable(),
  })
  .strict();

export type Product = z.infer<typeof productSchema>;

// ---------------------------------------------------------------------------
// The PUBLIC projection — what an unauthenticated visitor may see
// ---------------------------------------------------------------------------

/**
 * Stock, as a shopper may see it.
 *
 * `inventoryItemSchema` says in its own comment that `available` is "the ONLY
 * number a customer-facing surface should read", and then the public catalog
 * route serialised the whole record anyway — publishing `onHand`, `reserved` and
 * `lowStockThreshold` to anyone who curled the endpoint. That is a competitor's
 * free daily read of our sell-through rate and our reorder points, and it leaks
 * how many units are sitting inside other people's in-flight checkouts.
 *
 * This schema is the contract's stated intent made structural: the private
 * fields are not filtered by a mapper someone must remember to call, they are
 * ABSENT FROM THE TYPE, so a public handler that returns the wide shape does not
 * compile.
 *
 * `allowBackorder` stays because it is genuinely customer-facing — it is the
 * difference between "sold out" and "ships in 2 weeks".
 */
export const publicInventorySchema = z
  .object({
    variantId: idSchema,
    available: z.number().int().min(0),
    allowBackorder: z.boolean(),
  })
  .strict();

export type PublicInventory = z.infer<typeof publicInventorySchema>;

/** A variant with its stock narrowed to the customer-safe projection. */
export const publicProductVariantSchema = productVariantSchema
  .extend({
    inventory: publicInventorySchema,
  })
  .strict();

export type PublicProductVariant = z.infer<typeof publicProductVariantSchema>;

/**
 * THE shape served by `GET /v1/products` and `GET /v1/products/:slug`.
 *
 * Identical to `productSchema` except for the narrowed inventory. It is a
 * separate declaration rather than a `.omit()` chain at the call site so that
 * "what does the public see?" is answerable by reading one schema.
 */
export const publicProductSchema = productSchema
  .extend({
    variants: z.array(publicProductVariantSchema).min(1),
  })
  .strict();

export type PublicProduct = z.infer<typeof publicProductSchema>;

/**
 * One resolved component of a pack's "this pack includes…" panel —
 * `GET /v1/products/:slug/pack-components`.
 *
 * WRAPS `PublicProduct` RATHER THAN RETURNING IT BARE, unlike `listAddOnsFor`'s
 * response: an add-on has no pinned variant to single out (the shopper may pick
 * any of them, or none), but a pack component's whole point is that ONE
 * specific variant was pinned by the admin — the storefront must price and
 * label the "this pack includes…" row from THAT variant, never from
 * `product.variants`' own cheapest-first default (`purchasableVariants()`),
 * which is the wrong resolution for this call site and was the exact bug
 * this schema exists to prevent a recurrence of.
 */
export const publicPackComponentSchema = z
  .object({
    product: publicProductSchema,
    /** Which of `product.variants` is pinned — resolve by id, never guess. */
    variantId: idSchema,
    /** How many of this component one pack contains. */
    quantity: z.number().int().min(1).default(1),
    sortOrder: z.number().int().min(0),
  })
  .strict();

export type PublicPackComponent = z.infer<typeof publicPackComponentSchema>;

// ---------------------------------------------------------------------------
// Admin write shapes
// ---------------------------------------------------------------------------

export const createVariantSchema = z
  .object({
    sku: z.string().min(1).max(64),
    name: z.string().max(120).nullable().default(null),
    options: z.record(z.string().max(40), z.string().max(80)).default({}),
    /** Admin supplies GROSS (what the customer sees); the API derives net and tax. */
    priceGross: nonNegativeMinorSchema,
    compareAtGross: nonNegativeMinorSchema.nullable().default(null),
    currency: currencyCodeSchema,
    weightGrams: z.number().int().positive().nullable().default(null),
    /**
     * Volume pricing. Omitted means one price at every quantity, which is what
     * every existing caller sends — so this is additive for them.
     */
    priceTiers: z.array(priceTierSchema).max(10).default([]),
    initialStock: z.number().int().min(0).default(0),
    lowStockThreshold: z.number().int().min(0).default(5),
    allowBackorder: z.boolean().default(false),
  })
  .strict();

export type CreateVariant = z.infer<typeof createVariantSchema>;

/**
 * An add-on as an operator CHOSES it: which product, and optionally which of its
 * variants the page should arrive with selected.
 *
 * DELIBERATELY NOT NAMED `AddOnSelection`. The storefront has a type by that
 * name for what the SHOPPER has ticked; this is what the OPERATOR configured,
 * and the two travel in opposite directions.
 *
 * `defaultVariantId` must name a variant OF `id`. That is checked in the
 * service, which can answer with a named 400, and again by a composite foreign
 * key in the database — because the service is not the only writer a database
 * ever has.
 */
export const productAddOnInputSchema = z
  .object({
    id: idSchema,
    defaultVariantId: idSchema.nullable().default(null),
  })
  .strict();

export type ProductAddOnInput = z.infer<typeof productAddOnInputSchema>;

/**
 * "Offer this add-on on every product page", as a request.
 *
 * A ONE-TIME ATTACH, and the name is chosen to say so. It writes an edge to
 * every product that exists at the moment it runs; products created afterwards
 * do not inherit it. The alternative — a sticky flag unioned in at read time —
 * would make the edge table stop being the whole truth and would need an
 * "except these" mechanism before anyone could remove the add-on from a single
 * product. Re-running this is cheap and idempotent; that exception mechanism
 * would not be.
 *
 * IT APPENDS, NEVER REPLACES. Each host keeps the add-ons it already had, in
 * the order it already had them.
 */
export const offerEverywhereSchema = z
  .object({
    /** Applied to every edge it writes. Must name a variant of the add-on itself. */
    defaultVariantId: idSchema.nullable().default(null),
  })
  .strict();

export type OfferEverywhere = z.infer<typeof offerEverywhereSchema>;

/**
 * What attaching everywhere actually did — three counts, because "done" is not
 * an honest answer when some hosts were deliberately left alone.
 *
 * IN CONTRACTS RATHER THAN THE API's DTO, unlike `setAddOnsSchema`. The
 * dashboard calls this endpoint and has to parse what comes back, and
 * `@nx/enforce-module-boundaries` stops it importing anything from `apps/api`.
 */
export const offerEverywhereResultSchema = z
  .object({
    /** Hosts that gained the edge. */
    attached: z.number().int().min(0),
    /** Hosts that already offered it — re-running changes nothing for them. */
    alreadyPresent: z.number().int().min(0),
    /** Hosts already carrying 20 add-ons, the cap both write paths share. */
    skippedAtCap: z.number().int().min(0),
  })
  .strict();

export type OfferEverywhereResult = z.infer<typeof offerEverywhereResultSchema>;

export const createProductSchema = z
  .object({
    slug: slugSchema,
    status: productStatusSchema.default("DRAFT"),
    taxClass: taxClassSchema.default("STANDARD"),
    ...productCopyShape,
    variants: z.array(createVariantSchema).min(1),
    categoryIds: z.array(idSchema).default([]),
    /**
     * The add-ons this product's page offers, in the order given.
     *
     * SET AT CREATE, exactly as `categoryIds` is, rather than only through the
     * dedicated `PUT :id/add-ons` route. An operator who chose add-ons while
     * building a product should not have to save, reopen and choose again.
     *
     * A REQUEST field, so the `.default([])` here means "omitted means none" —
     * the ordinary meaning of a default. It is NOT the rollout default that
     * `addOns` on the response schema carries, and the two should not be read as
     * the same decision: one spares a caller from restating nothing, the other
     * keeps a new client parsing an old server.
     *
     * Capped at 20 to match `setAddOnsSchema`, so the two write paths cannot
     * disagree about how many a page may offer.
     */
    addOnIds: z.array(idSchema).max(20).default([]),
    /**
     * The same choice as `addOnIds`, plus which variant each one pre-selects.
     *
     * BOTH FIELDS EXIST ON PURPOSE, AND ONLY FOR ONE RELEASE. Request schemas
     * are `.strict()`, so an API that accepted only this would reject every save
     * from a dashboard that has not been redeployed yet — and the dashboard is
     * deployed after the API, always. The service prefers this field and falls
     * back to `addOnIds` when it is empty.
     *
     * FOLLOW-UP, NAMED SO IT IS NOT FORGOTTEN: delete `addOnIds` once the
     * dashboard deploy has landed. Two ways to say the same thing is a defect
     * with a deadline, not a design.
     *
     * `.optional()` RATHER THAN `.default([])`, unlike its neighbours. A default
     * is applied at parse time, which makes the field REQUIRED in the inferred
     * output type — so every direct TypeScript caller would have to pass
     * `addOns: []` to say nothing, including every existing test. Optional says
     * the same thing to an HTTP caller and costs them nothing.
     */
    addOns: z.array(productAddOnInputSchema).max(20).optional(),
    restrictedCountries: z.array(countryCodeSchema).default([]),
    /**
     * Defaults to LISTED, matching the column default, so an admin surface that
     * has not yet grown the toggle keeps creating ordinary catalogue products.
     * `updateProductSchema` below `.partial()`s this, so an update that omits it
     * leaves the flag alone rather than silently re-listing an add-on.
     */
    listed: z.boolean().default(true),
    /**
     * Offer this product as an add-on on every product created from now on.
     *
     * `.optional()` AND NOT `.default(false)`, unlike `listed` beside it: a
     * default is applied at parse time, which makes the field REQUIRED in the
     * inferred output type and forces every existing caller — and every test
     * fixture in four projects — to pass it just to mean "unchanged".
     */
    offerOnNewProducts: z.boolean().optional(),
    /** Must name a variant of THIS product. Checked in the service and by a
     * composite foreign key. */
    newProductDefaultVariantId: idSchema.nullable().optional(),
    /**
     * Every variant of this product uses the fixed stack-discount schedule.
     *
     * `.optional()`, not `.default(false)`, for the exact reason
     * `offerOnNewProducts` above gives.
     */
    stackDiscountEnabled: z.boolean().optional(),
    /**
     * `.optional()`, not `.default("SIMPLE")`, for the exact reason
     * `offerOnNewProducts` above gives.
     */
    kind: productKindSchema.optional(),
    /**
     * The 2-6 products this pack is made of, each with its pinned variant.
     * Required (and 2-6 long) only when `kind === "PACK"` — that cross-field
     * rule is checked by the service, not here, because it also has to hold
     * on update, where `kind` itself is frequently omitted (unchanged).
     *
     * `.optional()`, not `.default([])`: an ordinary SIMPLE product must never
     * be forced to state an empty pack component list just to mean "this is
     * not a pack" — the same reasoning `addOns` above gives for the same
     * shape of field.
     */
    packComponents: z
      .array(
        z
          .object({
            id: idSchema,
            variantId: idSchema,
            /**
             * How many of THIS component one pack contains. Required, like
             * `id`/`variantId` beside it — every entry in this array is a
             * complete component spec, and the admin UI always has a value
             * (defaulting to 1) by the time it submits. The real per-line
             * ceiling (`MAX_LINE_QUANTITY`) is enforced dynamically at
             * add-to-cart time against `quantity × how many packs`, not here
             * — this bound is just a sane input ceiling.
             */
            quantity: z.number().int().min(1).max(20),
          })
          .strict(),
      )
      .min(2)
      .max(6)
      .optional(),
  })
  .strict();

export type CreateProduct = z.infer<typeof createProductSchema>;

export const updateProductSchema = createProductSchema
  .omit({ variants: true })
  .partial()
  .strict();

export type UpdateProduct = z.infer<typeof updateProductSchema>;

/**
 * Catalog sort modes.
 *
 * `best_selling` is backed by an aggregate over PAID order lines, not by a
 * curation flag an admin sets and forgets. The alternative considered — a
 * `featured` boolean — was rejected because a section labelled "Best sellers"
 * that is actually "whatever someone ticked in March" is a claim the store
 * cannot substantiate, and EU consumer law treats ranking claims as
 * representations. A store with no orders yet gets a deterministic zero-unit
 * ordering rather than an error; the section degrades to a stable list rather
 * than to a lie.
 *
 * `manual` is the ONE mode that is a plain admin-set position
 * (`Product.sortOrder`), not derived from anything — the exception the note
 * above is about, deliberately opted into per catalogue page rather than a
 * default nobody can see they turned on. It carries no such representation
 * risk: it makes no claim about popularity or recency, only "this is the
 * order the shop chose to show these in", which needs no evidence behind it.
 */
export const productSortSchema = z.enum([
  "newest",
  "price_asc",
  "price_desc",
  "name",
  "best_selling",
  "manual",
]);

export type ProductSortMode = z.infer<typeof productSortSchema>;

/**
 * Shortest catalog search term that is honoured. Shorter terms are IGNORED —
 * the listing comes back unfiltered — never rejected: one stray letter in the
 * header box must not become an error page. Deliberately NOT a `.min()` on
 * `search` below for that reason. The API (`normaliseSearchTerm` in
 * product-query.ts) and the storefront's results heading both read this one
 * constant, so they cannot disagree about whether a search is active.
 */
export const MIN_SEARCH_TERM_LENGTH = 2;

/** Public catalog filters. Pagination is supplied separately by paginationQuerySchema. */
export const productListQuerySchema = z
  .object({
    category: slugSchema.optional(),
    /**
     * Restrict to one product kind — e.g. `PACK` for a packs-only listing
     * (the home page and `/bundles` use this rather than a manually-applied
     * category tag, so a pack can never fail to appear just because someone
     * forgot to tag it). Omitted means "every kind", same as today.
     */
    kind: productKindSchema.optional(),
    search: z.string().max(120).optional(),
    sort: productSortSchema.default("newest"),
    cursor: idSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(24),
  })
  .strict();

export type ProductListQuery = z.infer<typeof productListQuerySchema>;
