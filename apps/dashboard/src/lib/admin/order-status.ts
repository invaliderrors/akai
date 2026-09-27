import { ORDER_STATUS_TRANSITIONS, type OrderStatus } from "@akai/contracts";

/**
 * Which statuses the order-detail dropdown may offer.
 *
 * TWO independent rules apply, and conflating them is how a dashboard offers a
 * button that always 4xxs:
 *
 *  1. Is the move legal in the state machine?  → ORDER_STATUS_TRANSITIONS,
 *     imported from @akai/contracts. NOT redeclared here: the contracts module
 *     says in as many words that three copies of that table drifting apart is a
 *     guaranteed production incident, and the API's own state machine imports
 *     the same map.
 *  2. May a HUMAN OPERATOR perform it?  → ADMIN_ASSIGNABLE_STATUSES below.
 *
 * The API rejects a violation of (1) with 409 and of (2) with 403. The dropdown
 * simply never renders either, so the two are a defence-in-depth pair rather
 * than a duplicated rule: the server remains the enforcement point, and this is
 * only a rendering decision.
 *
 * DUPLICATION NOTE, deliberate and flagged in followUps:
 * ADMIN_ASSIGNABLE_STATUSES also exists in
 * apps/api/src/modules/orders/order-status.machine.ts. The dashboard is
 * `scope:web` and may only depend on `scope:shared`, so importing it from the
 * API is a lint error by design — Nx would (correctly) refuse to let a browser
 * bundle reach into a NestJS module. The right home is @akai/contracts beside
 * ORDER_STATUS_TRANSITIONS, but libs/contracts is being edited by parallel
 * agents right now, so adding to it would collide. In the meantime the set is
 * pinned member-by-member in order-status.test.ts with the reason each omission
 * exists, so a drift is a failing test rather than a silent privilege gain.
 */

/**
 * The statuses a STAFF/ADMIN operator may assign by hand.
 *
 * The OMISSIONS carry the meaning, and each is a security property rather than
 * a UI preference:
 *
 *  - PAID is absent because an order becomes PAID only through a
 *    signature-verified provider webhook. A clickable PAID would mean the "did the
 *    money arrive" question has two answers, one of which is forgeable by
 *    anyone who obtains a staff session.
 *  - REFUNDED / PARTIALLY_REFUNDED are absent because they are DERIVED from the
 *    refund ledger. Setting one directly marks an order refunded with no money
 *    moved and no Refund row to reconcile against.
 *  - PENDING / AWAITING_PAYMENT are absent because walking a paid order back
 *    into a pre-payment state is never legitimate.
 *  - FAILED is absent because only the payments module can know a payment
 *    attempt failed.
 */
export const ADMIN_ASSIGNABLE_STATUSES: readonly OrderStatus[] = [
  "FULFILLING",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
];

const ADMIN_ASSIGNABLE: ReadonlySet<OrderStatus> = new Set(ADMIN_ASSIGNABLE_STATUSES);

/**
 * The statuses to render in the transition dropdown for an order currently at
 * `from`. Empty means the control is hidden entirely, not disabled — a disabled
 * dropdown invites an operator to hunt for the permission that would enable it.
 */
export function adminTransitionOptions(from: OrderStatus): readonly OrderStatus[] {
  return ORDER_STATUS_TRANSITIONS[from].filter((to) => ADMIN_ASSIGNABLE.has(to));
}

/** True when nothing can leave this status. Drives the "final" badge. */
export function isTerminalStatus(status: OrderStatus): boolean {
  return ORDER_STATUS_TRANSITIONS[status].length === 0;
}

/**
 * Statuses that mean money has settled, so a refund control is meaningful.
 *
 * REFUNDED and PARTIALLY_REFUNDED are included: a refunded order was
 * unambiguously paid, and a partially-refunded one can be refunded further.
 * Mirrors `isPaidStatus` in the API's state machine.
 */
const REFUNDABLE_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  "PAID",
  "FULFILLING",
  "SHIPPED",
  "DELIVERED",
  "PARTIALLY_REFUNDED",
]);

/**
 * Whether to show the refund control at all.
 *
 * REFUNDED is deliberately excluded even though it is a "paid" status: there is
 * nothing left to refund, and the amount guard below would reject every entry.
 */
export function canRefund(status: OrderStatus, remainingRefundable: number): boolean {
  return REFUNDABLE_STATUSES.has(status) && remainingRefundable > 0;
}

/**
 * How much of an order may still be refunded.
 *
 * Computed as a guard for the FORM, not as an authority: the API recomputes this
 * server-side and bounds the refund by it. Client-side arithmetic on money is
 * for disabling a button, never for deciding an amount.
 */
export function remainingRefundable(grandTotal: number, refundedTotal: number): number {
  return Math.max(0, grandTotal - refundedTotal);
}

/*
 * THE STATUS TONE MAP HAS MOVED, and nothing else in this file has.
 *
 * `ORDER_STATUS_TONE` (and the `StatusTone` union that typed it) now live in
 * `lib/status` under the `order` domain, alongside the eleven other badged
 * vocabularies. Its one argued entry survived the move and got louder:
 * PAYMENT_MISMATCH is `attention` there rather than the `danger` it had here,
 * because money may have moved for the wrong amount and the order is frozen
 * until an operator rules on it — one of only two states in the whole product
 * that earn that treatment.
 *
 * The transition rules above are a DIFFERENT KIND OF THING and deliberately did
 * not move: they are security properties, not presentation.
 */
