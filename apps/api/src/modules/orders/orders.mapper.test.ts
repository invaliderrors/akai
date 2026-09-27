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
    productName: "Creatine Monohydrate",
    variantName: "500 g",
    sku: "AK-CRE-500",
    imageUrl: null,
    quantity: 2,
    unitPriceNet: 4131,
    unitPriceGross: 4999,
    lineDiscount: 0,
    taxRateBps: 2100,
    taxAmount: 1735,
    lineTotalNet: 8263,
    lineTotalGross: 9998,
    batchLotCode: "LOT-2026-04",
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
    locale: "es",
    currency: "EUR",
    subtotal: 8263,
    discountTotal: 0,
    shippingTotal: 0,
    taxTotal: 1735,
    grandTotal: 9998,
    refundedTotal: 0,
    shipFirstName: "Ana",
    shipLastName: "García",
    shipCompany: null,
    shipLine1: "Calle Mayor 1",
    shipLine2: null,
    shipCity: "Madrid",
    shipRegion: null,
    shipPostalCode: "28013",
    shipCountryCode: "ES",
    shipPhone: null,
    billFirstName: "Ana",
    billLastName: "García",
    billCompany: null,
    billLine1: "Calle Mayor 1",
    billLine2: null,
    billCity: "Madrid",
    billRegion: null,
    billPostalCode: "28013",
    billCountryCode: "ES",
    billPhone: null,
    invoiceNumber: "INV-2026-000045",
    vatNumber: null,
    reverseCharge: false,
    shippingMethodName: "Estándar",
    acceptedTermsVersion: "2026-01",
    providerCheckoutId: "cs_test_123",
    shippingRateId: null,
    sendcloudOptionCode: null,
    servicePointId: null,
    servicePointCarrierId: null,
    servicePointName: null,
    servicePointAddress: null,
    servicePointPostNumber: null,
    shipHouseNumber: null,
    parcelWeightGrams: null,
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
    expect(dto.shippingAddress.line1).toBe("Calle Mayor 1");
    expect(dto.shippingAddress.countryCode).toBe("ES");
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
    status: "LABEL_CREATED",
    carrier: "InPost",
    trackingNumber: "SCCWF3P9K4PJ",
    trackingUrl: "https://tracking.example.com/SCCWF3P9K4PJ",
    provider: "SENDCLOUD",
    sendcloudShipmentId: "95524bc9-174f-47c8-a03a-e60b83a24fe1",
    sendcloudParcelId: 718530367n,
    labelObjectKey: "labels/bbbbbbbb/718530367.pdf",
    sendcloudStatusCode: "READY_TO_SEND",
    failureReason: null,
    lastSyncedAt: null,
    shippedAt: null,
    deliveredAt: null,
    createdAt: new Date("2026-07-02T09:00:00.000Z"),
    ...overrides,
  };
}

const PICKUP_SNAPSHOT = {
  shippingRateId: "99999999-0000-4000-8000-000000000001",
  sendcloudOptionCode: "inpost_es:service_point,national_c2c",
  servicePointId: "12188365",
  servicePointCarrierId: "ES21366",
  servicePointName: "PAPELERIA PILI",
  servicePointAddress: "CALLE DE LA BATALLA DE LEPANTO, 50002 ZARAGOZA, ES",
  servicePointPostNumber: null,
  shipHouseNumber: "1",
  parcelWeightGrams: 120,
} as const;

describe("toOrderDto — fulfilment", () => {
  it("includes the method name, house number, point and parcels for the customer", () => {
    const dto = toOrderDto(orderRow({ ...PICKUP_SNAPSHOT, shipments: [shipmentRow()] }), "customer");

    expect(orderSchema.parse(dto)).toEqual(dto);
    expect(dto.shippingMethodName).toBe("Estándar");
    expect(dto.shippingHouseNumber).toBe("1");
    expect(dto.servicePoint).toEqual({
      name: "PAPELERIA PILI",
      address: "CALLE DE LA BATALLA DE LEPANTO, 50002 ZARAGOZA, ES",
    });
    expect(dto.shipments).toEqual([
      {
        id: "ffffffff-0000-4000-8000-000000000001",
        carrier: "InPost",
        trackingNumber: "SCCWF3P9K4PJ",
        trackingUrl: "https://tracking.example.com/SCCWF3P9K4PJ",
        status: "LABEL_CREATED",
        shippedAt: null,
        deliveredAt: null,
      },
    ]);
  });

  it("NEVER shows the customer the label key, vendor ids or failure detail", () => {
    const dto = toOrderDto(
      orderRow({
        ...PICKUP_SNAPSHOT,
        shipments: [shipmentRow({ status: "FAILED", failureReason: "to_address.house_number required" })],
      }),
      "customer",
    );
    const wire = JSON.stringify(dto);

    for (const leak of ["labels/", "718530367", "95524bc9", "house_number required", "national_c2c", "ES21366"]) {
      expect(wire).not.toContain(leak);
    }
  });

  it("renders a home-delivery order with no point and no parcels", () => {
    const dto = toOrderDto(orderRow(), "customer");
    expect(dto.servicePoint).toBeNull();
    expect(dto.shipments).toEqual([]);
  });

  it("treats a half-written point snapshot as no point", () => {
    const dto = toOrderDto(
      orderRow({ ...PICKUP_SNAPSHOT, servicePointName: null }),
      "customer",
    );
    expect(dto.servicePoint).toBeNull();
  });
});

describe("toAdminOrderDto", () => {
  it("adds the staff-only fulfilment facts and satisfies the admin contract", () => {
    const dto = toAdminOrderDto(
      orderRow({
        ...PICKUP_SNAPSHOT,
        shipments: [shipmentRow({ status: "FAILED", labelObjectKey: null, failureReason: "bad address" })],
      }),
    );

    expect(adminOrderSchema.parse(dto)).toEqual(dto);
    expect(dto.labelEligible).toBe(true);
    expect(dto.parcelWeightGrams).toBe(120);
    expect(dto.servicePoint).toEqual({
      name: "PAPELERIA PILI",
      address: "CALLE DE LA BATALLA DE LEPANTO, 50002 ZARAGOZA, ES",
      id: "12188365",
      carrierServicePointId: "ES21366",
      postNumber: null,
    });
    expect(dto.shipments[0]).toMatchObject({
      provider: "SENDCLOUD",
      hasLabel: false,
      providerStatusCode: "READY_TO_SEND",
      failureReason: "bad address",
      createdAt: "2026-07-02T09:00:00.000Z",
    });
  });

  it("keeps internal timeline entries (admin view)", () => {
    const dto = toAdminOrderDto(orderRow({ events: [eventRow({ isInternal: true })] }));
    expect(dto.events).toHaveLength(1);
  });

  it("is not label-eligible without an option-code snapshot", () => {
    expect(toAdminOrderDto(orderRow()).labelEligible).toBe(false);
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
