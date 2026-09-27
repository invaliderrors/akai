import { z } from "zod";
import { Prisma } from "@akai/db";
import {
  localeSchema,
  type Batch,
  type Category,
  type InventoryItem,
  type MediaAsset,
  type Price,
  type Product,
  type ProductTranslation,
  type ProductVariant,
  type PublicBatch,
  type PublicProduct,
} from "@akai/contracts";
import { toMinor } from "@akai/money";

/**
 * Prisma row → the wire shape in @akai/contracts.
 *
 * This file exists because those two shapes are NOT the same and must not be
 * allowed to become the same by accident. Returning Prisma rows straight from a
 * controller is the single most common way a schema-internal field ends up
 * public — here that would be `providerProductId`, `providerVariantId`, the raw
 * `onHand` count and the S3 `objectKey`. Every one of them is dropped below,
 * and `product.mapper.test.ts` asserts their absence rather than trusting this
 * comment.
 */

// ---------------------------------------------------------------------------
// Json column narrowing
// ---------------------------------------------------------------------------

/**
 * Prisma types Json columns as `Prisma.JsonValue`, which is a union that
 * includes `null`, arrays and nested objects. Casting it to
 * `Record<string,string>` would typecheck and then explode at the first render
 * on a legacy row — so every Json column is PARSED, not cast. This is the
 * "unknown + narrowing for external data" rule applied to our own database,
 * which is external the moment a migration, a seed script or a manual UPDATE
 * can write to it.
 */
const localizedTextSchema = z.record(localeSchema, z.string());
const optionsSchema = z.record(z.string(), z.string());

/**
 * Narrow a Json column, falling back to an empty value rather than throwing.
 *
 * DELIBERATE ASYMMETRY WITH THE REQUEST BOUNDARY: an invalid request body must
 * fail loudly (400), but an unexpected shape in one product's `options` column
 * must not take down the entire catalog listing for every visitor. A malformed
 * row degrades to "no options" and stays purchasable; the alternative is a 500
 * on the storefront home page caused by one bad row an admin can no longer
 * reach, because the admin UI is served by the same failing query.
 */
function narrowJson<T>(value: Prisma.JsonValue | null, schema: z.ZodType<T>, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

// ---------------------------------------------------------------------------
// Hydration shape
// ---------------------------------------------------------------------------

/**
 * The include set every product read uses.
 *
 * Declared once and shared so the mapper's input type and the query's actual
 * selection cannot drift — with two copies, adding an include to one query
 * produces a type that claims a relation the other query never loaded, and the
 * mapper reads `undefined` at runtime with no compile error.
 */
export const productInclude = {
  translations: true,
  // `variantId: null` PARTITIONS the one media table, in the query rather than
  // in the mapper. A variant image and a gallery image are rows on the same
  // table, so without this filter every variant image would also appear in the
  // product gallery — on the storefront hero rail and in the admin gallery
  // list. Doing it here means the two sets cannot leak into each other by
  // someone forgetting a `.filter()` downstream.
  media: { where: { variantId: null }, orderBy: { sortOrder: "asc" } },
  categories: { include: { category: true }, orderBy: { sortOrder: "asc" } },
  // The add-ons this product's page offers, in the operator's order.
  //
  // SOFT-DELETED TARGETS ARE FILTERED HERE; STATUS IS NOT. A deleted product is
  // gone and an edge pointing at one is a row the mapper would need an opinion
  // about on every read. `status` is deliberately left alone: it changes without
  // anyone touching the edge, and a reference that resolves to nothing should
  // shorten the strip at resolution time rather than silently rewrite what the
  // operator chose.
  addOns: {
    where: { addOn: { deletedAt: null } },
    orderBy: { sortOrder: "asc" },
    include: { addOn: { select: { id: true, slug: true } } },
  },
  // The 2-6 products THIS pack is made of. Same soft-deleted-target filter as
  // addOns above, for the same reason. Empty for every SIMPLE product.
  packComponents: {
    where: { component: { deletedAt: null } },
    orderBy: { sortOrder: "asc" },
    include: {
      component: { select: { id: true, slug: true, status: true } },
      // The PINNED variant's sellability and stock — the only inputs to a
      // pack's public availability (`derivePackAvailability`). Selected
      // narrowly: the private inventory numbers never leave this module.
      componentVariant: {
        select: {
          isActive: true,
          deletedAt: true,
          inventory: { select: { onHand: true, reserved: true, allowBackorder: true } },
        },
      },
    },
  },
  variants: {
    where: { deletedAt: null },
    orderBy: { createdAt: "asc" },
    include: {
      inventory: true,
      // At most one row: `@@unique([variantId])` on MediaAsset makes this a
      // to-one relation, so Prisma types it `MediaAsset | null` and there is no
      // ordering to specify and no tie to break.
      image: true,
      // ASCENDING, so the resolver and the page both read them in the order a
      // shopper sees them and neither has to sort.
      priceTiers: { orderBy: { minQuantity: "asc" } },
      // Newest tested lot only. The contract exposes ONE batch (the one that
      // would ship), not the full lot history, which is an admin concern.
      batches: { orderBy: { testedAt: "desc" }, take: 1 },
    },
  },
} satisfies Prisma.ProductInclude;

export type HydratedProduct = Prisma.ProductGetPayload<{ include: typeof productInclude }>;
export type HydratedVariant = HydratedProduct["variants"][number];

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toIso(value: Date): string {
  return value.toISOString();
}

function mapPrice(variant: HydratedVariant): Price {
  return {
    currency: variant.currency,
    // Minor is a branded type: these go through toMinor() rather than a cast,
    // so a non-integer that somehow reached the column throws here instead of
    // silently propagating a float into a cart total.
    net: toMinor(variant.priceNet),
    tax: toMinor(variant.priceTax),
    gross: toMinor(variant.priceGross),
    compareAtGross:
      variant.compareAtGross === null ? null : toMinor(variant.compareAtGross),
    taxRateBps: variant.taxRateBps,
  };
}

/**
 * Stock, as a customer-safe shape.
 *
 * `available = onHand - reserved`, floored at zero, and it is the ONLY figure
 * that reaches a buying surface. Publishing `onHand` would advertise units that
 * are already inside someone else's in-flight checkout, which is how a store
 * oversells without any race condition at all — just by telling the truth about
 * the wrong number.
 *
 * A variant with no inventory row is treated as zero stock, not unlimited. The
 * missing-row case means "never stocked", and defaulting it to purchasable is
 * the kind of assumption that only surfaces as an unfulfillable order.
 */
function mapInventory(variant: HydratedVariant): InventoryItem {
  const inventory = variant.inventory;

  if (inventory === null) {
    return {
      variantId: variant.id,
      onHand: 0,
      reserved: 0,
      available: 0,
      lowStockThreshold: 0,
      allowBackorder: false,
    };
  }

  return {
    variantId: variant.id,
    onHand: inventory.onHand,
    reserved: inventory.reserved,
    available: Math.max(0, inventory.onHand - inventory.reserved),
    lowStockThreshold: inventory.lowStockThreshold,
    allowBackorder: inventory.allowBackorder,
  };
}

/**
 * `objectKey` is a private-bucket key (`S3_BUCKET_COA`), never public — the
 * caller is trusted to turn it into a short-lived SIGNED url, never to echo it
 * back or build a bare `${endpoint}/${bucket}/${key}` string the way public
 * media does. Defaults to "no signer configured" (always `null`), which is
 * exactly today's behaviour for every existing caller that does not pass one.
 */
type CoaUrlSigner = (objectKey: string) => string | null;
const NO_COA_SIGNER: CoaUrlSigner = () => null;

function signOptional(objectKey: string | null, sign: CoaUrlSigner): string | null {
  return objectKey === null ? null : sign(objectKey);
}

function mapBatch(variant: HydratedVariant, signCoaUrl: CoaUrlSigner): Batch | null {
  const [batch] = variant.batches;
  if (batch === undefined) {
    return null;
  }

  return {
    id: batch.id,
    lotCode: batch.lotCode,
    // Decimal(5,2) → number. Purity is a measurement, not money, so a float is
    // correct here; the integer-minor-units rule governs money only.
    purityPercent: batch.purityPercent.toNumber(),
    testedAt: toIso(batch.testedAt),
    testMethod: batch.testMethod,
    // NOT the raw S3 key, ever — only what `signCoaUrl` returns for it. A COA
    // not yet uploaded (`coaObjectKey: null`) stays null with no call at all.
    coaUrl: batch.coaObjectKey === null ? null : signCoaUrl(batch.coaObjectKey),
    expiresAt: batch.expiresAt === null ? null : toIso(batch.expiresAt),
  };
}

export function mapVariant(
  variant: HydratedVariant,
  signCoaUrl: CoaUrlSigner = NO_COA_SIGNER,
): ProductVariant {
  const name = variant.name === null ? null : narrowJson(variant.name, localizedTextSchema, {});

  return {
    id: variant.id,
    productId: variant.productId,
    sku: variant.sku,
    name,
    options: narrowJson(variant.options, optionsSchema, {}),
    price: mapPrice(variant),
    weightGrams: variant.weightGrams,
    inventory: mapInventory(variant),
    batch: mapBatch(variant, signCoaUrl),
    // Same wire shape as a gallery image, and objectKey is dropped by the same
    // mapper — a variant image is not a different kind of asset, only a
    // differently-scoped one.
    image: variant.image === null ? null : mapMedia(variant.image),
    priceTiers: variant.priceTiers.map((tier) => ({
      minQuantity: tier.minQuantity,
      unitPriceGross: toMinor(tier.unitPriceGross),
    })),
    isActive: variant.isActive,
    version: variant.version,
    // providerVariantId is deliberately NOT mapped.
  };
}

function mapTranslation(
  row: HydratedProduct["translations"][number],
): ProductTranslation {
  return {
    locale: row.locale,
    name: row.name,
    shortDescription: row.shortDescription,
    description: row.description,
  };
}

/**
 * One media row → the wire shape, for BOTH scopes.
 *
 * The parameter is the row type, not `HydratedProduct["media"][number]`, so the
 * gallery and the variant image cannot drift into two mappers — and there is
 * exactly one place where `objectKey` is dropped.
 */
function mapMedia(row: Prisma.MediaAssetGetPayload<Record<string, never>>): MediaAsset {
  return {
    id: row.id,
    url: row.url,
    alt: narrowJson(row.alt, localizedTextSchema, {}),
    width: row.width,
    height: row.height,
    sortOrder: row.sortOrder,
    // objectKey is deliberately NOT mapped.
  };
}

function mapCategory(row: HydratedProduct["categories"][number]): Category {
  return {
    id: row.category.id,
    slug: row.category.slug,
    name: narrowJson(row.category.name, localizedTextSchema, {}),
    sortOrder: row.sortOrder,
  };
}

/**
 * Map a hydrated row to the public/admin product shape.
 *
 * `visibleVariants` lets the caller decide which variants a given audience may
 * see (public reads pass active-only, admin reads pass all) WITHOUT a second
 * mapper. The alternative — a boolean `isAdmin` flag threaded into the mapper —
 * puts an authorisation decision inside a formatting function, which is where
 * such decisions go to be forgotten.
 */
/**
 * Narrow a mapped product to the PUBLIC projection.
 *
 * `inventoryItemSchema` states in its own comment that `available` is "the ONLY
 * number a customer-facing surface should read", and the public catalog route
 * then serialised the whole record — publishing `onHand`, `reserved` and
 * `lowStockThreshold` to anyone who curled it. That is a free daily read of our
 * sell-through rate and our reorder points, and it discloses how many units sit
 * inside other people's in-flight checkouts.
 *
 * This runs on top of `mapProduct` rather than being a second mapper. One
 * hydration shape, one place where a Prisma row becomes a wire shape, and a
 * projection applied afterwards — the alternative (a `public: boolean` flag
 * threaded into `mapProduct`) puts an authorisation decision inside a formatting
 * function, which is where such decisions go to be forgotten.
 *
 * The narrowing is real, not a type assertion: a fresh inventory object is built
 * with three fields, so the private numbers are absent from the JSON as well as
 * from the type.
 */
export function toPublicProduct(
  product: Product,
  packAvailability: PackAvailability | null = null,
): PublicProduct {
  // The admin's switch and the signed URL are taken OUT of the spread, so
  // neither can reach the JSON; what remains of them is one derived boolean.
  const { showCoa, coaUrl, ...shared } = product;
  return {
    ...shared,
    // Offered exactly when a file is uploaded AND the admin switched it on.
    // `coaUrl` is non-null exactly when the row has an object key and the
    // caller passed a signer — every public read in `ProductsService` does
    // (`toPublic`). Never the key, never the URL: the storefront links to the
    // stable `GET /v1/products/:slug/coa` redirect, which signs at click time.
    hasCoa: showCoa && coaUrl !== null,
    variants: product.variants.map((variant) => ({
      ...variant,
      batch: toPublicBatch(variant.batch),
      inventory:
        packAvailability === null
          ? {
              variantId: variant.inventory.variantId,
              available: variant.inventory.available,
              // Genuinely customer-facing: the difference between "sold out"
              // and "ships in two weeks".
              allowBackorder: variant.inventory.allowBackorder,
            }
          : {
              variantId: variant.inventory.variantId,
              available: packAvailability.available,
              allowBackorder: packAvailability.allowBackorder,
            },
    })),
  };
}

/**
 * The shopper-safe batch: everything but the signed `coaUrl`. A one-hour
 * signed URL embedded in an ISR-cached page is a dead link waiting to happen,
 * and the certificate the shop offers is the PRODUCT's anyway (see `hasCoa`
 * above) — a lot's own certificate is admin data.
 *
 * Built field by field rather than by spreading and deleting, so the signed
 * URL is absent from the JSON as well as from the type.
 */
function toPublicBatch(batch: Batch | null): PublicBatch | null {
  if (batch === null) {
    return null;
  }
  return {
    id: batch.id,
    lotCode: batch.lotCode,
    purityPercent: batch.purityPercent,
    testedAt: batch.testedAt,
    testMethod: batch.testMethod,
    expiresAt: batch.expiresAt,
  };
}

/** How many of a PACK can be sold right now, derived from its components. */
export interface PackAvailability {
  readonly available: number;
  readonly allowBackorder: boolean;
}

/**
 * A PACK's customer-facing stock: `min over components of
 * floor(available_c / quantity_c)`. `null` for a SIMPLE product.
 *
 * WHY THE PACK'S OWN INVENTORY ROW IS NOT THE ANSWER. The cart never checks
 * it: `CartService.addPack` checks each COMPONENT at `quantity x packs`
 * against `onHand - reserved` (spec §1, strict per-component stock). Publishing
 * the pack variant's own row told the shopper "in stock" about a pack the cart
 * then refused (spec 2026-09-24 §11, cause 2). Publishing THIS figure on the
 * pack's variant means every surface that already reads
 * `variant.inventory` — the PDP panel, the card, the JSON-LD offer — agrees
 * with the cart without being taught what a pack is.
 *
 * Mirrors the cart's rules exactly: a missing inventory row is ZERO (fail
 * closed), a component that is not sellable (inactive or deleted variant,
 * non-ACTIVE product) makes the pack unsellable, and a backorderable
 * component does not constrain. Only when EVERY component is backorderable is
 * the pack itself backorderable.
 */
export function derivePackAvailability(product: HydratedProduct): PackAvailability | null {
  if (product.kind !== "PACK") {
    return null;
  }
  const soldOut: PackAvailability = { available: 0, allowBackorder: false };
  if (product.packComponents.length === 0) {
    return soldOut;
  }

  let constrained: number | null = null;
  for (const edge of product.packComponents) {
    const variant = edge.componentVariant;
    if (
      edge.component.status !== "ACTIVE" ||
      !variant.isActive ||
      variant.deletedAt !== null
    ) {
      return soldOut;
    }
    const inventory = variant.inventory;
    if (inventory !== null && inventory.allowBackorder) {
      continue;
    }
    const available =
      inventory === null ? 0 : Math.max(0, inventory.onHand - inventory.reserved);
    const packs = Math.floor(available / Math.max(1, edge.quantity));
    constrained = constrained === null ? packs : Math.min(constrained, packs);
  }

  return constrained === null
    ? { available: 0, allowBackorder: true }
    : { available: constrained, allowBackorder: false };
}

export function mapProduct(
  product: HydratedProduct,
  options: { readonly activeVariantsOnly: boolean },
  signCoaUrl: CoaUrlSigner = NO_COA_SIGNER,
): Product {
  const variants = options.activeVariantsOnly
    ? product.variants.filter((variant) => variant.isActive)
    : product.variants;

  return {
    id: product.id,
    slug: product.slug,
    status: product.status,
    taxClass: product.taxClass,
    translations: product.translations.map(mapTranslation),
    variants: variants.map((variant) => mapVariant(variant, signCoaUrl)),
    media: product.media.map(mapMedia),
    categories: product.categories.map(mapCategory),
    addOns: product.addOns.map((edge) => ({
      id: edge.addOn.id,
      slug: edge.addOn.slug,
      sortOrder: edge.sortOrder,
      // THE OPERATOR'S CHOICE, AS STORED — not filtered against the variant's
      // current state. Checking whether the default is still purchasable would
      // mean joining the add-on's variants on EVERY catalogue read, and
      // `GET /v1/products` returns up to 100 products each carrying up to 20
      // add-ons. The composite foreign key already guarantees the variant
      // belongs to this add-on; whether it is sellable TODAY is a question the
      // storefront answers for free, because `fetchProductAddOns` has already
      // loaded those products in full. The admin surface needs the raw value
      // regardless, to show what was actually configured.
      defaultVariantId: edge.defaultVariantId,
    })),
    restrictedCountries: product.restrictedCountries,
    listed: product.listed,
    // Both plain scalars. The composite foreign key that guarantees the default
    // variant belongs to THIS product lives in SQL, not in the Prisma schema —
    // modelling it would mean putting `Product.id` into a relation's `fields`.
    offerOnNewProducts: product.offerOnNewProducts,
    newProductDefaultVariantId: product.newProductDefaultVariantId,
    stackDiscountEnabled: product.stackDiscountEnabled,
    kind: product.kind,
    packComponents: product.packComponents.map((edge) => ({
      id: edge.component.id,
      slug: edge.component.slug,
      sortOrder: edge.sortOrder,
      // UNLIKE addOns.defaultVariantId above, this is never null — the
      // composite foreign key on the row guarantees it belongs to
      // `edge.component`, and its own doc comment records why it is required
      // rather than advisory.
      variantId: edge.componentVariantId,
      quantity: edge.quantity,
    })),
    form: product.form,
    showCoa: product.showCoa ?? false,
    // Signed fresh on every read, like a batch's `coaUrl`, so the dashboard
    // always links to the CURRENT file. `toPublicProduct` strips it.
    // `?? null` rather than `=== null`: a hydrated row built by hand (the
    // service tests' fixtures predate the column) must read as "no file",
    // never be handed to the signer as `undefined`.
    coaUrl: signOptional(product.coaObjectKey ?? null, signCoaUrl),
    createdAt: toIso(product.createdAt),
    updatedAt: toIso(product.updatedAt),
    deletedAt: product.deletedAt === null ? null : toIso(product.deletedAt),
    // providerProductId and hygieneExempt are deliberately NOT mapped:
    // the first is an internal sync detail, the second is consumed by the
    // returns module server-side and is not a storefront concern.
  };
}
