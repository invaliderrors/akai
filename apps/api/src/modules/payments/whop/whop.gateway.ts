import type { Whop } from "@whop/sdk";

/**
 * Per-request options we pass through to the SDK.
 *
 * NARROWED TO ONE FIELD deliberately. `BaseRequestOptions` also carries
 * `maxRetries`, `timeoutInSeconds`, `abortSignal`, `additionalBodyParameters`
 * and raw `headers` — and `additionalBodyParameters` in particular is a
 * `Record<string, unknown>` that would let a caller smuggle an unreviewed field
 * into a request that decides what a customer is charged. The port exists to
 * make "what can this system do to Whop" answerable from one file; a
 * pass-through escape hatch would make that answer "anything".
 */
export interface WhopRequestOptions {
  /**
   * Deterministic, derived from the order and its total. Whop retains it for 24
   * hours and replays the original response — including a 4xx — rather than
   * executing twice.
   */
  readonly idempotencyKey: string;
}

/**
 * Everything needed to open one hosted checkout.
 *
 * NARROW ON PURPOSE. `CreateCheckoutConfigurationsRequest` has every field
 * optional, so `checkoutConfigurations.create({})` compiles — a type that
 * accepts a bare `{}` for the call that decides what a customer is charged
 * gives no auditability, which is half the reason this port exists. The four
 * things a checkout cannot go without are required here.
 *
 * THE TAGADA PORT'S `_ParamsAreAssignable` PROOF IS DELIBERATELY NOT CARRIED
 * OVER. It existed because `CheckoutInitParams` carried `[key: string]: unknown`,
 * so a typo'd key compiled clean and had to be caught by a structural proof.
 * Whop's request type has no index signature, so tsc already rejects a typo at
 * the adapter. Keeping a proof for a hazard that no longer exists is cargo.
 */
export interface WhopCheckoutParams {
  /** `biz_…`. */
  readonly accountId: string;
  /** `prod_…` — the single Whop product every per-order plan hangs off. */
  readonly productId: string;
  /**
   * OUR recomputed grand total, in MAJOR units, via
   * `Number(toDecimalString(order.grandTotal, order.currency))`.
   *
   * THIS IS THE FIELD THAT KILLED THE CATALOG MIRROR. TagadaPay's checkout
   * accepted `{ variantId, quantity }` and no amount of any kind, which is what
   * made a mirrored variant the only channel through which a price could reach
   * the payment page. Whop takes the number, so our API is the source of truth
   * for pricing in the strong sense: nothing is mirrored, nothing can drift, and
   * a discounted order is simply a smaller figure here.
   */
  readonly initialPrice: number;
  /** ISO-4217, LOWERCASE. Whop's currency enum is lowercase; ours is upper. */
  readonly currency: string;
  /** Shown on the hosted page. The order number. */
  readonly title: string;
  /**
   * Correlation rank 1. Whop copies a checkout configuration's metadata onto
   * the payments created from it, so this is what comes back on the webhook.
   */
  readonly metadata: {
    readonly order_id: string;
    readonly order_number: string;
  };
  /**
   * Where the browser lands afterwards: a PROCESSING screen that polls, never a
   * success page. An order becomes PAID only via a verified webhook.
   */
  readonly redirectUrl: string;
}

export interface WhopCheckoutResult {
  /** `ch_…`. Correlation rank 2, persisted before the customer is redirected. */
  readonly checkoutId: string;
  /**
   * `string | null` because the SDK types it nullable. A null URL is a HARD
   * checkout failure — there is nowhere to send the customer.
   */
  readonly purchaseUrl: string | null;
}

export interface WhopRefundParams {
  /** `pay_…`, the handle the refund is issued against. */
  readonly paymentId: string;
  /**
   * MAJOR units. Omit for a full refund; we always pass one, because the
   * ceiling is recomputed server-side from the order row.
   */
  readonly partialAmount: number;
}

/**
 * The ONLY surface through which this codebase talks to Whop.
 *
 * Two reasons it is a port rather than a bare `WhopClient`:
 *
 * 1. TESTABILITY WITHOUT CASTS. `WhopClient` exposes ~90 resource clients; a
 *    test double for it would have to be forced into place with
 *    `as unknown as WhopClient`. Depending on this narrow interface means the
 *    fake implements a real, checked contract — a drifting signature fails to
 *    compile rather than lying at runtime.
 *
 * 2. AUDITABILITY. Every outbound Whop call the platform can make is listed
 *    here, in one file.
 *
 * THREE METHODS, AND THAT IS THE WHOLE INTEGRATION. There is no product, plan,
 * or webhook-registration method, and their absence is load-bearing rather than
 * incidental:
 *
 *   - No catalog methods, because there is no catalog mirror. The price rides
 *     on the checkout call (see `WhopCheckoutParams.initialPrice`), so nothing
 *     needs to be synced ahead of a purchase and a sync outage is not a class of
 *     failure this system has.
 *   - No `createWebhookEndpoint`. Whop registers endpoints in its dashboard
 *     (Developer -> Webhooks), so there is no API call to audit and no
 *     bootstrap script to ship.
 *   - No `constructWebhookEvent`. Verification lives in
 *     `payments/webhook/whop-webhook.verify.ts`, which wraps the SDK's own
 *     `unwrapWebhook` — see that file for why the vendor's verifier is used here
 *     when TagadaPay's was refused.
 */
export interface WhopGateway {
  createCheckoutConfiguration(
    params: WhopCheckoutParams,
    options: WhopRequestOptions,
  ): Promise<WhopCheckoutResult>;

  retrievePayment(paymentId: string): Promise<Whop.Payment>;

  /**
   * Refund all or part of a payment.
   *
   * RETURNS THE FULL, TYPED `Payment` — the SDK's own declaration, not a
   * widening we chose. TagadaPay's equivalent returned `unknown` and had to be
   * parsed through a deliberately tolerant schema before the ledger could be
   * touched; that schema is deleted, because there is nothing left for it to
   * defend against. `Payment.refunds[]` carries the refund id.
   */
  refundPayment(
    params: WhopRefundParams,
    options: WhopRequestOptions,
  ): Promise<Whop.Payment>;
}

/**
 * DI token. A symbol rather than the interface name because `WhopGateway` is a
 * TypeScript interface — it does not survive to runtime, so Nest has no
 * metadata to resolve it by.
 */
export const WHOP_GATEWAY = Symbol("WHOP_GATEWAY");
