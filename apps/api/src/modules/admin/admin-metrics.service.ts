import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { Prisma } from "@akai/db";
import type { OrderStatus } from "@akai/contracts";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Aggregate money, in integer minor units.
 *
 * DELIBERATELY NOT `Minor` from @akai/contracts, and this is worth reading.
 * `Minor` is capped at MINOR_MAX (2_000_000_000 minor units = €20M) because it
 * models a single transactional amount, and `toMinor` THROWS above that cap.
 * A platform-lifetime revenue sum legitimately exceeds €20M, so minting one as
 * `Minor` would make the dashboard start throwing on a successful business.
 *
 * The alternative — silently widening the cap on `Minor` — would weaken the
 * guard on every order total to accommodate a read-only reporting figure. So
 * aggregates get their own type. It is never used in arithmetic that feeds a
 * charge: it is display-only, and the compiler keeps it out of `Minor` slots.
 *
 * See followUps: this belongs in @akai/money as a first-class aggregate type.
 */
declare const AGGREGATE_MINOR_BRAND: unique symbol;

export type MinorTotal = number & { readonly [AGGREGATE_MINOR_BRAND]: "aggregate" };

/**
 * Statuses that count as realised revenue.
 *
 * PENDING/AWAITING_PAYMENT are excluded: money that has not been captured is not
 * revenue, and counting it makes the dashboard disagree with the gateway. CANCELLED
 * and FAILED are likewise excluded. REFUNDED orders ARE included at gross and
 * then netted off via `refundedTotal`, so a refund shows up as a reduction
 * rather than an order vanishing from history.
 */
export const REVENUE_STATUSES: readonly OrderStatus[] = [
  "PAID",
  "FULFILLING",
  "SHIPPED",
  "DELIVERED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
];

/**
 * TWO CASTS PER MONEY AGGREGATE, AND THEY DO DIFFERENT JOBS.
 *
 * The INNER one (`SUM(x::bigint)`) is about overflow: Postgres sums an `integer`
 * column into an `integer` accumulator and RAISES at ~€21.5M of cumulative gross
 * (spec §4).
 *
 * The OUTER one (`SUM(...)::bigint`) is about the returned TYPE, and it was
 * missing. `SUM(bigint)` returns NUMERIC — the inner cast is exactly what makes
 * it numeric rather than bigint — and the pg driver hands numeric to Prisma as a
 * `Decimal`, which is none of the three members below. The whole
 * `/admin/metrics/overview` endpoint answered 400 with "Invalid input" on
 * grossTotal and refundedTotal.
 *
 * `SUM(integer)` returns bigint, so `SUM(oi."quantity")` needs no inner cast —
 * only the money columns, which are already bigint by then, do.
 */
const bigintish = z.union([z.bigint(), z.number(), z.null()]);

const revenueRowSchema = z
  .object({
    grossTotal: bigintish,
    refundedTotal: bigintish,
    orderCount: bigintish,
  })
  .strict();

const statusCountRowSchema = z
  .object({ status: z.string(), count: bigintish })
  .strict();

const topProductRowSchema = z
  .object({
    sku: z.string(),
    productName: z.string(),
    unitsSold: bigintish,
    revenueGross: bigintish,
  })
  .strict();

const lowStockRowSchema = z
  .object({
    variantId: z.string(),
    sku: z.string(),
    onHand: z.number().int(),
    reserved: z.number().int(),
    available: z.number().int(),
    lowStockThreshold: z.number().int(),
  })
  .strict();

const repeatRateRowSchema = z
  .object({
    customersInWindow: bigintish,
    repeatCustomers: bigintish,
  })
  .strict();

const dailyRevenueRowSchema = z
  .object({
    day: z.date(),
    grossTotal: bigintish,
  })
  .strict();

/**
 * Convert a SQL aggregate into an integer minor-unit total.
 *
 * A SUM over an empty set is NULL in SQL, not 0 — the single most common way an
 * empty-state dashboard renders "NaN" or crashes. That case is normalised here,
 * once, rather than at each of five call sites.
 */
export function toMinorTotal(value: bigint | number | null): MinorTotal {
  if (value === null) {
    return 0 as MinorTotal;
  }
  const asNumber = typeof value === "bigint" ? Number(value) : value;

  if (!Number.isSafeInteger(asNumber)) {
    // Past 2^53 a JS number silently stops representing consecutive integers.
    // Reporting a wrong revenue figure is worse than reporting none.
    throw new RangeError(
      `Aggregate ${String(value)} exceeds the safe integer range and cannot be represented exactly`,
    );
  }
  return asNumber as MinorTotal;
}

export interface RevenueSummary {
  readonly grossTotal: MinorTotal;
  readonly refundedTotal: MinorTotal;
  /** gross - refunded. The figure that matches the bank. */
  readonly netTotal: MinorTotal;
  readonly orderCount: number;
  /** Integer division, rounded half-up. Zero when there are no orders. */
  readonly averageOrderValue: MinorTotal;
  readonly currency: string;
  readonly from: string;
  readonly to: string;
}

export interface StatusCount {
  readonly status: string;
  readonly count: number;
}

export interface TopProduct {
  readonly sku: string;
  readonly productName: string;
  readonly unitsSold: number;
  readonly revenueGross: MinorTotal;
}

export interface LowStockVariant {
  readonly variantId: string;
  readonly sku: string;
  readonly onHand: number;
  readonly reserved: number;
  readonly available: number;
  readonly lowStockThreshold: number;
}

export interface RecentOrder {
  readonly orderNumber: string;
  readonly status: string;
  readonly grandTotal: MinorTotal;
  readonly currency: string;
  readonly placedAt: string;
  /** Present only for registered customers; guest orders have none. */
  readonly customerId: string | null;
}

export interface MetricsWindow {
  readonly from: Date;
  readonly to: Date;
  readonly currency: string;
}

export interface RepeatCustomerRate {
  /** Customers who placed at least one revenue-counted order IN the window. */
  readonly customersInWindow: number;
  /** Of those, how many have 2+ revenue-counted orders in their LIFETIME. */
  readonly repeatCustomers: number;
  /** `repeatCustomers / customersInWindow`, rounded to 4 decimals. 0 when there are no customers. */
  readonly repeatRate: number;
}

export interface ReturnsSummary {
  readonly byStatus: readonly StatusCount[];
  readonly total: number;
}

export interface EmailDeliverySummary {
  readonly byStatus: readonly StatusCount[];
  readonly total: number;
}

export interface DailyRevenuePoint {
  /** UTC midnight of the day this point summarises, as an ISO string. */
  readonly day: string;
  readonly grossTotal: MinorTotal;
}

/**
 * Only raw SQL and the typed `order` delegate are used. Narrowing to them is what
 * lets an integration test hand this a container-backed client instead of the
 * Nest-managed `PrismaService` — hand-written SQL is validated by a server and by
 * nothing else, so it has to be exercised against a real one.
 */
type MetricsPrismaClient = Pick<PrismaService, "$queryRaw" | "order">;

@Injectable()
export class AdminMetricsService {
  constructor(@Inject(PrismaService) private readonly prisma: MetricsPrismaClient) {}

  /**
   * Revenue over a window.
   *
   * EVERY money aggregate below is cast `::bigint` before SUM. Without the cast
   * Postgres sums `integer` columns into an `integer` accumulator and RAISES on
   * overflow at ~€21.5M of cumulative gross — the failure lands in production,
   * on a good day, on the dashboard the owner checks most. This is spec §4 and
   * it is not optional.
   */
  async revenue(window: MetricsWindow): Promise<RevenueSummary> {
    const rows = await this.prisma.$queryRaw<unknown>(Prisma.sql`
      SELECT
        COALESCE(SUM("grandTotal"::bigint), 0)::bigint    AS "grossTotal",
        COALESCE(SUM("refundedTotal"::bigint), 0)::bigint AS "refundedTotal",
        COUNT(*)::bigint                          AS "orderCount"
      FROM "order"
      WHERE "placedAt" >= ${window.from}
        AND "placedAt" <  ${window.to}
        AND "currency"  = ${window.currency}
        AND "status"::text = ANY(${REVENUE_STATUSES.map((status) => status)})
    `);

    const [row] = z.array(revenueRowSchema).parse(rows);
    const gross = toMinorTotal(row?.grossTotal ?? null);
    const refunded = toMinorTotal(row?.refundedTotal ?? null);
    const orderCount = Number(row?.orderCount ?? 0);

    const net = toMinorTotal(gross - refunded);
    const average =
      orderCount === 0 ? toMinorTotal(0) : toMinorTotal(Math.round(net / orderCount));

    return {
      grossTotal: gross,
      refundedTotal: refunded,
      netTotal: net,
      orderCount,
      averageOrderValue: average,
      currency: window.currency,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    };
  }

  /** Order counts per status over the window. Drives the dashboard status tiles. */
  async orderCountsByStatus(window: MetricsWindow): Promise<readonly StatusCount[]> {
    const rows = await this.prisma.$queryRaw<unknown>(Prisma.sql`
      SELECT "status"::text AS "status", COUNT(*)::bigint AS "count"
      FROM "order"
      WHERE "placedAt" >= ${window.from}
        AND "placedAt" <  ${window.to}
      GROUP BY "status"
      ORDER BY "status"
    `);

    return z
      .array(statusCountRowSchema)
      .parse(rows)
      .map((row) => ({ status: row.status, count: Number(row.count ?? 0) }));
  }

  /**
   * Best sellers by units, over realised-revenue orders only.
   *
   * Grouped by the order line's SNAPSHOTTED sku and productName, never by a join
   * to the live product. Historical reporting must not change retroactively when
   * a product is renamed, and a deleted product must still appear in last
   * quarter's numbers.
   */
  async topProducts(window: MetricsWindow, limit: number): Promise<readonly TopProduct[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);

    const rows = await this.prisma.$queryRaw<unknown>(Prisma.sql`
      SELECT
        oi."sku"                                AS "sku",
        MIN(oi."productName")                   AS "productName",
        SUM(oi."quantity")::bigint              AS "unitsSold",
        SUM(oi."lineTotalGross"::bigint)::bigint AS "revenueGross"
      FROM "order_item" oi
      JOIN "order" o ON o."id" = oi."orderId"
      WHERE o."placedAt" >= ${window.from}
        AND o."placedAt" <  ${window.to}
        AND o."currency"  = ${window.currency}
        AND o."status"::text = ANY(${REVENUE_STATUSES.map((status) => status)})
      GROUP BY oi."sku"
      ORDER BY "unitsSold" DESC, "revenueGross" DESC
      LIMIT ${safeLimit}
    `);

    return z
      .array(topProductRowSchema)
      .parse(rows)
      .map((row) => ({
        sku: row.sku,
        productName: row.productName,
        unitsSold: Number(row.unitsSold ?? 0),
        revenueGross: toMinorTotal(row.revenueGross ?? null),
      }));
  }

  /**
   * Variants at or below their reorder threshold.
   *
   * Raw SQL because this is a COLUMN-TO-COLUMN comparison
   * (`onHand - reserved <= lowStockThreshold`), which Prisma's `where` cannot
   * express — the alternative is loading every variant into memory and
   * filtering in Node, which stops working at exactly the catalogue size where
   * you start needing the report.
   *
   * `available` (onHand - reserved), not onHand: stock inside someone's
   * in-flight checkout is already spoken for, and reordering against it is how
   * you oversell.
   */
  async lowStock(limit: number): Promise<readonly LowStockVariant[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);

    const rows = await this.prisma.$queryRaw<unknown>(Prisma.sql`
      SELECT
        ii."variantId"                              AS "variantId",
        pv."sku"                                    AS "sku",
        ii."onHand"                                 AS "onHand",
        ii."reserved"                               AS "reserved",
        (ii."onHand" - ii."reserved")               AS "available",
        ii."lowStockThreshold"                      AS "lowStockThreshold"
      FROM "inventory_item" ii
      JOIN "product_variant" pv ON pv."id" = ii."variantId"
      WHERE ii."allowBackorder" = false
        AND (ii."onHand" - ii."reserved") <= ii."lowStockThreshold"
      ORDER BY (ii."onHand" - ii."reserved") ASC, pv."sku" ASC
      LIMIT ${safeLimit}
    `);

    return z.array(lowStockRowSchema).parse(rows);
  }

  /**
   * Most recent orders. Uses the typed Prisma API rather than raw SQL because
   * there is no aggregate here — no overflow risk, so no reason to give up
   * schema-checked column names.
   */
  async recentOrders(limit: number): Promise<readonly RecentOrder[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);

    const orders = await this.prisma.order.findMany({
      orderBy: { placedAt: "desc" },
      take: safeLimit,
      select: {
        orderNumber: true,
        status: true,
        grandTotal: true,
        currency: true,
        placedAt: true,
        customerId: true,
      },
    });

    return orders.map((order) => ({
      orderNumber: order.orderNumber,
      status: order.status,
      grandTotal: toMinorTotal(order.grandTotal),
      currency: order.currency,
      placedAt: order.placedAt.toISOString(),
      customerId: order.customerId,
    }));
  }

  /**
   * What fraction of the customers who ordered IN this window have ordered
   * MORE THAN ONCE, ever — not just within the window.
   *
   * "Repeat rate over a period" has no single standard definition; this one
   * answers "of the people who bought from us this window, how many are
   * repeat buyers" rather than "how many orders in the window were a second
   * order", because the first framing is the one an operator can act on (loyal
   * customers vs. one-time buyers), and the second double-counts a customer
   * who ordered three times in one week.
   *
   * TWO CTEs, not a join with GROUP BY HAVING: the inner one fixes WHICH
   * customers are in scope (ordered in the window), the outer counts their
   * LIFETIME orders — a single grouped query cannot ask "count all orders for
   * a customer" while also filtering "but only customers who ordered in this
   * window" without either double-filtering the count or duplicating the
   * window predicate in a HAVING clause that reads nothing like the intent.
   */
  async repeatCustomerRate(window: MetricsWindow): Promise<RepeatCustomerRate> {
    const statuses = REVENUE_STATUSES.map((status) => status);

    const rows = await this.prisma.$queryRaw<unknown>(Prisma.sql`
      WITH window_customers AS (
        SELECT DISTINCT "customerId"
        FROM "order"
        WHERE "placedAt" >= ${window.from}
          AND "placedAt" <  ${window.to}
          AND "customerId" IS NOT NULL
          AND "status"::text = ANY(${statuses})
      ),
      lifetime_counts AS (
        SELECT "customerId", COUNT(*) AS order_count
        FROM "order"
        WHERE "customerId" IN (SELECT "customerId" FROM window_customers)
          AND "status"::text = ANY(${statuses})
        GROUP BY "customerId"
      )
      SELECT
        COUNT(*)::bigint AS "customersInWindow",
        COUNT(*) FILTER (WHERE order_count >= 2)::bigint AS "repeatCustomers"
      FROM lifetime_counts
    `);

    const [row] = z.array(repeatRateRowSchema).parse(rows);
    const customersInWindow = Number(row?.customersInWindow ?? 0);
    const repeatCustomers = Number(row?.repeatCustomers ?? 0);

    return {
      customersInWindow,
      repeatCustomers,
      repeatRate:
        customersInWindow === 0
          ? 0
          : Math.round((repeatCustomers / customersInWindow) * 10_000) / 10_000,
    };
  }

  /** Return requests filed over the window, grouped by their current status. */
  async returnsSummary(window: MetricsWindow): Promise<ReturnsSummary> {
    const rows = await this.prisma.$queryRaw<unknown>(Prisma.sql`
      SELECT "status"::text AS "status", COUNT(*)::bigint AS "count"
      FROM "return_request"
      WHERE "requestedAt" >= ${window.from}
        AND "requestedAt" <  ${window.to}
      GROUP BY "status"
      ORDER BY "status"
    `);

    const byStatus = z
      .array(statusCountRowSchema)
      .parse(rows)
      .map((row) => ({ status: row.status, count: Number(row.count ?? 0) }));

    return { byStatus, total: byStatus.reduce((sum, entry) => sum + entry.count, 0) };
  }

  /**
   * Outbound email over the window, grouped by delivery status.
   *
   * DELIVERY STATUS ONLY — `email_event.status` never reaches "opened" or
   * "clicked", by design (see `resend-webhook.schemas.ts`): those are
   * engagement signals the webhook handler deliberately discards, not outcomes
   * this table can report. A rate built from this method answers "did the
   * mail arrive", never "did anyone read it".
   */
  async emailDeliverySummary(window: MetricsWindow): Promise<EmailDeliverySummary> {
    const rows = await this.prisma.$queryRaw<unknown>(Prisma.sql`
      SELECT "status"::text AS "status", COUNT(*)::bigint AS "count"
      FROM "email_event"
      WHERE "createdAt" >= ${window.from}
        AND "createdAt" <  ${window.to}
      GROUP BY "status"
      ORDER BY "status"
    `);

    const byStatus = z
      .array(statusCountRowSchema)
      .parse(rows)
      .map((row) => ({ status: row.status, count: Number(row.count ?? 0) }));

    return { byStatus, total: byStatus.reduce((sum, entry) => sum + entry.count, 0) };
  }

  /**
   * Gross revenue per day over the window — the one series the overview page's
   * own doc comment names as deliberately absent until something built it.
   *
   * `date_trunc('day', ...)` groups in the DATABASE's session time zone, which
   * is UTC (spec-pinned at connection level); a day boundary here is a UTC day,
   * not the operator's local one. Documented rather than silently assumed,
   * because "day" is exactly the kind of word two people agree on until they
   * compare numbers at 11pm.
   */
  async dailyRevenue(window: MetricsWindow): Promise<readonly DailyRevenuePoint[]> {
    const rows = await this.prisma.$queryRaw<unknown>(Prisma.sql`
      SELECT
        date_trunc('day', "placedAt") AS "day",
        COALESCE(SUM("grandTotal"::bigint), 0)::bigint AS "grossTotal"
      FROM "order"
      WHERE "placedAt" >= ${window.from}
        AND "placedAt" <  ${window.to}
        AND "currency"  = ${window.currency}
        AND "status"::text = ANY(${REVENUE_STATUSES.map((status) => status)})
      GROUP BY "day"
      ORDER BY "day"
    `);

    return z
      .array(dailyRevenueRowSchema)
      .parse(rows)
      .map((row) => ({
        day: row.day.toISOString(),
        grossTotal: toMinorTotal(row.grossTotal ?? null),
      }));
  }
}
