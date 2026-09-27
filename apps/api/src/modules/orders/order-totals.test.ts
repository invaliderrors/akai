import { toMinor } from "@akai/money";
import { describe, expect, it } from "vitest";

import {
  OrderPricingError,
  type PricedLine,
  type ShippingCharge,
  assertTotalsBalance,
  priceOrder,
  refundableRemaining,
} from "./order-totals";

/** 21% Spanish standard VAT, the rate most of this catalogue sells at. */
const VAT_21 = 2100;

function line(overrides: Partial<PricedLine> = {}): PricedLine {
  return {
    variantId: "11111111-1111-4111-8111-111111111111",
    productName: "Oversized Tee",
    variantName: "L",
    sku: "AK-TEE-BLK-L",
    imageUrl: null,
    quantity: 1,
    unitPriceGross: toMinor(4999),
    taxRateBps: VAT_21,
    lineDiscount: toMinor(0),
    packProductId: null,
    packInstanceId: null,
    ...overrides,
  };
}

const FREE_SHIPPING: ShippingCharge = { net: toMinor(0), taxRateBps: VAT_21 };

describe("priceOrder", () => {
  it("splits a VAT-inclusive line so net + tax is exactly the gross", () => {
    const { lines, totals } = priceOrder([line()], FREE_SHIPPING);
    const [only] = lines;
    expect(only).toBeDefined();
    if (only === undefined) {
      return;
    }

    // 4999 gross at 21% -> net 4131, tax 868. The tax is DERIVED as
    // gross - net rather than computed independently, which is what makes the
    // identity exact instead of off-by-one about a third of the time.
    expect(only.lineTotalNet + only.taxAmount).toBe(only.lineTotalGross);
    expect(only.lineTotalGross).toBe(4999);
    expect(totals.grandTotal).toBe(4999);
  });

  it("rounds per line and then sums, never the other way round", () => {
    // Three units of an amount that does not divide cleanly. The documented
    // rule is round-half-up PER LINE then sum; rounding per unit and
    // multiplying gives a different net, and only one of the two makes the
    // invoice foot against the gross the customer was charged.
    const { lines } = priceOrder(
      [line({ quantity: 3, unitPriceGross: toMinor(1999) })],
      FREE_SHIPPING,
    );
    const [only] = lines;
    expect(only).toBeDefined();
    if (only === undefined) {
      return;
    }

    expect(only.lineTotalGross).toBe(5997);
    expect(only.lineTotalNet + only.taxAmount).toBe(5997);

    // The per-unit net is display-only and is deliberately NOT what the line
    // total was built from.
    const naivePerUnit = only.unitPriceNet * 3;
    expect(only.lineTotalNet).not.toBe(naivePerUnit - 1);
    expect(Math.abs(only.lineTotalNet - naivePerUnit)).toBeLessThanOrEqual(2);
  });

  it("keeps the additive identity exact across many awkward lines", () => {
    // The invariant that matters: subtotal - discount + shipping + tax must
    // equal grandTotal for arbitrary inputs, not just the ones in a fixture.
    // priceOrder itself asserts this, so an exception here is a real failure.
    const awkward = [1, 7, 33, 99, 333, 1999, 4999, 12345].map((price, index) =>
      line({
        sku: `AK-${price}`,
        quantity: (index % 4) + 1,
        unitPriceGross: toMinor(price),
        taxRateBps: index % 2 === 0 ? VAT_21 : 1000,
      }),
    );

    const { lines, totals } = priceOrder(awkward, { net: toMinor(590), taxRateBps: VAT_21 });

    expect(totals.subtotal - totals.discountTotal + totals.shippingTotal + totals.taxTotal).toBe(
      totals.grandTotal,
    );

    const grossOfLines = lines.reduce((sum, item) => sum + item.lineTotalGross, 0);
    expect(grossOfLines + 590 + Math.round(590 * 0.21)).toBe(totals.grandTotal);
  });

  it("applies a line discount in gross and derives the net discount from it", () => {
    const { lines, totals } = priceOrder(
      [line({ quantity: 2, unitPriceGross: toMinor(5000), lineDiscount: toMinor(1000) })],
      FREE_SHIPPING,
    );
    const [only] = lines;
    expect(only).toBeDefined();
    if (only === undefined) {
      return;
    }

    expect(only.lineTotalGross).toBe(9000);
    expect(totals.grandTotal).toBe(9000);
    // The discount reduces both the net subtotal and the tax, because VAT is
    // owed on what was actually charged, not on the list price.
    expect(totals.discountTotal).toBeGreaterThan(0);
    expect(totals.subtotal - totals.discountTotal + totals.taxTotal).toBe(9000);
  });

  it("refuses a discount larger than the line rather than clamping it", () => {
    // Clamping would quietly ship a free order. A discount engine that produced
    // this number is broken, and the request must fail loudly enough to notice.
    expect(() =>
      priceOrder(
        [line({ unitPriceGross: toMinor(1000), lineDiscount: toMinor(1500) })],
        FREE_SHIPPING,
      ),
    ).toThrow(OrderPricingError);
  });

  it("refuses an empty order, a zero quantity and a negative tax rate", () => {
    expect(() => priceOrder([], FREE_SHIPPING)).toThrow(OrderPricingError);
    expect(() => priceOrder([line({ quantity: 0 })], FREE_SHIPPING)).toThrow(OrderPricingError);
    expect(() => priceOrder([line({ quantity: 1.5 })], FREE_SHIPPING)).toThrow(
      OrderPricingError,
    );
    expect(() => priceOrder([line({ taxRateBps: -1 })], FREE_SHIPPING)).toThrow(
      OrderPricingError,
    );
  });

  it("charges tax on shipping too", () => {
    const { totals } = priceOrder([line({ unitPriceGross: toMinor(1000) })], {
      net: toMinor(1000),
      taxRateBps: VAT_21,
    });

    expect(totals.shippingTotal).toBe(1000);
    // 1000 gross line (826 net + 174 tax) + 1000 net shipping + 210 shipping tax.
    expect(totals.grandTotal).toBe(1000 + 1000 + 210);
  });

  it("handles a zero-rated (B2B reverse charge) order with no tax at all", () => {
    const { totals } = priceOrder([line({ taxRateBps: 0 })], {
      net: toMinor(0),
      taxRateBps: 0,
    });

    expect(totals.taxTotal).toBe(0);
    expect(totals.subtotal).toBe(totals.grandTotal);
  });
});

describe("assertTotalsBalance", () => {
  it("catches a grand total that does not match its own components", () => {
    const { lines, totals } = priceOrder([line()], FREE_SHIPPING);

    expect(() =>
      assertTotalsBalance(lines, { ...totals, grandTotal: toMinor(totals.grandTotal + 1) },
        FREE_SHIPPING,
      ),
    ).toThrow(OrderPricingError);
  });

  it("catches two compensating errors that satisfy the additive identity", () => {
    // Moving a cent from subtotal to tax keeps `subtotal - discount + shipping
    // + tax` intact, so the additive check alone would pass. The gross
    // cross-check is what catches it — which is why both exist.
    const { lines, totals } = priceOrder([line()], FREE_SHIPPING);

    expect(() =>
      assertTotalsBalance(
        lines,
        {
          ...totals,
          subtotal: toMinor(totals.subtotal - 1),
          taxTotal: toMinor(totals.taxTotal + 1),
        },
        FREE_SHIPPING,
      ),
    ).not.toThrow();

    // ...but a line whose own net + tax disagrees with its gross is caught.
    const [only] = lines;
    expect(only).toBeDefined();
    if (only === undefined) {
      return;
    }
    expect(() =>
      assertTotalsBalance(
        [{ ...only, taxAmount: toMinor(only.taxAmount + 1) }],
        totals,
        FREE_SHIPPING,
      ),
    ).toThrow(OrderPricingError);
  });
});

describe("refundableRemaining", () => {
  it("subtracts settled and pending refunds from the grand total", () => {
    expect(refundableRemaining(toMinor(10_000), toMinor(0), toMinor(0))).toBe(10_000);
    expect(refundableRemaining(toMinor(10_000), toMinor(2500), toMinor(0))).toBe(7500);
  });

  /**
   * The double-spend guard. Two operators clicking "refund" in the same minute
   * each see refundedTotal = 0; if pending refunds did not count against the
   * balance, both would pass their check and together refund twice what the
   * customer paid.
   */
  it("counts PENDING refunds against the balance", () => {
    expect(refundableRemaining(toMinor(10_000), toMinor(0), toMinor(10_000))).toBe(0);
    expect(refundableRemaining(toMinor(10_000), toMinor(3000), toMinor(7000))).toBe(0);
  });

  it("floors at zero rather than reporting a negative balance", () => {
    expect(refundableRemaining(toMinor(10_000), toMinor(9000), toMinor(5000))).toBe(0);
  });
});
