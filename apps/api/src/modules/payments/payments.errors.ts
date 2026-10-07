import {
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
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
 * The order is not in a currency Wompi can charge.
 *
 * Wompi Colombia settles COP only, and every order here is COP — so reaching
 * this means a row was written by something other than checkout. Refusing is
 * the only safe answer: the alternative is a checkout URL for a figure in the
 * wrong unit. 500, because nothing the client sent caused it.
 */
export class UnsupportedCurrencyError extends InternalServerErrorException {
  constructor(
    readonly currency: string,
    readonly orderNumber: string,
  ) {
    super({
      code: "UNSUPPORTED_CURRENCY",
      message: `Order ${orderNumber} is in ${currency}; Wompi charges COP only`,
    });
  }
}

/**
 * Payments are engaged but no Wompi keys are configured.
 *
 * `libs/config` refuses `PAYMENTS_ENABLED=true` without the four keys, so this
 * is reachable only when something calls the provider with payments disabled —
 * a programming fault, surfaced loudly instead of as a URL signed with nothing.
 */
export class PaymentsNotConfiguredError extends InternalServerErrorException {
  constructor() {
    super({
      code: "PAYMENTS_NOT_CONFIGURED",
      message: "No Wompi keys are configured; set the WOMPI_* variables or PAYMENTS_ENABLED=false",
    });
  }
}

// ---------------------------------------------------------------------------
// Wompi gateway failures
//
// The split is the only thing a caller needs to decide: is this worth
// retrying, or is it a request we should never send again? Transport failures,
// timeouts, 429 and 5xx are the first; every other status is the second. The
// classification lives in `live-wompi.gateway.ts`, once.
// ---------------------------------------------------------------------------

/**
 * Wompi was momentarily unreachable: connection, timeout, rate limit or 5xx.
 *
 * RETRY IS SAFE: the only call is a read (`GET /v1/transactions/{id}`), made
 * before any state of ours changes.
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
 * Wompi rejected the request itself — a bad key, a missing permission, a
 * validation failure — or answered 2xx with a body that is not a transaction.
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
