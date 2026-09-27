import type { Minor, PriceTier } from "@akai/contracts";

/**
 * The cart persistence PORT.
 *
 * CartService depends on this interface, not on PrismaService. Two reasons, and
 * neither is architectural purity:
 *
 *  1. The money and ownership logic in CartService is the part most worth
 *     testing exhaustively, and binding it to Prisma would make every one of
 *     those tests need a live Postgres. Behind a port they are plain unit tests
 *     against an in-memory double, so the security cases (IDOR, token reuse
 *     after claim, expiry) are cheap enough to enumerate properly.
 *  2. The Prisma adapter stays a thin, obvious translation layer with no
 *     branching worth hiding a bug in; it is covered by the integration suite
 *     in apps/api-e2e against a real database.
 *
 * Rows cross this boundary as plain readonly records, NOT as Prisma model
 * types. That keeps the service free of ORM shapes and means a schema column
 * rename cannot silently change a money field's meaning without a compile error
 * here first.
 */

export interface CartRecord {
  readonly id: string;
  /** Null while anonymous. Set by the merge/claim path on login. */
  readonly customerId: string | null;
  readonly currency: string;
  readonly discountCode: string | null;
  readonly expiresAt: Date;
  readonly updatedAt: Date;
  readonly items: readonly CartItemRecord[];
}

export interface CartItemRecord {
  readonly id: string;
  readonly variantId: string;
  readonly quantity: number;
  /**
   * Price snapshotted when the line was added — DISPLAY ONLY.
   *
   * The cart re-prices from the live variant on every read (spec §13). This
   * value exists solely so a price movement can be DETECTED and surfaced to the
   * customer; it is never what gets charged.
   */
  readonly unitPriceGross: number;
  readonly currency: string;
  /**
   * Set together, or both null. Every component line of one "add pack to
   * cart" event shares the same `packInstanceId` — see `CartItem`'s own
   * schema comment (libs/db/prisma/schema.prisma) for the full design.
   */
  readonly packProductId: string | null;
  readonly packInstanceId: string | null;
}

/**
 * Everything CartService needs to know about a sellable variant, flattened from
 * variant + product + inventory in one query.
 *
 * Flattened deliberately: assembling this in the adapter means the service can
 * never accidentally read a stale `availableQuantity` from a lazily-loaded
 * relation, and there is exactly one place where "is this purchasable?" is
 * decided.
 */
export interface VariantSnapshot {
  readonly variantId: string;
  readonly productId: string;
  readonly productSlug: string;
  readonly name: string;
  readonly variantName: string | null;
  readonly sku: string;
  readonly imageUrl: string | null;
  readonly currency: string;
  /** LIVE gross price in integer minor units. The price at quantity ONE. */
  readonly priceGross: number;
  /**
   * Volume pricing, ascending. Empty means one price at every quantity.
   *
   * CARRIED ON THE SNAPSHOT because the cart prices from this projection, not
   * from `PublicProduct` — so a tier that reached the product page but not here
   * would quote one number and charge another.
   */
  readonly priceTiers: readonly PriceTier[];
  readonly taxRateBps: number;
  /**
   * Grams, per unit. Null on a variant with no recorded weight.
   *
   * Read ONLY to compute a parcel weight for a shipping quote. A null weight is
   * treated as zero grams by the summing caller, which is the conservative
   * direction for the CUSTOMER (it can only select a cheaper bracket, never an
   * unshippable one) and is visible to operations as an under-quoted parcel
   * rather than as a checkout the shopper cannot complete.
   */
  readonly weightGrams: number | null;
  /** Active variant, active product, neither soft-deleted. */
  readonly isPurchasable: boolean;
  /**
   * `onHand - reserved`, never stored.
   *
   * The adapter reports 0 when no inventory row exists. That FAIL-CLOSED
   * default is deliberate: a variant with no stock record is an unfinished
   * product setup, and treating unknown stock as unlimited is how an oversell
   * happens on the first day a new SKU is published.
   */
  readonly availableQuantity: number;
  readonly allowBackorder: boolean;
  readonly restrictedCountries: readonly string[];
  /**
   * True when this is a PACK product's own variant.
   *
   * That variant only HOLDS the pack's flat price — it is never a cart line.
   * `CartService.addItem` refuses it, because adding it directly would skip
   * every component, every component's stock check and the price split.
   * `addPack` is the only way a pack reaches a cart.
   */
  readonly isPackVariant: boolean;
}

export interface CreateCartInput {
  readonly tokenHash: string;
  readonly customerId: string | null;
  readonly currency: string;
  readonly expiresAt: Date;
}

export interface SetItemQuantityInput {
  readonly cartId: string;
  readonly variantId: string;
  readonly quantity: number;
  /** Re-snapshotted to the LIVE price on every write. */
  readonly unitPriceGross: Minor;
  readonly currency: string;
}

/** One component line to write as part of one pack instance. */
export interface PackLineInput {
  readonly variantId: string;
  readonly quantity: number;
  readonly unitPriceGross: Minor;
  readonly currency: string;
}

/** One pack instance to (re)write in full, as `replacePackInstanceLines` does. */
export interface PackInstanceInput {
  readonly packProductId: string;
  readonly packInstanceId: string;
  readonly lines: readonly PackLineInput[];
}

/**
 * Everything merge-on-login writes, applied as ONE unit — see
 * `CartRepository.mergeCarts`.
 */
export interface MergeCartsInput {
  readonly targetCartId: string;
  readonly guestCartId: string;
  /** Standalone upserts into the target, as `setItemQuantity` (`cartId` is the target). */
  readonly standaloneLines: readonly Omit<SetItemQuantityInput, "cartId">[];
  /** Pack instances of the TARGET to replace wholesale (new or existing ids). */
  readonly packInstances: readonly PackInstanceInput[];
}

/** One component of a pack's recipe: which variant is pinned, and how many. */
export interface PackComponentSpec {
  readonly variantId: string;
  readonly quantity: number;
}

/**
 * The pack product's OWN live price — never a cart line, but the reference
 * figure `CartService.addPack` pro-rates across the real component lines.
 */
export interface PackPriceSnapshot {
  readonly packProductId: string;
  readonly priceGross: Minor;
  readonly currency: string;
  readonly isPurchasable: boolean;
}

export interface CartRepository {
  /** Anonymous lookup. The hash is the stored form; the raw token never is. */
  findByTokenHash(tokenHash: string): Promise<CartRecord | null>;

  findByCustomerId(customerId: string): Promise<CartRecord | null>;

  /**
   * Lookup by primary key.
   *
   * Used ONLY to re-read a cart the caller has already proven ownership of in
   * the same request (after a mutation). It is deliberately not reachable from a
   * client-supplied id — no cart endpoint takes a cart id — because resolving a
   * cart by bare id is exactly the IDOR shape that `ownedBy()` exists to prevent.
   */
  findById(cartId: string): Promise<CartRecord | null>;

  create(input: CreateCartInput): Promise<CartRecord>;

  /**
   * Upsert a STANDALONE (non-pack) line by (cartId, variantId) — a second add
   * increments, never duplicates. Targets the `cart_item_standalone_key`
   * partial index (`WHERE packInstanceId IS NULL`); never touches a line that
   * belongs to a pack instance, even one on the same variant — see
   * `CartItem`'s own schema comment for why both can coexist.
   */
  setItemQuantity(input: SetItemQuantityInput): Promise<void>;

  /**
   * Atomically REPLACE every component line of ONE pack instance: delete
   * whatever is currently stored for `(cartId, packInstanceId)`, then insert
   * `lines` fresh, inside one transaction.
   *
   * REPLACE, NOT UPSERT — deliberately, since a component with quantity > 1
   * can legitimately need a DIFFERENT NUMBER of stored rows between calls
   * (one when its allocated share divides evenly, two when it doesn't — see
   * `pack-pricing.ts`), so there is no stable per-row identity to upsert
   * against. A pack instance is never partially edited by a caller (only
   * added-as-a-whole or removed-as-a-whole), so replacing the whole set on
   * every write is safe and much simpler than reconciling a row count that
   * can shift as live prices move.
   */
  replacePackInstanceLines(
    cartId: string,
    packProductId: string,
    packInstanceId: string,
    lines: readonly PackLineInput[],
  ): Promise<void>;

  /**
   * The READ-PATH repair of a stale pack instance: the same delete + insert as
   * `replacePackInstanceLines`, but CONDITIONAL on the instance still holding
   * exactly `expectedItemIds` — the rows the caller read and found stale.
   *
   * Conditional because this runs inside a cart READ, and two reads of the
   * same cart can run concurrently. An unconditional replace from both would
   * insert the re-split twice. Here the second one finds the rows it expected
   * already gone, writes nothing and returns `false`; the caller simply
   * re-reads what the first one stored.
   *
   * Returns `true` when this call wrote the lines.
   */
  replaceStalePackInstanceLines(
    cartId: string,
    packProductId: string,
    packInstanceId: string,
    expectedItemIds: readonly string[],
    lines: readonly PackLineInput[],
  ): Promise<boolean>;

  /**
   * Merge-on-login's whole write, in ONE transaction: upsert each standalone
   * line into the target, replace each listed target pack instance, and delete
   * the guest cart (its items cascade, its token dies with it).
   *
   * One transaction because a half-applied merge is the worst outcome on
   * offer: a crash between "copied the lines" and "deleted the guest cart"
   * leaves a live guest token whose replay adds everything a second time.
   */
  mergeCarts(input: MergeCartsInput): Promise<void>;

  /** Removes every line sharing this `packInstanceId`, atomically. */
  removePackInstance(cartId: string, packInstanceId: string): Promise<void>;

  /**
   * Live price for however many of the given PACK products are asked for —
   * batched so `present()` resolves every pack instance in one cart with one
   * query rather than N. Missing ids are simply absent from the map, the same
   * "absence means unavailable" contract `loadVariants` already has.
   */
  loadPackPrices(
    packProductIds: readonly string[],
  ): Promise<ReadonlyMap<string, PackPriceSnapshot>>;

  /**
   * One pack's recipe: which variant is pinned per component and how many of
   * it, in the admin's chosen order. `null` when `packProductId` does not
   * name a live product with `kind === PACK` — the caller
   * (`CartService.addPack`) treats that identically to "product not found",
   * the same 404 `requirePurchasableVariant` gives an ordinary missing variant.
   */
  loadPackComponents(packProductId: string): Promise<readonly PackComponentSpec[] | null>;

  removeItem(cartId: string, itemId: string): Promise<void>;

  removeAllItems(cartId: string): Promise<void>;

  /** Pushes `expiresAt` forward. Called on every mutation. */
  touch(cartId: string, expiresAt: Date): Promise<void>;

  /**
   * Set (or clear, with null) the applied discount code. The code itself is not
   * validated here — that is CartService's job, before it calls this — so the
   * adapter stays a dumb write.
   */
  setDiscountCode(cartId: string, code: string | null): Promise<void>;

  /** Claims an anonymous cart for a customer. */
  assignCustomer(cartId: string, customerId: string): Promise<void>;

  deleteCart(cartId: string): Promise<void>;

  /** Reaps carts past `expiresAt`. Returns how many were removed. */
  deleteExpired(now: Date): Promise<number>;

  /**
   * Live variant data for the given ids. Missing ids are simply absent from the
   * map — the service treats absence as "unavailable", which is the correct
   * response to a variant that was hard-deleted under a live cart.
   */
  loadVariants(
    variantIds: readonly string[],
    /**
     * Locale for the DISPLAY strings (`name`, `variantName`).
     *
     * Optional so existing in-memory doubles remain valid implementations, and
     * because the correct fallback ("any translation") is the adapter's job, not
     * every caller's. Before this parameter existed the adapter pinned Spanish,
     * so an English-speaking customer's basket said "Creatina Monohidrato" with
     * no way for any client to ask otherwise — a translation rule violated in
     * the API, not fixable in the storefront.
     */
    locale?: string,
  ): Promise<ReadonlyMap<string, VariantSnapshot>>;
}

/**
 * DI token. An interface has no runtime value to inject against, so the token is
 * a symbol rather than a string — a string token typo resolves to `undefined` at
 * runtime, while a symbol import that does not exist fails at compile time.
 */
export const CART_REPOSITORY = Symbol("CART_REPOSITORY");
