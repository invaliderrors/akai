import type { SendcloudConfig } from "@akai/config";
import { createLogger } from "@akai/observability";
import { beforeEach, describe, expect, it } from "vitest";

import { FulfilmentError } from "../fulfilment.errors";
import { SendcloudError } from "../sendcloud/sendcloud.errors";
import { TEST_MODE_SHIPPING_OPTION_CODE } from "../sendcloud/test-mode";
import { LabelService } from "./label.service";
import { SendcloudWriteThrottle } from "./sendcloud-write-throttle";
import {
  ACTOR_ID,
  FakeSendcloud,
  InMemoryFulfilmentRepository,
  InMemoryLabelStorage,
  LABEL_BYTES,
  ORDER_ID,
  announcedShipment,
  labelOrder,
} from "./testing/label-fakes";

const LIVE: SendcloudConfig = {
  publicKey: "pub",
  secretKey: "sec",
  webhookSecret: "sec",
  senderAddressId: 920582,
  mode: "live",
  baseUrl: "https://panel.sendcloud.sc/api/v3",
};

const logger = createLogger({ level: "silent", nodeEnv: "test", serviceName: "labels-test" });
const NOW = new Date("2026-09-24T12:00:00.000Z");

let repository: InMemoryFulfilmentRepository;
let sendcloud: FakeSendcloud;
let storage: InMemoryLabelStorage;

function service(config: SendcloudConfig | null = LIVE, client: FakeSendcloud = sendcloud): LabelService {
  return new LabelService(
    repository,
    client,
    storage,
    new SendcloudWriteThrottle({ sleep: async () => undefined }),
    { sendcloud: config },
    { now: () => NOW },
    logger,
  );
}

beforeEach(() => {
  repository = new InMemoryFulfilmentRepository([labelOrder()]);
  sendcloud = new FakeSendcloud();
  storage = new InMemoryLabelStorage();
});

describe("LabelService.createForOrder — happy path", () => {
  it("announces from the order snapshot, stores the PDF and records a LABEL_CREATED shipment", async () => {
    sendcloud.scriptAnnounce({ shipment: announcedShipment(), reused: false });

    const outcome = await service().createForOrder(ORDER_ID, ACTOR_ID);

    expect(outcome.kind).toBe("created");
    expect(sendcloud.announceCalls).toHaveLength(1);
    expect(sendcloud.announceCalls[0]).toEqual({
      externalReferenceId: ORDER_ID,
      orderNumber: "AK-2026-000123",
      senderAddressId: 920582,
      recipient: {
        name: "Ana García",
        companyName: null,
        addressLine1: "Calle Mayor",
        houseNumber: "12",
        addressLine2: null,
        postalCode: "50002",
        city: "Zaragoza",
        countryCode: "ES",
        email: "ana@example.com",
        phoneNumber: "+34600111222",
      },
      servicePointId: "10875349",
      shippingOptionCode: "inpost_es:service_point,national_c2c",
      weightGrams: 750,
      totalOrderPrice: { value: "49.90", currency: "EUR" },
    });

    // The inline label, stored under the deterministic key.
    expect(storage.objects.get(`labels/${ORDER_ID}/412345678.pdf`)).toEqual(LABEL_BYTES);
    expect(sendcloud.downloadCalls).toEqual([]);

    const [shipment] = repository.shipments;
    expect(shipment).toMatchObject({
      status: "LABEL_CREATED",
      provider: "SENDCLOUD",
      sendcloudShipmentId: "sc-shipment-1",
      sendcloudParcelId: 412345678,
      labelObjectKey: `labels/${ORDER_ID}/412345678.pdf`,
      trackingNumber: "INP000123",
    });
    // PAID -> FULFILLING; nothing mailed (that is the first scan's job).
    expect(repository.orders.get(ORDER_ID)?.status).toBe("FULFILLING");
  });

  it("downloads the label when the announce did not carry it inline", async () => {
    const shipment = announcedShipment();
    const [parcel] = shipment.parcels;
    if (parcel === undefined) throw new Error("fixture");
    sendcloud.scriptAnnounce({
      shipment: { ...shipment, parcels: [{ ...parcel, labelPdf: null }] },
      reused: false,
    });

    await service().createForOrder(ORDER_ID, ACTOR_ID);

    expect(sendcloud.downloadCalls).toEqual([412345678]);
    expect(storage.objects.size).toBe(1);
  });
});

describe("LabelService.createForOrder — idempotency", () => {
  it("records a 409-reused shipment exactly like a fresh one (the crash-recovery path)", async () => {
    sendcloud.scriptAnnounce({ shipment: announcedShipment(), reused: true });

    const outcome = await service().createForOrder(ORDER_ID, ACTOR_ID);

    expect(outcome.kind).toBe("created");
    expect(repository.shipments).toHaveLength(1);
    expect(repository.shipments[0]?.status).toBe("LABEL_CREATED");
  });

  it("buys nothing when the order is already labelled", async () => {
    sendcloud.scriptAnnounce({ shipment: announcedShipment(), reused: false });
    await service().createForOrder(ORDER_ID, ACTOR_ID);

    const again = await service().createForOrder(ORDER_ID, ACTOR_ID);

    expect(again).toEqual({ kind: "skipped", reason: "ALREADY_LABELLED" });
    expect(sendcloud.announceCalls).toHaveLength(1);
  });

  it("lands on the existing row when a reused shipment was already recorded", async () => {
    // Two jobs raced: the first recorded the label; the second's announce came
    // back 409 with the SAME shipment before it re-read eligibility.
    await repository.recordLabel({
      orderId: ORDER_ID,
      actorId: ACTOR_ID,
      sendcloudShipmentId: "sc-shipment-1",
      sendcloudParcelId: 412345678,
      carrier: "InPost",
      trackingNumber: null,
      trackingUrl: null,
      statusCode: "READY_TO_SEND",
      labelObjectKey: "labels/x.pdf",
      now: NOW,
    });
    // Make the order eligible again from the service's point of view.
    const [recorded] = repository.shipments;
    if (recorded === undefined) throw new Error("fixture");
    repository.shipments.splice(0, 1, { ...recorded, status: "CANCELLED" });
    sendcloud.scriptAnnounce({ shipment: announcedShipment(), reused: true });

    const outcome = await service().createForOrder(ORDER_ID, ACTOR_ID);

    expect(outcome.kind).toBe("already-recorded");
    expect(repository.shipments).toHaveLength(1);
  });

  it("uses a fresh external reference after a cancelled or failed attempt", async () => {
    sendcloud.scriptAnnounce({ shipment: announcedShipment(), reused: false });
    await repository.recordFailure({
      orderId: ORDER_ID,
      actorId: ACTOR_ID,
      sendcloudShipmentId: null,
      sendcloudParcelId: null,
      carrier: "InPost",
      statusCode: null,
      failureReason: "invalid: house number",
      now: NOW,
    });

    await service().createForOrder(ORDER_ID, ACTOR_ID);

    expect(sendcloud.announceCalls[0]?.externalReferenceId).toBe(`${ORDER_ID}:1`);
  });
});

describe("LabelService.createForOrder — vendor refusals", () => {
  it("records a FAILED shipment for a 200 with errors[], and leaves the order alone", async () => {
    sendcloud.scriptAnnounce({
      shipment: announcedShipment({
        errors: [
          {
            status: 400,
            code: "parcel_announcement_error",
            detail: "House number is required",
            pointer: "/to_address/house_number",
          },
        ],
        parcels: [
          {
            id: 412345678,
            statusCode: "ANNOUNCEMENT_FAILED",
            statusMessage: "Announcement failed",
            trackingNumber: null,
            trackingUrl: null,
            labelPdf: null,
          },
        ],
      }),
      reused: false,
    });

    const outcome = await service().createForOrder(ORDER_ID, ACTOR_ID);

    expect(outcome).toMatchObject({
      kind: "failed",
      detail: "parcel_announcement_error: House number is required (/to_address/house_number)",
    });
    expect(repository.shipments[0]).toMatchObject({
      status: "FAILED",
      sendcloudShipmentId: "sc-shipment-1",
      failureReason: "parcel_announcement_error: House number is required (/to_address/house_number)",
    });
    expect(repository.orders.get(ORDER_ID)?.status).toBe("PAID");
    expect(storage.objects.size).toBe(0);
  });

  it("records a FAILED shipment for a parcel in ANNOUNCEMENT_FAILED with no errors[]", async () => {
    const shipment = announcedShipment();
    const [parcel] = shipment.parcels;
    if (parcel === undefined) throw new Error("fixture");
    sendcloud.scriptAnnounce({
      shipment: {
        ...shipment,
        parcels: [{ ...parcel, statusCode: "ANNOUNCEMENT_FAILED", statusMessage: "Carrier refused" }],
      },
      reused: false,
    });

    const outcome = await service().createForOrder(ORDER_ID, ACTOR_ID);

    expect(outcome).toMatchObject({ kind: "failed", detail: "Carrier refused" });
  });

  it("records a FAILED shipment for a 4xx refusal of the request", async () => {
    sendcloud.scriptAnnounce(new SendcloudError(422, "invalid", "Unknown shipping option"));

    const outcome = await service().createForOrder(ORDER_ID, ACTOR_ID);

    expect(outcome).toMatchObject({ kind: "failed", detail: "invalid: Unknown shipping option" });
    expect(repository.shipments[0]?.sendcloudShipmentId).toBeNull();
  });

  it.each([
    ["rate-limited", new SendcloudError(429, "too_many_requests", "slow down")],
    ["down", new SendcloudError(503, "unavailable", "maintenance")],
    ["unreachable", new SendcloudError(0, "network_error", "ECONNRESET")],
    ["refusing our credentials", new SendcloudError(401, "unauthorized", "bad key")],
  ])("THROWS (so the outbox retries) when Sendcloud is %s", async (_label, error) => {
    sendcloud.scriptAnnounce(error);

    await expect(service().createForOrder(ORDER_ID, ACTOR_ID)).rejects.toBe(error);
    expect(repository.shipments).toHaveLength(0);
  });

  it("THROWS when the label cannot be stored — the retry's 409 hands it back", async () => {
    sendcloud.scriptAnnounce({ shipment: announcedShipment(), reused: false });
    storage.failPut = true;

    await expect(service().createForOrder(ORDER_ID, ACTOR_ID)).rejects.toThrow("storage down");
    expect(repository.shipments).toHaveLength(0);
    expect(repository.orders.get(ORDER_ID)?.status).toBe("PAID");
  });
});

describe("LabelService.createForOrder — eligibility", () => {
  it("skips an order that does not exist without calling Sendcloud", async () => {
    const outcome = await service().createForOrder("missing-order", ACTOR_ID);
    expect(outcome).toEqual({ kind: "skipped", reason: "NOT_FOUND" });
    expect(sendcloud.announceCalls).toHaveLength(0);
  });

  it("skips an order that is not paid", async () => {
    repository = new InMemoryFulfilmentRepository([labelOrder({ status: "CANCELLED" })]);
    const outcome = await service().createForOrder(ORDER_ID, ACTOR_ID);
    expect(outcome).toEqual({ kind: "skipped", reason: "NOT_PAID" });
    expect(sendcloud.announceCalls).toHaveLength(0);
  });

  it("skips an unmapped rate", async () => {
    repository = new InMemoryFulfilmentRepository([labelOrder({ sendcloudOptionCode: null })]);
    const outcome = await service().createForOrder(ORDER_ID, ACTOR_ID);
    expect(outcome).toEqual({ kind: "skipped", reason: "RATE_NOT_MAPPED" });
    expect(sendcloud.announceCalls).toHaveLength(0);
  });

  it("skips an order with no frozen parcel weight", async () => {
    repository = new InMemoryFulfilmentRepository([labelOrder({ parcelWeightGrams: null })]);
    const outcome = await service().createForOrder(ORDER_ID, ACTOR_ID);
    expect(outcome).toEqual({ kind: "skipped", reason: "WEIGHT_MISSING" });
  });

  it("refuses outright when Sendcloud is not configured", async () => {
    await expect(service(null).createForOrder(ORDER_ID, ACTOR_ID)).rejects.toMatchObject({
      reason: "FULFILMENT_NOT_CONFIGURED",
    });
    await expect(
      service(LIVE, new FakeSendcloud(false)).createForOrder(ORDER_ID, ACTOR_ID),
    ).rejects.toBeInstanceOf(FulfilmentError);
  });
});

describe("LabelService.createForOrder — test mode", () => {
  it("buys the free sendcloud:letter and drops the pickup point, keeping the snapshot's real code", async () => {
    sendcloud.scriptAnnounce({ shipment: announcedShipment(), reused: false });

    await service({ ...LIVE, mode: "test" }).createForOrder(ORDER_ID, ACTOR_ID);

    expect(sendcloud.announceCalls[0]?.shippingOptionCode).toBe(TEST_MODE_SHIPPING_OPTION_CODE);
    expect(sendcloud.announceCalls[0]?.servicePointId).toBeNull();
    expect(repository.orders.get(ORDER_ID)?.sendcloudOptionCode).toBe(
      "inpost_es:service_point,national_c2c",
    );
  });
});
