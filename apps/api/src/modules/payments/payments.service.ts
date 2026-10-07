import { Inject, Injectable } from "@nestjs/common";
import type { ServerEnv } from "@akai/config";
import type { Minor, OrderStatus, OrderStatusResponse } from "@akai/contracts";
import { storefrontUrl } from "@akai/i18n";
import { add, subtract, sum, ZERO } from "@akai/money";
import type { Logger } from "@akai/observability";

import { SERVER_CONFIG } from "../config/config.module";
import { LOGGER } from "../observability/logger.module";
import type { StartCheckoutResponse } from "./dto/payments.dto";
import { settleOrderPaid } from "./order-settlement";
import {
  ORDER_STATE_PORT,
  isRedundantTransition,
  type OrderStatePort,
} from "./order-state.port";
import {
  CheckoutTotalMismatchError,
  OrderNotFoundError,
  OrderNotPayableError,
  PaymentsNotConfiguredError,
  UnsupportedCurrencyError,
} from "./payments.errors";
import {
  PAYMENTS_REPOSITORY,
  type OrderCheckoutDetails,
  type OrderLineSnapshot,
  type OrderSnapshot,
  type PaymentsRepository,
} from "./repository/payments.repository";
import { WompiSettlementService } from "./wompi-settlement.service";
import {
  CHECKOUT_EXPIRY_MS,
  WOMPI_CURRENCY,
  buildWompiCheckoutUrl,
  wompiReference,
  type WompiCheckoutShipping,
} from "./wompi/wompi-checkout";
import { WOMPI_GATEWAY, type WompiGateway } from "./wompi/wompi.gateway";

/**
 * The storefront route a customer returns to from Wompi.
 *
 * LOCALE-FREE ON PURPOSE — `storefrontUrl` adds the prefix the storefront's own
 * routing rule calls for. The page polls `GET payments/orders/:n/status` (and
 * hands back Wompi's `?id=` once); it does not assert success.
 */
const CHECKOUT_PROCESSING_PATH = "/checkout/processing";

/** Orders in these states may still open a hosted checkout. */
const PAYABLE_STATUSES: readonly OrderStatus[] = ["PENDING", "AWAITING_PAYMENT"];

/**
 * States in which the money is confirmed to have reached us. An ALLOWLIST:
 * `PAYMENT_MISMATCH` is neither payable nor failed, and reporting it as paid
 * would tell a customer their order settled when Wompi reported an amount we
 * refused to accept.
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
 * States in which polling has nothing left to learn — "will this change on its
 * own if the browser keeps asking?". `PAYMENT_MISMATCH` is non-terminal in the
 * STATE MACHINE (an operator may still move it) but terminal HERE: only a human
 * moves it, so the processing screen must stop and say so.
 */
const POLL_TERMINAL_STATUSES: readonly OrderStatus[] = [
  "CANCELLED",
  "REFUNDED",
  "FAILED",
  "DELIVERED",
  "PAYMENT_MISMATCH",
];

/** How long a PENDING transaction sits before the sweep asks Wompi about it. */
export const STALLED_TRANSACTION_AGE_MS = 10 * 60 * 1000;

/** At most this many Wompi lookups per sweep tick. */
const SWEEP_BATCH = 20;

@Injectable()
export class PaymentsService {
  constructor(
    @Inject(PAYMENTS_REPOSITORY) private readonly repository: PaymentsRepository,
    @Inject(WOMPI_GATEWAY) private readonly wompi: WompiGateway,
    private readonly settlement: WompiSettlementService,
    @Inject(ORDER_STATE_PORT) private readonly orderState: OrderStatePort,
    @Inject(SERVER_CONFIG) private readonly config: ServerEnv,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  // -------------------------------------------------------------------------
  // Checkout
  // -------------------------------------------------------------------------

  /**
   * Open a Wompi Web Checkout for an existing order.
   *
   * THE ONLY INPUT IS AN ORDER ID. The amount on the URL is `order.grandTotal`,
   * re-checked against the order's own lines here, and the URL carries an
   * integrity signature over it — so neither a caller nor the shopper's browser
   * can change what is charged.
   *
   * NO PROVIDER CALL. Web Checkout is a signed GET; everything is decided and
   * persisted here, BEFORE the shopper is redirected: the attempt row with its
   * unique reference, and the move to AWAITING_PAYMENT. A Wompi event can
   * therefore never arrive for a reference we have not stored.
   */
  async startCheckout(orderId: string): Promise<StartCheckoutResponse> {
    const order = await this.repository.findOrderById(orderId);
    if (order === null) {
      throw new OrderNotFoundError(orderId);
    }

    if (!PAYABLE_STATUSES.includes(order.status)) {
      throw new OrderNotPayableError(order.status, order.orderNumber);
    }

    // DEMO MODE. Settled locally, before anything provider-shaped is touched,
    // returning the SAME processing URL the provider would have returned the
    // customer to — so the storefront flow is byte-identical.
    if (!this.config.PAYMENTS_ENABLED) {
      return this.settleWithoutProvider(order);
    }

    const wompi = this.config.wompi;
    if (wompi === null) {
      throw new PaymentsNotConfiguredError();
    }

    if (order.currency !== WOMPI_CURRENCY) {
      throw new UnsupportedCurrencyError(order.currency, order.orderNumber);
    }

    // THE LOCAL INVARIANT: if the lines do not sum to the stored grand total,
    // the number we are about to sign is wrong.
    const lines = await this.repository.findOrderLines(order.id);
    const chargedTotal = this.chargedTotal(order, lines);
    if (chargedTotal !== order.grandTotal) {
      throw new CheckoutTotalMismatchError(chargedTotal, order.grandTotal, order.orderNumber);
    }

    const details = await this.repository.findOrderCheckoutDetails(order.id);
    if (details === null) {
      throw new OrderNotFoundError(orderId);
    }

    const reference = await this.repository.runInTransaction(async (tx) => {
      // Under the order row lock: the attempt count, and therefore the
      // reference, cannot be minted twice by two concurrent starts.
      const locked = await tx.lockOrder(order.id);
      if (locked === null) {
        throw new OrderNotFoundError(orderId);
      }
      if (!PAYABLE_STATUSES.includes(locked.status)) {
        throw new OrderNotPayableError(locked.status, locked.orderNumber);
      }

      const attempt = (await tx.countPaymentAttempts(order.id)) + 1;
      const minted = wompiReference(order.orderNumber, attempt);

      await tx.recordPaymentAttempt({
        orderId: order.id,
        amount: order.grandTotal,
        currency: order.currency,
        status: "REQUIRES_PAYMENT_METHOD",
        providerReference: minted,
      });

      if (!isRedundantTransition(locked.status, "AWAITING_PAYMENT")) {
        this.orderState.assertTransition(locked.status, "AWAITING_PAYMENT");
        await tx.setOrderStatus(order.id, "AWAITING_PAYMENT");
      }

      await tx.appendOrderEvent({
        orderId: order.id,
        type: "checkout.session.created",
        message: `Wompi checkout opened (reference ${minted}) for ${order.grandTotal} ${order.currency}`,
        isInternal: true,
      });

      return minted;
    });

    const checkoutUrl = buildWompiCheckoutUrl({
      checkoutUrl: wompi.checkoutUrl,
      publicKey: wompi.publicKey,
      integritySecret: wompi.integritySecret,
      reference,
      amountInCents: order.grandTotal,
      currency: WOMPI_CURRENCY,
      expiresAt: new Date(Date.now() + CHECKOUT_EXPIRY_MS),
      // A PROCESSING screen that polls, deliberately not a success page: an
      // order becomes PAID only from a verified event or a transaction read back
      // with the private key. Locale-correct via the shared routing rule.
      redirectUrl: this.processingUrl(order),
      vatInCents: order.taxTotal,
      customer: {
        email: order.email,
        fullName: details.billingName,
        phoneNumber: details.billingPhone ?? details.shipping.phone,
        legalId: details.documentNumber,
        legalIdType: details.documentType,
      },
      shipping: shippingFor(details),
    });

    this.logger.info(
      { orderNumber: order.orderNumber, reference },
      "Wompi checkout created",
    );

    return { orderNumber: order.orderNumber, checkoutUrl };
  }

  // -------------------------------------------------------------------------
  // Status and reconciliation
  // -------------------------------------------------------------------------

  /**
   * Backs the "processing" screen. Polling this is what replaces trusting a
   * success redirect.
   */
  async getOrderPaymentStatus(orderNumber: string): Promise<OrderStatusResponse> {
    const order = await this.repository.findOrderByNumber(orderNumber);
    if (order === null) {
      throw new OrderNotFoundError(orderNumber);
    }
    return statusOf(order);
  }

  /**
   * The return page hands back Wompi's `?id=`: settle from Wompi's own answer.
   *
   * COVERS WEBHOOK DELAYS without trusting the browser beyond the id. The
   * transaction is READ FROM WOMPI with the private key; its reference must
   * belong to THIS order (`expectedOrderNumber`), and it goes through the SAME
   * settlement as the webhook — amount and currency against our total, deduped
   * on (transaction, status) so a webhook carrying the same state is a no-op.
   *
   * NEVER FAILS THE PAGE. An unknown id, a transaction for another order or
   * Wompi being down all answer with the current status; the browser keeps
   * polling and the webhook (or the sweep) settles it.
   */
  async confirmPayment(orderNumber: string, transactionId: string): Promise<OrderStatusResponse> {
    const order = await this.repository.findOrderByNumber(orderNumber);
    if (order === null) {
      throw new OrderNotFoundError(orderNumber);
    }

    // Nothing to learn for an order that is not waiting on money, and no reason
    // to let a public endpoint trigger a Wompi call for it.
    if (order.status !== "AWAITING_PAYMENT" || this.config.wompi === null) {
      return statusOf(order);
    }

    try {
      const transaction = await this.wompi.getTransaction(transactionId);
      if (transaction === null) {
        this.logger.warn({ orderNumber, transactionId }, "Return-page transaction id unknown to Wompi");
      } else {
        await this.settlement.applyTransaction(transaction, {
          source: "return",
          expectedOrderNumber: orderNumber,
        });
      }
    } catch (error) {
      this.logger.warn(
        { orderNumber, transactionId, error: error instanceof Error ? error.message : String(error) },
        "Return-page confirmation failed; the webhook or the sweep will settle it",
      );
    }

    return this.getOrderPaymentStatus(orderNumber);
  }

  /**
   * The reconciliation sweep: ask Wompi again about transactions it last
   * reported PENDING, on orders still AWAITING_PAYMENT, after
   * `STALLED_TRANSACTION_AGE_MS`. Settles through the same path as everything
   * else. Returns how many it looked at. Runs from `ScheduledJobsRunner`.
   */
  async reconcileStalledPayments(now: Date = new Date()): Promise<number> {
    if (!this.config.PAYMENTS_ENABLED || this.config.wompi === null) {
      return 0;
    }

    const stalled = await this.repository.findStalledTransactions(
      new Date(now.getTime() - STALLED_TRANSACTION_AGE_MS),
      SWEEP_BATCH,
    );

    for (const candidate of stalled) {
      try {
        const transaction = await this.wompi.getTransaction(candidate.transactionId);
        if (transaction !== null) {
          await this.settlement.applyTransaction(transaction, {
            source: "sweep",
            expectedOrderNumber: candidate.orderNumber,
          });
        }
      } catch (error) {
        // One bad lookup must not starve the rest of the batch.
        this.logger.warn(
          {
            orderNumber: candidate.orderNumber,
            transactionId: candidate.transactionId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Reconciliation lookup failed; will retry next sweep",
        );
      }
    }

    return stalled.length;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Completes an order with no payment provider in the loop.
   *
   * IT REUSES THE SETTLEMENT THE PROVIDER PATH USES — same stock commit, same
   * timeline entry, same emails, same invoice number — so a demo order is a
   * real order nobody was charged for. NO PAYMENT ROW IS WRITTEN: nothing
   * settled, so the ledger must not claim a payment exists.
   */
  private async settleWithoutProvider(order: OrderSnapshot): Promise<StartCheckoutResponse> {
    await this.repository.runInTransaction(async (tx) => {
      // The same two steps the real flow takes; the state machine has no
      // PENDING -> PAID edge, deliberately.
      if (!isRedundantTransition(order.status, "AWAITING_PAYMENT")) {
        this.orderState.assertTransition(order.status, "AWAITING_PAYMENT");
        await tx.setOrderStatus(order.id, "AWAITING_PAYMENT");
      }

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

    return { orderNumber: order.orderNumber, checkoutUrl: this.processingUrl(order) };
  }

  private processingUrl(order: OrderSnapshot): string {
    return storefrontUrl(this.config.STOREFRONT_URL, order.locale, CHECKOUT_PROCESSING_PATH, {
      order: order.orderNumber,
    });
  }

  /**
   * What our own row says the order comes to, recomputed from its lines — the
   * same gross identity `assertTotalsBalance` enforces when the row is written.
   * Lines are stored GROSS (net of their own discount); shipping is stored NET
   * and its tax is whatever `taxTotal` holds beyond the lines' share.
   */
  private chargedTotal(order: OrderSnapshot, lines: readonly OrderLineSnapshot[]): Minor {
    const grossFromLines = sum(lines.map((line) => line.lineTotalGross));
    const shippingTax = subtract(order.taxTotal, sum(lines.map((line) => line.taxAmount)));
    return add(grossFromLines, add(order.shippingTotal, shippingTax));
  }

  /** Exposed for the invariant test: an empty order charges nothing. */
  static readonly EMPTY_TOTAL: Minor = ZERO;
}

function statusOf(order: OrderSnapshot): OrderStatusResponse {
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    isPaid: SETTLED_STATUSES.includes(order.status),
    isTerminal: POLL_TERMINAL_STATUSES.includes(order.status),
  };
}

/** The shipping snapshot as Wompi's `shipping-address:*`, or null without a phone. */
function shippingFor(details: OrderCheckoutDetails): WompiCheckoutShipping | null {
  const phone = details.shipping.phone ?? details.billingPhone;
  // Wompi requires a phone on a shipping address; checkout always collects one,
  // so null here means a row written some other way — send no address rather
  // than an incomplete one.
  if (phone === null) {
    return null;
  }
  return {
    name: details.shipping.name,
    addressLine1: details.shipping.line1,
    addressLine2: details.shipping.line2,
    city: details.shipping.city,
    region: details.shipping.region,
    country: details.shipping.countryCode,
    phoneNumber: phone,
    postalCode: details.shipping.postalCode,
  };
}
