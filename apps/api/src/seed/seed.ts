/**
 * Development / staging database seed.
 *
 * Run with: `pnpm db:seed` (see the README).
 *
 * WHY IT LIVES IN apps/api AND NOT libs/db:
 * seeding an admin account requires hashing a password, and the ONLY correct
 * hasher is `ScryptPasswordHasher` — the same class the login path verifies
 * against, producing the same self-describing `$scrypt$n=..,r=..,p=..$salt$key`
 * format. `libs/db` is `scope:server` but may not import an app, so a seed
 * placed there would have to reimplement the hash. A second implementation of
 * password hashing is exactly the kind of duplication that ends with an admin
 * account nobody can log into, discovered during an incident.
 *
 * IDEMPOTENT. Every write is an upsert keyed on a natural key (email, slug,
 * sku), so running it twice is a no-op rather than a duplicate-key crash or a
 * second catalogue. That matters because the realistic usage is "run it again
 * after I added a product to the seed".
 *
 * REFUSES TO RUN IN PRODUCTION. The admin password below is a known constant;
 * seeding it into a production database creates a publicly-known administrator.
 * The NODE_ENV check is the guard, and it fails closed.
 */

import { PrismaClient, Locale, ProductStatus, Role, TaxClass } from "@prisma/client";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { ScryptPasswordHasher } from "../modules/auth/crypto/scrypt-password-hasher";
import { CATEGORIES } from "./seed-taxonomy";
import { applyShippingSetup, STANDARD_VAT_BPS, TAX_VALID_FROM } from "./shipping-setup";
import {
  isSeedObjectKey,
  parseSeedMediaEnv,
  seedContentType,
  seedMediaBaseUrl,
  seedObjectKey,
  seedPublicUrl,
  uploadSeedObject,
  type SeedFetch,
  type SeedMediaTarget,
} from "./seed-media";

const prisma = new PrismaClient();

/**
 * Development-only credentials. Printed at the end of the run so nobody has to
 * read the source to find them.
 */
const ADMIN_EMAIL = "admin@akai.test";
const ADMIN_PASSWORD = "dev-admin-password-change-me";
const CUSTOMER_EMAIL = "customer@akai.test";
const CUSTOMER_PASSWORD = "dev-customer-password-change-me";

/** Spain's standard VAT rate, in basis points. 21% -> 2100. Clothing is standard-rated. */
const ES_STANDARD_VAT_BPS = STANDARD_VAT_BPS["ES"] ?? 2100;

/**
 * Where the fixture images live on disk.
 *
 * IN THIS APP, not in `apps/storefront/public/`. The seed used to reference the
 * storefront's own static assets and record their URL — which made the API's
 * catalogue depend on the FRONTEND being up on one specific port, re-creating
 * exactly the backend→frontend coupling the WordPress removal existed to
 * eliminate. These files are seed fixtures; they belong to the seed. They are
 * excluded from the production image along with the rest of `src/seed/**`.
 */
const ASSET_DIR = path.join(__dirname, "assets");

/**
 * Split a VAT-INCLUSIVE gross price into net and tax components.
 *
 * Display prices in an EU store are gross (spec §13), and the order line stores
 * net/tax/gross separately. Deriving net from gross — rather than the other way
 * round — is what keeps the advertised price exactly what the customer pays,
 * with the rounding remainder absorbed into tax rather than shifting the total.
 *
 * Integer arithmetic throughout: `Math.round` on a ratio of integers, never a
 * float multiplication of a currency amount.
 */
function splitGross(gross: number, rateBps: number): {
  net: number;
  tax: number;
  gross: number;
} {
  const net = Math.round((gross * 10_000) / (10_000 + rateBps));
  return { net, tax: gross - net, gross };
}

interface SeedVariant {
  readonly sku: string;
  /** Clothing size label, identical in both locales ("M", "One size" is `oneSize`). */
  readonly size: string;
  /** Optional colour, per locale. The `options` key is the English word, lower-cased. */
  readonly color?: { readonly es: string; readonly en: string };
  readonly grossCents: number;
  readonly stock: number;
  /** SHIPPING weight in grams, packaging included. It picks the shipping bracket. */
  readonly weightGrams: number;
}

interface SeedProduct {
  readonly slug: string;
  readonly es: { name: string; short: string; long: string };
  readonly en: { name: string; short: string; long: string };
  readonly variants: readonly SeedVariant[];
  /** Category slugs this product belongs to. Must exist in CATEGORIES. */
  readonly categories: readonly string[];
  /** File names under `ASSET_DIR`. First is the card/hero image. */
  readonly images: readonly string[];
  /**
   * False makes this an add-on rather than a catalogue listing — still fully
   * purchasable and reachable by slug, just not merchandised on `/products`.
   * Defaults true.
   */
  readonly listed?: boolean;
  /** Attach this add-on to every product created FROM NOW ON. Add-ons only. */
  readonly offerOnNewProducts?: boolean;
  /** Which of THIS add-on's own variants those automatic edges pre-select. */
  readonly defaultVariantSku?: string;
}

// `SeedCategory` and `CATEGORIES` live in `./seed-taxonomy` — a plain-data
// module with no top-level side effects — so a script that only needs the
// taxonomy (`seed-categories.ts`) can import it without triggering this
// file's `main()`, which runs unconditionally on import.

const BLACK = { es: "Negro", en: "Black" } as const;
const WHITE = { es: "Blanco", en: "White" } as const;
const OLIVE = { es: "Oliva", en: "Olive" } as const;
const NAVY = { es: "Marino", en: "Navy" } as const;

/** S–XL in one colour, same price — the common shape of a garment's variants. */
function sized(
  skuPrefix: string,
  color: { readonly es: string; readonly en: string } | undefined,
  grossCents: number,
  weightGrams: number,
  stock: readonly [number, number, number, number],
): SeedVariant[] {
  return (["S", "M", "L", "XL"] as const).map((size, index) => ({
    sku: `${skuPrefix}-${size}`,
    size,
    ...(color === undefined ? {} : { color }),
    grossCents,
    stock: stock[index] ?? 0,
    weightGrams,
  }));
}

/**
 * A small PLACEHOLDER streetwear catalogue: garments in S–XL, one of them in two
 * colours (8 variants), a one-size accessory in two colours, and a tote sold as
 * an add-on. Variant count is the dimension most likely to break a UI or a
 * pricing assumption, so the shapes differ on purpose. Replace it with the real
 * catalogue through /admin/products.
 *
 * Prices are integer minor units (cents) — the money rule end to end.
 */
const PRODUCTS: readonly SeedProduct[] = [
  {
    slug: "oversized-tee",
    es: {
      name: "Camiseta Oversize",
      short: "Algodón grueso de 240 g, corte amplio y hombro caído.",
      long: "Camiseta de algodón peinado de 240 g/m² con corte oversize, hombro caído y cuello canalé. Estampado frontal en serigrafía. Lavar del revés a 30 °C.",
    },
    en: {
      name: "Oversized Tee",
      short: "Heavyweight 240 gsm cotton, boxy fit, dropped shoulder.",
      long: "240 gsm combed-cotton tee with a boxy oversized fit, dropped shoulders and a ribbed collar. Screen-printed chest graphic. Wash inside out at 30 °C.",
    },
    variants: [
      ...sized("AK-TEE-BLK", BLACK, 3900, 280, [40, 60, 60, 30]),
      ...sized("AK-TEE-WHT", WHITE, 3900, 280, [30, 50, 50, 20]),
    ],
    categories: ["tops"],
    images: ["oversized-tee-1.png", "oversized-tee-2.png"],
  },
  {
    slug: "box-logo-hoodie",
    es: {
      name: "Sudadera Box Logo",
      short: "Felpa perchada de 400 g con capucha de doble capa.",
      long: "Sudadera con capucha en felpa perchada de 400 g/m², capucha de doble capa, bolsillo canguro y logo bordado en el pecho.",
    },
    en: {
      name: "Box Logo Hoodie",
      short: "400 gsm brushed fleece with a double-layer hood.",
      long: "Hooded sweatshirt in 400 gsm brushed fleece with a double-layer hood, kangaroo pocket and an embroidered chest logo.",
    },
    variants: sized("AK-HOOD-BLK", BLACK, 8900, 750, [20, 35, 35, 15]),
    categories: ["tops"],
    images: ["box-logo-hoodie-1.png"],
  },
  {
    slug: "cargo-pants",
    es: {
      name: "Pantalón Cargo",
      short: "Sarga de algodón con bolsillos laterales y bajo ajustable.",
      long: "Pantalón cargo de sarga de algodón, corte recto relajado, bolsillos laterales con fuelle y bajo ajustable con cordón.",
    },
    en: {
      name: "Cargo Pants",
      short: "Cotton twill with side pockets and an adjustable hem.",
      long: "Cotton-twill cargo pants with a relaxed straight fit, bellowed side pockets and a drawcord-adjustable hem.",
    },
    variants: sized("AK-CARGO-OLV", OLIVE, 9900, 850, [15, 25, 25, 10]),
    categories: ["bottoms"],
    images: ["cargo-pants-1.png"],
  },
  {
    slug: "coach-jacket",
    es: {
      name: "Chaqueta Coach",
      short: "Nailon cortavientos con forro de malla y cierre de corchetes.",
      long: "Chaqueta coach de nailon cortavientos con forro de malla, cierre de corchetes y bajo con cordón. Estampado en la espalda.",
    },
    en: {
      name: "Coach Jacket",
      short: "Windproof nylon, mesh lining, snap-button front.",
      long: "Windproof nylon coach jacket with a mesh lining, snap-button front and drawcord hem. Printed back graphic.",
    },
    // Low stock on XL on purpose: exercises the low-stock UI without selling out.
    variants: sized("AK-COACH-NVY", NAVY, 11900, 650, [10, 18, 18, 4]),
    categories: ["outerwear"],
    images: ["coach-jacket-1.png"],
  },
  {
    slug: "six-panel-cap",
    es: {
      name: "Gorra Seis Paneles",
      short: "Algodón lavado, visera curva y cierre de hebilla.",
      long: "Gorra de seis paneles en algodón lavado con visera curva, ojales bordados y cierre trasero de hebilla metálica. Talla única ajustable.",
    },
    en: {
      name: "Six-Panel Cap",
      short: "Washed cotton, curved brim, buckle strap.",
      long: "Six-panel cap in washed cotton with a curved brim, embroidered eyelets and a metal-buckle back strap. One adjustable size.",
    },
    variants: [
      { sku: "AK-CAP-BLK", size: "One size", color: BLACK, grossCents: 3500, stock: 60, weightGrams: 150 },
      { sku: "AK-CAP-OLV", size: "One size", color: OLIVE, grossCents: 3500, stock: 40, weightGrams: 150 },
    ],
    categories: ["accessories"],
    images: ["six-panel-cap-1.png"],
  },

  // ── ADD-ON ─────────────────────────────────────────────────────────────
  // `listed: false`: fully purchasable, reachable by slug, never merchandised
  // on `/products`. `seedAddOnAttachments()` below attaches it to every LISTED
  // product above (mirroring the admin "offer everywhere" action) and
  // `offerOnNewProducts: true` covers whatever is created after it.
  {
    slug: "canvas-tote",
    es: {
      name: "Bolsa Tote de Lona",
      short: "Lona de algodón de 340 g con asas largas.",
      long: "Bolsa tote de lona de algodón de 340 g/m² con asas largas y estampado frontal. Cabe un portátil de 15 pulgadas.",
    },
    en: {
      name: "Canvas Tote",
      short: "340 gsm cotton canvas with long handles.",
      long: "Tote bag in 340 gsm cotton canvas with long handles and a front print. Fits a 15-inch laptop.",
    },
    variants: [
      { sku: "AK-TOTE-NAT", size: "One size", grossCents: 1500, stock: 200, weightGrams: 200 },
    ],
    categories: ["accessories"],
    images: ["canvas-tote-1.png"],
    listed: false,
    offerOnNewProducts: true,
    // Pre-selected on every host page — a suggestion the shopper may untick.
    defaultVariantSku: "AK-TOTE-NAT",
  },
];

/** The per-locale variant name: the size, or "size / colour" when it has one. */
function variantName(variant: SeedVariant): { es: string; en: string } {
  const size = { es: variant.size === "One size" ? "Talla única" : variant.size, en: variant.size };
  return variant.color === undefined
    ? size
    : { es: `${size.es} / ${variant.color.es}`, en: `${size.en} / ${variant.color.en}` };
}

/** Option values, e.g. {"size":"M","color":"black"} — unique per product. */
function variantOptions(variant: SeedVariant): Record<string, string> {
  return variant.color === undefined
    ? { size: variant.size }
    : { size: variant.size, color: variant.color.en.toLowerCase() };
}

/**
 * Zones, rates and the served countries' STANDARD VAT rates — one definition in
 * `shipping-setup.ts`, shared with `seed-shipping.ts`.
 */
async function seedShipping(): Promise<void> {
  await applyShippingSetup(prisma);
}

/**
 * The navigation taxonomy.
 *
 * FIND-THEN-WRITE, keyed on the LIVE row matching `slug` — not `upsert`.
 * `slug` is unique among live categories only (partial index, see
 * `20260927000100_invariants`), so it is not a unique identifier
 * Prisma's `upsert` can key on. Re-running against a live row is still a
 * no-op past the first run; against one an admin deliberately deleted through
 * the category CRUD screen, it creates a fresh row rather than resurrecting
 * the deleted one.
 */
async function seedCategories(): Promise<void> {
  for (const category of CATEGORIES) {
    const existing = await prisma.category.findFirst({
      where: { slug: category.slug, deletedAt: null },
      select: { id: true },
    });

    if (existing === null) {
      await prisma.category.create({
        data: {
          slug: category.slug,
          name: { es: category.es, en: category.en },
          sortOrder: category.sortOrder,
        },
      });
    } else {
      await prisma.category.update({
        where: { id: existing.id },
        data: {
          name: { es: category.es, en: category.en },
          sortOrder: category.sortOrder,
        },
      });
    }
  }
}

async function seedTaxRates(): Promise<void> {
  // validFrom is part of the natural key, so it is pinned to a constant rather
  // than `now()` — otherwise every run would insert a new rate row and the
  // resolver would see a growing pile of overlapping rates.
  const validFrom = TAX_VALID_FROM;

  for (const taxClass of [TaxClass.STANDARD, TaxClass.REDUCED, TaxClass.ZERO_RATED]) {
    const rateBps =
      taxClass === TaxClass.STANDARD
        ? ES_STANDARD_VAT_BPS
        : taxClass === TaxClass.REDUCED
          ? 1000
          : 0;

    await prisma.taxRate.upsert({
      where: {
        countryCode_taxClass_validFrom: { countryCode: "ES", taxClass, validFrom },
      },
      update: { rateBps },
      create: { countryCode: "ES", taxClass, rateBps, validFrom },
    });
  }
}

async function seedAccounts(): Promise<void> {
  // Cost parameters match .env.example's defaults so a seeded password verifies
  // at the same cost the application uses.
  const hasher = new ScryptPasswordHasher({ memoryKib: 19456, timeCost: 2 });

  const adminHash = await hasher.hash(ADMIN_PASSWORD);
  const customerHash = await hasher.hash(CUSTOMER_PASSWORD);

  await prisma.customer.upsert({
    where: { email: ADMIN_EMAIL },
    update: { role: Role.ADMIN },
    create: {
      email: ADMIN_EMAIL,
      passwordHash: adminHash,
      // Pre-verified: an unverified admin cannot complete a login, which would
      // make the seed produce an account that exists but cannot be used.
      emailVerifiedAt: new Date(),
      firstName: "Akai",
      lastName: "Admin",
      role: Role.ADMIN,
      preferredLocale: Locale.es,
    },
  });

  await prisma.customer.upsert({
    where: { email: CUSTOMER_EMAIL },
    update: {},
    create: {
      email: CUSTOMER_EMAIL,
      passwordHash: customerHash,
      emailVerifiedAt: new Date(),
      firstName: "Ana",
      lastName: "García",
      role: Role.CUSTOMER,
      preferredLocale: Locale.es,
    },
  });
}

async function seedCatalog(publisher: MediaPublisher): Promise<void> {
  for (const product of PRODUCTS) {
    // NOT `upsert`: `slug` is unique among LIVE rows only now (a partial index
    // Prisma's schema language cannot express), so it is no longer a
    // `WhereUniqueInput`. Keyed on the live row deliberately — a soft-deleted
    // product has released its slug, and a seed re-run should make a fresh one
    // rather than resurrect a row somebody deleted on purpose.
    const existingProduct = await prisma.product.findFirst({
      where: { slug: product.slug, deletedAt: null },
      select: { id: true },
    });

    const row =
      existingProduct === null
        ? await prisma.product.create({
            data: {
              slug: product.slug,
              status: ProductStatus.ACTIVE,
              taxClass: TaxClass.STANDARD,
              listed: product.listed ?? true,
              offerOnNewProducts: product.offerOnNewProducts ?? false,
            },
          })
        : await prisma.product.update({
            where: { id: existingProduct.id },
            data: {
              status: ProductStatus.ACTIVE,
              listed: product.listed ?? true,
              offerOnNewProducts: product.offerOnNewProducts ?? false,
            },
          });

    for (const [locale, copy] of [
      [Locale.es, product.es],
      [Locale.en, product.en],
    ] as const) {
      await prisma.productTranslation.upsert({
        where: { productId_locale: { productId: row.id, locale } },
        update: {
          name: copy.name,
          shortDescription: copy.short,
          description: copy.long,
        },
        create: {
          productId: row.id,
          locale,
          name: copy.name,
          shortDescription: copy.short,
          description: copy.long,
        },
      });
    }

    for (const variant of product.variants) {
      const price = splitGross(variant.grossCents, ES_STANDARD_VAT_BPS);

      // Same reason as the product above: `sku` is unique among LIVE variants
      // only, so it is no longer a `WhereUniqueInput`.
      const existingVariant = await prisma.productVariant.findFirst({
        where: { sku: variant.sku, deletedAt: null },
        select: { id: true },
      });

      const variantRow =
        existingVariant === null
          ? await prisma.productVariant.create({
              data: {
                productId: row.id,
                sku: variant.sku,
                name: variantName(variant),
                options: variantOptions(variant),
                currency: "EUR",
                priceNet: price.net,
                priceTax: price.tax,
                priceGross: price.gross,
                taxRateBps: ES_STANDARD_VAT_BPS,
                weightGrams: variant.weightGrams,
                isActive: true,
              },
            })
          : await prisma.productVariant.update({
              where: { id: existingVariant.id },
              data: {
                priceNet: price.net,
                priceTax: price.tax,
                priceGross: price.gross,
              },
            });

      // `onHand` is not blindly overwritten on re-run: doing so would silently
      // undo any stock movement made since the last seed, which is the kind of
      // helpfulness that loses a real adjustment during testing.
      //
      // THE ONE EXCEPTION is a row sitting at zero with nothing reserved. That
      // is not an adjustment worth preserving, it is a dead SKU that makes
      // `POST /v1/cart/items` return OUT_OF_STOCK on every developer database no
      // matter what this file says. A restock is the only write that can turn
      // an unusable seed back into a usable one without a manual truncate.
      const existingStock = await prisma.inventoryItem.findUnique({
        where: { variantId: variantRow.id },
      });

      if (existingStock === null) {
        await prisma.inventoryItem.create({
          data: {
            variantId: variantRow.id,
            onHand: variant.stock,
            reserved: 0,
            lowStockThreshold: 10,
          },
        });
      } else if (existingStock.onHand === 0 && existingStock.reserved === 0) {
        await prisma.inventoryItem.update({
          where: { variantId: variantRow.id },
          data: { onHand: variant.stock },
        });
      }
    }

    // AFTER the variants loop, because the variant this points at has to
    // exist first: `newProductDefaultVariantId` is enforced by a composite FK
    // on (id, newProductDefaultVariantId) -> product_variant(productId, id).
    if (product.defaultVariantSku !== undefined) {
      const defaultVariant = await prisma.productVariant.findFirst({
        where: { sku: product.defaultVariantSku, deletedAt: null },
        select: { id: true },
      });
      if (defaultVariant === null) {
        throw new Error(
          `Product "${product.slug}" names unknown defaultVariantSku "${product.defaultVariantSku}".`,
        );
      }
      await prisma.product.update({
        where: { id: row.id },
        data: { newProductDefaultVariantId: defaultVariant.id },
      });
    }

    await linkCategories(row.id, product);
    await linkMedia(row.id, product, publisher);
  }
}

/**
 * Attach every add-on to every listed product — the seed's own equivalent of
 * the admin "offer everywhere" action, so a fresh database shows the tote on
 * every product page rather than needing a manual
 * per-product admin pass before they mean anything.
 *
 * Scoped to the products THIS SEED manages, not a `prisma.product.findMany()`
 * over the whole database — an admin-created product not in `PRODUCTS` is the
 * admin's own "offer everywhere" click to make, not something a re-run of
 * this script should reach into and change.
 *
 * UPSERTED, so re-running the seed after an operator has deliberately removed
 * an add-on from one product would silently put it back — matching the
 * "an add-on is admin-editable per product" behaviour `attachStickyAddOns`
 * describes.
 */
async function seedAddOnAttachments(): Promise<void> {
  const addOns = PRODUCTS.filter((product) => product.listed === false);
  const hosts = PRODUCTS.filter((product) => product.listed !== false);

  for (const addOn of addOns) {
    const addOnRow = await prisma.product.findFirst({
      where: { slug: addOn.slug, deletedAt: null },
      select: { id: true, newProductDefaultVariantId: true },
    });
    if (addOnRow === null) {
      throw new Error(`Add-on "${addOn.slug}" was not seeded — cannot attach it anywhere.`);
    }

    for (const [index, host] of hosts.entries()) {
      const hostRow = await prisma.product.findFirst({
        where: { slug: host.slug, deletedAt: null },
        select: { id: true },
      });
      if (hostRow === null) {
        throw new Error(`Host product "${host.slug}" was not seeded — cannot attach an add-on to it.`);
      }

      await prisma.productAddOn.upsert({
        where: { productId_addOnId: { productId: hostRow.id, addOnId: addOnRow.id } },
        update: { sortOrder: index, defaultVariantId: addOnRow.newProductDefaultVariantId },
        create: {
          productId: hostRow.id,
          addOnId: addOnRow.id,
          sortOrder: index,
          defaultVariantId: addOnRow.newProductDefaultVariantId,
        },
      });
    }
  }
}

/**
 * Attach the product to its categories.
 *
 * Without this the catalog returned `categories: []` for every product, so the
 * storefront's category chips and filter pills — which derive their options from
 * the products they are filtering — rendered empty. `GET /v1/products?category=…` worked the whole time; there was simply
 * nothing in any category.
 */
async function linkCategories(productId: string, product: SeedProduct): Promise<void> {
  for (const [index, slug] of product.categories.entries()) {
    // `slug` is unique among LIVE categories only (partial index, see
    // `20260927000100_invariants`), so `findUnique` can no longer key
    // on it directly — and a soft-deleted category is correctly no match here
    // anyway; a product should never link to a category the admin deleted.
    const category = await prisma.category.findFirst({ where: { slug, deletedAt: null } });
    if (category === null) {
      // A typo in PRODUCTS should fail the seed loudly rather than quietly
      // producing a product that belongs to nothing.
      throw new Error(
        `Product "${product.slug}" references unknown category "${slug}".`,
      );
    }

    await prisma.productCategory.upsert({
      where: { productId_categoryId: { productId, categoryId: category.id } },
      update: { sortOrder: index },
      create: { productId, categoryId: category.id, sortOrder: index },
    });
  }
}

/**
 * Everything the seed needs to put an object in the bucket.
 *
 * The `fetch` is a field rather than a global reference so the upload path is
 * substitutable, and so this file states its one and only network dependency
 * instead of hiding it inside a helper.
 */
interface MediaPublisher {
  readonly target: SeedMediaTarget;
  readonly fetchImpl: SeedFetch;
}

/**
 * Upload one fixture and return the URL it is readable at.
 *
 * THE UPLOAD HAPPENS FIRST, AND A FAILURE STOPS THE SEED. The alternative —
 * recording the URL and hoping — is what produced media rows pointing at an
 * origin nothing served: `next/image` requests them, the fetch is refused, and
 * because `remotePatterns` matches on hostname the only trace is an
 * `ECONNREFUSED` in the dev-server log while the page renders "successfully"
 * with no images. A seed that cannot publish must say so, at the point of
 * failure, naming the endpoint it tried.
 */
async function publishAsset(
  publisher: MediaPublisher,
  fileName: string,
  objectKey: string,
): Promise<string> {
  const body = await readFile(path.join(ASSET_DIR, fileName));

  try {
    await uploadSeedObject({
      target: publisher.target,
      objectKey,
      body,
      contentType: seedContentType(fileName),
      now: new Date(),
      fetchImpl: publisher.fetchImpl,
    });
  } catch (error: unknown) {
    throw new Error(
      `Could not publish seed image "${fileName}" to the object store at ` +
        `${publisher.target.endpoint} (bucket "${publisher.target.bucket}"). ` +
        `Is the local stack up? \`pnpm docker:up\` starts MinIO and creates the ` +
        `bucket. Cause: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  return seedPublicUrl(publisher.target, objectKey);
}

/**
 * Publish the product's imagery and attach it.
 *
 * Upserted on the derived `objectKey`, which is what makes a re-run idempotent —
 * `media_asset` has no unique constraint to key on, so the seed looks the row up
 * by product + key and updates in place instead of appending a duplicate image
 * on every run. The key is deterministic for the same reason.
 *
 * Dimensions are recorded because `mediaAssetSchema` requires positive integers
 * and `next/image` needs them to reserve layout space. They are the nominal size
 * of the seeded files, not measured — a seed is not the place to decode PNGs.
 */
async function linkMedia(
  productId: string,
  product: SeedProduct,
  publisher: MediaPublisher,
): Promise<void> {
  const currentKeys: string[] = [];

  for (const [index, fileName] of product.images.entries()) {
    const objectKey = seedObjectKey(product.slug, fileName);
    const url = await publishAsset(publisher, fileName, objectKey);
    currentKeys.push(objectKey);

    const existing = await prisma.mediaAsset.findFirst({
      where: { productId, objectKey },
    });

    const data = {
      url,
      alt: { es: product.es.name, en: product.en.name },
      width: 1200,
      height: 1200,
      sortOrder: index,
    };

    if (existing === null) {
      await prisma.mediaAsset.create({ data: { ...data, productId, objectKey } });
    } else {
      await prisma.mediaAsset.update({ where: { id: existing.id }, data });
    }
  }

  await pruneStaleSeedMedia(productId, currentKeys);
}

/**
 * Delete media rows this seed used to write and no longer does.
 *
 * NOT housekeeping. The previous seed keyed its rows on `seed/carousel/…` and
 * pointed their URL at the storefront's own dev server; without this, a re-run
 * would leave those rows in place and every developer database would show two
 * images per product, one of which never loads. Upserting cannot remove a row it
 * no longer knows about — only an explicit prune can.
 *
 * SCOPED TO THE SEED'S OWN NAMESPACE (`isSeedObjectKey`). An asset uploaded
 * through `POST /v1/admin/media/upload-url` lives under `products/…` and is
 * never touched: re-seeding a staging database must not delete real imagery.
 */
async function pruneStaleSeedMedia(
  productId: string,
  currentKeys: readonly string[],
): Promise<void> {
  const rows = await prisma.mediaAsset.findMany({
    where: { productId },
    select: { id: true, objectKey: true },
  });

  const staleIds = rows
    .filter((row) => isSeedObjectKey(row.objectKey) && !currentKeys.includes(row.objectKey))
    .map((row) => row.id);

  if (staleIds.length > 0) {
    await prisma.mediaAsset.deleteMany({ where: { id: { in: staleIds } } });
  }
}

async function main(): Promise<void> {
  if (process.env["NODE_ENV"] === "production") {
    throw new Error(
      "Refusing to seed a production database: this script creates an administrator " +
        "with a password that is published in the repository.",
    );
  }

  // BEFORE any write. The object-store configuration is validated up front so a
  // misconfigured seed fails in the first millisecond rather than half way
  // through the catalogue, with tax rates and accounts already committed and
  // products missing their imagery.
  const publisher: MediaPublisher = {
    target: parseSeedMediaEnv(process.env),
    fetchImpl: (url, init) => fetch(url, init),
  };

  await seedTaxRates();
  // Zones BEFORE the catalog only for readability; they are independent. What is
  // NOT optional is that they exist at all: without a zone covering ES, a fully
  // valid checkout for a Madrid address fails with "We do not ship to ES", and
  // the funnel is unusable end to end regardless of any storefront work.
  await seedShipping();
  await seedCategories();
  await seedAccounts();
  await seedCatalog(publisher);
  await seedAddOnAttachments();

  const products = await prisma.product.count();
  const variants = await prisma.productVariant.count();
  const categories = await prisma.category.count();
  const zones = await prisma.shippingZone.count();
  const rates = await prisma.shippingRate.count();
  const media = await prisma.mediaAsset.count();

  process.stdout.write(
    [
      "",
      "Seed complete.",
      `  products   : ${String(products)}`,
      `  variants   : ${String(variants)}`,
      `  categories : ${String(categories)}`,
      `  media      : ${String(media)} (published to ${seedMediaBaseUrl(publisher.target)})`,
      `  ship zones : ${String(zones)} (${String(rates)} rates)`,
      "",
      "  Admin    : " + ADMIN_EMAIL + " / " + ADMIN_PASSWORD,
      "  Customer : " + CUSTOMER_EMAIL + " / " + CUSTOMER_PASSWORD,
      "",
      "  NOTE: the admin account has no TOTP enrolled. Spec §8 makes 2FA mandatory",
      "  for ADMIN, so /admin/* routes will refuse it until enrolment is completed",
      "  through the dashboard. That is deliberate, not a broken seed.",
      "",
    ].join("\n"),
  );
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `\nSeed failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
