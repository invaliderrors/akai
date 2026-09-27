import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { Prisma } from "@akai/db";
import type { InventoryItem } from "@akai/contracts";
import { PrismaService } from "../prisma/prisma.service";
import { CatalogError } from "./catalog.errors";
import { CATALOG_TOPICS, type InventoryEventPayload } from "./catalog.events";
import type { AdjustInventory, ReserveStock, SetInventoryPolicy } from "./dto/catalog.dto";

/**
 * Stock levels, reservations and the inventory ledger for catalog variants.
 *
 * SCOPE NOTE: `InventoryModule` exists as a placeholder and may end up owning
 * this. It lives here for now because the task requires the catalog to ship
 * working stock tracking and reservation, and reaching into another module's
 * directory would collide with whoever is filling it. The public surface is
 * small and stateless-by-design, so collapsing it into InventoryModule later is
 * a move-and-reexport. See followUps.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: stock is never read, decided upon,
 * and then written. Every quantity change is a single conditional UPDATE whose
 * WHERE clause contains the precondition, so two concurrent checkouts for the
 * last unit cannot both observe "1 available" and both succeed. An affected-row
 * count of zero IS the rejection — it is not an error to be retried.
 */
@Injectable()
export class ProductInventoryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reserve stock for an in-flight checkout.
   *
   * The predicate is `"onHand" - "reserved" >= quantity`, evaluated by Postgres
   * inside the UPDATE. Prisma's `updateMany` cannot express a comparison between
   * two COLUMNS (its filters compare a column to a literal), so this is raw SQL
   * — the alternative would be reading `onHand` and `reserved` into JavaScript,
   * subtracting there, and writing back, which reintroduces exactly the
   * read-then-write race the spec forbids.
   *
   * Note this also cannot be left to the `reserved <= onHand` CHECK constraint:
   * the constraint would abort the transaction with a Postgres error, which is
   * indistinguishable from a genuine fault and would surface as a 500 rather
   * than a clean "out of stock".
   */
  async reserve(input: ReserveStock): Promise<{ reservationId: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + input.ttlSeconds * 1_000);

    return this.prisma.$transaction(async (tx) => {
      const variant = await tx.productVariant.findFirst({
        where: { id: input.variantId, deletedAt: null, isActive: true },
        select: { id: true, sku: true },
      });

      if (variant === null) {
        throw CatalogError.notFound("Variant");
      }

      const inventory = await tx.inventoryItem.findUnique({
        where: { variantId: input.variantId },
        select: { allowBackorder: true },
      });

      if (inventory === null) {
        throw CatalogError.outOfStock(`${variant.sku} is not stocked`);
      }

      // Backorder-enabled variants skip the availability precondition but still
      // record the reservation, so the oversold quantity is visible rather than
      // implicit. The CHECK constraint tolerates this because reserving under
      // backorder raises `onHand` alongside `reserved` is NOT done — instead the
      // reservation row alone carries the intent and inventory is untouched.
      const affected = inventory.allowBackorder
        ? 1
        : await tx.$executeRaw`
            UPDATE "inventory_item"
            SET "reserved" = "reserved" + ${input.quantity},
                "version"  = "version" + 1
            WHERE "variantId" = ${input.variantId}::uuid
              AND "onHand" - "reserved" >= ${input.quantity}
          `;

      if (affected === 0) {
        throw CatalogError.outOfStock(
          `Insufficient stock for ${variant.sku}: ${input.quantity} requested`,
        );
      }

      const reservation = await tx.stockReservation.create({
        data: {
          variantId: input.variantId,
          cartId: input.cartId,
          quantity: input.quantity,
          expiresAt,
        },
        select: { id: true, expiresAt: true },
      });

      // The ledger is append-only and records the RESERVATION movement so the
      // current reserved figure is reconstructable. `resultingOnHand` is
      // unchanged by a reservation — reserving does not consume stock, it
      // withholds it — and recording it that way is what makes a later oversell
      // dispute settleable from the ledger alone.
      await this.appendLedger(tx, {
        variantId: input.variantId,
        movement: "RESERVATION",
        quantityDelta: -input.quantity,
        reason: null,
        actorId: null,
      });

      return { reservationId: reservation.id, expiresAt: reservation.expiresAt };
    });
  }

  /**
   * Release a reservation without selling (abandoned cart, expiry, cancel).
   *
   * Idempotent by construction: the UPDATE requires `releasedAt IS NULL`, so a
   * double release — which WILL happen, because the expiry cron and the user's
   * own cancel action race — affects zero rows and returns false instead of
   * decrementing `reserved` twice and corrupting the count.
   */
  async release(reservationId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.stockReservation.findUnique({
        where: { id: reservationId },
        select: { id: true, variantId: true, quantity: true, releasedAt: true },
      });

      if (reservation === null || reservation.releasedAt !== null) {
        return false;
      }

      const claimed = await tx.stockReservation.updateMany({
        where: { id: reservationId, releasedAt: null },
        data: { releasedAt: new Date() },
      });

      if (claimed.count === 0) {
        return false;
      }

      // Floor at zero rather than trusting the stored quantity: if a prior bug
      // ever under-counted `reserved`, this must not drive it negative and trip
      // the CHECK constraint on an unrelated later write.
      await tx.$executeRaw`
        UPDATE "inventory_item"
        SET "reserved" = GREATEST(0, "reserved" - ${reservation.quantity}),
            "version"  = "version" + 1
        WHERE "variantId" = ${reservation.variantId}::uuid
      `;

      await this.appendLedger(tx, {
        variantId: reservation.variantId,
        movement: "RESERVATION_RELEASE",
        quantityDelta: reservation.quantity,
        reason: null,
        actorId: null,
      });

      return true;
    });
  }

  /**
   * Commit EVERY active reservation held for an order — the sale-completed path.
   *
   * Called when an order transitions to PAID (`OrdersService.markPaid`), which is
   * what finally connects the reservation primitives to a real sale: at checkout
   * `reserve()` holds the stock, and here that hold becomes an `onHand`
   * decrement and a SALE ledger row (issue SEV2 — the primitives existed but no
   * order path called them).
   *
   * IDEMPOTENT AT THE ORDER LEVEL. Each reservation is claimed with a
   * `releasedAt IS NULL` guard, so a second invocation (a retried settlement)
   * finds nothing left to commit and returns 0 rather than double-decrementing.
   * That matters because payment settlement is retried aggressively.
   *
   * @returns how many reservations were committed on THIS call.
   */
  async commitReservationsForOrder(orderId: string): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const reservations = await tx.stockReservation.findMany({
        where: { orderId, releasedAt: null },
        select: { id: true, variantId: true, quantity: true },
      });

      let committed = 0;
      for (const reservation of reservations) {
        // Claim under the same `releasedAt IS NULL` guard the single-reservation
        // path uses, so a concurrent expiry-release cannot be double-counted.
        const claimed = await tx.stockReservation.updateMany({
          where: { id: reservation.id, releasedAt: null },
          data: { releasedAt: new Date() },
        });
        if (claimed.count === 0) {
          continue;
        }

        const affected = await tx.$executeRaw`
          UPDATE "inventory_item"
          SET "onHand"   = "onHand" - ${reservation.quantity},
              "reserved" = GREATEST(0, "reserved" - ${reservation.quantity}),
              "version"  = "version" + 1
          WHERE "variantId" = ${reservation.variantId}::uuid
            AND "onHand" >= ${reservation.quantity}
        `;

        if (affected === 0) {
          throw CatalogError.outOfStock("Reserved stock is no longer on hand");
        }

        await tx.inventoryLedgerEntry.create({
          data: {
            variantId: reservation.variantId,
            movement: "SALE",
            quantityDelta: -reservation.quantity,
            resultingOnHand: await this.currentOnHand(tx, reservation.variantId),
            orderId,
          },
        });

        committed += 1;
      }

      return committed;
    });
  }

  /**
   * Convert a reservation into a sale: stock leaves the building.
   *
   * Decrements `onHand` AND `reserved` together. Decrementing only `onHand`
   * would leave the units reserved forever, permanently shrinking available
   * stock by every unit ever sold — a slow leak that looks like a demand
   * forecasting problem for months before anyone finds it.
   */
  async commitReservation(reservationId: string, orderId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const reservation = await tx.stockReservation.findUnique({
        where: { id: reservationId },
        select: { id: true, variantId: true, quantity: true, releasedAt: true },
      });

      if (reservation === null || reservation.releasedAt !== null) {
        throw CatalogError.conflict("Reservation is no longer active");
      }

      const claimed = await tx.stockReservation.updateMany({
        where: { id: reservationId, releasedAt: null },
        data: { releasedAt: new Date(), orderId },
      });

      if (claimed.count === 0) {
        throw CatalogError.conflict("Reservation is no longer active");
      }

      const affected = await tx.$executeRaw`
        UPDATE "inventory_item"
        SET "onHand"   = "onHand" - ${reservation.quantity},
            "reserved" = GREATEST(0, "reserved" - ${reservation.quantity}),
            "version"  = "version" + 1
        WHERE "variantId" = ${reservation.variantId}::uuid
          AND "onHand" >= ${reservation.quantity}
      `;

      if (affected === 0) {
        throw CatalogError.outOfStock("Reserved stock is no longer on hand");
      }

      const current = await this.currentOnHand(tx, reservation.variantId);

      await tx.inventoryLedgerEntry.create({
        data: {
          variantId: reservation.variantId,
          movement: "SALE",
          quantityDelta: -reservation.quantity,
          resultingOnHand: current,
          orderId,
        },
      });
    });
  }

  /**
   * Manual stock adjustment by an admin (restock, shrinkage, correction).
   *
   * A negative adjustment is guarded by `"onHand" + delta >= "reserved"`, not
   * merely `>= 0`. Writing stock down below what is already reserved would leave
   * in-flight checkouts holding units that no longer exist, turning a
   * bookkeeping correction into a batch of unfulfillable paid orders.
   *
   * `expectedOnHand`, when sent, joins the SAME conditional UPDATE as
   * `"onHand" = expected`. The operator's delta was computed from the count on
   * their screen; if an order moved it since, applying the delta anyway lands
   * on a number nobody typed. Folding it into the WHERE keeps the one rule of
   * this file — no read-decide-write.
   *
   * AN UNTRACKED VARIANT (no `inventory_item` row) IS STOCKED BY ITS FIRST
   * ADJUSTMENT. The UPDATE matches nothing, so the row is created here, in the
   * same transaction, with `onHand = delta`. The insert is ON CONFLICT DO
   * NOTHING (`skipDuplicates`): a concurrent creator shows up as a zero count
   * and is refused as STOCK_CHANGED — our delta was computed against a zero
   * that is no longer true — rather than as a unique violation that would abort
   * the transaction as a 500.
   *
   * When the guarded UPDATE affects nothing, the row is read ONLY to choose
   * which refusal to report. Nothing is written after that read, so it cannot
   * reintroduce the race; at worst a concurrent change picks the less precise
   * of two refusals.
   */
  async adjust(
    variantId: string,
    input: AdjustInventory,
    actorId: string,
  ): Promise<InventoryItem> {
    const { delta, expectedOnHand } = input;

    return this.prisma.$transaction(async (tx) => {
      const variant = await tx.productVariant.findFirst({
        where: { id: variantId, deletedAt: null },
        select: { id: true },
      });

      if (variant === null) {
        throw CatalogError.notFound("Variant");
      }

      const affected =
        expectedOnHand === undefined
          ? await tx.$executeRaw`
              UPDATE "inventory_item"
              SET "onHand"  = "onHand" + ${delta},
                  "version" = "version" + 1
              WHERE "variantId" = ${variantId}::uuid
                AND "onHand" + ${delta} >= "reserved"
            `
          : await tx.$executeRaw`
              UPDATE "inventory_item"
              SET "onHand"  = "onHand" + ${delta},
                  "version" = "version" + 1
              WHERE "variantId" = ${variantId}::uuid
                AND "onHand" + ${delta} >= "reserved"
                AND "onHand" = ${expectedOnHand}
            `;

      if (affected === 0) {
        const existing = await tx.inventoryItem.findUnique({
          where: { variantId },
          select: { onHand: true },
        });

        if (existing !== null) {
          throw CatalogError.adjustRefused(
            expectedOnHand !== undefined && existing.onHand !== expectedOnHand
              ? "STOCK_CHANGED"
              : "BELOW_RESERVED",
          );
        }

        // Untracked. What the operator saw for it is zero on hand.
        if (expectedOnHand !== undefined && expectedOnHand !== 0) {
          throw CatalogError.adjustRefused("STOCK_CHANGED");
        }
        if (delta < 0) {
          throw CatalogError.adjustRefused("NEGATIVE_STOCK");
        }

        const created = await tx.inventoryItem.createMany({
          data: [{ variantId, onHand: delta }],
          skipDuplicates: true,
        });

        if (created.count === 0) {
          throw CatalogError.adjustRefused("STOCK_CHANGED");
        }
      }

      const item = await this.readInventory(tx, variantId);

      await tx.inventoryLedgerEntry.create({
        data: {
          variantId,
          movement: delta > 0 ? "RESTOCK" : "ADJUSTMENT",
          quantityDelta: delta,
          resultingOnHand: item.onHand,
          actorId,
          reason: input.reason,
        },
      });

      await this.emitInventoryEvent(tx, {
        variantId,
        onHand: item.onHand,
        available: item.available,
        lowStock: item.available <= item.lowStockThreshold,
        actorId,
      });

      return item;
    });
  }

  async setPolicy(variantId: string, input: SetInventoryPolicy): Promise<InventoryItem> {
    const updated = await this.prisma.inventoryItem.updateMany({
      where: { variantId },
      data: {
        ...(input.lowStockThreshold === undefined
          ? {}
          : { lowStockThreshold: input.lowStockThreshold }),
        ...(input.allowBackorder === undefined
          ? {}
          : { allowBackorder: input.allowBackorder }),
      },
    });

    if (updated.count === 0) {
      throw CatalogError.notFound("Inventory");
    }

    return this.readInventory(this.prisma, variantId);
  }

  async get(variantId: string): Promise<InventoryItem> {
    return this.readInventory(this.prisma, variantId);
  }

  /**
   * Release every reservation whose TTL has passed — EXCEPT those held for an
   * order that has already been paid.
   *
   * Called by the worker's `reservation-expiry` cron. Without it an abandoned
   * checkout holds stock permanently and the store gradually sells out of items
   * it physically has on the shelf.
   *
   * THE PAID-ORDER GUARD is what makes the reserve→commit lifecycle safe even
   * before every payment path commits its reservations. A reservation attached to
   * a PAID (or fulfilling/shipped/refunded) order represents stock that has SOLD;
   * releasing it on TTL would hand that stock back to the shelf, decrementing
   * `reserved` without ever decrementing `onHand`, and the sold unit would be
   * offered again. Such reservations are the commit path's job (SALE + onHand
   * decrement), never the expiry cron's. Only reservations with no order, or with
   * an order still awaiting/failed/cancelled, are genuinely abandoned and freed.
   */
  async releaseExpired(now: Date = new Date()): Promise<number> {
    const expired = await this.prisma.stockReservation.findMany({
      where: { releasedAt: null, expiresAt: { lte: now } },
      select: { id: true, orderId: true },
      take: 500,
    });

    const soldOrderIds = await this.paidOrderIds(
      expired.flatMap((reservation) =>
        reservation.orderId === null ? [] : [reservation.orderId],
      ),
    );

    let released = 0;
    for (const reservation of expired) {
      // Stock behind a sold order is committed by the payment path, never freed
      // here — see the guard rationale above.
      if (reservation.orderId !== null && soldOrderIds.has(reservation.orderId)) {
        continue;
      }
      if (await this.release(reservation.id)) {
        released += 1;
      }
    }

    return released;
  }

  /** The subset of the given order ids whose order has reached a paid state. */
  private async paidOrderIds(orderIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (orderIds.length === 0) {
      return new Set<string>();
    }
    const orders = await this.prisma.order.findMany({
      where: {
        id: { in: [...new Set(orderIds)] },
        status: {
          in: [
            "PAID",
            "FULFILLING",
            "SHIPPED",
            "DELIVERED",
            "REFUNDED",
            "PARTIALLY_REFUNDED",
          ],
        },
      },
      select: { id: true },
    });
    return new Set(orders.map((order) => order.id));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async readInventory(
    client: Prisma.TransactionClient | PrismaService,
    variantId: string,
  ): Promise<InventoryItem> {
    const row = await client.inventoryItem.findUnique({ where: { variantId } });

    if (row === null) {
      throw CatalogError.notFound("Inventory");
    }

    return {
      variantId,
      onHand: row.onHand,
      reserved: row.reserved,
      available: Math.max(0, row.onHand - row.reserved),
      lowStockThreshold: row.lowStockThreshold,
      allowBackorder: row.allowBackorder,
    };
  }

  private async currentOnHand(
    tx: Prisma.TransactionClient,
    variantId: string,
  ): Promise<number> {
    const row = await tx.inventoryItem.findUnique({
      where: { variantId },
      select: { onHand: true },
    });

    return row === null ? 0 : row.onHand;
  }

  private async appendLedger(
    tx: Prisma.TransactionClient,
    entry: {
      variantId: string;
      movement: "RESERVATION" | "RESERVATION_RELEASE";
      quantityDelta: number;
      reason: string | null;
      actorId: string | null;
    },
  ): Promise<void> {
    await tx.inventoryLedgerEntry.create({
      data: {
        variantId: entry.variantId,
        movement: entry.movement,
        quantityDelta: entry.quantityDelta,
        resultingOnHand: await this.currentOnHand(tx, entry.variantId),
        reason: entry.reason,
        actorId: entry.actorId,
      },
    });
  }

  /**
   * Inventory changes go to the outbox in the same transaction, never to a
   * direct call. A low-stock alert or a gateway inventory push that fires from a
   * request handler is lost whenever the downstream is degraded.
   */
  private async emitInventoryEvent(
    tx: Prisma.TransactionClient,
    payload: InventoryEventPayload,
  ): Promise<void> {
    await tx.outboxMessage.create({
      data: {
        topic: CATALOG_TOPICS.inventoryAdjusted,
        // Prisma's Json input type does not accept an arbitrary interface, so
        // the payload is round-tripped through its own schema-derived shape.
        // z.parse both validates and produces a plain object literal.
        payload: inventoryPayloadJson(payload),
      },
    });
  }
}

/**
 * Convert a typed payload into Prisma's `InputJsonValue`.
 *
 * Prisma types Json inputs as a recursive union that a plain interface does not
 * structurally satisfy, and the ecosystem's habitual fix is `as any`. This
 * instead re-parses through a zod object schema, which yields a value whose type
 * IS a plain JSON-compatible record — validated, not asserted.
 */
const inventoryPayloadJsonSchema = z.object({
  variantId: z.string(),
  onHand: z.number().int(),
  available: z.number().int(),
  lowStock: z.boolean(),
  actorId: z.string().nullable(),
});

function inventoryPayloadJson(payload: InventoryEventPayload): Prisma.InputJsonObject {
  return inventoryPayloadJsonSchema.parse(payload);
}
