import { z } from "zod";
import {
  orderStatusSchema,
  paymentProviderSchema,
  paymentStatusSchema,
  refundReasonSchema,
  refundStatusSchema,
  shipmentProviderSchema,
  shipmentStatusSchema,
} from "./enums";
import { emailSchema, idSchema, isoDateTimeSchema, localeSchema } from "./common";
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
    /** The lot actually shipped, for traceability. */
    batchLotCode: z.string().nullable(),
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
 * split, no order id — it is nested under its order) and than
 * `adminOrderShipmentSchema` (no vendor failure detail, no label).
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

/**
 * The pickup point snapshotted at checkout. `address` is one pre-formatted
 * line ("Calle Mayor 1, 50002 Zaragoza, ES") — the snapshot survives the point
 * disappearing from Sendcloud, so it is display text, not a live lookup.
 */
export const orderServicePointSchema = z
  .object({
    name: z.string().max(120),
    address: z.string().max(255),
  })
  .strict();

export type OrderServicePoint = z.infer<typeof orderServicePointSchema>;

export const orderSchema = z
  .object({
    id: idSchema,
    /** Human-readable, e.g. AK-2026-000123. Customers and support cannot use UUIDs. */
    orderNumber: z.string().regex(/^AK-\d{4}-\d{6}$/),
    customerId: idSchema.nullable(),
    /** Always present, including for guest orders — it is the claim key. */
    email: emailSchema,
    status: orderStatusSchema,
    locale: localeSchema,
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
    /** Validated VAT number for B2B reverse charge. */
    vatNumber: z.string().max(20).nullable(),

    /**
     * FULFILMENT (Sendcloud spec §5). All four DEFAULTED: this schema is
     * `.strict()`, the clients deploy first, and a new client must still parse
     * an API that does not send them yet — as "no method name, no point, no
     * house number, no parcels", which is exactly what the old API meant.
     */
    /** The chosen method's name, stamped at checkout in the order's locale. */
    shippingMethodName: z.string().max(120).nullable().default(null),
    /** The shipping address's separate house number (checkout collects it). */
    shippingHouseNumber: z.string().max(16).nullable().default(null),
    /** Null for a home-delivery order, and for every order before pickup points. */
    servicePoint: orderServicePointSchema.nullable().default(null),
    /** Oldest first. Empty until staff create a label or a manual shipment. */
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

/**
 * A parcel as STAFF see it: the customer shape plus what the dashboard's
 * shipment card acts on. `failureReason` is Sendcloud's own detail for a FAILED
 * announcement or refused cancel — for staff eyes only, which is why it is not
 * on `orderShipmentSchema`. `hasLabel` rather than the object key: the key is
 * a storage detail, the download goes through its own admin endpoint.
 *
 * Defaulted fields for the same clients-first rollout as `orderSchema`.
 */
export const adminOrderShipmentSchema = orderShipmentSchema
  .extend({
    provider: shipmentProviderSchema.default("MANUAL"),
    hasLabel: z.boolean().default(false),
    /** Sendcloud's own last status code, verbatim (e.g. AWAITING_CUSTOMER_PICKUP). */
    providerStatusCode: z.string().max(64).nullable().default(null),
    failureReason: z.string().max(2000).nullable().default(null),
    createdAt: isoDateTimeSchema.nullable().default(null),
  })
  .strict();

export type AdminOrderShipment = z.infer<typeof adminOrderShipmentSchema>;

/**
 * The pickup point as STAFF see it: the customer's name + address plus the
 * identifiers a carrier desk asks for.
 */
export const adminOrderServicePointSchema = orderServicePointSchema
  .extend({
    /** Sendcloud's point id (string). */
    id: z.string().max(32),
    /** The carrier's own id for the point (e.g. `ES21366`). */
    carrierServicePointId: z.string().max(64).nullable(),
    postNumber: z.string().max(32).nullable(),
  })
  .strict();

export type AdminOrderServicePoint = z.infer<typeof adminOrderServicePointSchema>;

/**
 * The admin order detail. `orderSchema` plus the fulfilment facts only staff
 * need. Everything added is DEFAULTED, for the clients-first rollout.
 */
export const adminOrderSchema = orderSchema
  .extend({
    servicePoint: adminOrderServicePointSchema.nullable().default(null),
    shipments: z.array(adminOrderShipmentSchema).default([]),
    /** The rate chosen at checkout; null for older orders or a since-deleted rate. */
    shippingRateId: idSchema.nullable().default(null),
    /** Frozen at checkout — the label weight. Null for older orders. */
    parcelWeightGrams: z.number().int().min(0).nullable().default(null),
    /** True when the order's method is mapped to a Sendcloud option (labels possible). */
    labelEligible: z.boolean().default(false),
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

// ---------------------------------------------------------------------------
// Checkout — note the absence of any amount field.
// ---------------------------------------------------------------------------

/**
 * A phone number a carrier can use, validated LOOSELY on purpose: 7–20
 * characters of digits, spaces and a leading `+`, with at least 7 digits. Real
 * numbers come in too many national formats for anything stricter to be right,
 * and the only job here is to refuse an empty or obviously non-phone value.
 */
const checkoutPhoneSchema = z
  .string()
  .trim()
  .min(7)
  .max(20)
  .regex(/^\+?[0-9 ]+$/, "Phone may contain only digits, spaces and a leading +")
  .refine((value) => value.replace(/[^0-9]/g, "").length >= 7, {
    message: "Phone must contain at least 7 digits",
  });

/**
 * The SHIPPING address at checkout — stricter than the address book, and only
 * here (Sendcloud spec §3.4, decision D5):
 *  - `phone` is REQUIRED: several ES carriers refuse a label without it, and
 *    every pickup notification is sent to it.
 *  - `houseNumber` is a separate REQUIRED field: InPost ES and Mondial Relay take
 *    it apart from the street, and parsing it out of `line1` is fragile.
 *
 * Composed rather than changing `addressFieldsSchema`, which the address book
 * and the order snapshot share: tightening that would reject saved addresses
 * and historical orders that legitimately have no phone.
 */
export const checkoutShippingAddressSchema = addressFieldsSchema
  .extend({
    houseNumber: z.string().trim().min(1).max(16),
    phone: checkoutPhoneSchema,
  })
  .strict();

export type CheckoutShippingAddress = z.infer<typeof checkoutShippingAddressSchema>;

export const createCheckoutSessionSchema = z
  .object({
    cartId: idSchema,
    email: emailSchema,
    shippingAddress: checkoutShippingAddressSchema,
    billingAddress: addressFieldsSchema.nullable().default(null),
    shippingMethodId: idSchema,
    /**
     * The pickup point chosen for a SERVICE_POINT rate — the `id` from
     * `servicePointSchema`, sent back verbatim. REQUIRED (non-null) for a
     * SERVICE_POINT rate and REFUSED for a HOME rate; that depends on the rate,
     * so the server enforces it (reasons SERVICE_POINT_REQUIRED /
     * SERVICE_POINT_NOT_ALLOWED) and re-verifies the point with Sendcloud.
     */
    servicePointId: z.string().trim().min(1).max(32).nullable().default(null),
    vatNumber: z.string().max(20).nullable().default(null),
    locale: localeSchema.default("es"),
    acceptedTermsVersion: z.string().max(32),
  })
  .strict();

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
