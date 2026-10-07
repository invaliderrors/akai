import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AdminMetricsService } from "../../api/src/modules/admin/admin-metrics.service";
import { isDockerAvailable, startTestDatabase, type TestDatabase } from "./harness";

/**
 * REGRESSION, AND IT NEEDS A REAL DATABASE.
 *
 * `/admin/metrics/overview` answered 400 for every caller: "Invalid input" on
 * grossTotal and refundedTotal. The money aggregates were written
 * `COALESCE(SUM("grandTotal"::bigint), 0)` — and in Postgres `SUM(bigint)`
 * returns NUMERIC, which the driver hands to Prisma as a `Decimal`. The row
 * schema accepts `bigint | number | null`, so every parse failed.
 *
 * The inner `::bigint` is still correct and still required — it is what stops an
 * `integer` accumulator overflowing at ~€21.5M of cumulative gross — so the fix
 * was a SECOND cast on the result, not a replacement.
 *
 * NO UNIT TEST COULD CATCH THIS. It is a property of what Postgres returns, and
 * a fake client returns whatever the test author imagined.
 */

const RUN = isDockerAvailable();

describe.skipIf(!RUN)("admin metrics aggregates (real Postgres)", () => {
  let db: TestDatabase;
  let service: AdminMetricsService;

  beforeAll(async () => {
    db = await startTestDatabase();
    service = new AdminMetricsService(db.prisma);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  afterEach(async () => {
    await db.reset();
  });

  const WINDOW = {
    from: new Date("2026-01-01T00:00:00.000Z"),
    to: new Date("2026-12-31T00:00:00.000Z"),
    currency: "COP",
  };

  let sequence = 0;

  async function seedOrder(input: {
    status: string;
    grandTotal: number;
    refundedTotal?: number;
    currency?: string;
    placedAt?: Date;
  }): Promise<void> {
    sequence += 1;
    await db.prisma.$executeRawUnsafe(
      `INSERT INTO "order" (
         id, "orderNumber", email, status, currency,
         subtotal, "discountTotal", "shippingTotal", "taxTotal", "grandTotal", "refundedTotal",
         "shipFirstName","shipLastName","shipLine1","shipCity","shipRegion","shipCountryCode",
         "billFirstName","billLastName","billLine1","billCity","billRegion","billCountryCode",
         "documentType","documentNumber","placedAt","updatedAt",version
       ) VALUES (
         gen_random_uuid(), $1, 'buyer@akai.test', $2::"OrderStatus", $3,
         $4, 0, 0, 0, $4, $5,
         'A','B','Calle 10 # 43-21','Medellín','Antioquia','CO',
         'A','B','Calle 10 # 43-21','Medellín','Antioquia','CO',
         'CC', '1020304050', $6, now(), 0
       )`,
      `AK-2026-${String(sequence).padStart(6, "0")}`,
      input.status,
      input.currency ?? "COP",
      input.grandTotal,
      input.refundedTotal ?? 0,
      input.placedAt ?? new Date("2026-06-01T10:00:00.000Z"),
    );
  }

  it("returns a revenue summary at all — the original 400", async () => {
    await seedOrder({ status: "PAID", grandTotal: 5000 });
    await expect(service.revenue(WINDOW)).resolves.toBeDefined();
  });

  it("sums gross and refunds, and nets them", async () => {
    await seedOrder({ status: "PAID", grandTotal: 5000 });
    await seedOrder({ status: "PARTIALLY_REFUNDED", grandTotal: 3000, refundedTotal: 1000 });

    const summary = await service.revenue(WINDOW);

    // Integer minor units throughout — never a float, never a Decimal.
    expect(summary.grossTotal).toBe(8000);
    expect(summary.refundedTotal).toBe(1000);
    expect(summary.netTotal).toBe(7000);
    expect(summary.orderCount).toBe(2);
    expect(Number.isInteger(summary.grossTotal)).toBe(true);
  });

  it("computes the average order value from the NET figure", async () => {
    await seedOrder({ status: "PAID", grandTotal: 5000 });
    await seedOrder({ status: "PAID", grandTotal: 3000, refundedTotal: 1000 });

    // net 7000 over 2 orders.
    expect((await service.revenue(WINDOW)).averageOrderValue).toBe(3500);
  });

  it("returns zeros rather than failing when the window is empty", async () => {
    const summary = await service.revenue(WINDOW);
    expect(summary.grossTotal).toBe(0);
    expect(summary.orderCount).toBe(0);
    // Division by zero must not produce NaN on a page an operator reads.
    expect(summary.averageOrderValue).toBe(0);
  });

  it("excludes a status that never produced revenue", async () => {
    await seedOrder({ status: "PENDING", grandTotal: 9900 });
    expect((await service.revenue(WINDOW)).grossTotal).toBe(0);
  });

  it("excludes another currency", async () => {
    await seedOrder({ status: "PAID", grandTotal: 5000, currency: "USD" });
    expect((await service.revenue(WINDOW)).grossTotal).toBe(0);
  });

  it("excludes orders outside the window", async () => {
    await seedOrder({
      status: "PAID",
      grandTotal: 5000,
      placedAt: new Date("2025-06-01T10:00:00.000Z"),
    });
    expect((await service.revenue(WINDOW)).grossTotal).toBe(0);
  });

  it("holds a total far beyond an int32 accumulator", async () => {
    // The reason for the INNER cast: summing `integer` into an `integer`
    // accumulator raises at ~2.1e9 minor units (~€21.5M). Two orders just under
    // the column maximum exceed it comfortably.
    await seedOrder({ status: "PAID", grandTotal: 2_000_000_000 });
    await seedOrder({ status: "PAID", grandTotal: 2_000_000_000 });

    expect((await service.revenue(WINDOW)).grossTotal).toBe(4_000_000_000);
  });
});
