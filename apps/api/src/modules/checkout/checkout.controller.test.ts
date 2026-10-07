import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";

import { IS_PUBLIC_KEY } from "../../common/decorators/public.decorator";
import type { CartActor } from "../cart/cart-actor";
import type { IdempotencyService } from "../idempotency/idempotency.service";
import { THROTTLE_KEY } from "../throttler/throttle.decorator";
import { CheckoutController, idempotencyScope } from "./checkout.controller";
import type { CheckoutService, CheckoutSessionResponse } from "./checkout.service";
import type { CreateCheckoutSession } from "@akai/contracts";

const RESPONSE: CheckoutSessionResponse = {
  orderNumber: "AK-2026-000123",
  checkoutUrl: "https://checkout.wompi.co/p/?reference=AK-2026-000123-1",
};

const BODY = {
  cartId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
  email: "marta@example.com",
} as unknown as CreateCheckoutSession;

const GUEST: CartActor = { customerId: null, cartToken: "t".repeat(43) };

/**
 * An idempotency double that runs the handler and remembers the identity it was
 * given. The service's own semantics (reserve-then-execute, request-hash
 * comparison, replay) are proven in idempotency.service.test.ts; what matters
 * HERE is that the controller reaches it at all, and with a correctly-scoped
 * identity.
 */
function idempotencyDouble(): {
  service: Pick<IdempotencyService, "execute">;
  calls: { key: string; userId: string; route: string }[];
} {
  const calls: { key: string; userId: string; route: string }[] = [];

  return {
    calls,
    service: {
      execute: async (execution) => {
        calls.push({
          key: execution.key,
          userId: execution.userId,
          route: execution.route,
        });
        return { value: await execution.handler(), replayed: false };
      },
    },
  };
}

function controllerFor(
  checkout: Pick<CheckoutService, "startCheckout">,
  idempotency: Pick<IdempotencyService, "execute">,
): CheckoutController {
  return new CheckoutController(
    checkout as CheckoutService,
    idempotency as IdempotencyService,
  );
}

describe("CheckoutController", () => {
  it("is public — a guest must be able to buy without an account", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, CheckoutController.prototype.start)).toBe(
      true,
    );
  });

  it("carries a throttle rule on the money-creating POST", () => {
    const rule: unknown = Reflect.getMetadata(
      THROTTLE_KEY,
      CheckoutController.prototype.start,
    );

    expect(rule).toMatchObject({ name: "checkout" });
  });

  it("bypasses idempotency when the client sends no key, rather than failing", async () => {
    const start = vi.fn(async () => RESPONSE);
    const { service, calls } = idempotencyDouble();

    await expect(
      controllerFor({ startCheckout: start }, service).start(GUEST, BODY),
    ).resolves.toEqual(RESPONSE);

    expect(start).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it("treats a whitespace-only key as no key", async () => {
    const start = vi.fn(async () => RESPONSE);
    const { service, calls } = idempotencyDouble();

    await controllerFor({ startCheckout: start }, service).start(GUEST, BODY, "   ");

    expect(calls).toHaveLength(0);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("routes a keyed request through the reservation, scoped and named", async () => {
    const start = vi.fn(async () => RESPONSE);
    const { service, calls } = idempotencyDouble();

    const result = await controllerFor({ startCheckout: start }, service).start(
      GUEST,
      BODY,
      "key-123",
    );

    expect(result).toEqual(RESPONSE);
    expect(calls).toEqual([
      { key: "key-123", userId: idempotencyScope(GUEST), route: "POST /checkout" },
    ]);
  });
});

describe("idempotencyScope", () => {
  it("scopes a signed-in caller by customer id", () => {
    const customerId = "11111111-1111-4111-8111-111111111111";

    expect(idempotencyScope({ customerId, cartToken: "t".repeat(43) })).toBe(customerId);
  });

  it("never writes the raw cart token into the reservation row", () => {
    const token = "t".repeat(43);

    expect(idempotencyScope({ customerId: null, cartToken: token })).not.toContain(token);
  });

  it("partitions guests, so one guest's key cannot replay another's response", () => {
    const a = idempotencyScope({ customerId: null, cartToken: "a".repeat(43) });
    const b = idempotencyScope({ customerId: null, cartToken: "b".repeat(43) });

    expect(a).not.toBe(b);
  });

  it("is stable for the same token, so a genuine retry lands on the same row", () => {
    const actor: CartActor = { customerId: null, cartToken: "c".repeat(43) };

    expect(idempotencyScope(actor)).toBe(idempotencyScope(actor));
  });

  it("collapses a caller with no identity at all into one scope", () => {
    expect(idempotencyScope({ customerId: null, cartToken: null })).toBe(
      "guest:anonymous",
    );
  });
});
