import {
  type AdminOrderSummary,
  type OrderShippingFilter,
  type ShipmentStatus,
  shipmentStatusSchema,
} from "@akai/contracts";
import type { Prisma } from "@akai/db";
import { toMinor } from "@akai/money";

import { SHIPMENT_STATUS_TRAITS } from "./shipment-status";

/**
 * The admin order LIST's fulfilment half (Sendcloud spec §3.6, §7): the
 * shipping-status filter and the compact newest-shipment column.
 *
 * Its own file rather than more of `orders.service.ts` / `orders.mapper.ts`
 * because both are pure and table-driven, and a `Prisma.OrderWhereInput` is
 * worth asserting exactly — a filter that silently matches every order reads
 * as "no problems" on the one screen staff use to find problems.
 */

/**
 * Parcels whose lines count as shipped — derived from `SHIPMENT_STATUS_TRAITS`
 * (everything but CANCELLED / FAILED), so a status added to that total map
 * lands here without a second edit.
 */
export const ACTIVE_SHIPMENT_STATUSES: readonly ShipmentStatus[] =
  shipmentStatusSchema.options.filter((status) => SHIPMENT_STATUS_TRAITS[status].carriesGoods);

const noActiveShipment = {
  shipments: { none: { status: { in: [...ACTIVE_SHIPMENT_STATUSES] } } },
} satisfies Prisma.OrderWhereInput;

export function shippingFilterWhere(filter: OrderShippingFilter): Prisma.OrderWhereInput {
  switch (filter) {
    case "NO_LABEL":
      // FULFILLING too: an order moved there by hand, or left there by a
      // label whose only parcel was cancelled before the edge back existed,
      // still has nothing shipping it.
      return { status: { in: ["PAID", "FULFILLING"] }, ...noActiveShipment };
    case "LABEL_CREATED":
      return { shipments: { some: { status: "LABEL_CREATED" } } };
    case "IN_TRANSIT":
      return { shipments: { some: { status: { in: ["IN_TRANSIT", "AWAITING_PICKUP"] } } } };
    case "ISSUE":
      return {
        OR: [
          // A carrier problem matters while the order is still ours to fix; a
          // RETURNED parcel on a refunded order is history, not a to-do.
          {
            status: { in: ["PAID", "FULFILLING", "SHIPPED"] },
            shipments: { some: { status: { in: ["EXCEPTION", "RETURNED", "LOST"] } } },
          },
          // A FAILED announcement is only an issue until a retry succeeds.
          {
            status: { in: ["PAID", "FULFILLING"] },
            AND: [{ shipments: { some: { status: "FAILED" } } }, noActiveShipment],
          },
        ],
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
      provider: true,
      carrier: true,
      trackingNumber: true,
      labelObjectKey: true,
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
            provider: newest.provider,
            carrier: newest.carrier,
            trackingNumber: newest.trackingNumber,
            // Presence only — the key is a storage detail.
            hasLabel: newest.labelObjectKey !== null,
          },
  };
}
