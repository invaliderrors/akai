import "reflect-metadata";
import {
  cartSchema,
  orderSchema,
  toMinor,
  type Cart,
  type CartProblem,
  type CreateCheckoutSession,
  type Order,
} from "@akai/contracts";
import { buildOrder } from "@akai/testing";
import { beforeEach, describe, expect, it } from "vitest";

import type { CartActor } from "../cart/cart-actor";
import type { CartView } from "../cart/cart.service";
import { CatalogError } from "../catalog/catalog.errors";
import type { ReserveStock } from "../catalog/dto/catalog.dto";
import type { CreateOrderFromCartInput } from "../orders/orders.service";
import type { StartCheckoutResponse } from "../payments/dto/payments.dto";
import type {
  ResolvedShipping,
  ShippingChargeInput,
} from "../shipping/shipping.service";
import type { CheckoutCatalogPort } from "./checkout-catalog.port";
import {
  CheckoutService,
  type CheckoutCartPort,
  type CheckoutInventoryPort,
  type CheckoutOrdersPort,
  type CheckoutPaymentsPort,
  type CheckoutShippingPort,
} from "./checkout.service";

// Fixed ids so the reserve/attach calls can be asserted precisely.
const CART_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const VARIANT_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VARIANT_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function cartItem(variantId: string, quantity: number): Cart["items"][number] {
  return {
    id: `${variantId.slice(0, 8)}-1111-4111-8111-111111111111`,
    variantId,
    productId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    productSlug: "hoodie-kumo",
    name: "Hoodie Kumo",
    variantName: "M",
    sku: `SKU-${variantId.slice(0, 4)}`,
    imageUrl: null,
    quantity,
    unitPriceGross: toMinor(8_900_000),
    lineTotalGross: toMinor(8_900_000 * quantity),
    priceChanged: false,
    packProductId: null,
    packInstanceId: null,
  };
}

function buildCart(overrides: Partial<Cart> = {}): Cart {
  const items = overrides.items ?? [cartItem(VARIANT_A, 1), cartItem(VARIANT_B, 2)];
  const grandTotal = items.reduce((total, item) => total + item.lineTotalGross, 0);

  return cartSchema.parse({
    id: CART_ID,
    customerId: null,
    items,
    itemCount: items.reduce((count, item) => count + item.quantity, 0),
    totals: {
      currency: "COP",
      subtotal: grandTotal,
      discountTotal: 0,
      shippingTotal: 0,
      taxTotal: 0,
      grandTotal,
    },
    discountCode: null,
    problems: overrides.problems ?? [],
    expiresAt: "2026-07-20T11:00:00.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
    ...overrides,
  });
}

function request(overrides: Partial<CreateCheckoutSession> = {}): CreateCheckoutSession {
  return {
    cartId: CART_ID,
    email: "guest@example.com",
    shippingAddress: {
      firstName: "Valentina",
      lastName: "Restrepo",
      company: null,
      line1: "Calle 10 # 43-21",
      line2: null,
      city: "Medellín",
      region: "Antioquia",
      postalCode: null,
      countryCode: "CO",
      phone: "3001234567",
    },
    billingAddress: null,
    shippingMethodId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    documentType: "CC",
    documentNumber: "1020304050",
    locale: "es",
    acceptedTermsVersion: "2026-01",
    ...overrides,
  };
}

const SHIPPING: ResolvedShipping = {
  rateId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  methodName: "Envío nacional",
  currency: "COP",
  priceGross: toMinor(1_500_000),
  taxRateBps: 1900,
  net: toMinor(1_260_504),
  charge: { net: toMinor(1_260_504), taxRateBps: 1900 },
};

// ---------------------------------------------------------------------------
// Doubles — typed against the narrow Pick ports, so no cast is needed.
// ---------------------------------------------------------------------------

class FakeCart implements CheckoutCartPort {
  clearCalls = 0;
  constructor(private cart: Cart) {}
  setCart(cart: Cart): void {
    this.cart = cart;
  }
  async getOrCreateCart(): Promise<CartView> {
    return { cart: this.cart, issuedToken: null };
  }
  async clearCart(): Promise<CartView> {
    this.clearCalls += 1;
    return { cart: this.cart, issuedToken: null };
  }
}

class FakeShipping implements CheckoutShippingPort {
  readonly calls: ShippingChargeInput[] = [];
  error: Error | null = null;
  resolved: ResolvedShipping = SHIPPING;
  async resolveCharge(input: ShippingChargeInput): Promise<ResolvedShipping> {
    this.calls.push(input);
    if (this.error !== null) {
      throw this.error;
    }
    return this.resolved;
  }
}

class FakeInventory implements CheckoutInventoryPort {
  readonly reserved: ReserveStock[] = [];
  readonly released: string[] = [];
  failOnVariant: string | null = null;
  private seq = 0;

  async reserve(
    input: ReserveStock,
  ): Promise<{ reservationId: string; expiresAt: Date }> {
    this.reserved.push(input);
    if (this.failOnVariant === input.variantId) {
      throw CatalogError.outOfStock(`Insufficient stock for ${input.variantId}`);
    }
    this.seq += 1;
    return { reservationId: `res_${this.seq}`, expiresAt: new Date() };
  }

  async release(reservationId: string): Promise<boolean> {
    this.released.push(reservationId);
    return true;
  }
}

class FakeOrders implements CheckoutOrdersPort {
  readonly calls: CreateOrderFromCartInput[] = [];
  error: Error | null = null;
  constructor(private readonly order: Order) {}
  async createFromCart(input: CreateOrderFromCartInput): Promise<Order> {
    this.calls.push(input);
    if (this.error !== null) {
      throw this.error;
    }
    return this.order;
  }
}

class FakePayments implements CheckoutPaymentsPort {
  readonly calls: string[] = [];
  async startCheckout(orderId: string): Promise<StartCheckoutResponse> {
    this.calls.push(orderId);
    return {
      orderNumber: "AK-2026-000123",
      checkoutUrl: "https://checkout.wompi.co/p/?reference=AK-2026-000123-1",
    };
  }
}

class FakeCatalog implements CheckoutCatalogPort {
  constructor(private readonly weights: ReadonlyMap<string, number>) {}
  async loadVariantWeights(): Promise<ReadonlyMap<string, number>> {
    return this.weights;
  }
}

interface Harness {
  service: CheckoutService;
  cart: FakeCart;
  shipping: FakeShipping;
  inventory: FakeInventory;
  orders: FakeOrders;
  payments: FakePayments;
}

function buildHarness(cart: Cart = buildCart()): Harness {
  const order = orderSchema.parse(buildOrder({ id: ORDER_ID }));
  const cartDouble = new FakeCart(cart);
  const shipping = new FakeShipping();
  const inventory = new FakeInventory();
  const orders = new FakeOrders(order);
  const payments = new FakePayments();
  const catalog = new FakeCatalog(
    new Map([
      [VARIANT_A, 100],
      [VARIANT_B, 250],
    ]),
  );

  const service = new CheckoutService(
    cartDouble,
    shipping,
    inventory,
    orders,
    payments,
    catalog,
  );

  return { service, cart: cartDouble, shipping, inventory, orders, payments };
}

const ACTOR: CartActor = { customerId: null, cartToken: "tok_guest" };

describe("CheckoutService.startCheckout", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it("reserves every line, creates the order, links stock, consumes the cart and opens the gateway session", async () => {
    const result = await harness.service.startCheckout(ACTOR, request());

    expect(result).toEqual({
      orderNumber: "AK-2026-000123",
      checkoutUrl: "https://checkout.wompi.co/p/?reference=AK-2026-000123-1",
    });

    // One reservation per line, each against the caller's cart, held with a TTL
    // inside the schema's bounds.
    expect(harness.inventory.reserved).toEqual([
      { variantId: VARIANT_A, quantity: 1, cartId: CART_ID, ttlSeconds: 1800 },
      { variantId: VARIANT_B, quantity: 2, cartId: CART_ID, ttlSeconds: 1800 },
    ]);

    // The order was priced with the SERVER's shipping charge, never a client one.
    expect(harness.orders.calls).toHaveLength(1);
    const created = harness.orders.calls[0];
    expect(created?.shipping).toEqual(SHIPPING.charge);
    expect(created?.shippingMethodName).toBe(SHIPPING.methodName);
    expect(created?.cartId).toBe(CART_ID);
    // Guest: no customer, billing falls back to the shipping address.
    expect(created?.customerId).toBeNull();
    expect(created?.billingAddress).toEqual(created?.shippingAddress);
    // The reservations were opened against this cart id; createFromCart binds
    // them to the order by that id so the PAID webhook can convert them to a
    // sale. The orchestrator supplies no amount of its own.
    expect(harness.inventory.reserved.map((r) => r.cartId)).toEqual([CART_ID, CART_ID]);

    // Cart consumed, then the gateway session opened for THAT order.
    expect(harness.cart.clearCalls).toBe(1);
    expect(harness.payments.calls).toEqual([ORDER_ID]);
    // Nothing was released — the happy path holds all stock through to payment.
    expect(harness.inventory.released).toEqual([]);
  });

  it("prices shipping from the destination and the cart's gross subtotal", async () => {
    await harness.service.startCheckout(ACTOR, request());

    expect(harness.shipping.calls).toHaveLength(1);
    const quote = harness.shipping.calls[0];
    expect(quote?.countryCode).toBe("CO");
    expect(quote?.shippingMethodId).toBe("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    // 1×$89.000 + 2×$89.000 gross, in centavos.
    expect(quote?.subtotalGross).toBe(toMinor(26_700_000));
    // 1×100g + 2×250g.
    expect(quote?.weightGrams).toBe(600);
  });

  it("measures the free-shipping basis AFTER the discount, not on the raw line totals (D3a)", async () => {
    // $310.000 of lines, a $20.000 coupon: a $290.000 order. Summing
    // lineTotalGross (the old basis) would give 31 000 000 and buy free
    // shipping over a $300.000 threshold that the quote endpoint correctly
    // refused.
    const items = [cartItem(VARIANT_A, 1)].map((item) => ({
      ...item,
      unitPriceGross: toMinor(31_000_000),
      lineTotalGross: toMinor(31_000_000),
    }));
    harness = buildHarness(
      buildCart({
        items,
        totals: {
          currency: "COP",
          subtotal: toMinor(31_000_000),
          discountTotal: toMinor(2_000_000),
          shippingTotal: toMinor(0),
          taxTotal: toMinor(0),
          grandTotal: toMinor(29_000_000),
        },
        discountCode: "SAVE20",
      }),
    );

    await harness.service.startCheckout(ACTOR, request());

    expect(harness.shipping.calls[0]?.subtotalGross).toBe(toMinor(29_000_000));
  });

  it("measures the basis over COUNTED lines only — the cart's subtotal, not every line", async () => {
    // A PRICE_CHANGED line is non-blocking, so checkout proceeds; the cart's
    // own totals are the authority on which lines count. Here the totals say
    // 8 900 000 while the lines sum to 26 700 000 — the basis must follow the
    // totals.
    harness = buildHarness(
      buildCart({
        totals: {
          currency: "COP",
          subtotal: toMinor(8_900_000),
          discountTotal: toMinor(0),
          shippingTotal: toMinor(0),
          taxTotal: toMinor(0),
          grandTotal: toMinor(8_900_000),
        },
      }),
    );

    await harness.service.startCheckout(ACTOR, request());

    expect(harness.shipping.calls[0]?.subtotalGross).toBe(toMinor(8_900_000));
  });

  it("refuses an empty cart before holding any stock", async () => {
    harness = buildHarness(buildCart({ items: [], itemCount: 0 }));

    await expect(harness.service.startCheckout(ACTOR, request())).rejects.toThrow(
      /empty cart/i,
    );

    expect(harness.inventory.reserved).toEqual([]);
    expect(harness.orders.calls).toEqual([]);
    expect(harness.payments.calls).toEqual([]);
  });

  it("refuses a cart carrying a blocking problem, and holds no stock", async () => {
    const problem: CartProblem = {
      itemId: `${VARIANT_A.slice(0, 8)}-1111-4111-8111-111111111111`,
      code: "OUT_OF_STOCK",
      message: "Out of stock",
      availableQuantity: 0,
    };
    harness = buildHarness(buildCart({ problems: [problem] }));

    await expect(
      harness.service.startCheckout(ACTOR, request()),
    ).rejects.toThrow(/resolve the cart problems/i);

    expect(harness.inventory.reserved).toEqual([]);
    expect(harness.orders.calls).toEqual([]);
  });

  it("treats a PRICE_CHANGED problem as non-blocking and proceeds", async () => {
    const problem: CartProblem = {
      itemId: `${VARIANT_A.slice(0, 8)}-1111-4111-8111-111111111111`,
      code: "PRICE_CHANGED",
      message: "Price changed",
    };
    harness = buildHarness(buildCart({ problems: [problem] }));

    await expect(
      harness.service.startCheckout(ACTOR, request()),
    ).resolves.toMatchObject({ orderNumber: "AK-2026-000123" });

    expect(harness.orders.calls).toHaveLength(1);
  });

  it("acts only on the actor's own cart — a mismatched cartId is a 404", async () => {
    await expect(
      harness.service.startCheckout(
        ACTOR,
        request({ cartId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }),
      ),
    ).rejects.toThrow(/cart not found/i);

    expect(harness.inventory.reserved).toEqual([]);
    expect(harness.orders.calls).toEqual([]);
  });

  it("releases already-held reservations when a later line is out of stock", async () => {
    harness.inventory.failOnVariant = VARIANT_B;

    await expect(harness.service.startCheckout(ACTOR, request())).rejects.toBeInstanceOf(
      CatalogError,
    );

    // The first line reserved, the second failed → the first is released and no
    // order is created.
    expect(harness.inventory.reserved).toHaveLength(2);
    expect(harness.inventory.released).toEqual(["res_1"]);
    expect(harness.orders.calls).toEqual([]);
    expect(harness.payments.calls).toEqual([]);
  });

  it("releases all reservations when order creation is refused", async () => {
    harness.orders.error = new CatalogError("CONFLICT", "variant withdrawn");

    await expect(harness.service.startCheckout(ACTOR, request())).rejects.toThrow(
      /withdrawn/,
    );

    expect(harness.inventory.reserved).toHaveLength(2);
    expect(harness.inventory.released).toEqual(["res_1", "res_2"]);
    expect(harness.cart.clearCalls).toBe(0);
    expect(harness.payments.calls).toEqual([]);
  });
});

describe("CheckoutService.startCheckout — the order snapshot", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it("hands the buyer's identity document to the order, as the schema normalised it", async () => {
    await harness.service.startCheckout(
      ACTOR,
      request({ documentType: "NIT", documentNumber: "800197268-4" }),
    );

    expect(harness.orders.calls[0]?.customerDocument).toEqual({
      type: "NIT",
      number: "800197268-4",
    });
  });

  it("records the RESOLVED rate id, never one the client could have named", async () => {
    harness.shipping.resolved = { ...SHIPPING, rateId: "99999999-9999-4999-8999-999999999999" };

    await harness.service.startCheckout(ACTOR, request());

    expect(harness.orders.calls[0]?.shippingRateId).toBe("99999999-9999-4999-8999-999999999999");
  });

  it("passes the Colombian shipping address through unchanged", async () => {
    await harness.service.startCheckout(ACTOR, request());

    expect(harness.orders.calls[0]?.shippingAddress).toMatchObject({
      region: "Antioquia",
      city: "Medellín",
      postalCode: null,
      phone: "3001234567",
    });
  });
});
