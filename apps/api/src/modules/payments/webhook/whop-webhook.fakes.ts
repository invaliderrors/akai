import { createHmac, randomUUID } from "node:crypto";

import { toMinor } from "@akai/contracts";

import type {
  OrderLineSnapshot,
  OrderSnapshot,
  PaymentSnapshot,
} from "../repository/payments.repository";
import {
  FakePaymentsRepository,
  orderLine as baseOrderLine,
  orderSnapshot as baseOrderSnapshot,
  paymentSnapshot as basePaymentSnapshot,
} from "../testing/payments.fakes";

/**
 * Webhook-flavoured setup on top of the module's ONE fake repository.
 *
 * There is deliberately no `FakeWebhookRepository` here. This lane and the
 * checkout/refund lane were written in parallel and each grew its own class
 * implementing `PaymentsRepository`; they were merged into
 * `testing/payments.fakes.ts`. Two fakes for one port lets a change break an
 * invariant in one while every suite using the other stays green, and it gives
 * "how does the repository behave?" two answers that drift.
 *
 * What lives here is the genuinely webhook-specific part: the fixed ids the
 * suites correlate on, builders whose DEFAULTS describe an order that has
 * already reached the payment page (`AWAITING_PAYMENT`, checkout id set) rather
 * than a fresh one, and the signed-request helpers.
 */

export { FakePaymentsRepository } from "../testing/payments.fakes";
export type {
  RecordedOrderEvent,
  RecordedOutbox,
  RecordedProviderEvent,
} from "../testing/payments.fakes";

// ---------------------------------------------------------------------------
// Fixed ids the webhook suites correlate on
// ---------------------------------------------------------------------------

export const TEST_ORDER_ID = "11111111-1111-4111-8111-111111111111";
export const TEST_CHECKOUT_ID = "ch_test_checkout";
export const TEST_PAYMENT_ID = "pay_test_123";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * An order as it exists when a webhook arrives: already redirected to the hosted
 * page, so AWAITING_PAYMENT with a correlation handle persisted.
 *
 * The shared builder's default is a PENDING order with no checkout id, which is
 * right for the checkout suites and wrong for every test here — a webhook for an
 * order that never opened a checkout is a different scenario entirely.
 */
export function orderSnapshot(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return baseOrderSnapshot({
    id: TEST_ORDER_ID,
    status: "AWAITING_PAYMENT",
    providerCheckoutId: TEST_CHECKOUT_ID,
    ...overrides,
  });
}

export function orderLine(overrides: Partial<OrderLineSnapshot> = {}): OrderLineSnapshot {
  return baseOrderLine({
    id: "line-1",
    productName: "Creatine Monohydrate",
    variantName: "500 g",
    sku: "AK-CRE-500",
    unitPriceGross: toMinor(4999),
    lineTotalGross: toMinor(4999),
    ...overrides,
  });
}

/**
 * The payment row `startCheckout` leaves behind: recorded before Whop has minted
 * a payment id, so `providerPaymentId` is null and the webhook backfills it.
 */
export function paymentSnapshot(
  overrides: Partial<PaymentSnapshot> = {},
): PaymentSnapshot {
  return basePaymentSnapshot({
    id: "payment-1",
    orderId: TEST_ORDER_ID,
    status: "PROCESSING",
    providerPaymentId: null,
    providerTransactionId: null,
    ...overrides,
  });
}

/** A repository seeded with the standard awaiting-payment order. */
export function seededRepository(
  order: OrderSnapshot = orderSnapshot(),
): FakePaymentsRepository {
  const repository = new FakePaymentsRepository();
  repository.seedOrder(order, [orderLine()]);
  return repository;
}

// ---------------------------------------------------------------------------
// Signed-request helpers
// ---------------------------------------------------------------------------

/**
 * The webhook secret used across the webhook suites. Never a real value.
 *
 * Kept byte-identical to `TEST_WHOP_WEBHOOK_SECRET` in `@akai/testing`, which
 * `apps/api-e2e` uses. This file cannot import it: `@akai/testing` is
 * `type:testing` and this module is compiled into the application program (it is
 * not a `.test.ts`), so importing it here would pull a test library into the
 * shipped build.
 *
 * THE `ws_` PREFIX IS PART OF THE KEY and must not be trimmed — see `signBody`.
 */
export const TEST_WHOP_WEBHOOK_SECRET = "ws_test_secret_for_unit_tests_only_0123456789";

export interface SignedWhopWebhook {
  /** Exact bytes to POST. Must reach the controller UNPARSED. */
  readonly payload: string;
  /** The same bytes as a Buffer, which is what `request.rawBody` carries. */
  readonly rawBody: Buffer;
  /** The three Standard Webhooks headers, lower-cased as Whop sends them. */
  readonly headers: Record<string, string>;
  /** The `webhook-id`, which is also the dedupe key the controller uses. */
  readonly deliveryId: string;
}

export interface SignWhopEventOptions {
  readonly secret?: string;
  /** Repeat one to simulate a redelivery of the same event. */
  readonly deliveryId?: string;
  readonly timestampSeconds?: number;
}

/**
 * A GENUINE Whop Standard Webhooks signature.
 *
 * Why this and not a stub that returns a canned event: if the suites bypassed
 * verification, the raw-body path would never run, and the single most common
 * webhook defect — the body arriving JSON-parsed so every signature check fails
 * — would pass every test and fail every real delivery.
 *
 * THE SECRET IS BASE64-ENCODED BEFORE IT IS USED AS A KEY, prefix included. Whop
 * HMACs with the literal bytes of the secret; the `standardwebhooks` library the
 * SDK wraps base64-DECODES whatever key it is handed, so the SDK encodes first to
 * cancel that out. Signing with the raw secret here would produce bytes the real
 * verifier rejects, and the suite would be testing a protocol nothing speaks.
 */
export function buildSignedWhopEvent(
  event: Readonly<Record<string, unknown>>,
  options: SignWhopEventOptions = {},
): SignedWhopWebhook {
  const secret = options.secret ?? TEST_WHOP_WEBHOOK_SECRET;
  const deliveryId = options.deliveryId ?? `msg_${randomUUID()}`;
  const timestamp = String(options.timestampSeconds ?? Math.floor(Date.now() / 1000));

  // JSON.stringify output IS the signed byte sequence. Re-serialising it
  // anywhere downstream changes key order or whitespace and breaks the
  // signature.
  const payload = JSON.stringify(event);
  const rawBody = Buffer.from(payload, "utf8");

  const key = Buffer.from(Buffer.from(secret, "utf8").toString("base64"), "base64");
  const signature = createHmac("sha256", key)
    .update(`${deliveryId}.${timestamp}.${payload}`)
    .digest("base64");

  return {
    payload,
    rawBody,
    deliveryId,
    headers: {
      "webhook-id": deliveryId,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    },
  };
}

/**
 * A well-formed signature computed with the WRONG secret.
 *
 * Every webhook controller needs a test proving this is rejected. An endpoint
 * that accepts mis-signed payloads lets anyone on the internet mark any order
 * PAID.
 */
export function buildForgedWhopEvent(
  event: Readonly<Record<string, unknown>>,
): SignedWhopWebhook {
  return buildSignedWhopEvent(event, { secret: "ws_attacker_controlled_value_0123456789" });
}

/**
 * A CORRECTLY signed delivery whose timestamp is outside the tolerance window.
 *
 * The replay test the TagadaPay scheme could not support: its HMAC covered the
 * raw body alone, so the transport had no notion of when a delivery happened.
 * Here the timestamp is inside the signed material, so this is authentic and
 * must still be refused.
 */
export function buildStaleWhopEvent(
  event: Readonly<Record<string, unknown>>,
  ageSeconds = 3600,
): SignedWhopWebhook {
  return buildSignedWhopEvent(event, {
    timestampSeconds: Math.floor(Date.now() / 1000) - ageSeconds,
  });
}

/**
 * A minimal `payment.succeeded` body that correlates on both keys.
 *
 * MONEY IS MAJOR UNITS — `49.99`, not `4999`. That is Whop's webhook plane, and
 * writing it the other way round is the single easiest way to author a fixture
 * that passes against a shape the provider never sends.
 */
export function paymentSucceededEvent(
  overrides: Readonly<Record<string, unknown>> = {},
  dataOverrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "evt_whop_0001",
    type: "payment.succeeded",
    timestamp: new Date().toISOString(),
    data: {
      id: TEST_PAYMENT_ID,
      checkout_configuration_id: TEST_CHECKOUT_ID,
      metadata: { order_id: TEST_ORDER_ID, order_number: "AK-2026-000001" },
      status: "paid",
      substatus: "succeeded",
      total: 49.99,
      currency: "eur",
      paid_at: new Date().toISOString(),
      ...dataOverrides,
    },
    ...overrides,
  };
}
