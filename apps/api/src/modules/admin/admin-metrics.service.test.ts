import "reflect-metadata";
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  AdminMetricsService,
  REVENUE_STATUSES,
  toMinorTotal,
} from "./admin-metrics.service";
import { metricsWindowQuerySchema } from "./admin.dto";
import type { PrismaService } from "../prisma/prisma.service";

const WINDOW = {
  from: new Date("2026-06-01T00:00:00.000Z"),
  to: new Date("2026-07-01T00:00:00.000Z"),
  currency: "EUR",
};

/**
 * The shape of a Prisma tagged-template query, reduced to the two members these
 * tests read.
 *
 * `$queryRaw` receives a `Prisma.Sql`: `strings` is the literal SQL either side
 * of each interpolation and `values` is what was interpolated. Asserting on
 * `strings` is how this suite proves the `::bigint` casts are in the SQL, and on
 * `values` that a caller-supplied limit was clamped BEFORE it reached the
 * database. Both were being read off an `any`, which is the one thing that would
 * let those assertions keep passing against SQL that no longer contains them.
 */
interface SqlQuery {
  readonly strings: readonly string[];
  readonly values: readonly unknown[];
}

type QueryRawFn = (query: SqlQuery, ...values: readonly unknown[]) => Promise<unknown>;

function buildService(queryRawResult: unknown): {
  service: AdminMetricsService;
  queryRaw: Mock<QueryRawFn>;
} {
  const queryRaw = vi.fn<QueryRawFn>(async () => queryRawResult);
  const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
  return { service: new AdminMetricsService(prisma), queryRaw };
}

describe("toMinorTotal", () => {
  it("normalises a SQL NULL sum to zero", () => {
    // SUM over an empty set is NULL, not 0 — the single most common way an
    // empty-state dashboard renders NaN.
    expect(toMinorTotal(null)).toBe(0);
  });

  it("converts a bigint aggregate to an exact integer", () => {
    expect(toMinorTotal(123_456_789n)).toBe(123_456_789);
  });

  it("accepts totals ABOVE the per-transaction Minor cap", () => {
    // €25M of lifetime revenue exceeds MINOR_MAX (€20M), which `toMinor` rejects
    // by design. An aggregate must not start throwing because the store did well.
    expect(toMinorTotal(2_500_000_000n)).toBe(2_500_000_000);
  });

  it("throws rather than silently losing precision past 2^53", () => {
    // Beyond the safe-integer range a JS number stops representing consecutive
    // integers. Reporting a wrong revenue figure is worse than reporting none.
    expect(() => toMinorTotal(9_007_199_254_740_993n)).toThrow(RangeError);
  });
});

describe("AdminMetricsService — revenue", () => {
  it("nets refunds off gross and computes an average order value", async () => {
    const { service } = buildService([
      { grossTotal: 100_000n, refundedTotal: 15_000n, orderCount: 4n },
    ]);

    const summary = await service.revenue(WINDOW);

    expect(summary.grossTotal).toBe(100_000);
    expect(summary.refundedTotal).toBe(15_000);
    // The figure that matches the bank.
    expect(summary.netTotal).toBe(85_000);
    expect(summary.orderCount).toBe(4);
    expect(summary.averageOrderValue).toBe(21_250);
  });

  it("returns a zeroed summary — not NaN — when there are no orders", async () => {
    const { service } = buildService([
      { grossTotal: null, refundedTotal: null, orderCount: 0n },
    ]);

    const summary = await service.revenue(WINDOW);

    // Dividing 0 by 0 for the average is the specific crash this guards.
    expect(summary).toMatchObject({
      grossTotal: 0,
      refundedTotal: 0,
      netTotal: 0,
      orderCount: 0,
      averageOrderValue: 0,
    });
  });

  it("casts every money aggregate to ::bigint", async () => {
    const { service, queryRaw } = buildService([
      { grossTotal: 1n, refundedTotal: 0n, orderCount: 1n },
    ]);

    await service.revenue(WINDOW);

    const sql = String(queryRaw.mock.calls[0]?.[0].strings.join("?") ?? "");

    // Spec §4. Without the cast, Postgres sums integer columns into an integer
    // accumulator and RAISES on overflow at ~€21.5M cumulative gross — in
    // production, on the dashboard the owner checks most.
    expect(sql).toContain('SUM("grandTotal"::bigint)');
    expect(sql).toContain('SUM("refundedTotal"::bigint)');
  });

  it("counts only realised revenue, excluding uncaptured and failed orders", () => {
    // Counting AWAITING_PAYMENT as revenue makes the dashboard disagree with
    // the gateway; excluding REFUNDED entirely would make orders vanish from history
    // instead of showing as a reduction.
    expect(REVENUE_STATUSES).not.toContain("PENDING");
    expect(REVENUE_STATUSES).not.toContain("AWAITING_PAYMENT");
    expect(REVENUE_STATUSES).not.toContain("CANCELLED");
    expect(REVENUE_STATUSES).not.toContain("FAILED");
    expect(REVENUE_STATUSES).toContain("PAID");
    expect(REVENUE_STATUSES).toContain("REFUNDED");
  });

  it("rejects a row whose shape does not match the query", async () => {
    const { service } = buildService([{ grossTotal: "not-a-number" }]);

    // The raw-SQL result is external data. Parsing it means a column rename in
    // the query fails loudly instead of yielding undefined arithmetic.
    await expect(service.revenue(WINDOW)).rejects.toThrow();
  });
});

describe("AdminMetricsService — top products and low stock", () => {
  it("maps top-product rows and sums revenue as an aggregate", async () => {
    const { service } = buildService([
      { sku: "HOOD-M", productName: "Hoodie Kumo", unitsSold: 42n, revenueGross: 209_958n },
    ]);

    const top = await service.topProducts(WINDOW, 10);

    expect(top).toEqual([
      { sku: "HOOD-M", productName: "Hoodie Kumo", unitsSold: 42, revenueGross: 209_958 },
    ]);
  });

  it("clamps a caller-supplied limit instead of trusting it", async () => {
    const { service, queryRaw } = buildService([]);

    await service.topProducts(WINDOW, 10_000);

    // The limit reaches SQL. An unclamped one is a trivially available way to
    // make the database do maximal work on an authenticated endpoint.
    const values = queryRaw.mock.calls[0]?.[0].values ?? [];
    expect(values).toContain(100);
  });

  it("measures low stock against AVAILABLE, not on-hand", async () => {
    const { service, queryRaw } = buildService([]);

    await service.lowStock(20);
    const sql = String(queryRaw.mock.calls[0]?.[0].strings.join("?") ?? "");

    // Stock inside someone's in-flight checkout is already spoken for; measuring
    // against onHand is how you oversell.
    expect(sql).toContain('ii."onHand" - ii."reserved"');
    expect(sql).toContain('ii."allowBackorder" = false');
  });

  it("returns low-stock rows parsed into the declared shape", async () => {
    const { service } = buildService([
      {
        variantId: "v-1",
        sku: "HOOD-M",
        onHand: 4,
        reserved: 2,
        available: 2,
        lowStockThreshold: 5,
      },
    ]);

    const low = await service.lowStock(20);
    expect(low[0]).toMatchObject({ sku: "HOOD-M", available: 2 });
  });
});

describe("AdminMetricsService.repeatCustomerRate", () => {
  it("computes the share of window customers who are repeat buyers, rounded", async () => {
    const { service } = buildService([
      { customersInWindow: 3n, repeatCustomers: 1n },
    ]);

    const result = await service.repeatCustomerRate(WINDOW);

    expect(result).toEqual({
      customersInWindow: 3,
      repeatCustomers: 1,
      // 1/3 rounded to 4 decimals, not left as a repeating float.
      repeatRate: 0.3333,
    });
  });

  it("reports zero rather than dividing by zero when nobody ordered in the window", async () => {
    const { service } = buildService([{ customersInWindow: 0n, repeatCustomers: 0n }]);

    const result = await service.repeatCustomerRate(WINDOW);

    expect(result.repeatRate).toBe(0);
  });

  it("scopes the lifetime count to REVENUE statuses, same list revenue() uses", async () => {
    const { service, queryRaw } = buildService([
      { customersInWindow: 1n, repeatCustomers: 0n },
    ]);

    await service.repeatCustomerRate(WINDOW);

    const values = queryRaw.mock.calls[0]?.[0].values ?? [];
    expect(values.flat()).toEqual(expect.arrayContaining([...REVENUE_STATUSES]));
  });
});

describe("AdminMetricsService.returnsSummary", () => {
  it("totals the per-status counts", async () => {
    const { service } = buildService([
      { status: "REQUESTED", count: 3n },
      { status: "REFUNDED", count: 2n },
    ]);

    const summary = await service.returnsSummary(WINDOW);

    expect(summary.total).toBe(5);
    expect(summary.byStatus).toEqual([
      { status: "REQUESTED", count: 3 },
      { status: "REFUNDED", count: 2 },
    ]);
  });

  it("reports an empty, not a throwing, summary when nothing was filed", async () => {
    const { service } = buildService([]);

    const summary = await service.returnsSummary(WINDOW);

    expect(summary).toEqual({ byStatus: [], total: 0 });
  });
});

describe("AdminMetricsService.emailDeliverySummary", () => {
  it("totals the per-status counts", async () => {
    const { service } = buildService([
      { status: "DELIVERED", count: 40n },
      { status: "BOUNCED", count: 2n },
    ]);

    const summary = await service.emailDeliverySummary(WINDOW);

    expect(summary.total).toBe(42);
    expect(summary.byStatus).toEqual([
      { status: "DELIVERED", count: 40 },
      { status: "BOUNCED", count: 2 },
    ]);
  });
});

describe("AdminMetricsService.dailyRevenue", () => {
  it("maps each day to its own gross total, in integer minor units", async () => {
    const { service } = buildService([
      { day: new Date("2026-06-10T00:00:00.000Z"), grossTotal: 5_000n },
      { day: new Date("2026-06-11T00:00:00.000Z"), grossTotal: 12_500n },
    ]);

    const series = await service.dailyRevenue(WINDOW);

    expect(series).toEqual([
      { day: "2026-06-10T00:00:00.000Z", grossTotal: 5_000 },
      { day: "2026-06-11T00:00:00.000Z", grossTotal: 12_500 },
    ]);
  });

  it("casts the money aggregate to ::bigint, same guard as revenue()", async () => {
    const { service, queryRaw } = buildService([
      { day: new Date("2026-06-10T00:00:00.000Z"), grossTotal: 1n },
    ]);

    await service.dailyRevenue(WINDOW);

    const sql = String(queryRaw.mock.calls[0]?.[0].strings.join("?") ?? "");
    expect(sql).toContain('SUM("grandTotal"::bigint)');
  });

  it("returns an empty series rather than throwing when the window has no orders", async () => {
    const { service } = buildService([]);

    await expect(service.dailyRevenue(WINDOW)).resolves.toEqual([]);
  });
});

describe("metricsWindowQuerySchema", () => {
  it("defaults to a bounded recent window rather than all-time", () => {
    const parsed = metricsWindowQuerySchema.parse({});
    const days = (parsed.to.getTime() - parsed.from.getTime()) / (24 * 60 * 60 * 1000);

    // An unbounded default means the owner's first dashboard load full-scans the
    // largest table in the system, and gets slower every day the store succeeds.
    expect(Math.round(days)).toBe(30);
    expect(parsed.currency).toBe("EUR");
  });

  it("rejects an inverted window", () => {
    expect(() =>
      metricsWindowQuerySchema.parse({
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-06-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects a window wide enough to be a denial-of-service", () => {
    expect(() =>
      metricsWindowQuerySchema.parse({
        from: "1970-01-01T00:00:00.000Z",
        to: "2026-07-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects unknown query keys", () => {
    // .strict() IS forbidNonWhitelisted (spec §7).
    expect(() => metricsWindowQuerySchema.parse({ currency: "EUR", sneaky: 1 })).toThrow();
  });
});
