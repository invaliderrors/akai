import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ExpressAdapter } from "@nestjs/platform-express";
import { resetServerConfigCache } from "@akai/config";
import {
  TEST_WOMPI_EVENTS_SECRET,
  buildForgedWompiEvent,
  buildSignedWompiEvent,
  type WompiEventBody,
} from "@akai/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { AppModule } from "../../api/src/app.module";
import { API_GLOBAL_PREFIX, WOMPI_WEBHOOK_PATH } from "../../api/src/common/api-paths";
import { PaymentsService } from "../../api/src/modules/payments/payments.service";
import { FakeWompiGateway } from "../../api/src/modules/payments/testing/wompi.fakes";
import { WOMPI_GATEWAY } from "../../api/src/modules/payments/wompi/wompi.gateway";
import { isDockerAvailable, startTestDatabase, type TestDatabase } from "./harness";

/**
 * THE SETTLEMENT PROOF, AGAINST REAL POSTGRES.
 *
 * The unit suites run against an in-memory repository that MODELS
 * insert-then-run and the order lock. A model cannot prove Postgres does it:
 * the claim is that the `provider_event` INSERT and the state change share ONE
 * transaction, and that correlation takes a `FOR UPDATE` lock on the order, so
 *
 *   - two concurrent deliveries of the same (transaction, status) produce a
 *     primary-key violation on one and roll that whole transaction back, and
 *   - two DIFFERENT keys for one order (the webhook and the return page, or two
 *     transactions) serialise, so the second re-reads the first's commit.
 *
 * That is the difference between a duplicate delivery being free and a
 * duplicate delivery selling the same unit twice. Concurrency is the point: a
 * sequential second POST would pass against a naive check-then-write.
 *
 * Events are signed with the same checksum function Wompi documents
 * (`@akai/testing`), and POSTed as ordinary JSON — Wompi's checksum covers
 * parsed fields, not bytes. Nothing here calls the real Wompi; the gateway is
 * the in-memory fake, used only by the return-page test.
 */

const webhookAckSchema = z
  .object({
    received: z.literal(true),
    outcome: z.enum(["applied", "duplicate", "ignored", "unmatched", "unparsable"]),
  })
  .strict();

function ack(response: { readonly body: unknown }): z.infer<typeof webhookAckSchema> {
  return webhookAckSchema.parse(response.body);
}

const statusSchema = z.object({
  orderNumber: z.string(),
  status: z.string(),
  isPaid: z.boolean(),
  isTerminal: z.boolean(),
});

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  JWT_ACCESS_SECRET: "a".repeat(32),
  WOMPI_ENVIRONMENT: "sandbox",
  WOMPI_PUBLIC_KEY: "pub_test_e2e",
  WOMPI_PRIVATE_KEY: "prv_test_e2e",
  WOMPI_INTEGRITY_SECRET: "test_integrity_e2e",
  WOMPI_EVENTS_SECRET: TEST_WOMPI_EVENTS_SECRET,
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

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_NUMBER = "AK-2026-000123";
const PRODUCT_ID = "22222222-2222-4222-8222-222222222222";
const VARIANT_ID = "33333333-3333-4333-8333-333333333333";
const REFERENCE = `${ORDER_NUMBER}-1`;
const TRANSACTION_ID = "1234-1700000000-00001";
/** $ 89.000 — centavos on both sides, so no conversion anywhere. */
const GRAND_TOTAL = 8_900_000;
const NET = 7_478_992;
const TAX = 1_421_008;
const STOCK_ON_HAND = 10;
const RESERVED = 2;

describe.skipIf(!isDockerAvailable())("Wompi settlement — real Postgres", () => {
  let db: TestDatabase;
  let app: NestExpressApplication;
  let wompi: FakeWompiGateway;
  let savedEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    savedEnv = process.env;
    db = await startTestDatabase();

    process.env = {
      ...TEST_ENV,
      DATABASE_URL: db.databaseUrl,
      DIRECT_DATABASE_URL: db.databaseUrl,
    };
    resetServerConfigCache();

    wompi = new FakeWompiGateway();

    // The WHOLE graph, real Postgres. Only the outbound Wompi read is faked, so
    // the return-page path never leaves the machine.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WOMPI_GATEWAY)
      .useValue(wompi)
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>(new ExpressAdapter());
    app.setGlobalPrefix(API_GLOBAL_PREFIX);
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
    wompi.transactions.clear();
    await seedAwaitingOrder();
  });

  afterEach(() => {
    resetServerConfigCache();
  });

  async function seedAwaitingOrder(): Promise<void> {
    const prisma = db.prisma;

    await prisma.product.create({
      data: { id: PRODUCT_ID, slug: "oversized-tee", status: "ACTIVE" },
    });

    await prisma.productVariant.create({
      data: {
        id: VARIANT_ID,
        productId: PRODUCT_ID,
        sku: "AK-TEE-BLK-L",
        currency: "COP",
        priceNet: NET,
        priceTax: TAX,
        priceGross: GRAND_TOTAL,
        taxRateBps: 1900,
      },
    });

    await prisma.inventoryItem.create({
      data: { variantId: VARIANT_ID, onHand: STOCK_ON_HAND, reserved: RESERVED },
    });

    await prisma.order.create({
      data: {
        id: ORDER_ID,
        orderNumber: ORDER_NUMBER,
        email: "customer@example.com",
        status: "AWAITING_PAYMENT",
        locale: "es",
        currency: "COP",
        subtotal: NET,
        taxTotal: TAX,
        grandTotal: GRAND_TOTAL,
        shipFirstName: "Valentina",
        shipLastName: "Restrepo",
        shipLine1: "Calle 10 # 43-21",
        shipCity: "Medellín",
        shipRegion: "Antioquia",
        shipCountryCode: "CO",
        shipPhone: "3001234567",
        billFirstName: "Valentina",
        billLastName: "Restrepo",
        billLine1: "Calle 10 # 43-21",
        billCity: "Medellín",
        billRegion: "Antioquia",
        billCountryCode: "CO",
        documentType: "CC",
        documentNumber: "1020304050",
        items: {
          create: {
            variantId: VARIANT_ID,
            productName: "Oversized Tee",
            variantName: "L",
            sku: "AK-TEE-BLK-L",
            quantity: 1,
            unitPriceNet: NET,
            unitPriceGross: GRAND_TOTAL,
            taxRateBps: 1900,
            taxAmount: TAX,
            lineTotalNet: NET,
            lineTotalGross: GRAND_TOTAL,
          },
        },
      },
    });

    // The attempt `startCheckout` writes before the redirect — the row a Wompi
    // reference correlates through.
    await prisma.payment.create({
      data: {
        orderId: ORDER_ID,
        amount: GRAND_TOTAL,
        currency: "COP",
        providerReference: REFERENCE,
      },
    });

    await prisma.stockReservation.create({
      data: {
        variantId: VARIANT_ID,
        orderId: ORDER_ID,
        quantity: RESERVED,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
  }

  function transaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: TRANSACTION_ID,
      status: "APPROVED",
      reference: REFERENCE,
      amount_in_cents: GRAND_TOTAL,
      currency: "COP",
      payment_method_type: "CARD",
      finalized_at: new Date().toISOString(),
      ...overrides,
    };
  }

  function post(event: WompiEventBody) {
    return request(app.getHttpServer())
      .post(WOMPI_WEBHOOK_PATH)
      .set("X-Event-Checksum", event.signature.checksum)
      .send(event);
  }

  async function orderStatus(): Promise<string> {
    const order = await db.prisma.order.findUniqueOrThrow({ where: { id: ORDER_ID } });
    return order.status;
  }

  async function expectStockSoldOnce(): Promise<void> {
    const inventory = await db.prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: VARIANT_ID },
    });
    expect(inventory.onHand).toBe(STOCK_ON_HAND - RESERVED);
    expect(inventory.reserved).toBe(0);

    const sales = await db.prisma.inventoryLedgerEntry.findMany({
      where: { variantId: VARIANT_ID, movement: "SALE" },
    });
    expect(sales).toHaveLength(1);
  }

  it("applies ONE of two concurrent identical deliveries, and exactly one", async () => {
    const event = buildSignedWompiEvent(transaction());

    const [first, second] = await Promise.all([post(event), post(event)]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect([ack(first).outcome, ack(second).outcome].sort()).toEqual(["applied", "duplicate"]);

    const events = await db.prisma.providerEvent.findMany();
    expect(events.map((row) => row.id)).toEqual([`wompi:${TRANSACTION_ID}:APPROVED`]);

    const order = await db.prisma.order.findUniqueOrThrow({ where: { id: ORDER_ID } });
    expect(order.status).toBe("PAID");
    expect(order.paidAt).not.toBeNull();
    expect(order.invoiceNumber).toMatch(/^INV-\d{4}-000001$/);

    const paidEvents = await db.prisma.orderEvent.findMany({
      where: { orderId: ORDER_ID, type: "payment.succeeded" },
    });
    expect(paidEvents).toHaveLength(1);

    await expectStockSoldOnce();

    // The checkout's attempt row was CLAIMED, not duplicated.
    const payments = await db.prisma.payment.findMany({ where: { orderId: ORDER_ID } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      providerReference: REFERENCE,
      providerPaymentId: TRANSACTION_ID,
      status: "SUCCEEDED",
      provider: "WOMPI",
      amount: GRAND_TOTAL,
    });
  });

  it("settles ONCE when the webhook and the return page race on the same transaction", async () => {
    wompi.seed({
      id: TRANSACTION_ID,
      status: "APPROVED",
      reference: REFERENCE,
      amount_in_cents: GRAND_TOTAL,
      currency: "COP",
      finalized_at: new Date().toISOString(),
    });

    const [webhook, page] = await Promise.all([
      post(buildSignedWompiEvent(transaction())),
      request(app.getHttpServer())
        .post(`/${API_GLOBAL_PREFIX}/payments/orders/${ORDER_NUMBER}/confirm`)
        .send({ transactionId: TRANSACTION_ID }),
    ]);

    expect(webhook.status).toBe(200);
    expect(page.status).toBe(200);
    expect(statusSchema.parse(page.body).orderNumber).toBe(ORDER_NUMBER);

    expect(await orderStatus()).toBe("PAID");
    expect(await db.prisma.providerEvent.count()).toBe(1);
    expect(
      await db.prisma.outboxMessage.count({ where: { topic: "email" } }),
    ).toBe(3);
    await expectStockSoldOnce();
  });

  it("settles from the return page alone when the webhook never came", async () => {
    wompi.seed({
      id: TRANSACTION_ID,
      status: "APPROVED",
      reference: REFERENCE,
      amount_in_cents: GRAND_TOTAL,
      currency: "COP",
    });

    const response = await request(app.getHttpServer())
      .post(`/${API_GLOBAL_PREFIX}/payments/orders/${ORDER_NUMBER}/confirm`)
      .send({ transactionId: TRANSACTION_ID });

    expect(response.status).toBe(200);
    expect(statusSchema.parse(response.body)).toMatchObject({ status: "PAID", isPaid: true });
  });

  it("serialises two DIFFERENT approved transactions: one settles, the other is paged", async () => {
    const [first, second] = await Promise.all([
      post(buildSignedWompiEvent(transaction({ id: "tx_a" }))),
      post(buildSignedWompiEvent(transaction({ id: "tx_b" }))),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await orderStatus()).toBe("PAID");

    const paidEvents = await db.prisma.orderEvent.findMany({
      where: { orderId: ORDER_ID, type: "payment.succeeded" },
    });
    expect(paidEvents).toHaveLength(1);
    await expectStockSoldOnce();

    // Both transactions are on the ledger; the second is an operator's problem.
    const payments = await db.prisma.payment.findMany({ where: { orderId: ORDER_ID } });
    expect(payments.map((row) => row.providerPaymentId).sort()).toEqual(["tx_a", "tx_b"]);
    const alerts = await db.prisma.outboxMessage.findMany({ where: { topic: "notifications" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.payload).toMatchObject({ kind: "duplicate-payment" });
  });

  it("stays idempotent when the same event is redelivered later", async () => {
    const event = buildSignedWompiEvent(transaction());

    expect(ack(await post(event)).outcome).toBe("applied");
    expect(ack(await post(event)).outcome).toBe("duplicate");

    expect(await db.prisma.providerEvent.count()).toBe(1);
    await expectStockSoldOnce();
  });

  it("rejects a forged event and changes NOTHING", async () => {
    const response = await post(buildForgedWompiEvent(transaction()));

    expect(response.status).toBe(400);
    expect(await orderStatus()).toBe("AWAITING_PAYMENT");
    expect(await db.prisma.providerEvent.count()).toBe(0);
  });

  it("parks a wrong-amount approval in PAYMENT_MISMATCH and HOLDS the stock", async () => {
    const response = await post(buildSignedWompiEvent(transaction({ amount_in_cents: 100 })));
    expect(response.status).toBe(200);

    const order = await db.prisma.order.findUniqueOrThrow({ where: { id: ORDER_ID } });
    expect(order.status).toBe("PAYMENT_MISMATCH");
    expect(order.paidAt).toBeNull();
    expect(order.invoiceNumber).toBeNull();

    const inventory = await db.prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: VARIANT_ID },
    });
    expect(inventory.onHand).toBe(STOCK_ON_HAND);
    expect(inventory.reserved).toBe(RESERVED);

    const jobs = await db.prisma.outboxMessage.findMany();
    expect(jobs.map((job) => job.topic)).toEqual(["notifications"]);

    // Wompi's own figure is the evidence on the ledger row.
    const payment = await db.prisma.payment.findFirstOrThrow({ where: { orderId: ORDER_ID } });
    expect(payment.amount).toBe(100);
  });

  it("fails the order on DECLINED and hands the stock back", async () => {
    const response = await post(
      buildSignedWompiEvent(transaction({ status: "DECLINED", status_message: "Fondos insuficientes" })),
    );
    expect(response.status).toBe(200);

    expect(await orderStatus()).toBe("FAILED");
    const inventory = await db.prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: VARIANT_ID },
    });
    expect(inventory.onHand).toBe(STOCK_ON_HAND);
    expect(inventory.reserved).toBe(0);

    const payment = await db.prisma.payment.findFirstOrThrow({ where: { orderId: ORDER_ID } });
    expect(payment).toMatchObject({ status: "FAILED", failureCode: "DECLINED" });
  });

  it("acks PENDING without touching the order, and keeps the id for the sweep", async () => {
    const response = await post(buildSignedWompiEvent(transaction({ status: "PENDING" })));
    expect(ack(response).outcome).toBe("applied");

    expect(await orderStatus()).toBe("AWAITING_PAYMENT");
    const payment = await db.prisma.payment.findFirstOrThrow({ where: { orderId: ORDER_ID } });
    expect(payment).toMatchObject({ status: "PROCESSING", providerPaymentId: TRANSACTION_ID });
  });

  it("acks an unknown reference with 200 and burns no dedupe key", async () => {
    const response = await post(buildSignedWompiEvent(transaction({ reference: "NOT-OURS-1" })));

    expect(response.status).toBe(200);
    expect(ack(response).outcome).toBe("unmatched");
    expect(await db.prisma.providerEvent.count()).toBe(0);
    expect(await orderStatus()).toBe("AWAITING_PAYMENT");
  });

  it("alerts ONCE for a replayed unparsable event, and the synthetic key fits the column", async () => {
    // Checksum-valid, schema-invalid: no reference.
    const event = buildSignedWompiEvent({ id: "tx_broken", status: "APPROVED" });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await post(event);
      expect(response.status).toBe(200);
      expect(ack(response).outcome).toBe("unparsable");
    }

    expect(await db.prisma.outboxMessage.count({ where: { topic: "notifications" } })).toBe(1);
    const events = await db.prisma.providerEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("webhook/unparsable");
    expect(events[0]?.id).toHaveLength(75);
  });

  it("mints a fresh reference per checkout attempt, and settles through it", async () => {
    // The REAL startCheckout against Postgres: lock, attempt count, the
    // persisted reference — then an event for that reference settles the order.
    const payments = app.get(PaymentsService);
    const { checkoutUrl } = await payments.startCheckout(ORDER_ID);
    const params = new URL(checkoutUrl).searchParams;

    expect(params.get("reference")).toBe(`${ORDER_NUMBER}-2`);
    expect(params.get("amount-in-cents")).toBe(String(GRAND_TOTAL));
    expect(params.get("public-key")).toBe("pub_test_e2e");
    expect(params.get("customer-data:legal-id")).toBe("1020304050");

    const response = await post(
      buildSignedWompiEvent(transaction({ id: "tx_attempt_2", reference: `${ORDER_NUMBER}-2` })),
    );
    expect(ack(response).outcome).toBe("applied");
    expect(await orderStatus()).toBe("PAID");

    const attempt = await db.prisma.payment.findFirstOrThrow({
      where: { providerReference: `${ORDER_NUMBER}-2` },
    });
    expect(attempt.providerPaymentId).toBe("tx_attempt_2");
  });
});
