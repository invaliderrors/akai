import type { SendcloudConfig } from "@akai/config";
import { createLogger } from "@akai/observability";
import { beforeEach, describe, expect, it } from "vitest";

import { LabelService } from "./label.service";
import { OrderFulfilmentOutboxHandler } from "./order-fulfilment.outbox-handler";
import { ORDER_FULFILMENT_TOPIC } from "./order-fulfilment.types";
import { SendcloudWriteThrottle } from "./sendcloud-write-throttle";
import {
  ACTOR_ID,
  FakeSendcloud,
  InMemoryFulfilmentRepository,
  InMemoryLabelStorage,
  ORDER_ID,
  announcedShipment,
  labelOrder,
} from "./testing/label-fakes";

const CONFIG: SendcloudConfig = {
  publicKey: "pub",
  secretKey: "sec",
  webhookSecret: "sec",
  senderAddressId: 920582,
  mode: "live",
  baseUrl: "https://panel.sendcloud.sc/api/v3",
};
const logger = createLogger({ level: "silent", nodeEnv: "test", serviceName: "labels-test" });

let repository: InMemoryFulfilmentRepository;
let sendcloud: FakeSendcloud;
let handler: OrderFulfilmentOutboxHandler;

function message(attempts = 1) {
  return { id: "outbox-1", topic: ORDER_FULFILMENT_TOPIC, payload: {}, attempts };
}

beforeEach(() => {
  repository = new InMemoryFulfilmentRepository([labelOrder()]);
  sendcloud = new FakeSendcloud();
  const labels = new LabelService(
    repository,
    sendcloud,
    new InMemoryLabelStorage(),
    new SendcloudWriteThrottle({ sleep: async () => undefined }),
    { sendcloud: CONFIG },
    { now: () => new Date("2026-09-24T12:00:00.000Z") },
    logger,
  );
  handler = new OrderFulfilmentOutboxHandler(labels, logger);
});

describe("OrderFulfilmentOutboxHandler", () => {
  it("owns the order-fulfilment topic", () => {
    expect(handler.topic).toBe("order-fulfilment");
  });

  it("buys the label for a create-label message", async () => {
    sendcloud.scriptAnnounce({ shipment: announcedShipment(), reused: false });

    await handler.handle({ action: "create-label", orderId: ORDER_ID, actorId: ACTOR_ID }, message());

    expect(repository.shipments).toHaveLength(1);
  });

  it("REDELIVERY BUYS NOTHING: the same message handled twice announces once", async () => {
    sendcloud.scriptAnnounce({ shipment: announcedShipment(), reused: false });
    const payload = { action: "create-label", orderId: ORDER_ID, actorId: ACTOR_ID };

    await handler.handle(payload, message(1));
    await handler.handle(payload, message(2));

    expect(sendcloud.announceCalls).toHaveLength(1);
    expect(repository.shipments).toHaveLength(1);
  });

  it("a redelivery after a crash between purchase and record re-sends the SAME reference and records once", async () => {
    // Attempt 1: Sendcloud buys the label, then storage (our side) fails.
    sendcloud.scriptAnnounce(
      { shipment: announcedShipment(), reused: false },
      // Attempt 2: the same reference answers 409 with the label already bought.
      { shipment: announcedShipment(), reused: true },
    );
    const storage = new InMemoryLabelStorage();
    storage.failPut = true;
    const labels = new LabelService(
      repository,
      sendcloud,
      storage,
      new SendcloudWriteThrottle({ sleep: async () => undefined }),
      { sendcloud: CONFIG },
      { now: () => new Date("2026-09-24T12:00:00.000Z") },
      logger,
    );
    const crashing = new OrderFulfilmentOutboxHandler(labels, logger);
    const payload = { action: "create-label", orderId: ORDER_ID, actorId: ACTOR_ID };

    await expect(crashing.handle(payload, message(1))).rejects.toThrow();
    storage.failPut = false;
    await crashing.handle(payload, message(2));

    const references = sendcloud.announceCalls.map((call) => call.externalReferenceId);
    expect(references).toEqual([ORDER_ID, ORDER_ID]);
    expect(repository.shipments).toHaveLength(1);
  });

  it("completes (does not throw) for an order that is no longer eligible", async () => {
    repository = new InMemoryFulfilmentRepository([labelOrder({ status: "CANCELLED" })]);
    const labels = new LabelService(
      repository,
      sendcloud,
      new InMemoryLabelStorage(),
      new SendcloudWriteThrottle({ sleep: async () => undefined }),
      { sendcloud: CONFIG },
      { now: () => new Date() },
      logger,
    );

    await expect(
      new OrderFulfilmentOutboxHandler(labels, logger).handle(
        { action: "create-label", orderId: ORDER_ID, actorId: null },
        message(),
      ),
    ).resolves.toBeUndefined();
    expect(sendcloud.announceCalls).toHaveLength(0);
  });

  it.each([
    ["an unknown action", { action: "prepare", orderId: ORDER_ID, actorId: null }],
    ["a missing order id", { action: "create-label", actorId: null }],
    ["a non-object", "create-label"],
  ])("dead-letters %s rather than marking it done", async (_label, payload) => {
    await expect(handler.handle(payload, message())).rejects.toThrow(/Unrecognised/);
  });
});
