import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ExpressAdapter } from "@nestjs/platform-express";
import { resetServerConfigCache } from "@akai/config";
import { paginatedSchema, publicProductSchema } from "@akai/contracts";
import { createLogger } from "@akai/observability";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../../api/src/app.module";
import { API_GLOBAL_PREFIX } from "../../api/src/common/api-paths";
import { AllExceptionsFilter } from "../../api/src/common/filters/all-exceptions.filter";
import { isDockerAvailable, startTestDatabase, type TestDatabase } from "./harness";

/**
 * CATALOG SEARCH, AGAINST REAL POSTGRES (spec 2026-09-24 §5, cause B).
 *
 * `product-query.test.ts` pins the SQL text. What only a database can prove:
 * that `unaccent` is actually installed by the migrations, that the escaped
 * term compiles as a regex, that `\m` really refuses "tsukumo" for "kumo",
 * and that the rank survives the keyset cursor — a page walk that neither
 * skips nor repeats a product.
 */

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  JWT_ACCESS_SECRET: "a".repeat(32),
  WOMPI_ENVIRONMENT: "sandbox",
  WOMPI_PUBLIC_KEY: "pub_test_unit",
  WOMPI_PRIVATE_KEY: "prv_test_unit",
  WOMPI_INTEGRITY_SECRET: "test_integrity_unit",
  WOMPI_EVENTS_SECRET: "test_events_unit",
  EMAIL_TRANSPORT: "smtp",
  SMTP_URL: "smtp://localhost:1025",
  EMAIL_FROM: "no-reply@example.com",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "akai-media",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
  CORS_ALLOWED_ORIGINS: "http://localhost:3000",
  STOREFRONT_URL: "http://localhost:3000",
  DASHBOARD_URL: "http://localhost:3001",
  REVALIDATE_SIGNING_SECRET: "b".repeat(32),
};

const pageSchema = paginatedSchema(publicProductSchema);

interface SeedCopy {
  readonly name: string;
  readonly shortDescription: string;
  readonly description: string;
}

interface SeedProduct {
  readonly slug: string;
  readonly sku: string;
  readonly sortOrder?: number;
  readonly copy: SeedCopy;
}

function copy(name: string, shortDescription: string, description: string): SeedCopy {
  return { name, shortDescription, description };
}

/**
 * Every product the suite searches over. `sortOrder` is set AGAINST the
 * expected relevance where it matters: if the rank were not the leading key,
 * the manual order would put the description hit first and the test would say
 * so.
 */
const PRODUCTS: readonly SeedProduct[] = [
  {
    slug: "kumo-hdy-3",
    sku: "AK-K1",
    sortOrder: 50,
    copy: copy("KUMO (HDY-3)", "Sudadera pesada.", "<p>Colección de invierno.</p>"),
  },
  {
    slug: "kumogata",
    sku: "AK-K2",
    sortOrder: 40,
    copy: copy("Kumogata", "Camiseta de algodón.", "<p>Estampado serigrafiado.</p>"),
  },
  {
    // Reaches "kumo" ONLY through a description word start: ranked last.
    slug: "coach-jacket",
    sku: "AK-C1",
    sortOrder: 0,
    copy: copy("Coach Jacket", "Nailon cortavientos.", "<p>Se combina a menudo con <strong>kumo</strong>.</p>"),
  },
  {
    // "kumo" is only ever INSIDE a word here — must never match.
    slug: "cargo-pants",
    sku: "AK-G1",
    sortOrder: 0,
    copy: copy(
      "Cargo Pants",
      "Tejido tsukumo.",
      "<p>Inspirado en el barrio de Akumoto, de corte recto y relajado.</p>",
    ),
  },
  {
    slug: "sudadera-basica",
    sku: "AK-B1",
    copy: copy("Sudadera Básica", "Felpa perchada.", "<p>Sudadera básica.</p>"),
  },
  {
    // No "kumo" anywhere in its copy: never matches.
    slug: "tote-bag",
    sku: "AK-T1",
    copy: copy("Bolsa Tote", "Lona.", "<p>Algodón.</p>"),
  },
  {
    // "kumo" as a later word of the name: a name word-start hit.
    slug: "gorra-kumo",
    sku: "AK-E1",
    copy: copy("Gorra Seis Paneles Kumo", "Gorra.", "<p>Gorra.</p>"),
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

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
          ...product.copy,
        },
      });
      const variant = await db.prisma.productVariant.create({
        data: {
          productId: created.id,
          sku: product.sku,
          currency: "COP",
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
      .query({ sort: "manual", ...query });
    expect(response.status).toBe(200);
    return pageSchema.parse(response.body);
  }

  async function slugs(search: string): Promise<string[]> {
    const result = await page({ search, limit: "100" });
    return result.items.map((item) => item.slug);
  }

  it('"kumo": KUMO first, then Kumogata, never the tsukumo product', async () => {
    const found = await slugs("kumo");

    // Whole-word prefix → partial prefix → name word start → description word
    // start. Every name hit outranks the description hit, although the manual
    // order (sortOrder 0 vs 40/50) says the opposite.
    expect(found).toEqual(["kumo-hdy-3", "kumogata", "gorra-kumo", "coach-jacket"]);
    expect(found).not.toContain("cargo-pants");
  });

  it("searches the product's own copy and refuses a stray locale parameter", async () => {
    expect(await slugs("kumo")).not.toContain("tote-bag");
    expect(await slugs("lona")).toEqual(["tote-bag"]);

    // One language, so no `?locale=`: the strict query refuses it.
    const response = await request(app.getHttpServer())
      .get("/v1/products")
      .query({ search: "kumo", locale: "es" });
    expect(response.status).toBe(400);
  });

  it("is accent-insensitive in both directions", async () => {
    expect(await slugs("basica")).toEqual(["sudadera-basica"]);
    expect(await slugs("BÁSICA")).toEqual(["sudadera-basica"]);
    expect(await slugs("kúmó")).toContain("kumo-hdy-3");
  });

  it("an exact SKU ranks first and a partial SKU still finds the product", async () => {
    expect((await slugs("ak-c1"))[0]).toBe("coach-jacket");
    expect(await slugs("AK-B")).toEqual(["sudadera-basica"]);
  });

  it("treats regex and LIKE metacharacters as literals", async () => {
    // "(" unescaped is an invalid regex and would 500; "%" unescaped matches everything.
    expect(await slugs("(hdy")).toEqual(["kumo-hdy-3"]);
    expect(await slugs("%%")).toEqual([]);
    expect(await slugs("k.mo")).toEqual([]);
  });

  it("ignores a one-character term instead of erroring or matching nothing", async () => {
    const all = await page({ limit: "100" });
    const oneChar = await page({ search: "k", limit: "100" });
    expect(oneChar.items.map((item) => item.slug)).toEqual(all.items.map((item) => item.slug));
  });

  it("paginates ranked results one row at a time without skipping or repeating", async () => {
    const expected = await slugs("kumo");
    expect(expected.length).toBeGreaterThanOrEqual(4);

    const walked: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const result = await page({
        search: "kumo",
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
