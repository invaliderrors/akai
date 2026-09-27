import { ORDER_STATUS_TRANSITIONS, type OrderStatus } from "@akai/contracts";
import { describe, expect, it } from "vitest";

import {
  IllegalOrderTransitionError,
  TransitionTableOrderState,
  isRedundantTransition,
} from "./order-state.port";

const state = new TransitionTableOrderState();

describe("TransitionTableOrderState", () => {
  it("permits every transition the shared table declares legal", () => {
    for (const [from, targets] of Object.entries(ORDER_STATUS_TRANSITIONS)) {
      for (const to of targets) {
        expect(() =>
          state.assertTransition(from as OrderStatus, to),
        ).not.toThrow();
      }
    }
  });

  it("throws rather than coercing an illegal transition", () => {
    // The case that matters: a late provider event trying to walk a refunded
    // order back to PAID. Coercion here silently un-refunds a customer.
    expect(() => state.assertTransition("REFUNDED", "PAID")).toThrow(
      IllegalOrderTransitionError,
    );
  });

  it("treats terminal states as terminal", () => {
    for (const terminal of ["CANCELLED", "REFUNDED", "FAILED"] as const) {
      expect(ORDER_STATUS_TRANSITIONS[terminal]).toEqual([]);
      expect(() => state.assertTransition(terminal, "PAID")).toThrow(
        IllegalOrderTransitionError,
      );
    }
  });

  it("does not allow AWAITING_PAYMENT to skip straight to SHIPPED", () => {
    expect(() => state.assertTransition("AWAITING_PAYMENT", "SHIPPED")).toThrow(
      IllegalOrderTransitionError,
    );
  });
});

describe("isRedundantTransition", () => {
  it("treats a repeat of the current state as a no-op", () => {
    // checkout.session.completed and payment_intent.succeeded both want PAID and
    // carry DIFFERENT event ids, so the dedupe table does not collapse them.
    expect(isRedundantTransition("PAID", "PAID")).toBe(true);
  });

  it("ignores a late PAID for an order that has already been refunded", () => {
    expect(isRedundantTransition("REFUNDED", "PAID")).toBe(true);
    expect(isRedundantTransition("PARTIALLY_REFUNDED", "PAID")).toBe(true);
    expect(isRedundantTransition("CANCELLED", "PAID")).toBe(true);
  });

  it("ignores a stale failure for an order that demonstrably paid", () => {
    for (const status of ["PAID", "FULFILLING", "SHIPPED", "DELIVERED"] as const) {
      expect(isRedundantTransition(status, "FAILED")).toBe(true);
    }
  });

  it("ignores a late settlement for an order already paid or beyond", () => {
    // A provider can deliver two settlement events for one settlement, under
    // distinct event ids the dedupe table cannot collapse, and applyPaid enqueues
    // fulfilment in the same transaction — so the second event can land while the order
    // is already FULFILLING/SHIPPED/DELIVERED. Those have no edge back to PAID, so this
    // must read as redundant rather than throw a 500 the provider retries forever.
    for (const status of ["FULFILLING", "SHIPPED", "DELIVERED"] as const) {
      expect(isRedundantTransition(status, "PAID")).toBe(true);
    }
  });

  it("ignores a late PAYMENT_MISMATCH for an order that has already left the pre-settlement states", () => {
    // A second settlement event carrying no amount targets PAYMENT_MISMATCH. If the order
    // is already resolved it must be a no-op, not an illegal PAID -> PAYMENT_MISMATCH
    // (which throws and 500s the webhook into an endless retry). PAID has no edge to
    // PAYMENT_MISMATCH, so this MUST be caught here rather than at the transition table.
    for (const status of [
      "PAID",
      "FULFILLING",
      "SHIPPED",
      "DELIVERED",
      "REFUNDED",
      "PARTIALLY_REFUNDED",
      "CANCELLED",
      "FAILED",
    ] as const) {
      expect(isRedundantTransition(status, "PAYMENT_MISMATCH")).toBe(true);
    }
  });

  it("still lets a genuine PAYMENT_MISMATCH enter from the pre-settlement states", () => {
    expect(isRedundantTransition("PENDING", "PAYMENT_MISMATCH")).toBe(false);
    expect(isRedundantTransition("AWAITING_PAYMENT", "PAYMENT_MISMATCH")).toBe(false);
  });

  it("does NOT mask a genuine transition", () => {
    expect(isRedundantTransition("AWAITING_PAYMENT", "PAID")).toBe(false);
    expect(isRedundantTransition("PENDING", "FAILED")).toBe(false);
    expect(isRedundantTransition("PAID", "REFUNDED")).toBe(false);
  });

  it("does not let a cancellation quietly apply to a paid order", () => {
    // This one must NOT be redundant — it has to reach assertTransition and
    // throw, so the webhook lands in the DLQ for a human instead of silently
    // cancelling an order that has money against it.
    expect(isRedundantTransition("PAID", "CANCELLED")).toBe(false);
  });
});
