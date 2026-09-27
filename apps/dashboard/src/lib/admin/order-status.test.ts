import { describe, expect, it } from "vitest";
import { ORDER_STATUS_TRANSITIONS, type OrderStatus } from "@akai/contracts";
import { STATUS_TONE } from "@/lib/status";
import {
  ADMIN_ASSIGNABLE_STATUSES,
  adminTransitionOptions,
  canRefund,
  isTerminalStatus,
  remainingRefundable,
} from "./order-status";

describe("ADMIN_ASSIGNABLE_STATUSES", () => {
  it("pins the exact set an operator may assign", () => {
    // Pinned as a whole so that ADDING a member is a deliberate, reviewed act.
    // This list is duplicated from the API's state machine because a scope:web
    // project may not import from apps/api; the test is what keeps them equal.
    expect([...ADMIN_ASSIGNABLE_STATUSES].sort()).toEqual([
      "CANCELLED",
      "DELIVERED",
      "FULFILLING",
      "SHIPPED",
    ]);
  });

  it.each<[OrderStatus, string]>([
    ["PAID", "set only by a signature-verified provider webhook"],
    ["REFUNDED", "derived from the refund ledger"],
    ["PARTIALLY_REFUNDED", "derived from the refund ledger"],
    ["FAILED", "recorded by the payments module"],
    ["PENDING", "a paid order may not walk back to a pre-payment state"],
    ["AWAITING_PAYMENT", "a paid order may not walk back to a pre-payment state"],
  ])("never offers %s — %s", (status) => {
    expect(ADMIN_ASSIGNABLE_STATUSES).not.toContain(status);

    // And prove it via the function the UI actually calls, from every origin.
    for (const from of Object.keys(ORDER_STATUS_TRANSITIONS) as OrderStatus[]) {
      expect(adminTransitionOptions(from)).not.toContain(status);
    }
  });
});

describe("adminTransitionOptions", () => {
  it("offers only moves that are BOTH legal and operator-assignable", () => {
    // PAID legally reaches FULFILLING, CANCELLED, REFUNDED and
    // PARTIALLY_REFUNDED. The two refund states are ledger-derived, so an
    // operator sees two options, not four.
    expect(adminTransitionOptions("PAID")).toEqual(["FULFILLING", "CANCELLED"]);
  });

  it("narrows as the order advances", () => {
    expect(adminTransitionOptions("FULFILLING")).toEqual(["SHIPPED", "CANCELLED"]);
    expect(adminTransitionOptions("SHIPPED")).toEqual(["DELIVERED"]);
  });

  it("offers nothing from a terminal status", () => {
    expect(adminTransitionOptions("CANCELLED")).toEqual([]);
    expect(adminTransitionOptions("REFUNDED")).toEqual([]);
    expect(adminTransitionOptions("FAILED")).toEqual([]);
  });

  it("offers nothing before payment, where every legal move is system-owned", () => {
    // PENDING and AWAITING_PAYMENT lead only to PAID/CANCELLED/FAILED. CANCELLED
    // is assignable in the abstract but cancelling an unpaid order is the
    // checkout/expiry system's job, so the state machine's own table is what
    // decides — we assert whatever it yields rather than hardcoding a guess.
    for (const from of ["PENDING", "AWAITING_PAYMENT"] as const) {
      for (const option of adminTransitionOptions(from)) {
        expect(ORDER_STATUS_TRANSITIONS[from]).toContain(option);
        expect(ADMIN_ASSIGNABLE_STATUSES).toContain(option);
      }
    }
  });

  it("never returns a status the state machine would reject", () => {
    // The invariant behind the whole file: every option we render must be a
    // legal transition, or the dropdown is offering a guaranteed 409.
    for (const from of Object.keys(ORDER_STATUS_TRANSITIONS) as OrderStatus[]) {
      for (const to of adminTransitionOptions(from)) {
        expect(ORDER_STATUS_TRANSITIONS[from]).toContain(to);
      }
    }
  });
});

describe("isTerminalStatus", () => {
  it("identifies the states nothing leaves", () => {
    expect(isTerminalStatus("CANCELLED")).toBe(true);
    expect(isTerminalStatus("REFUNDED")).toBe(true);
    expect(isTerminalStatus("FAILED")).toBe(true);
  });

  it("does not mark PARTIALLY_REFUNDED terminal — it can still reach REFUNDED", () => {
    expect(isTerminalStatus("PARTIALLY_REFUNDED")).toBe(false);
  });

  it("does not mark an in-flight order terminal", () => {
    expect(isTerminalStatus("PAID")).toBe(false);
    expect(isTerminalStatus("DELIVERED")).toBe(false);
  });
});

describe("remainingRefundable", () => {
  it("subtracts what has already been refunded", () => {
    expect(remainingRefundable(10_000, 2_500)).toBe(7_500);
  });

  it("floors at zero rather than returning a negative balance", () => {
    // A negative here would render as a nonsense "refund up to -€5.00" hint.
    expect(remainingRefundable(10_000, 12_000)).toBe(0);
  });
});

describe("canRefund", () => {
  it("allows a refund against every settled status with a balance left", () => {
    for (const status of [
      "PAID",
      "FULFILLING",
      "SHIPPED",
      "DELIVERED",
      "PARTIALLY_REFUNDED",
    ] as const) {
      expect(canRefund(status, 5_000)).toBe(true);
    }
  });

  it("refuses once the order is fully refunded", () => {
    expect(canRefund("REFUNDED", 0)).toBe(false);
    expect(canRefund("PAID", 0)).toBe(false);
  });

  it("refuses before the money has settled", () => {
    // Refunding an unpaid order would ask the provider to reverse a charge that does
    // not exist.
    expect(canRefund("PENDING", 5_000)).toBe(false);
    expect(canRefund("AWAITING_PAYMENT", 5_000)).toBe(false);
    expect(canRefund("FAILED", 5_000)).toBe(false);
    expect(canRefund("CANCELLED", 5_000)).toBe(false);
  });
});

describe("the order tone table", () => {
  /*
   * The map itself moved to `lib/status`, where `index.test.ts` is now its
   * primary guard. This block stays because it asks a question that file
   * cannot: that the tone table covers every status THE TRANSITION MACHINE
   * knows about. `lib/status` walks `orderStatusSchema`; this walks the keys of
   * `ORDER_STATUS_TRANSITIONS`, which is what actually drives the dropdown
   * below — so a status reachable by a transition but absent from the badge
   * table fails here even if the two enums ever drift.
   */
  it("covers every status the transition machine can reach", () => {
    for (const status of Object.keys(ORDER_STATUS_TRANSITIONS) as OrderStatus[]) {
      expect(STATUS_TONE.order[status]).toBeDefined();
    }
  });

  it("gives PAYMENT_MISMATCH the loudest treatment in the product", () => {
    // Was `danger` when this map lived beside the transition rules, sharing a
    // tone with REFUNDED and FAILED. `attention` is the redesign's answer: a
    // frozen order with money possibly moved for the wrong amount is the one
    // row an operator must rule on before anything else on the page.
    expect(STATUS_TONE.order.PAYMENT_MISMATCH).toBe("attention");
    expect(STATUS_TONE.order.AWAITING_PAYMENT).not.toBe("attention");
  });
});
