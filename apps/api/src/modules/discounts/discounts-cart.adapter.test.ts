import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { CurrencyCode } from "@akai/contracts";
import { toMinor } from "@akai/money";

import type { CartDiscountContext } from "../cart/cart-discount.port";
import { DiscountsCartAdapter } from "./discounts-cart.adapter";
import { DiscountError } from "./discounts.errors";
import type { DiscountsService, ValidatedDiscount } from "./discounts.service";

const EUR = "EUR" as CurrencyCode;

function context(overrides: Partial<CartDiscountContext> = {}): CartDiscountContext {
  return {
    cartId: "cart-1",
    customerId: "cust-1",
    currency: EUR,
    discountCode: "SAVE10",
    subtotal: toMinor(3000),
    ...overrides,
  };
}

/** A DiscountsService test double with just the method the adapter calls. */
function serviceReturning(amount: number): DiscountsService {
  const validated: ValidatedDiscount = {
    discountId: "disc-1",
    code: "SAVE10",
    type: "PERCENTAGE",
    amount: toMinor(amount),
  };
  return { validate: vi.fn().mockResolvedValue(validated) } as unknown as DiscountsService;
}

function serviceThrowing(error: unknown): DiscountsService {
  return { validate: vi.fn().mockRejectedValue(error) } as unknown as DiscountsService;
}

describe("DiscountsCartAdapter", () => {
  it("returns zero when the cart carries no code, without touching the service", async () => {
    const validate = vi.fn();
    const adapter = new DiscountsCartAdapter({ validate } as unknown as DiscountsService);

    const amount = await adapter.resolveDiscount(context({ discountCode: null }));

    expect(amount).toBe(0);
    expect(validate).not.toHaveBeenCalled();
  });

  it("returns the validated amount for a good code", async () => {
    const adapter = new DiscountsCartAdapter(serviceReturning(300));
    expect(await adapter.resolveDiscount(context())).toBe(300);
  });

  it("degrades to zero when the code is invalid or lapsed", async () => {
    // A shopper whose code expired sees full price, not an error page.
    const adapter = new DiscountsCartAdapter(serviceThrowing(DiscountError.expired()));
    expect(await adapter.resolveDiscount(context())).toBe(0);
  });

  it("propagates a genuine fault rather than silently charging full price", async () => {
    // A database outage is NOT a "no discount" situation — it must surface.
    const adapter = new DiscountsCartAdapter(serviceThrowing(new Error("connection reset")));
    await expect(adapter.resolveDiscount(context())).rejects.toThrow("connection reset");
  });
});
