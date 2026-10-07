import "reflect-metadata";

import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { ExpressAdapter } from "@nestjs/platform-express";
import { resetServerConfigCache } from "@akai/config";
import { TEST_WHOP_WEBHOOK_SECRET, buildSignedWhopEvent } from "@akai/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppModule } from "../../api/src/app.module";
import { API_GLOBAL_PREFIX, WHOP_WEBHOOK_PATH } from "../../api/src/common/api-paths";
import { createRawBodyMiddleware } from "../../api/src/common/middleware/raw-body";
import {
  PAYMENTS_REPOSITORY,
  type PaymentsRepository,
} from "../../api/src/modules/payments/repository/payments.repository";
import { WHOP_GATEWAY } from "../../api/src/modules/payments/whop/whop.gateway";
import { FakeWhopGateway } from "../../api/src/modules/payments/testing/fake-whop.gateway";
import { isDockerAvailable, startTestDatabase, type TestDatabase } from "./harness";

/**
 * THE GAP-FREE INVOICE NUMBER, PROVEN AGAINST REAL POSTGRES.
 *
 * The platform's invariants migration states the requirement in its own
 * words: "INVOICE numbers may NOT have gaps — that is a legal requirement in most
 * EU member states". The implementation it shipped could not keep that promise,
 * because `next_invoice_number()` is `nextval` underneath and NEXTVAL IS NOT
 * TRANSACTIONAL. Measured on postgres:16-alpine before this change:
 *
 *   - `BEGIN; UPDATE "order" SET "invoiceNumber" = next_invoice_number()
 *     WHERE … IS NULL; ROLLBACK;` left the row NULL and advanced `last_value`
 *     from 1 to 2. A permanent gap, from a settlement that never happened.
 *   - Two overlapping sessions against ONE null row: the winner took
 *     INV-2026-000003, the loser printed `UPDATE 0` — and `last_value` moved
 *     2 -> 4. The target-list `nextval` is evaluated BEFORE the tuple lock is
 *     taken; EvalPlanQual then re-checks `"invoiceNumber" IS NULL`, finds it no
 *     longer holds, and DISCARDS a number it has already consumed.
 *
 * A unit test cannot see any of that: it is a property of how Postgres evaluates
 * a target list against a concurrently-updated tuple, and the previous attempt's
 * tests asserted it against an in-memory fake written in the same commit — so
 * they passed with the production code reverted and proved nothing.
 *
 * THIS SUITE IS THEREFORE DELIBERATELY REVERT-PROOF. Every assertion below is on
 * numbers a REAL Postgres actually issued, and each of the last two fails
 * loudly if `markOrderPaid` goes back to calling `next_invoice_number()`:
 * the rollback test would see INV-…-000002 where it demands 000001, and the
 * concurrency test would see the loser's discarded number missing from the
 * series. Nothing here reads `invoice_counter` directly — the claim under test
 * is about the numbers customers receive, not about the mechanism, so the suite
 * stays honest if the mechanism is ever replaced again.
 */

const SECRET = TEST_WHOP_WEBHOOK_SECRET;

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  JWT_ACCESS_SECRET: "a".repeat(32),
  // PINNED, exactly as the deployment pins it: the Whop environment DEFAULTS
  // from NODE_ENV, and "test" is not "production", so without this the schema
  // resolves to sandbox and demands the WHOP_SANDBOX_* set this suite has no
  // reason to carry.
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
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
  CORS_ALLOWED_ORIGINS: "http://localhost:3000",
  STOREFRONT_URL: "http://localhost:3000",
  DASHBOARD_URL: "http://localhost:3001",
  REVALIDATE_SIGNING_SECRET: "b".repeat(32),
};

const PRODUCT_ID = "22222222-2222-4222-8222-222222222222";
const VARIANT_ID = "33333333-3333-4333-8333-333333333333";

/** The order every test settles first. */
const ORDER_A = "11111111-1111-4111-8111-111111111111";
/**
 * The order settled SECOND, and the entire point of the suite.
 *
 * Whether a rolled-back or a lost settlement burned a number is invisible on the
 * order that was settled — it is visible only in what the NEXT order receives.
 * `A -> INV-…-000001` then `B -> INV-…-000002` is the series being gap-free;
 * `B -> INV-…-000003` is the gap.
 */
const ORDER_B = "44444444-4444-4444-8444-444444444444";

const CHECKOUT_A = "chk_invoice_a";
const GRAND_TOTAL = 4999;

/** `INV-YYYY-NNNNNN` — the format `next_invoice_number()` established. */
const INVOICE_FORMAT = /^INV-\d{4}-\d{6}$/;

describe.skipIf(!isDockerAvailable())("Invoice numbering — gap-free under rollback and concurrency", () => {
  let db: TestDatabase;
  let app: NestExpressApplication;
  let repository: PaymentsRepository;
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // `LiveWhopGateway.onModuleInit` calls the real Whop API, and `app.init()`
      // fires module-init hooks. Nothing on the settlement path touches the
      // gateway, so the fake costs no fidelity — it only keeps the suite off the
      // network.
      .overrideProvider(WHOP_GATEWAY)
      .useValue(new FakeWhopGateway())
      .compile();

    app = moduleRef.createNestApplication<NestExpressApplication>(new ExpressAdapter());
    app.use(WHOP_WEBHOOK_PATH, createRawBodyMiddleware());
    app.setGlobalPrefix(API_GLOBAL_PREFIX);
    await app.init();

    // THE REAL, WIRED REPOSITORY — the same instance the webhook handler uses,
    // against the same Postgres. Reaching for the container rather than
    // constructing one keeps the object under test the object that ships.
    repository = app.get<PaymentsRepository>(PAYMENTS_REPOSITORY);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.stop();
    process.env = savedEnv;
    resetServerConfigCache();
  });

  beforeEach(async () => {
    await db.reset();
    await seedCatalog();
    await seedOrder(ORDER_A, "AK-2026-000001", CHECKOUT_A);
    await seedOrder(ORDER_B, "AK-2026-000002", null);
  });

  afterEach(() => {
    resetServerConfigCache();
  });

  async function seedCatalog(): Promise<void> {
    await db.prisma.product.create({
      data: { id: PRODUCT_ID, slug: "oversized-tee", status: "ACTIVE" },
    });

    await db.prisma.productVariant.create({
      data: {
        id: VARIANT_ID,
        productId: PRODUCT_ID,
        sku: "AK-TEE-BLK-L",
        currency: "EUR",
        priceNet: 4131,
        priceTax: 868,
        priceGross: GRAND_TOTAL,
        taxRateBps: 2100,
      },
    });

    await db.prisma.inventoryItem.create({
      data: { variantId: VARIANT_ID, onHand: 10, reserved: 0 },
    });
  }

  async function seedOrder(
    id: string,
    orderNumber: string,
    checkoutId: string | null,
  ): Promise<void> {
    await db.prisma.order.create({
      data: {
        id,
        orderNumber,
        email: "customer@example.com",
        status: "AWAITING_PAYMENT",
        locale: "es",
        currency: "EUR",
        subtotal: 4131,
        taxTotal: 868,
        grandTotal: GRAND_TOTAL,
        providerCheckoutId: checkoutId,
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
  }

  /** The invoice number currently on an order, or null. */
  async function invoiceNumberOf(orderId: string): Promise<string | null> {
    const order = await db.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    return order.invoiceNumber;
  }

  /** Settle an order the way production does, in one committed transaction. */
  async function settle(orderId: string): Promise<void> {
    await repository.runInTransaction((tx) => tx.markOrderPaid(orderId, new Date()));
  }

  it("gives a settled order a number in the INV-YYYY-NNNNNN format, starting at one", async () => {
    // Through the REAL webhook: signature verification, correlation, the
    // transaction boundary and `settleOrderPaid` — not just the repository call.
    const signed = buildSignedWhopEvent(
      {
        id: "evt_invoice_first",
        type: "payment.succeeded",
        timestamp: new Date().toISOString(),
        data: {
          id: "pay_invoice_first",
          checkout_configuration_id: CHECKOUT_A,
          metadata: { order_id: ORDER_A, order_number: "AK-2026-000001" },
          status: "paid",
          substatus: "succeeded",
          // Whop's webhook plane speaks MAJOR units.
          total: GRAND_TOTAL / 100,
          currency: "eur",
          paid_at: new Date().toISOString(),
        },
      },
      { secret: SECRET },
    );

    const response = await request(app.getHttpServer())
      .post(WHOP_WEBHOOK_PATH)
      .set("Content-Type", "application/json")
      .set(signed.headers)
      .send(signed.payload);

    expect(response.status).toBe(200);

    const order = await db.prisma.order.findUniqueOrThrow({ where: { id: ORDER_A } });
    expect(order.status).toBe("PAID");

    // A PAID order without a number is the defect that dead-lettered every
    // `payment-receipt`: the handler defers while `invoiceNumber` is null.
    expect(order.invoiceNumber).not.toBeNull();
    expect(order.invoiceNumber).toMatch(INVOICE_FORMAT);
    expect(order.invoiceNumber).toMatch(/-000001$/);
  });

  it("consumes NO number when the settlement transaction rolls back", async () => {
    // A settlement that allocates and then fails — a stock CHECK violation, a
    // serialisation failure, a lost connection. The transaction rolls back and
    // the order is untouched; the question is what it cost the series.
    class SettlementAborted extends Error {}

    await expect(
      repository.runInTransaction(async (tx) => {
        await tx.markOrderPaid(ORDER_A, new Date());
        throw new SettlementAborted("settlement failed after allocation");
      }),
    ).rejects.toThrow(SettlementAborted);

    // The order really did roll back.
    expect(await invoiceNumberOf(ORDER_A)).toBeNull();

    // AND THE NUMBER CAME BACK WITH IT. This is the whole assertion: the next
    // order to settle must receive 000001, because nothing was ever issued.
    // With `nextval` behind the allocation this reads INV-…-000002 — a
    // permanent, legally-defective hole in the invoice series.
    await settle(ORDER_B);

    const allocated = await invoiceNumberOf(ORDER_B);
    expect(allocated).toMatch(INVOICE_FORMAT);
    expect(allocated).toMatch(/-000001$/);
  });

  it("allocates exactly ONE number when two settlements of the same order race", async () => {
    // Whop does not guarantee delivery order and retries up to 12 times, so two
    // transactions really can be inside `markOrderPaid` for one order at once.
    const [first, second] = await Promise.allSettled([settle(ORDER_A), settle(ORDER_A)]);

    // Neither is allowed to fail: a 5xx on an authentic delivery puts the
    // provider into a retry loop.
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("fulfilled");

    const onOrderA = await invoiceNumberOf(ORDER_A);
    expect(onOrderA).toMatch(INVOICE_FORMAT);
    expect(onOrderA).toMatch(/-000001$/);

    // THE LOSER MUST HAVE CONSUMED NOTHING. Under `nextval` the losing
    // statement evaluates the target list before it takes the tuple lock, so it
    // draws a number, discovers `"invoiceNumber" IS NULL` no longer holds via
    // EvalPlanQual, updates zero rows — and throws the number away. Invisible on
    // order A; visible here, where B must be 000002 and not 000003.
    await settle(ORDER_B);

    const onOrderB = await invoiceNumberOf(ORDER_B);
    expect(onOrderB).toMatch(INVOICE_FORMAT);
    expect(onOrderB).toMatch(/-000002$/);
  });

  it("does NOT restart the series when the counter row goes missing", async () => {
    await settle(ORDER_A);
    expect(await invoiceNumberOf(ORDER_A)).toMatch(/-000001$/);

    // THE ROW CAN GO MISSING, and that is the dangerous case. A restore from a
    // dump taken before this migration, or a reset run against a database that
    // still holds orders, leaves `invoice_counter` empty. An allocator that
    // re-seeds at 1 then re-issues INV-…-000001 — a number already on a filed
    // invoice — and keeps re-issuing, silently, until the UNIQUE on
    // "order"."invoiceNumber" finally aborts some later customer's settlement
    // on the money path. Duplicated invoice numbers are the legal corruption
    // this whole table exists to prevent, so the re-seed must read what has
    // actually been issued and can only ever move FORWARD.
    await db.prisma.$executeRawUnsafe('DELETE FROM "invoice_counter"');

    await settle(ORDER_B);

    const onOrderB = await invoiceNumberOf(ORDER_B);
    expect(onOrderB).toMatch(INVOICE_FORMAT);
    expect(onOrderB).toMatch(/-000002$/);
  });
});
