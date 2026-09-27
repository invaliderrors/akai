import { describe, expect, it } from "vitest";
import type { Minor } from "@akai/contracts";
import { toMinor } from "@akai/money";

import { calculateDiscountAmount } from "./discount-calculator";

describe("calculateDiscountAmount", () => {
  it("applies PERCENTAGE as basis points, half-up", () => {
    // 10% of €49.99 = €4.999 → €5.00 (half-up).
    expect(calculateDiscountAmount({ type: "PERCENTAGE", value: 1000 }, toMinor(4999))).toBe(500);
  });

  it("applies FIXED_AMOUNT as minor units", () => {
    expect(calculateDiscountAmount({ type: "FIXED_AMOUNT", value: 500 }, toMinor(4999))).toBe(500);
  });

  it("caps a FIXED_AMOUNT discount at the subtotal", () => {
    // €50 off a €30 basket removes €30, never more — no negative line.
    expect(calculateDiscountAmount({ type: "FIXED_AMOUNT", value: 5000 }, toMinor(3000))).toBe(3000);
  });

  it("caps a PERCENTAGE over 100% at the subtotal", () => {
    expect(calculateDiscountAmount({ type: "PERCENTAGE", value: 15_000 }, toMinor(3000))).toBe(3000);
  });

  it("treats FREE_SHIPPING as no subtotal discount", () => {
    expect(calculateDiscountAmount({ type: "FREE_SHIPPING", value: 0 }, toMinor(3000))).toBe(0);
  });

  it("returns zero for a 0% code", () => {
    expect(calculateDiscountAmount({ type: "PERCENTAGE", value: 0 }, toMinor(3000))).toBe(0);
  });

  it("rejects a negative value rather than discounting by it", () => {
    expect(() => calculateDiscountAmount({ type: "FIXED_AMOUNT", value: -100 }, toMinor(3000))).toThrow(
      RangeError,
    );
  });

  it("rejects a non-integer value", () => {
    expect(() => calculateDiscountAmount({ type: "PERCENTAGE", value: 10.5 }, toMinor(3000))).toThrow(
      RangeError,
    );
  });

  it("returns a branded Minor", () => {
    const amount: Minor = calculateDiscountAmount({ type: "FIXED_AMOUNT", value: 500 }, toMinor(4999));
    expect(amount).toBe(500);
  });
});
