import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ExpressAdapter } from "@nestjs/platform-express";
import { resetServerConfigCache } from "@akai/config";
import { type FakeSendcloudServer, startFakeSendcloud } from "@akai/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { AppModule } from "../../api/src/app.module";
import { API_GLOBAL_PREFIX, SENDCLOUD_WEBHOOK_PATH } from "../../api/src/common/api-paths";
import { createRawBodyMiddleware } from "../../api/src/common/middleware/raw-body";
import { InMemoryEmailTransport } from "../../api/src/modules/email/adapters/in-memory.transport";
import { EMAIL_TRANSPORT } from "../../api/src/modules/email/email.port";
import { SendcloudClient } from "../../api/src/modules/fulfilment/sendcloud/sendcloud.client";
import { SENDCLOUD_CLIENT } from "../../api/src/modules/fulfilment/sendcloud/sendcloud.port";
import { signSendcloudBody } from "../../api/src/modules/fulfilment/tracking/sendcloud-signature";
import { ShipmentSyncSweep } from "../../api/src/modules/fulfilment/tracking/shipment-sync.sweep";
import { OutboxDispatcher } from "../../api/src/modules/outbox/outbox.dispatcher";
import { OUTBOX_HANDLERS, type OutboxHandler } from "../../api/src/modules/outbox/outbox.types";
import { FakeWhopGateway } from "../../api/src/modules/payments/testing/fake-whop.gateway";
import { WHOP_GATEWAY } from "../../api/src/modules/payments/whop/whop.gateway";
import { isDockerAvailable, startTestDatabase, type TestDatabase } from "./harness";

/**
 * Sendcloud TRACKING, end to end (spec 2026-09-24-sendcloud-shipping §3.7, §10;
 * plan Phase 6): the whole AppModule over real Postgres, the production
 * `SendcloudClient` over real HTTP against the local fake, the raw-body mount
 * main.ts uses, the real outbox dispatcher and the real email pipeline (only the
 * transport is in-memory).
 *
 * What only this suite proves: the `provider_event` insert and the enqueue
 * commit together in Postgres; the first-scan UPDATE (`shippedAt IS NULL`) is
 * exactly-once against a real row; and a webhook is only a trigger — deliveries
 * in the wrong order converge on Sendcloud's CURRENT state.
 */

const WEBHOOK_SECRET = "sendcloud-webhook-signature-key-e2e";

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  JWT_ACCESS_SECRET: "a".repeat(32),
  WHOP_ENVIRONMENT: "live",
  WHOP_API_KEY: "whop_test_abc123def456ghi789",
  WHOP_ACCOUNT_ID: "biz_test_1",
  WHOP_PRODUCT_ID: "prod_test_1",
  WHOP_WEBHOOK_SECRET: `ws_${"c".repeat(32)}`,
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
  SENDCLOUD_PUBLIC_KEY: "pub_e2e",
  SENDCLOUD_SECRET_KEY: "sec_e2e",
  SENDCLOUD_SENDER_ADDRESS_ID: "920582",
  SENDCLOUD_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ITEM_ID = "44444444-4444-4444-8444-444444444444";
const SHIPMENT_ID = "55555555-5555-4555-8555-555555555555";
const SC_SHIPMENT_ID = "95524bc9-174f-47c8-a03a-e60b83a24fe1";
const PARCEL_ID = 718530367;
const RECIPIENT = "ana@example.com";

const ackSchema = z
  .object({
    received: z.literal(true),
    outcome: z.enum(["enqueued", "duplicate", "unmatched", "ignored"]),
  })
  .strict();

describe.skipIf(!isDockerAvailable())("Sendcloud tracking — webhook → shipment-sync → order (real Postgres)", () => {
  let db: TestDatabase;
  let fake: FakeSendcloudServer;
  let app: NestExpressApplication;
  let dispatcher: OutboxDispatcher;
  let sweep: ShipmentSyncSweep;
  let transport: InMemoryEmailTransport;
  let savedEnv: NodeJS.ProcessEnv;
  /** What Sendcloud's v3 `GET /shipments/{id}` currently says about the parcel. */
  let currentCode = "READY_TO_SEND";

  beforeAll(async () => {
    savedEnv = process.env;
    db = await startTestDatabase();
    fake = await startFakeSendcloud();

    process.env = { ...TEST_ENV, DATABASE_URL: db.databaseUrl, DIRECT_DATABASE_URL: db.databaseUrl };
    resetServerConfigCache();

    transport = new InMemoryEmailTransport();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WHOP_GATEWAY)
      .useValue(new FakeWhopGateway())
      // The PRODUCTION client, pointed at the fake: the base URL is a constant in
      // libs/config (there is no Sendcloud sandbox host), so it is the one thing
      // swapped. Auth, parsing and retries all run for real.
      .overrideProvider(SENDCLOUD_CLIENT)
      .useValue(
        new SendcloudClient(
          { publicKey: "pub_e2e", secretKey: "sec_e2e", baseUrl: fake.baseUrl, maxRetries: 0 },
          { sleep: () => Promise.resolve() },
        ),
      )
      .overrideProvider(EMAIL_TRANSPORT)
      .useValue(transport)
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>(new ExpressAdapter());
    // The SAME bootstrap order main.ts uses: raw body BEFORE Nest's JSON parser.
    app.use(SENDCLOUD_WEBHOOK_PATH, createRawBodyMiddleware());
    app.setGlobalPrefix(API_GLOBAL_PREFIX);
    await app.init();

    dispatcher = app.get(OutboxDispatcher);
    dispatcher.registerAll(app.get<readonly OutboxHandler[]>(OUTBOX_HANDLERS));
    sweep = app.get(ShipmentSyncSweep);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await fake?.close();
    await db?.stop();
    process.env = savedEnv;
    resetServerConfigCache();
  });

  beforeEach(async () => {
    await db.reset();
    fake.reset();
    transport.reset();
    currentCode = "READY_TO_SEND";
    fake.on("GET", "/shipments/:id", (req) => ({
      status: 200,
      body: {
        data: {
          id: req.params["id"],
          external_reference_id: ORDER_ID,
          order_number: "AK-2026-000123",
          carrier: { code: "inpost_es", name: "InPost" },
          parcels: [
            {
              id: PARCEL_ID,
              status: { code: currentCode, message: currentCode },
              tracking_number: "IP123456789",
              tracking_url: "https://tracking.sendcloud.sc/forward?code=IP123456789",
            },
          ],
        },
      },
    }));
    await seedLabelledOrder();
  });

  afterEach(() => {
    resetServerConfigCache();
  });

  async function seedLabelledOrder(): Promise<void> {
    await db.prisma.order.create({
      data: {
        id: ORDER_ID,
        orderNumber: "AK-2026-000123",
        email: RECIPIENT,
        status: "FULFILLING",
        locale: "es",
        currency: "EUR",
        subtotal: 8262,
        taxTotal: 1736,
        grandTotal: 9998,
        paidAt: new Date("2026-09-24T09:00:00.000Z"),
        invoiceNumber: "INV-2026-000001",
        shipFirstName: "Ana",
        shipLastName: "Garcia",
        shipLine1: "Calle Mayor 1",
        shipCity: "Zaragoza",
        shipPostalCode: "50002",
        shipCountryCode: "ES",
        billFirstName: "Ana",
        billLastName: "Garcia",
        billLine1: "Calle Mayor 1",
        billCity: "Zaragoza",
        billPostalCode: "50002",
        billCountryCode: "ES",
        shippingMethodName: "InPost pickup-point",
        servicePointId: "10875349",
        servicePointName: "PAPELERIA PILI",
        servicePointAddress: "Calle Delicias 12, 50002 Zaragoza",
        items: {
          create: [
            {
              id: ORDER_ITEM_ID,
              productName: "Creatine Monohydrate",
              variantName: "500 g",
              sku: "AK-CRE-500",
              quantity: 2,
              unitPriceNet: 4131,
              unitPriceGross: 4999,
              taxRateBps: 2100,
              taxAmount: 1736,
              lineTotalNet: 8262,
              lineTotalGross: 9998,
            },
          ],
        },
      },
    });

    await db.prisma.shipment.create({
      data: {
        id: SHIPMENT_ID,
        orderId: ORDER_ID,
        status: "LABEL_CREATED",
        provider: "SENDCLOUD",
        carrier: "InPost",
        sendcloudShipmentId: SC_SHIPMENT_ID,
        sendcloudParcelId: BigInt(PARCEL_ID),
        sendcloudStatusCode: "READY_TO_SEND",
        items: { create: [{ orderItemId: ORDER_ITEM_ID, quantity: 2 }] },
      },
    });
  }

  function webhookBody(timestamp: number, parcelId: number = PARCEL_ID): Buffer {
    // The legacy v2 shape Sendcloud posts, including the numeric status id the
    // handler deliberately ignores.
    return Buffer.from(
      JSON.stringify({
        action: "parcel_status_changed",
        timestamp,
        parcel: { id: parcelId, tracking_number: "IP123456789", status: { id: 3, message: "En route" } },
      }),
      "utf8",
    );
  }

  async function postWebhook(raw: Buffer, signature = signSendcloudBody(raw, WEBHOOK_SECRET)) {
    return request(app.getHttpServer())
      .post(SENDCLOUD_WEBHOOK_PATH)
      .set("content-type", "application/json")
      .set("Sendcloud-Signature", signature)
      // A STRING is transmitted verbatim; a Buffer under a JSON content type is
      // re-serialised by superagent, and the signature covers the exact bytes.
      .send(raw.toString("utf8"));
  }

  /** Run the outbox to quiescence, exactly as the API's poller would. */
  async function drain(): Promise<void> {
    // Due-now rows first, then a clock two minutes ahead so a deliberately
    // delayed row (the pickup mail held behind the shipping mail) drains too —
    // in the order a real poller would see them.
    for (const offsetMs of [0, 120_000]) {
      for (let pass = 0; pass < 10; pass += 1) {
        const summary = await dispatcher.dispatchDue(new Date(Date.now() + offsetMs));
        if (summary.claimed === 0) {
          break;
        }
      }
    }
  }

  async function orderStatus(): Promise<string> {
    return (await db.prisma.order.findUniqueOrThrow({ where: { id: ORDER_ID } })).status;
  }

  async function sentTemplates(): Promise<string[]> {
    const events = await db.prisma.emailEvent.findMany({
      where: { orderId: ORDER_ID, status: "SENT" },
      orderBy: { createdAt: "asc" },
    });
    return events.map((event) => event.templateKey);
  }

  it("in transit → SHIPPED + shipping-confirmation; then delivered → DELIVERED + delivery-confirmation", async () => {
    currentCode = "SHIPMENT_ON_ROUTE";
    const first = await postWebhook(webhookBody(1_727_200_000_000));
    expect(first.status).toBe(200);
    expect(ackSchema.parse(first.body).outcome).toBe("enqueued");

    await drain();
    expect(await orderStatus()).toBe("SHIPPED");
    const shipment = await db.prisma.shipment.findUniqueOrThrow({ where: { id: SHIPMENT_ID } });
    expect(shipment.status).toBe("IN_TRANSIT");
    expect(shipment.sendcloudStatusCode).toBe("SHIPMENT_ON_ROUTE");
    expect(shipment.shippedAt).not.toBeNull();
    expect(shipment.lastSyncedAt).not.toBeNull();
    expect(shipment.trackingNumber).toBe("IP123456789");
    expect(await sentTemplates()).toEqual(["shipping-confirmation"]);
    const shippingMail = transport.to(RECIPIENT)[0];
    expect(shippingMail?.text).toContain("PAPELERIA PILI");

    currentCode = "DELIVERED";
    const second = await postWebhook(webhookBody(1_727_300_000_000));
    expect(ackSchema.parse(second.body).outcome).toBe("enqueued");
    await drain();

    expect(await orderStatus()).toBe("DELIVERED");
    expect((await db.prisma.shipment.findUniqueOrThrow({ where: { id: SHIPMENT_ID } })).status).toBe("DELIVERED");
    expect(await sentTemplates()).toEqual(["shipping-confirmation", "delivery-confirmation"]);
  });

  it("converges when the deliveries arrive out of order (newer first), with each mail sent once", async () => {
    // Sendcloud already says DELIVERED; the in-transit delivery arrives AFTER it.
    currentCode = "DELIVERED";
    expect(ackSchema.parse((await postWebhook(webhookBody(1_727_300_000_000))).body).outcome).toBe("enqueued");
    expect(ackSchema.parse((await postWebhook(webhookBody(1_727_200_000_000))).body).outcome).toBe("enqueued");
    await drain();

    expect(await orderStatus()).toBe("DELIVERED");
    // Compared as a SET: both mails are enqueued by the one sync that saw
    // DELIVERED first, and the outbox claim (`UPDATE … RETURNING`) does not
    // promise to hand rows back in `availableAt` order within one batch.
    expect((await sentTemplates()).sort()).toEqual(["delivery-confirmation", "shipping-confirmation"]);

    // A stale in-transit read after delivery changes nothing — DELIVERED stays.
    currentCode = "SHIPMENT_ON_ROUTE";
    await postWebhook(webhookBody(1_727_400_000_000));
    await drain();
    expect(await orderStatus()).toBe("DELIVERED");
    expect((await db.prisma.shipment.findUniqueOrThrow({ where: { id: SHIPMENT_ID } })).status).toBe("DELIVERED");
    expect(transport.messages).toHaveLength(2);
  });

  it("mails ready-for-pickup once when the parcel reaches the pickup point", async () => {
    fake.on("GET", "/service-points/:id", {
      status: 200,
      body: {
        data: {
          id: 10875349,
          name: "PAPELERIA PILI",
          carrier: { code: "inpost_es" },
          address: { street: "Calle Delicias", house_number: "12", postal_code: "50002", city: "Zaragoza", country_code: "ES" },
          opening_times: {
            monday: [
              { start_time: "08:00", end_time: "14:00" },
              { start_time: "17:00", end_time: "20:30" },
            ],
            tuesday: null,
            wednesday: null,
            thursday: null,
            friday: null,
            saturday: null,
            sunday: null,
          },
        },
      },
    });
    currentCode = "AWAITING_CUSTOMER_PICKUP";
    await postWebhook(webhookBody(1));
    await postWebhook(webhookBody(2));
    await drain();

    expect(await orderStatus()).toBe("SHIPPED");
    expect(await sentTemplates()).toEqual(["shipping-confirmation", "ready-for-pickup"]);
    expect(transport.messages[1]?.text).toContain("17:00–20:30");
  });

  it("dedupes a redelivery of the same event in the same transaction as the enqueue", async () => {
    const raw = webhookBody(1_727_200_000_000);
    expect(ackSchema.parse((await postWebhook(raw)).body).outcome).toBe("enqueued");
    expect(ackSchema.parse((await postWebhook(raw)).body).outcome).toBe("duplicate");

    expect(await db.prisma.outboxMessage.count({ where: { topic: "shipment-sync" } })).toBe(1);
    expect(await db.prisma.providerEvent.count()).toBe(1);
  });

  it("answers 200 for a parcel it does not know, and enqueues nothing", async () => {
    const response = await postWebhook(webhookBody(5, 999));
    expect(response.status).toBe(200);
    expect(ackSchema.parse(response.body).outcome).toBe("unmatched");
    expect(await db.prisma.outboxMessage.count()).toBe(0);
  });

  it("refuses a bad signature before touching the database", async () => {
    const raw = webhookBody(5);
    const response = await postWebhook(raw, signSendcloudBody(raw, "not-the-key"));
    expect(response.status).toBe(400);
    expect(await db.prisma.providerEvent.count()).toBe(0);
  });

  it("leaves an unknown Sendcloud code alone — the order is never marked delivered", async () => {
    currentCode = "UNKNOWN";
    await postWebhook(webhookBody(7));
    await drain();

    const shipment = await db.prisma.shipment.findUniqueOrThrow({ where: { id: SHIPMENT_ID } });
    expect(shipment.status).toBe("LABEL_CREATED");
    expect(shipment.sendcloudStatusCode).toBe("UNKNOWN");
    expect(await orderStatus()).toBe("FULFILLING");
    expect(transport.messages).toHaveLength(0);
  });

  it("the sweep re-syncs a stale live shipment and skips a fresh one", async () => {
    await db.prisma.shipment.update({
      where: { id: SHIPMENT_ID },
      data: { lastSyncedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
    });
    currentCode = "SORTED";

    expect(await sweep.enqueueStaleSyncs()).toBe(1);
    await drain();
    expect(await orderStatus()).toBe("SHIPPED");

    // Just synced → not stale any more.
    expect(await sweep.enqueueStaleSyncs()).toBe(0);
  });
});
