import "reflect-metadata";
import { Global, Module } from "@nestjs/common";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import { describe, expect, it } from "vitest";

import type { ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";

import { SERVER_CONFIG } from "../config/config.module";
import { LOGGER } from "../observability/logger.module";
import { PrismaService } from "../prisma/prisma.service";
import { CartService } from "../cart/cart.service";
import { ProductInventoryService } from "../catalog/product-inventory.service";
import { QueueModule } from "./queue.module";
import {
  CART_SWEEPER,
  RESERVATION_SWEEPER,
  ScheduledJobsRunner,
} from "./scheduled-jobs.runner";

/**
 * DI GATE for the scheduler tier.
 *
 * Nest resolves constructor dependencies from emitted decorator metadata; a
 * token mismatch or a missing provider is a RUNTIME failure the type-checker
 * cannot see. This proves that QueueModule → CatalogModule / CartModule wires,
 * that the `useExisting` port bindings alias the real sweep services, and that
 * the runner constructs — all without a live database (PrismaService is
 * overridden; the fakes are only stored, never called, during `compile()`).
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

function testingModule(): TestingModuleBuilder {
  return Test.createTestingModule({
    imports: [TestInfraModule, QueueModule],
  })
    .overrideProvider(PrismaService)
    .useValue({} as unknown as PrismaService);
}

describe("QueueModule — dependency injection", () => {
  it("constructs the scheduled-jobs runner and its port bindings", async () => {
    const moduleRef = await testingModule().compile();

    expect(moduleRef.get(ScheduledJobsRunner)).toBeInstanceOf(ScheduledJobsRunner);

    // The narrow ports alias the real, already-tested sweep services — this is
    // what turns "the sweeps exist" into "the sweeps actually get called".
    expect(moduleRef.get(RESERVATION_SWEEPER)).toBeInstanceOf(ProductInventoryService);
    expect(moduleRef.get(CART_SWEEPER)).toBeInstanceOf(CartService);

    await moduleRef.close();
  });
});
