import { Inject, Injectable, Optional } from "@nestjs/common";
import { shipmentStatusSchema, type ShipmentStatus } from "@akai/contracts";

import { isTerminalShipmentStatus } from "../../orders/shipment-status";
import { PrismaService } from "../../prisma/prisma.service";
import { SHIPMENT_SYNC_TOPIC, type ShipmentSyncPayload } from "./shipment-sync.types";

/**
 * The safety net under the tracking webhook (spec §3.7): every 2 h, enqueue a
 * `shipment-sync` for each non-terminal Sendcloud shipment not synced in the
 * last 2 h. Covers lost webhooks, a panel with the webhook switched off, and a
 * sync that exhausted its retries during a Sendcloud outage.
 *
 * BOUNDED per pass (`batchSize`, oldest sync first — never-synced rows lead):
 * each sync is a Sendcloud GET, and the account allows 1000/min; a backlog
 * larger than one batch drains over the following passes rather than as one
 * burst. It only ENQUEUES — the outbox does the work, with its own retries.
 */

export const SHIPMENT_SYNC_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
export const SHIPMENT_SYNC_SWEEP_BATCH = 200;

/** Statuses the sweep keeps re-reading — derived from the traits table, never retyped. */
export const SYNCABLE_SHIPMENT_STATUSES: readonly ShipmentStatus[] = shipmentStatusSchema.options.filter(
  (status) => !isTerminalShipmentStatus(status),
);

type SweepPrismaClient = Pick<PrismaService, "shipment" | "outboxMessage">;

export interface ShipmentSyncSweepOptions {
  readonly staleAfterMs: number;
  readonly batchSize: number;
}

/** Optional override token (tests); production uses the defaults above. */
export const SHIPMENT_SYNC_SWEEP_OPTIONS = Symbol("SHIPMENT_SYNC_SWEEP_OPTIONS");

const DEFAULT_OPTIONS: ShipmentSyncSweepOptions = {
  staleAfterMs: SHIPMENT_SYNC_STALE_AFTER_MS,
  batchSize: SHIPMENT_SYNC_SWEEP_BATCH,
};

@Injectable()
export class ShipmentSyncSweep {
  private readonly options: ShipmentSyncSweepOptions;

  constructor(
    @Inject(PrismaService) private readonly prisma: SweepPrismaClient,
    @Optional() @Inject(SHIPMENT_SYNC_SWEEP_OPTIONS) options?: ShipmentSyncSweepOptions,
  ) {
    this.options = options ?? DEFAULT_OPTIONS;
  }

  /** Enqueue syncs for stale live shipments. Returns how many were enqueued. */
  async enqueueStaleSyncs(now: Date = new Date()): Promise<number> {
    const staleBefore = new Date(now.getTime() - this.options.staleAfterMs);
    const due = await this.prisma.shipment.findMany({
      where: {
        provider: "SENDCLOUD",
        sendcloudShipmentId: { not: null },
        status: { in: [...SYNCABLE_SHIPMENT_STATUSES] },
        OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: staleBefore } }],
      },
      orderBy: [{ lastSyncedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
      take: this.options.batchSize,
      select: { id: true },
    });

    if (due.length === 0) {
      return 0;
    }

    const rows = due.map((row) => {
      const payload: ShipmentSyncPayload = { shipmentId: row.id };
      return { topic: SHIPMENT_SYNC_TOPIC, payload };
    });
    await this.prisma.outboxMessage.createMany({ data: rows });
    return rows.length;
  }
}
