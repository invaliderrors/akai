import { describe, expect, it } from "vitest";
import { inventoryRowSchema, type InventoryRow } from "@akai/contracts";

import { STATUS_TONE } from "@/lib/status";
import { resolveStockState, single } from "./inventory-display";

/**
 * The badge an operator scans to decide what to act on.
 *
 * The precedence is the behaviour: UNTRACKED must outrank every numeric state,
 * because a missing inventory record and a sold-out variant both read as zero
 * and are fixed in completely different ways.
 *
 * Fixtures PARSE through the contract rather than being cast, so a fixture that
 * drifts fails here instead of passing against a shape the API cannot send.
 */

function row(overrides: Partial<InventoryRow> = {}): InventoryRow {
  return inventoryRowSchema.parse({
    variantId: "6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
    sku: "AK-CRE-300",
    productId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    productSlug: "oversized-tee",
    productName: "Camiseta Oversize",
    tracked: true,
    onHand: 50,
    reserved: 0,
    available: 50,
    lowStockThreshold: 10,
    allowBackorder: false,
    ...overrides,
  });
}

describe("resolveStockState", () => {
  it("is ok for a healthy variant", () => {
    expect(resolveStockState(row())).toBe("ok");
  });

  it("is low at or below the threshold", () => {
    expect(resolveStockState(row({ onHand: 10, available: 10 }))).toBe("low");
    expect(resolveStockState(row({ onHand: 11, available: 11 }))).toBe("ok");
  });

  it("is out at zero available", () => {
    expect(resolveStockState(row({ onHand: 5, reserved: 5, available: 0 }))).toBe("out");
  });

  it("counts RESERVED against availability", () => {
    // 50 on hand with 45 reserved is 5 available — low, not healthy. Reading
    // onHand alone is how an operator ships something already promised away.
    expect(resolveStockState(row({ onHand: 50, reserved: 45, available: 5 }))).toBe("low");
  });

  it("is backorder rather than out when backorder is allowed", () => {
    expect(
      resolveStockState(row({ onHand: 0, reserved: 0, available: 0, allowBackorder: true })),
    ).toBe("backorder");
  });

  it("does NOT flag a backorder-enabled variant as low", () => {
    // It is sellable at any level, so listing it in the restock queue is noise
    // that hides the variants that genuinely cannot be sold.
    expect(resolveStockState(row({ available: 1, allowBackorder: true }))).toBe("ok");
  });

  describe("precedence", () => {
    it("UNTRACKED outranks every numeric state", () => {
      // The API zero-fills an untracked row, so without this it would read as
      // "out of stock" — restocking would not fix it, creating the record would.
      const untracked = row({
        tracked: false,
        onHand: 0,
        reserved: 0,
        available: 0,
        lowStockThreshold: 0,
      });
      expect(resolveStockState(untracked)).toBe("untracked");
    });

    it("stays UNTRACKED even when backorder happens to be set", () => {
      const untracked = row({ tracked: false, available: 0, allowBackorder: true });
      expect(resolveStockState(untracked)).toBe("untracked");
    });
  });

  it("gives every state a tone, so a new state cannot render unstyled", () => {
    // `STOCK_TONE` moved to `lib/status` under the `stock` domain. This walks
    // the states THIS module derives, which is the link worth checking here:
    // `resolveStockState` above can only ever return one of these five, and
    // every one of them has to badge.
    for (const state of ["untracked", "out", "low", "backorder", "ok"] as const) {
      expect(STATUS_TONE.stock[state]).toBeTypeOf("string");
    }
    // The two states that mean "cannot be sold" must not be styled as healthy.
    expect(STATUS_TONE.stock.untracked).toBe("danger");
    // CHANGED from "danger". A tracked, no-backorder variant at zero available
    // is a listing a customer can reach and cannot buy, and the redesign spends
    // one of its two `attention` treatments on exactly that. `danger` here
    // would have put it level with an untracked row, which is a data problem
    // rather than a lost sale.
    expect(STATUS_TONE.stock.out).toBe("attention");
  });
});

describe("single", () => {
  it("takes the first value of a repeated query key", () => {
    // `?filter=a&filter=b` arrives as an array; forwarding it whole serialises
    // as "a,b", which the API rejects as one malformed value.
    expect(single(["low", "out"])).toBe("low");
  });

  it("passes a plain string and undefined through", () => {
    expect(single("low")).toBe("low");
    expect(single(undefined)).toBeUndefined();
  });
});
