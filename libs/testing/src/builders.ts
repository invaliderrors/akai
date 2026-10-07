import { randomUUID } from "node:crypto";

/**
 * Deterministic-by-default test data builders.
 *
 * The rule these encode: a test should state ONLY the fields it is actually
 * about. `buildOrder({ status: "PAID" })` reads as "an order that is paid",
 * and every other field is plausible boilerplate the reader can ignore. Tests
 * that spell out twenty irrelevant fields hide their own point.
 */

export type Overrides<T> = Partial<T>;

function id(): string {
  return randomUUID();
}

/** Fixed clock so snapshots and date assertions are stable across runs. */
export const TEST_NOW = new Date("2026-07-20T10:00:00.000Z");

export function buildAddressFields(overrides: Overrides<Record<string, unknown>> = {}) {
  return {
    firstName: "Valentina",
    lastName: "Restrepo",
    company: null,
    line1: "Calle 10 # 43-21",
    line2: null,
    city: "Medellín",
    region: "Antioquia",
    postalCode: null,
    countryCode: "CO",
    phone: "3001234567",
    ...overrides,
  };
}

export function buildCustomer(overrides: Overrides<Record<string, unknown>> = {}) {
  return {
    id: id(),
    email: `customer-${Math.random().toString(36).slice(2, 10)}@example.com`,
    emailVerifiedAt: TEST_NOW.toISOString(),
    firstName: "Ana",
    lastName: "García",
    phone: null,
    role: "CUSTOMER",
    twoFactorEnabled: false,
    anonymisedAt: null,
    createdAt: TEST_NOW.toISOString(),
    updatedAt: TEST_NOW.toISOString(),
    ...overrides,
  };
}

export function buildPrice(overrides: Overrides<Record<string, unknown>> = {}) {
  // $89.000 COP gross at 19% IVA (in centavos), split so net + tax === gross exactly.
  return {
    currency: "COP",
    net: 7_478_992,
    tax: 1_421_008,
    gross: 8_900_000,
    compareAtGross: null,
    taxRateBps: 1900,
    ...overrides,
  };
}

export function buildOrderItem(overrides: Overrides<Record<string, unknown>> = {}) {
  return {
    id: id(),
    variantId: id(),
    productName: "Hoodie Kumo",
    variantName: "M",
    sku: "HOOD-M-BLK",
    imageUrl: null,
    quantity: 1,
    unitPriceNet: 7_478_992,
    unitPriceGross: 8_900_000,
    lineDiscount: 0,
    taxRateBps: 1900,
    taxAmount: 1_421_008,
    lineTotalNet: 7_478_992,
    lineTotalGross: 8_900_000,
    packProductId: null,
    packInstanceId: null,
    ...overrides,
  };
}

export function buildOrder(overrides: Overrides<Record<string, unknown>> = {}) {
  return {
    id: id(),
    orderNumber: "AK-2026-000123",
    customerId: id(),
    email: "customer@example.com",
    status: "PENDING",
    currency: "COP",
    items: [buildOrderItem()],
    subtotal: 7_478_992,
    discountTotal: 0,
    shippingTotal: 0,
    taxTotal: 1_421_008,
    grandTotal: 8_900_000,
    refundedTotal: 0,
    shippingAddress: buildAddressFields(),
    billingAddress: buildAddressFields(),
    invoiceNumber: null,
    documentType: "CC",
    documentNumber: "1020304050",
    events: [],
    placedAt: TEST_NOW.toISOString(),
    paidAt: null,
    cancelledAt: null,
    updatedAt: TEST_NOW.toISOString(),
    version: 0,
    ...overrides,
  };
}
