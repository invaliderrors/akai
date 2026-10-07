import "reflect-metadata";
import { Global, Module } from "@nestjs/common";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import { describe, expect, it } from "vitest";

import type { ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";

import { SERVER_CONFIG } from "../config/config.module";
import { LOGGER } from "../observability/logger.module";
import { PrismaService } from "../prisma/prisma.service";
import { EmailOutboxHandler } from "../email/email-outbox.handler";
import { OutboxDispatcher } from "./outbox.dispatcher";
import { OutboxModule } from "./outbox.module";
import { OutboxRunner } from "./outbox.runner";
import { OUTBOX_HANDLERS, type OutboxHandler } from "./outbox.types";

/**
 * DI GATE for the async tier.
 *
 * Nest resolves constructor dependencies from emitted decorator metadata, and a
 * token mismatch or a missing provider is a RUNTIME failure the type-checker
 * cannot see. This proves the whole OutboxModule → EmailModule → PaymentsModule
 * graph — the dispatcher, the runner, the `OUTBOX_HANDLERS` factory and the
 * email and revalidation consumers — actually constructs, without needing a live
 * database (the fakes are only ever stored, never called, during `compile()`).
 */
const FAKE_CONFIG = {
  EMAIL_TRANSPORT: "smtp",
  EMAIL_FROM: "ops@akai.test",
  DASHBOARD_URL: "https://dash.akai.test",
  STOREFRONT_URL: "https://shop.akai.test",
  LOG_LEVEL: "info",
  NODE_ENV: "test",
  WHOP_API_KEY: "whop_test_abc123def456ghi789",
  WHOP_ACCOUNT_ID: "biz_test_1",
  WHOP_PRODUCT_ID: "prod_test_1",
  WHOP_WEBHOOK_SECRET: `ws_${"c".repeat(32)}`,
  WHOP_API_VERSION_DATE: "2026-08-14",
  WHOP_ENVIRONMENT: "live",
  /**
   * THE RESOLVED CREDENTIALS the schema normally derives at boot.
   *
   * A cast fixture has to carry this or the payments module throws while Nest is
   * still wiring it up. Consumers read `config.whop` and never choose between
   * sandbox and live themselves — a gateway talking to one environment while the
   * webhook verifies against the other is a payment taken in sandbox and settled
   * against production.
   */
  whop: {
    environment: "live",
    apiKey: "whop_test_abc123def456ghi789",
    accountId: "biz_test_1",
    productId: "prod_test_1",
    webhookSecret: `ws_${"c".repeat(32)}`,
    baseUrl: "https://api.whop.com/api/v1",
  },
} as unknown as ServerEnv;

const FAKE_LOGGER = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

@Global()
@Module({
  providers: [
    { provide: SERVER_CONFIG, useValue: FAKE_CONFIG },
    { provide: LOGGER, useValue: FAKE_LOGGER },
  ],
  exports: [SERVER_CONFIG, LOGGER],
})
class TestInfraModule {}

/**
 * PaymentsModule pulls in the real (@Global) PrismaModule, whose PrismaService
 * builds a live PrismaClient from DATABASE_URL in its constructor. Override the
 * token so no client is ever constructed — the DI proof needs the graph to
 * WIRE, not a database to exist.
 */
function testingModule(): TestingModuleBuilder {
  return Test.createTestingModule({
    imports: [TestInfraModule, OutboxModule],
  })
    .overrideProvider(PrismaService)
    .useValue({} as unknown as PrismaService);
}

describe("OutboxModule — dependency injection", () => {
  it("resolves the dispatcher, runner and email consumer", async () => {
    const moduleRef = await testingModule().compile();

    expect(moduleRef.get(OutboxDispatcher)).toBeInstanceOf(OutboxDispatcher);
    expect(moduleRef.get(OutboxRunner)).toBeInstanceOf(OutboxRunner);
    expect(moduleRef.get(EmailOutboxHandler)).toBeInstanceOf(EmailOutboxHandler);

    await moduleRef.close();
  });

  it("registers a handler for every topic the API actually produces", async () => {
    const moduleRef = await testingModule().compile();

    const handlers = moduleRef.get<readonly OutboxHandler[]>(OUTBOX_HANDLERS);
    const topics = new Set(handlers.map((handler) => handler.topic));

    // The email consumer is still there...
    expect(topics.has("email")).toBe(true);
    // ...and the storefront purge. THE CATALOG-SYNC CONSUMERS ARE GONE: they
    // drove the TagadaPay catalog mirror, which existed only because a checkout
    // there could name a variant id and no amount, so an unmirrored variant
    // could not be sold. Whop takes the amount on the checkout call, and the
    // `catalog.*` topics are no longer produced at all.
    expect(topics.has("storefront.revalidate")).toBe(true);
    // Nothing else: Sendcloud (`shipment-sync`, `order-fulfilment`) is gone.
    expect([...topics].sort()).toEqual(["email", "storefront.revalidate"]);

    await moduleRef.close();
  });
});
