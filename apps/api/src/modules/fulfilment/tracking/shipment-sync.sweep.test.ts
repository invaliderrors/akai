import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";

import type { PrismaService } from "../../prisma/prisma.service";
import {
  SHIPMENT_SYNC_STALE_AFTER_MS,
  SYNCABLE_SHIPMENT_STATUSES,
  ShipmentSyncSweep,
} from "./shipment-sync.sweep";

const NOW = new Date("2026-09-25T12:00:00.000Z");

function fakePrisma(ids: readonly string[]) {
  const findMany = vi.fn<(args: unknown) => Promise<{ id: string }[]>>(async () =>
    ids.map((id) => ({ id })),
  );
  const createMany = vi.fn(async ({ data }: { data: readonly unknown[] }) => ({ count: data.length }));
  const prisma = { shipment: { findMany }, outboxMessage: { createMany } };
  return { prisma: prisma as unknown as PrismaService, findMany, createMany };
}

describe("ShipmentSyncSweep", () => {
  it("re-reads only the statuses that can still change", () => {
    expect([...SYNCABLE_SHIPMENT_STATUSES].sort()).toEqual(
      ["AWAITING_PICKUP", "EXCEPTION", "IN_TRANSIT", "LABEL_CREATED", "PENDING"].sort(),
    );
  });

  it("selects live SENDCLOUD shipments not synced for 2 h, oldest first, bounded", async () => {
    const { prisma, findMany } = fakePrisma([]);
    await new ShipmentSyncSweep(prisma).enqueueStaleSyncs(NOW);

    expect(findMany).toHaveBeenCalledTimes(1);
    const [args] = findMany.mock.calls[0] ?? [];
    expect(args).toEqual({
      where: {
        provider: "SENDCLOUD",
        sendcloudShipmentId: { not: null },
        status: { in: [...SYNCABLE_SHIPMENT_STATUSES] },
        OR: [
          { lastSyncedAt: null },
          { lastSyncedAt: { lt: new Date(NOW.getTime() - SHIPMENT_SYNC_STALE_AFTER_MS) } },
        ],
      },
      orderBy: [{ lastSyncedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
      take: 200,
      select: { id: true },
    });
    expect(SHIPMENT_SYNC_STALE_AFTER_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("enqueues one shipment-sync per stale shipment and reports the count", async () => {
    const { prisma, createMany } = fakePrisma(["s-1", "s-2"]);
    const count = await new ShipmentSyncSweep(prisma).enqueueStaleSyncs(NOW);

    expect(count).toBe(2);
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { topic: "shipment-sync", payload: { shipmentId: "s-1" } },
        { topic: "shipment-sync", payload: { shipmentId: "s-2" } },
      ],
    });
  });

  it("writes nothing when nothing is stale", async () => {
    const { prisma, createMany } = fakePrisma([]);
    expect(await new ShipmentSyncSweep(prisma).enqueueStaleSyncs(NOW)).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("honours an overridden batch size and staleness window", async () => {
    const { prisma, findMany } = fakePrisma([]);
    await new ShipmentSyncSweep(prisma, { staleAfterMs: 60_000, batchSize: 5 }).enqueueStaleSyncs(NOW);
    const [args] = findMany.mock.calls[0] ?? [];
    expect(args).toMatchObject({
      take: 5,
      where: { OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: new Date(NOW.getTime() - 60_000) } }] },
    });
  });
});
