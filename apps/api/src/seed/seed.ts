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
import { FREE_SHIPPING_THRESHOLD_MINOR } from "./free-shipping-threshold";
import {
  EU_ZONE_COUNTRIES,
  EU_ZONE_NAME,
  INPOST_INTERNATIONAL_MAPPING,
  INPOST_NATIONAL_MAPPING,
  INPOST_RATE_EN,
  IRELAND_ZONE_COUNTRIES,
  IRELAND_ZONE_NAME,
  IRELAND_ZONE_SORT_ORDER,
  type RateMapping,
  SPAIN_ZONE_NAME,
  UPS_INTERNATIONAL_MAPPING,
  UPS_NATIONAL_MAPPING,
} from "./sendcloud-shipping-plan";
import { UPS_RATE_NAME, UPS_RATE_PRICE_GROSS } from "./ups-replaces-dhl-plan";
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

/** Spain's standard VAT rate, in basis points. 21% -> 2100. */
const ES_STANDARD_VAT_BPS = 2100;

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
 * The standard VAT rate of every country a seeded shipping zone serves.
 *
 * REQUIRED, not decorative: `PrismaShippingTaxResolver` THROWS when a served
 * destination has no STANDARD rate — deliberately, since defaulting shipping to
 * 0% is an invisible under-remittance. A seeded zone without a matching rate row
 * would therefore make checkout fail with a configuration error rather than a
 * shipping one, which is a confusing way to discover a seed gap.
 */
const ZONE_VAT_BPS: Readonly<Record<string, number>> = {
  ES: ES_STANDARD_VAT_BPS,
  PT: 2300,
  FR: 2000,
  DE: 1900,
  IT: 2200,
  NL: 2100,
  BE: 2100,
  IE: 2300,
};

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
  readonly nameEs: string;
  readonly nameEn: string;
  readonly grossCents: number;
  readonly stock: number;
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
   * Defaults true, so every existing entry keeps today's behaviour untouched.
   */
  readonly listed?: boolean;
  /** Attach this add-on to every product created FROM NOW ON. Add-ons only. */
  readonly offerOnNewProducts?: boolean;
  /** Which of THIS add-on's own variants those automatic edges pre-select. */
  readonly defaultVariantSku?: string;
}

// `SeedCategory` and `CATEGORIES` now live in `./seed-taxonomy` — a plain-data
// module with no top-level side effects — so a script that only needs the
// taxonomy (`seed-categories.ts`) can import it without triggering this
// file's `main()`, which runs unconditionally on import. See that module's
// doc comment.

/**
 * A small but REPRESENTATIVE catalogue: one single-variant product and two
 * multi-variant ones. Variant count is the dimension most likely to break a UI
 * or a pricing assumption, so a seed where every product looks the same is a
 * seed that proves very little.
 *
 * Prices are integer minor units (cents) — the money rule end to end.
 */
const PRODUCTS: readonly SeedProduct[] = [
  {
    slug: "magnesium-bisglycinate",
    es: {
      name: "Bisglicinato de Magnesio",
      short: "Magnesio de alta absorción, 200 mg por dosis.",
      long: "Bisglicinato de magnesio totalmente quelado para una absorción superior y una tolerancia digestiva excelente. Cada lote se analiza por HPLC y el certificado de análisis acompaña a cada pedido.",
    },
    en: {
      name: "Magnesium Bisglycinate",
      short: "High-absorption magnesium, 200 mg per serving.",
      long: "Fully chelated magnesium bisglycinate for superior absorption and excellent digestive tolerance. Every batch is HPLC-tested and the certificate of analysis ships with each order.",
    },
    variants: [
      {
        sku: "AK-MAG-120",
        nameEs: "120 cápsulas",
        nameEn: "120 capsules",
        grossCents: 2495,
        stock: 140,
        weightGrams: 180,
      },
      {
        sku: "AK-MAG-240",
        nameEs: "240 cápsulas",
        nameEn: "240 capsules",
        grossCents: 4290,
        stock: 65,
        weightGrams: 330,
      },
    ],
    categories: ["suministros", "longevidad"],
    images: ["magnesium-bisglycinate-1.png", "magnesium-bisglycinate-2.png"],
  },
  {
    slug: "creatine-monohydrate",
    es: {
      name: "Creatina Monohidrato",
      short: "Creatina micronizada Creapure®, 5 g por dosis.",
      long: "Creatina monohidrato micronizada de grado farmacéutico. Sin aditivos, sin excipientes y sin sabor. Pureza verificada por LC-MS en cada lote.",
    },
    en: {
      name: "Creatine Monohydrate",
      short: "Micronised Creapure® creatine, 5 g per serving.",
      long: "Pharmaceutical-grade micronised creatine monohydrate. No additives, no excipients, unflavoured. Purity verified by LC-MS on every batch.",
    },
    variants: [
      {
        sku: "AK-CRE-300",
        nameEs: "300 g",
        nameEn: "300 g",
        grossCents: 1990,
        stock: 210,
        weightGrams: 360,
      },
      {
        sku: "AK-CRE-1000",
        nameEs: "1 kg",
        nameEn: "1 kg",
        grossCents: 4990,
        stock: 48,
        weightGrams: 1080,
      },
    ],
    categories: ["miociencia", "bundles"],
    images: ["creatine-monohydrate-1.png", "creatine-monohydrate-2.png"],
  },
  {
    slug: "omega-3-triglyceride",
    es: {
      name: "Omega-3 Triglicérido",
      short: "EPA/DHA en forma de triglicérido reesterificado.",
      long: "Aceite de pescado en forma de triglicérido reesterificado, con 750 mg de EPA y 500 mg de DHA por dosis. Destilado molecularmente y analizado para metales pesados.",
    },
    en: {
      name: "Omega-3 Triglyceride",
      short: "EPA/DHA in re-esterified triglyceride form.",
      long: "Fish oil in re-esterified triglyceride form, delivering 750 mg EPA and 500 mg DHA per serving. Molecularly distilled and heavy-metal tested.",
    },
    variants: [
      {
        sku: "AK-OM3-90",
        nameEs: "90 cápsulas blandas",
        nameEn: "90 softgels",
        grossCents: 3450,
        // Low, not zero. It used to be zero "to exercise the sold-out UI path",
        // and the cost of that outweighed the benefit once the storefront began
        // reading this API: `POST /v1/cart/items` returned OUT_OF_STOCK for the
        // product, so add-to-cart could not be demonstrated or integration-tested
        // against a third of the catalog. Six units still exercises the
        // low-stock path, which is the more interesting UI state anyway, and an
        // admin can set it to zero in one call.
        stock: 6,
        weightGrams: 220,
      },
    ],
    categories: ["suministros"],
    images: ["omega-3-triglyceride-1.png"],
  },

  // ── ADD-ONS ────────────────────────────────────────────────────────────
  // `listed: false`: fully purchasable, reachable by slug, never merchandised
  // on `/products`. `seedAddOnAttachments()` below attaches each of these to
  // every LISTED product above (mirroring the admin "offer everywhere"
  // action) and `offerOnNewProducts: true` covers whatever this seed — or an
  // admin — creates after it. Prices are the client's own numbers, not the
  // 8,45 € that was this water's only prior value anywhere in the repo (a
  // test-fixture placeholder, never a real seeded price).
  {
    slug: "agua-bacteriostatica",
    es: {
      name: "Agua bacteriostática",
      short: "Agua bacteriostática estéril, para reconstituir compuestos liofilizados.",
      long: "Agua bacteriostática estéril de grado investigación, para reconstituir compuestos liofilizados en el laboratorio. No apta para uso humano.",
    },
    en: {
      name: "Bacteriostatic Water",
      short: "Sterile bacteriostatic water, for reconstituting lyophilized compounds.",
      long: "Research-grade sterile bacteriostatic water, for reconstituting lyophilized compounds in the laboratory. Not for human use.",
    },
    variants: [
      {
        sku: "AK-BW-3",
        nameEs: "3 ml",
        nameEn: "3 ml",
        grossCents: 0,
        stock: 500,
        weightGrams: 10,
      },
      {
        sku: "AK-BW-10",
        nameEs: "10 ml",
        nameEn: "10 ml",
        grossCents: 645,
        stock: 300,
        weightGrams: 20,
      },
    ],
    categories: [],
    images: [],
    listed: false,
    offerOnNewProducts: true,
    // The 3 ml, free, is the default every host page arrives with ticked —
    // the 10 ml stays an unticked upsell at 6,45 €, per the client's spec.
    defaultVariantSku: "AK-BW-3",
  },
  {
    slug: "toallitas-alcohol",
    es: {
      name: "Toallitas con alcohol",
      short: "Toallitas de preparación con alcohol isopropílico, paquete de 10.",
      long: "Toallitas desinfectantes con alcohol isopropílico al 70 %, para preparar la zona de trabajo antes de cada uso en el laboratorio.",
    },
    en: {
      name: "Alcohol Prep Wipes",
      short: "Isopropyl alcohol prep wipes, pack of 10.",
      long: "70% isopropyl alcohol prep wipes, for cleaning the work area before each use in the laboratory.",
    },
    variants: [
      {
        sku: "AK-WIPE-10",
        nameEs: "Paquete de 10",
        nameEn: "Pack of 10",
        grossCents: 299,
        stock: 500,
        weightGrams: 15,
      },
    ],
    categories: [],
    images: [],
    listed: false,
    offerOnNewProducts: true,
  },
  {
    slug: "jeringas",
    es: {
      name: "Jeringas",
      short: "Jeringas estériles de 1 ml, paquete de 10.",
      long: "Jeringas estériles de un solo uso, graduadas, para dosificación precisa en el laboratorio.",
    },
    en: {
      name: "Syringes",
      short: "Sterile 1 ml syringes, pack of 10.",
      long: "Sterile, single-use, graduated syringes for precise laboratory dosing.",
    },
    variants: [
      {
        sku: "AK-SYR-10",
        nameEs: "Paquete de 10",
        nameEn: "Pack of 10",
        grossCents: 500,
        stock: 500,
        weightGrams: 25,
      },
    ],
    categories: [],
    images: [],
    listed: false,
    offerOnNewProducts: true,
  },
];

/**
 * Standard/reduced/zero rates for every country a seeded zone serves.
 *
 * Seeded ALONGSIDE the zones rather than as an afterthought, because
 * `PrismaShippingTaxResolver` throws on a served destination with no STANDARD
 * rate. A zone without its rate turns a shipping quote into a configuration
 * error, which is a confusing way to discover a seed gap.
 */
async function seedShipping(): Promise<void> {
  const validFrom = new Date("2020-01-01T00:00:00.000Z");

  for (const [countryCode, rateBps] of Object.entries(ZONE_VAT_BPS)) {
    await prisma.taxRate.upsert({
      where: {
        countryCode_taxClass_validFrom: {
          countryCode,
          taxClass: TaxClass.STANDARD,
          validFrom,
        },
      },
      update: { rateBps },
      create: { countryCode, taxClass: TaxClass.STANDARD, rateBps, validFrom },
    });
  }

  // Zones are upserted by NAME because `shipping_zone` has no natural unique
  // key. Re-running the seed must not accumulate duplicate zones — two zones
  // covering ES would make rate selection depend on `sortOrder` alone, which is
  // exactly the ambiguity `findZoneForCountry`'s ordering exists to resolve
  // rather than to rely on.
  // 2026-09-19: the client replaced EVERY rate in BOTH zones with the same
  // two pickup-point options, so unlike the 2026-09-15 change above (an
  // in-place price edit plus one addition) this zeroes each zone's rate list
  // down to just these two. The four Spain rates this replaced (Estándar,
  // Exprés, the InPost/SEUR pickup point, Buzón) and the EU zone's Estándar
  // rate are gone from here — a fresh database no longer seeds them — but
  // still soft-deleted rather than hard-deleted on any database that already
  // has them; see `seed-shipping-2026-09-19.ts`, the dedicated idempotent
  // script that actually performs that removal against an existing database
  // (this function's own `upsertZone` only ever adds/updates rates named in
  // its list, it never removes one absent from it).
  // 2026-09-24: free shipping at or above €250.00 on every rate in every zone
  // (spec 2026-09-24 §3, D3b). An existing database gets it from
  // `seed-shipping-2026-09-24.ts`.
  // 2026-09-24 (Sendcloud): the InPost rates carry their Sendcloud mapping
  // (national code in Spain, international in the EU), DHL stays unmapped
  // (D2b open), and IE moves into its own "Ireland" zone with the DHL rate
  // only — InPost cannot ship there. One definition in
  // `sendcloud-shipping-plan.ts`; an existing database gets it from
  // `seed-shipping-sendcloud-2026-09-24.ts`.
  // 2026-09-25 (D2b): DHL is gone — the account has no DHL — and UPS pickup
  // point at the same €19.99 replaces it in every zone. An existing database
  // gets that from `seed-shipping-ups-2026-09-25.ts`.
  const upsRate = (mapping: RateMapping): SeedRate => ({
    name: { ...UPS_RATE_NAME },
    strategy: "FLAT",
    priceGross: UPS_RATE_PRICE_GROSS,
    freeOverSubtotal: FREE_SHIPPING_THRESHOLD_MINOR,
    minValue: null,
    maxValue: null,
    mapping,
  });
  const inpostRate = (mapping: RateMapping): SeedRate => ({
    name: {
      es: "Envío en punto de recogida INPOST",
      en: INPOST_RATE_EN,
    },
    strategy: "FLAT",
    priceGross: 899,
    freeOverSubtotal: FREE_SHIPPING_THRESHOLD_MINOR,
    minValue: null,
    maxValue: null,
    mapping,
  });

  await upsertZone({
    name: SPAIN_ZONE_NAME,
    countryCodes: ["ES"],
    sortOrder: 0,
    rates: [upsRate(UPS_NATIONAL_MAPPING), inpostRate(INPOST_NATIONAL_MAPPING)],
  });

  await upsertZone({
    name: EU_ZONE_NAME,
    countryCodes: EU_ZONE_COUNTRIES,
    sortOrder: 1,
    rates: [upsRate(UPS_INTERNATIONAL_MAPPING), inpostRate(INPOST_INTERNATIONAL_MAPPING)],
  });

  await upsertZone({
    name: IRELAND_ZONE_NAME,
    countryCodes: IRELAND_ZONE_COUNTRIES,
    sortOrder: IRELAND_ZONE_SORT_ORDER,
    rates: [upsRate(UPS_INTERNATIONAL_MAPPING)],
  });
}

interface SeedRate {
  /**
   * Per-locale name. BOTH locales are seeded deliberately: the storefront falls
   * back to Spanish, so an English-only rate would silently look correct in the
   * default locale while being wrong for the language it was written for.
   */
  readonly name: Record<Locale, string>;
  readonly strategy: string;
  readonly priceGross: number;
  readonly freeOverSubtotal: number | null;
  readonly minValue: number | null;
  readonly maxValue: number | null;
  /** The Sendcloud mapping (`sendcloud-shipping-plan.ts`). */
  readonly mapping: RateMapping;
}

async function upsertZone(zone: {
  readonly name: string;
  readonly countryCodes: readonly string[];
  readonly sortOrder: number;
  readonly rates: readonly SeedRate[];
}): Promise<void> {
  const existing = await prisma.shippingZone.findFirst({
    where: { name: zone.name },
  });

  const row =
    existing ??
    (await prisma.shippingZone.create({
      data: {
        name: zone.name,
        countryCodes: [...zone.countryCodes],
        sortOrder: zone.sortOrder,
      },
    }));

  if (existing !== null) {
    await prisma.shippingZone.update({
      where: { id: row.id },
      data: {
        countryCodes: [...zone.countryCodes],
        sortOrder: zone.sortOrder,
        deletedAt: null,
      },
    });
  }

  // Matched in memory rather than with a Json path filter. A zone has a handful
  // of rates, and the alternative — `where: { name: { path: ["en"], equals } }`
  // — pushes the seed's idempotency key into a database-specific Json operator
  // for no gain. `en` is the match key because it is the stable authoring name;
  // it is a seed-local convention and nothing at runtime depends on it.
  const existingRates = await prisma.shippingRate.findMany({ where: { zoneId: row.id } });

  for (const rate of zone.rates) {
    const existingRate =
      existingRates.find((candidate) => seededRateKey(candidate.name) === rate.name.en) ?? null;

    const data = {
      name: rate.name,
      strategy: rate.strategy,
      priceGross: rate.priceGross,
      currency: "EUR",
      minValue: rate.minValue,
      maxValue: rate.maxValue,
      freeOverSubtotal: rate.freeOverSubtotal,
      isActive: true,
      deletedAt: null,
      ...rate.mapping,
    };

    if (existingRate === null) {
      await prisma.shippingRate.create({ data: { ...data, zoneId: row.id } });
    } else {
      await prisma.shippingRate.update({ where: { id: existingRate.id }, data });
    }
  }
}

/**
 * The English name of a persisted rate, or null if the column holds anything
 * else.
 *
 * NARROWED, not cast: Prisma types a Json column as a union that includes null,
 * arrays and nested objects, and a row written before the locale migration (or
 * by hand) is external data like any other. A row this cannot read simply does
 * not match, so the seed creates a fresh rate rather than crashing.
 */
function seededRateKey(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const en: unknown = Reflect.get(value, "en");
  return typeof en === "string" ? en : null;
}

/**
 * The navigation taxonomy.
 *
 * FIND-THEN-WRITE, keyed on the LIVE row matching `slug` — not `upsert`.
 * `slug` is unique among live categories only (partial index, see
 * `20260915100000_category_admin_crud`), so it is not a unique identifier
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
  const validFrom = new Date("2020-01-01T00:00:00.000Z");

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
                name: { es: variant.nameEs, en: variant.nameEn },
                options: { size: variant.nameEn },
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
      // is not an adjustment worth preserving, it is a dead SKU — and it is
      // exactly the state a previous seed left `AK-OM3-90` in, which made
      // `POST /v1/cart/items` return OUT_OF_STOCK for a third of the catalog on
      // every existing developer database no matter what this file said. A
      // restock is the only write that can turn an unusable seed back into a
      // usable one without a manual truncate.
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
 * the admin "offer everywhere" action, so a fresh database shows the water,
 * wipes and syringes on every product page rather than needing a manual
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
 * the products they are filtering — rendered empty, and `/bundles` showed
 * nothing. `GET /v1/products?category=…` worked the whole time; there was simply
 * nothing in any category.
 */
async function linkCategories(productId: string, product: SeedProduct): Promise<void> {
  for (const [index, slug] of product.categories.entries()) {
    // `slug` is unique among LIVE categories only (partial index, see
    // `20260915100000_category_admin_crud`), so `findUnique` can no longer key
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
