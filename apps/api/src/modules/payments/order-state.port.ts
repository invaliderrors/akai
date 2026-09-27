import { Injectable } from "@nestjs/common";
import { ORDER_STATUS_TRANSITIONS, type OrderStatus } from "@akai/contracts";

/**
 * Order state transitions, as far as the payments module is concerned.
 *
 * PROVISIONAL — see followUps. Spec §13 says the OrdersModule domain service is
 * the ONLY thing that may set `order.status`, and that it throws on an illegal
 * transition. That module is still a placeholder, so this port stands in for it:
 * the payments module depends on the INTERFACE, and the integration pass rebinds
 * `ORDER_STATE_PORT` to the real OrdersModule service without touching a line of
 * payments code.
 *
 * The default implementation reads `ORDER_STATUS_TRANSITIONS` from
 * @akai/contracts — the same table the dashboard's status dropdown and the
 * orders tests read — so there is no second copy of the transition graph here to
 * drift out of sync.
 */
export class IllegalOrderTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`Illegal order transition ${from} -> ${to}`);
    this.name = "IllegalOrderTransitionError";
  }
}

export interface OrderStatePort {
  canTransition(from: OrderStatus, to: OrderStatus): boolean;

  /** Throws `IllegalOrderTransitionError` rather than coercing. */
  assertTransition(from: OrderStatus, to: OrderStatus): void;
}

export const ORDER_STATE_PORT = Symbol("ORDER_STATE_PORT");

@Injectable()
export class TransitionTableOrderState implements OrderStatePort {
  canTransition(from: OrderStatus, to: OrderStatus): boolean {
    return ORDER_STATUS_TRANSITIONS[from].includes(to);
  }

  assertTransition(from: OrderStatus, to: OrderStatus): void {
    if (!this.canTransition(from, to)) {
      throw new IllegalOrderTransitionError(from, to);
    }
  }
}

/**
 * Is the order already at (or past) the state this event wants to set?
 *
 * Whop guarantees NO delivery order and retries up to 12 times over ~71 hours, so
 * `payment/succeeded` and `order/paid` routinely both
 * arrive wanting PAID. They carry different event ids, so the `provider_event`
 * dedupe does not collapse them — the second must be recognised as a no-op here
 * instead of throwing PAID -> PAID at the transition table.
 *
 * This is the "handler is either commutative or gated by the state machine"
 * requirement from spec §9, made explicit.
 */
export function isRedundantTransition(
  current: OrderStatus,
  target: OrderStatus,
): boolean {
  if (current === target) {
    return true;
  }

  // Once money has been refunded or the order cancelled, a late "succeeded"
  // event must never walk the order back to PAID.
  const TERMINAL: readonly OrderStatus[] = [
    "CANCELLED",
    "REFUNDED",
    "PARTIALLY_REFUNDED",
    "FAILED",
  ];

  if (target === "PAID" && TERMINAL.includes(current)) {
    return true;
  }

  // PAYMENT_MISMATCH may only be ENTERED from the pre-settlement states.
  //
  // §6 places PAYMENT_MISMATCH downstream of PENDING / AWAITING_PAYMENT only. A
  // settlement event that reports a wrong — or, crucially, an ABSENT — amount
  // targets PAYMENT_MISMATCH, and a provider can deliver a SECOND settlement
  // for the same order (`payment/succeeded` then `order/paid`, each a distinct event
  // id the dedupe table cannot collapse) where the second carries no amount. If the
  // order has already left the pre-settlement states — it is PAID, refunded,
  // cancelled or failed — that late, out-of-order event must be a no-op, NOT an
  // attempt to drag a resolved order into an operator-only hold. Without this clause
  // `assertTransition("PAID", "PAYMENT_MISMATCH")` throws (PAID has no edge to
  // PAYMENT_MISMATCH), the webhook 500s, and because the transaction rolls the
  // `provider_event` row back with it, the provider replays the identical 500 forever.
  // Only PENDING and AWAITING_PAYMENT may enter PAYMENT_MISMATCH.
  if (
    target === "PAYMENT_MISMATCH" &&
    current !== "PENDING" &&
    current !== "AWAITING_PAYMENT"
  ) {
    return true;
  }

  // PAYMENT_MISMATCH -> PAID IS A HUMAN-ONLY TRANSITION (contract §6.3).
  //
  // `ORDER_STATUS_TRANSITIONS` deliberately permits it — an operator who has
  // reconciled the discrepancy must be able to settle the order — but the
  // AUTOMATED path must never take it. Without this clause a second
  // `payment/succeeded` delivery reporting the correct amount would quietly
  // promote a flagged order to PAID, erasing the very discrepancy the state
  // exists to surface, and triggering the invoice and fulfilment jobs that
  // `applyMismatch` withheld on purpose. "Legal" and "legal for a webhook to do"
  // are different questions; this is the second one.
  if (target === "PAID" && current === "PAYMENT_MISMATCH") {
    return true;
  }

  // A payment-failure event arriving after the order is demonstrably paid or
  // beyond is stale; the successful attempt is the truth.
  const PAID_OR_BEYOND: readonly OrderStatus[] = [
    "PAID",
    "FULFILLING",
    "SHIPPED",
    "DELIVERED",
  ];

  if (target === "FAILED" && PAID_OR_BEYOND.includes(current)) {
    return true;
  }

  // A SETTLEMENT event arriving after the order is already paid or beyond is a
  // late, out-of-order redelivery, not a new settlement. Whop guarantees no
  // ordering and retries a delivery up to 12 times under DISTINCT `webhook-id`s
  // the dedupe table cannot collapse, and `applyPaid` enqueues the fulfilment job
  // in the SAME transaction that marks the order PAID — so the order can
  // legitimately be FULFILLING (or beyond) by the time a redelivery lands.
  // Without this clause `assertTransition("SHIPPED", "PAID")` throws (SHIPPED has
  // no edge back to PAID), the webhook 500s, and because the transaction rolls
  // the `provider_event` row back with it, the provider replays the identical 500
  // forever. For FULFILLING the clause matters MORE, not less: FULFILLING -> PAID
  // IS a legal edge (a cancelled Sendcloud label walks it back), so without this
  // a replayed settlement would silently un-fulfil an order with a label on it. `current === "PAID"` is already caught above by the identity check;
  // the states this adds are FULFILLING / SHIPPED / DELIVERED.
  if (target === "PAID" && PAID_OR_BEYOND.includes(current)) {
    return true;
  }

  return false;
}
