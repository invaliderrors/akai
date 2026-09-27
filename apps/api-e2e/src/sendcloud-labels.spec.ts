import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ExpressAdapter } from "@nestjs/platform-express";
import { resetServerConfigCache } from "@akai/config";
import {
  adminOrderSummarySchema,
  bulkLabelResultSchema,
  cancelLabelResultSchema,
  paginatedSchema,
} from "@akai/contracts";
import { type FakeSendcloudServer, startFakeSendcloud } from "@akai/testing";
import { PDFDocument } from "pdf-lib";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppModule } from "../../api/src/app.module";
import { API_GLOBAL_PREFIX } from "../../api/src/common/api-paths";
import type { AuthenticatedUser } from "../../api/src/modules/auth/auth.types";
import { AuthService } from "../../api/src/modules/auth/auth.service";
import { SendcloudClient } from "../../api/src/modules/fulfilment/sendcloud/sendcloud.client";
import { SENDCLOUD_CLIENT } from "../../api/src/modules/fulfilment/sendcloud/sendcloud.port";
import { OutboxDispatcher } from "../../api/src/modules/outbox/outbox.dispatcher";
import { OUTBOX_HANDLERS, type OutboxHandler } from "../../api/src/modules/outbox/outbox.types";
import { FakeWhopGateway } from "../../api/src/modules/payments/testing/fake-whop.gateway";
import { WHOP_GATEWAY } from "../../api/src/modules/payments/whop/whop.gateway";
import { type FakeObjectStore, startFakeObjectStore } from "./fake-object-store";
import { isDockerAvailable, startTestDatabase, type TestDatabase } from "./harness";

/**
 * SENDCLOUD LABELS END TO END (plan Phases 4–5, spec §10): staff bulk generate
 * → the outbox drains → the REAL `SendcloudClient` announces against the fake
 * Sendcloud → the PDF is PUT over HTTP into a fake object store → a Shipment
 * row and PAID → FULFILLING in real Postgres → print merges the stored PDFs in
 * request order → download 302s → cancel walks the order back to PAID.
 *
 * AUTHENTICATION IS STUBBED at `AuthService.authenticate` (one bearer token →
 * a STAFF principal): the global JwtAuthGuard and the REAL RolesGuard still
 * run, and authentication itself has its own suites. What only this suite
 * proves is the label pipeline across the real HTTP, SQL and outbox seams.
 */

const adminOrderPageSchema = paginatedSchema(adminOrderSummarySchema);

const STAFF_TOKEN = "staff-token-e2e";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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
  S3_BUCKET: "akai-media",
  S3_BUCKET_PRIVATE: "akai-private",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
  CORS_ALLOWED_ORIGINS: "http://localhost:3000",
  STOREFRONT_URL: "http://localhost:3000",
  DASHBOARD_URL: "http://localhost:3001",
  REVALIDATE_SIGNING_SECRET: "b".repeat(32),
  SENDCLOUD_PUBLIC_KEY: "pub_e2e",
  SENDCLOUD_SECRET_KEY: "sec_e2e",
  SENDCLOUD_SENDER_ADDRESS_ID: "920582",
  // TEST mode — the default outside the live deployment: the label bought is
  // the free `sendcloud:letter`, whatever the rate is mapped to.
  SENDCLOUD_MODE: "test",
};

const INLINE = "11111111-1111-4111-8111-111111111111";
const DOWNLOADED = "22222222-2222-4222-8222-222222222222";
const UNMAPPED = "33333333-3333-4333-8333-333333333333";

/** Page width per order — how the merged PDF's order is read back. */
const WIDTH: Readonly<Record<string, number>> = { [INLINE]: 301, [DOWNLOADED]: 302 };
const PARCEL: Readonly<Record<string, number>> = { [INLINE]: 700000001, [DOWNLOADED]: 700000002 };

async function pdfOfWidth(width: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([width, 420]);
  return Buffer.from(await doc.save());
}


describe.skipIf(!isDockerAvailable())("Sendcloud labels — bulk generate → outbox → shipment + stored PDF → print (real Postgres)", () => {
  let db: TestDatabase;
  let fake: FakeSendcloudServer;
  let store: FakeObjectStore;
  let app: NestExpressApplication;
  let dispatcher: OutboxDispatcher;
  let savedEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    savedEnv = process.env;
    db = await startTestDatabase();
    fake = await startFakeSendcloud();
    store = await startFakeObjectStore();

    process.env = {
      ...TEST_ENV,
      S3_ENDPOINT: store.endpoint,
      DATABASE_URL: db.databaseUrl,
      DIRECT_DATABASE_URL: db.databaseUrl,
    };
    resetServerConfigCache();

    const staff: AuthenticatedUser = {
      customerId: STAFF_ID,
      sessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      role: "STAFF",
      email: "staff@example.com",
      emailVerified: true,
      // Admin routes demand a RECENT second factor (TwoFactorFreshnessGuard).
      twoFactorAssertedAt: new Date(),
    };

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WHOP_GATEWAY)
      .useValue(new FakeWhopGateway())
      .overrideProvider(SENDCLOUD_CLIENT)
      .useValue(
        new SendcloudClient(
          { publicKey: "pub_e2e", secretKey: "sec_e2e", baseUrl: fake.baseUrl, maxRetries: 0 },
          { sleep: () => Promise.resolve() },
        ),
      )
      .overrideProvider(AuthService)
      .useValue({
        authenticate: async (token: string): Promise<AuthenticatedUser | null> =>
          token === STAFF_TOKEN ? staff : null,
      })
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>(new ExpressAdapter());
    app.setGlobalPrefix(API_GLOBAL_PREFIX);
    await app.init();

    dispatcher = app.get(OutboxDispatcher);
    dispatcher.registerAll(app.get<readonly OutboxHandler[]>(OUTBOX_HANDLERS));
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await fake?.close();
    await store?.close();
    await db?.stop();
    process.env = savedEnv;
    resetServerConfigCache();
  });

  beforeEach(async () => {
    await db.reset();
    fake.reset();
    store.objects.clear();

    // Announce: the fixture's shape, echoing the request. The INLINE order's
    // label comes back base64 in the body; the other's must be downloaded.
    fake.on("POST", "/shipments/announce", async (req) => {
      const body = req.body;
      const reference =
        typeof body === "object" && body !== null && "external_reference_id" in body
          ? String(body.external_reference_id)
          : "";
      const orderId = reference.split(":")[0] ?? reference;
      const width = WIDTH[orderId] ?? 399;
      // A new parcel per attempt, as Sendcloud would (`order:1` → +1000).
      const attempt = Number(reference.split(":")[1] ?? "0");
      const parcelId = (PARCEL[orderId] ?? 799999999) + attempt * 1_000;
      return {
        status: 200,
        body: {
          data: {
            // Sendcloud mints a NEW shipment per reference.
            id: `sc-${reference}`,
            external_reference_id: reference,
            order_number: "NX",
            carrier: { code: "sendcloud", name: "Sendcloud" },
            ship_with: { type: "shipping_option_code", properties: { shipping_option_code: "sendcloud:letter" } },
            parcels: [
              {
                id: parcelId,
                status: { code: "READY_TO_SEND", message: "Ready to send" },
                tracking_number: `SC${String(parcelId)}`,
                tracking_url: `https://tracking.sendcloud.sc/forward?code=SC${String(parcelId)}`,
                label_file: orderId === INLINE ? (await pdfOfWidth(width)).toString("base64") : null,
              },
            ],
            errors: [],
          },
        },
      };
    });
    fake.on("GET", "/parcels/:id/documents/label", async () => ({
      status: 200,
      headers: { "content-type": "application/pdf" },
      body: new Uint8Array(await pdfOfWidth(WIDTH[DOWNLOADED] ?? 302)),
    }));
    fake.on("POST", "/shipments/:id/cancel", { status: 202, body: { data: { status: "queued" } } });

    for (const [id, number, optionCode] of [
      [INLINE, "AK-2026-000001", "inpost_es:service_point,national_c2c"],
      [DOWNLOADED, "AK-2026-000002", "ups:standard/service_point"],
      [UNMAPPED, "AK-2026-000003", null],
    ] as const) {
      await seedPaidOrder(id, number, optionCode);
    }
  });

  async function seedPaidOrder(id: string, orderNumber: string, optionCode: string | null): Promise<void> {
    await db.prisma.order.create({
      data: {
        id,
        orderNumber,
        email: "ana@example.com",
        status: "PAID",
        locale: "es",
        currency: "EUR",
        subtotal: 8262,
        taxTotal: 1736,
        grandTotal: 9998,
        paidAt: new Date("2026-09-24T09:00:00.000Z"),
        shipFirstName: "Ana",
        shipLastName: "Garcia",
        shipLine1: "Calle Mayor",
        shipHouseNumber: "1",
        shipCity: "Zaragoza",
        shipPostalCode: "50002",
        shipCountryCode: "ES",
        shipPhone: "+34600111222",
        billFirstName: "Ana",
        billLastName: "Garcia",
        billLine1: "Calle Mayor 1",
        billCity: "Zaragoza",
        billPostalCode: "50002",
        billCountryCode: "ES",
        shippingMethodName: "Pickup",
        sendcloudOptionCode: optionCode,
        servicePointId: "10875349",
        servicePointName: "PAPELERIA PILI",
        servicePointAddress: "Calle Delicias 12, 50002 Zaragoza, ES",
        parcelWeightGrams: 750,
        items: {
          create: [
            {
              productName: "Oversized Tee",
              variantName: "L",
              sku: "AK-TEE-BLK-L",
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
  }

  function staffPost(path: string) {
    return request(app.getHttpServer())
      .post(`/${API_GLOBAL_PREFIX}${path}`)
      .set("authorization", `Bearer ${STAFF_TOKEN}`);
  }

  async function drain(): Promise<void> {
    for (let pass = 0; pass < 10; pass += 1) {
      const summary = await dispatcher.dispatchDue(new Date(Date.now() + 1_000));
      if (summary.claimed === 0) break;
    }
  }

  async function generate(orderIds: readonly string[], key: string) {
    const response = await staffPost("/admin/fulfilment/labels")
      .set("idempotency-key", key)
      .send({ orderIds });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    return bulkLabelResultSchema.parse(response.body);
  }

  it("bulk generate → drain → shipments, stored PDFs, FULFILLING; then print, download, cancel", async () => {
    // 1. The request answers at once, with the split. Nothing bought yet.
    const result = await generate([INLINE, DOWNLOADED, UNMAPPED], "bulk-1");
    expect(result).toEqual({
      accepted: ["AK-2026-000001", "AK-2026-000002"],
      skipped: [{ orderId: UNMAPPED, orderNumber: "AK-2026-000003", reason: "RATE_NOT_MAPPED" }],
    });
    expect(fake.requestsTo("POST", "/shipments/announce")).toHaveLength(0);
    expect(await db.prisma.outboxMessage.count({ where: { topic: "order-fulfilment" } })).toBe(2);

    // The same Idempotency-Key replays the answer and enqueues nothing more.
    expect(await generate([INLINE, DOWNLOADED, UNMAPPED], "bulk-1")).toEqual(result);
    expect(await db.prisma.outboxMessage.count({ where: { topic: "order-fulfilment" } })).toBe(2);

    // 2. The outbox drains: one announce per order, in TEST mode.
    await drain();
    const announces = fake.requestsTo("POST", "/shipments/announce");
    expect(announces).toHaveLength(2);
    for (const call of announces) {
      expect(call.body).toMatchObject({
        from_address: { sender_address_id: 920582 },
        ship_with: { properties: { shipping_option_code: "sendcloud:letter" } },
        parcels: [{ weight: { value: "750", unit: "g" } }],
        to_address: { house_number: "1", phone_number: "+34600111222" },
      });
      // Test mode never sends the pickup point (a letter cannot go to one).
      expect(call.body).not.toHaveProperty("to_service_point");
    }
    // The label NOT returned inline was downloaded.
    expect(fake.requestsTo("GET", "/parcels/:id/documents/label")).toHaveLength(1);

    const shipments = await db.prisma.shipment.findMany({
      orderBy: { createdAt: "asc" },
      include: { items: true },
    });
    expect(shipments).toHaveLength(2);
    for (const shipment of shipments) {
      expect(shipment).toMatchObject({ provider: "SENDCLOUD", status: "LABEL_CREATED" });
      expect(shipment.items).toEqual([expect.objectContaining({ quantity: 2 })]);
      const key = `akai-private/${shipment.labelObjectKey ?? "missing"}`;
      expect(store.objects.has(key)).toBe(true);
      expect(store.contentTypes.get(key)).toBe("application/pdf");
    }
    for (const id of [INLINE, DOWNLOADED]) {
      expect((await db.prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe("FULFILLING");
    }
    expect((await db.prisma.order.findUniqueOrThrow({ where: { id: UNMAPPED } })).status).toBe("PAID");
    // A label is not "shipped": no shipping-confirmation mail was enqueued.
    const mails = await db.prisma.outboxMessage.findMany({ where: { topic: "email" } });
    expect(JSON.stringify(mails.map((mail) => mail.payload))).not.toContain("shipping-confirmation");

    // Draining again, and asking again, buys nothing more.
    await drain();
    const again = await generate([INLINE, DOWNLOADED], "bulk-2");
    expect(again.accepted).toEqual([]);
    expect(again.skipped.map((skip) => skip.reason)).toEqual(["ALREADY_LABELLED", "ALREADY_LABELLED"]);
    expect(fake.requestsTo("POST", "/shipments/announce")).toHaveLength(2);

    // 3. Print: OUR stored PDFs, merged in REQUEST order.
    const printed = await staffPost("/admin/fulfilment/labels/print")
      .send({ orderIds: [DOWNLOADED, UNMAPPED, INLINE] })
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(printed.status).toBe(200);
    expect(printed.headers["content-type"]).toContain("application/pdf");
    expect(printed.headers["x-labels-skipped"]).toBe(UNMAPPED);
    expect(printed.headers["x-labels-count"]).toBe("2");
    const merged = await PDFDocument.load(Buffer.isBuffer(printed.body) ? printed.body : Buffer.alloc(0));
    expect(merged.getPages().map((page) => page.getWidth())).toEqual([302, 301]);

    // 4. Download: a 302 to a signed URL on the private bucket.
    const inlineShipment = shipments.find((shipment) => shipment.orderId === INLINE);
    if (inlineShipment === undefined) throw new Error("no shipment for INLINE");
    const download = await request(app.getHttpServer())
      .get(`/${API_GLOBAL_PREFIX}/admin/fulfilment/shipments/${inlineShipment.id}/label`)
      .set("authorization", `Bearer ${STAFF_TOKEN}`);
    expect(download.status).toBe(302);
    const location = new URL(String(download.headers["location"]));
    expect(location.origin).toBe(store.endpoint);
    expect(location.pathname).toBe(`/akai-private/labels/${INLINE}/${String(PARCEL[INLINE])}.pdf`);
    expect(location.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);

    // 5. Cancel (Sendcloud 202 queued): CANCELLED, order back to PAID, and the
    // order is eligible again — under a FRESH external reference.
    const cancelled = await staffPost(`/admin/fulfilment/shipments/${inlineShipment.id}/cancel`)
      .set("idempotency-key", "cancel-1");
    expect(cancelled.status).toBe(200);
    expect(cancelLabelResultSchema.parse(cancelled.body)).toEqual({
      shipmentId: inlineShipment.id,
      status: "CANCELLED",
      orderStatus: "PAID",
    });
    expect((await db.prisma.order.findUniqueOrThrow({ where: { id: INLINE } })).status).toBe("PAID");

    const relabel = await generate([INLINE], "bulk-3");
    expect(relabel.accepted).toEqual(["AK-2026-000001"]);
    await drain();
    const lastAnnounce = fake.requestsTo("POST", "/shipments/announce").at(-1);
    expect(lastAnnounce?.body).toMatchObject({ external_reference_id: `${INLINE}:1` });
    const history = await db.prisma.shipment.findMany({
      where: { orderId: INLINE },
      orderBy: { createdAt: "asc" },
    });
    expect(history.map((shipment) => shipment.status)).toEqual(["CANCELLED", "LABEL_CREATED"]);
    expect((await db.prisma.order.findUniqueOrThrow({ where: { id: INLINE } })).status).toBe("FULFILLING");
  });

  it("a 200 with a failed announcement records FAILED with the detail and leaves the order PAID; retry re-enqueues", async () => {
    fake.queue("POST", "/shipments/announce", {
      status: 200,
      body: {
        data: {
          id: "sc-failed",
          external_reference_id: INLINE,
          carrier: { code: "inpost_es", name: "InPost" },
          parcels: [
            {
              id: 700000009,
              status: { code: "ANNOUNCEMENT_FAILED", message: "Announcement failed" },
              tracking_number: null,
              tracking_url: null,
              label_file: null,
            },
          ],
          errors: [{ status: "400", code: "invalid", detail: "House number is required" }],
        },
      },
    });

    await generate([INLINE], "fail-1");
    await drain();

    const failed = await db.prisma.shipment.findFirstOrThrow({ where: { orderId: INLINE } });
    expect(failed).toMatchObject({ status: "FAILED", provider: "SENDCLOUD", labelObjectKey: null });
    expect(failed.failureReason).toContain("House number is required");
    expect((await db.prisma.order.findUniqueOrThrow({ where: { id: INLINE } })).status).toBe("PAID");
    // The job settled — a refusal is not retried eight times.
    expect(
      await db.prisma.outboxMessage.count({ where: { topic: "order-fulfilment", processedAt: null } }),
    ).toBe(0);

    const retried = await staffPost(`/admin/fulfilment/shipments/${failed.id}/retry`)
      .set("idempotency-key", "retry-1");
    expect(retried.status).toBe(202);
    expect(bulkLabelResultSchema.parse(retried.body).accepted).toEqual(["AK-2026-000001"]);
    await drain();

    const shipments = await db.prisma.shipment.findMany({
      where: { orderId: INLINE },
      orderBy: { createdAt: "asc" },
    });
    expect(shipments.map((shipment) => shipment.status)).toEqual(["FAILED", "LABEL_CREATED"]);
    expect((await db.prisma.order.findUniqueOrThrow({ where: { id: INLINE } })).status).toBe("FULFILLING");
  });

  it("the admin order list filters by shipping state and carries the newest shipment", async () => {
    await generate([INLINE], "list-1");
    await drain();

    const labelled = await request(app.getHttpServer())
      .get(`/${API_GLOBAL_PREFIX}/admin/orders?shipping=LABEL_CREATED`)
      .set("authorization", `Bearer ${STAFF_TOKEN}`);
    expect(labelled.status).toBe(200);
    const labelledPage = adminOrderPageSchema.parse(labelled.body);
    expect(labelledPage.items.map((row) => row.orderNumber)).toEqual(["AK-2026-000001"]);
    expect(labelledPage.items[0]?.shipment).toMatchObject({
      status: "LABEL_CREATED",
      provider: "SENDCLOUD",
      hasLabel: true,
    });

    const unlabelled = await request(app.getHttpServer())
      .get(`/${API_GLOBAL_PREFIX}/admin/orders?shipping=NO_LABEL`)
      .set("authorization", `Bearer ${STAFF_TOKEN}`);
    expect(
      adminOrderPageSchema.parse(unlabelled.body).items.map((row) => row.orderNumber).sort(),
    ).toEqual(["AK-2026-000002", "AK-2026-000003"]);
  });
});
