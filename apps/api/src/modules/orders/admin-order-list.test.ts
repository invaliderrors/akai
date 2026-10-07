import { describe, expect, it } from "vitest";
import { adminOrderSummarySchema } from "@akai/contracts";

import {
  type OrderForAdminSummary,
  shippingFilterWhere,
  toAdminOrderSummaryDto,
} from "./admin-order-list";

function row(overrides: Partial<OrderForAdminSummary> = {}): OrderForAdminSummary {
  const base: OrderForAdminSummary = {
    id: "8d7a4a0e-5d0b-4b4e-9d4f-3a1c1f9b8e01",
    orderNumber: "AK-2026-000123",
    status: "PAID",
    currency: "COP",
    grandTotal: 10_400_000,
    placedAt: new Date("2026-09-24T10:00:00.000Z"),
    items: [{ quantity: 2 }, { quantity: 1 }],
    shipments: [],
  };
  return { ...base, ...overrides };
}

describe("toAdminOrderSummaryDto", () => {
  it("maps the newest shipment compactly", () => {
    const dto = toAdminOrderSummaryDto(
      row({
        status: "SHIPPED",
        shipments: [
          {
            id: "0b9f6a52-6a8e-4d38-9c1e-5b1d7d9e2a10",
            status: "IN_TRANSIT",
            carrier: "Servientrega",
            trackingNumber: "2087654321",
          },
        ],
      }),
    );

    expect(dto.itemCount).toBe(3);
    expect(dto.shipment).toEqual({
      id: "0b9f6a52-6a8e-4d38-9c1e-5b1d7d9e2a10",
      status: "IN_TRANSIT",
      carrier: "Servientrega",
      trackingNumber: "2087654321",
    });
    // The wire shape is the contract's, strictly.
    expect(adminOrderSummarySchema.parse(dto)).toEqual(dto);
  });

  it("reports no shipment as null", () => {
    expect(toAdminOrderSummaryDto(row()).shipment).toBeNull();
  });
});

describe("shippingFilterWhere", () => {
  it("NOT_SHIPPED = paid (or fulfilling) with no parcel recorded", () => {
    expect(shippingFilterWhere("NOT_SHIPPED")).toEqual({
      status: { in: ["PAID", "FULFILLING"] },
      shipments: { none: {} },
    });
  });

  it("IN_TRANSIT looks at the parcels", () => {
    expect(shippingFilterWhere("IN_TRANSIT")).toEqual({
      shipments: { some: { status: "IN_TRANSIT" } },
    });
  });

  it("ISSUE = a returned or lost parcel on an order that is still live", () => {
    expect(shippingFilterWhere("ISSUE")).toEqual({
      status: { in: ["PAID", "FULFILLING", "SHIPPED"] },
      shipments: { some: { status: { in: ["RETURNED", "LOST"] } } },
    });
  });
});
