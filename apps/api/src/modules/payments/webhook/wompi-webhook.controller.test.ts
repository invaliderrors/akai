import "reflect-metadata";
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import type { ServerEnv, WompiConfig } from "@akai/config";
import { createLogger } from "@akai/observability";
import {
  TEST_WOMPI_EVENTS_SECRET,
  buildForgedWompiEvent,
  buildSignedWompiEvent,
} from "@akai/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { TransitionTableOrderState } from "../order-state.port";
import {
  FakePaymentsRepository,
  orderLine,
  orderSnapshot,
  paymentSnapshot,
} from "../testing/payments.fakes";
import { wompiTransaction } from "../testing/wompi.fakes";
import { WompiSettlementService } from "../wompi-settlement.service";
import { WompiWebhookController } from "./wompi-webhook.controller";

const logger = createLogger({ level: "silent", nodeEnv: "test", serviceName: "api" });

const WOMPI: WompiConfig = {
  environment: "sandbox",
  publicKey: "pub_test_unit",
  privateKey: "prv_test_unit",
  integritySecret: "test_integrity_unit",
  eventsSecret: TEST_WOMPI_EVENTS_SECRET,
  apiBaseUrl: "https://sandbox.wompi.co/v1",
  checkoutUrl: "https://checkout.wompi.co/p/",
  eventEnvironment: "test",
};

let repository: FakePaymentsRepository;
let controller: WompiWebhookController;

function build(wompi: WompiConfig | null = WOMPI): WompiWebhookController {
  const config: Pick<ServerEnv, "wompi"> = { wompi };
  return new WompiWebhookController(
    new WompiSettlementService(repository, new TransitionTableOrderState(), logger),
    config,
    logger,
  );
}

/** Round-trip through JSON, as the body parser would hand it over. */
function asBody(value: unknown): unknown {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return parsed;
}

beforeEach(() => {
  repository = new FakePaymentsRepository();
  repository.seedOrder(orderSnapshot({ status: "AWAITING_PAYMENT" }), [orderLine()]);
  repository.seedPayment(paymentSnapshot());
  controller = build();
});

describe("WompiWebhookController — the security boundary", () => {
  it("settles a correctly signed APPROVED event", async () => {
    const event = buildSignedWompiEvent(wompiTransaction());

    const ack = await controller.handle(asBody(event), event.signature.checksum);

    expect(ack).toEqual({ received: true, outcome: "applied" });
    expect(repository.order().status).toBe("PAID");
  });

  it("REJECTS an event signed with the wrong secret, touching nothing", async () => {
    const forged = buildForgedWompiEvent(wompiTransaction());

    await expect(controller.handle(asBody(forged), undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repository.order().status).toBe("AWAITING_PAYMENT");
    expect(repository.providerEvents).toHaveLength(0);
  });

  it("REJECTS a signed event whose signed amount was tampered with", async () => {
    const event = buildSignedWompiEvent(wompiTransaction());
    const tampered = {
      ...event,
      data: { transaction: { ...event.data.transaction, amount_in_cents: 100 } },
    };

    await expect(controller.handle(asBody(tampered), undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("REJECTS a header checksum that disagrees with the body", async () => {
    const event = buildSignedWompiEvent(wompiTransaction());

    await expect(controller.handle(asBody(event), "0".repeat(64))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("REJECTS a body that cannot present a checksum at all", async () => {
    await expect(
      controller.handle({ event: "transaction.updated", data: {} }, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.handle("not json", undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("refuses with 503 (so Wompi retries) when no keys are configured — never verifies against nothing", async () => {
    const unconfigured = build(null);
    const event = buildSignedWompiEvent(wompiTransaction(), { secret: "" });

    await expect(unconfigured.handle(asBody(event), undefined)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("ignores a __proto__ smuggled into the transaction", async () => {
    // An event that carries NO amount must land in PAYMENT_MISMATCH; a
    // `__proto__` object must not be able to supply one.
    const event = buildSignedWompiEvent(
      { id: "tx_proto", status: "APPROVED", reference: "AK-2026-000123-1", currency: "COP" },
      { properties: ["transaction.id", "transaction.status"] },
    );
    const raw = JSON.stringify(event).replace(
      '"reference"',
      '"__proto__":{"amount_in_cents":8900000},"reference"',
    );

    await controller.handle(JSON.parse(raw), undefined);

    expect(repository.order().status).toBe("PAYMENT_MISMATCH");
  });
});

describe("WompiWebhookController — always 200 once authentic", () => {
  it("acks a PENDING heartbeat without touching the order", async () => {
    const event = buildSignedWompiEvent(wompiTransaction({ status: "PENDING" }));

    expect(await controller.handle(asBody(event), undefined)).toEqual({
      received: true,
      outcome: "applied",
    });
    expect(repository.order().status).toBe("AWAITING_PAYMENT");
  });

  it("acks a redelivery as a duplicate", async () => {
    const event = buildSignedWompiEvent(wompiTransaction());

    await controller.handle(asBody(event), undefined);
    const again = await controller.handle(asBody(event), undefined);

    expect(again.outcome).toBe("duplicate");
    expect(repository.committedReservationOrders).toHaveLength(1);
  });

  it("acks an unknown reference as unmatched", async () => {
    const event = buildSignedWompiEvent(wompiTransaction({ reference: "SOMEONE-ELSE-1" }));

    expect((await controller.handle(asBody(event), undefined)).outcome).toBe("unmatched");
  });

  it("acks an event type it does not handle", async () => {
    const event = buildSignedWompiEvent(wompiTransaction(), { event: "nequi_token.updated" });

    expect((await controller.handle(asBody(event), undefined)).outcome).toBe("ignored");
  });

  it("ignores a verified event stamped for the OTHER environment", async () => {
    const event = buildSignedWompiEvent(wompiTransaction(), { environment: "prod" });

    expect((await controller.handle(asBody(event), undefined)).outcome).toBe("ignored");
    expect(repository.order().status).toBe("AWAITING_PAYMENT");
  });

  it("acks a verified but unparsable transaction ONCE, with one alert", async () => {
    const event = buildSignedWompiEvent({ id: "tx_1", status: "APPROVED" });

    const first = await controller.handle(asBody(event), undefined);
    const second = await controller.handle(asBody(event), undefined);

    expect(first.outcome).toBe("unparsable");
    expect(second.outcome).toBe("unparsable");
    expect(repository.outboxFor("notifications")).toHaveLength(1);
    expect(repository.order().status).toBe("AWAITING_PAYMENT");
  });

  it("fails the order on a signed DECLINED event", async () => {
    const event = buildSignedWompiEvent(wompiTransaction({ status: "DECLINED" }));

    await controller.handle(asBody(event), undefined);

    expect(repository.order().status).toBe("FAILED");
    expect(repository.releasedReservationOrders).toHaveLength(1);
  });
});
