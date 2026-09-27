import "reflect-metadata";
import { createLogger } from "@akai/observability";
import { beforeEach, describe, expect, it } from "vitest";

import { TransitionTableOrderState } from "../order-state.port";
import {
  FakePaymentsRepository,
  TEST_ORDER_ID,
  orderLine,
  orderSnapshot,
  paymentSnapshot,
  paymentSucceededEvent,
} from "./whop-webhook.fakes";
import {
  whopEventEnvelopeSchema,
  type WhopEventEnvelope,
} from "./whop-webhook.schemas";
import { WhopWebhookService } from "./whop-webhook.service";

/**
 * STOCK MOVEMENT, ISOLATED.
 *
 * Reservations are the one thing a webhook touches that cannot be reversed by an operator
 * with a database console: an over-decrement is a phantom out-of-stock, and an
 * over-release is an oversell. Each of the three settlement outcomes moves stock a
 * different way, and the PAYMENT_MISMATCH one is the counter-intuitive case that this
 * file exists to pin down.
 */

let repository: FakePaymentsRepository;
let service: WhopWebhookService;

const logger = createLogger({ level: "silent", nodeEnv: "test", serviceName: "api" });

let deliveries = 0;

function envelope(input: Record<string, unknown>): WhopEventEnvelope {
  return whopEventEnvelopeSchema.parse(input);
}

/** A fresh delivery id per call, so nothing collides in the dedupe table by accident. */
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

describe("PAID — the sale is confirmed", () => {
  it("commits the reservations and never releases them", async () => {
    await service.handleEvent(envelope(paymentSucceededEvent()), nextDeliveryId());

    expect(repository.committedReservationOrders).toEqual([TEST_ORDER_ID]);
    expect(repository.releasedReservationOrders).toHaveLength(0);
  });

  it("commits exactly once across a redelivery under a NEW delivery id", async () => {
    // The dedupe table cannot collapse these — different `webhook-id`s — so what
    // stops the second one double-committing stock is `isRedundantTransition`
    // reading a status the first transaction actually wrote.
    await service.handleEvent(envelope(paymentSucceededEvent()), nextDeliveryId());
    await service.handleEvent(envelope(paymentSucceededEvent()), nextDeliveryId());

    expect(repository.committedReservationOrders).toEqual([TEST_ORDER_ID]);
  });
});

describe("FAILED — the payment did not happen", () => {
  it("releases the reservations and never commits them", async () => {
    await service.handleEvent(
      envelope(paymentSucceededEvent({ type: "payment.failed" })),
      nextDeliveryId(),
    );

    expect(repository.releasedReservationOrders).toEqual([TEST_ORDER_ID]);
    expect(repository.committedReservationOrders).toHaveLength(0);
  });
});

describe("PAYMENT_MISMATCH — stock stays held", () => {
  /**
   * THE NON-OBVIOUS HALF.
   *
   * The event says a payment SUCCEEDED, just not for the amount we asked for. Money may
   * very well have moved. Releasing the reservations would put those units back on the
   * shelf while a possibly-paid order is still open — an oversell. Committing them would
   * record a sale at a price we never agreed to. So we do NEITHER, and the stock stays
   * reserved until an operator resolves the order.
   */
  for (const [label, dataOverrides] of [
    ["amount differs", { total: 0.01 }],
    ["currency differs", { currency: "usd" }],
  ] as const) {
    it(`neither commits nor releases when the ${label}`, async () => {
      await service.handleEvent(
        envelope(paymentSucceededEvent({}, dataOverrides)),
        nextDeliveryId(),
      );

      expect(repository.order().status).toBe("PAYMENT_MISMATCH");
      expect(repository.committedReservationOrders).toHaveLength(0);
      expect(repository.releasedReservationOrders).toHaveLength(0);
    });
  }

  it("neither commits nor releases when the amount is absent", async () => {
    const body = paymentSucceededEvent();
    delete (body["data"] as Record<string, unknown>)["total"];

    await service.handleEvent(envelope(body), nextDeliveryId());

    expect(repository.order().status).toBe("PAYMENT_MISMATCH");
    expect(repository.committedReservationOrders).toHaveLength(0);
    expect(repository.releasedReservationOrders).toHaveLength(0);
  });

  it("enqueues NO customer-facing or invoice job on a mismatch", async () => {
    await service.handleEvent(
      envelope(paymentSucceededEvent({}, { total: 0.01 })),
      nextDeliveryId(),
    );

    // Nothing gap-free-numbered and nothing the customer receives may fire on an
    // unreconciled payment. Only the operator alert.
    expect(repository.outboxFor("email")).toHaveLength(0);
    expect(repository.outboxFor("invoice-pdf")).toHaveLength(0);
    expect(repository.outboxFor("order-fulfilment")).toHaveLength(0);
    expect(repository.outboxFor("notifications")).toHaveLength(1);
  });
});
