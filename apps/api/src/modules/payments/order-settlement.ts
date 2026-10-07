import type { OrderSnapshot, PaymentsWriter } from "./repository/payments.repository";

/**
 * EVERYTHING THAT HAPPENS WHEN AN ORDER BECOMES PAID, in one place.
 *
 * Extracted from the webhook's `applyPaid` when a second caller appeared: with
 * `PAYMENTS_ENABLED=false` the checkout settles the order itself, and it must
 * produce a genuinely identical order — same stock movement, same timeline entry,
 * same confirmation email, same invoice trigger — or a demo would be showing the
 * owner a flow that does not exist in production.
 *
 * A copy of these six steps would drift the first time one of them changed. The
 * webhook keeps what is genuinely provider-specific (the redundancy check, the
 * state assertion and the payment-row upsert) and calls this for the rest.
 *
 * CALLED INSIDE THE CALLER'S TRANSACTION. The stock decrement must be atomic
 * with PAID and can never be lost to a rollback.
 */

export interface PaidSettlement {
  /** When the money moved — the provider's event time, or now for a local settlement. */
  readonly occurredAt: Date;
  /** Customer-visible timeline text. Written by the caller because only it knows why. */
  readonly timelineMessage: string;
}

export async function settleOrderPaid(
  tx: PaymentsWriter,
  order: OrderSnapshot,
  settlement: PaidSettlement,
): Promise<void> {
  // PAID, and the gap-free invoice number allocated with it, inside the caller's
  // transaction — so a rollback leaves neither a paid order without a number nor
  // a number consumed by a settlement that never happened. That second half is a
  // property of the COUNTER, not of this call site: it holds because allocation
  // increments a row (`invoice_counter`) rather than a sequence. It did not hold
  // while `next_invoice_number()` was behind it, and the docblock here used to
  // claim otherwise. The `payment-receipt` queued below is unsendable until the
  // number exists.
  await tx.markOrderPaid(order.id, settlement.occurredAt);

  // The sale is confirmed, so the reserved stock leaves for good — decremented in
  // THIS transaction so the movement is atomic with PAID. Idempotent, so an
  // out-of-order re-delivery cannot double-decrement.
  await tx.commitReservationsForOrder(order.id);

  await tx.appendOrderEvent({
    orderId: order.id,
    type: "payment.succeeded",
    message: settlement.timelineMessage,
    isInternal: false,
  });

  // Everything expensive is queued. The caller returns in milliseconds; the
  // dispatcher does the work with retry and a dead-letter behind it.
  for (const templateKey of ["order-confirmation", "payment-receipt"] as const) {
    await tx.enqueue("email", {
      templateKey,
      orderId: order.id,
      orderNumber: order.orderNumber,
      recipient: order.email,
    });
  }

  await tx.enqueue("email", {
    templateKey: "admin-new-order",
    orderId: order.id,
    orderNumber: order.orderNumber,
  });

  // NOT ENQUEUED HERE: `invoice-pdf`.
  //
  // `invoice-pdf` still has NO handler — `invoices` is an empty module — and
  // the dispatcher treats an UNROUTED topic as a FAILURE, not as work waiting
  // for a consumer: every paid order would produce a row that burns ~8 retries
  // and dead-letters, permanent red at /admin/jobs drowning the dead-letters
  // that mean something. A topic is emitted in the SAME change as its consumer,
  // or not at all. When the invoices consumer lands, restore it here:
  //
  //   await tx.enqueue("invoice-pdf", {
  //     action: "allocate-and-render", orderId: order.id, orderNumber: order.orderNumber,
  //   });
  //
  // The invoice NUMBER is already allocated by `markOrderPaid` above, so what is
  // missing here is only the PDF: `invoice-pdf` renders a document for a number
  // the order already carries, rather than allocating one. That split matters —
  // numbering is a legal invariant and belongs in the PAID transaction, while
  // rendering is retryable work. Orders paid before the handler lands need a
  // backfill rather than a replay: the outbox is a delivery mechanism, and the
  // `order` row is the record of what happened.
}
