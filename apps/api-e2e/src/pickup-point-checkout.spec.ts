import "reflect-metadata";

import { readFileSync } from "node:fs";
import path from "node:path";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ExpressAdapter } from "@nestjs/platform-express";
import { resetServerConfigCache } from "@akai/config";
import {
  cartSchema,
  checkoutSessionResponseSchema,
  errorEnvelopeSchema,
  servicePointSearchResponseSchema,
  shippingQuoteResponseSchema,
} from "@akai/contracts";
import { createLogger } from "@akai/observability";
import { type FakeSendcloudServer, TEST_WHOP_WEBHOOK_SECRET, startFakeSendcloud } from "@akai/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppModule } from "../../api/src/app.module";
import { API_GLOBAL_PREFIX, WHOP_WEBHOOK_PATH } from "../../api/src/common/api-paths";
import { AllExceptionsFilter } from "../../api/src/common/filters/all-exceptions.filter";
import { createRawBodyMiddleware } from "../../api/src/common/middleware/raw-body";
import { CART_TOKEN_HEADER } from "../../api/src/modules/cart/cart.constants";
import { SendcloudClient } from "../../api/src/modules/fulfilment/sendcloud/sendcloud.client";
import { FakeWhopGateway } from "../../api/src/modules/payments/testing/fake-whop.gateway";
import { WHOP_GATEWAY } from "../../api/src/modules/payments/whop/whop.gateway";
import { SENDCLOUD_INTERACTIVE_CLIENT } from "../../api/src/modules/shipping/service-points/interactive-sendcloud.client";
import { isDockerAvailable, startTestDatabase, type TestDatabase } from "./harness";

/**
 * PICKUP POINTS AT CHECKOUT, END TO END (Sendcloud spec §3.2/§3.3, plan Phase 3).
 *
 * Real Postgres, the real Nest app, and the PRODUCTION `SendcloudClient`
 * speaking real HTTP to the local fake Sendcloud server: quote → search →
 * checkout, then the snapshot is read back off the stored order row. What the
 * unit suites cannot prove: that the rate's carrier really reaches Sendcloud's
 * query string, that the refusal envelope carries the `reason` a storefront
 * branches on, and that the snapshot columns really land in the database.
 */

const FIXTURES = path.resolve(__dirname, "../../api/src/modules/fulfilment/__fixtures__");

function fixtureJson(name: string): unknown {
  const value: unknown = JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
  return value;
}

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

const PRODUCT_ID = "40000000-0000-4000-8000-000000000001";
const VARIANT_ID = "40000000-0000-4000-8000-000000000002";
const ZONE_ID = "50000000-0000-4000-8000-000000000001";
const PICKUP_RATE_ID = "50000000-0000-4000-8000-000000000002";
const HOME_RATE_ID = "50000000-0000-4000-8000-000000000003";
const PILI_ID = "12188365";

describe.skipIf(!isDockerAvailable())("Pickup points — quote → search → checkout snapshot", () => {
  let db: TestDatabase;
  let app: NestExpressApplication;
  let fake: FakeSendcloudServer;
  let savedEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    savedEnv = process.env;
    fake = await startFakeSendcloud();
    db = await startTestDatabase();
    process.env = { ...TEST_ENV, DATABASE_URL: db.databaseUrl, DIRECT_DATABASE_URL: db.databaseUrl };
    resetServerConfigCache();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WHOP_GATEWAY)
      .useValue(new FakeWhopGateway())
      // `config.sendcloud.baseUrl` is a constant, so the interactive binding is
      // replaced by the SAME production client pointed at the fake.
      .overrideProvider(SENDCLOUD_INTERACTIVE_CLIENT)
      .useValue(
        new SendcloudClient(
          { publicKey: "pub", secretKey: "sec", baseUrl: fake.baseUrl, timeoutMs: 5_000, maxRetries: 1 },
          { sleep: () => Promise.resolve() },
        ),
      )
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>(new ExpressAdapter());
    app.use(WHOP_WEBHOOK_PATH, createRawBodyMiddleware());
    app.setGlobalPrefix(API_GLOBAL_PREFIX);
    app.useGlobalFilters(
      new AllExceptionsFilter(createLogger({ level: "silent", nodeEnv: "test", serviceName: "api-e2e" }), false),
    );
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.stop();
    await fake?.close();
    process.env = savedEnv;
    resetServerConfigCache();
  });

  beforeEach(async () => {
    await db.reset();
    fake.reset();
    await seed();
  });

  async function seed(): Promise<void> {
    await db.prisma.product.create({
      data: {
        id: PRODUCT_ID,
        slug: "bpc-157",
        status: "ACTIVE",
        translations: { create: [{ locale: "es", name: "BPC-157", shortDescription: "x", description: "x" }] },
      },
    });
    await db.prisma.productVariant.create({
      data: {
        id: VARIANT_ID,
        productId: PRODUCT_ID,
        sku: "BPC-157-10",
        currency: "EUR",
        taxRateBps: 2100,
        priceNet: 4132,
        priceTax: 868,
        priceGross: 5000,
        weightGrams: 150,
      },
    });
    await db.prisma.inventoryItem.create({ data: { variantId: VARIANT_ID, onHand: 50, reserved: 0 } });
    await db.prisma.taxRate.create({
      data: { countryCode: "ES", taxClass: "STANDARD", rateBps: 2100, validFrom: new Date("2020-01-01") },
    });
    await db.prisma.shippingZone.create({
      data: { id: ZONE_ID, name: "España", countryCodes: ["ES"], sortOrder: 0 },
    });
    await db.prisma.shippingRate.createMany({
      data: [
        {
          id: PICKUP_RATE_ID,
          zoneId: ZONE_ID,
          name: { es: "InPost punto de recogida", en: "InPost pickup point" },
          strategy: "FLAT",
          priceGross: 899,
          currency: "EUR",
          deliveryType: "SERVICE_POINT",
          carrierCode: "inpost_es",
          sendcloudOptionCode: "inpost_es:service_point,national_c2c",
          transitDaysMin: 1,
          transitDaysMax: 2,
        },
        {
          id: HOME_RATE_ID,
          zoneId: ZONE_ID,
          name: { es: "A domicilio", en: "Home delivery" },
          strategy: "FLAT",
          priceGross: 1299,
          currency: "EUR",
        },
      ],
    });
  }

  function http(): ReturnType<typeof request> {
    return request(app.getHttpServer());
  }

  /** A guest cart with 2 × 150 g, and its token. */
  async function guestCart(): Promise<{ token: string; cartId: string }> {
    const response = await http().post("/v1/cart/items").send({ variantId: VARIANT_ID, quantity: 2 });
    expect(response.status).toBe(200);
    const token = response.headers[CART_TOKEN_HEADER];
    if (typeof token !== "string") throw new Error("no cart token issued");
    return { token, cartId: cartSchema.parse(response.body).id };
  }

  function checkoutBody(cartId: string, overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      cartId,
      email: "ana@example.com",
      shippingAddress: {
        firstName: "Ana",
        lastName: "García",
        company: null,
        line1: "Calle Mayor",
        houseNumber: "12B",
        line2: null,
        city: "Zaragoza",
        region: null,
        postalCode: "50002",
        countryCode: "ES",
        phone: "+34 600 000 000",
      },
      billingAddress: null,
      shippingMethodId: PICKUP_RATE_ID,
      servicePointId: null,
      vatNumber: null,
      locale: "es",
      acceptedTermsVersion: "2026-01",
      ...overrides,
    };
  }

  function scriptPili(available: boolean): void {
    const search = fixtureJson("service-points.es-inpost-50002.json");
    fake.on("GET", "/service-points", { status: 200, body: search });
    const results =
      typeof search === "object" && search !== null && "data" in search ? search.data : null;
    const first =
      typeof results === "object" && results !== null && "results" in results && Array.isArray(results.results)
        ? (results.results[0] as unknown)
        : null;
    fake.on("GET", "/service-points/:id", (req) =>
      req.params["id"] === PILI_ID
        ? { status: 200, body: { data: first } }
        : { status: 404, body: { errors: [{ status: "404", code: "not_found", detail: "No point" }] } },
    );
    fake.on("POST", "/service-points/:id/check-availability", {
      status: 200,
      body: { data: { is_available: available } },
    });
  }

  it("quote → service points → checkout stores the verified pickup-point snapshot", async () => {
    scriptPili(true);
    const { token, cartId } = await guestCart();

    const quote = await http()
      .post("/v1/shipping/quote")
      .set(CART_TOKEN_HEADER, token)
      .send({ countryCode: "ES", postalCode: "50002" });
    expect(quote.status).toBe(200);
    const pickup = shippingQuoteResponseSchema
      .parse(quote.body)
      .options.find((option) => option.rateId === PICKUP_RATE_ID);
    expect(pickup).toMatchObject({
      deliveryType: "SERVICE_POINT",
      carrierName: "InPost",
      transitDaysMin: 1,
      transitDaysMax: 2,
    });

    const search = await http()
      .post("/v1/shipping/service-points")
      .send({ rateId: PICKUP_RATE_ID, countryCode: "ES", postalCode: "50002", city: null });
    expect(search.status).toBe(200);
    const points = servicePointSearchResponseSchema.parse(search.body);
    expect(points.status).toBe("OK");
    expect(points.points[0]).toMatchObject({ id: PILI_ID, name: "PAPELERIA PILI", distanceMeters: 1089 });
    // The RATE's carrier reached Sendcloud, 10 km radius.
    const [searched] = fake.requestsTo("GET", "/service-points");
    expect(searched?.query.getAll("carrier_code")).toEqual(["inpost_es"]);
    expect(searched?.query.get("radius")).toBe("10000");

    const checkout = await http()
      .post("/v1/checkout")
      .set(CART_TOKEN_HEADER, token)
      .send(checkoutBody(cartId, { servicePointId: PILI_ID }));
    expect(checkout.status).toBe(201);
    const { orderNumber } = checkoutSessionResponseSchema.parse(checkout.body);

    const order = await db.prisma.order.findUniqueOrThrow({ where: { orderNumber } });
    expect(order).toMatchObject({
      shippingRateId: PICKUP_RATE_ID,
      sendcloudOptionCode: "inpost_es:service_point,national_c2c",
      parcelWeightGrams: 300,
      shipHouseNumber: "12B",
      servicePointId: PILI_ID,
      servicePointCarrierId: "ES21366",
      servicePointName: "PAPELERIA PILI",
      servicePointAddress: "CALLE DE LA BATALLA DE LEPANTO, 50002 ZARAGOZA, ES",
      servicePointPostNumber: null,
    });
    expect(fake.requestsTo("POST", "/service-points/:id/check-availability")).toHaveLength(1);
  });

  it("refuses a pickup rate with no point (400 SERVICE_POINT_REQUIRED) and holds no stock", async () => {
    const { token, cartId } = await guestCart();

    const response = await http().post("/v1/checkout").set(CART_TOKEN_HEADER, token).send(checkoutBody(cartId, {}));

    expect(response.status).toBe(400);
    expect(errorEnvelopeSchema.parse(response.body)).toMatchObject({
      error: { code: "VALIDATION_FAILED", reason: "SERVICE_POINT_REQUIRED" },
    });
    expect(await db.prisma.stockReservation.count()).toBe(0);
    expect(await db.prisma.order.count()).toBe(0);
  });

  it("refuses a point Sendcloud reports unavailable (409 SERVICE_POINT_UNAVAILABLE), no side effects", async () => {
    scriptPili(false);
    const { token, cartId } = await guestCart();

    const response = await http()
      .post("/v1/checkout")
      .set(CART_TOKEN_HEADER, token)
      .send(checkoutBody(cartId, { servicePointId: PILI_ID }));

    expect(response.status).toBe(409);
    expect(errorEnvelopeSchema.parse(response.body)).toMatchObject({
      error: { code: "CONFLICT", reason: "SERVICE_POINT_UNAVAILABLE" },
    });
    expect(await db.prisma.stockReservation.count()).toBe(0);
    expect(await db.prisma.order.count()).toBe(0);
  });

  it("refuses a point on a HOME rate (SERVICE_POINT_NOT_ALLOWED)", async () => {
    const { token, cartId } = await guestCart();

    const response = await http()
      .post("/v1/checkout")
      .set(CART_TOKEN_HEADER, token)
      .send(checkoutBody(cartId, { shippingMethodId: HOME_RATE_ID, servicePointId: PILI_ID }));

    expect(response.status).toBe(400);
    expect(errorEnvelopeSchema.parse(response.body)).toMatchObject({
      error: { reason: "SERVICE_POINT_NOT_ALLOWED" },
    });
  });

  it("a Sendcloud outage during the search is a 200 UNAVAILABLE, never a 500", async () => {
    fake.on("GET", "/service-points", { status: 503, body: { errors: [{ status: "503", code: "unavailable" }] } });

    // A postcode no earlier test searched: the app (and its 5-minute cache)
    // lives for the whole suite.
    const search = await http()
      .post("/v1/shipping/service-points")
      .send({ rateId: PICKUP_RATE_ID, countryCode: "ES", postalCode: "28013", city: null });

    expect(search.status).toBe(200);
    expect(servicePointSearchResponseSchema.parse(search.body)).toEqual({ status: "UNAVAILABLE", points: [] });
    // One retry, not the label worker's three.
    expect(fake.requestsTo("GET", "/service-points")).toHaveLength(2);
  });
});
