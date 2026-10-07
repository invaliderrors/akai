import type {
  AddressFields,
  AdminOrder,
  AdminOrderShipment,
  Order,
  OrderEvent,
  OrderItem,
  OrderShipment,
  OrderStatus,
  OrderSummary,
  Refund,
  Shipment,
  ShipmentStatus,
} from "@akai/contracts";
import { toMinor } from "@akai/money";
import type {
  OrderStatus as PrismaOrderStatus,
  Prisma,
  ShipmentStatus as PrismaShipmentStatus,
} from "@akai/db";

/**
 * Prisma rows -> wire DTOs.
 *
 * A separate layer rather than returning Prisma models directly, for one
 * security reason and one correctness reason.
 *
 * SECURITY: a Prisma row is whatever the schema happens to contain today.
 * Returning it means every column added to `order` in a future migration is
 * published to customers automatically — an internal fraud score, a cost price,
 * an operator's note. An explicit mapper makes exposure a deliberate edit.
 *
 * CORRECTNESS: `Date` objects and raw integers are not the wire format.
 * Timestamps become ISO-8601 strings and money goes through `toMinor`, which
 * re-asserts that the value really is an integer in range rather than assuming
 * the database only ever contained good data.
 */

/**
 * Compile-time proof that the Prisma enum and the contract union are the same
 * set. If a future migration adds a status to one and not the other, this fails
 * to compile here — which is the cheap place to find out, rather than at
 * runtime in a status mapper somewhere.
 */
type MutuallyAssignable<A extends B, B extends C, C = A> = true;
export type OrderStatusEnumsAgree = MutuallyAssignable<
  PrismaOrderStatus,
  OrderStatus,
  PrismaOrderStatus
>;

/** Same proof for shipment statuses. */
export type ShipmentStatusEnumsAgree = MutuallyAssignable<
  PrismaShipmentStatus,
  ShipmentStatus,
  PrismaShipmentStatus
>;

/** The include shape every order-detail read uses. */
export type OrderWithDetail = Prisma.OrderGetPayload<{
  include: { items: true; events: true; shipments: true };
}>;

type ShipmentRow = OrderWithDetail["shipments"][number];

/** The lighter shape the paginated list reads — no events, quantities only. */
export type OrderForSummary = Prisma.OrderGetPayload<{
  include: { items: { select: { quantity: true } } };
}>;

export type ShipmentWithItems = Prisma.ShipmentGetPayload<{
  include: { items: true };
}>;

/** Who is reading. Drives ONLY the internal-event filter — never the totals. */
export type OrderView = "customer" | "admin";

function toShippingAddress(row: OrderWithDetail): AddressFields {
  return {
    firstName: row.shipFirstName,
    lastName: row.shipLastName,
    company: row.shipCompany,
    line1: row.shipLine1,
    line2: row.shipLine2,
    city: row.shipCity,
    region: row.shipRegion,
    postalCode: row.shipPostalCode,
    countryCode: row.shipCountryCode,
    phone: row.shipPhone,
  };
}

function toBillingAddress(row: OrderWithDetail): AddressFields {
  return {
    firstName: row.billFirstName,
    lastName: row.billLastName,
    company: row.billCompany,
    line1: row.billLine1,
    line2: row.billLine2,
    city: row.billCity,
    region: row.billRegion,
    postalCode: row.billPostalCode,
    countryCode: row.billCountryCode,
    phone: row.billPhone,
  };
}

export function toOrderItemDto(row: OrderWithDetail["items"][number]): OrderItem {
  return {
    id: row.id,
    variantId: row.variantId,
    productName: row.productName,
    variantName: row.variantName,
    sku: row.sku,
    imageUrl: row.imageUrl,
    quantity: row.quantity,
    unitPriceNet: toMinor(row.unitPriceNet),
    unitPriceGross: toMinor(row.unitPriceGross),
    lineDiscount: toMinor(row.lineDiscount),
    taxRateBps: row.taxRateBps,
    taxAmount: toMinor(row.taxAmount),
    lineTotalNet: toMinor(row.lineTotalNet),
    lineTotalGross: toMinor(row.lineTotalGross),
    packProductId: row.packProductId,
    packInstanceId: row.packInstanceId,
  };
}

export function toOrderEventDto(row: OrderWithDetail["events"][number]): OrderEvent {
  return {
    id: row.id,
    type: row.type,
    message: row.message,
    isInternal: row.isInternal,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A parcel as its customer sees it. */
export function toOrderShipmentDto(row: ShipmentRow): OrderShipment {
  return {
    id: row.id,
    carrier: row.carrier,
    trackingNumber: row.trackingNumber,
    trackingUrl: row.trackingUrl,
    status: row.status,
    shippedAt: row.shippedAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
  };
}

/** A parcel as staff see it (`adminOrderShipmentSchema`). */
export function toAdminOrderShipmentDto(row: ShipmentRow): AdminOrderShipment {
  return {
    ...toOrderShipmentDto(row),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Build the customer- or admin-facing order.
 *
 * The `view` parameter exists for exactly one thing: internal timeline entries.
 * An operator note like "customer disputed, flagged for review" lives on the
 * same timeline as "your parcel shipped", and shipping the former to the
 * customer is a real incident. Filtering happens HERE, in the single place
 * every order read passes through, rather than in each caller — a filter that
 * has to be remembered per call site is a filter that will be forgotten.
 */
export function toOrderDto(row: OrderWithDetail, view: OrderView): Order {
  const events = row.events
    .filter((event) => view === "admin" || !event.isInternal)
    .map(toOrderEventDto);

  return {
    id: row.id,
    orderNumber: row.orderNumber,
    customerId: row.customerId,
    email: row.email,
    status: row.status,
    currency: row.currency,
    items: row.items.map(toOrderItemDto),
    subtotal: toMinor(row.subtotal),
    discountTotal: toMinor(row.discountTotal),
    shippingTotal: toMinor(row.shippingTotal),
    taxTotal: toMinor(row.taxTotal),
    grandTotal: toMinor(row.grandTotal),
    refundedTotal: toMinor(row.refundedTotal),
    shippingAddress: toShippingAddress(row),
    billingAddress: toBillingAddress(row),
    invoiceNumber: row.invoiceNumber,
    documentType: row.documentType,
    documentNumber: row.documentNumber,
    shippingMethodName: row.shippingMethodName,
    shipments: row.shipments.map(toOrderShipmentDto),
    events,
    placedAt: row.placedAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

/**
 * The admin order detail (`adminOrderSchema`): the admin view of `toOrderDto`
 * plus the facts only staff act on.
 */
export function toAdminOrderDto(row: OrderWithDetail): AdminOrder {
  return {
    ...toOrderDto(row, "admin"),
    shipments: row.shipments.map(toAdminOrderShipmentDto),
    shippingRateId: row.shippingRateId,
  };
}

export function toOrderSummaryDto(row: OrderForSummary): OrderSummary {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    status: row.status,
    currency: row.currency,
    grandTotal: toMinor(row.grandTotal),
    // Units, not lines: "3 items" is what a customer counts, and a two-line
    // order of three units each reading "2 items" looks like a bug to them.
    itemCount: row.items.reduce((total, item) => total + item.quantity, 0),
    placedAt: row.placedAt.toISOString(),
  };
}

export function toShipmentDto(row: ShipmentWithItems): Shipment {
  return {
    id: row.id,
    orderId: row.orderId,
    status: row.status,
    carrier: row.carrier,
    trackingNumber: row.trackingNumber,
    trackingUrl: row.trackingUrl,
    items: row.items.map((item) => ({
      orderItemId: item.orderItemId,
      quantity: item.quantity,
    })),
    shippedAt: row.shippedAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toRefundDto(row: Prisma.RefundGetPayload<object>): Refund {
  return {
    id: row.id,
    paymentId: row.paymentId,
    orderId: row.orderId,
    status: row.status,
    reason: row.reason,
    amount: toMinor(row.amount),
    currency: row.currency,
    providerRefundId: row.providerRefundId,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}
