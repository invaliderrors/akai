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
    firstName: "Ana",
    lastName: "García",
    company: null,
    line1: "Calle Mayor 1",
    line2: null,
    city: "Madrid",
    region: null,
    postalCode: "28013",
    countryCode: "ES",
    phone: null,
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
    preferredLocale: "es",
    twoFactorEnabled: false,
    anonymisedAt: null,
    createdAt: TEST_NOW.toISOString(),
    updatedAt: TEST_NOW.toISOString(),
    ...overrides,
  };
}

export function buildPrice(overrides: Overrides<Record<string, unknown>> = {}) {
  // 49.99 EUR gross at 21% VAT, split so net + tax === gross exactly.
  return {
    currency: "EUR",
    net: 4131,
    tax: 868,
    gross: 4999,
    compareAtGross: null,
    taxRateBps: 2100,
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
    unitPriceNet: 4131,
    unitPriceGross: 4999,
    lineDiscount: 0,
    taxRateBps: 2100,
    taxAmount: 868,
    lineTotalNet: 4131,
    lineTotalGross: 4999,
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
    locale: "es",
    currency: "EUR",
    items: [buildOrderItem()],
    subtotal: 4131,
    discountTotal: 0,
    shippingTotal: 0,
    taxTotal: 868,
    grandTotal: 4999,
    refundedTotal: 0,
    shippingAddress: buildAddressFields(),
    billingAddress: buildAddressFields(),
    invoiceNumber: null,
    vatNumber: null,
    events: [],
    placedAt: TEST_NOW.toISOString(),
    paidAt: null,
    cancelledAt: null,
    updatedAt: TEST_NOW.toISOString(),
    version: 0,
    ...overrides,
  };
}
