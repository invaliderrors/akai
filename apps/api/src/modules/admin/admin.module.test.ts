import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { NotImplementedException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { AdminModule } from "./admin.module";
import { AdminGuard } from "./admin.guard";
import { AdminAuditService } from "./admin-audit.service";
import { IdempotencyService } from "../idempotency/idempotency.service";
import { AdminMetricsService } from "./admin-metrics.service";
import { AdminProductsService } from "./admin-products.service";
import { PrismaService } from "../prisma/prisma.service";
import { ADMIN_SESSION_READER, CATALOG_ADMIN_PORT } from "./admin.types";
import type { CatalogAdminPort } from "./admin.types";

/**
 * Proves the module's dependency graph actually RESOLVES.
 *
 * Unit tests construct services with `new`, which cannot catch a missing
 * provider, an unbound injection token or lost decorator metadata — all of
 * which fail at container build time, in production, not in a unit test.
 */
async function buildModule() {
  return Test.createTestingModule({ imports: [AdminModule] })
    // Overridden so the graph resolves without a database. PrismaService would
    // otherwise need a validated config and a live connection string.
    .overrideProvider(PrismaService)
    .useValue({})
    .compile();
}

describe("AdminModule", () => {
  it("resolves every provider in the admin graph", async () => {
    const moduleRef = await buildModule();

    expect(moduleRef.get(AdminGuard)).toBeInstanceOf(AdminGuard);
    expect(moduleRef.get(AdminAuditService)).toBeInstanceOf(AdminAuditService);
    expect(moduleRef.get(IdempotencyService)).toBeInstanceOf(IdempotencyService);
    expect(moduleRef.get(AdminMetricsService)).toBeInstanceOf(AdminMetricsService);
    expect(moduleRef.get(AdminProductsService)).toBeInstanceOf(AdminProductsService);
  });

  it("binds both integration ports so the container is complete", async () => {
    const moduleRef = await buildModule();

    // An unbound token is a boot-time crash, not a compile error. Both are
    // deliberately bound to stand-ins today (see the module's integration note).
    expect(moduleRef.get(ADMIN_SESSION_READER)).toBeDefined();
    expect(moduleRef.get(CATALOG_ADMIN_PORT)).toBeDefined();
  });

  it("makes the unbound catalog port FAIL LOUDLY rather than return empty data", async () => {
    const moduleRef = await buildModule();
    const catalog = moduleRef.get<CatalogAdminPort>(CATALOG_ADMIN_PORT);

    // An empty array here would make a broken export look like an empty
    // catalogue, and an admin would reasonably conclude their products were
    // deleted. A no-op upsert would report "created: 900" having written nothing.
    await expect(catalog.exportProducts()).rejects.toThrow(NotImplementedException);
    await expect(
      catalog.upsertProduct({
        slug: "x",
        status: "DRAFT",
        taxClass: "STANDARD",
        name: "x",
        shortDescription: "",
        description: "",
        variants: [],
        restrictedCountries: [],
      }),
    ).rejects.toThrow(NotImplementedException);
  });
});
