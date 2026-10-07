import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetServerConfigCache } from "@akai/config";
import { AppModule } from "./app.module";
import { RESEND_WEBHOOK_PATH, WOMPI_WEBHOOK_PATH } from "./common/api-paths";
import { PAYMENTS_REPOSITORY } from "./modules/payments/repository/payments.repository";
import { WOMPI_GATEWAY } from "./modules/payments/wompi/wompi.gateway";
import {
  WOMPI_WEBHOOK_ROUTE,
  WompiWebhookController,
} from "./modules/payments/webhook/wompi-webhook.controller";
import { WompiSettlementService } from "./modules/payments/wompi-settlement.service";
import { ScheduledJobsRunner } from "./modules/queue/scheduled-jobs.runner";
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
  WOMPI_ENVIRONMENT: "sandbox",
  WOMPI_PUBLIC_KEY: "pub_test_unit",
  WOMPI_PRIVATE_KEY: "prv_test_unit",
  WOMPI_INTEGRITY_SECRET: "test_integrity_unit",
  WOMPI_EVENTS_SECRET: "test_events_unit",
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
    expect(moduleRef.get(WompiWebhookController)).toBeDefined();
    expect(moduleRef.get(WompiSettlementService)).toBeDefined();
    expect(moduleRef.get(WOMPI_GATEWAY, { strict: false })).toBeDefined();
    // The reconciliation sweep reaches PaymentsService through the queue module.
    expect(moduleRef.get(ScheduledJobsRunner, { strict: false })).toBeDefined();
    expect(moduleRef.get(PAYMENTS_REPOSITORY, { strict: false })).toBeDefined();
    expect(moduleRef.get(PaymentsService, { strict: false })).toBeDefined();

    await moduleRef.close();
  });

  it("binds exactly ONE payment gateway", async () => {
    const moduleRef = await compile();

    // The Stripe and Whop adapters and their tokens are deleted. Two live
    // payment adapters in one container is a routing decision nobody made.
    expect(() => moduleRef.get<unknown>("STRIPE_GATEWAY", { strict: false })).toThrow();
    expect(() => moduleRef.get<unknown>("WHOP_GATEWAY", { strict: false })).toThrow();

    await moduleRef.close();
  });

  it("derives the webhook paths from the routes the controllers answer on", () => {
    // The Wompi path is what goes in the Wompi dashboard ("URL de Eventos");
    // the Resend path is where main.ts mounts the raw-body middleware.
    expect(WOMPI_WEBHOOK_PATH).toBe(`/v1/${WOMPI_WEBHOOK_ROUTE}`);
    expect(WOMPI_WEBHOOK_PATH).toBe("/v1/webhooks/wompi");
    expect(RESEND_WEBHOOK_PATH).toBe("/v1/webhooks/resend");
  });
});
