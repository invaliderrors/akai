import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Cart } from "@akai/contracts";
import { toMinor } from "@akai/money";

import { IS_PUBLIC_KEY } from "../../common/decorators/public.decorator";
import { PUBLIC_RATE_LIMITER } from "../throttler/rate-limiter.port";
import { ThrottleGuard } from "../throttler/throttle.guard";
import type { CartActor } from "./cart-actor";
import { CART_TOKEN_HEADER } from "./cart.constants";
import { CartController } from "./cart.controller";
import { CartService, type CartView } from "./cart.service";

// Built through `toMinor` rather than with a cast: the money brand exists to
// stop a plain number reaching a money field, and a test fixture that casts
// past it is a test fixture that stops proving the shape is real.
const EMPTY_CART: Cart = {
  id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  customerId: null,
  items: [],
  itemCount: 0,
  totals: {
    currency: "COP",
    subtotal: toMinor(0),
    discountTotal: toMinor(0),
    shippingTotal: toMinor(0),
    taxTotal: toMinor(0),
    grandTotal: toMinor(0),
  },
  discountCode: null,
  problems: [],
  expiresAt: "2026-08-19T10:00:00.000Z",
  updatedAt: "2026-07-20T10:00:00.000Z",
};

/** Captures what the handler writes to the response. */
function responseDouble(): { response: Response; headers: Map<string, string> } {
  const headers = new Map<string, string>();
  const sink = {
    setHeader(name: string, value: string): void {
      headers.set(name, value);
    },
  };
  return { response: sink as unknown as Response, headers };
}

type CartServiceDouble = {
  [Method in keyof CartService]: ReturnType<typeof vi.fn>;
};

describe("CartController", () => {
  let service: CartServiceDouble;
  let controller: CartController;

  const view = (issuedToken: string | null): CartView => ({
    cart: EMPTY_CART,
    issuedToken,
  });

  beforeEach(async () => {
    service = {
      getOrCreateCart: vi.fn(async () => view(null)),
      addItem: vi.fn(async () => view(null)),
      updateItemQuantity: vi.fn(async () => view(null)),
      removeItem: vi.fn(async () => view(null)),
      // Added with the pack feature: "add pack to cart" and "remove whole
      // pack" are separate verbs from the ordinary item ones above, so they
      // are separate mocks here too.
      addPack: vi.fn(async () => view(null)),
      removePack: vi.fn(async () => view(null)),
      clearCart: vi.fn(async () => view(null)),
      mergeGuestCart: vi.fn(async () => view(null)),
      expireStaleCarts: vi.fn(async () => 0),
      // Added with the checkout-validation and coupon endpoints. The mapped-type
      // double must list every public method, so a new one that is never wired
      // into a controller route fails here rather than silently.
      validateCart: vi.fn(async () => EMPTY_CART),
      applyDiscountCode: vi.fn(async () => EMPTY_CART),
      removeDiscountCode: vi.fn(async () => EMPTY_CART),
      // Added with the public shipping quote: ShippingController derives the
      // rate inputs from the cart rather than from the request body.
      getShippingBasis: vi.fn(async () => ({
        cartId: EMPTY_CART.id,
        currency: "COP",
        subtotalGross: toMinor(0),
        weightGrams: 0,
      })),
    };

    // Resolved through the Nest container rather than by direct construction,
    // so this doubles as a check that decorator metadata survives the SWC
    // transform and the controller's dependency actually injects.
    // ThrottleGuard is named by `@UseGuards` on the write verbs, so Nest must be
    // able to construct it even in a unit test that never exercises a limit. Its
    // limiter is stubbed to always allow: this file is about routing, tokens and
    // delegation, and throttle.guard.test.ts owns the limiting behaviour.
    const moduleRef = await Test.createTestingModule({
      controllers: [CartController],
      providers: [
        { provide: CartService, useValue: service },
        ThrottleGuard,
        {
          provide: PUBLIC_RATE_LIMITER,
          useValue: {
            consume: () =>
              Promise.resolve({
                allowed: true,
                remaining: 1,
                retryAfterSeconds: 0,
              }),
          },
        },
      ],
    }).compile();

    controller = moduleRef.get(CartController);
  });

  const actor: CartActor = { customerId: null, cartToken: null };

  // -------------------------------------------------------------------------
  // Guard behaviour
  // -------------------------------------------------------------------------

  describe("authentication metadata", () => {
    /**
     * The API is deny-by-default (spec §8): a global JwtAuthGuard rejects
     * anything not marked `@Public()`. A storefront must let an anonymous
     * visitor build a basket, so the cart routes opt out deliberately.
     */
    it.each([
      ["getCart", CartController.prototype.getCart],
      ["addItem", CartController.prototype.addItem],
      ["updateItem", CartController.prototype.updateItem],
      ["removeItem", CartController.prototype.removeItem],
      ["clear", CartController.prototype.clear],
    ])("marks %s public so anonymous carts work", (_name, handler) => {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
    });

    /**
     * THE guard test.
     *
     * Merging is only meaningful for a signed-in customer. If this route were
     * public, an unauthenticated caller could feed guest tokens to it. The
     * absence of the metadata is what makes the global guard reject it, so the
     * absence is asserted rather than assumed.
     */
    it("does NOT mark merge public — it requires a session", () => {
      expect(
        Reflect.getMetadata(IS_PUBLIC_KEY, CartController.prototype.merge),
      ).toBeUndefined();
    });

    it("does not mark the controller class itself public", () => {
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, CartController)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Token handling
  // -------------------------------------------------------------------------

  describe("cart token delivery", () => {
    /**
     * The token is a bearer credential. Response BODIES are what gets cached by
     * a CDN, logged by an APM and pasted into a bug report, so a freshly minted
     * token leaves in a header instead.
     */
    it("returns a newly issued token in a header, never in the body", async () => {
      service.getOrCreateCart.mockResolvedValue(view("t".repeat(43)));
      const { response, headers } = responseDouble();

      const body = await controller.getCart(actor, response);

      expect(headers.get(CART_TOKEN_HEADER)).toBe("t".repeat(43));
      expect(JSON.stringify(body)).not.toContain("t".repeat(43));
    });

    it("sets no token header when no token was issued", async () => {
      service.getOrCreateCart.mockResolvedValue(view(null));
      const { response, headers } = responseDouble();

      await controller.getCart(actor, response);

      expect(headers.has(CART_TOKEN_HEADER)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Delegation
  // -------------------------------------------------------------------------

  describe("delegation", () => {
    it("passes the resolved actor through to the service", async () => {
      const signedIn: CartActor = {
        customerId: "11111111-1111-4111-8111-111111111111",
        cartToken: null,
      };
      const { response } = responseDouble();

      await controller.getCart(signedIn, response);

      expect(service.getOrCreateCart).toHaveBeenCalledWith(signedIn);
    });

    it("forwards the add-item body verbatim", async () => {
      const { response } = responseDouble();
      const body = {
        variantId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
        quantity: 2,
      };

      await controller.addItem(actor, body, response);

      expect(service.addItem).toHaveBeenCalledWith(actor, body);
    });

    it("forwards the item id and quantity on update", async () => {
      const { response } = responseDouble();
      const itemId = "3f2504e0-4f89-11d3-9a0c-0305e82c3302";

      await controller.updateItem(actor, itemId, { quantity: 0 }, response);

      expect(service.updateItemQuantity).toHaveBeenCalledWith(
        actor,
        itemId,
        { quantity: 0 },
      );
    });

    it("forwards the guest token on merge", async () => {
      const { response } = responseDouble();
      const body = { cartToken: "g".repeat(43) };

      await controller.merge(actor, body, response);

      expect(service.mergeGuestCart).toHaveBeenCalledWith(actor, body);
    });
  });
});
