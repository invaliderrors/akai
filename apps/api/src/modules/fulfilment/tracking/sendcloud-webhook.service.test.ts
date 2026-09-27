import "reflect-metadata";
import { createLogger } from "@akai/observability";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaService } from "../../prisma/prisma.service";
import { SendcloudWebhookService } from "./sendcloud-webhook.service";

const logger = createLogger({ level: "silent", nodeEnv: "test", serviceName: "api" });
const SHIPMENT_ID = "dddddddd-0000-4000-8000-000000000001";

/**
 * A transaction fake that models the ONE property the service relies on: the
 * provider_event insert and the enqueue share a transaction, so when the insert
 * throws P2002 nothing else is written. The real-Postgres proof is the api-e2e
 * suite; this pins the control flow.
 */
function fakePrisma() {
  const seen = new Set<string>();
  const outbox: unknown[] = [];
  const shipmentByParcel = new Map<bigint, string>([[718530367n, SHIPMENT_ID]]);

  const tx = {
    providerEvent: {
      create: vi.fn(async ({ data }: { data: { id: string; type: string } }) => {
        if (seen.has(data.id)) {
          throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
            code: "P2002",
            clientVersion: "test",
          });
        }
        seen.add(data.id);
        return data;
      }),
    },
    shipment: {
      findUnique: vi.fn(async ({ where }: { where: { sendcloudParcelId: bigint } }) => {
        const id = shipmentByParcel.get(where.sendcloudParcelId);
        return id === undefined ? null : { id };
      }),
    },
    outboxMessage: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        outbox.push(data);
        return data;
      }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
  };
  return { prisma: prisma as unknown as PrismaService, tx, outbox, seen };
}

describe("SendcloudWebhookService", () => {
  let harness: ReturnType<typeof fakePrisma>;
  let service: SendcloudWebhookService;

  beforeEach(() => {
    harness = fakePrisma();
    service = new SendcloudWebhookService(harness.prisma, logger);
  });

  it("records the delivery and enqueues ONE shipment-sync for the parcel's shipment", async () => {
    const outcome = await service.accept({
      parcelId: 718530367n,
      eventId: "sendcloud:718530367:1727200000123",
      action: "parcel_status_changed",
    });

    expect(outcome).toEqual({ status: "enqueued", shipmentId: SHIPMENT_ID });
    expect(harness.seen.has("sendcloud:718530367:1727200000123")).toBe(true);
    expect(harness.outbox).toEqual([{ topic: "shipment-sync", payload: { shipmentId: SHIPMENT_ID } }]);
    expect(harness.tx.providerEvent.create).toHaveBeenCalledWith({
      data: { id: "sendcloud:718530367:1727200000123", type: "sendcloud.parcel_status_changed" },
    });
  });

  it("reports a redelivery of the same event as a duplicate and enqueues nothing more", async () => {
    const event = { parcelId: 718530367n, eventId: "sendcloud:718530367:1", action: "parcel_status_changed" };
    await service.accept(event);
    const second = await service.accept(event);

    expect(second).toEqual({ status: "duplicate" });
    expect(harness.outbox).toHaveLength(1);
  });

  it("treats a NEW timestamp for the same parcel as a new trigger", async () => {
    await service.accept({ parcelId: 718530367n, eventId: "sendcloud:718530367:1", action: "a" });
    await service.accept({ parcelId: 718530367n, eventId: "sendcloud:718530367:2", action: "a" });
    expect(harness.outbox).toHaveLength(2);
  });

  it("answers 'unmatched' for a parcel with no shipment row — still recorded, nothing enqueued", async () => {
    const outcome = await service.accept({ parcelId: 1n, eventId: "sendcloud:1:9", action: "parcel_status_changed" });

    expect(outcome).toEqual({ status: "unmatched" });
    expect(harness.outbox).toHaveLength(0);
    // The row commits, so Sendcloud's retry of this same delivery is a quiet duplicate.
    expect(harness.seen.has("sendcloud:1:9")).toBe(true);
  });

  it("rethrows anything that is not a dedupe collision", async () => {
    harness.tx.outboxMessage.create.mockRejectedValueOnce(new Error("connection reset"));
    await expect(
      service.accept({ parcelId: 718530367n, eventId: "sendcloud:718530367:3", action: "a" }),
    ).rejects.toThrow("connection reset");
  });
});
