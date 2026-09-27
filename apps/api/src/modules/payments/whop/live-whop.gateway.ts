import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type { ServerEnv } from "@akai/config";
import type { Logger } from "@akai/observability";
import { Whop, WhopClient, WhopError, WhopTimeoutError } from "@whop/sdk";

import { SERVER_CONFIG } from "../../config/config.module";
import { LOGGER } from "../../observability/logger.module";
import {
  PaymentProviderRequestError,
  PaymentProviderUnavailableError,
  WhopBootCheckFailedError,
} from "../payments.errors";
import {
  type WhopCheckoutParams,
  type WhopCheckoutResult,
  type WhopGateway,
  type WhopRefundParams,
  type WhopRequestOptions,
} from "./whop.gateway";

/**
 * Exactly the configuration this adapter reads.
 *
 * Narrowed from `ServerEnv` so the gateway's dependency is legible and so a
 * test can construct one without inventing forty unrelated variables.
 * `SERVER_CONFIG` supplies a full `ServerEnv`, which satisfies this
 * structurally, so no Nest wiring changes.
 */
export type WhopGatewayConfig = Pick<
  ServerEnv,
  "whop" | "WHOP_API_VERSION_DATE" | "WHOP_BOOT_CHECK"
>;

/**
 * Statuses that mean "try again", as opposed to "never send this request again".
 *
 * 429 and every 5xx. Everything else Whop returns — 400, 401, 403, 404, 409,
 * 422 — is a rejection of the request itself, and retrying an identical request
 * produces an identical rejection.
 *
 * 409 IS DELIBERATELY NOT RETRYABLE even though it is what Whop returns when an
 * `Idempotency-Key` is reused while the first request is still in flight. It
 * resolves on its own within seconds, but our keys are derived from stable
 * domain facts, so a 409 means two callers are driving the same order at once —
 * a condition an operator should see, not one a retry loop should paper over.
 */
function isRetryableStatus(statusCode: number | undefined): boolean {
  return statusCode === undefined || statusCode === 429 || statusCode >= 500;
}

/**
 * The live TagadaPay-shaped seam, now pointed at Whop.
 *
 * Every method funnels its failures through `rethrow` so the two-way
 * retryable/terminal split is decided in one place. The SDK ships only
 * `WhopError` and `WhopTimeoutError` — no per-condition subclasses — so the
 * classification is on the status code, and doing it per call site would mean
 * three copies of a rule that must not diverge.
 */
@Injectable()
export class LiveWhopGateway implements WhopGateway, OnModuleInit {
  private readonly client: WhopClient;

  constructor(
    @Inject(SERVER_CONFIG) private readonly config: WhopGatewayConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.client = new WhopClient({
      // The credentials are ALREADY RESOLVED — sandbox or live was decided once,
      // at boot, in `libs/config`. This adapter must not re-derive it: a gateway
      // talking to one environment while the webhook verifies against the other
      // is a payment taken in sandbox and settled against production.
      //
      // `token`, NOT `apiKey`. The SDK's bearer provider names its option
      // `token` and every field on `BaseClientOptions` is optional, so an
      // `apiKey` key would be a compile error here (there is no index
      // signature) — which is the good outcome, and worth noting because the
      // quickstart docs write `apiKey`.
      token: config.whop.apiKey,
      baseUrl: config.whop.baseUrl,
      // ALWAYS PINNED. Whop's payload shape is versioned by date, and the
      // webhook body in particular (`PaymentLegacy`) is what our settlement
      // check reads. Unpinned, a vendor-side version roll could change `total`
      // under us and every order would land in PAYMENT_MISMATCH.
      apiVersionDate: config.WHOP_API_VERSION_DATE,
    });
  }

  /**
   * Prove the credentials are real before the first customer does it for us.
   *
   * IT LISTS PRODUCTS, AND DELIBERATELY NOT `accounts.me()`. That was the
   * obvious "cheapest authenticated call", and it is the wrong one: it requires
   * the `company:balance:read` scope, which this integration never uses, and a
   * perfectly valid sandbox key returns 403 on it. Measured — the live key
   * answers 200 to both calls, the sandbox key answers 403 to `accounts.me` and
   * 200 to this. A boot check that kills the container on a good credential is
   * worse than no boot check at all.
   *
   * Listing one product against the configured account also tests the thing the
   * credential is actually FOR: the account and the product a checkout plan
   * hangs off. A key that can do this can open a checkout.
   *
   * A wrong or revoked key must still kill the boot — the alternative is a green
   * deploy whose first checkout 500s.
   */
  async onModuleInit(): Promise<void> {
    if (!this.config.WHOP_BOOT_CHECK) {
      this.logger.warn(
        {},
        "WHOP_BOOT_CHECK=false — skipping the credential check; a bad key will not surface until the first checkout",
      );
      return;
    }

    try {
      await this.client.products.list({
        account_id: this.config.whop.accountId,
        first: 1,
      });

      this.logger.info(
        {
          accountId: this.config.whop.accountId,
          productId: this.config.whop.productId,
          environment: this.config.whop.environment,
        },
        "Whop credentials verified at boot",
      );
    } catch (error) {
      throw new WhopBootCheckFailedError(this.config.whop.accountId, describe(error));
    }
  }

  /**
   * Open a hosted checkout.
   *
   * ONE CALL DOES ALL OF IT: the price, the correlation metadata and the return
   * URL. `plan` is inline rather than a separate `plans.create` — the SDK
   * documents the two as mutually exclusive with `plan_id`, and creating a plan
   * first would mean a second call whose failure would leave an orphan plan
   * behind with no order to attribute it to.
   */
  async createCheckoutConfiguration(
    params: WhopCheckoutParams,
    options: WhopRequestOptions,
  ): Promise<WhopCheckoutResult> {
    try {
      const configuration = await this.client.checkoutConfigurations.create(
        {
          account_id: params.accountId,
          // Metadata on the CONFIGURATION, not on the plan. Whop copies a
          // configuration's metadata onto the payments created from it; a plan
          // is a reusable price and may be shared by two orders with the same
          // total, so per-order identity must not live there.
          metadata: { ...params.metadata },
          mode: "payment",
          redirect_url: params.redirectUrl,
          plan: {
            product_id: params.productId,
            initial_price: params.initialPrice,
            currency: params.currency,
            plan_type: "one_time",
            release_method: "buy_now",
            title: params.title,
            // HIDDEN, because this plan is one order's price and must never
            // appear as a purchasable item on the storefront Whop renders.
            visibility: "hidden",
            // TAX IS ALREADY IN `initial_price`. The `tax` module computes EU
            // VAT into `order.grandTotal` before checkout is ever opened, so
            // declaring the price exclusive would have Whop add VAT a second
            // time and overcharge the customer. `collect_tax` is not settable
            // on create; this is the only lever the API exposes.
            //
            // UNVERIFIED AGAINST A LIVE ACCOUNT — spike gate S1. If Whop adds
            // tax anyway, the reported total exceeds ours, `verifySettlement`
            // returns AMOUNT_DIFFERS and the order parks in PAYMENT_MISMATCH
            // with an alert. Loud, and no money is misapplied.
            override_tax_type: "inclusive",
          },
        },
        { idempotencyKey: options.idempotencyKey },
      );

      return {
        checkoutId: configuration.id,
        // `purchase_url` is `string | null | undefined` on the response type.
        // Collapsed to `string | null` here so callers have one absent case to
        // handle rather than two that mean the same thing.
        purchaseUrl: configuration.purchase_url ?? null,
      };
    } catch (error) {
      this.rethrow("createCheckoutConfiguration", error);
    }
  }

  async retrievePayment(paymentId: string): Promise<Whop.Payment> {
    try {
      return await this.client.payments.retrieve({ id: paymentId });
    } catch (error) {
      this.rethrow("retrievePayment", error);
    }
  }

  async refundPayment(
    params: WhopRefundParams,
    options: WhopRequestOptions,
  ): Promise<Whop.Payment> {
    try {
      return await this.client.payments.refund(
        { id: params.paymentId, partial_amount: params.partialAmount },
        { idempotencyKey: options.idempotencyKey },
      );
    } catch (error) {
      this.rethrow("refundPayment", error);
    }
  }

  /**
   * Classify one SDK failure and rethrow it as a domain error.
   *
   * `never` return type so a `catch` block that calls this satisfies the
   * function's own return type without a redundant `throw` at the call site —
   * and so removing the throw from here becomes a compile error rather than a
   * silent `undefined` returned from a checkout.
   *
   * `body` IS DELIBERATELY NOT LOGGED. It is the provider's raw response and
   * can carry customer detail; `requestId` is what a support conversation with
   * Whop actually needs, and the status code is what decides the retry.
   */
  private rethrow(operation: string, error: unknown): never {
    if (error instanceof WhopTimeoutError) {
      this.logger.warn({ operation }, "Whop request timed out");
      throw new PaymentProviderUnavailableError(operation, "request timed out");
    }

    if (error instanceof WhopError) {
      const retryable = isRetryableStatus(error.statusCode);

      this.logger.error(
        {
          operation,
          statusCode: error.statusCode ?? null,
          requestId: error.requestId ?? null,
          retryable,
        },
        "Whop rejected a request",
      );

      if (retryable) {
        throw new PaymentProviderUnavailableError(operation, error.message);
      }

      throw new PaymentProviderRequestError(
        operation,
        error.statusCode ?? null,
        error.requestId ?? null,
        error.message,
      );
    }

    // Not an SDK error at all — a programming fault, or a fetch-layer failure
    // the SDK did not wrap. Retryable is the safe reading: it happened before
    // any state of ours changed, and every mutating call carries an
    // idempotency key.
    this.logger.error({ operation }, "Whop call failed with an unrecognised error");
    throw new PaymentProviderUnavailableError(operation, describe(error));
  }
}

/** A message for a log line, without assuming the thrown value is an Error. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
