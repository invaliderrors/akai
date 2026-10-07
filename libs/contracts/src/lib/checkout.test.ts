import { describe, expect, it } from "vitest";

import {
  adminOrderSchema,
  checkoutShippingAddressSchema,
  createCheckoutSessionSchema,
  orderSchema,
} from "./commerce";
import { addressFieldsSchema, createAddressSchema, updateAddressSchema } from "./identity";

const ADDRESS = {
  firstName: "Valentina",
  lastName: "Restrepo",
  company: null,
  line1: "Calle 10 # 43-21",
  line2: "Apto 502",
  city: "Medellín",
  region: "Antioquia",
  postalCode: null,
  countryCode: "CO",
  phone: "300 123 4567",
};

const CHECKOUT = {
  cartId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  email: "valentina@example.com",
  shippingAddress: ADDRESS,
  shippingMethodId: "0a5b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d",
  documentType: "CC",
  documentNumber: "1.020.304.050",
  acceptedTermsVersion: "2026-10-01",
};

describe("the Colombian address", () => {
  it("accepts a Colombian address and normalises its phone", () => {
    const parsed = addressFieldsSchema.parse(ADDRESS);
    expect(parsed.phone).toBe("3001234567");
    expect(parsed.region).toBe("Antioquia");
    expect(parsed.postalCode).toBeNull();
  });

  it("requires the departamento and validates it against the closed list", () => {
    expect(addressFieldsSchema.safeParse({ ...ADDRESS, region: null }).success).toBe(false);
    expect(addressFieldsSchema.safeParse({ ...ADDRESS, region: "Madrid" }).success).toBe(false);
    expect(addressFieldsSchema.parse({ ...ADDRESS, region: "bogota d.c." }).region).toBe(
      "Bogotá, D.C.",
    );
  });

  it("requires the city (municipio) and the street line", () => {
    expect(addressFieldsSchema.safeParse({ ...ADDRESS, city: "  " }).success).toBe(false);
    expect(addressFieldsSchema.safeParse({ ...ADDRESS, line1: "" }).success).toBe(false);
  });

  it("makes the postal code optional, and six digits when given", () => {
    const { postalCode: _omitted, ...withoutPostalCode } = ADDRESS;
    expect(addressFieldsSchema.parse(withoutPostalCode).postalCode).toBeNull();
    expect(addressFieldsSchema.parse({ ...ADDRESS, postalCode: "050021" }).postalCode).toBe("050021");
    expect(addressFieldsSchema.safeParse({ ...ADDRESS, postalCode: "28013" }).success).toBe(false);
  });

  it("serves Colombia only", () => {
    expect(addressFieldsSchema.safeParse({ ...ADDRESS, countryCode: "ES" }).success).toBe(false);
  });

  it("keeps the address-book phone optional but Colombian when present", () => {
    expect(createAddressSchema.parse({ ...ADDRESS, phone: null, type: "SHIPPING" }).phone).toBeNull();
    expect(
      createAddressSchema.safeParse({ ...ADDRESS, phone: "+34 612 345 678", type: "SHIPPING" }).success,
    ).toBe(false);
  });

  it("lets a PATCH name only the fields it changes", () => {
    expect(updateAddressSchema.parse({ city: "Envigado" })).toEqual({ city: "Envigado" });
    expect(updateAddressSchema.safeParse({ region: "Narnia" }).success).toBe(false);
  });

  it("has no house-number field: the number lives in the street line", () => {
    expect(
      checkoutShippingAddressSchema.safeParse({ ...ADDRESS, houseNumber: "43-21" }).success,
    ).toBe(false);
  });
});

describe("createCheckoutSessionSchema", () => {
  it("requires a Colombian mobile on the shipping address", () => {
    expect(
      createCheckoutSessionSchema.safeParse({
        ...CHECKOUT,
        shippingAddress: { ...ADDRESS, phone: null },
      }).success,
    ).toBe(false);
    expect(
      createCheckoutSessionSchema.safeParse({
        ...CHECKOUT,
        shippingAddress: { ...ADDRESS, phone: "601 234 5678" },
      }).success,
    ).toBe(false);
  });

  it("keeps the billing address on the address-book shape (phone optional)", () => {
    const parsed = createCheckoutSessionSchema.parse({
      ...CHECKOUT,
      billingAddress: { ...ADDRESS, phone: null },
    });
    expect(parsed.billingAddress?.phone).toBeNull();
  });

  it("requires the identity document and normalises its number", () => {
    const parsed = createCheckoutSessionSchema.parse(CHECKOUT);
    expect(parsed.documentType).toBe("CC");
    expect(parsed.documentNumber).toBe("1020304050");

    const { documentType: _type, ...withoutType } = CHECKOUT;
    expect(createCheckoutSessionSchema.safeParse(withoutType).success).toBe(false);
    const { documentNumber: _number, ...withoutNumber } = CHECKOUT;
    expect(createCheckoutSessionSchema.safeParse(withoutNumber).success).toBe(false);
  });

  it("validates the number against its type and reports it on documentNumber", () => {
    const result = createCheckoutSessionSchema.safeParse({
      ...CHECKOUT,
      documentType: "NIT",
      documentNumber: "800197268-5",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["documentNumber"]);
    }
    expect(
      createCheckoutSessionSchema.parse({
        ...CHECKOUT,
        documentType: "NIT",
        documentNumber: "800.197.268-4",
      }).documentNumber,
    ).toBe("800197268-4");
  });

  it("refuses an unknown document type", () => {
    expect(createCheckoutSessionSchema.safeParse({ ...CHECKOUT, documentType: "DNI" }).success).toBe(
      false,
    );
  });

  it("no longer accepts the Sendcloud-era fields", () => {
    for (const extra of [{ servicePointId: "123" }, { vatNumber: "ESB12345678" }]) {
      expect(createCheckoutSessionSchema.safeParse({ ...CHECKOUT, ...extra }).success).toBe(false);
    }
  });
});

describe("the order carries the identity document", () => {
  const ORDER = {
    id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    orderNumber: "AK-2026-000123",
    customerId: null,
    email: "valentina@example.com",
    status: "PAID",
    locale: "es",
    currency: "COP",
    items: [
      {
        id: "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
        variantId: null,
        productName: "Tee",
        variantName: null,
        sku: "TEE-1",
        imageUrl: null,
        quantity: 1,
        unitPriceNet: 7_478_992,
        unitPriceGross: 8_900_000,
        lineDiscount: 0,
        taxRateBps: 1900,
        taxAmount: 1_421_008,
        lineTotalNet: 7_478_992,
        lineTotalGross: 8_900_000,
      },
    ],
    subtotal: 8_900_000,
    discountTotal: 0,
    shippingTotal: 1_500_000,
    taxTotal: 1_660_504,
    grandTotal: 10_400_000,
    refundedTotal: 0,
    shippingAddress: { ...ADDRESS, phone: "3001234567" },
    billingAddress: { ...ADDRESS, phone: "3001234567" },
    invoiceNumber: null,
    documentType: "CC",
    documentNumber: "1020304050",
    shippingMethodName: "Envío nacional",
    shipments: [],
    events: [],
    placedAt: "2026-10-01T12:00:00.000Z",
    paidAt: null,
    cancelledAt: null,
    updatedAt: "2026-10-01T12:00:00.000Z",
    version: 0,
  };

  it("parses on the customer and the admin shapes", () => {
    expect(orderSchema.parse(ORDER).documentNumber).toBe("1020304050");
    expect(adminOrderSchema.parse({ ...ORDER, shippingRateId: null }).documentType).toBe("CC");
  });

  it("rejects an order without a document", () => {
    const { documentType: _type, ...withoutType } = ORDER;
    expect(orderSchema.safeParse(withoutType).success).toBe(false);
  });
});
