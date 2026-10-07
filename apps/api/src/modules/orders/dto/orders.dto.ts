import {
  idSchema,
  orderShippingFilterSchema,
  orderStatusSchema,
  paginationQuerySchema,
  refundReasonSchema,
} from "@akai/contracts";
import { z } from "zod";

/**
 * Request DTOs for the orders module.
 *
 * zod, not class-validator (spec §7): the idiomatic class-validator DTO needs a
 * definite-assignment `!` on every field, which is indistinguishable from the
 * banned non-null assertion and would make the CI gate unenforceable. A zod
 * schema yields the validator, the static type and the OpenAPI fragment from one
 * declaration, so they cannot drift.
 *
 * Every schema here is `.strict()`. That is the `forbidNonWhitelisted`
 * behaviour the spec requires, and it matters most on exactly these routes: an
 * unknown key that is merely stripped can still be re-added by a future
 * `data: { ...body }` spread, whereas a rejected request can never reach one.
 *
 * NOTE what is absent: there is no endpoint here that accepts a money amount
 * for an order. Order creation is a server-internal call from CheckoutModule
 * (`OrdersService.createFromCart`), priced from live variant rows. The only
 * client-supplied amount in the whole module is a refund amount, which is
 * bounded above by what the customer actually paid.
 */

/** A UUID path parameter. Rejects the malformed id before it reaches a query. */
export const idParamSchema = idSchema;

/** The human-readable order number is the customer-facing key, not the UUID. */
export const orderNumberParamSchema = z
  .string()
  .regex(/^AK-\d{4}-\d{6}$/, "Order number must look like AK-2026-000123");

/** Customer order history. Cursor-based; see paginationQuerySchema for why. */
export const customerOrderListQuerySchema = paginationQuerySchema;
export type CustomerOrderListQuery = z.infer<typeof customerOrderListQuerySchema>;

/**
 * Admin order list filters.
 *
 * `email` is a filter, not a lookup key: staff search by customer email far
 * more often than by order number, and forcing them through a UUID is what
 * drives people to query the database directly.
 */
export const adminOrderListQuerySchema = paginationQuerySchema
  .extend({
    status: orderStatusSchema.optional(),
    email: z.string().email().max(254).toLowerCase().optional(),
    orderNumber: z.string().max(20).optional(),
    /** Fulfilment state: NOT_SHIPPED / IN_TRANSIT / ISSUE. */
    shipping: orderShippingFilterSchema.optional(),
  })
  .strict();

export type AdminOrderListQuery = z.infer<typeof adminOrderListQuerySchema>;

/**
 * An operator-driven status change.
 *
 * The set of statuses this will actually accept is narrower than the enum and is
 * enforced in the state machine (`assertAdminMayAssign`), not here — a validation
 * schema is the wrong place for a rule that needs to explain itself, and the
 * 403 body names the system that owns the rejected status.
 */
export const adminTransitionOrderSchema = z
  .object({
    status: orderStatusSchema,
    /** Recorded on the order timeline as an internal note. */
    note: z.string().max(1000).optional(),
  })
  .strict();

export type AdminTransitionOrder = z.infer<typeof adminTransitionOrderSchema>;

/**
 * A parcel covering a subset of the order's lines.
 *
 * Shaped like the contracts' `createShipmentSchema` but declared locally with
 * `min(1)` on items, because a shipment with no lines is a tracking number
 * attached to nothing — it would mark inventory as gone with no record of what
 * left the building.
 */
export const createShipmentRequestSchema = z
  .object({
    carrier: z.string().min(1).max(64),
    trackingNumber: z.string().max(128).nullable().default(null),
    items: z
      .array(
        z
          .object({
            orderItemId: idSchema,
            quantity: z.number().int().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type CreateShipmentRequest = z.infer<typeof createShipmentRequestSchema>;

/**
 * A refund REQUEST. Note what this does and does not do.
 *
 * It records an intent to refund and reserves the amount against the order's
 * refundable balance. It does NOT move money and does NOT change the order
 * status — that happens in `settleRefund`, driven by a provider webhook, because
 * an order marked REFUNDED before the money left our account is a lie that a
 * customer will act on.
 *
 * `amount` omitted means "the full remaining refundable balance", resolved
 * server-side. That is the common case and the one an operator is most likely to
 * mistype.
 */
export const createRefundRequestSchema = z
  .object({
    amount: z.number().int().min(1).optional(),
    reason: refundReasonSchema,
    note: z.string().max(1000).optional(),
    /** Writes a RETURN movement to the inventory ledger when the refund settles. */
    restockVariantIds: z.array(idSchema).default([]),
  })
  .strict();

export type CreateRefundRequest = z.infer<typeof createRefundRequestSchema>;
