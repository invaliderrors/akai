import { describe, expect, it } from "vitest";

import { reportedAmountSchema, whopPaymentPayloadSchema } from "./whop-webhook.schemas";

/**
 * `reportedAmountSchema` is what stood between a real 2026-09-16 production
 * incident and two orders that should have settled. These tests pin its
 * three-shape contract directly, independent of the service-level coverage
 * in `whop-webhook.service.test.ts`.
 */
describe("reportedAmountSchema", () => {
  it("normalizes a legacy bare number to its exact decimal string", () => {
    expect(reportedAmountSchema.parse(49.99)).toBe("49.99");
  });

  it("normalizes a Money envelope to its amount string, unchanged", () => {
    expect(
      reportedAmountSchema.parse({
        amount: "49.99",
        currency: "eur",
        decimals: 2,
        display_decimals: 2,
      }),
    ).toBe("49.99");
  });

  it("is IDEMPOTENT — re-parsing its own output returns the same string", () => {
    // `verifySettlement` re-parses `event.data.total` a second time (through
    // `settlementSchema`) to enforce presence, not to reshape it again. By
    // then the value is already this schema's own string output. Without
    // this branch that second parse fails outright — a real regression this
    // test exists to pin.
    const once = reportedAmountSchema.parse(49.99);
    expect(reportedAmountSchema.parse(once)).toBe(once);
  });

  it("passes through a Money envelope's extra fields without asserting their shape", () => {
    // Vendor-owned shape — only `amount` is read. A vendor-added field, or
    // one this test gets slightly wrong, must not turn into a rejection.
    expect(
      reportedAmountSchema.parse({ amount: "10.00", currency: "eur", somethingNew: true }),
    ).toBe("10.00");
  });

  it("rejects a Money envelope missing amount", () => {
    expect(reportedAmountSchema.safeParse({ currency: "eur" }).success).toBe(false);
  });

  it("rejects a non-finite number", () => {
    expect(reportedAmountSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(reportedAmountSchema.safeParse(Number.NaN).success).toBe(false);
  });

  it("rejects shapes that are neither a number, a Money envelope, nor a string", () => {
    expect(reportedAmountSchema.safeParse(null).success).toBe(false);
    expect(reportedAmountSchema.safeParse([49.99]).success).toBe(false);
    expect(reportedAmountSchema.safeParse({ amount: 49.99 }).success).toBe(false);
  });
});

describe("whopPaymentPayloadSchema — total/refunded_amount through the real payload", () => {
  it("accepts both shapes on the same payload independently", () => {
    const parsed = whopPaymentPayloadSchema.parse({
      total: 49.99,
      refunded_amount: { amount: "10.00", currency: "eur", decimals: 2, display_decimals: 2 },
    });

    expect(parsed.total).toBe("49.99");
    expect(parsed.refunded_amount).toBe("10.00");
  });
});
