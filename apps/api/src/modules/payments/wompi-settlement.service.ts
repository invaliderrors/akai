import { Inject, Injectable } from "@nestjs/common";
import {
  currencyCodeSchema,
  isMinor,
  type CurrencyCode,
  type Minor,
  type OrderStatus,
  type PaymentStatus,
} from "@akai/contracts";
import type { Logger } from "@akai/observability";

import { LOGGER } from "../observability/logger.module";
import { settleOrderPaid } from "./order-settlement";
import {
  ORDER_STATE_PORT,
  isRedundantTransition,
  type OrderStatePort,
} from "./order-state.port";
import {
  PAYMENTS_REPOSITORY,
  type OrderSnapshot,
  type PaymentsRepository,
  type PaymentsWriter,
  type RecordTransactionInput,
} from "./repository/payments.repository";
import {
  wompiTransactionStatusSchema,
  type WompiTransaction,
  type WompiTransactionStatus,
} from "./wompi/wompi-events";

/** Where a transaction came from. Recorded in logs; the settlement is identical. */
export type SettlementSource = "webhook" | "return" | "sweep";

/**
 * What happened to one transaction. Returned rather than logged-and-forgotten so
 * the controller can report it and the tests can assert on it.
 */
export type SettlementOutcome =
  | { readonly status: "applied"; readonly transactionStatus: WompiTransactionStatus }
  | { readonly status: "duplicate"; readonly transactionStatus: WompiTransactionStatus }
  | { readonly status: "ignored"; readonly reason: string }
  | { readonly status: "unmatched" };

/** Why a reported settlement was refused. Recorded on the order event and the alert. */
export type MismatchReason = "AMOUNT_ABSENT" | "AMOUNT_DIFFERS" | "CURRENCY_DIFFERS";

/**
 * The settlement decision, as a value.
 *
 * `SETTLE ⟺ amount_in_cents is a valid Minor
 *         ∧ currency === order.currency
 *         ∧ amount_in_cents === order.grandTotal`
 */
export type SettlementVerdict =
  | { readonly settle: true; readonly amount: Minor; readonly currency: CurrencyCode }
  | { readonly settle: false; readonly reason: MismatchReason };

/**
 * `provider_event.type` for a verified event whose transaction we could not
 * parse. Ours, not Wompi's. Fits `VarChar(64)`.
 */
export const UNPARSABLE_EVENT_TYPE = "webhook/unparsable";

/** Prefix for the synthetic dedupe key of an unparsable event (+ 64 hex = 75 chars). */
export const UNPARSABLE_EVENT_ID_PREFIX = "unparsable:";

/** Statuses that end a transaction without money moving. */
const FAILED_TRANSACTION_STATUSES: readonly WompiTransactionStatus[] = [
  "DECLINED",
  "VOIDED",
  "ERROR",
];

/**
 * Orders we have already given up on. A transaction APPROVED after this has
 * taken money for an order that released its stock — never settled silently,
 * never ignored silently: see `applyUnexpectedApproval`.
 */
const ABANDONED_STATUSES: readonly OrderStatus[] = ["FAILED", "CANCELLED"];

/** Orders whose money already settled — a further APPROVED is a second payment. */
const SETTLED_ORDER_STATUSES: readonly OrderStatus[] = [
  "PAID",
  "FULFILLING",
  "SHIPPED",
  "DELIVERED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
];

/**
 * The dedupe key for one state of one transaction.
 *
 * SHARED BY EVERY SOURCE. The webhook, the return page and the sweep all write
 * `wompi:<id>:<status>`, so whichever sees a state first applies it and the
 * others collide on the primary key. Wompi's events carry no delivery id of
 * their own, and (transaction, status) is exactly the unit that must apply
 * once. ≤ 6 + 64 + 1 + 8 chars, inside `VarChar(128)`.
 */
export function transactionEventId(transactionId: string, status: string): string {
  return `wompi:${transactionId}:${status}`;
}

/**
 * Decide whether an APPROVED transaction may settle an order.
 *
 * ABSENCE IS NEVER AGREEMENT. A transaction that does not say what was charged
 * cannot prove the right amount was charged — `AMOUNT_ABSENT`, not PAID. This is
 * "treat the provider's reported amount as untrusted input".
 *
 * NO UNIT CONVERSION. `amount_in_cents` is centavos and so is our ledger
 * (`$ 89.000` is `8_900_000` on both sides), so the comparison is integer
 * equality on the reported number. `isMinor` refuses a fraction, a negative or
 * an out-of-range figure — a total we cannot read exactly is a total we cannot
 * agree with.
 *
 * `order.grandTotal` is OUR recomputed total and stays authoritative; nothing
 * here can change it. Exported and pure: it is the single most important
 * predicate in the payments module.
 */
export function verifySettlement(
  transaction: WompiTransaction,
  order: OrderSnapshot,
): SettlementVerdict {
  const amount = transaction.amount_in_cents;
  if (!isMinor(amount)) {
    return { settle: false, reason: "AMOUNT_ABSENT" };
  }

  const currency = currencyCodeSchema.safeParse(transaction.currency?.toUpperCase());
  if (!currency.success || currency.data !== order.currency) {
    return { settle: false, reason: "CURRENCY_DIFFERS" };
  }

  if (amount !== order.grandTotal) {
    return { settle: false, reason: "AMOUNT_DIFFERS" };
  }

  return { settle: true, amount, currency: currency.data };
}

/** The reported amount as ledger evidence, or null when it is not a valid one. */
function reportedEvidence(
  transaction: WompiTransaction,
): RecordTransactionInput["reported"] {
  const amount = transaction.amount_in_cents;
  const currency = currencyCodeSchema.safeParse(transaction.currency?.toUpperCase());
  return isMinor(amount) && amount > 0 && currency.success
    ? { amount, currency: currency.data }
    : null;
}

/**
 * Internal sentinel: the transaction's reference matched no order — or, on the
 * return page, matched a DIFFERENT order than the one asked about. Thrown INSIDE
 * the dedupe transaction so the `provider_event` row rolls back with it: a
 * reference that does not correlate now must not burn its key.
 */
class UnmatchedTransactionError extends Error {
  constructor() {
    super("Wompi transaction reference matched no order");
    this.name = "UnmatchedTransactionError";
  }
}

export interface ApplyTransactionOptions {
  readonly source: SettlementSource;
  /** When the event was sent — used only when the transaction has no `finalized_at`. */
  readonly eventTime?: Date | undefined;
  /**
   * The order the caller is asking about. The return page passes the order in
   * its URL, and a transaction whose reference belongs to another order is
   * REFUSED (`unmatched`) — a shopper must not be able to settle order B by
   * pasting order A's transaction id.
   */
  readonly expectedOrderNumber?: string | undefined;
}

/**
 * THE settlement, for every source.
 *
 * The webhook, the return-page confirmation and the reconciliation sweep each
 * end here with a Wompi transaction in hand. There is one code path from "Wompi
 * says" to "order state", so the three cannot disagree about what APPROVED for
 * the wrong amount means.
 *
 *   APPROVED                 -> PAID, only if amount AND currency match ours;
 *                               otherwise PAYMENT_MISMATCH + alert
 *   DECLINED / VOIDED / ERROR -> FAILED, reservations released, customer emailed
 *   PENDING                  -> order untouched; the transaction id is recorded
 *                               on the attempt (PROCESSING) so the sweep can
 *                               re-ask about it
 */
@Injectable()
export class WompiSettlementService {
  constructor(
    @Inject(PAYMENTS_REPOSITORY) private readonly repository: PaymentsRepository,
    @Inject(ORDER_STATE_PORT) private readonly orderState: OrderStatePort,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Apply one AUTHENTIC transaction, exactly once per (transaction, status).
   *
   * "Authentic" is the caller's job: the webhook verified the event checksum;
   * the return page and the sweep fetched the transaction from Wompi with the
   * private key. Nothing here re-checks that, and nothing here may be reached
   * with a transaction a browser described.
   *
   * IDEMPOTENCY IS STRUCTURAL: `runOnceForEvent` inserts the `provider_event`
   * row and runs the handler in ONE transaction, and the handler correlates
   * through `findOrderByPaymentReference`, which takes the order row lock — so
   * two DIFFERENT keys touching one order (an APPROVED from the webhook and a
   * DECLINED of an earlier transaction from the sweep) serialise, and the second
   * re-reads what the first committed.
   */
  async applyTransaction(
    transaction: WompiTransaction,
    options: ApplyTransactionOptions,
  ): Promise<SettlementOutcome> {
    const status = wompiTransactionStatusSchema.safeParse(transaction.status);

    if (!status.success) {
      // A status Wompi added after this was written. ACKed, so it is not
      // retried forever, and visible in the logs.
      this.logger.warn(
        { transactionId: transaction.id, status: transaction.status, source: options.source },
        "Wompi transaction in an unknown status; ignored",
      );
      return { status: "ignored", reason: `Unknown transaction status ${transaction.status}` };
    }

    const transactionStatus = status.data;
    const eventTime = this.transactionTime(transaction, options.eventTime);

    let applied: boolean;
    try {
      applied = await this.repository.runOnceForEvent(
        {
          id: transactionEventId(transaction.id, transactionStatus),
          type: `transaction.${transactionStatus.toLowerCase()}`,
        },
        async (tx) => {
          const order = await tx.findOrderByPaymentReference(transaction.reference);

          if (
            order === null ||
            (options.expectedOrderNumber !== undefined &&
              order.orderNumber !== options.expectedOrderNumber)
          ) {
            throw new UnmatchedTransactionError();
          }

          await this.handle(tx, order, transaction, transactionStatus, eventTime);
        },
      );
    } catch (error) {
      if (error instanceof UnmatchedTransactionError) {
        // Not an error and never a 4xx: a Wompi account can carry payments we
        // did not originate (payment links, another integration), and a non-200
        // would put them into Wompi's retry schedule.
        this.logger.warn(
          {
            transactionId: transaction.id,
            reference: transaction.reference,
            expectedOrderNumber: options.expectedOrderNumber ?? null,
            source: options.source,
          },
          "Wompi transaction could not be matched to an order",
        );
        return { status: "unmatched" };
      }
      throw error;
    }

    if (!applied) {
      this.logger.info(
        { transactionId: transaction.id, status: transactionStatus, source: options.source },
        "Wompi transaction state already applied",
      );
      return { status: "duplicate", transactionStatus };
    }

    this.logger.info(
      { transactionId: transaction.id, status: transactionStatus, source: options.source },
      "Wompi transaction applied",
    );
    return { status: "applied", transactionStatus };
  }

  /**
   * A body whose CHECKSUM VERIFIED but whose transaction we could not parse.
   *
   * The loudest thing that can happen without money moving: the event is
   * provably Wompi's and we do not understand it. Never a 4xx (Wompi would
   * retry a payload we will keep failing on) — ONE alert, deduped on the
   * verified checksum, so a replay pages nobody twice.
   */
  async recordUnparsable(checksum: string, issues: readonly string[]): Promise<void> {
    const applied = await this.repository.runOnceForEvent(
      { id: `${UNPARSABLE_EVENT_ID_PREFIX}${checksum.toLowerCase()}`, type: UNPARSABLE_EVENT_TYPE },
      async (tx) => {
        await tx.enqueue("notifications", {
          kind: "webhook-unparsable",
          provider: "WOMPI",
          checksum: checksum.toLowerCase(),
          issues: [...issues],
          detectedAt: new Date().toISOString(),
        });
      },
    );

    if (!applied) {
      this.logger.info(
        { checksum },
        "Replay of an already-reported unparsable Wompi event; no new alert",
      );
      return;
    }

    this.logger.error(
      { issues, checksum },
      "Wompi event checksum verified but its transaction failed schema validation",
    );
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private async handle(
    tx: PaymentsWriter,
    order: OrderSnapshot,
    transaction: WompiTransaction,
    status: WompiTransactionStatus,
    eventTime: Date,
  ): Promise<void> {
    if (status === "APPROVED") {
      await this.applyApproved(tx, order, transaction, eventTime);
      return;
    }

    if (FAILED_TRANSACTION_STATUSES.includes(status)) {
      await this.applyFailed(tx, order, transaction, status);
      return;
    }

    await this.applyPending(tx, order, transaction);
  }

  // -------------------------------------------------------------------------
  // APPROVED
  // -------------------------------------------------------------------------

  private async applyApproved(
    tx: PaymentsWriter,
    order: OrderSnapshot,
    transaction: WompiTransaction,
    eventTime: Date,
  ): Promise<void> {
    if (this.isOperatorHeld(order, transaction)) {
      return;
    }

    if (ABANDONED_STATUSES.includes(order.status)) {
      await this.applyUnexpectedApproval(tx, order, transaction, eventTime, "payment-after-failure");
      return;
    }

    // ALREADY SETTLED. The (transaction, APPROVED) dedupe means this is a
    // DIFFERENT transaction reaching APPROVED — the shopper paid twice (two
    // attempts' links, or a staff re-issue paid on top of the original). Never
    // a second settlement and never silently dropped: recorded and paged.
    if (SETTLED_ORDER_STATUSES.includes(order.status)) {
      await this.applyUnexpectedApproval(tx, order, transaction, eventTime, "duplicate-payment");
      return;
    }

    const verdict = verifySettlement(transaction, order);

    if (!verdict.settle) {
      await this.applyMismatch(tx, order, transaction, verdict.reason);
      return;
    }

    // Belt and braces: the settled states were handled above, so this only
    // guards a state added to the machine later — a no-op, never a throw.
    if (isRedundantTransition(order.status, "PAID")) {
      this.logger.info(
        { orderNumber: order.orderNumber, status: order.status },
        "Approved transaction ignored; order already settled",
      );
      return;
    }

    this.orderState.assertTransition(order.status, "PAID");

    await tx.recordTransaction(
      this.transactionRow(order, transaction, "SUCCEEDED", eventTime, {
        amount: verdict.amount,
        currency: verdict.currency,
      }),
    );

    // The steps every paid order gets, wherever the settlement came from —
    // shared with the payments-disabled checkout so a demo order is identical.
    await settleOrderPaid(tx, order, {
      occurredAt: eventTime,
      timelineMessage: `Payment confirmed for ${verdict.amount} ${verdict.currency}${describeMethod(transaction)}`,
    });
  }

  /**
   * Wompi says money moved, but not the money we asked for.
   *
   * All of it or none of it, inside the dedupe transaction. It does NOT release
   * the stock (money may well have moved, so the units stay held), does NOT
   * commit it (nothing was sold at a price we agreed to), does NOT mark the
   * order paid, and enqueues nothing customer-facing or invoice-numbered. It
   * DOES make the discrepancy impossible to miss: a dedicated state, both
   * figures on record, and an operator paged.
   */
  private async applyMismatch(
    tx: PaymentsWriter,
    order: OrderSnapshot,
    transaction: WompiTransaction,
    reason: MismatchReason,
  ): Promise<void> {
    if (isRedundantTransition(order.status, "PAYMENT_MISMATCH")) {
      this.logger.warn(
        { orderNumber: order.orderNumber, status: order.status, reason },
        "Payment mismatch ignored; order already past the pre-settlement states",
      );
      return;
    }

    this.orderState.assertTransition(order.status, "PAYMENT_MISMATCH");

    // The provider's OWN figures, exactly as reported — the evidence an
    // operator reconciles against. A figure we cannot read is not written to a
    // typed column; the order event and the alert carry it verbatim instead.
    const reportedAmount = transaction.amount_in_cents ?? null;
    const reportedCurrency = transaction.currency ?? null;

    await tx.recordTransaction(
      this.transactionRow(
        order,
        transaction,
        "SUCCEEDED",
        this.transactionTime(transaction),
        reportedEvidence(transaction),
      ),
    );

    await tx.setOrderStatus(order.id, "PAYMENT_MISMATCH");

    await tx.appendOrderEvent({
      orderId: order.id,
      type: "payment.mismatch",
      message:
        `Wompi reported ${reportedAmount === null ? "no amount" : String(reportedAmount)} ${reportedCurrency ?? ""}`.trim() +
        `; order total is ${order.grandTotal} ${order.currency} (${reason})`,
      isInternal: false,
    });

    await tx.enqueue("notifications", {
      kind: "payment-mismatch",
      orderId: order.id,
      orderNumber: order.orderNumber,
      reportedAmount,
      reportedCurrency,
      expectedAmount: order.grandTotal,
      expectedCurrency: order.currency,
      reason,
      providerPaymentId: transaction.id,
    });

    this.logger.error(
      {
        orderNumber: order.orderNumber,
        reason,
        reportedAmount,
        reportedCurrency,
        expectedAmount: order.grandTotal,
        expectedCurrency: order.currency,
      },
      "Payment amount mismatch; order parked in PAYMENT_MISMATCH",
    );
  }

  /**
   * An APPROVED transaction this order cannot absorb. Two cases, one response:
   *
   *   - `payment-after-failure`: the order is FAILED or CANCELLED. Reachable —
   *     Web Checkout can let a shopper retry after a decline, and the DECLINED
   *     event may have failed the order (and released its stock) first. There
   *     is no FAILED -> PAID edge, and there must not be a silent one: the
   *     stock may already be sold to someone else.
   *   - `duplicate-payment`: the order is already settled by ANOTHER
   *     transaction — the shopper paid twice.
   *
   * The money is RECORDED (a SUCCEEDED ledger row, an internal timeline entry)
   * and an operator is PAGED to refund it in the Wompi dashboard or resolve it
   * by hand. The order status is left alone. Ignoring it — what
   * `isRedundantTransition` alone would do — would keep a customer's money with
   * no trace on our side.
   */
  private async applyUnexpectedApproval(
    tx: PaymentsWriter,
    order: OrderSnapshot,
    transaction: WompiTransaction,
    eventTime: Date,
    kind: "payment-after-failure" | "duplicate-payment",
  ): Promise<void> {
    await tx.recordTransaction(
      this.transactionRow(order, transaction, "SUCCEEDED", eventTime, reportedEvidence(transaction)),
    );

    await tx.appendOrderEvent({
      orderId: order.id,
      type: `payment.${kind}`,
      message: `Wompi approved transaction ${transaction.id} while the order was ${order.status}; refund it in the Wompi dashboard or resolve by hand`,
      isInternal: true,
    });

    await tx.enqueue("notifications", {
      kind,
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderStatus: order.status,
      reportedAmount: transaction.amount_in_cents ?? null,
      reportedCurrency: transaction.currency ?? null,
      providerPaymentId: transaction.id,
    });

    this.logger.error(
      { orderNumber: order.orderNumber, status: order.status, transactionId: transaction.id, kind },
      "Wompi approved a payment the order cannot absorb; operator action required",
    );
  }

  // -------------------------------------------------------------------------
  // DECLINED / VOIDED / ERROR
  // -------------------------------------------------------------------------

  private async applyFailed(
    tx: PaymentsWriter,
    order: OrderSnapshot,
    transaction: WompiTransaction,
    status: WompiTransactionStatus,
  ): Promise<void> {
    // FIRST: an order on operator hold is off limits. `isRedundantTransition`
    // does not cover PAYMENT_MISMATCH -> FAILED, and the release below is the
    // one that hurts — money may have moved, so the stock stays held.
    if (this.isOperatorHeld(order, transaction)) {
      return;
    }

    // Before any ledger write: a late failure for an order already PAID (or
    // beyond) must touch neither the ledger nor the status.
    if (isRedundantTransition(order.status, "FAILED")) {
      this.logger.info(
        { orderNumber: order.orderNumber, status: order.status },
        "Failure ignored; order already settled or failed",
      );
      return;
    }

    await tx.recordTransaction(
      this.transactionRow(order, transaction, "FAILED", null, null, status),
    );

    this.orderState.assertTransition(order.status, "FAILED");
    await tx.setOrderStatus(order.id, "FAILED");

    // The payment failed, so the stock this order held returns to the shelf in
    // the same transaction rather than waiting for the TTL sweep. Contrast
    // `applyMismatch`, where money may have moved and the stock stays held.
    await tx.releaseReservationsForOrder(order.id);

    const message = transaction.status_message ?? "Payment failed";
    await tx.appendOrderEvent({
      orderId: order.id,
      type: "payment.failed",
      message: `${status}: ${message}`,
      isInternal: false,
    });

    await tx.enqueue("email", {
      templateKey: "payment-failed",
      orderId: order.id,
      orderNumber: order.orderNumber,
      locale: order.locale,
      recipient: order.email,
    });
  }

  // -------------------------------------------------------------------------
  // PENDING
  // -------------------------------------------------------------------------

  /**
   * Nothing to decide yet — the order stays AWAITING_PAYMENT. What IS worth
   * keeping is the transaction id: Wompi's events can be delayed, and with the
   * id on the attempt row (PROCESSING) the reconciliation sweep can ask Wompi
   * about it directly instead of waiting on a webhook that may not come.
   */
  private async applyPending(
    tx: PaymentsWriter,
    order: OrderSnapshot,
    transaction: WompiTransaction,
  ): Promise<void> {
    if (order.status !== "AWAITING_PAYMENT" && order.status !== "PENDING") {
      return;
    }

    await tx.recordTransaction(
      this.transactionRow(order, transaction, "PROCESSING", null, reportedEvidence(transaction)),
    );
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * PAYMENT_MISMATCH IS AN OPERATOR-ONLY HOLD. NO AUTOMATED PATH MAY LEAVE IT.
   *
   * A transaction may put an order INTO PAYMENT_MISMATCH; only a human may take
   * it out. This cannot live in `isRedundantTransition`, which the operator
   * paths share — "legal" and "legal for an automated settlement" are different
   * questions, and only this plane asks the second. Still ACKed and deduped: it
   * was genuinely delivered and genuinely seen.
   */
  private isOperatorHeld(order: OrderSnapshot, transaction: WompiTransaction): boolean {
    if (order.status !== "PAYMENT_MISMATCH") {
      return false;
    }

    this.logger.warn(
      { orderNumber: order.orderNumber, transactionId: transaction.id, status: transaction.status },
      "Transaction ignored; order is in PAYMENT_MISMATCH and only an operator may resolve it",
    );
    return true;
  }

  private transactionRow(
    order: OrderSnapshot,
    transaction: WompiTransaction,
    status: PaymentStatus,
    capturedAt: Date | null,
    reported: RecordTransactionInput["reported"],
    failureCode: string | null = null,
  ): RecordTransactionInput {
    return {
      orderId: order.id,
      providerReference: transaction.reference,
      providerPaymentId: transaction.id,
      status,
      reported,
      failureCode,
      failureMessage: failureCode === null ? null : (transaction.status_message ?? null),
      capturedAt,
    };
  }

  /**
   * When the money moved: the transaction's `finalized_at`, else the event's
   * own time, else `created_at`, else now. An unparseable stamp is skipped —
   * "now" is off by at most the delivery latency, an Invalid Date in the ledger
   * is wrong forever.
   */
  private transactionTime(transaction: WompiTransaction, eventTime?: Date): Date {
    return (
      parseStamp(transaction.finalized_at) ??
      eventTime ??
      parseStamp(transaction.created_at) ??
      new Date()
    );
  }
}

function parseStamp(stamp: string | null | undefined): Date | undefined {
  if (stamp == null) {
    return undefined;
  }
  const parsed = new Date(stamp);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** " (NEQUI)" for the timeline, or nothing. */
function describeMethod(transaction: WompiTransaction): string {
  return transaction.payment_method_type == null ? "" : ` (${transaction.payment_method_type})`;
}
