import type { AdminOrder } from "@akai/contracts";
import { describe, expect, it } from "vitest";

import esMessages from "../../../messages/es.json";
import enMessages from "../../../messages/en.json";
import {
  SKIP_REASON_KEY,
  asShippingFilter,
  canCancelLabel,
  canGenerateLabel,
  canRetryLabel,
  labelErrorKey,
  labelFailureKey,
} from "./fulfilment-display";

type Shipment = AdminOrder["shipments"][number];

function shipment(overrides: Partial<Shipment> = {}): Shipment {
  const base: Shipment = {
    id: "0b9f6a52-6a8e-4d38-9c1e-5b1d7d9e2a10",
    carrier: "InPost",
    trackingNumber: null,
    trackingUrl: null,
    status: "LABEL_CREATED",
    shippedAt: null,
    deliveredAt: null,
    provider: "SENDCLOUD",
    hasLabel: true,
    providerStatusCode: null,
    failureReason: null,
    createdAt: null,
  };
  return { ...base, ...overrides };
}

const ELIGIBLE = {
  status: "PAID" as const,
  labelEligible: true,
  parcelWeightGrams: 750,
  shipments: [] as Shipment[],
};

/** Walk a dotted key through a messages object. */
function lookup(messages: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (typeof node !== "object" || node === null) {
      return undefined;
    }
    const value: unknown = Object.getOwnPropertyDescriptor(node, part)?.value;
    return value;
  }, messages);
}

describe("canGenerateLabel", () => {
  it("offers a label for a paid, mapped, weighed order with nothing shipping it", () => {
    expect(canGenerateLabel(ELIGIBLE)).toBe(true);
    expect(
      canGenerateLabel({ ...ELIGIBLE, status: "FULFILLING", shipments: [shipment({ status: "CANCELLED" })] }),
    ).toBe(true);
  });

  it.each([
    ["an active label", { shipments: [shipment()] }],
    ["an unpaid order", { status: "AWAITING_PAYMENT" as const }],
    ["an unmapped rate", { labelEligible: false }],
    ["no weight", { parcelWeightGrams: null }],
  ])("does not offer one for %s", (_label, overrides) => {
    expect(canGenerateLabel({ ...ELIGIBLE, ...overrides })).toBe(false);
  });
});

describe("cancel / retry", () => {
  it("cancels only an unscanned Sendcloud label; retries only a failed one", () => {
    expect(canCancelLabel(shipment())).toBe(true);
    expect(canCancelLabel(shipment({ status: "IN_TRANSIT" }))).toBe(false);
    expect(canCancelLabel(shipment({ provider: "MANUAL" }))).toBe(false);
    expect(canRetryLabel(shipment({ status: "FAILED" }))).toBe(true);
    expect(canRetryLabel(shipment())).toBe(false);
  });
});

describe("labelFailureKey", () => {
  it("prefers the domain reason, then the platform code — never the message", () => {
    expect(labelFailureKey("CONFLICT", "CANCEL_REJECTED")).toBe(
      "admin.fulfilment.reason.CANCEL_REJECTED",
    );
    expect(labelFailureKey("CONFLICT", "SOMETHING_NEW")).toBe("errors.CONFLICT");
    expect(labelFailureKey(null, null)).toBe("errors.generic");
    expect(labelFailureKey("UNPARSEABLE_RESPONSE", null)).toBe("errors.generic");
  });
});

describe("messages", () => {
  it.each([
    ["es", esMessages],
    ["en", enMessages],
  ])("%s has copy for every skip reason and every failure reason", (_locale, messages) => {
    for (const key of Object.values(SKIP_REASON_KEY)) {
      expect(typeof lookup(messages, key), key).toBe("string");
    }
    for (const reason of [
      "FULFILMENT_NOT_CONFIGURED",
      "VENDOR_UNAVAILABLE",
      "VENDOR_REJECTED",
      "CANCEL_REJECTED",
      "LABEL_NOT_AVAILABLE",
      "SERVICE_POINT_REQUIRED",
      "SERVICE_POINT_NOT_ALLOWED",
      "SERVICE_POINT_UNAVAILABLE",
    ]) {
      const key = labelFailureKey("CONFLICT", reason);
      expect(typeof lookup(messages, key), key).toBe("string");
    }
  });
});

describe("asShippingFilter", () => {
  it("narrows URL input to the four filters", () => {
    expect(asShippingFilter("NO_LABEL")).toBe("NO_LABEL");
    expect(asShippingFilter("ISSUE")).toBe("ISSUE");
    expect(asShippingFilter("nope")).toBeUndefined();
    expect(asShippingFilter(undefined)).toBeUndefined();
  });
});

describe("labelErrorKey", () => {
  it("maps a reason or a code from the URL onto our own copy, and nothing else", () => {
    expect(labelErrorKey("LABEL_NOT_AVAILABLE")).toBe("admin.fulfilment.reason.LABEL_NOT_AVAILABLE");
    expect(labelErrorKey("UNAUTHENTICATED")).toBe("errors.UNAUTHENTICATED");
    expect(labelErrorKey("<script>")).toBe("errors.generic");
    expect(labelErrorKey(undefined)).toBeNull();
  });
});
