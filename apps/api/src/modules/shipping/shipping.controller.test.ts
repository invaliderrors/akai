import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import { toMinor } from "@akai/money";
import {
  freeShippingThresholdResponseSchema,
  shippingQuoteResponseSchema,
} from "@akai/contracts";

import type { CartActor } from "../cart/cart-actor";
import type { CartService, CartShippingBasis } from "../cart/cart.service";
import { ShippingController } from "./shipping.controller";
import { ShippingError } from "./shipping.errors";
import { type ShippingOption } from "./shipping-rate.selector";
import type { ShippingQuoteInput, ShippingService } from "./shipping.service";

const ACTOR: CartActor = { customerId: null, cartToken: "token" };

const BASIS: CartShippingBasis = {
  cartId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  currency: "EUR",
  subtotalGross: toMinor(3980),
  weightGrams: 540,
};

const STANDARD: ShippingOption = {
  rateId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Estándar",
  currency: "EUR",
  priceGross: toMinor(495),
  isFree: false,
  transitDaysMin: null,
  transitDaysMax: null,
};

/**
 * Doubles typed as the real dependency via `Pick`, so a signature change in
 * CartService or ShippingService breaks this file at compile time rather than
 * letting the controller test keep passing against an interface that no longer
 * exists.
 */
type CartDouble = Pick<CartService, "getShippingBasis">;
type ShippingDouble = Pick<ShippingService, "listOptions" | "freeShippingThreshold">;
function controllerWith(
  shipping: ShippingDouble,
  cart: CartDouble = { getShippingBasis: () => Promise.resolve(BASIS) },
): ShippingController {
  return new ShippingController(shipping as ShippingService, cart as CartService);
}

describe("ShippingController.quote", () => {
  let seen: ShippingQuoteInput[];

  beforeEach(() => {
    seen = [];
  });

  function recordingShipping(
    result: ShippingOption[] | ShippingError,
  ): ShippingDouble {
    return {
      freeShippingThreshold: () => Promise.resolve(null),
      listOptions: (input: ShippingQuoteInput) => {
        seen.push(input);
        return result instanceof ShippingError
          ? Promise.reject(result)
          : Promise.resolve(result);
      },
    };
  }

  it("prices the caller's own cart, never numbers from the request body", async () => {
    const controller = controllerWith(recordingShipping([STANDARD]));

    await controller.quote(ACTOR, { countryCode: "ES", postalCode: null });

    expect(seen).toEqual([
      {
        countryCode: "ES",
        currency: BASIS.currency,
        subtotalGross: BASIS.subtotalGross,
        weightGrams: BASIS.weightGrams,
      },
    ]);
  });

  it("returns the offered methods and satisfies the published contract", async () => {
    const controller = controllerWith(recordingShipping([STANDARD]));

    const quote = await controller.quote(ACTOR, {
      countryCode: "ES",
      postalCode: "28001",
    });

    expect(shippingQuoteResponseSchema.parse(quote)).toEqual(quote);
    expect(quote.destinationServed).toBe(true);
    expect(quote.options).toEqual([
      {
        rateId: STANDARD.rateId,
        name: "Estándar",
        currency: "EUR",
        priceGross: 495,
        isFree: false,
        transitDaysMin: null,
        transitDaysMax: null,
      },
    ]);
  });

  it("answers an unserved destination with a 200, not an error envelope", async () => {
    const controller = controllerWith(
      recordingShipping(ShippingError.destinationNotServed("US")),
    );

    const quote = await controller.quote(ACTOR, {
      countryCode: "US",
      postalCode: null,
    });

    expect(quote.destinationServed).toBe(false);
    expect(quote.options).toEqual([]);
  });

  it("distinguishes 'served, no bracket fits' from 'not served'", async () => {
    const controller = controllerWith(recordingShipping([]));

    const quote = await controller.quote(ACTOR, {
      countryCode: "ES",
      postalCode: null,
    });

    expect(quote.destinationServed).toBe(true);
    expect(quote.options).toEqual([]);
  });

  it("propagates an operator misconfiguration instead of hiding it as 'no shipping'", async () => {
    const controller = controllerWith(
      recordingShipping(ShippingError.taxUnconfigured("ES")),
    );

    await expect(
      controller.quote(ACTOR, { countryCode: "ES", postalCode: null }),
    ).rejects.toBeInstanceOf(ShippingError);
  });

  it("propagates methodUnavailable rather than flattening it to an empty quote", async () => {
    const controller = controllerWith(
      recordingShipping(ShippingError.methodUnavailable()),
    );

    await expect(
      controller.quote(ACTOR, { countryCode: "ES", postalCode: null }),
    ).rejects.toBeInstanceOf(ShippingError);
  });

  it("propagates a cart-resolution failure — a quote without a cart is meaningless", async () => {
    const controller = controllerWith(recordingShipping([STANDARD]), {
      getShippingBasis: () => Promise.reject(new Error("Cart not found")),
    });

    await expect(
      controller.quote(ACTOR, { countryCode: "ES", postalCode: null }),
    ).rejects.toThrow("Cart not found");
  });
});

describe("ShippingController.freeShipping", () => {
  function shippingWithThreshold(
    threshold: Awaited<ReturnType<ShippingService["freeShippingThreshold"]>>,
  ): ShippingDouble {
    return {
      listOptions: () => Promise.resolve([]),
      freeShippingThreshold: () => Promise.resolve(threshold),
    };
  }

  it("exposes the store-wide threshold in the published contract shape", async () => {
    const controller = controllerWith(
      shippingWithThreshold({ amount: toMinor(25_000), currency: "EUR" }),
    );

    const body = await controller.freeShipping();

    expect(freeShippingThresholdResponseSchema.parse(body)).toEqual({
      threshold: { amount: 25_000, currency: "EUR" },
    });
  });

  it("answers null when no single threshold holds everywhere", async () => {
    const controller = controllerWith(shippingWithThreshold(null));

    expect(await controller.freeShipping()).toEqual({ threshold: null });
  });
});

describe("ShippingError.isDestinationNotServed", () => {
  it("is set on the one case a caller may treat as a normal answer", () => {
    expect(ShippingError.destinationNotServed("US").isDestinationNotServed).toBe(true);
  });

  it("is NOT set on the other VALIDATION_FAILED cases that share its status", () => {
    expect(ShippingError.noMethodAvailable("ES").isDestinationNotServed).toBe(false);
    expect(ShippingError.taxUnconfigured("ES").isDestinationNotServed).toBe(false);
  });
});
