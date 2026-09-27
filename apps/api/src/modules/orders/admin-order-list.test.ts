import { describe, expect, it } from "vitest";
import { adminOrderSummarySchema } from "@akai/contracts";

import {
  ACTIVE_SHIPMENT_STATUSES,
  type OrderForAdminSummary,
  shippingFilterWhere,
  toAdminOrderSummaryDto,
} from "./admin-order-list";

function row(overrides: Partial<OrderForAdminSummary> = {}): OrderForAdminSummary {
  const base: OrderForAdminSummary = {
    id: "8d7a4a0e-5d0b-4b4e-9d4f-3a1c1f9b8e01",
    orderNumber: "AK-2026-000123",
    status: "PAID",
    currency: "EUR",
    grandTotal: 4990,
    placedAt: new Date("2026-09-24T10:00:00.000Z"),
    items: [{ quantity: 2 }, { quantity: 1 }],
    shipments: [],
  };
  return { ...base, ...overrides };
}

describe("toAdminOrderSummaryDto", () => {
  it("maps the newest shipment compactly and never leaks the object key", () => {
    const dto = toAdminOrderSummaryDto(
      row({
        status: "FULFILLING",
        shipments: [
          {
            id: "0b9f6a52-6a8e-4d38-9c1e-5b1d7d9e2a10",
            status: "LABEL_CREATED",
            provider: "SENDCLOUD",
            carrier: "inpost_es",
            trackingNumber: "INP123",
            labelObjectKey: "labels/o/1.pdf",
          },
        ],
      }),
    );

    expect(dto.itemCount).toBe(3);
    expect(dto.shipment).toEqual({
      id: "0b9f6a52-6a8e-4d38-9c1e-5b1d7d9e2a10",
      status: "LABEL_CREATED",
      provider: "SENDCLOUD",
      carrier: "inpost_es",
      trackingNumber: "INP123",
      hasLabel: true,
    });
    expect(JSON.stringify(dto)).not.toContain("labels/o/1.pdf");
    // The wire shape is the contract's, strictly.
    expect(adminOrderSummarySchema.parse(dto)).toEqual(dto);
  });

  it("reports no shipment as null", () => {
    expect(toAdminOrderSummaryDto(row()).shipment).toBeNull();
  });
});

describe("shippingFilterWhere", () => {
  it("NO_LABEL = paid (or fulfilling) with no parcel that carries goods", () => {
    expect(shippingFilterWhere("NO_LABEL")).toEqual({
      status: { in: ["PAID", "FULFILLING"] },
      shipments: { none: { status: { in: [...ACTIVE_SHIPMENT_STATUSES] } } },
    });
  });

  it("an active set that excludes exactly the two statuses that moved nothing", () => {
    expect(ACTIVE_SHIPMENT_STATUSES).not.toContain("CANCELLED");
    expect(ACTIVE_SHIPMENT_STATUSES).not.toContain("FAILED");
    expect(ACTIVE_SHIPMENT_STATUSES).toContain("LABEL_CREATED");
    expect(ACTIVE_SHIPMENT_STATUSES).toContain("PENDING");
  });

  it("LABEL_CREATED and IN_TRANSIT look at the parcels", () => {
    expect(shippingFilterWhere("LABEL_CREATED")).toEqual({
      shipments: { some: { status: "LABEL_CREATED" } },
    });
    expect(shippingFilterWhere("IN_TRANSIT")).toEqual({
      shipments: { some: { status: { in: ["IN_TRANSIT", "AWAITING_PICKUP"] } } },
    });
  });

  it("ISSUE = a carrier problem on a live order, or a paid order whose only labels failed", () => {
    expect(shippingFilterWhere("ISSUE")).toEqual({
      OR: [
        {
          status: { in: ["PAID", "FULFILLING", "SHIPPED"] },
          shipments: { some: { status: { in: ["EXCEPTION", "RETURNED", "LOST"] } } },
        },
        {
          status: { in: ["PAID", "FULFILLING"] },
          AND: [
            { shipments: { some: { status: "FAILED" } } },
            { shipments: { none: { status: { in: [...ACTIVE_SHIPMENT_STATUSES] } } } },
          ],
        },
      ],
    });
  });
});
