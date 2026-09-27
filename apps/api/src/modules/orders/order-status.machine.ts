import { ConflictException, ForbiddenException } from "@nestjs/common";
import { ORDER_STATUS_TRANSITIONS, type OrderStatus } from "@akai/contracts";

/**
 * THE order state machine.
 *
 * This file is the only place that decides whether a status change is legal.
 * Nothing else in the platform may write `order.status` (spec §13) — not the
 * Whop webhook, not an admin controller, not a fulfilment job. They all route
 * through `assertTransition`.
 *
 * The transition table itself is deliberately NOT redeclared here: it is
 * imported from @akai/contracts, so the domain service, the dashboard's status
 * dropdown and these tests read the same map. Three copies of a transition
 * table drifting apart is a guaranteed production incident.
 *
 * The machine THROWS on an illegal transition rather than coercing. That is the
 * whole point. The provider delivers events out of order and retries them
 * aggressively, so a `payment_intent.succeeded` can land after a
 * `charge.refunded`. Coercion is exactly how a refunded order silently becomes
 * PAID again and ships free product.
 */

/** Thrown when a caller attempts a transition the table does not permit. */
export class IllegalOrderTransitionError extends ConflictException {
  public readonly from: OrderStatus;
  public readonly to: OrderStatus;

  constructor(from: OrderStatus, to: OrderStatus) {
    super({
      // The filter renders `message`; the extra keys are for log context.
      message:
        `Illegal order status transition ${from} -> ${to}. ` +
        `Legal transitions from ${from}: ` +
        `${formatLegalTargets(ORDER_STATUS_TRANSITIONS[from])}.`,
      from,
      to,
    });
    this.from = from;
    this.to = to;
  }
}

/**
 * Thrown when a transition is legal in the abstract but not something a human
 * operator may perform by hand.
 *
 * Separate from IllegalOrderTransitionError because the cause is different and
 * so is the fix: the operator has not hit a state-machine wall, they have hit a
 * rule saying "this status is owned by a system event, not by you".
 */
export class StatusNotAdminAssignableError extends ForbiddenException {
  public readonly to: OrderStatus;

  constructor(to: OrderStatus, reason: string) {
    super({ message: `An operator may not set an order to ${to}. ${reason}`, to });
    this.to = to;
  }
}

function formatLegalTargets(targets: readonly OrderStatus[]): string {
  return targets.length === 0 ? "(none — terminal state)" : targets.join(", ");
}

/** Non-throwing predicate. Use for rendering a dropdown, never for enforcement. */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[from].includes(to);
}

/** The enforcement point. Throws IllegalOrderTransitionError if `to` is not reachable. */
export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new IllegalOrderTransitionError(from, to);
  }
}

/** Statuses nothing can leave. */
export function isTerminal(status: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[status].length === 0;
}

/** Every status the order list may legally move to from here. */
export function legalTransitionsFrom(status: OrderStatus): readonly OrderStatus[] {
  return ORDER_STATUS_TRANSITIONS[status];
}

/**
 * Statuses that mean "money has settled".
 *
 * REFUNDED and PARTIALLY_REFUNDED are included: a refunded order was
 * unambiguously paid, and the invoice it produced is still filed for tax. This
 * set drives `isPaid` on the polled status endpoint and the invoice-number
 * allocation guard.
 */
const PAID_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "PAID",
  "FULFILLING",
  "SHIPPED",
  "DELIVERED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
]);

export function isPaidStatus(status: OrderStatus): boolean {
  return PAID_STATUSES.has(status);
}

/**
 * The statuses a STAFF/ADMIN operator may assign through the dashboard.
 *
 * Everything omitted here is owned by a system event, and the omissions are the
 * security-relevant part of this file:
 *
 *  - PAID is absent because an order becomes PAID ONLY via a signature-verified
 *    Whop webhook whose reported amount matched. If an operator
 *    could set PAID by hand, the "did the
 *    money actually arrive" question would have two answers, and the one an
 *    operator can click is forgeable by anyone who gets a staff session.
 *  - REFUNDED / PARTIALLY_REFUNDED are absent because they are derived from the
 *    refund ledger. Setting them directly would mark an order refunded without
 *    any money moving and without a Refund row to reconcile against.
 *  - PENDING / AWAITING_PAYMENT are absent because moving backwards into a
 *    pre-payment state on a paid order is never a legitimate operation.
 *  - FAILED is absent because it means "the payment attempt failed", which only
 *    the payments module can know.
 */
export const ADMIN_ASSIGNABLE_STATUSES: readonly OrderStatus[] = [
  "FULFILLING",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
];

const ADMIN_ASSIGNABLE: ReadonlySet<OrderStatus> = new Set(ADMIN_ASSIGNABLE_STATUSES);

/** Why each operator-forbidden status is forbidden. Surfaced in the 403 body. */
const NOT_ADMIN_ASSIGNABLE_REASON: Readonly<Partial<Record<OrderStatus, string>>> = {
  PAID: "An order becomes PAID only through a signature-verified provider webhook.",
  REFUNDED: "Refunded status is derived from the refund ledger; issue a refund instead.",
  PARTIALLY_REFUNDED:
    "Refunded status is derived from the refund ledger; issue a refund instead.",
  FAILED: "Payment failure is recorded by the payments module, not by hand.",
  PENDING: "An order cannot be moved back into a pre-payment state.",
  AWAITING_PAYMENT: "An order cannot be moved back into a pre-payment state.",
};

export function assertAdminMayAssign(to: OrderStatus): void {
  if (!ADMIN_ASSIGNABLE.has(to)) {
    throw new StatusNotAdminAssignableError(
      to,
      NOT_ADMIN_ASSIGNABLE_REASON[to] ?? "This status is set by a system event.",
    );
  }
}

/**
 * The status an order lands on once a refund settles.
 *
 * Derived from the amounts, never chosen by a caller — that is what keeps the
 * refund ledger and the order status from disagreeing.
 */
export function statusAfterRefund(
  refundedTotal: number,
  grandTotal: number,
): OrderStatus {
  if (refundedTotal >= grandTotal) {
    return "REFUNDED";
  }
  return "PARTIALLY_REFUNDED";
}
