import { z } from "zod";
import {
  orderStatusSchema,
  paymentProviderSchema,
  paymentStatusSchema,
  refundReasonSchema,
  refundStatusSchema,
  shipmentStatusSchema,
} from "./enums";
import {
  colombianMobileSchema,
  documentNumberInputSchema,
  documentNumberSchema,
  identityDocumentTypeSchema,
  normaliseDocumentNumber,
} from "./colombia";
import { emailSchema, idSchema, isoDateTimeSchema } from "./common";
import { currencyCodeSchema, nonNegativeMinorSchema } from "./money";
import { addressFieldsSchema } from "./identity";

/**
 * Cart, checkout, orders, payments, refunds, shipments.
 *
 * Everything here is SERVER-OWNED. The single most important rule in this file
 * is that no request schema accepts an amount — the grand total is always
 * recomputed server-side from live variants, tax rules and shipping (spec §13).
 * A client-supplied total is the number one vulnerability in custom checkouts.
 */

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

export const cartItemSchema = z
  .object({
    id: idSchema,
    variantId: idSchema,
    productId: idSchema,
    productSlug: z.string(),
    /** Snapshotted for display; the checkout RE-PRICES from the live variant. */
    name: z.string(),
    variantName: z.string().nullable(),
    sku: z.string(),
    imageUrl: z.string().url().nullable(),
    quantity: z.number().int().min(1).max(99),
    unitPriceGross: nonNegativeMinorSchema,
    lineTotalGross: nonNegativeMinorSchema,
    /** Set when the live price moved since this line was added. */
    priceChanged: z.boolean(),
    /**
     * Set together, or both null. Every component line of one "add pack to
     * cart" event shares the same `packInstanceId` — the cart UI groups them
     * and offers one "remove pack" action instead of N independent ones.
     * `unitPriceGross`/`lineTotalGross` above already carry this line's share
     * of the pack's flat price; nothing downstream needs to re-derive it.
     *
     * DEFAULTED FOR THE SAME ROLLOUT REASON `listed`/`offerOnNewProducts`
     * ARE ON `productSchema` — this is a response schema, and the storefront
     * and dashboard deploy separately from the API. Without a default, a
     * client that already knows this field cannot parse a cart from an API
     * that predates it, which makes deploy order a trap in BOTH directions
     * (deploy clients first and they fail on the still-running old API;
     * deploy the API first and `.strict()` rejects the new key on the still-
     * running old clients). A default breaks only the first of those.
     */
    packProductId: idSchema.nullable().default(null),
    packInstanceId: idSchema.nullable().default(null),
  })
  .strict();

export type CartItem = z.infer<typeof cartItemSchema>;

/**
 * A line-level problem surfaced by cart validation. The cart page renders these
 * and blocks checkout rather than letting the customer discover the problem
 * after their card is charged.
 */
export const cartProblemSchema = z
  .object({
    itemId: idSchema,
    code: z.enum([
      "OUT_OF_STOCK",
      "INSUFFICIENT_STOCK",
      "PRODUCT_UNAVAILABLE",
      "PRICE_CHANGED",
      "QUANTITY_EXCEEDS_MAX",
      "COUNTRY_RESTRICTED",
    ]),
    message: z.string(),
    /** For INSUFFICIENT_STOCK: how many can actually be supplied. */
    availableQuantity: z.number().int().min(0).optional(),
  })
  .strict();

export type CartProblem = z.infer<typeof cartProblemSchema>;

export const cartTotalsSchema = z
  .object({
    currency: currencyCodeSchema,
    subtotal: nonNegativeMinorSchema,
    discountTotal: nonNegativeMinorSchema,
    shippingTotal: nonNegativeMinorSchema,
    taxTotal: nonNegativeMinorSchema,
    grandTotal: nonNegativeMinorSchema,
  })
  .strict();

export type CartTotals = z.infer<typeof cartTotalsSchema>;

export const cartSchema = z
  .object({
    id: idSchema,
    /** Null for an anonymous cart; set on login via the merge policy. */
    customerId: idSchema.nullable(),
    items: z.array(cartItemSchema),
    itemCount: z.number().int().min(0),
    totals: cartTotalsSchema,
    discountCode: z.string().nullable(),
    problems: z.array(cartProblemSchema),
    expiresAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type Cart = z.infer<typeof cartSchema>;

export const addCartItemSchema = z
  .object({
    variantId: idSchema,
    quantity: z.number().int().min(1).max(99),
  })
  .strict();

export const updateCartItemSchema = z
  .object({
    /** Zero removes the line — one less endpoint than a separate DELETE. */
    quantity: z.number().int().min(0).max(99),
  })
  .strict();

/**
 * "Add pack to cart" — a SEPARATE route from `addCartItemSchema`, not a
 * variant-or-pack union on it, because the two resolve completely
 * differently server-side: this one expands into N real component lines
 * (see `CartService.addPack`), never a line for the pack's own variant.
 */
export const addPackToCartSchema = z
  .object({
    packProductId: idSchema,
    /** How many of the whole pack — scales every component line together. */
    quantity: z.number().int().min(1).max(10),
  })
  .strict();

export type AddPackToCart = z.infer<typeof addPackToCartSchema>;

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/**
 * An order line SNAPSHOT.
 *
 * Every display field is copied at order time. Rendering historical orders must
 * NEVER join to the live product table: a renamed product or a changed price
 * would retroactively rewrite an invoice that has already been filed for tax.
 */
export const orderItemSchema = z
  .object({
    id: idSchema,
    /** Kept for reorder/analytics only — never for display. Nullable: products can be purged. */
    variantId: idSchema.nullable(),
    productName: z.string(),
    variantName: z.string().nullable(),
    sku: z.string(),
    imageUrl: z.string().url().nullable(),
    quantity: z.number().int().min(1),
    unitPriceNet: nonNegativeMinorSchema,
    unitPriceGross: nonNegativeMinorSchema,
    lineDiscount: nonNegativeMinorSchema,
    taxRateBps: z.number().int().min(0).max(10_000),
    taxAmount: nonNegativeMinorSchema,
    lineTotalNet: nonNegativeMinorSchema,
    lineTotalGross: nonNegativeMinorSchema,
    /**
     * Set together, or both null. Carried over verbatim from `CartItem` at
     * order-creation time — every component line of one pack purchase shares
     * the same `packInstanceId`. Purely for display/reporting grouping; no
     * pricing or tax logic reads these.
     *
     * DEFAULTED for the same deploy-order reason `cartItemSchema` gives for
     * its own identical pair of fields, immediately above in this file.
     */
    packProductId: idSchema.nullable().default(null),
    packInstanceId: idSchema.nullable().default(null),
  })
  .strict();

export type OrderItem = z.infer<typeof orderItemSchema>;

/** Append-only timeline entry. `isInternal` entries are admin-only. */
export const orderEventSchema = z
  .object({
    id: idSchema,
    type: z.string().max(64),
    message: z.string().max(1000),
    isInternal: z.boolean(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export type OrderEvent = z.infer<typeof orderEventSchema>;

/**
 * One parcel of an order, as its CUSTOMER sees it: who carries it, how to
 * track it, where it is. Deliberately narrower than `shipmentSchema` (no line
 * split, no order id — it is nested under its order).
 */
export const orderShipmentSchema = z
  .object({
    id: idSchema,
    carrier: z.string().max(64),
    trackingNumber: z.string().max(128).nullable(),
    trackingUrl: z.string().url().nullable(),
    status: shipmentStatusSchema,
    shippedAt: isoDateTimeSchema.nullable(),
    deliveredAt: isoDateTimeSchema.nullable(),
  })
  .strict();

export type OrderShipment = z.infer<typeof orderShipmentSchema>;

export const orderSchema = z
  .object({
    id: idSchema,
    /** Human-readable, e.g. AK-2026-000123. Customers and support cannot use UUIDs. */
    orderNumber: z.string().regex(/^AK-\d{4}-\d{6}$/),
    customerId: idSchema.nullable(),
    /** Always present, including for guest orders — it is the claim key. */
    email: emailSchema,
    status: orderStatusSchema,
    currency: currencyCodeSchema,

    items: z.array(orderItemSchema).min(1),

    // Totals are separate integer columns, not derived at read time.
    // An invariant test asserts lines + adjustments === grandTotal.
    subtotal: nonNegativeMinorSchema,
    discountTotal: nonNegativeMinorSchema,
    shippingTotal: nonNegativeMinorSchema,
    taxTotal: nonNegativeMinorSchema,
    grandTotal: nonNegativeMinorSchema,
    refundedTotal: nonNegativeMinorSchema,

    /** Snapshotted, NOT foreign keys to the address book. See addressFieldsSchema. */
    shippingAddress: addressFieldsSchema,
    billingAddress: addressFieldsSchema,

    /** Allocated from a gap-free sequence at PAID only. */
    invoiceNumber: z.string().nullable(),

    /**
     * The buyer's identity document, snapshotted at checkout (normalised —
     * see `normaliseDocumentNumber`). Shown to the customer and to staff, and
     * what a PSE payment's `customer_data` is built from.
     */
    documentType: identityDocumentTypeSchema,
    documentNumber: documentNumberSchema,

    /** The chosen method's name, stamped at checkout. */
    shippingMethodName: z.string().max(120).nullable().default(null),
    /** Oldest first. Empty until staff record a shipment. */
    shipments: z.array(orderShipmentSchema).default([]),

    events: z.array(orderEventSchema),
    placedAt: isoDateTimeSchema,
    paidAt: isoDateTimeSchema.nullable(),
    cancelledAt: isoDateTimeSchema.nullable(),
    updatedAt: isoDateTimeSchema,
    version: z.number().int().min(0),
  })
  .strict();

export type Order = z.infer<typeof orderSchema>;

/** A parcel as STAFF see it: the customer shape plus when it was recorded. */
export const adminOrderShipmentSchema = orderShipmentSchema
  .extend({
    createdAt: isoDateTimeSchema,
  })
  .strict();

export type AdminOrderShipment = z.infer<typeof adminOrderShipmentSchema>;

/** The admin order detail: `orderSchema` plus the facts only staff need. */
export const adminOrderSchema = orderSchema
  .extend({
    shipments: z.array(adminOrderShipmentSchema),
    /** The rate chosen at checkout; null for a since-deleted rate. */
    shippingRateId: idSchema.nullable(),
  })
  .strict();

export type AdminOrder = z.infer<typeof adminOrderSchema>;

/** Compact row for the dashboard's paginated order list. */
export const orderSummarySchema = z
  .object({
    id: idSchema,
    orderNumber: z.string(),
    status: orderStatusSchema,
    currency: currencyCodeSchema,
    grandTotal: nonNegativeMinorSchema,
    itemCount: z.number().int().min(1),
    placedAt: isoDateTimeSchema,
  })
  .strict();

export type OrderSummary = z.infer<typeof orderSummarySchema>;

/**
 * `GET /v1/admin/orders?shipping=` — the questions staff ask of the list:
 *  - NOT_SHIPPED — paid, and no parcel recorded yet: "what still has to go out?"
 *  - IN_TRANSIT  — a parcel is on its way.
 *  - ISSUE       — a parcel came back (RETURNED) or went missing (LOST) on an
 *                  order that is still ours to fix.
 */
export const orderShippingFilterSchema = z.enum(["NOT_SHIPPED", "IN_TRANSIT", "ISSUE"]);
export type OrderShippingFilter = z.infer<typeof orderShippingFilterSchema>;

/** The newest parcel of an order, compact enough for a table cell. */
export const adminOrderShipmentSummarySchema = z
  .object({
    id: idSchema,
    status: shipmentStatusSchema,
    carrier: z.string().max(64),
    trackingNumber: z.string().max(128).nullable(),
  })
  .strict();

export type AdminOrderShipmentSummary = z.infer<typeof adminOrderShipmentSummarySchema>;

/** One row of the ADMIN order list: the customer summary plus the newest shipment. */
export const adminOrderSummarySchema = orderSummarySchema
  .extend({
    shipment: adminOrderShipmentSummarySchema.nullable(),
  })
  .strict();

export type AdminOrderSummary = z.infer<typeof adminOrderSummarySchema>;

/**
 * The polled status endpoint backing the post-checkout "processing" screen.
 * An order becomes PAID only via webhook (spec §9), so the browser returning
 * from the hosted payment page polls this instead of asserting success — a client-side success
 * redirect is forged in ten seconds.
 */
export const orderStatusResponseSchema = z
  .object({
    orderNumber: z.string(),
    status: orderStatusSchema,
    isPaid: z.boolean(),
    isTerminal: z.boolean(),
  })
  .strict();

export type OrderStatusResponse = z.infer<typeof orderStatusResponseSchema>;

/**
 * A Wompi transaction id, as Wompi appends it to the return URL (`?id=…`).
 *
 * Documented ids look like `1234-1610641025-49201`; the shape is kept to
 * alphanumerics and hyphens rather than that exact pattern so an id format
 * change degrades to "the webhook settles it" instead of a rejected return.
 * It is only ever used as a path segment of OUR private-key lookup, encoded.
 */
export const wompiTransactionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/, "Expected a Wompi transaction id");

/**
 * The return page hands back the transaction id Wompi put on the redirect.
 *
 * THE ID IS THE ONLY THING TRUSTED FROM THE BROWSER, and only as a pointer: the
 * API fetches that transaction from Wompi with the PRIVATE key and settles from
 * Wompi's answer, after checking its reference belongs to this order.
 */
export const confirmPaymentRequestSchema = z
  .object({
    transactionId: wompiTransactionIdSchema,
  })
  .strict();

export type ConfirmPaymentRequest = z.infer<typeof confirmPaymentRequestSchema>;

// ---------------------------------------------------------------------------
// Checkout — note the absence of any amount field.
// ---------------------------------------------------------------------------

/**
 * The SHIPPING address at checkout — stricter than the address book, and only
 * here: `phone` is REQUIRED (the carrier calls it, and a PSE payment asks for
 * it). It is a Colombian mobile, normalised to 10 digits without +57.
 *
 * Composed rather than changing `addressFieldsSchema`, which the address book
 * and the order snapshot share: tightening that would reject saved addresses
 * that legitimately have no phone.
 */
export const checkoutShippingAddressSchema = addressFieldsSchema
  .extend({
    phone: colombianMobileSchema,
  })
  .strict();

export type CheckoutShippingAddress = z.infer<typeof checkoutShippingAddressSchema>;

/**
 * The checkout request's fields, before the document number is normalised
 * against its type. Exported for introspection (`.shape`); validate requests
 * with `createCheckoutSessionSchema`.
 */
export const createCheckoutSessionObjectSchema = z
  .object({
    cartId: idSchema,
    email: emailSchema,
    shippingAddress: checkoutShippingAddressSchema,
    billingAddress: addressFieldsSchema.nullable().default(null),
    shippingMethodId: idSchema,
    /**
     * The buyer's identity document (Colombia): its type and number. REQUIRED
     * — it is snapshotted on the order, printed for staff, and a PSE payment's
     * `customer_data` needs both.
     */
    documentType: identityDocumentTypeSchema,
    documentNumber: documentNumberInputSchema,
    acceptedTermsVersion: z.string().max(32),
  })
  .strict();

/**
 * The checkout request. `documentNumber` comes out NORMALISED for its type
 * (`normaliseDocumentNumber`: "1.020.304.050" → "1020304050",
 * "900.123.456-7" → "900123456-7"); a number that is not valid for the type is
 * a validation error on `documentNumber`.
 */
export const createCheckoutSessionSchema = createCheckoutSessionObjectSchema.transform(
  (request, ctx) => {
    const documentNumber = normaliseDocumentNumber(request.documentType, request.documentNumber);
    if (documentNumber === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["documentNumber"],
        message: `documentNumber is not a valid ${request.documentType} number`,
      });
      return z.NEVER;
    }
    return { ...request, documentNumber };
  },
);

export type CreateCheckoutSession = z.infer<typeof createCheckoutSessionSchema>;

export const checkoutSessionResponseSchema = z
  .object({
    orderNumber: z.string(),
    /** Gateway-hosted checkout URL. The browser is redirected here. */
    checkoutUrl: z.string().url(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Payments, refunds, shipments
// ---------------------------------------------------------------------------

/** Payment is a SEPARATE entity from Order: one order can have several attempts. */
export const paymentSchema = z
  .object({
    id: idSchema,
    orderId: idSchema,
    provider: paymentProviderSchema,
    status: paymentStatusSchema,
    amount: nonNegativeMinorSchema,
    currency: currencyCodeSchema,
    providerPaymentId: z.string().nullable(),
    providerTransactionId: z.string().nullable(),
    /** Display-only card metadata. Never a PAN, never a token we could replay. */
    cardBrand: z.string().max(32).nullable(),
    cardLast4: z.string().length(4).nullable(),
    failureCode: z.string().max(64).nullable(),
    failureMessage: z.string().max(500).nullable(),
    capturedAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export type Payment = z.infer<typeof paymentSchema>;

export const refundSchema = z
  .object({
    id: idSchema,
    paymentId: idSchema,
    orderId: idSchema,
    status: refundStatusSchema,
    reason: refundReasonSchema,
    amount: nonNegativeMinorSchema,
    currency: currencyCodeSchema,
    providerRefundId: z.string().nullable(),
    note: z.string().max(1000).nullable(),
    createdAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema.nullable(),
  })
  .strict();

export type Refund = z.infer<typeof refundSchema>;

export const createRefundSchema = z
  .object({
    orderId: idSchema,
    /** Omit for a full refund of the remaining refundable balance. */
    amount: nonNegativeMinorSchema.optional(),
    reason: refundReasonSchema,
    note: z.string().max(1000).optional(),
    /**
     * The refund's id/reference in the Wompi dashboard, when the operator has
     * one. Refunds are issued THERE (Wompi has no refund API for Web Checkout
     * payments); this endpoint records what was done.
     */
    providerRefundId: z.string().trim().min(1).max(128).optional(),
    /** Per-line restock decision; writes a RETURN movement to the inventory ledger. */
    restockVariantIds: z.array(idSchema).default([]),
  })
  .strict();

export type CreateRefund = z.infer<typeof createRefundSchema>;

/**
 * A shipment covers a SUBSET of an order's lines. Partial shipment is normal,
 * which is why tracking lives here and not as a column on Order.
 */
export const shipmentSchema = z
  .object({
    id: idSchema,
    orderId: idSchema,
    status: shipmentStatusSchema,
    carrier: z.string().max(64),
    trackingNumber: z.string().max(128).nullable(),
    trackingUrl: z.string().url().nullable(),
    /** Order ITEM ids, with the quantity shipped in this parcel. */
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
    shippedAt: isoDateTimeSchema.nullable(),
    deliveredAt: isoDateTimeSchema.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export type Shipment = z.infer<typeof shipmentSchema>;

export const createShipmentSchema = shipmentSchema
  .pick({ carrier: true, trackingNumber: true, items: true })
  .strict();

export type CreateShipment = z.infer<typeof createShipmentSchema>;
