import type {
  BulkLabelSkipReason,
  OrderStatus,
  ShipmentProvider,
  ShipmentStatus,
} from "@akai/contracts";

import { carriesGoods } from "../../orders/shipment-status";

/**
 * May a label be bought for this order NOW? (spec §3.5 step 1, §3.6 skip rules.)
 *
 * ONE function, used twice on purpose: by the bulk endpoint to split
 * accepted / skipped BEFORE anything is enqueued, and by the label job again
 * at run time — because minutes may pass between the two, and an order
 * cancelled or labelled in between must not buy a label.
 *
 * Order of checks = what staff most need to hear:
 *  1. ALREADY_LABELLED — any parcel still carrying goods (a live label or a
 *     manual shipment). A SHIPPED order with a label reads as "already
 *     labelled", which is true, rather than "not paid", which is not.
 *  2. NOT_PAID — only PAID, or FULFILLING with nothing shipping it (moved
 *     there by hand, or its label cancelled).
 *  3. RATE_NOT_MAPPED — the method snapshotted at checkout has no Sendcloud
 *     option; ship it by hand.
 *  4. WEIGHT_MISSING — no frozen parcel weight; the carrier cannot price it.
 */
export interface LabelEligibilityInput {
  readonly status: OrderStatus;
  readonly sendcloudOptionCode: string | null;
  readonly parcelWeightGrams: number | null;
  readonly shipments: readonly { readonly status: ShipmentStatus }[];
}

export function labelSkipReason(order: LabelEligibilityInput): BulkLabelSkipReason | null {
  if (order.shipments.some((shipment) => carriesGoods(shipment.status))) {
    return "ALREADY_LABELLED";
  }
  if (order.status !== "PAID" && order.status !== "FULFILLING") {
    return "NOT_PAID";
  }
  if (order.sendcloudOptionCode === null || order.sendcloudOptionCode.trim() === "") {
    return "RATE_NOT_MAPPED";
  }
  if (order.parcelWeightGrams === null || order.parcelWeightGrams <= 0) {
    return "WEIGHT_MISSING";
  }
  return null;
}

/**
 * The `external_reference_id` for the NEXT label attempt on an order.
 *
 * `order.id` for the first — so the reference IS the order, as the spec asks —
 * and `order.id:N` after N earlier Sendcloud attempts that ended CANCELLED or
 * FAILED. Sendcloud keeps a reference unique per account FOREVER (a reuse
 * answers 409 with the EXISTING shipment, spike §11a G3), so without the
 * suffix a re-label after a cancel would be handed back the cancelled label,
 * and a retry after a failed announcement could be handed back the failure.
 *
 * DETERMINISTIC FROM THE DATABASE, which is what keeps the crash case
 * idempotent: if the process dies between Sendcloud buying the label and our
 * transaction recording it, no row was written, N is unchanged, the retried
 * job sends the SAME reference, and the 409 hands back the label already
 * bought. A second label is never bought for one attempt.
 */
export function externalReferenceFor(
  orderId: string,
  shipments: readonly { readonly provider: ShipmentProvider; readonly status: ShipmentStatus }[],
): string {
  const spent = shipments.filter(
    (shipment) =>
      shipment.provider === "SENDCLOUD" &&
      (shipment.status === "CANCELLED" || shipment.status === "FAILED"),
  ).length;
  return spent === 0 ? orderId : `${orderId}:${String(spent)}`;
}
