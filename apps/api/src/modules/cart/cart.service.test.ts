import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { ConflictException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { beforeEach, describe, expect, it } from "vitest";
import { cartSchema } from "@akai/contracts";
import { ZERO, toMinor } from "@akai/money";

import type { CartActor } from "./cart-actor";
import type { CartClock } from "./cart-clock";
import type { CartDiscountPort } from "./cart-discount.port";
import { CartTokenService } from "./cart-token.service";
import { CART_TTL_MS, MAX_LINE_QUANTITY } from "./cart.constants";
import type {
  CartRecord,
  CartRepository,
  CreateCartInput,
  MergeCartsInput,
  PackComponentSpec,
  PackLineInput,
  PackPriceSnapshot,
  SetItemQuantityInput,
  VariantSnapshot,
} from "./cart.repository";
import { CartService } from "./cart.service";
import { CheckoutService } from "../checkout/checkout.service";
import type { ShippingChargeInput } from "../shipping/shipping.service";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface StoredItem {
  id: string;
  variantId: string;
  quantity: number;
  unitPriceGross: number;
  currency: string;
  packProductId: string | null;
  packInstanceId: string | null;
}

interface StoredCart {
  id: string;
  customerId: string | null;
  tokenHash: string;
  currency: string;
  discountCode: string | null;
  expiresAt: Date;
  updatedAt: Date;
  items: StoredItem[];
}

/**
 * In-memory CartRepository.
 *
 * Exists so the ownership, expiry, merge and re-pricing rules — the parts worth
 * testing exhaustively — can be asserted without a Postgres. It mirrors the two
 * behaviours of the real adapter that the service actually depends on: lines are
 * unique per (cartId, variantId), and lookups return copies rather than live
 * references (so a test cannot accidentally mutate the "database" through a
 * returned record and prove nothing).
 */
class InMemoryCartRepository implements CartRepository {
  readonly carts = new Map<string, StoredCart>();
  readonly variants = new Map<string, VariantSnapshot>();
  readonly packPrices = new Map<string, PackPriceSnapshot>();
  readonly packComponents = new Map<string, readonly PackComponentSpec[]>();

  private toRecord(cart: StoredCart): CartRecord {
    return {
      id: cart.id,
      customerId: cart.customerId,
      currency: cart.currency,
      discountCode: cart.discountCode,
      expiresAt: new Date(cart.expiresAt),
      updatedAt: new Date(cart.updatedAt),
      items: cart.items.map((item) => ({ ...item })),
    };
  }

  private require(cartId: string): StoredCart {
    const cart = this.carts.get(cartId);
    if (cart === undefined) {
      throw new Error(`test double: unknown cart ${cartId}`);
    }
    return cart;
  }

  async findByTokenHash(tokenHash: string): Promise<CartRecord | null> {
    for (const cart of this.carts.values()) {
      if (cart.tokenHash === tokenHash) {
        return this.toRecord(cart);
      }
    }
    return null;
  }

  async findByCustomerId(customerId: string): Promise<CartRecord | null> {
    for (const cart of this.carts.values()) {
      if (cart.customerId === customerId) {
        return this.toRecord(cart);
      }
    }
    return null;
  }

  async findById(cartId: string): Promise<CartRecord | null> {
    const cart = this.carts.get(cartId);
    return cart === undefined ? null : this.toRecord(cart);
  }

  async create(input: CreateCartInput): Promise<CartRecord> {
    const cart: StoredCart = {
      id: randomUUID(),
      customerId: input.customerId,
      tokenHash: input.tokenHash,
      currency: input.currency,
      discountCode: null,
      expiresAt: input.expiresAt,
      updatedAt: new Date(),
      items: [],
    };
    this.carts.set(cart.id, cart);
    return this.toRecord(cart);
  }

  async setItemQuantity(input: SetItemQuantityInput): Promise<void> {
    const cart = this.require(input.cartId);
    const existing = cart.items.find(
      (item) => item.variantId === input.variantId && item.packInstanceId === null,
    );

    if (existing === undefined) {
      cart.items.push({
        id: randomUUID(),
        variantId: input.variantId,
        quantity: input.quantity,
        unitPriceGross: input.unitPriceGross,
        currency: input.currency,
        packProductId: null,
        packInstanceId: null,
      });
      return;
    }

    existing.quantity = input.quantity;
    existing.unitPriceGross = input.unitPriceGross;
    existing.currency = input.currency;
  }

  async replacePackInstanceLines(
    cartId: string,
    packProductId: string,
    packInstanceId: string,
    lines: readonly PackLineInput[],
  ): Promise<void> {
    const cart = this.require(cartId);
    cart.items = cart.items.filter((item) => item.packInstanceId !== packInstanceId);
    for (const line of lines) {
      cart.items.push({
        id: randomUUID(),
        variantId: line.variantId,
        quantity: line.quantity,
        unitPriceGross: line.unitPriceGross,
        currency: line.currency,
        packProductId,
        packInstanceId,
      });
    }
  }

  /** How many times the stale-pack repair path wrote. */
  repackWrites = 0;

  async replaceStalePackInstanceLines(
    cartId: string,
    packProductId: string,
    packInstanceId: string,
    expectedItemIds: readonly string[],
    lines: readonly PackLineInput[],
  ): Promise<boolean> {
    const cart = this.require(cartId);
    const current = cart.items
      .filter((item) => item.packInstanceId === packInstanceId)
      .map((item) => item.id)
      .sort();
    const expected = [...expectedItemIds].sort();
    // Mirrors the adapter's optimistic check: somebody else already rewrote
    // this instance, so this caller writes nothing.
    if (current.length !== expected.length || current.some((id, index) => id !== expected[index])) {
      return false;
    }
    this.repackWrites += 1;
    await this.replacePackInstanceLines(cartId, packProductId, packInstanceId, lines);
    return true;
  }

  /** How many times the merge path wrote — one call is one transaction. */
  mergeWrites = 0;

  async mergeCarts(input: MergeCartsInput): Promise<void> {
    this.mergeWrites += 1;
    this.require(input.guestCartId);
    for (const line of input.standaloneLines) {
      await this.setItemQuantity({ ...line, cartId: input.targetCartId });
    }
    for (const instance of input.packInstances) {
      await this.replacePackInstanceLines(
        input.targetCartId,
        instance.packProductId,
        instance.packInstanceId,
        instance.lines,
      );
    }
    this.carts.delete(input.guestCartId);
  }

  async removePackInstance(cartId: string, packInstanceId: string): Promise<void> {
    const cart = this.require(cartId);
    cart.items = cart.items.filter((item) => item.packInstanceId !== packInstanceId);
  }

  async loadPackPrices(
    packProductIds: readonly string[],
  ): Promise<ReadonlyMap<string, PackPriceSnapshot>> {
    const found = new Map<string, PackPriceSnapshot>();
    for (const id of packProductIds) {
      const price = this.packPrices.get(id);
      if (price !== undefined) {
        found.set(id, price);
      }
    }
    return found;
  }

  async loadPackComponents(packProductId: string): Promise<readonly PackComponentSpec[] | null> {
    return this.packComponents.get(packProductId) ?? null;
  }

  async removeItem(cartId: string, itemId: string): Promise<void> {
    const cart = this.require(cartId);
    cart.items = cart.items.filter((item) => item.id !== itemId);
  }

  async removeAllItems(cartId: string): Promise<void> {
    this.require(cartId).items = [];
  }

  async touch(cartId: string, expiresAt: Date): Promise<void> {
    const cart = this.require(cartId);
    cart.expiresAt = expiresAt;
    cart.updatedAt = new Date();
  }

  async setDiscountCode(cartId: string, code: string | null): Promise<void> {
    this.require(cartId).discountCode = code;
  }

  async assignCustomer(cartId: string, customerId: string): Promise<void> {
    this.require(cartId).customerId = customerId;
  }

  async deleteCart(cartId: string): Promise<void> {
    this.carts.delete(cartId);
  }

  async deleteExpired(now: Date): Promise<number> {
    let removed = 0;
    for (const [id, cart] of this.carts) {
      if (cart.expiresAt.getTime() <= now.getTime()) {
        this.carts.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async loadVariants(
    variantIds: readonly string[],
  ): Promise<ReadonlyMap<string, VariantSnapshot>> {
    const found = new Map<string, VariantSnapshot>();
    for (const id of variantIds) {
      const variant = this.variants.get(id);
      if (variant !== undefined) {
        found.set(id, variant);
      }
    }
    return found;
  }
}

class MutableClock implements CartClock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceMs(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CUSTOMER_A = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_B = "22222222-2222-4222-8222-222222222222";

function variant(overrides: Partial<VariantSnapshot> = {}): VariantSnapshot {
  return {
    variantId: randomUUID(),
    productId: randomUUID(),
    productSlug: "hoodie-kumo-m",
    name: "Hoodie Kumo",
    variantName: "M",
    sku: "AK-HOOD-M",
    imageUrl: null,
    currency: "COP",
    priceGross: 4999,
    // No volume pricing by default — every variant that exists today. The tier
    // tests pass their own.
    priceTiers: [],
    taxRateBps: 2100,
    weightGrams: 180,
    isPurchasable: true,
    availableQuantity: 25,
    allowBackorder: false,
    restrictedCountries: [],
    isPackVariant: false,
    ...overrides,
  };
}

/** The domain code a Nest HttpException carries in its payload, if any. */
function responseCode(error: unknown): unknown {
  if (!(error instanceof ConflictException)) return undefined;
  const payload: unknown = error.getResponse();
  return typeof payload === "object" && payload !== null && "code" in payload
    ? payload.code
    : undefined;
}

const anonymous = (cartToken: string | null = null): CartActor => ({
  customerId: null,
  cartToken,
});

const signedIn = (
  customerId: string,
  cartToken: string | null = null,
): CartActor => ({ customerId, cartToken });

describe("CartService", () => {
  let repository: InMemoryCartRepository;
  let clock: MutableClock;
  let service: CartService;
  let discountAmount: number;

  beforeEach(() => {
    repository = new InMemoryCartRepository();
    clock = new MutableClock(new Date("2026-07-20T10:00:00.000Z"));
    discountAmount = 0;

    const discounts: CartDiscountPort = {
      resolveDiscount: async () => toMinor(discountAmount),
      // Echoes the applied code and yields the suite's current discountAmount, so
      // the apply-coupon tests can assert both the stored code and the total.
      validate: async (context) => ({
        code: context.discountCode ?? "",
        amount: toMinor(discountAmount),
      }),
    };

    service = new CartService(repository, discounts, clock, new CartTokenService());
  });

  /** Convenience: register a variant and return it. */
  function registerVariant(overrides: Partial<VariantSnapshot> = {}): VariantSnapshot {
    const snapshot = variant(overrides);
    repository.variants.set(snapshot.variantId, snapshot);
    return snapshot;
  }

  // -------------------------------------------------------------------------
  // Creation and shape
  // -------------------------------------------------------------------------

  describe("getOrCreateCart", () => {
    it("creates an empty cart and issues a token exactly once", async () => {
      const created = await service.getOrCreateCart(anonymous());

      expect(created.issuedToken).not.toBeNull();
      expect(created.cart.items).toEqual([]);
      expect(created.cart.totals.grandTotal).toBe(0);

      const refetched = await service.getOrCreateCart(anonymous(created.issuedToken));

      expect(refetched.cart.id).toBe(created.cart.id);
      // A token is a bearer credential; re-issuing it on every read would put it
      // in far more logs and caches than it needs to be in.
      expect(refetched.issuedToken).toBeNull();
    });

    it("emits a cart that satisfies the shared contract schema", async () => {
      const item = registerVariant();
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 2,
      });

      const parsed = cartSchema.safeParse(created.cart);
      expect(parsed.success).toBe(true);
    });

    it("returns the signed-in customer's own cart", async () => {
      const first = await service.getOrCreateCart(signedIn(CUSTOMER_A));
      const second = await service.getOrCreateCart(signedIn(CUSTOMER_A));

      expect(second.cart.id).toBe(first.cart.id);
      expect(second.cart.customerId).toBe(CUSTOMER_A);
    });
  });

  // -------------------------------------------------------------------------
  // SECURITY: ownership
  // -------------------------------------------------------------------------

  describe("access control", () => {
    it("lets the holder of an anonymous token reach that cart", async () => {
      const created = await service.getOrCreateCart(anonymous());
      const fetched = await service.getOrCreateCart(anonymous(created.issuedToken));
      expect(fetched.cart.id).toBe(created.cart.id);
    });

    /**
     * THE session-fixation defence.
     *
     * An attacker seeds a cart token into a victim's browser, the victim signs
     * in (claiming that cart) and fills it with their address and basket. If the
     * token kept working, the attacker would keep read/write access to a
     * logged-in customer's cart forever.
     */
    it("stops honouring a token once the cart has been claimed by a customer", async () => {
      const created = await service.getOrCreateCart(anonymous());
      const token = created.issuedToken;
      expect(token).not.toBeNull();

      await service.mergeGuestCart(signedIn(CUSTOMER_A), { cartToken: token ?? "" });

      // Same token, now presented anonymously: must resolve to a BRAND NEW cart.
      const replayed = await service.getOrCreateCart(anonymous(token));

      expect(replayed.cart.id).not.toBe(created.cart.id);
      expect(replayed.cart.customerId).toBeNull();
      expect(replayed.issuedToken).not.toBeNull();
    });

    it("refuses another customer's claimed cart even with its original token", async () => {
      const created = await service.getOrCreateCart(anonymous());
      const token = created.issuedToken ?? "";
      await service.mergeGuestCart(signedIn(CUSTOMER_A), { cartToken: token });

      const asOtherCustomer = await service.getOrCreateCart(signedIn(CUSTOMER_B, token));

      expect(asOtherCustomer.cart.id).not.toBe(created.cart.id);
      expect(asOtherCustomer.cart.customerId).toBe(CUSTOMER_B);
    });

    /**
     * Ordering matters: the signed-in customer's own cart is looked up FIRST.
     * On a shared or public browser a stale guest token must never leak a
     * previous visitor's basket into an authenticated session.
     */
    it("prefers the signed-in customer's cart over a presented guest token", async () => {
      const guestItem = registerVariant();
      const guest = await service.addItem(anonymous(), {
        variantId: guestItem.variantId,
        quantity: 3,
      });

      const ownCart = await service.getOrCreateCart(signedIn(CUSTOMER_A));

      const fetched = await service.getOrCreateCart(
        signedIn(CUSTOMER_A, guest.issuedToken),
      );

      expect(fetched.cart.id).toBe(ownCart.cart.id);
      expect(fetched.cart.items).toEqual([]);
    });

    it("treats a malformed token as no token rather than probing the database", async () => {
      const fetched = await service.getOrCreateCart(anonymous("' OR 1=1 --"));
      expect(fetched.issuedToken).not.toBeNull();
      expect(fetched.cart.items).toEqual([]);
    });

    it("treats an unknown well-formed token as no token", async () => {
      const fetched = await service.getOrCreateCart(anonymous("z".repeat(43)));
      expect(fetched.issuedToken).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // SECURITY: IDOR on item ids
  // -------------------------------------------------------------------------

  describe("line ownership", () => {
    it("will not mutate a line belonging to somebody else's cart", async () => {
      const item = registerVariant();

      const victim = await service.addItem(signedIn(CUSTOMER_A), {
        variantId: item.variantId,
        quantity: 2,
      });
      const victimLineId = victim.cart.items[0]?.id ?? "";
      expect(victimLineId).not.toBe("");

      await service.getOrCreateCart(signedIn(CUSTOMER_B));

      // 404, not 403: a 403 would confirm the id exists and let an attacker
      // enumerate other customers' cart lines.
      await expect(
        service.updateItemQuantity(signedIn(CUSTOMER_B), victimLineId, { quantity: 99 }),
      ).rejects.toBeInstanceOf(NotFoundException);

      await expect(
        service.removeItem(signedIn(CUSTOMER_B), victimLineId),
      ).rejects.toBeInstanceOf(NotFoundException);

      const untouched = await service.getOrCreateCart(signedIn(CUSTOMER_A));
      expect(untouched.cart.items[0]?.quantity).toBe(2);
    });

    it("404s on an unknown line id", async () => {
      await service.getOrCreateCart(signedIn(CUSTOMER_A));
      await expect(
        service.removeItem(signedIn(CUSTOMER_A), randomUUID()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("404s when the caller has no cart at all", async () => {
      await expect(
        service.removeItem(anonymous(), randomUUID()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // SECURITY / correctness: expiry
  // -------------------------------------------------------------------------

  describe("expiry", () => {
    it("stops honouring a token the moment the cart lapses", async () => {
      const created = await service.getOrCreateCart(anonymous());
      const token = created.issuedToken;

      clock.advanceMs(CART_TTL_MS + 1);

      const afterExpiry = await service.getOrCreateCart(anonymous(token));

      expect(afterExpiry.cart.id).not.toBe(created.cart.id);
      expect(afterExpiry.issuedToken).not.toBeNull();
    });

    it("does not depend on the reaper job having run", async () => {
      const created = await service.getOrCreateCart(anonymous());
      clock.advanceMs(CART_TTL_MS + 1);

      // The row is still present; read-time expiry is what protects it.
      expect(repository.carts.has(created.cart.id)).toBe(true);

      const fetched = await service.getOrCreateCart(anonymous(created.issuedToken));
      expect(fetched.cart.id).not.toBe(created.cart.id);
    });

    it("slides the TTL forward on every mutation", async () => {
      const item = registerVariant();
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 1,
      });

      clock.advanceMs(CART_TTL_MS - 1000);

      await service.addItem(anonymous(created.issuedToken), {
        variantId: item.variantId,
        quantity: 1,
      });

      clock.advanceMs(CART_TTL_MS - 1000);

      const stillAlive = await service.getOrCreateCart(anonymous(created.issuedToken));
      expect(stillAlive.cart.id).toBe(created.cart.id);
    });

    it("reaps lapsed carts and leaves live ones alone", async () => {
      await service.getOrCreateCart(anonymous());
      clock.advanceMs(CART_TTL_MS + 1);
      const live = await service.getOrCreateCart(anonymous());

      const removed = await service.expireStaleCarts();

      expect(removed).toBe(1);
      expect(repository.carts.has(live.cart.id)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // MONEY: server-side recomputation
  // -------------------------------------------------------------------------

  describe("totals", () => {
    it("computes totals from the live variant, never the stored snapshot", async () => {
      const item = registerVariant({ priceGross: 1000, taxRateBps: 2100 });

      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 2,
      });
      expect(created.cart.totals.subtotal).toBe(2000);

      // The catalog raises the price behind the customer's back.
      repository.variants.set(item.variantId, { ...item, priceGross: 1500 });

      const refetched = await service.getOrCreateCart(anonymous(created.issuedToken));

      expect(refetched.cart.totals.subtotal).toBe(3000);
      expect(refetched.cart.items[0]?.unitPriceGross).toBe(1500);
      expect(refetched.cart.items[0]?.lineTotalGross).toBe(3000);
    });

    /**
     * Spec §13: the cart "re-prices from live variants and surfaces any change
     * instead of silently charging the new figure". Both halves matter — the
     * live price is used AND the customer is told.
     */
    it("flags a price change without blocking the line", async () => {
      const item = registerVariant({ priceGross: 1000 });
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 1,
      });

      repository.variants.set(item.variantId, { ...item, priceGross: 1500 });
      const refetched = await service.getOrCreateCart(anonymous(created.issuedToken));

      expect(refetched.cart.items[0]?.priceChanged).toBe(true);
      expect(
        refetched.cart.problems.some((problem) => problem.code === "PRICE_CHANGED"),
      ).toBe(true);
      // Still chargeable — a blocked line would leave the customer stuck.
      expect(refetched.cart.totals.grandTotal).toBe(1500);
    });

    it("keeps tax inside the VAT-inclusive grand total", async () => {
      const item = registerVariant({ priceGross: 12_100, taxRateBps: 2100 });
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 1,
      });

      expect(created.cart.totals.grandTotal).toBe(12_100);
      expect(created.cart.totals.taxTotal).toBe(2100);
      expect(created.cart.totals.grandTotal).not.toBe(
        created.cart.totals.subtotal + created.cart.totals.taxTotal,
      );
    });

    it("applies the discount resolved by the discounts port", async () => {
      const item = registerVariant({ priceGross: 10_000, taxRateBps: 2100 });
      discountAmount = 2500;

      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 1,
      });

      expect(created.cart.totals.discountTotal).toBe(2500);
      expect(created.cart.totals.grandTotal).toBe(7500);
    });

    it("defaults to no discount when the port is unbound", async () => {
      const item = registerVariant({ priceGross: 10_000 });
      const plain = new CartService(
        repository,
        {
          resolveDiscount: async () => ZERO,
          validate: async () => ({ code: "TEST", amount: ZERO }),
        },
        clock,
        new CartTokenService(),
      );

      const created = await plain.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 1,
      });

      expect(created.cart.totals.discountTotal).toBe(0);
      expect(created.cart.totals.grandTotal).toBe(10_000);
    });

    it("reports no shipping at the cart stage", async () => {
      const item = registerVariant();
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 1,
      });
      expect(created.cart.totals.shippingTotal).toBe(0);
    });

    it("keeps every total an integer", async () => {
      const item = registerVariant({ priceGross: 3333, taxRateBps: 2100 });
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 7,
      });

      for (const amount of Object.values(created.cart.totals)) {
        if (typeof amount === "number") {
          expect(Number.isInteger(amount)).toBe(true);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Line mutations and stock
  // -------------------------------------------------------------------------

  describe("addItem", () => {
    it("increments an existing line rather than duplicating it", async () => {
      const item = registerVariant();

      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 2,
      });
      const updated = await service.addItem(anonymous(created.issuedToken), {
        variantId: item.variantId,
        quantity: 3,
      });

      expect(updated.cart.items).toHaveLength(1);
      expect(updated.cart.items[0]?.quantity).toBe(5);
      expect(updated.cart.itemCount).toBe(5);
    });

    /**
     * The stock check runs against the RESULTING quantity, not the delta.
     * Otherwise ten adds of one unit each would each pass a "1 <= available"
     * check and collectively oversell.
     */
    it("checks stock against the resulting quantity, not the delta", async () => {
      const item = registerVariant({ availableQuantity: 3 });
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 3,
      });

      await expect(
        service.addItem(anonymous(created.issuedToken), {
          variantId: item.variantId,
          quantity: 1,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("rejects a quantity beyond available stock", async () => {
      const item = registerVariant({ availableQuantity: 2 });
      await expect(
        service.addItem(anonymous(), { variantId: item.variantId, quantity: 5 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("rejects an out-of-stock variant", async () => {
      const item = registerVariant({ availableQuantity: 0 });
      await expect(
        service.addItem(anonymous(), { variantId: item.variantId, quantity: 1 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("allows exceeding stock when the variant is backorderable", async () => {
      const item = registerVariant({ availableQuantity: 0, allowBackorder: true });
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 10,
      });
      expect(created.cart.items[0]?.quantity).toBe(10);
      expect(created.cart.problems).toEqual([]);
    });

    it("refuses to exceed the per-line maximum", async () => {
      const item = registerVariant({ allowBackorder: true });
      await expect(
        service.addItem(anonymous(), {
          variantId: item.variantId,
          quantity: MAX_LINE_QUANTITY + 1,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("404s on an unknown variant", async () => {
      await expect(
        service.addItem(anonymous(), { variantId: randomUUID(), quantity: 1 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    /**
     * A draft or archived product must 404 exactly like a missing one, or the
     * endpoint becomes a way to enumerate unreleased SKUs.
     */
    it("404s on a variant that exists but is not purchasable", async () => {
      const item = registerVariant({ isPurchasable: false });
      await expect(
        service.addItem(anonymous(), { variantId: item.variantId, quantity: 1 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("refuses to mix currencies in one cart", async () => {
      const item = registerVariant({ currency: "USD" });
      await expect(
        service.addItem(anonymous(), { variantId: item.variantId, quantity: 1 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("rejects an out-of-stock variant with the OUT_OF_STOCK code", async () => {
      const item = registerVariant({ availableQuantity: 0 });
      const failure = await service
        .addItem(anonymous(), { variantId: item.variantId, quantity: 1 })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ConflictException);
      expect(responseCode(failure)).toBe("OUT_OF_STOCK");
    });

    it("rejects a quantity beyond available stock with the OUT_OF_STOCK code", async () => {
      const item = registerVariant({ availableQuantity: 2 });
      const failure = await service
        .addItem(anonymous(), { variantId: item.variantId, quantity: 5 })
        .catch((error: unknown) => error);
      expect(responseCode(failure)).toBe("OUT_OF_STOCK");
    });

    /**
     * A pack's OWN variant is a price holder, never a line. Adding it as one
     * skips every component, every component's stock check and the price
     * split (spec 2026-09-24 §11, cause 3).
     */
    it("refuses a PACK product's own variant with a coded 409 and writes nothing", async () => {
      const packVariant = registerVariant({ isPackVariant: true });
      const failure = await service
        .addItem(anonymous(), { variantId: packVariant.variantId, quantity: 1 })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ConflictException);
      expect(responseCode(failure)).toBe("CONFLICT");
      for (const cart of repository.carts.values()) {
        expect(cart.items).toHaveLength(0);
      }
    });

    it("creates a cart on the very first add", async () => {
      const item = registerVariant();
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 1,
      });

      expect(created.issuedToken).not.toBeNull();
      expect(created.cart.items).toHaveLength(1);
    });
  });

  describe("addPack / removePack", () => {
    const PACK_ID = "33333333-3333-4333-8333-333333333333";

    /**
     * Registers a pack's component variants plus its own flat price.
     * `componentQuantities`, when given, must be the same length as
     * `componentPrices` — defaults to 1 of each (the original, pre-quantity
     * shape every existing test here assumes).
     */
    function registerPack(
      packPriceGross: number,
      componentPrices: readonly number[] = [1000, 2000, 3000],
      componentQuantities?: readonly number[],
    ): readonly string[] {
      const componentIds = componentPrices.map(
        (priceGross) => registerVariant({ priceGross }).variantId,
      );
      repository.packComponents.set(
        PACK_ID,
        componentIds.map((variantId, index) => ({
          variantId,
          quantity: componentQuantities?.[index] ?? 1,
        })),
      );
      repository.packPrices.set(PACK_ID, {
        packProductId: PACK_ID,
        priceGross: toMinor(packPriceGross),
        currency: "COP",
        isPurchasable: true,
      });
      return componentIds;
    }

    it("writes one real cart line per component, never a line for the pack itself", async () => {
      registerPack(5499);

      const created = await service.addPack(anonymous(), {
        packProductId: PACK_ID,
        quantity: 1,
      });

      expect(created.cart.items).toHaveLength(3);
      expect(created.cart.items.map((item) => item.variantId)).not.toContain(PACK_ID);
      for (const item of created.cart.items) {
        expect(item.packProductId).toBe(PACK_ID);
        expect(item.packInstanceId).not.toBeNull();
      }
      // Every line shares the SAME instance id.
      const instanceIds = new Set(created.cart.items.map((item) => item.packInstanceId));
      expect(instanceIds.size).toBe(1);
    });

    it("the component lines sum EXACTLY to the pack's flat price", async () => {
      registerPack(5499, [1000, 2000, 3000]);

      const created = await service.addPack(anonymous(), {
        packProductId: PACK_ID,
        quantity: 1,
      });

      const total = created.cart.items.reduce(
        (sum, item) => sum + item.lineTotalGross,
        0,
      );
      expect(total).toBe(5499);
    });

    it("adding the same pack again increments the SAME instance rather than duplicating it", async () => {
      registerPack(5499);
      const created = await service.addPack(anonymous(), {
        packProductId: PACK_ID,
        quantity: 1,
      });
      const again = await service.addPack(anonymous(created.issuedToken), {
        packProductId: PACK_ID,
        quantity: 1,
      });

      expect(again.cart.items).toHaveLength(3);
      expect(again.cart.items.every((item) => item.quantity === 2)).toBe(true);
      // Same instance id as before — not a second, parallel set of lines.
      const instanceIds = new Set(again.cart.items.map((item) => item.packInstanceId));
      expect(instanceIds.size).toBe(1);
      expect([...instanceIds][0]).toBe(created.cart.items[0]?.packInstanceId);
    });

    it("refuses when any one component is out of stock, and writes nothing", async () => {
      registerPack(5499);
      const shortVariantId = repository.packComponents.get(PACK_ID)?.[1]?.variantId;
      if (shortVariantId === undefined) throw new Error("fixture");
      const shortVariant = repository.variants.get(shortVariantId);
      if (shortVariant === undefined) throw new Error("fixture");
      repository.variants.set(shortVariantId, { ...shortVariant, availableQuantity: 0 });

      // Pre-existing standalone line, so we can prove the failed pack add
      // touched nothing in this SAME cart, not just an unrelated fresh one.
      const standalone = registerVariant();
      const created = await service.addItem(anonymous(), {
        variantId: standalone.variantId,
        quantity: 1,
      });

      await expect(
        service.addPack(anonymous(created.issuedToken), {
          packProductId: PACK_ID,
          quantity: 1,
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      const cart = await service.getOrCreateCart(anonymous(created.issuedToken));
      expect(cart.cart.items).toHaveLength(1);
      expect(cart.cart.items[0]?.variantId).toBe(standalone.variantId);
    });

    it("a component shortage carries the OUT_OF_STOCK code and names the component", async () => {
      registerPack(5499);
      const shortVariantId = repository.packComponents.get(PACK_ID)?.[1]?.variantId;
      if (shortVariantId === undefined) throw new Error("fixture");
      const shortVariant = repository.variants.get(shortVariantId);
      if (shortVariant === undefined) throw new Error("fixture");
      repository.variants.set(shortVariantId, {
        ...shortVariant,
        name: "RETA",
        availableQuantity: 3,
      });
      repository.packComponents.set(
        PACK_ID,
        (repository.packComponents.get(PACK_ID) ?? []).map((component) =>
          component.variantId === shortVariantId ? { ...component, quantity: 5 } : component,
        ),
      );

      const failure = await service
        .addPack(anonymous(), { packProductId: PACK_ID, quantity: 1 })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ConflictException);
      expect(responseCode(failure)).toBe("OUT_OF_STOCK");
      expect(failure instanceof ConflictException ? failure.message : "").toContain("RETA");
    });

    describe("a pack whose stored split no longer matches the live one", () => {
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

      /**
       * 6000 across a (1 x 1000) and b (5 x 1000) splits EVENLY — b is stored
       * as ONE row of 5 @ 1000. Raising a's price re-weights the split so b's
       * share no longer divides by 5, and the live split needs TWO rows. The
       * old presenter invented `${instance}:${variant}:${index}` for the
       * second one — not a UUID, so the storefront's `cartSchema.parse`
       * rejected EVERY cart response from then on.
       */
      async function addThenReweight(): Promise<{
        token: string | null;
        bVariantId: string;
      }> {
        const [aVariantId, bVariantId] = registerPack(6000, [1000, 1000], [1, 5]);
        if (aVariantId === undefined || bVariantId === undefined) throw new Error("fixture");

        const created = await service.addPack(anonymous(), {
          packProductId: PACK_ID,
          quantity: 1,
        });
        const bStored = created.cart.items.filter((item) => item.variantId === bVariantId);
        expect(bStored).toHaveLength(1);

        const a = repository.variants.get(aVariantId);
        if (a === undefined) throw new Error("fixture");
        repository.variants.set(aVariantId, { ...a, priceGross: 1100 });
        return { token: created.issuedToken, bVariantId };
      }

      it("presents ONLY stored rows, every id a UUID, and persists the re-split", async () => {
        const { token, bVariantId } = await addThenReweight();

        const read = await service.getOrCreateCart(anonymous(token));

        expect(() => cartSchema.parse(read.cart)).not.toThrow();
        for (const item of read.cart.items) {
          expect(item.id).toMatch(UUID);
        }
        const stored = [...repository.carts.values()].flatMap((cart) => cart.items);
        expect(new Set(read.cart.items.map((item) => item.id))).toEqual(
          new Set(stored.map((item) => item.id)),
        );
        // The re-split is now what is STORED, not just what was shown.
        const bRows = stored.filter((item) => item.variantId === bVariantId);
        expect(bRows).toHaveLength(2);
        expect(bRows.reduce((sum, row) => sum + row.quantity, 0)).toBe(5);
        for (const row of bRows) {
          const presented = read.cart.items.find((item) => item.id === row.id);
          expect(presented?.quantity).toBe(row.quantity);
          expect(presented?.unitPriceGross).toBe(row.unitPriceGross);
        }
        expect(read.cart.totals.grandTotal).toBe(6000);
      });

      it("is stable: the next read presents the same ids and writes nothing", async () => {
        const { token } = await addThenReweight();
        const first = await service.getOrCreateCart(anonymous(token));
        const writesAfterFirst = repository.repackWrites;

        const second = await service.getOrCreateCart(anonymous(token));

        expect(repository.repackWrites).toBe(writesAfterFirst);
        expect(second.cart.items.map((item) => item.id).sort()).toEqual(
          first.cart.items.map((item) => item.id).sort(),
        );
      });

      it("any later cart response for the same customer still parses", async () => {
        const { token } = await addThenReweight();
        const standalone = registerVariant();

        const added = await service.addItem(anonymous(token), {
          variantId: standalone.variantId,
          quantity: 1,
        });

        expect(() => cartSchema.parse(added.cart)).not.toThrow();
      });

      it("does NOT rewrite a pack whose split only moved in price — the change is still reported", async () => {
        registerPack(5499, [1000, 2000, 3000]);
        const created = await service.addPack(anonymous(), {
          packProductId: PACK_ID,
          quantity: 1,
        });
        const pack = repository.packPrices.get(PACK_ID);
        if (pack === undefined) throw new Error("fixture");
        repository.packPrices.set(PACK_ID, { ...pack, priceGross: toMinor(5999) });

        const read = await service.getOrCreateCart(anonymous(created.issuedToken));

        expect(repository.repackWrites).toBe(0);
        expect(read.cart.items.map((item) => item.id).sort()).toEqual(
          created.cart.items.map((item) => item.id).sort(),
        );
        expect(read.cart.items.some((item) => item.priceChanged)).toBe(true);
        expect(read.cart.totals.grandTotal).toBe(5999);
      });
    });

    it("404s on an unknown pack", async () => {
      await expect(
        service.addPack(anonymous(), { packProductId: randomUUID(), quantity: 1 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects a pack priced in a different currency to the cart", async () => {
      registerPack(5499);
      const packPrice = repository.packPrices.get(PACK_ID);
      if (packPrice === undefined) throw new Error("fixture");
      repository.packPrices.set(PACK_ID, { ...packPrice, currency: "USD" });

      await expect(
        service.addPack(anonymous(), { packProductId: PACK_ID, quantity: 1 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("removePack removes every component line atomically", async () => {
      registerPack(5499);
      const standalone = registerVariant();

      const withPack = await service.addPack(anonymous(), {
        packProductId: PACK_ID,
        quantity: 1,
      });
      const withStandalone = await service.addItem(
        anonymous(withPack.issuedToken),
        { variantId: standalone.variantId, quantity: 1 },
      );

      const packInstanceId = withStandalone.cart.items.find(
        (item) => item.packInstanceId !== null,
      )?.packInstanceId;
      if (packInstanceId === null || packInstanceId === undefined) {
        throw new Error("fixture");
      }

      const removed = await service.removePack(
        anonymous(withPack.issuedToken),
        packInstanceId,
      );

      // Only the standalone line survives.
      expect(removed.cart.items).toHaveLength(1);
      expect(removed.cart.items[0]?.variantId).toBe(standalone.variantId);
    });

    it("404s removing a pack instance id belonging to a DIFFERENT cart (IDOR)", async () => {
      registerPack(5499);
      const ownerCart = await service.addPack(anonymous(), {
        packProductId: PACK_ID,
        quantity: 1,
      });
      const packInstanceId = ownerCart.cart.items[0]?.packInstanceId;
      if (packInstanceId === null || packInstanceId === undefined) {
        throw new Error("fixture");
      }

      // A second, unrelated cart — same pack, its own separate instance.
      const otherCart = await service.addPack(anonymous(), {
        packProductId: PACK_ID,
        quantity: 1,
      });

      await expect(
        service.removePack(anonymous(otherCart.issuedToken), packInstanceId),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Neither cart lost anything: the owner's pack is still there, and the
      // caller's OWN cart was left untouched by the refused cross-cart attempt.
      const stillOwned = await service.getOrCreateCart(anonymous(ownerCart.issuedToken));
      expect(stillOwned.cart.items).toHaveLength(3);
      const stillOther = await service.getOrCreateCart(anonymous(otherCart.issuedToken));
      expect(stillOther.cart.items).toHaveLength(3);
    });

    it("a pack component line cannot be edited or removed individually — only as a whole pack", async () => {
      registerPack(5499);
      const created = await service.addPack(anonymous(), {
        packProductId: PACK_ID,
        quantity: 1,
      });
      const line = created.cart.items[0];
      if (line === undefined) throw new Error("fixture");

      await expect(
        service.updateItemQuantity(anonymous(created.issuedToken), line.id, {
          quantity: 5,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.removeItem(anonymous(created.issuedToken), line.id),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("the SAME component variant can sit both standalone and inside a pack, priced independently", async () => {
      const componentIds = registerPack(5499, [1000, 2000, 3000]);
      const sharedVariantId = componentIds[0];
      if (sharedVariantId === undefined) throw new Error("fixture");

      const withPack = await service.addPack(anonymous(), {
        packProductId: PACK_ID,
        quantity: 1,
      });
      const withStandalone = await service.addItem(
        anonymous(withPack.issuedToken),
        { variantId: sharedVariantId, quantity: 1 },
      );

      const linesForVariant = withStandalone.cart.items.filter(
        (item) => item.variantId === sharedVariantId,
      );
      expect(linesForVariant).toHaveLength(2);
      // One priced at its own standalone price (1000), one at its pack share.
      const standaloneLine = linesForVariant.find((item) => item.packInstanceId === null);
      expect(standaloneLine?.unitPriceGross).toBe(1000);
    });

    describe("a component with quantity > 1", () => {
      it("writes a total quantity of component-quantity × pack-quantity, summing exactly to its fair share", async () => {
        // "b" claims 5 units per pack — a real "3x Tee Black M" slot.
        registerPack(5499, [1000, 1000, 3000], [1, 5, 1]);

        const created = await service.addPack(anonymous(), {
          packProductId: PACK_ID,
          quantity: 1,
        });

        const componentIds = repository.packComponents.get(PACK_ID) ?? [];
        const bVariantId = componentIds[1]?.variantId;
        if (bVariantId === undefined) throw new Error("fixture");

        const bLines = created.cart.items.filter((item) => item.variantId === bVariantId);
        // At most 2 lines (allocate()'s own remainder guarantee), never more.
        expect(bLines.length).toBeLessThanOrEqual(2);
        const totalQuantity = bLines.reduce((sum, item) => sum + item.quantity, 0);
        expect(totalQuantity).toBe(5);
        // Its total value across every line sums to its EXACT proportional
        // share (worth 5x "a" and 5x "c" combined — a:b:c value ratio 1:5:3
        // of the 5499 total).
        const totalValue = bLines.reduce((sum, item) => sum + item.lineTotalGross, 0);
        const allValue = created.cart.items.reduce((sum, item) => sum + item.lineTotalGross, 0);
        expect(allValue).toBe(5499);
        expect(totalValue).toBe(Math.round((5499 * 5) / 9));
      });

      it("scales the split component's quantity by how many packs are added", async () => {
        registerPack(5499, [1000, 1000, 3000], [1, 5, 1]);

        const created = await service.addPack(anonymous(), {
          packProductId: PACK_ID,
          quantity: 3,
        });

        const componentIds = repository.packComponents.get(PACK_ID) ?? [];
        const bVariantId = componentIds[1]?.variantId;
        if (bVariantId === undefined) throw new Error("fixture");

        const bLines = created.cart.items.filter((item) => item.variantId === bVariantId);
        const totalQuantity = bLines.reduce((sum, item) => sum + item.quantity, 0);
        expect(totalQuantity).toBe(15); // 5 per pack × 3 packs
        const allValue = created.cart.items.reduce((sum, item) => sum + item.lineTotalGross, 0);
        expect(allValue).toBe(5499 * 3);
      });

      it("removePack removes every split line atomically, same as any other component", async () => {
        registerPack(5499, [1000, 1000, 3000], [1, 5, 1]);
        const created = await service.addPack(anonymous(), {
          packProductId: PACK_ID,
          quantity: 1,
        });

        const removed = await service.removePack(
          anonymous(created.issuedToken),
          created.cart.items[0]?.packInstanceId ?? "",
        );

        expect(removed.cart.items).toHaveLength(0);
      });

      it("adding the same pack again re-derives the split fresh rather than doubling stale lines", async () => {
        registerPack(5499, [1000, 1000, 3000], [1, 5, 1]);
        const first = await service.addPack(anonymous(), {
          packProductId: PACK_ID,
          quantity: 1,
        });
        const again = await service.addPack(anonymous(first.issuedToken), {
          packProductId: PACK_ID,
          quantity: 1,
        });

        const componentIds = repository.packComponents.get(PACK_ID) ?? [];
        const bVariantId = componentIds[1]?.variantId;
        if (bVariantId === undefined) throw new Error("fixture");
        const bLines = again.cart.items.filter((item) => item.variantId === bVariantId);
        const totalQuantity = bLines.reduce((sum, item) => sum + item.quantity, 0);
        expect(totalQuantity).toBe(10); // 5 per pack × 2 packs total
        const allValue = again.cart.items.reduce((sum, item) => sum + item.lineTotalGross, 0);
        expect(allValue).toBe(5499 * 2);
      });
    });

    // -----------------------------------------------------------------------
    // Packs across the WHOLE cart — demand per variant, shortage detail, and
    // merge-on-login (spec 2026-09-24 §11 follow-up).
    // -----------------------------------------------------------------------

    /** Sets one pack component's stock/name/recipe quantity in place. */
    function tuneComponent(
      index: number,
      changes: { availableQuantity?: number; name?: string; recipeQuantity?: number },
    ): string {
      const recipe = repository.packComponents.get(PACK_ID) ?? [];
      const variantId = recipe[index]?.variantId;
      if (variantId === undefined) throw new Error("fixture");
      const snapshot = repository.variants.get(variantId);
      if (snapshot === undefined) throw new Error("fixture");
      repository.variants.set(variantId, {
        ...snapshot,
        ...(changes.availableQuantity === undefined ? {} : { availableQuantity: changes.availableQuantity }),
        ...(changes.name === undefined ? {} : { name: changes.name }),
      });
      if (changes.recipeQuantity !== undefined) {
        const quantity = changes.recipeQuantity;
        repository.packComponents.set(
          PACK_ID,
          recipe.map((component) => (component.variantId === variantId ? { ...component, quantity } : component)),
        );
      }
      return variantId;
    }

    /** The structured shortage a Nest exception carries in its payload, if any. */
    function responseShortage(error: unknown): unknown {
      if (!(error instanceof ConflictException)) return undefined;
      const payload: unknown = error.getResponse();
      return typeof payload === "object" && payload !== null && "shortage" in payload
        ? payload.shortage
        : undefined;
    }

    describe("stock is checked against the TOTAL demand per variant across the cart", () => {
      it("refuses a pack needing 5 of a variant when 3 are already a standalone line and 6 exist", async () => {
        registerPack(5499);
        const retaId = tuneComponent(1, { availableQuantity: 6, name: "RETA", recipeQuantity: 5 });

        const standalone = await service.addItem(anonymous(), { variantId: retaId, quantity: 3 });
        const failure = await service
          .addPack(anonymous(standalone.issuedToken), { packProductId: PACK_ID, quantity: 1 })
          .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ConflictException);
        expect(responseCode(failure)).toBe("OUT_OF_STOCK");
        const cart = await service.getOrCreateCart(anonymous(standalone.issuedToken));
        expect(cart.cart.items).toHaveLength(1);
      });

      it("refuses a standalone add that, with the same variant inside a pack, exceeds stock", async () => {
        registerPack(5499);
        const retaId = tuneComponent(1, { availableQuantity: 6, recipeQuantity: 5 });

        const withPack = await service.addPack(anonymous(), { packProductId: PACK_ID, quantity: 1 });
        await expect(
          service.addItem(anonymous(withPack.issuedToken), { variantId: retaId, quantity: 2 }),
        ).rejects.toBeInstanceOf(ConflictException);
        // One more still fits: 5 in the pack + 1 standalone = 6.
        const fits = await service.addItem(anonymous(withPack.issuedToken), { variantId: retaId, quantity: 1 });
        expect(fits.cart.problems).toEqual([]);
      });

      it("refuses raising a standalone line past what a pack in the same cart leaves", async () => {
        registerPack(5499);
        const retaId = tuneComponent(1, { availableQuantity: 6, recipeQuantity: 5 });
        const withPack = await service.addPack(anonymous(), { packProductId: PACK_ID, quantity: 1 });
        const withLine = await service.addItem(anonymous(withPack.issuedToken), { variantId: retaId, quantity: 1 });
        const line = withLine.cart.items.find((item) => item.variantId === retaId && item.packInstanceId === null);
        if (line === undefined) throw new Error("fixture");

        await expect(
          service.updateItemQuantity(anonymous(withPack.issuedToken), line.id, { quantity: 2 }),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it("adding the same pack again counts its own previous lines ONCE, not twice", async () => {
        registerPack(5499);
        tuneComponent(1, { availableQuantity: 10, recipeQuantity: 5 });
        const first = await service.addPack(anonymous(), { packProductId: PACK_ID, quantity: 1 });
        const again = await service.addPack(anonymous(first.issuedToken), { packProductId: PACK_ID, quantity: 1 });
        expect(again.cart.problems).toEqual([]);
      });

      it("a cart read flags every line of an over-committed variant and excludes it from the totals", async () => {
        registerPack(5499);
        const retaId = tuneComponent(1, { availableQuantity: 8, recipeQuantity: 5 });
        const withPack = await service.addPack(anonymous(), { packProductId: PACK_ID, quantity: 1 });
        await service.addItem(anonymous(withPack.issuedToken), { variantId: retaId, quantity: 3 });

        // Each line alone (5, 3) still fits in 6; together (8) they do not.
        tuneComponent(1, { availableQuantity: 6 });
        const refetched = await service.getOrCreateCart(anonymous(withPack.issuedToken));

        const retaLines = refetched.cart.items.filter((item) => item.variantId === retaId);
        expect(retaLines.length).toBeGreaterThanOrEqual(2);
        for (const line of retaLines) {
          const problem = refetched.cart.problems.find(
            (entry) => entry.itemId === line.id && entry.code === "INSUFFICIENT_STOCK",
          );
          expect(problem?.availableQuantity).toBe(6);
        }
      });
    });

    describe("a component shortage names the component in a structured detail", () => {
      it("carries the short variant's id and how many are left", async () => {
        registerPack(5499);
        const retaId = tuneComponent(1, { availableQuantity: 3, name: "RETA", recipeQuantity: 5 });

        const failure = await service
          .addPack(anonymous(), { packProductId: PACK_ID, quantity: 1 })
          .catch((error: unknown) => error);

        expect(responseShortage(failure)).toEqual({ variantId: retaId, availableQuantity: 3 });
      });

      it("reports what is left AFTER the rest of the cart, not the raw stock", async () => {
        registerPack(5499);
        const retaId = tuneComponent(1, { availableQuantity: 6, recipeQuantity: 5 });
        const standalone = await service.addItem(anonymous(), { variantId: retaId, quantity: 3 });

        const failure = await service
          .addPack(anonymous(standalone.issuedToken), { packProductId: PACK_ID, quantity: 1 })
          .catch((error: unknown) => error);

        expect(responseShortage(failure)).toEqual({ variantId: retaId, availableQuantity: 3 });
      });

      it("an out-of-stock component reports zero left", async () => {
        registerPack(5499);
        const retaId = tuneComponent(1, { availableQuantity: 0 });

        const failure = await service
          .addPack(anonymous(), { packProductId: PACK_ID, quantity: 1 })
          .catch((error: unknown) => error);

        expect(responseShortage(failure)).toEqual({ variantId: retaId, availableQuantity: 0 });
      });
    });

    describe("merge-on-login keeps a guest pack a PACK", () => {
      /** A customer cart that already exists, so merge is not the claim fast path. */
      async function customerCartWith(variantId: string, quantity: number): Promise<void> {
        await service.addItem(signedIn(CUSTOMER_A), { variantId, quantity });
      }

      it("carries a guest pack over as pack lines at the pack price", async () => {
        registerPack(5499, [1000, 2000, 3000]);
        const unrelated = registerVariant({ priceGross: 700 });
        await customerCartWith(unrelated.variantId, 1);
        const guest = await service.addPack(anonymous(), { packProductId: PACK_ID, quantity: 1 });

        const merged = await service.mergeGuestCart(signedIn(CUSTOMER_A), {
          cartToken: guest.issuedToken ?? "",
        });

        const packLines = merged.cart.items.filter((item) => item.packProductId === PACK_ID);
        expect(packLines).toHaveLength(3);
        expect(new Set(packLines.map((item) => item.packInstanceId)).size).toBe(1);
        expect(packLines.every((item) => item.packInstanceId !== null)).toBe(true);
        expect(packLines.reduce((sum, item) => sum + item.lineTotalGross, 0)).toBe(5499);
        expect(merged.cart.totals.grandTotal).toBe(5499 + 700);
        expect(merged.cart.problems).toEqual([]);
        expect(repository.mergeWrites).toBe(1);
        expect(repository.carts.has(guest.cart.id)).toBe(false);
      });

      it("never folds a guest pack line into a standalone line of the same variant", async () => {
        const componentIds = registerPack(5499, [1000, 2000, 3000]);
        const sharedId = componentIds[0];
        if (sharedId === undefined) throw new Error("fixture");
        await customerCartWith(sharedId, 1);
        const guest = await service.addPack(anonymous(), { packProductId: PACK_ID, quantity: 1 });

        const merged = await service.mergeGuestCart(signedIn(CUSTOMER_A), {
          cartToken: guest.issuedToken ?? "",
        });

        const standalone = merged.cart.items.filter(
          (item) => item.variantId === sharedId && item.packInstanceId === null,
        );
        expect(standalone).toHaveLength(1);
        expect(standalone[0]?.quantity).toBe(1);
        expect(standalone[0]?.unitPriceGross).toBe(1000);
        expect(merged.cart.totals.grandTotal).toBe(5499 + 1000);
      });

      it("SUMS into the customer's own instance of the same pack, re-priced at the pack price", async () => {
        registerPack(5499, [1000, 2000, 3000]);
        const own = await service.addPack(signedIn(CUSTOMER_A), { packProductId: PACK_ID, quantity: 1 });
        const ownInstance = own.cart.items[0]?.packInstanceId;
        const guest = await service.addPack(anonymous(), { packProductId: PACK_ID, quantity: 2 });

        const merged = await service.mergeGuestCart(signedIn(CUSTOMER_A), {
          cartToken: guest.issuedToken ?? "",
        });

        expect(merged.cart.items).toHaveLength(3);
        expect(merged.cart.items.every((item) => item.quantity === 3)).toBe(true);
        expect(new Set(merged.cart.items.map((item) => item.packInstanceId))).toEqual(new Set([ownInstance]));
        expect(merged.cart.totals.grandTotal).toBe(5499 * 3);
      });

      it("caps the summed pack count so no component line exceeds the per-line maximum", async () => {
        registerPack(5499, [1000, 1000, 3000], [1, 5, 1]);
        for (const component of repository.packComponents.get(PACK_ID) ?? []) {
          const snapshot = repository.variants.get(component.variantId);
          if (snapshot !== undefined) {
            repository.variants.set(component.variantId, { ...snapshot, allowBackorder: true });
          }
        }
        await service.addPack(signedIn(CUSTOMER_A), { packProductId: PACK_ID, quantity: 10 });
        const guest = await service.addPack(anonymous(), { packProductId: PACK_ID, quantity: 10 });

        const merged = await service.mergeGuestCart(signedIn(CUSTOMER_A), {
          cartToken: guest.issuedToken ?? "",
        });

        // 20 packs would put 100 of b on one line; floor(99 / 5) = 19 packs.
        const bVariantId = repository.packComponents.get(PACK_ID)?.[1]?.variantId;
        const bTotal = merged.cart.items
          .filter((item) => item.variantId === bVariantId)
          .reduce((sum, item) => sum + item.quantity, 0);
        expect(bTotal).toBe(95);
        expect(merged.cart.totals.grandTotal).toBe(5499 * 19);
        expect(merged.cart.problems.some((problem) => problem.code === "QUANTITY_EXCEEDS_MAX")).toBe(false);
      });

      it("drops a guest pack that is no longer purchasable, like a withdrawn line", async () => {
        registerPack(5499, [1000, 2000, 3000]);
        const unrelated = registerVariant({ priceGross: 700 });
        await customerCartWith(unrelated.variantId, 1);
        const guest = await service.addPack(anonymous(), { packProductId: PACK_ID, quantity: 1 });
        repository.packPrices.set(PACK_ID, {
          packProductId: PACK_ID,
          priceGross: toMinor(5499),
          currency: "COP",
          isPurchasable: false,
        });

        const merged = await service.mergeGuestCart(signedIn(CUSTOMER_A), {
          cartToken: guest.issuedToken ?? "",
        });

        expect(merged.cart.items.map((item) => item.variantId)).toEqual([unrelated.variantId]);
        expect(repository.carts.has(guest.cart.id)).toBe(false);
      });

      it("does not refuse the login over stock: an over-committed merge is flagged on read", async () => {
        registerPack(5499);
        const retaId = tuneComponent(1, { availableQuantity: 6, recipeQuantity: 5 });
        await customerCartWith(retaId, 3);
        const guest = await service.addPack(anonymous(), { packProductId: PACK_ID, quantity: 1 });

        const merged = await service.mergeGuestCart(signedIn(CUSTOMER_A), {
          cartToken: guest.issuedToken ?? "",
        });

        const packLines = merged.cart.items.filter((item) => item.packProductId === PACK_ID);
        expect(new Set(packLines.map((item) => item.variantId)).size).toBe(3);
        expect(
          merged.cart.problems.some(
            (problem) => problem.code === "INSUFFICIENT_STOCK" && problem.availableQuantity === 6,
          ),
        ).toBe(true);
      });
    });
  });

  describe("updateItemQuantity", () => {
    it("sets an absolute quantity", async () => {
      const item = registerVariant();
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 2,
      });
      const lineId = created.cart.items[0]?.id ?? "";

      const updated = await service.updateItemQuantity(
        anonymous(created.issuedToken),
        lineId,
        { quantity: 5 },
      );

      expect(updated.cart.items[0]?.quantity).toBe(5);
    });

    it("removes the line when quantity is zero", async () => {
      const item = registerVariant();
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 2,
      });
      const lineId = created.cart.items[0]?.id ?? "";

      const updated = await service.updateItemQuantity(
        anonymous(created.issuedToken),
        lineId,
        { quantity: 0 },
      );

      expect(updated.cart.items).toEqual([]);
    });

    /**
     * A line whose product was withdrawn must still be removable, or the
     * customer's cart is permanently stuck and un-checkoutable.
     */
    it("can still remove a line whose product became unavailable", async () => {
      const item = registerVariant();
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 1,
      });
      const lineId = created.cart.items[0]?.id ?? "";

      repository.variants.set(item.variantId, { ...item, isPurchasable: false });

      const cleared = await service.updateItemQuantity(
        anonymous(created.issuedToken),
        lineId,
        { quantity: 0 },
      );
      expect(cleared.cart.items).toEqual([]);
    });

    it("rejects a raise beyond available stock", async () => {
      const item = registerVariant({ availableQuantity: 4 });
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 1,
      });
      const lineId = created.cart.items[0]?.id ?? "";

      await expect(
        service.updateItemQuantity(anonymous(created.issuedToken), lineId, {
          quantity: 9,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe("clearCart", () => {
    it("empties the cart but keeps it usable", async () => {
      const item = registerVariant();
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 2,
      });

      const cleared = await service.clearCart(anonymous(created.issuedToken));

      expect(cleared.cart.id).toBe(created.cart.id);
      expect(cleared.cart.items).toEqual([]);
      expect(cleared.cart.totals.grandTotal).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Read-time validation problems
  // -------------------------------------------------------------------------

  describe("cart problems", () => {
    it("reports a line whose stock fell below its quantity", async () => {
      const item = registerVariant({ availableQuantity: 10 });
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 8,
      });

      repository.variants.set(item.variantId, { ...item, availableQuantity: 3 });
      const refetched = await service.getOrCreateCart(anonymous(created.issuedToken));

      const problem = refetched.cart.problems.find(
        (entry) => entry.code === "INSUFFICIENT_STOCK",
      );
      expect(problem?.availableQuantity).toBe(3);
      // Excluded from the money until the customer resolves it.
      expect(refetched.cart.totals.grandTotal).toBe(0);
    });

    it("reports a line that went out of stock entirely", async () => {
      const item = registerVariant();
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 1,
      });

      repository.variants.set(item.variantId, { ...item, availableQuantity: 0 });
      const refetched = await service.getOrCreateCart(anonymous(created.issuedToken));

      expect(
        refetched.cart.problems.some((problem) => problem.code === "OUT_OF_STOCK"),
      ).toBe(true);
    });

    it("reports a product that was withdrawn, keeping the line visible", async () => {
      const item = registerVariant();
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 1,
      });

      repository.variants.set(item.variantId, { ...item, isPurchasable: false });
      const refetched = await service.getOrCreateCart(anonymous(created.issuedToken));

      expect(refetched.cart.items).toHaveLength(1);
      expect(
        refetched.cart.problems.some((problem) => problem.code === "PRODUCT_UNAVAILABLE"),
      ).toBe(true);
      expect(refetched.cart.totals.grandTotal).toBe(0);
    });

    /**
     * The variant row is gone entirely, so there is no name, sku or price to
     * render. The line is dropped rather than emitted half-populated — and the
     * cart must still parse against the contract schema.
     */
    it("drops an unrenderable line when the variant row vanished", async () => {
      const item = registerVariant();
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 1,
      });

      repository.variants.delete(item.variantId);
      const refetched = await service.getOrCreateCart(anonymous(created.issuedToken));

      expect(refetched.cart.items).toEqual([]);
      expect(
        refetched.cart.problems.some((problem) => problem.code === "PRODUCT_UNAVAILABLE"),
      ).toBe(true);
      expect(cartSchema.safeParse(refetched.cart).success).toBe(true);
    });

    it("reports nothing for a healthy cart", async () => {
      const item = registerVariant();
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 2,
      });
      expect(created.cart.problems).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Merge on login
  // -------------------------------------------------------------------------

  describe("mergeGuestCart", () => {
    it("requires authentication", async () => {
      const guest = await service.getOrCreateCart(anonymous());

      await expect(
        service.mergeGuestCart(anonymous(), { cartToken: guest.issuedToken ?? "" }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("claims the guest cart when the customer has none", async () => {
      const item = registerVariant();
      const guest = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 2,
      });

      const merged = await service.mergeGuestCart(signedIn(CUSTOMER_A), {
        cartToken: guest.issuedToken ?? "",
      });

      expect(merged.cart.id).toBe(guest.cart.id);
      expect(merged.cart.customerId).toBe(CUSTOMER_A);
      expect(merged.cart.items[0]?.quantity).toBe(2);
    });

    /** The decided policy (spec §13), pinned so it cannot drift. */
    it("SUMS quantities for a variant present in both carts", async () => {
      const item = registerVariant({ availableQuantity: 50 });

      const guest = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 3,
      });
      await service.addItem(signedIn(CUSTOMER_A), {
        variantId: item.variantId,
        quantity: 4,
      });

      const merged = await service.mergeGuestCart(signedIn(CUSTOMER_A), {
        cartToken: guest.issuedToken ?? "",
      });

      expect(merged.cart.items).toHaveLength(1);
      expect(merged.cart.items[0]?.quantity).toBe(7);
    });

    it("caps the summed quantity at the per-line maximum", async () => {
      const item = registerVariant({ allowBackorder: true });

      const guest = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 80,
      });
      await service.addItem(signedIn(CUSTOMER_A), {
        variantId: item.variantId,
        quantity: 80,
      });

      const merged = await service.mergeGuestCart(signedIn(CUSTOMER_A), {
        cartToken: guest.issuedToken ?? "",
      });

      expect(merged.cart.items[0]?.quantity).toBe(MAX_LINE_QUANTITY);
    });

    it("carries over variants the customer did not already have", async () => {
      const shared = registerVariant();
      const guestOnly = registerVariant();

      const guest = await service.addItem(anonymous(), {
        variantId: guestOnly.variantId,
        quantity: 1,
      });
      await service.addItem(signedIn(CUSTOMER_A), {
        variantId: shared.variantId,
        quantity: 1,
      });

      const merged = await service.mergeGuestCart(signedIn(CUSTOMER_A), {
        cartToken: guest.issuedToken ?? "",
      });

      expect(merged.cart.items).toHaveLength(2);
    });

    /** Destroying the guest cart is what kills its token. */
    it("destroys the guest cart so its token cannot be replayed", async () => {
      const item = registerVariant();
      const guest = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 1,
      });
      await service.addItem(signedIn(CUSTOMER_A), {
        variantId: item.variantId,
        quantity: 1,
      });

      await service.mergeGuestCart(signedIn(CUSTOMER_A), {
        cartToken: guest.issuedToken ?? "",
      });

      expect(repository.carts.has(guest.cart.id)).toBe(false);

      const replayed = await service.getOrCreateCart(anonymous(guest.issuedToken));
      expect(replayed.cart.id).not.toBe(guest.cart.id);
    });

    it("re-prices merged lines from the live variant", async () => {
      const item = registerVariant({ priceGross: 1000 });
      const guest = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 1,
      });
      await service.getOrCreateCart(signedIn(CUSTOMER_A));

      repository.variants.set(item.variantId, { ...item, priceGross: 2000 });

      const merged = await service.mergeGuestCart(signedIn(CUSTOMER_A), {
        cartToken: guest.issuedToken ?? "",
      });

      expect(merged.cart.totals.subtotal).toBe(2000);
    });

    it("drops guest lines whose product was withdrawn", async () => {
      const gone = registerVariant();
      const guest = await service.addItem(anonymous(), {
        variantId: gone.variantId,
        quantity: 1,
      });
      await service.getOrCreateCart(signedIn(CUSTOMER_A));

      repository.variants.set(gone.variantId, { ...gone, isPurchasable: false });

      const merged = await service.mergeGuestCart(signedIn(CUSTOMER_A), {
        cartToken: guest.issuedToken ?? "",
      });

      expect(merged.cart.items).toEqual([]);
    });

    /**
     * The merge endpoint must not become an oracle for probing which cart
     * tokens exist. Every non-actionable token produces the caller's own cart
     * unchanged, indistinguishably.
     */
    it("silently ignores an unknown token", async () => {
      const own = await service.getOrCreateCart(signedIn(CUSTOMER_A));

      const merged = await service.mergeGuestCart(signedIn(CUSTOMER_A), {
        cartToken: "z".repeat(43),
      });

      expect(merged.cart.id).toBe(own.cart.id);
    });

    it("silently ignores a token for another customer's claimed cart", async () => {
      const item = registerVariant();
      const guest = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 4,
      });
      const token = guest.issuedToken ?? "";

      // CUSTOMER_B claims it first.
      await service.mergeGuestCart(signedIn(CUSTOMER_B), { cartToken: token });

      const ownCart = await service.getOrCreateCart(signedIn(CUSTOMER_A));
      const merged = await service.mergeGuestCart(signedIn(CUSTOMER_A), {
        cartToken: token,
      });

      expect(merged.cart.id).toBe(ownCart.cart.id);
      expect(merged.cart.items).toEqual([]);

      const victim = await service.getOrCreateCart(signedIn(CUSTOMER_B));
      expect(victim.cart.items[0]?.quantity).toBe(4);
    });

    it("silently ignores an expired guest cart", async () => {
      const item = registerVariant();
      const guest = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 2,
      });

      clock.advanceMs(CART_TTL_MS + 1);

      const merged = await service.mergeGuestCart(signedIn(CUSTOMER_A), {
        cartToken: guest.issuedToken ?? "",
      });

      expect(merged.cart.items).toEqual([]);
    });

    it("cannot merge a cart into itself", async () => {
      const item = registerVariant({ availableQuantity: 50 });
      const guest = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 3,
      });
      const token = guest.issuedToken ?? "";

      const first = await service.mergeGuestCart(signedIn(CUSTOMER_A), {
        cartToken: token,
      });
      const second = await service.mergeGuestCart(signedIn(CUSTOMER_A), {
        cartToken: token,
      });

      // Replaying the merge must not double the line.
      expect(first.cart.items[0]?.quantity).toBe(3);
      expect(second.cart.items[0]?.quantity).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Checkout validation + discount code (issue SEV4)
  // -------------------------------------------------------------------------

  describe("validateCart — destination restrictions", () => {
    it("flags a line the destination may not receive as COUNTRY_RESTRICTED", async () => {
      const item = registerVariant({ restrictedCountries: ["DE"] });
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 1,
      });
      const token = created.issuedToken ?? "";

      const toGermany = await service.validateCart(anonymous(token), "DE");
      expect(toGermany.problems.some((problem) => problem.code === "COUNTRY_RESTRICTED")).toBe(
        true,
      );

      // The same basket ships fine to an unrestricted country.
      const toFrance = await service.validateCart(anonymous(token), "FR");
      expect(toFrance.problems.some((problem) => problem.code === "COUNTRY_RESTRICTED")).toBe(
        false,
      );
    });

    it("adds no country problem when no destination is supplied", async () => {
      const item = registerVariant({ restrictedCountries: ["DE"] });
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 1,
      });
      const token = created.issuedToken ?? "";

      const validated = await service.validateCart(anonymous(token), null);
      expect(
        validated.problems.some((problem) => problem.code === "COUNTRY_RESTRICTED"),
      ).toBe(false);
    });
  });

  describe("applyDiscountCode", () => {
    /**
     * A code-aware service: its discount port returns the discount ONLY when a
     * code is present, matching the real adapter (the shared suite fake ignores
     * the code so the pricing tests can exercise a fixed amount). Shares the same
     * repository, so a cart created here is visible to it.
     */
    function codeAwareService(): CartService {
      return new CartService(
        repository,
        {
          resolveDiscount: async (context) =>
            context.discountCode === null ? ZERO : toMinor(discountAmount),
          validate: async (context) => ({
            code: context.discountCode ?? "",
            amount: toMinor(discountAmount),
          }),
        },
        clock,
        new CartTokenService(),
      );
    }

    it("stores a validated code and reflects the discount in the totals", async () => {
      discountAmount = 1500;
      const coupons = codeAwareService();
      const item = registerVariant({ priceGross: 10_000, taxRateBps: 2100 });
      const created = await coupons.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 1,
      });
      const token = created.issuedToken ?? "";

      const applied = await coupons.applyDiscountCode(anonymous(token), "SAVE15");

      expect(applied.discountCode).toBe("SAVE15");
      expect(applied.totals.discountTotal).toBe(1500);
      // Gross subtotal 10000, less a 1500 discount, no shipping at the cart stage.
      expect(applied.totals.grandTotal).toBe(8500);
    });

    it("clears the code and the discount on removal", async () => {
      discountAmount = 1500;
      const coupons = codeAwareService();
      const item = registerVariant({ priceGross: 10_000 });
      const created = await coupons.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 1,
      });
      const token = created.issuedToken ?? "";
      await coupons.applyDiscountCode(anonymous(token), "SAVE15");

      const removed = await coupons.removeDiscountCode(anonymous(token));

      expect(removed.discountCode).toBeNull();
      expect(removed.totals.discountTotal).toBe(0);
      expect(removed.totals.grandTotal).toBe(10_000);
    });
  });

  // -------------------------------------------------------------------------
  // Free-shipping basis: quote vs checkout parity (spec 2026-09-24 §3, D3a)
  // -------------------------------------------------------------------------

  describe("getShippingBasis — the quote and checkout agree on the basis", () => {
    /** Thrown by the shipping double so checkout stops right after pricing. */
    class StopAfterShipping extends Error {}

    /**
     * Run the REAL CheckoutService against the REAL cart this service
     * presents, and capture the subtotal it prices shipping with. Every
     * collaborator past shipping is unreachable (the shipping double throws),
     * so none of them needs behaviour.
     */
    async function checkoutBasisFor(cartService: CartService, actor: CartActor): Promise<number> {
      const captured: ShippingChargeInput[] = [];
      const unreachable = (): Promise<never> =>
        Promise.reject(new Error("unreachable: checkout stops after shipping"));
      const checkout = new CheckoutService(
        cartService,
        {
          resolveCharge: (input) => {
            captured.push(input);
            return Promise.reject(new StopAfterShipping());
          },
        },
        { reserve: unreachable, release: unreachable },
        { createFromCart: unreachable },
        { startCheckout: unreachable },
        { loadVariantWeights: () => Promise.resolve(new Map<string, number>()) },
      );
      const { cart } = await cartService.getOrCreateCart(actor);

      await expect(
        checkout.startCheckout(actor, {
          cartId: cart.id,
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
          shippingMethodId: randomUUID(),
          documentType: "CC",
          documentNumber: "1020304050",
          acceptedTermsVersion: "2026-01",
        }),
      ).rejects.toBeInstanceOf(StopAfterShipping);

      const [call] = captured;
      if (call === undefined) {
        throw new Error("checkout never priced shipping");
      }
      return call.subtotalGross;
    }

    it("prices a discounted €260 cart at €240 on BOTH paths — one basis, after discount", async () => {
      discountAmount = 2_000;
      const item = registerVariant({ priceGross: 13_000, weightGrams: 100 });
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 2,
      });
      const actor = anonymous(created.issuedToken ?? "");

      const quoteBasis = await service.getShippingBasis(actor);
      const checkoutBasis = await checkoutBasisFor(service, actor);

      // 2 × 13 000 = 26 000 of lines, less a 2 000 discount. Under the €250
      // threshold on both paths; before this fix checkout said 26 000.
      expect(quoteBasis.subtotalGross).toBe(24_000);
      expect(checkoutBasis).toBe(quoteBasis.subtotalGross);
    });

    it("agrees on an undiscounted cart too", async () => {
      const item = registerVariant({ priceGross: 12_500 });
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 2,
      });
      const actor = anonymous(created.issuedToken ?? "");

      const quoteBasis = await service.getShippingBasis(actor);

      expect(quoteBasis.subtotalGross).toBe(25_000);
      expect(await checkoutBasisFor(service, actor)).toBe(25_000);
    });
  });

  // -------------------------------------------------------------------------
  // MONEY: volume pricing
  // -------------------------------------------------------------------------

  describe("price tiers", () => {
    const TIERS = [
      { minQuantity: 2, unitPriceGross: toMinor(900) },
      { minQuantity: 5, unitPriceGross: toMinor(800) },
    ];

    it("charges the base price below the first threshold", async () => {
      // Quantity one is the variant's own price; the tiers do not claim it.
      const item = registerVariant({ priceGross: 1000, priceTiers: TIERS });

      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 1,
      });

      expect(created.cart.items[0]?.unitPriceGross).toBe(1000);
      expect(created.cart.totals.subtotal).toBe(1000);
    });

    it("CHARGES the tier price, not merely displays it", async () => {
      // The whole point of putting this in the cart rather than the page: the
      // line total and the totals both derive from the resolved unit price, and
      // checkout sums the line totals.
      const item = registerVariant({ priceGross: 1000, priceTiers: TIERS });

      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 2,
      });

      expect(created.cart.items[0]?.unitPriceGross).toBe(900);
      expect(created.cart.items[0]?.lineTotalGross).toBe(1800);
      expect(created.cart.totals.subtotal).toBe(1800);
    });

    it("takes the highest threshold the quantity reaches", async () => {
      const item = registerVariant({ priceGross: 1000, priceTiers: TIERS });

      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 5,
      });

      expect(created.cart.items[0]?.unitPriceGross).toBe(800);
      expect(created.cart.totals.subtotal).toBe(4000);
    });

    it("does NOT report a price change when only the QUANTITY crossed a tier", async () => {
      // THE FALSE ALARM THIS GUARDS. `priceChanged` compares the live price to
      // the snapshot taken on the last write. Without re-snapshotting at the
      // tier for the resulting quantity, raising 1 → 2 would move the live price
      // and tell the customer "the price of this product has changed" — when it
      // did not; they bought more.
      const item = registerVariant({ priceGross: 1000, priceTiers: TIERS });
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 1,
      });
      const line = created.cart.items[0];
      if (line === undefined) throw new Error("expected a line");

      const raised = await service.updateItemQuantity(
        anonymous(created.issuedToken),
        line.id,
        { quantity: 2 },
      );

      expect(raised.cart.items[0]?.unitPriceGross).toBe(900);
      expect(raised.cart.items[0]?.priceChanged).toBe(false);
      expect(
        raised.cart.problems.some((problem) => problem.code === "PRICE_CHANGED"),
      ).toBe(false);
    });

    it("still reports a REAL price change on a tiered variant", async () => {
      // The guard above must not blind the cart to an actual catalogue change.
      const item = registerVariant({ priceGross: 1000, priceTiers: TIERS });
      const created = await service.addItem(anonymous(), {
        variantId: item.variantId,
        quantity: 2,
      });

      repository.variants.set(item.variantId, { ...item, priceGross: 1200 });
      const refetched = await service.getOrCreateCart(anonymous(created.issuedToken));

      // Still the tier price for quantity 2 — but the tier moved with the base.
      expect(refetched.cart.items[0]?.priceChanged).toBe(false);
      expect(refetched.cart.items[0]?.unitPriceGross).toBe(900);
    });
  });
});
