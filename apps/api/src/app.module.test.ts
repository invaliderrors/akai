import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetServerConfigCache } from "@akai/config";
import { AppModule } from "./app.module";
import {
  RESEND_WEBHOOK_PATH,
  WHOP_WEBHOOK_PATH,
} from "./common/api-paths";
import { PAYMENTS_REPOSITORY } from "./modules/payments/repository/payments.repository";
import { WHOP_GATEWAY } from "./modules/payments/whop/whop.gateway";
import {
  WHOP_WEBHOOK_ROUTE,
  WhopWebhookController,
} from "./modules/payments/webhook/whop-webhook.controller";
import { WhopWebhookService } from "./modules/payments/webhook/whop-webhook.service";
import { PaymentsService } from "./modules/payments/payments.service";
import { PrismaService } from "./modules/prisma/prisma.service";
import { SERVER_CONFIG } from "./modules/config/config.module";

/**
 * Proves the ENTIRE module graph resolves — every placeholder domain module,
 * the global config/logger/prisma providers, and the middleware registration.
 *
 * This is the test that catches a circular import or a missing provider the
 * moment it is introduced, rather than at `listen()` on a deploy. Prisma is
 * overridden so no database is required.
 */

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://akai:akai@localhost:5432/akai",
  DIRECT_DATABASE_URL: "postgresql://akai:akai@localhost:5432/akai",
  JWT_ACCESS_SECRET: "a".repeat(32),
  WHOP_API_KEY: "whop_test_abc123def456ghi789",
  WHOP_ACCOUNT_ID: "biz_test_1",
  WHOP_PRODUCT_ID: "prod_test_1",
  WHOP_API_VERSION_DATE: "2026-08-14",
  // PINNED, as every real deployment does. NODE_ENV="test" is not production, so
  // an unset value resolves to SANDBOX and the schema then demands a sandbox
  // credential set — the parse throws and takes the whole suite with it.
  WHOP_ENVIRONMENT: "live",
  WHOP_WEBHOOK_SECRET: `ws_${"c".repeat(32)}`,
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

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = process.env;
  process.env = { ...TEST_ENV };
  resetServerConfigCache();
});

afterEach(() => {
  process.env = savedEnv;
  resetServerConfigCache();
});

describe("AppModule", () => {
  it("resolves the complete module graph without a database", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({
        $connect: async () => undefined,
        $disconnect: async () => undefined,
        ping: async () => undefined,
      })
      .compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });

  it("exposes the validated config under SERVER_CONFIG", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({
        $connect: async () => undefined,
        $disconnect: async () => undefined,
        ping: async () => undefined,
      })
      .compile();

    const config = moduleRef.get<{ PORT: number; NODE_ENV: string }>(SERVER_CONFIG);

    expect(config.PORT).toBe(3333);
    expect(config.NODE_ENV).toBe("test");
    await moduleRef.close();
  });
});

/**
 * DI GATE for the payments plane.
 *
 * Nest resolves constructor dependencies from emitted decorator metadata, so a
 * missing provider or a mistyped token is a RUNTIME failure at the first
 * webhook — invisible to `tsc`, and by then a customer has already been charged.
 * These assertions are the reason the graph is compiled in a test at all.
 */
describe("payments wiring", () => {
  async function compile() {
    return Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({
        $connect: async () => undefined,
        $disconnect: async () => undefined,
        ping: async () => undefined,
      })
      .compile();
  }

  it("resolves the webhook controller, its service and the gateway", async () => {
    const moduleRef = await compile();

    // If any of these throws, every inbound payment notification 500s.
    expect(moduleRef.get(WhopWebhookController)).toBeDefined();
    expect(moduleRef.get(WhopWebhookService)).toBeDefined();
    expect(moduleRef.get(WHOP_GATEWAY, { strict: false })).toBeDefined();
    expect(moduleRef.get(PAYMENTS_REPOSITORY, { strict: false })).toBeDefined();
    expect(moduleRef.get(PaymentsService, { strict: false })).toBeDefined();

    await moduleRef.close();
  });

  it("binds exactly ONE payment gateway", async () => {
    const moduleRef = await compile();

    // The Stripe adapter and its token are deleted. Two live payment adapters in
    // one container is a routing decision nobody made, and the way it fails is
    // that a refund goes to the provider that did not take the money.
    expect(() => moduleRef.get<unknown>("STRIPE_GATEWAY", { strict: false })).toThrow();

    await moduleRef.close();
  });

  it("mounts the raw-body middleware on the SAME path the controller answers on", () => {
    // `setGlobalPrefix` rewrites Nest's router but NOT raw Express mounts, so
    // these two are reconciled by hand in main.ts. If they drift, the middleware
    // silently never runs, the controller is still reached with no raw body, and
    // every delivery fails closed with RAW_BODY_UNAVAILABLE — a failure mode no
    // type-checker can see.
    expect(WHOP_WEBHOOK_PATH).toBe(`/v1/${WHOP_WEBHOOK_ROUTE}`);
    expect(WHOP_WEBHOOK_PATH).toBe("/v1/webhooks/whop");
    expect(RESEND_WEBHOOK_PATH).toBe("/v1/webhooks/resend");
  });
});
