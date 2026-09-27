import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { Minor, OrderStatus } from "@akai/contracts";

/**
 * Named domain errors.
 *
 * They extend Nest HTTP exceptions so the global AllExceptionsFilter renders the
 * typed error envelope with the right status automatically, while still being
 * NAMED types that unit tests can assert on precisely. Asserting
 * `rejects.toThrow(RefundExceedsRefundableError)` is a real check; asserting on
 * a message string passes for the wrong reason as soon as someone rewords it.
 */

export class OrderNotFoundError extends NotFoundException {
  constructor(reference: string) {
    super({ code: "ORDER_NOT_FOUND", message: `No order matches ${reference}` });
  }
}

// NOTE: the domain field is `orderStatus`, not `status`. `HttpException` already
// has a private `status`, and shadowing it is a compile error — one of the small
// reasons these errors are declared once, here, rather than inline at each site.

export class OrderNotPayableError extends ConflictException {
  constructor(
    readonly orderStatus: OrderStatus,
    readonly orderNumber: string,
  ) {
    super({
      code: "ORDER_NOT_PAYABLE",
      message: `Order ${orderNumber} is ${orderStatus} and cannot start a new checkout`,
    });
  }
}

export class OrderNotRefundableError extends ConflictException {
  constructor(
    readonly orderStatus: OrderStatus,
    readonly orderNumber: string,
  ) {
    super({
      code: "ORDER_NOT_REFUNDABLE",
      message: `Order ${orderNumber} is ${orderStatus}; only a paid order can be refunded`,
    });
  }
}

export class NoRefundablePaymentError extends ConflictException {
  constructor(readonly orderNumber: string) {
    super({
      code: "NO_REFUNDABLE_PAYMENT",
      message: `Order ${orderNumber} has no succeeded payment to refund against`,
    });
  }
}

/**
 * The refund ceiling. This is the check that makes a client-proposed amount
 * safe: whatever the caller asks for, the server independently computes
 * `grandTotal - refundedTotal` from the order row and refuses anything above it.
 */
export class RefundExceedsRefundableError extends UnprocessableEntityException {
  constructor(
    readonly requested: Minor,
    readonly refundable: Minor,
  ) {
    super({
      code: "REFUND_EXCEEDS_REFUNDABLE",
      message: `Requested refund of ${requested} exceeds the remaining refundable balance of ${refundable}`,
    });
  }
}

export class RefundAmountInvalidError extends UnprocessableEntityException {
  constructor(readonly requested: Minor) {
    super({
      code: "REFUND_AMOUNT_INVALID",
      message: `A refund must be greater than zero; got ${requested}`,
    });
  }
}

/**
 * An INTERNAL invariant breach, not a client error: the order's own line items
 * do not sum to its stored grand total. Refusing to open a Checkout session is
 * the only safe response — the alternative is charging a number that does not
 * match the order we will later invoice.
 */
export class CheckoutTotalMismatchError extends InternalServerErrorException {
  constructor(
    readonly computed: Minor,
    readonly stored: Minor,
    readonly orderNumber: string,
  ) {
    super({
      code: "CHECKOUT_TOTAL_MISMATCH",
      message: `Order ${orderNumber} line items sum to ${computed} but grandTotal is ${stored}`,
    });
  }
}

/**
 * Whop created the checkout configuration but handed back no URL to send the
 * customer to.
 *
 * `purchase_url` is typed `string | null` on the create response, so this is a
 * real production outcome rather than a defensive nicety. Persisting an order in
 * that state would mean an order that has been moved to AWAITING_PAYMENT with
 * nowhere for the customer to pay and no page to return from.
 *
 * 500, not a 4xx — nothing the client sent caused this.
 */
export class CheckoutUrlMissingError extends InternalServerErrorException {
  constructor(readonly orderNumber: string) {
    super({
      code: "CHECKOUT_URL_MISSING",
      message: `The payment provider returned no purchase URL for order ${orderNumber}; refusing to move the order to AWAITING_PAYMENT with nowhere to pay`,
    });
  }
}

/** The webhook request did not carry verifiable raw bytes. */
export class WebhookSignatureError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WebhookSignatureError";
  }
}

// ---------------------------------------------------------------------------
// Whop gateway failures
//
// The split is the only thing a caller actually needs to decide: is this worth
// retrying, or is it a request we should never send again? `WhopTimeoutError`,
// a transport failure with no status code, and any 5xx or 429 are the first;
// every other status — auth, permission, not-found, validation — is the second.
// Two named errors, not eight, because eight would be eight `catch` arms that
// all do one of two things.
//
// The SDK ships a THIN taxonomy: `WhopError` (with an optional `statusCode`,
// `body` and `requestId`) and `WhopTimeoutError`. There are no per-condition
// subclasses to narrow on, so `live-whop.gateway.ts` classifies on the status
// code instead — which is why that classification lives in exactly one helper
// there rather than being repeated at each call site.
// ---------------------------------------------------------------------------

/**
 * The Whop account could not be reached at boot.
 *
 * A plain `Error`, deliberately: this is thrown from `onModuleInit`, where
 * there is no request to render a status code onto. Its whole purpose is to
 * kill the process, so an HTTP shape would be theatre.
 */
export class WhopBootCheckFailedError extends Error {
  constructor(
    readonly accountId: string,
    readonly reason: string,
  ) {
    super(
      `Whop account ${accountId} was unreachable at boot: ${reason}. ` +
        `Refusing to start — a misconfigured key must fail here, not at the first customer's checkout.`,
    );
    this.name = "WhopBootCheckFailedError";
  }
}

/**
 * Whop was momentarily unreachable: connection, timeout or rate limit.
 *
 * RETRY IS SAFE and that is not an assumption — the gateway performs no local
 * writes, so a failure here happens before any state of ours has changed, and
 * every mutating call it makes carries an `idempotencyKey`.
 *
 * 503 rather than 500 because it is genuinely transient and the caller (or the
 * outbox) should try again.
 */
export class PaymentProviderUnavailableError extends ServiceUnavailableException {
  constructor(
    readonly operation: string,
    readonly reason: string,
  ) {
    super({
      code: "PAYMENT_PROVIDER_UNAVAILABLE",
      message: `The payment provider could not be reached while performing ${operation}: ${reason}`,
    });
  }
}

/**
 * Whop rejected the request itself — a bad key, a missing permission, an
 * unknown id, a validation failure.
 *
 * Retrying an identical request produces an identical rejection, so this is
 * NOT a transient condition and must not be routed to a retry queue.
 *
 * The field is `providerStatusCode`, not `statusCode`: `HttpException` owns
 * enough of its own surface that shadowing near-misses are worth avoiding on
 * sight.
 */
export class PaymentProviderRequestError extends InternalServerErrorException {
  constructor(
    readonly operation: string,
    readonly providerStatusCode: number | null,
    readonly providerCode: string | null,
    readonly reason: string,
  ) {
    super({
      code: "PAYMENT_PROVIDER_REQUEST_FAILED",
      message: `The payment provider rejected ${operation}: ${reason}`,
    });
  }
}
