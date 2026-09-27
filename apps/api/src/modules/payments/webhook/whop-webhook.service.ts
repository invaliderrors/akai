import { settleOrderPaid } from "../order-settlement";
import { Inject, Injectable } from "@nestjs/common";
import { currencyCodeSchema, type CurrencyCode, type Minor } from "@akai/contracts";
import { fromDecimalString, subtract } from "@akai/money";
import type { Logger } from "@akai/observability";

import { LOGGER } from "../../observability/logger.module";
import {
  ORDER_STATE_PORT,
  isRedundantTransition,
  type OrderStatePort,
} from "../order-state.port";
import {
  PAYMENTS_REPOSITORY,
  type OrderSnapshot,
  type PaymentsRepository,
  type PaymentsWriter,
  type ProviderOrderReference,
} from "../repository/payments.repository";
import {
  isHandledEventType,
  settlementSchema,
  type WhopEventEnvelope,
} from "./whop-webhook.schemas";

/**
 * What happened to one inbound event. Returned rather than logged-and-forgotten
 * so the controller can report it and the tests can assert on it.
 */
export type WebhookOutcome =
  | { readonly status: "applied"; readonly type: string }
  | { readonly status: "duplicate"; readonly type: string }
  | { readonly status: "ignored"; readonly type: string; readonly reason: string }
  | { readonly status: "unmatched"; readonly type: string }
  | { readonly status: "unparsable" };

/** Why a reported settlement was refused. Recorded on the order event and the alert. */
export type MismatchReason = "AMOUNT_ABSENT" | "AMOUNT_DIFFERS" | "CURRENCY_DIFFERS";

/**
 * The §6.1 settlement decision, as a value.
 *
 * `SETTLE ⟺ amount !== undefined ∧ currency !== undefined
 *         ∧ currency.toUpperCase() === order.currency
 *         ∧ fromDecimalString(String(total), …) === order.grandTotal`
 */
export type SettlementVerdict =
  | { readonly settle: true; readonly amount: Minor; readonly currency: CurrencyCode }
  | { readonly settle: false; readonly reason: MismatchReason };

/** A unit of work to run inside the dedupe transaction, against a correlated order. */
type EventHandler = (tx: PaymentsWriter, order: OrderSnapshot) => Promise<void>;

/**
 * Internal sentinel: the event verified, parsed and carried a correlation key, but that
 * key matched no order of ours AT THE MOMENT this delivery ran.
 *
 * It is thrown from INSIDE the `runOnceForEvent` transaction on purpose, so the transaction
 * — and with it the `provider_event` dedupe INSERT — rolls back. A no-op that COMMITTED its
 * dedupe row would burn the event's identity: the provider's legitimate redelivery of that same
 * event (which is exactly what happens when `order/paid` arrives before `providerOrderId`
 * has been backfilled, or before the order is visible) would then be swallowed as a
 * duplicate and never applied, stranding the order in AWAITING_PAYMENT forever. Rolling back
 * keeps the key unused so the redelivery re-runs and correlates. `handleEvent` catches it and
 * maps it to an `unmatched` 200 — never a 4xx, which would put the un-originated event into a
 * retry loop.
 */
class UnmatchedEventError extends Error {
  constructor() {
    super("Whop event carried a correlation key that matched no order");
    this.name = "UnmatchedEventError";
  }
}

/**
 * `provider_event.type` for a verified body we could not parse.
 *
 * Not a Whop event type — it is ours, and deliberately distinguishable so the
 * §7 `derived` audit can exclude these rows. Fits `VarChar(64)`.
 */
export const UNPARSABLE_EVENT_TYPE = "webhook/unparsable";

/**
 * Prefix for the synthetic dedupe key of an unparsable body.
 *
 * 11 chars + a 64-char SHA-256 hex digest = 75, comfortably inside the
 * `provider_event.id VarChar(128)` column. It cannot collide with a vendor id (those do
 * not carry this prefix) nor with `provider-event-id.ts`'s `derived:` keys.
 */
export const UNPARSABLE_EVENT_ID_PREFIX = "unparsable:";

/**
 * Decide whether an inbound event may settle an order.
 *
 * ABSENCE IS NEVER AGREEMENT. An event that does not say what was charged cannot
 * prove the right amount was charged, so it may not settle an order — it lands
 * in PAYMENT_MISMATCH with reason `AMOUNT_ABSENT`. This is the direct
 * consequence of "treat the webhook's reported amount as untrusted input".
 *
 * `total`, NEVER `amount_after_fees`. Both sit on the payload; the latter is net
 * of Whop's platform fee, so comparing it against `order.grandTotal` would
 * mismatch every single order.
 *
 * `order.grandTotal` is OUR recomputed total and stays authoritative; nothing
 * here can change it.
 *
 * THE UNIT CONVERSION IS PART OF THE CHECK, not a step before it. Whop reports
 * major units as a bare JSON number; our ledger is integer minor units.
 * `fromDecimalString(String(total), …)` is exact — `String(n)` is JS's shortest
 * round-tripping decimal, so no precision is invented — and it THROWS rather
 * than rounds when the value carries more fraction digits than the currency
 * holds. A total we cannot read exactly is a total we cannot agree with, so that
 * throw is caught here and treated as `AMOUNT_ABSENT`. `total * 100` with a
 * `Math.round` on top would have silently agreed with 49.999.
 *
 * Exported and pure so the amount check is testable without a database, a
 * transaction or a Nest container. It is the single most important predicate in
 * the payments module.
 */
export function verifySettlement(
  event: WhopEventEnvelope,
  order: OrderSnapshot,
): SettlementVerdict {
  // Parsed through `settlementSchema` rather than by two hand-written
  // `!== undefined` tests, so the exported schema IS the control instead of a
  // second, decorative copy of it.
  const reported = settlementSchema.safeParse({
    total: event.data.total,
    currency: event.data.currency,
  });

  if (!reported.success) {
    return { settle: false, reason: "AMOUNT_ABSENT" };
  }

  const reportedCurrency = currencyCodeSchema.safeParse(
    reported.data.currency.toUpperCase(),
  );

  if (!reportedCurrency.success || reportedCurrency.data !== order.currency) {
    return { settle: false, reason: "CURRENCY_DIFFERS" };
  }

  let reportedAmount: Minor;
  try {
    // Already an exact decimal string — `reportedAmountSchema` normalizes
    // both the legacy bare-number shape and the newer `Money` envelope to
    // one, so there is nothing left to stringify here.
    reportedAmount = fromDecimalString(reported.data.total, order.currency);
  } catch {
    return { settle: false, reason: "AMOUNT_ABSENT" };
  }

  if (reportedAmount !== order.grandTotal) {
    return { settle: false, reason: "AMOUNT_DIFFERS" };
  }

  return { settle: true, amount: reportedAmount, currency: reportedCurrency.data };
}

/**
 * The correlation references an event offers, in rank order.
 *
 * ONE FUNCTION, used by both the cheap pre-flight in `handleEvent` and the
 * in-transaction lookup in `resolveOrder`. They previously each built their own
 * list from the same fields, which is two places to forget a key.
 */
function correlationKeys(event: WhopEventEnvelope): readonly ProviderOrderReference[] {
  const references: ProviderOrderReference[] = [];

  const orderId = event.data.metadata?.order_id;
  if (orderId !== undefined) {
    references.push({ kind: "orderId", id: orderId });
  }

  const checkoutId = event.data.checkout_configuration_id;
  if (checkoutId != null) {
    references.push({ kind: "checkoutId", id: checkoutId });
  }

  return references;
}

/**
 * Convert a provider-reported major-unit decimal string to our minor units, or
 * `null`.
 *
 * NON-THROWING BY DESIGN, and the null is meaningful rather than defensive.
 * `fromDecimalString` refuses a value carrying more precision than the currency
 * holds instead of rounding it, which is the behaviour the settlement check
 * depends on — but the two callers here are recording evidence and reconciling a
 * refund, and neither should turn an unreadable figure into a 500 on an
 * authentic delivery. They branch on the null instead.
 */
function tryFromDecimal(value: string | null, currency: CurrencyCode | null): Minor | null {
  if (value === null || currency === null) {
    return null;
  }

  try {
    return fromDecimalString(value, currency);
  } catch {
    return null;
  }
}

@Injectable()
export class WhopWebhookService {
  constructor(
    @Inject(PAYMENTS_REPOSITORY) private readonly repository: PaymentsRepository,
    @Inject(ORDER_STATE_PORT) private readonly orderState: OrderStatePort,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Apply one VERIFIED and PARSED Whop event, exactly once.
   *
   * The controller owns steps 1-7 of the §4.1 sequence (raw body, signature,
   * JSON.parse, zod, freshness). By the time an envelope reaches this method its
   * authenticity is already established, so everything here is business logic.
   *
   * IDEMPOTENCY IS STRUCTURAL, not a check — but READ WHAT IT ACTUALLY COVERS.
   * `runOnceForEvent` inserts the `provider_event` row and runs the handler in ONE
   * transaction, so a REDELIVERY OF THE SAME EVENT ID hits a primary-key violation and
   * the entire transaction — event row AND state change — rolls back atomically. A
   * check-then-write would race against the vendor's own retries. The CRM plane binds no
   * timestamp into its signature (§4.3), so this table is the only UNCONDITIONAL replay
   * defence in the system; it may not be relaxed to an advisory check.
   *
   * WHAT THE DEDUPE TABLE DOES NOT COVER, and this was a real defect rather than a
   * theoretical one: `payment/succeeded` and `order/paid` describe the SAME settlement
   * and carry DIFFERENT event ids, so `provider_event` never collides and both
   * transactions are free to run. The guard that stops them both settling the order is
   * `isRedundantTransition` below — and that guard is only sound because
   * `findOrderByProviderReference` takes a `FOR UPDATE` row lock on the order, which
   * serialises the two transactions and makes the status this handler reads the status
   * the other transaction actually committed. Without the lock, both read
   * AWAITING_PAYMENT under READ COMMITTED, both pass the guard, and one order produces
   * two invoice numbers and two fulfilment jobs. Do not remove that lock; the
   * concurrency test in `apps/api-e2e/src/whop-webhook-dedupe.spec.ts` is what proves
   * it is still there.
   *
   * The handler does the minimum needed to record state and then ENQUEUES the real work
   * (emails, invoices, fulfilment), which is what keeps the ACK inside
   * the 5-second budget Whop allows before it counts the delivery as failed.
   */
  async handleEvent(
    event: WhopEventEnvelope,
    deliveryId: string,
  ): Promise<WebhookOutcome> {
    const handler = this.resolveHandler(event);

    if (handler === null) {
      // Not an error. Whop sends whatever the endpoint is subscribed to, and a 200 on an
      // unhandled type stops it retrying forever.
      return {
        status: "ignored",
        type: event.type,
        reason: "No handler registered for this event type",
      };
    }

    // Cheap pre-flight: an event carrying neither correlation key can never
    // match an order, so there is nothing to dedupe and nothing to transact. The
    // in-transaction `resolveOrder` still handles the case where a key IS
    // present but matches nothing of ours.
    if (correlationKeys(event).length === 0) {
      this.logger.warn(
        { eventType: event.type },
        "Whop event carries no correlation key (metadata.order_id, checkout_configuration_id)",
      );
      return { status: "unmatched", type: event.type };
    }

    // An event that correlated to no order must NOT commit its dedupe row (see
    // `UnmatchedEventError`), so the "did not correlate" answer is carried out of
    // the transaction by THROWING that sentinel rather than by a mutable flag
    // that returns normally — a normal return commits the row and permanently
    // poisons the event's dedupe key against its own legitimate redelivery.
    let applied: boolean;
    try {
      applied = await this.repository.runOnceForEvent(
        { id: deliveryId, type: event.type },
        async (tx) => {
          const order = await this.resolveOrder(tx, event);

          if (order === null) {
            throw new UnmatchedEventError();
          }

          await handler(tx, order);
        },
      );
    } catch (error) {
      if (error instanceof UnmatchedEventError) {
        // The dedupe row rolled back with the transaction, so a redelivery will
        // re-run.
        return { status: "unmatched", type: event.type };
      }
      throw error;
    }

    if (!applied) {
      this.logger.info(
        { deliveryId, eventType: event.type },
        "Duplicate Whop delivery ignored",
      );
      return { status: "duplicate", type: event.type };
    }

    return { status: "applied", type: event.type };
  }

  /**
   * A body whose SIGNATURE VERIFIED but whose shape we could not parse.
   *
   * This is the loudest thing that can happen without money moving: the bytes are
   * provably from Whop, and we do not understand them. It must never become a 400 —
   * a 4xx makes the vendor retry a payload we will keep failing on, producing a retry
   * storm on top of an outage. The correct outcome is ONE alert, one error log, and an
   * order visibly stuck in AWAITING_PAYMENT for an operator to find.
   *
   * "ONE alert" IS THE LOAD-BEARING WORD, and getting it wrong was a real defect. This
   * path used to open its own transaction and enqueue unconditionally, outside
   * `runOnceForEvent` entirely — so a single captured delivery, replayed, wrote a fresh
   * outbox row and paged an operator again on every POST, forever, with no dedupe and no
   * freshness check in front of it (the freshness window needs a PARSED timestamp, which
   * by definition this body does not have). An unbounded, un-deduped write reachable by
   * replay is exactly what §4.1 step 8 exists to forbid.
   *
   * The fix is to give the unparsable body an identity of its own: the SHA-256 of the
   * exact signed bytes. Identical bytes produce an identical key, so a replay collides on
   * the `provider_event` primary key and does nothing at all — the same mechanism, and
   * the same transaction boundary, that protects a parsable event. Distinct bytes still
   * alert, which is the behaviour that matters; producing them requires the signing
   * secret, since the digest is only ever computed on a body that already passed the
   * HMAC.
   *
   * The row is typed `webhook/unparsable` so the §7 audit query
   * (`SELECT derived, count(*) FROM provider_event GROUP BY derived`) can exclude it —
   * these rows are `derived: true` by construction and would otherwise be read as
   * evidence that the weak synthesised-id fallback is live on real events.
   *
   * The alert rides the transactional outbox like everything else, so it survives a
   * process restart.
   *
   * @param bodyDigest SHA-256 hex of the raw, verified request body.
   */
  async recordUnparsable(bodyDigest: string, issues: readonly string[]): Promise<void> {
    const applied = await this.repository.runOnceForEvent(
      {
        id: `${UNPARSABLE_EVENT_ID_PREFIX}${bodyDigest}`,
        type: UNPARSABLE_EVENT_TYPE,
      },
      async (tx) => {
        await tx.enqueue("notifications", {
          kind: "webhook-unparsable",
          provider: "WHOP",
          bodyDigest,
          issues: [...issues],
          detectedAt: new Date().toISOString(),
        });
      },
    );

    if (!applied) {
      // Deliberately `info`, not `error`. The first delivery already paged; a replay of
      // the same bytes is noise, and paging on it is how an alert channel gets muted.
      this.logger.info(
        { bodyDigest },
        "Replay of an already-reported unparsable Whop webhook body; no new alert",
      );
      return;
    }

    this.logger.error(
      { issues, bodyDigest },
      "Whop webhook signature verified but body failed schema validation",
    );
  }

  /**
   * Map a dot-format Whop event type to its handler.
   *
   * FOUR TYPES, DOWN FROM SEVEN. TagadaPay emitted a payment-scoped and an
   * order-scoped event for the same settlement (`payment/succeeded` AND
   * `order/paid`), which carried different ids, never collided in the dedupe
   * table, and had to be caught by `isRedundantTransition` instead. Whop emits
   * one `payment.succeeded` per settlement.
   *
   * `payment.authorized`, `payment.created` and `payment.pending` are
   * deliberately absent: an order settles on `succeeded` and nothing else. They
   * are ACKed and ignored, as is `dispute.*` — the `disputes` module is an empty
   * placeholder and this integration does not change that.
   */
  private resolveHandler(event: WhopEventEnvelope): EventHandler | null {
    if (!isHandledEventType(event.type)) {
      return null;
    }

    switch (event.type) {
      case "payment.succeeded":
        return async (tx, order) => {
          await this.applySettlement(tx, order, event);
        };

      case "payment.failed":
        return async (tx, order) => {
          await this.applyFailed(tx, order, event);
        };

      case "refund.created":
      case "refund.updated":
        return async (tx, order) => {
          await this.reconcileRefund(tx, order, event);
        };
    }
  }

  // -------------------------------------------------------------------------
  // Settlement
  // -------------------------------------------------------------------------

  private async applySettlement(
    tx: PaymentsWriter,
    order: OrderSnapshot,
    event: WhopEventEnvelope,
  ): Promise<void> {
    if (this.isOperatorHeld(order, event)) {
      return;
    }

    const verdict = verifySettlement(event, order);

    if (!verdict.settle) {
      await this.applyMismatch(tx, order, event, verdict.reason);
      return;
    }

    await this.applyPaid(tx, order, event, verdict.amount, verdict.currency);
  }

  private async applyPaid(
    tx: PaymentsWriter,
    order: OrderSnapshot,
    event: WhopEventEnvelope,
    amount: Minor,
    currency: CurrencyCode,
  ): Promise<void> {
    // `payment/succeeded` and `order/paid` both describe the same settlement and carry
    // DIFFERENT event ids, so the dedupe table does not collapse them — the second must
    // be recognised as redundant here rather than throwing PAID -> PAID. This is also
    // what stops a late success event walking an order out of PAYMENT_MISMATCH: that
    // pair is redundant by construction in `isRedundantTransition`.
    if (isRedundantTransition(order.status, "PAID")) {
      this.logger.info(
        { orderNumber: order.orderNumber, status: order.status },
        "Paid event ignored; order already settled or awaiting operator resolution",
      );
      return;
    }

    this.orderState.assertTransition(order.status, "PAID");

    await this.recordSettlementPayment(tx, order, event, "SUCCEEDED", amount, currency);

    // The six steps every paid order gets, wherever the settlement came from.
    // Shared with the payments-disabled checkout so a demo order is identical to
    // a real one — same stock movement, same emails, same invoice trigger.
    await settleOrderPaid(tx, order, {
      occurredAt: this.eventTime(event),
      timelineMessage: `Payment confirmed for ${amount} ${currency}`,
    });
  }

  /**
   * Whop says money moved, but not the money we asked for.
   *
   * All of it or none of it, inside the dedupe transaction.
   *
   * WHAT THIS DELIBERATELY DOES NOT DO, and the non-obvious half first:
   *
   *   - It does NOT release the stock reservations. Money may very well have moved — the
   *     event says a payment SUCCEEDED — so handing the stock back would let the same
   *     units be sold twice while a paid-for order is still open. STOCK STAYS RESERVED
   *     AND HELD until an operator resolves the order. That is the opposite of what
   *     `applyFailed` does, and it is intentional.
   *   - It does NOT commit the reservations either. Nothing has been sold at a price we
   *     agreed to.
   *   - It does NOT mark the order paid.
   *   - It enqueues nothing customer-facing and nothing gap-free-numbered: no
   *     confirmation, no receipt, no invoice, no fulfilment. An unreconciled payment must
   *     not produce an invoice number.
   *
   * What it DOES do is make the discrepancy impossible to miss: the order stops in a
   * dedicated state, the ledger records BOTH figures, the customer-visible timeline says
   * what happened, and an operator is paged.
   */
  private async applyMismatch(
    tx: PaymentsWriter,
    order: OrderSnapshot,
    event: WhopEventEnvelope,
    reason: MismatchReason,
  ): Promise<void> {
    if (isRedundantTransition(order.status, "PAYMENT_MISMATCH")) {
      this.logger.warn(
        { orderNumber: order.orderNumber, status: order.status, reason },
        "Payment mismatch event ignored; order already in that state or settled",
      );
      return;
    }

    this.orderState.assertTransition(order.status, "PAYMENT_MISMATCH");

    // The provider's OWN figures, in the provider's own unit, exactly as
    // delivered. This is the evidence an operator reconciles against, so it is
    // deliberately NOT normalised into our minor units — a conversion here would
    // hide the very discrepancy the row exists to record.
    const reportedAmount = event.data.total ?? null;
    const reportedCurrency = event.data.currency?.toUpperCase() ?? null;

    // The ledger must show what Whop says AND what we say. Recorded with the REPORTED
    // amount, not ours — an operator reconciling this needs the provider's figure.
    if (reportedAmount !== null && reportedCurrency !== null) {
      const parsedCurrency = currencyCodeSchema.safeParse(reportedCurrency);

      // A currency we recognise but an amount we cannot read exactly are
      // different failures. Both end here, and neither may write a ledger row
      // carrying a number we invented.
      const asMinor = tryFromDecimal(reportedAmount, parsedCurrency.success ? parsedCurrency.data : null);

      if (parsedCurrency.success && asMinor !== null) {
        await this.recordSettlementPayment(
          tx,
          order,
          event,
          "SUCCEEDED",
          asMinor,
          parsedCurrency.data,
        );
      }
      // A currency we do not recognise at all cannot be written to a typed column. The
      // order event and the alert below carry the raw strings verbatim, which is what an
      // operator actually reads.
    }

    await tx.setOrderStatus(order.id, "PAYMENT_MISMATCH");

    await tx.appendOrderEvent({
      orderId: order.id,
      type: "payment.mismatch",
      message:
        `Whop reported ${reportedAmount ?? "no amount"} ${reportedCurrency ?? ""}`.trim() +
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
      providerPaymentId: event.data.id ?? null,
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

  // -------------------------------------------------------------------------
  // Failure
  // -------------------------------------------------------------------------

  private async applyFailed(
    tx: PaymentsWriter,
    order: OrderSnapshot,
    event: WhopEventEnvelope,
  ): Promise<void> {
    // FIRST, before the redundancy guard and before any write: an order on operator hold
    // is off limits to this handler entirely. `isRedundantTransition` does NOT cover the
    // PAYMENT_MISMATCH -> FAILED edge, and the release below is the one that hurts.
    if (this.isOperatorHeld(order, event)) {
      return;
    }

    // The redundancy guard runs BEFORE any ledger write. A late, out-of-order
    // `payment/failed` for an order that is already PAID (or beyond) carries a DISTINCT
    // event id, so the dedupe table does not collapse it; if the ledger were mutated
    // first, it would stamp the settled payment row FAILED with `capturedAt: null` —
    // wiping the settlement record — and only THEN return early, leaving the order PAID
    // while its payment row says FAILED. Deciding redundancy first keeps the ledger and
    // the order status in agreement: a stale failure touches neither.
    if (isRedundantTransition(order.status, "FAILED")) {
      this.logger.info(
        { orderNumber: order.orderNumber, status: order.status },
        "Failure event ignored; order already settled",
      );
      return;
    }

    if (event.data.id !== undefined) {
      await tx.updatePaymentByProviderId({
        providerPaymentId: event.data.id,
        orderId: order.id,
        status: "FAILED",
        providerTransactionId: null,
        cardBrand: null,
        cardLast4: null,
        failureCode: event.data.decline_code ?? null,
        failureMessage: event.data.failure_message ?? null,
        capturedAt: null,
      });
    }

    this.orderState.assertTransition(order.status, "FAILED");
    await tx.setOrderStatus(order.id, "FAILED");

    // The payment failed, so the stock this order was holding returns to the shelf in the
    // same transaction — otherwise an abandoned failed checkout withholds inventory until
    // the TTL cron eventually reaps it. Contrast `applyMismatch`, where money may have
    // moved and the stock must stay held.
    await tx.releaseReservationsForOrder(order.id);

    const message = event.data.failure_message ?? "Payment failed";

    await tx.appendOrderEvent({
      orderId: order.id,
      type: "payment.failed",
      message:
        event.data.decline_code == null ? message : `${event.data.decline_code}: ${message}`,
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
  // Refunds
  // -------------------------------------------------------------------------

  /**
   * Converge our refunded total with Whop's.
   *
   * `payment/refunded` fires for refunds WE issued (already recorded by PaymentsService)
   * and for refunds an operator issued directly in the Whop dashboard. Rather than
   * trying to tell them apart, this compares the totals and records only the DIFFERENCE —
   * which makes the handler idempotent and commutative, exactly what out-of-order
   * delivery demands, and exactly why the derived-event-id fallback in
   * `provider-event-id.ts` is survivable.
   */
  private async reconcileRefund(
    tx: PaymentsWriter,
    order: OrderSnapshot,
    event: WhopEventEnvelope,
  ): Promise<void> {
    // Same hold as `applyFailed` and `applySettlement`, and for the same reason: reaching
    // REFUNDED or PARTIALLY_REFUNDED is a resolution of the discrepancy, and resolving it
    // is an operator's decision. Refusing here means the refunded total is not converged
    // while the hold stands — which is the conservative direction, because the operator is
    // already looking at this order and the next refund event reports Whop's CUMULATIVE
    // total, so nothing is lost once the hold is lifted.
    if (this.isOperatorHeld(order, event)) {
      return;
    }

    if (event.data.refunded_amount == null) {
      this.logger.warn(
        { orderNumber: order.orderNumber, eventType: event.type },
        "Refund event carried no refundedAmount; nothing to reconcile",
      );
      return;
    }

    const refundedAtProvider = tryFromDecimal(event.data.refunded_amount, order.currency);

    if (refundedAtProvider === null) {
      // A cumulative total we cannot read exactly must not become a ledger
      // delta. Converging against a rounded figure would either under-record a
      // refund the customer received or over-record one they did not.
      this.logger.error(
        {
          orderNumber: order.orderNumber,
          eventType: event.type,
          reported: event.data.refunded_amount,
        },
        "Refund event reported an unreadable refunded_amount; nothing reconciled",
      );
      return;
    }

    if (refundedAtProvider <= order.refundedTotal) {
      // We already know about at least this much. Nothing to do.
      return;
    }

    const delta = subtract(refundedAtProvider, order.refundedTotal);

    await tx.addRefundedTotal(order.id, delta);

    const payment =
      event.data.id === undefined
        ? await tx.findRefundablePaymentForOrder(order.id)
        : await tx.findPaymentByProviderId(event.data.id);

    if (payment !== null) {
      await tx.recordRefund({
        paymentId: payment.id,
        orderId: order.id,
        amount: delta,
        currency: order.currency,
        reason: "OTHER",
        status: "SUCCEEDED",
        providerRefundId: null,
        note: "Recorded from a Whop refund event (issued outside the API)",
        actorId: null,
      });
    }

    const target = refundedAtProvider >= order.grandTotal ? "REFUNDED" : "PARTIALLY_REFUNDED";

    if (!isRedundantTransition(order.status, target)) {
      this.orderState.assertTransition(order.status, target);
      await tx.setOrderStatus(order.id, target);
    }

    await tx.appendOrderEvent({
      orderId: order.id,
      type: "refund.reconciled",
      message: `Refund of ${delta} ${order.currency} recorded from Whop`,
      isInternal: true,
    });

    await tx.enqueue("email", {
      templateKey: "refund-confirmation",
      orderId: order.id,
      orderNumber: order.orderNumber,
      locale: order.locale,
      recipient: order.email,
      amount: delta,
      currency: order.currency,
    });
  }

  // -------------------------------------------------------------------------
  // Correlation
  // -------------------------------------------------------------------------

  /**
   * Find our order for an inbound Whop event.
   *
   * TWO KEYS, tried in a fixed order, first hit wins:
   *
   *   1. `metadata.order_id` — OUR order UUID, round-tripped. Whop copies a
   *      checkout configuration's metadata onto the payments created from it, so
   *      this is present on anything that originated from our checkout and is
   *      independent of every identifier Whop mints.
   *   2. `checkout_configuration_id` — persisted before the customer ever
   *      reaches the payment page, so it cannot lose a race with the webhook.
   *
   * THE TAGADAPAY THIRD RANK AND ITS BACKFILL RULE ARE GONE. There, nothing in
   * the SDK types proved a webhook body carried ANY of our keys, so the design
   * sent three, needed one to survive, and backfilled the provider's own order
   * id on first contact so later payment-scoped events could still find us. Whop
   * documents the metadata round-trip, so rank 1 is always there when the
   * payment came from a checkout we opened.
   */
  private async resolveOrder(
    tx: PaymentsWriter,
    event: WhopEventEnvelope,
  ): Promise<OrderSnapshot | null> {
    for (const reference of correlationKeys(event)) {
      const order = await tx.findOrderByProviderReference(reference);
      if (order !== null) {
        return order;
      }
    }

    // Not an error and not a 4xx. Whop delivers everything the endpoint is
    // subscribed to, including payments we did not originate; a non-2xx would
    // put those into a 12-attempt, 71-hour retry loop and eventually get the
    // endpoint disabled.
    this.logger.warn(
      {
        eventType: event.type,
        orderId: event.data.metadata?.order_id ?? null,
        checkoutId: event.data.checkout_configuration_id ?? null,
      },
      "Whop event could not be matched to an order",
    );

    return null;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * PAYMENT_MISMATCH IS AN OPERATOR-ONLY HOLD. NO AUTOMATED HANDLER MAY LEAVE IT.
   *
   * A webhook may put an order INTO PAYMENT_MISMATCH; only a human may take it out
   * (contract §6.3). Every handler on this class asks this question first, and the answer
   * is the same for all of them, which is why it is one predicate and not three copies.
   *
   * WHY IT CANNOT LIVE IN `isRedundantTransition`, which is where the enforcement for the
   * PAID edge sits. That function is shared with `PaymentsService.refundOrder` — the
   * OPERATOR-driven path. Generalising its `target === "PAID" && current ===
   * "PAYMENT_MISMATCH"` clause to "any target" would silently stop an operator's own
   * refund of a held order from moving its status, which is the exact action the hold
   * exists to enable. "Legal" and "legal for a webhook to do" are different questions;
   * `isRedundantTransition` answers the first, this answers the second, and only the
   * webhook plane asks it.
   *
   * WHAT WAS ACTUALLY BROKEN, because the gap was not theoretical. `ORDER_STATUS_TRANSITIONS`
   * legalises PAYMENT_MISMATCH -> FAILED / REFUNDED / PARTIALLY_REFUNDED / CANCELLED, and
   * `isRedundantTransition` blocked only the PAID edge. So an ordinary vendor retry — a
   * `payment/failed`, `payment/rejected` or `order/failed` landing after the mismatch —
   * passed both gates, set the order FAILED, and called `releaseReservationsForOrder`.
   * That is the precise inverse of `applyMismatch`'s documented invariant: money may well
   * have moved, so the stock STAYS RESERVED AND HELD. One later failure event erased the
   * flag, dropped the hold, and emailed the customer "payment failed" for an order the
   * provider may have charged.
   *
   * The event is still ACKed and its dedupe row still commits: it was genuinely delivered
   * and genuinely seen, and rolling back would only make Whop redeliver something we
   * will keep refusing. `warn`, not an alert — `applyMismatch` already paged when the hold
   * was placed, and paging again per retry is how an alert channel gets muted.
   */
  private isOperatorHeld(order: OrderSnapshot, event: WhopEventEnvelope): boolean {
    if (order.status !== "PAYMENT_MISMATCH") {
      return false;
    }

    this.logger.warn(
      { orderNumber: order.orderNumber, eventType: event.type },
      "Event ignored; order is in PAYMENT_MISMATCH and only an operator may resolve it",
    );

    return true;
  }

  /**
   * Write the settlement row into the payment ledger.
   *
   * `startCheckout` records the attempt before a Whop payment id exists, so the row it
   * created has `providerPaymentId: null` and cannot be found by provider id. This writes
   * the settlement row keyed on that id — the one identifier every later Whop event
   * carries — as a single INSERT-OR-UPDATE. See `upsertSettlementPayment` on the port for
   * why the atomicity is the requirement rather than an optimisation.
   *
   * Without a `paymentId` there is nothing to key a row on; the order event and (on
   * mismatch) the alert carry the record instead. A payment row with a null provider id
   * cannot be reconciled against Whop later, so writing one would be worse than not.
   */
  private async recordSettlementPayment(
    tx: PaymentsWriter,
    order: OrderSnapshot,
    event: WhopEventEnvelope,
    status: "SUCCEEDED",
    amount: Minor,
    currency: CurrencyCode,
  ): Promise<void> {
    const providerPaymentId = event.data.id;

    if (providerPaymentId === undefined) {
      this.logger.warn(
        { orderNumber: order.orderNumber, eventType: event.type },
        "Settlement event carried no paymentId; no payment row written",
      );
      return;
    }

    // ONE statement, insert-or-update. This used to be
    // `findPaymentByProviderId` -> (null) -> `recordPaymentAttempt` -> update, and that
    // check-then-insert was not atomic: two deliveries for the SAME settlement can
    // be in flight at once — Whop retries up to 12 times and guarantees no
    // ordering — both carrying the same payment id, so both read null and both
    // inserted. The loser hit P2002 on
    // `payment.providerPaymentId`, and because `runOnceForEvent` maps only
    // ProviderEvent unique violations to "duplicate" — by design, so that a genuine
    // duplicate-refund P2002 is not swallowed — it escaped as a 500 on a delivery whose
    // signature was perfectly valid. A 5xx here is the retry storm the controller's own
    // contract forbids.
    await tx.upsertSettlementPayment({
      orderId: order.id,
      amount,
      currency,
      status,
      providerPaymentId,
      // Whop's webhook payload nests card details under `payment_instrument`,
      // which this schema does not declare and no handler reads. Recording a
      // brand and last4 we did not parse would be asserting them.
      cardBrand: null,
      cardLast4: null,
      capturedAt: this.eventTime(event),
    });
  }

  /**
   * When the event says it happened.
   *
   * Falls back to "now" only when the payload carries no timestamp at all — which the SDK
   * cannot rule out (§0 E7). A settlement time of "now" is off by at most the delivery
   * latency, whereas refusing the event entirely would strand a genuinely paid order.
   */
  private eventTime(event: WhopEventEnvelope): Date {
    const stamp = event.data.paid_at ?? event.timestamp ?? event.data.created_at;

    if (stamp == null) {
      return new Date();
    }

    const parsed = new Date(stamp);

    // The schema bounds these as short strings but does not prove they are
    // dates. An unparseable stamp becomes "now", which is off by at most the
    // delivery latency, rather than an Invalid Date written into the ledger.
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }
}
