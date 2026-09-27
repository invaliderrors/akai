import { describe, expect, it } from "vitest";
import { toMinor } from "@akai/money";

import {
  allocatePackComponents,
  maxPacksPerLine,
  recoverPackQuantity,
  type AllocatedPackComponentLine,
} from "./pack-pricing";

/** Total value across every returned sub-line — what the pack is actually charged. */
function totalValue(shares: readonly AllocatedPackComponentLine[]): number {
  return shares.reduce((sum, share) => sum + share.unitPriceGross * share.quantity, 0);
}

/** Every sub-line's own quantity, summed back per component. */
function quantityByLineId(shares: readonly AllocatedPackComponentLine[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const share of shares) {
    totals.set(share.lineId, (totals.get(share.lineId) ?? 0) + share.quantity);
  }
  return totals;
}

describe("allocatePackComponents", () => {
  it("sums EXACTLY to the pack's flat price, no cent lost or gained", () => {
    const shares = allocatePackComponents(toMinor(5499), [
      { lineId: "a", liveUnitPrice: toMinor(1000), quantity: 1 },
      { lineId: "b", liveUnitPrice: toMinor(2000), quantity: 1 },
      { lineId: "c", liveUnitPrice: toMinor(3000), quantity: 1 },
    ]);

    expect(totalValue(shares)).toBe(5499);
  });

  it("distributes proportionally to each component's own live price, not evenly", () => {
    const shares = allocatePackComponents(toMinor(6000), [
      { lineId: "a", liveUnitPrice: toMinor(1000), quantity: 1 },
      { lineId: "b", liveUnitPrice: toMinor(2000), quantity: 1 },
      { lineId: "c", liveUnitPrice: toMinor(3000), quantity: 1 },
    ]);

    const byId = new Map(shares.map((share) => [share.lineId, share.unitPriceGross]));
    expect(byId.get("a")).toBe(1000);
    expect(byId.get("b")).toBe(2000);
    expect(byId.get("c")).toBe(3000);
  });

  it("still sums exactly with a genuine discount applied (pack cheaper than components)", () => {
    const shares = allocatePackComponents(toMinor(7999), [
      { lineId: "a", liveUnitPrice: toMinor(2500), quantity: 1 },
      { lineId: "b", liveUnitPrice: toMinor(2500), quantity: 1 },
      { lineId: "c", liveUnitPrice: toMinor(2500), quantity: 1 },
      { lineId: "d", liveUnitPrice: toMinor(2500), quantity: 1 },
    ]);

    expect(totalValue(shares)).toBe(7999);
    for (const share of shares) {
      expect(Number.isInteger(share.unitPriceGross)).toBe(true);
      expect(share.unitPriceGross).toBeGreaterThanOrEqual(0);
    }
  });

  it("handles the maximum component count (6) and still balances exactly", () => {
    const components = Array.from({ length: 6 }, (_, index) => ({
      lineId: `line-${index}`,
      liveUnitPrice: toMinor(1111 + index * 137),
      quantity: 1,
    }));

    const shares = allocatePackComponents(toMinor(9999), components);

    expect(totalValue(shares)).toBe(9999);
  });

  it("gives a single component the whole pack price", () => {
    const shares = allocatePackComponents(toMinor(2500), [
      { lineId: "only", liveUnitPrice: toMinor(9999), quantity: 1 },
    ]);

    expect(shares).toEqual([{ lineId: "only", unitPriceGross: 2500, quantity: 1 }]);
  });

  describe("component quantity > 1", () => {
    it("weights by quantity × liveUnitPrice, not liveUnitPrice alone", () => {
      // "b" is worth 5x "a" in TOTAL value (5 units at the same unit price as
      // "a" has 1 of) — the share should follow total value, not per-unit price.
      const shares = allocatePackComponents(toMinor(6000), [
        { lineId: "a", liveUnitPrice: toMinor(1000), quantity: 1 },
        { lineId: "b", liveUnitPrice: toMinor(1000), quantity: 5 },
      ]);

      const totals = new Map<string, number>();
      for (const share of shares) {
        totals.set(share.lineId, (totals.get(share.lineId) ?? 0) + share.unitPriceGross * share.quantity);
      }
      // a : b should split 1 : 5 of 6000 — 1000 and 5000.
      expect(totals.get("a")).toBe(1000);
      expect(totals.get("b")).toBe(5000);
    });

    it("every sub-line's quantity sums back to exactly the component's own quantity", () => {
      const shares = allocatePackComponents(toMinor(5499), [
        { lineId: "a", liveUnitPrice: toMinor(1000), quantity: 1 },
        { lineId: "b", liveUnitPrice: toMinor(2000), quantity: 5 },
        { lineId: "c", liveUnitPrice: toMinor(3000), quantity: 2 },
      ]);

      const byId = quantityByLineId(shares);
      expect(byId.get("a")).toBe(1);
      expect(byId.get("b")).toBe(5);
      expect(byId.get("c")).toBe(2);
      expect(totalValue(shares)).toBe(5499);
    });

    it("splits a component into AT MOST TWO sub-lines when its share doesn't divide evenly", () => {
      // €54.99 pack, weighted so "b" (quantity 5) gets a total share that
      // does NOT divide evenly by 5 — this is the common case, not a rare one.
      const shares = allocatePackComponents(toMinor(5499), [
        { lineId: "a", liveUnitPrice: toMinor(1000), quantity: 1 },
        { lineId: "b", liveUnitPrice: toMinor(1000), quantity: 5 },
      ]);

      const bLines = shares.filter((share) => share.lineId === "b");
      expect(bLines.length).toBeLessThanOrEqual(2);
      expect(bLines.length).toBeGreaterThanOrEqual(1);

      // Every sub-line is a real, non-negative integer price.
      for (const share of shares) {
        expect(Number.isInteger(share.unitPriceGross)).toBe(true);
        expect(share.unitPriceGross).toBeGreaterThanOrEqual(0);
      }

      // If split, the two prices are adjacent (differ by exactly 1 minor unit).
      if (bLines.length === 2) {
        const prices = bLines.map((share) => share.unitPriceGross).sort((x, y) => x - y);
        expect(prices[1]).toBe((prices[0] ?? 0) + 1);
      }

      expect(quantityByLineId(shares).get("b")).toBe(5);
      expect(totalValue(shares)).toBe(5499);
    });

    it("still balances exactly at the maximum component count with mixed quantities", () => {
      const components = Array.from({ length: 6 }, (_, index) => ({
        lineId: `line-${index}`,
        liveUnitPrice: toMinor(1111 + index * 137),
        quantity: index + 1, // 1, 2, 3, 4, 5, 6
      }));

      const shares = allocatePackComponents(toMinor(9999), components);

      expect(totalValue(shares)).toBe(9999);
      const byId = quantityByLineId(shares);
      components.forEach((component, index) => {
        expect(byId.get(`line-${index}`)).toBe(component.quantity);
      });
    });

    it("a single component with quantity > 1 gets the whole pack price, split across its own units", () => {
      const shares = allocatePackComponents(toMinor(2501), [
        { lineId: "only", liveUnitPrice: toMinor(9999), quantity: 3 },
      ]);

      expect(quantityByLineId(shares).get("only")).toBe(3);
      expect(totalValue(shares)).toBe(2501);
    });
  });
});

describe("recoverPackQuantity", () => {
  const recipe = [
    { variantId: "a", quantity: 1 },
    { variantId: "b", quantity: 5 },
  ];

  it("reads how many packs an instance holds from its first stored component, split rows summed", () => {
    expect(
      recoverPackQuantity(recipe, [
        { variantId: "a", quantity: 3 },
        { variantId: "b", quantity: 9 },
        { variantId: "b", quantity: 6 },
      ]),
    ).toBe(3);
  });

  it("falls through to the next component when the first has no stored line", () => {
    expect(recoverPackQuantity(recipe, [{ variantId: "b", quantity: 10 }])).toBe(2);
  });

  it("is zero when no stored line belongs to the recipe", () => {
    expect(recoverPackQuantity(recipe, [{ variantId: "z", quantity: 4 }])).toBe(0);
  });
});

describe("maxPacksPerLine", () => {
  it("is the most packs whose every component line stays within the per-line maximum", () => {
    expect(maxPacksPerLine([{ quantity: 1 }, { quantity: 5 }], 99)).toBe(19);
    expect(maxPacksPerLine([{ quantity: 1 }], 99)).toBe(99);
  });
});
