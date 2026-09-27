import { describe, expect, it } from "vitest";
import { toMinor } from "@akai/money";
import { calculateTotals, type TotalsLine } from "./cart-totals";

const EUR = "EUR";

function line(overrides: Partial<TotalsLine> = {}): TotalsLine {
  return {
    quantity: 1,
    unitPriceGross: toMinor(1000),
    taxRateBps: 2100,
    countsTowardTotals: true,
    ...overrides,
  };
}

describe("calculateTotals", () => {
  it("sums line gross into the subtotal using integer minor units", () => {
    const totals = calculateTotals({
      currency: EUR,
      lines: [
        line({ unitPriceGross: toMinor(4999), quantity: 2 }),
        line({ unitPriceGross: toMinor(1250), quantity: 3 }),
      ],
      discountTotal: toMinor(0),
      shippingTotal: toMinor(0),
    });

    expect(totals.subtotal).toBe(4999 * 2 + 1250 * 3);
    expect(Number.isInteger(totals.subtotal)).toBe(true);
  });

  /**
   * THE regression test for this module.
   *
   * EU display prices are VAT-inclusive, so tax is already inside the subtotal.
   * Adding taxTotal into grandTotal charges the VAT twice — a 21% overcharge
   * that looks entirely plausible on an invoice and is caught by nobody until a
   * customer complains.
   */
  it("does NOT add tax on top of a VAT-inclusive subtotal", () => {
    const totals = calculateTotals({
      currency: EUR,
      lines: [line({ unitPriceGross: toMinor(12_100), quantity: 1, taxRateBps: 2100 })],
      discountTotal: toMinor(0),
      shippingTotal: toMinor(0),
    });

    expect(totals.grandTotal).toBe(12_100);
    expect(totals.grandTotal).toBe(totals.subtotal);
    expect(totals.grandTotal).not.toBe(totals.subtotal + totals.taxTotal);

    // 12100 gross at 21% = 10000 net + 2100 tax.
    expect(totals.taxTotal).toBe(2100);
  });

  it("derives tax per line so mixed tax rates are respected", () => {
    const totals = calculateTotals({
      currency: EUR,
      lines: [
        line({ unitPriceGross: toMinor(12_100), taxRateBps: 2100 }),
        line({ unitPriceGross: toMinor(10_400), taxRateBps: 400 }),
      ],
      discountTotal: toMinor(0),
      shippingTotal: toMinor(0),
    });

    // 2100 + 400 — computing tax once over the combined subtotal at either rate
    // would produce a different, wrong number.
    expect(totals.taxTotal).toBe(2500);
  });

  it("clamps a discount larger than the basket instead of going negative", () => {
    const totals = calculateTotals({
      currency: EUR,
      lines: [line({ unitPriceGross: toMinor(1000) })],
      discountTotal: toMinor(50_000),
      shippingTotal: toMinor(0),
    });

    expect(totals.discountTotal).toBe(1000);
    expect(totals.grandTotal).toBe(0);
    expect(totals.grandTotal).toBeGreaterThanOrEqual(0);
  });

  it("recomputes tax from the DISCOUNTED gross, not the original", () => {
    const undiscounted = calculateTotals({
      currency: EUR,
      lines: [line({ unitPriceGross: toMinor(12_100), taxRateBps: 2100 })],
      discountTotal: toMinor(0),
      shippingTotal: toMinor(0),
    });

    const discounted = calculateTotals({
      currency: EUR,
      lines: [line({ unitPriceGross: toMinor(12_100), taxRateBps: 2100 })],
      discountTotal: toMinor(1210),
      shippingTotal: toMinor(0),
    });

    expect(discounted.taxTotal).toBeLessThan(undiscounted.taxTotal);
    // 10890 gross at 21% => 1890 tax.
    expect(discounted.taxTotal).toBe(1890);
  });

  /**
   * The remainder-distributing allocator exists for exactly this: three lines
   * cannot each take a third of a cent, and naive rounding either loses or
   * invents one.
   */
  it("allocates a discount across lines losing no cent", () => {
    const totals = calculateTotals({
      currency: EUR,
      lines: [
        line({ unitPriceGross: toMinor(1000) }),
        line({ unitPriceGross: toMinor(1000) }),
        line({ unitPriceGross: toMinor(1000) }),
      ],
      discountTotal: toMinor(1000),
      shippingTotal: toMinor(0),
    });

    expect(totals.subtotal).toBe(3000);
    expect(totals.discountTotal).toBe(1000);
    expect(totals.grandTotal).toBe(2000);
  });

  it("excludes non-chargeable lines from every total", () => {
    const totals = calculateTotals({
      currency: EUR,
      lines: [
        line({ unitPriceGross: toMinor(1000), countsTowardTotals: true }),
        line({ unitPriceGross: toMinor(9999), countsTowardTotals: false }),
      ],
      discountTotal: toMinor(0),
      shippingTotal: toMinor(0),
    });

    expect(totals.subtotal).toBe(1000);
    expect(totals.grandTotal).toBe(1000);
  });

  it("adds shipping to the grand total but not to the subtotal", () => {
    const totals = calculateTotals({
      currency: EUR,
      lines: [line({ unitPriceGross: toMinor(1000) })],
      discountTotal: toMinor(0),
      shippingTotal: toMinor(495),
    });

    expect(totals.subtotal).toBe(1000);
    expect(totals.shippingTotal).toBe(495);
    expect(totals.grandTotal).toBe(1495);
  });

  it("handles an empty cart without throwing", () => {
    const totals = calculateTotals({
      currency: EUR,
      lines: [],
      discountTotal: toMinor(0),
      shippingTotal: toMinor(0),
    });

    expect(totals.subtotal).toBe(0);
    expect(totals.taxTotal).toBe(0);
    expect(totals.grandTotal).toBe(0);
  });

  /**
   * `allocate` throws when its ratios sum to zero. A basket of zero-priced
   * lines is reachable (free samples), so this must not be an exception path.
   */
  it("handles a zero-value basket without throwing in the allocator", () => {
    const totals = calculateTotals({
      currency: EUR,
      lines: [line({ unitPriceGross: toMinor(0), quantity: 3 })],
      discountTotal: toMinor(500),
      shippingTotal: toMinor(0),
    });

    expect(totals.subtotal).toBe(0);
    expect(totals.discountTotal).toBe(0);
    expect(totals.grandTotal).toBe(0);
  });
});
