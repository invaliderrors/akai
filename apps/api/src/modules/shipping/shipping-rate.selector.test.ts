import { describe, expect, it } from "vitest";
import type { CurrencyCode, Minor } from "@akai/contracts";
import { toMinor } from "@akai/money";

import {
  type ShippingRateRow,
  type ShippingSelectionContext,
  selectShippingOptions,
} from "./shipping-rate.selector";

const EUR = "EUR" as CurrencyCode;

function rate(overrides: Partial<ShippingRateRow> = {}): ShippingRateRow {
  return {
    id: "rate-flat",
    name: "Estándar",
    strategy: "FLAT",
    priceGross: 495,
    currency: "EUR",
    minValue: null,
    maxValue: null,
    freeOverSubtotal: null,
    isActive: true,
    transitDaysMin: null,
    transitDaysMax: null,
    ...overrides,
  };
}

function context(overrides: Partial<ShippingSelectionContext> = {}): ShippingSelectionContext {
  return {
    currency: EUR,
    subtotalGross: toMinor(3000),
    weightGrams: 250,
    ...overrides,
  };
}

describe("selectShippingOptions", () => {
  it("always offers a FLAT rate regardless of weight or subtotal", () => {
    const options = selectShippingOptions([rate()], context({ weightGrams: 99_999 }));

    expect(options).toHaveLength(1);
    expect(options[0]?.priceGross).toBe(495);
    expect(options[0]?.isFree).toBe(false);
  });

  it("excludes an inactive rate", () => {
    expect(selectShippingOptions([rate({ isActive: false })], context())).toHaveLength(0);
  });

  it("excludes a rate priced in a different currency", () => {
    const usd = rate({ id: "usd", currency: "USD" });
    expect(selectShippingOptions([usd], context({ currency: EUR }))).toHaveLength(0);
  });

  it("excludes a rate with an unrecognised strategy rather than guessing", () => {
    // A mis-seeded strategy must fail CLOSED — never offered, never charged
    // under a guessed rule.
    expect(selectShippingOptions([rate({ strategy: "SURFACE_MAIL" })], context())).toHaveLength(
      0,
    );
  });

  it("excludes a rate with a blank name — an unreadable method is unbuyable", () => {
    // The database refuses a blank name with a CHECK, but it is not the only
    // writer. Failing closed here is what lets the wire schema, the order's
    // stamped method name and the invoice all treat a name as present.
    expect(selectShippingOptions([rate({ name: "" })], context())).toHaveLength(0);
    expect(selectShippingOptions([rate({ name: "   " })], context())).toHaveLength(0);
  });

  it("carries the rate's name through as is", () => {
    const [option] = selectShippingOptions([rate()], context());
    expect(option?.name).toEqual("Estándar");
  });

  describe("WEIGHT brackets", () => {
    const light = rate({ id: "w-light", strategy: "WEIGHT", minValue: 0, maxValue: 1000, priceGross: 495 });
    const heavy = rate({ id: "w-heavy", strategy: "WEIGHT", minValue: 1000, maxValue: 5000, priceGross: 895 });

    it("offers only the bracket the weight falls into", () => {
      const options = selectShippingOptions([light, heavy], context({ weightGrams: 250 }));
      expect(options.map((o) => o.rateId)).toEqual(["w-light"]);
    });

    it("treats the upper bound as exclusive so brackets tile without overlap", () => {
      // 1000g belongs to the heavy bracket [1000,5000), NOT to light [0,1000).
      const options = selectShippingOptions([light, heavy], context({ weightGrams: 1000 }));
      expect(options.map((o) => o.rateId)).toEqual(["w-heavy"]);
    });

    it("offers nothing when the weight exceeds every bracket", () => {
      expect(selectShippingOptions([light, heavy], context({ weightGrams: 6000 }))).toHaveLength(
        0,
      );
    });

    it("treats a null upper bound as unbounded", () => {
      const openEnded = rate({ id: "w-open", strategy: "WEIGHT", minValue: 1000, maxValue: null });
      const options = selectShippingOptions([openEnded], context({ weightGrams: 500_000 }));
      expect(options.map((o) => o.rateId)).toEqual(["w-open"]);
    });
  });

  describe("PRICE brackets", () => {
    const small = rate({ id: "p-small", strategy: "PRICE", minValue: 0, maxValue: 5000 });
    const large = rate({ id: "p-large", strategy: "PRICE", minValue: 5000, maxValue: null });

    it("selects the bracket the gross subtotal falls into", () => {
      const options = selectShippingOptions([small, large], context({ subtotalGross: toMinor(4999) }));
      expect(options.map((o) => o.rateId)).toEqual(["p-small"]);
    });

    it("uses the exclusive upper bound on the price too", () => {
      const options = selectShippingOptions([small, large], context({ subtotalGross: toMinor(5000) }));
      expect(options.map((o) => o.rateId)).toEqual(["p-large"]);
    });
  });

  describe("free-over-threshold", () => {
    it("drops the price to zero at or above the threshold but still offers the method", () => {
      const freeOver = rate({ freeOverSubtotal: 5000, priceGross: 495 });
      const options = selectShippingOptions([freeOver], context({ subtotalGross: toMinor(5000) }));

      expect(options).toHaveLength(1);
      expect(options[0]?.priceGross).toBe(0);
      expect(options[0]?.isFree).toBe(true);
    });

    it("charges normally just below the threshold", () => {
      const freeOver = rate({ freeOverSubtotal: 5000, priceGross: 495 });
      const options = selectShippingOptions([freeOver], context({ subtotalGross: toMinor(4999) }));

      expect(options[0]?.priceGross).toBe(495);
      expect(options[0]?.isFree).toBe(false);
    });

    // The store-wide free-shipping rule: every seeded rate
    // carries freeOverSubtotal = 25000, so the boundary is pinned for BOTH of
    // them at one cent below, exactly at, and one cent above the threshold.
    describe("at the store-wide €250.00 threshold", () => {
      const seeded = [
        rate({ id: "dhl", priceGross: 1999, freeOverSubtotal: 25_000 }),
        rate({ id: "inpost", priceGross: 899, freeOverSubtotal: 25_000 }),
      ];

      it("charges every rate at 24 999 (one cent short)", () => {
        const options = selectShippingOptions(seeded, context({ subtotalGross: toMinor(24_999) }));
        expect(options.map((o) => [o.rateId, o.priceGross, o.isFree])).toEqual([
          ["inpost", 899, false],
          ["dhl", 1999, false],
        ]);
      });

      it("makes every rate free at exactly 25 000 (the threshold is inclusive)", () => {
        const options = selectShippingOptions(seeded, context({ subtotalGross: toMinor(25_000) }));
        expect(options.map((o) => [o.rateId, o.priceGross, o.isFree])).toEqual([
          ["dhl", 0, true],
          ["inpost", 0, true],
        ]);
      });

      it("keeps every rate free at 25 001", () => {
        const options = selectShippingOptions(seeded, context({ subtotalGross: toMinor(25_001) }));
        expect(options.every((o) => o.priceGross === 0 && o.isFree)).toBe(true);
        expect(options).toHaveLength(2);
      });
    });
  });

  it("returns options cheapest first, tie-broken by rate id", () => {
    const a = rate({ id: "b-id", priceGross: 495 });
    const b = rate({ id: "a-id", priceGross: 495 });
    const c = rate({ id: "cheapest", priceGross: 100 });

    const options = selectShippingOptions([a, b, c], context());
    expect(options.map((o) => o.rateId)).toEqual(["cheapest", "a-id", "b-id"]);
  });

  it("brands the returned price as Minor", () => {
    const [option] = selectShippingOptions([rate()], context());
    // Compile-time proof the price is a branded Minor, not a bare number.
    const price: Minor | undefined = option?.priceGross;
    expect(price).toBe(495);
  });
});
