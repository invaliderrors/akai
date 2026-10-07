import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PrismaUsersDataAccess } from "../../api/src/modules/users/prisma-users.repository";
import { isDockerAvailable, startTestDatabase, type TestDatabase } from "./harness";

/**
 * REGRESSION, AND IT NEEDS A REAL DATABASE.
 *
 * `aggregateOrderStats` is hand-written SQL, and it referenced its columns
 * UNQUOTED: `customer_id`, `grand_total`, `placed_at`. This schema is camelCase,
 * and Postgres folds an unquoted identifier to lower case — so the query asked
 * for columns that do not exist and died with 42703. Every request to
 * `GET /v1/admin/users` was a 500, which reached the operator as
 * "Customers could not be loaded".
 *
 * NO UNIT TEST COULD HAVE CAUGHT IT. The repository's collaborator is a Prisma
 * client, and a fake one happily accepts any SQL string — the query is only ever
 * validated by a server. That is exactly the boundary this suite exists for, and
 * there are 23 more `$queryRaw` call sites in the API with the same exposure.
 *
 * It also pins the AGGREGATE itself, not just that the statement parses: money
 * is summed as bigint (spec §4 — an integer accumulator overflows at ~€21.5M of
 * cumulative gross), refunds are deducted, and only revenue-bearing statuses
 * count.
 */

const RUN = isDockerAvailable();

describe.skipIf(!RUN)("aggregateOrderStats (real Postgres)", () => {
  let db: TestDatabase;
  let repository: PrismaUsersDataAccess;

  beforeAll(async () => {
    db = await startTestDatabase();
    // The DATA-ACCESS class, not the Nest repository: it takes the narrow client
    // type, so a plain container-backed PrismaClient satisfies it without a cast.
    repository = new PrismaUsersDataAccess(db.prisma);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  afterEach(async () => {
    await db.reset();
  });

  async function seedCustomer(email: string): Promise<string> {
    const customer = await db.prisma.customer.create({
      data: { email, role: "CUSTOMER" },
    });
    return customer.id;
  }

  async function seedOrder(input: {
    customerId: string | null;
    number: string;
    status: string;
    grandTotal: number;
    refundedTotal?: number;
    placedAt?: Date;
  }): Promise<void> {
    await db.prisma.$executeRawUnsafe(
      `INSERT INTO "order" (
         id, "orderNumber", "customerId", email, status, currency,
         subtotal, "discountTotal", "shippingTotal", "taxTotal", "grandTotal", "refundedTotal",
         "shipFirstName","shipLastName","shipLine1","shipCity","shipRegion","shipCountryCode",
         "billFirstName","billLastName","billLine1","billCity","billRegion","billCountryCode",
         "documentType","documentNumber","placedAt","updatedAt",version
       ) VALUES (
         gen_random_uuid(), $1, $2::uuid, 'buyer@akai.test', $3::"OrderStatus", 'COP',
         $4, 0, 0, 0, $4, $5,
         'A','B','Calle 10 # 43-21','Medellín','Antioquia','CO',
         'A','B','Calle 10 # 43-21','Medellín','Antioquia','CO',
         'CC', '1020304050', $6, now(), 0
       )`,
      input.number,
      input.customerId,
      input.status,
      input.grandTotal,
      input.refundedTotal ?? 0,
      input.placedAt ?? new Date("2026-03-01T10:00:00.000Z"),
    );
  }

  it("runs at all — the column names must match the schema", async () => {
    const customerId = await seedCustomer("stats-smoke@akai.test");
    // The original defect: this threw 42703 before the identifiers were quoted.
    await expect(repository.aggregateOrderStats([customerId])).resolves.toBeDefined();
  });

  it("counts revenue-bearing orders and deducts refunds", async () => {
    const customerId = await seedCustomer("stats@akai.test");
    await seedOrder({ customerId, number: "AK-2026-000001", status: "PAID", grandTotal: 5000 });
    await seedOrder({
      customerId,
      number: "AK-2026-000002",
      status: "PARTIALLY_REFUNDED",
      grandTotal: 3000,
      refundedTotal: 1000,
    });

    const [stats] = await repository.aggregateOrderStats([customerId]);

    expect(stats?.customerId).toBe(customerId);
    expect(stats?.orderCount).toBe(2);
    // 5000 + (3000 - 1000), in integer minor units.
    expect(stats?.lifetimeValueMinor).toBe(7000n);
  });

  it("EXCLUDES a status that never produced revenue", async () => {
    const customerId = await seedCustomer("pending@akai.test");
    await seedOrder({ customerId, number: "AK-2026-000003", status: "PENDING", grandTotal: 9900 });

    // A PENDING order is not money; counting it inflates lifetime value with
    // baskets that were never paid for.
    expect(await repository.aggregateOrderStats([customerId])).toEqual([]);
  });

  it("reports the most recent order date", async () => {
    const customerId = await seedCustomer("recent@akai.test");
    await seedOrder({
      customerId,
      number: "AK-2026-000004",
      status: "PAID",
      grandTotal: 1000,
      placedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await seedOrder({
      customerId,
      number: "AK-2026-000005",
      status: "PAID",
      grandTotal: 1000,
      placedAt: new Date("2026-05-05T00:00:00.000Z"),
    });

    const [stats] = await repository.aggregateOrderStats([customerId]);
    expect(stats?.lastOrderAt?.toISOString()).toBe("2026-05-05T00:00:00.000Z");
  });

  it("returns nothing for a customer with no orders, rather than a zero row", async () => {
    const customerId = await seedCustomer("empty@akai.test");
    expect(await repository.aggregateOrderStats([customerId])).toEqual([]);
  });

  it("short-circuits on an empty id list without touching the database", async () => {
    expect(await repository.aggregateOrderStats([])).toEqual([]);
  });
});
