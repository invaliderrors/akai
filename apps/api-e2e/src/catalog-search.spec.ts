import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ExpressAdapter } from "@nestjs/platform-express";
import { resetServerConfigCache } from "@akai/config";
import { paginatedSchema, publicProductSchema } from "@akai/contracts";
import { TEST_WHOP_WEBHOOK_SECRET } from "@akai/testing";
import { createLogger } from "@akai/observability";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../../api/src/app.module";
import { API_GLOBAL_PREFIX } from "../../api/src/common/api-paths";
import { AllExceptionsFilter } from "../../api/src/common/filters/all-exceptions.filter";
import { WHOP_GATEWAY } from "../../api/src/modules/payments/whop/whop.gateway";
import { FakeWhopGateway } from "../../api/src/modules/payments/testing/fake-whop.gateway";
import { isDockerAvailable, startTestDatabase, type TestDatabase } from "./harness";

/**
 * CATALOG SEARCH, AGAINST REAL POSTGRES (spec 2026-09-24 §5, cause B).
 *
 * `product-query.test.ts` pins the SQL text. What only a database can prove:
 * that `unaccent` is actually installed by the migrations, that the escaped
 * term compiles as a regex, that `\m` really refuses "secretagogo" for "reta",
 * and that the rank survives the keyset cursor — a page walk that neither
 * skips nor repeats a product.
 */

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  JWT_ACCESS_SECRET: "a".repeat(32),
  WHOP_ENVIRONMENT: "live",
  WHOP_API_KEY: "whop_test_abc123def456ghi789",
  WHOP_ACCOUNT_ID: "biz_test_1",
  WHOP_PRODUCT_ID: "prod_test_1",
  WHOP_WEBHOOK_SECRET: TEST_WHOP_WEBHOOK_SECRET,
  WHOP_API_VERSION_DATE: "2026-08-14",
  EMAIL_TRANSPORT: "smtp",
  SMTP_URL: "smtp://localhost:1025",
  EMAIL_FROM: "no-reply@example.com",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "akai-media",
  S3_BUCKET_COA: "akai-coa",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
  CORS_ALLOWED_ORIGINS: "http://localhost:3000",
  STOREFRONT_URL: "http://localhost:3000",
  DASHBOARD_URL: "http://localhost:3001",
  REVALIDATE_SIGNING_SECRET: "b".repeat(32),
};

const pageSchema = paginatedSchema(publicProductSchema);

interface SeedTranslation {
  readonly locale: "es" | "en";
  readonly name: string;
  readonly shortDescription: string;
  readonly description: string;
}

interface SeedProduct {
  readonly slug: string;
  readonly sku: string;
  readonly sortOrder?: number;
  readonly translations: readonly SeedTranslation[];
}

function es(name: string, shortDescription: string, description: string): SeedTranslation {
  return { locale: "es", name, shortDescription, description };
}

/**
 * Every product the suite searches over. `sortOrder` is set AGAINST the
 * expected relevance where it matters: if the rank were not the leading key,
 * the manual order would put the description hit first and the test would say
 * so.
 */
const PRODUCTS: readonly SeedProduct[] = [
  {
    slug: "reta-glp-3",
    sku: "AK-R1",
    sortOrder: 50,
    translations: [es("RETA (GLP-3)", "Agonista triple.", "<p>Investigación metabólica.</p>")],
  },
  {
    slug: "retatrutide",
    sku: "AK-R2",
    sortOrder: 40,
    translations: [es("Retatrutide", "Péptido de investigación.", "<p>Vial liofilizado.</p>")],
  },
  {
    // Reaches "reta" ONLY through a description word start: ranked last.
    slug: "tirzepatide",
    sku: "AK-T1",
    sortOrder: 0,
    translations: [
      es("Tirzepatide", "Agonista dual.", "<p>Se compara a menudo con <strong>reta</strong>.</p>"),
    ],
  },
  {
    // "reta" is only ever INSIDE a word here — must never match.
    slug: "ipamorelin",
    sku: "AK-I1",
    sortOrder: 0,
    translations: [
      es(
        "Ipamorelin",
        "Péptido secretagogo de GH.",
        "<p>Un secretagogo selectivo, de acción discreta y concreta.</p>",
      ),
    ],
  },
  {
    slug: "proteina-whey",
    sku: "AK-P1",
    translations: [es("Proteína Whey", "Aislado de suero.", "<p>Proteína de suero.</p>")],
  },
  {
    // "reta" appears only in the ENGLISH name. An es search reads the es row.
    slug: "magnesio",
    sku: "AK-M1",
    translations: [
      es("Magnesio", "Bisglicinato.", "<p>Mineral.</p>"),
      { locale: "en", name: "Retaline Magnesium", shortDescription: "Bisglycinate.", description: "<p>Mineral.</p>" },
    ],
  },
  {
    // No es row at all: falls back to en, so an es search still finds it.
    slug: "english-only",
    sku: "AK-E1",
    translations: [
      { locale: "en", name: "Nasal Spray Reta", shortDescription: "Spray.", description: "<p>Spray.</p>" },
    ],
  },
];

describe.skipIf(!isDockerAvailable())("Catalog search — ranking, word starts, accents, pagination", () => {
  let db: TestDatabase;
  let app: NestExpressApplication;
  let savedEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    savedEnv = process.env;
    db = await startTestDatabase();
    process.env = { ...TEST_ENV, DATABASE_URL: db.databaseUrl, DIRECT_DATABASE_URL: db.databaseUrl };
    resetServerConfigCache();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WHOP_GATEWAY)
      .useValue(new FakeWhopGateway())
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>(new ExpressAdapter());
    app.setGlobalPrefix(API_GLOBAL_PREFIX);
    app.useGlobalFilters(
      new AllExceptionsFilter(createLogger({ level: "silent", nodeEnv: "test", serviceName: "api-e2e" }), false),
    );
    await app.init();

    // Seeded once: every test here is a read.
    for (const product of PRODUCTS) {
      const created = await db.prisma.product.create({
        data: {
          slug: product.slug,
          status: "ACTIVE",
          sortOrder: product.sortOrder ?? 0,
          translations: { create: product.translations.map((row) => ({ ...row })) },
        },
      });
      const variant = await db.prisma.productVariant.create({
        data: {
          productId: created.id,
          sku: product.sku,
          currency: "EUR",
          taxRateBps: 2100,
          priceNet: 1000,
          priceTax: 210,
          priceGross: 1210,
        },
      });
      await db.prisma.inventoryItem.create({ data: { variantId: variant.id, onHand: 10, reserved: 0 } });
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.stop();
    process.env = savedEnv;
    resetServerConfigCache();
  });

  async function page(query: Record<string, string>): Promise<ReturnType<typeof pageSchema.parse>> {
    const response = await request(app.getHttpServer())
      .get("/v1/products")
      .query({ sort: "manual", locale: "es", ...query });
    expect(response.status).toBe(200);
    return pageSchema.parse(response.body);
  }

  async function slugs(search: string, locale: "es" | "en" = "es"): Promise<string[]> {
    const result = await page({ search, locale, limit: "100" });
    return result.items.map((item) => item.slug);
  }

  it('"reta": RETA first, then Retatrutide, never the secretagogo product', async () => {
    const found = await slugs("reta");

    // Whole-word prefix → partial prefix → name word start → description word
    // start. Every name hit outranks the description hit, although the manual
    // order (sortOrder 0 vs 40/50) says the opposite.
    expect(found).toEqual(["reta-glp-3", "retatrutide", "english-only", "tirzepatide"]);
    expect(found).not.toContain("ipamorelin");
  });

  it("matches the active locale's translation, falling back when a product lacks it", async () => {
    const found = await slugs("reta");

    // "Retaline" is only the en name of a product that HAS an es row.
    expect(found).not.toContain("magnesio");
    // No es row at all: the en row is the one the product is shown in.
    expect(found).toContain("english-only");

    expect(await slugs("retaline", "en")).toEqual(["magnesio"]);
  });

  it("is accent-insensitive in both directions", async () => {
    expect(await slugs("proteina")).toEqual(["proteina-whey"]);
    expect(await slugs("PROTEÍNA")).toEqual(["proteina-whey"]);
    expect(await slugs("rétà")).toContain("reta-glp-3");
  });

  it("an exact SKU ranks first and a partial SKU still finds the product", async () => {
    expect((await slugs("nx-t1"))[0]).toBe("tirzepatide");
    expect(await slugs("AK-P")).toEqual(["proteina-whey"]);
  });

  it("treats regex and LIKE metacharacters as literals", async () => {
    // "(" unescaped is an invalid regex and would 500; "%" unescaped matches everything.
    expect(await slugs("(glp")).toEqual(["reta-glp-3"]);
    expect(await slugs("%%")).toEqual([]);
    expect(await slugs("r.ta")).toEqual([]);
  });

  it("ignores a one-character term instead of erroring or matching nothing", async () => {
    const all = await page({ limit: "100" });
    const oneChar = await page({ search: "r", limit: "100" });
    expect(oneChar.items.map((item) => item.slug)).toEqual(all.items.map((item) => item.slug));
  });

  it("paginates ranked results one row at a time without skipping or repeating", async () => {
    const expected = await slugs("reta");
    expect(expected.length).toBeGreaterThanOrEqual(4);

    const walked: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const result = await page({
        search: "reta",
        limit: "1",
        ...(cursor === null ? {} : { cursor }),
      });
      walked.push(...result.items.map((item) => item.slug));
      if (!result.hasMore) break;
      cursor = result.nextCursor;
      expect(cursor).not.toBeNull();
    }

    expect(walked).toEqual(expected);
  });
});
