import { describe, expect, it } from "vitest";

import { adminDiscountSchema, type AdminDiscount } from "./schemas";

import { formatValue, resolveState } from "./discount-display";

/**
 * The two pure helpers behind the coupon list, neither of which had a test.
 *
 * `resolveState` decides the badge an operator reads to know whether a coupon is
 * live, and its branches are a PRECEDENCE chain — an archived-and-expired code
 * must read ARCHIVED, not EXPIRED — so the order is the behaviour, and reordering
 * two `if`s is a silent change.
 *
 * `formatValue` is the single place the `value` overload is resolved for display:
 * basis points for PERCENTAGE, minor units for FIXED_AMOUNT. Reading one as the
 * other is a factor-of-a-hundred misread on a number an operator edits.
 *
 * Fixtures PARSE through `adminDiscountSchema` rather than being cast, so a
 * fixture that drifts from the contract fails here instead of passing against a
 * shape the API cannot send.
 */

const NOW = Date.parse("2026-06-15T12:00:00.000Z");

function discount(overrides: Record<string, unknown> = {}): AdminDiscount {
  return adminDiscountSchema.parse({
    id: "8f1f2c1e-1f3a-4c6e-9b2a-2f7f5c4d3e21",
    code: "SUMMER10",
    type: "PERCENTAGE",
    value: 1000,
    minimumSubtotal: null,
    currency: "EUR",
    maxRedemptions: null,
    maxRedemptionsPerCustomer: null,
    timesRedeemed: 0,
    remainingRedemptions: null,
    stackable: false,
    startsAt: null,
    endsAt: null,
    affiliateId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  });
}

describe("resolveState", () => {
  it("is ACTIVE for an uncapped code inside its window", () => {
    expect(resolveState(discount(), NOW)).toBe("ACTIVE");
  });

  it("is SCHEDULED before startsAt", () => {
    expect(resolveState(discount({ startsAt: "2026-07-01T00:00:00.000Z" }), NOW)).toBe(
      "SCHEDULED",
    );
  });

  it("is EXPIRED once endsAt has passed", () => {
    expect(resolveState(discount({ endsAt: "2026-06-01T00:00:00.000Z" }), NOW)).toBe("EXPIRED");
  });

  it("treats endsAt as INCLUSIVE of the exact boundary instant", () => {
    // `<= now`, so a code ending exactly now is already spent, not still live.
    expect(resolveState(discount({ endsAt: "2026-06-15T12:00:00.000Z" }), NOW)).toBe("EXPIRED");
  });

  it("is EXHAUSTED when no redemptions remain", () => {
    expect(resolveState(discount({ remainingRedemptions: 0 }), NOW)).toBe("EXHAUSTED");
  });

  it("does NOT read remainingRedemptions: null as exhausted", () => {
    // null means uncapped. Treating it as 0 would grey out every unlimited code.
    expect(resolveState(discount({ remainingRedemptions: null }), NOW)).toBe("ACTIVE");
  });

  describe("precedence", () => {
    it("ARCHIVED outranks EXPIRED", () => {
      const archivedAndExpired = discount({
        deletedAt: "2026-05-01T00:00:00.000Z",
        endsAt: "2026-06-01T00:00:00.000Z",
      });
      expect(resolveState(archivedAndExpired, NOW)).toBe("ARCHIVED");
    });

    it("EXPIRED outranks EXHAUSTED", () => {
      const expiredAndExhausted = discount({
        endsAt: "2026-06-01T00:00:00.000Z",
        remainingRedemptions: 0,
      });
      expect(resolveState(expiredAndExhausted, NOW)).toBe("EXPIRED");
    });

    it("EXPIRED outranks SCHEDULED for a window that is inverted", () => {
      const inverted = discount({
        startsAt: "2026-07-01T00:00:00.000Z",
        endsAt: "2026-06-01T00:00:00.000Z",
      });
      expect(resolveState(inverted, NOW)).toBe("EXPIRED");
    });
  });
});

describe("formatValue", () => {
  it("renders PERCENTAGE from BASIS POINTS, not as a raw integer", () => {
    // 1000 basis points is 10%. Rendering "1000%" or "€10.00" here is the
    // hundred-fold misread this function exists to prevent.
    const formatted = formatValue(discount({ type: "PERCENTAGE", value: 1000 }), "en");
    expect(formatted).toContain("10");
    expect(formatted).toContain("%");
    expect(formatted).not.toContain("1000");
  });

  it("keeps sub-percent precision", () => {
    expect(formatValue(discount({ type: "PERCENTAGE", value: 1050 }), "en")).toContain("10.5");
  });

  it("renders FIXED_AMOUNT as money from MINOR units", () => {
    const formatted = formatValue(
      discount({ type: "FIXED_AMOUNT", value: 1000, currency: "EUR" }),
      "en",
    );
    // 1000 minor units is €10.00 — the SAME integer that means 10% above.
    expect(formatted).toContain("10");
    expect(formatted).not.toContain("%");
  });

  it("renders FREE_SHIPPING as a dash, because its value is unused", () => {
    expect(formatValue(discount({ type: "FREE_SHIPPING", value: 0 }), "en")).toBe("—");
  });

  it("degrades an out-of-range FIXED_AMOUNT to its raw integer instead of throwing", () => {
    // isMinor narrows rather than asserting: one bad row must not 500 the list.
    const formatted = formatValue(
      discount({ type: "FIXED_AMOUNT", value: Number.MAX_SAFE_INTEGER }),
      "en",
    );
    expect(formatted).toBe(String(Number.MAX_SAFE_INTEGER));
  });
});
