import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ExpressAdapter } from "@nestjs/platform-express";
import { resetServerConfigCache } from "@akai/config";
import { cartSchema, errorEnvelopeSchema, publicProductSchema } from "@akai/contracts";
import { TEST_WHOP_WEBHOOK_SECRET } from "@akai/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppModule } from "../../api/src/app.module";
import { API_GLOBAL_PREFIX, WHOP_WEBHOOK_PATH } from "../../api/src/common/api-paths";
import { createLogger } from "@akai/observability";
import { AllExceptionsFilter } from "../../api/src/common/filters/all-exceptions.filter";
import { createRawBodyMiddleware } from "../../api/src/common/middleware/raw-body";
import { CART_TOKEN_HEADER } from "../../api/src/modules/cart/cart.constants";
import { AccessTokenService } from "../../api/src/modules/auth/crypto/access-token.service";
import { WHOP_GATEWAY } from "../../api/src/modules/payments/whop/whop.gateway";
import { FakeWhopGateway } from "../../api/src/modules/payments/testing/fake-whop.gateway";
import { isDockerAvailable, startTestDatabase, type TestDatabase } from "./harness";

/**
 * PACKS IN THE CART, AGAINST REAL POSTGRES (spec 2026-09-24 §11).
 *
 * The unit suite proves the service's decisions against an in-memory double.
 * What it cannot prove is the adapter: that the stale-pack repair's
 * conditional delete + insert really commits once under concurrent reads
 * (`cart_item_pack_key` would turn a double insert into a 500), and that the
 * public catalogue's pack availability is really read from the components'
 * inventory rows.
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
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
  CORS_ALLOWED_ORIGINS: "http://localhost:3000",
  STOREFRONT_URL: "http://localhost:3000",
  DASHBOARD_URL: "http://localhost:3001",
  REVALIDATE_SIGNING_SECRET: "b".repeat(32),
};

const PACK_ID = "10000000-0000-4000-8000-000000000001";
const PACK_VARIANT_ID = "10000000-0000-4000-8000-000000000002";
const A_ID = "20000000-0000-4000-8000-000000000001";
const A_VARIANT_ID = "20000000-0000-4000-8000-000000000002";
const B_ID = "30000000-0000-4000-8000-000000000001";
const B_VARIANT_ID = "30000000-0000-4000-8000-000000000002";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** VAT-inclusive gross -> the (net, tax) pair the price CHECK constraint demands. */
function prices(gross: number): { priceNet: number; priceTax: number; priceGross: number } {
  const priceNet = Math.round(gross / 1.21);
  return { priceNet, priceTax: gross - priceNet, priceGross: gross };
}

describe.skipIf(!isDockerAvailable())("Cart packs — stored rows, codes and availability", () => {
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
    app.use(WHOP_WEBHOOK_PATH, createRawBodyMiddleware());
    app.setGlobalPrefix(API_GLOBAL_PREFIX);
    // The filter `main.ts` registers: the codes asserted below are what it
    // reads off the exception, so the suite must run through it.
    app.useGlobalFilters(
      new AllExceptionsFilter(createLogger({ level: "silent", nodeEnv: "test", serviceName: "api-e2e" }), false),
    );
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.stop();
    process.env = savedEnv;
    resetServerConfigCache();
  });

  beforeEach(async () => {
    await db.reset();
    await seedPack();
  });

  afterEach(() => {
    resetServerConfigCache();
  });

  async function seedProduct(
    id: string,
    variantId: string,
    slug: string,
    gross: number,
    onHand: number,
    kind: "SIMPLE" | "PACK" = "SIMPLE",
  ): Promise<void> {
    await db.prisma.product.create({
      data: {
        id,
        slug,
        status: "ACTIVE",
        kind,
        translations: { create: [{ locale: "es", name: slug, shortDescription: slug, description: slug }] },
      },
    });
    await db.prisma.productVariant.create({
      data: {
        id: variantId,
        productId: id,
        sku: slug.toUpperCase(),
        currency: "EUR",
        taxRateBps: 2100,
        ...prices(gross),
      },
    });
    await db.prisma.inventoryItem.create({ data: { variantId, onHand, reserved: 0 } });
  }

  /**
   * 6000 across a (1 x 1000) and b (5 x 1000) splits EVENLY: b is ONE stored
   * row of 5 @ 1000. The pack's OWN variant claims 999 in stock — the number
   * the storefront used to publish, which the cart never checks.
   */
  async function seedPack(): Promise<void> {
    await seedProduct(A_ID, A_VARIANT_ID, "component-a", 1000, 50);
    await seedProduct(B_ID, B_VARIANT_ID, "component-b", 1000, 13);
    await seedProduct(PACK_ID, PACK_VARIANT_ID, "the-pack", 6000, 999, "PACK");
    await db.prisma.productPackComponent.createMany({
      data: [
        { packProductId: PACK_ID, componentProductId: A_ID, componentVariantId: A_VARIANT_ID, sortOrder: 0, quantity: 1 },
        { packProductId: PACK_ID, componentProductId: B_ID, componentVariantId: B_VARIANT_ID, sortOrder: 1, quantity: 5 },
      ],
    });
  }

  function http(): ReturnType<typeof request> {
    return request(app.getHttpServer());
  }

  async function addPack(): Promise<string> {
    const response = await http().post("/v1/cart/packs").send({ packProductId: PACK_ID, quantity: 1 });
    expect(response.status).toBe(200);
    const token = response.headers[CART_TOKEN_HEADER];
    if (typeof token !== "string") throw new Error("no cart token issued");
    return token;
  }

  it("re-splits and PERSISTS a stale pack: every presented id is a stored row", async () => {
    const token = await addPack();
    expect(await db.prisma.cartItem.count({ where: { variantId: B_VARIANT_ID } })).toBe(1);

    // a gets dearer: b's share of 6000 no longer divides by 5.
    await db.prisma.productVariant.update({ where: { id: A_VARIANT_ID }, data: prices(1100) });

    const response = await http().get("/v1/cart").set(CART_TOKEN_HEADER, token);
    expect(response.status).toBe(200);
    const cart = cartSchema.parse(response.body);

    const stored = await db.prisma.cartItem.findMany();
    expect(new Set(cart.items.map((item) => item.id))).toEqual(new Set(stored.map((row) => row.id)));
    for (const item of cart.items) expect(item.id).toMatch(UUID);
    expect(stored.filter((row) => row.variantId === B_VARIANT_ID)).toHaveLength(2);
    expect(cart.totals.grandTotal).toBe(6000);
  });

  it("concurrent reads of a stale pack store the re-split exactly once", async () => {
    const token = await addPack();
    await db.prisma.productVariant.update({ where: { id: A_VARIANT_ID }, data: prices(1100) });

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => http().get("/v1/cart").set(CART_TOKEN_HEADER, token)),
    );

    for (const response of responses) {
      expect(response.status).toBe(200);
      cartSchema.parse(response.body);
    }
    const stored = await db.prisma.cartItem.findMany();
    // a: one row; b: two rows. Nothing duplicated.
    expect(stored).toHaveLength(3);
    expect(stored.reduce((sum, row) => sum + row.quantity * row.unitPriceGross, 0)).toBe(6000);
  });

  it("refuses the pack's own variant as an ordinary line with a coded 409", async () => {
    const response = await http().post("/v1/cart/items").send({ variantId: PACK_VARIANT_ID, quantity: 1 });

    expect(response.status).toBe(409);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe("CONFLICT");
    expect(await db.prisma.cartItem.count()).toBe(0);
  });

  it("a component shortage is OUT_OF_STOCK, not a bare CONFLICT", async () => {
    // 13 of b at 5 per pack: two packs fit, three do not.
    const response = await http().post("/v1/cart/packs").send({ packProductId: PACK_ID, quantity: 3 });

    expect(response.status).toBe(409);
    expect(errorEnvelopeSchema.parse(response.body).error.code).toBe("OUT_OF_STOCK");
  });

  it("a pack refused over the SAME variant already standalone in the cart names it, with what is left", async () => {
    // b: 13 in stock. 9 standalone + one pack needing 5 = 14.
    const first = await http().post("/v1/cart/items").send({ variantId: B_VARIANT_ID, quantity: 9 });
    expect(first.status).toBe(200);
    const token = first.headers[CART_TOKEN_HEADER];
    if (typeof token !== "string") throw new Error("no cart token issued");

    const response = await http()
      .post("/v1/cart/packs")
      .set(CART_TOKEN_HEADER, token)
      .send({ packProductId: PACK_ID, quantity: 1 });

    expect(response.status).toBe(409);
    const envelope = errorEnvelopeSchema.parse(response.body);
    expect(envelope.error.code).toBe("OUT_OF_STOCK");
    expect(envelope.error.shortage).toEqual({ variantId: B_VARIANT_ID, availableQuantity: 4 });
    expect(await db.prisma.cartItem.count({ where: { packInstanceId: { not: null } } })).toBe(0);
  });

  it("a cart read flags a variant over-committed across a standalone line and a pack", async () => {
    const token = await addPack();
    const standalone = await http()
      .post("/v1/cart/items")
      .set(CART_TOKEN_HEADER, token)
      .send({ variantId: B_VARIANT_ID, quantity: 5 });
    expect(standalone.status).toBe(200);

    // Each line (5, 5) still fits in 8; together (10) they do not.
    await db.prisma.inventoryItem.update({ where: { variantId: B_VARIANT_ID }, data: { onHand: 8 } });
    const cart = cartSchema.parse((await http().get("/v1/cart").set(CART_TOKEN_HEADER, token)).body);

    const bLines = cart.items.filter((item) => item.variantId === B_VARIANT_ID);
    expect(bLines.length).toBeGreaterThanOrEqual(2);
    for (const line of bLines) {
      expect(cart.problems).toContainEqual(
        expect.objectContaining({ itemId: line.id, code: "INSUFFICIENT_STOCK", availableQuantity: 8 }),
      );
    }
  });

  describe("merge-on-login", () => {
    async function customerToken(): Promise<string> {
      const customer = await db.prisma.customer.create({ data: { email: "pack-buyer@example.com" } });
      const session = await db.prisma.session.create({
        data: { customerId: customer.id, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
      });
      return app.get(AccessTokenService).issue({
        customerId: customer.id,
        sessionId: session.id,
        role: "CUSTOMER",
      }).token;
    }

    it("carries a guest pack over AS A PACK at the pack price, in one transaction", async () => {
      const bearer = await customerToken();
      // The customer's own cart already exists, so this is a real merge, not
      // the claim-the-guest-cart fast path.
      const own = await http()
        .post("/v1/cart/items")
        .set("authorization", `Bearer ${bearer}`)
        .send({ variantId: A_VARIANT_ID, quantity: 1 });
      expect(own.status).toBe(200);
      expect(cartSchema.parse(own.body).customerId).not.toBeNull();

      const guestToken = await addPack();

      const response = await http()
        .post("/v1/cart/merge")
        .set("authorization", `Bearer ${bearer}`)
        .send({ cartToken: guestToken });
      expect(response.status).toBe(200);
      const cart = cartSchema.parse(response.body);

      const packLines = cart.items.filter((item) => item.packProductId === PACK_ID);
      expect(new Set(packLines.map((item) => item.variantId))).toEqual(new Set([A_VARIANT_ID, B_VARIANT_ID]));
      expect(new Set(packLines.map((item) => item.packInstanceId)).size).toBe(1);
      expect(packLines.reduce((sum, item) => sum + item.lineTotalGross, 0)).toBe(6000);
      // The customer's standalone a stays standalone at its own price.
      const standaloneA = cart.items.filter((item) => item.variantId === A_VARIANT_ID && item.packInstanceId === null);
      expect(standaloneA).toHaveLength(1);
      expect(standaloneA[0]?.quantity).toBe(1);
      expect(cart.totals.grandTotal).toBe(6000 + 1000);
      expect(cart.problems).toEqual([]);

      // The guest cart is gone, and every presented id is a stored row.
      expect(await db.prisma.cart.count()).toBe(1);
      const stored = await db.prisma.cartItem.findMany();
      expect(new Set(cart.items.map((item) => item.id))).toEqual(new Set(stored.map((row) => row.id)));
    });

    it("sums a guest pack into the customer's own instance of the same pack", async () => {
      const bearer = await customerToken();
      const own = await http()
        .post("/v1/cart/packs")
        .set("authorization", `Bearer ${bearer}`)
        .send({ packProductId: PACK_ID, quantity: 1 });
      expect(own.status).toBe(200);
      const ownInstance = cartSchema.parse(own.body).items[0]?.packInstanceId;

      const guestToken = await addPack();
      const response = await http()
        .post("/v1/cart/merge")
        .set("authorization", `Bearer ${bearer}`)
        .send({ cartToken: guestToken });
      expect(response.status).toBe(200);
      const cart = cartSchema.parse(response.body);

      expect(new Set(cart.items.map((item) => item.packInstanceId))).toEqual(new Set([ownInstance]));
      expect(cart.items.filter((item) => item.variantId === B_VARIANT_ID).reduce((sum, item) => sum + item.quantity, 0)).toBe(10);
      expect(cart.totals.grandTotal).toBe(12000);
      expect(await db.prisma.cart.count()).toBe(1);
    });
  });

  it("publishes the pack's stock as min over components of floor(available / quantity)", async () => {
    const response = await http().get("/v1/products/the-pack");
    expect(response.status).toBe(200);
    const pack = publicProductSchema.parse(response.body);

    // floor(13 / 5) = 2 — not the pack variant's own 999.
    expect(pack.variants[0]?.inventory.available).toBe(2);
    expect(pack.variants[0]?.inventory.allowBackorder).toBe(false);
  });
});
