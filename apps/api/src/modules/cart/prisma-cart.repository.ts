import { Injectable } from "@nestjs/common";
import { ProductStatus } from "@akai/db";
import { toMinor } from "@akai/money";
import { z } from "zod";

import { PrismaService } from "../prisma/prisma.service";
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

/**
 * Prisma implementation of CartRepository.
 *
 * Deliberately thin: it translates rows to the module's own records and does
 * nothing else. All money and ownership logic lives in CartService, where it is
 * unit-testable without a database. This class is covered by the integration
 * suite in apps/api-e2e against a real Postgres (see followUps).
 *
 * The one piece of real judgement here is `loadVariants`, which decides
 * purchasability and available stock in ONE place so the service can never
 * assemble those facts differently at two call sites.
 */

@Injectable()
export class PrismaCartRepository implements CartRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByTokenHash(tokenHash: string): Promise<CartRecord | null> {
    const cart = await this.prisma.cart.findUnique({
      where: { tokenHash },
      include: { items: { orderBy: { createdAt: "asc" } } },
    });
    return cart === null ? null : toCartRecord(cart);
  }

  async findByCustomerId(customerId: string): Promise<CartRecord | null> {
    // `findFirst`, not `findUnique`: `cart.customerId` is indexed but not
    // unique in the schema, so a customer could in principle hold more than one
    // row. The most recently touched one is the live cart.
    const cart = await this.prisma.cart.findFirst({
      where: { customerId },
      orderBy: { updatedAt: "desc" },
      include: { items: { orderBy: { createdAt: "asc" } } },
    });
    return cart === null ? null : toCartRecord(cart);
  }

  async findById(cartId: string): Promise<CartRecord | null> {
    const cart = await this.prisma.cart.findUnique({
      where: { id: cartId },
      include: { items: { orderBy: { createdAt: "asc" } } },
    });
    return cart === null ? null : toCartRecord(cart);
  }

  async create(input: CreateCartInput): Promise<CartRecord> {
    const cart = await this.prisma.cart.create({
      data: {
        tokenHash: input.tokenHash,
        customerId: input.customerId,
        currency: input.currency,
        expiresAt: input.expiresAt,
      },
      include: { items: true },
    });
    return toCartRecord(cart);
  }

  /**
   * Upsert a STANDALONE line on the partial-unique `(cartId, variantId) WHERE
   * "packInstanceId" IS NULL`.
   *
   * RAW SQL, NOT `prisma.cartItem.upsert`. Prisma only generates a typed
   * compound `where` for an `@@unique`/`@@id`, and this constraint is a
   * PARTIAL index instead (see `CartItem`'s own schema comment for why) — it
   * has no such generated name to upsert against. Postgres's own
   * `ON CONFLICT (...) WHERE ...` targets a specific partial index directly,
   * so this stays exactly as atomic as the `upsert()` call it replaces: two
   * concurrent adds of the same variant still cannot produce duplicate lines.
   */
  async setItemQuantity(input: SetItemQuantityInput): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "cart_item"
        ("id", "cartId", "variantId", "quantity", "unitPriceGross", "currency", "updatedAt")
      VALUES
        (gen_random_uuid(), ${input.cartId}::uuid, ${input.variantId}::uuid, ${input.quantity}, ${input.unitPriceGross}, ${input.currency}, now())
      ON CONFLICT ("cartId", "variantId") WHERE "packInstanceId" IS NULL
      DO UPDATE SET
        "quantity" = EXCLUDED."quantity",
        "unitPriceGross" = EXCLUDED."unitPriceGross",
        "currency" = EXCLUDED."currency",
        "updatedAt" = now()
    `;
  }

  /**
   * Atomically REPLACE every component line of one pack instance — delete
   * whatever is stored for `(cartId, packInstanceId)`, then insert `lines`
   * fresh, in one transaction. See `CartRepository.replacePackInstanceLines`'s
   * doc comment for why this is a replace rather than an upsert: a component
   * with quantity > 1 can legitimately need a different NUMBER of stored rows
   * between calls, so there is no stable per-row identity to upsert against.
   */
  async replacePackInstanceLines(
    cartId: string,
    packProductId: string,
    packInstanceId: string,
    lines: readonly PackLineInput[],
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.cartItem.deleteMany({ where: { cartId, packInstanceId } }),
      this.prisma.cartItem.createMany({
        data: lines.map((line) => ({
          cartId,
          variantId: line.variantId,
          quantity: line.quantity,
          unitPriceGross: line.unitPriceGross,
          currency: line.currency,
          packProductId,
          packInstanceId,
        })),
      }),
    ]);
  }

  /**
   * See `CartRepository.replaceStalePackInstanceLines`. An interactive
   * transaction, because the insert must not happen when the delete did not
   * remove exactly the rows the caller read.
   *
   * Why the count check is enough under READ COMMITTED: a concurrent repair of
   * the same instance holds row locks on the rows it deleted. This DELETE
   * blocks on them, and once that transaction commits it finds them gone and
   * removes fewer than expected (the other transaction's new rows are
   * invisible to this statement's snapshot, and their ids are not in the list
   * anyway). The throw rolls this transaction back, so nothing is inserted
   * twice — which `cart_item_pack_key` would otherwise reject as a 500.
   */
  async replaceStalePackInstanceLines(
    cartId: string,
    packProductId: string,
    packInstanceId: string,
    expectedItemIds: readonly string[],
    lines: readonly PackLineInput[],
  ): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const remaining = await tx.cartItem.count({
          where: { cartId, packInstanceId, id: { notIn: [...expectedItemIds] } },
        });
        const deleted = await tx.cartItem.deleteMany({
          where: { cartId, packInstanceId, id: { in: [...expectedItemIds] } },
        });
        if (remaining > 0 || deleted.count !== expectedItemIds.length) {
          throw new StalePackRepairConflict();
        }
        await tx.cartItem.createMany({
          data: lines.map((line) => ({
            cartId,
            variantId: line.variantId,
            quantity: line.quantity,
            unitPriceGross: line.unitPriceGross,
            currency: line.currency,
            packProductId,
            packInstanceId,
          })),
        });
      });
      return true;
    } catch (error: unknown) {
      if (error instanceof StalePackRepairConflict) {
        return false;
      }
      throw error;
    }
  }

  /**
   * See `CartRepository.mergeCarts`. The standalone upsert is the SAME
   * partial-index `ON CONFLICT` statement `setItemQuantity` runs, and each pack
   * instance is the same delete + insert `replacePackInstanceLines` runs — both
   * against the transaction client, so the guest cart is deleted only if every
   * write before it landed.
   *
   * `cart_item_pack_key` is (cartId, variantId, packInstanceId, unitPriceGross):
   * a replaced instance is deleted before it is re-inserted, and a new one has
   * a fresh UUID, so no insert here can collide with a row this statement did
   * not first remove.
   */
  async mergeCarts(input: MergeCartsInput): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const line of input.standaloneLines) {
        await tx.$executeRaw`
          INSERT INTO "cart_item"
            ("id", "cartId", "variantId", "quantity", "unitPriceGross", "currency", "updatedAt")
          VALUES
            (gen_random_uuid(), ${input.targetCartId}::uuid, ${line.variantId}::uuid, ${line.quantity}, ${line.unitPriceGross}, ${line.currency}, now())
          ON CONFLICT ("cartId", "variantId") WHERE "packInstanceId" IS NULL
          DO UPDATE SET
            "quantity" = EXCLUDED."quantity",
            "unitPriceGross" = EXCLUDED."unitPriceGross",
            "currency" = EXCLUDED."currency",
            "updatedAt" = now()
        `;
      }
      for (const instance of input.packInstances) {
        await tx.cartItem.deleteMany({
          where: { cartId: input.targetCartId, packInstanceId: instance.packInstanceId },
        });
        await tx.cartItem.createMany({
          data: instance.lines.map((line) => ({
            cartId: input.targetCartId,
            variantId: line.variantId,
            quantity: line.quantity,
            unitPriceGross: line.unitPriceGross,
            currency: line.currency,
            packProductId: instance.packProductId,
            packInstanceId: instance.packInstanceId,
          })),
        });
      }
      await tx.cart.delete({ where: { id: input.guestCartId } });
    });
  }

  async removePackInstance(cartId: string, packInstanceId: string): Promise<void> {
    await this.prisma.cartItem.deleteMany({
      where: { cartId, packInstanceId },
    });
  }

  async loadPackPrices(
    packProductIds: readonly string[],
  ): Promise<ReadonlyMap<string, PackPriceSnapshot>> {
    if (packProductIds.length === 0) {
      return new Map<string, PackPriceSnapshot>();
    }

    // A pack has exactly one variant by construction (the admin form enforces
    // it), so `variants[0]` is that variant — not an arbitrary pick among
    // several.
    const packs = await this.prisma.product.findMany({
      where: {
        id: { in: [...new Set(packProductIds)] },
        kind: "PACK",
      },
      include: {
        variants: { where: { deletedAt: null }, take: 1 },
      },
    });

    const snapshots = new Map<string, PackPriceSnapshot>();
    for (const pack of packs) {
      const variant = pack.variants[0];
      if (variant === undefined) {
        continue;
      }
      snapshots.set(pack.id, {
        packProductId: pack.id,
        priceGross: toMinor(variant.priceGross),
        currency: variant.currency,
        isPurchasable:
          variant.isActive &&
          pack.deletedAt === null &&
          pack.status === ProductStatus.ACTIVE,
      });
    }
    return snapshots;
  }

  /**
   * Scoped by cartId as well as item id.
   *
   * CartService has already proven the caller owns this cart, so this is
   * belt-and-braces — but it is the cheap kind: a `deleteMany` with both keys
   * cannot delete another cart's line even if a future caller reaches this
   * method without the service's checks.
   */
  async removeItem(cartId: string, itemId: string): Promise<void> {
    await this.prisma.cartItem.deleteMany({ where: { id: itemId, cartId } });
  }

  async removeAllItems(cartId: string): Promise<void> {
    await this.prisma.cartItem.deleteMany({ where: { cartId } });
  }

  async touch(cartId: string, expiresAt: Date): Promise<void> {
    await this.prisma.cart.update({ where: { id: cartId }, data: { expiresAt } });
  }

  async setDiscountCode(cartId: string, code: string | null): Promise<void> {
    await this.prisma.cart.update({ where: { id: cartId }, data: { discountCode: code } });
  }

  async assignCustomer(cartId: string, customerId: string): Promise<void> {
    await this.prisma.cart.update({ where: { id: cartId }, data: { customerId } });
  }

  async deleteCart(cartId: string): Promise<void> {
    await this.prisma.cart.delete({ where: { id: cartId } });
  }

  async deleteExpired(now: Date): Promise<number> {
    // Items cascade on cart delete (schema: onDelete: Cascade), so this is one
    // statement rather than a two-phase cleanup that can half-fail.
    const result = await this.prisma.cart.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    return result.count;
  }

  async loadVariants(
    variantIds: readonly string[],
  ): Promise<ReadonlyMap<string, VariantSnapshot>> {
    if (variantIds.length === 0) {
      // `IN ()` is a needless round trip, and an empty cart is the common case
      // on a first page view.
      return new Map<string, VariantSnapshot>();
    }

    const variants = await this.prisma.productVariant.findMany({
      where: { id: { in: [...new Set(variantIds)] } },
      include: {
        inventory: true,
        priceTiers: { orderBy: { minQuantity: "asc" } },
        product: {
          include: {
            media: { orderBy: { sortOrder: "asc" }, take: 1 },
          },
        },
      },
    });

    const snapshots = new Map<string, VariantSnapshot>();

    for (const variant of variants) {
      const { product, inventory } = variant;

      snapshots.set(variant.id, {
        variantId: variant.id,
        productId: product.id,
        productSlug: product.slug,
        name: product.name,
        variantName: variant.name,
        sku: variant.sku,
        imageUrl: toDisplayableUrl(product.media[0]?.url),
        currency: variant.currency,
        priceGross: variant.priceGross,
        priceTiers: variant.priceTiers.map((tier) => ({
          minQuantity: tier.minQuantity,
          // Branded here, once, rather than at each pricing call site.
          unitPriceGross: toMinor(tier.unitPriceGross),
        })),
        taxRateBps: variant.taxRateBps,
        weightGrams: variant.weightGrams,
        isPurchasable:
          variant.isActive &&
          variant.deletedAt === null &&
          product.deletedAt === null &&
          product.status === ProductStatus.ACTIVE,
        // FAIL CLOSED. No inventory row means an unfinished product setup, and
        // treating unknown stock as unlimited is how a new SKU oversells on its
        // first day.
        availableQuantity:
          inventory === null
            ? 0
            : Math.max(0, inventory.onHand - inventory.reserved),
        allowBackorder: inventory?.allowBackorder ?? false,
        restrictedCountries: product.restrictedCountries,
        isPackVariant: product.kind === "PACK",
      });
    }

    return snapshots;
  }

  async loadPackComponents(packProductId: string): Promise<readonly PackComponentSpec[] | null> {
    const pack = await this.prisma.product.findFirst({
      where: { id: packProductId, kind: "PACK", deletedAt: null },
      select: {
        packComponents: {
          orderBy: { sortOrder: "asc" },
          select: { componentVariantId: true, quantity: true },
        },
      },
    });
    if (pack === null) {
      return null;
    }
    return pack.packComponents.map((component) => ({
      variantId: component.componentVariantId,
      quantity: component.quantity,
    }));
  }
}

/**
 * Thrown inside the stale-pack repair transaction ONLY to roll it back when
 * another request already rewrote the same instance. Never escapes the
 * repository.
 */
class StalePackRepairConflict extends Error {
  constructor() {
    super("pack instance was rewritten concurrently");
    this.name = "StalePackRepairConflict";
  }
}

interface CartRowLike {
  readonly id: string;
  readonly customerId: string | null;
  readonly currency: string;
  readonly discountCode: string | null;
  readonly expiresAt: Date;
  readonly updatedAt: Date;
  readonly items: readonly {
    readonly id: string;
    readonly variantId: string;
    readonly quantity: number;
    readonly unitPriceGross: number;
    readonly currency: string;
    readonly packProductId: string | null;
    readonly packInstanceId: string | null;
  }[];
}

/**
 * Row to record.
 *
 * Structural (not `Prisma.CartGetPayload`) so the mapping is checked against the
 * shape the module actually needs. If a column is renamed or its type changes,
 * this fails to compile here rather than silently flowing a wrong value into the
 * money path.
 */
function toCartRecord(row: CartRowLike): CartRecord {
  return {
    id: row.id,
    customerId: row.customerId,
    currency: row.currency,
    discountCode: row.discountCode,
    expiresAt: row.expiresAt,
    updatedAt: row.updatedAt,
    items: row.items.map((item) => ({
      id: item.id,
      variantId: item.variantId,
      quantity: item.quantity,
      unitPriceGross: item.unitPriceGross,
      currency: item.currency,
      packProductId: item.packProductId,
      packInstanceId: item.packInstanceId,
    })),
  };
}

/**
 * Only emit a URL that is actually a URL.
 *
 * `cartItemSchema.imageUrl` is `z.string().url().nullable()`, so a malformed
 * stored value would fail validation for the whole cart at the contract
 * boundary. Degrading to `null` loses a thumbnail; passing it through loses the
 * customer's basket.
 */
function toDisplayableUrl(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  return z.string().url().safeParse(value).success ? value : null;
}
