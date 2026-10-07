import { ForbiddenException } from "@nestjs/common";
import { ORDER_STATUS_TRANSITIONS, type OrderStatus } from "@akai/contracts";
import { describe, expect, it } from "vitest";

import {
  ADMIN_ASSIGNABLE_STATUSES,
  IllegalOrderTransitionError,
  StatusNotAdminAssignableError,
  assertAdminMayAssign,
  assertTransition,
  canTransition,
  isPaidStatus,
  isTerminal,
  statusAfterRefund,
} from "./order-status.machine";

const ALL_STATUSES = Object.keys(ORDER_STATUS_TRANSITIONS) as OrderStatus[];

describe("order state machine", () => {
  it("permits every edge the contract table declares", () => {
    for (const from of ALL_STATUSES) {
      for (const to of ORDER_STATUS_TRANSITIONS[from]) {
        expect(canTransition(from, to)).toBe(true);
        expect(() => assertTransition(from, to)).not.toThrow();
      }
    }
  });

  /**
   * The complement of the previous test, and the more important one: it asserts
   * that EVERY pair not in the table is refused. A machine that permits its
   * declared edges is easy; one that refuses all 100 - n others is the thing
   * that actually stops a refunded order from becoming PAID again.
   */
  it("refuses every edge the contract table does not declare", () => {
    for (const from of ALL_STATUSES) {
      const legal = new Set<OrderStatus>(ORDER_STATUS_TRANSITIONS[from]);
      for (const to of ALL_STATUSES) {
        if (legal.has(to)) {
          continue;
        }
        expect(canTransition(from, to)).toBe(false);
        expect(() => assertTransition(from, to)).toThrow(IllegalOrderTransitionError);
      }
    }
  });

  it("refuses a self-transition, including the tempting no-op ones", () => {
    // PAID -> PAID looks harmless and is the shape a duplicate provider webhook
    // takes. It is refused so that idempotency is handled deliberately, in
    // markPaid, rather than by accidentally allowing every status to re-enter
    // itself and re-run its side effects (a second invoice number, a second
    // confirmation email).
    for (const status of ALL_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it("never allows escape from a terminal state", () => {
    for (const terminal of ["CANCELLED", "REFUNDED", "FAILED"] satisfies OrderStatus[]) {
      expect(isTerminal(terminal)).toBe(true);
      for (const to of ALL_STATUSES) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });

  it("lets a partially refunded order still become fully refunded", () => {
    // PARTIALLY_REFUNDED is the one near-terminal state with an exit, and the
    // exit is deliberately one-way.
    expect(isTerminal("PARTIALLY_REFUNDED")).toBe(false);
    expect(canTransition("PARTIALLY_REFUNDED", "REFUNDED")).toBe(true);
    expect(canTransition("PARTIALLY_REFUNDED", "SHIPPED")).toBe(false);
    expect(canTransition("PARTIALLY_REFUNDED", "PAID")).toBe(false);
  });

  it("reports paid-ness for every status that implies money settled", () => {
    expect(isPaidStatus("PAID")).toBe(true);
    expect(isPaidStatus("FULFILLING")).toBe(true);
    expect(isPaidStatus("SHIPPED")).toBe(true);
    expect(isPaidStatus("DELIVERED")).toBe(true);
    // A refunded order was unambiguously paid, and its invoice is still filed.
    expect(isPaidStatus("PARTIALLY_REFUNDED")).toBe(true);
    expect(isPaidStatus("REFUNDED")).toBe(true);

    expect(isPaidStatus("PENDING")).toBe(false);
    expect(isPaidStatus("AWAITING_PAYMENT")).toBe(false);
    expect(isPaidStatus("CANCELLED")).toBe(false);
    expect(isPaidStatus("FAILED")).toBe(false);
  });

  it("names the legal targets in the rejection message", () => {
    // The operator reading this 409 needs to know what they CAN do next;
    // "illegal transition" alone sends them to the source.
    try {
      assertTransition("PAID", "PENDING");
      expect.unreachable("PAID -> PENDING must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalOrderTransitionError);
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("PAID -> PENDING");
    }
  });
});

describe("operator-assignable statuses", () => {
  it("accepts the fulfilment statuses an operator legitimately drives", () => {
    for (const status of ADMIN_ASSIGNABLE_STATUSES) {
      expect(() => assertAdminMayAssign(status)).not.toThrow();
    }
    expect(ADMIN_ASSIGNABLE_STATUSES).toEqual([
      "FULFILLING",
      "SHIPPED",
      "DELIVERED",
      "CANCELLED",
    ]);
  });

  /**
   * THE security assertion of this file.
   *
   * An order becomes PAID only through a signature-verified provider webhook. If
   * an operator could set PAID by hand, then anyone who obtains a staff session
   * — phishing, a shared laptop, a disgruntled leaver whose access was not
   * revoked — can mark arbitrary orders paid and have them shipped for free.
   * The state machine is legal-transition-wise perfectly happy with
   * AWAITING_PAYMENT -> PAID, which is exactly why this second, separate gate
   * exists.
   */
  it("refuses PAID from an operator even though the transition itself is legal", () => {
    expect(canTransition("AWAITING_PAYMENT", "PAID")).toBe(true);
    expect(() => assertAdminMayAssign("PAID")).toThrow(StatusNotAdminAssignableError);
    expect(() => assertAdminMayAssign("PAID")).toThrow(ForbiddenException);
  });

  it("refuses the refund statuses, which are derived from the refund ledger", () => {
    expect(() => assertAdminMayAssign("REFUNDED")).toThrow(StatusNotAdminAssignableError);
    expect(() => assertAdminMayAssign("PARTIALLY_REFUNDED")).toThrow(
      StatusNotAdminAssignableError,
    );
  });

  it("refuses payment-owned and backwards statuses", () => {
    for (const status of ["FAILED", "PENDING", "AWAITING_PAYMENT"] satisfies OrderStatus[]) {
      expect(() => assertAdminMayAssign(status)).toThrow(StatusNotAdminAssignableError);
    }
  });

  it("denies by default — every status is refused unless explicitly allowed", () => {
    // Written as a complement sweep so that a status ADDED to the enum later is
    // refused for operators until someone deliberately allow-lists it. The
    // failure mode of that direction is a locked-out operator; the failure mode
    // of the other direction is an open privileged surface.
    const allowed = new Set<OrderStatus>(ADMIN_ASSIGNABLE_STATUSES);
    for (const status of ALL_STATUSES) {
      if (allowed.has(status)) {
        continue;
      }
      expect(() => assertAdminMayAssign(status)).toThrow(StatusNotAdminAssignableError);
    }
  });
});

describe("statusAfterRefund", () => {
  it("is REFUNDED only when the whole order is covered", () => {
    expect(statusAfterRefund(5000, 5000)).toBe("REFUNDED");
    expect(statusAfterRefund(4999, 5000)).toBe("PARTIALLY_REFUNDED");
    expect(statusAfterRefund(1, 5000)).toBe("PARTIALLY_REFUNDED");
  });

  it("treats an over-refund as fully refunded rather than inventing a status", () => {
    // The amount guard lives in recordRefund, which refuses to over-refund at
    // all. Should one ever slip through, REFUNDED is the safe reading — the
    // customer has had at least their money back.
    expect(statusAfterRefund(5001, 5000)).toBe("REFUNDED");
  });
});
