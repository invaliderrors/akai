import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ExpressAdapter } from "@nestjs/platform-express";
import { resetServerConfigCache } from "@akai/config";
import { TEST_WHOP_WEBHOOK_SECRET } from "@akai/testing";
import { createLogger } from "@akai/observability";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppModule } from "../../api/src/app.module";
import { API_GLOBAL_PREFIX } from "../../api/src/common/api-paths";
import { buildCorsOptions } from "../../api/src/common/cors-options";
import { AllExceptionsFilter } from "../../api/src/common/filters/all-exceptions.filter";
import { WHOP_GATEWAY } from "../../api/src/modules/payments/whop/whop.gateway";
import { FakeWhopGateway } from "../../api/src/modules/payments/testing/fake-whop.gateway";
import { type FakeObjectStore, startFakeObjectStore } from "./fake-object-store";
import { isDockerAvailable, startTestDatabase, type TestDatabase } from "./harness";

/**
 * THE CERTIFICATE AS BYTES, AGAINST REAL POSTGRES AND A REAL HTTP BUCKET.
 *
 * `GET /v1/products/:slug/coa/file` is what the storefront's in-page PDF.js
 * viewer fetches, cross-origin, from the shop. What only this stack proves:
 * the API really reads the object over HTTP from the private bucket named by
 * the product's `coaObjectKey` and returns those exact bytes with the viewer's
 * headers; the SAME hide rules as the 302 route hold (a hidden, missing,
 * unknown — or row-present-but-object-gone — certificate is a 404); and the
 * production CORS policy (`buildCorsOptions`, the function `main.ts` applies)
 * lets the storefront origin read the response while a foreign origin gets no
 * allow-origin header.
 */

const STOREFRONT_ORIGIN = "http://localhost:3000";

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
  S3_BUCKET: "akai-media",
  S3_BUCKET_COA: "akai-coa",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
  CORS_ALLOWED_ORIGINS: STOREFRONT_ORIGIN,
  STOREFRONT_URL: STOREFRONT_ORIGIN,
  DASHBOARD_URL: "http://localhost:3001",
  REVALIDATE_SIGNING_SECRET: "b".repeat(32),
};

const SHOWN_KEY = "coa/products/shown/2026-09-24T10-00-00-000Z-aaaa.pdf";
const HIDDEN_KEY = "coa/products/hidden/2026-09-24T10-00-00-000Z-bbbb.pdf";
const GONE_KEY = "coa/products/gone/2026-09-24T10-00-00-000Z-cccc.pdf";

/** A tiny but real-looking PDF body; the route must not care what is inside. */
const PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "latin1");

describe.skipIf(!isDockerAvailable())("GET /v1/products/:slug/coa/file — the certificate bytes for the in-page viewer", () => {
  let db: TestDatabase;
  let store: FakeObjectStore;
  let app: NestExpressApplication;
  let savedEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    savedEnv = process.env;
    db = await startTestDatabase();
    store = await startFakeObjectStore();
    process.env = {
      ...TEST_ENV,
      S3_ENDPOINT: store.endpoint,
      DATABASE_URL: db.databaseUrl,
      DIRECT_DATABASE_URL: db.databaseUrl,
    };
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
    app.enableCors(buildCorsOptions([STOREFRONT_ORIGIN]));
    await app.init();

    async function product(slug: string, extra: { coaObjectKey?: string; showCoa?: boolean }) {
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
    }

    await product("bpc-157", { coaObjectKey: SHOWN_KEY, showCoa: true });
    await product("tb-500", { coaObjectKey: HIDDEN_KEY, showCoa: false });
    await product("ghk-cu", { showCoa: true });
    await product("kpv", { coaObjectKey: GONE_KEY, showCoa: true });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await store?.close();
    await db?.stop();
    process.env = savedEnv;
    resetServerConfigCache();
  });

  beforeEach(() => {
    store.objects.clear();
    store.contentTypes.clear();
    // Both files exist in the bucket; only the SHOWN one may ever be served.
    store.objects.set(`akai-coa/${SHOWN_KEY}`, PDF_BYTES);
    store.contentTypes.set(`akai-coa/${SHOWN_KEY}`, "application/pdf");
    store.objects.set(`akai-coa/${HIDDEN_KEY}`, PDF_BYTES);
  });

  function file(slug: string, origin?: string) {
    const req = request(app.getHttpServer()).get(`/v1/products/${slug}/coa/file`);
    return (origin === undefined ? req : req.set("Origin", origin))
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });
  }

  it("200s with the bucket's exact bytes and the viewer's headers", async () => {
    const response = await file("bpc-157");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"]).toBe('inline; filename="certificado-bpc-157.pdf"');
    expect(response.headers["cache-control"]).toBe("private, max-age=300");
    expect(response.headers["content-length"]).toBe(String(PDF_BYTES.byteLength));
    expect(Buffer.compare(response.body as Buffer, PDF_BYTES)).toBe(0);
  });

  it("is readable cross-origin by the storefront — and only by the storefront", async () => {
    const allowed = await file("bpc-157", STOREFRONT_ORIGIN);
    expect(allowed.status).toBe(200);
    expect(allowed.headers["access-control-allow-origin"]).toBe(STOREFRONT_ORIGIN);

    const foreign = await file("bpc-157", "https://evil.example");
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("404s a certificate the admin has NOT switched on, although the file is in the bucket", async () => {
    const response = await file("tb-500");

    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).not.toContain("application/pdf");
    expect(response.headers["cache-control"]).not.toBe("private, max-age=300");
  });

  it("404s a product with the switch on but no file uploaded", async () => {
    expect((await file("ghk-cu")).status).toBe(404);
  });

  it("404s a row whose object is gone from the bucket", async () => {
    expect((await file("kpv")).status).toBe(404);
  });

  it("404s an unknown product and 400s a malformed slug", async () => {
    expect((await file("no-such-product")).status).toBe(404);
    expect((await file("NOT_A_SLUG")).status).toBe(400);
  });

  it("leaves the 302 route in place for 'open in a new tab'", async () => {
    const response = await request(app.getHttpServer()).get("/v1/products/bpc-157/coa").redirects(0);

    expect(response.status).toBe(302);
    expect(new URL(String(response.headers["location"])).pathname).toBe(`/akai-coa/${SHOWN_KEY}`);
  });
});
