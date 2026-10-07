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
  line1: "Calle 10 # 43-21",
  line2: null,
  city: "Medellín",
  region: "Antioquia",
  postalCode: null,
  countryCode: "CO",
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
    currency: "COP",
    grandTotal: 12_098_000,
    itemCount: 2,
    placedAt: "2026-03-02T09:30:00.000Z",
    ...overrides,
  });
}

/**
 * A two-line order whose totals actually foot, in COP centavos: $ 89.990 +
 * $ 24.990 = $ 114.980 subtotal, minus a $ 4.000 discount, plus $ 10.000
 * shipping = $ 120.980 gross. Lines carry 19% IVA.
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
    currency: "COP",
    items: [
      {
        id: UUID.orderItemA,
        variantId: UUID.variant,
        productName: "Camiseta Oversize",
        variantName: "M",
        sku: "AK-TEE-BLK-M",
        imageUrl: null,
        quantity: 1,
        unitPriceNet: 7_562_185,
        unitPriceGross: 8_999_000,
        lineDiscount: 0,
        taxRateBps: 1_900,
        taxAmount: 1_436_815,
        lineTotalNet: 7_562_185,
        lineTotalGross: 8_999_000,
        packProductId: null,
        packInstanceId: null,
      },
      {
        id: UUID.orderItemB,
        variantId: null,
        productName: "Bolsa Tote de Lona",
        variantName: null,
        sku: "AK-TOTE-NAT",
        imageUrl: null,
        quantity: 1,
        unitPriceNet: 2_100_000,
        unitPriceGross: 2_499_000,
        lineDiscount: 0,
        taxRateBps: 1_900,
        taxAmount: 399_000,
        lineTotalNet: 2_100_000,
        lineTotalGross: 2_499_000,
        packProductId: null,
        packInstanceId: null,
      },
    ],
    subtotal: 11_498_000,
    discountTotal: 400_000,
    shippingTotal: 1_000_000,
    taxTotal: 1_835_815,
    grandTotal: 12_098_000,
    refundedTotal: 0,
    shippingAddress: ADDRESS_FIELDS,
    billingAddress: ADDRESS_FIELDS,
    invoiceNumber: "INV-2026-000045",
    documentType: "CC",
    documentNumber: "1020304050",
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
    carrier: "Servientrega",
    trackingNumber: "SV-9981234",
    trackingUrl: "https://www.servientrega.com/rastreo/SV-9981234",
    shippedAt: "2026-03-03T08:00:00.000Z",
    deliveredAt: null,
    ...overrides,
  });
}

export function buildPayment(overrides: Record<string, unknown> = {}): Payment {
  return paymentSchema.parse({
    id: UUID.payment,
    orderId: UUID.order,
    provider: "WOMPI",
    status: "SUCCEEDED",
    amount: 12_098_000,
    currency: "COP",
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
