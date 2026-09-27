import type { Whop } from "@whop/sdk";

import type {
  WhopCheckoutParams,
  WhopCheckoutResult,
  WhopGateway,
  WhopRefundParams,
  WhopRequestOptions,
} from "../whop/whop.gateway";
import { whopPayment } from "./whop-objects";

/** One recorded outbound call: what we asked for, and how we asked for it. */
export interface RecordedGatewayCall<TParams> {
  readonly params: TParams;
  readonly options: WhopRequestOptions;
}

/**
 * A Whop double that records what it was asked to do.
 *
 * `implements WhopGateway` with ZERO casts, which is the entire point of the
 * port: a drifting signature breaks this file at compile time instead of
 * letting a test pass against a contract the real adapter no longer honours.
 *
 * There is deliberately no webhook method to stub. Signature verification is
 * exercised for real in every webhook test — a webhook endpoint that skips
 * verification lets anyone on the internet mark orders paid, so it is the one
 * part of the integration that must never be faked.
 */
export class FakeWhopGateway implements WhopGateway {
  readonly checkoutConfigurations: RecordedGatewayCall<WhopCheckoutParams>[] = [];
  readonly refundCalls: RecordedGatewayCall<WhopRefundParams>[] = [];
  readonly retrievedPaymentIds: string[] = [];

  /**
   * The URL the next `createCheckoutConfiguration` reports back.
   *
   * SETTABLE TO `null` ON PURPOSE. `purchase_url` is typed nullable on the
   * create response, so an absent URL is a real production outcome, and the
   * "refuse to move an order to AWAITING_PAYMENT with nowhere to pay" path is
   * only testable if a fake can produce it.
   */
  nextPurchaseUrl: string | null = "https://whop.com/checkout/ch_test_000000/";
  nextCheckoutId = "ch_test_000000";

  /** Errors to raise instead of succeeding, for failure-path tests. */
  createCheckoutError: Error | null = null;
  refundError: Error | null = null;

  /** What a refund call reports back. Typed, unlike TagadaPay's `unknown`. */
  nextRefundResult: Whop.Payment = whopPayment({ refunded_amount: null });

  /** Lookups for the read method; unmatched ids fall back to a default object. */
  readonly paymentLookup = new Map<string, Whop.Payment>();

  async createCheckoutConfiguration(
    params: WhopCheckoutParams,
    options: WhopRequestOptions,
  ): Promise<WhopCheckoutResult> {
    if (this.createCheckoutError !== null) {
      throw this.createCheckoutError;
    }

    this.checkoutConfigurations.push({ params, options });

    return { checkoutId: this.nextCheckoutId, purchaseUrl: this.nextPurchaseUrl };
  }

  async retrievePayment(paymentId: string): Promise<Whop.Payment> {
    this.retrievedPaymentIds.push(paymentId);

    return this.paymentLookup.get(paymentId) ?? whopPayment({ id: paymentId });
  }

  async refundPayment(
    params: WhopRefundParams,
    options: WhopRequestOptions,
  ): Promise<Whop.Payment> {
    if (this.refundError !== null) {
      throw this.refundError;
    }

    this.refundCalls.push({ params, options });

    return this.nextRefundResult;
  }
}
