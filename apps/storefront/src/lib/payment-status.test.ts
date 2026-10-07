import { describe, expect, it } from "vitest";

import type { OrderStatusResponse } from "@akai/contracts";

import { processingOutcome, wompiTransactionIdFrom } from "./payment-status";

function status(overrides: Partial<OrderStatusResponse>): OrderStatusResponse {
  return {
    orderNumber: "AK-2026-000123",
    status: "AWAITING_PAYMENT",
    isPaid: false,
    isTerminal: false,
    ...overrides,
  };
}

describe("processingOutcome", () => {
  it("keeps waiting while the order awaits payment", () => {
    expect(processingOutcome(status({}))).toBe("waiting");
  });

  it("shows paid once the money settled", () => {
    expect(processingOutcome(status({ status: "PAID", isPaid: true }))).toBe("paid");
  });

  it("never tells a PAYMENT_MISMATCH customer the payment failed — money may have moved", () => {
    expect(
      processingOutcome(status({ status: "PAYMENT_MISMATCH", isTerminal: true })),
    ).toBe("review");
  });

  it("shows failed for a declined order", () => {
    expect(processingOutcome(status({ status: "FAILED", isTerminal: true }))).toBe("failed");
  });
});

describe("wompiTransactionIdFrom", () => {
  it("accepts Wompi's documented id shape", () => {
    expect(wompiTransactionIdFrom("1234-1610641025-49201")).toBe("1234-1610641025-49201");
  });

  it("rejects anything that is not a plain id", () => {
    expect(wompiTransactionIdFrom(null)).toBeNull();
    expect(wompiTransactionIdFrom("")).toBeNull();
    expect(wompiTransactionIdFrom("../admin")).toBeNull();
    expect(wompiTransactionIdFrom("<script>")).toBeNull();
    expect(wompiTransactionIdFrom("a".repeat(65))).toBeNull();
  });
});
