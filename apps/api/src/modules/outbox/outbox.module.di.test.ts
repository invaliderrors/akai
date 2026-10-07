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
  WOMPI_ENVIRONMENT: "sandbox",
  WOMPI_PUBLIC_KEY: "pub_test_unit",
  WOMPI_PRIVATE_KEY: "prv_test_unit",
  WOMPI_INTEGRITY_SECRET: "test_integrity_unit",
  WOMPI_EVENTS_SECRET: "test_events_unit",
  /**
   * THE RESOLVED CONFIGURATION the schema normally derives at boot. Consumers
   * read `config.wompi` and never choose between sandbox and live themselves.
   */
  wompi: {
    environment: "sandbox",
    publicKey: "pub_test_unit",
    privateKey: "prv_test_unit",
    integritySecret: "test_integrity_unit",
    eventsSecret: "test_events_unit",
    apiBaseUrl: "https://sandbox.wompi.co/v1",
    checkoutUrl: "https://checkout.wompi.co/p/",
    eventEnvironment: "test",
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
    // could not be sold. Wompi takes the amount on the checkout URL, and the
    // `catalog.*` topics are no longer produced at all.
    expect(topics.has("storefront.revalidate")).toBe(true);
    // Nothing else: Sendcloud (`shipment-sync`, `order-fulfilment`) is gone.
    expect([...topics].sort()).toEqual(["email", "storefront.revalidate"]);

    await moduleRef.close();
  });
});
