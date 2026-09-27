import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ExpressAdapter } from "@nestjs/platform-express";
import { resetServerConfigCache } from "@akai/config";
import {
  TEST_WHOP_WEBHOOK_SECRET,
  buildForgedWhopEvent,
  buildSignedWhopEvent,
} from "@akai/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { AppModule } from "../../api/src/app.module";
import { API_GLOBAL_PREFIX, WHOP_WEBHOOK_PATH } from "../../api/src/common/api-paths";
import { createRawBodyMiddleware } from "../../api/src/common/middleware/raw-body";
import { WHOP_GATEWAY } from "../../api/src/modules/payments/whop/whop.gateway";
import { FakeWhopGateway } from "../../api/src/modules/payments/testing/fake-whop.gateway";
import { isDockerAvailable, startTestDatabase, type TestDatabase } from "./harness";

/**
 * THE TRANSACTION-BOUNDARY PROOF.
 *
 * Every other webhook suite runs against an in-memory fake that MODELS
 * insert-then-run. A model cannot prove Postgres does it: the guarantee being
 * claimed is that the `provider_event` INSERT and the state change share ONE
 * transaction, so two concurrent deliveries of the same event produce a
 * primary-key violation on one of them and roll that whole transaction back —
 * event row, PAID transition and stock decrement together.
 *
 * That property is the difference between a duplicate delivery being free and a
 * duplicate delivery selling the same unit twice. It is also the ONLY
 * unconditional replay defence in the system: the CRM plane binds no timestamp
 * into its webhook signature, so a captured delivery is replayable forever as
 * far as the transport is concerned.
 *
 * Concurrency is the point. A sequential second POST would pass against a naive
 * check-then-write implementation, which is exactly the implementation this test
 * exists to reject.
 */

const SECRET = TEST_WHOP_WEBHOOK_SECRET;

/**
 * The webhook acknowledgement, EARNED rather than asserted.
 *
 * `supertest` types `response.body` as `any`, so every `first.body.outcome` in
 * this file was an unchecked member access — and `outcome` is the assertion that
 * carries the whole suite: it is how a duplicate delivery is distinguished from
 * an applied one. Reading it off an `any` means a controller that stopped
 * returning the field would make these tests pass by comparing `undefined` to
 * `undefined` in some future refactor, not fail.
 *
 * The union is spelled out to match `WebhookOutcome["status"]` in
 * `whop-webhook.service.ts`, so a new outcome added there without updating
 * this suite fails loudly here.
 */
const webhookAckSchema = z
  .object({
    received: z.literal(true),
    outcome: z.enum([
      "applied",
      "duplicate",
      "ignored",
      "unmatched",
      "unparsable",
      "conflicted",
      "stale",
    ]),
  })
  .strict();

type WebhookAckBody = z.infer<typeof webhookAckSchema>;

/** Parse a supertest response body as a webhook ack. Throws if it is not one. */
function ack(response: { readonly body: unknown }): WebhookAckBody {
  return webhookAckSchema.parse(response.body);
}

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  JWT_ACCESS_SECRET: "a".repeat(32),
  // PINNED, exactly as the deployment pins it: the Whop environment DEFAULTS
  // from NODE_ENV, and "test" is not "production", so without this the schema
  // resolves to sandbox and demands the WHOP_SANDBOX_* set this suite has no
  // reason to carry. The keys below are the live-shaped ones.
  WHOP_ENVIRONMENT: "live",
  WHOP_API_KEY: "whop_test_abc123def456ghi789",
  WHOP_ACCOUNT_ID: "biz_test_1",
  WHOP_PRODUCT_ID: "prod_test_1",
  WHOP_WEBHOOK_SECRET: SECRET,
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

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCT_ID = "22222222-2222-4222-8222-222222222222";
const VARIANT_ID = "33333333-3333-4333-8333-333333333333";
const CHECKOUT_ID = "chk_e2e_token";
const GRAND_TOTAL = 4999;
const STOCK_ON_HAND = 10;
const RESERVED = 2;

describe.skipIf(!isDockerAvailable())("Whop webhook — dedupe under concurrency", () => {
  let db: TestDatabase;
  let app: NestExpressApplication;
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

    // The WHOLE graph, not just PaymentsModule: the payments providers depend on
    // SERVER_CONFIG and LOGGER, which the global config/observability modules
    // supply, and a suite that hand-assembles a smaller graph is testing a
    // container the application never builds.
    //
    // PrismaService is NOT overridden — the point of this suite is real Postgres,
    // and it reads DATABASE_URL from the env set above.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // The one thing that MUST be faked. `LiveWhopGateway.onModuleInit` runs a
      // boot check against the real Whop API, and `app.init()` below fires
      // module-init hooks. Nothing on the webhook path calls the gateway, so the
      // fake costs no fidelity here — it only stops the suite reaching out to a
      // third party over the network.
      .overrideProvider(WHOP_GATEWAY)
      .useValue(new FakeWhopGateway())
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>(new ExpressAdapter());

    // The SAME bootstrap order main.ts uses, and the order is the whole point:
    // the raw-body middleware must bind before Nest registers its JSON parser,
    // which happens inside `init()`. Testing a different order would test a
    // server we do not ship.
    app.use(WHOP_WEBHOOK_PATH, createRawBodyMiddleware());
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
    await seedPaidableOrder();
  });

  afterEach(() => {
    resetServerConfigCache();
  });

  async function seedPaidableOrder(): Promise<void> {
    const prisma = db.prisma;

    await prisma.product.create({
      data: { id: PRODUCT_ID, slug: "creatine-monohydrate", status: "ACTIVE" },
    });

    await prisma.productVariant.create({
      data: {
        id: VARIANT_ID,
        productId: PRODUCT_ID,
        sku: "AK-CRE-500",
        currency: "EUR",
        priceNet: 4131,
        priceTax: 868,
        priceGross: GRAND_TOTAL,
        taxRateBps: 2100,
      },
    });

    await prisma.inventoryItem.create({
      data: { variantId: VARIANT_ID, onHand: STOCK_ON_HAND, reserved: RESERVED },
    });

    await prisma.order.create({
      data: {
        id: ORDER_ID,
        orderNumber: "AK-2026-000123",
        email: "customer@example.com",
        status: "AWAITING_PAYMENT",
        locale: "es",
        currency: "EUR",
        subtotal: 4131,
        taxTotal: 868,
        grandTotal: GRAND_TOTAL,
        providerCheckoutId: CHECKOUT_ID,
        shipFirstName: "Ana",
        shipLastName: "Garcia",
        shipLine1: "Calle Mayor 1",
        shipCity: "Madrid",
        shipPostalCode: "28001",
        shipCountryCode: "ES",
        billFirstName: "Ana",
        billLastName: "Garcia",
        billLine1: "Calle Mayor 1",
        billCity: "Madrid",
        billPostalCode: "28001",
        billCountryCode: "ES",
      },
    });

    // The stock this order is holding. `commitReservationsForOrder` turns it
    // into a sale inside the PAID transaction — which is the third thing that
    // must happen exactly once.
    await prisma.stockReservation.create({
      data: {
        variantId: VARIANT_ID,
        orderId: ORDER_ID,
        quantity: RESERVED,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
  }

  /**
   * A settlement body.
   *
   * MONEY IS MAJOR UNITS on this provider's webhook plane: `GRAND_TOTAL` is
   * integer minor units, so it is divided here and nowhere else in this file.
   */
  function settlementEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "evt_whop_concurrent_0001",
      type: "payment.succeeded",
      timestamp: new Date().toISOString(),
      data: {
        id: "pay_e2e_1",
        checkout_configuration_id: CHECKOUT_ID,
        metadata: { order_id: ORDER_ID, order_number: "AK-2026-000123" },
        status: "paid",
        substatus: "succeeded",
        total: GRAND_TOTAL / 100,
        currency: "eur",
        paid_at: new Date().toISOString(),
        ...overrides,
      },
    };
  }

  function post(signed: { payload: string; headers: Record<string, string> }) {
    return request(app.getHttpServer())
      .post(WHOP_WEBHOOK_PATH)
      .set("Content-Type", "application/json")
      .set(signed.headers)
      // `.send(string)` transmits the bytes verbatim. Passing an object would
      // let supertest re-serialise it and the signature would no longer match —
      // the exact defect the raw-body path exists to prevent.
      .send(signed.payload);
  }

  it("applies ONE of two concurrent identical deliveries, and exactly one", async () => {
    const signed = buildSignedWhopEvent(settlementEvent(), { secret: SECRET });

    // Fired together, not one after the other. Both transactions race for the
    // same primary key; Postgres must let exactly one commit.
    const [first, second] = await Promise.all([post(signed), post(signed)]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // One applied, one recognised as a duplicate — in either order, because the
    // winner of the race is genuinely nondeterministic.
    const outcomes = [ack(first).outcome, ack(second).outcome].sort();
    expect(outcomes).toEqual(["applied", "duplicate"]);

    // 1. Exactly one provider_event row.
    const events = await db.prisma.providerEvent.findMany();
    expect(events).toHaveLength(1);
    // The key is the `webhook-id` HEADER, which Whop sends on every delivery and
    // its own documentation names as the value to store for duplicate detection.
    expect(events[0]?.id).toBe(signed.headers["webhook-id"]);

    // 2. Exactly one PAID transition.
    const order = await db.prisma.order.findUniqueOrThrow({ where: { id: ORDER_ID } });
    expect(order.status).toBe("PAID");
    expect(order.paidAt).not.toBeNull();

    const paidEvents = await db.prisma.orderEvent.findMany({
      where: { orderId: ORDER_ID, type: "payment.succeeded" },
    });
    expect(paidEvents).toHaveLength(1);

    // 3. Exactly one stock decrement. THE MONEY QUESTION: a double-decrement
    // here is a unit sold twice.
    const inventory = await db.prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: VARIANT_ID },
    });
    expect(inventory.onHand).toBe(STOCK_ON_HAND - RESERVED);
    expect(inventory.reserved).toBe(0);

    const saleEntries = await db.prisma.inventoryLedgerEntry.findMany({
      where: { variantId: VARIANT_ID, movement: "SALE" },
    });
    expect(saleEntries).toHaveLength(1);
    expect(saleEntries[0]?.quantityDelta).toBe(-RESERVED);

    // And the reservation is claimed once, not twice.
    const reservations = await db.prisma.stockReservation.findMany({
      where: { orderId: ORDER_ID },
    });
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.releasedAt).not.toBeNull();
  });

  it("applies ONE settlement when payment/succeeded and order/paid race with DIFFERENT ids", async () => {
    // THE CASE `provider_event` CANNOT COVER, AND THE ONE THAT ACTUALLY HAPPENS.
    //
    // TagadaPay emits both `payment/succeeded` and `order/paid` for a single
    // settlement. They are distinct events with distinct ids, so the dedupe
    // table does NOT collapse them — by design. What must collapse them is the
    // state machine: the second one to reach `applyPaid` has to see PAID and
    // treat itself as redundant.
    //
    // That guard is a read-then-write, and under READ COMMITTED an unlocked read
    // makes it a TOCTOU window. Measured before the fix, with both fired
    // together: two `payment.succeeded` order events, TWO invoice
    // allocate-and-render jobs (two gap-free invoice numbers for one order), two
    // order-fulfilment prepare jobs — a real risk of shipping twice — and six
    // emails. Stock survived only by accident, saved by an unrelated row lock
    // inside `commitReservationsForOrder`.
    //
    // The fix is the `FOR UPDATE` lock in `findOrderByProviderReference`, which
    // serialises the two transactions on the order row so the loser re-reads the
    // winner's committed state. Note both bodies omit the payment id: the unique
    // index on `payment.providerPaymentId` would otherwise mask the race behind
    // a 500, which is the OTHER defect and not the one under test here.
    const withoutPaymentId = (): Record<string, unknown> => {
      const body = settlementEvent();
      delete (body["data"] as Record<string, unknown>)["id"];
      return body;
    };

    const succeeded = buildSignedWhopEvent(withoutPaymentId(), {
      secret: SECRET,
      deliveryId: "msg_race_payment",
    });

    const paid = buildSignedWhopEvent(withoutPaymentId(), {
      secret: SECRET,
      deliveryId: "msg_race_order",
    });

    const [first, second] = await Promise.all([post(succeeded), post(paid)]);

    // Both are authentic and both are accepted. A 5xx on either would put
    // Whop into a retry loop.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // Two genuinely distinct events, so two dedupe rows. That is correct and is
    // exactly why the dedupe table cannot be what protects this case.
    expect(await db.prisma.providerEvent.count()).toBe(2);

    const order = await db.prisma.order.findUniqueOrThrow({ where: { id: ORDER_ID } });
    expect(order.status).toBe("PAID");

    // ONE settlement, and every downstream effect exactly once.
    const paidEvents = await db.prisma.orderEvent.findMany({
      where: { orderId: ORDER_ID, type: "payment.succeeded" },
    });
    expect(paidEvents).toHaveLength(1);

    const jobs = await db.prisma.outboxMessage.findMany();
    const topics = jobs.map((job) => job.topic).sort();

    // 2 customer emails + 1 admin email = exactly one settlement's worth.
    expect(topics).toEqual(["email", "email", "email"]);

    // NO `invoice-pdf` AND NO `order-fulfilment`, and their absence is the
    // assertion rather than an omission. `settleOrderPaid` deliberately stopped
    // producing both: neither topic has a registered handler (`invoices` and
    // `fulfilment` are empty modules) and the dispatcher treats an unrouted topic
    // as a FAILURE, so every paid order was burning retries and dead-lettering on
    // /admin/jobs while the order itself was fine. When those consumers land, the
    // producers come back in the same change — and this expectation with them,
    // because a SECOND invoice job is a second gap-free invoice number for one
    // order and a second fulfilment job is a shipment sent twice.
    expect(jobs.filter((job) => job.topic === "invoice-pdf")).toHaveLength(0);
    expect(jobs.filter((job) => job.topic === "order-fulfilment")).toHaveLength(0);

    // And the stock moved once.
    const inventory = await db.prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: VARIANT_ID },
    });
    expect(inventory.onHand).toBe(STOCK_ON_HAND - RESERVED);

    const saleEntries = await db.prisma.inventoryLedgerEntry.findMany({
      where: { variantId: VARIANT_ID, movement: "SALE" },
    });
    expect(saleEntries).toHaveLength(1);
  });

  it("answers 200 to BOTH of two racing settlements that share a paymentId", async () => {
    // The same race, now with the provider payment id present on both bodies.
    // `recordSettlementPayment` used to check-then-insert with no lock, so the
    // loser raised P2002 on `payment.providerPaymentId` — which escaped the
    // webhook transaction and was rendered as a generic 500 on an AUTHENTIC,
    // correctly-signed delivery. The controller's own contract forbids that: a
    // non-2xx makes Whop retry something we will keep refusing.
    //
    // Note the perverse coupling this test pins down: that accidental unique
    // constraint was the only thing preventing the double-apply above in the
    // same-paymentId case. Both had to be fixed together, so both are asserted
    // together — 200/200 AND exactly one settlement.
    const shared = (): Record<string, unknown> =>
      settlementEvent({ id: "pay_e2e_shared" });

    const [first, second] = await Promise.all([
      post(buildSignedWhopEvent(shared(), { secret: SECRET, deliveryId: "msg_shared_a" })),
      post(buildSignedWhopEvent(shared(), { secret: SECRET, deliveryId: "msg_shared_b" })),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(ack(first).received).toBe(true);
    expect(ack(second).received).toBe(true);

    // One payment row, not two, and not a crash.
    const payments = await db.prisma.payment.findMany({ where: { orderId: ORDER_ID } });
    expect(payments).toHaveLength(1);
    expect(payments[0]?.providerPaymentId).toBe("pay_e2e_shared");
    expect(payments[0]?.amount).toBe(GRAND_TOTAL);

    const paidEvents = await db.prisma.orderEvent.findMany({
      where: { orderId: ORDER_ID, type: "payment.succeeded" },
    });
    expect(paidEvents).toHaveLength(1);
  });

  it("stays idempotent when the SAME event is redelivered later", async () => {
    const signed = buildSignedWhopEvent(settlementEvent(), { secret: SECRET });

    const first = await post(signed);
    expect(ack(first).outcome).toBe("applied");

    // Sequential redelivery — what a vendor retry actually looks like.
    const second = await post(signed);
    expect(second.status).toBe(200);
    expect(ack(second).outcome).toBe("duplicate");

    expect(await db.prisma.providerEvent.count()).toBe(1);
    const inventory = await db.prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: VARIANT_ID },
    });
    expect(inventory.onHand).toBe(STOCK_ON_HAND - RESERVED);
  });

  it("rejects a forged signature and changes NOTHING", async () => {
    const forged = buildForgedWhopEvent(settlementEvent());

    const response = await post(forged);

    // The signature is the entire security boundary on this plane — TagadaPay
    // presents no session and no other credential. Accepting this would let
    // anyone on the internet mark any order PAID.
    expect(response.status).toBe(400);

    const order = await db.prisma.order.findUniqueOrThrow({ where: { id: ORDER_ID } });
    expect(order.status).toBe("AWAITING_PAYMENT");
    expect(await db.prisma.providerEvent.count()).toBe(0);

    const inventory = await db.prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: VARIANT_ID },
    });
    expect(inventory.onHand).toBe(STOCK_ON_HAND);
  });

  it("parks a wrong-amount settlement in PAYMENT_MISMATCH and HOLDS the stock", async () => {
    const signed = buildSignedWhopEvent(settlementEvent({ total: 0.01 }), {
      secret: SECRET,
    });

    const response = await post(signed);
    expect(response.status).toBe(200);

    const order = await db.prisma.order.findUniqueOrThrow({ where: { id: ORDER_ID } });
    expect(order.status).toBe("PAYMENT_MISMATCH");
    expect(order.paidAt).toBeNull();

    // THE NON-OBVIOUS HALF: the reservation is neither committed NOR released.
    // Money may well have moved, so handing the stock back would let the same
    // units be sold again while a paid-for order is still open.
    const inventory = await db.prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: VARIANT_ID },
    });
    expect(inventory.onHand).toBe(STOCK_ON_HAND);
    expect(inventory.reserved).toBe(RESERVED);

    const reservations = await db.prisma.stockReservation.findMany({
      where: { orderId: ORDER_ID },
    });
    expect(reservations[0]?.releasedAt).toBeNull();

    // Nothing customer-facing and nothing gap-free-numbered was queued.
    const jobs = await db.prisma.outboxMessage.findMany();
    expect(jobs.map((job) => job.topic)).toEqual(["notifications"]);
  });

  it("alerts ONCE for a replayed unparsable body, and the synthetic key fits the column", async () => {
    // The verified-but-unparsable path is a WRITE reachable by replay. It used to run
    // outside `runOnceForEvent` in a transaction of its own, ahead of the freshness check
    // — so one captured delivery replayed N times wrote N outbox rows and paged an
    // operator N times, at no cost to the replayer and regardless of how old the capture
    // was. It is now keyed on the SHA-256 of the signed bytes.
    //
    // Only real Postgres can prove the two things that matter here: that the synthetic
    // id fits `provider_event.id VarChar(128)` (a silent truncation would collapse
    // distinct alerts into one) and that the type fits `VarChar(64)`.
    // Signature-valid, schema-invalid: `type` must be a string.
    const signed = buildSignedWhopEvent({ type: 12345, data: {} }, { secret: SECRET });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await post(signed);
      expect(response.status).toBe(200);
      expect(ack(response).outcome).toBe("unparsable");
    }

    const alerts = await db.prisma.outboxMessage.findMany({ where: { topic: "notifications" } });
    expect(alerts).toHaveLength(1);

    const events = await db.prisma.providerEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("webhook/unparsable");
    // 11-char prefix + a 64-char hex digest, stored whole.
    expect(events[0]?.id).toHaveLength(75);
    expect(events[0]?.id.startsWith("unparsable:")).toBe(true);

    // And nothing about the order moved.
    const order = await db.prisma.order.findUniqueOrThrow({ where: { id: ORDER_ID } });
    expect(order.status).toBe("AWAITING_PAYMENT");
  });
});
