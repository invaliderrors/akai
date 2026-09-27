import "reflect-metadata";

import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CatalogError } from "../../api/src/modules/catalog/catalog.errors";
import { ProductInventoryService } from "../../api/src/modules/catalog/product-inventory.service";
import { PrismaService } from "../../api/src/modules/prisma/prisma.service";
import { isDockerAvailable, startTestDatabase, type TestDatabase } from "./harness";

/**
 * MANUAL STOCK ADJUSTMENT, AGAINST REAL POSTGRES.
 *
 * The unit suite asserts the SQL text the service sends; only a real database
 * can prove that text does what it says. Three claims are worth that cost:
 *
 *   - the `"onHand" = expectedOnHand` predicate genuinely refuses a stale write
 *     and the refusal rolls back with nothing written;
 *   - the reserved guard still holds with the new predicate beside it;
 *   - an untracked variant's first adjustment creates its `inventory_item` row
 *     (Prisma `createMany … skipDuplicates` → ON CONFLICT DO NOTHING) and its
 *     ledger row in one transaction.
 */

const PRODUCT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VARIANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACTOR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe.skipIf(!isDockerAvailable())("Inventory adjust — expectedOnHand and untracked variants", () => {
  let db: TestDatabase;
  let service: ProductInventoryService;

  beforeAll(async () => {
    db = await startTestDatabase();
    const moduleRef = await Test.createTestingModule({
      providers: [ProductInventoryService, { provide: PrismaService, useValue: db.prisma }],
    }).compile();
    service = moduleRef.get(ProductInventoryService);
  });

  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await db.reset();
    await db.prisma.customer.create({
      data: { id: ACTOR_ID, email: "admin@example.com", role: "ADMIN" },
    });
    await db.prisma.product.create({
      data: { id: PRODUCT_ID, slug: "creatine-monohydrate", status: "ACTIVE" },
    });
    await db.prisma.productVariant.create({
      data: {
        id: VARIANT_ID,
        productId: PRODUCT_ID,
        sku: "AK-CRE-500",
        currency: "EUR",
        priceNet: 4131,
        priceTax: 868,
        priceGross: 4999,
        taxRateBps: 2100,
      },
    });
  });

  async function ledgerRows() {
    return db.prisma.inventoryLedgerEntry.findMany({ where: { variantId: VARIANT_ID } });
  }

  it("applies the delta when the expected count still holds", async () => {
    await db.prisma.inventoryItem.create({
      data: { variantId: VARIANT_ID, onHand: 29, reserved: 4 },
    });

    const item = await service.adjust(
      VARIANT_ID,
      { delta: 8, reason: "STOCK_COUNT", expectedOnHand: 29 },
      ACTOR_ID,
    );

    expect(item.onHand).toBe(37);
    const ledger = await ledgerRows();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.resultingOnHand).toBe(37);
  });

  it("refuses a stale expectation as STOCK_CHANGED and leaves stock and ledger untouched", async () => {
    await db.prisma.inventoryItem.create({
      data: { variantId: VARIANT_ID, onHand: 40, reserved: 4 },
    });

    await expect(
      service.adjust(
        VARIANT_ID,
        { delta: 8, reason: "STOCK_COUNT", expectedOnHand: 29 },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "STOCK_CHANGED" });

    const row = await db.prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: VARIANT_ID },
    });
    expect(row.onHand).toBe(40);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("still refuses a write-down below the reserved quantity", async () => {
    await db.prisma.inventoryItem.create({
      data: { variantId: VARIANT_ID, onHand: 10, reserved: 6 },
    });

    await expect(
      service.adjust(
        VARIANT_ID,
        { delta: -5, reason: "DAMAGE", expectedOnHand: 10 },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "OUT_OF_STOCK", reason: "BELOW_RESERVED" });

    const row = await db.prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: VARIANT_ID },
    });
    expect(row.onHand).toBe(10);
  });

  it("creates the row for an untracked variant, with its ledger entry", async () => {
    const item = await service.adjust(
      VARIANT_ID,
      { delta: 12, reason: "RESTOCK", expectedOnHand: 0 },
      ACTOR_ID,
    );

    expect(item).toMatchObject({ onHand: 12, reserved: 0, available: 12 });
    const row = await db.prisma.inventoryItem.findUniqueOrThrow({
      where: { variantId: VARIANT_ID },
    });
    expect(row.onHand).toBe(12);
    const ledger = await ledgerRows();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ movement: "RESTOCK", quantityDelta: 12, actorId: ACTOR_ID });
  });

  it("refuses a negative first adjustment and creates nothing", async () => {
    const failure = service.adjust(VARIANT_ID, { delta: -1, reason: "DAMAGE" }, ACTOR_ID);

    await expect(failure).rejects.toBeInstanceOf(CatalogError);
    await expect(failure).rejects.toMatchObject({ reason: "NEGATIVE_STOCK" });
    expect(await db.prisma.inventoryItem.count()).toBe(0);
    expect(await ledgerRows()).toHaveLength(0);
  });
});
