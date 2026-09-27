import "reflect-metadata";
import { createLogger } from "@akai/observability";
import { beforeEach, describe, expect, it } from "vitest";

import { TransitionTableOrderState } from "../order-state.port";
import {
  FakePaymentsRepository,
  TEST_ORDER_ID,
  TEST_PAYMENT_ID,
  orderLine,
  orderSnapshot,
  paymentSnapshot,
  paymentSucceededEvent,
} from "./whop-webhook.fakes";
import {
  whopEventEnvelopeSchema,
  type WhopEventEnvelope,
} from "./whop-webhook.schemas";
import { WhopWebhookService, verifySettlement } from "./whop-webhook.service";

let repository: FakePaymentsRepository;
let service: WhopWebhookService;
let deliveries = 0;

const logger = createLogger({ level: "silent", nodeEnv: "test", serviceName: "api" });

/** Build the envelope THROUGH the schema — the service only ever sees parsed input. */
function envelope(input: Record<string, unknown>): WhopEventEnvelope {
  return whopEventEnvelopeSchema.parse(input);
}

/**
 * A fresh `webhook-id` per call.
 *
 * The dedupe key is the TRANSPORT header, not a body field, so a suite that
 * wants two distinct deliveries of the same logical event gets them by calling
 * this twice — and one that wants a redelivery passes the same id explicitly.
 */
function nextDeliveryId(): string {
  deliveries += 1;
  return `msg_test_${deliveries}`;
}

beforeEach(() => {
  repository = new FakePaymentsRepository();
  repository.seedOrder(orderSnapshot(), [orderLine()]);
  repository.seedPayment(paymentSnapshot());

  service = new WhopWebhookService(repository, new TransitionTableOrderState(), logger);
});

// ---------------------------------------------------------------------------
// The amount check. REQUIRED, not an edge case.
// ---------------------------------------------------------------------------

describe("amount verification", () => {
  it("settles when the reported amount and currency match our recomputed total", async () => {
    const outcome = await service.handleEvent(envelope(paymentSucceededEvent()), nextDeliveryId());

    expect(outcome).toEqual({ status: "applied", type: "payment.succeeded" });
    expect(repository.order().status).toBe("PAID");
  });

  it("settles when `total` arrives as a Money envelope, not a bare number — the 2026-09-16 incident", async () => {
    // Production reality, not a hypothesis: a real delivery reported `total`
    // as `Whop.Money` ({amount, currency, decimals, display_decimals}) where
    // this SDK version's own types still declare a bare number for the
    // webhook plane. Two real orders sat in AWAITING_PAYMENT because of it.
    const outcome = await service.handleEvent(
      envelope(
        paymentSucceededEvent(
          {},
          { total: { amount: "49.99", currency: "eur", decimals: 2, display_decimals: 2 } },
        ),
      ),
      nextDeliveryId(),
    );

    expect(outcome).toEqual({ status: "applied", type: "payment.succeeded" });
    expect(repository.order().status).toBe("PAID");
  });

  it("does NOT mark the order paid when the reported amount differs", async () => {
    const outcome = await service.handleEvent(envelope(paymentSucceededEvent({}, { total: 0.01 })), nextDeliveryId());

    expect(outcome.status).toBe("applied");
    expect(repository.order().status).toBe("PAYMENT_MISMATCH");
    expect(repository.order().status).not.toBe("PAID");

    const event = repository.orderEvents.find((entry) => entry.type === "payment.mismatch");
    expect(event?.message).toContain("AMOUNT_DIFFERS");
    // Customer-visible: the buyer must be able to see why their order stalled.
    expect(event?.isInternal).toBe(false);
  });

  it("does NOT mark the order paid when the reported currency differs", async () => {
    await service.handleEvent(envelope(paymentSucceededEvent({}, { currency: "usd" })), nextDeliveryId());

    expect(repository.order().status).toBe("PAYMENT_MISMATCH");
    expect(
      repository.orderEvents.find((entry) => entry.type === "payment.mismatch")?.message,
    ).toContain("CURRENCY_DIFFERS");
  });

  it("does NOT mark the order paid when the amount is ABSENT — absence is never agreement", async () => {
    const body = paymentSucceededEvent();
    delete (body["data"] as Record<string, unknown>)["total"];

    await service.handleEvent(envelope(body), nextDeliveryId());

    expect(repository.order().status).toBe("PAYMENT_MISMATCH");
    expect(
      repository.orderEvents.find((entry) => entry.type === "payment.mismatch")?.message,
    ).toContain("AMOUNT_ABSENT");
  });

  it("treats a missing currency as AMOUNT_ABSENT too", async () => {
    const body = paymentSucceededEvent();
    delete (body["data"] as Record<string, unknown>)["currency"];

    await service.handleEvent(envelope(body), nextDeliveryId());

    expect(repository.order().status).toBe("PAYMENT_MISMATCH");
  });

  it("records the ledger row with the REPORTED amount, not ours", async () => {
    await service.handleEvent(envelope(paymentSucceededEvent({}, { total: 0.01 })), nextDeliveryId());

    const recorded = repository.payments.find(
      (entry) => entry.providerPaymentId === TEST_PAYMENT_ID,
    );

    // The ledger must show what Whop says AND what we say. Ours is on the order.
    // 0.01 major units is 1 minor unit — the row stores our unit, the provider's
    // figure.
    expect(recorded?.amount).toBe(1);
    expect(repository.order().grandTotal).toBe(4999);
  });

  it("alerts an operator on every mismatch", async () => {
    await service.handleEvent(envelope(paymentSucceededEvent({}, { total: 0.01 })), nextDeliveryId());

    const alerts = repository.outboxFor("notifications");

    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.payload).toMatchObject({
      kind: "payment-mismatch",
      reason: "AMOUNT_DIFFERS",
      // The provider's OWN figure in the provider's OWN unit, deliberately not
      // normalised: an operator reconciling this is comparing against what Whop
      // shows them, and a converted number would hide the discrepancy. A
      // string since `reportedAmountSchema` normalizes both the legacy
      // bare-number and the newer Money-envelope shape to one.
      reportedAmount: "0.01",
      expectedAmount: 4999,
      expectedCurrency: "EUR",
    });
  });

  it("does not promote an order already in PAYMENT_MISMATCH, even on a second SUCCEEDED", async () => {
    await service.handleEvent(envelope(paymentSucceededEvent({}, { total: 0.01 })), nextDeliveryId());
    expect(repository.order().status).toBe("PAYMENT_MISMATCH");

    // A different event id, so the dedupe table does not collapse it. The state machine
    // is what has to hold here.
    await service.handleEvent(envelope(paymentSucceededEvent({}, { total: 49.99 })), nextDeliveryId());

    expect(repository.order().status).toBe("PAYMENT_MISMATCH");
    expect(repository.committedReservationOrders).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PAYMENT_MISMATCH is an OPERATOR-ONLY hold. No automated handler may leave it.
// ---------------------------------------------------------------------------

describe("PAYMENT_MISMATCH is operator-only", () => {
  /** Park the order on operator hold the way production does: a wrong-amount settlement. */
  async function park(): Promise<void> {
    await service.handleEvent(envelope(paymentSucceededEvent({}, { total: 0.01 })), nextDeliveryId());
    expect(repository.order().status).toBe("PAYMENT_MISMATCH");
  }

  it("does not let a later FAILURE event release the stock the hold is keeping reserved", async () => {
    // The gap that was live: `ORDER_STATUS_TRANSITIONS` legalises
    // PAYMENT_MISMATCH -> FAILED and `isRedundantTransition` blocked only the PAID edge, so
    // an ordinary vendor retry passed both gates, set the order FAILED and called
    // `releaseReservationsForOrder`. That is the exact inverse of `applyMismatch`'s
    // documented invariant: money may have moved, so the stock stays held. Releasing it
    // hands the same units back to the shelf while a possibly-paid order is still open.
    await park();

    const outcome = await service.handleEvent(envelope(paymentSucceededEvent({ id: "evt_late_fail", type: "payment.failed" })), nextDeliveryId());

    // ACKed and deduped — the event really was delivered — but nothing moved.
    expect(outcome.status).toBe("applied");
    expect(repository.order().status).toBe("PAYMENT_MISMATCH");
    expect(repository.releasedReservationOrders).toHaveLength(0);
    expect(repository.committedReservationOrders).toHaveLength(0);
    // No "payment failed" email for an order the provider may well have charged.
    expect(repository.emailTemplates()).toHaveLength(0);
  });

  it("blocks payment/rejected and order/failed the same way", async () => {
    await park();

    for (const [id, type] of [
      ["evt_rej", "payment.failed"],
      ["evt_ord_fail", "payment.failed"],
    ] as const) {
      await service.handleEvent(envelope(paymentSucceededEvent({ id, type })), nextDeliveryId());
    }

    expect(repository.order().status).toBe("PAYMENT_MISMATCH");
    expect(repository.releasedReservationOrders).toHaveLength(0);
  });

  it("does not let a REFUND event walk the order out of the hold", async () => {
    await park();

    const outcome = await service.handleEvent(
      envelope(
        paymentSucceededEvent(
          { id: "evt_refund_on_hold", type: "refund.created" },
          { refunded_amount: 49.99 },
        ),
      ),
      nextDeliveryId(),
    );

    expect(outcome.status).toBe("applied");
    expect(repository.order().status).toBe("PAYMENT_MISMATCH");
    expect(repository.order().status).not.toBe("REFUNDED");
    // Nothing converged: reconciling a held order is the operator's decision, and the next
    // refund event reports Whop's CUMULATIVE total, so nothing is lost by waiting.
    expect(repository.order().refundedTotal).toBe(0);
    expect(repository.refunds).toHaveLength(0);
  });

  it("still ACKs and dedupes, so Whop does not retry-storm a held order", async () => {
    await park();

    const body = paymentSucceededEvent({ id: "evt_late_fail", type: "payment.failed" });

    // The SAME `webhook-id` both times — that is what a redelivery is.
    expect((await service.handleEvent(envelope(body), "msg_late_fail")).status).toBe("applied");
    expect((await service.handleEvent(envelope(body), "msg_late_fail")).status).toBe("duplicate");
    expect(repository.order().status).toBe("PAYMENT_MISMATCH");
  });
});

describe("verifySettlement (pure)", () => {
  const order = orderSnapshot();

  it("is case-insensitive on the currency code", () => {
    // Whop's enum is lowercase and `CurrencyCode` is uppercase, so this crosses
    // the case boundary on every single settlement.
    expect(
      verifySettlement(envelope(paymentSucceededEvent({}, { currency: "EUR" })), order).settle,
    ).toBe(true);
    expect(
      verifySettlement(envelope(paymentSucceededEvent({}, { currency: "eur" })), order).settle,
    ).toBe(true);
  });

  it("REFUSES an amount carrying more precision than the currency holds", () => {
    // Rounding 49.999 to 4999 would invent a cent the provider never charged and
    // silently agree with a total we never computed. `fromDecimalString` throws;
    // the predicate turns that into a refusal, not a 500.
    const verdict = verifySettlement(
      envelope(paymentSucceededEvent({}, { total: 49.999 })),
      order,
    );

    expect(verdict).toEqual({ settle: false, reason: "AMOUNT_ABSENT" });
  });

  it("refuses a currency that is not a valid ISO-4217 code at all", () => {
    const verdict = verifySettlement(
      envelope(paymentSucceededEvent({}, { currency: "€€€" })),
      order,
    );

    expect(verdict).toEqual({ settle: false, reason: "CURRENCY_DIFFERS" });
  });

  it("a Money-envelope total that does not match still refuses — the new shape is CHECKED, not bypassed", () => {
    const verdict = verifySettlement(
      envelope(
        paymentSucceededEvent(
          {},
          { total: { amount: "0.01", currency: "eur", decimals: 2, display_decimals: 2 } },
        ),
      ),
      order,
    );

    expect(verdict).toEqual({ settle: false, reason: "AMOUNT_DIFFERS" });
  });
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe("settlement", () => {
  it("commits reservations and enqueues only the job families that have consumers", async () => {
    await service.handleEvent(envelope(paymentSucceededEvent()), nextDeliveryId());

    expect(repository.order().status).toBe("PAID");
    expect(repository.committedReservationOrders).toEqual([TEST_ORDER_ID]);
    expect(repository.releasedReservationOrders).toHaveLength(0);

    expect(repository.emailTemplates()).toEqual([
      "order-confirmation",
      "payment-receipt",
      "admin-new-order",
    ]);
    // NOT ENQUEUED, and this assertion is inverted on purpose. `invoices` and
    // `fulfilment` are empty modules, so these topics have no handler and the
    // dispatcher dead-letters them: every settled order used to leave two rows
    // burning ~8 retries each. The producers come back in the same change as
    // their consumers — see order-settlement.ts.
    expect(repository.outboxFor("invoice-pdf")).toHaveLength(0);
    expect(repository.outboxFor("order-fulfilment")).toHaveLength(0);
  });

  it("stamps the settlement with the time the EVENT reports, not the time we processed it", async () => {
    const paidAt = new Date(Date.now() - 120_000).toISOString();

    await service.handleEvent(
      envelope(paymentSucceededEvent({}, { paid_at: paidAt })),
      nextDeliveryId(),
    );

    expect(repository.paidAt.get(TEST_ORDER_ID)?.toISOString()).toBe(paidAt);
  });

  it("falls back to now, rather than an Invalid Date, on an unparseable stamp", async () => {
    // The schema bounds these as short strings but does not prove they are
    // dates. An Invalid Date written into the ledger is worse than a settlement
    // time off by the delivery latency.
    await service.handleEvent(
      envelope(paymentSucceededEvent({}, { paid_at: "not-a-date" })),
      nextDeliveryId(),
    );

    expect(repository.paidAt.get(TEST_ORDER_ID)?.getTime()).not.toBeNaN();
  });

  it("treats a second settlement event for an already PAID order as a no-op", async () => {
    // DISTINCT delivery ids, so the dedupe table does not collapse them. What
    // holds here is `isRedundantTransition`.
    await service.handleEvent(envelope(paymentSucceededEvent()), nextDeliveryId());
    await service.handleEvent(envelope(paymentSucceededEvent()), nextDeliveryId());

    expect(repository.order().status).toBe("PAID");
    // Committed exactly once — a double decrement is a phantom stock loss.
    expect(repository.committedReservationOrders).toEqual([TEST_ORDER_ID]);
  });

  it("does NOT throw (or 500) when a second settlement for a PAID order carries no amount", async () => {
    await service.handleEvent(envelope(paymentSucceededEvent()), nextDeliveryId());
    expect(repository.order().status).toBe("PAID");

    // `order/paid` after `payment/succeeded` is routine, and it can arrive with no amount.
    // Absence would send a still-open order to PAYMENT_MISMATCH — but this order is already
    // resolved, so the late event must be an idempotent no-op, NOT an illegal
    // PAID -> PAYMENT_MISMATCH transition that throws out of the handler and 500s the
    // webhook (which would make TagadaPay retry the same 500 forever).
    const secondBody = paymentSucceededEvent({ id: "evt_order_paid", type: "payment.succeeded" });
    delete secondBody["amount"];

    const outcome = await service.handleEvent(envelope(secondBody), nextDeliveryId());

    expect(outcome.status).toBe("applied");
    expect(repository.order().status).toBe("PAID");
    // It never touched the mismatch machinery: no alert, no mismatch order event.
    expect(repository.outboxFor("notifications")).toHaveLength(0);
    expect(
      repository.orderEvents.find((entry) => entry.type === "payment.mismatch"),
    ).toBeUndefined();
  });

  it("does NOT throw (or 500) when a settlement arrives after the order is FULFILLING", async () => {
    // `applyPaid` enqueues the fulfilment job in the SAME transaction that marks the order
    // PAID, so the order can legitimately be FULFILLING (or beyond) by the time TagadaPay's
    // SECOND settlement event id — `payment/succeeded` then `order/paid`, each distinct and
    // uncollapsible by the dedupe table — lands. FULFILLING has no edge back to PAID, so
    // without the redundancy guard `assertTransition("FULFILLING", "PAID")` throws, the
    // webhook 500s, and the rolled-back provider_event row makes TagadaPay replay the same
    // 500 forever. The late event must be an idempotent no-op instead.
    repository.seedOrder(orderSnapshot({ status: "FULFILLING" }), [orderLine()]);

    const outcome = await service.handleEvent(envelope(paymentSucceededEvent({ id: "evt_order_paid", type: "payment.succeeded" })), nextDeliveryId());

    expect(outcome.status).toBe("applied");
    expect(repository.order().status).toBe("FULFILLING");
    // No second commit: the sale was already booked when the order first reached PAID.
    expect(repository.committedReservationOrders).toHaveLength(0);
    expect(repository.outboxFor("notifications")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

describe("dedupe", () => {
  it("runs the handler once and reports duplicate for a repeated delivery id", async () => {
    const body = paymentSucceededEvent();

    const first = await service.handleEvent(envelope(body), "msg_repeated");
    const second = await service.handleEvent(envelope(body), "msg_repeated");

    expect(first.status).toBe("applied");
    expect(second).toEqual({ status: "duplicate", type: "payment.succeeded" });
    expect(repository.handlerRuns).toBe(1);
    expect(repository.providerEvents).toHaveLength(1);
  });

  it("keys the dedupe row on the TRANSPORT delivery id, not a body field", async () => {
    // TagadaPay might supply no event id at all, so the key had to be a content
    // fingerprint and a `derived` column recorded how often that weaker path was
    // live. Whop sends `webhook-id` on every delivery, so the key is the header —
    // which is also what its own documentation tells integrators to store.
    const body = paymentSucceededEvent();
    delete body["id"];

    await service.handleEvent(envelope(body), "msg_from_the_header");

    expect(repository.providerEvents[0]?.id).toBe("msg_from_the_header");
    expect(repository.providerEvents[0]?.type).toBe("payment.succeeded");
  });
});

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

describe("correlation", () => {
  it("resolves by metadata.order_id — rank 1", async () => {
    const body = paymentSucceededEvent();
    delete (body["data"] as Record<string, unknown>)["checkout_configuration_id"];

    const outcome = await service.handleEvent(envelope(body), nextDeliveryId());

    expect(outcome.status).toBe("applied");
    expect(repository.order().status).toBe("PAID");
  });

  it("resolves by checkout_configuration_id when metadata is absent — rank 2", async () => {
    const body = paymentSucceededEvent();
    delete (body["data"] as Record<string, unknown>)["metadata"];

    const outcome = await service.handleEvent(envelope(body), nextDeliveryId());

    expect(outcome.status).toBe("applied");
    expect(repository.order().status).toBe("PAID");
  });

  it("prefers metadata.order_id over the checkout id", async () => {
    // A second order that would match by checkout id. Rank 1 must win.
    repository.seedOrder(
      orderSnapshot({
        id: "22222222-2222-4222-8222-222222222222",
        orderNumber: "AK-2026-000999",
        providerCheckoutId: "ch_other",
      }),
    );

    const body = paymentSucceededEvent({}, { checkout_configuration_id: "ch_other" });

    await service.handleEvent(envelope(body), nextDeliveryId());

    expect(repository.order(TEST_ORDER_ID).status).toBe("PAID");
    expect(repository.order("22222222-2222-4222-8222-222222222222").status).toBe(
      "AWAITING_PAYMENT",
    );
  });

  it("ACKs an uncorrelatable event as unmatched, changing nothing", async () => {
    const body = paymentSucceededEvent(
      {},
      {
        checkout_configuration_id: "ch_someone_elses",
        metadata: { order_id: "33333333-3333-4333-8333-333333333333" },
      },
    );

    const outcome = await service.handleEvent(envelope(body), nextDeliveryId());

    expect(outcome).toEqual({ status: "unmatched", type: "payment.succeeded" });
    expect(repository.order().status).toBe("AWAITING_PAYMENT");
    // The correlation key matched no order, so the dedupe row must have ROLLED
    // BACK with the transaction. If it committed, the redelivery below would be
    // swallowed.
    expect(repository.providerEvents).toHaveLength(0);
  });

  it("does NOT burn the dedupe key on a miss, so a later redelivery still applies", async () => {
    // A delivery that arrives before the order it names is visible — which is
    // exactly what Whop's "ordering is not guaranteed" means in practice.
    const unknownOrder = "44444444-4444-4444-8444-444444444444";
    const body = paymentSucceededEvent(
      {},
      { checkout_configuration_id: "ch_not_yet", metadata: { order_id: unknownOrder } },
    );

    const first = await service.handleEvent(envelope(body), "msg_redelivered");
    expect(first).toEqual({ status: "unmatched", type: "payment.succeeded" });
    // Rolled back: the delivery id is still free.
    expect(repository.providerEvents).toHaveLength(0);

    // The order becomes visible.
    repository.seedOrder(orderSnapshot({ id: unknownOrder }), [orderLine()]);

    // The SAME delivery id, redelivered, now matches and settles the order —
    // proof the first miss did not permanently poison this event's dedupe key.
    const second = await service.handleEvent(envelope(body), "msg_redelivered");
    expect(second.status).toBe("applied");
    expect(repository.order(unknownOrder).status).toBe("PAID");
    expect(repository.providerEvents).toHaveLength(1);
  });

  it("ACKs an event carrying NEITHER key as unmatched, without a transaction", async () => {
    const body = paymentSucceededEvent();
    const data = body["data"] as Record<string, unknown>;
    delete data["checkout_configuration_id"];
    delete data["metadata"];

    const outcome = await service.handleEvent(envelope(body), nextDeliveryId());

    expect(outcome).toEqual({ status: "unmatched", type: "payment.succeeded" });
    expect(repository.providerEvents).toHaveLength(0);
    expect(repository.handlerRuns).toBe(0);
  });

  it("ignores an event type it has no handler for", async () => {
    const outcome = await service.handleEvent(envelope(paymentSucceededEvent({ type: "payment.authorized" })), nextDeliveryId());

    expect(outcome.status).toBe("ignored");
    expect(repository.order().status).toBe("AWAITING_PAYMENT");
  });
});

// ---------------------------------------------------------------------------
// Failure and refund handlers
// ---------------------------------------------------------------------------

describe("failure", () => {
  it("fails the order and RELEASES the held stock", async () => {
    const outcome = await service.handleEvent(envelope(
        paymentSucceededEvent({
          id: "evt_fail",
          type: "payment.failed",
          failureCode: "card_declined",
          failureMessage: "Insufficient funds",
        }),
      ), nextDeliveryId());

    expect(outcome.status).toBe("applied");
    expect(repository.order().status).toBe("FAILED");
    expect(repository.releasedReservationOrders).toEqual([TEST_ORDER_ID]);
    expect(repository.committedReservationOrders).toHaveLength(0);
    expect(repository.emailTemplates()).toEqual(["payment-failed"]);
  });

  it("treats payment/rejected the same way", async () => {
    await service.handleEvent(envelope(paymentSucceededEvent({ id: "evt_rej", type: "payment.failed" })), nextDeliveryId());

    expect(repository.order().status).toBe("FAILED");
  });

  it("ignores a failure event arriving after the order is demonstrably paid", async () => {
    await service.handleEvent(envelope(paymentSucceededEvent()), nextDeliveryId());

    await service.handleEvent(envelope(paymentSucceededEvent({ id: "evt_late_fail", type: "payment.failed" })), nextDeliveryId());

    expect(repository.order().status).toBe("PAID");
    expect(repository.releasedReservationOrders).toHaveLength(0);
  });

  it("does NOT corrupt the settlement ledger row when a late failure arrives after PAID", async () => {
    await service.handleEvent(envelope(paymentSucceededEvent()), nextDeliveryId());

    const settled = repository.payments.find(
      (entry) => entry.providerPaymentId === TEST_PAYMENT_ID,
    );
    expect(settled?.status).toBe("SUCCEEDED");

    // A late, out-of-order payment/failed for the SAME payment id must leave the
    // settlement row untouched: the redundancy guard runs BEFORE any ledger write, so the
    // row is never flipped to FAILED behind an order that stays PAID. That disagreement is
    // exactly what moving the guard ahead of the write prevents.
    await service.handleEvent(envelope(paymentSucceededEvent({ id: "evt_late_fail", type: "payment.failed" })), nextDeliveryId());

    const after = repository.payments.find(
      (entry) => entry.providerPaymentId === TEST_PAYMENT_ID,
    );
    expect(after?.status).toBe("SUCCEEDED");
    expect(repository.order().status).toBe("PAID");
  });

  it("does NOT mutate a payment row belonging to a DIFFERENT order", async () => {
    // A second order, already settled, whose payment row carries its own provider id.
    const OTHER_ORDER_ID = "22222222-2222-4222-8222-222222222222";
    const OTHER_PAYMENT_ID = "tgd_pay_other";
    repository.seedOrder(
      orderSnapshot({
        id: OTHER_ORDER_ID,
        orderNumber: "AK-2026-000999",
        status: "PAID",
        providerCheckoutId: "ch_other",
      }),
    );
    repository.seedPayment(
      paymentSnapshot({
        id: "payment-other",
        orderId: OTHER_ORDER_ID,
        status: "SUCCEEDED",
        providerPaymentId: OTHER_PAYMENT_ID,
      }),
    );

    // A failure that correlates to OUR order (by metadata) but names the OTHER
    // order's payment id. The update is scoped to the correlated order, so the
    // other order's row must not move even though the provider id matches it.
    const body = paymentSucceededEvent(
      { type: "payment.failed" },
      { id: OTHER_PAYMENT_ID },
    );

    await service.handleEvent(envelope(body), nextDeliveryId());

    expect(repository.order().status).toBe("FAILED");
    expect(
      repository.payments.find((entry) => entry.providerPaymentId === OTHER_PAYMENT_ID)?.status,
    ).toBe("SUCCEEDED");
  });
});

describe("refund reconciliation", () => {
  beforeEach(async () => {
    await service.handleEvent(envelope(paymentSucceededEvent()), nextDeliveryId());
  });

  it("converges by DIFFERENCE, so a redelivered total is a no-op", async () => {
    // MAJOR units: 10.00 is a €10 refund against a €49.99 order.
    const refund = paymentSucceededEvent(
      { id: "evt_refund_1", type: "refund.created" },
      { refunded_amount: 10.0 },
    );

    await service.handleEvent(envelope(refund), nextDeliveryId());

    expect(repository.order().refundedTotal).toBe(1000);
    expect(repository.order().status).toBe("PARTIALLY_REFUNDED");
    expect(repository.refunds).toHaveLength(1);
    expect(repository.refunds[0]?.amount).toBe(1000);

    // The same CUMULATIVE total again under a new delivery id: nothing more is
    // owed. This is what makes the handler commutative under Whop's explicitly
    // unordered, up-to-12-attempt delivery.
    await service.handleEvent(envelope({ ...refund, id: "evt_refund_2" }), nextDeliveryId());

    expect(repository.order().refundedTotal).toBe(1000);
    expect(repository.refunds).toHaveLength(1);
  });

  it("moves to REFUNDED once the provider total reaches the grand total", async () => {
    await service.handleEvent(
      envelope(
        paymentSucceededEvent(
          { id: "evt_refund_full", type: "refund.updated" },
          { refunded_amount: 49.99 },
        ),
      ),
      nextDeliveryId(),
    );

    expect(repository.order().status).toBe("REFUNDED");
    expect(repository.order().refundedTotal).toBe(4999);
  });

  it("does nothing when the event carries no refunded_amount", async () => {
    await service.handleEvent(
      envelope(paymentSucceededEvent({ id: "evt_refund_empty", type: "refund.created" })),
      nextDeliveryId(),
    );

    expect(repository.order().refundedTotal).toBe(0);
    expect(repository.order().status).toBe("PAID");
  });

  it("reconciles the same way when refunded_amount arrives as a Money envelope", async () => {
    const refund = paymentSucceededEvent(
      { id: "evt_refund_money", type: "refund.created" },
      { refunded_amount: { amount: "10.00", currency: "eur", decimals: 2, display_decimals: 2 } },
    );

    await service.handleEvent(envelope(refund), nextDeliveryId());

    expect(repository.order().refundedTotal).toBe(1000);
    expect(repository.order().status).toBe("PARTIALLY_REFUNDED");
  });
});
