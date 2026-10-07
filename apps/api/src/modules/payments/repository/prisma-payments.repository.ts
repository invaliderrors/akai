import { Injectable } from "@nestjs/common";
import { type CurrencyCode, toMinor } from "@akai/contracts";
import { Prisma } from "@akai/db";

import { PrismaService } from "../../prisma/prisma.service";
import type {
  JsonObject,
  OrderCheckoutDetails,
  OrderLineSnapshot,
  OrderSnapshot,
  PaymentSnapshot,
  PaymentsRepository,
  PaymentsWriter,
  RecordPaymentAttemptInput,
  RecordTransactionInput,
  StalledTransaction,
} from "./payments.repository";
import type { OrderStatus } from "@akai/contracts";

/**
 * Prisma-backed implementation of the payments persistence port.
 *
 * This adapter is the ONLY place where a raw Postgres `Int` becomes a branded
 * `Minor`. Doing the conversion here — once, at the edge — is what lets every
 * service above it do arithmetic through @akai/money with the compiler
 * guaranteeing no unbranded number ever reaches a money calculation.
 */

/** Internal sentinel: a duplicate provider event, distinguished from any other P2002. */
class DuplicateProviderEventError extends Error {
  constructor() {
    super("Provider event already processed");
    this.name = "DuplicateProviderEventError";
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

/**
 * The write surface, bound to either a transaction client or the base client.
 * Both satisfy the same delegate API, which is why one class covers both.
 */
class PrismaPaymentsWriter implements PaymentsWriter {
  constructor(protected readonly db: Prisma.TransactionClient) {}

  // --- Reads ---------------------------------------------------------------

  async findOrderById(orderId: string): Promise<OrderSnapshot | null> {
    return this.toOrderSnapshot(
      await this.db.order.findUnique({ where: { id: orderId } }),
    );
  }

  async findOrderByNumber(orderNumber: string): Promise<OrderSnapshot | null> {
    return this.toOrderSnapshot(
      await this.db.order.findUnique({ where: { orderNumber } }),
    );
  }

  /**
   * Correlate a Wompi `reference`, AND LOCK THE ORDER IT BELONGS TO.
   *
   * Two statements rather than one raw select of every column: `SELECT … FOR
   * UPDATE` takes the lock, and the ordinary `findUnique` that follows reads the
   * snapshot through Prisma's own mapping. Under READ COMMITTED each statement
   * takes a fresh snapshot, so the read after the lock sees whatever the
   * transaction we queued behind committed — which is the point. See the port
   * doc for why the lock is the contract.
   *
   * A reference that matches nothing locks nothing and returns null.
   */
  async findOrderByPaymentReference(reference: string): Promise<OrderSnapshot | null> {
    const rows = await this.db.$queryRaw<readonly { readonly id: unknown }[]>`
      SELECT o."id" FROM "order" o
      WHERE o."id" = (
        SELECT p."orderId" FROM "payment" p
        WHERE p."providerReference" = ${reference}
        LIMIT 1
      )
      FOR UPDATE OF o
    `;

    // `$queryRaw`'s generic is an assertion, not a check — narrowed, not trusted.
    const id = rows[0]?.id;
    return typeof id === "string" ? this.findOrderById(id) : null;
  }

  async lockOrder(orderId: string): Promise<OrderSnapshot | null> {
    const rows = await this.db.$queryRaw<readonly { readonly id: unknown }[]>`
      SELECT "id" FROM "order" WHERE "id" = ${orderId}::uuid FOR UPDATE
    `;
    const id = rows[0]?.id;
    return typeof id === "string" ? this.findOrderById(id) : null;
  }

  async countPaymentAttempts(orderId: string): Promise<number> {
    return this.db.payment.count({
      where: { orderId, providerReference: { not: null } },
    });
  }

  async findOrderCheckoutDetails(orderId: string): Promise<OrderCheckoutDetails | null> {
    const row = await this.db.order.findUnique({
      where: { id: orderId },
      select: {
        billFirstName: true,
        billLastName: true,
        billPhone: true,
        documentType: true,
        documentNumber: true,
        shipFirstName: true,
        shipLastName: true,
        shipLine1: true,
        shipLine2: true,
        shipCity: true,
        shipRegion: true,
        shipPostalCode: true,
        shipCountryCode: true,
        shipPhone: true,
      },
    });

    if (row === null) {
      return null;
    }

    return {
      billingName: `${row.billFirstName} ${row.billLastName}`.trim(),
      billingPhone: row.billPhone,
      documentType: row.documentType,
      documentNumber: row.documentNumber,
      shipping: {
        name: `${row.shipFirstName} ${row.shipLastName}`.trim(),
        line1: row.shipLine1,
        line2: row.shipLine2,
        city: row.shipCity,
        region: row.shipRegion,
        postalCode: row.shipPostalCode,
        countryCode: row.shipCountryCode,
        phone: row.shipPhone,
      },
    };
  }

  /**
   * Order lines, exactly as stored.
   *
   * ONE QUERY. Wompi is given the amount directly on the checkout URL, so there
   * is no catalogue mirror to join to and checkout reads nothing here beyond the
   * money it already holds.
   */
  async findOrderLines(orderId: string): Promise<readonly OrderLineSnapshot[]> {
    const rows = await this.db.orderItem.findMany({
      where: { orderId },
      orderBy: { id: "asc" },
    });

    return rows.map((row): OrderLineSnapshot => ({
      id: row.id,
      productName: row.productName,
      variantName: row.variantName,
      sku: row.sku,
      imageUrl: row.imageUrl,
      quantity: row.quantity,
      unitPriceGross: toMinor(row.unitPriceGross),
      lineTotalGross: toMinor(row.lineTotalGross),
      taxAmount: toMinor(row.taxAmount),
    }));
  }

  // --- Writes --------------------------------------------------------------

  async recordPaymentAttempt(
    input: RecordPaymentAttemptInput,
  ): Promise<PaymentSnapshot> {
    const created = await this.db.payment.create({
      data: {
        orderId: input.orderId,
        provider: "WOMPI",
        status: input.status,
        amount: input.amount,
        currency: input.currency,
        providerReference: input.providerReference,
        providerPaymentId: null,
      },
    });

    return this.toPaymentSnapshot(created);
  }

  /**
   * Write one transaction's state. See `RecordTransactionInput` for the three
   * cases. Runs under the order row lock the settlement already holds, so the
   * claim in case 2 cannot race another claim for the same attempt.
   *
   * SCOPED TO THE ORDER in case 1: a transaction id already attached to a
   * DIFFERENT order's row is left alone rather than re-attributed — the
   * reference resolved this event to `orderId`, and a disagreement between the
   * two is for an operator, never for a silent rewrite of another order's
   * ledger.
   */
  async recordTransaction(input: RecordTransactionInput): Promise<void> {
    const state = {
      status: input.status,
      failureCode: input.failureCode,
      failureMessage: input.failureMessage,
      capturedAt: input.capturedAt,
    };

    const existing = await this.db.payment.findUnique({
      where: { providerPaymentId: input.providerPaymentId },
      select: { id: true, orderId: true },
    });

    if (existing !== null) {
      if (existing.orderId === input.orderId) {
        await this.db.payment.update({ where: { id: existing.id }, data: state });
      }
      return;
    }

    const attempt = await this.db.payment.findFirst({
      where: {
        orderId: input.orderId,
        providerReference: input.providerReference,
        providerPaymentId: null,
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });

    if (attempt !== null) {
      await this.db.payment.update({
        where: { id: attempt.id },
        data: {
          ...state,
          providerPaymentId: input.providerPaymentId,
          ...(input.reported === null
            ? {}
            : { amount: input.reported.amount, currency: input.reported.currency }),
        },
      });
      return;
    }

    if (input.reported === null || input.reported.amount <= 0) {
      return;
    }

    await this.db.payment.create({
      data: {
        ...state,
        orderId: input.orderId,
        provider: "WOMPI",
        amount: input.reported.amount,
        currency: input.reported.currency,
        providerReference: input.providerReference,
        providerPaymentId: input.providerPaymentId,
      },
    });
  }

  async setOrderStatus(orderId: string, status: OrderStatus): Promise<void> {
    await this.db.order.update({
      where: { id: orderId },
      data: { status, version: { increment: 1 } },
    });
  }

  /**
   * PAID, and the gap-free invoice number that legally goes with it.
   *
   * ONE TRANSACTION — `this.db` is the caller's transaction client, so a
   * settlement that rolls back leaves no number and no PAID order, and a
   * committed settlement cannot exist without a number. That second half is the
   * defect this closes: `settleOrderPaid` enqueues `payment-receipt` on every
   * paid order, and its handler DEFERS while `invoiceNumber` is null, so with
   * nothing allocating on the live path every real paid order retried until the
   * row dead-lettered and no customer ever received a receipt.
   *
   * The status write stays on the Prisma delegate so `@updatedAt` is still
   * maintained, and `version` still increments — the optimistic-concurrency
   * counter the out-of-order webhook pair is serialised by.
   */
  async markOrderPaid(orderId: string, paidAt: Date): Promise<void> {
    await this.allocateInvoiceNumberIfMissing(orderId);

    await this.db.order.update({
      where: { id: orderId },
      data: { status: "PAID", paidAt, version: { increment: 1 } },
    });
  }

  /**
   * Give this order an invoice number, unless it already has one.
   *
   * THREE STATEMENTS, AND THE ORDER OF THEM IS THE WHOLE DESIGN. The obvious
   * one-statement version — `UPDATE "order" SET "invoiceNumber" =
   * next_invoice_number() WHERE … AND "invoiceNumber" IS NULL` — is what this
   * replaces, and it was wrong twice over, because `nextval` is deliberately NOT
   * transactional. Measured on postgres:16-alpine:
   *
   *   - a settlement that allocated and then rolled back left the row NULL and
   *     `invoice_number_seq.last_value` advanced 1 -> 2; and
   *   - two overlapping settlements of ONE null row gave the winner
   *     INV-2026-000003, the loser `UPDATE 0`, and last_value 2 -> 4 — because
   *     the target-list `nextval` is evaluated BEFORE the tuple lock, and
   *     EvalPlanQual then discards a number already drawn.
   *
   * Both leave permanent holes in a series that must legally be
   * unbroken. So:
   *
   *   1. LOCK THE ORDER ROW AND READ IT. Under READ COMMITTED, `FOR UPDATE`
   *      waits for any competing settlement and then returns the version that
   *      transaction committed — so a second delivery genuinely sees the first
   *      one's number and takes the early return. Without the lock the loser
   *      would still be safe (step 3 refuses to renumber and the throw rolls its
   *      allocation back) but it would fail an authentic delivery with a 500,
   *      which is exactly the answer that makes Wompi retry. The settlement
   *      path already holds this lock from `findOrderByPaymentReference`;
   *      re-taking it in the same transaction costs nothing and means the local
   *      `PAYMENTS_ENABLED=false` settlement is protected too, without relying
   *      on its caller.
   *
   *   2. ALLOCATE, only now that a number is known to be needed.
   *      `allocate_invoice_number()` increments an ordinary ROW under its own
   *      lock, so it rolls back with this transaction — the entire point. It is
   *      called in a plain SELECT and never in the target list of a conditional
   *      UPDATE, because a bumped counter under a WHERE that matched nothing
   *      would be an allocation the caller has to unwind.
   *
   *   3. WRITE IT, still predicated on `IS NULL`, and INSIST the write landed.
   *      A zero-row result means something renumbered the order between the lock
   *      and here, which should be impossible; throwing is what makes it
   *      impossible-and-safe rather than impossible-and-silent, since the throw
   *      rolls back step 2 and returns the number to the series.
   */
  private async allocateInvoiceNumberIfMissing(orderId: string): Promise<void> {
    const locked = await this.db.$queryRaw<
      readonly { readonly invoiceNumber: unknown }[]
    >`
      SELECT "invoiceNumber" FROM "order" WHERE "id" = ${orderId}::uuid FOR UPDATE
    `;

    const current = locked[0];

    // No such order — leave it to the status write below to fail loudly with
    // Prisma's own P2025 rather than inventing an error here.
    if (current === undefined) {
      return;
    }

    // Already numbered: a duplicate webhook or a settlement retry. It must
    // neither consume a second number nor renumber an order whose receipt has
    // already gone out. `$queryRaw`'s generic is an assertion, not a check, so
    // the one field read is narrowed rather than trusted.
    if (typeof current.invoiceNumber === "string") {
      return;
    }

    const allocated = await this.db.$queryRaw<readonly { readonly value: unknown }[]>`
      SELECT allocate_invoice_number() AS "value"
    `;

    const invoiceNumber = allocated[0]?.value;
    if (typeof invoiceNumber !== "string") {
      throw new Error("Invoice allocation returned no number");
    }

    const written = await this.db.$executeRaw`
      UPDATE "order"
      SET "invoiceNumber" = ${invoiceNumber}
      WHERE "id" = ${orderId}::uuid
        AND "invoiceNumber" IS NULL
    `;

    if (written !== 1) {
      throw new Error(
        `Invoice number ${invoiceNumber} could not be written to order ${orderId}; rolling back so it is not lost from the series`,
      );
    }
  }

  /**
   * The reserved units leave the building.
   *
   * `onHand` AND `reserved` drop together by the reserved quantity — dropping
   * only `onHand` would strand the units reserved forever, a slow leak that
   * shrinks available stock by every unit ever sold. The `onHand >= quantity`
   * guard keeps the non-negative CHECK constraints intact; for a reservation
   * that is still active it always holds, because `reserve` guaranteed
   * `onHand >= reserved >= quantity`. Both counters fall by the same amount, so
   * `reserved <= onHand` is preserved.
   *
   * The SQL deliberately mirrors ProductInventoryService.commitReservation. The
   * duplication is the cost of running it inside the webhook's transaction
   * rather than the service's own; unifying the two belongs with the fulfilment
   * worker (followUps).
   */
  async commitReservationsForOrder(orderId: string): Promise<void> {
    const reservations = await this.db.stockReservation.findMany({
      where: { orderId, releasedAt: null },
      select: { id: true, variantId: true, quantity: true },
    });

    for (const reservation of reservations) {
      const claimed = await this.db.stockReservation.updateMany({
        where: { id: reservation.id, releasedAt: null },
        data: { releasedAt: new Date() },
      });

      // A concurrent release (TTL cron, cancel) already claimed it — skip rather
      // than decrement twice.
      if (claimed.count === 0) {
        continue;
      }

      await this.db.$executeRaw`
        UPDATE "inventory_item"
        SET "onHand"   = "onHand" - ${reservation.quantity},
            "reserved" = GREATEST(0, "reserved" - ${reservation.quantity}),
            "version"  = "version" + 1
        WHERE "variantId" = ${reservation.variantId}::uuid
          AND "onHand" >= ${reservation.quantity}
      `;

      const current = await this.db.inventoryItem.findUnique({
        where: { variantId: reservation.variantId },
        select: { onHand: true },
      });

      await this.db.inventoryLedgerEntry.create({
        data: {
          variantId: reservation.variantId,
          movement: "SALE",
          quantityDelta: -reservation.quantity,
          resultingOnHand: current?.onHand ?? 0,
          orderId,
        },
      });
    }
  }

  async releaseReservationsForOrder(orderId: string): Promise<void> {
    const reservations = await this.db.stockReservation.findMany({
      where: { orderId, releasedAt: null },
      select: { id: true, variantId: true, quantity: true },
    });

    for (const reservation of reservations) {
      const claimed = await this.db.stockReservation.updateMany({
        where: { id: reservation.id, releasedAt: null },
        data: { releasedAt: new Date() },
      });

      if (claimed.count === 0) {
        continue;
      }

      // Floor at zero rather than trusting the stored quantity: an earlier
      // under-count must not drive `reserved` negative and trip the CHECK on an
      // unrelated later write.
      await this.db.$executeRaw`
        UPDATE "inventory_item"
        SET "reserved" = GREATEST(0, "reserved" - ${reservation.quantity}),
            "version"  = "version" + 1
        WHERE "variantId" = ${reservation.variantId}::uuid
      `;

      const current = await this.db.inventoryItem.findUnique({
        where: { variantId: reservation.variantId },
        select: { onHand: true },
      });

      await this.db.inventoryLedgerEntry.create({
        data: {
          variantId: reservation.variantId,
          movement: "RESERVATION_RELEASE",
          quantityDelta: reservation.quantity,
          resultingOnHand: current?.onHand ?? 0,
          orderId,
        },
      });
    }
  }

  async appendOrderEvent(input: {
    readonly orderId: string;
    readonly type: string;
    readonly message: string;
    readonly isInternal: boolean;
  }): Promise<void> {
    await this.db.orderEvent.create({
      data: {
        orderId: input.orderId,
        type: input.type,
        message: input.message,
        isInternal: input.isInternal,
      },
    });
  }

  async enqueue(topic: string, payload: JsonObject): Promise<void> {
    await this.db.outboxMessage.create({
      data: { topic, payload: { ...payload } },
    });
  }

  // --- Mapping -------------------------------------------------------------

  private toOrderSnapshot(
    row: {
      id: string;
      orderNumber: string;
      status: OrderStatus;
      email: string;
      locale: "es" | "en";
      currency: string;
      grandTotal: number;
      discountTotal: number;
      shippingTotal: number;
      taxTotal: number;
      refundedTotal: number;
    } | null,
  ): OrderSnapshot | null {
    if (row === null) {
      return null;
    }

    return {
      id: row.id,
      orderNumber: row.orderNumber,
      status: row.status,
      email: row.email,
      locale: row.locale,
      currency: row.currency,
      grandTotal: toMinor(row.grandTotal),
      discountTotal: toMinor(row.discountTotal),
      shippingTotal: toMinor(row.shippingTotal),
      taxTotal: toMinor(row.taxTotal),
      refundedTotal: toMinor(row.refundedTotal),
    };
  }

  private toPaymentSnapshot(row: {
    id: string;
    orderId: string;
    status: PaymentSnapshot["status"];
    amount: number;
    currency: string;
    providerReference: string | null;
    providerPaymentId: string | null;
  }): PaymentSnapshot {
    const currency: CurrencyCode = row.currency;

    return {
      id: row.id,
      orderId: row.orderId,
      status: row.status,
      amount: toMinor(row.amount),
      currency,
      providerReference: row.providerReference,
      providerPaymentId: row.providerPaymentId,
    };
  }
}

@Injectable()
export class PrismaPaymentsRepository
  extends PrismaPaymentsWriter
  implements PaymentsRepository
{
  constructor(private readonly prisma: PrismaService) {
    super(prisma);
  }

  async runOnceForEvent(
    event: {
      readonly id: string;
      readonly type: string;
    },
    apply: (tx: PaymentsWriter) => Promise<void>,
  ): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        // The dedupe INSERT and the state change share one transaction. Note
        // the try/catch is scoped to THIS statement only: a P2002 raised by
        // `apply` (say, a duplicate refund) is a real error and must not be
        // silently reported as "already processed".
        try {
          // `wompi:<transactionId>:<status>`, so this INSERT is the dedupe: a
          // redelivery (or the return page seeing the same state) violates the
          // primary key, rolling the whole transaction back atomically.
          await tx.providerEvent.create({
            data: { id: event.id, type: event.type },
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new DuplicateProviderEventError();
          }
          throw error;
        }

        await apply(new PrismaPaymentsWriter(tx));
      });

      return true;
    } catch (error) {
      if (error instanceof DuplicateProviderEventError) {
        return false;
      }
      throw error;
    }
  }

  async runInTransaction<T>(apply: (tx: PaymentsWriter) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => apply(new PrismaPaymentsWriter(tx)));
  }

  async findStalledTransactions(
    olderThan: Date,
    limit: number,
  ): Promise<readonly StalledTransaction[]> {
    const rows = await this.prisma.payment.findMany({
      where: {
        status: "PROCESSING",
        providerPaymentId: { not: null },
        updatedAt: { lte: olderThan },
        order: { status: "AWAITING_PAYMENT" },
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
      select: { providerPaymentId: true, order: { select: { orderNumber: true } } },
    });

    return rows.flatMap((row) =>
      row.providerPaymentId === null
        ? []
        : [{ transactionId: row.providerPaymentId, orderNumber: row.order.orderNumber }],
    );
  }
}
