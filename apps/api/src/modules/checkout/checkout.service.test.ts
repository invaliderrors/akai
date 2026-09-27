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
import { UNMAPPED_FULFILMENT, type RateFulfilment } from "../shipping/shipping-rate.selector";
import type {
  ServicePointSnapshot,
  VerifyServicePointInput,
} from "../shipping/service-points/service-points.service";
import { FulfilmentError } from "../fulfilment/fulfilment.errors";
import type { CheckoutCatalogPort } from "./checkout-catalog.port";
import {
  CheckoutService,
  type CheckoutCartPort,
  type CheckoutInventoryPort,
  type CheckoutOrdersPort,
  type CheckoutPaymentsPort,
  type CheckoutServicePointPort,
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
    unitPriceGross: toMinor(4999),
    lineTotalGross: toMinor(4999 * quantity),
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
      currency: "EUR",
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
      firstName: "Ana",
      lastName: "García",
      company: null,
      line1: "Calle Mayor 1",
      line2: null,
      city: "Madrid",
      region: null,
      postalCode: "28013",
      countryCode: "ES",
      phone: "+34600000000",
      houseNumber: "1",
    },
    billingAddress: null,
    shippingMethodId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    servicePointId: null,
    vatNumber: null,
    locale: "es",
    acceptedTermsVersion: "2026-01",
    ...overrides,
  };
}

const SHIPPING: ResolvedShipping = {
  rateId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  methodName: "Correos Estándar",
  currency: "EUR",
  priceGross: toMinor(500),
  taxRateBps: 2100,
  net: toMinor(413),
  charge: { net: toMinor(413), taxRateBps: 2100 },
  fulfilment: UNMAPPED_FULFILMENT,
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

/**
 * The pickup-point gate, reduced to its contract: HOME needs no point and
 * refuses one; SERVICE_POINT needs one, and `error` scripts a refusal of it.
 * The real rules (carrier/country/expiry/availability) are proven in
 * service-points.service.test.ts; this proves checkout ORDERS them right and
 * stamps the snapshot.
 */
class FakeServicePoints implements CheckoutServicePointPort {
  readonly calls: VerifyServicePointInput[] = [];
  error: Error | null = null;
  snapshot: ServicePointSnapshot = {
    servicePointId: "12188365",
    servicePointCarrierId: "ES21366",
    servicePointName: "PAPELERIA PILI",
    servicePointAddress: "CALLE DE LA BATALLA DE LEPANTO, 50002 ZARAGOZA, ES",
    servicePointPostNumber: null,
  };
  async verifyForCheckout(input: VerifyServicePointInput): Promise<ServicePointSnapshot | null> {
    this.calls.push(input);
    if (this.error !== null) {
      throw this.error;
    }
    if (input.fulfilment.deliveryType === "HOME") {
      if (input.servicePointId !== null) throw FulfilmentError.from("SERVICE_POINT_NOT_ALLOWED");
      return null;
    }
    if (input.servicePointId === null) throw FulfilmentError.from("SERVICE_POINT_REQUIRED");
    return this.snapshot;
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
      checkoutUrl: "https://whop.com/checkout/ch_test_123/",
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
  servicePoints: FakeServicePoints;
}

function buildHarness(cart: Cart = buildCart()): Harness {
  const order = orderSchema.parse(buildOrder({ id: ORDER_ID }));
  const cartDouble = new FakeCart(cart);
  const shipping = new FakeShipping();
  const inventory = new FakeInventory();
  const orders = new FakeOrders(order);
  const payments = new FakePayments();
  const servicePoints = new FakeServicePoints();
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
    servicePoints,
  );

  return { service, cart: cartDouble, shipping, inventory, orders, payments, servicePoints };
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
      checkoutUrl: "https://whop.com/checkout/ch_test_123/",
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
    expect(quote?.countryCode).toBe("ES");
    expect(quote?.shippingMethodId).toBe("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    // 1×4999 + 2×4999 gross.
    expect(quote?.subtotalGross).toBe(toMinor(14997));
    // 1×100g + 2×250g.
    expect(quote?.weightGrams).toBe(600);
  });

  it("measures the free-shipping basis AFTER the discount, not on the raw line totals (D3a)", async () => {
    // €260.00 of lines, a €20.00 coupon: a €240.00 order. Summing
    // lineTotalGross (the old basis) would give 26 000 and buy free shipping
    // over a €250 threshold that the quote endpoint correctly refused.
    const items = [cartItem(VARIANT_A, 1)].map((item) => ({
      ...item,
      unitPriceGross: toMinor(26_000),
      lineTotalGross: toMinor(26_000),
    }));
    harness = buildHarness(
      buildCart({
        items,
        totals: {
          currency: "EUR",
          subtotal: toMinor(26_000),
          discountTotal: toMinor(2_000),
          shippingTotal: toMinor(0),
          taxTotal: toMinor(0),
          grandTotal: toMinor(24_000),
        },
        discountCode: "SAVE20",
      }),
    );

    await harness.service.startCheckout(ACTOR, request());

    expect(harness.shipping.calls[0]?.subtotalGross).toBe(toMinor(24_000));
  });

  it("measures the basis over COUNTED lines only — the cart's subtotal, not every line", async () => {
    // A PRICE_CHANGED line is non-blocking, so checkout proceeds; the cart's
    // own totals are the authority on which lines count. Here the totals say
    // 4 999 while the lines sum to 14 997 — the basis must follow the totals.
    harness = buildHarness(
      buildCart({
        totals: {
          currency: "EUR",
          subtotal: toMinor(4_999),
          discountTotal: toMinor(0),
          shippingTotal: toMinor(0),
          taxTotal: toMinor(0),
          grandTotal: toMinor(4_999),
        },
      }),
    );

    await harness.service.startCheckout(ACTOR, request());

    expect(harness.shipping.calls[0]?.subtotalGross).toBe(toMinor(4_999));
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

describe("CheckoutService.startCheckout — pickup points and the fulfilment snapshot (Sendcloud §3.3)", () => {
  const PICKUP: RateFulfilment = {
    deliveryType: "SERVICE_POINT",
    carrierCode: "inpost_es",
    sendcloudOptionCode: "inpost_es:service_point,national_c2c",
    transitDaysMin: 1,
    transitDaysMax: 2,
  };
  const PICKUP_SHIPPING: ResolvedShipping = { ...SHIPPING, fulfilment: PICKUP };

  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  function expectNoSideEffects(): void {
    expect(harness.inventory.reserved).toEqual([]);
    expect(harness.orders.calls).toEqual([]);
    expect(harness.cart.clearCalls).toBe(0);
    expect(harness.payments.calls).toEqual([]);
  }

  async function reasonOf(promise: Promise<unknown>): Promise<string | null> {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    return error instanceof FulfilmentError ? error.reason : null;
  }

  it("stamps the snapshot for a HOME rate: rate id, option code, parcel weight, house number, no point", async () => {
    harness.shipping.resolved = {
      ...SHIPPING,
      fulfilment: { ...UNMAPPED_FULFILMENT, sendcloudOptionCode: "ups:standard" },
    };

    await harness.service.startCheckout(
      ACTOR,
      request({ shippingAddress: { ...request().shippingAddress, houseNumber: " 12B " } }),
    );

    expect(harness.orders.calls[0]?.fulfilment).toEqual({
      shippingRateId: SHIPPING.rateId,
      sendcloudOptionCode: "ups:standard",
      // 1×100 g + 2×250 g — the SAME weights shipping was priced with.
      parcelWeightGrams: 600,
      shipHouseNumber: "12B",
      servicePointId: null,
      servicePointCarrierId: null,
      servicePointName: null,
      servicePointAddress: null,
      servicePointPostNumber: null,
    });
  });

  it("verifies the chosen point against the RESOLVED rate and the shipping country, then snapshots it", async () => {
    harness.shipping.resolved = PICKUP_SHIPPING;

    await harness.service.startCheckout(ACTOR, request({ servicePointId: "12188365" }));

    expect(harness.servicePoints.calls).toEqual([
      { fulfilment: PICKUP, servicePointId: "12188365", countryCode: "ES" },
    ]);
    expect(harness.orders.calls[0]?.fulfilment).toMatchObject({
      shippingRateId: SHIPPING.rateId,
      sendcloudOptionCode: "inpost_es:service_point,national_c2c",
      parcelWeightGrams: 600,
      servicePointId: "12188365",
      servicePointCarrierId: "ES21366",
      servicePointName: "PAPELERIA PILI",
      servicePointAddress: "CALLE DE LA BATALLA DE LEPANTO, 50002 ZARAGOZA, ES",
      servicePointPostNumber: null,
    });
  });

  it("refuses a pickup rate with no point (SERVICE_POINT_REQUIRED) before holding stock", async () => {
    harness.shipping.resolved = PICKUP_SHIPPING;

    expect(await reasonOf(harness.service.startCheckout(ACTOR, request()))).toBe("SERVICE_POINT_REQUIRED");
    expectNoSideEffects();
  });

  it("refuses a point on a HOME rate (SERVICE_POINT_NOT_ALLOWED) before holding stock", async () => {
    expect(
      await reasonOf(harness.service.startCheckout(ACTOR, request({ servicePointId: "12188365" }))),
    ).toBe("SERVICE_POINT_NOT_ALLOWED");
    expectNoSideEffects();
  });

  it("refuses an unavailable point (wrong carrier / country / expired / closed / Sendcloud down) with no side effects", async () => {
    harness.shipping.resolved = PICKUP_SHIPPING;
    harness.servicePoints.error = FulfilmentError.from("SERVICE_POINT_UNAVAILABLE");

    expect(
      await reasonOf(harness.service.startCheckout(ACTOR, request({ servicePointId: "12188365" }))),
    ).toBe("SERVICE_POINT_UNAVAILABLE");
    expectNoSideEffects();
  });

  it("does not verify a point at all when shipping itself is refused", async () => {
    harness.shipping.error = new Error("method unavailable");

    await expect(harness.service.startCheckout(ACTOR, request({ servicePointId: "1" }))).rejects.toThrow(
      /method unavailable/,
    );
    expect(harness.servicePoints.calls).toEqual([]);
  });
});
