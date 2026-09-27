import { ConflictException } from "@nestjs/common";
import { RecordNotFoundError } from "@akai/db";
import { createLogger } from "@akai/observability";
import { PDFDocument } from "pdf-lib";
import { beforeEach, describe, expect, it } from "vitest";

import { SendcloudError } from "../sendcloud/sendcloud.errors";
import { FulfilmentAdminService } from "./fulfilment-admin.service";
import { SendcloudWriteThrottle } from "./sendcloud-write-throttle";
import {
  ACTOR_ID,
  FakeSendcloud,
  InMemoryFulfilmentRepository,
  InMemoryLabelStorage,
  labelOrder,
} from "./testing/label-fakes";

const logger = createLogger({ level: "silent", nodeEnv: "test", serviceName: "labels-test" });
const NOW = new Date("2026-09-24T12:00:00.000Z");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";
const E = "55555555-5555-4555-8555-555555555555";
const MISSING = "99999999-9999-4999-8999-999999999999";

let repository: InMemoryFulfilmentRepository;
let sendcloud: FakeSendcloud;
let storage: InMemoryLabelStorage;

function service(client: FakeSendcloud = sendcloud): FulfilmentAdminService {
  return new FulfilmentAdminService(
    repository,
    client,
    storage,
    new SendcloudWriteThrottle({ sleep: async () => undefined }),
    logger,
  );
}

async function labelFor(orderId: string, width: number): Promise<string> {
  const doc = await PDFDocument.create();
  doc.addPage([width, 420]);
  const key = `labels/${orderId}/${String(width)}.pdf`;
  await storage.put(key, await doc.save());
  const result = await repository.recordLabel({
    orderId,
    actorId: ACTOR_ID,
    sendcloudShipmentId: `sc-${orderId}-${String(width)}`,
    sendcloudParcelId: width,
    carrier: "InPost",
    trackingNumber: null,
    trackingUrl: null,
    statusCode: "READY_TO_SEND",
    labelObjectKey: key,
    now: NOW,
  });
  return result.shipmentId;
}

beforeEach(() => {
  repository = new InMemoryFulfilmentRepository([
    labelOrder({ id: A, orderNumber: "AK-2026-000001" }),
    labelOrder({ id: B, orderNumber: "AK-2026-000002", status: "AWAITING_PAYMENT" }),
    labelOrder({ id: C, orderNumber: "AK-2026-000003", sendcloudOptionCode: null }),
    labelOrder({ id: D, orderNumber: "AK-2026-000004", status: "FULFILLING" }),
    labelOrder({ id: E, orderNumber: "AK-2026-000005", parcelWeightGrams: 0 }),
  ]);
  sendcloud = new FakeSendcloud();
  storage = new InMemoryLabelStorage();
});

describe("enqueueLabels — bulk skip rules", () => {
  it("accepts the eligible, skips the rest with a reason, in request order", async () => {
    await labelFor(D, 300); // D already has a live label.

    const result = await service().enqueueLabels([D, MISSING, A, B, C, E], ACTOR_ID);

    expect(result).toEqual({
      accepted: ["AK-2026-000001"],
      skipped: [
        { orderId: D, orderNumber: "AK-2026-000004", reason: "ALREADY_LABELLED" },
        { orderId: MISSING, orderNumber: null, reason: "NOT_FOUND" },
        { orderId: B, orderNumber: "AK-2026-000002", reason: "NOT_PAID" },
        { orderId: C, orderNumber: "AK-2026-000003", reason: "RATE_NOT_MAPPED" },
        { orderId: E, orderNumber: "AK-2026-000005", reason: "WEIGHT_MISSING" },
      ],
    });
    // ONE job per accepted order, carrying the actor; nothing for the skipped.
    expect(repository.enqueued).toEqual([{ orderId: A, actorId: ACTOR_ID }]);
    // Enqueuing is not buying: Sendcloud is not called at request time.
    expect(sendcloud.announceCalls).toHaveLength(0);
  });

  it("refuses the whole request when Sendcloud is not configured", async () => {
    await expect(service(new FakeSendcloud(false)).enqueueLabels([A], ACTOR_ID)).rejects.toMatchObject({
      reason: "FULFILMENT_NOT_CONFIGURED",
    });
    expect(repository.enqueued).toHaveLength(0);
  });
});

describe("retry", () => {
  it("re-enqueues the order of a FAILED Sendcloud label", async () => {
    const failed = await repository.recordFailure({
      orderId: A,
      actorId: ACTOR_ID,
      sendcloudShipmentId: null,
      sendcloudParcelId: null,
      carrier: "InPost",
      statusCode: null,
      failureReason: "invalid",
      now: NOW,
    });

    const result = await service().retry(failed.shipmentId, ACTOR_ID);

    expect(result.accepted).toEqual(["AK-2026-000001"]);
    expect(repository.enqueued).toEqual([{ orderId: A, actorId: ACTOR_ID }]);
  });

  it("refuses to retry a label that did not fail", async () => {
    const live = await labelFor(A, 300);
    await expect(service().retry(live, ACTOR_ID)).rejects.toBeInstanceOf(ConflictException);
  });

  it("404s an unknown shipment", async () => {
    await expect(service().retry(MISSING, ACTOR_ID)).rejects.toBeInstanceOf(RecordNotFoundError);
  });
});

describe("cancel", () => {
  it("200 cancelled → CANCELLED and the order back to PAID", async () => {
    const shipmentId = await labelFor(A, 300);
    expect(repository.orders.get(A)?.status).toBe("FULFILLING");

    const result = await service().cancel(shipmentId, ACTOR_ID);

    expect(sendcloud.cancelCalls).toEqual([`sc-${A}-300`]);
    expect(result).toEqual({ shipmentId, status: "CANCELLED", orderStatus: "PAID" });
    expect(repository.orders.get(A)?.status).toBe("PAID");
  });

  it("202 queued is treated as cancelled", async () => {
    const shipmentId = await labelFor(A, 300);
    sendcloud.cancelResult = { status: "queued" };

    const result = await service().cancel(shipmentId, ACTOR_ID);

    expect(result.status).toBe("CANCELLED");
  });

  it("409 rejected → CANCEL_REJECTED, detail kept for staff, nothing else changes", async () => {
    const shipmentId = await labelFor(A, 300);
    sendcloud.cancelResult = { status: "rejected", detail: "Parcel already picked up" };

    await expect(service().cancel(shipmentId, ACTOR_ID)).rejects.toMatchObject({
      reason: "CANCEL_REJECTED",
    });
    const shipment = repository.shipments.find((candidate) => candidate.id === shipmentId);
    expect(shipment?.status).toBe("LABEL_CREATED");
    expect(shipment?.failureReason).toBe("Parcel already picked up");
    expect(repository.orders.get(A)?.status).toBe("FULFILLING");
  });

  it("refuses a label the carrier has already scanned without calling Sendcloud", async () => {
    const shipmentId = await labelFor(A, 300);
    const index = repository.shipments.findIndex((candidate) => candidate.id === shipmentId);
    const shipment = repository.shipments[index];
    if (shipment === undefined) throw new Error("fixture");
    repository.shipments[index] = { ...shipment, status: "IN_TRANSIT" };

    await expect(service().cancel(shipmentId, ACTOR_ID)).rejects.toMatchObject({
      reason: "CANCEL_REJECTED",
    });
    expect(sendcloud.cancelCalls).toHaveLength(0);
  });

  it("maps a Sendcloud outage to VENDOR_UNAVAILABLE", async () => {
    const shipmentId = await labelFor(A, 300);
    sendcloud.cancelResult = new SendcloudError(503, "unavailable", "maintenance");

    await expect(service().cancel(shipmentId, ACTOR_ID)).rejects.toMatchObject({
      reason: "VENDOR_UNAVAILABLE",
    });
  });
});

describe("print — PDF merge order", () => {
  it("merges our stored labels in REQUEST order and reports orders without one", async () => {
    await labelFor(A, 301);
    await labelFor(D, 304);

    const printed = await service().print([D, B, A]);

    expect(printed.count).toBe(2);
    expect(printed.skippedOrderIds).toEqual([B]);
    const doc = await PDFDocument.load(printed.pdf);
    expect(doc.getPages().map((page) => page.getWidth())).toEqual([304, 301]);
  });

  it("is LABEL_NOT_AVAILABLE when no requested order has a label", async () => {
    await expect(service().print([A, B])).rejects.toMatchObject({ reason: "LABEL_NOT_AVAILABLE" });
  });
});

describe("labelUrl", () => {
  it("signs a URL for a stored label", async () => {
    const shipmentId = await labelFor(A, 300);
    expect(await service().labelUrl(shipmentId)).toContain(`labels/${A}/300.pdf`);
  });

  it("is LABEL_NOT_AVAILABLE for a shipment with no label", async () => {
    const failed = await repository.recordFailure({
      orderId: A,
      actorId: ACTOR_ID,
      sendcloudShipmentId: null,
      sendcloudParcelId: null,
      carrier: "InPost",
      statusCode: null,
      failureReason: "invalid",
      now: NOW,
    });
    await expect(service().labelUrl(failed.shipmentId)).rejects.toMatchObject({
      reason: "LABEL_NOT_AVAILABLE",
    });
  });
});
