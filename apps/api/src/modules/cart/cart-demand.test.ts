import { describe, expect, it } from "vitest";

import { demandByVariant } from "./cart-demand";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("demandByVariant", () => {
  it("sums every line of a variant — standalone, pack components and split pack rows alike", () => {
    const demand = demandByVariant([
      { variantId: A, quantity: 3 },
      { variantId: A, quantity: 2 },
      { variantId: A, quantity: 3 },
      { variantId: B, quantity: 1 },
    ]);

    expect(demand.get(A)).toBe(8);
    expect(demand.get(B)).toBe(1);
  });

  it("is empty for an empty cart", () => {
    expect(demandByVariant([]).size).toBe(0);
  });
});
