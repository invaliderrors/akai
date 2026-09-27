import { describe, expect, it } from "vitest";
import { canTransitionReturn, isReturnOpen, RETURN_TRANSITIONS, returnStatusSchema } from "@akai/contracts";

/**
 * The return state machine.
 *
 * The map is CLOSED on purpose. Without it an operator could walk a REJECTED
 * request straight to REFUNDED and issue money against a decision that was never
 * approved — the status dropdown would be the only thing standing between a
 * mis-click and a bank movement.
 */

describe("RETURN_TRANSITIONS", () => {
  it("covers every status, so a new one cannot be silently unreachable", () => {
    for (const status of returnStatusSchema.options) {
      expect(RETURN_TRANSITIONS[status]).toBeDefined();
    }
  });

  it("allows the ordinary happy path", () => {
    expect(canTransitionReturn("REQUESTED", "APPROVED")).toBe(true);
    expect(canTransitionReturn("APPROVED", "IN_TRANSIT")).toBe(true);
    expect(canTransitionReturn("IN_TRANSIT", "RECEIVED")).toBe(true);
    expect(canTransitionReturn("RECEIVED", "REFUNDED")).toBe(true);
  });

  it("REFUSES a refund on a rejected request", () => {
    // The transition this map exists to prevent.
    expect(canTransitionReturn("REJECTED", "REFUNDED")).toBe(false);
  });

  it("refuses skipping straight from REQUESTED to REFUNDED", () => {
    expect(canTransitionReturn("REQUESTED", "REFUNDED")).toBe(false);
  });

  it("refuses moving backwards", () => {
    expect(canTransitionReturn("RECEIVED", "APPROVED")).toBe(false);
    expect(canTransitionReturn("APPROVED", "REQUESTED")).toBe(false);
  });

  it("treats REFUNDED and REJECTED as terminal", () => {
    expect(RETURN_TRANSITIONS.REFUNDED).toHaveLength(0);
    expect(RETURN_TRANSITIONS.REJECTED).toHaveLength(0);
    for (const status of returnStatusSchema.options) {
      expect(canTransitionReturn("REFUNDED", status)).toBe(false);
    }
  });

  it("lets an approved request still be rejected", () => {
    // Approving is not irreversible — the parcel may never arrive, or arrive
    // outside policy. Only refunding is.
    expect(canTransitionReturn("APPROVED", "REJECTED")).toBe(true);
  });
});

describe("isReturnOpen", () => {
  it("is true while the request can still move", () => {
    expect(isReturnOpen("REQUESTED")).toBe(true);
    expect(isReturnOpen("APPROVED")).toBe(true);
    expect(isReturnOpen("IN_TRANSIT")).toBe(true);
    expect(isReturnOpen("RECEIVED")).toBe(true);
  });

  it("is false once it is finished, which is what gates a second request", () => {
    expect(isReturnOpen("REFUNDED")).toBe(false);
    expect(isReturnOpen("REJECTED")).toBe(false);
  });
});
