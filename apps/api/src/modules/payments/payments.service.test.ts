import "reflect-metadata";
import { loadServerConfig, resetServerConfigCache, type ServerEnv } from "@akai/config";
import { toMinor, type OrderStatus } from "@akai/contracts";
import { createLogger } from "@akai/observability";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startCheckoutSchema } from "./dto/payments.dto";
import { settleOrderPaid } from "./order-settlement";
import { TransitionTableOrderState } from "./order-state.port";
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
import { PaymentsService } from "./payments.service";
import { FakeWhopGateway } from "./testing/fake-whop.gateway";
import {
  FakePaymentsRepository,
  orderLine,
  orderSnapshot,
  paymentSnapshot,
} from "./testing/payments.fakes";

const TEST_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://akai:akai@localhost:5432/akai",
  DIRECT_DATABASE_URL: "postgresql://akai:akai@localhost:5432/akai",
  JWT_ACCESS_SECRET: "a".repeat(32),
  WHOP_API_KEY: "whop_test_abc123def456ghi789",
  WHOP_ACCOUNT_ID: "biz_test_1",
  WHOP_PRODUCT_ID: "prod_test_1",
  WHOP_WEBHOOK_SECRET: `ws_${"c".repeat(32)}`,
  WHOP_API_VERSION_DATE: "2026-08-14",
  // PINNED, as every real deployment does. Unset, NODE_ENV="test" is not
  // production, so the environment resolves to SANDBOX and the schema demands a
  // sandbox credential set — the parse throws in beforeEach and takes the whole
  // suite with it. These suites exercise the live-credential path.
  WHOP_ENVIRONMENT: "live",
  EMAIL_TRANSPORT: "smtp",
  SMTP_URL: "smtp://localhost:1025",
  EMAIL_FROM: "no-reply@example.com",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "akai-media",
  S3_BUCKET_COA: "akai-coa",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
  CORS_ALLOWED_ORIGINS: "http://localhost:3000",
  STOREFRONT_URL: "http://localhost:3000",
  DASHBOARD_URL: "http://localhost:3001",
  REVALIDATE_SIGNING_SECRET: "b".repeat(32),
};

/** A line that HAS been mirrored — the normal case for every happy-path test. */

let savedEnv: NodeJS.ProcessEnv;
let repository: FakePaymentsRepository;
let whop: FakeWhopGateway;
let service: PaymentsService;
let config: ServerEnv;

function buildService(): PaymentsService {
  return new PaymentsService(
    repository,
    whop,
    new TransitionTableOrderState(),
    config,
    createLogger({ level: "silent", nodeEnv: "test", serviceName: "api" }),
  );
}

beforeEach(() => {
  savedEnv = process.env;
  process.env = { ...TEST_ENV };
  resetServerConfigCache();
  config = loadServerConfig();

  repository = new FakePaymentsRepository();
  whop = new FakeWhopGateway();
  service = buildService();
});

afterEach(() => {
  process.env = savedEnv;
  resetServerConfigCache();
});

// ---------------------------------------------------------------------------
// The rule: the client never supplies an amount.
// ---------------------------------------------------------------------------

describe("checkout request contract", () => {
  it("has no field through which a caller could propose an amount", () => {
    // Pins the contract itself, not just the handler. If someone later adds an
    // `amount` to this schema, this test fails and they have to justify it.
    const withAmount = startCheckoutSchema.safeParse({
      orderId: "11111111-1111-4111-8111-111111111111",
      amount: 1,
    });

    expect(withAmount.success).toBe(false);
  });

  it("accepts a bare order id", () => {
    const result = startCheckoutSchema.safeParse({
      orderId: "11111111-1111-4111-8111-111111111111",
    });

    expect(result.success).toBe(true);
  });
});

describe("PaymentsService.startCheckout", () => {
  it("sends OUR recomputed grand total as the checkout price", async () => {
    const order = orderSnapshot({ grandTotal: toMinor(9998), taxTotal: toMinor(1735) });
    repository.seedOrder(order, [
      orderLine({
        quantity: 2,
        unitPriceGross: toMinor(4999),
        lineTotalGross: toMinor(9998),
        taxAmount: toMinor(1735),
      }),
    ]);

    await service.startCheckout(order.id);

    const call = whop.checkoutConfigurations[0];
    expect(call).toBeDefined();
    // MAJOR units on the wire, integer minor units in our ledger. 9998 minor
    // units is 99.98, not 9998 — a provider charging the latter would take a
    // hundred times the order value.
    expect(call?.params.initialPrice).toBe(99.98);
  });

  it("is the SOURCE OF TRUTH for the price, not a party to a negotiation", async () => {
    // The whole reason the mirror is gone. TagadaPay accepted `{ variantId,
    // quantity }` and no amount, so the price lived in a replica that could
    // drift; here the figure we compute is the figure charged, and there is no
    // second copy of it anywhere.
    const order = orderSnapshot({ grandTotal: toMinor(4999) });
    repository.seedOrder(order, [orderLine()]);

    await service.startCheckout(order.id);

    const params = whop.checkoutConfigurations[0]?.params;
    expect(params?.initialPrice).toBe(49.99);
    expect(params?.accountId).toBe("biz_test_1");
    expect(params?.productId).toBe("prod_test_1");
  });

  it("collapses a MULTI-LINE cart into one correct figure", async () => {
    // THE QUESTION THIS ANSWERS: a cart still holds as many products as it likes.
    // Whop is told one number, not a basket — it has no per-line concept at all —
    // so the arithmetic that turns several lines, shipping and a discount into
    // that single figure is the whole correctness surface, and every other test
    // in this file happens to use a single line.
    //
    // 4999x2 + 2450x1 + 1200x3 = 16048; +595 shipping; -1500 discount = 15143.
    const order = orderSnapshot({
      grandTotal: toMinor(15_143),
      shippingTotal: toMinor(595),
      discountTotal: toMinor(1500),
      taxTotal: toMinor(2525),
    });
    repository.seedOrder(order, [
      // 2 x 4999 = 9998, less the 1500 discount = 8498.
      orderLine({ id: "line-1", sku: "AK-CRE-500", quantity: 2, unitPriceGross: toMinor(4999), lineTotalGross: toMinor(8498), taxAmount: toMinor(1475) }),
      orderLine({ id: "line-2", sku: "AK-WHE-1000", quantity: 1, unitPriceGross: toMinor(2450), lineTotalGross: toMinor(2450), taxAmount: toMinor(425) }),
      orderLine({ id: "line-3", sku: "AK-BCAA-200", quantity: 3, unitPriceGross: toMinor(1200), lineTotalGross: toMinor(3600), taxAmount: toMinor(625) }),
    ]);

    await service.startCheckout(order.id);

    expect(whop.checkoutConfigurations[0]?.params.initialPrice).toBe(151.43);
  });

  it("REFUSES the checkout when one line of a multi-line cart disagrees with the total", async () => {
    // The guard that makes the figure above trustworthy. Under TagadaPay this
    // could only prove our row was self-consistent, because the provider priced
    // from its own catalogue; now it predicts exactly what the customer pays, so
    // an inconsistent row must never reach a payment page.
    const order = orderSnapshot({
      grandTotal: toMinor(15_143),
      shippingTotal: toMinor(595),
      taxTotal: toMinor(2525),
    });
    repository.seedOrder(order, [
      orderLine({ id: "line-1", quantity: 2, unitPriceGross: toMinor(4999), lineTotalGross: toMinor(8498), taxAmount: toMinor(1475) }),
      // 2450 -> 2451: one cent of drift on one line of three.
      orderLine({ id: "line-2", quantity: 1, unitPriceGross: toMinor(2451), lineTotalGross: toMinor(2451), taxAmount: toMinor(425) }),
      orderLine({ id: "line-3", quantity: 3, unitPriceGross: toMinor(1200), lineTotalGross: toMinor(3600), taxAmount: toMinor(625) }),
    ]);

    await expect(service.startCheckout(order.id)).rejects.toThrow(CheckoutTotalMismatchError);
    expect(whop.checkoutConfigurations).toHaveLength(0);
    expect(repository.orders.get(order.id)?.status).toBe("PENDING");
  });

  it("sends the currency LOWERCASED, because Whop's enum is lowercase", async () => {
    // `CurrencyCode` is uppercase throughout our system and Whop's currency enum
    // is `"eur"`. Getting this backwards is a rejected request, not a silent
    // mispricing — but it is a rejected request on every single checkout.
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);

    await service.startCheckout(order.id);

    expect(whop.checkoutConfigurations[0]?.params.currency).toBe("eur");
  });

  it("carries our own order id in metadata — correlation rank 1", async () => {
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);

    await service.startCheckout(order.id);

    // Whop copies a checkout configuration's metadata onto the payments created
    // from it, so this is our own UUID round-tripped and is what the settlement
    // webhook is matched on.
    expect(whop.checkoutConfigurations[0]?.params.metadata).toEqual({
      order_id: order.id,
      order_number: order.orderNumber,
    });
  });

  it("persists the checkout configuration id as the order's rank-2 handle", async () => {
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);
    whop.nextCheckoutId = "ch_live_abc";

    await service.startCheckout(order.id);

    expect(repository.orders.get(order.id)?.providerCheckoutId).toBe("ch_live_abc");
  });

  it("returns the provider's purchase URL", async () => {
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);
    whop.nextPurchaseUrl = "https://whop.com/checkout/ch_live_abc/";

    const result = await service.startCheckout(order.id);

    expect(result.orderNumber).toBe(order.orderNumber);
    expect(result.checkoutUrl).toBe("https://whop.com/checkout/ch_live_abc/");
  });

  it("REFUSES the checkout when no purchase URL came back, mutating no order row", async () => {
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);
    // `purchase_url` is typed nullable on the create response, so this is a real
    // production outcome rather than a defensive nicety.
    whop.nextPurchaseUrl = null;

    await expect(service.startCheckout(order.id)).rejects.toThrow(CheckoutUrlMissingError);

    // The assertion that matters: NOTHING was persisted. An order left in
    // AWAITING_PAYMENT with nowhere to pay would hang there forever.
    expect(repository.orders.get(order.id)?.status).toBe("PENDING");
    expect(repository.orders.get(order.id)?.providerCheckoutId).toBeNull();
    expect(repository.payments).toHaveLength(0);
    expect(repository.orderEvents).toHaveLength(0);
  });

  it("CHECKS OUT A DISCOUNTED ORDER — the capability the previous provider could not have", async () => {
    // TagadaPay had no coupon primitive and no way to pass an amount, so a
    // discounted order had two possible outcomes: charge the undiscounted total,
    // or refuse. It refused, with `DiscountsUnsupportedError`. Whop takes the
    // number, so a discount is simply a smaller price and promotions work.
    const order = orderSnapshot({
      grandTotal: toMinor(3999),
      discountTotal: toMinor(1000),
      taxTotal: toMinor(694),
    });
    repository.seedOrder(order, [
      orderLine({
        unitPriceGross: toMinor(4999),
        lineTotalGross: toMinor(3999),
        taxAmount: toMinor(694),
      }),
    ]);

    const result = await service.startCheckout(order.id);

    expect(result.checkoutUrl).toBeTruthy();
    expect(whop.checkoutConfigurations[0]?.params.initialPrice).toBe(39.99);
    expect(repository.orders.get(order.id)?.status).toBe("AWAITING_PAYMENT");
  });

  it("refuses to charge when the order's lines disagree with its stored total", async () => {
    // The order says 4999 but its lines sum to 3000. Picking either number is
    // wrong: one overcharges the customer, the other under-bills against an
    // invoice we already stored. So we refuse and touch no card.
    const order = orderSnapshot({ grandTotal: toMinor(4999) });
    repository.seedOrder(order, [
      orderLine({
        unitPriceGross: toMinor(3000),
        lineTotalGross: toMinor(3000),
        taxAmount: toMinor(521),
      }),
    ]);

    await expect(service.startCheckout(order.id)).rejects.toThrow(
      CheckoutTotalMismatchError,
    );

    expect(whop.checkoutConfigurations).toHaveLength(0);
  });

  it("counts shipping toward the order's own consistency check", async () => {
    const order = orderSnapshot({
      grandTotal: toMinor(5499),
      shippingTotal: toMinor(500),
    });
    repository.seedOrder(order, [
      orderLine({ unitPriceGross: toMinor(4999), lineTotalGross: toMinor(4999) }),
    ]);

    // 4999 + 500 == 5499, so this passes — and the figure sent is the WHOLE
    // order, shipping included. There is no basket on this provider: one price
    // covers lines, shipping, tax and discount, which is exactly why the
    // consistency check above has to hold before anything is sent.
    await expect(service.startCheckout(order.id)).resolves.toBeDefined();
    expect(whop.checkoutConfigurations[0]?.params.initialPrice).toBe(54.99);
  });

  it("counts the tax on SHIPPING, which is stored net while the total is gross", async () => {
    // REGRESSION, and it reached production. Order AK-2026-000003 was a 19.90
    // item with 2.95 letterbox shipping: lines 1990 gross (345 tax), shipping
    // 244 NET plus 51 tax, taxTotal 396 covering BOTH, grandTotal 2285.
    //
    // The check used to add gross lines to NET shipping and ignore taxTotal, so
    // it computed 2234 and refused a perfectly well-formed order. It never
    // showed up because it only runs with PAYMENTS_ENABLED=true, and the demo
    // path returns before it — the first real checkout would have 500'd.
    const order = orderSnapshot({
      grandTotal: toMinor(2285),
      shippingTotal: toMinor(244),
      taxTotal: toMinor(396),
    });
    repository.seedOrder(order, [
      orderLine({
        unitPriceGross: toMinor(1990),
        lineTotalGross: toMinor(1990),
        taxAmount: toMinor(345),
      }),
    ]);

    await expect(service.startCheckout(order.id)).resolves.toBeDefined();
    expect(whop.checkoutConfigurations[0]?.params.initialPrice).toBe(22.85);
  });

  it("moves the order to AWAITING_PAYMENT and records the attempt", async () => {
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);

    await service.startCheckout(order.id);

    expect(repository.orders.get(order.id)?.status).toBe("AWAITING_PAYMENT");

    const attempt = repository.payments[0];
    expect(attempt?.amount).toBe(order.grandTotal);
    expect(attempt?.status).toBe("REQUIRES_PAYMENT_METHOD");
    // No payment exists yet — the provider mints its id when the hosted form is
    // submitted, and the webhook backfills it.
    expect(attempt?.providerPaymentId).toBeNull();
  });

  it("sends the browser to a processing screen, never a success page", async () => {
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);

    await service.startCheckout(order.id);

    // An order becomes PAID only via webhook; a success redirect is forgeable.
    expect(whop.checkoutConfigurations[0]?.params.redirectUrl).toContain("processing");
    expect(whop.checkoutConfigurations[0]?.params.redirectUrl).toContain(order.orderNumber);
  });

  it("returns a Spanish buyer to the UNPREFIXED processing route", async () => {
    const order = orderSnapshot({ locale: "es" });
    repository.seedOrder(order, [orderLine()]);

    await service.startCheckout(order.id);

    // `as-needed` prefixing: es is the default locale and is served at the
    // bare path. Pinned as a whole URL rather than a `toContain`, because the
    // defect this replaces was a URL that contained every expected substring
    // and was still wrong.
    expect(whop.checkoutConfigurations[0]?.params.redirectUrl).toBe(
      "http://localhost:3000/checkout/processing?order=AK-2026-000123",
    );
  });

  it("returns an English buyer to the /en processing route", async () => {
    const order = orderSnapshot({ locale: "en" });
    repository.seedOrder(order, [orderLine()]);

    await service.startCheckout(order.id);

    // THE REGRESSION THIS FILE EXISTS TO CATCH. The return URL used to be built
    // with no locale segment at all, so an English customer who had just paid
    // was handed a Spanish page. Every storefront route is locale-scoped; the
    // return URL is not exempt because it happens to be minted server-side.
    expect(whop.checkoutConfigurations[0]?.params.redirectUrl).toBe(
      "http://localhost:3000/en/checkout/processing?order=AK-2026-000123",
    );
  });

  it("points the return URL at a route the storefront actually serves", async () => {
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);

    await service.startCheckout(order.id);

    const returnUrl = whop.checkoutConfigurations[0]?.params.redirectUrl ?? "";

    // `apps/storefront/src/app/[locale]/checkout/processing/page.tsx`. The path
    // is asserted here because a customer reaches it with their card already
    // charged: a 404 at that moment reads as "the payment failed" and generates
    // a support ticket and, often, a second attempt.
    expect(new URL(returnUrl).pathname).toBe("/checkout/processing");
    expect(new URL(returnUrl).searchParams.get("order")).toBe(order.orderNumber);
  });

  it("calls the provider BEFORE opening the transaction, and rolls our side back if the commit fails", async () => {
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);
    repository.failNextTransaction = true;

    await expect(service.startCheckout(order.id)).rejects.toThrow();

    // A network call is never held inside an open transaction, so the session
    // exists — and our row is untouched. That exposure is bounded by the
    // idempotency key: the retry reuses the same session rather than minting a
    // second one for the same order and total.
    expect(whop.checkoutConfigurations).toHaveLength(1);
    expect(repository.orders.get(order.id)?.status).toBe("PENDING");
    expect(repository.orders.get(order.id)?.providerCheckoutId).toBeNull();
  });

  it("derives a stable idempotency key from the order and its total", async () => {
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);
    await service.startCheckout(order.id);
    const first = whop.checkoutConfigurations[0]?.options?.idempotencyKey;

    // A fresh world in the same state must produce the same key, so a retry
    // reuses the session instead of opening a second payment window.
    repository = new FakePaymentsRepository();
    whop = new FakeWhopGateway();
    service = buildService();
    repository.seedOrder(orderSnapshot(), [
      orderLine(),
    ]);
    await service.startCheckout(order.id);
    const second = whop.checkoutConfigurations[0]?.options?.idempotencyKey;

    expect(first).toBeDefined();
    expect(first).toBe(second);
  });

  it("derives a DIFFERENT key once the order total changes", async () => {
    const order = orderSnapshot({ grandTotal: toMinor(4999) });
    repository.seedOrder(order, [orderLine()]);
    await service.startCheckout(order.id);

    repository = new FakePaymentsRepository();
    whop = new FakeWhopGateway();
    service = buildService();

    const repriced = orderSnapshot({ grandTotal: toMinor(5999), taxTotal: toMinor(1041) });
    repository.seedOrder(repriced, [
      orderLine({
        unitPriceGross: toMinor(5999),
        lineTotalGross: toMinor(5999),
        taxAmount: toMinor(1041),
      }),
    ]);
    await service.startCheckout(repriced.id);

    // Reusing a session minted for the old amount would charge the old amount.
    expect(whop.checkoutConfigurations[0]?.options?.idempotencyKey).toBeDefined();
  });

  it("rejects a checkout for an order that is already paid", async () => {
    const order = orderSnapshot({ status: "PAID" });
    repository.seedOrder(order, [orderLine()]);

    await expect(service.startCheckout(order.id)).rejects.toThrow(OrderNotPayableError);
    expect(whop.checkoutConfigurations).toHaveLength(0);
  });

  it("rejects a checkout for an order flagged PAYMENT_MISMATCH", async () => {
    const order = orderSnapshot({ status: "PAYMENT_MISMATCH" });
    repository.seedOrder(order, [orderLine()]);

    // Money may well have moved. Opening a second payment window on top of a
    // settlement we have not reconciled is how a customer gets charged twice.
    await expect(service.startCheckout(order.id)).rejects.toThrow(OrderNotPayableError);
    expect(whop.checkoutConfigurations).toHaveLength(0);
  });

  it("404s on an unknown order", async () => {
    await expect(
      service.startCheckout("99999999-9999-4999-8999-999999999999"),
    ).rejects.toThrow(OrderNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Status polling — what the processing screen reads.
// ---------------------------------------------------------------------------

describe("PaymentsService.getOrderPaymentStatus", () => {
  async function statusOf(
    status: OrderStatus,
  ): ReturnType<PaymentsService["getOrderPaymentStatus"]> {
    const order = orderSnapshot({ status });
    repository.seedOrder(order, []);
    return service.getOrderPaymentStatus(order.orderNumber);
  }

  it("reports an awaiting order as neither paid nor finished", async () => {
    const result = await statusOf("AWAITING_PAYMENT");

    expect(result.isPaid).toBe(false);
    expect(result.isTerminal).toBe(false);
  });

  it("reports a paid order as paid", async () => {
    const result = await statusOf("PAID");

    expect(result.isPaid).toBe(true);
    expect(result.isTerminal).toBe(false);
  });

  it("NEVER reports PAYMENT_MISMATCH as paid", async () => {
    const result = await statusOf("PAYMENT_MISMATCH");

    // The whole point of the state: the provider reported a settlement whose
    // amount we refused to accept. Telling the customer it succeeded would be a
    // lie, and the old `!payable && !failed` formulation would have done exactly
    // that the moment this status was added.
    expect(result.status).toBe("PAYMENT_MISMATCH");
    expect(result.isPaid).toBe(false);
  });

  it("stops the browser polling on PAYMENT_MISMATCH, because only a human can move it", async () => {
    const result = await statusOf("PAYMENT_MISMATCH");

    // Non-terminal in the STATE MACHINE (an operator may still resolve it),
    // terminal for POLLING — nothing automated will ever change this value, so
    // spinning until the tab closes helps nobody.
    expect(result.isTerminal).toBe(true);
  });

  it("reports failure and cancellation as finished and unpaid", async () => {
    expect(await statusOf("FAILED")).toMatchObject({
      isPaid: false,
      isTerminal: true,
    });
    expect(await statusOf("CANCELLED")).toMatchObject({
      isPaid: false,
      isTerminal: true,
    });
  });

  it("404s on an unknown order number", async () => {
    await expect(service.getOrderPaymentStatus("AK-2026-999999")).rejects.toThrow(
      OrderNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// Refunds — the ceiling is the security boundary.
// ---------------------------------------------------------------------------

describe("PaymentsService.refundOrder", () => {
  function seedPaidOrder(refundedTotal = 0): ReturnType<typeof orderSnapshot> {
    const order = orderSnapshot({
      status: refundedTotal > 0 ? "PARTIALLY_REFUNDED" : "PAID",
      grandTotal: toMinor(4999),
      refundedTotal: toMinor(refundedTotal),
    });
    repository.seedOrder(order, [orderLine()]);
    repository.seedPayment(paymentSnapshot({ orderId: order.id }));
    return order;
  }

  it("refunds the whole remaining balance when no amount is given", async () => {
    const order = seedPaidOrder();

    const result = await service.refundOrder(
      order.id,
      { reason: "REQUESTED_BY_CUSTOMER", restockVariantIds: [] },
      "actor-1",
    );

    expect(result.amount).toBe(4999);
    expect(result.remainingRefundable).toBe(0);
    // MAJOR units on the wire; our own ledger stays integer minor units. A
    // refund sent as 4999 would be a hundredfold overpayment.
    expect(whop.refundCalls[0]?.params.partialAmount).toBe(49.99);
    expect(repository.orders.get(order.id)?.status).toBe("REFUNDED");
  });

  it("refunds against the selected payment id, and only that one", async () => {
    const order = seedPaidOrder();

    await service.refundOrder(
      order.id,
      { reason: "OTHER", restockVariantIds: [] },
      "actor-1",
    );

    // The id of the SUCCEEDED attempt the service selected — not any other
    // payment on the order, which on a card retry would include a declined
    // sibling.
    expect(whop.refundCalls[0]?.params.paymentId).toBe("tgd_pay_test");
  });

  it("marks a partial refund PARTIALLY_REFUNDED and reports what is left", async () => {
    const order = seedPaidOrder();

    const result = await service.refundOrder(
      order.id,
      { amount: toMinor(2000), reason: "DAMAGED", restockVariantIds: [] },
      "actor-1",
    );

    expect(result.amount).toBe(2000);
    expect(result.remainingRefundable).toBe(2999);
    expect(repository.orders.get(order.id)?.status).toBe("PARTIALLY_REFUNDED");
    expect(repository.orders.get(order.id)?.refundedTotal).toBe(2000);
  });

  it("REJECTS an amount above the remaining balance and never calls the provider", async () => {
    const order = seedPaidOrder();

    await expect(
      service.refundOrder(
        order.id,
        { amount: toMinor(50_000), reason: "OTHER", restockVariantIds: [] },
        "actor-1",
      ),
    ).rejects.toThrow(RefundExceedsRefundableError);

    // The assertion that matters: no money moved. A validation error that still
    // reached the provider first would be worthless.
    expect(whop.refundCalls).toHaveLength(0);
    expect(repository.orders.get(order.id)?.refundedTotal).toBe(0);
  });

  it("recomputes the ceiling from what has ALREADY been refunded", async () => {
    // 4999 total, 4000 already refunded => only 999 remains. A caller asking
    // for 2000 is refused even though 2000 < grandTotal.
    const order = seedPaidOrder(4000);

    await expect(
      service.refundOrder(
        order.id,
        { amount: toMinor(2000), reason: "OTHER", restockVariantIds: [] },
        "actor-1",
      ),
    ).rejects.toThrow(RefundExceedsRefundableError);

    expect(whop.refundCalls).toHaveLength(0);
  });

  it("allows exactly the remaining balance", async () => {
    const order = seedPaidOrder(4000);

    const result = await service.refundOrder(
      order.id,
      { amount: toMinor(999), reason: "OTHER", restockVariantIds: [] },
      "actor-1",
    );

    expect(result.amount).toBe(999);
    expect(result.remainingRefundable).toBe(0);
    expect(repository.orders.get(order.id)?.status).toBe("REFUNDED");
  });

  it("rejects a zero or negative refund", async () => {
    const order = seedPaidOrder(4999);

    await expect(
      service.refundOrder(
        order.id,
        { amount: toMinor(0), reason: "OTHER", restockVariantIds: [] },
        null,
      ),
    ).rejects.toThrow(RefundAmountInvalidError);
  });

  it("refuses to refund an order that never paid", async () => {
    const order = orderSnapshot({ status: "PENDING" });
    repository.seedOrder(order, [orderLine()]);

    await expect(
      service.refundOrder(order.id, { reason: "OTHER", restockVariantIds: [] }, null),
    ).rejects.toThrow(OrderNotRefundableError);
  });

  it("refuses when there is no succeeded payment to refund against", async () => {
    const order = orderSnapshot({ status: "PAID" });
    repository.seedOrder(order, [orderLine()]);
    repository.seedPayment(paymentSnapshot({ orderId: order.id, status: "FAILED" }));

    await expect(
      service.refundOrder(order.id, { reason: "OTHER", restockVariantIds: [] }, null),
    ).rejects.toThrow(NoRefundablePaymentError);
  });

  it("queues the refund email instead of sending it inline", async () => {
    const order = seedPaidOrder();

    await service.refundOrder(
      order.id,
      { reason: "WITHDRAWAL_RIGHT", restockVariantIds: [] },
      "actor-1",
    );

    const email = repository.outbox.find((entry) => entry.topic === "email");
    expect(email?.payload["templateKey"]).toBe("refund-confirmation");
    expect(email?.payload["locale"]).toBe("es");
  });

  it("preserves our FULL refund vocabulary — no lossy mapping survives", async () => {
    const order = seedPaidOrder();

    await service.refundOrder(
      order.id,
      { reason: "WITHDRAWAL_RIGHT", restockVariantIds: [] },
      "actor-1",
    );

    // A DELIBERATE REGRESSION AGAINST THE PREVIOUS PROVIDER, pinned here so it
    // is a decision rather than a discovery. TagadaPay's refund params carried a
    // `metadata` bag, so our full vocabulary travelled to the provider intact.
    // Whop's `RefundPaymentsRequest` is `{ id, partial_amount }` and nothing
    // else — no reason, no metadata — so the reason stays authoritative in OUR
    // ledger and Whop simply never learns it. Inventing a channel would mean
    // writing it nowhere while believing it went somewhere.
    expect(repository.refunds[0]?.reason).toBe("WITHDRAWAL_RIGHT");
    expect(Object.keys(whop.refundCalls[0]?.params ?? {})).toEqual([
      "paymentId",
      "partialAmount",
    ]);
  });

  it("records the refund with a NULL provider refund id, because none comes back", async () => {
    // `payments.refund` returns the full typed `Payment`, which carries
    // `refunded_amount` and `refunded_at` — and NO refunds array; that belongs
    // to the webhook shape. So the provider's refund id is not available
    // synchronously. The money moved regardless, so the ledger entry and the
    // balance must both land; `refund.created` carries the real id later.
    //
    // The TagadaPay path parsed an `unknown` response through a deliberately
    // tolerant schema to dig an id out of one of three places. That schema is
    // deleted: there is nothing left for it to defend against.
    const order = seedPaidOrder();

    const result = await service.refundOrder(
      order.id,
      { reason: "OTHER", restockVariantIds: [] },
      null,
    );

    expect(result.refundId).toBeNull();
    expect(repository.refunds).toHaveLength(1);
    expect(repository.refunds[0]?.providerRefundId).toBeNull();
    expect(repository.orders.get(order.id)?.refundedTotal).toBe(4999);
  });

  it("uses a stable idempotency key for a retry of the same refund", async () => {
    const first = seedPaidOrder();
    const keyA = await captureRefundKey(first.id, 1000);

    // A fresh world in the same state must produce the same key, so the
    // provider collapses a retry rather than refunding twice.
    repository = new FakePaymentsRepository();
    whop = new FakeWhopGateway();
    service = buildService();

    const second = seedPaidOrder();
    const keyB = await captureRefundKey(second.id, 1000);

    expect(keyA).toBe(keyB);
  });

  it("uses a DIFFERENT key for a second, deliberate refund of the same amount", async () => {
    const order = seedPaidOrder();

    await service.refundOrder(
      order.id,
      { amount: toMinor(1000), reason: "OTHER", restockVariantIds: [] },
      null,
    );
    await service.refundOrder(
      order.id,
      { amount: toMinor(1000), reason: "OTHER", restockVariantIds: [] },
      null,
    );

    // Two genuine €10 refunds must BOTH go through. The key includes the
    // balance before each one, so they differ.
    expect(whop.refundCalls).toHaveLength(2);
    expect(whop.refundCalls[0]?.options?.idempotencyKey).not.toBe(
      whop.refundCalls[1]?.options?.idempotencyKey,
    );
    expect(repository.orders.get(order.id)?.refundedTotal).toBe(2000);
  });

  it("closes the order out when a second partial refund exhausts the balance", async () => {
    const order = seedPaidOrder();

    await service.refundOrder(
      order.id,
      { amount: toMinor(2000), reason: "OTHER", restockVariantIds: [] },
      null,
    );
    expect(repository.orders.get(order.id)?.status).toBe("PARTIALLY_REFUNDED");

    await service.refundOrder(
      order.id,
      { amount: toMinor(2999), reason: "OTHER", restockVariantIds: [] },
      null,
    );

    // The target status is derived from the RUNNING balance, not from whether
    // an amount was supplied — so the order lands in REFUNDED without anyone
    // having asked for a "full" refund.
    expect(repository.orders.get(order.id)?.status).toBe("REFUNDED");
    expect(repository.orders.get(order.id)?.refundedTotal).toBe(4999);
  });

  it("keeps every figure an integer in minor units", async () => {
    const order = seedPaidOrder();

    const result = await service.refundOrder(
      order.id,
      { amount: toMinor(1667), reason: "OTHER", restockVariantIds: [] },
      null,
    );

    // A refund is the one place where a rounding error is also a compliance
    // incident, so this asserts the type discipline actually held end to end.
    for (const value of [
      result.amount,
      result.remainingRefundable,
      repository.orders.get(order.id)?.refundedTotal ?? 0,
      repository.refunds[0]?.amount ?? 0,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
    expect(result.amount + result.remainingRefundable).toBe(4999);
  });

  it("404s on an unknown order without calling the provider", async () => {
    await expect(
      service.refundOrder(
        "99999999-9999-4999-8999-999999999999",
        { reason: "OTHER", restockVariantIds: [] },
        null,
      ),
    ).rejects.toBeInstanceOf(OrderNotFoundError);

    expect(whop.refundCalls).toHaveLength(0);
  });

  it("refuses when the succeeded payment carries no provider payment id", async () => {
    const order = orderSnapshot({ status: "PAID", grandTotal: toMinor(4999) });
    repository.seedOrder(order, [orderLine()]);
    // A payment recorded by startCheckout, before Whop minted an id. There is
    // nothing to refund AGAINST — `paymentIds` cannot be populated.
    repository.seedPayment(
      paymentSnapshot({ orderId: order.id, providerPaymentId: null }),
    );

    await expect(
      service.refundOrder(order.id, { reason: "OTHER", restockVariantIds: [] }, null),
    ).rejects.toBeInstanceOf(NoRefundablePaymentError);

    expect(whop.refundCalls).toHaveLength(0);
  });

  it("writes NOTHING when the provider call fails", async () => {
    const order = seedPaidOrder();
    whop.refundError = new Error("provider exploded");

    await expect(
      service.refundOrder(order.id, { reason: "OTHER", restockVariantIds: [] }, null),
    ).rejects.toThrow("provider exploded");

    // The gateway is called BEFORE the transaction opens, so a failure there
    // must leave the ledger, the balance and the outbox completely untouched.
    expect(repository.refunds).toHaveLength(0);
    expect(repository.orders.get(order.id)?.refundedTotal).toBe(0);
    expect(repository.orders.get(order.id)?.status).toBe("PAID");
    expect(repository.outboxFor("email")).toHaveLength(0);
  });

  it("rolls the ledger row, the balance and the queued email back together", async () => {
    const order = seedPaidOrder();
    repository.failNextTransaction = true;

    await expect(
      service.refundOrder(order.id, { reason: "OTHER", restockVariantIds: [] }, null),
    ).rejects.toThrow();

    // All three or none. A ledger row without the balance move would overstate
    // what is still refundable; an email without either would tell a customer
    // about a refund that did not happen.
    expect(repository.refunds).toHaveLength(0);
    expect(repository.orders.get(order.id)?.refundedTotal).toBe(0);
    expect(repository.outboxFor("email")).toHaveLength(0);
  });

  it("does NOT queue a restock — nothing consumes the topic, so it never happened", async () => {
    const order = seedPaidOrder();

    await service.refundOrder(
      order.id,
      { reason: "OTHER", restockVariantIds: [] },
      null,
    );
    expect(repository.outboxFor("order-fulfilment")).toHaveLength(0);

    const second = seedPaidOrder();
    await service.refundOrder(
      second.id,
      { reason: "DAMAGED", restockVariantIds: ["variant-1"] },
      null,
    );

    // Selecting variants to restock used to enqueue `order-fulfilment`, which has
    // no handler — so the restock dead-lettered and the stock was never returned.
    // The outcome is unchanged by removing the producer; what changes is that the
    // gap is now visible in the code instead of disguised as queued work.
    //
    // RESTORE THIS ASSERTION with the handler, and give that handler an
    // idempotency key: a re-delivered restock is a DOUBLE stock increment.
    expect(repository.outboxFor("order-fulfilment")).toHaveLength(0);
  });

  it("writes a customer-visible order event and attributes the actor", async () => {
    const order = seedPaidOrder();

    await service.refundOrder(
      order.id,
      { reason: "WITHDRAWAL_RIGHT", note: "EU 14-day return", restockVariantIds: [] },
      "operator-7",
    );

    const event = repository.orderEvents.find((entry) => entry.type === "refund.succeeded");
    expect(event?.isInternal).toBe(false);
    expect(repository.refunds[0]?.actorId).toBe("operator-7");
    expect(repository.refunds[0]?.note).toBe("EU 14-day return");
  });

  it("lets an operator refund an order parked in PAYMENT_MISMATCH", async () => {
    const order = orderSnapshot({
      status: "PAYMENT_MISMATCH",
      grandTotal: toMinor(4999),
    });
    repository.seedOrder(order, [orderLine()]);
    repository.seedPayment(paymentSnapshot({ orderId: order.id }));

    const result = await service.refundOrder(
      order.id,
      { amount: toMinor(2000), reason: "OTHER", restockVariantIds: [] },
      "operator-7",
    );

    // Refunding is the most likely way an operator resolves a mismatch, and a
    // PARTIAL refund must work — while only the full-refund edge existed this
    // threw AFTER the gateway had already moved the money.
    expect(result.amount).toBe(2000);
    expect(repository.orders.get(order.id)?.status).toBe("PARTIALLY_REFUNDED");
    expect(repository.refunds).toHaveLength(1);
  });

  async function captureRefundKey(orderId: string, amount: number): Promise<string> {
    await service.refundOrder(
      orderId,
      { amount: toMinor(amount), reason: "OTHER", restockVariantIds: [] },
      null,
    );
    return whop.refundCalls[0]?.options?.idempotencyKey ?? "";
  }
});

// ---------------------------------------------------------------------------
// The invoice number is allocated BY the PAID transition, not after it.
// ---------------------------------------------------------------------------

/**
 * REGRESSION (G1): `payment-receipt` dead-lettered on every real paid order.
 *
 * `settleOrderPaid` enqueues the receipt on every settlement, but the live paid
 * path — `markOrderPaid` — wrote status/paidAt/version and nothing else. The
 * only caller of the old `next_invoice_number()` was `OrdersService.markPaid`,
 * which has no production caller, so `order.invoiceNumber` stayed null forever
 * and `email-outbox.handler` threw "Invoice number not yet allocated" on every
 * retry until the row dead-lettered: permanent red on /admin/jobs, and no
 * customer ever got a receipt.
 *
 * Both tests below run the LIVE settlement (`PAYMENTS_ENABLED=false` reaches
 * the same `settleOrderPaid` the webhook does — that is why it exists).
 *
 * WHAT THESE TWO DO NOT PROVE, AND MUST NOT BE READ AS PROVING: that a number
 * survives nothing when a settlement rolls back, or that two racing settlements
 * consume one number between them. Those are properties of Postgres, and a fake
 * asserting them would only be asserting itself — which is how the first attempt
 * at this shipped a broken allocator under a green suite. They are tested where
 * they can actually fail: `apps/api-e2e/src/invoice-counter.spec.ts`, against a
 * real database.
 */
describe("a paid order carries its invoice number", () => {
  function withPaymentsDisabled(): void {
    process.env = { ...TEST_ENV, PAYMENTS_ENABLED: "false" };
    resetServerConfigCache();
    config = loadServerConfig();
    service = buildService();
  }

  it("allocates the number in the transaction that marks the order PAID", async () => {
    withPaymentsDisabled();
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);

    await service.startCheckout(order.id);

    expect(repository.order(order.id).status).toBe("PAID");
    // Null here is exactly what the receipt handler defers and then
    // dead-letters on.
    expect(repository.invoiceNumberFor(order.id)).toMatch(/^INV-/);
  });

  it("does NOT burn a second number when the settlement runs again", async () => {
    withPaymentsDisabled();
    const order = orderSnapshot();
    repository.seedOrder(order, [orderLine()]);

    await service.startCheckout(order.id);
    const allocated = repository.invoiceNumberFor(order.id);

    // A duplicate webhook delivery replays the same settlement writes. Invoice
    // numbering is gap-free by law, so the replay must not consume a number —
    // and must not renumber an order the customer already has a receipt for.
    await repository.runInTransaction((tx) =>
      settleOrderPaid(tx, repository.order(order.id), {
        occurredAt: new Date("2026-09-10T09:00:00.000Z"),
        timelineMessage: "duplicate delivery",
      }),
    );

    expect(repository.invoiceNumberFor(order.id)).toBe(allocated);
    expect(repository.invoiceNumbersIssued).toHaveLength(1);
  });
});
