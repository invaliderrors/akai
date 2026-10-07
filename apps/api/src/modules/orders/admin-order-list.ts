import type { AdminOrderSummary, OrderShippingFilter } from "@akai/contracts";
import type { Prisma } from "@akai/db";
import { toMinor } from "@akai/money";

/**
 * The admin order LIST's fulfilment half: the shipping-status filter and the
 * compact newest-shipment column.
 *
 * Its own file rather than more of `orders.service.ts` / `orders.mapper.ts`
 * because both are pure and table-driven, and a `Prisma.OrderWhereInput` is
 * worth asserting exactly — a filter that silently matches every order reads
 * as "no problems" on the one screen staff use to find problems.
 */
export function shippingFilterWhere(filter: OrderShippingFilter): Prisma.OrderWhereInput {
  switch (filter) {
    case "NOT_SHIPPED":
      // FULFILLING too: an order moved there by hand has nothing shipping it
      // until a parcel is recorded.
      return { status: { in: ["PAID", "FULFILLING"] }, shipments: { none: {} } };
    case "IN_TRANSIT":
      return { shipments: { some: { status: "IN_TRANSIT" } } };
    case "ISSUE":
      // A parcel problem matters while the order is still ours to fix; a
      // RETURNED parcel on a refunded order is history, not a to-do.
      return {
        status: { in: ["PAID", "FULFILLING", "SHIPPED"] },
        shipments: { some: { status: { in: ["RETURNED", "LOST"] } } },
      };
  }
}

/** The include every admin list read uses: unit counts and the NEWEST parcel only. */
export const ADMIN_SUMMARY_INCLUDE = {
  items: { select: { quantity: true } },
  shipments: {
    orderBy: { createdAt: "desc" },
    take: 1,
    select: {
      id: true,
      status: true,
      carrier: true,
      trackingNumber: true,
    },
  },
} satisfies Prisma.OrderInclude;

type OrderRowForAdminSummary = Prisma.OrderGetPayload<{
  include: typeof ADMIN_SUMMARY_INCLUDE;
}>;

/**
 * Only the columns the mapper reads — so a test can build one without the
 * other forty, and the Prisma row (a superset) is accepted as it is.
 */
export type OrderForAdminSummary = Pick<
  OrderRowForAdminSummary,
  "id" | "orderNumber" | "status" | "currency" | "grandTotal" | "placedAt" | "items" | "shipments"
>;

export function toAdminOrderSummaryDto(row: OrderForAdminSummary): AdminOrderSummary {
  const [newest] = row.shipments;
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    status: row.status,
    currency: row.currency,
    grandTotal: toMinor(row.grandTotal),
    itemCount: row.items.reduce((total, item) => total + item.quantity, 0),
    placedAt: row.placedAt.toISOString(),
    shipment:
      newest === undefined
        ? null
        : {
            id: newest.id,
            status: newest.status,
            carrier: newest.carrier,
            trackingNumber: newest.trackingNumber,
          },
  };
}
