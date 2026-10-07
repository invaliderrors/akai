import { adminOrderSchema, orderSchema, orderSummarySchema } from "@akai/contracts";
import { describe, expect, it } from "vitest";

import {
  type OrderForSummary,
  type OrderWithDetail,
  toAdminOrderDto,
  toOrderDto,
  toOrderSummaryDto,
} from "./orders.mapper";

const PLACED = new Date("2026-07-01T10:00:00.000Z");

function itemRow(
  overrides: Partial<OrderWithDetail["items"][number]> = {},
): OrderWithDetail["items"][number] {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    orderId: "bbbbbbbb-0000-4000-8000-000000000001",
    variantId: "cccccccc-0000-4000-8000-000000000001",
    productName: "Oversized Tee",
    variantName: "L",
    sku: "AK-TEE-BLK-L",
    imageUrl: null,
    quantity: 2,
    unitPriceNet: 4131,
    unitPriceGross: 4999,
    lineDiscount: 0,
    taxRateBps: 2100,
    taxAmount: 1735,
    lineTotalNet: 8263,
    lineTotalGross: 9998,
    packProductId: null,
    packInstanceId: null,
    ...overrides,
  };
}

function eventRow(
  overrides: Partial<OrderWithDetail["events"][number]> = {},
): OrderWithDetail["events"][number] {
  return {
    id: "dddddddd-0000-4000-8000-000000000001",
    orderId: "bbbbbbbb-0000-4000-8000-000000000001",
    type: "ORDER_PLACED",
    message: "Order AK-2026-000123 placed.",
    isInternal: false,
    actorId: null,
    createdAt: PLACED,
    ...overrides,
  };
}

function orderRow(overrides: Partial<OrderWithDetail> = {}): OrderWithDetail {
  return {
    id: "bbbbbbbb-0000-4000-8000-000000000001",
    orderNumber: "AK-2026-000123",
    customerId: "eeeeeeee-0000-4000-8000-000000000001",
    email: "cliente@example.com",
    status: "PAID",
    currency: "COP",
    subtotal: 8263,
    discountTotal: 0,
    shippingTotal: 0,
    taxTotal: 1735,
    grandTotal: 9998,
    refundedTotal: 0,
    shipFirstName: "Valentina",
    shipLastName: "Restrepo",
    shipCompany: null,
    shipLine1: "Calle 10 # 43-21",
    shipLine2: "Apto 502",
    shipCity: "Medellín",
    shipRegion: "Antioquia",
    shipPostalCode: null,
    shipCountryCode: "CO",
    shipPhone: "3001234567",
    billFirstName: "Valentina",
    billLastName: "Restrepo",
    billCompany: null,
    billLine1: "Calle 10 # 43-21",
    billLine2: "Apto 502",
    billCity: "Medellín",
    billRegion: "Antioquia",
    billPostalCode: null,
    billCountryCode: "CO",
    billPhone: null,
    invoiceNumber: "INV-2026-000045",
    documentType: "CC",
    documentNumber: "1020304050",
    shippingMethodName: "Envío nacional",
    acceptedTermsVersion: "2026-01",
    shippingRateId: null,
    placedAt: PLACED,
    paidAt: new Date("2026-07-01T10:05:00.000Z"),
    cancelledAt: null,
    updatedAt: new Date("2026-07-01T10:05:00.000Z"),
    version: 2,
    items: [itemRow()],
    events: [eventRow()],
    shipments: [],
    ...overrides,
  };
}

describe("toOrderDto", () => {
  it("produces a payload the contract schema accepts", () => {
    const parsed = orderSchema.safeParse(toOrderDto(orderRow(), "customer"));
    expect(parsed.success).toBe(true);
  });

  it("serialises timestamps as ISO strings, never as Date objects", () => {
    const dto = toOrderDto(orderRow(), "customer");
    expect(dto.placedAt).toBe("2026-07-01T10:00:00.000Z");
    expect(dto.paidAt).toBe("2026-07-01T10:05:00.000Z");
    expect(dto.cancelledAt).toBeNull();
  });

  /**
   * THE data-leak test.
   *
   * Operator notes ("customer disputed, flagged for review", "suspected reseller")
   * live on the same timeline as "your parcel shipped". Shipping the former to
   * the customer is a real incident, and the filter is easy to omit because the
   * happy-path fixture usually has no internal events in it — hence a fixture
   * here that deliberately does.
   */
  it("hides internal timeline entries from the customer view", () => {
    const row = orderRow({
      events: [
        eventRow(),
        eventRow({
          id: "dddddddd-0000-4000-8000-000000000002",
          type: "STATUS_CHANGED",
          message: "Customer disputed; flagged for manual review.",
          isInternal: true,
        }),
      ],
    });

    const customerView = toOrderDto(row, "customer");
    expect(customerView.events).toHaveLength(1);
    expect(JSON.stringify(customerView)).not.toContain("flagged for manual review");
    expect(customerView.events.every((event) => !event.isInternal)).toBe(true);

    const adminView = toOrderDto(row, "admin");
    expect(adminView.events).toHaveLength(2);
  });

  it("maps money as integers and never as floats", () => {
    const dto = toOrderDto(orderRow(), "customer");
    for (const amount of [
      dto.subtotal,
      dto.taxTotal,
      dto.grandTotal,
      dto.refundedTotal,
    ]) {
      expect(Number.isInteger(amount)).toBe(true);
    }
    expect(dto.grandTotal).toBe(9998);
  });

  it("carries the snapshotted address, not a reference to the address book", () => {
    const dto = toOrderDto(orderRow(), "customer");
    expect(dto.shippingAddress.line1).toBe("Calle 10 # 43-21");
    expect(dto.shippingAddress.countryCode).toBe("CO");
    // No addressId anywhere: a customer editing their address book must not
    // rewrite where a two-year-old parcel was sent.
    expect(JSON.stringify(dto)).not.toContain("addressId");
  });

  it("rejects a row whose money columns are not integers", () => {
    // toMinor re-asserts the invariant rather than trusting that the database
    // only ever contained good data.
    expect(() => toOrderDto(orderRow({ grandTotal: 99.98 }), "customer")).toThrow();
  });
});

function shipmentRow(
  overrides: Partial<OrderWithDetail["shipments"][number]> = {},
): OrderWithDetail["shipments"][number] {
  return {
    id: "ffffffff-0000-4000-8000-000000000001",
    orderId: "bbbbbbbb-0000-4000-8000-000000000001",
    status: "IN_TRANSIT",
    carrier: "Servientrega",
    trackingNumber: "2087654321",
    trackingUrl: "https://tracking.example.com/2087654321",
    shippedAt: new Date("2026-07-02T09:00:00.000Z"),
    deliveredAt: null,
    createdAt: new Date("2026-07-02T09:00:00.000Z"),
    ...overrides,
  };
}

describe("toOrderDto — identity document, method and parcels", () => {
  it("includes the document, the Colombian address, the method name and the parcels", () => {
    const dto = toOrderDto(orderRow({ shipments: [shipmentRow()] }), "customer");

    expect(orderSchema.parse(dto)).toEqual(dto);
    expect(dto.documentType).toBe("CC");
    expect(dto.documentNumber).toBe("1020304050");
    expect(dto.shippingMethodName).toBe("Envío nacional");
    expect(dto.shippingAddress).toMatchObject({
      region: "Antioquia",
      city: "Medellín",
      postalCode: null,
      phone: "3001234567",
    });
    expect(dto.shipments).toEqual([
      {
        id: "ffffffff-0000-4000-8000-000000000001",
        carrier: "Servientrega",
        trackingNumber: "2087654321",
        trackingUrl: "https://tracking.example.com/2087654321",
        status: "IN_TRANSIT",
        shippedAt: "2026-07-02T09:00:00.000Z",
        deliveredAt: null,
      },
    ]);
  });

  it("renders an order with no parcels yet", () => {
    expect(toOrderDto(orderRow(), "customer").shipments).toEqual([]);
  });
});

describe("toAdminOrderDto", () => {
  it("adds the staff-only facts and satisfies the admin contract", () => {
    const dto = toAdminOrderDto(
      orderRow({
        shippingRateId: "99999999-0000-4000-8000-000000000001",
        shipments: [shipmentRow()],
      }),
    );

    expect(adminOrderSchema.parse(dto)).toEqual(dto);
    expect(dto.shippingRateId).toBe("99999999-0000-4000-8000-000000000001");
    expect(dto.documentNumber).toBe("1020304050");
    expect(dto.shipments[0]).toMatchObject({
      carrier: "Servientrega",
      createdAt: "2026-07-02T09:00:00.000Z",
    });
  });

  it("keeps internal timeline entries (admin view)", () => {
    const dto = toAdminOrderDto(orderRow({ events: [eventRow({ isInternal: true })] }));
    expect(dto.events).toHaveLength(1);
  });
});

describe("toOrderSummaryDto", () => {
  function summaryRow(items: Array<{ quantity: number }>): OrderForSummary {
    // The summary read selects only quantities, so the detail row's `items` and
    // `events` are replaced rather than destructured away.
    const full = orderRow();
    const rest: Omit<OrderWithDetail, "items" | "events" | "shipments"> = full;
    return { ...rest, items };
  }

  it("counts UNITS, not lines", () => {
    // A two-line order of three units each reading "2 items" looks like a bug
    // to the customer counting what is in the box.
    const dto = toOrderSummaryDto(summaryRow([{ quantity: 3 }, { quantity: 3 }]));
    expect(dto.itemCount).toBe(6);
    expect(orderSummarySchema.safeParse(dto).success).toBe(true);
  });

  it("produces a payload the contract schema accepts", () => {
    expect(orderSummarySchema.safeParse(toOrderSummaryDto(summaryRow([{ quantity: 1 }]))).success).toBe(
      true,
    );
  });
});
