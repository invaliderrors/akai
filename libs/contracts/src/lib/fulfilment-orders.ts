import { z } from "zod";
import { idSchema } from "./common";
import { orderSummarySchema } from "./commerce";
import { orderStatusSchema, shipmentProviderSchema, shipmentStatusSchema } from "./enums";

/**
 * The admin ORDER LIST's view of fulfilment — Sendcloud spec
 * `docs/superpowers/specs/2026-09-24-sendcloud-shipping.md` §3.6, §7.
 *
 * A separate file from `fulfilment.ts` (labels + zones/rates admin) because
 * this one EXTENDS `commerce.ts`'s order summary, and keeping that import out
 * of `fulfilment.ts` keeps the rates admin free of the order graph.
 */

/**
 * `GET /v1/admin/orders?shipping=` — the four questions staff ask of the list:
 *  - NO_LABEL      — paid, nothing active shipping it: "what still needs a label?"
 *  - LABEL_CREATED — a label exists, the carrier has not scanned it yet.
 *  - IN_TRANSIT    — moving (including waiting at the pickup point).
 *  - ISSUE         — a parcel in EXCEPTION / RETURNED / LOST, or a paid order
 *                    whose only label attempts FAILED: a human must act.
 */
export const orderShippingFilterSchema = z.enum([
  "NO_LABEL",
  "LABEL_CREATED",
  "IN_TRANSIT",
  "ISSUE",
]);
export type OrderShippingFilter = z.infer<typeof orderShippingFilterSchema>;

/**
 * The newest parcel of an order, compact enough for a table cell. No vendor
 * detail (`failureReason`) — that stays on the detail screen.
 */
export const adminOrderShipmentSummarySchema = z
  .object({
    id: idSchema,
    status: shipmentStatusSchema,
    provider: shipmentProviderSchema,
    carrier: z.string().max(64),
    trackingNumber: z.string().max(128).nullable(),
    hasLabel: z.boolean(),
  })
  .strict();

export type AdminOrderShipmentSummary = z.infer<typeof adminOrderShipmentSummarySchema>;

/**
 * One row of the ADMIN order list: the customer summary plus the newest
 * shipment. Defaulted, for the same clients-first rollout as `adminOrderSchema`
 * — a dashboard deployed first still parses an API that does not send it.
 */
export const adminOrderSummarySchema = orderSummarySchema
  .extend({
    shipment: adminOrderShipmentSummarySchema.nullable().default(null),
  })
  .strict();

export type AdminOrderSummary = z.infer<typeof adminOrderSummarySchema>;

/**
 * `POST /v1/admin/fulfilment/labels/print` answers `application/pdf`, so the
 * orders it had to leave out cannot ride in a JSON body. They ride in this
 * header instead: the request's `orderIds` that have no stored label, comma
 * separated, in request order (empty when every order printed). A request in
 * which NO order has a label is a 409 with reason LABEL_NOT_AVAILABLE instead.
 */
export const PRINT_LABELS_SKIPPED_HEADER = "x-labels-skipped";
/** How many labels the merged PDF holds. */
export const PRINT_LABELS_COUNT_HEADER = "x-labels-count";

/**
 * `POST /v1/admin/fulfilment/shipments/:id/cancel` — what the cancel changed.
 * `orderStatus` is PAID when the label was the only thing shipping the order
 * (it is ready for a new label), FULFILLING when something else still is.
 */
export const cancelLabelResultSchema = z
  .object({
    shipmentId: idSchema,
    status: shipmentStatusSchema,
    orderStatus: orderStatusSchema,
  })
  .strict();

export type CancelLabelResult = z.infer<typeof cancelLabelResultSchema>;
