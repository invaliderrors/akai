import { describe, expect, it } from "vitest";

import {
  type LabelEligibilityInput,
  externalReferenceFor,
  labelSkipReason,
} from "./label-eligibility";

function order(overrides: Partial<LabelEligibilityInput> = {}): LabelEligibilityInput {
  const base: LabelEligibilityInput = {
    status: "PAID",
    sendcloudOptionCode: "inpost_es:service_point,national_c2c",
    parcelWeightGrams: 500,
    shipments: [],
  };
  return { ...base, ...overrides };
}

describe("labelSkipReason", () => {
  it("accepts a PAID, mapped, weighed order with nothing shipping it", () => {
    expect(labelSkipReason(order())).toBeNull();
  });

  it("accepts FULFILLING when nothing active ships it (a cancelled or failed label)", () => {
    expect(
      labelSkipReason(
        order({ status: "FULFILLING", shipments: [{ status: "CANCELLED" }, { status: "FAILED" }] }),
      ),
    ).toBeNull();
  });

  it.each(["LABEL_CREATED", "IN_TRANSIT", "PENDING", "DELIVERED", "EXCEPTION"] as const)(
    "refuses a second label while a %s parcel carries goods",
    (status) => {
      expect(labelSkipReason(order({ status: "FULFILLING", shipments: [{ status }] }))).toBe(
        "ALREADY_LABELLED",
      );
    },
  );

  it.each(["PENDING", "AWAITING_PAYMENT", "PAYMENT_MISMATCH", "CANCELLED", "REFUNDED", "SHIPPED"] as const)(
    "refuses a %s order as NOT_PAID",
    (status) => {
      expect(labelSkipReason(order({ status }))).toBe("NOT_PAID");
    },
  );

  it("prefers ALREADY_LABELLED over NOT_PAID for a shipped order with a label", () => {
    expect(
      labelSkipReason(order({ status: "SHIPPED", shipments: [{ status: "IN_TRANSIT" }] })),
    ).toBe("ALREADY_LABELLED");
  });

  it("refuses an unmapped method", () => {
    expect(labelSkipReason(order({ sendcloudOptionCode: null }))).toBe("RATE_NOT_MAPPED");
    expect(labelSkipReason(order({ sendcloudOptionCode: "  " }))).toBe("RATE_NOT_MAPPED");
  });

  it("refuses a missing or zero parcel weight", () => {
    expect(labelSkipReason(order({ parcelWeightGrams: null }))).toBe("WEIGHT_MISSING");
    expect(labelSkipReason(order({ parcelWeightGrams: 0 }))).toBe("WEIGHT_MISSING");
  });
});

describe("externalReferenceFor", () => {
  const ORDER = "6f1b3c2a-8a4e-4a55-9a51-0f0f5b1c7d11";

  it("is the order id for the first attempt", () => {
    expect(externalReferenceFor(ORDER, [])).toBe(ORDER);
  });

  it("ignores manual shipments and live labels", () => {
    expect(
      externalReferenceFor(ORDER, [
        { provider: "MANUAL", status: "CANCELLED" },
        { provider: "SENDCLOUD", status: "LABEL_CREATED" },
      ]),
    ).toBe(ORDER);
  });

  it("moves on after each cancelled or failed Sendcloud attempt", () => {
    expect(externalReferenceFor(ORDER, [{ provider: "SENDCLOUD", status: "CANCELLED" }])).toBe(
      `${ORDER}:1`,
    );
    expect(
      externalReferenceFor(ORDER, [
        { provider: "SENDCLOUD", status: "FAILED" },
        { provider: "SENDCLOUD", status: "CANCELLED" },
      ]),
    ).toBe(`${ORDER}:2`);
  });
});
