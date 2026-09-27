import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { ProductInventoryService } from "./product-inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { CatalogError } from "./catalog.errors";

const VARIANT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RESERVATION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ORDER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const ACTOR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

interface Recorded {
  ledger: Record<string, unknown>[];
  outbox: { topic: string; payload: unknown }[];
  /** Every raw statement issued, so the guard predicates can be asserted. */
  statements: string[];
  /** Every `inventory_item` row the service created for an untracked variant. */
  created: Record<string, unknown>[];
}

/**
 * `$executeRaw` is a TAGGED TEMPLATE, so the mock receives the string fragments
 * as its first argument. Joining them back together lets the tests assert on
 * the actual predicate that was sent to Postgres — which is the only place the
 * oversell guard exists, and therefore the only thing worth asserting.
 */
function makeExecuteRaw(recorded: Recorded, affected: number | (() => number)) {
  return vi.fn((strings: TemplateStringsArray | string[]) => {
    recorded.statements.push(Array.from(strings).join("?"));
    return Promise.resolve(typeof affected === "function" ? affected() : affected);
  });
}

interface HarnessOptions {
  affected?: number | (() => number);
  variant?: Record<string, unknown> | null;
  inventory?: Record<string, unknown> | null;
  reservation?: Record<string, unknown> | null;
  reservationUpdateCount?: number;
  inventoryAfter?: Record<string, unknown> | null;
  /**
   * How many rows `inventoryItem.createMany` reports. 0 models a concurrent
   * writer creating the row between our UPDATE and our INSERT.
   */
  createCount?: number;
}

async function buildHarness(options: HarnessOptions = {}): Promise<{
  service: ProductInventoryService;
  recorded: Recorded;
}> {
  const recorded: Recorded = { ledger: [], outbox: [], statements: [], created: [] };

  const inventoryRow =
    options.inventory === undefined
      ? { onHand: 40, reserved: 12, lowStockThreshold: 5, allowBackorder: false, version: 1 }
      : options.inventory;

  const tx = {
    productVariant: {
      findFirst: vi.fn(async () =>
        options.variant === undefined ? { id: VARIANT_ID, sku: "AK-1" } : options.variant,
      ),
    },
    inventoryItem: {
      // Once the service has created a row, reads see it — the same thing a
      // real transaction would observe after its own INSERT.
      findUnique: vi.fn(async () => {
        const created = recorded.created[0];
        if (created !== undefined) {
          return {
            reserved: 0,
            lowStockThreshold: 5,
            allowBackorder: false,
            version: 0,
            ...created,
          };
        }
        return options.inventoryAfter ?? inventoryRow;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
      createMany: vi.fn(
        async (args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }) => {
          const count = options.createCount ?? args.data.length;
          if (count > 0) {
            recorded.created.push(
              ...args.data.map((row) => ({ ...row, skipDuplicates: args.skipDuplicates })),
            );
          }
          return { count };
        },
      ),
    },
    stockReservation: {
      findUnique: vi.fn(async () =>
        options.reservation === undefined
          ? { id: RESERVATION_ID, variantId: VARIANT_ID, quantity: 3, releasedAt: null }
          : options.reservation,
      ),
      create: vi.fn(async () => ({
        id: RESERVATION_ID,
        expiresAt: new Date("2026-03-01T10:15:00.000Z"),
      })),
      updateMany: vi.fn(async () => ({ count: options.reservationUpdateCount ?? 1 })),
      findMany: vi.fn(async () => []),
    },
    inventoryLedgerEntry: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        recorded.ledger.push(args.data);
        return {};
      }),
    },
    outboxMessage: {
      create: vi.fn(async (args: { data: { topic: string; payload: unknown } }) => {
        recorded.outbox.push({ topic: args.data.topic, payload: args.data.payload });
        return {};
      }),
    },
    $executeRaw: makeExecuteRaw(recorded, options.affected ?? 1),
  };

  const prisma = {
    $transaction: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work(tx)),
    inventoryItem: {
      findUnique: vi.fn(async () => options.inventoryAfter ?? inventoryRow),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    stockReservation: { findMany: vi.fn(async () => []) },
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      ProductInventoryService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();

  return { service: moduleRef.get(ProductInventoryService), recorded };
}

describe("ProductInventoryService.reserve", () => {
  it("reserves when stock is available", async () => {
    const { service } = await buildHarness({ affected: 1 });

    const result = await service.reserve({
      variantId: VARIANT_ID,
      quantity: 3,
      cartId: null,
      ttlSeconds: 900,
    });

    expect(result.reservationId).toBe(RESERVATION_ID);
  });

  /**
   * THE OVERSELL BOUNDARY.
   *
   * The precondition lives in the UPDATE's WHERE clause, evaluated by Postgres.
   * Zero affected rows IS the rejection — not an error to retry. Two concurrent
   * checkouts for the last unit cannot both observe "1 available" and both
   * succeed, because only one UPDATE can satisfy the predicate.
   */
  it("rejects the reservation when the conditional update affects no rows", async () => {
    const { service } = await buildHarness({ affected: 0 });

    await expect(
      service.reserve({ variantId: VARIANT_ID, quantity: 999, cartId: null, ttlSeconds: 900 }),
    ).rejects.toThrow(CatalogError);
  });

  it("reports an out-of-stock rejection, not a generic conflict", async () => {
    const { service } = await buildHarness({ affected: 0 });

    await expect(
      service.reserve({ variantId: VARIANT_ID, quantity: 999, cartId: null, ttlSeconds: 900 }),
    ).rejects.toMatchObject({ code: "OUT_OF_STOCK" });
  });

  /**
   * The predicate must compare AVAILABLE (onHand - reserved) against the
   * request, not onHand alone. Checking onHand would hand out stock already
   * held by another customer's in-flight checkout.
   */
  it("guards on onHand MINUS reserved, never on onHand alone", async () => {
    const { service, recorded } = await buildHarness({ affected: 1 });

    await service.reserve({
      variantId: VARIANT_ID,
      quantity: 3,
      cartId: null,
      ttlSeconds: 900,
    });

    const statement = recorded.statements.join(" ").replace(/\s+/g, " ");
    expect(statement).toContain('"onHand" - "reserved" >=');
  });

  it("never reads stock into JS and writes it back", async () => {
    const { service, recorded } = await buildHarness({ affected: 1 });

    await service.reserve({
      variantId: VARIANT_ID,
      quantity: 3,
      cartId: null,
      ttlSeconds: 900,
    });

    // The increment is relative (`"reserved" + n`), not an absolute value
    // computed in the application — which is what makes it race-free.
    const statement = recorded.statements.join(" ").replace(/\s+/g, " ");
    expect(statement).toContain('"reserved" = "reserved" +');
  });

  it("records the reservation in the append-only ledger", async () => {
    const { service, recorded } = await buildHarness({ affected: 1 });

    await service.reserve({
      variantId: VARIANT_ID,
      quantity: 3,
      cartId: null,
      ttlSeconds: 900,
    });

    const [entry] = recorded.ledger;
    expect(entry?.["movement"]).toBe("RESERVATION");
    // Reserving WITHHOLDS stock, it does not consume it — so the delta is
    // negative but resultingOnHand is unchanged.
    expect(entry?.["quantityDelta"]).toBe(-3);
  });

  it("404s on a missing or inactive variant", async () => {
    const { service } = await buildHarness({ variant: null });

    await expect(
      service.reserve({ variantId: VARIANT_ID, quantity: 1, cartId: null, ttlSeconds: 900 }),
    ).rejects.toThrow(CatalogError);
  });

  it("refuses to reserve a variant that was never stocked", async () => {
    const { service } = await buildHarness({ inventory: null });

    await expect(
      service.reserve({ variantId: VARIANT_ID, quantity: 1, cartId: null, ttlSeconds: 900 }),
    ).rejects.toMatchObject({ code: "OUT_OF_STOCK" });
  });

  it("skips the availability precondition for a backorder-enabled variant", async () => {
    const { service } = await buildHarness({
      affected: 0,
      inventory: {
        onHand: 0,
        reserved: 0,
        lowStockThreshold: 5,
        allowBackorder: true,
        version: 1,
      },
    });

    // Zero affected rows would reject a normal variant; backorder is the
    // documented exception and must still succeed.
    await expect(
      service.reserve({ variantId: VARIANT_ID, quantity: 5, cartId: null, ttlSeconds: 900 }),
    ).resolves.toMatchObject({ reservationId: RESERVATION_ID });
  });
});

describe("ProductInventoryService.release", () => {
  /**
   * Release is idempotent by construction. The expiry cron and the customer's
   * own cancel WILL race; a second release that decremented `reserved` again
   * would corrupt the count downward and quietly inflate available stock.
   */
  it("is idempotent — releasing an already-released reservation is a no-op", async () => {
    const { service, recorded } = await buildHarness({
      reservation: {
        id: RESERVATION_ID,
        variantId: VARIANT_ID,
        quantity: 3,
        releasedAt: new Date(),
      },
    });

    expect(await service.release(RESERVATION_ID)).toBe(false);
    expect(recorded.ledger).toHaveLength(0);
  });

  it("returns false when the reservation does not exist", async () => {
    const { service } = await buildHarness({ reservation: null });
    expect(await service.release(RESERVATION_ID)).toBe(false);
  });

  it("returns false when another writer claimed the release first", async () => {
    const { service, recorded } = await buildHarness({ reservationUpdateCount: 0 });

    expect(await service.release(RESERVATION_ID)).toBe(false);
    // Losing the claim race must not also write a ledger row.
    expect(recorded.ledger).toHaveLength(0);
  });

  it("releases a live reservation and records it", async () => {
    const { service, recorded } = await buildHarness();

    expect(await service.release(RESERVATION_ID)).toBe(true);
    expect(recorded.ledger[0]?.["movement"]).toBe("RESERVATION_RELEASE");
    expect(recorded.ledger[0]?.["quantityDelta"]).toBe(3);
  });

  it("floors reserved at zero so a prior undercount cannot drive it negative", async () => {
    const { service, recorded } = await buildHarness();

    await service.release(RESERVATION_ID);

    const statement = recorded.statements.join(" ").replace(/\s+/g, " ");
    expect(statement).toContain('GREATEST(0, "reserved" -');
  });
});

describe("ProductInventoryService.commitReservation", () => {
  /**
   * A sale decrements BOTH counters. Decrementing only `onHand` leaves the
   * units reserved forever — a slow leak that shrinks available stock by every
   * unit ever sold and looks like a demand-forecasting problem for months.
   */
  it("decrements onHand and reserved together", async () => {
    const { service, recorded } = await buildHarness();

    await service.commitReservation(RESERVATION_ID, ORDER_ID);

    const statement = recorded.statements.join(" ").replace(/\s+/g, " ");
    expect(statement).toContain('"onHand" = "onHand" -');
    expect(statement).toContain('"reserved" = GREATEST(0, "reserved" -');
  });

  it("records a SALE movement carrying the order id", async () => {
    const { service, recorded } = await buildHarness();

    await service.commitReservation(RESERVATION_ID, ORDER_ID);

    const [entry] = recorded.ledger;
    expect(entry?.["movement"]).toBe("SALE");
    expect(entry?.["orderId"]).toBe(ORDER_ID);
  });

  it("refuses to commit an already-released reservation", async () => {
    const { service } = await buildHarness({
      reservation: {
        id: RESERVATION_ID,
        variantId: VARIANT_ID,
        quantity: 3,
        releasedAt: new Date(),
      },
    });

    await expect(service.commitReservation(RESERVATION_ID, ORDER_ID)).rejects.toThrow(
      CatalogError,
    );
  });

  it("fails loudly when the reserved stock is no longer on hand", async () => {
    const { service } = await buildHarness({ affected: 0 });

    await expect(service.commitReservation(RESERVATION_ID, ORDER_ID)).rejects.toMatchObject(
      { code: "OUT_OF_STOCK" },
    );
  });
});

describe("ProductInventoryService.adjust", () => {
  /**
   * A negative adjustment is guarded against RESERVED, not merely against zero.
   * Writing stock below what is already reserved leaves in-flight checkouts
   * holding units that no longer exist — turning a bookkeeping correction into
   * a batch of unfulfillable paid orders.
   */
  it("guards a decrement against the reserved quantity, not just zero", async () => {
    const { service, recorded } = await buildHarness({
      inventoryAfter: {
        onHand: 30,
        reserved: 12,
        lowStockThreshold: 5,
        allowBackorder: false,
        version: 2,
      },
    });

    await service.adjust(VARIANT_ID, { delta: -10, reason: "Damaged" }, ACTOR_ID);

    const statement = recorded.statements.join(" ").replace(/\s+/g, " ");
    expect(statement).toContain('"onHand" + ? >= "reserved"');
  });

  it("rejects an adjustment that would drop stock below what is reserved", async () => {
    const { service } = await buildHarness({ affected: 0 });

    await expect(
      service.adjust(VARIANT_ID, { delta: -100, reason: "Shrinkage" }, ACTOR_ID),
    ).rejects.toMatchObject({ code: "OUT_OF_STOCK" });
  });

  it("classifies a positive delta as RESTOCK and a negative one as ADJUSTMENT", async () => {
    const restock = await buildHarness();
    await restock.service.adjust(VARIANT_ID, { delta: 10, reason: "Delivery" }, ACTOR_ID);
    expect(restock.recorded.ledger[0]?.["movement"]).toBe("RESTOCK");

    const shrink = await buildHarness();
    await shrink.service.adjust(VARIANT_ID, { delta: -2, reason: "Damaged" }, ACTOR_ID);
    expect(shrink.recorded.ledger[0]?.["movement"]).toBe("ADJUSTMENT");
  });

  it("attributes the adjustment to an actor and records the reason", async () => {
    const { service, recorded } = await buildHarness();

    await service.adjust(VARIANT_ID, { delta: 5, reason: "Recount" }, ACTOR_ID);

    // An unattributable, unexplained row in an append-only ledger defeats the
    // point of keeping one.
    expect(recorded.ledger[0]?.["actorId"]).toBe(ACTOR_ID);
    expect(recorded.ledger[0]?.["reason"]).toBe("Recount");
  });

  it("emits the inventory event to the outbox, not to a direct call", async () => {
    const { service, recorded } = await buildHarness();

    await service.adjust(VARIANT_ID, { delta: 5, reason: "Recount" }, ACTOR_ID);

    expect(recorded.outbox).toHaveLength(1);
    expect(recorded.outbox[0]?.topic).toBe("catalog.inventory.adjusted");
  });

  it("flags low stock against the configured threshold", async () => {
    const { service, recorded } = await buildHarness({
      inventoryAfter: {
        onHand: 6,
        reserved: 3,
        lowStockThreshold: 5,
        allowBackorder: false,
        version: 2,
      },
    });

    await service.adjust(VARIANT_ID, { delta: -1, reason: "Damaged" }, ACTOR_ID);

    // available = 6 - 3 = 3, threshold 5 → low.
    expect(recorded.outbox[0]?.payload).toMatchObject({ available: 3, lowStock: true });
  });

  it("404s when the variant does not exist", async () => {
    const { service } = await buildHarness({ variant: null });

    await expect(
      service.adjust(VARIANT_ID, { delta: 1, reason: "Recount" }, ACTOR_ID),
    ).rejects.toThrow(CatalogError);
  });

  it("tags a below-reserved refusal with its own reason", async () => {
    // onHand 40, reserved 12: a -100 adjustment is refused because of the
    // reservations, and the client must be able to SAY that rather than a
    // generic "it failed".
    const { service, recorded } = await buildHarness({ affected: 0 });

    await expect(
      service.adjust(VARIANT_ID, { delta: -100, reason: "Shrinkage" }, ACTOR_ID),
    ).rejects.toMatchObject({ code: "OUT_OF_STOCK", reason: "BELOW_RESERVED" });
    expect(recorded.ledger).toHaveLength(0);
    expect(recorded.outbox).toHaveLength(0);
    expect(recorded.created).toHaveLength(0);
  });

  it("still classifies below-reserved when the expected count DID match", async () => {
    const { service } = await buildHarness({ affected: 0 });

    await expect(
      service.adjust(
        VARIANT_ID,
        { delta: -100, reason: "Shrinkage", expectedOnHand: 40 },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "OUT_OF_STOCK", reason: "BELOW_RESERVED" });
  });
});

describe("ProductInventoryService.adjust — expectedOnHand (lost-update guard)", () => {
  it("puts the expectation INTO the guarded UPDATE, beside the reserved guard", async () => {
    // The check must be part of the same conditional write. Reading onHand,
    // comparing in JS and then writing is exactly the race it exists to close.
    const { service, recorded } = await buildHarness({
      inventoryAfter: {
        onHand: 37,
        reserved: 12,
        lowStockThreshold: 5,
        allowBackorder: false,
        version: 2,
      },
    });

    await service.adjust(
      VARIANT_ID,
      { delta: 8, reason: "STOCK_COUNT", expectedOnHand: 29 },
      ACTOR_ID,
    );

    const statement = recorded.statements.join(" ").replace(/\s+/g, " ");
    expect(statement).toContain('"onHand" + ? >= "reserved"');
    expect(statement).toContain('"onHand" = ?');
  });

  it("leaves the expectation out of the UPDATE when the caller sent none", async () => {
    const { service, recorded } = await buildHarness();

    await service.adjust(VARIANT_ID, { delta: 8, reason: "Delivery" }, ACTOR_ID);

    const statement = recorded.statements.join(" ").replace(/\s+/g, " ");
    expect(statement).not.toContain('"onHand" = ?');
  });

  it("rejects a stale expectation as STOCK_CHANGED and writes nothing", async () => {
    // The page showed 29; an order has since moved it to 40. Applying the delta
    // would land on a count the operator never typed.
    const { service, recorded } = await buildHarness({ affected: 0 });

    const failure = service.adjust(
      VARIANT_ID,
      { delta: 8, reason: "STOCK_COUNT", expectedOnHand: 29 },
      ACTOR_ID,
    );

    await expect(failure).rejects.toBeInstanceOf(CatalogError);
    await expect(failure).rejects.toMatchObject({
      code: "CONFLICT",
      reason: "STOCK_CHANGED",
    });
    expect(recorded.ledger).toHaveLength(0);
    expect(recorded.outbox).toHaveLength(0);
    expect(recorded.created).toHaveLength(0);
  });

  it("carries the reason on the HTTP payload, where the exception filter reads it", async () => {
    const { service } = await buildHarness({ affected: 0 });

    const caught = await service
      .adjust(VARIANT_ID, { delta: 8, reason: "STOCK_COUNT", expectedOnHand: 29 }, ACTOR_ID)
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(caught).toBeInstanceOf(CatalogError);
    if (!(caught instanceof CatalogError)) return;
    expect(caught.getStatus()).toBe(409);
    expect(caught.getResponse()).toMatchObject({ code: "CONFLICT", reason: "STOCK_CHANGED" });
  });
});

describe("ProductInventoryService.adjust — untracked variant", () => {
  /** No `inventory_item` row: the guarded UPDATE matches nothing. */
  const untracked = { affected: 0, inventory: null } as const;

  it("creates the inventory row with onHand = delta, inside the same transaction", async () => {
    const { service, recorded } = await buildHarness(untracked);

    const item = await service.adjust(
      VARIANT_ID,
      { delta: 7, reason: "Restock" },
      ACTOR_ID,
    );

    expect(recorded.created).toHaveLength(1);
    expect(recorded.created[0]).toMatchObject({
      variantId: VARIANT_ID,
      onHand: 7,
      // ON CONFLICT DO NOTHING: a concurrent creator is detected by the count,
      // never by a unique-violation that would abort the transaction as a 500.
      skipDuplicates: true,
    });
    expect(item).toMatchObject({ variantId: VARIANT_ID, onHand: 7, reserved: 0, available: 7 });
  });

  it("records the ledger entry and the outbox event as for any adjustment", async () => {
    const { service, recorded } = await buildHarness(untracked);

    await service.adjust(VARIANT_ID, { delta: 7, reason: "Restock" }, ACTOR_ID);

    expect(recorded.ledger).toHaveLength(1);
    expect(recorded.ledger[0]).toMatchObject({
      variantId: VARIANT_ID,
      movement: "RESTOCK",
      quantityDelta: 7,
      resultingOnHand: 7,
      actorId: ACTOR_ID,
      reason: "Restock",
    });
    expect(recorded.outbox).toHaveLength(1);
  });

  it("accepts an expectation of zero — what the inventory list shows for an untracked row", async () => {
    const { service, recorded } = await buildHarness(untracked);

    await service.adjust(
      VARIANT_ID,
      { delta: 3, reason: "STOCK_COUNT", expectedOnHand: 0 },
      ACTOR_ID,
    );

    expect(recorded.created[0]).toMatchObject({ onHand: 3 });
  });

  it("refuses a negative first adjustment as NEGATIVE_STOCK and writes nothing", async () => {
    const { service, recorded } = await buildHarness(untracked);

    await expect(
      service.adjust(VARIANT_ID, { delta: -2, reason: "Damaged" }, ACTOR_ID),
    ).rejects.toMatchObject({ code: "OUT_OF_STOCK", reason: "NEGATIVE_STOCK" });
    expect(recorded.created).toHaveLength(0);
    expect(recorded.ledger).toHaveLength(0);
    expect(recorded.outbox).toHaveLength(0);
  });

  it("treats a non-zero expectation against a missing row as STOCK_CHANGED", async () => {
    const { service, recorded } = await buildHarness(untracked);

    await expect(
      service.adjust(
        VARIANT_ID,
        { delta: 3, reason: "STOCK_COUNT", expectedOnHand: 12 },
        ACTOR_ID,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "STOCK_CHANGED" });
    expect(recorded.created).toHaveLength(0);
    expect(recorded.ledger).toHaveLength(0);
  });

  it("reports STOCK_CHANGED when a concurrent writer created the row first", async () => {
    // Our UPDATE saw no row, and by the INSERT someone else had made one. Their
    // count is not the zero this delta was computed against.
    const { service, recorded } = await buildHarness({ ...untracked, createCount: 0 });

    await expect(
      service.adjust(VARIANT_ID, { delta: 3, reason: "STOCK_COUNT" }, ACTOR_ID),
    ).rejects.toMatchObject({ code: "CONFLICT", reason: "STOCK_CHANGED" });
    expect(recorded.ledger).toHaveLength(0);
  });
});

describe("ProductInventoryService.get", () => {
  it("derives available as onHand minus reserved", async () => {
    const { service } = await buildHarness();
    expect((await service.get(VARIANT_ID)).available).toBe(28);
  });

  it("floors available at zero", async () => {
    const { service } = await buildHarness({
      inventoryAfter: {
        onHand: 2,
        reserved: 9,
        lowStockThreshold: 5,
        allowBackorder: false,
        version: 1,
      },
    });

    expect((await service.get(VARIANT_ID)).available).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sale-completed commit + the paid-order guard on expiry (issue SEV2).
//
// These use their own prisma doubles rather than the shared harness: they
// exercise `order` reads (the guard) and the order-level `stockReservation`
// projection that the reserve/release suites above have no need for.
// ---------------------------------------------------------------------------

const PAID_ORDER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeee0001";
const OPEN_ORDER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeee0002";

interface CommitDoubles {
  reservationFindMany: ReturnType<typeof vi.fn>;
  reservationUpdateMany: ReturnType<typeof vi.fn>;
  ledgerCreate: ReturnType<typeof vi.fn>;
  executeRaw: ReturnType<typeof vi.fn>;
}

async function buildCommitService(
  reservations: { id: string; variantId: string; quantity: number }[],
): Promise<{ service: ProductInventoryService; doubles: CommitDoubles }> {
  const doubles: CommitDoubles = {
    reservationFindMany: vi.fn(async () => reservations),
    reservationUpdateMany: vi.fn(async () => ({ count: 1 })),
    ledgerCreate: vi.fn(async () => ({})),
    executeRaw: vi.fn(async () => 1),
  };

  const tx = {
    stockReservation: {
      findMany: doubles.reservationFindMany,
      updateMany: doubles.reservationUpdateMany,
    },
    inventoryItem: { findUnique: vi.fn(async () => ({ onHand: 37 })) },
    inventoryLedgerEntry: { create: doubles.ledgerCreate },
    $executeRaw: doubles.executeRaw,
  };

  const prisma = {
    $transaction: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work(tx)),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [ProductInventoryService, { provide: PrismaService, useValue: prisma }],
  }).compile();

  return { service: moduleRef.get(ProductInventoryService), doubles };
}

describe("ProductInventoryService.commitReservationsForOrder", () => {
  it("decrements on-hand and writes a SALE ledger row for every held reservation", async () => {
    const { service, doubles } = await buildCommitService([
      { id: RESERVATION_ID, variantId: VARIANT_ID, quantity: 3 },
    ]);

    const committed = await service.commitReservationsForOrder(ORDER_ID);

    expect(committed).toBe(1);
    // A SALE movement, negative delta, tied to the order — the ledger row that
    // was never written before because no order path called commit.
    expect(doubles.ledgerCreate).toHaveBeenCalledTimes(1);
    expect(doubles.ledgerCreate.mock.calls[0]?.[0]).toMatchObject({
      data: { movement: "SALE", quantityDelta: -3, orderId: ORDER_ID },
    });
  });

  it("is idempotent at the order level — nothing left to commit is a no-op", async () => {
    // A retried settlement finds no unreleased reservations for the order.
    const { service, doubles } = await buildCommitService([]);

    const committed = await service.commitReservationsForOrder(ORDER_ID);

    expect(committed).toBe(0);
    expect(doubles.ledgerCreate).not.toHaveBeenCalled();
  });
});

describe("ProductInventoryService.releaseExpired — paid-order guard", () => {
  /**
   * Stock behind a PAID order has SOLD; releasing it on TTL would hand it back to
   * the shelf without ever decrementing on-hand, and the sold unit would be
   * offered again. Only genuinely abandoned holds (no order, or an order still
   * open) are freed.
   */
  it("frees abandoned holds but never a paid order's reserved stock", async () => {
    const releaseTx = {
      stockReservation: {
        findUnique: vi.fn(async () => ({
          id: RESERVATION_ID,
          variantId: VARIANT_ID,
          quantity: 2,
          releasedAt: null,
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      inventoryItem: { findUnique: vi.fn(async () => ({ onHand: 10 })) },
      inventoryLedgerEntry: { create: vi.fn(async () => ({})) },
      $executeRaw: vi.fn(async () => 1),
    };

    const prisma = {
      $transaction: vi.fn(async (work: (client: unknown) => Promise<unknown>) =>
        work(releaseTx),
      ),
      stockReservation: {
        findMany: vi.fn(async () => [
          { id: "res-open", orderId: OPEN_ORDER_ID },
          { id: "res-paid", orderId: PAID_ORDER_ID },
          { id: "res-abandoned", orderId: null },
        ]),
      },
      // Only the paid order comes back from the paid-status filter.
      order: { findMany: vi.fn(async () => [{ id: PAID_ORDER_ID }]) },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [ProductInventoryService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    const service = moduleRef.get(ProductInventoryService);

    const released = await service.releaseExpired(new Date("2026-07-20T12:00:00.000Z"));

    // The open-order hold and the orphan hold are freed; the paid one is not.
    // That `released` is 2, not 3, IS the guard: the paid order's stock was
    // skipped because the order-status lookup marked it sold.
    expect(released).toBe(2);
    expect(prisma.order.findMany).toHaveBeenCalledTimes(1);
  });
});
