import { describe, expect, it } from "vitest";
import { toMinor } from "@akai/money";

import {
  qualifyingSubtotal,
  sharedFreeShippingThreshold,
} from "./free-shipping";

describe("qualifyingSubtotal — the ONE basis a free-shipping threshold is measured against", () => {
  it("is the counted gross subtotal AFTER the discount (D3a)", () => {
    // A €260 basket with a €20 coupon is a €240 order: it must not qualify for
    // a €250 threshold, however large it looked before the coupon.
    expect(
      qualifyingSubtotal({ subtotal: toMinor(26_000), discountTotal: toMinor(2_000) }),
    ).toBe(24_000);
  });

  it("is the subtotal unchanged when no discount applies", () => {
    expect(qualifyingSubtotal({ subtotal: toMinor(25_000), discountTotal: toMinor(0) })).toBe(
      25_000,
    );
  });

  it("never goes negative, even on a discount larger than the basket", () => {
    expect(qualifyingSubtotal({ subtotal: toMinor(1_000), discountTotal: toMinor(5_000) })).toBe(
      0,
    );
  });
});

describe("sharedFreeShippingThreshold — the destination-independent threshold", () => {
  it("is the threshold when every active rate carries the same one", () => {
    expect(
      sharedFreeShippingThreshold([{ freeOverSubtotal: 25_000, currency: "EUR" }, { freeOverSubtotal: 25_000, currency: "EUR" }]),
    ).toEqual({ amount: 25_000, currency: "EUR" });
  });

  it("is null when two rates share an amount but not a currency", () => {
    expect(
      sharedFreeShippingThreshold([
        { freeOverSubtotal: 25_000, currency: "EUR" },
        { freeOverSubtotal: 25_000, currency: "GBP" },
      ]),
    ).toBeNull();
  });

  it("is null when any rate has no threshold — free shipping is not universal", () => {
    expect(
      sharedFreeShippingThreshold([{ freeOverSubtotal: 25_000, currency: "EUR" }, { freeOverSubtotal: null, currency: "EUR" }]),
    ).toBeNull();
  });

  it("is null when rates disagree — no single number can be promised before a destination is known", () => {
    expect(
      sharedFreeShippingThreshold([{ freeOverSubtotal: 25_000, currency: "EUR" }, { freeOverSubtotal: 30_000, currency: "EUR" }]),
    ).toBeNull();
  });

  it("is null when there are no rates at all", () => {
    expect(sharedFreeShippingThreshold([])).toBeNull();
  });
});
