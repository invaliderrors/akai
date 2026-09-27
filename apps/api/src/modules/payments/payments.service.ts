import { Inject, Injectable } from "@nestjs/common";
import type { ServerEnv } from "@akai/config";
import type { Minor, OrderStatus } from "@akai/contracts";
import { storefrontUrl } from "@akai/i18n";
import { settleOrderPaid } from "./order-settlement";
import { add, subtract, sum, toDecimalString, ZERO } from "@akai/money";
import type { Logger } from "@akai/observability";
import { createHash } from "node:crypto";

import { SERVER_CONFIG } from "../config/config.module";
import { LOGGER } from "../observability/logger.module";
import type { RefundRequest, RefundResponse, StartCheckoutResponse } from "./dto/payments.dto";
import {
  ORDER_STATE_PORT,
  isRedundantTransition,
  type OrderStatePort,
} from "./order-state.port";
import {
  CheckoutTotalMismatchError,
  CheckoutUrlMissingError,
  NoRefundablePaymentError,
  OrderNotFoundError,
  OrderNotPayableError,
  OrderNotRefundableError,
  RefundAmountInvalidError,
  RefundExceedsRefundableError,
} from "./payments.errors";
import {
  PAYMENTS_REPOSITORY,
  type OrderLineSnapshot,
  type OrderSnapshot,
  type PaymentsRepository,
} from "./repository/payments.repository";
import {
  WHOP_GATEWAY,
  type WhopCheckoutParams,
  type WhopGateway,
} from "./whop/whop.gateway";

/**
 * The storefront route a customer returns to from the hosted payment page.
 *
 * LOCALE-FREE ON PURPOSE — `storefrontUrl` adds the prefix the storefront's own
 * routing rule calls for. Hard-coding one here is what produced the original
 * defect: a single path served to Spanish and English buyers alike.
 *
 * The page itself is `apps/storefront/src/app/[locale]/checkout/processing`. It
 * polls `GET payments/orders/:orderNumber/status`; it does not assert success.
 */
const CHECKOUT_PROCESSING_PATH = "/checkout/processing";

/** Orders in these states may still open a hosted checkout session. */
const PAYABLE_STATUSES: readonly OrderStatus[] = ["PENDING", "AWAITING_PAYMENT"];

/**
 * Orders in these states have money that can be given back.
 *
 * PAYMENT_MISMATCH IS HERE ON PURPOSE, and it is the interesting entry. The
 * provider reported a settlement we refused to accept, so money may well have
 * moved — refunding it is the most likely way an operator resolves the order,
 * and the state machine is explicitly non-terminal to allow exactly that.
 *
 * Admitting it was only safe once `ORDER_STATUS_TRANSITIONS` gained
 * `PAYMENT_MISMATCH -> PARTIALLY_REFUNDED`. While only the full-refund edge
 * existed, a partial refund from this state would have called the gateway
 * successfully and THEN thrown `IllegalOrderTransitionError`, rolling our
 * transaction back after the provider had already moved the money: a refund at the
 * provider with no ledger row on our side. The two changes belong together and
 * must not be separated.
 */
const REFUNDABLE_STATUSES: readonly OrderStatus[] = [
  "PAID",
  "FULFILLING",
  "SHIPPED",
  "DELIVERED",
  "PARTIALLY_REFUNDED",
  "PAYMENT_MISMATCH",
];

/**
 * States in which the money is confirmed to have reached us.
 *
 * An ALLOWLIST, not "everything that is not pending". The previous formulation
 * — `!PAYABLE.includes(status) && status !== "FAILED"` — was correct only for
 * as long as every non-payable, non-failed state meant "paid". `PAYMENT_MISMATCH`
 * breaks that: it is neither payable nor failed, and reporting it as paid would
 * tell a customer their order settled when the provider reported an amount we
 * refused to accept. A new order status must now be added here deliberately
 * rather than acquiring `isPaid: true` by omission.
 */
const SETTLED_STATUSES: readonly OrderStatus[] = [
  "PAID",
  "FULFILLING",
  "SHIPPED",
  "DELIVERED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
];

/**
 * States in which polling has nothing left to learn.
 *
 * NOTE THE TWO DIFFERENT SENSES OF "TERMINAL". In the ORDER STATE MACHINE
 * (`ORDER_STATUS_TRANSITIONS`), `PAYMENT_MISMATCH` is explicitly non-terminal —
 * an operator may still move it to PAID, REFUNDED, CANCELLED or FAILED. In THIS
 * list the question is different: "will this value change on its own if the
 * browser keeps asking?" For `PAYMENT_MISMATCH` the answer is no — by design,
 * only a human can move it — so the processing screen must stop polling and say
 * so, rather than spin until the tab is closed. `isPaid` is false there, so the
 * pair reads as "payment did not complete; contact support", which is exactly
 * what has happened.
 */
const POLL_TERMINAL_STATUSES: readonly OrderStatus[] = [
  "CANCELLED",
  "REFUNDED",
  "FAILED",
  "DELIVERED",
  "PAYMENT_MISMATCH",
];

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(PAYMENTS_REPOSITORY) private readonly repository: PaymentsRepository,
    @Inject(WHOP_GATEWAY) private readonly whop: WhopGateway,
    @Inject(ORDER_STATE_PORT) private readonly orderState: OrderStatePort,
    @Inject(SERVER_CONFIG) private readonly config: ServerEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  // -------------------------------------------------------------------------
  // Checkout
  // -------------------------------------------------------------------------

  /**
   * Open a Whop-hosted checkout for an existing order.
   *
   * THE ONLY INPUT IS AN ORDER ID. There is no code path by which a
   * caller-supplied figure can influence what is charged: the amount sent to
   * Whop is `order.grandTotal`, recomputed and re-checked here.
   *
   * OUR API IS THE SOURCE OF TRUTH FOR PRICE, IN THE STRONG SENSE. TagadaPay
   * accepted `{ variantId, quantity }` and no amount of any kind, which made a
   * mirrored catalog the only channel through which a price could reach the
   * hosted page — so an unmirrored variant could not be sold, a drifted mirror
   * silently charged the wrong figure, and a discount could not be expressed at
   * all. Whop takes the number. Nothing is mirrored, nothing can drift, and a
   * discounted order is simply a smaller `initialPrice`.
   */
  async startCheckout(orderId: string): Promise<StartCheckoutResponse> {
    const order = await this.repository.findOrderById(orderId);
    if (order === null) {
      throw new OrderNotFoundError(orderId);
    }

    if (!PAYABLE_STATUSES.includes(order.status)) {
      throw new OrderNotPayableError(order.status, order.orderNumber);
    }

    // DEMO MODE. Settled locally, before anything provider-shaped is touched.
    //
    // It returns the SAME processing URL the provider would have returned the
    // customer to, so the storefront flow is byte-identical: redirect, poll,
    // confirmation. Nothing in the browser knows the difference, which is the
    // point — what is being demonstrated has to be the real flow.
    if (!this.config.PAYMENTS_ENABLED) {
      return this.settleWithoutProvider(order);
    }

    const lines = await this.repository.findOrderLines(order.id);

    // THE LOCAL INVARIANT, AND IT MEANS WHAT IT ORIGINALLY MEANT AGAIN. Under
    // TagadaPay this could only prove our own row was self-consistent, because
    // the provider priced from its own catalog and nothing here could predict
    // what it would charge. We set the price now, so this check once more
    // predicts exactly what the customer will be charged: if the lines do not
    // sum to the stored grand total, the number we are about to send is wrong.
    const chargedTotal = this.chargedTotal(order, lines);
    if (chargedTotal !== order.grandTotal) {
      throw new CheckoutTotalMismatchError(
        chargedTotal,
        order.grandTotal,
        order.orderNumber,
      );
    }

    const params: WhopCheckoutParams = {
      accountId: this.config.whop.accountId,
      productId: this.config.whop.productId,
      // THE MONEY BOUNDARY, and the only place it is crossed on the way out.
      // Whop prices in MAJOR units; our ledger is integer minor units.
      // `toDecimalString` is integer/string arithmetic, so no float ever
      // touches the figure — `grandTotal / 100` is the defect this avoids.
      initialPrice: Number(toDecimalString(order.grandTotal, order.currency)),
      // Whop's currency enum is LOWERCASE; `CurrencyCode` is upper.
      currency: order.currency.toLowerCase(),
      title: `Order ${order.orderNumber}`,
      // Correlation. Whop copies a checkout configuration's metadata onto the
      // payments created from it, so `order_id` is our own UUID round-tripped
      // and comes back on the settlement webhook.
      metadata: { order_id: order.id, order_number: order.orderNumber },
      // The browser returns to a PROCESSING screen that polls for status. It is
      // deliberately not a success page: an order becomes PAID only via a
      // verified webhook, and a client-side success redirect is forged in ten
      // seconds.
      //
      // LOCALE-CORRECT, and built by the shared routing rule rather than by a
      // template literal here. Every storefront route is locale-scoped, so an
      // English order returning to the Spanish-default path would land a paying
      // customer on a page in the wrong language.
      redirectUrl: storefrontUrl(
        this.config.STOREFRONT_URL,
        order.locale,
        CHECKOUT_PROCESSING_PATH,
        { order: order.orderNumber },
      ),
    };

    const checkout = await this.whop.createCheckoutConfiguration(params, {
      // Derived from the order AND its total: a retry of the same attempt
      // reuses the configuration, but an order whose total legitimately changed
      // gets a fresh one instead of silently reusing a checkout for the old
      // amount.
      idempotencyKey: this.idempotencyKey("checkout", order.id, order.grandTotal),
    });

    // `purchase_url` is typed nullable on the create response, so this is a real
    // production outcome rather than a defensive nicety. Moving the order to
    // AWAITING_PAYMENT with nowhere for the customer to pay would strand it
    // there: no payment page, no return, no webhook.
    if (checkout.purchaseUrl === null) {
      throw new CheckoutUrlMissingError(order.orderNumber);
    }

    const purchaseUrl = checkout.purchaseUrl;

    await this.repository.runInTransaction(async (tx) => {
      await tx.linkCheckoutId(order.id, checkout.checkoutId);

      await tx.recordPaymentAttempt({
        orderId: order.id,
        amount: order.grandTotal,
        currency: order.currency,
        status: "REQUIRES_PAYMENT_METHOD",
        // No payment exists yet. Whop mints its payment id when the customer
        // submits the hosted form; the webhook backfills it.
        providerPaymentId: null,
      });

      if (!isRedundantTransition(order.status, "AWAITING_PAYMENT")) {
        this.orderState.assertTransition(order.status, "AWAITING_PAYMENT");
        await tx.setOrderStatus(order.id, "AWAITING_PAYMENT");
      }

      await tx.appendOrderEvent({
        orderId: order.id,
        type: "checkout.session.created",
        message: `Whop checkout ${checkout.checkoutId} opened for ${order.grandTotal} ${order.currency}`,
        isInternal: true,
      });
    });

    this.logger.info(
      { orderNumber: order.orderNumber, checkoutId: checkout.checkoutId },
      "Checkout session created",
    );

    return { orderNumber: order.orderNumber, checkoutUrl: purchaseUrl };
  }

  // -------------------------------------------------------------------------
  // Refunds
  // -------------------------------------------------------------------------

  /**
   * Refund all or part of an order.
   *
   * The caller may PROPOSE an amount (a partial refund is a legitimate operator
   * decision) but the ceiling is computed here from the order row:
   * `grandTotal - refundedTotal`. Anything above it is rejected. Omitting the
   * amount refunds the whole remaining balance.
   *
   * ORDERING NOTE — deliberate, not accidental. The provider is called BEFORE
   * the database transaction, because a network call must never be held inside
   * an open transaction (it would pin a connection for the duration of a
   * third-party outage). The exposure this creates — the refund succeeds, our
   * commit fails — is bounded three ways: the `idempotencyKey` makes a retry a
   * no-op rather than a second refund, the `refundedTotal <= grandTotal` CHECK
   * constraint makes an over-refund unrepresentable in the database, and the
   * nightly reconciliation job alerts on any divergence it still finds.
   *
   * ONE THING GOT STRICTLY BETTER HERE. The Stripe path had to coarsen our
   * refund vocabulary — WITHDRAWAL_RIGHT and DAMAGED both collapsed to
   * `requested_by_customer` — because Stripe accepts only three reasons.
   * `PaymentRefundParams` has no `reason` field at all but does have
   * `metadata`, so the full `RefundReason` vocabulary now travels intact and
   * the lossy mapping table is gone.
   */
  async refundOrder(
    orderId: string,
    request: RefundRequest,
    actorId: string | null,
  ): Promise<RefundResponse> {
    const order = await this.repository.findOrderById(orderId);
    if (order === null) {
      throw new OrderNotFoundError(orderId);
    }

    if (!REFUNDABLE_STATUSES.includes(order.status)) {
      throw new OrderNotRefundableError(order.status, order.orderNumber);
    }

    const payment = await this.repository.findRefundablePaymentForOrder(order.id);
    if (payment === null || payment.providerPaymentId === null) {
      throw new NoRefundablePaymentError(order.orderNumber);
    }

    const providerPaymentId = payment.providerPaymentId;

    const refundable = subtract(order.grandTotal, order.refundedTotal);
    const requested: Minor = request.amount ?? refundable;

    if (requested <= 0) {
      throw new RefundAmountInvalidError(requested);
    }

    if (requested > refundable) {
      throw new RefundExceedsRefundableError(requested, refundable);
    }

    await this.whop.refundPayment(
      {
        paymentId: providerPaymentId,
        // MAJOR units, through the same integer/string encoder checkout uses.
        // The ceiling was recomputed above from the order row, so this figure is
        // ours and never the caller's.
        partialAmount: Number(toDecimalString(requested, order.currency)),
      },
      {
        // Includes the balance BEFORE this refund, so two deliberate identical
        // partial refunds get different keys (both go through, correctly) while
        // a retry of the same one collapses to a single refund.
        idempotencyKey: this.idempotencyKey(
          "refund",
          order.id,
          order.refundedTotal,
          requested,
        ),
      },
    );

    const refundedAfter = add(order.refundedTotal, requested);
    const targetStatus: OrderStatus =
      refundedAfter >= order.grandTotal ? "REFUNDED" : "PARTIALLY_REFUNDED";

    await this.repository.runInTransaction(async (tx) => {
      // Re-read under the transaction. A refund that raced with another one
      // must not be sized against a stale balance.
      const fresh = await tx.findOrderById(order.id);
      if (fresh === null) {
        throw new OrderNotFoundError(order.id);
      }

      const freshRefundable = subtract(fresh.grandTotal, fresh.refundedTotal);
      if (requested > freshRefundable) {
        throw new RefundExceedsRefundableError(requested, freshRefundable);
      }

      await tx.recordRefund({
        paymentId: payment.id,
        orderId: order.id,
        amount: requested,
        currency: order.currency,
        reason: request.reason,
        status: "SUCCEEDED",
        // ALWAYS NULL HERE, and that is a property of Whop's API rather than a
        // shortcut. `payments.refund` returns the full `Payment`, which carries
        // `refunded_amount` and `refunded_at` but NO refunds array — the array
        // belongs to the webhook shape. So the refund id is not available
        // synchronously, and the two ways to fake it are both worse: a
        // follow-up `refunds.list` is a second network call in the window
        // between the provider call and our transaction AND races the row
        // materialising, while writing our own refund row id into a column
        // named for the provider's would be a lie an operator reconciles
        // against. `refund.created` carries the real id for reconciliation.
        providerRefundId: null,
        note: request.note ?? null,
        actorId,
      });

      await tx.addRefundedTotal(order.id, requested);

      if (!isRedundantTransition(fresh.status, targetStatus)) {
        this.orderState.assertTransition(fresh.status, targetStatus);
        await tx.setOrderStatus(order.id, targetStatus);
      }

      await tx.appendOrderEvent({
        orderId: order.id,
        type: "refund.succeeded",
        message: `Refunded ${requested} ${order.currency} (${request.reason})`,
        isInternal: false,
      });

      // Both the customer email and any restocking are queued, never done
      // inline — spec §10 requires email idempotent per (orderId, templateKey)
      // and driven by pg-boss with retry/backoff.
      await tx.enqueue("email", {
        templateKey: "refund-confirmation",
        orderId: order.id,
        orderNumber: order.orderNumber,
        locale: order.locale,
        recipient: order.email,
        amount: requested,
        currency: order.currency,
      });

      // NOT ENQUEUED: `order-fulfilment` / restock.
      //
      // `fulfilment` is an empty module, so this topic has no handler and the
      // dispatcher dead-letters it. The restock therefore NEVER HAPPENED — it
      // failed silently in a queue instead of failing visibly here, which is the
      // worse of the two. Removing the producer does not change the outcome; it
      // stops the outcome being disguised as work in progress.
      //
      // WHEN A HANDLER LANDS, RESTORE THIS IN THE SAME CHANGE — and give it an
      // idempotency key: an outbox re-delivery of a restock is a DOUBLE stock
      // increment, which is the one failure mode a naive handler will have.
      //
      //   if (request.restockVariantIds.length > 0) {
      //     await tx.enqueue("order-fulfilment", {
      //       action: "restock", orderId: order.id,
      //       variantIds: [...request.restockVariantIds],
      //     });
      //   }
    });

    this.logger.info(
      { orderNumber: order.orderNumber, amount: requested },
      "Refund issued",
    );

    return {
      refundId: null,
      orderNumber: order.orderNumber,
      amount: requested,
      currency: order.currency,
      reason: request.reason,
      remainingRefundable: subtract(order.grandTotal, refundedAfter),
    };
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /**
   * Backs the "processing" screen the browser lands on after the hosted
   * checkout. Polling this is what replaces trusting a success redirect.
   */
  async getOrderPaymentStatus(orderNumber: string): Promise<{
    orderNumber: string;
    status: OrderStatus;
    isPaid: boolean;
    isTerminal: boolean;
  }> {
    const order = await this.repository.findOrderByNumber(orderNumber);
    if (order === null) {
      throw new OrderNotFoundError(orderNumber);
    }

    return {
      orderNumber: order.orderNumber,
      status: order.status,
      isPaid: SETTLED_STATUSES.includes(order.status),
      isTerminal: POLL_TERMINAL_STATUSES.includes(order.status),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Completes an order with no payment provider in the loop.
   *
   * IT REUSES THE SETTLEMENT THE WEBHOOK USES. Same stock commit, same timeline
   * entry, same confirmation and receipt emails, same invoice and fulfilment
   * triggers — a demo order is a real order that nobody was charged for. A
   * parallel "just mark it paid" would show the owner a flow that does not exist.
   *
   * The transition is asserted rather than assumed: `PAYABLE_STATUSES` has
   * already been checked, so this is belt-and-braces against a future status
   * being added to that list without the state machine agreeing.
   *
   * NO PAYMENT ROW IS WRITTEN. Nothing settled, so the ledger must not claim a
   * payment exists — the order's own timeline says why it is paid.
   */
  private async settleWithoutProvider(order: OrderSnapshot): Promise<StartCheckoutResponse> {
    await this.repository.runInTransaction(async (tx) => {
      // THE SAME TWO STEPS THE REAL FLOW TAKES. Opening a provider session moves
      // the order to AWAITING_PAYMENT and the webhook then settles it; the state
      // machine has no PENDING -> PAID edge, deliberately, because an order that
      // was never payable must not become paid. Demo mode walks the same path
      // rather than widening the machine to accommodate itself.
      if (!isRedundantTransition(order.status, "AWAITING_PAYMENT")) {
        this.orderState.assertTransition(order.status, "AWAITING_PAYMENT");
        await tx.setOrderStatus(order.id, "AWAITING_PAYMENT");
      }

      // `order` is the snapshot read before the transition, so the settlement is
      // asserted against the status it will actually be in.
      this.orderState.assertTransition("AWAITING_PAYMENT", "PAID");

      await settleOrderPaid(tx, { ...order, status: "AWAITING_PAYMENT" }, {
        occurredAt: new Date(),
        timelineMessage: "Order completed with payments disabled — no charge was taken",
      });
    });

    this.logger.warn(
      { orderNumber: order.orderNumber, grandTotal: order.grandTotal },
      "PAYMENTS_ENABLED=false — order settled locally without taking payment",
    );

    return {
      orderNumber: order.orderNumber,
      checkoutUrl: storefrontUrl(
        this.config.STOREFRONT_URL,
        order.locale,
        CHECKOUT_PROCESSING_PATH,
        { order: order.orderNumber },
      ),
    };
  }

  /**
   * What our own row says the order comes to, recomputed from the same lines we
   * are about to send. Compared against the stored grand total so an internal
   * inconsistency surfaces BEFORE a customer is handed to a payment page.
   */
  private chargedTotal(
    order: OrderSnapshot,
    lines: readonly OrderLineSnapshot[],
  ): Minor {
    // THE GROSS IDENTITY, and deliberately the same one `assertTotalsBalance`
    // enforces in `orders/order-totals.ts` when the row is written. This has to
    // mirror it: that assertion is what the stored order was built to satisfy,
    // so any other arithmetic here rejects orders that are perfectly correct.
    //
    // Lines are stored GROSS and already net of their own discount, so
    // `lineTotalGross` is summed as-is — neither the line's tax nor
    // `order.discountTotal` may be applied a second time.
    const grossFromLines = sum(lines.map((line) => line.lineTotalGross));

    // SHIPPING IS THE ONE FIGURE STORED NET, while `grandTotal` carries it
    // gross, and `taxTotal` bundles line tax together with shipping tax. So the
    // shipping tax is whatever `taxTotal` still holds once the lines have
    // claimed their share. Omitting it silently under-counts every order with
    // taxed shipping, which is exactly the defect this replaced.
    const shippingTax = subtract(
      order.taxTotal,
      sum(lines.map((line) => line.taxAmount)),
    );

    return add(grossFromLines, add(order.shippingTotal, shippingTax));
  }

  /**
   * A deterministic `Idempotency-Key`, accepted on every mutating SDK call via
   * `RequestOptions`.
   *
   * PROVISIONAL — see followUps. Spec §9 derives this from a row in the
   * `idempotency_record` table, which the IdempotencyModule owns and which this
   * pass may not write to. Deriving it deterministically from stable domain
   * facts gives the same guarantee for the retry case (identical inputs produce
   * an identical key, so the provider collapses the duplicate); what it does not
   * yet give is the stored response snapshot for replaying a duplicate client
   * request.
   */
  private idempotencyKey(
    purpose: string,
    orderId: string,
    ...amounts: readonly Minor[]
  ): string {
    const material = [purpose, orderId, ...amounts.map(String)].join(":");
    return `akai_${createHash("sha256").update(material).digest("hex").slice(0, 48)}`;
  }

  /** Exposed for the invariant test: an empty order charges nothing. */
  static readonly EMPTY_TOTAL: Minor = ZERO;
}
