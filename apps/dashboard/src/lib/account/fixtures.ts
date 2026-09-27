import {
  addressSchema,
  customerSchema,
  orderSchema,
  orderSummarySchema,
  paymentSchema,
  orderShipmentSchema,
  type Address,
  type Customer,
  type Order,
  type OrderSummary,
  type Payment,
  type OrderShipment,
} from "@akai/contracts";

/**
 * Test fixtures for the account surface.
 *
 * Every builder ends in a `.parse()` against the real contract schema rather
 * than an object literal with a type annotation. That is the point of the file:
 * a fixture that drifts from the contract fails HERE, loudly, instead of
 * producing a green test suite for a shape the API will never send. It also
 * means the branded `Minor` values are minted by the schema, so no test needs a
 * cast to construct money.
 *
 * Not referenced by application code — only by `*.test.tsx`.
 */

const UUID = {
  customer: "11111111-1111-4111-8111-111111111111",
  order: "22222222-2222-4222-8222-222222222222",
  orderItemA: "33333333-3333-4333-8333-333333333333",
  orderItemB: "44444444-4444-4444-8444-444444444444",
  address: "55555555-5555-4555-8555-555555555555",
  shipment: "66666666-6666-4666-8666-666666666666",
  payment: "77777777-7777-4777-8777-777777777777",
  event: "88888888-8888-4888-8888-888888888888",
  variant: "99999999-9999-4999-8999-999999999999",
} as const;

const ADDRESS_FIELDS = {
  firstName: "Elena",
  lastName: "Ruiz",
  company: null,
  line1: "Calle Mayor 12",
  line2: null,
  city: "Madrid",
  region: null,
  postalCode: "28013",
  countryCode: "ES",
  phone: null,
} as const;

export function buildCustomer(overrides: Record<string, unknown> = {}): Customer {
  return customerSchema.parse({
    id: UUID.customer,
    email: "elena@example.com",
    emailVerifiedAt: "2026-01-04T10:00:00.000Z",
    firstName: "Elena",
    lastName: "Ruiz",
    phone: null,
    role: "CUSTOMER",
    preferredLocale: "es",
    twoFactorEnabled: false,
    anonymisedAt: null,
    createdAt: "2026-01-04T10:00:00.000Z",
    updatedAt: "2026-01-04T10:00:00.000Z",
    ...overrides,
  });
}

export function buildAddress(overrides: Record<string, unknown> = {}): Address {
  return addressSchema.parse({
    ...ADDRESS_FIELDS,
    id: UUID.address,
    customerId: UUID.customer,
    type: "SHIPPING",
    isDefault: true,
    createdAt: "2026-01-04T10:00:00.000Z",
    updatedAt: "2026-01-04T10:00:00.000Z",
    ...overrides,
  });
}

export function buildOrderSummary(overrides: Record<string, unknown> = {}): OrderSummary {
  return orderSummarySchema.parse({
    id: UUID.order,
    orderNumber: "AK-2026-000123",
    status: "DELIVERED",
    currency: "EUR",
    grandTotal: 12_098,
    itemCount: 2,
    placedAt: "2026-03-02T09:30:00.000Z",
    ...overrides,
  });
}

/**
 * A two-line order whose totals actually foot: 8999 + 2499 = 11498 subtotal,
 * minus a 400 discount, plus 1000 shipping = 12098 gross.
 *
 * Deliberately arithmetically consistent so the totals test in
 * `order-detail.test.tsx` is asserting rendering, not compensating for a
 * fixture that never balanced.
 */
export function buildOrder(overrides: Record<string, unknown> = {}): Order {
  return orderSchema.parse({
    id: UUID.order,
    orderNumber: "AK-2026-000123",
    customerId: UUID.customer,
    email: "elena@example.com",
    status: "SHIPPED",
    locale: "es",
    currency: "EUR",
    items: [
      {
        id: UUID.orderItemA,
        variantId: UUID.variant,
        productName: "Camiseta Oversize",
        variantName: "M",
        sku: "AK-TEE-BLK-M",
        imageUrl: null,
        quantity: 1,
        unitPriceNet: 7_437,
        unitPriceGross: 8_999,
        lineDiscount: 0,
        taxRateBps: 2_100,
        taxAmount: 1_562,
        lineTotalNet: 7_437,
        lineTotalGross: 8_999,
        packProductId: null,
        packInstanceId: null,
      },
      {
        id: UUID.orderItemB,
        variantId: null,
        productName: "Beta-Alanina",
        variantName: null,
        sku: "AK-BAL-250",
        imageUrl: null,
        quantity: 1,
        unitPriceNet: 2_065,
        unitPriceGross: 2_499,
        lineDiscount: 0,
        taxRateBps: 2_100,
        taxAmount: 434,
        lineTotalNet: 2_065,
        lineTotalGross: 2_499,
        packProductId: null,
        packInstanceId: null,
      },
    ],
    subtotal: 11_498,
    discountTotal: 400,
    shippingTotal: 1_000,
    taxTotal: 1_996,
    grandTotal: 12_098,
    refundedTotal: 0,
    shippingAddress: ADDRESS_FIELDS,
    billingAddress: ADDRESS_FIELDS,
    invoiceNumber: "INV-2026-000045",
    vatNumber: null,
    events: [
      {
        id: UUID.event,
        type: "PAID",
        message: "Pago confirmado",
        isInternal: false,
        createdAt: "2026-03-02T09:35:00.000Z",
      },
    ],
    placedAt: "2026-03-02T09:30:00.000Z",
    paidAt: "2026-03-02T09:35:00.000Z",
    cancelledAt: null,
    updatedAt: "2026-03-03T08:00:00.000Z",
    version: 3,
    ...overrides,
  });
}

/**
 * A parcel as the CUSTOMER order endpoint sends it (`orderShipmentSchema`,
 * nested under the order) — not the full `shipmentSchema`, which carries the
 * order id and line split the customer endpoint does not publish.
 */
export function buildShipment(overrides: Record<string, unknown> = {}): OrderShipment {
  return orderShipmentSchema.parse({
    id: UUID.shipment,
    status: "IN_TRANSIT",
    carrier: "SEUR",
    trackingNumber: "SEUR-9981234",
    trackingUrl: "https://www.seur.com/track/SEUR-9981234",
    shippedAt: "2026-03-03T08:00:00.000Z",
    deliveredAt: null,
    ...overrides,
  });
}

export function buildPayment(overrides: Record<string, unknown> = {}): Payment {
  return paymentSchema.parse({
    id: UUID.payment,
    orderId: UUID.order,
    provider: "WHOP",
    status: "SUCCEEDED",
    amount: 12_098,
    currency: "EUR",
    providerPaymentId: "pi_test_123",
    providerTransactionId: "ch_test_123",
    cardBrand: "visa",
    cardLast4: "4242",
    failureCode: null,
    failureMessage: null,
    capturedAt: "2026-03-02T09:35:00.000Z",
    createdAt: "2026-03-02T09:31:00.000Z",
    ...overrides,
  });
}
