import { Injectable } from "@nestjs/common";
import { type CurrencyCode, type Minor, toMinor } from "@akai/contracts";
import { Prisma } from "@akai/db";

import { PrismaService } from "../../prisma/prisma.service";
import type {
  JsonObject,
  OrderLineSnapshot,
  OrderSnapshot,
  PaymentSnapshot,
  PaymentsRepository,
  PaymentsWriter,
  RecordDisputeInput,
  RecordPaymentAttemptInput,
  ProviderOrderReference,
  RecordRefundInput,
  UpdatePaymentInput,
  UpsertSettlementPaymentInput,
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
 * Canonical UUID shape, checked before a correlation value is cast to `uuid`.
 *
 * `order.id` is `@db.Uuid`, so comparing it against arbitrary text makes Postgres
 * raise `invalid input syntax for type uuid` — and inside the webhook transaction
 * that aborts everything, turning "we could not correlate this event" into a 500.
 * The value comes from a signed but externally-authored body, so it is validated
 * for shape before it reaches SQL.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
   * Correlate, AND LOCK THE ROW WE CORRELATED TO.
   *
   * Two statements rather than one raw select of every column: `SELECT "id" …
   * FOR UPDATE` takes the lock, and the ordinary `findUnique` that follows reads
   * the snapshot through Prisma's own mapping. Under READ COMMITTED each
   * statement takes a fresh snapshot, so the read after the lock sees whatever
   * the transaction we just queued behind committed — which is the entire point.
   * Doing it as one raw query would mean hand-mapping twelve columns here and a
   * second place for the snapshot shape to drift.
   *
   * WHY A LOCK AT ALL: see the port doc on `findOrderByProviderReference`. In
   * short, every webhook handler is a read-then-write on `order.status`, and
   * `payment/succeeded` + `order/paid` arrive concurrently with different event
   * ids, so `provider_event` alone does not serialise them.
   *
   * A reference that matches nothing locks nothing and returns null, which is
   * correct: there is no row to protect.
   */
  async findOrderByProviderReference(
    reference: ProviderOrderReference,
  ): Promise<OrderSnapshot | null> {
    const lockedId = await this.lockOrderIdByReference(reference);

    return lockedId === null ? null : this.findOrderById(lockedId);
  }

  private async lockOrderIdByReference(
    reference: ProviderOrderReference,
  ): Promise<string | null> {
    const rows = await this.selectOrderIdForUpdate(reference);
    const first = rows[0];

    // `$queryRaw`'s generic is an assertion, not a check — so the one field we
    // read is narrowed rather than trusted.
    return typeof first?.id === "string" ? first.id : null;
  }

  private selectOrderIdForUpdate(
    reference: ProviderOrderReference,
  ): Promise<readonly { readonly id: unknown }[]> {
    switch (reference.kind) {
      // Rank 1. `metadata.order_id` is our own order UUID round-tripped, so
      // this is a primary-key lookup and needs no dedicated column. The shape
      // guard is load-bearing: `order.id` is `@db.Uuid`, and a signed-but-hostile
      // body carrying a non-UUID value would otherwise make Postgres raise on the
      // cast and abort the whole webhook transaction — a 500 on a delivery we
      // should simply have failed to correlate.
      case "orderId":
        return UUID_PATTERN.test(reference.id)
          ? this.db.$queryRaw<readonly { readonly id: unknown }[]>`
              SELECT "id" FROM "order" WHERE "id" = ${reference.id}::uuid FOR UPDATE
            `
          : Promise.resolve([]);

      case "checkoutId":
        return this.db.$queryRaw<readonly { readonly id: unknown }[]>`
          SELECT "id" FROM "order"
          WHERE "providerCheckoutId" = ${reference.id}
          FOR UPDATE
        `;
    }
  }

  /**
   * Order lines, exactly as stored.
   *
   * ONE QUERY. It used to be two: a second `productVariant.findMany` looked up
   * each line's mirrored provider variant id, because a TagadaPay checkout item
   * carried a `variantId` and no amount, so the mirror was the only channel
   * through which a price could reach the payment page. Whop takes the amount
   * directly on the checkout call, so there is no mirror to join to and checkout
   * reads nothing here beyond the money it already holds.
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

  async findPaymentByProviderId(
    providerPaymentId: string,
  ): Promise<PaymentSnapshot | null> {
    return this.toPaymentSnapshot(
      await this.db.payment.findUnique({
        where: { providerPaymentId },
      }),
    );
  }

  /**
   * The payment a refund can be issued against: the SUCCEEDED attempt.
   *
   * An order may have several attempts (a declined card, then a good one).
   * Refunding the wrong one is an error the gateway would reject anyway, but
   * selecting correctly here keeps the failure out of the money path entirely.
   */
  async findRefundablePaymentForOrder(orderId: string): Promise<PaymentSnapshot | null> {
    return this.toPaymentSnapshot(
      await this.db.payment.findFirst({
        where: { orderId, status: "SUCCEEDED" },
        orderBy: { createdAt: "desc" },
      }),
    );
  }

  // --- Writes --------------------------------------------------------------

  async recordPaymentAttempt(
    input: RecordPaymentAttemptInput,
  ): Promise<PaymentSnapshot> {
    const created = await this.db.payment.create({
      data: {
        orderId: input.orderId,
        provider: "WHOP",
        status: input.status,
        amount: input.amount,
        currency: input.currency,
        providerPaymentId: input.providerPaymentId,
      },
    });

    const snapshot = this.toPaymentSnapshot(created);
    if (snapshot === null) {
      throw new Error("Payment row vanished immediately after creation");
    }
    return snapshot;
  }

  /**
   * INSERT ... ON CONFLICT, expressed as a Prisma upsert.
   *
   * One statement, so there is no window between "does a row with this provider
   * payment id exist?" and "create one". The check-then-insert this replaces let
   * two concurrent settlement events for the same `paymentId` both decide to
   * insert; the loser raised P2002 out of the webhook transaction and the
   * controller answered 500 to a delivery whose signature was perfectly valid.
   *
   * `amount` appears in `create` ONLY. On update the row keeps the amount the
   * first settlement event reported — on the PAYMENT_MISMATCH path that figure is
   * the provider's side of the discrepancy an operator reconciles, and silently
   * rewriting it with a later event's number would destroy the evidence.
   * `failureCode` / `failureMessage` are cleared because a settlement supersedes
   * an earlier failed attempt on the same payment id.
   *
   * `orderId` is re-scoped on update, NOT left to `create` only. The upsert is
   * keyed on `providerPaymentId` — which is `@unique` GLOBALLY, so at most one row
   * exists per payment id regardless of order. If Whop ever delivers a
   * settlement for order A carrying a `paymentId` already attached to order B's
   * row, the update branch fires against B's row; without setting `orderId` here
   * that write would flip B's ledger row to SUCCEEDED with A's capture time while
   * `applySettlement` marks order A PAID — money attributed to the wrong order,
   * silently. Writing `input.orderId` re-attributes the single row to the order
   * this settlement actually belongs to. In the ordinary concurrent case (the
   * same settlement delivered as both `payment/succeeded` and `order/paid` for the
   * same order) `input.orderId` equals the existing value, so this is a no-op.
   */
  async upsertSettlementPayment(input: UpsertSettlementPaymentInput): Promise<void> {
    await this.db.payment.upsert({
      where: { providerPaymentId: input.providerPaymentId },
      create: {
        orderId: input.orderId,
        provider: "WHOP",
        status: input.status,
        amount: input.amount,
        currency: input.currency,
        providerPaymentId: input.providerPaymentId,
        cardBrand: input.cardBrand,
        cardLast4: input.cardLast4,
        capturedAt: input.capturedAt,
      },
      update: {
        orderId: input.orderId,
        status: input.status,
        cardBrand: input.cardBrand,
        cardLast4: input.cardLast4,
        capturedAt: input.capturedAt,
        failureCode: null,
        failureMessage: null,
      },
    });
  }

  async updatePaymentByProviderId(input: UpdatePaymentInput): Promise<void> {
    // updateMany, not update: an event can arrive for an intent we never
    // recorded (e.g. created out-of-band). A zero-count result is a no-op
    // rather than a thrown P2025 that would fail the whole webhook.
    await this.db.payment.updateMany({
      // Scoped to the correlated order as well as the provider payment id: an event
      // correlated to order A must never mutate a payment row that belongs to order B
      // just because it names B's paymentId.
      where: { providerPaymentId: input.providerPaymentId, orderId: input.orderId },
      data: {
        status: input.status,
        providerTransactionId: input.providerTransactionId,
        cardBrand: input.cardBrand,
        cardLast4: input.cardLast4,
        failureCode: input.failureCode,
        failureMessage: input.failureMessage,
        capturedAt: input.capturedAt,
      },
    });
  }

  async linkCheckoutId(orderId: string, checkoutId: string): Promise<void> {
    await this.db.order.update({
      where: { id: orderId },
      data: { providerCheckoutId: checkoutId },
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
   * Both leave permanent holes in a series EU member states require to be
   * unbroken. So:
   *
   *   1. LOCK THE ORDER ROW AND READ IT. Under READ COMMITTED, `FOR UPDATE`
   *      waits for any competing settlement and then returns the version that
   *      transaction committed — so a second delivery genuinely sees the first
   *      one's number and takes the early return. Without the lock the loser
   *      would still be safe (step 3 refuses to renumber and the throw rolls its
   *      allocation back) but it would fail an authentic delivery with a 500,
   *      which is exactly the answer that makes Whop retry forever. The webhook
   *      path already holds this lock from `findOrderByProviderReference`;
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

  async addRefundedTotal(orderId: string, delta: Minor): Promise<void> {
    await this.db.order.update({
      where: { id: orderId },
      data: { refundedTotal: { increment: delta }, version: { increment: 1 } },
    });
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

  async recordRefund(input: RecordRefundInput): Promise<void> {
    await this.db.refund.create({
      data: {
        paymentId: input.paymentId,
        orderId: input.orderId,
        status: input.status,
        reason: input.reason,
        amount: input.amount,
        currency: input.currency,
        providerRefundId: input.providerRefundId,
        note: input.note,
        actorId: input.actorId,
        completedAt: input.status === "SUCCEEDED" ? new Date() : null,
      },
    });
  }

  async recordDispute(input: RecordDisputeInput): Promise<void> {
    await this.db.dispute.upsert({
      where: { providerDisputeId: input.providerDisputeId },
      create: {
        orderId: input.orderId,
        providerDisputeId: input.providerDisputeId,
        status: input.status,
        reason: input.reason,
        amount: input.amount,
        currency: input.currency,
        evidenceDueBy: input.evidenceDueBy,
        closedAt: input.closedAt,
      },
      update: {
        status: input.status,
        evidenceDueBy: input.evidenceDueBy,
        closedAt: input.closedAt,
      },
    });
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

  // --- Catalog mirror ------------------------------------------------------


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
      providerCheckoutId: string | null;
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
      providerCheckoutId: row.providerCheckoutId,
    };
  }

  private toPaymentSnapshot(
    row: {
      id: string;
      orderId: string;
      status: PaymentSnapshot["status"];
      amount: number;
      currency: string;
      providerPaymentId: string | null;
      providerTransactionId: string | null;
    } | null,
  ): PaymentSnapshot | null {
    if (row === null) {
      return null;
    }

    const currency: CurrencyCode = row.currency;

    return {
      id: row.id,
      orderId: row.orderId,
      status: row.status,
      amount: toMinor(row.amount),
      currency,
      providerPaymentId: row.providerPaymentId,
      providerTransactionId: row.providerTransactionId,
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
          // The id is Whop's own `webhook-id`, so this INSERT is the dedupe:
          // a redelivery repeats the header verbatim and violates the primary
          // key, rolling the whole transaction back atomically.
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
}
