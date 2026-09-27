import {
  type AdminOrder,
  type BulkLabelSkipReason,
  type FulfilmentFailureReason,
  type OrderShippingFilter,
  type ShipmentStatus,
  errorCodeSchema,
  fulfilmentFailureReasonSchema,
  orderShippingFilterSchema,
} from "@akai/contracts";

import type { ActionErrorCode } from "./actions";

/**
 * Pure display rules for the label UI — kept out of the components so they
 * are testable without rendering, and out of the route modules so a test does
 * not trip the server-only session code (the `discount-display.ts` split).
 */

/**
 * Parcels whose lines count as shipped: everything but a cancelled label and
 * a refused announcement. Mirrors the API's `SHIPMENT_STATUS_TRAITS` — a
 * TOTAL record, so a status added to the contract is a compile error here.
 */
const CARRIES_GOODS: Readonly<Record<ShipmentStatus, boolean>> = {
  PENDING: true,
  LABEL_CREATED: true,
  IN_TRANSIT: true,
  AWAITING_PICKUP: true,
  EXCEPTION: true,
  DELIVERED: true,
  RETURNED: true,
  LOST: true,
  CANCELLED: false,
  FAILED: false,
};

/**
 * Whether to OFFER "Generar etiqueta" on the order detail. A rendering
 * decision only — the API re-checks the same four rules (`labelSkipReason`)
 * at request time and again when the job runs, and answers the skip reason.
 */
export function canGenerateLabel(
  order: Pick<AdminOrder, "status" | "labelEligible" | "parcelWeightGrams" | "shipments">,
): boolean {
  const shipping = order.shipments.some((shipment) => CARRIES_GOODS[shipment.status]);
  return (
    !shipping &&
    (order.status === "PAID" || order.status === "FULFILLING") &&
    order.labelEligible &&
    order.parcelWeightGrams !== null &&
    order.parcelWeightGrams > 0
  );
}

/** Staff may cancel only a label the carrier has not scanned yet. */
export function canCancelLabel(shipment: AdminOrder["shipments"][number]): boolean {
  return shipment.provider === "SENDCLOUD" && shipment.status === "LABEL_CREATED";
}

export function canRetryLabel(shipment: AdminOrder["shipments"][number]): boolean {
  return shipment.provider === "SENDCLOUD" && shipment.status === "FAILED";
}

/** Message keys (root namespace) for why an order was left out of a bulk generate. */
export const SKIP_REASON_KEY: Readonly<Record<BulkLabelSkipReason, string>> = {
  NOT_PAID: "admin.fulfilment.skip.NOT_PAID",
  ALREADY_LABELLED: "admin.fulfilment.skip.ALREADY_LABELLED",
  RATE_NOT_MAPPED: "admin.fulfilment.skip.RATE_NOT_MAPPED",
  NOT_FOUND: "admin.fulfilment.skip.NOT_FOUND",
  WEIGHT_MISSING: "admin.fulfilment.skip.WEIGHT_MISSING",
};

const FAILURE_REASON_KEY: Readonly<Record<FulfilmentFailureReason, string>> = {
  SERVICE_POINT_REQUIRED: "admin.fulfilment.reason.SERVICE_POINT_REQUIRED",
  SERVICE_POINT_NOT_ALLOWED: "admin.fulfilment.reason.SERVICE_POINT_NOT_ALLOWED",
  SERVICE_POINT_UNAVAILABLE: "admin.fulfilment.reason.SERVICE_POINT_UNAVAILABLE",
  FULFILMENT_NOT_CONFIGURED: "admin.fulfilment.reason.FULFILMENT_NOT_CONFIGURED",
  VENDOR_UNAVAILABLE: "admin.fulfilment.reason.VENDOR_UNAVAILABLE",
  VENDOR_REJECTED: "admin.fulfilment.reason.VENDOR_REJECTED",
  CANCEL_REJECTED: "admin.fulfilment.reason.CANCEL_REJECTED",
  LABEL_NOT_AVAILABLE: "admin.fulfilment.reason.LABEL_NOT_AVAILABLE",
};

/**
 * The sentence for a failed label action: the domain `reason` when the API
 * sent one we know (FULFILMENT_NOT_CONFIGURED, CANCEL_REJECTED, …), else the
 * platform code's generic line. NEVER the server's English `message`.
 */
export function labelFailureKey(code: ActionErrorCode | null, reason: string | null): string {
  const parsed = fulfilmentFailureReasonSchema.safeParse(reason);
  if (parsed.success) {
    return FAILURE_REASON_KEY[parsed.data];
  }
  if (code === null || code === "UNPARSEABLE_RESPONSE") {
    return "errors.generic";
  }
  return `errors.${code}`;
}

export const SHIPPING_FILTERS: readonly OrderShippingFilter[] = orderShippingFilterSchema.options;

/** A URL value narrowed to a filter, or undefined — never forwarded unchecked. */
export function asShippingFilter(value: string | undefined): OrderShippingFilter | undefined {
  const parsed = orderShippingFilterSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The `?labelError=` the label-download route hands back: a fulfilment reason
 * or a platform code — narrowed through both closed enums, so a hand-edited
 * URL can only ever select one of our own sentences.
 */
export function labelErrorKey(value: string | undefined): string | null {
  if (value === undefined || value === "") {
    return null;
  }
  const code = errorCodeSchema.safeParse(value);
  return labelFailureKey(code.success ? code.data : null, value);
}
