import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Cart, CartItem, CartProblem, Minor } from "@akai/contracts";
// A value, not a type: the cart CHARGES from this, and the product page quotes
// from the same function.
import { resolveUnitPrice } from "@akai/contracts";
import { ZERO, multiply, toMinor } from "@akai/money";
import { randomUUID } from "node:crypto";

import type { CartActor } from "./cart-actor";
import { CART_CLOCK, type CartClock } from "./cart-clock";
import {
  CART_DISCOUNT_PORT,
  type CartDiscountPort,
} from "./cart-discount.port";
import { calculateTotals, type TotalsLine } from "./cart-totals";
import { CartTokenService } from "./cart-token.service";
import {
  CART_TTL_MS,
  DEFAULT_CART_CURRENCY,
  DEFAULT_CART_LOCALE,
  MAX_LINE_QUANTITY,
} from "./cart.constants";
import type { AddCartItemDto, AddPackToCartDto, MergeCartDto, UpdateCartItemDto } from "./cart.dto";
import {
  CART_REPOSITORY,
  type CartItemRecord,
  type CartRecord,
  type CartRepository,
  type PackComponentSpec,
  type PackInstanceInput,
  type PackLineInput,
  type PackPriceSnapshot,
  type SetItemQuantityInput,
  type VariantSnapshot,
} from "./cart.repository";
import { demandByVariant } from "./cart-demand";
import { qualifyingSubtotal } from "../shipping/free-shipping";
import { allocatePackComponents, maxPacksPerLine, recoverPackQuantity } from "./pack-pricing";

/**
 * The result of any cart operation.
 *
 * `issuedToken` is populated ONLY on the request that created the cart. It is
 * never re-issued on a read, so a token cannot be recovered by anyone who has
 * lost it — they get a new, empty cart instead. It also travels in a response
 * HEADER rather than in the body (see CartController), keeping a bearer
 * credential out of anything a client might cache or log as data.
 */
export interface CartView {
  readonly cart: Cart;
  readonly issuedToken: string | null;
}

/**
 * The server-derived inputs to a shipping rate selection.
 *
 * Every field here is COMPUTED from the caller's cart, never accepted from them.
 * The type exists so that fact is visible at the boundary between CartModule and
 * ShippingModule: a shipping controller holding one of these cannot have been
 * handed a subtotal by a shopper, because there is no constructor for it that
 * takes one.
 */
export interface CartShippingBasis {
  readonly cartId: string;
  readonly currency: string;
  /** DISCOUNTED gross total — what the free-shipping threshold measures. */
  readonly subtotalGross: Minor;
  /** Summed parcel weight in grams across every line. */
  readonly weightGrams: number;
}

/**
 * Server-owned carts.
 *
 * THE INVARIANT THIS CLASS EXISTS TO HOLD: no monetary value ever originates
 * from the client. Prices, line totals, tax and the grand total are re-read from
 * the live variant on every single read and every single write. The DTOs cannot
 * even express an amount, so this is enforced by the shape of the input as well
 * as by the code path.
 *
 * THE OTHER INVARIANT: a cart token is a bearer credential for an ANONYMOUS cart
 * only. Once a cart has been claimed by a customer, the token stops granting
 * access to it. Without that rule, a guest token captured before login keeps
 * working against the account's cart forever.
 */
@Injectable()
export class CartService {
  constructor(
    @Inject(CART_REPOSITORY) private readonly repository: CartRepository,
    @Inject(CART_DISCOUNT_PORT) private readonly discounts: CartDiscountPort,
    @Inject(CART_CLOCK) private readonly clock: CartClock,
    private readonly tokens: CartTokenService,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Fetch the caller's cart, creating an empty one if they have none. */
  async getOrCreateCart(
    actor: CartActor,
    locale: string = DEFAULT_CART_LOCALE,
  ): Promise<CartView> {
    const existing = await this.resolveCart(actor);
    if (existing !== null) {
      return { cart: await this.present(existing, null, locale), issuedToken: null };
    }
    return this.createCart(actor, locale);
  }

  /**
   * Validate the caller's cart for checkout, resolving it by OWNERSHIP.
   *
   * Backs `POST /cart/validate` and is the first step of checkout: the cart page
   * must surface every line-level problem (out of stock, withdrawn, over the
   * per-line max, price moved) BEFORE a card is charged rather than after. Passing
   * a `countryCode` additionally flags lines the destination may not receive
   * (`COUNTRY_RESTRICTED`) — some supplements/peptides are not legal everywhere,
   * and that restriction is enforced here and again at checkout, never left to a
   * forgotten `if`.
   *
   * Throws NotFound when the actor owns no cart — the same ownership rule every
   * other read here obeys, so a cart id is never taken from the request.
   */
  async validateCart(
    actor: CartActor,
    countryCode: string | null,
    locale: string = DEFAULT_CART_LOCALE,
  ): Promise<Cart> {
    const record = await this.requireCart(actor);
    return this.present(record, countryCode, locale);
  }

  /**
   * The two figures a shipping rate is selected by, derived SERVER-SIDE from the
   * caller's own cart.
   *
   * This exists so `POST /v1/shipping/quote` can price a parcel without the
   * client stating either number. A request that could carry `subtotalGross`
   * would let anyone claim the free-over-threshold bracket; one that could carry
   * `weightGrams` would let anyone ship 20 kg at the 500 g rate. Neither is
   * expressible, because the quote endpoint asks the cart rather than the caller.
   *
   * `subtotalGross` is `qualifyingSubtotal(totals)` — counted lines, after
   * discount — the SAME function checkout prices shipping with, so a quote and
   * the charge that follows it can never disagree about the free-shipping
   * threshold. A threshold measured against the pre-discount figure would
   * promise free delivery on a basket that stops qualifying for it the moment
   * the coupon applies.
   *
   * A null variant weight contributes zero grams; see the note on
   * `VariantSnapshot.weightGrams` for why that direction is the safe one.
   */
  async getShippingBasis(actor: CartActor): Promise<CartShippingBasis> {
    const record = await this.requireCart(actor);
    const cart = await this.present(record);
    const variants = await this.repository.loadVariants(
      record.items.map((item) => item.variantId),
    );

    let weightGrams = 0;
    for (const line of record.items) {
      const variant = variants.get(line.variantId);
      if (variant === undefined) {
        continue;
      }
      weightGrams += (variant.weightGrams ?? 0) * line.quantity;
    }

    return {
      cartId: record.id,
      currency: record.currency,
      subtotalGross: qualifyingSubtotal(cart.totals),
      weightGrams,
    };
  }

  // -------------------------------------------------------------------------
  // Line mutations
  // -------------------------------------------------------------------------

  async addItem(
    actor: CartActor,
    dto: AddCartItemDto,
    locale: string = DEFAULT_CART_LOCALE,
  ): Promise<CartView> {
    // Adding to a cart that does not exist yet creates one, so a first-time
    // visitor's very first action works without a preceding GET.
    const resolved = await this.resolveCart(actor);
    const created = resolved === null ? await this.createCartRecord(actor) : null;
    const record = resolved ?? created?.record;

    // Narrowing, not a formality: exactly one of the two branches above always
    // produces a record, but that is proven to the compiler rather than asserted
    // away with a non-null `!`.
    if (record === undefined) {
      throw new NotFoundException("Cart not found");
    }

    const variant = await this.requirePurchasableVariant(dto.variantId);
    this.assertNotPackVariant(variant);
    this.assertSameCurrency(record, variant);

    // SCOPED TO STANDALONE LINES (`packInstanceId === null`). The SAME variant
    // can also be sitting in this cart as part of a pack instance — see
    // `CartItem`'s own schema comment — and that line must never be the one
    // this ordinary add increments; the two partial indexes in the database
    // enforce the same separation on write.
    const existingLine = record.items.find(
      (item) => item.variantId === dto.variantId && item.packInstanceId === null,
    );

    // A second add INCREMENTS the existing line rather than creating a duplicate
    // (the `cart_item_standalone_key` partial index says the same thing at the
    // DB level). The stock check therefore runs against the resulting total,
    // not against the delta — otherwise ten adds of one unit each would each
    // pass a "1 <= available" check and collectively oversell.
    const desiredQuantity = (existingLine?.quantity ?? 0) + dto.quantity;
    // ...and against the WHOLE cart's demand for this variant: the same
    // variant inside a pack draws on the same stock.
    this.assertQuantityAvailable(
      variant,
      desiredQuantity,
      this.demandAfter(record, (item) => item === existingLine, [
        { variantId: dto.variantId, quantity: desiredQuantity },
      ]),
    );

    await this.repository.setItemQuantity({
      cartId: record.id,
      variantId: dto.variantId,
      quantity: desiredQuantity,
      // Re-snapshotted to the LIVE price on every write — at the tier the
      // RESULTING quantity reaches, so a line that crosses a threshold is not
      // then reported as "the price of this product has changed".
      unitPriceGross: resolveUnitPrice(
        toMinor(variant.priceGross),
        variant.priceTiers,
        desiredQuantity,
      ),
      currency: variant.currency,
    });

    await this.touch(record.id);
    return {
      cart: await this.presentById(record.id, locale),
      issuedToken: created?.token ?? null,
    };
  }

  /** Sets an absolute quantity. Zero removes the line (spec: one less endpoint). */
  async updateItemQuantity(
    actor: CartActor,
    itemId: string,
    dto: UpdateCartItemDto,
    locale: string = DEFAULT_CART_LOCALE,
  ): Promise<CartView> {
    const record = await this.requireCart(actor);
    const line = this.requireLine(record, itemId);
    this.assertNotPackLine(line);

    if (dto.quantity === 0) {
      await this.repository.removeItem(record.id, line.id);
    } else {
      const variant = await this.requirePurchasableVariant(line.variantId);
      this.assertSameCurrency(record, variant);
      this.assertQuantityAvailable(
        variant,
        dto.quantity,
        this.demandAfter(record, (item) => item.id === line.id, [
          { variantId: line.variantId, quantity: dto.quantity },
        ]),
      );

      await this.repository.setItemQuantity({
        cartId: record.id,
        variantId: line.variantId,
        quantity: dto.quantity,
        unitPriceGross: resolveUnitPrice(
          toMinor(variant.priceGross),
          variant.priceTiers,
          dto.quantity,
        ),
        currency: variant.currency,
      });
    }

    await this.touch(record.id);
    return { cart: await this.presentById(record.id, locale), issuedToken: null };
  }

  async removeItem(
    actor: CartActor,
    itemId: string,
    locale: string = DEFAULT_CART_LOCALE,
  ): Promise<CartView> {
    const record = await this.requireCart(actor);
    const line = this.requireLine(record, itemId);
    this.assertNotPackLine(line);

    await this.repository.removeItem(record.id, line.id);
    await this.touch(record.id);

    return { cart: await this.presentById(record.id, locale), issuedToken: null };
  }

  async clearCart(
    actor: CartActor,
    locale: string = DEFAULT_CART_LOCALE,
  ): Promise<CartView> {
    const record = await this.requireCart(actor);
    await this.repository.removeAllItems(record.id);
    await this.touch(record.id);
    return { cart: await this.presentById(record.id, locale), issuedToken: null };
  }

  // -------------------------------------------------------------------------
  // Packs — "add pack to cart" resolves the pack's pinned components and
  // writes THEIR real variants as real cart lines. The pack's own variant is
  // never added here. See `ProductPackComponent`'s schema comment for the
  // full design and why checkout needs no special case for any of this.
  // -------------------------------------------------------------------------

  async addPack(
    actor: CartActor,
    dto: AddPackToCartDto,
    locale: string = DEFAULT_CART_LOCALE,
  ): Promise<CartView> {
    const resolved = await this.resolveCart(actor);
    const created = resolved === null ? await this.createCartRecord(actor) : null;
    const record = resolved ?? created?.record;
    if (record === undefined) {
      throw new NotFoundException("Cart not found");
    }

    const components = await this.repository.loadPackComponents(dto.packProductId);
    // 404 for "does not exist" AND for "is not a pack" — same reasoning
    // `requirePurchasableVariant` gives for collapsing its own two cases: an
    // enumeration oracle over which products are packs is not something this
    // endpoint should hand out either.
    if (components === null || components.length === 0) {
      throw new NotFoundException("Pack not found");
    }

    const packPrices = await this.repository.loadPackPrices([dto.packProductId]);
    const packPrice = packPrices.get(dto.packProductId);
    if (packPrice === undefined || !packPrice.isPurchasable) {
      throw new NotFoundException("Pack not found");
    }
    // Same rule `assertSameCurrency` states for an ordinary variant — the pack
    // itself has no variant record to run it against, so this is the direct
    // form of the same check.
    if (packPrice.currency !== record.currency) {
      throw new ConflictException(
        "This product is priced in a different currency to your cart",
      );
    }

    const componentVariantIds = components.map((component) => component.variantId);
    const variants = await this.repository.loadVariants(componentVariantIds, locale);
    for (const variantId of componentVariantIds) {
      const variant = variants.get(variantId);
      if (variant === undefined || !variant.isPurchasable) {
        throw new ConflictException(
          "This pack is missing a component that is no longer available",
        );
      }
    }

    // REUSING AN EXISTING INSTANCE, NOT MINTING A SECOND ONE. "Add this pack
    // again" scales every component line together — the same "a second add
    // increments" rule `addItem` follows for an ordinary line — rather than
    // creating a parallel, independently-priced copy of the same pack. How
    // many packs it already holds is recovered from its stored rows by
    // `recoverPackQuantity` (see there for why that is not a bare read).
    const packInstanceId =
      record.items.find((item) => item.packProductId === dto.packProductId)?.packInstanceId ??
      randomUUID();
    const previousPackQuantity = recoverPackQuantity(
      components,
      record.items.filter((item) => item.packInstanceId === packInstanceId),
    );
    const desiredPackQuantity = previousPackQuantity + dto.quantity;

    const lines = this.pricePackLines(packPrice, components, variants, desiredPackQuantity);

    // NO PACK-LEVEL STOCK CHECK — the whole point of the recorded decision
    // (spec §1: strict per-component stock, not a separate pack-level count).
    // Every component's OWN stock is checked, against the WHOLE cart's demand
    // for its variant once this instance holds `desiredPackQuantity` packs:
    // the same variant standalone, or inside another pack, draws on the same
    // units. The instance's own previous rows are the ones being replaced, so
    // they are swapped out, not counted twice.
    const demand = demandByVariant([
      ...record.items.filter((item) => item.packInstanceId !== packInstanceId),
      ...lines,
    ]);
    for (const component of components) {
      const variant = variants.get(component.variantId);
      if (variant === undefined) {
        continue;
      }
      this.assertQuantityAvailable(
        variant,
        component.quantity * desiredPackQuantity,
        demand.get(component.variantId) ?? 0,
      );
    }

    await this.repository.replacePackInstanceLines(
      record.id,
      dto.packProductId,
      packInstanceId,
      lines,
    );

    await this.touch(record.id);
    return {
      cart: await this.presentById(record.id, locale),
      issuedToken: created?.token ?? null,
    };
  }

  async removePack(
    actor: CartActor,
    packInstanceId: string,
    locale: string = DEFAULT_CART_LOCALE,
  ): Promise<CartView> {
    const record = await this.requireCart(actor);
    // Ownership check: at least one line of this instance must belong to the
    // caller's own cart — the same IDOR shape `requireLine` guards against for
    // an ordinary item id.
    const owned = record.items.some((item) => item.packInstanceId === packInstanceId);
    if (!owned) {
      throw new NotFoundException("Pack not found in cart");
    }

    await this.repository.removePackInstance(record.id, packInstanceId);
    await this.touch(record.id);
    return { cart: await this.presentById(record.id, locale), issuedToken: null };
  }

  // -------------------------------------------------------------------------
  // Discount code
  // -------------------------------------------------------------------------

  /**
   * Apply a coupon code to the caller's cart (issue SEV4 — the discount engine
   * was built but nothing let a customer reach it).
   *
   * The code is VALIDATED against the live, undiscounted subtotal before it is
   * stored: an unknown, expired, below-minimum or exhausted code throws (surfaced
   * as 422 with a reason) rather than being silently ignored, which is the whole
   * point of an "apply" action. On success the stored code makes every subsequent
   * cart read reflect the discount through the same pricing path.
   */
  async applyDiscountCode(
    actor: CartActor,
    code: string,
    locale: string = DEFAULT_CART_LOCALE,
  ): Promise<Cart> {
    const record = await this.requireCart(actor);

    // The undiscounted gross subtotal the discount minimum is measured against.
    // `present`'s `totals.subtotal` is the sum of live line gross, before any
    // discount, regardless of what code (if any) the cart currently carries.
    const current = await this.present(record);

    const validated = await this.discounts.validate({
      cartId: record.id,
      customerId: record.customerId,
      currency: record.currency,
      discountCode: code,
      subtotal: current.totals.subtotal,
    });

    await this.repository.setDiscountCode(record.id, validated.code);
    await this.touch(record.id);
    return this.presentById(record.id, locale);
  }

  /** Remove any applied coupon code from the caller's cart. */
  async removeDiscountCode(
    actor: CartActor,
    locale: string = DEFAULT_CART_LOCALE,
  ): Promise<Cart> {
    const record = await this.requireCart(actor);
    await this.repository.setDiscountCode(record.id, null);
    await this.touch(record.id);
    return this.presentById(record.id, locale);
  }

  // -------------------------------------------------------------------------
  // Merge on login
  // -------------------------------------------------------------------------

  /**
   * Fold an anonymous cart into the caller's own cart.
   *
   * POLICY (spec §13, decided and pinned by test): quantity-SUM, capped at the
   * per-line maximum. Not "replace" (which loses the basket the customer built
   * while logged in on another device) and not "keep the larger" (which
   * surprises someone who deliberately added to both).
   *
   * Stock is NOT enforced here. A login that fails because a merged line
   * exceeds stock is a terrible failure mode, and it is unnecessary: read-time
   * validation surfaces the shortfall as a cart problem and checkout is blocked
   * while any problem is present. The customer sees it and fixes it before
   * paying.
   *
   * The method is deliberately quiet about tokens it will not act on. An unknown
   * token, an expired one, or one belonging to another customer's cart all
   * produce the caller's own cart unchanged, with no error — otherwise the
   * endpoint becomes an oracle for probing which cart tokens exist.
   */
  async mergeGuestCart(actor: CartActor, dto: MergeCartDto): Promise<CartView> {
    if (actor.customerId === null) {
      throw new UnauthorizedException("Authentication required to merge a cart");
    }
    const customerId = actor.customerId;

    const guest = await this.findAnonymousCartByToken(dto.cartToken);

    if (guest === null) {
      return this.getOrCreateCart(actor);
    }

    const target = await this.findOwnCart(customerId);

    // Fast path: the customer has no cart of their own, so claiming the guest
    // cart wholesale is both cheaper and lossless. The token is now attached to
    // a claimed cart, which `mayAccess` stops honouring on its own.
    if (target === null) {
      await this.repository.assignCustomer(guest.id, customerId);
      await this.touch(guest.id);
      return { cart: await this.presentById(guest.id), issuedToken: null };
    }

    // PACKS SURVIVE AS PACKS. A guest pack's component lines are regrouped
    // by instance and re-added the way `addPack` would: the live recipe, the
    // live pack price split across it, summed into the customer's own
    // instance of the same pack when there is one. Folding them into ordinary
    // lines — what this did before — charged every component at its full
    // standalone price and silently dropped the pack discount at login.
    const packProductIds = [
      ...new Set(
        [...guest.items, ...target.items]
          .map((item) => item.packProductId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const packPrices = await this.repository.loadPackPrices(packProductIds);
    const recipes = new Map(
      await Promise.all(
        packProductIds.map(
          async (id) => [id, await this.repository.loadPackComponents(id)] as const,
        ),
      ),
    );

    const variants = await this.repository.loadVariants([
      ...guest.items.map((item) => item.variantId),
      ...[...recipes.values()].flatMap((recipe) => (recipe ?? []).map((component) => component.variantId)),
    ]);

    const standaloneLines: Omit<SetItemQuantityInput, "cartId">[] = [];
    for (const guestItem of guest.items) {
      if (guestItem.packInstanceId !== null) {
        continue;
      }
      const variant = variants.get(guestItem.variantId);

      // A line whose product has since been withdrawn is dropped rather than
      // carried over: merging it would create a cart that can never check out.
      // A pack's own variant as an ordinary line never passed a component
      // stock check (see `assertNotPackVariant`), so it is not carried either.
      if (variant === undefined || !variant.isPurchasable || variant.isPackVariant) {
        continue;
      }
      if (variant.currency !== target.currency) {
        continue;
      }

      // STANDALONE ONLY. The same variant may also sit inside one of the
      // customer's packs, and that line is not the one this sums into.
      const existing = target.items.find(
        (item) => item.variantId === guestItem.variantId && item.packInstanceId === null,
      );

      const summed = (existing?.quantity ?? 0) + guestItem.quantity;
      const merged = Math.min(summed, MAX_LINE_QUANTITY);

      standaloneLines.push({
        variantId: guestItem.variantId,
        quantity: merged,
        unitPriceGross: resolveUnitPrice(
          toMinor(variant.priceGross),
          variant.priceTiers,
          merged,
        ),
        currency: variant.currency,
      });
    }

    // One entry per pack PRODUCT in the result — the customer's own instance
    // when they have one (addPack's reuse rule), otherwise a fresh id. Keyed
    // by product so two guest instances of one pack also collapse into one.
    const packsByProduct = new Map<string, { packInstanceId: string; quantity: number }>();
    const guestPackGroups = new Map<string, CartItemRecord[]>();
    for (const item of guest.items) {
      if (item.packInstanceId === null) {
        continue;
      }
      const group = guestPackGroups.get(item.packInstanceId) ?? [];
      group.push(item);
      guestPackGroups.set(item.packInstanceId, group);
    }

    for (const lines of guestPackGroups.values()) {
      const packProductId = lines[0]?.packProductId ?? null;
      if (packProductId === null) {
        continue;
      }
      const packPrice = packPrices.get(packProductId);
      const recipe = recipes.get(packProductId) ?? null;
      // Dropped, like a withdrawn ordinary line: a pack that can no longer be
      // bought, whose recipe is gone, in another currency, or with a component
      // that is no longer sold would be a cart that can never check out.
      if (
        packPrice === undefined ||
        !packPrice.isPurchasable ||
        packPrice.currency !== target.currency ||
        recipe === null ||
        recipe.length === 0 ||
        recipe.some((component) => {
          const variant = variants.get(component.variantId);
          return variant === undefined || !variant.isPurchasable || variant.currency !== target.currency;
        })
      ) {
        continue;
      }
      const guestPacks = recoverPackQuantity(recipe, lines);
      if (guestPacks === 0) {
        continue;
      }

      let entry = packsByProduct.get(packProductId);
      if (entry === undefined) {
        const ownInstanceId =
          target.items.find((item) => item.packProductId === packProductId)?.packInstanceId ?? null;
        entry = {
          packInstanceId: ownInstanceId ?? randomUUID(),
          quantity:
            ownInstanceId === null
              ? 0
              : recoverPackQuantity(
                  recipe,
                  target.items.filter((item) => item.packInstanceId === ownInstanceId),
                ),
        };
        packsByProduct.set(packProductId, entry);
      }
      // Quantity-SUM, capped — the ordinary-line policy above, with the cap
      // being the one `addPack` enforces: no component line past
      // MAX_LINE_QUANTITY. (`addPackToCartSchema`'s 10 caps ONE request, not
      // the instance — `addPack` itself accumulates past it.) Stock is not
      // enforced, for the reason the method comment gives; the read path
      // flags an over-committed variant against the whole cart's demand.
      entry.quantity = Math.min(entry.quantity + guestPacks, maxPacksPerLine(recipe, MAX_LINE_QUANTITY));
    }

    const packInstances: PackInstanceInput[] = [];
    for (const [packProductId, entry] of packsByProduct) {
      const packPrice = packPrices.get(packProductId);
      const recipe = recipes.get(packProductId) ?? null;
      if (packPrice === undefined || recipe === null || entry.quantity === 0) {
        continue;
      }
      packInstances.push({
        packProductId,
        packInstanceId: entry.packInstanceId,
        lines: this.pricePackLines(packPrice, recipe, variants, entry.quantity),
      });
    }

    // ONE TRANSACTION: every line lands and the guest cart is destroyed, or
    // nothing happens. The guest cart is destroyed, not left claimed: its
    // token dies with it, which is the point — a token captured before login
    // must not survive it.
    await this.repository.mergeCarts({
      targetCartId: target.id,
      guestCartId: guest.id,
      standaloneLines,
      packInstances,
    });
    await this.touch(target.id);

    return { cart: await this.presentById(target.id), issuedToken: null };
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /**
   * Reap carts past their TTL. Driven by the `cart-expiry` cron (spec §5).
   *
   * Expiry is enforced on READ as well (see `isExpired`), so a cart is
   * unreachable the moment it lapses whether or not this job has run. The job
   * exists to bound table growth, not to be the security boundary — a
   * correctness rule that depends on a cron having fired is not a rule.
   */
  async expireStaleCarts(): Promise<number> {
    return this.repository.deleteExpired(this.clock.now());
  }

  // -------------------------------------------------------------------------
  // Access control
  // -------------------------------------------------------------------------

  /**
   * Resolve the cart this actor is entitled to, or null.
   *
   * The customer-owned cart is looked up FIRST. That ordering matters: an
   * authenticated caller who also presents a stale guest token must get their
   * own cart, never the guest one, or a shared/public browser would leak a
   * previous visitor's basket into a logged-in session.
   */
  private async resolveCart(actor: CartActor): Promise<CartRecord | null> {
    if (actor.customerId !== null) {
      const owned = await this.findOwnCart(actor.customerId);
      if (owned !== null) {
        return owned;
      }
    }

    if (actor.cartToken === null || !this.tokens.isWellFormed(actor.cartToken)) {
      return null;
    }

    const byToken = await this.repository.findByTokenHash(
      this.tokens.hash(actor.cartToken),
    );

    if (byToken === null || this.isExpired(byToken)) {
      return null;
    }

    return this.mayAccess(byToken, actor) ? byToken : null;
  }

  /**
   * THE ownership rule.
   *
   * An anonymous cart belongs to whoever holds its token. A CLAIMED cart belongs
   * to its customer and to nobody else — presenting the token that originally
   * created it is not sufficient, because that token may have been captured
   * before the cart was claimed (a session-fixation shape: attacker seeds a
   * token into a victim's browser, victim logs in and fills the cart, attacker
   * replays the token).
   */
  private mayAccess(cart: CartRecord, actor: CartActor): boolean {
    if (cart.customerId === null) {
      return true;
    }
    return actor.customerId !== null && cart.customerId === actor.customerId;
  }

  private async findOwnCart(customerId: string): Promise<CartRecord | null> {
    const cart = await this.repository.findByCustomerId(customerId);
    if (cart === null || this.isExpired(cart)) {
      return null;
    }
    return cart;
  }

  /**
   * A token lookup that only ever yields an UNCLAIMED cart.
   *
   * Used by the merge path, which must not be able to reach a cart already
   * belonging to a customer — including the caller's own, since merging a cart
   * into itself would double every line.
   */
  private async findAnonymousCartByToken(token: string): Promise<CartRecord | null> {
    if (!this.tokens.isWellFormed(token)) {
      return null;
    }

    const cart = await this.repository.findByTokenHash(this.tokens.hash(token));

    if (cart === null || cart.customerId !== null || this.isExpired(cart)) {
      return null;
    }
    return cart;
  }

  private isExpired(cart: CartRecord): boolean {
    return cart.expiresAt.getTime() <= this.clock.now().getTime();
  }

  private async requireCart(actor: CartActor): Promise<CartRecord> {
    const cart = await this.resolveCart(actor);
    if (cart === null) {
      throw new NotFoundException("Cart not found");
    }
    return cart;
  }

  /**
   * Find a line WITHIN a cart the caller has already been proven to own.
   *
   * This is the IDOR defence for item ids, and it is structural rather than a
   * remembered check: the only line ids reachable are the ones on the resolved
   * cart, so another customer's item id simply is not in the list. A non-owner
   * gets 404 rather than 403, so the response cannot be used to confirm that an
   * id exists.
   */
  private requireLine(cart: CartRecord, itemId: string): CartItemRecord {
    const line = cart.items.find((item) => item.id === itemId);
    if (line === undefined) {
      throw new NotFoundException("Cart item not found");
    }
    return line;
  }

  /**
   * A pack's component lines are add/remove-atomic — see `CartItem`'s own
   * schema comment for why. `updateItem`/`removeItem` operate on ONE line and
   * would leave a pack partially edited, which has no sensible flat price;
   * `removePack` is the only way to touch one of these.
   */
  private assertNotPackLine(line: CartItemRecord): void {
    if (line.packInstanceId !== null) {
      throw new ConflictException(
        "This item is part of a pack. Remove the whole pack instead.",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Creation / persistence helpers
  // -------------------------------------------------------------------------

  private async createCartRecord(
    actor: CartActor,
  ): Promise<{ record: CartRecord; token: string }> {
    const { token, tokenHash } = this.tokens.mint();

    const record = await this.repository.create({
      tokenHash,
      customerId: actor.customerId,
      currency: DEFAULT_CART_CURRENCY,
      expiresAt: this.nextExpiry(),
    });

    return { record, token };
  }

  private async createCart(
    actor: CartActor,
    locale: string = DEFAULT_CART_LOCALE,
  ): Promise<CartView> {
    const { record, token } = await this.createCartRecord(actor);
    return { cart: await this.present(record, null, locale), issuedToken: token };
  }

  private nextExpiry(): Date {
    return new Date(this.clock.now().getTime() + CART_TTL_MS);
  }

  /** Every mutation slides the TTL forward — the window is "since last touched". */
  private async touch(cartId: string): Promise<void> {
    await this.repository.touch(cartId, this.nextExpiry());
  }

  private async requireRecordById(cartId: string): Promise<CartRecord> {
    const record = await this.repository.findById(cartId);
    if (record === null) {
      throw new NotFoundException("Cart not found");
    }
    return record;
  }

  private async presentById(
    cartId: string,
    locale: string = DEFAULT_CART_LOCALE,
  ): Promise<Cart> {
    return this.present(await this.requireRecordById(cartId), null, locale);
  }

  private async requirePurchasableVariant(
    variantId: string,
  ): Promise<VariantSnapshot> {
    const variants = await this.repository.loadVariants([variantId]);
    const variant = variants.get(variantId);

    // 404 for "does not exist" AND for "exists but is not purchasable". A draft
    // or archived product must not be distinguishable from a missing one, or the
    // endpoint becomes a way to enumerate unreleased SKUs.
    if (variant === undefined || !variant.isPurchasable) {
      throw new NotFoundException("Product variant not found");
    }
    return variant;
  }

  /**
   * A PACK product's own variant only holds the pack's flat price. As an
   * ordinary line it would skip every component, every component's stock
   * check and the price split — `addPack` is the only way in. 409, not 404:
   * the variant is public (it is on the product page), so there is nothing to
   * hide, and the caller made a routing mistake rather than a lookup one.
   */
  private assertNotPackVariant(variant: VariantSnapshot): void {
    if (variant.isPackVariant) {
      throw new ConflictException({
        code: "CONFLICT",
        message: "A pack is added to the cart as a pack, not as a single item",
      });
    }
  }

  private assertSameCurrency(cart: CartRecord, variant: VariantSnapshot): void {
    if (variant.currency !== cart.currency) {
      throw new ConflictException(
        "This product is priced in a different currency to your cart",
      );
    }
  }

  /**
   * The cart's total demand for `variantId` once a write lands: every current
   * row except the ones `replaced` matches, plus the rows the write would
   * store. The summation itself is `demandByVariant`'s — this only builds the
   * prospective cart.
   */
  private demandAfter(
    record: CartRecord,
    replaced: (item: CartItemRecord) => boolean,
    written: readonly { readonly variantId: string; readonly quantity: number }[],
  ): number {
    const variantId = written[0]?.variantId;
    if (variantId === undefined) {
      return 0;
    }
    return (
      demandByVariant([...record.items.filter((item) => !replaced(item)), ...written]).get(variantId) ??
      0
    );
  }

  /**
   * One pack instance's rows at `packQuantity` packs: the pack's live flat
   * price split across the live recipe (`pack-pricing.ts`), ALLOCATED AT THE
   * SINGLE-PACK BASIS (`component.quantity`) and scaled by `packQuantity`
   * afterwards — see `allocatePackComponents` for why. Shared by `addPack`,
   * the read path and merge-on-login, so all three store the same split.
   */
  private pricePackLines(
    packPrice: PackPriceSnapshot,
    recipe: readonly PackComponentSpec[],
    variants: ReadonlyMap<string, VariantSnapshot>,
    packQuantity: number,
  ): PackLineInput[] {
    const allocated = allocatePackComponents(
      packPrice.priceGross,
      recipe.map((component) => {
        const variant = variants.get(component.variantId);
        return {
          lineId: component.variantId,
          liveUnitPrice:
            variant === undefined
              ? toMinor(0)
              : resolveUnitPrice(
                  toMinor(variant.priceGross),
                  variant.priceTiers,
                  component.quantity * packQuantity,
                ),
          quantity: component.quantity,
        };
      }),
    );
    return allocated.map((share) => ({
      variantId: share.lineId,
      quantity: share.quantity * packQuantity,
      unitPriceGross: share.unitPriceGross,
      currency: variants.get(share.lineId)?.currency ?? packPrice.currency,
    }));
  }

  /**
   * Reject a quantity the warehouse cannot satisfy.
   *
   * `lineQuantity` is the line being written (the per-line maximum applies to
   * it); `cartDemand` is the WHOLE cart's demand for this variant once the
   * write lands (`demandByVariant`), which is what stock is measured against —
   * the same variant standalone and inside a pack draws on the same units.
   *
   * This is a courtesy check that gives a clear error at add-time; it is NOT the
   * oversell defence. That is the conditional decrement at fulfilment
   * (`updateMany` with `quantity: { gte: n }`, spec §4), because any check
   * performed here is inherently racy — two customers can both pass it for the
   * last unit in the same millisecond.
   */
  private assertQuantityAvailable(
    variant: VariantSnapshot,
    lineQuantity: number,
    cartDemand: number,
  ): void {
    if (lineQuantity > MAX_LINE_QUANTITY) {
      throw new ConflictException(
        `A single line may not exceed ${MAX_LINE_QUANTITY} units`,
      );
    }

    if (variant.allowBackorder || cartDemand <= variant.availableQuantity) {
      return;
    }

    // What this line could still have: stock less everything ELSE in the
    // cart. That, not the raw stock figure, is the number a customer can act
    // on — "only 6 left" is wrong when 3 of them are already in their basket.
    const left = Math.max(0, variant.availableQuantity - (cartDemand - lineQuantity));

    // CODED OUT_OF_STOCK, with a STRUCTURED `shortage` naming the variant and
    // what is left. Un-coded, the exception filter derives CONFLICT from the
    // status and the storefront says "no longer available" about a product
    // that is merely short. The component's NAME is in the message so a pack
    // shortage is legible in a log; clients never render this string — they
    // branch on `code` and read `shortage` (parsed against
    // `stockShortageSchema`) to name the component in their own language.
    throw new ConflictException({
      code: "OUT_OF_STOCK",
      message:
        left === 0
          ? `${variant.name}: out of stock`
          : `${variant.name}: only ${left} units are available`,
      shortage: { variantId: variant.variantId, availableQuantity: left },
    });
  }

  // -------------------------------------------------------------------------
  // Presentation — where every price is re-read from the live variant
  // -------------------------------------------------------------------------

  /**
   * `allowRepair` is true on the first pass only. A stale pack instance (see
   * `matchPackLines`) is re-split and PERSISTED, and the cart is then presented
   * once more from what is now stored — with repair off, so a second
   * disagreement degrades the pack instead of looping.
   */
  private async present(
    record: CartRecord,
    countryCode: string | null = null,
    locale: string = DEFAULT_CART_LOCALE,
    allowRepair = true,
  ): Promise<Cart> {
    const variants = await this.repository.loadVariants(
      record.items.map((item) => item.variantId),
      locale,
    );

    // Every PACK product referenced by any line, resolved in one batched call
    // — a cart typically holds at most a handful of distinct packs, never one
    // query per line.
    const packProductIds = [
      ...new Set(
        record.items
          .map((item) => item.packProductId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const packPrices = await this.repository.loadPackPrices(packProductIds);

    // Each pack's CURRENT recipe (component variant + its own quantity),
    // needed to regroup stored lines back into logical components below —
    // a component with quantity > 1 can be split across up to two stored
    // rows (`pack-pricing.ts`), so "one stored row = one component" no
    // longer holds and re-pricing has to reconstitute the recipe first.
    const recipesByPackProductId = new Map(
      await Promise.all(
        packProductIds.map(
          async (id) => [id, await this.repository.loadPackComponents(id)] as const,
        ),
      ),
    );

    // GROUP BY packInstanceId. Every line with a null packInstanceId is its
    // own group of one — ordinary lines are priced exactly as before, one at
    // a time; a pack's N component lines are priced TOGETHER, because the
    // allocation of the pack's flat price across them is only meaningful as a
    // group (see `pack-pricing.ts`).
    const standaloneLines = record.items.filter((item) => item.packInstanceId === null);
    const packGroups = new Map<string, CartItemRecord[]>();
    for (const item of record.items) {
      if (item.packInstanceId === null) {
        continue;
      }
      const group = packGroups.get(item.packInstanceId) ?? [];
      group.push(item);
      packGroups.set(item.packInstanceId, group);
    }

    // Stock is one number per variant, so every line of a variant is judged
    // against the WHOLE cart's demand for it — standalone, inside any pack,
    // and across a split pack component's two rows.
    const demand = demandByVariant(record.items);

    const items: CartItem[] = [];
    const problems: CartProblem[] = [];
    const totalsLines: TotalsLine[] = [];
    const staleInstances: {
      readonly packProductId: string;
      readonly packInstanceId: string;
      readonly expectedItemIds: readonly string[];
      readonly lines: readonly PackLineInput[];
    }[] = [];

    const emit = (
      line: CartItemRecord,
      variant: VariantSnapshot | undefined,
      overridePrice?: Minor,
      forcedProblem?: { readonly code: CartProblem["code"]; readonly message: string },
    ): void => {
      // The variant row is gone entirely (hard-deleted under a live cart), so
      // there is no name, sku or price to render. The line is dropped from
      // `items` — an unrenderable line is worse than an absent one — and the
      // problem carries the item id so the UI can say what happened.
      if (variant === undefined) {
        problems.push({
          itemId: line.id,
          code: "PRODUCT_UNAVAILABLE",
          message: "This product is no longer available",
        });
        return;
      }

      const evaluated = this.evaluateLine(
        record,
        line,
        variant,
        demand.get(line.variantId) ?? line.quantity,
        overridePrice,
        forcedProblem,
      );
      items.push(evaluated.item);
      problems.push(...evaluated.problems);
      totalsLines.push(evaluated.totalsLine);

      // Country restriction is only knowable once a destination is supplied
      // (checkout / explicit validation), so it lives here rather than in the
      // destination-agnostic per-line evaluation. It blocks checkout without
      // altering the displayed totals — the customer still sees the line and why
      // it cannot ship.
      if (countryCode !== null && variant.restrictedCountries.includes(countryCode)) {
        problems.push({
          itemId: line.id,
          code: "COUNTRY_RESTRICTED",
          message: "This product cannot be shipped to the selected country",
        });
      }
    };

    for (const line of standaloneLines) {
      emit(line, variants.get(line.variantId));
    }

    for (const [packInstanceId, lines] of packGroups) {
      const packProductId = lines[0]?.packProductId ?? null;
      const packPrice = packProductId === null ? undefined : packPrices.get(packProductId);
      const recipe = packProductId === null ? null : (recipesByPackProductId.get(packProductId) ?? null);
      const degrade = (): void => {
        // THE WHOLE INSTANCE DEGRADES TOGETHER, at each component's own live
        // price — never a partial pack silently priced as if it were still
        // whole. Every surviving line still renders so the customer can see
        // and remove it; none of them count toward the totals.
        for (const line of lines) {
          emit(line, variants.get(line.variantId), undefined, {
            code: "PRODUCT_UNAVAILABLE",
            message: "This pack is no longer available",
          });
        }
      };

      if (packPrice === undefined || !packPrice.isPurchasable || recipe === null || recipe.length === 0) {
        degrade();
        continue;
      }

      // RECOVER "HOW MANY PACKS", the same way `addPack` does — a component
      // with recipe quantity > 1 can be split across two stored rows, which
      // `recoverPackQuantity` sums before dividing.
      const packQuantity = recoverPackQuantity(recipe, lines);
      // The recipe changed too much to reconcile (every stored variant is
      // now absent from it) — degrade exactly like an unavailable pack
      // rather than guessing.
      if (packQuantity === 0) {
        degrade();
        continue;
      }

      const freshLines = this.pricePackLines(packPrice, recipe, variants, packQuantity);
      const subLinesByVariant = new Map<string, FreshPackSubLine[]>();
      for (const fresh of freshLines) {
        const group = subLinesByVariant.get(fresh.variantId) ?? [];
        group.push({ unitPriceGross: fresh.unitPriceGross, quantity: fresh.quantity });
        subLinesByVariant.set(fresh.variantId, group);
      }

      // EVERY PRESENTED LINE IS A STORED ROW. Where the live split still lines
      // up with what is stored, each fresh sub-line is shown under its stored
      // row's id and snapshot price (so `priceChanged` compares against
      // something real). Where it does NOT — a component's price or tier moved
      // so "5 @ x" is now "3 @ x + 2 @ x+1", or the recipe changed — the pack
      // is STALE, and it is re-split and persisted rather than presented with
      // an invented id: `cartItemSchema.id` is a UUID, and one fabricated id
      // made every later cart response for that customer fail to parse
      // (spec 2026-09-24 §11, cause 1).
      const matched = matchPackLines(
        [...new Set(recipe.map((component) => component.variantId))],
        subLinesByVariant,
        lines,
      );

      if (matched === null) {
        if (allowRepair && packProductId !== null) {
          staleInstances.push({
            packProductId,
            packInstanceId,
            expectedItemIds: lines.map((line) => line.id),
            lines: freshLines,
          });
        } else {
          // Still disagreeing straight after a re-split was stored: never
          // guess, never invent — show the stored rows, excluded from totals.
          degrade();
        }
        continue;
      }

      for (const { stored, fresh } of matched) {
        emit(stored, variants.get(stored.variantId), fresh.unitPriceGross);
      }
    }

    if (staleInstances.length > 0) {
      for (const stale of staleInstances) {
        // `false` means a concurrent read already stored the re-split; the
        // re-read below picks up ITS rows, which is just as correct.
        await this.repository.replaceStalePackInstanceLines(
          record.id,
          stale.packProductId,
          stale.packInstanceId,
          stale.expectedItemIds,
          stale.lines,
        );
      }
      return this.present(await this.requireRecordById(record.id), countryCode, locale, false);
    }

    // Two passes, because a discount rule is a function of the subtotal and the
    // subtotal is a function of live prices. The first pass computes the
    // subtotal with no discount; the second applies whatever the discounts
    // module resolves against it.
    const undiscounted = calculateTotals({
      currency: record.currency,
      lines: totalsLines,
      discountTotal: ZERO,
      shippingTotal: ZERO,
    });

    const discountTotal = await this.discounts.resolveDiscount({
      cartId: record.id,
      customerId: record.customerId,
      currency: record.currency,
      discountCode: record.discountCode,
      subtotal: undiscounted.subtotal,
    });

    const totals = calculateTotals({
      currency: record.currency,
      lines: totalsLines,
      discountTotal,
      // Always zero at the cart stage: no destination is known, so no rate can
      // be quoted. ShippingModule computes this at checkout, where an address
      // exists. Showing a speculative shipping figure here would be a price the
      // customer is not actually going to be charged.
      shippingTotal: ZERO,
    });

    return {
      id: record.id,
      customerId: record.customerId,
      items,
      itemCount: items.reduce((count, item) => count + item.quantity, 0),
      totals,
      discountCode: record.discountCode,
      problems,
      expiresAt: record.expiresAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  /**
   * Price and validate one line against the LIVE variant.
   *
   * The snapshot price on the row is used for exactly one thing — detecting that
   * the price moved — and never for arithmetic.
   *
   * `cartDemand` is the WHOLE cart's demand for this line's variant
   * (`demandByVariant`), and is what stock is judged against: two lines that
   * each fit on their own can together over-commit the variant, and then
   * every line of it is flagged.
   *
   * `overridePrice` is how a pack-component line reuses every one of the
   * checks below (purchasability, currency, stock, max quantity) unchanged —
   * only WHICH price counts as "live" differs, never how a line is validated.
   * `forcedProblem` is how `present()` degrades a whole pack instance
   * together when the PACK itself (not this component) is unavailable: it is
   * always added and always disqualifies the line from the totals, on top of
   * whatever this component's own checks find.
   */
  private evaluateLine(
    cart: CartRecord,
    line: CartItemRecord,
    variant: VariantSnapshot,
    cartDemand: number,
    overridePrice?: Minor,
    forcedProblem?: { readonly code: CartProblem["code"]; readonly message: string },
  ): { item: CartItem; problems: CartProblem[]; totalsLine: TotalsLine } {
    const problems: CartProblem[] = [];
    let countsTowardTotals = true;

    if (forcedProblem !== undefined) {
      problems.push({ itemId: line.id, ...forcedProblem });
      countsTowardTotals = false;
    }

    // THE PRICE IS A FUNCTION OF THE QUANTITY, not of the variant alone. This
    // single expression is what makes the cart, its totals and the checkout sum
    // agree about volume pricing: `lineTotalGross` and `totalsLine` below are
    // both derived from it, and checkout sums `lineTotalGross`.
    const livePrice: Minor =
      overridePrice ??
      resolveUnitPrice(toMinor(variant.priceGross), variant.priceTiers, line.quantity);

    if (variant.isPackVariant && line.packInstanceId === null) {
      // A pack's own variant sitting as an ordinary line — only reachable from
      // a cart filled before `addItem` refused it. It never passed a
      // component stock check, so it must not be charged; the customer can
      // still see and remove it.
      problems.push({
        itemId: line.id,
        code: "PRODUCT_UNAVAILABLE",
        message: "This pack must be added to the cart as a pack",
      });
      countsTowardTotals = false;
    } else if (!variant.isPurchasable) {
      problems.push({
        itemId: line.id,
        code: "PRODUCT_UNAVAILABLE",
        message: "This product is no longer available",
      });
      countsTowardTotals = false;
    } else if (variant.currency !== cart.currency) {
      // Cannot be charged alongside the rest of the basket, and must never be
      // silently converted at an unaudited rate.
      problems.push({
        itemId: line.id,
        code: "PRODUCT_UNAVAILABLE",
        message: "This product is priced in a different currency",
      });
      countsTowardTotals = false;
    } else {
      const available = variant.allowBackorder
        ? Number.POSITIVE_INFINITY
        : variant.availableQuantity;

      if (available <= 0) {
        problems.push({
          itemId: line.id,
          code: "OUT_OF_STOCK",
          message: "This product is out of stock",
          availableQuantity: 0,
        });
        countsTowardTotals = false;
      } else if (cartDemand > available) {
        problems.push({
          itemId: line.id,
          code: "INSUFFICIENT_STOCK",
          message: `Only ${variant.availableQuantity} units are available`,
          availableQuantity: variant.availableQuantity,
        });
        countsTowardTotals = false;
      }
    }

    if (line.quantity > MAX_LINE_QUANTITY) {
      problems.push({
        itemId: line.id,
        code: "QUANTITY_EXCEEDS_MAX",
        message: `A single line may not exceed ${MAX_LINE_QUANTITY} units`,
      });
      countsTowardTotals = false;
    }

    // A moved price is REPORTED but does NOT disqualify the line: the customer
    // is charged the live price and told about the change, which is the
    // behaviour spec §13 requires ("surfaces any change instead of silently
    // charging the new figure"). Blocking the line instead would leave the
    // customer with no way to proceed.
    const priceChanged = livePrice !== line.unitPriceGross;
    if (priceChanged) {
      problems.push({
        itemId: line.id,
        code: "PRICE_CHANGED",
        message: "The price of this product has changed since you added it",
      });
    }

    return {
      item: {
        id: line.id,
        variantId: variant.variantId,
        productId: variant.productId,
        productSlug: variant.productSlug,
        name: variant.name,
        variantName: variant.variantName,
        sku: variant.sku,
        imageUrl: variant.imageUrl,
        quantity: line.quantity,
        unitPriceGross: livePrice,
        lineTotalGross: multiply(livePrice, line.quantity),
        priceChanged,
        packProductId: line.packProductId,
        packInstanceId: line.packInstanceId,
      },
      problems,
      totalsLine: {
        quantity: line.quantity,
        unitPriceGross: livePrice,
        taxRateBps: variant.taxRateBps,
        countsTowardTotals,
      },
    };
  }
}

/** One sub-line of a pack's LIVE split, already scaled by the pack quantity. */
interface FreshPackSubLine {
  readonly unitPriceGross: Minor;
  readonly quantity: number;
}

/**
 * Pair a pack instance's stored rows with its live split, or report that they
 * cannot be paired (`null` — the instance is stale and must be re-split).
 *
 * DETERMINISTIC, NOT POSITIONAL. Rows written by one `createMany` share a
 * `createdAt`, so "the first stored row" is whatever order Postgres returns
 * them in. Per component variant, rows are paired first on the exact
 * (price, quantity) — `cart_item_pack_key` makes (variant, price) unique
 * within an instance, so that match is unambiguous — and whatever is left is
 * paired by quantity, largest first, cheapest first. A pair whose quantities
 * differ, a count mismatch, or a stored row no live sub-line claims (its
 * variant left the recipe) all mean stale.
 */
function matchPackLines(
  recipeVariantIds: readonly string[],
  freshByVariant: ReadonlyMap<string, readonly FreshPackSubLine[]>,
  storedLines: readonly CartItemRecord[],
): { stored: CartItemRecord; fresh: FreshPackSubLine }[] | null {
  const pairs: { stored: CartItemRecord; fresh: FreshPackSubLine }[] = [];

  for (const variantId of recipeVariantIds) {
    const fresh = [...(freshByVariant.get(variantId) ?? [])];
    const stored = storedLines.filter((line) => line.variantId === variantId);
    if (fresh.length !== stored.length) {
      return null;
    }

    const unmatchedStored: CartItemRecord[] = [];
    for (const row of stored) {
      const exact = fresh.findIndex(
        (sub) => sub.unitPriceGross === row.unitPriceGross && sub.quantity === row.quantity,
      );
      if (exact === -1) {
        unmatchedStored.push(row);
        continue;
      }
      const [sub] = fresh.splice(exact, 1);
      if (sub !== undefined) {
        pairs.push({ stored: row, fresh: sub });
      }
    }

    const byQuantityThenPrice = (
      a: { quantity: number; unitPriceGross: number },
      b: { quantity: number; unitPriceGross: number },
    ): number => b.quantity - a.quantity || a.unitPriceGross - b.unitPriceGross;
    unmatchedStored.sort(byQuantityThenPrice);
    fresh.sort(byQuantityThenPrice);

    for (const [index, row] of unmatchedStored.entries()) {
      const sub = fresh[index];
      if (sub === undefined || sub.quantity !== row.quantity) {
        return null;
      }
      pairs.push({ stored: row, fresh: sub });
    }
  }

  // Every stored row must have been claimed — one left over belongs to a
  // variant that is no longer in the recipe.
  return pairs.length === storedLines.length ? pairs : null;
}
