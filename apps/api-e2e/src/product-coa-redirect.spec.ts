import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ExpressAdapter } from "@nestjs/platform-express";
import { resetServerConfigCache } from "@akai/config";
import { publicProductSchema } from "@akai/contracts";
import { TEST_WHOP_WEBHOOK_SECRET } from "@akai/testing";
import { createLogger } from "@akai/observability";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../../api/src/app.module";
import { API_GLOBAL_PREFIX } from "../../api/src/common/api-paths";
import { AllExceptionsFilter } from "../../api/src/common/filters/all-exceptions.filter";
import { WHOP_GATEWAY } from "../../api/src/modules/payments/whop/whop.gateway";
import { FakeWhopGateway } from "../../api/src/modules/payments/testing/fake-whop.gateway";
import { CATALOG_TOPICS } from "../../api/src/modules/catalog/catalog.events";
import { ProductsService } from "../../api/src/modules/catalog/products.service";
import { REVALIDATION_TOPIC } from "../../api/src/modules/revalidation/revalidation.types";
import { isDockerAvailable, startTestDatabase, type TestDatabase } from "./harness";

/**
 * THE STABLE CERTIFICATE LINK, AGAINST REAL POSTGRES (spec 2026-09-24 §9).
 *
 * One certificate per PRODUCT, with the admin's visibility switch. The product
 * page is ISR-cached, so it links to `GET /v1/products/:slug/coa` instead of
 * embedding a signed URL that expires. What only the real stack proves: the
 * new columns (`coaObjectKey`, `showCoa`, `form`) exist and are read, the
 * redirect 404s a certificate that is missing OR hidden, a lot's own
 * certificate never drives the storefront, the public payload carries only
 * `hasCoa` (no key, no signed URL, no `purityLabel`), and the service's
 * attach/remove really write the column and enqueue the storefront purge.
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

describe.skipIf(!isDockerAvailable())("GET /v1/products/:slug/coa — stable certificate redirect", () => {
  let db: TestDatabase;
  let app: NestExpressApplication;
  let savedEnv: NodeJS.ProcessEnv;

  /** The id of the product with no certificate uploaded yet — attached to below. */
  let pendingId = "";
  let lotVariantId = "";

  const SHOWN_KEY = "coa/products/shown/2026-09-24T10-00-00-000Z-aaaa.pdf";
  const HIDDEN_KEY = "coa/products/hidden/2026-09-24T10-00-00-000Z-bbbb.pdf";

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

    async function product(
      slug: string,
      extra: { form?: "SOLUTION"; coaObjectKey?: string; showCoa?: boolean } = {},
    ) {
      const created = await db.prisma.product.create({
        data: {
          slug,
          status: "ACTIVE",
          ...extra,
          translations: {
            create: [{ locale: "es", name: slug, shortDescription: "", description: "" }],
          },
        },
      });
      const variant = await db.prisma.productVariant.create({
        data: {
          productId: created.id,
          sku: `AK-${slug.toUpperCase()}`,
          options: {},
          currency: "EUR",
          taxRateBps: 2100,
          priceNet: 1000,
          priceTax: 210,
          priceGross: 1210,
        },
      });
      await db.prisma.inventoryItem.create({ data: { variantId: variant.id, onHand: 5, reserved: 0 } });
      return { productId: created.id, variantId: variant.id };
    }

    const shown = await product("bpc-157", {
      form: "SOLUTION",
      coaObjectKey: SHOWN_KEY,
      showCoa: true,
    });
    lotVariantId = shown.variantId;
    // A lot WITH ITS OWN certificate: admin data, which must neither leak into
    // the public payload nor be what the redirect serves.
    await db.prisma.batch.create({
      data: {
        variantId: shown.variantId,
        lotCode: "LOT-A1",
        purityPercent: 99.42,
        testedAt: new Date("2026-08-01T00:00:00.000Z"),
        testMethod: "HPLC",
        coaObjectKey: "coa/lot-a1/report.pdf",
      },
    });

    await product("tb-500", { coaObjectKey: HIDDEN_KEY, showCoa: false });
    pendingId = (await product("ghk-cu", { showCoa: true })).productId;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.stop();
    process.env = savedEnv;
    resetServerConfigCache();
  });

  function coa(slug: string) {
    return request(app.getHttpServer()).get(`/v1/products/${slug}/coa`).redirects(0);
  }

  it("302s to a freshly signed, short-lived URL for the PRODUCT's certificate", async () => {
    const response = await coa("bpc-157");

    expect(response.status).toBe(302);
    expect(response.headers["cache-control"]).toBe("no-store");
    const location = new URL(String(response.headers["location"]));
    // The product's file — never the lot's `coa/lot-a1/report.pdf`.
    expect(location.pathname).toBe(`/akai-coa/${SHOWN_KEY}`);
    expect(location.searchParams.get("X-Amz-Signature")).not.toBeNull();
    expect(location.searchParams.get("X-Amz-Expires")).toBe("300");
  });

  it("still serves a stale page's old ?variantId= link", async () => {
    const response = await request(app.getHttpServer())
      .get("/v1/products/bpc-157/coa")
      .query({ variantId: lotVariantId })
      .redirects(0);

    expect(response.status).toBe(302);
  });

  it("404s an uploaded certificate the admin has NOT switched on", async () => {
    const response = await coa("tb-500");

    expect(response.status).toBe(404);
    expect(response.headers["location"]).toBeUndefined();
  });

  it("404s a product with the switch on but no file uploaded", async () => {
    expect((await coa("ghk-cu")).status).toBe(404);
  });

  it("404s an unknown product and 400s a malformed slug", async () => {
    expect((await coa("no-such-product")).status).toBe(404);
    expect((await coa("NOT_A_SLUG")).status).toBe(400);
  });

  it("the public product carries hasCoa and form — no key, no signed URL, no purityLabel", async () => {
    const shown = await request(app.getHttpServer()).get("/v1/products/bpc-157");
    const hidden = await request(app.getHttpServer()).get("/v1/products/tb-500");

    expect(shown.status).toBe(200);
    const json = JSON.stringify(shown.body);
    expect(json).not.toContain("X-Amz-Signature");
    expect(json).not.toContain(SHOWN_KEY);
    expect(json).not.toContain("coa/lot-a1");
    const product = publicProductSchema.parse(shown.body);
    expect(product.form).toBe("SOLUTION");
    expect(product.hasCoa).toBe(true);
    expect(shown.body).not.toHaveProperty("purityLabel");
    expect(shown.body).not.toHaveProperty("showCoa");
    expect(product.variants[0]?.batch?.lotCode).toBe("LOT-A1");
    expect(product.variants[0]?.batch).not.toHaveProperty("hasCoa");

    expect(publicProductSchema.parse(hidden.body).hasCoa).toBe(false);
  });

  it("attach and remove write the real column, flip the redirect, and enqueue the storefront purge", async () => {
    const products = app.get(ProductsService);
    const key = `coa/products/${pendingId}/2026-09-24T10-00-00-000Z-cccc.pdf`;

    const attached = await products.attachCoa(pendingId, { objectKey: key });
    expect(attached.coaUrl).toContain(key);
    expect((await coa("ghk-cu")).status).toBe(302);

    const removed = await products.removeCoa(pendingId);
    expect(removed.coaUrl).toBeNull();
    expect((await coa("ghk-cu")).status).toBe(404);

    const purges = await db.prisma.outboxMessage.findMany({
      where: { topic: REVALIDATION_TOPIC },
      select: { payload: true },
    });
    const reasons = purges.map((row) =>
      typeof row.payload === "object" && row.payload !== null && !Array.isArray(row.payload)
        ? row.payload["reason"]
        : undefined,
    );
    expect(reasons).toEqual(
      expect.arrayContaining([CATALOG_TOPICS.productCoaAttached, CATALOG_TOPICS.productCoaRemoved]),
    );
  });

  it("refuses to attach a key issued for another product", async () => {
    await expect(
      app.get(ProductsService).attachCoa(pendingId, { objectKey: HIDDEN_KEY }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
