import { describe, expect, it } from "vitest";

import {
  adminOrderSchema,
  checkoutShippingAddressSchema,
  createCheckoutSessionSchema,
  orderSchema,
} from "./commerce";
import { addressFieldsSchema } from "./identity";
import { fulfilmentFailureReasonSchema, shipmentStatusSchema } from "./enums";
import {
  bulkLabelRequestSchema,
  bulkLabelResultSchema,
  createShippingRateSchema,
  createShippingZoneSchema,
  printLabelsRequestSchema,
  updateShippingRateSchema,
} from "./fulfilment";
import {
  servicePointSearchRequestSchema,
  servicePointSearchResponseSchema,
  shippingOptionSchema,
} from "./shipping";

/**
 * The Sendcloud-shaped additions to the contract (spec
 * 2026-09-24-sendcloud-shipping §3.2–§3.6, §5, §7a).
 *
 * Two kinds of guarantee are under test: what the schemas REFUSE, and that
 * every field added to a `.strict()` RESPONSE schema is defaulted — the
 * clients deploy first, so a new client must parse the old API's payload.
 */

const UUID = "6f1b9e2c-2a1e-4a4e-9a53-2f9a4a7c1b11";
const UUID_2 = "7a2c0f3d-3b2f-4b5f-8b64-3fab5b8d2c22";

const OLD_ORDER = {
  id: UUID,
  orderNumber: "AK-2026-000001",
  customerId: null,
  email: "ana@example.com",
  status: "PAID",
  locale: "es",
  currency: "EUR",
  items: [
    {
      id: UUID_2,
      variantId: null,
      productName: "RETA",
      variantName: null,
      sku: "RETA-10",
      imageUrl: null,
      quantity: 1,
      unitPriceNet: 1000,
      unitPriceGross: 1210,
      lineDiscount: 0,
      taxRateBps: 2100,
      taxAmount: 210,
      lineTotalNet: 1000,
      lineTotalGross: 1210,
      batchLotCode: null,
    },
  ],
  subtotal: 1210,
  discountTotal: 0,
  shippingTotal: 0,
  taxTotal: 210,
  grandTotal: 1210,
  refundedTotal: 0,
  shippingAddress: {
    firstName: "Ana",
    lastName: "García",
    company: null,
    line1: "Calle Mayor",
    line2: null,
    city: "Zaragoza",
    region: null,
    postalCode: "50002",
    countryCode: "ES",
    phone: null,
  },
  billingAddress: {
    firstName: "Ana",
    lastName: "García",
    company: null,
    line1: "Calle Mayor",
    line2: null,
    city: "Zaragoza",
    region: null,
    postalCode: "50002",
    countryCode: "ES",
    phone: null,
  },
  invoiceNumber: null,
  vatNumber: null,
  events: [],
  placedAt: "2026-09-24T10:00:00.000Z",
  paidAt: null,
  cancelledAt: null,
  updatedAt: "2026-09-24T10:00:00.000Z",
  version: 0,
} as const;

/** The address-book shape: the checkout address minus its house number. */
function withoutHouseNumber(address: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(address).filter(([key]) => key !== "houseNumber"));
}

const CHECKOUT_ADDRESS = {
  firstName: "Ana",
  lastName: "García",
  company: null,
  line1: "Calle Mayor",
  line2: null,
  city: "Zaragoza",
  region: null,
  postalCode: "50002",
  countryCode: "ES",
  phone: "+34 600 000 000",
  houseNumber: "1",
} as const;

describe("rollout safety: new response fields are defaulted", () => {
  it("parses an OLD quote option as HOME with no carrier line", () => {
    const parsed = shippingOptionSchema.parse({
      rateId: UUID,
      name: { es: "InPost", en: "InPost" },
      currency: "EUR",
      priceGross: 899,
      isFree: false,
    });

    expect(parsed).toMatchObject({
      deliveryType: "HOME",
      carrierName: null,
      transitDaysMin: null,
      transitDaysMax: null,
    });
  });

  it("never carries the internal Sendcloud option code on a quote option", () => {
    const result = shippingOptionSchema.safeParse({
      rateId: UUID,
      name: { es: "InPost" },
      currency: "EUR",
      priceGross: 899,
      isFree: false,
      sendcloudOptionCode: "inpost_es:service_point,national_c2c",
    });
    expect(result.success).toBe(false);
  });

  it("parses an OLD order as having no method, no point and no parcels", () => {
    const parsed = orderSchema.parse(OLD_ORDER);
    expect(parsed.shippingMethodName).toBeNull();
    expect(parsed.shippingHouseNumber).toBeNull();
    expect(parsed.servicePoint).toBeNull();
    expect(parsed.shipments).toEqual([]);
  });

  it("parses an OLD order through the ADMIN schema too", () => {
    const parsed = adminOrderSchema.parse(OLD_ORDER);
    expect(parsed.shipments).toEqual([]);
    expect(parsed.labelEligible).toBe(false);
    expect(parsed.parcelWeightGrams).toBeNull();
  });

  it("defaults the admin-only shipment fields of an older payload", () => {
    const parsed = adminOrderSchema.parse({
      ...OLD_ORDER,
      shipments: [
        {
          id: UUID_2,
          carrier: "InPost",
          trackingNumber: null,
          trackingUrl: null,
          status: "IN_TRANSIT",
          shippedAt: null,
          deliveredAt: null,
        },
      ],
    });
    expect(parsed.shipments[0]).toMatchObject({
      provider: "MANUAL",
      hasLabel: false,
      failureReason: null,
    });
  });

  it("keeps staff-only shipment detail OFF the customer order", () => {
    const result = orderSchema.safeParse({
      ...OLD_ORDER,
      shipments: [
        {
          id: UUID_2,
          carrier: "InPost",
          trackingNumber: null,
          trackingUrl: null,
          status: "FAILED",
          shippedAt: null,
          deliveredAt: null,
          failureReason: "address_line_1 too long",
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("shipmentStatusSchema", () => {
  it("knows the Sendcloud lifecycle states", () => {
    for (const status of [
      "LABEL_CREATED",
      "AWAITING_PICKUP",
      "CANCELLED",
      "FAILED",
      "EXCEPTION",
    ]) {
      expect(shipmentStatusSchema.safeParse(status).success).toBe(true);
    }
  });
});

describe("fulfilmentFailureReasonSchema", () => {
  it("carries the checkout and label sub-codes", () => {
    for (const reason of [
      "SERVICE_POINT_REQUIRED",
      "SERVICE_POINT_UNAVAILABLE",
      "FULFILMENT_NOT_CONFIGURED",
    ]) {
      expect(fulfilmentFailureReasonSchema.safeParse(reason).success).toBe(true);
    }
  });
});

describe("checkout shipping address", () => {
  it("requires a house number and a phone at checkout", () => {
    expect(checkoutShippingAddressSchema.safeParse(CHECKOUT_ADDRESS).success).toBe(true);

    expect(
      checkoutShippingAddressSchema.safeParse(withoutHouseNumber(CHECKOUT_ADDRESS)).success,
    ).toBe(false);

    expect(
      checkoutShippingAddressSchema.safeParse({ ...CHECKOUT_ADDRESS, phone: null }).success,
    ).toBe(false);
    expect(
      checkoutShippingAddressSchema.safeParse({ ...CHECKOUT_ADDRESS, phone: "   " }).success,
    ).toBe(false);
  });

  it("validates the phone loosely: digits, spaces, a leading +, 7–20 chars", () => {
    for (const ok of ["+34600000000", "600 000 000", "+353 1 234 5678"]) {
      expect(
        checkoutShippingAddressSchema.safeParse({ ...CHECKOUT_ADDRESS, phone: ok }).success,
      ).toBe(true);
    }
    for (const bad of ["call me", "12345", "+34-600-000-000", "++34600000000", "1 2 3 4 5 6"]) {
      expect(
        checkoutShippingAddressSchema.safeParse({ ...CHECKOUT_ADDRESS, phone: bad }).success,
        bad,
      ).toBe(false);
    }
  });

  it("caps the house number at 16 characters", () => {
    expect(
      checkoutShippingAddressSchema.safeParse({ ...CHECKOUT_ADDRESS, houseNumber: "1".repeat(17) })
        .success,
    ).toBe(false);
  });

  it("leaves the ADDRESS BOOK schema untouched: phone optional, no house number", () => {
    const bookAddress = withoutHouseNumber(CHECKOUT_ADDRESS);
    expect(addressFieldsSchema.safeParse({ ...bookAddress, phone: null }).success).toBe(true);
    expect(addressFieldsSchema.safeParse(CHECKOUT_ADDRESS).success).toBe(false);
  });

  it("defaults servicePointId to null and bounds it", () => {
    const base = {
      cartId: UUID,
      email: "ana@example.com",
      shippingAddress: CHECKOUT_ADDRESS,
      shippingMethodId: UUID_2,
      acceptedTermsVersion: "2026-09-01",
    };
    expect(createCheckoutSessionSchema.parse(base).servicePointId).toBeNull();
    expect(
      createCheckoutSessionSchema.parse({ ...base, servicePointId: "12188365" }).servicePointId,
    ).toBe("12188365");
    expect(
      createCheckoutSessionSchema.safeParse({ ...base, servicePointId: "x".repeat(33) }).success,
    ).toBe(false);
  });

  it("keeps the billing address on the address-book shape (no house number required)", () => {
    const billing = withoutHouseNumber(CHECKOUT_ADDRESS);
    const result = createCheckoutSessionSchema.safeParse({
      cartId: UUID,
      email: "ana@example.com",
      shippingAddress: CHECKOUT_ADDRESS,
      billingAddress: { ...billing, phone: null },
      shippingMethodId: UUID_2,
      acceptedTermsVersion: "2026-09-01",
    });
    expect(result.success).toBe(true);
  });
});

describe("servicePointSearchRequestSchema", () => {
  it("names a rate, never a carrier, and defaults city to null", () => {
    expect(
      servicePointSearchRequestSchema.parse({
        rateId: UUID,
        countryCode: "ES",
        postalCode: "50002",
      }),
    ).toEqual({ rateId: UUID, countryCode: "ES", postalCode: "50002", city: null });

    expect(
      servicePointSearchRequestSchema.safeParse({
        rateId: UUID,
        countryCode: "ES",
        postalCode: "50002",
        carrierCode: "ups",
      }).success,
    ).toBe(false);
  });

  it("requires a postcode", () => {
    expect(
      servicePointSearchRequestSchema.safeParse({ rateId: UUID, countryCode: "ES", postalCode: " " })
        .success,
    ).toBe(false);
  });
});

describe("servicePointSearchResponseSchema", () => {
  const point = {
    id: "12188365",
    name: "PAPELERIA PILI",
    shopType: "servicepoint",
    street: "CALLE DE LA BATALLA DE LEPANTO",
    houseNumber: "",
    postalCode: "50002",
    city: "ZARAGOZA",
    countryCode: "ES",
    distanceMeters: 1089,
    openingHours: {
      monday: [
        { from: "08:00", to: "14:00" },
        { from: "17:00", to: "20:30" },
      ],
      tuesday: null,
      wednesday: null,
      thursday: null,
      friday: null,
      saturday: [{ from: "08:00", to: "14:00" }],
      sunday: null,
    },
  };

  it("accepts several shifts a day, an empty house number and closed days", () => {
    expect(servicePointSearchResponseSchema.safeParse({ status: "OK", points: [point] }).success).toBe(
      true,
    );
  });

  it("rejects a malformed opening time", () => {
    const bad = {
      ...point,
      openingHours: { ...point.openingHours, sunday: [{ from: "9:00", to: "14:00" }] },
    };
    expect(servicePointSearchResponseSchema.safeParse({ status: "OK", points: [bad] }).success).toBe(
      false,
    );
  });

  it("knows exactly the four statuses", () => {
    for (const status of ["OK", "ADDRESS_NOT_FOUND", "NONE_NEARBY", "UNAVAILABLE"]) {
      expect(servicePointSearchResponseSchema.safeParse({ status, points: [] }).success).toBe(true);
    }
    expect(servicePointSearchResponseSchema.safeParse({ status: "ERROR", points: [] }).success).toBe(
      false,
    );
  });
});

describe("bulk labels", () => {
  it("caps a generate request at 100 ids and a print at 200", () => {
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `6f1b9e2c-2a1e-4a4e-9a53-${String(i).padStart(12, "0")}`);

    expect(bulkLabelRequestSchema.safeParse({ orderIds: ids(100) }).success).toBe(true);
    expect(bulkLabelRequestSchema.safeParse({ orderIds: ids(101) }).success).toBe(false);
    expect(bulkLabelRequestSchema.safeParse({ orderIds: [] }).success).toBe(false);
    expect(printLabelsRequestSchema.safeParse({ orderIds: ids(200) }).success).toBe(true);
    expect(printLabelsRequestSchema.safeParse({ orderIds: ids(201) }).success).toBe(false);
  });

  it("refuses a duplicated id", () => {
    expect(bulkLabelRequestSchema.safeParse({ orderIds: [UUID, UUID] }).success).toBe(false);
  });

  it("reports skips with a closed reason and a nullable order number", () => {
    expect(
      bulkLabelResultSchema.safeParse({
        accepted: ["AK-2026-000001"],
        skipped: [
          { orderId: UUID, orderNumber: null, reason: "NOT_FOUND" },
          { orderId: UUID_2, orderNumber: "AK-2026-000002", reason: "RATE_NOT_MAPPED" },
        ],
      }).success,
    ).toBe(true);
    expect(
      bulkLabelResultSchema.safeParse({
        accepted: [],
        skipped: [{ orderId: UUID, orderNumber: null, reason: "SOMETHING" }],
      }).success,
    ).toBe(false);
  });
});

describe("shipping admin", () => {
  const rate = {
    name: { es: "InPost punto de recogida", en: "InPost pickup point" },
    strategy: "FLAT",
    priceGross: 899,
  } as const;

  it("defaults a new rate to an active, unmapped HOME rate in EUR", () => {
    expect(createShippingRateSchema.parse(rate)).toMatchObject({
      currency: "EUR",
      isActive: true,
      deliveryType: "HOME",
      carrierCode: null,
      sendcloudOptionCode: null,
      freeOverSubtotal: null,
    });
  });

  it("refuses a pickup-point rate without a carrier", () => {
    expect(createShippingRateSchema.safeParse({ ...rate, deliveryType: "SERVICE_POINT" }).success).toBe(
      false,
    );
    expect(
      createShippingRateSchema.safeParse({
        ...rate,
        deliveryType: "SERVICE_POINT",
        carrierCode: "inpost_es",
        sendcloudOptionCode: "inpost_es:service_point,national_c2c",
      }).success,
    ).toBe(true);
  });

  it("refuses inverted bounds and transit days, and a float price", () => {
    expect(createShippingRateSchema.safeParse({ ...rate, minValue: 10, maxValue: 5 }).success).toBe(
      false,
    );
    expect(
      createShippingRateSchema.safeParse({ ...rate, transitDaysMin: 3, transitDaysMax: 1 }).success,
    ).toBe(false);
    expect(createShippingRateSchema.safeParse({ ...rate, priceGross: 8.99 }).success).toBe(false);
  });

  it("requires the Spanish name and lets the English one wait", () => {
    expect(createShippingRateSchema.safeParse({ ...rate, name: { es: "InPost" } }).success).toBe(
      true,
    );
    expect(createShippingRateSchema.safeParse({ ...rate, name: { en: "InPost" } }).success).toBe(
      false,
    );
    // An empty English name would satisfy "has a name" and render blank.
    expect(
      createShippingRateSchema.safeParse({ ...rate, name: { es: "InPost", en: "  " } }).success,
    ).toBe(false);
  });

  it("refuses bounds on a FLAT rate, a zero free-over threshold and a non-euro price", () => {
    expect(createShippingRateSchema.safeParse({ ...rate, minValue: 0, maxValue: 500 }).success).toBe(
      false,
    );
    expect(
      createShippingRateSchema.safeParse({ ...rate, strategy: "WEIGHT", minValue: 0, maxValue: 500 })
        .success,
    ).toBe(true);
    expect(createShippingRateSchema.safeParse({ ...rate, freeOverSubtotal: 0 }).success).toBe(false);
    expect(createShippingRateSchema.safeParse({ ...rate, freeOverSubtotal: 25_000 }).success).toBe(
      true,
    );
    expect(createShippingRateSchema.safeParse({ ...rate, currency: "USD" }).success).toBe(false);
  });

  it("judges only the ordering of a bounds-only PATCH (the service checks the merged row)", () => {
    expect(updateShippingRateSchema.safeParse({ maxValue: 500 }).success).toBe(true);
    expect(updateShippingRateSchema.safeParse({ minValue: 9, maxValue: 5 }).success).toBe(false);
  });

  it("accepts a partial rate update and still rejects unknown keys", () => {
    expect(updateShippingRateSchema.safeParse({ isActive: false }).success).toBe(true);
    expect(updateShippingRateSchema.safeParse({ zoneId: UUID }).success).toBe(false);
  });

  it("refuses duplicate or malformed countries on a zone", () => {
    expect(createShippingZoneSchema.parse({ name: "Irlanda", countryCodes: ["IE"] })).toEqual({
      name: "Irlanda",
      countryCodes: ["IE"],
      sortOrder: 0,
    });
    expect(
      createShippingZoneSchema.safeParse({ name: "EU", countryCodes: ["FR", "FR"] }).success,
    ).toBe(false);
    expect(createShippingZoneSchema.safeParse({ name: "EU", countryCodes: ["fr"] }).success).toBe(
      false,
    );
    // Only countries the storefront offers as destinations: US is a valid ISO
    // code the checkout's selector does not list.
    expect(createShippingZoneSchema.safeParse({ name: "US", countryCodes: ["US"] }).success).toBe(
      false,
    );
  });
});
