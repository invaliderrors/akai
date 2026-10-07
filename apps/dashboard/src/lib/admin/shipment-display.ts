import {
  type AdminOrder,
  type OrderShippingFilter,
  type ShipmentStatus,
  orderShippingFilterSchema,
} from "@akai/contracts";

/**
 * Pure display rules for the order's shipments — kept out of the components so
 * they are testable without rendering (the `discount-display.ts` split).
 *
 * Shipping is MANUAL: staff record a parcel with the carrier and tracking
 * number as free text, then mark it delivered. The API re-checks every rule
 * here (paid order, units left to ship); these only decide what to OFFER.
 */

export const SHIPPING_FILTERS: readonly OrderShippingFilter[] = orderShippingFilterSchema.options;

/** A URL value narrowed to a filter, or undefined — never forwarded unchecked. */
export function asShippingFilter(value: string | undefined): OrderShippingFilter | undefined {
  const parsed = orderShippingFilterSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** One order line and the units of it the parcel will carry. */
export interface UnshippedLine {
  readonly orderItemId: string;
  readonly quantity: number;
}

/**
 * The lines a new parcel carries: every unit of every line, while nothing has
 * shipped yet. A parcel's own lines are not on the order DTO (only its carrier
 * and status are), so once one exists this proposes nothing — the API still
 * accepts a partial second parcel, and refuses an over-shipment regardless.
 */
export function unshippedLines(
  order: Pick<AdminOrder, "items" | "shipments">,
): readonly UnshippedLine[] {
  if (order.shipments.length > 0) {
    return [];
  }
  return order.items.map((item) => ({ orderItemId: item.id, quantity: item.quantity }));
}

/** Whether to OFFER "Marcar como enviado": a paid order with nothing shipped yet. */
export function canRecordShipment(
  order: Pick<AdminOrder, "status" | "items" | "shipments">,
): boolean {
  return (
    (order.status === "PAID" || order.status === "FULFILLING") && unshippedLines(order).length > 0
  );
}

/** TOTAL over the contract's statuses, so a new one is a compile error here. */
const DELIVERABLE: Readonly<Record<ShipmentStatus, boolean>> = {
  PENDING: true,
  IN_TRANSIT: true,
  DELIVERED: false,
  RETURNED: false,
  LOST: false,
};

/** Whether to OFFER "Marcar como entregado" on one parcel. */
export function canMarkDelivered(
  shipment: Pick<AdminOrder["shipments"][number], "status">,
): boolean {
  return DELIVERABLE[shipment.status];
}
