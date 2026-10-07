import { describe, expect, it } from "vitest";
import { type AdminOrder, type OrderItem, orderItemSchema } from "@akai/contracts";

import {
  SHIPPING_FILTERS,
  asShippingFilter,
  canMarkDelivered,
  canRecordShipment,
  unshippedLines,
} from "./shipment-display";

type OrderSlice = Pick<AdminOrder, "status" | "items" | "shipments">;

function item(id: string, quantity: number): OrderItem {
  return orderItemSchema.parse({
    id,
    variantId: null,
    productName: "Camiseta Oversize",
    variantName: "M / Negro",
    sku: "AK-TEE-BLK-M",
    imageUrl: null,
    quantity,
    unitPriceNet: 7_478_992,
    unitPriceGross: 8_900_000,
    lineDiscount: 0,
    taxRateBps: 1900,
    taxAmount: 1_421_008,
    lineTotalNet: 7_478_992,
    lineTotalGross: 8_900_000,
  });
}

const LINE_A = "11111111-1111-4111-8111-111111111111";
const LINE_B = "22222222-2222-4222-8222-222222222222";

function order(overrides: Partial<OrderSlice> = {}): OrderSlice {
  return {
    status: "PAID",
    items: [item(LINE_A, 2), item(LINE_B, 1)],
    shipments: [],
    ...overrides,
  };
}

const PARCEL: AdminOrder["shipments"][number] = {
  id: "33333333-3333-4333-8333-333333333333",
  carrier: "Servientrega",
  trackingNumber: "2087654321",
  trackingUrl: null,
  status: "IN_TRANSIT",
  shippedAt: "2026-10-01T12:00:00.000Z",
  deliveredAt: null,
  createdAt: "2026-10-01T12:00:00.000Z",
};

describe("shipping filters", () => {
  it("are exactly the contract's three", () => {
    expect(SHIPPING_FILTERS).toEqual(["NOT_SHIPPED", "IN_TRANSIT", "ISSUE"]);
  });

  it("narrow a URL value, dropping anything else (including the Sendcloud-era ones)", () => {
    expect(asShippingFilter("NOT_SHIPPED")).toBe("NOT_SHIPPED");
    expect(asShippingFilter("NO_LABEL")).toBeUndefined();
    expect(asShippingFilter("LABEL_CREATED")).toBeUndefined();
    expect(asShippingFilter(undefined)).toBeUndefined();
  });
});

describe("recording a shipment", () => {
  it("proposes every unit of every line while nothing has shipped", () => {
    expect(unshippedLines(order())).toEqual([
      { orderItemId: LINE_A, quantity: 2 },
      { orderItemId: LINE_B, quantity: 1 },
    ]);
  });

  it("is offered for a paid or fulfilling order with nothing shipped", () => {
    expect(canRecordShipment(order())).toBe(true);
    expect(canRecordShipment(order({ status: "FULFILLING" }))).toBe(true);
  });

  it("is not offered before payment, or once a parcel exists", () => {
    expect(canRecordShipment(order({ status: "AWAITING_PAYMENT" }))).toBe(false);
    expect(canRecordShipment(order({ status: "PAYMENT_MISMATCH" }))).toBe(false);
    expect(canRecordShipment(order({ shipments: [PARCEL] }))).toBe(false);
  });
});

describe("marking delivered", () => {
  it("is offered for a parcel still on its way", () => {
    expect(canMarkDelivered({ status: "IN_TRANSIT" })).toBe(true);
    expect(canMarkDelivered({ status: "PENDING" })).toBe(true);
  });

  it("is not offered for a parcel that is delivered, returned or lost", () => {
    expect(canMarkDelivered({ status: "DELIVERED" })).toBe(false);
    expect(canMarkDelivered({ status: "RETURNED" })).toBe(false);
    expect(canMarkDelivered({ status: "LOST" })).toBe(false);
  });
});
